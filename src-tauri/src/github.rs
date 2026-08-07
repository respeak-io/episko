// GitHub, through the `gh` CLI — issues and PRs as threads, and the claim Episko
// writes when you dispatch an agent at one.
//
// WHY `gh` AND NOT THE API. Auth. `gh` already holds the user's token, refreshes it,
// honours enterprise hosts and `GH_TOKEN`, and is the thing they already trust with
// this repo. Shipping our own OAuth flow to duplicate that would be a worse product
// and a much larger attack surface, so Episko borrows the credential rather than
// asking for one. The cost is a process per call, which is why reads are cached.
//
// DEGRADE, NEVER FAIL. `gh` may be missing, logged out, or pointed at a folder that
// is not a GitHub repo. None of those is an error the user needs to see as breakage:
// every read answers with `available: false` and a reason the UI can show as a single
// quiet row, exactly like a blocked runnable. Only an explicit *write* the user asked
// for reports failure loudly.
//
// The write half is deliberately small — assign, one edited-in-place comment, an
// optional label — because a claim is a hint, never a lock. See ./claim.ts for the
// rules that shape it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::platform::{augmented_path, sys_command};

/// How long a read stays fresh. Long enough that opening a board twice costs one
/// round trip, short enough that a colleague's push shows up on the timescale the
/// rest of the collaborator signals do.
const TTL: Duration = Duration::from_secs(60);

/// One issue or PR, flattened to what a thread row needs. Deliberately not the whole
/// GitHub object: the board shows a title, who has it, and how stale it is.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct GhThread {
    pub number: i64,
    pub kind: String, // "issue" | "pr"
    pub title: String,
    pub url: String,
    /// Login names. Empty means nobody has claimed it.
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    /// The PR's head branch — the link between a PR and a checkout we can see locally.
    pub branch: Option<String>,
    pub author: Option<String>,
    pub draft: bool,
    /// ISO-8601, straight from gh. Parsed by the frontend, which already formats time.
    pub updated_at: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub(crate) struct GhResult {
    /// False when gh is absent, unauthenticated, or this folder is not a GitHub repo.
    pub available: bool,
    /// Why not — shown as one quiet row rather than an error dialog.
    pub reason: Option<String>,
    pub threads: Vec<GhThread>,
    /// Who `gh` thinks you are, so the UI can tell your claims from a colleague's.
    pub viewer: Option<String>,
}

impl GhResult {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self { available: false, reason: Some(reason.into()), threads: vec![], viewer: None }
    }
}

struct Cached { at: Instant, result: GhResult }

// Keyed by repo root. A Mutex rather than a channel because every access is a short
// map lookup, and the same reasoning as `discover_cached` in tasks.rs: the cheap thing
// is to remember, not to coordinate.
static CACHE: Mutex<Option<HashMap<String, Cached>>> = Mutex::new(None);

/// Who `gh` thinks you are. **Cached for the life of the process, and deliberately
/// NOT per repo**: `gh api user` returns the same login whichever folder it is run in,
/// so keying it by root spent one extra process per project for an answer already in
/// hand. With a dashboard per project that was a real cost — it is the same call, N
/// times, for one string that cannot differ.
static VIEWER: Mutex<Option<Option<String>>> = Mutex::new(None);

