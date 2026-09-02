//! The Trail's one generated sentence: `summarize_day` (Haiku via `claude -p`) and the
//! committed `.episko/digest.md`. Ask once per closed day, run in a scratch cwd (never a
//! real project), and let it fail: no summary is a fine state. See docs/dashboard.md.

use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::platform::{augmented_path, physical_cwd, resolve_claude, sys_command};

/// Long enough for a slow link, short enough that a wedged CLI does not leak a blocked thread.
const TIMEOUT: Duration = Duration::from_secs(45);

/// The app config dir, not `$TMPDIR`: a summary that vanished on reboot would be re-bought.
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

/// Serialises the cache's read-modify-write; see `summarize_day`.
static CACHE_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Temp-then-rename: a crash mid-write must not lose every earlier summary.
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

/// Scratch cwd for the summariser's own transcripts. `scan_history_in` skips it by name,
/// so it must not create anything (`run_claude` does) and must resolve through
/// `physical_cwd` at the temp dir: Claude encodes the child's resolved `getcwd()`, and the
/// leaf may not exist yet, which `physical_cwd` would pass through unresolved.
pub(crate) fn scratch_cwd() -> PathBuf {
    let mut d = PathBuf::from(physical_cwd(&std::env::temp_dir().to_string_lossy()));
    d.push("cc-launcher");
    d.push("trail-summary");
    d
}

/// Which of a day's two sentences is asked for. The two get different prompts: told it
/// is reading a developer's day, the model narrates an afternoon it never saw.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Scope {
    Me, // your sessions and spend; cached locally, never written to a file
    Project, // commits and pull requests, which everyone has; the committable half
}

impl Scope {
    /// Anything unrecognised is `Me`: a typo must not promote a sentence into a committed file.
    fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("project") { Scope::Project } else { Scope::Me }
    }
}

/// Narrow on purpose: the model labels facts it is handed, with no tools and no room to editorialise.
fn prompt_for(scope: Scope, facts: &str) -> String {
    let preamble = match scope {
        Scope::Me =>
            "Below is a factual record of one day of a developer's work — the sessions their \
AI coding agents ran, the commits that landed, and what it cost.\n\n\
Write ONE plain sentence, at most 18 words, describing what the day was about. Name the \
dominant project if one clearly dominates.",
        // No "they", no time of day: read by a colleague months later, about a repository.
        Scope::Project =>
            "Below is one day of a software project's committed history — the commits that \
landed and the pull requests that moved. It is the whole record: nobody's sessions, \
notes or working hours are included, so do not describe how the work was done or who \
spent time on what.\n\n\
Write ONE plain sentence, at most 22 words, describing what changed in the project that \
day. Name features, fixes and releases from the subjects themselves.",
    };
    format!(
        "{preamble} Prefer concrete nouns from the facts over generic words like \
\"various\" or \"development\". Output only the sentence: no preamble, no bullet points, \
no markdown, no quotes.\n\n\
FACTS\n{facts}"
    )
}

/// `Me` keeps the bare `root\0day` form so summaries already bought stay valid; `Project` adds a segment.
fn cache_key(root: &str, day: &str, scope: Scope) -> String {
    match scope {
        Scope::Me => format!("{root}\u{0}{day}"),
        Scope::Project => format!("{root}\u{0}{day}\u{0}project"),
    }
}

/// Run `claude -p`, bounded; returns the trimmed stdout. A reader thread drains stdout,
/// since a `wait()` that only reads afterwards deadlocks past one pipe buffer.
fn run_claude(model: &str, prompt: &str) -> Result<String, String> {
    let cwd = scratch_cwd();
    let _ = std::fs::create_dir_all(&cwd); // `scratch_cwd` only names it
    let mut child = sys_command(resolve_claude())
        .env("PATH", augmented_path())
        .current_dir(cwd)
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
// A generated day is also written into the project as one committable markdown file, so a
// teammate opening the same dashboard pays nothing. Read before generate. Creating it asks
// first (`create`): a new committable file in someone's repo is a real side effect.

/// Markdown because a human reads it in a PR: `## YYYY-MM-DD` sections, newest first, one paragraph each.
const DIGEST_HEAD: &str = "# Work log\n\n\
One line per day, generated by [Episko](https://episko.dev) from that day's commits and \
agent sessions. Committed so the team shares one history instead of each re-deriving it.\n";

fn digest_path(root: &str) -> PathBuf {
    PathBuf::from(root).join(".episko").join("digest.md")
}

/// Day → sentence. A missing or malformed file is an empty map, never an error.
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
            // Only a real date starts a section; prose in a hand-edited file must not become a key.
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
    for (day, line) in map.iter().rev() { // newest first: the useful end is today
        s.push_str(&format!("\n## {day}\n{line}\n"));
    }
    s
}

#[tauri::command]
pub(crate) fn read_digest(root: String) -> std::collections::BTreeMap<String, String> {
    std::fs::read_to_string(digest_path(&root))
        .map(|t| parse_digest(&t))
        .unwrap_or_default()
}

/// Asked before offering to create one, so "may Episko write a file into your repo" is asked once.
#[tauri::command]
pub(crate) fn has_digest(root: String) -> bool {
    digest_path(&root).is_file()
}

