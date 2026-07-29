// Everything Episko reads out of `~/.claude`: the transcripts and the token ledger.
//
// Two consumers, one directory, and the same load-bearing caveat over both — this
// layout is internal to Claude Code and documented as unstable across releases, so
// every reader here is a fallback chain rather than a schema:
//
// - **Transcripts.** `list_past_sessions` labels a dormant session from its
//   `ai-title` record — *last occurrence wins* — falling back `ai-title` ->
//   `last-prompt` -> the first user message. Only the 512KB tail is scanned. An
//   entry with no transcript is dropped: a session launched but never prompted
//   writes none. `read_transcript` mirrors one read-only, decoding the cwd -> <enc>
//   path scheme.
// - **The token ledger.** `scan_usage` folds every project's `.jsonl` into per-day
//   totals by model family. It does **not** deduplicate messages — every line with a
//   `message.usage` record is summed once, which is correct because `--resume`
//   appends to the *same* transcript rather than replaying it. What is deduplicated
//   is the *session count*: `file_days` counts one file once per day it touched,
//   however many messages it holds.
//
// **Every reader here takes its base directory as an argument.** `~/.claude` is
// resolved once, by `claude_dir()`, and only the three `#[tauri::command]` wrappers
// call it; the work happens in `*_in(base, …)` functions a test can point at a
// fixture tree. The commands' own signatures are the IPC contract and are unchanged.
// Without this the only way to test any of it was against the developer's real
// `~/.claude` — unreproducible, and shared by cargo's parallel test threads.

use std::path::{Path, PathBuf};

use crate::git::git_repo_info;
use crate::platform::{home_dir, norm_path};

/// The `~/.claude` Episko reads. None when there is no home directory at all, which
/// every caller reports rather than silently returning nothing.
fn claude_dir() -> Option<PathBuf> {
    let home = home_dir();
    if home.is_empty() {
        return None;
    }
    Some(Path::new(&home).join(".claude"))
}

#[derive(serde::Serialize)]
pub(crate) struct TranscriptMsg {
    role: String,
    text: String,
}

/// Windows `canonicalize` returns the *verbatim* form — `\\?\C:\Work` — which encodes
/// to a different directory than the `C:\Work` Claude records, so the prefix has to
/// come back off. Split out from `physical_cwd` because it is the half that can be
/// tested on every OS: the other half needs a real symlink on disk.
fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

/// The *physical* spelling of `cwd` — the one Claude will have recorded.
///
/// This is not Claude being clever: a process that `chdir`s through a symlink still
/// reports the resolved path from `getcwd()`, so a session launched in `/tmp/x` (on
/// macOS a symlink to `/private/tmp/x`) writes its transcript under the
/// `-private-tmp-x` encoding and under no other. Encoding the spelling the *user*
/// picked would look in a directory that never exists, and the caller would read that
/// as "this project has no past sessions" rather than as a failure.
///
/// Falls back to the input when the path won't resolve. A workdir that has been
/// deleted is a real case here (worktrees go away), and a best-effort encoding is
/// worth more to both callers than an error neither can act on.
fn physical_cwd(cwd: &str) -> String {
    match std::fs::canonicalize(cwd) {
        Ok(p) => strip_verbatim(&p.to_string_lossy()),
        Err(_) => cwd.to_string(),
    }
}

/// Claude stores a project's transcripts under `<base>/projects/<enc>/`, where
/// `<enc>` is the **physical** cwd with every non-ASCII-alphanumeric char replaced
/// by `-`.
fn project_transcript_dir(base: &Path, cwd: &str) -> PathBuf {
    let enc: String = physical_cwd(cwd)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    base.join("projects").join(enc)
}

/// A finished (or at least not-currently-owned) session found on disk, offered to
/// the user as restorable via `claude --resume <id>`.
#[derive(serde::Serialize)]
pub(crate) struct PastSession {
    session_id: String,
    title: String,
    last_prompt: String,
    mtime: u64,
}

/// Enumerate the transcripts Claude has written for `workdir`, newest first, so
/// the frontend can label restorable sessions with something human-readable.
///
/// Titles come from the `ai-title` record Claude maintains; it is rewritten as the
/// session evolves, so the LAST occurrence wins. That record type is internal to
/// Claude Code and documented as unstable across releases, hence the fallback
/// chain: `ai-title` → `last-prompt` → first user message → "" (caller labels it).
/// Only the tail is scanned — `ai-title` recurs throughout the file, so a bounded
/// read reliably catches the latest one without paying for a 4MB transcript.
#[tauri::command(async)]
pub(crate) fn list_past_sessions(workdir: String) -> Result<Vec<PastSession>, String> {
    let base = claude_dir().ok_or_else(|| "no home directory".to_string())?;
    list_past_sessions_in(&base, &workdir)
}

fn list_past_sessions_in(base: &Path, workdir: &str) -> Result<Vec<PastSession>, String> {
    let dir = project_transcript_dir(base, workdir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]), // project never had a session — not an error
    };

    let mut out: Vec<PastSession> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let (title, last_prompt) = match transcript_meta(&path) {
            Some(m) => m,
            None => continue,
        };
        out.push(PastSession { session_id, title, last_prompt, mtime });
    }

    // newest first (Reverse, because sort_by_key sorts ascending)
    out.sort_by_key(|s| std::cmp::Reverse(s.mtime));
    Ok(out)
}

