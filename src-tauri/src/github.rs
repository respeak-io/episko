// GitHub through the `gh` CLI: issues and PRs as threads, plus the claim Episko writes
// when you dispatch an agent at one (src/claim.ts). `gh` is used for its credential, never
// the API directly. Every read degrades to `available: false`; only an explicit write fails loudly.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::platform::{augmented_path, sys_command};

const TTL: Duration = Duration::from_secs(60);

/// One issue or PR, flattened to what a thread row needs.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct GhThread {
    pub number: i64,
    pub kind: String, // "issue" | "pr"
    pub title: String,
    pub url: String,
    pub assignees: Vec<String>, // logins; empty means unclaimed
    pub labels: Vec<String>,
    pub branch: Option<String>, // the PR's head branch, the join to a local checkout
    pub author: Option<String>,
    pub draft: bool,
    pub updated_at: String, // ISO-8601 as gh gives it; the frontend parses
}

#[derive(serde::Serialize, Clone, Debug)]
pub(crate) struct GhResult {
    pub available: bool, // false: gh absent, unauthenticated, or not a GitHub repo
    pub reason: Option<String>, // shown as one quiet row, never an error dialog
    pub threads: Vec<GhThread>,
    pub viewer: Option<String>, // who gh thinks you are; tells your claims from a colleague's
}

impl GhResult {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self { available: false, reason: Some(reason.into()), threads: vec![], viewer: None }
    }
}

struct Cached { at: Instant, result: GhResult }

static CACHE: Mutex<Option<HashMap<String, Cached>>> = Mutex::new(None); // keyed by repo root

/// The active account's login, cached per process rather than per repo: `gh api user`
/// answers the same in every folder. A project pinned to another account never reaches
/// this cache; the pin itself is the answer (`viewer_login`). Claims compare against it.
static VIEWER: Mutex<Option<Option<String>>> = Mutex::new(None);

