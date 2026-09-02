//! Everything Episko reads out of `~/.claude`: the transcripts and the token ledger.
//! That layout is internal to Claude Code and unstable, so every reader is a fallback
//! chain, and every reader takes its base dir so a test can point it at a fixture tree.

use std::path::{Path, PathBuf};

use crate::git::repo_root_of;
use crate::platform::{home_dir, norm_path, physical_cwd};

/// None when there is no home directory; every caller reports that rather than hiding it.
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

/// Claude's `<base>/projects/<enc>/`, where `<enc>` is the physical cwd with every
/// non-ASCII-alphanumeric char replaced by `-`.
fn project_transcript_dir(base: &Path, cwd: &str) -> PathBuf {
    let enc: String = physical_cwd(cwd)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    base.join("projects").join(enc)
}

/// A session on disk, restorable via `claude --resume <id>`.
#[derive(serde::Serialize)]
pub(crate) struct PastSession {
    session_id: String,
    title: String,
    last_prompt: String,
    last_active: u64, // epoch secs of the newest record, never the mtime; see TranscriptMeta
}

/// The transcripts Claude wrote for `workdir`, newest by `last_active`, each labelled
/// `ai-title` -> `last-prompt` -> first user message -> "" (the caller labels it).
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

        let meta = match transcript_meta(&path) {
            Some(m) => m,
            None => continue,
        };
        let last_active = meta.last_active_or(mtime);
        out.push(PastSession {
            session_id,
            title: meta.title,
            last_prompt: meta.last_prompt,
            last_active,
        });
    }

    out.sort_by_key(|s| std::cmp::Reverse(s.last_active));
    Ok(out)
}

/// What a tail scan recovers from a transcript: its label and when it was last used.
#[derive(Default)]
struct TranscriptMeta {
    title: String,
    last_prompt: String,
    /// Newest timestamp the records claim (epoch secs), 0 when none. Never the mtime:
    /// Claude appends untimestamped bookkeeping records at shutdown, so every open
    /// transcript's mtime becomes the shutdown, hours off and identical across sessions.
    last_active: u64,
}