/// Add or replace one day. Read-modify-write, since today's line is regenerated as the
/// day goes on; `create` gates the first write into someone's repo.
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
    // Temp-then-rename: a crash mid-write must not truncate a file under version control.
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, render_digest(&map)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// One day's sentence, cached per `root` and `key` (`YYYY-MM-DD`). `facts` is titles and
/// commit subjects only, never transcript bodies; the caller hands over the record that
/// matches `scope`, since this end cannot tell a private fact from a shared one. `force`
/// re-asks for today; every other day is answered from disk. Runs on a blocking thread.
#[tauri::command]
pub(crate) async fn summarize_day(
    app: AppHandle,
    root: String,
    key: String,
    facts: String,
    model: String,
    scope: String,
    force: bool,
) -> Result<String, String> {
    let scope = Scope::parse(&scope);
    let cache_key = cache_key(&root, &key, scope);
    if !force {
        if let Some(hit) = read_cache(&app).get(&cache_key).and_then(|v| v.as_str()) {
            if !hit.is_empty() {
                return Ok(hit.to_string());
            }
        }
    }
    if facts.trim().is_empty() {
        // Under `force` too: a refresh with nothing to summarise keeps the sentence the day
        // already has rather than reporting a failure over it.
        if let Some(hit) = read_cache(&app).get(&cache_key).and_then(|v| v.as_str()) {
            if !hit.is_empty() {
                return Ok(hit.to_string());
            }
        }
        return Err("nothing to summarise".into());
    }

    let model = if model.trim().is_empty() { "haiku".to_string() } else { model };
    let prompt = prompt_for(scope, &facts);
    let text = tauri::async_runtime::spawn_blocking(move || run_claude(&model, &prompt))
        .await
        .map_err(|e| e.to_string())??;

    // An empty answer is a failure, never cached: "" would make the day permanently unsummarisable.
    let line = first_sentence(&text);
    if line.is_empty() {
        return Err("empty summary".into());
    }

    // Read-modify-write under a lock: the dashboard asks for both scopes of one day at once,
    // and two unsynchronised writes leave only the later one's entry in the file.
    {
        let _guard = CACHE_WRITE.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = read_cache(&app);
        map.insert(cache_key, serde_json::Value::String(line.clone()));
        write_cache(&app, &map);
    }
    Ok(line)
}

/// The first non-empty line only: the prompt asks for one sentence, and this enforces it.
fn first_sentence(raw: &str) -> String {
    let line = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with(['-', '*', '#', '>']))
        .unwrap_or("")
        .trim_matches('"')
        .trim();
    // Cut at a word boundary so the row still reads.
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
    use super::{cache_key, first_sentence, parse_digest, prompt_for, render_digest, write_digest, Scope};
    use crate::testutil::scratch_dir;

    #[test]
    fn the_two_scopes_never_share_a_cache_entry() {
        let (a, b) = (
            cache_key("/w/episko", "2026-07-31", Scope::Me),
            cache_key("/w/episko", "2026-07-31", Scope::Project),
        );
        assert_ne!(a, b);
        // The private one keeps the shape it shipped with.
        assert_eq!(a, "/w/episko\u{0}2026-07-31");
        // The day segment sits between root and scope, so no root collides with another's project entry.
        assert_ne!(cache_key("/w/a", "2026-07-31\u{0}project", Scope::Me), b);
    }

    #[test]
    fn an_unknown_scope_falls_back_to_the_private_one() {
        assert_eq!(Scope::parse("project"), Scope::Project);
        assert_eq!(Scope::parse("PROJECT"), Scope::Project);
        assert_eq!(Scope::parse("me"), Scope::Me);
        assert_eq!(Scope::parse("prject"), Scope::Me);
        assert_eq!(Scope::parse(""), Scope::Me);
    }

    #[test]
    fn the_shared_prompt_asks_for_a_repository_not_an_afternoon() {
        let facts = "commit: fix: a thing";
        let mine = prompt_for(Scope::Me, facts);
        let theirs = prompt_for(Scope::Project, facts);
        assert_ne!(mine, theirs);
        for p in [&mine, &theirs] {
            assert!(p.contains(facts));
            assert!(p.contains("ONE plain sentence"));
        }
        assert!(theirs.contains("committed history"));
        assert!(!theirs.contains("developer's work"));
        assert!(mine.contains("developer's work"));
    }

    #[test]
    fn digest_round_trips_through_markdown() {
        let mut m = std::collections::BTreeMap::new();
        m.insert("2026-07-30".to_string(), "Filed the performance backlog.".to_string());
        m.insert("2026-07-31".to_string(), "Six branches landed and 0.12.0 went out.".to_string());
        let out = parse_digest(&render_digest(&m));
        assert_eq!(out, m);
        // Newest first.
        let text = render_digest(&m);
        assert!(text.find("2026-07-31").unwrap() < text.find("2026-07-30").unwrap());
    }

    #[test]
    fn a_hand_edited_file_keeps_its_prose_out_of_the_keys() {
        // A hand-added heading must not become a day, nor eat the entry above it.
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
        assert!(write_digest(root_s.clone(), "2026-07-31".into(), "One.".into(), false).is_err());
        assert!(!root.join(".episko").join("digest.md").exists());

        write_digest(root_s.clone(), "2026-07-31".into(), "One.".into(), true).unwrap();
        let f = root.join(".episko").join("digest.md");
        assert!(f.is_file());

        // Once it exists, no further permission is needed.
        write_digest(root_s.clone(), "2026-07-30".into(), "Two.".into(), false).unwrap();
        let m = parse_digest(&std::fs::read_to_string(&f).unwrap());
        assert_eq!(m.len(), 2);
        assert_eq!(m.get("2026-07-30").map(String::as_str), Some("Two."));
    }

    #[test]
    fn re_writing_a_day_replaces_it_rather_than_appending() {
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
        // Dirtying a tracked file on every open would put digest.md in every `git status`.
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
