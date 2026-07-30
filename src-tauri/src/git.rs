// Everything Episko asks git: worktrees, branches, the working-set diff, the
// toolbar's fetch/pull/push, and the commit info the new-session dialog shows.
//
// Two invariants run through the whole module and are what its tests are about:
//
// - **Never parse localized git output.** Every call goes through `git_cmd`, which
//   forces `LC_ALL=C`, and control flow branches on exit codes or an explicit
//   probe — a German git says "existiert bereits", not "already exists".
// - **Never destroy a checkout something is using.** `remove_worktree` and
//   `switch_branch` consult `AppState.sessions` by `same_path`, so a worktree with
//   a live embedded session in it is refused rather than deleted.
//
// `git_cmd`/`git_run` are git-only and live here; they call down into
// `platform::{sys_command, augmented_path}`, which is why platform.rs had to move
// out first. `same_path` came here too — one consumer module, so it belongs to it.


use tauri::State;

use crate::platform::{augmented_path, norm_path, sys_command};
use crate::AppState;

/// Create a git worktree with a new (or existing) branch off `repo_dir`.
/// Returns the absolute worktree path. Worktrees live in a sibling
/// `.cc-worktrees/<repo>/<branch>` folder so the repo stays clean.
#[tauri::command(async)]
pub(crate) fn create_worktree(repo_dir: String, branch: String, base: Option<String>) -> Result<String, String> {
    // Every git call forces LC_ALL=C: we must never depend on localized output.
    // A German git says "existiert bereits", not "already exists" — parsing error
    // text for control flow (as this used to) silently broke worktree creation on
    // non-English gits. We now branch on exit codes / an explicit existence probe.
    let git = |args: &[&str]| {
        sys_command("git")
            .env("LC_ALL", "C")
            .args(args)
            .output()
    };

    let root_out = git(&["-C", &repo_dir, "rev-parse", "--show-toplevel"])
        .map_err(|e| e.to_string())?;
    if !root_out.status.success() {
        return Err("not a git repository".into());
    }
    let root = norm_path(String::from_utf8_lossy(&root_out.stdout).trim());
    let safe: String = branch.trim().chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.') { c } else { '-' })
        .collect();
    if safe.is_empty() {
        return Err("empty branch name".into());
    }

    let root_path = std::path::Path::new(&root);
    let name = root_path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "repo".into());
    let parent = root_path.parent().unwrap_or(root_path);
    let wt_path = parent.join(".cc-worktrees").join(&name).join(safe.replace('/', "-"));
    if let Some(p) = wt_path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let wt_str = wt_path.to_string_lossy().to_string();

    // Decide new-branch (-b) vs attach-existing by probing the ref directly,
    // instead of creating and inspecting a localized error string.
    let branch_exists = git(&["-C", &root, "rev-parse", "--verify", "--quiet", &format!("refs/heads/{safe}")])
        .map(|o| o.status.success())
        .unwrap_or(false);

    // `base` only means anything when we're CREATING the branch — attaching an existing
    // one takes its own tip. Without it `worktree add -b` cuts from the repo's HEAD,
    // which quietly makes whatever the root folder is parked on the parent of every new
    // branch; passing a start-point is how the caller escapes that.
    let base = base.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    if let Some(b) = base.as_deref() {
        if !branch_exists {
            let ok = git(&["-C", &root, "rev-parse", "--verify", "--quiet", &format!("{b}^{{commit}}")])
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !ok {
                return Err(format!("can't branch from {b} — no such commit"));
            }
        }
    }

    let add = if branch_exists {
        git(&["-C", &root, "worktree", "add", &wt_str, &safe])
    } else if let Some(b) = base.as_deref() {
        git(&["-C", &root, "worktree", "add", "-b", &safe, &wt_str, b])
    } else {
        git(&["-C", &root, "worktree", "add", "-b", &safe, &wt_str])
    }.map_err(|e| e.to_string())?;
    if add.status.success() {
        return Ok(wt_str);
    }

    // Recoverable case: the worktree dir already exists from a previous run and is
    // already on the branch we want — hand it back so re-opening it just works.
    if wt_path.is_dir() {
        if let Ok(o) = git(&["-C", &wt_str, "rev-parse", "--abbrev-ref", "HEAD"]) {
            if o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == safe {
                return Ok(wt_str);
            }
        }
    }
    Err(String::from_utf8_lossy(&add.stderr).trim().to_string())
}

#[derive(serde::Serialize, Debug)]
pub(crate) struct Worktree {
    path: String,
    branch: String,
    is_main: bool,
    /// Working tree has uncommitted or untracked changes (`git status --porcelain`).
    /// A dirty worktree can't be removed without `--force`, so the UI won't offer a
    /// one-click removal for it. Always false for the main worktree (never removable).
    dirty: bool,
    /// This worktree's branch is fully merged into the MAIN worktree's branch (its
    /// commits are an ancestor). Removing such a worktree — and safe-deleting its
    /// branch — loses nothing, so the UI can surface it as the obvious cleanup.
    merged: bool,
    /// `git worktree lock` was used on this checkout. Git refuses to remove a locked
    /// worktree even with `--force`, so without this flag the UI would hand the user
    /// a `--force` command that also fails. Always false for the main worktree.
    locked: bool,
    /// The checkout directory is still on disk. A hand-deleted folder stays in
    /// `.git/worktrees` until pruned, so it keeps appearing in this list — the UI must
    /// not launch a PTY into it, and removal has to fall back to `prune`.
    exists: bool,
}

/// List the git worktrees for a repo (parsed from `git worktree list --porcelain`).
/// The first entry is the main working tree. Each linked worktree is enriched with
/// `dirty` / `merged` cues so the picker can tell which are safe to clean up.
#[tauri::command(async)]
pub(crate) fn list_worktrees(repo_dir: String) -> Vec<Worktree> {
    let out = sys_command("git")
        .arg("-C").arg(&repo_dir).args(["worktree", "list", "--porcelain"])
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut res: Vec<Worktree> = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch = String::new();
    let mut cur_locked = false;
    let flush = |res: &mut Vec<Worktree>, path: Option<String>, branch: String, locked: bool| {
        if let Some(path) = path {
            let is_main = res.is_empty();
            let exists = std::path::Path::new(&path).is_dir();
            res.push(Worktree {
                path, branch, is_main, dirty: false, merged: false,
                locked: locked && !is_main,
                exists,
            });
        }
    };
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut res, cur_path.take(), std::mem::take(&mut cur_branch), std::mem::take(&mut cur_locked));
            cur_path = Some(norm_path(p));
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        } else if line.starts_with("detached") {
            cur_branch = "(detached)".to_string();
        } else if line == "locked" || line.starts_with("locked ") {
            // `locked` appears bare, or as `locked <reason>`.
            cur_locked = true;
        }
    }
    flush(&mut res, cur_path.take(), cur_branch, cur_locked);

    // Second pass: cleanliness cues for the linked worktrees. `merged` is measured
    // against the main worktree's branch. Every git call here is best-effort — any
    // hiccup just leaves the flag false, which only ever makes the UI more cautious.
    let main_branch = res.iter().find(|w| w.is_main)
        .map(|w| w.branch.clone())
        .filter(|b| !b.is_empty() && b != "(detached)");
    for w in res.iter_mut() {
        if w.is_main {
            continue;
        }
        w.dirty = sys_command("git")
            .env("LC_ALL", "C")
            .arg("-C").arg(&w.path)
            .args(["--no-optional-locks", "status", "--porcelain"])
            .output()
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false);
        if let Some(mb) = &main_branch {
            if !w.branch.is_empty() && w.branch != "(detached)" && &w.branch != mb {
                // `merge-base --is-ancestor A B` exits 0 when A is an ancestor of B,
                // i.e. this worktree's branch is fully contained in the main branch.
                w.merged = sys_command("git")
                    .env("LC_ALL", "C")
                    .arg("-C").arg(&repo_dir)
                    .args(["merge-base", "--is-ancestor",
                        &format!("refs/heads/{}", w.branch),
                        &format!("refs/heads/{mb}")])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
            }
        }
    }
    res
}

/// True when two paths point at the same location, tolerant of symlinks and
/// trailing slashes. Falls back to a string compare when either can't be
/// canonicalized (e.g. one has already been deleted).
fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// Remove a linked git worktree, optionally safe-deleting its branch. Mirrors
/// `git_action`'s rule that no button may leave state the UI can't explain: the
/// destructive `--force` (worktree) and `-D` (branch) variants are NEVER run from
/// here — on refusal we hand back the exact shell command to run in a terminal.
///
/// Two guards up front: refuse while a live embedded session runs in the worktree
/// (close it first), and refuse the repo's main worktree. Beyond that, plain
/// `git worktree remove` is the safety net — it declines a dirty/untracked tree on
/// its own, so committed work is never at risk from a click.
#[tauri::command(async)]
pub(crate) fn remove_worktree(
    state: State<AppState>,
    repo_dir: String,
    path: String,
    branch: String,
    delete_branch: bool,
) -> Result<GitActionResult, String> {
    // The one guard that needs live app state: never yank a worktree out from under
    // a running embedded session. The rest is pure git and lives in the helper.
    let label = if branch.is_empty() { "worktree" } else { &branch };
    if state.sessions.lock().unwrap().values().any(|s| same_path(&s.workdir, &path)) {
        return Err(format!("a session is still running in {label} — close it first"));
    }
    remove_worktree_impl(&repo_dir, &path, &branch, delete_branch)
}