/// Pull `(title, last_prompt)` out of one transcript. Split out of
/// `list_past_sessions` so it can be tested against a fixture file without
/// touching `$HOME` (which the parallel test threads share).
fn transcript_meta(path: &std::path::Path) -> Option<(String, String)> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    const CAP: u64 = 512 * 1024;
    let mut reader = BufReader::new(file);
    if len > CAP {
        reader.seek(SeekFrom::Start(len - CAP)).ok()?;
        let mut discard = String::new(); // drop the partial first line
        let _ = reader.read_line(&mut discard);
    }

    let (mut title, mut last_prompt, mut first_user) = (String::new(), String::new(), String::new());
    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Substring gate before the parse. Only three record types can change the
        // outcome, and once a user turn has been seen only two can — the rest of a
        // 512KB tail is assistant prose and tool traffic. Skipping their parse is
        // behaviour-neutral (their match arms do nothing) and is what makes the
        // whole-machine scan behind `list_session_history` affordable.
        if !(first_user.is_empty() || line.contains("ai-title") || line.contains("last-prompt")) {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
            // Both records recur through the file and are rewritten as the session
            // evolves — the LAST occurrence is the current one, so keep overwriting.
            "ai-title" => {
                if let Some(s) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    title = s.trim().to_string();
                }
            }
            "last-prompt" => {
                if let Some(s) = v.get("lastPrompt").and_then(|x| x.as_str()) {
                    last_prompt = s.trim().to_string();
                }
            }
            "user" if first_user.is_empty() => {
                if let Some(serde_json::Value::String(s)) =
                    v.get("message").and_then(|m| m.get("content"))
                {
                    first_user = s.trim().chars().take(200).collect();
                }
            }
            _ => {}
        }
    }
    if title.is_empty() {
        title = if !last_prompt.is_empty() { last_prompt.clone() } else { first_user };
    }
    if title.chars().count() > 120 {
        title = title.chars().take(120).collect::<String>() + "…";
    }
    Some((title, last_prompt))
}

/// The `(cwd, git_branch)` a transcript was recorded under, read from the HEAD of
/// the file.
///
/// Load-bearing for history, and the mirror image of `project_transcript_dir`: that
/// function encodes a cwd into a folder name, replacing every non-alphanumeric char
/// with `-`, and the encoding is **lossy** — `/a/b` and `-a-b` collapse to the same
/// name, and a Windows drive colon is unrecoverable. So going the other way is not
/// possible, and the real path can only come from inside the file, where every user
/// and assistant record carries `cwd` (and `gitBranch`) verbatim. The first such
/// record is within the first few lines, hence a bounded head read rather than the
/// tail scan `transcript_meta` needs for the title.
fn transcript_origin(path: &Path) -> (String, String) {
    use std::io::{BufRead, BufReader, Read};
    const CAP: u64 = 64 * 1024;
    let none = (String::new(), String::new());
    let Ok(file) = std::fs::File::open(path) else {
        return none;
    };
    for line in BufReader::new(file).take(CAP).lines().map_while(Result::ok) {
        if !line.contains("\"cwd\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("");
        if cwd.is_empty() {
            continue;
        }
        let branch = v.get("gitBranch").and_then(|x| x.as_str()).unwrap_or("");
        return (cwd.to_string(), branch.to_string());
    }
    none
}

/// One row of the History panel: a conversation Claude has on disk anywhere on this
/// machine, whether Episko launched it or not.
#[derive(serde::Serialize)]
pub(crate) struct HistorySession {
    session_id: String,
    cwd: String,
    project: String, // basename of cwd — the label, before the frontend regroups it
    branch: String,
    title: String,
    last_prompt: String,
    mtime: u64,
    bytes: u64,
    exists: bool, // its folder is still there — a resume into a deleted worktree fails
    // The repo's MAIN worktree, so every worktree of one repo groups under it — the
    // same enrichment `list_external_sessions` does, and what makes History's "this
    // project" filter catch a session that ran in a worktree *beside* the repo
    // rather than inside it. None when the folder is gone or isn't a repo.
    repo_root: Option<String>,
}

/// Every session on this machine, newest first — the backing store for the History
/// panel, and the answer to "reopen the session I closed".
///
/// `list_past_sessions` above cannot answer that: it takes a `workdir`, and Episko's
/// own roster (`cc-restore`) deliberately forgets a session the moment it's closed
/// and only ever knew the ones Episko launched. Claude's transcripts forget nothing,
/// so this walks all of `<base>/projects/*/*.jsonl` instead — making the list a
/// superset of the sidebar's dormant rows that also covers sessions started from a
/// plain terminal or an IDE.
///
/// Bounded because that corpus runs to ~1GB: the cheap `(mtime, len)` pass over dir
/// entries picks the newest `limit` files *before* anything is read, and only those
/// get the tail scan for a title. So `limit` caps the I/O, not the row count — a
/// transcript with no recoverable cwd is dropped afterwards and the result can come
/// back shorter. Like `token_usage_by_day` this is the heavy path, so it runs on a
/// blocking thread — a synchronous command would hold the main thread and freeze the
/// UI for the length of the scan.
#[tauri::command]
pub(crate) async fn list_session_history(limit: usize) -> Result<Vec<HistorySession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = claude_dir().ok_or_else(|| "no home directory".to_string())?;
        Ok(scan_history_in(&base, limit))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn scan_history_in(base: &Path, limit: usize) -> Vec<HistorySession> {
    let root = base.join("projects");
    let projects = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return vec![], // no transcripts yet — not an error
    };

    // Pass 1 — metadata only, no file contents. This is what keeps the scan bounded:
    // ranking by mtime here means the expensive pass never sees the old 95%.
    let mut files: Vec<(u64, u64, PathBuf)> = Vec::new();
    for proj in projects.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&pdir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() == 0 {
                continue; // a session that was launched but never prompted
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            files.push((mtime, meta.len(), path));
        }
    }
    files.sort_by_key(|(mtime, _, _)| std::cmp::Reverse(*mtime));
    files.truncate(if limit == 0 { 200 } else { limit });

    // Pass 2 — read the winners. Everything keyed by cwd is memoised: a project folder
    // owns many transcripts and the answer is identical for all of them, which matters
    // because `git_repo_info` spawns a process. Unique cwds are a few dozen even when
    // the file list is hundreds.
    let mut by_dir: std::collections::HashMap<String, (bool, Option<String>)> =
        std::collections::HashMap::new();
    let mut out: Vec<HistorySession> = Vec::with_capacity(files.len());
    for (mtime, bytes, path) in files {
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let (cwd, branch) = transcript_origin(&path);
        // No cwd, no honest row: `claude --resume` must run in the session's original
        // directory, and the folder name on disk can't be decoded back into one.
        if cwd.is_empty() {
            continue;
        }
        // Claude records the cwd exactly as it was typed, so the same folder shows up
        // as both `e:\proj` and `E:\proj`. Normalise to the spelling everything else in
        // the app compares against (`git_repo_info`'s root, a live session's workdir) —
        // otherwise a repo's own checkout never equals its repo_root and every row
        // reads as a worktree. Safe for the transcript lookup: off Windows this is the
        // identity, and on Windows it only touches the drive letter and separators,
        // which the case-insensitive filesystem and the `<enc>` scheme both absorb.
        let cwd = norm_path(&cwd);
        let (title, last_prompt) = transcript_meta(&path).unwrap_or_default();
        let project = cwd
            .rsplit(|c: char| c == '/' || c == '\\')
            .find(|s| !s.is_empty())
            .unwrap_or(&cwd)
            .to_string();
        let (exists, repo_root) = by_dir
            .entry(cwd.clone())
            .or_insert_with(|| {
                // No git on a folder that's gone: it would just fail, slowly.
                if !Path::new(&cwd).is_dir() {
                    return (false, None);
                }
                (true, git_repo_info(&cwd).0)
            })
            .clone();
        out.push(HistorySession {
            session_id,
            cwd,
            project,
            branch,
            title,
            last_prompt,
            mtime,
            bytes,
            exists,
            repo_root,
        });
    }
    out
}

