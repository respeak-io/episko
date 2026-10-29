//! The Trail's one generated sentence: `summarize_day` (Haiku via `claude -p`) and the
//! committed `.episko/digest.md`. Ask once per closed day, run in a scratch cwd (never a
//! real project), and let it fail: no summary is a fine state. See docs/dashboard.md.
//! Also the handoff brief, the one headless run inside a real project (docs/handoff.md).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
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
    Me, // your sessions and commits; cached locally, never written to a file
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
AI coding agents ran and the commits that landed.\n\n\
Write ONE plain sentence, at most 18 words, describing what the day was about. Name the \
dominant project if one clearly dominates. Never mention cost.",
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

/// `Me` left the bare `root\0day` form when its facts dropped spend, so no cached line about cost survives.
fn cache_key(root: &str, day: &str, scope: Scope) -> String {
    match scope {
        Scope::Me => format!("{root}\u{0}{day}\u{0}me"),
        Scope::Project => format!("{root}\u{0}{day}\u{0}project"),
    }
}

/// The Trail's sentence: one bounded `claude -p` in the scratch cwd.
fn run_claude(model: &str, prompt: &str) -> Result<String, String> {
    let cwd = scratch_cwd();
    let _ = std::fs::create_dir_all(&cwd); // `scratch_cwd` only names it
    let args = ["-p", prompt, "--model", model].map(String::from);
    run_headless(&cwd, &args, TIMEOUT)
}

/// Run `claude` with `args` in `cwd`, bounded; returns the trimmed stdout of a clean exit.
fn run_headless(cwd: &Path, args: &[String], timeout: Duration) -> Result<String, String> {
    match run_bounded(cwd, args, timeout)? {
        (status, _) if !status.success() => Err(format!("claude exited {status}")),
        (_, text) => Ok(text.trim().to_string()),
    }
}

/// The exit status with whatever stdout said, on any exit: print mode reports a failed turn on
/// stdout. A reader thread drains it, since a `wait()` that only reads afterwards deadlocks.
fn run_bounded(cwd: &Path, args: &[String], timeout: Duration) -> Result<(ExitStatus, String), String> {
    let mut child = sys_command(resolve_claude())
        .env("PATH", augmented_path())
        .current_dir(cwd)
        .args(args)
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

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok((status, reader.join().unwrap_or_default())),
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

// ---------- the handoff brief (docs/handoff.md) ----------
// A stopped session summarised for whoever picks it up: a forked, tool-less, hook-less,
// unpersisted resume of its transcript. Runs only after `pty-exit`, and types at no PTY.

/// A long conversation is a slow read, even for Haiku.
const BRIEF_TIMEOUT: Duration = Duration::from_secs(120);

const BRIEF_SCHEMA: &str = r#"{"type":"object","additionalProperties":false,
"required":["summary","state","next_steps","open_questions","memories"],
"properties":{"summary":{"type":"string","maxLength":600},"state":{"type":"string","maxLength":400},
"next_steps":{"type":"array","maxItems":6,"items":{"type":"string","maxLength":200}},
"open_questions":{"type":"array","maxItems":6,"items":{"type":"string","maxLength":200}},
"memories":{"type":"array","maxItems":10,"items":{"type":"string","maxLength":120}}}}"#;

const BRIEF_PROMPT: &str = "You are handing this conversation to another developer, who will \
resume it on their own machine. Write a brief from what is above: what the work is (summary), \
where it stands right now (state), the next concrete steps, and any questions still open. In \
`memories`, list the file names of any saved memories this session relied on, or none. Do not \
quote secrets, credentials, tokens or file contents; name files and decisions instead. Answer \
only through the requested structure.";

/// What the recipient reads before resuming. Every field may be empty: the sheet edits it.
#[derive(serde::Serialize, serde::Deserialize, Debug, Default, PartialEq)]
#[serde(default)]
pub(crate) struct Brief {
    summary: String,
    state: String,
    next_steps: Vec<String>,
    open_questions: Vec<String>,
    memories: Vec<String>,
}