fn viewer_login(root: &str) -> Option<String> {
    if let Ok(g) = VIEWER.lock() {
        if let Some(v) = g.as_ref() {
            return v.clone();
        }
    }
    let v = gh(root, &["api", "user", "--jq", ".login"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // A failure is cached too: an unauthenticated gh will keep failing, and retrying
    // it on every project click is a process per click for a known answer.
    if let Ok(mut g) = VIEWER.lock() {
        *g = Some(v.clone());
    }
    v
}

fn gh(root: &str, args: &[&str]) -> Result<String, String> {
    let out = sys_command("gh")
        .env("PATH", augmented_path())
        // gh infers the repo from the working directory; there is no -C equivalent.
        .current_dir(root)
        .args(args)
        // Never let gh try to open a browser or prompt: this runs with no terminal.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let first = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("gh failed");
        return Err(first.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Map gh's own failure text to something a person can act on.
///
/// This is the one place we look at gh's stderr prose, and only to *classify* — the
/// data paths all parse `--json`. Worth the exception because "gh: command not found"
/// and "you are not logged in" need very different responses from the user, and gh
/// gives no distinguishing exit code.
fn classify(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("not found") && e.contains("gh") { return "GitHub CLI (gh) is not installed".into(); }
    if e.contains("auth") || e.contains("logged in") || e.contains("token") {
        return "gh is not authenticated — run `gh auth login`".into();
    }
    if e.contains("not a git repository") || e.contains("no git remotes") || e.contains("could not determine") {
        return "not a GitHub repository".into();
    }
    err.to_string()
}

// ---------- parsing ----------
// Split out from the fetch so it can be tested against fixtures without a network,
// a token, or a repo — the parsing is where the bugs live, not the process spawn.

pub(crate) fn parse_issues(json: &str) -> Vec<GhThread> {
    parse_list(json, "issue")
}
pub(crate) fn parse_prs(json: &str) -> Vec<GhThread> {
    parse_list(json, "pr")
}

fn parse_list(json: &str, kind: &str) -> Vec<GhThread> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(arr) = v.as_array() else { return vec![] };
    arr.iter()
        .filter_map(|o| {
            let number = o.get("number")?.as_i64()?;
            Some(GhThread {
                number,
                kind: kind.to_string(),
                title: o.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                url: o.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                assignees: o
                    .get("assignees")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|u| u.get("login").and_then(|l| l.as_str()).map(String::from)).collect())
                    .unwrap_or_default(),
                labels: o
                    .get("labels")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
                    .unwrap_or_default(),
                branch: o.get("headRefName").and_then(|x| x.as_str()).map(String::from),
                author: o.get("author").and_then(|a| a.get("login")).and_then(|l| l.as_str()).map(String::from),
                draft: o.get("isDraft").and_then(|x| x.as_bool()).unwrap_or(false),
                updated_at: o.get("updatedAt").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            })
        })
        .collect()
}

// ---------- reads ----------

/// Open issues and PRs for the repo at `root`, cached for TTL.
///
/// Two `gh` calls, never one per item. `force` bypasses the cache for an explicit
/// refresh; everything else — opening the board, switching altitude, a repaint — is
/// served from memory, which is what stops a render loop becoming a network loop.
#[tauri::command]
pub(crate) async fn gh_threads(root: String, force: bool) -> GhResult {
    tauri::async_runtime::spawn_blocking(move || {
        if !force {
            if let Ok(guard) = CACHE.lock() {
                if let Some(hit) = guard.as_ref().and_then(|m| m.get(&root)) {
                    if hit.at.elapsed() < TTL {
                        return hit.result.clone();
                    }
                }
            }
        }

        // **The three reads run at once.** Each is a process spawn plus a network round
        // trip, and in sequence they cost the sum: measured against a real repo at 662ms
        // (issues), 605ms (PRs) and 457ms (the viewer, once per process) — 1.7-2.3s of
        // wall clock, against 0.7-1.0s for the same three concurrently. Nothing here
        // depends on anything else here, so the only reason they were sequential was that
        // `viewer_login` sat inside the issue read's success arm.
        //
        // `std::thread::scope` rather than tasks: we are already inside `spawn_blocking`,
        // so there is no runtime to hand work to, and a scope lets all three borrow `root`
        // instead of cloning it. A panicking probe is folded into that probe's own failure
        // — one dead read must not take the other two down.
        //
        // The viewer is now probed even when the issue read fails, which the old nesting
        // never did. That is consistent rather than new: the failure it would cache is the
        // *same* failure — gh missing or logged out — that `viewer_login` already caches
        // deliberately, and the one case where the two differ (a folder that is not a
        // GitHub repo) is exactly the case where `gh api user` still answers correctly,
        // since it is not repo-scoped.
        let (issues, prs, viewer) = std::thread::scope(|s| {
            let i = s.spawn(|| gh(&root, &[
                "issue", "list", "--state", "open", "--limit", "60",
                "--json", "number,title,url,assignees,labels,updatedAt",
            ]));
            let p = s.spawn(|| gh(&root, &[
                "pr", "list", "--state", "open", "--limit", "60",
                "--json", "number,title,url,assignees,labels,updatedAt,headRefName,author,isDraft",
            ]));
            let v = s.spawn(|| viewer_login(&root));
            (
                i.join().unwrap_or_else(|_| Err("gh issue list panicked".into())),
                p.join().unwrap_or_else(|_| Err("gh pr list panicked".into())),
                v.join().unwrap_or(None),
            )
        });
        let result = match issues {
            Err(e) => GhResult::unavailable(classify(&e)),
            Ok(issue_json) => {
                let mut threads = parse_issues(&issue_json);
                // A PR failure is not fatal: issues alone are still a useful board.
                if let Ok(pr_json) = prs {
                    threads.extend(parse_prs(&pr_json));
                }
                GhResult { available: true, reason: None, threads, viewer }
            }
        };

        if let Ok(mut guard) = CACHE.lock() {
            guard.get_or_insert_with(HashMap::new)
                .insert(root.clone(), Cached { at: Instant::now(), result: result.clone() });
        }
        result
    })
    .await
    .unwrap_or_else(|e| GhResult::unavailable(format!("gh task failed: {e}")))
}

/// Drop a repo's cached reads so the next call goes to the network.
#[tauri::command]
pub(crate) fn gh_invalidate(root: String) {
    if let Ok(mut guard) = CACHE.lock() {
        if let Some(m) = guard.as_mut() {
            m.remove(&root);
        }
    }
}

// ---------- writes ----------

/// The marker that makes the sticky comment ours to edit.
///
/// `gh issue comment --edit-last` edits the last comment *by you*, which is not
/// necessarily this one — you may have replied since. The marker lets us check we are
/// about to overwrite our own note rather than a real reply, and it also tells a
/// reader on GitHub that a machine wrote it.
const MARKER: &str = "<!-- episko:claim -->";

#[derive(serde::Serialize)]
pub(crate) struct ClaimOutcome {
    pub assigned: bool,
    pub commented: bool,
    pub labeled: bool,
    /// Everything that did not work, in the user's words rather than gh's.
    pub problems: Vec<String>,
}

/// Claim a thread: assign yourself, and/or leave one comment that is edited in place.
///
/// Every part is independent and best-effort — a repo where you cannot assign (no
/// write access) should still get the comment, and a failure of either is reported
/// without undoing the other. Nothing here refuses: this records a claim, it does not
/// enforce one.
#[tauri::command]
pub(crate) async fn gh_claim(
    root: String,
    number: i64,
    kind: String,
    assign: bool,
    comment: bool,
    label: String,
    body: String,
) -> ClaimOutcome {
    tauri::async_runtime::spawn_blocking(move || {
        let noun = if kind == "pr" { "pr" } else { "issue" };
        let n = number.to_string();
        let mut out = ClaimOutcome { assigned: false, commented: false, labeled: false, problems: vec![] };

        if assign {
            match gh(&root, &[noun, "edit", &n, "--add-assignee", "@me"]) {
                Ok(_) => out.assigned = true,
                Err(e) => out.problems.push(format!("assign: {}", classify(&e))),
            }
        }
        if !label.is_empty() {
            match gh(&root, &[noun, "edit", &n, "--add-label", &label]) {
                Ok(_) => out.labeled = true,
                Err(e) => out.problems.push(format!("label: {}", classify(&e))),
            }
        }
        if comment {
            let text = format!("{MARKER}\n{body}");
            // --edit-last --create-if-none: ONE comment per thread, updated. Appending
            // a new comment per dispatch is the behaviour that makes bots unwelcome.
            let edited = gh(&root, &[noun, "comment", &n, "--edit-last", "--create-if-none", "--body", &text]);
            match edited {
                Ok(_) => out.commented = true,
                Err(e) => {
                    // Older gh has no --create-if-none; fall back to a plain comment so
                    // the claim still lands rather than being silently skipped.
                    match gh(&root, &[noun, "comment", &n, "--body", &text]) {
                        Ok(_) => out.commented = true,
                        Err(_) => out.problems.push(format!("comment: {}", classify(&e))),
                    }
                }
            }
        }

        gh_invalidate(root);
        out
    })
    .await
    .unwrap_or(ClaimOutcome { assigned: false, commented: false, labeled: false, problems: vec!["claim task failed".into()] })
}

/// Release a claim — the agent ended without pushing, so the thread is free again.
///
/// The failure mode this exists to prevent is a graveyard of dead claims: a claim that
/// is never released is worse than no claim, because it tells a colleague someone is
/// working on something nobody is.
///
/// **It undoes what the claim wrote, never a blanket reset.** `unassign` and `label`
/// come from the frontend's ledger record of what actually landed, because the two
/// failure directions are not symmetrical: leaving a stale claim up costs a colleague
/// one wasted glance, while stripping an assignment a human made by hand is this app
/// editing someone else's planning signal on the strength of a guess.
#[tauri::command]
pub(crate) async fn gh_release(
    root: String,
    number: i64,
    kind: String,
    unassign: bool,
    label: String,
    body: String,
) -> ClaimOutcome {
    tauri::async_runtime::spawn_blocking(move || {
        let noun = if kind == "pr" { "pr" } else { "issue" };
        let n = number.to_string();
        let mut out = ClaimOutcome { assigned: false, commented: false, labeled: false, problems: vec![] };

        if unassign {
            if let Err(e) = gh(&root, &[noun, "edit", &n, "--remove-assignee", "@me"]) {
                out.problems.push(format!("unassign: {}", classify(&e)));
            }
        }
        if !label.is_empty() {
            if let Err(e) = gh(&root, &[noun, "edit", &n, "--remove-label", &label]) {
                out.problems.push(format!("label: {}", classify(&e)));
            }
        }
        if !body.is_empty() {
            let text = format!("{MARKER}\n{body}");
            let _ = gh(&root, &[noun, "comment", &n, "--edit-last", "--create-if-none", "--body", &text]);
        }
        gh_invalidate(root);
        out
    })
    .await
    .unwrap_or(ClaimOutcome { assigned: false, commented: false, labeled: false, problems: vec!["release task failed".into()] })
}

// ---------- what happened, and when ----------

/// One thing that happened to an issue or PR on a given day. The Trail buckets these
/// by date, so what a day *closed* reads as clearly as what it started.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct GhEvent {
    pub number: i64,
    pub kind: String,  // "issue" | "pr"
    pub event: String, // "opened" | "closed" | "merged"
    pub title: String,
    pub url: String,
    /// ISO-8601 — the frontend already owns calendar-day bucketing (`dayKeyOf`), and
    /// doing it here would risk the two disagreeing about where midnight falls.
    pub at: String,
}