/// The three model tiers collapsed to a family (matches the frontend's `modelFamily`).
fn model_family(model: &str) -> &'static str {
    let s = model.to_ascii_lowercase();
    if s.contains("opus") {
        "opus"
    } else if s.contains("sonnet") {
        "sonnet"
    } else if s.contains("haiku") {
        "haiku"
    } else {
        "other"
    }
}

/// One assistant message's usage, pulled from a transcript line.
struct LineUsage {
    day: String,           // YYYY-MM-DD from the line's own ISO timestamp (UTC)
    tokens: [u64; 4],      // [input, output, cache_read, cache_write]
    family: &'static str,  // opus | sonnet | haiku | other
    project: String,       // basename of the line's cwd ("by working directory")
}

/// Parse one transcript line into a `LineUsage`, or `None` for the many lines with no
/// assistant `usage` record (user turns, tool results, meta). Split out of the scan so
/// the load-bearing, format-dependent parsing can be tested without a `$HOME` the
/// parallel tests share.
fn parse_usage_line(line: &str) -> Option<LineUsage> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let usage = v
        .get("message")
        .and_then(|m| m.get("usage"))
        .or_else(|| v.get("usage"))?;
    let day = match v.get("timestamp").and_then(|t| t.as_str()) {
        Some(ts) if ts.len() >= 10 => ts[..10].to_string(),
        _ => return None,
    };
    let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let model = v
        .get("message")
        .and_then(|m| m.get("model"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let project = v
        .get("cwd")
        .and_then(|x| x.as_str())
        .and_then(|c| c.rsplit(['/', '\\']).find(|s| !s.is_empty()))
        .unwrap_or("unknown")
        .to_string();
    Some(LineUsage {
        day,
        tokens: [
            g("input_tokens"),
            g("output_tokens"),
            g("cache_read_input_tokens"),
            g("cache_creation_input_tokens"),
        ],
        family: model_family(model),
        project,
    })
}

/// One calendar day, aggregated across every transcript: token totals by type, token
/// totals by model family, the number of distinct sessions active, and per-project
/// token totals ("by working directory"). Everything except the daily $ total (which
/// lives in the telemetry rollup and can't be recovered from transcripts) is here.
#[derive(serde::Serialize, Default)]
pub(crate) struct DayUsage {
    day: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    opus: u64,
    sonnet: u64,
    haiku: u64,
    other: u64,
    sessions: u64,
    projects: std::collections::BTreeMap<String, u64>,
}

/// Aggregate transcript usage per calendar day across every Claude Code transcript
/// touched within the last `days` days — tokens (by type and by model family), the
/// count of distinct sessions active, and per-project token totals.
///
/// Tokens et al. are the figures the statusLine never reports (it carries only
/// context-window *occupancy* and a $ total), so they're recovered from each assistant
/// message's own `usage` record. That record shape is internal to Claude Code and
/// documented as unstable (the risk `list_past_sessions` already lives with), hence
/// the defensive parsing and the cheap `contains("\"usage\"")` pre-filter that skips
/// the many lines carrying no tokens.
///
/// This is the heavy path: it reads whole transcripts, so the frontend calls it off
/// the render path and caches the result. The mtime filter skips transcripts not
/// written within the window — an old, untouched file cannot hold an in-range day —
/// which keeps a full year's scan bounded to recent work. All of the model / project /
/// session breakdown rides on this one pass; it adds no extra file reads.
#[tauri::command]
pub(crate) async fn token_usage_by_day(days: u64) -> Result<Vec<DayUsage>, String> {
    // The scan reads whole transcripts (the recent corpus can run to ~1GB), so hand
    // it to a blocking thread. A *synchronous* command runs on the main thread and
    // would freeze the entire UI for the length of the first, uncached scan.
    tauri::async_runtime::spawn_blocking(move || {
        let base = claude_dir().ok_or_else(|| "no home directory".to_string())?;
        scan_usage_in(&base, days)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn scan_usage_in(base: &Path, days: u64) -> Result<Vec<DayUsage>, String> {
    use std::collections::{HashMap, HashSet};
    use std::io::{BufRead, BufReader};
    let root = base.join("projects");
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(days.saturating_mul(86_400)));

    let mut acc: HashMap<String, DayUsage> = HashMap::new();
    let projects = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]), // no transcripts yet — not an error
    };
    for proj in projects.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let files = match std::fs::read_dir(&pdir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in files.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // Skip transcripts untouched within the window: they can't hold in-range days.
            if let (Some(cut), Ok(meta)) = (cutoff, entry.metadata()) {
                if meta.modified().map(|m| m < cut).unwrap_or(false) {
                    continue;
                }
            }
            let file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            // One file == one session; remember the days it touched to count it once each.
            let mut file_days: HashSet<String> = HashSet::new();
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                let Some(lu) = parse_usage_line(&line) else { continue };
                let LineUsage { day, tokens, family, project } = lu;
                let tot: u64 = tokens.iter().sum();
                let e = acc.entry(day.clone()).or_default();
                if e.day.is_empty() {
                    e.day = day.clone();
                }
                e.input += tokens[0];
                e.output += tokens[1];
                e.cache_read += tokens[2];
                e.cache_write += tokens[3];
                match family {
                    "opus" => e.opus += tot,
                    "sonnet" => e.sonnet += tot,
                    "haiku" => e.haiku += tot,
                    _ => e.other += tot,
                }
                *e.projects.entry(project).or_insert(0) += tot;
                file_days.insert(day);
            }
            for d in file_days {
                let e = acc.entry(d.clone()).or_default();
                if e.day.is_empty() {
                    e.day = d;
                }
                e.sessions += 1;
            }
        }
    }
    let mut out: Vec<DayUsage> = acc.into_values().collect();
    out.sort_by(|a, b| a.day.cmp(&b.day));
    Ok(out)
}

