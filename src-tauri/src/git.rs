//! Everything Episko asks git: worktrees, branches, the working-set diff, fetch/pull/push.
//! Never parse localized git output (every call pins LC_ALL=C; branch on exit codes or a
//! probe), and never destroy a checkout a live session is using (docs/worktrees.md).


use std::collections::HashMap;
use std::sync::Mutex;

use tauri::State;

use crate::platform::{
    augmented_path, kill_pid_tree, norm_path, path_holders, physical_cwd, remove_tree, sys_command,
    PathHolder,
};
use crate::AppState;

/// Create a worktree on a new or existing branch off `repo_dir`, under the sibling
/// `.cc-worktrees/<repo>/<branch>` folder. Returns the absolute worktree path.
#[tauri::command(async)]
pub(crate) fn create_worktree(repo_dir: String, branch: String, base: Option<String>) -> Result<String, String> {
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

    let branch_exists = git(&["-C", &root, "rev-parse", "--verify", "--quiet", &format!("refs/heads/{safe}")])
        .map(|o| o.status.success())
        .unwrap_or(false);

    // `base` only applies when creating: without a start-point `worktree add -b` cuts
    // from the root's HEAD, so whatever the root is parked on parents every new branch.
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

    // A remote-tracking start-point must be tracked outright: git's autoSetupMerge DWIM
    // is a default a user can turn off, and an untracked branch has no ahead/behind.
    let track = !branch_exists
        && base.as_deref().is_some_and(|b| {
            git(&["-C", &root, "rev-parse", "--verify", "--quiet", &format!("refs/remotes/{b}")])
                .map(|o| o.status.success())
                .unwrap_or(false)
        });

    let add = if branch_exists {
        git(&["-C", &root, "worktree", "add", &wt_str, &safe])
    } else if let Some(b) = base.as_deref() {
        let mut args = vec!["-C", &root, "worktree", "add"];
        if track {
            args.push("--track");
        }
        args.extend_from_slice(&["-b", &safe, &wt_str, b]);
        git(&args)
    } else {
        git(&["-C", &root, "worktree", "add", "-b", &safe, &wt_str])
    }.map_err(|e| e.to_string())?;
    if add.status.success() {
        return Ok(wt_str);
    }

    // The dir may already exist from an earlier run on this branch; hand it back.
    if wt_path.is_dir() {
        if let Ok(o) = git(&["-C", &wt_str, "rev-parse", "--abbrev-ref", "HEAD"]) {
            if o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == safe {
                return Ok(wt_str);
            }
        }
    }
    Err(String::from_utf8_lossy(&add.stderr).trim().to_string())
}

/// One checkout as seen by `worktree_heads`: only what can be answered from files.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct WorktreeHead {
    path: String,   // physical spelling, as `repo_root_of` uses
    branch: String, // "(detached)" when HEAD holds a raw sha
    is_main: bool,
    exists: bool,   // a hand-deleted folder stays registered until pruned, like `Worktree::exists`
}

/// Read a `HEAD` file into a branch label without spawning git.
/// `ref: refs/heads/foo` → "foo"; a bare sha → "(detached)".
fn head_branch(head_file: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(head_file).ok()?;
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    Some(match t.strip_prefix("ref:") {
        Some(r) => r.trim().strip_prefix("refs/heads/").unwrap_or(r.trim()).to_string(),
        None => "(detached)".to_string(),
    })
}

/// Every checkout of `dir`'s repo and its HEAD branch, read off `.git/` with no git
/// process, so the sidebar can poll it; `list_worktrees` is the expensive picker half.
/// The path comes from each `gitdir` file (the bookkeeping name need not match the
/// folder) and goes through `physical_cwd`, or one checkout renders as two roots.
#[tauri::command(async)]
pub(crate) fn worktree_heads(dir: String) -> Vec<WorktreeHead> {
    let Some(root) = repo_root_of(&dir) else {
        return vec![];
    };
    let common = std::path::Path::new(&root).join(".git");
    let mut out: Vec<WorktreeHead> = Vec::new();
    if let Some(branch) = head_branch(&common.join("HEAD")) {
        out.push(WorktreeHead {
            path: root.clone(),
            branch,
            is_main: true,
            exists: std::path::Path::new(&root).is_dir(),
        });
    }
    let Ok(entries) = std::fs::read_dir(common.join("worktrees")) else {
        return out; // a repo with no linked worktrees has no such dir
    };
    for e in entries.flatten() {
        let bk = e.path();
        // `gitdir` points at the checkout's `.git` file; its parent is the checkout.
        let Ok(gd) = std::fs::read_to_string(bk.join("gitdir")) else { continue };
        let Some(checkout) = std::path::Path::new(gd.trim()).parent() else { continue };
        let Some(branch) = head_branch(&bk.join("HEAD")) else { continue };
        let exists = checkout.is_dir();
        out.push(WorktreeHead {
            path: norm_path(&physical_cwd(&checkout.to_string_lossy())),
            branch,
            is_main: false,
            exists,
        });
    }
    // Stable order so the caller's change comparison isn't fooled by readdir order.
    out.sort_by(|a, b| (!a.is_main, &a.path).cmp(&(!b.is_main, &b.path)));
    out
}

#[derive(serde::Serialize, Debug)]
pub(crate) struct Worktree {
    path: String,
    branch: String,
    is_main: bool,
    dirty: bool,  // uncommitted or untracked changes; not one-click removable. Always false for main
    merged: bool, // fully merged into the main worktree's branch, so removal loses nothing
    locked: bool, // `git worktree lock`; git refuses removal even with --force. Always false for main
    exists: bool, // a hand-deleted folder stays in .git/worktrees until pruned; never launch into it
}

/// Worktrees from `git worktree list --porcelain`, main first, linked ones enriched
/// with `dirty`/`merged` so the picker can tell which are safe to clean up.
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

    // Cleanliness cues, best-effort: a hiccup leaves the flag false, which only makes the UI more cautious.
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
                // `--is-ancestor A B` exits 0 when A is an ancestor of B.
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

/// Same location, tolerant of symlinks and trailing slashes; falls back to comparing
/// normalized spellings when either side is gone (a removed worktree is exactly that).
fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => norm_path(a) == norm_path(b),
    }
}

/// Remove a linked worktree, optionally safe-deleting its branch. Never runs `--force`
/// or `-D`: on refusal the exact command is handed back for a terminal. Refuses the
/// main worktree and any worktree with a live embedded session in it.
#[tauri::command(async)]
pub(crate) fn remove_worktree(
    state: State<AppState>,
    repo_dir: String,
    path: String,
    branch: String,
    delete_branch: bool,
) -> Result<GitActionResult, String> {
    let label = if branch.is_empty() { "worktree" } else { &branch };
    if state.sessions.lock().unwrap().values().any(|s| same_path(&s.workdir, &path)) {
        return Err(format!("a session is still running in {label} — close it first"));
    }
    remove_worktree_impl(&repo_dir, &path, &branch, delete_branch)
}

/// The git side of `remove_worktree`, free of app state so it is testable on a temp repo.
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
    // Locked: git refuses even with --force, so name the real next step (unlock).
    if listed.iter().any(|w| w.locked && same_path(&w.path, path)) {
        return Ok(GitActionResult {
            ok: false,
            summary: format!("{label} is locked — unlock it first"),
            output: String::new(),
            suggest: Some(format!("git worktree unlock \"{path}\" && git worktree remove \"{path}\"")),
            ..Default::default()
        });
    }

    let out = git_run(git_cmd(repo_dir, &["worktree", "remove", path]), 30)?;
    if !out.status.success() {
        // A non-zero exit does NOT mean nothing happened: git deletes the folder first and
        // unregisters second, and carries on past a failed delete (Windows: a held folder),
        // leaving the worktree unregistered. Offering --force then fails with "not a working
        // tree", so ask git whether it is still registered (docs/worktrees.md).
        if !still_registered(repo_dir, path) {
            return finish_removal(repo_dir, path, branch, delete_branch, &label);
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
            ..Default::default()
        });
    }

    finish_removal(repo_dir, path, branch, delete_branch, &label)
}

/// After a worktree has left git's records, by a clean exit or a partial one: delete the
/// folder if it is still there, then optionally safe-delete the branch.
fn finish_removal(
    repo_dir: &str,
    path: &str,
    branch: &str,
    delete_branch: bool,
    label: &str,
) -> Result<GitActionResult, String> {
    let stranded = ensure_folder_gone(path);

    // Best-effort drop of the now-empty `.cc-worktrees/<repo>/` parent; `remove_dir` only
    // succeeds when empty, which is the whole guard against a user's own parent folder.
    if stranded.is_none() {
        if let Some(parent) = std::path::Path::new(path).parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }

    let mut res = if delete_branch && !branch.is_empty() && branch != "(detached)" {
        // Safe-delete only; an unmerged branch is refused and -D handed back.
        let del = git_run(git_cmd(repo_dir, &["branch", "-d", branch]), 15)?;
        if del.status.success() {
            GitActionResult { ok: true, summary: format!("Removed worktree and branch {branch}"), ..Default::default() }
        } else {
            GitActionResult {
                ok: true,
                summary: format!("Removed worktree — kept branch {branch} (not fully merged)"),
                output: String::from_utf8_lossy(&del.stderr).trim().to_string(),
                suggest: Some(format!("git branch -D \"{branch}\"")),
                ..Default::default()
            }
        }
    } else {
        GitActionResult { ok: true, summary: format!("Removed worktree {label}"), ..Default::default() }
    };

    if let Some(s) = stranded {
        // `ok` stays true: the worktree IS removed and the roster changed. The leftover
        // directory is a separate problem, carried in its own field with its own repair.
        res.summary = format!("Removed {label} — its folder is still on disk");
        res.suggest = None;
        res.stranded = Some(s);
    }
    Ok(res)
}

/// Is `path` still one of `repo_dir`'s worktrees? A fresh listing, since git may have
/// changed it. Unknown (a failed listing) counts as still registered.
fn still_registered(repo_dir: &str, path: &str) -> bool {
    let Ok(out) = git_run(git_cmd(repo_dir, &["worktree", "list", "--porcelain"]), 15) else {
        return true;
    };
    if !out.status.success() {
        return true;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .any(|p| same_path(&norm_path(p), path))
}

/// What is left of a removed worktree when its directory would not delete.
#[derive(serde::Serialize, Debug, Default)]
pub(crate) struct Stranded {
    path: String,   // the checkout directory still on disk
    stuck: String,  // the first path inside it that refused; what the holder probe ran against
    reason: String, // the OS's own reason, for the debug log
    holders: Vec<PathHolder>,
}

/// Delete the checkout directory, and if it won't go, say who is keeping it. Retried
/// briefly first: the commonest holder is a process killed moments ago whose handles
/// outlive the signal by milliseconds. Bounded, since past a second it is somebody's editor.
fn ensure_folder_gone(path: &str) -> Option<Stranded> {
    let p = std::path::Path::new(path);
    let mut last = None;
    for wait in [90u64, 200, 400] {
        match remove_tree(p) {
            Ok(()) => return None,
            Err(e) => last = Some(e),
        }
        std::thread::sleep(std::time::Duration::from_millis(wait));
    }
    // One final attempt after the last backoff, so the longest wait is not wasted.
    if remove_tree(p).is_ok() {
        return None;
    }
    let (stuck, err) = last?;
    let stuck = norm_path(&stuck.to_string_lossy());
    Some(Stranded {
        path: norm_path(path),
        holders: path_holders(path, Some(&stuck)),
        reason: err.to_string(),
        stuck,
    })
}

/// The outcome of a purge attempt, with a refreshed picture of what still holds the folder.
#[derive(serde::Serialize, Debug, Default)]
pub(crate) struct PurgeResult {
    gone: bool,
    stranded: Option<Stranded>,
}

/// Second half of a stranded removal: kill the processes named in `kill`, then retry.
/// The holders are re-probed first and only a pid still holding this folder is touched
/// (pids are reused); the path must be at least two levels deep, so a bug deletes nothing.
#[tauri::command(async)]
pub(crate) fn purge_worktree_folder(path: String, kill: Vec<u32>) -> Result<PurgeResult, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(PurgeResult { gone: true, stranded: None });
    }
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    if p.parent().and_then(|x| x.parent()).is_none() {
        return Err(format!("refusing to purge a top-level path: {path}"));
    }
    let Some(s) = ensure_folder_gone(&path) else {
        return Ok(PurgeResult { gone: true, stranded: None });
    };
    let us = std::process::id();
    let killed = s
        .holders
        .iter()
        .filter(|h| h.pid != us && kill.contains(&h.pid))
        .filter(|h| kill_pid_tree(h.pid))
        .count();
    if killed == 0 {
        return Ok(PurgeResult { gone: false, stranded: Some(s) });
    }
    log::info!("purge {path} · killed {killed} holder(s)");
    // A tree kill is only a signal; the retry inside covers the handles closing.
    let after = ensure_folder_gone(&path);
    Ok(PurgeResult { gone: after.is_none(), stranded: after })
}

/// The tip commit the new-session dialog's detail pane shows for the highlighted row.
#[derive(serde::Serialize)]
pub(crate) struct CommitInfo {
    short: String,   // %h
    subject: String, // %s
    author: String,  // %an
    rel: String,     // %cr, relative ("2 hours ago")
}

/// Tip commit of `rev` (HEAD when empty) as seen from `dir`. Fetched for the highlighted
/// row only, never the whole list; NUL-separated so any printable subject parses.
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

/// Whether a live pane of this `Session::kind` alone forbids switching its folder's branch.
/// Only a `task` does: a shell is the user's own prompt, and a claude pane's phase lives
/// in the frontend (`midFlight` in src/types.ts decides the mid-turn half).
fn blocks_switch(kind: &str) -> bool {
    kind == "task"
}

/// The `git switch` invocation for a target and the terminal handoff for it, as one
/// decision so the two cannot disagree. `track` is `Some(remote_ref)` for a remote-only target.
fn switch_args<'a>(branch: &'a str, track: Option<&'a str>) -> (Vec<&'a str>, String) {
    match track {
        // --track outright: git's DWIM only applies while checkout.guess/autoSetupMerge are default.
        Some(b) => (
            vec!["switch", "--track", "-c", branch, b],
            format!("git switch --track -c \"{branch}\" \"{b}\""),
        ),
        None => (vec!["switch", branch], format!("git switch \"{branch}\"")),
    }
}