/// Derive events from a list that carries `createdAt`, `closedAt` and (for PRs)
/// `mergedAt`.
///
/// One item can produce two events — opened on Monday, merged on Thursday — and both
/// matter, so this fans out rather than reducing to a current state. `mergedAt` wins
/// over `closedAt`: GitHub sets both when a PR merges, and "merged" is the true story.
pub(crate) fn parse_events(json: &str, kind: &str) -> Vec<GhEvent> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(arr) = v.as_array() else { return vec![] };
    let mut out = Vec::new();
    for o in arr {
        let Some(number) = o.get("number").and_then(|x| x.as_i64()) else { continue };
        let title = o.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let url = o.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let at = |k: &str| o.get(k).and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(String::from);
        let mk = |event: &str, when: String| GhEvent {
            number, kind: kind.to_string(), event: event.to_string(),
            title: title.clone(), url: url.clone(), at: when,
        };
        if let Some(w) = at("createdAt") { out.push(mk("opened", w)); }
        if let Some(w) = at("mergedAt") {
            out.push(mk("merged", w));
        } else if let Some(w) = at("closedAt") {
            out.push(mk("closed", w));
        }
    }
    out
}

struct CachedEvents { at: Instant, events: Vec<GhEvent> }
static EVENT_CACHE: Mutex<Option<HashMap<String, CachedEvents>>> = Mutex::new(None);