/// The git side of `remove_worktree`, free of app state so it's testable against a
/// real temp repo. Refuses the main worktree; removes without `--force`; optionally
/// safe-deletes the branch — handing back the force command on any refusal.
fn remove_worktree_impl(
    repo_dir: &str,
    path: &str,
    branch: &str,
    delete_branch: bool,
) -> Result<GitActionResult, String> {
    let label = if branch.is_empty() { "worktree".to_string() } else { branch.to_string() };

    let listed = list_worktrees(repo_dir.to_string());
    if listed.iter().any(|w| w.is_main && same_path(&w.path, path)) {
        return Err("that's the repo's main worktree — it can't be removed".into());
    }
    // A locked worktree is refused by git even WITH --force, so suggesting the force
    // command (as the generic failure path below does) would just fail again. Name
    // the actual next step instead.
    if listed.iter().any(|w| w.locked && same_path(&w.path, path)) {
        return Ok(GitActionResult {
            ok: false,
            summary: format!("{label} is locked — unlock it first"),
            output: String::new(),
            suggest: Some(format!("git worktree unlock \"{path}\" && git worktree remove \"{path}\"")),
        });
    }

    let out = git_run(git_cmd(repo_dir, &["worktree", "remove", path]), 30)?;
    if !out.status.success() {
        // The folder was deleted by hand: nothing to remove, only an administrative
        // record in .git/worktrees. `prune` is the operation git actually wants here,
        // and it can't lose work — the tree is already gone.
        if !std::path::Path::new(path).is_dir() {
            let pruned = git_run(git_cmd(repo_dir, &["worktree", "prune"]), 15)?;
            if pruned.status.success() {
                return Ok(GitActionResult {
                    ok: true,
                    summary: format!("Pruned {label} — its folder was already gone"),
                    output: String::new(),
                    suggest: None,
                });
            }
        }
        let combined = [
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
        let first = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("git refused").to_string();
        return Ok(GitActionResult {
            ok: false,
            summary: first,
            output: combined,
            suggest: Some(format!("git worktree remove --force \"{path}\"")),
        });
    }

    // Best-effort: drop the now-empty `.cc-worktrees/<repo>/` parent so the sibling
    // tree doesn't accumulate empty dirs. `remove_dir` only succeeds when empty.
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = std::fs::remove_dir(parent);
    }

    if delete_branch && !branch.is_empty() && branch != "(detached)" {
        // Safe-delete only: `git branch -d` refuses an unmerged branch. If it does,
        // the worktree is already gone — report success and offer the force command.
        let del = git_run(git_cmd(repo_dir, &["branch", "-d", branch]), 15)?;
        if del.status.success() {
            return Ok(GitActionResult {
                ok: true,
                summary: format!("Removed worktree and branch {branch}"),
                output: String::new(),
                suggest: None,
            });
        }
        return Ok(GitActionResult {
            ok: true,
            summary: format!("Removed worktree — kept branch {branch} (not fully merged)"),
            output: String::from_utf8_lossy(&del.stderr).trim().to_string(),
            suggest: Some(format!("git branch -D \"{branch}\"")),
        });
    }

    Ok(GitActionResult { ok: true, summary: format!("Removed worktree {label}"), output: String::new(), suggest: None })
}

/// The tip commit of a checkout or a ref — what the new-session dialog's detail
/// pane shows for whichever destination is highlighted.
#[derive(serde::Serialize)]
pub(crate) struct CommitInfo {
    /// Abbreviated sha (`%h`).
    short: String,
    /// Subject line (`%s`).
    subject: String,
    /// Author name (`%an`).
    author: String,
    /// Committer date, relative (`%cr`) — "2 hours ago".
    rel: String,
}

/// Tip commit of `rev` (a branch name, or HEAD when empty) as seen from `dir`.
///
/// Fetched for the *highlighted* row only, never for the whole list — a repo can
/// have `BRANCH_LIST_CAP` branches plus every worktree, and one `git log` per row
/// would cost far more than the pane is worth. NUL-separated so a subject
/// containing any printable character still parses.
#[tauri::command(async)]
pub(crate) fn git_commit_info(dir: String, rev: String) -> Option<CommitInfo> {
    let rev = if rev.trim().is_empty() { "HEAD".to_string() } else { rev };
    let out = sys_command("git")
        .env("LC_ALL", "C")
        .arg("-C").arg(&dir)
        .args(["--no-optional-locks", "log", "-1", "--format=%h%x00%s%x00%an%x00%cr", &rev])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.trim_end_matches('\n').split('\0');
    let short = parts.next()?.to_string();
    if short.is_empty() {
        return None; // an unborn branch has no tip
    }
    Some(CommitInfo {
        short,
        subject: parts.next().unwrap_or("").to_string(),
        author: parts.next().unwrap_or("").to_string(),
        rel: parts.next().unwrap_or("").to_string(),
    })
}