/// Read a read-only slice of an external session's transcript. The transcript
/// lives at `~/.claude/projects/<enc>/<session_id>.jsonl`, where `<enc>` is the
/// cwd with every non-alphanumeric char replaced by `-`. Only the tail (≤512KB)
/// is read; only human/assistant prose is extracted (tool calls, tool results and
/// thinking are dropped), and the last `limit` messages are returned.
#[tauri::command(async)]
pub(crate) fn read_transcript(cwd: String, session_id: String, limit: usize) -> Result<Vec<TranscriptMsg>, String> {
    let base = claude_dir().ok_or_else(|| "no home directory".to_string())?;
    read_transcript_in(&base, &cwd, &session_id, limit)
}

fn read_transcript_in(base: &Path, cwd: &str, session_id: &str, limit: usize) -> Result<Vec<TranscriptMsg>, String> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let path = project_transcript_dir(base, cwd).join(format!("{session_id}.jsonl"));
    let file = std::fs::File::open(&path).map_err(|e| format!("transcript not found: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    const CAP: u64 = 512 * 1024;
    let mut reader = BufReader::new(file);
    if len > CAP {
        reader.seek(SeekFrom::Start(len - CAP)).map_err(|e| e.to_string())?;
        let mut discard = String::new(); // drop the partial first line
        let _ = reader.read_line(&mut discard);
    }

    let mut msgs: Vec<TranscriptMsg> = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t != "user" && t != "assistant" {
            continue;
        }
        let content = v.get("message").and_then(|m| m.get("content"));
        let mut text = String::new();
        match content {
            Some(serde_json::Value::String(s)) => text.push_str(s),
            Some(serde_json::Value::Array(arr)) => {
                // Only "text" blocks: tool calls (Bash, Read, Edit, …), tool_result
                // echoes and thinking blocks are noise in a read-only conversation
                // mirror — keep the human/assistant prose. An assistant turn that is
                // only tool calls collapses to empty and is dropped below.
                for blk in arr {
                    if blk.get("type").and_then(|x| x.as_str()) == Some("text") {
                        if let Some(s) = blk.get("text").and_then(|x| x.as_str()) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(s);
                        }
                    }
                }
            }
            _ => {}
        }
        let mut text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if text.len() > 4000 {
            text.truncate(4000);
            text.push('…');
        }
        msgs.push(TranscriptMsg { role: t.to_string(), text });
    }
    let n = msgs.len();
    if n > limit {
        msgs = msgs.split_off(n - limit);
    }
    Ok(msgs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{git, scratch_dir};

    /// History rows live or die on this: `project_transcript_dir` encodes a cwd
    /// lossily, so the real path (and the branch) can only come from inside the file —
    /// including a Windows path, whose backslashes and drive colon are exactly what the
    /// folder name destroys.
    #[test]
    fn transcript_origin_recovers_the_cwd_from_inside_the_file() {
        let dir = scratch_dir();

        let a = dir.join("a.jsonl");
        std::fs::write(
            &a,
            concat!(
                r#"{"type":"mode","mode":"normal"}"#, "\n",
                r#"{"type":"user","message":{"content":"hi"},"cwd":"E:\\Programming\\episko","gitBranch":"dev"}"#, "\n",
            ),
        )
        .unwrap();
        assert_eq!(
            transcript_origin(&a),
            ("E:\\Programming\\episko".to_string(), "dev".to_string())
        );

        // A repo with no branch (detached, or not a repo at all) still yields its cwd.
        let b = dir.join("b.jsonl");
        std::fs::write(&b, "{\"type\":\"user\",\"cwd\":\"/home/me/proj\"}\n").unwrap();
        assert_eq!(transcript_origin(&b), ("/home/me/proj".to_string(), String::new()));

        // No cwd anywhere → empty, and scan_history drops the row rather than guessing.
        let c = dir.join("c.jsonl");
        std::fs::write(&c, "{\"type\":\"ai-title\",\"aiTitle\":\"no cwd here\"}\n").unwrap();
        assert_eq!(transcript_origin(&c), (String::new(), String::new()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The rules that decide what History can offer: newest first, capped by `limit`,
    /// no row without a resumable cwd, a worktree resolved back to its repo, and a
    /// folder that's gone flagged rather than hidden (a deleted worktree still reads).
    #[test]
    fn scan_history_ranks_by_mtime_and_drops_what_cannot_resume() {
        let dir = scratch_dir();
        let base = dir.join("claude");
        let root = base.join("projects");
        let live = dir.join("live-project");
        std::fs::create_dir_all(root.join("proj-a")).unwrap();
        std::fs::create_dir_all(root.join("proj-b")).unwrap();
        std::fs::create_dir_all(&live).unwrap();
        let live_s = live.to_string_lossy().replace('\\', "\\\\");

        // A repo plus a linked worktree BESIDE it — the layout no path-prefix test can
        // group, and the reason rows carry a backend-resolved repo_root at all.
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = dir.join("repo-wt");
        git(&repo, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
        let wt_s = wt.to_string_lossy().replace('\\', "\\\\");

        // mtimes are set explicitly: writing the files back to back lands them in the
        // same second, which would make the ordering assertion below pass by accident.
        let touch = |name: &str, body: &str, age_secs: u64| {
            let p = root.join(name);
            std::fs::write(&p, body).unwrap();
            let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
            f.set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 - age_secs)).unwrap();
        };
        touch(
            "proj-a/newest.jsonl",
            &format!(
                "{}\n{}\n",
                format!(r#"{{"type":"user","cwd":"{live_s}","gitBranch":"dev"}}"#),
                r#"{"type":"ai-title","aiTitle":"The newest one"}"#
            ),
            0,
        );
        touch(
            "proj-b/older.jsonl",
            &format!("{}\n", format!(r#"{{"type":"user","cwd":"{live_s}","message":{{"content":"an older chat"}}}}"#)),
            60,
        );
        touch(
            "proj-a/worktree.jsonl",
            &format!("{}\n", format!(r#"{{"type":"user","cwd":"{wt_s}","gitBranch":"side"}}"#)),
            90,
        );
        // Deleted worktree: readable, but not resumable — it must still be listed.
        let missing = dir.join("removed-worktree");
        let missing_s = missing.to_string_lossy().replace('\\', "\\\\");
        touch(
            "proj-a/gone.jsonl",
            &format!("{}\n", format!(r#"{{"type":"user","cwd":"{missing_s}","gitBranch":"wip"}}"#)),
            120,
        );
        // Dropped: no cwd to resume into, empty file, and a non-transcript.
        touch("proj-b/nocwd.jsonl", "{\"type\":\"ai-title\",\"aiTitle\":\"orphan\"}\n", 30);
        touch("proj-a/empty.jsonl", "", 10);
        touch("proj-a/notes.txt", "not a transcript\n", 5);

        let out = scan_history_in(&base, 0);
        let ids: Vec<&str> = out.iter().map(|h| h.session_id.as_str()).collect();
        assert_eq!(ids, vec!["newest", "older", "worktree", "gone"], "newest first, unresumable rows dropped");

        // The whole point of repo_root: a session that ran in the worktree resolves to
        // the repo, so "this project" in History covers both checkouts.
        let side = out.iter().find(|h| h.session_id == "worktree").unwrap();
        assert_eq!(side.repo_root.as_deref(), Some(norm_path(&repo.to_string_lossy()).as_str()));
        assert_eq!(side.branch, "side");
        assert_eq!(out[0].repo_root, None, "a folder that isn't a repo has no root to group under");

        assert_eq!(out[0].title, "The newest one");
        assert_eq!(out[0].branch, "dev");
        assert_eq!(out[0].cwd, norm_path(&live.to_string_lossy()));
        assert_eq!(out[0].project, "live-project", "labelled by the leaf of its own cwd");
        assert!(out[0].exists);

        assert_eq!(out[1].title, "an older chat", "no ai-title → the first user message stands in");

        let gone = out.iter().find(|h| h.session_id == "gone").unwrap();
        assert_eq!(gone.project, "removed-worktree");
        assert!(!gone.exists, "a vanished folder is flagged, not hidden");
        assert_eq!(gone.repo_root, None, "no git is run on a folder that isn't there");

        // `limit` bounds the files READ, not the rows returned — it exists to cap I/O,
        // and the unresumable ones are dropped after. Asking for 2 here reads the two
        // newest transcripts (`newest` and the cwd-less `nocwd`) and yields just one.
        let capped = scan_history_in(&base, 2);
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].session_id, "newest");
        assert!(scan_history_in(&dir.join("nope"), 0).is_empty(), "a missing base is empty, not an error");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Claude writes the cwd exactly as the user typed it, so the same folder appears
    /// as both `e:\proj` and `E:\proj` across transcripts. Everything History compares
    /// against — `git_repo_info`'s root, a live session's workdir — is normalised, so
    /// a raw cwd made a repo's own checkout unequal to its own repo_root and every row
    /// in it read as a worktree.
    #[cfg(windows)]
    #[test]
    fn scan_history_normalises_the_cwd_it_reads_from_a_transcript() {
        let dir = scratch_dir();
        let base = dir.join("claude");
        std::fs::create_dir_all(base.join("projects/p")).unwrap();

        let real = norm_path(&dir.to_string_lossy()); // C:\Users\…\episko_git_diff_test_N
        let typed = format!("{}{}", real[..1].to_ascii_lowercase(), &real[1..]).replace('\\', "/");
        assert_ne!(typed, real, "fixture must actually differ in spelling");
        std::fs::write(
            base.join("projects/p/s.jsonl"),
            format!("{{\"type\":\"user\",\"cwd\":\"{}\"}}\n", typed.replace('\\', "\\\\")),
        )
        .unwrap();

        let out = scan_history_in(&base, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].cwd, real, "the row carries the app-wide spelling, not the typed one");
        assert!(out[0].exists, "and it still resolves on disk");

        let _ = std::fs::remove_dir_all(&dir);
    }


    #[test]
    fn parse_usage_line_extracts_day_tokens_family_and_project() {
        let line = r#"{"type":"assistant","timestamp":"2026-07-21T10:00:00.000Z","cwd":"/Users/tim/dev/episko","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":300,"cache_creation_input_tokens":4}}}"#;
        let lu = parse_usage_line(line).expect("assistant usage line should parse");
        assert_eq!(lu.day, "2026-07-21");
        assert_eq!(lu.tokens, [10, 20, 300, 4]);
        assert_eq!(lu.family, "opus");
        assert_eq!(lu.project, "episko"); // basename of cwd
        // Missing token fields default to 0; unknown model → "other"; no cwd → "unknown".
        let partial = r#"{"timestamp":"2026-07-21T10:00:00Z","message":{"usage":{"output_tokens":7}}}"#;
        let lu = parse_usage_line(partial).expect("should parse");
        assert_eq!(lu.tokens, [0, 7, 0, 0]);
        assert_eq!(lu.family, "other");
        assert_eq!(lu.project, "unknown");
    }

    #[test]
    fn parse_usage_line_skips_lines_without_usage() {
        // The cheap pre-filter and the shape checks both reject non-usage lines.
        assert!(parse_usage_line(r#"{"type":"user","timestamp":"2026-07-21T10:00:00Z"}"#).is_none());
        assert!(parse_usage_line("not json at all").is_none());
        // A usage record with no timestamp can't be bucketed, so it's dropped.
        assert!(parse_usage_line(r#"{"message":{"usage":{"input_tokens":5}}}"#).is_none());
    }

    #[test]
    fn model_family_buckets_by_tier() {
        assert_eq!(model_family("claude-opus-4-8"), "opus");
        assert_eq!(model_family("claude-sonnet-4-5"), "sonnet");
        assert_eq!(model_family("claude-haiku-4-5-20251001"), "haiku");
        assert_eq!(model_family("some-future-model"), "other");
    }

    /// `ai-title` and `last-prompt` are rewritten repeatedly as a session evolves,
    /// so the newest one at the end of the file has to win over the earlier ones.
    #[test]
    fn transcript_meta_takes_the_last_title_and_prompt() {
        let dir = scratch_dir();
        let path = dir.join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","message":{"content":"the very first thing I asked"}}"#, "\n",
                r#"{"type":"ai-title","aiTitle":"An early guess"}"#, "\n",
                r#"{"type":"last-prompt","lastPrompt":"an early prompt"}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#, "\n",
                r#"{"type":"ai-title","aiTitle":"What it settled on"}"#, "\n",
                r#"{"type":"last-prompt","lastPrompt":"the latest prompt"}"#, "\n",
            ),
        )
        .unwrap();
        let (title, last) = transcript_meta(&path).unwrap();
        assert_eq!(title, "What it settled on");
        assert_eq!(last, "the latest prompt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The record types are internal to Claude Code and documented as unstable, so a
    /// transcript without `ai-title` must still yield something human-readable.
    #[test]
    fn transcript_meta_falls_back_when_no_ai_title() {
        let dir = scratch_dir();

        // No ai-title → the last prompt stands in.
        let a = dir.join("a.jsonl");
        std::fs::write(
            &a,
            concat!(
                r#"{"type":"user","message":{"content":"opening message"}}"#, "\n",
                r#"{"type":"last-prompt","lastPrompt":"what I asked most recently"}"#, "\n",
            ),
        )
        .unwrap();
        assert_eq!(transcript_meta(&a).unwrap().0, "what I asked most recently");

        // Neither → the first user message stands in.
        let b = dir.join("b.jsonl");
        std::fs::write(&b, "{\"type\":\"user\",\"message\":{\"content\":\"opening message\"}}\n").unwrap();
        assert_eq!(transcript_meta(&b).unwrap().0, "opening message");

        // Garbage lines are skipped, not fatal — a torn write must not lose the title.
        let c = dir.join("c.jsonl");
        std::fs::write(
            &c,
            concat!("not json at all\n", r#"{"type":"ai-title","aiTitle":"Survived"}"#, "\n", "{\"truncated\":"),
        )
        .unwrap();
        assert_eq!(transcript_meta(&c).unwrap().0, "Survived");

        // An empty transcript yields an empty title (the frontend labels it).
        let d = dir.join("d.jsonl");
        std::fs::write(&d, "").unwrap();
        assert_eq!(transcript_meta(&d).unwrap().0, "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A transcript bigger than the 512KB tail cap must still surface the newest
    /// title — the whole point of scanning the tail rather than the head.
    #[test]
    fn transcript_meta_reads_the_tail_of_a_large_transcript() {
        let dir = scratch_dir();
        let path = dir.join("big.jsonl");
        let filler = format!(
            "{}\n",
            serde_json::json!({ "type": "assistant", "message": { "content": "x".repeat(4000) } })
        );
        let mut body = String::new();
        body.push_str(r#"{"type":"ai-title","aiTitle":"Stale head title"}"#);
        body.push('\n');
        while body.len() < 900 * 1024 {
            body.push_str(&filler);
        }
        body.push_str(r#"{"type":"ai-title","aiTitle":"Fresh tail title"}"#);
        body.push('\n');
        std::fs::write(&path, &body).unwrap();

        assert!(body.len() as u64 > 512 * 1024, "fixture must exceed the tail cap");
        assert_eq!(transcript_meta(&path).unwrap().0, "Fresh tail title");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- against a fixture ~/.claude ----------
    //
    // Everything below drives the `*_in(base, …)` functions the base-dir injection
    // introduced. Before it, these three could only be run against the developer's
    // real `~/.claude` — which cargo's parallel test threads share, and which has no
    // known contents.

    /// Set a file's mtime, via std rather than a new dependency — `FileTimes` has
    /// been stable since 1.75 and this is the only thing the tests need it for.
    fn set_mtime(path: &Path, t: std::time::SystemTime) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }

    /// Build `<scratch>/projects/<enc(cwd)>/` and return (base, project dir), so a
    /// fixture is laid out exactly where the encoder will look for it.
    fn fixture(cwd: &str) -> (PathBuf, PathBuf) {
        let base = scratch_dir();
        let proj = project_transcript_dir(&base, cwd);
        std::fs::create_dir_all(&proj).unwrap();
        (base, proj)
    }

    /// The cwd → `<enc>` scheme Claude Code uses for a project's transcript folder.
    /// Everything that isn't ASCII-alphanumeric becomes `-`, which is why both a
    /// POSIX and a Windows path collapse the same way.
    #[test]
    fn project_dir_encodes_every_non_alphanumeric_char() {
        let base = Path::new("/base");
        assert_eq!(
            project_transcript_dir(base, "/Users/tim/dev/episko"),
            base.join("projects").join("-Users-tim-dev-episko")
        );
        assert_eq!(
            project_transcript_dir(base, r"E:\Work\Respeak"),
            base.join("projects").join("E--Work-Respeak")
        );
        // Dots, spaces and non-ASCII letters are all "not alphanumeric".
        assert_eq!(
            project_transcript_dir(base, "/a b/.git/über"),
            base.join("projects").join("-a-b--git--ber")
        );
        assert_eq!(project_transcript_dir(base, ""), base.join("projects").join(""));
    }

    /// The verbatim prefix Windows' `canonicalize` adds, which must not reach the
    /// encoder. Pure string work, so it is checked on every OS rather than only on the
    /// leg that can produce one — this is the half of the symlink fix that a macOS
    /// developer would otherwise never run.
    #[test]
    fn verbatim_prefixes_are_stripped_before_encoding() {
        assert_eq!(strip_verbatim(r"\\?\C:\Work\Respeak"), r"C:\Work\Respeak");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\proj"), r"\\srv\share\proj");
        // Anything already in its normal form is returned untouched, on either OS.
        assert_eq!(strip_verbatim(r"C:\Work\Respeak"), r"C:\Work\Respeak");
        assert_eq!(strip_verbatim("/Users/tim/dev"), "/Users/tim/dev");
    }

    /// A project reached through a symlink must resolve to the same transcript folder
    /// as the real path, because that is the only one Claude ever writes: `getcwd()`
    /// reports the physical path however the process got there. Before this, the list
    /// of past sessions for such a project was silently empty.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_workdir_finds_the_real_project_dir() {
        let root = scratch_dir();
        let real = root.join("real");
        let link = root.join("link");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let base = Path::new("/base");
        let via_link = project_transcript_dir(base, &link.to_string_lossy());
        assert_eq!(
            via_link,
            project_transcript_dir(base, &real.to_string_lossy()),
            "the two spellings of one directory must encode identically"
        );
        // And specifically to the real one — an assertion the line above would still
        // satisfy if both sides were wrong in the same way.
        let name = via_link.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.ends_with("-real"), "encoded the link's own name: {name}");
    }

    /// The restorable-sessions list: newest first, labelled by the fallback chain, and
    /// nothing in the folder that isn't a transcript.
    #[test]
    fn list_past_sessions_orders_by_mtime_and_ignores_non_transcripts() {
        let cwd = "/Users/tim/dev/proj";
        let (base, proj) = fixture(cwd);

        let write = |name: &str, body: &str| {
            std::fs::write(proj.join(name), body).unwrap();
        };
        write("older.jsonl", "{\"type\":\"ai-title\",\"aiTitle\":\"The older one\"}\n");
        write("newer.jsonl", "{\"type\":\"last-prompt\",\"lastPrompt\":\"no title, so this\"}\n");
        // Not transcripts: a different extension, and an extensionless file.
        write("notes.txt", "ignore me");
        write("README", "ignore me too");

        // Make the ordering unambiguous rather than relying on write order — a
        // filesystem with coarse mtime granularity would otherwise flake.
        let day = std::time::SystemTime::now() - std::time::Duration::from_secs(86_400);
        set_mtime(&proj.join("older.jsonl"), day);

        let out = list_past_sessions_in(&base, cwd).expect("a project with transcripts");
        assert_eq!(out.len(), 2, "only the two .jsonl files are sessions");
        assert_eq!(out[0].session_id, "newer", "newest first");
        assert_eq!(out[0].title, "no title, so this", "falls back to last-prompt");
        assert_eq!(out[1].session_id, "older");
        assert_eq!(out[1].title, "The older one");
        assert!(out[0].mtime > out[1].mtime);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A project Claude has never written a transcript for is empty, not an error —
    /// the Resume list simply has nothing to offer.
    #[test]
    fn list_past_sessions_is_empty_for_an_unknown_project() {
        let base = scratch_dir();
        assert!(list_past_sessions_in(&base, "/never/seen").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The read-only mirror. Only human/assistant prose survives: tool calls, tool
    /// results and thinking blocks are noise in a conversation view, and an assistant
    /// turn that is *only* tool calls collapses to nothing and is dropped entirely.
    #[test]
    fn read_transcript_keeps_prose_and_drops_tool_traffic() {
        let cwd = "/Users/tim/dev/mirror";
        let (base, proj) = fixture(cwd);
        std::fs::write(
            proj.join("sid.jsonl"),
            concat!(
                r#"{"type":"user","message":{"content":"plain string content"}}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"first"},{"type":"text","text":"second"}]}}"#, "\n",
                // A block whose type we don't know but which happens to carry a
                // `text` field. The filter is a whitelist on `type`, deliberately:
                // this format is unstable, so an unrecognised block must stay out of
                // a conversation mirror rather than leak in on a field-name match.
                r#"{"type":"assistant","message":{"content":[{"type":"redacted_thinking","text":"should not appear"}]}}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#, "\n",
                r#"{"type":"system","message":{"content":"not a turn"}}"#, "\n",
                "torn write, not json\n",
                r#"{"type":"user","message":{"content":"   "}}"#, "\n",
                r#"{"type":"user","message":{"content":"last human turn"}}"#, "\n",
            ),
        )
        .unwrap();

        let msgs = read_transcript_in(&base, cwd, "sid", 100).expect("transcript exists");
        let got: Vec<(&str, &str)> = msgs.iter().map(|m| (m.role.as_str(), m.text.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("user", "plain string content"),
                ("assistant", "first\nsecond"), // text blocks joined, thinking dropped
                ("user", "last human turn"),    // the tool-only turn, the system line,
            ],                                  // the garbage and the blank all dropped
        );

        // `limit` takes the LAST n, because the mirror shows the end of a conversation.
        let tail = read_transcript_in(&base, cwd, "sid", 1).unwrap();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].text, "last human turn");

        // A session id with no transcript is an error, not an empty mirror — the UI
        // must be able to tell "nothing was said" from "there is no such session".
        assert!(read_transcript_in(&base, cwd, "no-such-session", 10).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// One over-long message is truncated rather than shipped whole across the IPC
    /// boundary and into the DOM.
    #[test]
    fn read_transcript_truncates_a_huge_message() {
        let cwd = "/Users/tim/dev/huge";
        let (base, proj) = fixture(cwd);
        let line = serde_json::json!({
            "type": "user",
            "message": { "content": "x".repeat(9000) },
        });
        std::fs::write(proj.join("sid.jsonl"), format!("{line}\n")).unwrap();

        let msgs = read_transcript_in(&base, cwd, "sid", 10).unwrap();
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].text.ends_with('…'), "truncation must be visible: {}", &msgs[0].text[..40]);
        assert_eq!(msgs[0].text.chars().count(), 4001, "4000 chars plus the ellipsis");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The token ledger, folded across two projects: totals by type and by family,
    /// the per-project breakdown, days sorted ascending, and — the fiddly one — a
    /// session counted **once per day it touched**, not once per usage line.
    #[test]
    fn scan_usage_folds_days_families_and_counts_sessions_once() {
        let base = scratch_dir();
        let write = |proj: &str, file: &str, body: &str| {
            let d = base.join("projects").join(proj);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join(file), body).unwrap();
        };
        let line = |day: &str, cwd: &str, model: &str, toks: [u64; 4]| {
            format!(
                concat!(
                    r#"{{"type":"assistant","timestamp":"{}T10:00:00.000Z","cwd":"{}","message":{{"model":"{}","#,
                    r#""usage":{{"input_tokens":{},"output_tokens":{},"cache_read_input_tokens":{},"cache_creation_input_tokens":{}}}}}}}"#,
                    "\n"
                ),
                day, cwd, model, toks[0], toks[1], toks[2], toks[3]
            )
        };

        // One session spanning two days, with two lines on the first day.
        write(
            "-work-alpha",
            "s1.jsonl",
            &format!(
                "{}{}{}",
                line("2026-07-20", "/work/alpha", "claude-opus-4-8", [10, 1, 0, 0]),
                line("2026-07-20", "/work/alpha", "claude-sonnet-4-5", [20, 2, 0, 0]),
                line("2026-07-21", "/work/alpha", "claude-haiku-4-5", [5, 0, 7, 3]),
            ),
        );
        // A second session, same day as the first, different project.
        write(
            "-work-beta",
            "s2.jsonl",
            &line("2026-07-20", "/work/beta", "some-future-model", [1, 1, 1, 1]),
        );
        // Not a transcript, and a stray file at the project level.
        write("-work-beta", "notes.md", "ignored");

        let days = scan_usage_in(&base, 3650).expect("a populated fixture");
        assert_eq!(days.iter().map(|d| d.day.as_str()).collect::<Vec<_>>(), ["2026-07-20", "2026-07-21"],
            "ascending by day");

        let d20 = &days[0];
        assert_eq!((d20.input, d20.output, d20.cache_read, d20.cache_write), (31, 4, 1, 1));
        assert_eq!(d20.opus, 11);
        assert_eq!(d20.sonnet, 22);
        assert_eq!(d20.other, 4, "an unrecognised model falls into `other`");
        assert_eq!(d20.haiku, 0);
        assert_eq!(d20.sessions, 2, "two files touched this day");
        assert_eq!(d20.projects.get("alpha"), Some(&33), "keyed by cwd basename");
        assert_eq!(d20.projects.get("beta"), Some(&4));

        let d21 = &days[1];
        assert_eq!(d21.haiku, 15);
        assert_eq!(d21.sessions, 1, "the SAME file again — counted once per day, not per line");
        assert_eq!(d21.projects.get("beta"), None, "beta wasn't active on the 21st");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The window is what keeps a full-year scan bounded: a transcript untouched
    /// within it cannot hold an in-range day, so it is skipped without being read.
    #[test]
    fn scan_usage_skips_transcripts_older_than_the_window() {
        let base = scratch_dir();
        let d = base.join("projects").join("-work-alpha");
        std::fs::create_dir_all(&d).unwrap();
        let body = concat!(
            r#"{"type":"assistant","timestamp":"2026-07-20T10:00:00.000Z","cwd":"/work/alpha","#,
            r#""message":{"model":"claude-opus-4-8","usage":{"input_tokens":10}}}"#, "\n"
        );
        std::fs::write(d.join("stale.jsonl"), body).unwrap();

        // In range with a generous window...
        assert_eq!(scan_usage_in(&base, 3650).unwrap().len(), 1);

        // ...and skipped once its mtime falls outside a tight one.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 86_400);
        set_mtime(&d.join("stale.jsonl"), old);
        assert!(scan_usage_in(&base, 2).unwrap().is_empty(), "outside the window, not read at all");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// No transcripts at all is an empty ledger, not an error — a fresh install.
    #[test]
    fn scan_usage_is_empty_without_a_projects_dir() {
        let base = scratch_dir();
        assert!(scan_usage_in(&base, 30).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }
}
