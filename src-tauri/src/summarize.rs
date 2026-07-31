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
    let mut child = sys_command(resolve_claude())
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

// ---------- the shared half: .episko/digest.md ----------
// A summary costs money, and every teammate opening the same dashboard would pay for
// the same sentence again. So a generated day is also written into the project as a
// plain markdown file, which is committable, diffable, and readable by a colleague who
// never opens Episko. Read before generate: the second person to look at a week pays
// nothing for it.
//
// ONE file, not one per month. A year of one-line entries is ~365 lines — small enough
// that a single read answers any window, and a single diff shows what changed. It is
// also the second file Episko is allowed to write inside a user's repo (after
// `.episko/tasks.toml`), which is why creating it asks first: see `create`.

/// The digest is markdown because a human reads it in a PR, not because anything here
/// needs markdown. `## YYYY-MM-DD` sections, newest first, one paragraph each.
const DIGEST_HEAD: &str = "# Work log\n\n\
One line per day, generated by [Episko](https://episko.dev) from that day's commits and \
agent sessions. Committed so the team shares one history instead of each re-deriving it.\n";

fn digest_path(root: &str) -> PathBuf {
    PathBuf::from(root).join(".episko").join("digest.md")
}

/// Day → sentence, from whatever is on disk. A missing or malformed file is an empty
/// map, never an error: a digest is an optimisation, and a project without one has to
/// behave exactly like a project that has never heard of it.
fn parse_digest(text: &str) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    let mut day: Option<String> = None;
    let mut buf: Vec<&str> = Vec::new();
    let flush = |day: &mut Option<String>,
                 buf: &mut Vec<&str>,
                 out: &mut std::collections::BTreeMap<String, String>| {
        if let Some(d) = day.take() {
            let s = buf.join(" ").trim().to_string();
            if !s.is_empty() {
                out.insert(d, s);
            }
        }
        buf.clear();
    };
    for line in text.lines() {
        if let Some(rest) = line.trim_end().strip_prefix("## ") {
            flush(&mut day, &mut buf, &mut out);
            let d = rest.trim();
            // Only a real date starts a section. Anything else is prose in someone's
            // hand-edited file and must not become a key.
            if d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-'
                && d.bytes().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
            {
                day = Some(d.to_string());
            }
        } else if day.is_some() && !line.trim().is_empty() {
            buf.push(line.trim());
        }
    }
    flush(&mut day, &mut buf, &mut out);
    out
}

fn render_digest(map: &std::collections::BTreeMap<String, String>) -> String {
    let mut s = String::from(DIGEST_HEAD);
    // Newest first: the file is read top-down by a human, and the useful end is today.
    for (day, line) in map.iter().rev() {
        s.push_str(&format!("\n## {day}\n{line}\n"));
    }
    s
}

/// Every day the project's committed digest already knows about.
#[tauri::command]
pub(crate) fn read_digest(root: String) -> std::collections::BTreeMap<String, String> {
    std::fs::read_to_string(digest_path(&root))
        .map(|t| parse_digest(&t))
        .unwrap_or_default()
}

/// Whether this project already has a digest — what the frontend asks before offering
/// to create one, so "may Episko write a file into your repo" is asked once and only
/// when the answer isn't already yes.
#[tauri::command]
pub(crate) fn has_digest(root: String) -> bool {
    digest_path(&root).is_file()
}