impl Brief {
    /// The schema asks for these bounds; an answer that overruns them is cut to fit.
    fn clamped(mut self) -> Self {
        let cut = |s: &mut String, n: usize| *s = s.trim().chars().take(n).collect();
        cut(&mut self.summary, 600);
        cut(&mut self.state, 400);
        let lists = [(&mut self.next_steps, 6, 200), (&mut self.open_questions, 6, 200), (&mut self.memories, 10, 120)];
        for (list, max, len) in lists {
            list.iter_mut().for_each(|s| cut(s, len));
            list.retain(|s| !s.is_empty());
            list.truncate(max);
        }
        self
    }
}

/// A model alias or id, never something the CLI could read as a flag.
fn model_or(model: Option<&str>, fallback: &str) -> String {
    match model.map(str::trim) {
        Some(m) if !m.is_empty() && !m.starts_with('-')
            && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '[' | ']')) => m.to_string(),
        _ => fallback.to_string(),
    }
}

/// The prompt sits right after `-p`: `--tools` and `--mcp-config` take lists and would swallow it.
fn brief_args(resume_id: &str, model: &str, prompt: &str) -> Vec<String> {
    [
        "-p", prompt, "--resume", resume_id, "--fork-session", "--no-session-persistence",
        "--model", model, "--tools", "", "--settings", r#"{"disableAllHooks":true}"#,
        "--strict-mcp-config", "--mcp-config", r#"{"mcpServers":{}}"#,
        "--output-format", "json", "--json-schema", BRIEF_SCHEMA,
    ]
    .map(String::from)
    .to_vec()
}

/// `--output-format json`'s envelope: the brief from `structured_output`, else `result` read as JSON.
fn parse_brief(stdout: &str) -> Result<Brief, String> {
    let v: serde_json::Value = serde_json::from_str(stdout).map_err(|e| format!("not a JSON answer: {e}"))?;
    if v.get("is_error").and_then(|b| b.as_bool()) == Some(true) {
        let why: String = v.get("result").and_then(|r| r.as_str()).unwrap_or("no reason given").chars().take(200).collect();
        return Err(format!("claude reported an error: {why}"));
    }
    let body = match v.get("structured_output") {
        Some(o) if o.is_object() => o.clone(),
        _ => v
            .get("result")
            .and_then(|r| r.as_str())
            .and_then(|r| serde_json::from_str(r).ok())
            .ok_or("the answer carried no brief")?,
    };
    let brief: Brief = serde_json::from_value(body).map_err(|e| format!("not a brief: {e}"))?;
    Ok(brief.clamped())
}

/// Read off any answer, failed ones included; a run killed at its timeout leaves none to read.
fn fork_id(stdout: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(stdout).ok()?;
    v.get("session_id").and_then(|s| s.as_str()).map(String::from)
}

/// `Retry` is an answer that came back unusable; `Stop` is one another model cannot fix.
#[derive(Debug, PartialEq)]
enum BriefErr {
    Retry(String),
    Stop(String),
}

fn brief_once(cwd: &Path, resume_id: &str, model: &str) -> Result<Brief, BriefErr> {
    let (status, out) = run_bounded(cwd, &brief_args(resume_id, model, BRIEF_PROMPT), BRIEF_TIMEOUT).map_err(BriefErr::Stop)?;
    if let Some(fork) = fork_id(&out) {
        if let Err(e) = crate::usage::discard_fork(&cwd.to_string_lossy(), resume_id, &fork) {
            log::warn!("handoff brief: {e}");
        }
    }
    judge(status.success(), out.trim())
}

/// A non-zero exit with no JSON envelope is a refused invocation (a missing transcript, say).
fn judge(ok: bool, out: &str) -> Result<Brief, BriefErr> {
    if !ok && serde_json::from_str::<serde_json::Value>(out).is_err() {
        return Err(BriefErr::Stop("claude exited without an answer".into()));
    }
    parse_brief(out).map_err(BriefErr::Retry)
}

/// One retry on Sonnet, for an unusable answer only; an `Err` leaves the sheet an empty brief.
fn brief_blocking(cwd: &Path, resume_id: &str, model: &str) -> Result<Brief, String> {
    match brief_once(cwd, resume_id, model) {
        Ok(b) => Ok(b),
        Err(BriefErr::Stop(e)) => Err(e),
        Err(BriefErr::Retry(e)) if model == "sonnet" => Err(e),
        Err(BriefErr::Retry(e)) => {
            log::warn!("handoff brief on {model}: {e}; retrying on sonnet");
            brief_once(cwd, resume_id, "sonnet").map_err(|(BriefErr::Retry(e) | BriefErr::Stop(e))| e)
        }
    }
}