fn viewer_login(root: &str, account: Option<&str>) -> Option<String> {
    if let Some(login) = account {
        return Some(login.to_string());
    }
    if let Ok(g) = VIEWER.lock() {
        if let Some(v) = g.as_ref() {
            return v.clone();
        }
    }
    let v = gh(root, None, &["api", "user", "--jq", ".login"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // A failure is cached too: an unauthenticated gh keeps failing, and a retry is a process.
    if let Ok(mut g) = VIEWER.lock() {
        *g = Some(v.clone());
    }
    v
}

/// One `gh` call, run as `account` when the project names one. `GH_TOKEN` is the only
/// per-call account selector gh has (`gh auth switch` is global), so the pinned account's
/// own token is handed to this one child and nothing else changes.
fn gh(root: &str, account: Option<&str>, args: &[&str]) -> Result<String, String> {
    let mut cmd = sys_command("gh");
    cmd.env("PATH", augmented_path())
        .current_dir(root) // gh has no -C; it infers the repo from cwd
        .args(args)
        .env("GH_PROMPT_DISABLED", "1") // no terminal here: never prompt or open a browser
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    if let Some(login) = account {
        cmd.env("GH_TOKEN", account_token(login)?);
    }
    let out = cmd.output().map_err(|e| format!("gh not available: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let first = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("gh failed");
        return Err(first.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// The token gh holds for one account, read from gh's own keyring. Never cached (gh
/// refreshes them, and the read is cheap beside the network call it precedes) and never
/// logged. A pin gh no longer knows is an error, never a fall-back to the active account.
fn account_token(login: &str) -> Result<String, String> {
    // The login reaches gh as an argument, so it must not read as a flag.
    if login.is_empty() || login.starts_with('-') {
        return Err(format!("{login:?} is not a GitHub account name"));
    }
    let out = sys_command("gh")
        .env("PATH", augmented_path())
        .args(["auth", "token", "--hostname", "github.com", "--user", login])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || token.is_empty() {
        return Err(format!("gh is not logged in as {login}, which this project is set to use"));
    }
    Ok(token)
}

/// Map gh's stderr prose to something a person can act on: the one place stderr is
/// read, and only to classify (data paths parse `--json`). `who` is the account the call
/// ran as. GitHub answers an invisible repo exactly like a nonexistent one, so naming
/// the account is what turns that message into a fix.
fn classify(err: &str, who: Option<&str>) -> String {
    let e = err.to_lowercase();
    if e.contains("could not resolve to a repository") {
        return match who {
            Some(w) => format!("signed in as {w}, which cannot see this repository"),
            None => "the signed-in GitHub account cannot see this repository".into(),
        };
    }
    // `gh()` writes "not available" on a spawn failure. The looser "not found" must not
    // match gh's own HTTP prose (`gh: Not Found (HTTP 404)` is about a resource).
    let missing = e.contains("not available") || (e.contains("not found") && !e.contains("http"));
    if missing && e.contains("gh") { return "GitHub CLI (gh) is not installed".into(); }
    if e.contains("auth") || e.contains("logged in") || e.contains("token") {
        return "gh is not authenticated — run `gh auth login`".into();
    }
    if e.contains("not a git repository") || e.contains("no git remotes") || e.contains("could not determine") {
        return "not a GitHub repository".into();
    }
    err.to_string()
}

/// The login to name in a failure: the pin, else the active account's last answer. Never
/// a fresh probe; this runs on a path that already failed, and a second call can hang.
fn who_for(account: Option<&str>) -> Option<String> {
    account
        .map(str::to_string)
        .or_else(|| VIEWER.lock().ok().and_then(|g| g.clone().flatten()))
}

// ---------- which of your accounts ----------

/// One github.com account `gh` is logged in to.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct GhAccount {
    pub login: String,
    pub active: bool, // gh's default when nothing is pinned; the picker marks it as such
}

static ACCOUNT_CACHE: Mutex<Option<(Instant, Vec<GhAccount>)>> = Mutex::new(None);

/// Every github.com account `gh` is logged in to (github.com only: `parse_remote` mints
/// slugs for nothing else). `gh auth status` tests each account against the API, so this
/// is cached, but for TTL rather than per process so a `gh auth login` shows up without a restart.
#[tauri::command]
pub(crate) async fn gh_accounts() -> Vec<GhAccount> {
    tauri::async_runtime::spawn_blocking(|| {
        if let Ok(g) = ACCOUNT_CACHE.lock() {
            if let Some((at, v)) = g.as_ref() {
                if at.elapsed() < TTL {
                    return v.clone();
                }
            }
        }
        let out = sys_command("gh")
            .env("PATH", augmented_path())
            .args(["auth", "status", "--json", "hosts"])
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .output()
            .ok();
        // No gh means no accounts: the picker is simply absent, never an error dialog.
        let list = out
            .filter(|o| o.status.success())
            .map(|o| parse_accounts(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default();
        if let Ok(mut g) = ACCOUNT_CACHE.lock() {
            *g = Some((Instant::now(), list.clone()));
        }
        list
    })
    .await
    .unwrap_or_default()
}

/// The github.com half of `gh auth status --json hosts`:
/// `{"hosts":{"<host>":[{"login":…,"active":…}]}}`.
fn parse_accounts(json: &str) -> Vec<GhAccount> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(arr) = v.get("hosts").and_then(|h| h.get("github.com")).and_then(|a| a.as_array()) else {
        return vec![];
    };
    arr.iter()
        .filter_map(|a| {
            let login = a.get("login")?.as_str()?.trim().to_string();
            if login.is_empty() {
                return None;
            }
            Some(GhAccount { login, active: a.get("active").and_then(serde_json::Value::as_bool).unwrap_or(false) })
        })
        .collect()
}

// ---------- parsing ----------
// Split from the fetch so it can be tested against fixtures without a network.

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

/// Open issues and PRs for the repo at `root`, cached for TTL. `force` bypasses the
/// cache for an explicit refresh only; a repaint must never become a network call.
#[tauri::command]
pub(crate) async fn gh_threads(root: String, force: bool, account: Option<String>) -> GhResult {
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

        // The three reads are independent and each is a process plus a round trip, so they
        // run concurrently. A thread scope because this is already inside `spawn_blocking`
        // with no runtime to hand work to; a panicking probe folds into its own failure only.
        let acct = account.as_deref();
        let (issues, prs, viewer) = std::thread::scope(|s| {
            let i = s.spawn(|| gh(&root, acct, &[
                "issue", "list", "--state", "open", "--limit", "60",
                "--json", "number,title,url,assignees,labels,updatedAt",
            ]));
            let p = s.spawn(|| gh(&root, acct, &[
                "pr", "list", "--state", "open", "--limit", "60",
                "--json", "number,title,url,assignees,labels,updatedAt,headRefName,author,isDraft",
            ]));
            let v = s.spawn(|| viewer_login(&root, acct));
            (
                i.join().unwrap_or_else(|_| Err("gh issue list panicked".into())),
                p.join().unwrap_or_else(|_| Err("gh pr list panicked".into())),
                v.join().unwrap_or(None),
            )
        });
        let result = match issues {
            Err(e) => GhResult::unavailable(classify(&e, who_for(acct).as_deref())),
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

/// Drop a repo's cached reads so the next call goes to the network. All three caches:
/// a refresh is one question, and switching the account a project reads as must not
/// leave a board of the new identity beside a triage list of the old one.
#[tauri::command]
pub(crate) fn gh_invalidate(root: String) {
    if let Ok(mut guard) = CACHE.lock() {
        if let Some(m) = guard.as_mut() {
            m.remove(&root);
        }
    }
    if let Ok(mut guard) = EVENT_CACHE.lock() {
        if let Some(m) = guard.as_mut() {
            m.remove(&root);
        }
    }
    if let Ok(mut guard) = MERGED_CACHE.lock() {
        if let Some(m) = guard.as_mut() {
            m.remove(&root);
        }
    }
}

// ---------- writes ----------

/// Marks the sticky comment as ours: `--edit-last` edits your last comment, which may be
/// a real reply you wrote since, and a reader on GitHub sees that a machine wrote it.
const MARKER: &str = "<!-- episko:claim -->";

#[derive(serde::Serialize)]
pub(crate) struct ClaimOutcome {
    pub assigned: bool,
    pub commented: bool,
    pub labeled: bool,
    pub problems: Vec<String>, // in the user's words rather than gh's
}

/// Claim a thread: assign yourself and/or leave one comment that is edited in place.
/// Every part is independent and best-effort; a claim is recorded, never enforced.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command parameters are the frontend wire format.
pub(crate) async fn gh_claim(
    root: String,
    number: i64,
    kind: String,
    assign: bool,
    comment: bool,
    label: String,
    body: String,
    account: Option<String>,
) -> ClaimOutcome {
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let who = who_for(acct);
        let noun = if kind == "pr" { "pr" } else { "issue" };
        let n = number.to_string();
        let mut out = ClaimOutcome { assigned: false, commented: false, labeled: false, problems: vec![] };

        if assign {
            match gh(&root, acct, &[noun, "edit", &n, "--add-assignee", "@me"]) {
                Ok(_) => out.assigned = true,
                Err(e) => out.problems.push(format!("assign: {}", classify(&e, who.as_deref()))),
            }
        }
        if !label.is_empty() {
            match gh(&root, acct, &[noun, "edit", &n, "--add-label", &label]) {
                Ok(_) => out.labeled = true,
                Err(e) => out.problems.push(format!("label: {}", classify(&e, who.as_deref()))),
            }
        }
        if comment {
            let text = format!("{MARKER}\n{body}");
            // --edit-last --create-if-none: one comment per thread, updated, never appended.
            let edited = gh(&root, acct, &[noun, "comment", &n, "--edit-last", "--create-if-none", "--body", &text]);
            match edited {
                Ok(_) => out.commented = true,
                Err(_) => {
                    // Older gh has no --create-if-none; fall back so the claim still lands.
                    // The FALLBACK's error is the one reported: the first is most likely that
                    // missing flag, and `classify` cannot see an auth failure through it.
                    match gh(&root, acct, &[noun, "comment", &n, "--body", &text]) {
                        Ok(_) => out.commented = true,
                        Err(e) => out.problems.push(format!("comment: {}", classify(&e, who.as_deref()))),
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

/// Release a claim once the agent ended without pushing: a claim never released tells a
/// colleague someone is working on what nobody is. Undoes only what the claim wrote
/// (`unassign` and `label` come from the frontend's ledger), never a blanket reset.
#[tauri::command]
pub(crate) async fn gh_release(
    root: String,
    number: i64,
    kind: String,
    unassign: bool,
    label: String,
    body: String,
    account: Option<String>,
) -> ClaimOutcome {
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let who = who_for(acct);
        let noun = if kind == "pr" { "pr" } else { "issue" };
        let n = number.to_string();
        let mut out = ClaimOutcome { assigned: false, commented: false, labeled: false, problems: vec![] };

        if unassign {
            if let Err(e) = gh(&root, acct, &[noun, "edit", &n, "--remove-assignee", "@me"]) {
                out.problems.push(format!("unassign: {}", classify(&e, who.as_deref())));
            }
        }
        if !label.is_empty() {
            if let Err(e) = gh(&root, acct, &[noun, "edit", &n, "--remove-label", &label]) {
                out.problems.push(format!("label: {}", classify(&e, who.as_deref())));
            }
        }
        if !body.is_empty() {
            let text = format!("{MARKER}\n{body}");
            // Reported like unassign and label above: a release comment that never landed
            // leaves the thread saying somebody is still working on this.
            if gh(&root, acct, &[noun, "comment", &n, "--edit-last", "--create-if-none", "--body", &text]).is_ok() {
                out.commented = true;
            } else {
                match gh(&root, acct, &[noun, "comment", &n, "--body", &text]) {
                    Ok(_) => out.commented = true,
                    Err(e) => out.problems.push(format!("comment: {}", classify(&e, who.as_deref()))),
                }
            }
        }
        gh_invalidate(root);
        out
    })
    .await
    .unwrap_or(ClaimOutcome { assigned: false, commented: false, labeled: false, problems: vec!["release task failed".into()] })
}

// ---------- what happened, and when ----------

/// One thing that happened to an issue or PR; the Trail buckets these by day.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct GhEvent {
    pub number: i64,
    pub kind: String,  // "issue" | "pr"
    pub event: String, // "opened" | "closed" | "merged"
    pub title: String,
    pub url: String,
    pub at: String, // ISO-8601; the frontend owns day bucketing (`dayKeyOf`)
}

/// Events from a list carrying `createdAt`, `closedAt` and (for PRs) `mergedAt`. One
/// item can yield two events (opened, then merged); `mergedAt` wins over `closedAt`,
/// since GitHub sets both when a PR merges.
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

/// Everything that opened, closed or merged in this repo recently. gh has no "changed
/// since" filter, so the caller applies the window after bucketing; the limit bounds the work.
#[tauri::command]
pub(crate) async fn gh_day_activity(root: String, force: bool, account: Option<String>) -> Vec<GhEvent> {
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
        let acct = account.as_deref();
        let mut out = Vec::new();
        if let Ok(j) = gh(&root, acct, &[
            "issue", "list", "--state", "all", "--limit", "120",
            "--json", "number,title,url,createdAt,closedAt",
        ]) {
            out.extend(parse_events(&j, "issue"));
        }
        if let Ok(j) = gh(&root, acct, &[
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

/// A merged pull request, reduced to what branch cleanup needs: the branch it merged from.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct MergedPr {
    pub number: i64,
    pub branch: String, // head branch, the join to a local ref of the same name
    pub title: String,
    pub url: String,
    pub merged_at: String,
}

/// Merged pull requests, and whether we could ask at all. `available: false` must not
/// read as an empty list: a squash-merged branch is unidentifiable without this data,
/// and silently offering less cleanup ends in a force-delete by hand.
#[derive(serde::Serialize, Clone, Debug, Default)]
pub(crate) struct MergedPrs {
    pub available: bool,
    pub reason: Option<String>,
    pub prs: Vec<MergedPr>,
}

pub(crate) fn parse_merged_prs(json: &str) -> Vec<MergedPr> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(arr) = v.as_array() else { return vec![] };
    arr.iter()
        .filter_map(|o| {
            let number = o.get("number")?.as_i64()?;
            // The join is the branch; a PR without one is no use here.
            let branch = o.get("headRefName").and_then(|x| x.as_str()).filter(|s| !s.is_empty())?;
            // `mergedAt` is null for a PR closed unmerged. `--state merged` should never
            // return one, but the difference is a branch's whole history.
            let merged_at = o.get("mergedAt").and_then(|x| x.as_str()).filter(|s| !s.is_empty())?;
            Some(MergedPr {
                number,
                branch: branch.to_string(),
                title: o.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                url: o.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                merged_at: merged_at.to_string(),
            })
        })
        .collect()
}

struct CachedMerged { at: Instant, result: MergedPrs }
static MERGED_CACHE: Mutex<Option<HashMap<String, CachedMerged>>> = Mutex::new(None);

/// Which branches had their pull request merged: the evidence behind the deep-clean
/// pane's force-delete, since a squash merge leaves commits no local read can tell from
/// unshipped work. Cached for TTL: the pane re-reads on every repaint of its list.
#[tauri::command]
pub(crate) async fn gh_merged_prs(root: String, force: bool, account: Option<String>) -> MergedPrs {
    tauri::async_runtime::spawn_blocking(move || {
        if !force {
            if let Ok(guard) = MERGED_CACHE.lock() {
                if let Some(hit) = guard.as_ref().and_then(|m| m.get(&root)) {
                    if hit.at.elapsed() < TTL {
                        return hit.result.clone();
                    }
                }
            }
        }
        let acct = account.as_deref();
        let result = match gh(&root, acct, &[
            "pr", "list", "--state", "merged", "--limit", "100",
            "--json", "number,title,url,headRefName,mergedAt",
        ]) {
            Err(e) => MergedPrs { available: false, reason: Some(classify(&e, who_for(acct).as_deref())), prs: vec![] },
            Ok(j) => MergedPrs { available: true, reason: None, prs: parse_merged_prs(&j) },
        };
        if let Ok(mut guard) = MERGED_CACHE.lock() {
            guard.get_or_insert_with(HashMap::new)
                .insert(root.clone(), CachedMerged { at: Instant::now(), result: result.clone() });
        }
        result
    })
    .await
    .unwrap_or_default()
}

/// Close an issue, with a comment saying why. The only destructive GitHub write, so the
/// UI never does it on one click and the comment is required. The comment goes first:
/// a failed close then leaves an explanation, where the other order leaves a silent close.
#[tauri::command]
pub(crate) async fn gh_close_issue(
    root: String,
    number: i64,
    comment: String,
    account: Option<String>,
) -> Result<(), String> {
    let body = comment.trim().to_string();
    if body.is_empty() {
        return Err("a closing comment is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let who = who_for(acct);
        let n = number.to_string();
        gh(&root, acct, &["issue", "comment", &n, "--body", &body]).map_err(|e| classify(&e, who.as_deref()))?;
        gh(&root, acct, &["issue", "close", &n]).map_err(|e| classify(&e, who.as_deref()))?;
        gh_invalidate(root.clone());
        Ok(())
    })
    .await
    .map_err(|e| format!("gh task failed: {e}"))?
}

// ---------- the project's own policy ----------

/// ```toml
/// [claim]            # in .episko/episko.toml; a ceiling, never a default
/// assign = false     # this team uses assignment for planning
/// ```
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

/// Every field is `Option`: absent must mean "allowed", never `false`, so a serde default
/// on a bool would turn an incomplete policy into a lockout. Unknown keys are ignored.
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
    // A malformed file must not lock a team out of their claims; forgiving on read, as tasks.rs is.
    let Ok(file) = toml::from_str::<RawFile>(toml_text) else { return a };
    let Some(c) = file.claim else { return a };
    if let Some(x) = c.assign { a.assign = x; }
    if let Some(x) = c.comment { a.comment = x; }
    if let Some(x) = c.label { a.label = x; }
    a
}

/// The project's claim policy; a missing or unreadable file is "everything allowed".
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
// "We decided #24 stays open" is a project fact, so it is committed, with who decided
// so the list is auditable. Written through `toml_edit` so a hand-written `[claim]`
// block and its comments survive, as tasks.rs does for tasks.toml.

fn episko_toml(root: &str) -> std::path::PathBuf {
    std::path::Path::new(root).join(".episko").join("episko.toml")
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct KeptIssue {
    pub number: i64,
    pub who: String, // who decided; a record, not an anonymous blocklist
    pub at: String,  // ISO-8601 date, day resolution; the hour only churns the diff
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

/// Add or remove one. `create` gates the very first write, as the digest's does: a new
/// committable file in someone's repo is a real side effect.
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
    // Drop any existing entry first, so a re-keep updates and an un-keep is the removal.
    arr.retain(|v| v.as_inline_table().and_then(|t| t.get("number")).and_then(|n| n.as_integer()) != Some(number));
    if keep {
        let mut t = toml_edit::InlineTable::new();
        t.insert("number", number.into());
        t.insert("who", who.into());
        t.insert("at", at.into());
        arr.push(toml_edit::Value::InlineTable(t));
    }
    // One entry per line; a readable diff is the point of committing this.
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

trait PipeRead { fn pipe_read(&self) -> Option<String>; } // lets claim_policy read as one expression
impl PipeRead for std::path::PathBuf {
    fn pipe_read(&self) -> Option<String> { std::fs::read_to_string(self).ok() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::scratch_dir;

    #[test]
    fn keep_list_round_trips_and_records_who_decided() {
        // Committed, so auditable: `who` must round-trip.
        let d = scratch_dir();
        let r = d.to_string_lossy().to_string();
        assert!(set_kept(r.clone(), 24, "Tim".into(), "2026-07-31".into(), true, false).is_err());
        set_kept(r.clone(), 24, "Tim".into(), "2026-07-31".into(), true, true).unwrap();
        let l = list_kept(r.clone());
        assert_eq!(l.len(), 1);
        assert_eq!(l[0], KeptIssue { number: 24, who: "Tim".into(), at: "2026-07-31".into() });

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
        // [claim] may be hand-written with comments; toml_edit is what keeps them.
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
    fn parses_merged_prs_and_drops_the_ones_that_never_merged() {
        // "closed" and "merged" are one null field apart in gh's model, and the deep-clean
        // pane force-deletes on this evidence.
        let m = parse_merged_prs(r#"[
          {"number":74,"title":"a merged one","url":"u1","headRefName":"feat/one","mergedAt":"2026-08-01T10:00:00Z"},
          {"number":75,"title":"closed unmerged","url":"u2","headRefName":"feat/two","mergedAt":null},
          {"number":76,"title":"no head branch","url":"u3","mergedAt":"2026-08-02T10:00:00Z"}
        ]"#);
        assert_eq!(m.len(), 1, "only the genuinely merged PR with a branch survives: {m:?}");
        assert_eq!(m[0].branch, "feat/one");
        assert_eq!(m[0].number, 74);

        for bad in ["", "not json", "{}", "null", "<html>"] {
            assert!(parse_merged_prs(bad).is_empty(), "should be empty for {bad:?}");
        }
    }

    #[test]
    fn malformed_output_yields_nothing_rather_than_panicking() {
        // gh can print a warning, an empty body, or HTML from a proxy.
        for bad in ["", "not json", "{}", "null", "[{\"no\":\"number\"}]", "<html>"] {
            assert!(parse_issues(bad).is_empty(), "should be empty for {bad:?}");
        }
    }

    #[test]
    fn tolerates_missing_optional_fields() {
        // Fields differ between issue and pr payloads and gh versions; `number` alone must do.
        let t = parse_issues(r#"[{"number":7}]"#);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].title, "");
        assert!(t[0].branch.is_none());
        assert!(!t[0].draft);
    }

    #[test]
    fn one_item_can_produce_two_events_on_different_days() {
        let e = parse_events(r#"[{"number":46,"title":"a pr","url":"u",
            "createdAt":"2026-07-31T12:09:32Z","closedAt":"2026-07-31T13:37:35Z","mergedAt":"2026-07-31T13:37:35Z"}]"#, "pr");
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].event, "opened");
        // mergedAt wins: GitHub sets closedAt too when a PR merges.
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
        assert_eq!(parse_allow(""), ClaimAllow::default());
        assert_eq!(parse_allow("[other]\nkey = 1"), ClaimAllow::default());
        assert_eq!(parse_allow("not { valid toml"), ClaimAllow::default());
    }

    #[test]
    fn a_project_can_withhold_one_thing_without_withholding_the_rest() {
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
        assert!(classify("gh: command not found", None).contains("not installed"));
        assert!(classify("gh not available: No such file or directory", None).contains("not installed"));
        assert!(classify("error: not logged in to any GitHub hosts", None).contains("gh auth login"));
        assert!(classify("fatal: not a git repository", None).contains("not a GitHub repository"));
        // Anything unrecognised passes through rather than being mangled into a guess.
        assert_eq!(classify("API rate limit exceeded", None), "API rate limit exceeded");
    }

    #[test]
    fn an_invisible_repo_names_the_account_that_could_not_see_it() {
        let err = "GraphQL: Could not resolve to a Repository with the name 'acme/secret'. (repository)";
        let said = classify(err, Some("octocat"));
        assert!(said.contains("octocat"), "{said}");
        assert!(said.contains("cannot see"), "{said}");
        // With nothing to name, the sentence must still say an account is involved.
        assert!(classify(err, None).contains("account"));
    }

    #[test]
    fn a_404_is_not_a_missing_cli() {
        assert_ne!(classify("gh: Not Found (HTTP 404)", None), "GitHub CLI (gh) is not installed");
    }

    #[test]
    fn reads_both_accounts_and_which_one_is_active() {
        let json = r#"{"hosts":{"github.com":[
            {"state":"success","active":true,"host":"github.com","login":"octocat","tokenSource":"keyring"},
            {"state":"success","active":false,"host":"github.com","login":"octocat-work","tokenSource":"keyring"}
        ]}}"#;
        let a = parse_accounts(json);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0], GhAccount { login: "octocat".into(), active: true });
        assert!(!a[1].active);
    }

    #[test]
    fn other_hosts_are_not_accounts_you_can_pick() {
        let json = r#"{"hosts":{"github.example.com":[{"active":true,"login":"someone"}]}}"#;
        assert!(parse_accounts(json).is_empty());
    }

    /// No gh, a gh too old for `--json`, or a blank login all mean "no picker", never an error.
    #[test]
    fn unreadable_account_output_is_no_accounts_rather_than_a_panic() {
        assert!(parse_accounts("").is_empty());
        assert!(parse_accounts("not json at all").is_empty());
        assert!(parse_accounts(r#"{"hosts":{"github.com":[{"active":true,"login":""}]}}"#).is_empty());
        assert!(!parse_accounts(r#"{"hosts":{"github.com":[{"login":"octocat"}]}}"#)[0].active);
    }
}