/// Add or replace one day, preserving every other entry.
///
/// Read-modify-write rather than append: today's line is re-generated as the day goes
/// on, and appending would leave a file with the same date three times over.
/// `create` gates the very first write, because a new committable file in someone's
/// repo is a real side effect — the same stance `tasks.rs` takes with `tasks.toml`.
#[tauri::command]
pub(crate) fn write_digest(root: String, key: String, line: String, create: bool) -> Result<(), String> {
    let path = digest_path(&root);
    if !path.is_file() && !create {
        return Err("no digest yet".into());
    }
    let mut map = std::fs::read_to_string(&path).map(|t| parse_digest(&t)).unwrap_or_default();
    if map.get(&key).is_some_and(|cur| *cur == line) {
        return Ok(()); // unchanged — don't dirty the working tree for nothing
    }
    map.insert(key, line);
    let dir = path.parent().ok_or("bad root")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Temp-then-rename, like the cache above and like tasks.toml: a crash mid-write
    // must not truncate a file that is under version control.
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, render_digest(&map)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// One day's summary sentence, cached.
///
/// `root` scopes it to a project — the dashboard is per-project, and two projects on
/// the same day are two different sentences. `key` is the calendar day (`YYYY-MM-DD`),
/// `facts` the record built by `dayFacts` in the frontend — titles and commit subjects
/// only, never transcript bodies. `force` re-asks for a day that is still being written
/// (today); every other day is answered from disk forever after the first time.
///
/// Runs on a blocking thread: a synchronous command would hold the main thread for the
/// length of a model call and freeze the UI.
#[tauri::command]
pub(crate) async fn summarize_day(
    app: AppHandle,
    root: String,
    key: String,
    facts: String,
    model: String,
    force: bool,
) -> Result<String, String> {
    // Project-scoped, so two dashboards can't answer each other's days. The old
    // day-only key is not migrated: it was never shipped outside the spike branch.
    let cache_key = format!("{root}\u{0}{key}");
    if !force {
        if let Some(hit) = read_cache(&app).get(&cache_key).and_then(|v| v.as_str()) {
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
    map.insert(cache_key, serde_json::Value::String(line.clone()));
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
    use super::{first_sentence, parse_digest, render_digest, write_digest};
    use crate::testutil::scratch_dir;

    #[test]
    fn digest_round_trips_through_markdown() {
        let mut m = std::collections::BTreeMap::new();
        m.insert("2026-07-30".to_string(), "Filed the performance backlog.".to_string());
        m.insert("2026-07-31".to_string(), "Six branches landed and 0.12.0 went out.".to_string());
        let out = parse_digest(&render_digest(&m));
        assert_eq!(out, m);
        // Newest first, because a human reads the file top-down and today is the useful end.
        let text = render_digest(&m);
        assert!(text.find("2026-07-31").unwrap() < text.find("2026-07-30").unwrap());
    }

    #[test]
    fn a_hand_edited_file_keeps_its_prose_out_of_the_keys() {
        // Someone will add a heading. It must not become a day, and it must not eat
        // the entry above it either.
        let text = "# Work log\n\n## Notes for the team\nignore me\n\n## 2026-07-31\nReal entry.\n";
        let m = parse_digest(text);
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("2026-07-31").map(String::as_str), Some("Real entry."));
    }

    #[test]
    fn a_missing_or_junk_file_is_an_empty_map_not_an_error() {
        assert!(parse_digest("").is_empty());
        assert!(parse_digest("nothing structured here at all").is_empty());
        // A date-shaped heading with no body is not an entry.
        assert!(parse_digest("## 2026-07-31\n").is_empty());
    }

    #[test]
    fn writing_refuses_to_create_the_file_until_it_is_allowed_to() {
        let root = scratch_dir();
        let root_s = root.to_string_lossy().to_string();
        // The first write into someone's repo is a real side effect, so it is gated.
        assert!(write_digest(root_s.clone(), "2026-07-31".into(), "One.".into(), false).is_err());
        assert!(!root.join(".episko").join("digest.md").exists());

        write_digest(root_s.clone(), "2026-07-31".into(), "One.".into(), true).unwrap();
        let f = root.join(".episko").join("digest.md");
        assert!(f.is_file());

        // …and once it exists, no further permission is needed.
        write_digest(root_s.clone(), "2026-07-30".into(), "Two.".into(), false).unwrap();
        let m = parse_digest(&std::fs::read_to_string(&f).unwrap());
        assert_eq!(m.len(), 2);
        assert_eq!(m.get("2026-07-30").map(String::as_str), Some("Two."));
    }

    #[test]
    fn re_writing_a_day_replaces_it_rather_than_appending() {
        // Today's line is regenerated as the day goes on; appending would leave the
        // same date in the file three times over.
        let root = scratch_dir();
        let root_s = root.to_string_lossy().to_string();
        write_digest(root_s.clone(), "2026-07-31".into(), "First take.".into(), true).unwrap();
        write_digest(root_s.clone(), "2026-07-31".into(), "Better take.".into(), false).unwrap();
        let text = std::fs::read_to_string(root.join(".episko").join("digest.md")).unwrap();
        assert_eq!(text.matches("## 2026-07-31").count(), 1);
        assert_eq!(parse_digest(&text).get("2026-07-31").map(String::as_str), Some("Better take."));
    }

    #[test]
    fn an_unchanged_day_does_not_rewrite_the_file() {
        // The dashboard re-summarises today on every open; dirtying a tracked file
        // each time would put .episko/digest.md in every `git status` for nothing.
        let root = scratch_dir();
        let root_s = root.to_string_lossy().to_string();
        write_digest(root_s.clone(), "2026-07-31".into(), "Same.".into(), true).unwrap();
        let f = root.join(".episko").join("digest.md");
        let before = std::fs::metadata(&f).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_digest(root_s, "2026-07-31".into(), "Same.".into(), false).unwrap();
        assert_eq!(std::fs::metadata(&f).unwrap().modified().unwrap(), before);
    }

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