/// Move the repo's main working tree to another branch.
///
/// Episko's whole model is "don't switch, branch out" — worktrees exist so two pieces
/// of work never fight over one checkout. But the root folder's branch is also the
/// default parent of every new worktree, so a root parked somewhere stale is a real
/// problem, and a terminal was the only way out. This is that lever, with the guards
/// that make it safe to expose:
///
/// - Refused while Episko sessions run in the root: switching moves the ground under a
///   live agent's cwd mid-edit.
/// - Refused when the target is checked out in another worktree (git refuses too, but
///   this says which one).
/// - Refused on a dirty tree. `git switch` would silently CARRY uncommitted changes to
///   the new branch — not destructive, but a state change the UI never explained, which
///   is the same rule `git_action` and `remove_worktree` follow. Handed to a terminal.
#[tauri::command(async)]
pub(crate) fn switch_branch(state: State<AppState>, repo_dir: String, branch: String) -> Result<GitActionResult, String> {
    if branch.trim().is_empty() {
        return Err("no branch given".into());
    }
    if state.sessions.lock().unwrap().values().any(|s| same_path(&s.workdir, &repo_dir)) {
        return Err("sessions are running in this folder — close them first".into());
    }
    if list_worktrees(repo_dir.clone()).iter()
        .any(|w| !same_path(&w.path, &repo_dir) && w.branch == branch)
    {
        return Err(format!("{branch} is already checked out in another worktree"));
    }

    let status = git_run(git_cmd(&repo_dir, &["--no-optional-locks", "status", "--porcelain"]), 20)?;
    if status.status.success() && !status.stdout.is_empty() {
        return Ok(GitActionResult {
            ok: false,
            summary: "uncommitted changes — switching would carry them across".into(),
            output: String::new(),
            suggest: Some(format!("git switch \"{branch}\"")),
        });
    }

    let out = git_run(git_cmd(&repo_dir, &["switch", &branch]), 30)?;
    if out.status.success() {
        return Ok(GitActionResult {
            ok: true,
            summary: format!("Switched to {branch}"),
            output: String::new(),
            suggest: None,
        });
    }
    let combined = [
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
    let first = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("git refused").to_string();
    Ok(GitActionResult {
        ok: false,
        summary: first,
        output: combined,
        suggest: Some(format!("git switch \"{branch}\"")),
    })
}

/// Delete a local branch, the counterpart to the picker's worktree removal.
///
/// Same rule as `remove_worktree`: the destructive variant is NEVER run from a click.
/// `git branch -d` refuses anything not fully merged, and on refusal we hand back the
/// exact `-D` command for a terminal instead of running it.
///
/// Worth knowing about the common case this exists for — a branch whose upstream is
/// `gone` (the PR merged, the remote branch was deleted). If that PR was **squash**-
/// merged, the branch's commits never became ancestors of HEAD, so `-d` refuses even
/// though the work is safely in main. That refusal is correct and the `-D` handoff is
/// the honest answer; the UI warns about it before the click rather than after.
#[tauri::command(async)]
pub(crate) fn delete_branch(repo_dir: String, branch: String) -> Result<GitActionResult, String> {
    if branch.trim().is_empty() {
        return Err("no branch given".into());
    }
    // git refuses to delete a branch that some worktree holds; say so in our own words
    // instead of surfacing its message, and name the fix.
    if list_worktrees(repo_dir.clone()).iter().any(|w| w.branch == branch) {
        return Err(format!("{branch} is checked out — remove its worktree first"));
    }

    let out = git_run(git_cmd(&repo_dir, &["branch", "-d", &branch]), 15)?;
    if out.status.success() {
        return Ok(GitActionResult {
            ok: true,
            summary: format!("Deleted branch {branch}"),
            output: String::new(),
            suggest: None,
        });
    }
    let combined = [
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
    let first = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("git refused").to_string();
    Ok(GitActionResult {
        ok: false,
        summary: first,
        output: combined,
        suggest: Some(format!("git branch -D \"{branch}\"")),
    })
}

/// One local branch, with enough context for the worktree picker to tell whether
/// it's worth starting on. `current` is the branch the repo's HEAD is on (the repo
/// row, not the pick list). `checked_out` means some worktree already holds it — git
/// refuses a second checkout, so it can't take a new worktree and appears in the
/// existing-worktrees list instead. `rel`/`unix` describe the last commit (staleness).
///
/// `ahead`/`behind` are versus this branch's OWN upstream, not versus HEAD. Measuring
/// every branch against whatever happens to be checked out answers a question nobody
/// asked ("how far behind my current work is this old branch" — always "very"), while
/// the useful one is "is my work pushed, and has the remote moved on".
#[derive(serde::Serialize, Debug)]
pub(crate) struct BranchInfo {
    name: String,
    current: bool,
    checked_out: bool,
    /// The remote-tracking ref this branch follows ("origin/foo"), empty when the
    /// branch is purely local.
    upstream: String,
    /// Commits this branch has that its upstream doesn't — unpushed work. 0 when
    /// there is no upstream.
    ahead: u32,
    /// Commits the upstream has that this branch doesn't — unpulled work. 0 when
    /// there is no upstream.
    behind: u32,
    /// An upstream is configured but no longer exists on the remote (branch deleted
    /// after a merge, typically). `upstream` still names it.
    gone: bool,
    rel: String,
    unix: i64,
}

/// Local branches for the worktree picker, most-recently-committed first, each with
/// staleness + upstream context (see `BranchInfo`). Nothing is filtered here — the
/// frontend hides `current` and `checked_out` from the pickable list; returning them
/// with flags keeps the command honest and testable. Capped at BRANCH_LIST_CAP so a
/// repo with hundreds of refs can't blow the list up.
///
/// Everything comes out of ONE `for-each-ref`: `%(upstream:track)` makes git do the
/// ahead/behind arithmetic itself, so this no longer spawns a `rev-list` per branch.
#[tauri::command(async)]
pub(crate) fn git_branch_list(repo_dir: String) -> Vec<BranchInfo> {
    const BRANCH_LIST_CAP: usize = 80;
    // LC_ALL=C for the same reason as create_worktree: never depend on localized
    // output — and here it also pins `%(upstream:track)` to English "ahead"/"behind".
    let git = |args: &[&str]| sys_command("git").env("LC_ALL", "C").args(args).output();

    let taken: std::collections::HashSet<String> =
        match git(&["-C", &repo_dir, "worktree", "list", "--porcelain"]) {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.strip_prefix("branch "))
                .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string())
                .collect(),
            _ => Default::default(),
        };

    // The branch HEAD points at (None when detached — then there is no "current").
    let current = git(&["-C", &repo_dir, "symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    // Tab-separated so neither the branch name nor the relative date can collide with
    // the delimiter (a relative date is "3 days ago" — spaces, never tabs).
    let out = match git(&[
        "-C", &repo_dir,
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)\t%(committerdate:unix)\t%(committerdate:relative)\t%(upstream)\t%(upstream:short)\t%(upstream:track,nobracket)",
        "refs/heads",
    ]) {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };
    let text = String::from_utf8_lossy(&out.stdout);

    let mut res = Vec::new();
    for line in text.lines().take(BRANCH_LIST_CAP) {
        let mut parts = line.split('\t');
        let name = match parts.next() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let unix = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let rel = parts.next().unwrap_or("").to_string();
        // An upstream is only interesting if it is a REMOTE. `git branch`/`checkout -b`
        // off a local branch can set that local branch as the upstream (depending on
        // branch.autoSetupMerge), and "2 commits not pushed to dev" is nonsense — dev is
        // right here. Gate on the full refname; only refs/remotes/* counts.
        let is_remote = parts.next().unwrap_or("").trim().starts_with("refs/remotes/");
        let upstream = if is_remote { parts.next().unwrap_or("").trim().to_string() } else { parts.next(); String::new() };
        // `%(upstream:track,nobracket)` is "" when in sync (or absent), "gone" when the
        // upstream was deleted, else "ahead 2", "behind 3" or "ahead 2, behind 3".
        let track = if is_remote { parts.next().unwrap_or("").trim() } else { parts.next(); "" };
        let gone = track == "gone";
        let field = |key: &str| -> u32 {
            track.split(',')
                .filter_map(|p| p.trim().strip_prefix(key))
                .filter_map(|n| n.trim().parse().ok())
                .next()
                .unwrap_or(0)
        };
        let (ahead, behind) = if gone { (0, 0) } else { (field("ahead "), field("behind ")) };

        res.push(BranchInfo {
            checked_out: taken.contains(&name),
            current: current.as_deref() == Some(name.as_str()),
            name, upstream, ahead, behind, gone, rel, unix,
        });
    }
    res
}

/// Current git branch for a working directory (None if not a repo / detached).
#[tauri::command(async)]
pub(crate) fn git_branch(workdir: String) -> Option<String> {
    let out = sys_command("git")
        .arg("-C")
        .arg(&workdir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if b.is_empty() || b == "HEAD" { None } else { Some(b) }
}

#[derive(serde::Serialize)]
pub(crate) struct HeadInfo {
    /// Branch name when on a branch; None when HEAD is detached.
    branch: Option<String>,
    /// Short commit sha of HEAD (used to label a detached checkout).
    short: String,
}

/// Live HEAD of a working directory, so the UI can show the branch that is
/// *actually* checked out rather than the one a worktree was created with (a
/// worktree shows whatever branch is checked out, and that can change). Returns
/// None if the dir isn't a git repo. LC_ALL=C keeps output locale-independent.
#[tauri::command(async)]
pub(crate) fn git_head(workdir: String) -> Option<HeadInfo> {
    let git = |args: &[&str]| {
        sys_command("git")
            .env("LC_ALL", "C")
            .arg("-C").arg(&workdir)
            .args(args)
            .output()
    };
    let head = git(&["rev-parse", "--short", "HEAD"]).ok()?;
    if !head.status.success() {
        return None;
    }
    let short = String::from_utf8_lossy(&head.stdout).trim().to_string();
    // symbolic-ref succeeds only when on a branch; fails on detached HEAD.
    let branch = git(&["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    Some(HeadInfo { branch, short })
}

/// Resolve `cwd` to its repo's MAIN worktree root and current branch. This is what
/// lets external sessions running in different worktrees of one repo group under that
/// repo (and merge into its project) instead of each cwd becoming its own top-level
/// entry in the sidebar. One git call: line 1 = the common `.git` dir (its parent is
/// the main worktree, identical for the main checkout AND every linked worktree),
/// line 2 = the branch ("HEAD" when detached). (None, None) when `cwd` isn't a repo.
pub(crate) fn git_repo_info(cwd: &str) -> (Option<String>, Option<String>) {
    let out = match git_cmd(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return (None, None),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let common = lines.next().unwrap_or("").trim();
    let branch = lines.next().unwrap_or("").trim();
    let root = std::path::Path::new(common).parent()
        .map(|p| norm_path(&p.to_string_lossy()))
        .filter(|s| !s.is_empty());
    let branch = if branch.is_empty() || branch == "HEAD" { None } else { Some(branch.to_string()) };
    (root, branch)
}

/// A `git` command hardened for running under a GUI app.
///
/// Three things are non-negotiable here, and each one has bitten this codebase's
/// neighbours already:
/// - `LC_ALL=C` — never parse localized output (the german-git-locale gotcha).
/// - an augmented PATH — a Finder-launched app gets a stripped one, and `git` may
///   well live in `/opt/homebrew/bin`.
/// - every credential prompt disabled — a network op that decides to ask for an
///   SSH passphrase or an HTTPS password has no tty to ask on, so without this it
///   blocks forever and takes the invoke thread with it. `BatchMode=yes` makes ssh
///   fail instead of prompting; an askpass that exits non-zero sends git back to
///   the terminal prompt, which `GIT_TERMINAL_PROMPT=0` then refuses. Credential
///   *helpers* (osxkeychain) are untouched, so stored HTTPS creds still work, as
///   do keys already loaded in ssh-agent. Anything else fails fast and readably —
///   which is exactly when we hand the user a terminal.
fn git_cmd(workdir: &str, args: &[&str]) -> std::process::Command {
    let mut c = sys_command("git");
    c.env("LC_ALL", "C")
        .env("PATH", augmented_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    #[cfg(not(windows))]
    {
        c.env("GIT_ASKPASS", "/usr/bin/false").env("SSH_ASKPASS", "/usr/bin/false");
    }
    #[cfg(windows)]
    {
        // No `/usr/bin/false` to point an askpass at; instead forbid Git Credential
        // Manager's interactive GUI prompt, so a missing credential fails fast rather
        // than popping a dialog that hangs the invoke thread. `git_run`'s hard
        // timeout is the ultimate backstop. Stored creds (GCM cache) still work.
        c.arg("-c").arg("credential.interactive=false");
    }
    c.arg("-C").arg(workdir).args(args);
    c
}

/// Run a git command with a hard timeout. `Child::wait` has no timeout in std, so
/// the wait happens on a scratch thread and we kill by pid if it overruns. Without
/// this, a fetch against an unreachable remote hangs a Tauri worker thread for the
/// rest of the app's life.
fn git_run(mut cmd: std::process::Command, secs: u64) -> Result<std::process::Output, String> {
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("git: {e}"))?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    // wait_with_output consumes the child, so the timeout path kills by pid.
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(secs)) {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(_) => {
            #[cfg(not(windows))]
            let _ = sys_command("kill").arg("-9").arg(pid.to_string()).status();
            #[cfg(windows)]
            let _ = sys_command("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).status();
            Err(format!("no answer after {secs}s — remote unreachable, or it wants credentials"))
        }
    }
}

/// Where this branch sits relative to its upstream: `(upstream_name, ahead, behind)`.
/// All zeros with no name when the branch has no upstream, or HEAD is detached.
///
/// Note these counts are only as fresh as the last fetch — git compares against the
/// local remote-tracking ref, not the network. That's why the UI pairs them with a
/// fetch button rather than pretending they're live.
fn upstream_state(workdir: &str) -> (Option<String>, u32, u32) {
    let name = git_cmd(workdir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(name) = name else { return (None, 0, 0) };
    // --left-right --count over the symmetric difference prints "behind\tahead":
    // left side is upstream-only commits, right side is ours.
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Ok(o) = git_cmd(workdir, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).output() {
        if o.status.success() {
            let text = String::from_utf8_lossy(&o.stdout);
            let mut it = text.split_whitespace();
            behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
    }
    (Some(name), ahead, behind)
}

#[derive(serde::Serialize)]
pub(crate) struct DiffStat {
    /// Insertions in the uncommitted working tree (tracked files, vs HEAD).
    added: u32,
    /// Deletions in the uncommitted working tree.
    removed: u32,
    /// Tracked files with uncommitted changes.
    files: u32,
    /// Untracked files (new, never committed).
    untracked: u32,
    /// Total dirty entries (`git status --porcelain` line count).
    dirty: u32,
    /// Upstream ref this branch tracks ("origin/main"), None if it tracks nothing.
    upstream: Option<String>,
    /// Commits we have that the upstream doesn't (as of the last fetch).
    ahead: u32,
    /// Commits the upstream has that we don't (as of the last fetch).
    behind: u32,
}

/// A summary of a session's *uncommitted* work — the "working set" the inspector's
/// Checks strip shows ("+142 −38 · 7 files · 2 new"). We diff against HEAD rather
/// than a base branch on purpose: during a live session the interesting delta is
/// what's in flight since the last commit, and that's always well-defined (whereas
/// guessing the base branch is not). Returns None when `workdir` isn't a repo or
/// has no commits yet. LC_ALL=C + numeric numstat keep it locale-independent (the
/// german-git-locale gotcha) and `--no-optional-locks` avoids fighting a running
/// `git` in the same worktree.
#[tauri::command(async)]
pub(crate) fn git_diffstat(workdir: String) -> Option<DiffStat> {
    let git = |args: &[&str]| {
        sys_command("git")
            .env("LC_ALL", "C")
            .arg("-C").arg(&workdir)
            .args(args)
            .output()
    };
    let ns = git(&["--no-optional-locks", "diff", "--numstat", "HEAD"]).ok()?;
    if !ns.status.success() {
        return None; // not a repo, or an unborn HEAD (no commits)
    }
    let (mut added, mut removed, mut files) = (0u32, 0u32, 0u32);
    for line in String::from_utf8_lossy(&ns.stdout).lines() {
        let mut it = line.split('\t');
        let a = it.next().unwrap_or("");
        let d = it.next().unwrap_or("");
        files += 1;
        added += a.parse::<u32>().unwrap_or(0); // "-" (binary) parses to 0
        removed += d.parse::<u32>().unwrap_or(0);
    }
    let (mut untracked, mut dirty) = (0u32, 0u32);
    if let Ok(st) = git(&["--no-optional-locks", "status", "--porcelain"]) {
        for line in String::from_utf8_lossy(&st.stdout).lines() {
            if line.is_empty() {
                continue;
            }
            dirty += 1;
            if line.starts_with("??") {
                untracked += 1;
            }
        }
    }
    let (upstream, ahead, behind) = upstream_state(&workdir);
    Some(DiffStat { added, removed, files, untracked, dirty, upstream, ahead, behind })
}

#[derive(serde::Serialize)]
pub(crate) struct GitDiff {
    /// Combined unified-diff patch for the working set: tracked changes vs HEAD,
    /// followed by each untracked file rendered as a new-file diff. The frontend
    /// parses this into files/hunks for the peek viewer.
    patch: String,
    /// True when we stopped early because the patch hit the size/file cap — the
    /// viewer shows a "truncated" note so a partial diff can't read as complete.
    truncated: bool,
}

/// The full *uncommitted* diff behind the working-set card, for the peek viewer.
/// Tracked changes come from `diff HEAD`; untracked files are appended as new-file
/// diffs via `diff --no-index` against `/dev/null` — which, unlike `add -N`, never
/// touches the index (important while a live session may be staging/committing).
/// `core.quotepath=false` keeps non-ASCII paths literal; a size + file-count cap
/// stops a huge working tree from shipping a multi-MB payload into the webview.
#[tauri::command]
pub(crate) fn git_diff(workdir: String) -> Option<GitDiff> {
    const CAP: usize = 800_000; // ~0.8 MB of patch text — ample for a peek
    const MAX_UNTRACKED: usize = 300;

    let tracked = git_cmd(&workdir, &["-c", "core.quotepath=false", "--no-optional-locks", "diff", "HEAD"])
        .output()
        .ok()?;
    if !tracked.status.success() {
        return None; // not a repo, or an unborn HEAD (no commits)
    }
    let mut patch = String::from_utf8_lossy(&tracked.stdout).into_owned();
    let mut truncated = false;
    if patch.len() > CAP {
        patch.truncate(CAP);
        truncated = true;
    }

    // Untracked files, each as its own new-file diff. `--no-index` exits 1 whenever
    // the files differ (always, vs /dev/null), so we read stdout regardless of status.
    if !truncated {
        if let Ok(o) = git_cmd(&workdir, &["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]).output() {
            let listing = String::from_utf8_lossy(&o.stdout);
            let others: Vec<&str> = listing.split('\0').filter(|s| !s.is_empty()).collect();
            if others.len() > MAX_UNTRACKED {
                truncated = true;
            }
            for f in others.into_iter().take(MAX_UNTRACKED) {
                if patch.len() >= CAP {
                    truncated = true;
                    break;
                }
                if let Ok(d) = git_cmd(&workdir, &["-c", "core.quotepath=false", "diff", "--no-index", "--", "/dev/null", f]).output() {
                    patch.push_str(&String::from_utf8_lossy(&d.stdout));
                }
            }
            if patch.len() > CAP {
                patch.truncate(CAP);
                truncated = true;
            }
        }
    }
    Some(GitDiff { patch, truncated })
}

/// One commit, as the project graph panel draws it.
///
/// Deliberately flat, small and *underived*: a page of these crosses the IPC
/// boundary as JSON, so nothing is computed here that the frontend can compute
/// itself — the lane layout, the ref chips and the absolute date are all derived
/// in `graph.ts`, where they can be unit-tested without a repo.
#[derive(serde::Serialize)]
pub(crate) struct GraphCommit {
    /// Full sha. Not abbreviable: the parent links are matched on it, and an
    /// abbreviation is only unique within the repo's current object count.
    sha: String,
    /// Abbreviated sha for display, at git's own chosen length (`%h`).
    short: String,
    /// Parent shas, first parent first — empty for a root, 2+ for a merge. This is
    /// the only thing the graph's shape comes from.
    parents: Vec<String>,
    subject: String,
    author: String,
    /// Author date, epoch seconds — the panel's absolute timestamp.
    unix: i64,
    /// Committer date, relative ("3 days ago"), in git's own wording.
    rel: String,
    /// Raw decoration (`%D` in `--decorate=full` form): "HEAD -> refs/heads/main,
    /// refs/remotes/origin/main, tag: refs/tags/v1.0", empty when the commit carries
    /// no ref. Parsed into typed chips by the frontend (`parseRefs`), which needs the
    /// full paths — the short forms can't be told apart.
    refs: String,
}

/// One page of history.
///
/// `more` is what lets the panel offer "load more" without ever having counted the
/// repo's commits: we ask git for one commit *past* the page and report whether it
/// was there. A count would mean walking the whole history, which is precisely what
/// this command exists not to do.
#[derive(serde::Serialize)]
pub(crate) struct GraphPage {
    commits: Vec<GraphCommit>,
    more: bool,
}

/// A page of commit history for a project's graph panel.
///
/// **The panel must never read a whole history**, so this command can't either: it
/// is `git log --skip=<skip> -n <limit+1>` and nothing else. A big monorepo has
/// hundreds of thousands of commits; the panel opens on the first ~60 and asks for
/// the next page only when the user scrolls to the end of what it has. Everything
/// else in the design follows from that:
///
/// - **`--date-order`, not `--topo-order`.** Both keep a child ahead of its parents,
///   which is all the lane layout needs. But paging by recency means page 1 has to be
///   the genuinely most recent commits *across* refs, and topo-order will pull a stale
///   branch's whole chain forward to keep it contiguous — making the first page look
///   like history from a month ago.
/// - **`\x1e` records, NUL fields.** A subject may contain any printable character,
///   tabs included, so neither delimiter may be something that can appear inside a
///   field. (`git log -z` is not an option: it would collide with the NULs.)
/// - **`scope`** is `"head"` for the checked-out branch alone, anything else for every
///   ref (`--all`, which is refs/heads + refs/remotes + tags, never the stash). A graph
///   with one lane isn't a graph, so the panel defaults to all refs and offers "this
///   branch" as the narrowing.
///
/// Errs with git's own first line when the folder isn't a git repo. A repo with **no
/// commits yet** is an empty page rather than an error, because that is the truthful
/// answer and the panel can say it — note git itself disagrees with itself here:
/// `log --all` on an unborn HEAD exits 0 with no output (no refs matched), while a
/// bare `log` calls it fatal.
#[tauri::command(async)]
pub(crate) fn git_graph(workdir: String, skip: u32, limit: u32, scope: String) -> Result<GraphPage, String> {
    /// Ceiling on one page, whatever the caller asks for — a runaway `limit` would
    /// undo the entire point of the command.
    const MAX_PAGE: u32 = 400;

    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    let limit = limit.clamp(1, MAX_PAGE);
    let n = format!("-{}", limit as u64 + 1); // one past the page — see GraphPage::more
    let sk = format!("--skip={skip}");
    let mut args = vec![
        "--no-optional-locks", "log", "--date-order", "--no-color",
        // FULL ref paths in %D. Short ones can't be told apart — a local `feat/x` and a
        // remote `origin/x` are the same shape — so the chips would be guesses.
        "--decorate=full",
        sk.as_str(), n.as_str(),
        "--format=%x1e%H%x00%h%x00%P%x00%an%x00%at%x00%cr%x00%D%x00%s",
    ];
    if scope != "head" {
        args.push("--all");
    }
    // 20s is generous for a bounded log; the timeout exists because git_run's does,
    // and a repo mid-`gc` can block on the object store.
    let out = git_run(git_cmd(&workdir, &args), 20)?;
    if !out.status.success() {
        // "not a git repository", a bad `scope`, an unreadable object store — git's own
        // first line names which, so pass it through rather than inventing wording.
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().find(|l| !l.trim().is_empty()).unwrap_or("git log failed").to_string());
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut commits = Vec::new();
    // The split's first slice is the empty string ahead of the first record; each
    // record carries the newline git writes after it.
    for rec in text.split('\u{1e}').skip(1) {
        let mut f = rec.trim_matches('\n').split('\0');
        let sha = f.next().unwrap_or("").trim().to_string();
        if sha.is_empty() {
            continue;
        }
        // These field expressions are read in the order they are *written*, which must
        // stay the order of the format string above — not the struct's declaration order.
        commits.push(GraphCommit {
            sha,
            short: f.next().unwrap_or("").to_string(),
            parents: f.next().unwrap_or("").split_whitespace().map(str::to_string).collect(),
            author: f.next().unwrap_or("").to_string(),
            unix: f.next().unwrap_or("").trim().parse().unwrap_or(0),
            rel: f.next().unwrap_or("").to_string(),
            refs: f.next().unwrap_or("").to_string(),
            subject: f.next().unwrap_or("").to_string(),
        });
    }
    let more = commits.len() > limit as usize;
    commits.truncate(limit as usize);
    Ok(GraphPage { commits, more })
}

/// One commit's whole message (`%B` — subject and body), for the graph panel's commit
/// overlay.
///
/// **Deliberately not part of `git_graph`'s page.** Bodies were once a field on every
/// commit in the page, which meant a length cap so 60 of them wouldn't cross IPC as
/// half a megabyte of JSON — and that cap then truncated the one message somebody was
/// actually reading. Only ever one commit is open, so this fetches only that one, and
/// the cap can be high enough never to matter in practice.
///
/// `sha` must be a hex object name: it goes to git as a revision argument, and anything
/// else (a `--flag`, a `refname@{…}` expression) is refused rather than passed through.
#[tauri::command(async)]
pub(crate) fn git_commit_message(workdir: String, sha: String) -> Result<String, String> {
    /// ~200KB of one commit message. Reached only by a machine-generated commit; a marker
    /// is appended so a truncated message can never read as complete.
    const CAP: usize = 200_000;

    if sha.len() < 4 || sha.len() > 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("not an object name: {sha}"));
    }
    let out = git_run(git_cmd(&workdir, &["--no-optional-locks", "show", "-s", "--format=%B", &sha]), 15)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().find(|l| !l.trim().is_empty()).unwrap_or("git show failed").to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let msg = text.trim_end();
    if msg.len() > CAP {
        let cut = msg.char_indices().map(|(i, _)| i).take_while(|i| *i <= CAP).last().unwrap_or(0);
        return Ok(format!("{}\n\n[… message truncated at {CAP} characters]", &msg[..cut]));
    }
    Ok(msg.to_string())
}

#[derive(serde::Serialize, Debug)]
pub(crate) struct GitActionResult {
    ok: bool,
    /// One line for the toast.
    summary: String,
    /// Combined stdout+stderr, for the debug log.
    output: String,
    /// Set when the action can't be finished safely from a button. The UI offers to
    /// open a terminal prefilled with this, rather than leaving the user guessing.
    suggest: Option<String>,
}

/// Fetch / pull / push for a session's working directory — the "git fluff" a
/// cockpit needs so you don't drop to a shell for the routine half of git.
///
/// The design rule is that **no button may leave the working tree in a state the
/// UI can't explain**, because there is no conflict-resolution surface here. So:
/// pull is `--ff-only` (it can never conflict, never half-merge, and git itself
/// refuses when local edits would be clobbered), push never invents an upstream,
/// and the cases we can predict — a diverged branch, a missing upstream, a stale
/// branch that would be rejected — are refused *before* running git, with the
/// command the user should run instead. Committing deliberately isn't here: it
/// belongs to the session, not to a toolbar.
///
/// Every op is safe against a live Claude in the same worktree: fetch and push
/// don't touch the working tree at all, and ff-only pull won't overwrite edits.
#[tauri::command(async)]
pub(crate) fn git_action(workdir: String, op: String) -> Result<GitActionResult, String> {
    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    let branch = git_cmd(&workdir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    let refuse = |summary: &str, suggest: &str| {
        Ok(GitActionResult {
            ok: false,
            summary: summary.to_string(),
            output: String::new(),
            suggest: Some(suggest.to_string()),
        })
    };

    let (upstream, ahead, behind) = upstream_state(&workdir);
    let args: Vec<&str> = match op.as_str() {
        // Read-only and always safe — this is what makes ahead/behind trustworthy.
        "fetch" => vec!["fetch", "--prune"],
        "pull" => {
            let Some(branch) = branch.as_deref() else {
                return refuse("detached HEAD — nothing to pull into", "git switch -");
            };
            if upstream.is_none() {
                return refuse(
                    &format!("{branch} tracks no upstream"),
                    &format!("git branch --set-upstream-to=origin/{branch} {branch}"),
                );
            }
            // Diverged: ff-only would fail anyway. Refusing up front lets us say why
            // and hand over the rebase, instead of surfacing a raw git error.
            if ahead > 0 && behind > 0 {
                return refuse(
                    &format!("diverged — {ahead} ahead, {behind} behind"),
                    "git pull --rebase",
                );
            }
            if behind == 0 {
                return Ok(GitActionResult {
                    ok: true,
                    summary: "already up to date".into(),
                    output: String::new(),
                    suggest: None,
                });
            }
            vec!["pull", "--ff-only"]
        }
        "push" => {
            let Some(branch) = branch.as_deref() else {
                return refuse("detached HEAD — nothing to push", "git switch -");
            };
            // Never invent a remote branch from a button: the first push of a branch
            // is a publishing decision, so we hand it over instead.
            if upstream.is_none() {
                return refuse(
                    &format!("{branch} tracks no upstream"),
                    &format!("git push -u origin {branch}"),
                );
            }
            if behind > 0 {
                return refuse(
                    &format!("{behind} behind — push would be rejected"),
                    "git pull --ff-only && git push",
                );
            }
            if ahead == 0 {
                return Ok(GitActionResult {
                    ok: true,
                    summary: "nothing to push".into(),
                    output: String::new(),
                    suggest: None,
                });
            }
            vec!["push"]
        }
        _ => return Err(format!("unknown git op: {op}")),
    };

    let out = git_run(git_cmd(&workdir, &args), 45)?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let combined = [stdout, stderr].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");

    if out.status.success() {
        // Re-read after a fetch: the whole point of fetching is the new behind count.
        let summary = match op.as_str() {
            "fetch" => match upstream_state(&workdir).2 {
                0 => "fetched — up to date".into(),
                n => format!("fetched — {n} behind"),
            },
            "pull" => format!("pulled {behind} commit{}", if behind == 1 { "" } else { "s" }),
            _ => format!("pushed {ahead} commit{}", if ahead == 1 { "" } else { "s" }),
        };
        return Ok(GitActionResult { ok: true, summary, output: combined, suggest: None });
    }

    // git said no for a reason we didn't predict (local edits in the way, a hook
    // rejecting the push, a protected branch, a host key we've never seen). Show
    // its own first line — the truthful thing — and offer the same op in a shell.
    let first = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("git failed").to_string();
    Ok(GitActionResult {
        ok: false,
        summary: first,
        output: combined,
        suggest: Some(format!("git {}", args.join(" "))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::scratch_dir;
    use std::path::{Path, PathBuf};
    use std::process::Command;


    /// Where `create_worktree` puts this repo's checkouts: `<parent>/.cc-worktrees/<repo>`.
    ///
    /// Tests MUST clean up via this and never via `<parent>/.cc-worktrees` — `scratch_dir`
    /// hands every repo the same parent (the OS temp dir), so wiping the whole
    /// `.cc-worktrees` tree deletes the checkouts of every test running in parallel,
    /// which made these two flake against each other.
    fn wt_root(repo: &Path) -> PathBuf {
        repo.parent().unwrap()
            .join(".cc-worktrees")
            .join(repo.file_name().unwrap())
    }

    /// Run a git command in `dir`, asserting success. Identity/signing are passed via
    /// `-c` so the test doesn't depend on (or touch) the developer's global gitconfig.
    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").current_dir(dir).args(args).output().expect("failed to spawn git");
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn git_diff_reports_tracked_and_untracked_changes() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q"]);
        std::fs::write(dir.join("tracked.txt"), "line1\nline2\nline3\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

        // Working-tree changes: edit the tracked file, add an untracked one.
        std::fs::write(dir.join("tracked.txt"), "line1\nCHANGED\nline3\nline4\n").unwrap();
        std::fs::write(dir.join("new.txt"), "brand new\n").unwrap();

        let d = git_diff(dir.to_str().unwrap().to_string()).expect("git_diff returned None for a real repo");
        assert!(!d.truncated);
        // Tracked modification, diffed against HEAD.
        assert!(d.patch.contains("diff --git a/tracked.txt b/tracked.txt"), "missing tracked diff:\n{}", d.patch);
        assert!(d.patch.contains("+CHANGED") && d.patch.contains("-line2"));
        // Untracked file rendered as a new-file diff.
        assert!(d.patch.contains("diff --git a/new.txt b/new.txt"), "missing untracked diff:\n{}", d.patch);
        assert!(d.patch.contains("new file mode") && d.patch.contains("+brand new"));

        // Crucially, surfacing the untracked file must NOT have staged it — `--no-index`
        // leaves the index untouched, which is why we use it over `git add -N`.
        let st = Command::new("git").current_dir(&dir).args(["status", "--porcelain"]).output().unwrap();
        let st = String::from_utf8_lossy(&st.stdout);
        assert!(st.contains("?? new.txt"), "new.txt should still be untracked, got:\n{st}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_diff_returns_none_outside_a_repo() {
        let dir = scratch_dir();
        assert!(git_diff(dir.to_str().unwrap().to_string()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Commit in `dir`, identity and signing passed via `-c` for the same reason
    /// `git()` takes none from the environment: the developer's global gitconfig must
    /// neither be needed nor touched.
    fn commit(dir: &Path, msg: &str) {
        git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
    }

    /// The inspector's working-set strip ("+2 −1 · 1 file · 1 new") and the ahead/
    /// behind pair beside it. Two things it must not do: count an untracked file's
    /// lines as insertions (they're a separate, differently-worded number), and
    /// measure the gap against anything other than the tracking ref.
    #[test]
    fn git_diffstat_counts_the_working_set_and_the_upstream_gap() {
        let dir = scratch_dir();
        let remote = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);

        // An unborn HEAD has nothing to diff against — None, not a row of zeros that
        // would read as "clean".
        assert!(git_diffstat(path.clone()).is_none(), "no commits yet");

        std::fs::write(dir.join("a.txt"), "1\n2\n3\n").unwrap();
        git(&dir, &["add", "-A"]);
        commit(&dir, "init");

        let d = git_diffstat(path.clone()).expect("a repo with a commit has a diffstat");
        assert_eq!((d.added, d.removed, d.files, d.untracked, d.dirty), (0, 0, 0, 0, 0));
        assert_eq!(d.upstream, None, "a branch with no remote must not be given one");
        assert_eq!(upstream_state(&path), (None, 0, 0));

        std::fs::write(dir.join("a.txt"), "1\nCHANGED\n3\n4\n").unwrap();
        std::fs::write(dir.join("new.txt"), "brand new\n").unwrap();
        let d = git_diffstat(path.clone()).unwrap();
        assert_eq!((d.added, d.removed, d.files), (2, 1, 1), "numstat covers tracked files only");
        assert_eq!((d.untracked, d.dirty), (1, 2), "the new file is counted, not diffed");

        git(&remote, &["init", "-q", "--bare", "-b", "main"]);
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&dir, &["push", "-q", "-u", "origin", "main"]);
        commit(&dir, "ahead by one");
        let d = git_diffstat(path.clone()).unwrap();
        assert_eq!(d.upstream.as_deref(), Some("origin/main"));
        assert_eq!((d.ahead, d.behind), (1, 0), "measured against origin/main");
        // The working set is orthogonal to the upstream gap and must survive it.
        assert_eq!((d.added, d.removed, d.untracked), (2, 1, 1));

        // Detached HEAD tracks nothing — it must not inherit the branch it left.
        git(&dir, &["checkout", "-q", "--detach"]);
        assert_eq!(upstream_state(&path), (None, 0, 0));

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote);
    }

    /// The git buttons predict, *before* running git, everything git would reject
    /// anyway — and hand over the command that does work instead of surfacing a raw
    /// error. That prediction is the whole value of the feature.
    #[test]
    fn git_action_refuses_what_git_would_reject() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);
        commit(&dir, "base");

        // No upstream: pull says how to set one; push hands over the publishing
        // decision rather than inventing a remote branch from a button.
        let r = git_action(path.clone(), "pull".into()).unwrap();
        assert!(!r.ok && r.summary.contains("tracks no upstream"), "{}", r.summary);
        assert_eq!(r.suggest.as_deref(), Some("git branch --set-upstream-to=origin/main main"));
        let r = git_action(path.clone(), "push".into()).unwrap();
        assert!(!r.ok && r.summary.contains("tracks no upstream"), "{}", r.summary);
        assert_eq!(r.suggest.as_deref(), Some("git push -u origin main"));

        // Detached HEAD: no branch to pull into or push from.
        git(&dir, &["checkout", "-q", "--detach"]);
        for op in ["pull", "push"] {
            let r = git_action(path.clone(), op.into()).unwrap();
            assert!(!r.ok && r.summary.starts_with("detached HEAD"), "{op}: {}", r.summary);
            assert_eq!(r.suggest.as_deref(), Some("git switch -"));
        }

        // A refusal is a result the UI can show. An Err is reserved for a call that
        // makes no sense at all — those two must not be confused.
        assert!(git_action(path.clone(), "commit".into()).is_err(), "committing isn't a toolbar op");
        assert!(git_action(format!("{path}/gone"), "fetch".into()).is_err(), "missing workdir");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The same three ops against a real bare remote: fetch is always safe and
    /// re-reads the gap it just closed, pull only fast-forwards, push only runs when
    /// it can't be rejected — and a diverged branch is refused with a rebase handoff.
    #[test]
    fn git_action_fetches_pulls_and_pushes_against_a_real_remote() {
        let dir = scratch_dir();
        let other = scratch_dir();
        let remote = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&remote, &["init", "-q", "--bare", "-b", "main"]);
        git(&dir, &["init", "-q", "-b", "main"]);
        commit(&dir, "base");
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&dir, &["push", "-q", "-u", "origin", "main"]);

        // In sync: every op is a no-op, and says so instead of running git.
        let r = git_action(path.clone(), "fetch".into()).unwrap();
        assert!(r.ok && r.summary == "fetched — up to date", "{}", r.summary);
        let r = git_action(path.clone(), "pull".into()).unwrap();
        assert!(r.ok && r.summary == "already up to date", "{}", r.summary);
        let r = git_action(path.clone(), "push".into()).unwrap();
        assert!(r.ok && r.summary == "nothing to push", "{}", r.summary);

        commit(&dir, "mine");
        let r = git_action(path.clone(), "push".into()).unwrap();
        assert!(r.ok && r.summary == "pushed 1 commit", "{}", r.summary);
        assert_eq!(upstream_state(&path), (Some("origin/main".to_string()), 0, 0));

        // Someone else pushes. Fetch re-reads afterwards — reporting the gap it just
        // learned about is the entire point of the button — and pull fast-forwards it.
        git(&other, &["clone", "-q", remote.to_str().unwrap(), "."]);
        commit(&other, "theirs");
        git(&other, &["push", "-q", "origin", "main"]);
        let r = git_action(path.clone(), "fetch".into()).unwrap();
        assert!(r.ok && r.summary == "fetched — 1 behind", "{}", r.summary);
        let r = git_action(path.clone(), "pull".into()).unwrap();
        assert!(r.ok && r.summary == "pulled 1 commit", "{}", r.summary);

        // Diverged: ff-only would fail and the push would be rejected, so neither is
        // attempted — the user gets the command that actually resolves it.
        commit(&dir, "local");
        commit(&other, "theirs 2");
        git(&other, &["push", "-q", "origin", "main"]);
        git(&dir, &["fetch", "-q", "origin"]);
        let r = git_action(path.clone(), "pull".into()).unwrap();
        assert!(!r.ok && r.summary.starts_with("diverged"), "{}", r.summary);
        assert_eq!(r.suggest.as_deref(), Some("git pull --rebase"));
        let r = git_action(path.clone(), "push".into()).unwrap();
        assert!(!r.ok && r.summary.contains("push would be rejected"), "{}", r.summary);
        assert_eq!(r.suggest.as_deref(), Some("git pull --ff-only && git push"));

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
        let _ = std::fs::remove_dir_all(&remote);
    }

    /// The graph panel's contract with git, and the reason the command exists: it
    /// pages. `more` must be an observation (one commit past the page was there), the
    /// page must actually stop at `limit`, and `skip` must land on the next commit —
    /// because the alternative is reading a monorepo's whole history to draw 60 rows.
    #[test]
    fn git_graph_pages_history_instead_of_reading_all_of_it() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);

        // Not a repo is an Err (the panel says so). A repo with no commits is an empty
        // page — the truthful answer, and the one thing git is inconsistent about:
        // `log --all` exits 0 on an unborn HEAD, a bare `log` calls it fatal.
        assert!(git_graph(format!("{path}/gone"), 0, 10, "all".into()).is_err(), "missing dir");
        let empty = git_graph(path.clone(), 0, 10, "all".into()).expect("unborn HEAD is an empty page");
        assert!(empty.commits.is_empty() && !empty.more);
        assert!(git_graph(path.clone(), 0, 10, "head".into()).is_err(), "git calls a bare log fatal here");

        for i in 1..=5 {
            commit(&dir, &format!("c{i}"));
        }

        let p = git_graph(path.clone(), 0, 2, "all".into()).unwrap();
        assert_eq!(p.commits.len(), 2, "a page is `limit` commits, not limit+1");
        assert!(p.more, "3 commits are still behind this page");
        assert_eq!(p.commits[0].subject, "c5", "newest first");
        assert_eq!(p.commits[1].subject, "c4");

        // The next page starts exactly where the last one stopped.
        let p2 = git_graph(path.clone(), 2, 2, "all".into()).unwrap();
        assert_eq!(p2.commits[0].subject, "c3");
        assert!(p2.more);

        // The last page reports there is nothing behind it, so the panel can stop
        // offering to load more.
        let last = git_graph(path.clone(), 4, 2, "all".into()).unwrap();
        assert_eq!(last.commits.len(), 1);
        assert!(!last.more, "c1 is the root — nothing behind it");
        assert!(last.commits[0].parents.is_empty(), "a root commit has no parents");

        // Past the end: an empty page, not an error.
        let past = git_graph(path.clone(), 99, 2, "all".into()).unwrap();
        assert!(past.commits.is_empty() && !past.more);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The two fields the drawing is made of — `parents` (the graph's whole shape)
    /// and `refs` (the chips) — plus the delimiter choice: a subject containing a tab
    /// must survive, which is why records are \x1e-separated and fields NUL-separated
    /// rather than the tab-separated format the branch list can afford.
    #[test]
    fn git_graph_carries_merge_parents_refs_and_awkward_subjects() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);
        commit(&dir, "base");
        git(&dir, &["checkout", "-q", "-b", "side"]);
        commit(&dir, "side\twork with\ttabs");
        git(&dir, &["checkout", "-q", "main"]);
        commit(&dir, "main work");
        git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false",
                    "merge", "-q", "--no-ff", "-m", "merge side", "side"]);
        git(&dir, &["tag", "v1"]);

        let p = git_graph(path.clone(), 0, 10, "all".into()).unwrap();
        let merge = &p.commits[0];
        assert_eq!(merge.subject, "merge side");
        assert_eq!(merge.parents.len(), 2, "a merge is the only thing that forks a lane");
        // Full paths, not the short forms the frontend can't classify.
        assert!(merge.refs.contains("HEAD -> refs/heads/main"), "{}", merge.refs);
        assert!(merge.refs.contains("tag: refs/tags/v1"), "{}", merge.refs);
        assert_eq!(merge.author, "T");
        assert!(merge.unix > 0 && !merge.rel.is_empty());
        assert_eq!(merge.short, merge.sha[..merge.short.len()], "%h abbreviates %H");

        // Every parent of a loaded commit is either loaded too or past the frontier —
        // the layout matches on full shas, so an abbreviation here would break lanes.
        let tabbed = p.commits.iter().find(|c| c.subject.contains('\t')).expect("tab subject survived");
        assert_eq!(tabbed.subject, "side\twork with\ttabs");

        // The page carries no bodies at all — see git_commit_message, and the test below.
        let p2 = git_graph(path.clone(), 0, 5, "all".into()).unwrap();
        assert!(!p2.commits.is_empty());
        assert!(merge.parents.iter().all(|sha| sha.len() == merge.sha.len()));

        // `scope: "head"` is the narrowing: side's commit is not on main's first-parent
        // history... it IS reachable through the merge, so use a repo state where the
        // difference shows — an unmerged branch.
        git(&dir, &["checkout", "-q", "-b", "unmerged"]);
        commit(&dir, "only on unmerged");
        git(&dir, &["checkout", "-q", "main"]);
        let all = git_graph(path.clone(), 0, 20, "all".into()).unwrap();
        let head = git_graph(path.clone(), 0, 20, "head".into()).unwrap();
        assert!(all.commits.iter().any(|c| c.subject == "only on unmerged"), "--all sees every ref");
        assert!(!head.commits.iter().any(|c| c.subject == "only on unmerged"), "head scope is the checkout alone");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The overlay's message, fetched one commit at a time. The multi-line body is the
    /// whole point: it is why this is a separate command rather than a field on every
    /// commit in a page, where it had to be length-capped and duly truncated the one
    /// message a reader had opened.
    #[test]
    fn git_commit_message_returns_the_whole_thing_for_one_commit() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);
        let long = "para one, which is long enough to have mattered under the old cap.\n\n\
                    - a bullet\n- another bullet\n\nCo-Authored-By: T <t@example.com>";
        git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false",
                    "commit", "-q", "--allow-empty", "-m", "subject line", "-m", long]);
        let head = git_cmd(&path, &["rev-parse", "HEAD"]).output().unwrap();
        let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();

        let msg = git_commit_message(path.clone(), sha.clone()).unwrap();
        assert!(msg.starts_with("subject line\n\n"), "subject then body:\n{msg}");
        assert!(msg.contains("- a bullet\n- another bullet"), "structure survives:\n{msg}");
        assert!(msg.ends_with("Co-Authored-By: T <t@example.com>"), "trailing newlines trimmed:\n{msg}");
        // An abbreviation is a valid object name too.
        assert_eq!(git_commit_message(path.clone(), sha[..8].to_string()).unwrap(), msg);

        // Not an object name: refused here rather than handed to git as a revision
        // argument, where a leading dash would be read as an option.
        for bad in ["--help", "HEAD", "main@{0}", "", "zzzz"] {
            assert!(git_commit_message(path.clone(), bad.to_string()).is_err(), "{bad} should be refused");
        }
        // Well-formed but unknown: git's own error, not a panic or an empty string.
        assert!(git_commit_message(path.clone(), "0".repeat(40)).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The picker leans on these flags to decide what's pickable: it hides `current`
    /// (the "start here" button) and `checked_out` (git refuses a second checkout, so
    /// those sit in the existing-worktrees list instead). ahead/behind must be
    /// The picker's branch context: which branches are claimed, and how each stands
    /// against ITS OWN upstream — not against whatever HEAD happens to be.
    #[test]
    fn git_branch_list_flags_state_and_tracks_each_upstream() {
        let dir = scratch_dir();
        let remote = scratch_dir();
        git(&remote, &["init", "-q", "--bare", "-b", "dev"]);
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&dir, &["push", "-q", "-u", "origin", "dev"]);

        // pushed-then-moved: tracks origin/pushed, 2 commits unpushed.
        git(&dir, &["checkout", "-q", "-b", "pushed"]);
        git(&dir, &["push", "-q", "-u", "origin", "pushed"]);
        commit(&dir, "p1");
        commit(&dir, "p2");

        // local-only: never pushed, so no upstream at all.
        git(&dir, &["checkout", "-q", "-b", "local-only"]);
        commit(&dir, "l1");

        // orphaned: had an upstream, which was then deleted on the remote.
        git(&dir, &["checkout", "-q", "-b", "orphaned"]);
        git(&dir, &["push", "-q", "-u", "origin", "orphaned"]);
        git(&dir, &["push", "-q", "origin", "--delete", "orphaned"]);
        git(&dir, &["fetch", "-q", "--prune", "origin"]);

        git(&dir, &["checkout", "-q", "dev"]);
        git(&dir, &["branch", "claimed"]);
        let wt = dir.join("wt-claimed");
        git(&dir, &["worktree", "add", "-q", wt.to_str().unwrap(), "claimed"]);

        let bs = git_branch_list(dir.to_str().unwrap().to_string());
        let by = |n: &str| bs.iter().find(|b| b.name == n).unwrap_or_else(|| panic!("{n} missing from {bs:?}"));

        // dev is `current`; it's also `checked_out` because the main working tree holds
        // it — the frontend hides it via `current`, so that overlap is harmless.
        assert!(by("dev").current, "dev should be current: {bs:?}");
        assert!(by("claimed").checked_out && !by("claimed").current, "claimed should be checked_out: {bs:?}");
        assert!(!by("pushed").current && !by("pushed").checked_out, "pushed should be free: {bs:?}");

        // Ahead is measured against origin/pushed, NOT against dev — dev has moved on
        // its own and that must not leak into this branch's numbers.
        let p = by("pushed");
        assert_eq!(p.upstream, "origin/pushed", "pushed should track its own remote: {bs:?}");
        assert_eq!((p.ahead, p.behind), (2, 0), "pushed should be 2 unpushed / 0 unpulled: {bs:?}");
        assert!(!p.gone);

        let l = by("local-only");
        assert!(l.upstream.is_empty() && !l.gone, "local-only has no upstream: {bs:?}");
        assert_eq!((l.ahead, l.behind), (0, 0), "no upstream means no counts: {bs:?}");

        let o = by("orphaned");
        assert!(o.gone, "orphaned's upstream was deleted: {bs:?}");
        assert_eq!(o.upstream, "origin/orphaned", "a gone upstream is still named: {bs:?}");

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote);
    }
    /// Without a start-point, `worktree add -b` cuts from HEAD — which makes whatever
    /// the root folder is parked on the silent parent of every new branch. Pin the
    /// escape hatch down.
    #[test]
    fn create_worktree_branches_from_the_given_base() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        let commit = |msg: &str| git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit("on main");
        let repo = dir.to_str().unwrap().to_string();
        let main_tip = String::from_utf8_lossy(
            &Command::new("git").current_dir(&dir).args(["rev-parse", "HEAD"]).output().unwrap().stdout
        ).trim().to_string();

        // Park the root on a feature branch that has moved past main.
        git(&dir, &["checkout", "-q", "-b", "parked"]);
        commit("only on parked");

        // No base → inherits HEAD, i.e. `parked`. This is the trap.
        let inherit = create_worktree(repo.clone(), "from-head".into(), None).expect("default base");
        let p = String::from_utf8_lossy(
            &Command::new("git").current_dir(&inherit).args(["rev-parse", "HEAD"]).output().unwrap().stdout
        ).trim().to_string();
        assert_ne!(p, main_tip, "with no base the new branch cuts from the parked HEAD");

        // Explicit base → main's tip, regardless of where the root is parked.
        let based = create_worktree(repo.clone(), "from-main".into(), Some("main".into())).expect("explicit base");
        let b = String::from_utf8_lossy(
            &Command::new("git").current_dir(&based).args(["rev-parse", "HEAD"]).output().unwrap().stdout
        ).trim().to_string();
        assert_eq!(b, main_tip, "an explicit base wins over HEAD");

        // A base that doesn't resolve is refused before git can emit anything cryptic.
        let e = create_worktree(repo, "from-nowhere".into(), Some("no-such-ref".into())).expect_err("bad base refused");
        assert!(e.contains("no such commit"), "the message should name the problem: {e}");

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Branch deletion mirrors worktree removal: safe-delete only, force handed off.
    #[test]
    fn delete_branch_safe_deletes_merged_and_refuses_the_rest() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        let repo = dir.to_str().unwrap().to_string();

        // merged: branched and never advanced, so its commits are all in dev.
        git(&dir, &["branch", "merged-b"]);
        // unmerged: has a commit dev doesn't.
        git(&dir, &["checkout", "-q", "-b", "unmerged-b"]);
        commit(&dir, "only-here");
        git(&dir, &["checkout", "-q", "dev"]);
        // held: claimed by a worktree.
        git(&dir, &["branch", "held-b"]);
        let wt = dir.join("wt-held");
        git(&dir, &["worktree", "add", "-q", wt.to_str().unwrap(), "held-b"]);

        let r = delete_branch(repo.clone(), "merged-b".into()).expect("merged deletes");
        assert!(r.ok && r.suggest.is_none(), "a merged branch should just go: {r:?}");
        let b = Command::new("git").current_dir(&dir).args(["branch", "--list", "merged-b"]).output().unwrap();
        assert!(String::from_utf8_lossy(&b.stdout).trim().is_empty(), "merged-b should be gone");

        // Unmerged: refused, branch survives, `-D` offered rather than run.
        let r = delete_branch(repo.clone(), "unmerged-b".into()).expect("call returns");
        assert!(!r.ok, "an unmerged branch must be refused: {r:?}");
        assert!(r.suggest.as_deref().unwrap_or("").contains("branch -D"), "force should be handed off: {r:?}");
        let b = Command::new("git").current_dir(&dir).args(["branch", "--list", "unmerged-b"]).output().unwrap();
        assert!(!String::from_utf8_lossy(&b.stdout).trim().is_empty(), "unmerged-b must survive");

        // Checked out somewhere: refused up front, in our words.
        let e = delete_branch(repo, "held-b".into()).expect_err("a checked-out branch is refused");
        assert!(e.contains("checked out"), "the message should name the reason: {e}");

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The label says "New branch" but the field has always taken existing ones —
    /// that's the whole point of the picker, so pin the attach path down.
    #[test]
    fn create_worktree_attaches_an_existing_branch() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
        git(&dir, &["branch", "test"]);

        let path = create_worktree(dir.to_str().unwrap().to_string(), "test".into(), None).expect("attach failed");
        let head = Command::new("git").current_dir(&path).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "test");

        // The repo it was created from must be undisturbed — this is a second
        // checkout, not a branch switch.
        let orig = Command::new("git").current_dir(&dir).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&orig.stdout).trim(), "dev");

        // Worktrees land in a *sibling* .cc-worktrees tree, never inside the repo.
        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The cleanup path: `list_worktrees` must flag which linked worktrees are safe
    /// to remove (merged, clean), and `remove_worktree_impl` must never force —
    /// safe-deleting a merged branch, keeping an unmerged one, and refusing a dirty
    /// tree with a `--force` handoff instead of clobbering it.
    #[test]
    fn worktree_cleanup_flags_and_safe_removal() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        let repo = dir.to_str().unwrap().to_string();

        // Three linked worktrees: one at dev's tip (merged, clean), one advanced past
        // dev (unmerged), and one with an untracked file (dirty).
        let merged = create_worktree(repo.clone(), "merged-wt".into(), None).expect("merged worktree");
        let ahead = create_worktree(repo.clone(), "ahead-wt".into(), None).expect("ahead worktree");
        commit(Path::new(&ahead), "extra");
        let dirty = create_worktree(repo.clone(), "dirty-wt".into(), None).expect("dirty worktree");
        std::fs::write(Path::new(&dirty).join("scratch.txt"), "wip\n").unwrap();

        let wts = list_worktrees(repo.clone());
        let by = |b: &str| wts.iter().find(|w| w.branch == b).unwrap_or_else(|| panic!("{b} missing from {wts:?}"));
        assert!(by("merged-wt").merged && !by("merged-wt").dirty, "merged-wt should be merged+clean: {wts:?}");
        assert!(!by("ahead-wt").merged && !by("ahead-wt").dirty, "ahead-wt should be unmerged+clean: {wts:?}");
        assert!(by("dirty-wt").dirty, "dirty-wt should be dirty: {wts:?}");
        let main_path = wts.iter().find(|w| w.is_main).expect("a main worktree").path.clone();

        // The main worktree can never be removed.
        assert!(remove_worktree_impl(&repo, &main_path, "dev", false).is_err(), "main worktree must be refused");

        // Merged + delete_branch: worktree gone, branch safe-deleted.
        let r = remove_worktree_impl(&repo, &merged, "merged-wt", true).expect("remove merged");
        assert!(r.ok, "merged removal should succeed: {r:?}");
        assert!(!Path::new(&merged).exists(), "merged worktree dir should be gone");
        let b = Command::new("git").current_dir(&dir).args(["branch", "--list", "merged-wt"]).output().unwrap();
        assert!(String::from_utf8_lossy(&b.stdout).trim().is_empty(), "merged branch should be deleted");

        // Unmerged + delete_branch: worktree gone, branch KEPT with a force handoff.
        let r = remove_worktree_impl(&repo, &ahead, "ahead-wt", true).expect("remove ahead");
        assert!(r.ok && r.suggest.as_deref().unwrap_or("").contains("branch -D"), "unmerged branch delete should be handed off: {r:?}");
        let b = Command::new("git").current_dir(&dir).args(["branch", "--list", "ahead-wt"]).output().unwrap();
        assert!(!String::from_utf8_lossy(&b.stdout).trim().is_empty(), "unmerged branch should be kept");

        // Dirty, no force: refused, tree untouched, force handoff offered.
        let r = remove_worktree_impl(&repo, &dirty, "dirty-wt", false).expect("call returns");
        assert!(!r.ok && r.suggest.as_deref().unwrap_or("").contains("--force"), "dirty removal should be refused with a force handoff: {r:?}");
        assert!(Path::new(&dirty).exists(), "dirty worktree must not be clobbered");

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The two states the new-session dialog needs but `git worktree remove` handles
    /// badly on its own: a LOCKED worktree (git refuses it even with `--force`, so
    /// suggesting force would just fail again) and a worktree whose folder was deleted
    /// by hand (nothing to remove — `prune` is what git actually wants).
    #[test]
    fn worktree_locked_and_missing_are_reported_and_handled() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false",
                    "commit", "-q", "--allow-empty", "-m", "base"]);
        let repo = dir.to_str().unwrap().to_string();

        let locked = create_worktree(repo.clone(), "locked-wt".into(), None).expect("locked worktree");
        let gone = create_worktree(repo.clone(), "gone-wt".into(), None).expect("gone worktree");
        git(&dir, &["worktree", "lock", &locked]);
        std::fs::remove_dir_all(&gone).expect("hand-delete the checkout");

        let wts = list_worktrees(repo.clone());
        let by = |b: &str| wts.iter().find(|w| w.branch == b).unwrap_or_else(|| panic!("{b} missing from {wts:?}"));
        assert!(by("locked-wt").locked, "locked-wt should report locked: {wts:?}");
        assert!(by("locked-wt").exists, "locked-wt is still on disk: {wts:?}");
        assert!(!by("gone-wt").exists, "gone-wt's folder was deleted: {wts:?}");
        assert!(!wts.iter().any(|w| w.is_main && w.locked), "the main worktree is never locked");

        // Locked: refused with an unlock handoff, NOT a --force one that would also fail.
        let r = remove_worktree_impl(&repo, &locked, "locked-wt", false).expect("call returns");
        let suggest = r.suggest.as_deref().unwrap_or("");
        assert!(!r.ok, "a locked worktree must be refused: {r:?}");
        assert!(suggest.contains("worktree unlock") && !suggest.contains("--force"),
            "locked handoff should unlock, not force: {r:?}");
        assert!(Path::new(&locked).exists(), "locked worktree must survive the refusal");

        // Hand-deleted folder: pruned, and it leaves the listing.
        let r = remove_worktree_impl(&repo, &gone, "gone-wt", false).expect("call returns");
        assert!(r.ok, "a vanished worktree should prune cleanly: {r:?}");
        assert!(!list_worktrees(repo.clone()).iter().any(|w| w.branch == "gone-wt"),
            "gone-wt should be pruned out of the listing");

        git(&dir, &["worktree", "unlock", &locked]);
        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The detail pane's HEAD line. Parsing is NUL-separated so a subject containing
    /// spaces (or anything else printable) survives the round trip.
    #[test]
    fn git_commit_info_reads_the_tip_of_a_dir_or_a_ref() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |msg: &str| git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=Ada L",
                                             "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit("base subject with spaces");
        let repo = dir.to_str().unwrap().to_string();

        let head = git_commit_info(repo.clone(), String::new()).expect("HEAD resolves");
        assert_eq!(head.subject, "base subject with spaces", "the whole subject survives");
        assert_eq!(head.author, "Ada L");
        assert!(!head.short.is_empty() && !head.rel.is_empty(), "sha and relative date are filled: {head:?}",
            head = (&head.short, &head.rel));

        // A named ref resolves independently of what HEAD points at.
        git(&dir, &["branch", "side"]);
        commit("moved dev on");
        let side = git_commit_info(repo.clone(), "side".into()).expect("side resolves");
        assert_eq!(side.subject, "base subject with spaces", "side still points at the first commit");
        assert_ne!(git_commit_info(repo.clone(), String::new()).unwrap().short, side.short,
            "HEAD has moved past side");

        assert!(git_commit_info(repo, "no-such-ref".into()).is_none(), "an unknown ref yields None");
        let _ = std::fs::remove_dir_all(&dir);
    }

}
