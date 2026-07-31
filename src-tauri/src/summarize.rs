// The Trail's one generated sentence — and nothing else.
//
// Everything else the Trail shows is derived from evidence Episko already keeps
// (transcripts, the usage rollup, git). This module exists for the single part that
// cannot be derived: a readable one-line label for a day. It is deliberately the only
// place in Episko that spends money to render a view, which is why it is also the only
// place with a cache, a timeout and an off switch.
//
// Four rules shape it:
//
// - **Ask once, ever.** A day that is over cannot change, so its summary is written to
//   disk and never recomputed. Only today re-summarises (the frontend decides, via
//   `dayIsClosed`, and asks with `force`). Opening the Trail ten times costs nothing.
// - **Never touch a real session.** `claude -p` still writes a transcript, under an
//   encoding of its cwd — so this runs in a scratch directory. Pointing it at a project
//   folder would scatter one-line summariser transcripts through the user's own history,
//   and reusing a session id would *append to that conversation*.
// - **A stripped PATH is the norm.** Same constraint as the hooks: a GUI app launched
//   from Finder inherits almost no PATH, so the binary comes from `resolve_claude()` and
//   the environment from `augmented_path()`.
// - **It must be allowed to fail.** No summary is a fine state — the day still renders
//   with its deterministic headline — so every failure path returns an error the caller
//   shrugs off rather than surfacing as breakage.

use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::platform::{augmented_path, resolve_claude, sys_command};

/// Long enough for a small prompt on a slow link, short enough that a wedged CLI is
/// noticed rather than leaking a blocked thread for the life of the app.
const TIMEOUT: Duration = Duration::from_secs(45);

/// Where summaries live. The app config dir, not `$TMPDIR/cc-launcher` where the
/// instrument files go: those are per-launch scratch and *should* evaporate, while a
/// summary that vanished on reboot would be silently re-bought.
fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("trail-summaries.json"))
}