/// Everything that opened, closed or merged in this repo recently.
///
/// `--state all` in two calls rather than one per state: gh has no "changed since"
/// filter for these, so the window is applied by the caller after bucketing. The limit
/// is what bounds the work — 120 covers a very busy month and costs two requests.
#[tauri::command]
pub(crate) async fn gh_day_activity(root: String, force: bool) -> Vec<GhEvent> {
    tauri::async_runtime::spawn_blocking(move || {
        if !force {
            if let Ok(guard) = EVENT_CACHE.lock() {
                if let Some(hit) = guard.as_ref().and_then(|m| m.get(&root)) {
                    if hit.at.elapsed() < TTL {
                        return hit.events.clone();
                    }
                }
            }
        }
        let mut out = Vec::new();
        if let Ok(j) = gh(&root, &[
            "issue", "list", "--state", "all", "--limit", "120",
            "--json", "number,title,url,createdAt,closedAt",
        ]) {
            out.extend(parse_events(&j, "issue"));
        }
        if let Ok(j) = gh(&root, &[
            "pr", "list", "--state", "all", "--limit", "120",
            "--json", "number,title,url,createdAt,closedAt,mergedAt",
        ]) {
            out.extend(parse_events(&j, "pr"));
        }
        if let Ok(mut guard) = EVENT_CACHE.lock() {
            guard.get_or_insert_with(HashMap::new)
                .insert(root.clone(), CachedEvents { at: Instant::now(), events: out.clone() });
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Close an issue, with a comment saying why.
///
/// **The only destructive write Episko makes to GitHub**, and the reason the UI never
/// does it on one click: it is public, it notifies every watcher, and "close" is not a
/// thing you can quietly undo for other people who already read the notification. The
/// comment is required rather than optional — a stale-close with no reason is the kind
/// of bot behaviour that makes a team turn the whole feature off.
///
/// The comment goes first: if the close then fails, the issue has a note explaining
/// what was attempted, which is recoverable. The other order can leave an issue closed
/// with no explanation at all.
#[tauri::command]
pub(crate) async fn gh_close_issue(root: String, number: i64, comment: String) -> Result<(), String> {
    let body = comment.trim().to_string();
    if body.is_empty() {
        return Err("a closing comment is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let n = number.to_string();
        gh(&root, &["issue", "comment", &n, "--body", &body]).map_err(|e| classify(&e))?;
        gh(&root, &["issue", "close", &n]).map_err(|e| classify(&e))?;
        gh_invalidate(root.clone());
        Ok(())
    })
    .await
    .map_err(|e| format!("gh task failed: {e}"))?
}

// ---------- the project's own policy ----------

/// What a project permits, from `.episko/episko.toml`:
///
/// ```toml
/// [claim]
/// assign = false     # this team uses assignment for planning
/// comment = true
/// ```
///
/// **Absent means everything is allowed.** A repo that has never heard of Episko must
/// not silently disable features, and a missing file is not a policy. Only keys that
/// are present and `false` take anything away — the file is a ceiling, never a default.
///
/// There was a `push_branch` ceiling here. Nothing ever implemented the thing it
/// bounded — `gh_claim` never took the argument and dispatch creates no branch — so a
/// project switching it off was refusing a capability that did not exist. An unknown
/// key in a hand-written `[claim]` table is ignored on read, so a file still carrying
/// `push_branch` keeps working; it simply no longer pretends to decide anything.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct ClaimAllow {
    pub assign: bool,
    pub comment: bool,
    pub label: bool,
}

impl Default for ClaimAllow {
    fn default() -> Self {
        Self { assign: true, comment: true, label: true }
    }
}

/// Every field is `Option`, and that is the whole design: absent must mean "allowed",
/// not "false". A serde `Default` on a bool would silently deny everything the file
/// forgot to mention, turning an incomplete policy into a total lockout.
#[derive(serde::Deserialize, Default)]
struct RawFile { claim: Option<RawClaim> }
#[derive(serde::Deserialize, Default)]
struct RawClaim {
    assign: Option<bool>,
    comment: Option<bool>,
    label: Option<bool>,
}

pub(crate) fn parse_allow(toml_text: &str) -> ClaimAllow {
    let mut a = ClaimAllow::default();
    // A malformed file must not lock a team out of their own claims — the same
    // forgiving-on-read stance tasks.rs takes with a broken tasks.toml.
    let Ok(file) = toml::from_str::<RawFile>(toml_text) else { return a };
    let Some(c) = file.claim else { return a };
    if let Some(x) = c.assign { a.assign = x; }
    if let Some(x) = c.comment { a.comment = x; }
    if let Some(x) = c.label { a.label = x; }
    a
}

/// The project's claim policy. Reads `<root>/.episko/episko.toml`; a missing or
/// unreadable file is "everything allowed", not an error.
#[tauri::command]
pub(crate) fn claim_policy(root: String) -> ClaimAllow {
    std::path::Path::new(&root)
        .join(".episko")
        .join("episko.toml")
        .pipe_read()
        .map(|t| parse_allow(&t))
        .unwrap_or_default()
}

// ---------- the keep list ----------
// "We decided #24 stays open" is a project fact, not a personal preference, so it is
// committed: decide once and nobody on the team is asked about that issue again. The
// cost of that choice is that it has to be *auditable* — a committed decision nobody
// can see is worse than no decision — which is why the UI shows the list with who
// added each entry and an undo, and why this stores a `who` alongside the number.
//
// `toml_edit`, not a serialize-the-whole-struct round trip: the file may carry a
// hand-written `[claim]` block with comments, and rewriting it wholesale would eat
// them. Same rule tasks.rs follows for tasks.toml.

fn episko_toml(root: &str) -> std::path::PathBuf {
    std::path::Path::new(root).join(".episko").join("episko.toml")
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct KeptIssue {
    pub number: i64,
    /// Who decided, so the list reads as a record rather than an anonymous blocklist.
    pub who: String,
    /// ISO-8601 date, day resolution — the hour adds nothing and churns the diff.
    pub at: String,
}

/// Issues this project has decided to keep, so triage stops suggesting them.
#[tauri::command]
pub(crate) fn list_kept(root: String) -> Vec<KeptIssue> {
    let Ok(text) = std::fs::read_to_string(episko_toml(&root)) else { return vec![] };
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else { return vec![] };
    let Some(arr) = doc.get("triage").and_then(|t| t.get("keep")).and_then(|k| k.as_array()) else {
        return vec![];
    };
    arr.iter()
        .filter_map(|v| {
            let t = v.as_inline_table()?;
            Some(KeptIssue {
                number: t.get("number")?.as_integer()?,
                who: t.get("who").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                at: t.get("at").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Add or remove one. `create` gates the very first write for the same reason the
/// digest's does: a new committable file in someone's repo is a real side effect.
#[tauri::command]
pub(crate) fn set_kept(
    root: String, number: i64, who: String, at: String, keep: bool, create: bool,
) -> Result<(), String> {
    let path = episko_toml(&root);
    if !path.is_file() && !create {
        return Err("no .episko/episko.toml yet".into());
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = text.parse::<toml_edit::DocumentMut>().map_err(|e| e.to_string())?;
    if doc.get("triage").is_none() {
        doc["triage"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let tri = doc["triage"].as_table_mut().ok_or("triage is not a table")?;
    if tri.get("keep").is_none() {
        tri["keep"] = toml_edit::value(toml_edit::Array::new());
    }
    let arr = tri["keep"].as_array_mut().ok_or("triage.keep is not an array")?;
    // Remove any existing entry for this number first, so a re-keep updates rather
    // than duplicating and an un-keep is simply the removal.
    arr.retain(|v| v.as_inline_table().and_then(|t| t.get("number")).and_then(|n| n.as_integer()) != Some(number));
    if keep {
        let mut t = toml_edit::InlineTable::new();
        t.insert("number", number.into());
        t.insert("who", who.into());
        t.insert("at", at.into());
        arr.push(toml_edit::Value::InlineTable(t));
    }
    // One entry per line: a single-line array of ten inline tables is unreadable in a
    // diff, and a diff is the whole point of committing this.
    for item in arr.iter_mut() {
        item.decor_mut().set_prefix("\n  ");
    }
    arr.set_trailing("\n");
    if arr.is_empty() {
        // An empty `keep = []` is noise; drop the table when the last one goes.
        tri.remove("keep");
        if tri.is_empty() {
            doc.remove("triage");
        }
    }
    let dir = path.parent().ok_or("bad root")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, doc.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Tiny helper so the command above reads as one expression.
trait PipeRead { fn pipe_read(&self) -> Option<String>; }
impl PipeRead for std::path::PathBuf {
    fn pipe_read(&self) -> Option<String> { std::fs::read_to_string(self).ok() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::scratch_dir;

    #[test]
    fn keep_list_round_trips_and_records_who_decided() {
        // The list is committed, so it has to be auditable: an anonymous blocklist
        // raises "who decided this?" on every read.
        let d = scratch_dir();
        let r = d.to_string_lossy().to_string();
        assert!(set_kept(r.clone(), 24, "Tim".into(), "2026-07-31".into(), true, false).is_err());
        set_kept(r.clone(), 24, "Tim".into(), "2026-07-31".into(), true, true).unwrap();
        let l = list_kept(r.clone());
        assert_eq!(l.len(), 1);
        assert_eq!(l[0], KeptIssue { number: 24, who: "Tim".into(), at: "2026-07-31".into() });

        // Un-keeping removes it, and the last removal takes the table with it.
        set_kept(r.clone(), 24, String::new(), String::new(), false, false).unwrap();
        assert!(list_kept(r.clone()).is_empty());
        let text = std::fs::read_to_string(d.join(".episko").join("episko.toml")).unwrap();
        assert!(!text.contains("keep"), "an empty keep list is noise: {text}");
    }

    #[test]
    fn keeping_the_same_issue_twice_updates_rather_than_duplicating() {
        let d = scratch_dir();
        let r = d.to_string_lossy().to_string();
        set_kept(r.clone(), 24, "Tim".into(), "2026-07-01".into(), true, true).unwrap();
        set_kept(r.clone(), 24, "Frederic".into(), "2026-07-31".into(), true, false).unwrap();
        let l = list_kept(r);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].who, "Frederic");
    }

    #[test]
    fn a_hand_written_claim_policy_survives_a_keep() {
        // episko.toml is shared with [claim], which a team may have hand-written with
        // comments. toml_edit is what keeps that true.
        let d = scratch_dir();
        let r = d.to_string_lossy().to_string();
        std::fs::create_dir_all(d.join(".episko")).unwrap();
        std::fs::write(d.join(".episko").join("episko.toml"),
            "# we use assignment for planning\n[claim]\nassign = false\n").unwrap();
        set_kept(r.clone(), 12, "Tim".into(), "2026-07-31".into(), true, false).unwrap();
        let text = std::fs::read_to_string(d.join(".episko").join("episko.toml")).unwrap();
        assert!(text.contains("# we use assignment for planning"), "comment eaten: {text}");
        assert!(!parse_allow(&text).assign, "the policy must still parse: {text}");
        assert_eq!(list_kept(r).len(), 1);
    }

    #[test]
    fn a_malformed_file_reads_as_an_empty_keep_list() {
        let d = scratch_dir();
        std::fs::create_dir_all(d.join(".episko")).unwrap();
        std::fs::write(d.join(".episko").join("episko.toml"), "not [ valid").unwrap();
        assert!(list_kept(d.to_string_lossy().to_string()).is_empty());
    }


    // Captured from `gh issue list --json …` against respeak-io/episko, trimmed.
    const ISSUES: &str = r#"[
      {"assignees":[],"labels":[{"name":"performance"},{"name":"prio: high"}],
       "number":33,"title":"renderAll() runs per telemetry event","updatedAt":"2026-07-30T07:48:37Z",
       "url":"https://github.com/respeak-io/episko/issues/33"},
      {"assignees":[{"login":"FAbrahamDev"}],"labels":[],
       "number":24,"title":"RFC: project board","updatedAt":"2026-07-27T12:26:45Z",
       "url":"https://github.com/respeak-io/episko/issues/24"}
    ]"#;

    const PRS: &str = r#"[
      {"assignees":[],"labels":[],"number":42,"title":"sidebar: a + on each worktree cluster header",
       "updatedAt":"2026-07-30T13:39:37Z","url":"https://github.com/respeak-io/episko/pull/42",
       "headRefName":"feat/worktree-quick-launch","author":{"login":"FAbrahamDev"},"isDraft":false}
    ]"#;

    #[test]
    fn parses_issues_including_who_already_has_them() {
        let t = parse_issues(ISSUES);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].number, 33);
        assert_eq!(t[0].kind, "issue");
        assert_eq!(t[0].labels, vec!["performance", "prio: high"]);
        assert!(t[0].assignees.is_empty());
        // The whole point of reading assignees: knowing a colleague already has it.
        assert_eq!(t[1].assignees, vec!["FAbrahamDev"]);
    }

    #[test]
    fn parses_prs_with_the_branch_that_links_them_to_a_local_checkout() {
        let t = parse_prs(PRS);
        assert_eq!(t[0].kind, "pr");
        assert_eq!(t[0].branch.as_deref(), Some("feat/worktree-quick-launch"));
        assert_eq!(t[0].author.as_deref(), Some("FAbrahamDev"));
        assert!(!t[0].draft);
    }

    #[test]
    fn malformed_output_yields_nothing_rather_than_panicking() {
        // gh can print a warning, an empty body, or HTML from a proxy. None of those
        // may take the board down — they degrade to "no threads".
        for bad in ["", "not json", "{}", "null", "[{\"no\":\"number\"}]", "<html>"] {
            assert!(parse_issues(bad).is_empty(), "should be empty for {bad:?}");
        }
    }

    #[test]
    fn tolerates_missing_optional_fields() {
        // Fields differ between issue and pr payloads, and between gh versions; a row
        // must survive on `number` alone.
        let t = parse_issues(r#"[{"number":7}]"#);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].title, "");
        assert!(t[0].branch.is_none());
        assert!(!t[0].draft);
    }

    #[test]
    fn one_item_can_produce_two_events_on_different_days() {
        // Opened Monday, merged Thursday — both matter to the day they happened on, so
        // this fans out rather than reducing to a current state.
        let e = parse_events(r#"[{"number":46,"title":"a pr","url":"u",
            "createdAt":"2026-07-31T12:09:32Z","closedAt":"2026-07-31T13:37:35Z","mergedAt":"2026-07-31T13:37:35Z"}]"#, "pr");
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].event, "opened");
        // mergedAt wins: GitHub sets closedAt too when a PR merges, and "merged" is the
        // true story — reporting it as merely closed would misread the day.
        assert_eq!(e[1].event, "merged");
    }

    #[test]
    fn a_closed_but_unmerged_pr_is_closed_not_merged() {
        let e = parse_events(r#"[{"number":9,"title":"x","url":"u",
            "createdAt":"2026-07-01T00:00:00Z","closedAt":"2026-07-02T00:00:00Z","mergedAt":null}]"#, "pr");
        assert_eq!(e.iter().map(|x| x.event.as_str()).collect::<Vec<_>>(), vec!["opened", "closed"]);
    }

    #[test]
    fn an_open_issue_reports_only_its_opening() {
        let e = parse_events(r#"[{"number":47,"title":"x","url":"u",
            "createdAt":"2026-07-31T13:30:17Z","closedAt":null}]"#, "issue");
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].event, "opened");
        assert_eq!(e[0].kind, "issue");
    }

    #[test]
    fn malformed_event_output_is_empty_rather_than_a_panic() {
        for bad in ["", "null", "{}", "[{\"no\":\"number\"}]"] {
            assert!(parse_events(bad, "issue").is_empty(), "{bad:?}");
        }
    }

    #[test]
    fn a_project_with_no_policy_permits_everything() {
        // The load-bearing default: a repo that never heard of Episko must not
        // silently disable features.
        assert_eq!(parse_allow(""), ClaimAllow::default());
        assert_eq!(parse_allow("[other]\nkey = 1"), ClaimAllow::default());
        assert_eq!(parse_allow("not { valid toml"), ClaimAllow::default());
    }

    #[test]
    fn a_project_can_withhold_one_thing_without_withholding_the_rest() {
        // Tim's case exactly: "we don't use assignments for planning, but people might".
        let a = parse_allow("[claim]\nassign = false\n");
        assert!(!a.assign);
        assert!(a.comment && a.label);
    }

    #[test]
    fn present_and_true_is_still_allowed() {
        let a = parse_allow("[claim]\nassign = true\ncomment = false\n");
        assert!(a.assign);
        assert!(!a.comment);
    }

    #[test]
    fn classifies_the_failures_that_need_different_answers() {
        assert!(classify("gh: command not found").contains("not installed"));
        assert!(classify("error: not logged in to any GitHub hosts").contains("gh auth login"));
        assert!(classify("fatal: not a git repository").contains("not a GitHub repository"));
        // Anything unrecognised is passed through rather than mangled into a guess.
        assert_eq!(classify("API rate limit exceeded"), "API rate limit exceeded");
    }
}