/// The brief for `resume_id`, asked in `workdir`, the folder its transcript is filed under.
#[tauri::command]
pub(crate) async fn handoff_brief(workdir: String, resume_id: String, model: Option<String>) -> Result<Brief, String> {
    if !crate::usage::uuid_shaped(&resume_id) {
        return Err(format!("not a session id: {resume_id}"));
    }
    let cwd = PathBuf::from(&workdir);
    if !cwd.is_dir() {
        return Err(format!("{workdir} is not a folder"));
    }
    let model = model_or(model.as_deref(), "haiku");
    tauri::async_runtime::spawn_blocking(move || brief_blocking(&cwd, &resume_id, &model))
        .await
        .map_err(|e| e.to_string())?
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

#[tauri::command(async)]
pub(crate) fn read_digest(root: String) -> std::collections::BTreeMap<String, String> {
    std::fs::read_to_string(digest_path(&root))
        .map(|t| parse_digest(&t))
        .unwrap_or_default()
}

/// Asked before offering to create one, so "may Episko write a file into your repo" is asked once.
#[tauri::command(async)]
pub(crate) fn has_digest(root: String) -> bool {
    digest_path(&root).is_file()
}

/// Add or replace one day. Read-modify-write, since today's line is regenerated as the
/// day goes on; `create` gates the first write into someone's repo.
#[tauri::command(async)]
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

/// The work log moved to the sync server: the file goes, and `.episko/` too if it is now empty.
/// Deleting is all this does; committing the deletion stays the user's.
#[tauri::command(async)]
pub(crate) fn remove_digest(root: String) -> Result<(), String> {
    let path = digest_path(&root);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir(dir); // refuses a non-empty dir, which is the point
    }
    Ok(())
}