/// Move the repo's main working tree to another branch. Refused while a task pane runs
/// in the root (`blocks_switch`), when the target is checked out elsewhere, and on a dirty
/// tree (a switch would silently carry the changes; handed to a terminal instead). `base`
/// is the remote-tracking ref a remote-only target is cut from, as in `create_worktree`.
#[tauri::command(async)]
pub(crate) fn switch_branch(
    state: State<AppState>,
    repo_dir: String,
    branch: String,
    base: Option<String>,
) -> Result<GitActionResult, String> {
    if branch.trim().is_empty() {
        return Err("no branch given".into());
    }
    let blocked = state
        .sessions
        .lock()
        .unwrap()
        .values()
        .filter(|s| same_path(&s.workdir, &repo_dir) && blocks_switch(s.kind))
        .count();
    if blocked > 0 {
        return Err(format!(
            "{blocked} task{} running in this folder — a run that changes branch mid-flight has verified nothing",
            if blocked == 1 { " is" } else { "s are" }
        ));
    }
    if list_worktrees(repo_dir.clone()).iter()
        .any(|w| !same_path(&w.path, &repo_dir) && w.branch == branch)
    {
        return Err(format!("{branch} is already checked out in another worktree"));
    }

    // Tracked only when the branch has no local ref yet, which is what makes `base` safe to
    // pass unconditionally: a ref that appeared since the list was read is switched to, not -c'd.
    let ref_exists = |r: String| {
        git_run(git_cmd(&repo_dir, &["rev-parse", "--verify", "--quiet", &r]), 10)
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    let track = if ref_exists(format!("refs/heads/{branch}")) {
        None
    } else {
        base.as_deref().filter(|b| ref_exists(format!("refs/remotes/{b}")))
    };
    let (args, suggest) = switch_args(&branch, track);

    let status = git_run(git_cmd(&repo_dir, &["--no-optional-locks", "status", "--porcelain"]), 20)?;
    if status.status.success() && !status.stdout.is_empty() {
        return Ok(GitActionResult {
            ok: false,
            summary: "uncommitted changes — switching would carry them across".into(),
            output: String::new(),
            suggest: Some(suggest.clone()),
            ..Default::default()
        });
    }

    let out = git_run(git_cmd(&repo_dir, &args), 30)?;
    if out.status.success() {
        return Ok(GitActionResult {
            ok: true,
            summary: match track {
                Some(b) => format!("Switched to {branch}, tracking {b}"),
                None => format!("Switched to {branch}"),
            },
            ..Default::default()
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
        suggest: Some(suggest),
        ..Default::default()
    })
}

/// Delete a local branch. As with `remove_worktree`, `-D` is never run from a click: `git
/// branch -d` refuses anything not fully merged (including a squash-merged PR, whose commits
/// never became ancestors) and the exact `-D` command is handed back instead.
#[tauri::command(async)]
pub(crate) fn delete_branch(repo_dir: String, branch: String) -> Result<GitActionResult, String> {
    if branch.trim().is_empty() {
        return Err("no branch given".into());
    }
    // Say it in our own words and name the fix, rather than surfacing git's refusal.
    if list_worktrees(repo_dir.clone()).iter().any(|w| w.branch == branch) {
        return Err(format!("{branch} is checked out — remove its worktree first"));
    }

    let out = git_run(git_cmd(&repo_dir, &["branch", "-d", &branch]), 15)?;
    if out.status.success() {
        return Ok(GitActionResult {
            ok: true,
            summary: format!("Deleted branch {branch}"),
            ..Default::default()
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
        ..Default::default()
    })
}

/// Most branches the picker lists and, to match, the most a sweep will act on.
const BRANCH_LIST_CAP: usize = 80;

/// One branch the picker asks the sweep to delete. `gone` is a claim git re-checks here
/// (the list may be a minute old); `force` is evidence only the caller has (a squash-merged
/// PR read from `gh`) and is honoured per branch, never as a blanket setting.
#[derive(serde::Deserialize, Debug)]
pub(crate) struct SweepPick {
    branch: String,
    #[serde(default)]
    gone: bool,  // the caller saw the upstream as deleted; re-derived here before acting
    #[serde(default)]
    force: bool, // escalate to `git branch -D` if the safe delete refuses
}

/// One branch the sweep deleted. `sha` is git's own "(was 1a2b3c4)", so a forced delete
/// can be undone with `git branch <name> <sha>`.
#[derive(serde::Serialize, Debug)]
pub(crate) struct DeletedBranch {
    branch: String,
    sha: String,
    forced: bool, // took -D after the safe delete refused
}

/// One branch the sweep kept and why. `forceable` says a `-D` would answer the refusal
/// ("not fully merged"); a worktree holding it is refused with or without a force.
#[derive(serde::Serialize, Debug)]
pub(crate) struct KeptBranch {
    branch: String,
    reason: String,
    forceable: bool,
}

/// What one sweep did; `deleted` and `kept` together account for every name passed.
#[derive(serde::Serialize, Debug)]
pub(crate) struct SweepResult {
    deleted: Vec<DeletedBranch>,
    kept: Vec<KeptBranch>,
    suggest: Option<String>, // one `git branch -D` over the forceable refusals, for a terminal
    summary: String,         // one line for the toast
}

/// Delete a batch of local branches, the picker's broom. `git branch -d` decides and what
/// it refuses comes back as a `-D` command; the one exception is a per-branch `force`
/// (see `SweepPick`). A held branch or a `gone` claim git disagrees with lands in `kept`.
#[tauri::command(async)]
pub(crate) fn sweep_branches(repo_dir: String, picks: Vec<SweepPick>) -> Result<SweepResult, String> {
    let mut want: Vec<SweepPick> = Vec::new();
    for p in picks {
        let branch = p.branch.trim().to_string();
        if !branch.is_empty() && !want.iter().any(|q| q.branch == branch) {
            want.push(SweepPick { branch, ..p });
        }
    }
    if want.is_empty() {
        return Err("no branches given".into());
    }
    want.truncate(BRANCH_LIST_CAP);   // the picker's own list can't be longer; a caller's might

    // The same read `git_branch_list` derives `gone` from. Gated on refs/remotes: a LOCAL
    // upstream (autoSetupMerge) going away is a different rule than the button offers.
    let out = git_run(git_cmd(&repo_dir, &[
        "for-each-ref",
        "--format=%(refname:short)\t%(upstream)\t%(upstream:track,nobracket)",
        "refs/heads",
    ]), 15)?;
    if !out.status.success() {
        return Err(format!("git: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let gone: std::collections::HashSet<&str> = text
        .lines()
        .filter_map(|l| {
            let mut p = l.split('\t');
            let name = p.next().filter(|n| !n.is_empty())?;
            let upstream = p.next().unwrap_or("");
            let track = p.next().unwrap_or("").trim();
            (upstream.starts_with("refs/remotes/") && track == "gone").then_some(name)
        })
        .collect();

    // Same guard as `delete_branch`, via one porcelain listing rather than a status per checkout.
    let taken: std::collections::HashSet<String> =
        match git_run(git_cmd(&repo_dir, &["worktree", "list", "--porcelain"]), 15) {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.strip_prefix("branch "))
                .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string())
                .collect(),
            // Unreadable means assume nothing is held; git's own refusal still lands in `kept`.
            _ => Default::default(),
        };

    // "Deleted branch foo (was 1a2b3c4)." is git's own (LC_ALL=C) line; an unparseable
    // line just means no recovery hint.
    let was_sha = |s: &str| -> String {
        s.split_once("(was ")
            .and_then(|(_, rest)| rest.split_once(')'))
            .map(|(sha, _)| sha.trim().to_string())
            .unwrap_or_default()
    };

    let mut deleted: Vec<DeletedBranch> = Vec::new();
    let mut kept: Vec<KeptBranch> = Vec::new();
    for p in want {
        let b = p.branch;
        if p.gone && !gone.contains(b.as_str()) {
            kept.push(KeptBranch { branch: b, reason: "not gone any more — it has a remote branch again".into(), forceable: false });
            continue;
        }
        if taken.contains(&b) {
            kept.push(KeptBranch { branch: b, reason: "checked out in a worktree".into(), forceable: false });
            continue;
        }
        // A spawn failure or timeout stops this branch, never the sweep.
        let run = |flag: &str| git_run(git_cmd(&repo_dir, &["branch", flag, &b]), 15);
        let out = match run("-d") {
            Ok(o) => o,
            Err(e) => { kept.push(KeptBranch { branch: b, reason: e, forceable: false }); continue; }
        };
        if out.status.success() {
            let sha = was_sha(&String::from_utf8_lossy(&out.stdout));
            deleted.push(DeletedBranch { branch: b, sha, forced: false });
            continue;
        }
        if p.force {
            match run("-D") {
                Ok(o) if o.status.success() => {
                    let sha = was_sha(&String::from_utf8_lossy(&o.stdout));
                    deleted.push(DeletedBranch { branch: b, sha, forced: true });
                    continue;
                }
                // Report the SAFE delete's refusal: -D failing after -d means something structural.
                _ => {}
            }
        }
        let combined = [
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
        let first = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("git refused").to_string();
        kept.push(KeptBranch { branch: b, reason: first, forceable: true });
    }

    let force: Vec<String> = kept.iter().filter(|k| k.forceable).map(|k| format!("\"{}\"", k.branch)).collect();
    let plural = |n: usize| if n == 1 { "" } else { "es" };
    let summary = match (deleted.len(), kept.len()) {
        (0, k) => format!("Deleted nothing — kept {k} branch{}", plural(k)),
        (n, 0) => format!("Deleted {n} branch{}", plural(n)),
        (n, k) => format!("Deleted {n} branch{}, kept {k}", plural(n)),
    };
    Ok(SweepResult {
        deleted,
        kept,
        suggest: (!force.is_empty()).then(|| format!("git branch -D {}", force.join(" "))),
        summary,
    })
}

/// One branch for the worktree picker. `current` is the repo's HEAD branch, `checked_out`
/// means a worktree holds it (git refuses a second checkout). `ahead`/`behind` are versus
/// this branch's OWN upstream, never versus HEAD: "is my work pushed, has the remote moved".
#[derive(serde::Serialize, Debug)]
pub(crate) struct BranchInfo {
    name: String,
    current: bool,
    checked_out: bool,
    upstream: String, // the remote-tracking ref it follows ("origin/foo"); empty when purely local
    ahead: u32,       // unpushed commits; 0 without an upstream
    behind: u32,      // unpulled commits; 0 without an upstream
    gone: bool,       // an upstream is configured but gone from the remote; `upstream` still names it
    /// Every commit is an ancestor of the trunk, the measure `Worktree.merged` uses. A
    /// squash-merged branch is false here; the deep-clean pane's PR lookup fills that gap.
    merged: bool,
    /// A remote-tracking ref with no local branch of that name: `name` is the branch a checkout
    /// would create and `upstream` the ref it would track; `current`/`checked_out`/`gone` are
    /// false, and `ahead`/`behind` are versus the remote's default branch (`base`).
    remote: bool,
    /// What a REMOTE row's `ahead`/`behind` were measured against ("origin/main"). Empty on a
    /// local row, and on a row whose remote has no known default (its counts are then unmeasured).
    base: String,
    author: String, // the tip commit's author, which is what GitHub's branches view shows
    sha: String,    // the tip when read; a remote delete is refused if it moved (`RemotePick`)
    rel: String,
    unix: i64,
}

/// One remote branch the picker asks to delete, with the sha it was showing: a `push
/// --delete` is a shared-state write, so a ref that moved since is refused, not deleted.
#[derive(serde::Deserialize, Debug)]
pub(crate) struct RemotePick {
    branch: String,
    sha: String,
}

/// Delete branches on a remote, the one write here that changes state for other people.
/// The remote's default branch is refused unconditionally, a ref that moved since the
/// caller read it (or vanished) is refused, there is no force and no fallback, and every
/// delete comes back with its sha (`git push <remote> <sha>:refs/heads/<branch>` restores it).
#[tauri::command(async)]
pub(crate) fn delete_remote_branches(repo_dir: String, remote: String, picks: Vec<RemotePick>) -> Result<SweepResult, String> {
    let remote = remote.trim().to_string();
    if remote.is_empty() {
        return Err("no remote given".into());
    }
    let mut want: Vec<RemotePick> = Vec::new();
    for p in picks {
        let branch = p.branch.trim().to_string();
        if !branch.is_empty() && !want.iter().any(|q| q.branch == branch) {
            want.push(RemotePick { branch, sha: p.sha.trim().to_string() });
        }
    }
    if want.is_empty() {
        return Err("no branches given".into());
    }
    want.truncate(BRANCH_LIST_CAP);

    // "origin/main" → "main"; refused here rather than filtered in the UI.
    let default = remote_default(&repo_dir, &remote)
        .and_then(|d| d.strip_prefix(&format!("{remote}/")).map(str::to_string));

    let mut deleted: Vec<DeletedBranch> = Vec::new();
    let mut kept: Vec<KeptBranch> = Vec::new();
    let mut go: Vec<(String, String)> = Vec::new();   // (branch, sha as it stands now)
    for p in want {
        if default.as_deref() == Some(p.branch.as_str()) {
            kept.push(KeptBranch { branch: p.branch, reason: format!("it is {remote}'s default branch"), forceable: false });
            continue;
        }
        let full = format!("refs/remotes/{remote}/{}", p.branch);
        let now = git_run(git_cmd(&repo_dir, &["rev-parse", "--verify", "--quiet", &full]), 15)
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        match now {
            None => kept.push(KeptBranch { branch: p.branch, reason: format!("not on {remote} any more — someone deleted it already"), forceable: false }),
            Some(sha) if !p.sha.is_empty() && sha != p.sha =>
                kept.push(KeptBranch { branch: p.branch, reason: "it moved since this list was read — someone pushed to it".into(), forceable: false }),
            Some(sha) => go.push((p.branch, sha)),
        }
    }
    if go.is_empty() {
        return Ok(finish_remote_sweep(deleted, kept, &remote));
    }

    // One push for the whole batch (each delete is a round trip). A failed batch names no
    // culprit, so a small one is retried per branch; a large one reports git's message
    // against every branch rather than spending eighty round trips to phrase it per row.
    const ATTRIBUTE_MAX: usize = 12;
    let mut args: Vec<&str> = vec!["push", &remote, "--delete"];
    for (b, _) in &go {
        args.push(b);
    }
    let batch = git_run(git_cmd(&repo_dir, &args), 90);
    let ok = matches!(&batch, Ok(o) if o.status.success());
    if ok {
        for (branch, sha) in go {
            deleted.push(DeletedBranch { branch, sha, forced: false });
        }
        return Ok(finish_remote_sweep(deleted, kept, &remote));
    }
    let why = match &batch {
        Ok(o) => first_line(o),
        Err(e) => e.clone(),
    };
    if go.len() > ATTRIBUTE_MAX {
        for (branch, _) in go {
            kept.push(KeptBranch { branch, reason: why.clone(), forceable: false });
        }
        return Ok(finish_remote_sweep(deleted, kept, &remote));
    }
    for (branch, sha) in go {
        match git_run(git_cmd(&repo_dir, &["push", &remote, "--delete", &branch]), 90) {
            Ok(o) if o.status.success() => deleted.push(DeletedBranch { branch, sha, forced: false }),
            Ok(o) => kept.push(KeptBranch { branch, reason: first_line(&o), forceable: false }),
            Err(e) => kept.push(KeptBranch { branch, reason: e, forceable: false }),
        }
    }
    Ok(finish_remote_sweep(deleted, kept, &remote))
}

/// git's first meaningful line from either stream: `push` refuses on stderr, "up-to-date" on stdout.
fn first_line(o: &std::process::Output) -> String {
    let combined = [
        String::from_utf8_lossy(&o.stdout).trim().to_string(),
        String::from_utf8_lossy(&o.stderr).trim().to_string(),
    ].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
    combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("git push refused").to_string()
}

fn finish_remote_sweep(deleted: Vec<DeletedBranch>, kept: Vec<KeptBranch>, remote: &str) -> SweepResult {
    let plural = |n: usize| if n == 1 { "" } else { "es" };
    let summary = match (deleted.len(), kept.len()) {
        (0, k) => format!("Deleted nothing on {remote} — kept {k} branch{}", plural(k)),
        (n, 0) => format!("Deleted {n} branch{} on {remote}", plural(n)),
        (n, k) => format!("Deleted {n} branch{} on {remote}, kept {k}", plural(n)),
    };
    // No -D handoff: a remote refusal (protected branch, no permission) has no flag that fixes it.
    SweepResult { deleted, kept, suggest: None, summary }
}

/// Branches for the worktree picker, most-recently-committed first (see `BranchInfo`).
/// Nothing is filtered here; the frontend hides `current`/`checked_out`. Locals come out
/// of one `for-each-ref` (`%(upstream:track)` does the ahead/behind); a second pass adds
/// remote-only rows, capped separately, so a colleague's branch is a destination too.
#[tauri::command(async)]
pub(crate) fn git_branch_list(repo_dir: String, base: Option<String>) -> Vec<BranchInfo> {
    // LC_ALL=C also pins `%(upstream:track)` to English "ahead"/"behind".
    let git = |args: &[&str]| sys_command("git").env("LC_ALL", "C").args(args).output();

    // The trunk everything is measured against: the caller's `base` if git resolves it, else
    // the primary remote's default. One choice for remote ahead/behind AND local `merged`.
    let asked = base.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    let trunk = asked
        .filter(|b| {
            git(&["-C", &repo_dir, "rev-parse", "--verify", "--quiet", &format!("{b}^{{commit}}")])
                .is_ok_and(|o| o.status.success())
        })
        .or_else(|| {
            let remotes: Vec<String> = match git(&["-C", &repo_dir, "remote"]) {
                Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                    .lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect(),
                _ => Vec::new(),
            };
            (!remotes.is_empty()).then(|| remote_default(&repo_dir, primary_remote(&remotes))).flatten()
        });

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

    // One `--merged` listing rather than an --is-ancestor per branch. Falls back to the
    // checked-out branch with no trunk, and to nothing when HEAD is detached too.
    let merged_base = trunk.clone().or_else(|| current.clone());
    let merged: std::collections::HashSet<String> = match &merged_base {
        Some(c) => match git(&["-C", &repo_dir, "branch", "--format=%(refname:short)", "--merged", c]) {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect(),
            _ => Default::default(),
        },
        None => Default::default(),
    };

    // Tab-separated: neither a branch name nor a relative date ("3 days ago") holds a tab.
    let out = match git(&[
        "-C", &repo_dir,
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)\t%(committerdate:unix)\t%(committerdate:relative)\t%(upstream)\t%(upstream:short)\t%(upstream:track,nobracket)\t%(authorname)\t%(objectname)",
        "refs/heads",
    ]) {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };
    let text = String::from_utf8_lossy(&out.stdout);

    // Uncapped: the remote pass asks "is there a local branch called this?", and a capped
    // `res` would resurrect a checked-out branch as a remote-only row in big repos.
    let local_names: std::collections::HashSet<&str> = text
        .lines()
        .filter_map(|l| l.split('\t').next())
        .filter(|n| !n.is_empty())
        .collect();

    let mut res = Vec::new();
    for line in text.lines().take(BRANCH_LIST_CAP) {
        let mut parts = line.split('\t');
        let name = match parts.next() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let unix = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let rel = parts.next().unwrap_or("").to_string();
        // Only a refs/remotes/* upstream counts: autoSetupMerge can make a LOCAL branch the
        // upstream, and "2 commits not pushed to dev" is nonsense.
        let is_remote = parts.next().unwrap_or("").trim().starts_with("refs/remotes/");
        let upstream = if is_remote { parts.next().unwrap_or("").trim().to_string() } else { parts.next(); String::new() };
        // "" in sync or absent, "gone" when deleted, else "ahead 2", "behind 3" or "ahead 2, behind 3".
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
        let author = parts.next().unwrap_or("").trim().to_string();
        let sha = parts.next().unwrap_or("").trim().to_string();

        res.push(BranchInfo {
            checked_out: taken.contains(&name),
            current: current.as_deref() == Some(name.as_str()),
            // Contained in the trunk but never "safe to delete": the checked-out branch, and
            // the trunk itself (a local `main` is contained in `origin/main`).
            merged: merged.contains(&name)
                && current.as_deref() != Some(name.as_str())
                && !merged_base.as_deref().is_some_and(|b| b == name || b.ends_with(&format!("/{name}"))),
            remote: false,
            // What `merged` was decided against; a local row's ahead/behind is still vs its own upstream.
            base: merged_base.clone().unwrap_or_default(),
            name, upstream, ahead, behind, gone, rel, unix, author, sha,
        });
    }

    // ---- remote-only branches ------------------------------------------------------
    // Remote names are read, not assumed: "origin/feature/x" has to be split back into remote + branch.
    let remotes: Vec<String> = match git(&["-C", &repo_dir, "remote"]) {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    if remotes.is_empty() {
        return res;
    }
    // A remote-only row is measured against the trunk (its remote's default branch, what
    // GitHub shows). ONE base: rows from another remote are left uncompared.
    let primary = primary_remote(&remotes);
    let base = trunk;
    let rfmt = |with_base: Option<&str>| match with_base {
        Some(b) => format!("--format=%(refname:short)\t%(committerdate:unix)\t%(committerdate:relative)\t%(authorname)\t%(objectname)\t%(ahead-behind:{b})"),
        None => "--format=%(refname:short)\t%(committerdate:unix)\t%(committerdate:relative)\t%(authorname)\t%(objectname)".to_string(),
    };
    // `%(ahead-behind:)` is git 2.41+, and an older git fails the WHOLE listing on it, so
    // the retry without it is what keeps remote rows on a Debian-stable git.
    let mut rout = match git(&["-C", &repo_dir, "for-each-ref", "--sort=-committerdate", &rfmt(base.as_deref()), "refs/remotes"]) {
        Ok(o) if o.status.success() => Some(o),
        _ => None,
    };
    let mut have_ab = base.is_some();
    if rout.is_none() {
        have_ab = false;
        rout = match git(&["-C", &repo_dir, "for-each-ref", "--sort=-committerdate", &rfmt(None), "refs/remotes"]) {
            Ok(o) if o.status.success() => Some(o),
            _ => None,
        };
    }
    let rout = match rout {
        Some(o) => o,
        None => return res,
    };
    let rtext = String::from_utf8_lossy(&rout.stdout);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in rtext.lines() {
        if seen.len() >= BRANCH_LIST_CAP {
            break;
        }
        let mut parts = line.split('\t');
        let short = match parts.next() {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        // Longest matching prefix: a remote `a` may sit beside `a/b`. An empty remainder drops
        // `refs/remotes/<remote>/HEAD`, which git shortens to a bare `origin` rather than
        // `origin/HEAD`; the `local == "HEAD"` test covers a git that spells it out.
        let local = match remotes
            .iter()
            .filter_map(|r| short.strip_prefix(r.as_str()).and_then(|s| s.strip_prefix('/')))
            .filter(|s| !s.is_empty())
            .min_by_key(|s| s.len())
        {
            Some(l) => l,
            None => continue,
        };
        // A name that exists locally is not remote-only; two remotes with one branch is one destination.
        if local == "HEAD" || local_names.contains(local) || !seen.insert(local.to_string()) {
            continue;
        }
        let unix = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let rel = parts.next().unwrap_or("").to_string();
        let author = parts.next().unwrap_or("").trim().to_string();
        let sha = parts.next().unwrap_or("").trim().to_string();
        // "<ahead> <behind>" relative to `base`. Only the primary remote's refs are comparable;
        // other remotes keep zeros and `base: ""` tells the UI not to draw a comparison.
        let ab = parts.next().unwrap_or("").trim();
        let mine = have_ab && short.strip_prefix(primary).is_some_and(|s| s.starts_with('/'));
        let (ahead, behind) = if mine {
            let mut n = ab.split_whitespace().filter_map(|v| v.parse::<u32>().ok());
            (n.next().unwrap_or(0), n.next().unwrap_or(0))
        } else { (0, 0) };
        res.push(BranchInfo {
            name: local.to_string(),
            current: false,
            checked_out: false,
            upstream: short.to_string(),
            ahead,
            behind,
            gone: false,
            // The basis on which a remote branch may be offered for deletion; no base offers nothing.
            merged: mine && ahead == 0 && base.is_some(),
            remote: true,
            base: if mine { base.clone().unwrap_or_default() } else { String::new() },
            rel,
            unix,
            author,
            sha,
        });
    }
    res
}

/// The remote a cleanup pushes to: `origin` when present, else the first configured.
fn primary_remote(remotes: &[String]) -> &str {
    remotes.iter().find(|r| *r == "origin").unwrap_or(&remotes[0])
}

/// A remote's default branch as a short ref ("origin/main"). `refs/remotes/<remote>/HEAD`
/// only exists after a clone or `remote set-head`, so main/master are probed as fallbacks;
/// never guesses further, since a wrong default makes every branch look (un)merged.
fn remote_default(repo_dir: &str, remote: &str) -> Option<String> {
    let git = |args: &[&str]| sys_command("git").env("LC_ALL", "C").args(args).output();
    if let Ok(o) = git(&["-C", repo_dir, "symbolic-ref", "--quiet", "--short", &format!("refs/remotes/{remote}/HEAD")]) {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    ["main", "master"].into_iter().find_map(|c| {
        let short = format!("{remote}/{c}");
        git(&["-C", repo_dir, "rev-parse", "--verify", "--quiet", &format!("refs/remotes/{short}")])
            .ok()
            .filter(|o| o.status.success())
            .map(|_| short)
    })
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

#[derive(serde::Serialize, Debug)]
pub(crate) struct HeadInfo {
    branch: Option<String>, // None when HEAD is detached
    short: String,          // short sha of HEAD, labels a detached checkout
}

/// The per-worktree git dir (where `HEAD` lives) and the common dir (`refs/`, `packed-refs`),
/// without spawning git; they differ only for a linked worktree. Mirrors `repo_root_of`'s
/// walk, including stopping at a `.git` file whose target is gone.
fn git_dirs(cwd: &str) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let phys = physical_cwd(cwd);
    let mut dir: Option<&std::path::Path> = Some(std::path::Path::new(&phys));
    while let Some(d) = dir {
        let dot = d.join(".git");
        match std::fs::metadata(&dot) {
            Ok(m) if m.is_dir() => return Some((dot.clone(), dot)),
            Ok(_) => {
                let link = std::fs::read_to_string(&dot).ok()?;
                let target = link.trim().strip_prefix("gitdir:")?.trim();
                let abs = d.join(target);
                if !abs.exists() {
                    return None;
                }
                let flat = abs.to_string_lossy().replace('\\', "/");
                // …/<repo>/.git/worktrees/<name> → common is …/<repo>/.git
                let common = match flat.rfind("/.git/worktrees/") {
                    Some(i) => std::path::PathBuf::from(format!("{}/.git", &flat[..i])),
                    // A submodule's `…/.git/modules/<name>` is its own everything.
                    None => abs.clone(),
                };
                return Some((abs, common));
            }
            Err(_) => dir = d.parent(),
        }
    }
    None
}

/// A ref name (`refs/heads/main`) to its full sha, loose file first then `packed-refs`.
/// `None` means no such ref, which for HEAD's target is the unborn-branch case.
fn resolve_ref(common: &std::path::Path, name: &str) -> Option<String> {
    let sha = |s: &str| {
        let t = s.trim();
        // A symbolic loose ref is vanishingly rare; decline rather than guess.
        (t.len() >= 40 && t.chars().all(|c| c.is_ascii_hexdigit())).then(|| t.to_string())
    };
    if let Ok(t) = std::fs::read_to_string(common.join(name)) {
        if let Some(s) = sha(&t) {
            return Some(s);
        }
    }
    let packed = std::fs::read_to_string(common.join("packed-refs")).ok()?;
    packed.lines().find_map(|l| {
        let l = l.trim();
        if l.starts_with('#') || l.starts_with('^') {
            return None;
        }
        let (s, r) = l.split_once(' ')?;
        (r.trim() == name).then(|| sha(s)).flatten()
    })
}

/// Live HEAD of a working directory, read off the filesystem with no git process: this
/// is on the 4s branch poll, once per open session. `None` for anything that is not a
/// repo with at least one commit; `projmenu.ts` relies on that to drop *Commit graph…*
/// for a fresh `git init`, which is why a missing ref is "no repo" rather than "detached".
#[tauri::command(async)]
pub(crate) fn git_head(workdir: String) -> Option<HeadInfo> {
    let (gitdir, common) = git_dirs(&workdir)?;
    let text = std::fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let t = text.trim();
    let (branch, full) = match t.strip_prefix("ref:") {
        Some(r) => {
            let name = r.trim();
            // Unborn: HEAD names a branch with no commit; git calls that "not a repository with a HEAD".
            let sha = resolve_ref(&common, name)?;
            (Some(name.strip_prefix("refs/heads/").unwrap_or(name).to_string()), sha)
        }
        // Detached: HEAD holds the sha itself.
        None if t.len() >= 40 && t.chars().all(|c| c.is_ascii_hexdigit()) => (None, t.to_string()),
        None => return None,
    };
    // Fixed at 7 rather than git's core.abbrev; only shown as the "(detached @…)" label.
    Some(HeadInfo { branch, short: full.chars().take(7).collect() })
}

/// The repo's MAIN worktree root, read off the filesystem instead of spawning git (History
/// asks in bulk, and a `rev-parse` is ~140ms on Windows). A `.git` dir is the root; a `.git`
/// file into `…/.git/worktrees/<n>` names a linked worktree; a submodule is its own root.
/// Starts from the PHYSICAL cwd, as git does, or one repo gets two spellings in the sidebar.
pub(crate) fn repo_root_of(cwd: &str) -> Option<String> {
    let phys = physical_cwd(cwd);
    let mut dir: Option<&std::path::Path> = Some(std::path::Path::new(&phys));
    while let Some(d) = dir {
        let dot = d.join(".git");
        match std::fs::metadata(&dot) {
            Ok(m) if m.is_dir() => return Some(norm_path(&d.to_string_lossy())),
            Ok(_) => {
                // A `.git` FILE: `gitdir: <path>`, absolute in a worktree, maybe relative in a submodule.
                let link = std::fs::read_to_string(&dot).ok()?;
                let target = link.trim().strip_prefix("gitdir:")?.trim();
                let abs = d.join(target);
                // A pruned worktree's `.git` file points at nothing. git calls that "not a
                // repository" and does NOT search upward past it, so neither do we.
                if !abs.exists() {
                    return None;
                }
                let flat = abs.to_string_lossy().replace('\\', "/");
                // …/<repo>/.git/worktrees/<name> → <repo>
                if let Some(i) = flat.rfind("/.git/worktrees/") {
                    return Some(norm_path(&flat[..i]));
                }
                return Some(norm_path(&d.to_string_lossy()));
            }
            Err(_) => dir = d.parent(),
        }
    }
    None
}

/// `cwd`'s repo MAIN worktree root and current branch, in one git call, so external
/// sessions in different worktrees of one repo group under it. Line 1 is the common `.git`
/// dir (its parent is the main worktree), line 2 the branch ("HEAD" when detached).
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

/// A `git` command hardened for a GUI app: `LC_ALL=C` (never parse localized output), an
/// augmented PATH (Finder strips it), and every credential prompt disabled, since there is
/// no tty to ask on and a prompt would block the invoke thread forever. Credential helpers
/// and ssh-agent keys still work; anything else fails fast, and the user gets a terminal.
fn git_cmd(workdir: &str, args: &[&str]) -> std::process::Command {
    let mut c = sys_command("git");
    c.env("LC_ALL", "C")
        .env("PATH", augmented_path())
        .env("GIT_TERMINAL_PROMPT", "0") // a failed askpass falls back to the terminal prompt
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    #[cfg(not(windows))]
    {
        c.env("GIT_ASKPASS", "/usr/bin/false").env("SSH_ASKPASS", "/usr/bin/false");
    }
    #[cfg(windows)]
    {
        // No /usr/bin/false to point an askpass at; forbid Git Credential Manager's GUI
        // prompt instead so a missing credential fails fast. Stored GCM creds still work.
        c.arg("-c").arg("credential.interactive=false");
    }
    c.arg("-C").arg(workdir).args(args);
    c
}

/// Run git with a hard timeout: `Child::wait` has none, so a scratch thread waits and the
/// pid is killed on overrun. Without it a fetch to an unreachable remote hangs a worker forever.
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

/// `(upstream_name, ahead, behind)` versus the branch's upstream; zeros and no name without
/// one or on a detached HEAD. Only as fresh as the last fetch, hence the UI's fetch button.
fn upstream_state(workdir: &str) -> (Option<String>, u32, u32) {
    let name = git_cmd(workdir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(name) = name else { return (None, 0, 0) };
    // --left-right --count over the symmetric difference prints "behind\tahead".
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
    added: u32,     // insertions in the uncommitted working tree (tracked files, vs HEAD)
    removed: u32,
    files: u32,     // tracked files with uncommitted changes
    untracked: u32, // untracked entries; git collapses an untracked directory into one
    new_dirs: u32,  // how many of `untracked` are directories ("1 new folder", not "1 new file")
    dirty: u32,     // `git status --porcelain` line count
    upstream: Option<String>, // "origin/main"; None when the branch tracks nothing
    ahead: u32,     // as of the last fetch
    behind: u32,
}

/// One dirty entry, as the new-session dialog lists it under "Working tree".
#[derive(serde::Serialize)]
pub(crate) struct StatusFile {
    path: String,         // repo-relative, forward slashes; for a rename the NEW path
    code: char,           // M modified, A added, D deleted, R renamed, C copied, U unmerged, ? untracked
    from: Option<String>, // where a rename/copy came from
    /// Lines vs HEAD. An untracked file has no `diff HEAD` row, so it carries the lines
    /// `new_file_lines` counted for the stat; both 0 for a binary or skipped file.
    added: u32,
    removed: u32,
}

/// A `DiffStat` plus the entries behind it, flattened so the frontend's `WorkingSet` is a
/// `DiffStat` plus one field. `entries` is capped and `dirty` is not.
#[derive(serde::Serialize)]
pub(crate) struct WorkingSet {
    #[serde(flatten)]
    stat: DiffStat,
    entries: Vec<StatusFile>,
}

/// `--numstat` spells a rename `old => new` (or `dir/{old => new}/leaf`); porcelain=v2 uses
/// the new path alone, and the line counts have to be filed under that.
fn numstat_path(raw: &str) -> String {
    let Some(i) = raw.find(" => ") else { return raw.to_string() };
    let (l, r) = (&raw[..i], &raw[i + 4..]);
    match (l.rfind('{'), r.find('}')) {
        (Some(o), Some(c)) => format!("{}{}{}", &l[..o], &r[..c], &r[c + 1..]),
        _ => r.to_string(),
    }
}

/// The path (plus a rename's origin) out of one porcelain=v2 entry. Fields before the path:
/// 8 for `1`, 9 for `2` (rename score), 10 for `u` (three stages); the path is everything
/// after, since it may contain spaces, and a `2` entry puts the original after a TAB.
fn v2_path(line: &str) -> Option<(String, Option<String>)> {
    let kind = *line.as_bytes().first()?;
    if kind == b'?' {
        return Some((line.get(2..)?.to_string(), None));
    }
    let fields = match kind {
        b'1' => 8,
        b'2' => 9,
        b'u' => 10,
        _ => return None,
    };
    let mut rest = line;
    for _ in 0..fields {
        rest = &rest[rest.find(' ')? + 1..];
    }
    Some(match rest.split_once('\t') {
        Some((new, old)) => (new.to_string(), Some(old.to_string())),
        None => (rest.to_string(), None),
    })
}

/// The letter for one entry's `XY` pair: the index column wins when it says anything (a
/// renamed-then-edited file reads `R`), and an unmerged entry is always `U`.
fn v2_code(kind: u8, xy: &str) -> char {
    if kind == b'u' {
        return 'U';
    }
    let mut it = xy.chars();
    let (x, y) = (it.next().unwrap_or('.'), it.next().unwrap_or('.'));
    if x != '.' { x } else { y }
}

/// Bounds on the untracked scan: a meter must not add to what it measures.
const NEW_SCAN_MAX: usize = 64;
const NEW_FILE_MAX: u64 = 512 * 1024;

/// Lines in an untracked file as `git diff --no-index` would count them. None means not
/// counted (gone, not a regular file, too big, looks binary); the caller adds nothing.
fn new_file_lines(path: &std::path::Path) -> Option<u32> {
    let md = std::fs::metadata(path).ok()?;
    if !md.is_file() || md.len() > NEW_FILE_MAX {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return Some(0);
    }
    // git's own binary test: a NUL in the first 8000 bytes.
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
    Some(newlines + u32::from(bytes.last() != Some(&b'\n')))
}

/// A session's uncommitted work, diffed against HEAD (always well-defined mid-session,
/// unlike a guessed base branch). None when `workdir` is not a repo or has no commits.
/// `cap` is how many dirty entries to name: 0 for the polled counts (`git_diffstat`), else
/// the most the caller shows. One scan serves both, so the two surfaces cannot disagree.
fn working_set(workdir: &str, cap: usize) -> Option<(DiffStat, Vec<StatusFile>)> {
    let git = |args: &[&str]| {
        sys_command("git")
            .env("LC_ALL", "C")
            .arg("-C").arg(workdir)
            // Without this git octal-escapes any non-ASCII path and quotes it.
            .args(["-c", "core.quotePath=false"])
            .args(args)
            .output()
    };
    // ONE spawn for everything but the line counts: `--porcelain=v2 --branch` reports the
    // dirty entries and the upstream/ahead/behind in one walk. This is polled per folder.
    let st = git(&["--no-optional-locks", "status", "--porcelain=v2", "--branch"]).ok()?;
    if !st.status.success() {
        return None; // not a repo
    }
    let text = String::from_utf8_lossy(&st.stdout);
    let (mut untracked, mut dirty, mut new_dirs) = (0u32, 0u32, 0u32);
    let mut new_files: Vec<String> = Vec::new();
    let (mut upstream, mut ahead, mut behind) = (None, 0u32, 0u32);
    let mut unborn = false;
    let mut entries: Vec<StatusFile> = Vec::new();
    for line in text.lines() {
        match line.as_bytes().first() {
            // `1` changed, `2` renamed/copied, `u` unmerged; `?` counts as dirty and as new.
            Some(&k @ (b'1' | b'2' | b'u' | b'?')) => {
                dirty += 1;
                if k == b'?' {
                    untracked += 1;
                    // `? sub/` is a whole untracked directory collapsed into one entry: named, never read.
                    match line.strip_prefix("? ") {
                        Some(p) if p.ends_with('/') => new_dirs += 1,
                        Some(p) => new_files.push(p.to_string()),
                        None => {}
                    }
                }
                if entries.len() < cap {
                    if let Some((path, from)) = v2_path(line) {
                        let xy = line.split(' ').nth(1).unwrap_or("");
                        entries.push(StatusFile {
                            path,
                            code: if k == b'?' { '?' } else { v2_code(k, xy) },
                            from,
                            added: 0,
                            removed: 0,
                        });
                    }
                }
            }
            Some(b'#') => {
                if let Some(v) = line.strip_prefix("# branch.upstream ") {
                    upstream = Some(v.trim().to_string());
                } else if let Some(v) = line.strip_prefix("# branch.ab ") {
                    // "+<ahead> -<behind>", present only when an upstream is set.
                    let mut it = v.split_whitespace();
                    ahead = it.next().and_then(|s| s.trim_start_matches('+').parse().ok()).unwrap_or(0);
                    behind = it.next().and_then(|s| s.trim_start_matches('-').parse().ok()).unwrap_or(0);
                } else if line.starts_with("# branch.oid (initial)") {
                    unborn = true;
                }
            }
            _ => {}
        }
    }
    // An unborn HEAD has nothing to diff against; None rather than a card claiming zero changes.
    if unborn {
        return None;
    }
    // The second walk (+/- counts) is skipped on a clean tree, the steady state for most folders.
    let (mut added, mut removed, mut files) = (0u32, 0u32, 0u32);
    if dirty > 0 {
        let ns = git(&["--no-optional-locks", "diff", "--numstat", "HEAD"]).ok()?;
        if !ns.status.success() {
            return None;
        }
        let mut per: HashMap<String, (u32, u32)> = HashMap::new();
        for line in String::from_utf8_lossy(&ns.stdout).lines() {
            let mut it = line.split('\t');
            let a = it.next().unwrap_or("").parse::<u32>().unwrap_or(0); // "-" (binary) parses to 0
            let d = it.next().unwrap_or("").parse::<u32>().unwrap_or(0);
            files += 1;
            added += a;
            removed += d;
            if !entries.is_empty() {
                if let Some(p) = it.next() {
                    per.insert(numstat_path(p), (a, d));
                }
            }
        }
        for e in entries.iter_mut() {
            if let Some(&(a, d)) = per.get(&e.path) {
                (e.added, e.removed) = (a, d);
            }
        }
    }
    // A never-committed file has no `diff HEAD` row, yet the peek renders it as a new-file
    // diff with a real count, so count its lines here and on the named entry. Bounded (this
    // is the dirty poll): at most NEW_SCAN_MAX files of NEW_FILE_MAX bytes, binaries skipped.
    for rel in new_files.iter().take(NEW_SCAN_MAX) {
        let n = new_file_lines(&std::path::Path::new(workdir).join(rel)).unwrap_or(0);
        added += n;
        if let Some(e) = entries.iter_mut().find(|e| e.path == *rel) {
            e.added = n;
        }
    }
    Some((
        DiffStat { added, removed, files, untracked, new_dirs, dirty, upstream, ahead, behind },
        entries,
    ))
}

#[tauri::command(async)]
pub(crate) fn git_diffstat(workdir: String) -> Option<DiffStat> {
    working_set(&workdir, 0).map(|(stat, _)| stat)
}

/// `git_diffstat` with the files named, for the new-session dialog. Capped (a folder can
/// hold an untracked `node_modules`); `dirty` still carries the true total.
#[tauri::command(async)]
pub(crate) fn git_working_set(workdir: String) -> Option<WorkingSet> {
    const LIST_CAP: usize = 200;
    working_set(&workdir, LIST_CAP).map(|(stat, entries)| WorkingSet { stat, entries })
}

#[derive(serde::Serialize)]
pub(crate) struct ChangedPath {
    path: String,   // repo-relative, forward slashes, the same shape as the explorer's index
    status: String, // one letter from `v2_code`, so this and the dialog's list agree
}

/// Which paths are dirty and how: the marks on an explorer row. Separate from the polled
/// `git_diffstat` because this one asks for `-uall`, once, when the overlay opens. Not a
/// repo is an empty list, not an error; the explorer works there from a walk.
#[tauri::command(async)]
pub(crate) fn git_changed(workdir: String) -> Vec<ChangedPath> {
    let out = sys_command("git")
        .env("LC_ALL", "C")
        .arg("-C").arg(&workdir)
        .args(["-c", "core.quotePath=false"])
        // `-uall`: the default collapses a new folder into `? sub/`, so every file inside it
        // would reach the explorer unmarked. `working_set` keeps `-unormal` (it is polled).
        .args(["--no-optional-locks", "status", "--porcelain=v2", "-uall"])
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows = Vec::new();
    for line in text.lines() {
        // Shared with the new-session dialog's list, so one file cannot be `M` here and `A` there.
        let Some(kind) = line.as_bytes().first().copied() else { continue };
        if !matches!(kind, b'1' | b'2' | b'u' | b'?') {
            continue;
        }
        let Some((path, _from)) = v2_path(line) else { continue };
        if path.is_empty() {
            continue;
        }
        let xy = line.split(' ').nth(1).unwrap_or("");
        let code = if kind == b'?' { '?' } else { v2_code(kind, xy) };
        rows.push(ChangedPath { path, status: code.to_string() });
    }
    rows
}

#[derive(serde::Serialize)]
pub(crate) struct GitDiff {
    patch: String,   // tracked changes vs HEAD, then each untracked file as a new-file diff
    truncated: bool, // stopped at the size/file cap; the viewer shows a note
}

/// The full uncommitted diff behind the working-set card. Tracked changes from `diff HEAD`;
/// untracked files appended via `diff --no-index` against `/dev/null`, which unlike `add -N`
/// never touches the index while a live session may be staging.
#[tauri::command]
pub(crate) fn git_diff(workdir: String) -> Option<GitDiff> {
    const CAP: usize = 800_000; // ~0.8 MB of patch text — ample for a peek
    // Each untracked file costs a whole git process (`--no-index` is one pair at a time), so
    // this bounds a process storm, not output size; 300 once meant ~600 spawns on one click.
    const MAX_UNTRACKED: usize = 25;

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

    // `--no-index` exits 1 whenever the files differ, so stdout is read regardless of status.
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

/// One commit as the graph panel draws it. Flat and underived: lanes, ref chips and dates
/// are computed in `graph.ts`, where they can be tested without a repo.
#[derive(serde::Serialize)]
pub(crate) struct GraphCommit {
    sha: String,          // full: parents are matched on it, and an abbreviation is only unique today
    short: String,        // %h
    parents: Vec<String>, // first parent first; empty for a root, 2+ for a merge
    subject: String,
    author: String,
    unix: i64,            // author date, epoch seconds
    rel: String,          // committer date, relative, in git's own wording
    /// Raw `%D` in `--decorate=full` form, empty without a ref. The frontend's `parseRefs`
    /// needs the full paths; the short forms cannot be told apart.
    refs: String,
}

/// One page of history. `more` comes from asking git for one commit past the page, so
/// "load more" never needs the repo's commit count.
#[derive(serde::Serialize)]
pub(crate) struct GraphPage {
    commits: Vec<GraphCommit>,
    more: bool,
}

/// A page of commit history: `git log --skip -n limit+1` and nothing else, since the panel
/// must never read a whole history; `--date-order` so page 1 is newest across refs
/// (docs/commit-graph.md). `\x1e` records, NUL fields: a subject may hold a tab, and `-z` would
/// collide with the NULs. `scope` "head" is the checkout alone, else `--all`. Unborn: an empty page.
#[tauri::command(async)]
pub(crate) fn git_graph(workdir: String, skip: u32, limit: u32, scope: String) -> Result<GraphPage, String> {
    /// Ceiling on one page, whatever the caller asks for.
    const MAX_PAGE: u32 = 400;

    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    let limit = limit.clamp(1, MAX_PAGE);
    let n = format!("-{}", limit as u64 + 1); // one past the page — see GraphPage::more
    let sk = format!("--skip={skip}");
    let mut args = vec![
        "--no-optional-locks", "log", "--date-order", "--no-color",
        // FULL ref paths in %D; short ones cannot be told apart.
        "--decorate=full",
        sk.as_str(), n.as_str(),
        "--format=%x1e%H%x00%h%x00%P%x00%an%x00%at%x00%cr%x00%D%x00%s",
    ];
    if scope != "head" {
        args.push("--all");
    }
    // A repo mid-gc can block on the object store.
    let out = git_run(git_cmd(&workdir, &args), 20)?;
    if !out.status.success() {
        // git's own first line names which failure; pass it through.
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().find(|l| !l.trim().is_empty()).unwrap_or("git log failed").to_string());
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut commits = Vec::new();
    // The first slice is the empty string ahead of the first record.
    for rec in text.split('\u{1e}').skip(1) {
        let mut f = rec.trim_matches('\n').split('\0');
        let sha = f.next().unwrap_or("").trim().to_string();
        if sha.is_empty() {
            continue;
        }
        // Read in the order the format string writes them, not the struct's order.
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

/// One commit's whole message (`%B`), for the graph's commit overlay. Not part of the page:
/// a per-commit body needed a cap that truncated the one message being read. `sha` must be
/// hex, since it goes to git as a revision argument (a `--flag` is refused).
#[tauri::command(async)]
pub(crate) fn git_commit_message(workdir: String, sha: String) -> Result<String, String> {
    /// ~200KB; only a machine-generated message gets there, and a marker is appended.
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

#[derive(serde::Serialize, Debug, Default)]
pub(crate) struct GitActionResult {
    ok: bool,
    summary: String,         // one line for the toast
    output: String,          // combined stdout+stderr, for the debug log
    suggest: Option<String>, // the command to finish with in a terminal, when a button cannot safely
    /// `remove_worktree` only: the worktree is unregistered (`ok: true`, the roster changed)
    /// but its directory is still on disk. `purge_worktree_folder` acts on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    stranded: Option<Stranded>,
}

/// Fetch / pull / push for a session's working directory. No button may leave the tree in a
/// state the UI cannot explain (there is no conflict surface): pull is `--ff-only`, push never
/// invents an upstream, and the predictable refusals (diverged, no upstream) come with the
/// command to run instead. All three are safe against a live agent in the same worktree.
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
            ..Default::default()
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
            // Diverged: refusing up front lets us say why and hand over the rebase.
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
                    ..Default::default()
                });
            }
            vec!["pull", "--ff-only"]
        }
        "push" => {
            let Some(branch) = branch.as_deref() else {
                return refuse("detached HEAD — nothing to push", "git switch -");
            };
            // A branch's first push is a publishing decision; never made from a button.
            if upstream.is_none() {
                return refuse(
                    &format!("{branch} tracks no upstream"),
                    &format!("git push -u origin {branch}"),
                );
            }
            // "Nothing to send" comes FIRST: with no commits of our own a push is a no-op,
            // whatever the remote has done.
            if ahead == 0 {
                return Ok(GitActionResult {
                    ok: true,
                    summary: "nothing to push".into(),
                    ..Default::default()
                });
            }
            // Diverged: `git pull --ff-only` was once offered here and cannot fast-forward
            // a branch that moved on locally, so the handoff must be the rebase.
            if behind > 0 {
                return refuse(
                    &format!("diverged — {ahead} ahead, {behind} behind, so the push would be rejected"),
                    "git pull --rebase && git push",
                );
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
        return Ok(GitActionResult { ok: true, summary, output: combined, ..Default::default() });
    }

    // An unpredicted refusal: show git's own first line and offer the same op in a shell.
    let first = combined.lines().find(|l| !l.trim().is_empty()).unwrap_or("git failed").to_string();
    Ok(GitActionResult {
        ok: false,
        summary: first,
        output: combined,
        suggest: Some(format!("git {}", args.join(" "))),
        ..Default::default()
    })
}

/// One commit on the Trail. `when` is the author date in UNIX seconds, like `HistorySession.mtime`.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct DayCommit {
    pub sha: String,
    pub author: String,
    pub when: u64,
    pub subject: String,
    pub root: String, // the repo as the caller named it, so the frontend needs no path resolving
}

/// Something that identifies a folder's REPOSITORY, not its checkout: every worktree shares
/// one common dir, and that is what stops the Trail counting one repo's commits N times.
/// `--path-format=absolute` matters, or a main worktree answers a relative `.git`.
fn repo_identity(dir: &str) -> Option<String> {
    let out = sys_command("git")
        .env("LC_ALL", "C")
        .arg("-C").arg(dir)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(norm_path(&s)) }
}

/// Commits across `roots` in the last `days` days, for the Trail. One git call per
/// repository, never per day; every local branch (`--branches`), merges kept, every author.
/// A root that is not a repo, has no commits or was deleted contributes nothing.
#[tauri::command(async)]
pub(crate) fn git_log_days(roots: Vec<String>, days: u64) -> Vec<DayCommit> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<DayCommit> = Vec::new();
    // git's approxidate cannot express a date before the epoch and `--since=36500.days.ago`
    // silently matches NOTHING, so a wider window means "all history": omit `--since`.
    const WIDER_THAN_GIT_CAN_SAY: u64 = 18_000; // ~49 years; the epoch is the real limit
    let since = format!("--since={days}.days.ago");

    for root in &roots {
        // Dedupe by repository, keeping the first-named root as the label.
        let id = repo_identity(root).unwrap_or_else(|| norm_path(root));
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);

        let mut args: Vec<&str> = vec!["--no-optional-locks", "log", "--branches"];
        if days < WIDER_THAN_GIT_CAN_SAY {
            args.push(&since);
        }
        // NUL between fields; %s is the subject line, so records stay newline-separated.
        args.push("--format=%H%x00%an%x00%at%x00%s");

        let res = sys_command("git")
            .env("LC_ALL", "C")
            .arg("-C").arg(root)
            .args(&args)
            .output();
        let Ok(res) = res else { continue };
        if !res.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&res.stdout).lines() {
            let mut p = line.split('\0');
            let (Some(sha), Some(author), Some(at), Some(subject)) =
                (p.next(), p.next(), p.next(), p.next())
            else {
                continue;
            };
            let Ok(when) = at.parse::<u64>() else { continue };
            out.push(DayCommit {
                sha: sha.chars().take(9).collect(),
                author: author.to_string(),
                when,
                subject: subject.to_string(),
                root: root.clone(),
            });
        }
    }
    out
}

/// What the dashboard needs before it renders anything, in one call, since it decides
/// which cards exist: a GitHub remote unlocks issues and PRs, git unlocks the commit
/// half and everything shared; neither gates sessions, spend or tasks (docs/dashboard.md).
#[derive(serde::Serialize, Debug, PartialEq, Default)]
pub(crate) struct ProjectFacts {
    pub is_repo: bool,
    pub root: Option<String>,   // the repo's main checkout; None when the folder is not a repo
    pub origin: Option<String>, // `origin`'s URL verbatim; None for a repo with no remote
    pub host: Option<String>,   // as the remote spells it, lowercased; an ssh alias included
    /// `owner/repo`, only when the host is GitHub (it is what `gh` needs); an ssh alias
    /// that resolves to `github.com` counts, see [`parse_remote_with`].
    pub slug: Option<String>,
}

/// Host and `owner/repo` out of a git remote URL. Pure: `git@host:owner/repo.git` has no
/// scheme and a colon where a slash belongs, while ssh:// and https:// are ordinary URLs.
fn split_remote(url: &str) -> (Option<String>, Option<String>) {
    let u = url.trim();
    if u.is_empty() {
        return (None, None);
    }
    // scp-like `[user@]host:path`, told apart from a scheme by the absence of "://".
    let rest = if let Some((_, after)) = u.split_once("://") {
        after.to_string()
    } else if let Some((hostish, path)) = u.split_once(':') {
        // A Windows drive letter or a plain relative path is not a remote host.
        if hostish.contains('/') || hostish.chars().count() <= 1 {
            return (None, None);
        }
        format!("{hostish}/{path}")
    } else {
        return (None, None);
    };
    let rest = rest.split_once('@').map_or(rest.as_str(), |(_, r)| r); // strip user[:pass]@
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    // Strip a port: `git@host:2222/o/r` and `ssh://host:2222/o/r` are both legal.
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    if host.is_empty() {
        return (None, None);
    }
    let path = path.trim_matches('/').trim_end_matches(".git");
    let mut seg = path.split('/').filter(|s| !s.is_empty());
    let owner_repo = match (seg.next(), seg.next()) {
        (Some(o), Some(r)) => Some(format!("{o}/{r}")),
        _ => None,
    };
    (Some(host), owner_repo)
}

/// [`split_remote`], plus whether the name is a hostname at all. Only GitHub gets a slug,
/// but an `~/.ssh/config` `Host` alias (`github.com-work`, two accounts on one machine) is
/// GitHub too; `resolve` (see [`ssh_hostname`]) is consulted only after the plain match fails.
fn parse_remote_with(url: &str, resolve: impl Fn(&str) -> Option<String>) -> (Option<String>, Option<String>) {
    let (host, owner_repo) = split_remote(url);
    let Some(h) = host else { return (None, None) };
    if h == "github.com" {
        return (Some(h), owner_repo);
    }
    // Only an ssh-ish remote can carry an alias; an https host is a real hostname.
    let aliased = owner_repo.is_some()
        && !url.trim_start().to_ascii_lowercase().starts_with("http")
        && resolve(&h).as_deref() == Some("github.com");
    // The host stays as written: it is only shown when there is no slug.
    (Some(h), owner_repo.filter(|_| aliased))
}

/// Host and GitHub `owner/repo` out of a git remote URL.
pub(crate) fn parse_remote(url: &str) -> (Option<String>, Option<String>) {
    parse_remote_with(url, ssh_hostname)
}

// Cached for the life of the process; nobody edits ~/.ssh/config mid-session.
static SSH_HOSTS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// The real hostname behind an `~/.ssh/config` `Host` alias, or None. `ssh -G` prints the
/// applicable config without connecting, and it, not a half-parser, owns `Include`,
/// wildcards and `Match`. No ssh on PATH is None.
fn ssh_hostname(alias: &str) -> Option<String> {
    // The name goes to ssh as an argument, so it must not read as a flag.
    if alias.starts_with('-')
        || alias.is_empty()
        || !alias.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return None;
    }
    if let Ok(g) = SSH_HOSTS.lock() {
        if let Some(hit) = g.as_ref().and_then(|m| m.get(alias)) {
            return hit.clone();
        }
    }
    let found = sys_command("ssh")
        .env("PATH", augmented_path())
        .args(["-G", alias])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| ssh_hostname_in(&String::from_utf8_lossy(&o.stdout), alias));
    if let Ok(mut g) = SSH_HOSTS.lock() {
        g.get_or_insert_with(HashMap::new).insert(alias.to_string(), found.clone());
    }
    found
}

/// The `hostname` line out of `ssh -G` output, if it names something other than the alias:
/// ssh echoes a non-alias back as itself, which must not read as a resolution.
fn ssh_hostname_in(out: &str, alias: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.strip_prefix("hostname ").map(|h| h.trim().to_ascii_lowercase()))
        .filter(|h| !h.is_empty() && !h.eq_ignore_ascii_case(alias))
}

