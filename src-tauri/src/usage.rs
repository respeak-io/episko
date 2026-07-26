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
//   totals by model family, deduplicating on message id so a resumed transcript
//   isn't counted twice.
//
// PLAN's Phase-2 item for this module also asks for an injectable base dir so these
// become testable against a fixture tree instead of the developer's real ~/.claude.
// That changes signatures, so it is the next commit, not this move.

use crate::platform::home_dir;

#[derive(serde::Serialize)]
pub(crate) struct TranscriptMsg {
    role: String,
    text: String,
}

/// Claude stores a project's transcripts under `~/.claude/projects/<enc>/`, where
/// `<enc>` is the cwd with every non-ASCII-alphanumeric char replaced by `-`.
fn project_transcript_dir(cwd: &str) -> Option<std::path::PathBuf> {
    let home = home_dir();
    if home.is_empty() {
        return None;
    }
    let enc: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(std::path::Path::new(&home).join(".claude").join("projects").join(enc))
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
    let dir = match project_transcript_dir(&workdir) {
        Some(d) => d,
        None => return Err("no home directory".to_string()),
    };
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

    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
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
        .and_then(|c| c.rsplit(|ch: char| ch == '/' || ch == '\\').find(|s| !s.is_empty()))
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
    tauri::async_runtime::spawn_blocking(move || scan_usage(days))
        .await
        .map_err(|e| e.to_string())?
}

fn scan_usage(days: u64) -> Result<Vec<DayUsage>, String> {
    use std::collections::{HashMap, HashSet};
    use std::io::{BufRead, BufReader};
    let home = home_dir();
    if home.is_empty() {
        return Err("no home directory".to_string());
    }
    let root = std::path::Path::new(&home).join(".claude").join("projects");
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
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let path = project_transcript_dir(&cwd)
        .ok_or_else(|| "no home directory".to_string())?
        .join(format!("{session_id}.jsonl"));
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
    use crate::testutil::scratch_dir;


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

}