/// Commits the work log's removal and nothing else: `--only` with the one path leaves whatever
/// the user had staged out of it. `Ok(false)` when git never tracked the file.
#[tauri::command(async)]
pub(crate) fn commit_digest_removal(root: String) -> Result<bool, String> {
    use crate::git::{git_cmd, git_run};
    const REL: &str = ".episko/digest.md";
    if !git_run(git_cmd(&root, &["ls-files", "--error-unmatch", REL]), 15)?.status.success() {
        remove_digest(root)?;
        return Ok(false);
    }
    remove_digest(root.clone())?;
    let out = git_run(git_cmd(&root, &["commit", "-q", "-m", "episko: the work log moved to the sync server", "--only", "--", REL]), 60)?;
    if out.status.success() { Ok(true) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
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
    use super::{cache_key, commit_digest_removal, first_sentence, parse_digest, prompt_for, remove_digest, render_digest, write_digest, Scope};
    use super::{brief_args, fork_id, judge, model_or, parse_brief, Brief, BriefErr, BRIEF_SCHEMA};
    use crate::usage::uuid_shaped;
    use crate::testutil::scratch_dir;

    const SRC: &str = "11111111-2222-3333-4444-555555555555";

    #[test]
    fn only_an_unusable_answer_earns_the_sonnet_retry() {
        let refused = judge(false, "Error: no conversation found");
        assert!(matches!(refused, Err(BriefErr::Stop(_))), "{refused:?}");
        let failed_turn = judge(false, r#"{"is_error":true,"result":"Prompt is too long"}"#);
        assert!(matches!(&failed_turn, Err(BriefErr::Retry(e)) if e.contains("Prompt is too long")), "{failed_turn:?}");
        assert!(matches!(judge(true, r#"{"result":"just prose"}"#), Err(BriefErr::Retry(_))));
        assert!(judge(true, r#"{"structured_output":{"summary":"x"}}"#).is_ok());
    }

    #[test]
    fn the_brief_runs_forked_toolless_hookless_and_unpersisted() {
        let a = brief_args(SRC, "haiku", "PROMPT");
        assert_eq!(&a[..2], ["-p", "PROMPT"], "a list-taking flag before it would swallow the prompt");
        let after = |flag: &str| a.iter().position(|x| x == flag).map(|i| a[i + 1].as_str());
        assert_eq!(after("--resume"), Some(SRC));
        assert!(a.iter().any(|x| x == "--fork-session"));
        assert!(a.iter().any(|x| x == "--no-session-persistence"));
        assert!(a.iter().any(|x| x == "--strict-mcp-config"));
        assert_eq!(after("--tools"), Some(""));
        assert_eq!(after("--model"), Some("haiku"));
        assert_eq!(after("--output-format"), Some("json"));
        assert_eq!(after("--json-schema"), Some(BRIEF_SCHEMA));
        let settings: serde_json::Value = serde_json::from_str(after("--settings").unwrap()).unwrap();
        assert_eq!(settings["disableAllHooks"], true);
        let mcp: serde_json::Value = serde_json::from_str(after("--mcp-config").unwrap()).unwrap();
        assert_eq!(mcp["mcpServers"], serde_json::json!({}));
        assert!(!a.iter().any(|x| x == "--bare"), "--bare breaks a subscription login");
        let schema: serde_json::Value = serde_json::from_str(BRIEF_SCHEMA).unwrap();
        assert_eq!(schema["properties"]["summary"]["maxLength"], 600);
    }

    #[test]
    fn only_a_uuid_or_a_plain_model_name_reaches_the_command_line() {
        assert!(uuid_shaped(SRC));
        assert!(uuid_shaped("AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee"));
        for bad in ["", "--help", "1111111-2222-3333-4444-555555555555", "11111111-2222-3333-4444-55555555555g", "../x", "11111111-2222-3333-4444-555555555555-6"] {
            assert!(!uuid_shaped(bad), "{bad}");
        }
        assert_eq!(model_or(Some("claude-haiku-4-5[1m]"), "haiku"), "claude-haiku-4-5[1m]");
        assert_eq!(model_or(Some("--tools"), "haiku"), "haiku");
        assert_eq!(model_or(Some("a b"), "haiku"), "haiku");
        assert_eq!(model_or(Some("  "), "haiku"), "haiku");
        assert_eq!(model_or(None, "haiku"), "haiku");
    }

    #[test]
    fn the_brief_comes_from_structured_output_else_from_result() {
        let structured = r#"{"type":"result","is_error":false,"session_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","result":"",
            "structured_output":{"summary":"Handoff slice six.","state":"tests green","next_steps":["commit"],"open_questions":[],"memories":["a.md"]}}"#;
        let b = parse_brief(structured).unwrap();
        assert_eq!(b.summary, "Handoff slice six.");
        assert_eq!(b.memories, vec!["a.md".to_string()]);
        assert_eq!(fork_id(structured).as_deref(), Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        let in_result = r#"{"result":"{\"summary\":\"S\",\"next_steps\":[\"x\"]}"}"#;
        let b = parse_brief(in_result).unwrap();
        assert_eq!((b.summary.as_str(), b.state.as_str(), b.next_steps.len()), ("S", "", 1), "a missing field is empty");
        assert!(parse_brief(r#"{"is_error":true,"structured_output":{"summary":"x"}}"#).is_err());
        assert!(parse_brief(r#"{"result":"just prose"}"#).is_err());
        assert!(parse_brief("not json").is_err());
        assert_eq!(fork_id("not json"), None);
    }

    #[test]
    fn a_brief_that_overran_its_schema_is_cut() {
        let long = serde_json::json!({
            "summary": "x".repeat(900), "state": format!("  {}  ", "y".repeat(500)),
            "next_steps": (0..9).map(|i| format!("step {i}")).collect::<Vec<_>>(),
            "open_questions": ["", "  ", "real"], "memories": (0..14).map(|i| format!("m{i}.md")).collect::<Vec<_>>(),
        });
        let b = parse_brief(&serde_json::json!({ "structured_output": long }).to_string()).unwrap();
        assert_eq!((b.summary.chars().count(), b.state.chars().count()), (600, 400));
        assert!(!b.state.starts_with(' '));
        assert_eq!((b.next_steps.len(), b.memories.len()), (6, 10));
        assert_eq!(b.open_questions, vec!["real".to_string()], "blank entries are dropped");
        assert_eq!(Brief::default(), parse_brief(r#"{"structured_output":{}}"#).unwrap());
    }

    /// Against the real CLI, spending a few Haiku tokens: the brief's flags still combine,
    /// and the fork it resumes under leaves no transcript of its own behind (RELEASE.md).
    #[test]
    #[ignore]
    fn brief_fork_leaves_no_transcript() {
        let cwd = scratch_dir();
        let id = "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
        let seed = ["-p", "Remember the word heron. Reply with ok.", "--session-id", id, "--model", "haiku"].map(String::from);
        super::run_headless(&cwd, &seed, super::TIMEOUT).expect("seeding a session needs an authenticated claude");
        let dir = crate::usage::project_transcript_dir(&crate::usage::claude_dir().unwrap(), &cwd.to_string_lossy());
        let listing = || {
            let mut v: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            v.sort();
            v
        };
        let before = listing();
        assert!(before.contains(&format!("{id}.jsonl")), "{before:?}");
        // The raw run, not `brief_blocking`: its cleanup would hide the leak this checks for.
        let out = super::run_headless(&cwd, &brief_args(id, "haiku", super::BRIEF_PROMPT), super::BRIEF_TIMEOUT);
        let after = listing();
        let _ = crate::platform::remove_tree(&dir);
        let brief = parse_brief(&out.expect("the brief's flag combination was refused")).expect("no brief in the answer");
        assert!(!brief.summary.is_empty(), "{brief:?}");
        assert_eq!(before, after, "the forked brief wrote into the project's transcripts");
    }

    #[test]
    fn the_two_scopes_never_share_a_cache_entry() {
        let (a, b) = (
            cache_key("/w/episko", "2026-07-31", Scope::Me),
            cache_key("/w/episko", "2026-07-31", Scope::Project),
        );
        assert_ne!(a, b);
        // Not the bare form it shipped with: those entries were written from facts that carried spend.
        assert_eq!(a, "/w/episko\u{0}2026-07-31\u{0}me");
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
        // A hand-added heading must not become a day, either side of the one real entry:
        // above it (not a day) or below it (not part of the day it follows).
        let text = "# Work log\n\n## Notes for the team\nignore me\n\n## 2026-07-31\nReal entry.\n\n## Conventions\nnor this\n";
        let m = parse_digest(text);
        assert_eq!(m.len(), 1, "{m:?}");
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
    fn removing_the_work_log_keeps_the_rest_of_episko() {
        let root = scratch_dir();
        let root_s = root.to_string_lossy().to_string();
        write_digest(root_s.clone(), "2026-07-31".into(), "One.".into(), true).unwrap();
        std::fs::write(root.join(".episko").join("notes.toml"), "").unwrap();
        remove_digest(root_s.clone()).unwrap();
        assert!(!root.join(".episko").join("digest.md").exists());
        assert!(root.join(".episko").join("notes.toml").exists());
        std::fs::remove_file(root.join(".episko").join("notes.toml")).unwrap();
        remove_digest(root_s).unwrap();
        assert!(!root.join(".episko").exists(), "an emptied .episko goes with it");
    }

    #[test]
    fn committing_the_removal_takes_that_path_and_nothing_staged_beside_it() {
        use crate::testutil::git;
        let root = scratch_dir();
        let root_s = root.to_string_lossy().to_string();
        git(&root, &["init", "-q"]);
        // Repo-local identity: the command under test runs git with the user's own config.
        for (k, v) in [("user.name", "t"), ("user.email", "t@t"), ("commit.gpgsign", "false")] { git(&root, &["config", k, v]); }
        write_digest(root_s.clone(), "2026-07-31".into(), "One.".into(), true).unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        std::fs::write(root.join("a.txt"), "staged").unwrap();
        git(&root, &["add", "a.txt"]);
        assert_eq!(commit_digest_removal(root_s.clone()), Ok(true));
        let show = std::process::Command::new("git").current_dir(&root).args(["show", "--name-status", "--format=", "HEAD"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&show.stdout).trim(), "D	.episko/digest.md");
        let staged = std::process::Command::new("git").current_dir(&root).args(["diff", "--cached", "--name-only"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), "a.txt", "the user's staged change is still theirs");
        assert_eq!(commit_digest_removal(root_s), Ok(false), "an untracked or absent file commits nothing");
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