impl TranscriptMeta {
    /// The transcript's own answer, or the mtime: a session that never completed a turn
    /// has no timestamp to read, and an mtime still beats 1970.
    fn last_active_or(&self, mtime: u64) -> u64 {
        if self.last_active > 0 {
            self.last_active
        } else {
            mtime
        }
    }
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's `days_from_civil`); the only
/// calendar arithmetic here, not worth a `chrono` dependency.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-08-17T08:08:18.686Z` -> epoch seconds, `None` for any other shape: the caller's
/// mtime fallback beats a misparsed date. The offset is ignored, since Claude writes UTC.
fn iso_epoch_secs(ts: &str) -> Option<u64> {
    let b = ts.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { ts.get(r)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    u64::try_from(days_from_civil(y, mo, d) * 86_400 + h * 3_600 + mi * 60 + s).ok()
}

/// The newest `"timestamp"` in one line. A substring scan rather than a parse: this runs
/// on every line of every tail window, including the ones the metadata scan skips parsing.
fn line_timestamp(line: &str) -> u64 {
    const NEEDLE: &str = "\"timestamp\":\"";
    let mut best = 0;
    for (i, _) in line.match_indices(NEEDLE) {
        let rest = &line[i + NEEDLE.len()..];
        let end = rest.find('"').unwrap_or(rest.len());
        if let Some(t) = iso_epoch_secs(&rest[..end]) {
            best = best.max(t);
        }
    }
    best
}

/// One transcript's `TranscriptMeta`, read from its tail.
fn transcript_meta(path: &std::path::Path) -> Option<TranscriptMeta> {
    // The fast read answers nearly every file (the newest record sits within ~30KB of EOF)
    // and widens only when neither record was found, the one case where the `first_user`
    // fallback depends on how far back we looked. The result equals one CAP_FULL read.
    const CAP_FAST: u64 = 64 * 1024;
    const CAP_FULL: u64 = 512 * 1024;
    let (meta, found) = transcript_meta_within(path, CAP_FAST)?;
    if found {
        return Some(meta);
    }
    Some(transcript_meta_within(path, CAP_FULL)?.0)
}

/// One pass over the last `cap` bytes. The bool says this window answered everything,
/// i.e. reading further back could not change any of the three outputs.
fn transcript_meta_within(path: &std::path::Path, cap: u64) -> Option<(TranscriptMeta, bool)> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let cap = cap.min(512 * 1024);
    let mut reader = BufReader::new(file);
    if len > cap {
        reader.seek(SeekFrom::Start(len - cap)).ok()?;
        let mut discard = String::new(); // drop the partial first line
        let _ = reader.read_line(&mut discard);
    }

    let (mut title, mut last_prompt, mut first_user) = (String::new(), String::new(), String::new());
    // Both must be seen before the caller may stop: a window holding `last-prompt` but not
    // `ai-title` would label the row with the raw prompt while the title sits further back.
    let (mut saw_title, mut saw_prompt) = (false, false);
    let mut last_active: u64 = 0;
    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Before the gate: the newest timestamp rides on the records the gate skips.
        last_active = last_active.max(line_timestamp(line));
        // Only three record types can change the outcome; skipping the parse of the rest
        // is what keeps the whole-machine scan behind `list_session_history` affordable.
        if !(first_user.is_empty() || line.contains("ai-title") || line.contains("last-prompt")) {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
            // Both recur and are rewritten as the session evolves: the last occurrence wins.
            "ai-title" => {
                saw_title = true;
                if let Some(s) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    title = s.trim().to_string();
                }
            }
            "last-prompt" => {
                saw_prompt = true;
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
    Some((
        TranscriptMeta { title, last_prompt, last_active },
        saw_title && saw_prompt && last_active > 0,
    ))
}

/// The `(cwd, git_branch)` a transcript was recorded under, read from its head. The folder
/// name is a lossy encoding of the cwd, so the real path can only come from inside the file.
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

/// One row of the History panel: a conversation on disk anywhere on this machine.
#[derive(serde::Serialize)]
pub(crate) struct HistorySession {
    session_id: String,
    cwd: String,
    project: String, // basename of cwd — the label, before the frontend regroups it
    branch: String,
    title: String,
    last_prompt: String,
    last_active: u64, // epoch secs of the newest record, never the mtime; see TranscriptMeta
    bytes: u64,
    exists: bool, // its folder is still there — a resume into a deleted worktree fails
    /// The repo's MAIN worktree, so every worktree of one repo groups under it in History.
    /// None when the folder is gone or is not a repo.
    repo_root: Option<String>,
}

/// Every session on this machine, newest first: History's backing store, a superset of the
/// sidebar's dormant rows. `limit` caps the files read (ranked by mtime before anything is
/// opened), not the rows returned, since unresumable rows are dropped afterwards. Runs on
/// a blocking thread: a synchronous command would freeze the UI for the length of the scan.
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

    // The Trail summariser's own transcripts (one `claude -p` per day) are skipped by directory
    // in pass 1, not filtered later: newest on disk, they would take the `limit` slots.
    let summariser = crate::summarize::scratch_cwd();
    let summariser_dir = project_transcript_dir(base, &summariser.to_string_lossy());

    // Pass 1: metadata only. Ranking by mtime here keeps the expensive pass off the old 95%.
    let mut files: Vec<(u64, u64, PathBuf)> = Vec::new();
    for proj in projects.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() || pdir == summariser_dir {
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

    // Pass 2: read the winners. Everything keyed by cwd is memoised, since `repo_root_of`
    // does filesystem I/O per call and a project folder owns many transcripts.
    let mut by_dir: std::collections::HashMap<String, (bool, Option<String>)> =
        std::collections::HashMap::new();
    let mut out: Vec<HistorySession> = Vec::with_capacity(files.len());
    for (mtime, bytes, path) in files {
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let (cwd, branch) = transcript_origin(&path);
        // No cwd, no row: `--resume` must run in the session's original directory.
        if cwd.is_empty() {
            continue;
        }
        // Claude records the cwd as typed (`e:\proj` and `E:\proj` both occur). Normalise to
        // the spelling the app compares against, or a checkout never equals its own repo_root.
        let cwd = norm_path(&cwd);
        let meta = transcript_meta(&path).unwrap_or_default();
        let project = cwd
            .rsplit(['/', '\\'])
            .find(|s| !s.is_empty())
            .unwrap_or(&cwd)
            .to_string();
        let (exists, repo_root) = by_dir
            .entry(cwd.clone())
            .or_insert_with(|| {
                if !Path::new(&cwd).is_dir() {
                    return (false, None);
                }
                (true, repo_root_of(&cwd))
            })
            .clone();
        let last_active = meta.last_active_or(mtime);
        out.push(HistorySession {
            session_id,
            cwd,
            project,
            branch,
            title: meta.title,
            last_prompt: meta.last_prompt,
            last_active,
            bytes,
            exists,
            repo_root,
        });
    }
    // Pass 1's mtime order is only an approximation, and the frontend does not re-sort.
    out.sort_by_key(|h| std::cmp::Reverse(h.last_active));
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

struct LineUsage {
    day: String,           // YYYY-MM-DD from the line's own ISO timestamp (UTC)
    tokens: [u64; 4],      // [input, output, cache_read, cache_write]
    family: &'static str,  // opus | sonnet | haiku | other
    cwd: String,           // the line's cwd verbatim; `project_label` groups it
    /// `message.id`. Claude Code writes one line per content block, each repeating the
    /// same `usage`, so the scan dedupes on this; a record with no id is counted as it is.
    id: Option<String>,
}

/// One transcript line's usage, or `None` for the many lines with no assistant `usage` record.
fn parse_usage_line(line: &str) -> Option<LineUsage> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let usage = v
        .get("message")
        .and_then(|m| m.get("usage"))
        .or_else(|| v.get("usage"))?;
    // `get(..10)`, not `[..10]`: a torn line's timestamp must skip the record, not panic the scan.
    let day = v.get("timestamp").and_then(|t| t.as_str()).and_then(|ts| ts.get(..10))?.to_string();
    let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let model = v
        .get("message")
        .and_then(|m| m.get("model"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let cwd = v
        .get("cwd")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let id = v
        .get("message")
        .and_then(|m| m.get("id"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Some(LineUsage {
        day,
        tokens: [
            g("input_tokens"),
            g("output_tokens"),
            g("cache_read_input_tokens"),
            g("cache_creation_input_tokens"),
        ],
        family: model_family(model),
        cwd,
        id,
    })
}

/// What to file a line's tokens under: the repo root's basename, not the cwd's, so a
/// worktree groups with its repo as the frontend's $ split does. `memo` because
/// `repo_root_of` does filesystem I/O per call. A vanished or non-repo cwd keeps its basename.
fn project_label(cwd: &str, memo: &mut std::collections::HashMap<String, String>) -> String {
    if let Some(hit) = memo.get(cwd) {
        return hit.clone();
    }
    let root = repo_root_of(cwd);
    let label = root
        .as_deref()
        .unwrap_or(cwd)
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string();
    memo.insert(cwd.to_string(), label.clone());
    label
}

/// One calendar day across every transcript. The daily $ total is not here: it lives in
/// the telemetry rollup and cannot be recovered from transcripts.
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

/// Per-day token usage from every transcript touched within `days`. The statusLine never
/// reports tokens (only context occupancy and $), so they come from each assistant record's
/// `usage`, all on one pass. Heavy: the frontend calls it off the render path and caches it.
#[tauri::command]
pub(crate) async fn token_usage_by_day(days: u64) -> Result<Vec<DayUsage>, String> {
    // A synchronous command would hold the main thread for the length of the scan.
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
    // Dedupe spans files: one response can survive a `/compact` rotation into a second
    // transcript and must still be billed once. The total is still an undercount: compaction
    // and title-generation requests bill but write no assistant record.
    let mut seen: HashSet<String> = HashSet::new();
    let mut projects_memo: HashMap<String, String> = HashMap::new();
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
                let LineUsage { day, tokens, family, cwd, id } = lu;
                // Claimed before the dedupe gate: the session was active that day even if
                // every line of it is a repeat.
                file_days.insert(day.clone());
                if let Some(id) = id {
                    if !seen.insert(id) {
                        continue; // another content block of a response already counted
                    }
                }
                let project = project_label(&cwd, &mut projects_memo);
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

/// A read-only slice of a session's transcript: the last `limit` prose messages from the
/// tail (≤512KB); tool calls, tool results and thinking are dropped.
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
                // Only "text" blocks: tool calls, tool_result echoes and thinking are noise in
                // a conversation mirror. A tool-only turn collapses to empty and is dropped.
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
            // Byte-indexed, so cut on a char boundary: `truncate` panics inside an umlaut or emoji.
            let cut = text.char_indices().map(|(i, _)| i).take_while(|i| *i <= 4000).last().unwrap_or(0);
            text.truncate(cut);
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

/// Re-home a session's transcript so `claude --resume <id>` finds it in `to_workdir`: the
/// one write Episko makes inside `~/.claude`, since `--resume` takes no path. Rename, never
/// copy (History would list the id twice); the tool-results sidecar travels too; never clobber.
/// The caller must have stopped the session and waited for `pty-exit`, not just sent the kill.
#[tauri::command(async)]
pub(crate) fn move_session_transcript(
    session_id: String,
    from_workdir: String,
    to_workdir: String,
) -> Result<String, String> {
    let base = claude_dir().ok_or_else(|| "no home directory".to_string())?;
    move_session_transcript_in(&base, &session_id, &from_workdir, &to_workdir)
}

fn move_session_transcript_in(
    base: &Path,
    session_id: &str,
    from_workdir: &str,
    to_workdir: &str,
) -> Result<String, String> {
    // The id is pasted into a filename: uuid characters only, so no `..` or separator can
    // escape the projects tree. Rejected, not sanitised: a sanitised id names the wrong file.
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(format!("not a valid session id: {session_id}"));
    }
    let from_dir = project_transcript_dir(base, from_workdir);
    let to_dir = project_transcript_dir(base, to_workdir);
    if from_dir == to_dir {
        return Err("that session is already in this folder".to_string());
    }
    let src = from_dir.join(format!("{session_id}.jsonl"));
    if !src.is_file() {
        return Err(format!(
            "no transcript for this session in {}",
            from_dir.display()
        ));
    }
    let dst = to_dir.join(format!("{session_id}.jsonl"));
    if dst.exists() {
        return Err("a transcript with this id is already in the target folder".to_string());
    }
    std::fs::create_dir_all(&to_dir).map_err(|e| format!("could not create {}: {e}", to_dir.display()))?;
    std::fs::rename(&src, &dst).map_err(|e| format!("could not move the transcript: {e}"))?;

    // The tool-results sidecar. A failure here is logged, not fatal: the transcript is
    // already across.
    let side_src = from_dir.join(session_id);
    if side_src.is_dir() {
        let side_dst = to_dir.join(session_id);
        if !side_dst.exists() {
            if let Err(e) = std::fs::rename(&side_src, &side_dst) {
                log::warn!("moved transcript but not its tool-results sidecar: {e}");
            }
        }
    }
    Ok(dst.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{git, scratch_dir};

    /// A transcript, optionally with its sidecar, where Claude would write it for `workdir`.
    fn seed_transcript(base: &Path, workdir: &Path, id: &str, body: &str, sidecar: bool) -> PathBuf {
        let dir = project_transcript_dir(base, &workdir.to_string_lossy());
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(format!("{id}.jsonl"));
        std::fs::write(&f, body).unwrap();
        if sidecar {
            let s = dir.join(id).join("tool-results");
            std::fs::create_dir_all(&s).unwrap();
            std::fs::write(s.join("artifact.html"), "<p>kept</p>").unwrap();
        }
        f
    }

    #[test]
    fn move_session_transcript_rehomes_the_conversation_and_its_sidecar() {
        let root = scratch_dir();
        let base = root.join("claude");
        let (from, to) = (root.join("exp-overview"), root.join("overview"));
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        let id = "acdc250f-a7af-4655-bb87-8ee83731b586";
        let body = "{\"type\":\"user\",\"cwd\":\"/somewhere\"}\n";
        let src = seed_transcript(&base, &from, id, body, true);

        let dst = move_session_transcript_in(
            &base, id, &from.to_string_lossy(), &to.to_string_lossy(),
        )
        .expect("the move should succeed");

        // Where `--resume` will look, once the session is relaunched in `to`.
        let want = project_transcript_dir(&base, &to.to_string_lossy()).join(format!("{id}.jsonl"));
        assert_eq!(PathBuf::from(&dst), want);
        assert_eq!(std::fs::read_to_string(&want).unwrap(), body, "content travels intact");

        // A rename, not a copy: one id must not name two conversations.
        assert!(!src.exists(), "the source transcript must not be left behind");

        // The sidecar carries the tool results older turns refer to.
        let side = project_transcript_dir(&base, &to.to_string_lossy())
            .join(id).join("tool-results").join("artifact.html");
        assert_eq!(std::fs::read_to_string(&side).unwrap(), "<p>kept</p>");
        assert!(
            !project_transcript_dir(&base, &from.to_string_lossy()).join(id).exists(),
            "the sidecar must move rather than be duplicated",
        );
    }

    #[test]
    fn move_session_transcript_refuses_what_it_cannot_do_safely() {
        let root = scratch_dir();
        let base = root.join("claude");
        let (from, to) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        let id = "acdc250f-a7af-4655-bb87-8ee83731b586";
        seed_transcript(&base, &from, id, "{}\n", false);

        // Same folder: nothing to do, and the rename would be onto itself.
        assert!(move_session_transcript_in(
            &base, id, &from.to_string_lossy(), &from.to_string_lossy(),
        ).is_err());

        // No such transcript — a session launched but never prompted writes none.
        assert!(move_session_transcript_in(
            &base, "11111111-2222-3333-4444-555555555555",
            &from.to_string_lossy(), &to.to_string_lossy(),
        ).is_err());

        // A non-uuid id gets nowhere near a filename: `..` would walk out of the projects tree.
        for bad in ["../../etc/passwd", "a/b", "", "id with space"] {
            assert!(
                move_session_transcript_in(
                    &base, bad, &from.to_string_lossy(), &to.to_string_lossy(),
                ).is_err(),
                "must reject session id {bad:?}",
            );
        }

        // A different conversation already at the destination is never overwritten.
        seed_transcript(&base, &to, id, "{\"other\":true}\n", false);
        assert!(move_session_transcript_in(
            &base, id, &from.to_string_lossy(), &to.to_string_lossy(),
        ).is_err());
        assert_eq!(
            std::fs::read_to_string(
                project_transcript_dir(&base, &to.to_string_lossy()).join(format!("{id}.jsonl"))
            ).unwrap(),
            "{\"other\":true}\n",
            "the destination must be left exactly as it was",
        );
    }

    /// The two-step tail read must never change an answer, only its cost. A 64KB window
    /// holding `last-prompt` but not `ai-title` looks conclusive and is not.
    #[test]
    fn transcript_meta_widens_when_the_title_is_out_of_the_fast_window() {
        let dir = scratch_dir();
        // Timestamped like a real assistant record: a window without one is not conclusive.
        let filler = format!(
            "{}\n",
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-01-02T03:04:05.000Z",
                "message": { "content": "x".repeat(4000) },
            })
        );

        // ai-title far back, last-prompt near EOF: only the full read sees both.
        let split = dir.join("split.jsonl");
        let mut body = String::from("{\"type\":\"ai-title\",\"aiTitle\":\"The summary Claude wrote\"}\n");
        while body.len() < 120 * 1024 {
            body.push_str(&filler);
        }
        body.push_str("{\"type\":\"last-prompt\",\"lastPrompt\":\"do the thing\"}\n");
        std::fs::write(&split, &body).unwrap();
        assert!(body.len() > 64 * 1024, "fixture must exceed the fast window");
        let got = transcript_meta(&split).unwrap();
        assert_eq!(
            (got.title.as_str(), got.last_prompt.as_str()),
            ("The summary Claude wrote", "do the thing"),
            "the title must win over the prompt even when only the prompt is in fast range",
        );
        // Identical to a single full-cap read.
        let full = transcript_meta_within(&split, 512 * 1024).unwrap().0;
        assert_eq!((full.title, full.last_prompt), (got.title, got.last_prompt));

        // Both records near EOF: the fast pass is final, and still agrees with the full read.
        let near = dir.join("near.jsonl");
        let mut body = String::new();
        while body.len() < 200 * 1024 {
            body.push_str(&filler);
        }
        body.push_str("{\"type\":\"ai-title\",\"aiTitle\":\"Close enough\"}\n");
        body.push_str("{\"type\":\"last-prompt\",\"lastPrompt\":\"the latest\"}\n");
        std::fs::write(&near, &body).unwrap();
        let (fast, final_) = transcript_meta_within(&near, 64 * 1024).unwrap();
        assert!(final_, "both records and a timestamp are in range, so the fast read is final");
        let whole = transcript_meta(&near).unwrap();
        assert_eq!((fast.title, fast.last_prompt), (whole.title, whole.last_prompt));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The folder name is a lossy encoding, so the cwd (and branch) can only come from inside
    /// the file; a Windows path's backslashes and drive colon are what the name destroys.
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

    #[test]
    fn scan_history_ranks_by_last_active_and_drops_what_cannot_resume() {
        let dir = scratch_dir();
        let base = dir.join("claude");
        let root = base.join("projects");
        let live = dir.join("live-project");
        std::fs::create_dir_all(root.join("proj-a")).unwrap();
        std::fs::create_dir_all(root.join("proj-b")).unwrap();
        std::fs::create_dir_all(&live).unwrap();
        let live_s = live.to_string_lossy().replace('\\', "\\\\");

        // A linked worktree BESIDE the repo: the layout no path-prefix test can group.
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = dir.join("repo-wt");
        git(&repo, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
        let wt_s = wt.to_string_lossy().replace('\\', "\\\\");

        // mtimes are set explicitly: back-to-back writes land in the same second, and the
        // ordering assertion would pass by accident.
        let touch = |name: &str, body: &str, age_secs: u64| {
            let p = root.join(name);
            std::fs::write(&p, body).unwrap();
            let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
            f.set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 - age_secs)).unwrap();
        };
        // A raw string with `{{`/`}}` and the newline appended: a `format!` wrapping a
        // `format!` is what clippy's `format_in_format_args` rejects.
        touch(
            "proj-a/newest.jsonl",
            &(format!(r#"{{"type":"user","cwd":"{live_s}","gitBranch":"dev"}}"#)
                + "\n"
                + r#"{"type":"ai-title","aiTitle":"The newest one"}"#
                + "\n"),
            0,
        );
        touch(
            "proj-b/older.jsonl",
            &(format!(r#"{{"type":"user","cwd":"{live_s}","message":{{"content":"an older chat"}}}}"#) + "\n"),
            60,
        );
        touch(
            "proj-a/worktree.jsonl",
            &(format!(r#"{{"type":"user","cwd":"{wt_s}","gitBranch":"side"}}"#) + "\n"),
            90,
        );
        // Deleted worktree: readable, but not resumable — it must still be listed.
        let missing = dir.join("removed-worktree");
        let missing_s = missing.to_string_lossy().replace('\\', "\\\\");
        touch(
            "proj-a/gone.jsonl",
            &(format!(r#"{{"type":"user","cwd":"{missing_s}","gitBranch":"wip"}}"#) + "\n"),
            120,
        );
        // Dropped: no cwd to resume into, empty file, and a non-transcript.
        touch("proj-b/nocwd.jsonl", "{\"type\":\"ai-title\",\"aiTitle\":\"orphan\"}\n", 30);
        touch("proj-a/empty.jsonl", "", 10);
        touch("proj-a/notes.txt", "not a transcript\n", 5);

        let out = scan_history_in(&base, 0);
        let ids: Vec<&str> = out.iter().map(|h| h.session_id.as_str()).collect();
        assert_eq!(ids, vec!["newest", "older", "worktree", "gone"], "newest first, unresumable rows dropped");

        // A session that ran in the worktree resolves to the repo.
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

        // `limit` bounds the files READ, not the rows returned: 2 reads `newest` and the
        // cwd-less `nocwd`, and yields one.
        let capped = scan_history_in(&base, 2);
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].session_id, "newest");
        assert!(scan_history_in(&dir.join("nope"), 0).is_empty(), "a missing base is empty, not an error");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The skip keys on `summarize::scratch_cwd()`, which resolves `$TMPDIR` first. Encode the
    /// unresolved spelling and the first assertion still passes on Linux while missing every
    /// real transcript on a Mac, where `/var/folders` is a symlink.
    #[test]
    fn scan_history_hides_the_trail_summarisers_own_transcripts() {
        let dir = scratch_dir();
        let base = dir.join("claude");
        let root = base.join("projects");

        let scratch = crate::summarize::scratch_cwd();
        let scratch_s = scratch.to_string_lossy().replace('\\', "\\\\");
        let enc: String = scratch
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        std::fs::create_dir_all(root.join(&enc)).unwrap();
        std::fs::create_dir_all(root.join("real")).unwrap();

        let live = dir.join("live-project");
        std::fs::create_dir_all(&live).unwrap();
        let live_s = live.to_string_lossy().replace('\\', "\\\\");

        // The summariser's row is the NEWER one: skipped in pass 1, it must not take the
        // single `limit` slot below.
        std::fs::write(
            root.join(&enc).join("summary.jsonl"),
            format!(r#"{{"type":"user","cwd":"{scratch_s}","message":{{"content":"Below is a factual record of one day of a developer's work"}}}}"#) + "\n",
        )
        .unwrap();
        std::fs::write(
            root.join("real").join("mine.jsonl"),
            format!(r#"{{"type":"user","cwd":"{live_s}","message":{{"content":"a real conversation"}}}}"#) + "\n",
        )
        .unwrap();

        let out = scan_history_in(&base, 0);
        let ids: Vec<&str> = out.iter().map(|h| h.session_id.as_str()).collect();
        assert_eq!(ids, vec!["mine"], "the summariser's transcripts are not sessions the user had");

        // Otherwise the assertion above passes for the wrong reason: nothing matched, so
        // nothing was skipped.
        assert_eq!(
            project_transcript_dir(&base, &scratch.to_string_lossy()),
            root.join(&enc),
            "the skip must name the folder Claude actually writes into",
        );

        let capped = scan_history_in(&base, 1);
        assert_eq!(capped.len(), 1, "the skipped rows never took the limit slot");
        assert_eq!(capped[0].session_id, "mine");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Claude writes the cwd as typed, so `e:\proj` and `E:\proj` both occur across transcripts.
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
        assert_eq!(lu.cwd, "/Users/tim/dev/episko"); // verbatim; grouped by project_label
        // Missing token fields default to 0, an unknown model is "other", no cwd is ""
        // (`project_label` says "unknown"), and no message.id is None, so the line is counted.
        let partial = r#"{"timestamp":"2026-07-21T10:00:00Z","message":{"usage":{"output_tokens":7}}}"#;
        let lu = parse_usage_line(partial).expect("should parse");
        assert_eq!(lu.tokens, [0, 7, 0, 0]);
        assert_eq!(lu.family, "other");
        assert_eq!(lu.cwd, "");
        assert_eq!(lu.id, None);
        assert_eq!(project_label("", &mut std::collections::HashMap::new()), "unknown");
    }

    /// Three lines sharing a `message.id` are one response (one line per content block);
    /// a fourth without an id cannot be matched and is counted on its own.
    #[test]
    fn scan_usage_counts_each_message_once_however_many_lines_carry_it() {
        let base = scratch_dir();
        let d = base.join("projects").join("-work-alpha");
        std::fs::create_dir_all(&d).unwrap();
        let block = |id: &str| {
            format!(
                concat!(
                    r#"{{"type":"assistant","timestamp":"2026-07-20T10:00:00.000Z","cwd":"/work/alpha","#,
                    r#""message":{{"id":"{}","model":"claude-opus-4-8","#,
                    r#""usage":{{"input_tokens":10,"output_tokens":1}}}}}}"#,
                    "\n"
                ),
                id
            )
        };
        // One response written as three blocks, a second response, and an
        // id-less record. Naive per-line summing would report 5 × 11 = 55.
        let idless = concat!(
            r#"{"type":"assistant","timestamp":"2026-07-20T10:00:00.000Z","cwd":"/work/alpha","#,
            r#""message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":1}}}"#,
            "\n"
        );
        std::fs::write(
            d.join("s1.jsonl"),
            format!("{}{}{}{}{}", block("msg_a"), block("msg_a"), block("msg_a"), block("msg_b"), idless),
        )
        .unwrap();

        let days = scan_usage_in(&base, 3650).unwrap();
        assert_eq!(days.len(), 1);
        let d20 = &days[0];
        assert_eq!((d20.input, d20.output), (30, 3), "3 counted responses, not 5 lines");
        assert_eq!(d20.opus, 33);
        assert_eq!(d20.projects.get("alpha"), Some(&33));
        assert_eq!(d20.sessions, 1);

        // The same response in a second transcript (a `/compact` rotation) is one response.
        std::fs::write(d.join("s2.jsonl"), block("msg_a")).unwrap();
        let days = scan_usage_in(&base, 3650).unwrap();
        assert_eq!((days[0].input, days[0].output), (30, 3), "cross-file duplicate not re-counted");
        assert_eq!(days[0].sessions, 2, "but the second file is still a session active that day");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parse_usage_line_skips_lines_without_usage() {
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
        let meta = transcript_meta(&path).unwrap();
        assert_eq!(meta.title, "What it settled on");
        assert_eq!(meta.last_prompt, "the latest prompt");
        let _ = std::fs::remove_dir_all(&dir);
    }

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
        assert_eq!(transcript_meta(&a).unwrap().title, "what I asked most recently");

        // Neither → the first user message stands in.
        let b = dir.join("b.jsonl");
        std::fs::write(&b, "{\"type\":\"user\",\"message\":{\"content\":\"opening message\"}}\n").unwrap();
        assert_eq!(transcript_meta(&b).unwrap().title, "opening message");

        // Garbage lines are skipped, not fatal — a torn write must not lose the title.
        let c = dir.join("c.jsonl");
        std::fs::write(
            &c,
            concat!("not json at all\n", r#"{"type":"ai-title","aiTitle":"Survived"}"#, "\n", "{\"truncated\":"),
        )
        .unwrap();
        assert_eq!(transcript_meta(&c).unwrap().title, "Survived");

        // An empty transcript yields an empty title (the frontend labels it).
        let d = dir.join("d.jsonl");
        std::fs::write(&d, "").unwrap();
        assert_eq!(transcript_meta(&d).unwrap().title, "");

        let _ = std::fs::remove_dir_all(&dir);
    }

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
        assert_eq!(transcript_meta(&path).unwrap().title, "Fresh tail title");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- against a fixture ~/.claude ----------

    /// Via std's `FileTimes` (stable since 1.75) rather than a new dependency.
    fn set_mtime(path: &Path, t: std::time::SystemTime) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }

    /// `<scratch>/projects/<enc(cwd)>/`, laid out where the encoder will look.
    fn fixture(cwd: &str) -> (PathBuf, PathBuf) {
        let base = scratch_dir();
        let proj = project_transcript_dir(&base, cwd);
        std::fs::create_dir_all(&proj).unwrap();
        (base, proj)
    }

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

    /// `getcwd()` reports the physical path however the process got there, so a symlinked
    /// workdir must encode to the folder Claude actually writes.
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
        // And specifically to the real one: the line above would still pass with both
        // sides wrong in the same way.
        let name = via_link.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.ends_with("-real"), "encoded the link's own name: {name}");
    }

    #[test]
    fn list_past_sessions_orders_by_last_active_and_ignores_non_transcripts() {
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

        // An explicit mtime: a filesystem with coarse mtime granularity would otherwise flake.
        let day = std::time::SystemTime::now() - std::time::Duration::from_secs(86_400);
        set_mtime(&proj.join("older.jsonl"), day);

        let out = list_past_sessions_in(&base, cwd).expect("a project with transcripts");
        assert_eq!(out.len(), 2, "only the two .jsonl files are sessions");
        assert_eq!(out[0].session_id, "newer", "newest first");
        assert_eq!(out[0].title, "no title, so this", "falls back to last-prompt");
        assert_eq!(out[1].session_id, "older");
        assert_eq!(out[1].title, "The older one");
        assert!(out[0].last_active > out[1].last_active);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn list_past_sessions_is_empty_for_an_unknown_project() {
        let base = scratch_dir();
        assert!(list_past_sessions_in(&base, "/never/seen").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Dates whose answers are fixed: the epoch, a leap day, a non-leap century, and the
    /// instants the shutdown regression test below is built on.
    #[test]
    fn iso_timestamps_parse_to_epoch_seconds() {
        assert_eq!(iso_epoch_secs("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_epoch_secs("2026-08-17T08:08:18.686Z"), Some(1_786_954_098));
        assert_eq!(iso_epoch_secs("2024-02-29T12:00:00Z"), Some(1_709_208_000));
        assert_eq!(iso_epoch_secs("2100-03-01T00:00:00Z"), Some(4_107_542_400));

        // Off-shape is None: the caller falls back to the mtime rather than invent a date.
        assert_eq!(iso_epoch_secs(""), None);
        assert_eq!(iso_epoch_secs("2026-08-17"), None);
        assert_eq!(iso_epoch_secs("2026/08/17T08:08:18Z"), None);
        assert_eq!(iso_epoch_secs("20xx-08-17T08:08:18Z"), None);
        assert_eq!(iso_epoch_secs("2026-13-17T08:08:18Z"), None);
        assert_eq!(iso_epoch_secs("2026-08-17T25:08:18Z"), None);
        assert_eq!(iso_epoch_secs("1969-12-31T23:59:59Z"), None, "pre-epoch has no u64");

        // The newest wins wherever the field sits; a nested tool-result timestamp counts too.
        assert_eq!(
            line_timestamp(r#"{"timestamp":"2026-08-17T08:08:18.686Z","type":"assistant"}"#),
            1_786_954_098
        );
        assert_eq!(
            line_timestamp(
                r#"{"timestamp":"2026-08-17T08:08:18Z","r":{"timestamp":"2026-08-17T09:00:00Z"}}"#
            ),
            1_786_957_200
        );
        assert_eq!(line_timestamp(r#"{"type":"mode","mode":"normal"}"#), 0);
        assert_eq!(line_timestamp(r#"{"timestamp":"not a date"}"#), 0);
    }

    /// A shutdown has Claude append untimestamped bookkeeping records to every open transcript,
    /// so their mtimes all become the shutdown; only the records inside know better.
    #[test]
    fn last_active_survives_a_shutdown_that_touches_every_transcript() {
        let cwd = "/Users/tim/dev/proj";
        let (base, proj) = fixture(cwd);

        // Two sessions, one worked on long after the other …
        let write = |name: &str, ts: &str| {
            let body = format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{ts}\",\"message\":{{\"content\":\"done\"}}}}\n\
                 {{\"type\":\"ai-title\",\"aiTitle\":\"{name}\"}}\n\
                 {{\"type\":\"mode\",\"mode\":\"normal\"}}\n\
                 {{\"type\":\"permission-mode\",\"permissionMode\":\"auto\"}}\n"
            );
            std::fs::write(proj.join(format!("{name}.jsonl")), body).unwrap();
        };
        // The three records after the assistant turn are what Claude appends on the way
        // out, and none of them carries a timestamp.
        write("morning", "2026-08-17T08:08:18.686Z");
        write("evening", "2026-08-17T15:50:15.525Z");

        // One shutdown stamps both files, in the order that would put the WRONG session first.
        let reboot = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_787_200_000);
        set_mtime(&proj.join("evening.jsonl"), reboot);
        set_mtime(&proj.join("morning.jsonl"), reboot + std::time::Duration::from_secs(2));

        let out = list_past_sessions_in(&base, cwd).expect("a project with transcripts");
        let by = |id: &str| out.iter().find(|s| s.session_id == id).unwrap().last_active;
        assert_eq!(by("morning"), 1_786_954_098, "08:08, not the reboot");
        assert_eq!(by("evening"), 1_786_981_815, "15:50, not the reboot");
        assert_eq!(out[0].session_id, "evening", "ordered by the work, not by the shutdown");

        // Nothing timestamped at all: the mtime is all that is left to say.
        std::fs::write(proj.join("blank.jsonl"), "{\"type\":\"mode\",\"mode\":\"normal\"}\n").unwrap();
        set_mtime(&proj.join("blank.jsonl"), reboot);
        let out = list_past_sessions_in(&base, cwd).unwrap();
        assert_eq!(
            out.iter().find(|s| s.session_id == "blank").unwrap().last_active,
            1_787_200_000,
            "no record to read, so the file is all that is left",
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_transcript_keeps_prose_and_drops_tool_traffic() {
        let cwd = "/Users/tim/dev/mirror";
        let (base, proj) = fixture(cwd);
        std::fs::write(
            proj.join("sid.jsonl"),
            concat!(
                r#"{"type":"user","message":{"content":"plain string content"}}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"first"},{"type":"text","text":"second"}]}}"#, "\n",
                // An unknown block type carrying a `text` field: the filter is a whitelist
                // on `type`, so an unrecognised block cannot leak in on a field name.
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

        // No transcript is an error, not an empty mirror: the UI must tell "nothing was
        // said" from "there is no such session".
        assert!(read_transcript_in(&base, cwd, "no-such-session", 10).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

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

    #[test]
    fn read_transcript_truncates_multibyte_text_without_panicking() {
        let cwd = "/Users/tim/dev/umlaut";
        let (base, proj) = fixture(cwd);
        // "ä" is two bytes, so byte 4000 lands mid-character: `truncate` would panic there.
        let line = serde_json::json!({
            "type": "user",
            "message": { "content": "ä".repeat(9000) },
        });
        std::fs::write(proj.join("sid.jsonl"), format!("{line}\n")).unwrap();

        let msgs = read_transcript_in(&base, cwd, "sid", 10).unwrap();
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].text.ends_with('…'));
        assert_eq!(msgs[0].text.chars().count(), 2001, "2000 two-byte chars plus the ellipsis");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parse_usage_line_skips_a_torn_timestamp_instead_of_panicking() {
        let line = serde_json::json!({
            "timestamp": "2026-09-0ä",   // byte 10 is inside the umlaut
            "message": { "usage": { "input_tokens": 5 } },
        })
        .to_string();
        assert!(parse_usage_line(&line).is_none());
    }

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

    #[test]
    fn scan_usage_is_empty_without_a_projects_dir() {
        let base = scratch_dir();
        assert!(scan_usage_in(&base, 30).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }
}