/// The one probe the dashboard makes before deciding what it can show.
#[tauri::command(async)]
pub(crate) fn project_facts(dir: String) -> ProjectFacts {
    let Some(root) = repo_root_of(&dir) else {
        return ProjectFacts::default();
    };
    // `remote get-url` rather than reading .git/config: worktrees, submodules and includeIf.
    let origin = sys_command("git")
        .env("LC_ALL", "C")
        .arg("-C").arg(&root)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let (host, slug) = origin.as_deref().map_or((None, None), parse_remote);
    ProjectFacts { is_repo: true, root: Some(root), origin, host, slug }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{git, scratch_dir};

    /// No ssh config at all; assertions using it also assert the alias lookup was not needed.
    fn no_aliases(_: &str) -> Option<String> { None }

    /// `switch_branch` needs a live `AppState`, so its rule is pinned here; the other half
    /// (`midFlight` in src/types.ts) is written to agree, and the two drift silently.
    #[test]
    fn only_a_running_task_blocks_a_branch_switch_from_the_backend_side() {
        assert!(blocks_switch("task"));
        // A shell is the user's own prompt; an agent's phase is not visible here.
        assert!(!blocks_switch("shell"));
        assert!(!blocks_switch("claude"));
        // An unknown kind is a pane we added, not a hazard to refuse on.
        assert!(!blocks_switch(""));
    }

    /// The pair must never disagree; only the dirty-tree path hands the suggest to a terminal.
    #[test]
    fn a_remote_only_switch_tracks_and_hands_over_the_same_command() {
        let (args, suggest) = switch_args("feat/x", Some("origin/feat/x"));
        assert_eq!(args, ["switch", "--track", "-c", "feat/x", "origin/feat/x"]);
        assert_eq!(suggest, "git switch --track -c \"feat/x\" \"origin/feat/x\"");
        // An existing branch is switched to, never cut again (-c on it is a hard error).
        let (args, suggest) = switch_args("dev", None);
        assert_eq!(args, ["switch", "dev"]);
        assert_eq!(suggest, "git switch \"dev\"");
    }

    #[test]
    fn parse_remote_reads_every_spelling_git_accepts() {
        let p = |u| parse_remote_with(u, no_aliases);
        // scp-like: not a URI at all, and the most common form for an SSH key setup.
        assert_eq!(p("git@github.com:respeak-io/episko.git"),
                   (Some("github.com".into()), Some("respeak-io/episko".into())));
        assert_eq!(p("https://github.com/respeak-io/episko.git"),
                   (Some("github.com".into()), Some("respeak-io/episko".into())));
        assert_eq!(p("ssh://git@github.com/respeak-io/episko"),
                   (Some("github.com".into()), Some("respeak-io/episko".into())));
        // A token in the URL must not become the host.
        assert_eq!(p("https://x-access-token:ghp_abc@github.com/respeak-io/episko.git"),
                   (Some("github.com".into()), Some("respeak-io/episko".into())));
        // A port is legal on both forms and is not part of the host.
        assert_eq!(p("ssh://git@github.com:2222/respeak-io/episko.git").0,
                   Some("github.com".into()));
    }

    #[test]
    fn a_slug_is_only_ever_produced_for_github() {
        let p = |u| parse_remote_with(u, no_aliases);
        // The slug is what `gh` is handed; another host would promise issues Episko cannot reach.
        assert_eq!(p("git@gitlab.com:team/thing.git"),
                   (Some("gitlab.com".into()), None));
        assert_eq!(p("git@git.respeak.internal:team/thing.git"),
                   (Some("git.respeak.internal".into()), None));
        // Host case is normalised — GitHub URLs are written both ways.
        assert_eq!(p("git@GitHub.com:o/r.git").1, Some("o/r".into()));
    }

    #[test]
    fn an_ssh_host_alias_is_still_github() {
        // Two GitHub accounts on one machine means an ssh Host alias per identity in the remote URL.
        let cfg = |h: &str| match h {
            "github.com-work" | "gh-personal" => Some("github.com".to_string()),
            "work-lab" => Some("gitlab.com".to_string()),
            _ => None,
        };
        assert_eq!(parse_remote_with("github.com-work:respeak-io/episko.git", cfg),
                   (Some("github.com-work".into()), Some("respeak-io/episko".into())));
        // The alias need not look like a hostname at all.
        assert_eq!(parse_remote_with("git@gh-personal:me/dotfiles.git", cfg).1,
                   Some("me/dotfiles".into()));
        assert_eq!(parse_remote_with("ssh://git@gh-personal/me/dotfiles", cfg).1,
                   Some("me/dotfiles".into()));
        // Resolving somewhere else is not GitHub, and neither is an unknown name.
        assert_eq!(parse_remote_with("work-lab:team/thing.git", cfg).1, None);
        assert_eq!(parse_remote_with("git@nowhere-known:team/thing.git", cfg).1, None);
        // An https host is a real hostname — never an ssh alias, however it is spelled.
        assert_eq!(parse_remote_with("https://github.com-work/respeak-io/episko.git", cfg).1, None);
    }

    #[test]
    fn an_alias_lookup_never_hands_ssh_something_that_reads_as_a_flag() {
        // The name comes out of a remote URL, and it goes to ssh as an argument.
        assert_eq!(ssh_hostname("-oProxyCommand=touch pwned"), None);
        assert_eq!(ssh_hostname("host name"), None);
        assert_eq!(ssh_hostname(""), None);
    }

    #[test]
    fn the_hostname_is_read_out_of_real_ssh_g_output() {
        // Verbatim shape of `ssh -G` (OpenSSH 9.x): ~60 `key value` lines, in no fixed order.
        const OUT: &str = "\
user git
hostname github.com
port 22
addressfamily any
identityfile ~/.ssh/respeak
identityfile ~/.ssh/id_rsa
hostkeyalias
canonicalizehostname false
";
        assert_eq!(ssh_hostname_in(OUT, "github.com-work"), Some("github.com".into()));
        // A non-alias: ssh still prints a `hostname`, echoing it back.
        assert_eq!(ssh_hostname_in("user git\nhostname gitlab.com\n", "gitlab.com"), None);
        assert_eq!(ssh_hostname_in("hostname GitLab.com\n", "gitlab.com"), None);
        // `hostkeyalias` must not be mistaken for it, nor an empty value accepted.
        assert_eq!(ssh_hostname_in("hostkeyalias github.com\nhostname \n", "x"), None);
        assert_eq!(ssh_hostname_in("", "x"), None);
    }

    #[test]
    fn a_local_path_is_not_a_remote_host() {
        let p = |u| parse_remote_with(u, no_aliases);
        assert_eq!(p("/srv/git/thing.git"), (None, None));
        assert_eq!(p("../sibling"), (None, None));
        assert_eq!(p("C:/repos/thing"), (None, None));
        assert_eq!(p(""), (None, None));
        assert_eq!(p("   "), (None, None));
    }

    #[test]
    fn project_facts_separates_not_a_repo_from_a_repo_with_no_remote() {
        // Different tiers: one loses the git half, the other only issues and PRs.
        let plain = scratch_dir();
        assert_eq!(project_facts(plain.to_string_lossy().to_string()), ProjectFacts::default());

        let repo = scratch_dir();
        git(&repo, &["init", "-q", "-b", "main"]);
        let f = project_facts(repo.to_string_lossy().to_string());
        assert!(f.is_repo);
        assert!(f.root.is_some());
        assert_eq!(f.origin, None, "a repo with no remote is normal, not an error");
        assert_eq!(f.slug, None);

        // NOT this repo's own remote: `remote get-url` applies the developer's
        // `url.<base>.insteadOf` rewrites, so a real owner can come back rewritten.
        git(&repo, &["remote", "add", "origin", "git@github.com:example-org/thing.git"]);
        let f = project_facts(repo.to_string_lossy().to_string());
        assert_eq!(f.slug, Some("example-org/thing".into()));
        assert_eq!(f.host, Some("github.com".into()));
    }

    use std::path::{Path, PathBuf};
    use std::process::Command;


    /// Where `create_worktree` puts this repo's checkouts. Clean up via this, never via
    /// `<parent>/.cc-worktrees`: every test shares that parent, and wiping it flakes them.
    fn wt_root(repo: &Path) -> PathBuf {
        repo.parent().unwrap()
            .join(".cc-worktrees")
            .join(repo.file_name().unwrap())
    }


    /// The same repository arrives under several worktree paths; count it once.
    #[test]
    fn git_log_days_counts_a_repo_once_however_many_worktrees_name_it() {
        let repo = scratch_dir();
        git(&repo, &["init", "-q", "-b", "main"]);
        let commit = |msg: &str| {
            git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=T",
                         "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        };
        commit("first thing");
        commit("second thing");

        let wt = wt_root(&repo).join("side");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(&repo, &["worktree", "add", "-q", "-b", "side", &wt.to_string_lossy()]);

        let root = repo.to_string_lossy().to_string();
        let side = wt.to_string_lossy().to_string();

        // One checkout: both commits, newest first is not asserted (the frontend sorts).
        let one = git_log_days(vec![root.clone()], 3650);
        assert_eq!(one.len(), 2, "expected both commits, got {one:?}");
        assert!(one.iter().any(|c| c.subject == "first thing"));
        assert_eq!(one[0].author, "T");
        assert!(one[0].when > 0, "author date must be a real unix timestamp");

        // Both checkouts of the SAME repo: still two commits, not four.
        let both = git_log_days(vec![root.clone(), side.clone()], 3650);
        assert_eq!(both.len(), 2, "worktrees of one repo must not double-count: {both:?}");

        // The dedupe key is the repository, not whichever path was listed first.
        assert_eq!(git_log_days(vec![side], 3650).len(), 2);

        let _ = std::fs::remove_dir_all(wt_root(&repo));
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A non-repo root contributes nothing rather than failing the whole call.
    #[test]
    fn git_log_days_shrugs_off_a_root_that_is_not_a_repo() {
        let plain = scratch_dir();
        assert!(git_log_days(vec![plain.to_string_lossy().to_string()], 30).is_empty());
        assert!(git_log_days(vec!["/nope/does/not/exist".into()], 30).is_empty());

        let repo = scratch_dir();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=T",
                     "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "only one"]);
        // A bad root alongside a good one still yields the good one's commits.
        let mixed = git_log_days(vec!["/nope".into(), repo.to_string_lossy().to_string()], 3650);
        assert_eq!(mixed.len(), 1);
        assert_eq!(mixed[0].subject, "only one");

        let _ = std::fs::remove_dir_all(&plain);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A commit outside `--since` must not appear, or "last 30 days" becomes "everything".
    #[test]
    fn git_log_days_honours_the_window() {
        let repo = scratch_dir();
        git(&repo, &["init", "-q", "-b", "main"]);
        // GIT_AUTHOR_DATE/COMMITTER_DATE are the only way to fabricate an old commit.
        let out = Command::new("git")
            .current_dir(&repo)
            .env("GIT_AUTHOR_DATE", "2001-02-03T04:05:06")
            .env("GIT_COMMITTER_DATE", "2001-02-03T04:05:06")
            .args(["-c", "user.email=t@example.com", "-c", "user.name=T",
                   "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "ancient"])
            .output()
            .expect("git");
        assert!(out.status.success());

        let root = repo.to_string_lossy().to_string();
        assert!(git_log_days(vec![root.clone()], 30).is_empty(),
                "a 2001 commit must fall outside a 30-day window");
        assert_eq!(git_log_days(vec![root.clone()], 20_000).len(), 1, "a wide window must include it");

        // git's approxidate matches NOTHING before the epoch; an over-wide window must widen, never empty.
        assert_eq!(git_log_days(vec![root.clone()], 36_500).len(), 1, "an over-wide window must not go blank");
        assert_eq!(git_log_days(vec![root], u64::MAX).len(), 1, "and neither must an absurd one");

        let _ = std::fs::remove_dir_all(&repo);
    }

    /// `repo_root_of` replaces a `git rev-parse`, so every case is asserted against
    /// `git_repo_info` in the same breath, including where git refuses an answer.
    #[test]
    fn repo_root_of_matches_git_without_spawning_it() {
        let repo = scratch_dir();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
        let root = norm_path(&repo.to_string_lossy());
        let agree = |dir: &Path| {
            let (fs, via_git) = (repo_root_of(&dir.to_string_lossy()), git_repo_info(&dir.to_string_lossy()).0);
            assert_eq!(fs, via_git, "disagreed with git at {}", dir.display());
            fs
        };

        // The main checkout, and a subdirectory of it — `.git` is a directory.
        assert_eq!(agree(&repo), Some(root.clone()));
        let sub = repo.join("src/deep");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(agree(&sub), Some(root.clone()));

        // A linked worktree BESIDE the repo: `.git` is a file into `<repo>/.git/worktrees/<name>`.
        let wt = wt_root(&repo).join("side");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(&repo, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
        assert!(wt.join(".git").is_file(), "fixture must be a linked worktree, not a clone");
        assert_eq!(agree(&wt), Some(root.clone()), "a worktree resolves to its repo");

        // Pruned admin dir: git calls the dangling `.git` file "not a repository" and stops.
        std::fs::remove_dir_all(repo.join(".git/worktrees/side")).unwrap();
        assert_eq!(agree(&wt), None, "a stale worktree resolves to nothing");

        // Not a repository at all, at any level above it.
        let bare = std::env::temp_dir();
        assert_eq!(repo_root_of(&bare.to_string_lossy()), None);

        let _ = std::fs::remove_dir_all(wt_root(&repo));
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// `git_head` reads `.git` directly, so every case is asserted against what git answers.
    /// An unborn HEAD is the subtle one: `.git/HEAD` names a branch either way, so only the
    /// missing ref tells it apart, and `projmenu.ts` relies on the `None`.
    #[test]
    fn git_head_matches_git_without_spawning_it() {
        let repo = scratch_dir();
        git(&repo, &["init", "-q", "-b", "main"]);

        // Ask git the same question, the way git_head used to.
        let via_git = |dir: &Path| -> Option<(Option<String>, String)> {
            let rp = Command::new("git").current_dir(dir).args(["rev-parse", "HEAD"]).output().unwrap();
            if !rp.status.success() {
                return None; // no repo, or an unborn HEAD
            }
            let full = String::from_utf8_lossy(&rp.stdout).trim().to_string();
            let sr = Command::new("git").current_dir(dir)
                .args(["symbolic-ref", "--quiet", "--short", "HEAD"]).output().unwrap();
            let branch = sr.status.success()
                .then(|| String::from_utf8_lossy(&sr.stdout).trim().to_string())
                .filter(|s| !s.is_empty());
            Some((branch, full))
        };
        let agree = |dir: &Path, what: &str| {
            let ours = git_head(dir.to_string_lossy().to_string());
            match (via_git(dir), &ours) {
                (None, None) => {}
                (Some((branch, full)), Some(h)) => {
                    assert_eq!(h.branch, branch, "branch disagreed with git ({what})");
                    assert!(full.starts_with(&h.short) && !h.short.is_empty(),
                        "short {:?} is not a prefix of HEAD {full} ({what})", h.short);
                }
                (g, o) => panic!("git said {:?}, we said {:?} ({what})", g.map(|x| x.0), o.as_ref().map(|x| &x.branch)),
            }
            ours
        };

        // Unborn HEAD: a repo, but no commit — must be None, not "detached".
        assert!(agree(&repo, "unborn").is_none(), "a repo with no commits has no HEAD to report");

        let commit = |msg: &str| {
            git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=T",
                         "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        };
        commit("init");

        // On a branch, from the checkout and from a subdirectory of it.
        assert_eq!(agree(&repo, "main").unwrap().branch.as_deref(), Some("main"));
        let sub = repo.join("src/deep");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(agree(&sub, "subdir").unwrap().branch.as_deref(), Some("main"));

        // `pack-refs` deletes the loose file, so this exercises the packed-refs fallback.
        git(&repo, &["pack-refs", "--all"]);
        assert!(!repo.join(".git/refs/heads/main").exists(), "fixture must have packed the ref away");
        assert_eq!(agree(&repo, "packed").unwrap().branch.as_deref(), Some("main"));

        // A linked worktree has its OWN HEAD but shares the repo's refs.
        let wt = wt_root(&repo).join("side");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(&repo, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
        assert!(wt.join(".git").is_file(), "fixture must be a linked worktree, not a clone");
        assert_eq!(agree(&wt, "worktree").unwrap().branch.as_deref(), Some("side"));
        assert_eq!(agree(&repo, "repo beside a worktree").unwrap().branch.as_deref(), Some("main"),
            "the main checkout keeps its own HEAD");

        // Detached HEAD: branch is None and `short` is what labels the pane.
        git(&repo, &["checkout", "-q", "--detach"]);
        let d = agree(&repo, "detached").unwrap();
        assert!(d.branch.is_none(), "a detached HEAD has no branch");
        assert_eq!(d.short.len(), 7, "the detached label needs a short sha: {d:?}");

        // Not a repository at all.
        assert!(git_head(std::env::temp_dir().to_string_lossy().to_string()).is_none());

        let _ = std::fs::remove_dir_all(wt_root(&repo));
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// One repo reached by two spellings must resolve to ONE root (the sidebar groups by
    /// exact string equality). `scratch_dir` hands back physical paths, so a deliberate
    /// symlink is the only fixture that can hold `repo_root_of` to git's answer.
    #[cfg(unix)]
    #[test]
    fn repo_root_of_resolves_a_symlinked_path_like_git_does() {
        let root = scratch_dir();
        let repo = root.join("real");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        // Committed first: `git_repo_info` fails the whole call on an unborn HEAD.
        git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
        let link = root.join("link");
        std::os::unix::fs::symlink(&repo, &link).unwrap();

        let physical = norm_path(&repo.to_string_lossy());
        assert_eq!(repo_root_of(&link.to_string_lossy()), Some(physical.clone()));
        assert_eq!(
            repo_root_of(&link.to_string_lossy()),
            git_repo_info(&link.to_string_lossy()).0,
            "still the answer git gives, through a symlink too"
        );
        // A subdirectory below the link resolves the same way.
        let sub = link.join("src/deep");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(repo_root_of(&sub.to_string_lossy()), Some(physical.clone()));

        // A linked worktree's root comes out of the `gitdir:` file, which git wrote canonically.
        let wt = root.join("side");
        git(&repo, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
        assert_eq!(repo_root_of(&wt.to_string_lossy()), Some(physical));

        let _ = std::fs::remove_dir_all(&root);
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
        assert!(d.patch.contains("diff --git a/tracked.txt b/tracked.txt"), "missing tracked diff:\n{}", d.patch);
        assert!(d.patch.contains("+CHANGED") && d.patch.contains("-line2"));
        assert!(d.patch.contains("diff --git a/new.txt b/new.txt"), "missing untracked diff:\n{}", d.patch);
        assert!(d.patch.contains("new file mode") && d.patch.contains("+brand new"));

        // Surfacing the untracked file must NOT have staged it; that is why --no-index over add -N.
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

    /// Identity and signing via `-c`: the developer's global gitconfig is neither needed nor touched.
    fn commit(dir: &Path, msg: &str) {
        git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
    }

    /// The sidebar's polling path must agree with `list_worktrees` while spawning no git: the
    /// same answer from a linked checkout, the path from `gitdir` rather than the bookkeeping
    /// name, a branch switch tracked, and a detached HEAD labelled rather than dropped.
    #[test]
    fn worktree_heads_reads_every_checkout_without_spawning_git() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        commit(&dir, "init");
        let repo = dir.to_str().unwrap().to_string();
        let made = create_worktree(repo.clone(), "feat/thing".into(), None).expect("worktree created");

        let heads = worktree_heads(repo.clone());
        assert_eq!(heads.len(), 2, "main + the linked checkout: {heads:?}");
        let main = heads.iter().find(|w| w.is_main).expect("a main entry");
        assert_eq!(main.branch, "main");
        assert_eq!(Some(main.path.as_str()), repo_root_of(&repo).as_deref(),
            "main's path is the checkout root, in the same spelling every other root uses");
        let linked = heads.iter().find(|w| !w.is_main).expect("a linked entry");
        assert_eq!(linked.branch, "feat/thing", "a slashed branch keeps its slash");
        // The CHECKOUT, not the repo root; the folder is `feat-thing`, so the path came from `gitdir`.
        assert_eq!(linked.path, norm_path(&physical_cwd(&made)));
        assert!(linked.path.ends_with("feat-thing"), "the checkout dir, not the repo root: {}", linked.path);
        assert!(linked.exists);

        // From inside the linked worktree (a `.git` file) the answer must be identical.
        assert_eq!(worktree_heads(made.clone()), heads, "same repo, same answer from any checkout");

        // The point of the whole thing: a branch switch is visible with no git spawn.
        git(Path::new(&made), &["checkout", "-q", "-b", "second"]);
        assert_eq!(worktree_heads(repo.clone()).iter().find(|w| !w.is_main).unwrap().branch, "second");

        git(Path::new(&made), &["checkout", "-q", "--detach"]);
        assert_eq!(worktree_heads(repo.clone()).iter().find(|w| !w.is_main).unwrap().branch, "(detached)");

        // A hand-deleted checkout stays LISTED with `exists: false`: git keeps its record until
        // pruned, and the frontend picks "remove" or "prune" off this flag.
        std::fs::remove_dir_all(&made).expect("hand-delete the checkout");
        let heads = worktree_heads(repo.clone());
        let linked = heads.iter().find(|w| !w.is_main).expect("still listed once pruned-pending");
        assert!(!linked.exists, "the folder is gone: {linked:?}");
        assert!(heads.iter().find(|w| w.is_main).expect("main").exists, "the repo itself is fine");

        // A directory that is not a repo answers empty rather than erroring.
        let plain = scratch_dir();
        assert!(worktree_heads(plain.to_str().unwrap().to_string()).is_empty());

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&plain);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The inspector's working-set strip and the ahead/behind pair beside it. An untracked
    /// file's lines ARE insertions here, so the strip and the peek agree; the gap is measured
    /// against the tracking ref only, and the scan must refuse what it should.
    #[test]
    fn git_diffstat_counts_the_working_set_and_the_upstream_gap() {
        let dir = scratch_dir();
        let remote = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);

        // An unborn HEAD is None, not a row of zeros that reads as "clean".
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
        assert_eq!((d.added, d.removed), (3, 1), "2 tracked insertions + the new file's 1 line");
        assert_eq!(d.files, 1, "`files` stays numstat's count: tracked files only");
        assert_eq!((d.untracked, d.dirty, d.new_dirs), (1, 2, 0), "one new file, no new folder");

        git(&remote, &["init", "-q", "--bare", "-b", "main"]);
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&dir, &["push", "-q", "-u", "origin", "main"]);
        commit(&dir, "ahead by one");
        let d = git_diffstat(path.clone()).unwrap();
        assert_eq!(d.upstream.as_deref(), Some("origin/main"));
        assert_eq!((d.ahead, d.behind), (1, 0), "measured against origin/main");
        // The working set is orthogonal to the upstream gap and must survive it.
        assert_eq!((d.added, d.removed, d.untracked), (3, 1, 1));

        // Detached HEAD tracks nothing — it must not inherit the branch it left.
        git(&dir, &["checkout", "-q", "--detach"]);
        assert_eq!(upstream_state(&path), (None, 0, 0));
        // Detached prints no `# branch.upstream`/`# branch.ab`: the parser's absent-field path.
        let d = git_diffstat(path.clone()).expect("a detached checkout still has a working set");
        assert_eq!(d.upstream, None);
        assert_eq!((d.ahead, d.behind), (0, 0));
        assert_eq!((d.added, d.removed, d.untracked), (3, 1, 1), "detaching changed no files");

        // A clean tree skips `--numstat` entirely, so it needs its own assertion.
        git(&dir, &["checkout", "-q", "main"]);
        git(&dir, &["checkout", "-q", "--", "a.txt"]);
        std::fs::remove_file(dir.join("new.txt")).unwrap();
        let clean = git_diffstat(path.clone()).expect("clean is still a diffstat");
        assert_eq!((clean.added, clean.removed, clean.files, clean.untracked, clean.dirty), (0, 0, 0, 0, 0));
        assert_eq!(clean.upstream.as_deref(), Some("origin/main"), "clean does not lose the upstream");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote);
    }

    /// Naming files is a different job from the totals: the counts must land on the right path
    /// (numstat spells a rename `old => new`), an untracked file has no diff, and the cap bounds
    /// the list but not the total.
    #[test]
    fn git_working_set_names_the_files_behind_the_counts() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("keep.txt"), "a\nb\nc\n").unwrap();
        std::fs::write(dir.join("old name.txt"), "1\n2\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "x\n").unwrap();
        git(&dir, &["add", "-A"]);
        commit(&dir, "init");

        // A clean tree names nothing, and still answers.
        let w = git_working_set(path.clone()).expect("a repo with a commit has a working set");
        assert_eq!(w.stat.dirty, 0);
        assert!(w.entries.is_empty(), "clean names no files");

        std::fs::write(dir.join("keep.txt"), "a\nCHANGED\nc\nd\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        git(&dir, &["mv", "old name.txt", "sub/new name.txt"]);
        std::fs::write(dir.join("sub").join("new name.txt"), "1
2
3
").unwrap();
        std::fs::write(dir.join("untracked file.txt"), "u\n").unwrap();

        let w = git_working_set(path.clone()).unwrap();
        assert_eq!(w.stat.dirty, 4, "modified + deleted + renamed + untracked");
        assert_eq!(w.entries.len(), 4, "every dirty entry is named");
        let by = |p: &str| {
            w.entries.iter().find(|e| e.path == p).unwrap_or_else(|| panic!("no entry for {p}"))
        };

        let m = by("keep.txt");
        assert_eq!(m.code, 'M');
        assert_eq!((m.added, m.removed), (2, 1), "its own lines, not the tree's total");

        // porcelain=v2 puts the path last, so a space in it survives.
        let r = by("sub/new name.txt");
        assert_eq!(r.code, 'R', "renamed-then-edited reads R, not M");
        assert_eq!(r.from.as_deref(), Some("old name.txt"));
        assert_eq!((r.added, r.removed), (1, 0), "numstat's `old => new` filed under the new path");

        let d = by("gone.txt");
        assert_eq!(d.code, 'D');
        assert_eq!((d.added, d.removed), (0, 1));

        let u = by("untracked file.txt");
        assert_eq!(u.code, '?', "untracked is its own kind, not an add");
        assert_eq!(
            (u.added, u.removed),
            (1, 0),
            "no `diff HEAD` row, so it carries the lines the stat counted for it"
        );

        // The cap bounds the list, never the totals; the pane subtracts the two.
        let (stat, few) = working_set(&path, 1).unwrap();
        assert_eq!(stat.dirty, 4, "the total ignores the cap");
        assert_eq!(few.len(), 1);
        // …and 0 is the polled path: counts, no walk over the entries at all.
        let (stat, none) = working_set(&path, 0).unwrap();
        assert_eq!((stat.dirty, stat.untracked, stat.files), (4, 1, 3));
        assert!(none.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// porcelain=v2 puts the path last after a per-kind number of fields, so a wrong count
    /// silently yields half a hash; a space in the name and a rename are what catch it.
    #[test]
    fn git_changed_names_every_dirty_path_and_says_how() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("edit me.txt"), "1\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "x\n").unwrap();
        std::fs::write(dir.join("old name.txt"), "same\n").unwrap();
        git(&dir, &["add", "-A"]);
        commit(&dir, "init");

        std::fs::write(dir.join("edit me.txt"), "1\n2\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::rename(dir.join("old name.txt"), dir.join("new name.txt")).unwrap();
        git(&dir, &["add", "-A"]); // a rename is only a rename once git can see both halves
        std::fs::write(dir.join("fresh file.txt"), "hi\n").unwrap();

        let rows = git_changed(path.clone());
        let by = |p: &str| rows.iter().find(|r| r.path == p).map(|r| r.status.clone());
        assert_eq!(by("edit me.txt").as_deref(), Some("M"), "spaces survive the field split: {rows:?}",
            rows = rows.iter().map(|r| (&r.path, &r.status)).collect::<Vec<_>>());
        assert_eq!(by("gone.txt").as_deref(), Some("D"));
        assert_eq!(by("fresh file.txt").as_deref(), Some("?"));
        // A rename is reported under its NEW name only.
        assert_eq!(by("new name.txt").as_deref(), Some("R"));
        assert!(by("old name.txt").is_none(), "the old name is not a file any more: {:?}",
            rows.iter().map(|r| &r.path).collect::<Vec<_>>());
        assert_eq!(rows.len(), 4);

        // A new folder is where `-unormal` collapsed to `? sub/`; every file inside must be named.
        std::fs::create_dir(dir.join("new dir")).unwrap();
        std::fs::write(dir.join("new dir").join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.join("new dir").join("b.txt"), "b\n").unwrap();
        let rows = git_changed(path.clone());
        let by = |p: &str| rows.iter().find(|r| r.path == p).map(|r| r.status.clone());
        assert_eq!(by("new dir/a.txt").as_deref(), Some("?"), "each file inside a new folder is named: {:?}",
            rows.iter().map(|r| &r.path).collect::<Vec<_>>());
        assert_eq!(by("new dir/b.txt").as_deref(), Some("?"));
        assert!(by("new dir/").is_none(), "the collapsed folder entry is not a row");

        // The index half of XY wins: staged as added, then edited, reads `A`.
        std::fs::write(dir.join("staged then edited.txt"), "1\n").unwrap();
        git(&dir, &["add", "staged then edited.txt"]);
        std::fs::write(dir.join("staged then edited.txt"), "1\n2\n").unwrap();
        let rows = git_changed(path.clone());
        let by = |p: &str| rows.iter().find(|r| r.path == p).map(|r| r.status.clone());
        assert_eq!(by("staged then edited.txt").as_deref(), Some("A"));

        // Not a repo: an empty list, not an error — the explorer still works there.
        let plain = scratch_dir();
        assert!(git_changed(plain.to_string_lossy().to_string()).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&plain);
    }

    /// The bounds that make the untracked scan safe on a 15s poll: a directory is never opened,
    /// a binary or oversized file adds nothing, and no skip stops the files after it.
    #[test]
    fn git_diffstat_bounds_what_it_reads_for_untracked_lines() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        git(&dir, &["add", "-A"]);
        commit(&dir, "init");

        // A whole untracked directory is one entry, never walked.
        std::fs::create_dir_all(dir.join("scratch")).unwrap();
        std::fs::write(dir.join("scratch/a.txt"), "1\n2\n3\n").unwrap();
        std::fs::write(dir.join("scratch/b.txt"), "4\n").unwrap();
        let d = git_diffstat(path.clone()).unwrap();
        assert_eq!((d.untracked, d.new_dirs), (1, 1), "a new folder is one entry, and is a folder");
        assert_eq!(d.added, 0, "a folder's contents are not line-counted");

        // No trailing newline still has a last line, as `git diff` reports; a binary has none.
        std::fs::write(dir.join("tail.txt"), "one\ntwo").unwrap();
        std::fs::write(dir.join("blob.bin"), [0x00, 0x01, 0x02, b'a', b'\n']).unwrap();
        std::fs::write(dir.join("empty.txt"), "").unwrap();
        let d = git_diffstat(path.clone()).unwrap();
        assert_eq!(d.added, 2, "2 lines from tail.txt, nothing from the binary or the empty file");
        assert_eq!((d.untracked, d.new_dirs), (4, 1), "all four entries still counted");

        // Over the size cap a file contributes nothing, and the others are unaffected.
        std::fs::write(dir.join("huge.txt"), "x\n".repeat((NEW_FILE_MAX as usize / 2) + 10)).unwrap();
        let d = git_diffstat(path.clone()).unwrap();
        assert_eq!(d.added, 2, "an oversized file adds nothing, and does not break the others");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A miss on numstat's rename spelling is silent: the file lists with no counts.
    #[test]
    fn numstat_path_reads_both_rename_spellings() {
        assert_eq!(numstat_path("src/plain.ts"), "src/plain.ts");
        assert_eq!(numstat_path("old name.txt => sub/new.txt"), "sub/new.txt");
        assert_eq!(numstat_path("src/{a.ts => b.ts}"), "src/b.ts");
        assert_eq!(numstat_path("src/{old => new}/leaf.ts"), "src/new/leaf.ts");
    }

    /// The buttons predict what git would reject and hand over the command that works instead.
    #[test]
    fn git_action_refuses_what_git_would_reject() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);
        commit(&dir, "base");

        // No upstream: pull says how to set one; push hands over the publishing decision.
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

        // A refusal is a result the UI can show; an Err is a call that makes no sense.
        assert!(git_action(path.clone(), "commit".into()).is_err(), "committing isn't a toolbar op");
        assert!(git_action(format!("{path}/gone"), "fetch".into()).is_err(), "missing workdir");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Against a real bare remote: fetch re-reads the gap, pull only fast-forwards, push only
    /// runs when it cannot be rejected, and a diverged branch gets a rebase handoff.
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

        // Someone else pushes; fetch must report the gap it just learned about.
        git(&other, &["clone", "-q", remote.to_str().unwrap(), "."]);
        commit(&other, "theirs");
        git(&other, &["push", "-q", "origin", "main"]);
        let r = git_action(path.clone(), "fetch".into()).unwrap();
        assert!(r.ok && r.summary == "fetched — 1 behind", "{}", r.summary);
        // Behind with nothing of our own: nothing to push, not a predicted rejection.
        let r = git_action(path.clone(), "push".into()).unwrap();
        assert!(r.ok && r.summary == "nothing to push", "{}", r.summary);
        let r = git_action(path.clone(), "pull".into()).unwrap();
        assert!(r.ok && r.summary == "pulled 1 commit", "{}", r.summary);

        // Diverged: neither ff-only nor push is attempted; the user gets the resolving command.
        commit(&dir, "local");
        commit(&other, "theirs 2");
        git(&other, &["push", "-q", "origin", "main"]);
        git(&dir, &["fetch", "-q", "origin"]);
        let r = git_action(path.clone(), "pull".into()).unwrap();
        assert!(!r.ok && r.summary.starts_with("diverged"), "{}", r.summary);
        assert_eq!(r.suggest.as_deref(), Some("git pull --rebase"));
        let r = git_action(path.clone(), "push".into()).unwrap();
        assert!(!r.ok && r.summary.starts_with("diverged"), "{}", r.summary);
        // NOT `git pull --ff-only && git push`, which fails one command after the button did.
        assert_eq!(r.suggest.as_deref(), Some("git pull --rebase && git push"));

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
        let _ = std::fs::remove_dir_all(&remote);
    }

    /// The command exists to page: `more` is an observation, the page stops at `limit`, and
    /// `skip` lands on the next commit.
    #[test]
    fn git_graph_pages_history_instead_of_reading_all_of_it() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);

        // Not a repo is an Err; no commits is an empty page. git is inconsistent here:
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

        // The last page reports nothing behind it.
        let last = git_graph(path.clone(), 4, 2, "all".into()).unwrap();
        assert_eq!(last.commits.len(), 1);
        assert!(!last.more, "c1 is the root — nothing behind it");
        assert!(last.commits[0].parents.is_empty(), "a root commit has no parents");

        // Past the end: an empty page, not an error.
        let past = git_graph(path.clone(), 99, 2, "all".into()).unwrap();
        assert!(past.commits.is_empty() && !past.more);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `parents` (the graph's shape) and `refs` (the chips), plus the delimiters: a subject
    /// with a tab must survive, hence \x1e records and NUL fields.
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

        let tabbed = p.commits.iter().find(|c| c.subject.contains('\t')).expect("tab subject survived");
        assert_eq!(tabbed.subject, "side\twork with\ttabs");

        // The layout matches on full shas, so a parent must never be abbreviated.
        let p2 = git_graph(path.clone(), 0, 5, "all".into()).unwrap();
        assert!(!p2.commits.is_empty());
        assert!(merge.parents.iter().all(|sha| sha.len() == merge.sha.len()));

        // `scope: "head"` shows the difference only on an unmerged branch.
        git(&dir, &["checkout", "-q", "-b", "unmerged"]);
        commit(&dir, "only on unmerged");
        git(&dir, &["checkout", "-q", "main"]);
        let all = git_graph(path.clone(), 0, 20, "all".into()).unwrap();
        let head = git_graph(path.clone(), 0, 20, "head".into()).unwrap();
        assert!(all.commits.iter().any(|c| c.subject == "only on unmerged"), "--all sees every ref");
        assert!(!head.commits.iter().any(|c| c.subject == "only on unmerged"), "head scope is the checkout alone");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Fetched one commit at a time so the multi-line body is never length-capped away.
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

        // Refused here rather than handed to git, where a leading dash reads as an option.
        for bad in ["--help", "HEAD", "main@{0}", "", "zzzz"] {
            assert!(git_commit_message(path.clone(), bad.to_string()).is_err(), "{bad} should be refused");
        }
        // Well-formed but unknown: git's own error, not a panic or an empty string.
        assert!(git_commit_message(path.clone(), "0".repeat(40)).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The picker's branch context: which branches are claimed, and how each stands against
    /// ITS OWN upstream, not against whatever HEAD happens to be.
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

        let bs = git_branch_list(dir.to_str().unwrap().to_string(), None);
        let by = |n: &str| bs.iter().find(|b| b.name == n).unwrap_or_else(|| panic!("{n} missing from {bs:?}"));

        // dev is both `current` and `checked_out`; the frontend hides it via `current`.
        assert!(by("dev").current, "dev should be current: {bs:?}");
        assert!(by("claimed").checked_out && !by("claimed").current, "claimed should be checked_out: {bs:?}");
        assert!(!by("pushed").current && !by("pushed").checked_out, "pushed should be free: {bs:?}");

        // Ahead is against origin/pushed, NOT dev, which has moved on its own.
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

    /// A remote-only branch is a destination too, and picking it must cut from the remote's
    /// tip and TRACK it, not mint a same-named stranger off HEAD.
    #[test]
    fn git_branch_list_offers_remote_only_branches_and_their_worktrees_track() {
        let dir = scratch_dir();
        let remote = scratch_dir();
        let theirs = scratch_dir();
        git(&remote, &["init", "-q", "--bare", "-b", "dev"]);
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&dir, &["push", "-q", "-u", "origin", "dev"]);

        // A colleague pushes from their own clone; these two exist only under refs/remotes.
        git(&theirs, &["clone", "-q", remote.to_str().unwrap(), "."]);
        git(&theirs, &["checkout", "-q", "-b", "their-feature"]);
        commit(&theirs, "their work");
        git(&theirs, &["push", "-q", "-u", "origin", "their-feature"]);
        git(&theirs, &["checkout", "-q", "-b", "nested/topic"]);
        commit(&theirs, "nested work");
        git(&theirs, &["push", "-q", "-u", "origin", "nested/topic"]);
        git(&dir, &["fetch", "-q", "origin"]);
        git(&dir, &["remote", "set-head", "origin", "dev"]);   // creates origin/HEAD

        let bs = git_branch_list(dir.to_str().unwrap().to_string(), None);
        let by = |n: &str| bs.iter().find(|b| b.name == n).unwrap_or_else(|| panic!("{n} missing from {bs:?}"));

        let f = by("their-feature");
        assert!(f.remote, "their-feature exists only on the remote: {bs:?}");
        assert_eq!(f.upstream, "origin/their-feature", "name is the local branch to create, upstream the ref it tracks: {bs:?}");
        assert!(!f.current && !f.checked_out, "a remote-only branch has no local checkout: {bs:?}");
        // A remote row's ahead/behind are against the REMOTE's default; `gone` stays false.
        assert!(!f.gone, "a remote row has no upstream to lose: {bs:?}");
        assert_eq!((f.ahead, f.behind), (1, 0), "one commit ahead of origin/dev: {bs:?}");
        assert_eq!(f.base, "origin/dev", "and it says what it was measured against: {bs:?}");

        // A slashed branch name must not be split at the first slash.
        assert_eq!(by("nested/topic").upstream, "origin/nested/topic", "{bs:?}");

        // dev has a local branch; origin/HEAD is a pointer, not a branch. git shortens that
        // ref to a bare `origin`, so both spellings are asserted.
        assert!(!by("dev").remote, "dev has a local branch: {bs:?}");
        assert!(!bs.iter().any(|b| b.name == "HEAD" || b.name == "origin"),
            "the remote's HEAD pointer is not a branch: {bs:?}");

        // Picking the row is `create_worktree(name, base = upstream)`.
        let path = create_worktree(dir.to_str().unwrap().to_string(), "their-feature".into(), Some("origin/their-feature".into()))
            .expect("worktree on a remote-only branch");
        let out = |args: &[&str]| String::from_utf8_lossy(
            &Command::new("git").current_dir(&path).args(args).output().unwrap().stdout
        ).trim().to_string();
        assert_eq!(out(&["rev-parse", "--abbrev-ref", "HEAD"]), "their-feature");
        assert_eq!(out(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]), "origin/their-feature",
            "the new branch must track the remote ref it was cut from");
        assert_eq!(out(&["log", "-1", "--format=%s"]), "their work",
            "it must hold THEIR commit, not a fresh branch off our HEAD");

        // And having become local, it must stop being offered as remote-only.
        let bs2 = git_branch_list(dir.to_str().unwrap().to_string(), None);
        let f2 = bs2.iter().find(|b| b.name == "their-feature").expect("still listed");
        assert!(!f2.remote && f2.checked_out, "it is a local, checked-out branch now: {bs2:?}");

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&theirs);
        let _ = std::fs::remove_dir_all(&remote);
    }
    /// Without a start-point `worktree add -b` cuts from HEAD; pin the `base` escape hatch.
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

    /// The broom deletes the merged-and-gone branches in one pass and refuses to take the
    /// caller's word for which those are.
    #[test]
    fn sweep_branches_deletes_only_what_git_still_calls_gone() {
        let dir = scratch_dir();
        let remote = scratch_dir();
        git(&remote, &["init", "-q", "--bare", "-b", "dev"]);
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&dir, &["push", "-q", "-u", "origin", "dev"]);

        // Push a branch, then delete it on the remote — the state the broom exists for.
        let orphan = |name: &str, extra: bool| {
            git(&dir, &["checkout", "-q", "-b", name]);
            git(&dir, &["push", "-q", "-u", "origin", name]);
            if extra { commit(&dir, "unpushed"); }
            git(&dir, &["push", "-q", "origin", "--delete", name]);
            git(&dir, &["checkout", "-q", "dev"]);
        };
        orphan("gone-merged", false);    // merged into dev: -d takes it
        orphan("gone-ahead", true);      // has a commit dev doesn't: -d refuses
        orphan("gone-held", false);      // gone, but a worktree holds it
        orphan("gone-alive", false);
        git(&dir, &["push", "-q", "-u", "origin", "gone-alive"]);   // …pushed again since
        git(&dir, &["fetch", "-q", "--prune", "origin"]);
        git(&dir, &["branch", "never-pushed"]);                     // no upstream at all
        let wt = dir.join("wt-held");
        git(&dir, &["worktree", "add", "-q", wt.to_str().unwrap(), "gone-held"]);

        let repo = dir.to_str().unwrap().to_string();
        let asked = ["gone-merged", "gone-ahead", "gone-held", "gone-alive", "never-pushed"];
        // The broom's own call: every pick claims `gone`, none may force.
        let pick = |n: &str| SweepPick { branch: n.into(), gone: true, force: false };
        let r = sweep_branches(repo.clone(), asked.iter().map(|n| pick(n)).collect()).expect("sweep runs");

        assert_eq!(r.deleted.iter().map(|d| d.branch.as_str()).collect::<Vec<_>>(), ["gone-merged"],
            "only the merged-and-gone branch goes: {r:?}");
        assert!(!r.deleted[0].forced, "the safe delete took it — nothing was forced: {r:?}");
        assert!(r.deleted[0].sha.len() >= 7, "git's (was <sha>) is the recovery hint: {r:?}");
        // Every name is accounted for — nothing may silently fall out of the count.
        assert_eq!(r.deleted.len() + r.kept.len(), asked.len(), "all five reported: {r:?}");
        let why = |n: &str| r.kept.iter().find(|k| k.branch == n).unwrap_or_else(|| panic!("{n} missing from {r:?}"));
        assert!(why("gone-ahead").forceable, "git's refusal is what -D answers: {r:?}");
        assert!(why("gone-ahead").reason.contains("not fully merged"), "git's own words: {r:?}");
        assert!(!why("gone-held").forceable && why("gone-held").reason.contains("worktree"),
            "a held branch is refused with or without -D: {r:?}");
        assert!(!why("gone-alive").forceable, "re-pushed since the caller looked: {r:?}");
        assert!(!why("never-pushed").forceable, "never had an upstream to lose: {r:?}");
        // The force handoff covers exactly the branches a -D would actually help.
        let s = r.suggest.as_deref().unwrap_or("");
        assert!(s.contains("branch -D") && s.contains("\"gone-ahead\""), "force handed off: {r:?}");
        assert!(!s.contains("gone-held") && !s.contains("gone-alive"), "and only where it applies: {r:?}");

        let live = String::from_utf8_lossy(&Command::new("git").current_dir(&dir)
            .args(["branch", "--format=%(refname:short)"]).output().unwrap().stdout).to_string();
        assert!(!live.contains("gone-merged"), "gone-merged should be deleted: {live}");
        for n in ["gone-ahead", "gone-held", "gone-alive", "never-pushed", "dev"] {
            assert!(live.contains(n), "{n} must survive the sweep: {live}");
        }

        // An empty ask is a caller bug, not a licence to sweep everything it can find.
        assert!(sweep_branches(repo, vec![]).is_err(), "an empty list is refused");

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote);
    }

    /// The deep-clean pane's extra powers: a pick without a `gone` claim still deletes, and a
    /// per-branch `force` escalates to `-D`, but a worktree's claim beats a force.
    #[test]
    fn sweep_branches_forces_only_where_the_caller_asked_and_never_over_a_worktree() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        let repo = dir.to_str().unwrap().to_string();

        git(&dir, &["branch", "plain-merged"]);          // merged into dev, no remote at all
        git(&dir, &["checkout", "-q", "-b", "squashed"]); // stands in for a squash-merged PR
        commit(&dir, "work that landed under another sha");
        git(&dir, &["checkout", "-q", "-b", "kept-back"]);
        commit(&dir, "unmerged, and nobody vouched for it");
        git(&dir, &["checkout", "-q", "dev"]);
        git(&dir, &["branch", "held"]);
        let wt = dir.join("wt-held");
        git(&dir, &["worktree", "add", "-q", wt.to_str().unwrap(), "held"]);

        let r = sweep_branches(repo, vec![
            SweepPick { branch: "plain-merged".into(), gone: false, force: false },
            SweepPick { branch: "squashed".into(), gone: false, force: true },
            SweepPick { branch: "kept-back".into(), gone: false, force: false },
            SweepPick { branch: "held".into(), gone: false, force: true },
        ]).expect("sweep runs");

        let got = |n: &str| r.deleted.iter().find(|d| d.branch == n);
        assert!(got("plain-merged").is_some_and(|d| !d.forced),
            "a merged branch needs no gone claim and no force: {r:?}");
        assert!(got("squashed").is_some_and(|d| d.forced && !d.sha.is_empty()),
            "the force applies where it was asked, with a sha to undo it: {r:?}");
        let why = |n: &str| r.kept.iter().find(|k| k.branch == n).unwrap_or_else(|| panic!("{n} missing from {r:?}"));
        assert!(why("kept-back").forceable, "unmerged and unvouched-for: kept, -D offered: {r:?}");
        assert!(why("held").reason.contains("worktree"), "a force never overrides a checkout: {r:?}");

        let live = String::from_utf8_lossy(&Command::new("git").current_dir(&dir)
            .args(["branch", "--format=%(refname:short)"]).output().unwrap().stdout).to_string();
        assert!(live.contains("kept-back") && live.contains("held"), "both survive: {live}");
        assert!(!live.contains("squashed"), "the forced one is gone: {live}");

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Remote rows carry what GitHub's branches view shows, measured against the REMOTE's
    /// default, never local HEAD.
    #[test]
    fn git_branch_list_measures_remote_branches_against_the_remotes_default() {
        let dir = scratch_dir();
        let remote = scratch_dir();
        let theirs = scratch_dir();
        git(&remote, &["init", "-q", "--bare", "-b", "main"]);
        git(&dir, &["init", "-q", "-b", "main"]);
        let commit = |dir: &Path, who: &str, msg: &str| git(dir, &[
            "-c", &format!("user.email={who}@example.com"), "-c", &format!("user.name={who}"),
            "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg,
        ]);
        commit(&dir, "Us", "base");
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&dir, &["push", "-q", "-u", "origin", "main"]);

        git(&theirs, &["clone", "-q", remote.to_str().unwrap(), "."]);
        // Merged into main and pushed: main moves on, so this ends up 0 ahead / 1 behind.
        git(&theirs, &["checkout", "-q", "-b", "theirs-landed"]);
        commit(&theirs, "Ada", "landed work");
        git(&theirs, &["push", "-q", "-u", "origin", "theirs-landed"]);
        git(&theirs, &["checkout", "-q", "main"]);
        git(&theirs, &["merge", "-q", "--ff-only", "theirs-landed"]);
        commit(&theirs, "Ada", "one more on main");
        git(&theirs, &["push", "-q", "origin", "main"]);
        // Still in flight: 2 commits main doesn't have.
        git(&theirs, &["checkout", "-q", "-b", "theirs-wip"]);
        commit(&theirs, "Grace", "wip 1");
        commit(&theirs, "Grace", "wip 2");
        git(&theirs, &["push", "-q", "-u", "origin", "theirs-wip"]);

        git(&dir, &["fetch", "-q", "origin"]);
        git(&dir, &["remote", "set-head", "origin", "main"]);

        let bs = git_branch_list(dir.to_str().unwrap().to_string(), None);
        let by = |n: &str| bs.iter().find(|b| b.name == n).unwrap_or_else(|| panic!("{n} missing from {bs:?}"));

        let landed = by("theirs-landed");
        assert!(landed.remote && landed.base == "origin/main", "measured against the remote's default: {bs:?}");
        assert_eq!((landed.ahead, landed.behind), (0, 1), "contained in main, and main has moved on: {bs:?}");
        assert!(landed.merged, "nothing on it that main lacks — that is what makes it deletable: {bs:?}");
        assert_eq!(landed.author, "Ada", "the tip commit's author is who the row is about: {bs:?}");

        let wip = by("theirs-wip");
        assert_eq!((wip.ahead, wip.behind), (2, 0), "two commits main doesn't have: {bs:?}");
        assert!(!wip.merged, "unmerged work is never offered for deletion: {bs:?}");
        assert_eq!(wip.author, "Grace", "{bs:?}");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote);
        let _ = std::fs::remove_dir_all(&theirs);
    }

    /// The guards on the one write that changes things for other people: the default branch
    /// is untouchable, a moved ref is refused, and every delete returns its restoring sha.
    #[test]
    fn delete_remote_branches_guards_the_default_and_refuses_a_stale_reading() {
        let dir = scratch_dir();
        let remote = scratch_dir();
        let theirs = scratch_dir();
        git(&remote, &["init", "-q", "--bare", "-b", "main"]);
        git(&dir, &["init", "-q", "-b", "main"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&dir, &["push", "-q", "-u", "origin", "main"]);
        for b in ["landed", "moved", "vanished"] {
            git(&dir, &["push", "-q", "origin", &format!("main:refs/heads/{b}")]);
        }
        git(&dir, &["fetch", "-q", "origin"]);
        git(&dir, &["remote", "set-head", "origin", "main"]);

        let sha = |b: &str| String::from_utf8_lossy(&Command::new("git").current_dir(&dir)
            .args(["rev-parse", &format!("refs/remotes/origin/{b}")]).output().unwrap().stdout).trim().to_string();
        let landed_sha = sha("landed");
        let stale = sha("moved");

        // Someone else pushes to `moved` and deletes `vanished` after our list was read.
        git(&theirs, &["clone", "-q", remote.to_str().unwrap(), "."]);
        git(&theirs, &["checkout", "-q", "-b", "moved", "origin/moved"]);
        commit(&theirs, "their new commit");
        git(&theirs, &["push", "-q", "origin", "moved"]);
        git(&theirs, &["push", "-q", "origin", "--delete", "vanished"]);
        git(&dir, &["fetch", "-q", "--prune", "origin"]);

        let repo = dir.to_str().unwrap().to_string();
        let pick = |b: &str, s: &str| RemotePick { branch: b.into(), sha: s.into() };
        let r = delete_remote_branches(repo.clone(), "origin".into(), vec![
            pick("landed", &landed_sha),
            pick("moved", &stale),
            pick("vanished", &landed_sha),
            pick("main", &landed_sha),
        ]).expect("call returns");

        assert_eq!(r.deleted.iter().map(|d| d.branch.as_str()).collect::<Vec<_>>(), ["landed"],
            "only the branch that still matched its reading goes: {r:?}");
        assert_eq!(r.deleted[0].sha, landed_sha, "the sha that restores it comes back: {r:?}");
        let why = |n: &str| r.kept.iter().find(|k| k.branch == n).unwrap_or_else(|| panic!("{n} missing from {r:?}"));
        assert!(why("moved").reason.contains("moved since"), "a ref that moved is refused: {r:?}");
        assert!(why("vanished").reason.contains("deleted it already"), "{r:?}");
        assert!(why("main").reason.contains("default branch"), "the default is refused whatever we're asked: {r:?}");
        assert!(r.suggest.is_none(), "a remote refusal has no flag that fixes it: {r:?}");

        let left = String::from_utf8_lossy(&Command::new("git").current_dir(&remote)
            .args(["branch", "--format=%(refname:short)"]).output().unwrap().stdout).to_string();
        assert!(!left.contains("landed"), "landed should be gone from the remote: {left}");
        assert!(left.contains("main") && left.contains("moved"), "both survive: {left}");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote);
        let _ = std::fs::remove_dir_all(&theirs);
    }

    /// `merged` must mean exactly "already contained in the trunk": never the current branch
    /// itself (which `git branch --merged` lists), and never a squash-merge.
    #[test]
    fn git_branch_list_marks_branches_contained_in_head() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        git(&dir, &["branch", "contained"]);
        git(&dir, &["checkout", "-q", "-b", "ahead-of-dev"]);
        commit(&dir, "not in dev");
        git(&dir, &["checkout", "-q", "dev"]);

        let bs = git_branch_list(dir.to_str().unwrap().to_string(), None);
        let by = |n: &str| bs.iter().find(|b| b.name == n).unwrap_or_else(|| panic!("{n} missing from {bs:?}"));
        assert!(by("contained").merged, "every commit is already in dev: {bs:?}");
        assert!(!by("ahead-of-dev").merged, "it has a commit dev doesn't: {bs:?}");
        assert!(!by("dev").merged, "the current branch is not a cleanup candidate: {bs:?}");
        assert_eq!(by("contained").base, "dev", "with no remote, the trunk is the checkout: {bs:?}");

        // A named base moves the whole question: a repo parked on a feature branch.
        let named = git_branch_list(dir.to_str().unwrap().to_string(), Some("ahead-of-dev".into()));
        let by2 = |n: &str| named.iter().find(|b| b.name == n).unwrap_or_else(|| panic!("{n} missing from {named:?}"));
        assert!(by2("contained").merged, "still contained, now measured against the named base: {named:?}");
        assert_eq!(by2("contained").base, "ahead-of-dev", "the row says what it was measured against: {named:?}");
        // Neither the trunk nor the checkout may come back as a cleanup candidate.
        assert!(!by2("ahead-of-dev").merged, "the base is never a candidate for deletion: {named:?}");
        assert!(!by2("dev").merged, "nor is the checked-out branch: {named:?}");

        // An unresolvable base is ignored rather than obeyed into "nothing to clean".
        let bogus = git_branch_list(dir.to_str().unwrap().to_string(), Some("no-such-ref".into()));
        assert_eq!(bogus.iter().find(|b| b.name == "contained").map(|b| b.base.as_str()), Some("dev"),
            "falls back to the real trunk: {bogus:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The "New branch" field has always taken existing ones; pin the attach path.
    #[test]
    fn create_worktree_attaches_an_existing_branch() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
        git(&dir, &["branch", "test"]);

        let path = create_worktree(dir.to_str().unwrap().to_string(), "test".into(), None).expect("attach failed");
        let head = Command::new("git").current_dir(&path).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "test");

        // The source repo must be undisturbed: a second checkout, not a switch.
        let orig = Command::new("git").current_dir(&dir).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&orig.stdout).trim(), "dev");

        // Worktrees land in a *sibling* .cc-worktrees tree, never inside the repo.
        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `list_worktrees` must flag what is safe to remove, and `remove_worktree_impl` must never
    /// force: safe-delete a merged branch, keep an unmerged one, refuse a dirty tree.
    #[test]
    fn worktree_cleanup_flags_and_safe_removal() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        let commit = |dir: &Path, msg: &str| git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
        commit(&dir, "base");
        let repo = dir.to_str().unwrap().to_string();

        // One at dev's tip (merged, clean), one past it (unmerged), one with an untracked file.
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

    /// Two states git handles badly on its own: a LOCKED worktree (refused even with --force)
    /// and a hand-deleted folder (`prune` is what git wants).
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

        // A hand-deleted folder leaves the listing whichever way git gets there (modern git
        // exits 0, older gits hit `still_registered`). Assert the outcome, not the route.
        let r = remove_worktree_impl(&repo, &gone, "gone-wt", false).expect("call returns");
        assert!(r.ok, "a vanished worktree should remove cleanly: {r:?}");
        assert!(r.stranded.is_none(), "nothing is on disk to strand: {r:?}");
        assert!(!list_worktrees(repo.clone()).iter().any(|w| w.branch == "gone-wt"),
            "gone-wt should be out of the listing");

        git(&dir, &["worktree", "unlock", &locked]);
        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `git worktree remove` deletes the folder first, unregisters second, and carries on past
    /// a failed delete, so on Windows a held folder leaves the worktree gone from git with its
    /// directory still on disk. The three assertions are the three halves of the answer: not a
    /// refusal, no force command, and the leftover named. POSIX unlinks under holders; Windows-only.
    #[cfg(windows)]
    #[test]
    fn a_worktree_whose_folder_is_held_is_removed_not_refused() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ_WRITE: u32 = 0x0000_0001 | 0x0000_0002;

        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "dev"]);
        // The checkout needs a file to hold; a repo of empty commits has none.
        std::fs::write(dir.join("keep.txt"), "content\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false",
                    "commit", "-q", "-m", "base"]);
        let repo = dir.to_str().unwrap().to_string();
        let wt = create_worktree(repo.clone(), "held-wt".into(), None).expect("held worktree");

        // Not `share_mode(0)`: that also blocks git's own read, so it refuses the tree as dirty
        // and never reaches the delete. READ|WRITE without DELETE is an editor's handle.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ_WRITE) // no FILE_SHARE_DELETE — the whole point
            .open(Path::new(&wt).join("keep.txt"))
            .expect("hold a file in the checkout");

        let r = remove_worktree_impl(&repo, &wt, "held-wt", false).expect("call returns");
        assert!(r.ok, "the worktree IS removed — reporting a refusal is the bug: {r:?}");
        assert!(r.suggest.is_none(), "--force cannot work once git has unregistered it: {r:?}");
        let s = r.stranded.as_ref().expect("the folder is still on disk, and must be reported");
        assert!(!s.reason.is_empty(), "the OS's own reason travels with it: {s:?}");
        assert!(Path::new(&wt).exists(), "the folder really is still there");
        assert!(!list_worktrees(repo.clone()).iter().any(|w| w.branch == "held-wt"),
            "git has already unregistered it — that is what makes --force fail");

        // Released, the repair goes through with nothing to kill.
        drop(held);
        let p = purge_worktree_folder(wt.clone(), vec![]).expect("purge returns");
        assert!(p.gone && p.stranded.is_none(), "an unheld folder purges cleanly: {p:?}");
        assert!(!Path::new(&wt).exists(), "the folder should be gone now");

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `purge_worktree_folder` deletes a tree and kills processes, so it must never accept a
    /// path shallow enough to be somebody's whole drive. The depth rule is crude on purpose.
    #[test]
    fn purge_refuses_a_top_level_path() {
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(purge_worktree_folder(root.to_string(), vec![]).is_err(), "a drive root must be refused");
        // A missing path is the outcome being asked for, not an error.
        let missing = scratch_dir().join("never-created");
        let r = purge_worktree_folder(missing.to_string_lossy().to_string(), vec![]).expect("call returns");
        assert!(r.gone, "nothing to delete counts as gone: {r:?}");
    }

    /// NUL-separated parsing, so a subject with spaces survives.
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