fn read_cache(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    cache_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Temp-then-rename, like `tasks.rs` writes `tasks.toml`: a crash mid-write must not
/// leave a truncated file that then fails to parse and loses every earlier summary.
fn write_cache(app: &AppHandle, map: &serde_json::Map<String, serde_json::Value>) {
    let Some(path) = cache_path(app) else { return };
    let tmp = path.with_extension("json.tmp");
    if serde_json::to_string_pretty(map)
        .ok()
        .and_then(|s| std::fs::write(&tmp, s).ok())
        .is_some()
    {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// A scratch cwd for the summariser's own transcripts, kept out of every real project.
fn scratch_cwd() -> PathBuf {
    let mut d = std::env::temp_dir();
    d.push("cc-launcher");
    d.push("trail-summary");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// The instruction. Deliberately narrow: the model is labelling facts it is handed, not
/// investigating anything, so it gets no tools, no context and no room to editorialise.
fn prompt_for(facts: &str) -> String {
    format!(
        "Below is a factual record of one day of a developer's work — the sessions their \
AI coding agents ran, the commits that landed, and what it cost.\n\n\
Write ONE plain sentence, at most 18 words, describing what the day was about. Name the \
dominant project if one clearly dominates. Prefer concrete nouns from the facts over \
generic words like \"various\" or \"development\". Output only the sentence: no preamble, \
no bullet points, no markdown, no quotes.\n\n\
FACTS\n{facts}"
    )
}

/// Run `claude -p`, bounded. Returns the trimmed stdout.
///
/// The child's stdout is drained by a reader thread rather than collected after the
/// wait: a `wait()` that only reads afterwards deadlocks the moment the child writes
/// more than one pipe buffer, and "the summariser hung the app" is a far worse failure
/// than "there is no summary today".
fn run_claude(model: &str, prompt: &str) -> Result<String, String> {
    let mut child = sys_command(&resolve_claude())
        .env("PATH", augmented_path())
        .current_dir(scratch_cwd())
        .args(["-p", prompt, "--model", model])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start claude: {e}"))?;

    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });

    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let text = reader.join().unwrap_or_default();
                if !status.success() {
                    return Err(format!("claude exited {status}"));
                }
                return Ok(text.trim().to_string());
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("claude timed out".into());
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// One day's summary sentence, cached.
///
/// `key` is the calendar day (`YYYY-MM-DD`), `facts` the record built by `dayFacts` in
/// the frontend — titles and commit subjects only, never transcript bodies. `force`
/// re-asks for a day that is still being written (today); every other day is answered
/// from disk forever after the first time.
///
/// Runs on a blocking thread: a synchronous command would hold the main thread for the
/// length of a model call and freeze the UI.
#[tauri::command]
pub(crate) async fn summarize_day(
    app: AppHandle,
    key: String,
    facts: String,
    model: String,
    force: bool,
) -> Result<String, String> {
    if !force {
        if let Some(hit) = read_cache(&app).get(&key).and_then(|v| v.as_str()) {
            if !hit.is_empty() {
                return Ok(hit.to_string());
            }
        }
    }
    if facts.trim().is_empty() {
        return Err("nothing to summarise".into());
    }

    let model = if model.trim().is_empty() { "haiku".to_string() } else { model };
    let prompt = prompt_for(&facts);
    let text = tauri::async_runtime::spawn_blocking(move || run_claude(&model, &prompt))
        .await
        .map_err(|e| e.to_string())??;

    // A model that answers with nothing is a failure, not an empty summary to cache —
    // caching "" would make the day permanently unsummarisable.
    let line = first_sentence(&text);
    if line.is_empty() {
        return Err("empty summary".into());
    }

    let mut map = read_cache(&app);
    map.insert(key, serde_json::Value::String(line.clone()));
    write_cache(&app, &map);
    Ok(line)
}

/// Keep the first non-empty line, and only that.
///
/// The prompt asks for one sentence; this enforces it rather than trusting it. A model
/// that adds a preamble line or a bulleted afterthought would otherwise break the day
/// row's layout, and clamping here is cheaper than re-prompting.
fn first_sentence(raw: &str) -> String {
    let line = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with(['-', '*', '#', '>']))
        .unwrap_or("")
        .trim_matches('"')
        .trim();
    // A long paragraph that slipped through is cut at a word boundary rather than
    // mid-word, so the row degrades to something still readable.
    if line.chars().count() <= 160 {
        return line.to_string();
    }
    let mut out = String::new();
    for w in line.split_whitespace() {
        if out.chars().count() + w.chars().count() + 1 > 157 {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::first_sentence;

    #[test]
    fn takes_the_first_real_line() {
        assert_eq!(first_sentence("\n\nMostly episko — the overview spike.\n"), "Mostly episko — the overview spike.");
    }

    #[test]
    fn strips_a_preamble_or_bullets_the_model_added() {
        // The prompt forbids these; enforcing it keeps one bad generation from
        // breaking the row rather than trusting the model to have complied.
        assert_eq!(first_sentence("- point one\n- point two"), "");
        assert_eq!(first_sentence("# Summary\nShipped the release."), "Shipped the release.");
    }

    #[test]
    fn unquotes() {
        assert_eq!(first_sentence("\"Filed the performance backlog.\""), "Filed the performance backlog.");
    }

    #[test]
    fn clamps_a_runaway_paragraph_at_a_word_boundary() {
        let long = "word ".repeat(80);
        let out = first_sentence(&long);
        assert!(out.chars().count() <= 160, "got {}", out.chars().count());
        assert!(out.ends_with('…'));
        assert!(!out.contains("wor…"), "must not cut mid-word: {out}");
    }

    #[test]
    fn empty_input_is_empty_not_a_panic() {
        assert_eq!(first_sentence(""), "");
        assert_eq!(first_sentence("   \n  \n"), "");
    }
}
