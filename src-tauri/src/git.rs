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
//   a live embedded session in it is refused rather than deleted. The two ask
//   different questions of that map, because they cost different things: removal
//   deletes the folder, so *any* pane there stops it; a switch only moves HEAD under
//   panes that survive it, so only work in flight does (`blocks_switch`).
//
// `git_cmd`/`git_run` are git-only and live here; they call down into
// `platform::{sys_command, augmented_path}`, which is why platform.rs had to move
// out first. `same_path` came here too — one consumer module, so it belongs to it.


use std::collections::HashMap;
use std::sync::Mutex;

use tauri::State;

use crate::platform::{
    augmented_path, kill_pid_tree, norm_path, path_holders, physical_cwd, remove_tree, sys_command,
    PathHolder,
};
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

    // A start-point that IS a remote-tracking ref means "check out what's on the remote",
    // so the branch we cut must follow it: without an upstream, `git push`/`git pull` in
    // the new worktree need arguments, and the picker's ahead/behind for it reads empty
    // forever. Git already does this when `branch.autoSetupMerge` is at its default —
    // which is exactly why it must be said outright, since a user who turned that off
    // would otherwise get a silently untracked branch. Detected rather than passed as a
    // flag so the rule holds for any caller, and so `base` keeps its one meaning.
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

/// One checkout as seen by `worktree_heads` — the cheap, spawn-free half of
/// `list_worktrees`. Deliberately carries only what can be answered from files.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct WorktreeHead {
    /// The checkout directory, in the same physical spelling `repo_root_of` uses.
    path: String,
    /// Branch name, or "(detached)" when HEAD holds a raw sha.
    branch: String,
    is_main: bool,
    /// The checkout dir is still on disk. A hand-deleted folder stays registered under
    /// `.git/worktrees` until pruned, so this mirrors `Worktree::exists`.
    exists: bool,
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

/// Every checkout of `dir`'s repo and the branch each has on HEAD — read straight off
/// the filesystem, with **no `git` process at all**.
///
/// This is the cheap counterpart to `list_worktrees`, and it exists because the sidebar
/// wants to notice a new worktree *continuously*, not when a dialog is opened.
/// `list_worktrees` costs a `status --porcelain` per checkout plus a `merge-base` per
/// branch — right for a picker, far too heavy to poll across every open project. The
/// facts here come from three files per worktree:
///
/// ```text
/// <root>/.git/HEAD                      → the main worktree's branch
/// <root>/.git/worktrees/<n>/gitdir      → …/<checkout>/.git, whose parent is the checkout
/// <root>/.git/worktrees/<n>/HEAD        → that checkout's branch
/// ```
///
/// Two things this must not get wrong. `<n>` is git's bookkeeping name and does **not**
/// have to match the checkout's folder name (`worktrees/board` can own `…/feat-board`),
/// so the path comes from `gitdir` and never from the directory name. And every path is
/// run through `physical_cwd`, for the reason spelled out on `repo_root_of`: git writes
/// an already-resolved path into `gitdir`, so an unresolved one derived here would be a
/// *second spelling of the same checkout*, and the sidebar groups by exact string
/// equality — one worktree would render as two.
///
/// The result doubles as a change stamp: the caller compares it to its previous copy and
/// only reaches for the expensive `list_worktrees` when it actually moved.
#[tauri::command(async)]
pub(crate) fn worktree_heads(dir: String) -> Vec<WorktreeHead> {
    // repo_root_of already resolves both `.git` shapes (dir and `gitdir:` file) from a
    // physical starting point, so asking it is what keeps this in step with every other
    // root in the app — including when called from inside a linked worktree.
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
        // One side is gone — which is not an edge case here but the main event: a
        // removed worktree is exactly a path that no longer resolves. With nothing to
        // canonicalize against, compare the canonical *spelling* rather than the raw
        // strings. Every path the frontend sends and every path git prints has been
        // through `norm_path` already, so this changes no answer today; it stops the
        // one caller that forgets from failing on a forward slash alone, and off
        // Windows it is the identity this always was.
        _ => norm_path(a) == norm_path(b),
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
            ..Default::default()
        });
    }

    let out = git_run(git_cmd(repo_dir, &["worktree", "remove", path]), 30)?;
    if !out.status.success() {
        // **A non-zero exit does NOT mean nothing happened**, and assuming it did is
        // the bug this branch exists to answer. `git worktree remove` deletes the
        // checkout directory first and unregisters it second, and git's own source
        // continues past a failed delete because "there's no going back from here" —
        // so a folder it could not remove (Windows: any process holding it) leaves the
        // worktree *already unregistered* and exit 255. Reporting that as a refusal
        // and handing over `--force` produced the one command guaranteed to fail:
        // `fatal: '<path>' is not a working tree`.
        //
        // So ask the only question that separates the two states. Note this is asked
        // even when the folder is gone: a hand-deleted checkout also lands here on
        // older gits (newer ones exit 0 and never reach this), and "not registered
        // any more" covers both without a second special case.
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

/// Everything that follows a worktree leaving git's records, shared by the clean exit
/// and the partial one — because from here they are the same situation: the worktree
/// is gone, and what is left is a folder that may or may not still be on disk and a
/// branch that may or may not be worth deleting.
fn finish_removal(
    repo_dir: &str,
    path: &str,
    branch: &str,
    delete_branch: bool,
    label: &str,
) -> Result<GitActionResult, String> {
    let stranded = ensure_folder_gone(path);

    // Best-effort: drop the now-empty `.cc-worktrees/<repo>/` parent so the sibling
    // tree doesn't accumulate empty dirs. `remove_dir` only succeeds when empty, which
    // is also the whole guard — a checkout the user put somewhere of their own has a
    // parent full of their things, and this cannot touch it. Skipped while the folder
    // is stranded, when the parent is by definition not empty.
    if stranded.is_none() {
        if let Some(parent) = std::path::Path::new(path).parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }

    let mut res = if delete_branch && !branch.is_empty() && branch != "(detached)" {
        // Safe-delete only: `git branch -d` refuses an unmerged branch. If it does,
        // the worktree is already gone — report success and offer the force command.
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
        // `ok` stays true, and that is the honest answer rather than a convenient one:
        // the worktree IS removed, the roster HAS changed, and the caller must refresh
        // exactly as it would on a clean run. What is left is a directory — a separate
        // problem, carried in a separate field, with its own repair.
        res.summary = format!("Removed {label} — its folder is still on disk");
        res.suggest = None;
        res.stranded = Some(s);
    }
    Ok(res)
}

/// Is `path` still one of `repo_dir`'s worktrees? The question `remove_worktree_impl`
/// has to ask after a failure, and deliberately a fresh listing rather than a re-use
/// of the one taken at the top — the whole point is that git may have changed it.
///
/// Unknown counts as *still registered*: if the listing itself failed we have learned
/// nothing, and the old behaviour (report git's refusal, offer the force command) is
/// the right thing to fall back to.
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
    /// The checkout directory still on disk.
    path: String,
    /// The first path inside it that refused — what the holder probe was run against.
    stuck: String,
    /// The OS's own reason, for the debug log and for the case with no holders at all.
    reason: String,
    holders: Vec<PathHolder>,
}

/// Delete the checkout directory, and if it won't go, say who is keeping it.
///
/// Retried before anything is reported, because the commonest holder by far is a
/// process that was asked to die moments ago and whose handles outlive the signal by
/// milliseconds — an answer worth having before the UI says a word. Deliberately short
/// and bounded: past a second this is no longer a race, it is somebody's editor.
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

/// The outcome of a purge attempt: whether the folder went, and if not, the refreshed
/// picture of what is still holding it.
#[derive(serde::Serialize, Debug, Default)]
pub(crate) struct PurgeResult {
    gone: bool,
    stranded: Option<Stranded>,
}

/// Second half of a stranded removal: terminate the processes named in `kill`, then
/// try the folder again. Only ever reached from a `Stranded` the app just produced.
///
/// Two guards, and neither is ceremony. **The holders are re-probed before anything is
/// killed**, and only a pid still holding this folder is touched — the list came from
/// an earlier answer, pids are reused, and killing a stale one means killing whatever
/// inherited its number. And the path must be at least two levels deep, so a bug that
/// arrives here with a drive root or a bare `C:\foo` deletes nothing.
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
    // A tree kill is still only a signal; `ensure_folder_gone` retries, which is what
    // actually covers the gap between the kill returning and the handles closing.
    let after = ensure_folder_gone(&path);
    Ok(PurgeResult { gone: after.is_none(), stranded: after })
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

/// Whether a live pane of this `Session::kind` alone forbids switching its folder's
/// branch. The kind is all the backend has — the phase that decides it for a claude
/// pane never leaves the frontend — so this answers only where the kind is enough:
///
/// - `task` — yes, unconditionally. It is running (an exited one is no longer in the
///   map), and a build that starts on one branch and finishes on another is worthless.
/// - `shell` — no. It is the user's own prompt; refusing `git switch` on behalf of the
///   pane that exists to accept it is the app arguing with itself.
/// - `claude` — no *here*. Mid-turn is a real blocker and the frontend refuses it
///   (`midFlight` in src/types.ts); idle is not, and this layer cannot tell them apart.
fn blocks_switch(kind: &str) -> bool {
    kind == "task"
}

/// The `git switch` invocation for a target, paired with the terminal handoff for it.
///
/// One function because they are one decision and they must not disagree: a dirty tree
/// hands `suggest` over verbatim, and for a remote-only target `git switch <branch>`
/// resolves to something else entirely — or to nothing. `track` is `Some(remote_ref)`
/// only when the branch has no local ref *and* that remote ref is real, which is what
/// makes `base` safe for the caller to pass unconditionally.
fn switch_args<'a>(branch: &'a str, track: Option<&'a str>) -> (Vec<&'a str>, String) {
    match track {
        // `--track` outright rather than leaning on git's DWIM: the guess only happens
        // while `checkout.guess` and `branch.autoSetupMerge` are at their defaults, and a
        // user who turned either off would get a branch with no upstream — after which
        // push/pull need arguments and the picker's ahead/behind reads empty forever.
        Some(b) => (
            vec!["switch", "--track", "-c", branch, b],
            format!("git switch --track -c \"{branch}\" \"{b}\""),
        ),
        None => (vec!["switch", branch], format!("git switch \"{branch}\"")),
    }
}

/// Move the repo's main working tree to another branch.
///
/// Episko's whole model is "don't switch, branch out" — worktrees exist so two pieces
/// of work never fight over one checkout. But the root folder's branch is also the
/// default parent of every new worktree, so a root parked somewhere stale is a real
/// problem, and a terminal was the only way out. This is that lever, with the guards
/// that make it safe to expose:
///
/// - Refused while a **task** pane runs in the root — see `blocks_switch` above.
/// - Refused when the target is checked out in another worktree (git refuses too, but
///   this says which one).
/// - Refused on a dirty tree. `git switch` would silently CARRY uncommitted changes to
///   the new branch — not destructive, but a state change the UI never explained, which
///   is the same rule `git_action` and `remove_worktree` follow. Handed to a terminal.
///
/// `base` is the remote-tracking ref a **remote-only** target should be cut from
/// ("origin/foo"), and it is the same parameter `create_worktree` takes, with the same
/// meaning and the same `--track` detection. A colleague's branch is a destination you'd
/// want the root to move to as readily as a worktree, and the alternative was a terminal
/// and two commands. Ignored when the branch already exists locally.
///
/// The first guard used to be "any session at all", and that made the lever unreachable
/// in the one situation it exists for: a root folder you keep an agent parked in. What
/// actually must not move is a tree with *work in flight* on it, which is a question
/// about a pane's state — and a claude pane's phase lives only in the frontend, so
/// `midFlight` owns that half and `blocks_switch` owns the half the backend can see.
/// Two things keep the split honest rather than merely trusting: a task's whole life is
/// visible here (the reaper drops a session from the map the moment its PTY exits, so a
/// `task` in the map IS a running one), and the dirty-tree refusal below independently
/// catches any agent that has written a byte, whatever the frontend believed.
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

    // Cutting a local branch from a remote-tracking ref, the same detection
    // `create_worktree` makes and for the same reason: without `--track`, `git push` and
    // `git pull` in the switched-to folder need arguments and the picker's ahead/behind
    // reads empty forever. Git's own DWIM would usually do this, but only while
    // `checkout.guess` and `branch.autoSetupMerge` are at their defaults — a user who
    // turned either off would get a silently untracked branch, so it is said outright.
    //
    // Conditioned on the branch NOT existing locally, which is what makes `base` safe to
    // pass unconditionally: the switch target may have grown a local ref since the list
    // was read (a colleague's branch you fetched in a terminal), and the answer to that
    // is to switch to the branch, not to fail on `-c`.
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

/// How many branches the picker will ever deal with at once: `git_branch_list` caps its
/// list here (a repo with hundreds of refs can't blow the dialog up) and the sweep caps
/// what it will act on to match, so the button can never be asked to do more than the
/// list it lives in can show.
const BRANCH_LIST_CAP: usize = 80;

/// One branch the picker asks the sweep to delete.
///
/// Two claims travel with the name, and the difference between them is the whole safety
/// model of this command:
///
/// - **`gone`** is a claim about the world that this command can and does re-check. The
///   dialog's list is a reading from up to a minute old (it refreshes on window focus and
///   after a fetch, no more often), so a branch pushed again from a terminal since then is
///   no longer the branch anyone asked to delete. Claim it and git disagrees → skipped.
/// - **`force`** is a claim about *evidence*, and nothing local can check it. It exists
///   for the one case the safe delete gets wrong in both directions: a **squash**-merged
///   pull request. Its commits never became ancestors of the main branch, so `git branch
///   -d` refuses a branch whose work is demonstrably shipped — and the only thing that
///   knows it shipped is the merged PR the deep-clean pane read from `gh`. So `-D` is
///   available, but only ever per-branch, only when the caller showed that evidence on
///   the row, and never as a blanket setting.
#[derive(serde::Deserialize, Debug)]
pub(crate) struct SweepPick {
    branch: String,
    /// The caller saw this branch's upstream as deleted; re-derived here before acting.
    #[serde(default)]
    gone: bool,
    /// Escalate to `git branch -D` if the safe delete refuses. See above.
    #[serde(default)]
    force: bool,
}

/// One branch the sweep deleted. The sha is git's own "(was 1a2b3c4)" — kept because a
/// forced delete is the one action here with no undo button, and `git branch <name> <sha>`
/// is one: naming the sha in the result turns "recoverable in principle, via a reflog
/// nobody reads" into a line the user can act on.
#[derive(serde::Serialize, Debug)]
pub(crate) struct DeletedBranch {
    branch: String,
    sha: String,
    /// It took `-D` — the safe delete had refused it.
    forced: bool,
}

/// One branch the sweep did not delete, and why — git's own first line when it
/// refused, our words when we never asked it. `forceable` splits those two: a `-D`
/// is an answer to "not fully merged" and no answer at all to "some worktree holds
/// it" (git refuses that with or without the force), so only the first kind goes
/// into the handoff command.
#[derive(serde::Serialize, Debug)]
pub(crate) struct KeptBranch {
    branch: String,
    reason: String,
    forceable: bool,
}

/// What one sweep did. `deleted` and `kept` together account for every name the
/// caller passed — a sweep that quietly did less than it was asked is the failure
/// mode this shape exists to prevent.
#[derive(serde::Serialize, Debug)]
pub(crate) struct SweepResult {
    deleted: Vec<DeletedBranch>,
    kept: Vec<KeptBranch>,
    /// A single `git branch -D` over everything git's safe delete refused and that no
    /// evidence justified forcing, for the same terminal handoff `delete_branch` offers.
    /// `None` when nothing refused.
    suggest: Option<String>,
    /// One line for the toast.
    summary: String,
}

/// Delete a batch of local branches — the picker's broom, and the engine under its
/// deep-clean pane.
///
/// The bulk counterpart to `delete_branch`, and it keeps that command's shape: `git
/// branch -d` decides, and what it refuses comes back as a `-D` command for a terminal
/// rather than being run. What is safe one branch at a time is not automatically safe
/// times ten, so the one exception — a per-branch `force` backed by a merged pull request
/// — is spelled out on `SweepPick` and never inferred here.
///
/// Two things this never touches, whatever it is asked: a branch some worktree holds (git
/// refuses that with or without a force, and the checkout is a separate decision with its
/// own flow), and a branch whose `gone` claim git no longer agrees with. Both come back in
/// `kept` with their reason rather than vanishing from the count.
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

    // The same read `git_branch_list` derives its `gone` flag from, and the only
    // authority on it. Gated on refs/remotes for the same reason: `branch.autoSetupMerge`
    // can make one LOCAL branch another's upstream, and deleting because a local upstream
    // went away is a different rule than the one the button offers.
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

    // Same guard as `delete_branch`, read the cheap way: one porcelain listing rather
    // than `list_worktrees` (a status probe per checkout) once per branch.
    let taken: std::collections::HashSet<String> =
        match git_run(git_cmd(&repo_dir, &["worktree", "list", "--porcelain"]), 15) {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.strip_prefix("branch "))
                .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string())
                .collect(),
            // Unreadable means "assume nothing is held" — git still refuses a held
            // branch itself, and that refusal lands in `kept` like any other.
            _ => Default::default(),
        };

    // "Deleted branch foo (was 1a2b3c4)." — git's own line, in English because `git_cmd`
    // pins LC_ALL=C. Parsed rather than asked for with an extra `rev-parse` per branch;
    // an unparseable line just means no recovery hint, never a wrong one.
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
        // A spawn failure or a timeout stops this branch, never the sweep: the branches
        // already deleted have to be reported whatever happens to the ones after them.
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
                // Fall through to reporting the SAFE delete's refusal: `-D` failing after
                // `-d` failed means something structural (a bad ref, a locked ref), and
                // git's first message is the one that names it.
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
    /// Every commit on this branch is already an ancestor of the repo's checked-out
    /// branch — the same measure `Worktree.merged` uses, and for the same reason: it is
    /// what makes a branch safe to delete. Note what it is NOT: a **squash**-merged
    /// branch is false here, because its commits never became ancestors of anything.
    /// That gap is exactly what the deep-clean pane's pull-request lookup fills.
    merged: bool,
    /// This row is a remote-tracking ref with no local branch of the same name —
    /// someone else pushed it and nothing here points at it yet. The fields are then
    /// read one level over: `name` is the local branch a checkout would CREATE and
    /// `upstream` the ref it would track, which is exactly the pair the row will hold
    /// a second after it is picked. `current`/`checked_out`/`gone` are always false —
    /// there is no local ref to be any of them — while `ahead`/`behind` swap their
    /// meaning to "versus the remote's default branch" (`base`), which is the only
    /// comparison a branch nobody has checked out can meaningfully have.
    remote: bool,
    /// What `ahead`/`behind` were measured against, for a REMOTE row: its remote's
    /// default branch ("origin/main"), which is the comparison GitHub's branches view
    /// shows. Empty on a local row (whose comparison is its own `upstream`, already
    /// named there) and on a row from a remote we have no default for — in which case
    /// the counts are zero and mean "not measured", not "in sync".
    base: String,
    /// Who wrote the tip commit. Not "who created the branch" — git does not record that
    /// — but it is what GitHub's branches view shows and the question it answers ("is
    /// this mine?") is the same one.
    author: String,
    /// The tip this row was read at. Carried so a remote delete can be refused when the
    /// ref has moved since (`RemotePick`), and so a deletion can be undone by sha.
    sha: String,
    rel: String,
    unix: i64,
}

/// One remote branch the picker asks to delete, with the sha it was showing.
///
/// The sha is not decoration: `git push --delete` is a public, shared-state write, and
/// the list it was chosen from is as old as the last fetch. If someone pushed to that
/// branch in between, the row you clicked no longer describes what is on the remote —
/// so the delete is refused rather than performed on a stale reading.
#[derive(serde::Deserialize, Debug)]
pub(crate) struct RemotePick {
    branch: String,
    sha: String,
}

/// Delete branches on a remote — the cleanup behind the picker's Remote branches header.
///
/// **The one write in this app that changes state for other people**, so it is bounded
/// harder than its local counterpart rather than more conveniently:
///
/// - The remote's **default branch is refused unconditionally**, whatever it is asked.
/// - A branch whose remote-tracking ref has **moved since the caller read it** is refused
///   (see `RemotePick`) — as is one that no longer exists, which usually means somebody
///   else already cleaned it up.
/// - There is **no force and no fallback**: `git push` either deletes the ref or it does
///   not, and a protected branch's refusal is the server's answer, not ours to work
///   around. What was refused comes back with git's own words.
/// - Every deleted branch is reported **with the sha it pointed at**, because a remote
///   branch is restorable — `git push <remote> <sha>:refs/heads/<branch>` — for exactly
///   as long as somebody still has the objects.
///
/// Whether a branch is *worth* deleting (merged into the default branch, or its pull
/// request merged) is the caller's judgement, for the same reason as the local sweep's
/// force: a squash-merged branch is contained in nothing, and only GitHub knows it landed.
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

    // "origin/main" → "main". The default branch is refused here rather than filtered in
    // the UI, because this is the one mistake with no cheap undo for anyone else.
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

    // One push for the whole batch: each delete is a network round trip, and a cleanup of
    // eight branches should not be eight of them. On failure the batch says nothing about
    // WHICH ref the remote rejected, so a small batch is retried one at a time to find
    // out; a large one reports git's message against every branch rather than spending
    // eighty round trips to phrase it per row.
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

/// git's first meaningful line, from whichever stream carried it — `push` writes its
/// progress and its refusals to stderr, and its "everything up-to-date" to stdout.
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
    // No `-D` handoff here, deliberately: the local sweep's refusals have a safe manual
    // answer, and a remote refusal (protected branch, no permission, the ref moved) does
    // not — the fix is a conversation, not a flag.
    SweepResult { deleted, kept, suggest: None, summary }
}

/// Branches for the worktree picker, most-recently-committed first, each with
/// staleness + upstream context (see `BranchInfo`). Nothing is filtered here — the
/// frontend hides `current` and `checked_out` from the pickable list; returning them
/// with flags keeps the command honest and testable. Capped at BRANCH_LIST_CAP so a
/// repo with hundreds of refs can't blow the list up.
///
/// Local branches come out of ONE `for-each-ref`: `%(upstream:track)` makes git do the
/// ahead/behind arithmetic itself, so this no longer spawns a `rev-list` per branch.
/// A second pass adds **remote-only** branches (`remote: true`) — a colleague's branch
/// that exists on a remote and nowhere locally is a destination you'd want, and before
/// this it wasn't merely hidden: typing its name fell through to the create path and
/// made a *new, unrelated* branch off HEAD under the same name. Remote rows are capped
/// separately so a fork with hundreds of them can't crowd out the local list.
#[tauri::command(async)]
pub(crate) fn git_branch_list(repo_dir: String, base: Option<String>) -> Vec<BranchInfo> {
    // LC_ALL=C for the same reason as create_worktree: never depend on localized
    // output — and here it also pins `%(upstream:track)` to English "ahead"/"behind".
    let git = |args: &[&str]| sys_command("git").env("LC_ALL", "C").args(args).output();

    // The trunk everything is measured against: the caller's choice when it named one and
    // git can still resolve it, else the primary remote's default branch. Resolved once,
    // here, because both halves of this listing depend on it — a remote row's ahead/behind
    // AND whether a local branch counts as merged. Those used to disagree: `merged` was
    // measured against whatever HEAD happened to be on, so a repo parked on a feature
    // branch called half its history "merged" and the cleanup pane offered it.
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

    // Which branches are fully contained in the trunk. One `--merged` listing rather than
    // a `merge-base --is-ancestor` per branch (which is what `list_worktrees` pays, over a
    // handful of checkouts rather than every ref in the repo). Falls back to the checked-out
    // branch when there is no trunk at all (no remote, nothing named) — and to nothing when
    // HEAD is detached too, which is right: no base means no claim that anything is merged.
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

    // Tab-separated so neither the branch name nor the relative date can collide with
    // the delimiter (a relative date is "3 days ago" — spaces, never tabs).
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

    // Every local branch name, uncapped. The remote pass below asks "is there already a
    // local branch called this?", and `res` stops being able to answer that the moment
    // BRANCH_LIST_CAP truncates it — which would resurrect a checked-out branch as a
    // remote-only row in exactly the repos big enough to hit the cap.
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
        let author = parts.next().unwrap_or("").trim().to_string();
        let sha = parts.next().unwrap_or("").trim().to_string();

        res.push(BranchInfo {
            checked_out: taken.contains(&name),
            current: current.as_deref() == Some(name.as_str()),
            // Two branches are contained in the trunk and must still never be called
            // "merged, safe to delete": the checked-out one (which git refuses to delete
            // at all), and the trunk itself — a local `main` is by definition contained
            // in `origin/main`, and offering to delete it because of that would be the
            // worst suggestion in the app. Matched with and without the remote prefix.
            merged: merged.contains(&name)
                && current.as_deref() != Some(name.as_str())
                && !merged_base.as_deref().is_some_and(|b| b == name || b.ends_with(&format!("/{name}"))),
            remote: false,
            // What `merged` was decided against. A local row's ahead/behind is still
            // against its OWN upstream (which `upstream` names) — see the field's doc.
            base: merged_base.clone().unwrap_or_default(),
            name, upstream, ahead, behind, gone, rel, unix, author, sha,
        });
    }

    // ---- remote-only branches ------------------------------------------------------
    // The remote names are read rather than assumed, because the short ref is the only
    // thing `for-each-ref` gives us and "origin/feature/x" has to be split back into
    // remote + branch. Nothing here can guess where that boundary is.
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
    // A remote-only row is measured against the same trunk everything else is — by
    // default its remote's default branch, which is the comparison GitHub's own branches
    // view shows. There is no other sensible base: a branch nothing here has checked out
    // is not "behind" your HEAD in any way you'd act on, and `%(upstream:track)` says
    // nothing at all about a remote ref.
    //
    // ONE base, and rows from another remote are left uncompared rather than compared
    // against the wrong trunk — which is also exactly right for cleanup, since you cannot
    // delete on a remote you only fetch.
    let primary = primary_remote(&remotes);
    let base = trunk;
    let rfmt = |with_base: Option<&str>| match with_base {
        Some(b) => format!("--format=%(refname:short)\t%(committerdate:unix)\t%(committerdate:relative)\t%(authorname)\t%(objectname)\t%(ahead-behind:{b})"),
        None => "--format=%(refname:short)\t%(committerdate:unix)\t%(committerdate:relative)\t%(authorname)\t%(objectname)".to_string(),
    };
    // `%(ahead-behind:)` is git 2.41+. An older git fails the WHOLE listing on an unknown
    // field name, so the retry is not belt-and-braces: without it every remote row would
    // vanish on a machine with, say, Debian stable's git.
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
        // Longest matching prefix wins: git permits a remote named `a` alongside one
        // named `a/b`, and only the longer one splits `a/b/topic` where it really joins.
        // The empty remainder is what drops `refs/remotes/<remote>/HEAD` — the symbolic
        // pointer at the remote's default branch, which would otherwise duplicate
        // whatever it points at. Worth spelling out because it does NOT shorten to
        // `origin/HEAD` as you'd expect: git renders it as a bare `origin`, so no test
        // on the name would have caught it. (The `HEAD` check below is a belt for any
        // git that does spell it out.)
        let local = match remotes
            .iter()
            .filter_map(|r| short.strip_prefix(r.as_str()).and_then(|s| s.strip_prefix('/')))
            .filter(|s| !s.is_empty())
            .min_by_key(|s| s.len())
        {
            Some(l) => l,
            None => continue,
        };
        // A name that already exists locally isn't remote-*only*, and two remotes
        // carrying the same branch is one destination, not two.
        if local == "HEAD" || local_names.contains(local) || !seen.insert(local.to_string()) {
            continue;
        }
        let unix = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let rel = parts.next().unwrap_or("").to_string();
        let author = parts.next().unwrap_or("").trim().to_string();
        let sha = parts.next().unwrap_or("").trim().to_string();
        // "<ahead> <behind>" — ahead first, both relative to `base`. Only the primary
        // remote's own refs are comparable to it; another remote's rows keep the zeros,
        // and `base: ""` is what tells the UI not to draw a comparison it can't make.
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
            // For a remote row this is the same claim as for a local one — every commit
            // is already in the branch it is measured against — and it is the whole basis
            // on which a remote branch may be offered for deletion. `ahead == 0` is that,
            // exactly; a base we could not compute leaves it false and offers nothing.
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

/// The remote a cleanup would push to: `origin` when it exists, else the first one
/// configured. Named rather than assumed because everything downstream — the base for
/// ahead/behind, and which rows may be deleted at all — hangs off this one choice.
fn primary_remote(remotes: &[String]) -> &str {
    remotes.iter().find(|r| *r == "origin").unwrap_or(&remotes[0])
}

/// A remote's default branch as a short ref ("origin/main"), or None when nothing says.
///
/// `refs/remotes/<remote>/HEAD` is the honest answer but it only exists if the repo was
/// cloned (or `git remote set-head` was run), so the fallbacks matter more than they look
/// — a repo whose remote was added by hand has no HEAD ref at all. Never guesses past
/// main/master: a wrong default would make every branch look unmerged, or worse, merged.
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
    /// Branch name when on a branch; None when HEAD is detached.
    branch: Option<String>,
    /// Short commit sha of HEAD (used to label a detached checkout).
    short: String,
}

/// The two git directories a working directory answers to, resolved without
/// spawning git. `.0` is the **per-worktree** dir (where `HEAD` lives), `.1` the
/// **common** dir (where `refs/` and `packed-refs` live). They are the same path
/// for a main checkout and differ for a linked worktree, which is the whole reason
/// this returns a pair: a worktree has its own `HEAD` but shares every branch ref.
///
/// Mirrors `repo_root_of`'s walk — including its refusal to search past a `.git`
/// file whose target is gone (a pruned worktree is "not a repository" to git, and
/// following the dangling pointer would answer for a repo that has forgotten it).
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

/// Resolve a ref name (`refs/heads/main`) to its full sha, reading the loose file
/// first and falling back to `packed-refs`. `None` means the ref does not exist —
/// which for HEAD's target is exactly the unborn-branch case (`git init`, no commit
/// yet), and callers depend on telling that apart from a detached HEAD.
fn resolve_ref(common: &std::path::Path, name: &str) -> Option<String> {
    let sha = |s: &str| {
        let t = s.trim();
        // A loose ref may itself be symbolic; refs that deep are vanishingly rare
        // and git resolves them recursively, so decline rather than guess.
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

/// Live HEAD of a working directory, so the UI can show the branch that is
/// *actually* checked out rather than the one a worktree was created with (a
/// worktree shows whatever branch is checked out, and that can change).
///
/// **Read off the filesystem, with no `git` process at all** — the same trade
/// `worktree_heads` and `repo_root_of` already make, and for a sharper reason: this
/// is on the 4s branch poll, once per open session. It used to cost *two* spawns
/// each (`rev-parse --short HEAD`, then `symbolic-ref`), so a three-session fleet
/// spent 1.5 git processes per second re-reading a file — and on Windows, where
/// process creation dominates, that was a measurable share of the app's whole load.
///
/// Returns `None` for anything that isn't a repo **with at least one commit**, and
/// the "with a commit" half is load-bearing rather than incidental: `projmenu.ts`
/// uses exactly that to drop the *Commit graph…* row for a freshly `git init`ed
/// folder. An unborn HEAD still names a branch in `.git/HEAD`, so it is only the
/// missing ref that distinguishes it — which is why `resolve_ref` failing is
/// treated as "no repo" and not as "detached".
#[tauri::command(async)]
pub(crate) fn git_head(workdir: String) -> Option<HeadInfo> {
    let (gitdir, common) = git_dirs(&workdir)?;
    let text = std::fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let t = text.trim();
    let (branch, full) = match t.strip_prefix("ref:") {
        Some(r) => {
            let name = r.trim();
            // Unborn: HEAD names a branch that has no commit, so there is no ref to
            // resolve. git calls that "not a repository with a HEAD", and so do we.
            let sha = resolve_ref(&common, name)?;
            (Some(name.strip_prefix("refs/heads/").unwrap_or(name).to_string()), sha)
        }
        // Detached: HEAD holds the sha itself.
        None if t.len() >= 40 && t.chars().all(|c| c.is_ascii_hexdigit()) => (None, t.to_string()),
        None => return None,
    };
    // Fixed at 7 rather than reproducing git's auto-abbreviation (`core.abbrev`
    // widens with repo size). This is only ever shown as the "(detached @…)" label,
    // where a stable prefix is what the display wants; nothing compares it to git's.
    Some(HeadInfo { branch, short: full.chars().take(7).collect() })
}

/// The same answer as `git_repo_info`'s first half — the repo's MAIN worktree root —
/// read straight off the filesystem instead of spawning `git`.
///
/// This exists because History asks the question in bulk. One `git rev-parse` costs
/// ~140ms on Windows (process creation dominates, not the work), so resolving the ~28
/// distinct folders behind a few hundred transcripts cost **3.3 s** — two thirds of the
/// whole scan, and a cost that a smaller page size cannot reduce because the number of
/// distinct folders barely moves. The same walk in `std::fs` is microseconds.
///
/// It reads the layout `git` itself defines, so there is no guesswork:
/// - `.git` is a **directory** → this dir is the main worktree.
/// - `.git` is a **file** holding `gitdir: …/.git/worktrees/<name>` → a linked
///   worktree, and the main one is the parent of the `.git` that path points into.
///   This is the case that matters: a worktree usually lives *beside* its repo.
/// - `.git` is a file pointing anywhere else (a submodule's `…/.git/modules/<name>`) →
///   the submodule checkout is its own root. `git_repo_info` answers `…/.git/modules`
///   here, which is not a checkout at all, so this is the more useful answer as well
///   as the cheaper one.
/// - No `.git` at this level → walk up; `None` at the filesystem root.
///
/// `git_repo_info` stays for the callers that also need the branch.
///
/// The walk starts from the **physical** `cwd`, and that is load-bearing rather than
/// tidy. `git` resolves symlinks before it answers (`getcwd()` does it for free), so a
/// folder reached through one — `/tmp/x` for `/private/tmp/x`, or a Windows 8.3 short
/// name — makes an unresolved walk return a *different string* for the same repo. The
/// two spellings then fail the exact string equality the sidebar groups by, and a
/// repo's main checkout stops merging with its own worktrees. Canonicalising the
/// starting point fixes every branch below at once, including the one that was already
/// physical by accident: a linked worktree's answer is read out of the `gitdir:` file,
/// which `git` wrote canonically, so before this the same function disagreed with
/// itself depending on which kind of checkout it landed in.
pub(crate) fn repo_root_of(cwd: &str) -> Option<String> {
    let phys = physical_cwd(cwd);
    let mut dir: Option<&std::path::Path> = Some(std::path::Path::new(&phys));
    while let Some(d) = dir {
        let dot = d.join(".git");
        match std::fs::metadata(&dot) {
            Ok(m) if m.is_dir() => return Some(norm_path(&d.to_string_lossy())),
            Ok(_) => {
                // A `.git` FILE: one line, `gitdir: <path>`, absolute in a worktree and
                // possibly relative in a submodule — resolve it against this dir either way.
                let link = std::fs::read_to_string(&dot).ok()?;
                let target = link.trim().strip_prefix("gitdir:")?.trim();
                let abs = d.join(target);
                // A worktree whose admin dir has been pruned leaves the `.git` file
                // behind pointing at nothing. `git` treats that as "not a repository"
                // and stops — it does NOT keep searching upward past a `.git` file — so
                // returning None here is what keeps this in step with it. Following the
                // dangling pointer would file a dead checkout under a repo that no
                // longer knows about it.
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
    /// Untracked entries (new, never committed). git collapses an untracked *directory*
    /// into one entry, so this counts things-git-will-not-commit-yet, not files.
    untracked: u32,
    /// How many of `untracked` are directories rather than files — the card says "1 new
    /// folder" rather than "1 new file" for them, because one entry can be forty files.
    new_dirs: u32,
    /// Total dirty entries (`git status --porcelain` line count).
    dirty: u32,
    /// Upstream ref this branch tracks ("origin/main"), None if it tracks nothing.
    upstream: Option<String>,
    /// Commits we have that the upstream doesn't (as of the last fetch).
    ahead: u32,
    /// Commits the upstream has that we don't (as of the last fetch).
    behind: u32,
}

/// How many untracked files one poll is willing to open, and how large each may be.
/// A repo can hold thousands of untracked files (a build dir git happens not to ignore);
/// the card only needs a number, and a meter must not add to what it measures.
const NEW_SCAN_MAX: usize = 64;
const NEW_FILE_MAX: u64 = 512 * 1024;

/// Lines in an untracked file, counted the way `git diff --no-index` would report them:
/// every newline, plus a final line with no terminator. None means "not counted" — the
/// file is gone, is not a regular file, is too big, or looks binary — and the caller
/// adds nothing rather than guessing.
fn new_file_lines(path: &std::path::Path) -> Option<u32> {
    let md = std::fs::metadata(path).ok()?;
    if !md.is_file() || md.len() > NEW_FILE_MAX {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return Some(0);
    }
    // git's own binary test is a NUL in the first 8000 bytes; a binary file has no
    // "lines" to add, and the peek renders it as `Binary files … differ` for the same reason.
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
    Some(newlines + u32::from(bytes.last() != Some(&b'\n')))
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
            // Without this git octal-escapes any path outside ASCII and wraps it in
            // quotes, and the untracked scan below would then look for a file whose
            // name is the escape sequence. It costs nothing for the counts.
            .args(["-c", "core.quotePath=false"])
            .args(args)
            .output()
    };
    // ONE spawn for everything except the line counts. `--porcelain=v2 --branch` is
    // git's machine format: it reports the dirty entries *and* the upstream name and
    // ahead/behind in a single walk, which is what `upstream_state`'s two extra
    // processes used to cost. This is polled per folder on a timer (see
    // `refreshDirtyStates`), so the spawn count here is the difference between
    // "background" and "a git every few hundred milliseconds".
    let st = git(&["--no-optional-locks", "status", "--porcelain=v2", "--branch"]).ok()?;
    if !st.status.success() {
        return None; // not a repo
    }
    let text = String::from_utf8_lossy(&st.stdout);
    let (mut untracked, mut dirty, mut new_dirs) = (0u32, 0u32, 0u32);
    let mut new_files: Vec<String> = Vec::new();
    let (mut upstream, mut ahead, mut behind) = (None, 0u32, 0u32);
    let mut unborn = false;
    for line in text.lines() {
        match line.as_bytes().first() {
            // Tracked entries: `1` changed, `2` renamed/copied, `u` unmerged.
            Some(b'1') | Some(b'2') | Some(b'u') => dirty += 1,
            Some(b'?') => {
                dirty += 1;
                untracked += 1;
                // `? sub/` (trailing slash) is a whole untracked directory collapsed into
                // one entry. It is not a file, so it is neither read nor line-counted.
                match line.strip_prefix("? ") {
                    Some(p) if p.ends_with('/') => new_dirs += 1,
                    Some(p) => new_files.push(p.to_string()),
                    None => {}
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
    // An unborn HEAD has nothing to diff against; None, as before, so the UI shows no
    // working-set card rather than a card claiming zero changes in a repo full of them.
    if unborn {
        return None;
    }
    // The expensive half — a second walk, purely for +/- line counts — is skipped
    // entirely when the tree is clean. That is the steady state for most open folders,
    // so in practice this halves the polling cost rather than shaving it.
    let (mut added, mut removed, mut files) = (0u32, 0u32, 0u32);
    if dirty > 0 {
        let ns = git(&["--no-optional-locks", "diff", "--numstat", "HEAD"]).ok()?;
        if !ns.status.success() {
            return None;
        }
        for line in String::from_utf8_lossy(&ns.stdout).lines() {
            let mut it = line.split('\t');
            let a = it.next().unwrap_or("");
            let d = it.next().unwrap_or("");
            files += 1;
            added += a.parse::<u32>().unwrap_or(0); // "-" (binary) parses to 0
            removed += d.parse::<u32>().unwrap_or(0);
        }
    }
    // A never-committed file has no `diff HEAD` row, so `added`/`removed` used to read
    // `+0 −0` next to a count saying the tree had gained something — and the peek, which
    // renders untracked files as new-file diffs, showed `+37` for the very same file.
    // Two surfaces, one tree, two answers. Counting the lines here settles it.
    //
    // Bounded on purpose: this runs on the per-folder dirty poll, so it reads at most
    // NEW_SCAN_MAX files, at most NEW_FILE_MAX bytes each, and skips anything that
    // smells binary. Whatever it skips simply is not counted — the figure stays a
    // lower bound rather than becoming a guess.
    for rel in new_files.iter().take(NEW_SCAN_MAX) {
        added += new_file_lines(&std::path::Path::new(&workdir).join(rel)).unwrap_or(0);
    }
    Some(DiffStat { added, removed, files, untracked, new_dirs, dirty, upstream, ahead, behind })
}

#[derive(serde::Serialize)]
pub(crate) struct ChangedPath {
    /// Repo-relative, forward slashes — the same shape the explorer's index uses, so the
    /// two join on the string without either side normalising.
    path: String,
    /// One letter: `M` modified, `A` added, `D` deleted, `R` renamed, `U` unmerged,
    /// `?` untracked. The worktree half of git's XY wins over the index half, because a
    /// file staged-then-edited is, to a reader looking at their tree, edited.
    status: String,
}

/// Which paths are dirty and how — the marks on an explorer row.
///
/// A sibling of `git_diffstat` rather than a field on it: the stat is polled every 15s
/// for every open folder and must stay a handful of integers, while this is asked for
/// once, by one overlay, when it opens. Same single `status --porcelain=v2` walk either
/// way, so the cost is one process and no diffing.
///
/// Returns an empty list rather than an error when the folder is not a repo: the
/// explorer works fine there (its index just comes from a walk instead), and a row with
/// no mark is the correct rendering of "git has nothing to say about this file".
#[tauri::command(async)]
pub(crate) fn git_changed(workdir: String) -> Vec<ChangedPath> {
    let out = sys_command("git")
        .env("LC_ALL", "C")
        .arg("-C").arg(&workdir)
        .args(["-c", "core.quotePath=false"])
        .args(["--no-optional-locks", "status", "--porcelain=v2"])
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows = Vec::new();
    for line in text.lines() {
        // Every entry type puts its path LAST, after a fixed field count, so splitn on
        // that count keeps a path with spaces in one piece. Rename entries then carry
        // `<new>\t<old>`; the new name is the one a file list is about.
        let (fields, xy) = match line.as_bytes().first() {
            Some(b'1') => (9, line.get(2..4)),
            Some(b'2') => (10, line.get(2..4)),
            Some(b'u') => (11, Some("uu")),
            Some(b'?') => (2, Some("??")),
            _ => continue,
        };
        let Some(path) = line.splitn(fields, ' ').nth(fields - 1) else { continue };
        let path = path.split('\t').next().unwrap_or(path);
        if path.is_empty() {
            continue;
        }
        rows.push(ChangedPath { path: path.to_string(), status: status_letter(xy).to_string() });
    }
    rows
}

/// git's two-character XY (index, worktree) as the one letter a row shows.
fn status_letter(xy: Option<&str>) -> &'static str {
    let b = xy.unwrap_or("").as_bytes();
    if b == b"??" {
        return "?";
    }
    if b == b"uu" {
        return "U";
    }
    // Worktree half first: a file staged as added and then edited still reads as `A`
    // only if nothing has happened to it since, which is what taking `.` as "no news"
    // gives us.
    for c in [b.get(1).copied().unwrap_or(b'.'), b.first().copied().unwrap_or(b'.')] {
        match c {
            b'M' => return "M",
            b'A' => return "A",
            b'D' => return "D",
            b'R' => return "R",
            b'C' => return "C",
            b'T' => return "T",
            _ => {}
        }
    }
    "M"
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
    // Each untracked file below costs a whole `git` process (and on Windows a console
    // with it, at ~140ms worst case per spawn), because `--no-index` compares one pair
    // at a time — so this cap bounds a process storm, not output size. 300 shipped one:
    // ~600 back-to-back process creations on a click that should feel instant, and a
    // plausible source of git.exe 0xc0000142 dialogs. Nobody reads 300 untracked files
    // in a peek; the viewer's truncation note explains the rest.
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

#[derive(serde::Serialize, Debug, Default)]
pub(crate) struct GitActionResult {
    ok: bool,
    /// One line for the toast.
    summary: String,
    /// Combined stdout+stderr, for the debug log.
    output: String,
    /// Set when the action can't be finished safely from a button. The UI offers to
    /// open a terminal prefilled with this, rather than leaving the user guessing.
    suggest: Option<String>,
    /// `remove_worktree` only, and only in the one state git can leave behind: the
    /// worktree is unregistered — so this is `ok: true` and the roster really did
    /// change — but its directory is still on disk because something has it open.
    /// Neither `ok` alone can express that, which is why it is a field and not a
    /// wording; `purge_worktree_folder` is what acts on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    stranded: Option<Stranded>,
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
                    ..Default::default()
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
                    ..Default::default()
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
        return Ok(GitActionResult { ok: true, summary, output: combined, ..Default::default() });
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
        ..Default::default()
    })
}

/// One commit on the Trail. `when` is the author date in UNIX **seconds**, matching
/// `HistorySession.mtime` — the frontend converts both once, at the boundary.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct DayCommit {
    pub sha: String,
    pub author: String,
    pub when: u64,
    pub subject: String,
    /// The repo this came from, as the caller named it — so the frontend can attribute
    /// a commit to a project without re-resolving paths.
    pub root: String,
}

/// Resolve a folder to something that identifies its **repository**, not its checkout.
///
/// This is the whole reason the Trail doesn't double-count: Episko is worktree-heavy,
/// and every worktree of one repo shares one object store, so asking each of them for
/// "commits since Monday" returns the same commits N times. Worktrees share a
/// *common dir*, so that is the identity.
///
/// `--path-format=absolute` matters: plain `--git-common-dir` answers `.git` for a main
/// worktree, which is relative to the cwd and would compare unequal to the absolute
/// path a linked worktree reports for the very same repo.
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

/// Commits across `roots` in the last `days` days, for the Trail's "behind you" half.
///
/// **One git call per repository, never one per day or per commit.** A day view over a
/// month is 30 buckets; asking git per bucket would be 30 processes for what one pass
/// answers, and the frontend groups by date anyway.
///
/// Includes every local branch (`--branches`), not just HEAD: with several worktrees
/// open, the work that landed today is spread across them, and a Trail that only saw
/// the checked-out branch would miss most of it. Merges are kept — "merged #43" is
/// exactly the kind of thing a day is remembered by.
///
/// Every author is returned, not just the current user. Seeing that a colleague pushed
/// while you were elsewhere is the point of the collaborator work, and the frontend
/// decides how to show whose commit it was.
///
/// Failures are per-repo and silent: a root that isn't a repo, has no commits yet, or
/// has since been deleted contributes nothing rather than failing the whole call.
#[tauri::command(async)]
pub(crate) fn git_log_days(roots: Vec<String>, days: u64) -> Vec<DayCommit> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<DayCommit> = Vec::new();
    // git's approxidate cannot express a date before the UNIX epoch, and it fails
    // *silently*: `--since=36500.days.ago` matches NOTHING rather than everything, so an
    // over-wide window would blank the Trail instead of widening it — the worst kind of
    // bug, because "no work happened" is a plausible-looking answer.
    //
    // A window wider than git can express simply means "all history", which is what
    // omitting `--since` already means — so say that, rather than guessing a magic
    // cutoff that drifts further from the epoch every year.
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
        // NUL between fields so a subject containing any printable character still
        // parses; %s is the subject *line*, so it can't contain a newline and records
        // stay newline-separated.
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

/// What the project dashboard needs to know about a folder before it renders anything.
///
/// **One call, because it decides which cards exist at all.** Three tiers, and they are
/// not the same gate: a GitHub remote unlocks issues and pull requests, *git* unlocks
/// the commit half of the timeline and everything shared (`.episko/` is only meaningful
/// if it can be committed), and neither gates sessions, spend or tasks. A card with
/// nothing to say is absent rather than empty — an empty "Issues" panel in a folder that
/// has no issues reads as breakage.
#[derive(serde::Serialize, Debug, PartialEq, Default)]
pub(crate) struct ProjectFacts {
    pub is_repo: bool,
    /// The repo's main checkout, so a dashboard opened on a worktree still speaks for
    /// the project. None when the folder isn't a repo at all.
    pub root: Option<String>,
    /// `origin`'s URL verbatim, for display. None for a repo with no remote — a normal
    /// local-only project, not an error.
    pub origin: Option<String>,
    /// The host as the remote spells it, lowercased (`github.com`, `gitlab.com`,
    /// `git.example.internal`) — an `~/.ssh/config` alias included, since that is the
    /// name the user chose and the only place this is shown is the "not on GitHub" card.
    pub host: Option<String>,
    /// `owner/repo`, only when the host is GitHub — it is what `gh` needs, and naming it
    /// for any other host would imply a capability Episko doesn't have there. An ssh
    /// alias that resolves to `github.com` counts; see [`parse_remote_with`].
    pub slug: Option<String>,
}

/// Host and `owner/repo` out of a git remote URL, before anything decides what that host
/// *is*.
///
/// Pure and separated out because the spellings git accepts all appear in the wild and
/// only some are URIs: `git@host:owner/repo.git` has no scheme and a colon where a slash
/// belongs, while `ssh://git@host/owner/repo` and `https://host/owner/repo.git` are
/// ordinary URLs. Getting this wrong does not error — it silently files a GitHub project
/// under "no GitHub" and drops two cards, which is the failure this test-covers against.
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

/// [`split_remote`], plus the one question a parser cannot answer on its own: **is the
/// name in this URL a hostname at all?**
///
/// Only GitHub gets a slug — it is what `gh` is handed, and producing one for a GitLab
/// remote would promise a capability that does not exist. But `github.com-work` *is*
/// GitHub: an `~/.ssh/config` `Host` alias is how one machine keeps two GitHub identities
/// apart, and it is the alias, not the hostname, that lands in the remote URL. Matching
/// the string alone therefore drops the issues-and-pull-requests half of the dashboard
/// for exactly the people who have two accounts. `gh` resolves those aliases itself
/// (which is why `gh repo view` answers in such a checkout), so Episko was the only link
/// in the chain that could not read the remote.
///
/// `resolve` is the seam for that — see [`ssh_hostname`] — and it is consulted only after
/// the plain match has failed, so the ordinary case still costs nothing.
fn parse_remote_with(url: &str, resolve: impl Fn(&str) -> Option<String>) -> (Option<String>, Option<String>) {
    let (host, owner_repo) = split_remote(url);
    let Some(h) = host else { return (None, None) };
    if h == "github.com" {
        return (Some(h), owner_repo);
    }
    // Only an ssh-ish remote can carry an alias: an https host is a real hostname, and
    // asking ssh about one would spend a process on every GitLab dashboard.
    let aliased = owner_repo.is_some()
        && !url.trim_start().to_ascii_lowercase().starts_with("http")
        && resolve(&h).as_deref() == Some("github.com");
    // The host stays as written. It is only shown when there is no slug, and a user who
    // typed an alias should be told back the name they typed.
    (Some(h), owner_repo.filter(|_| aliased))
}

/// Host and GitHub `owner/repo` out of a git remote URL.
pub(crate) fn parse_remote(url: &str) -> (Option<String>, Option<String>) {
    parse_remote_with(url, ssh_hostname)
}

// Resolved aliases, for the life of the process. `~/.ssh/config` is config, and nobody
// edits it mid-session — the same reasoning as github.rs's `VIEWER`.
static SSH_HOSTS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// The real hostname behind an `~/.ssh/config` `Host` alias, or `None` if there is none.
///
/// `ssh -G <name>` prints the config that *would* apply to a connection without making
/// one, so this costs a process and no network; a name that is not an alias comes back as
/// itself, which is what makes the answer always safe to compare. Asking ssh rather than
/// reading the file ourselves is the whole point: `Include`, wildcards and `Match` are
/// its grammar, and a half-parser would be wrong precisely on the configs elaborate
/// enough to have an alias in them.
///
/// No ssh on PATH → `None`, which is exactly the behaviour before this existed.
fn ssh_hostname(alias: &str) -> Option<String> {
    // The name reaches ssh as an argument, so it must not be able to read as a flag —
    // the same guard `git_commit_message` puts on a sha before handing it to git.
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

/// The `hostname` line out of `ssh -G` output, if it names something other than the alias
/// itself. Split from the process call because this is the half that can break silently:
/// the answer sits in ~60 lines of `key value` pairs, `ssh -G` always prints one whatever
/// it was asked about, and a `hostname` echoing the alias back means "not an alias" —
/// which is indistinguishable, at the call site, from a correct resolution.
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
    // `git remote get-url origin` rather than reading .git/config directly: worktrees,
    // submodules and `includeIf` all make the file the wrong place to look, and this is
    // one process on a folder the user just clicked.
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

    /// A machine with no ssh config at all. Every assertion below that uses it is also
    /// asserting the alias lookup was **not** needed to reach the answer.
    fn no_aliases(_: &str) -> Option<String> { None }

    /// `switch_branch` itself needs a real `AppState`, whose `Session` holds a live PTY —
    /// nothing a unit test can build. Its rule is extracted precisely so the half the
    /// backend owns can still be pinned, because the other half (`midFlight`, in
    /// src/types.ts) is written to agree with it and the two drift silently: a
    /// disagreement shows up as the frontend offering a switch the backend then refuses,
    /// which reads as a bug in git.
    #[test]
    fn only_a_running_task_blocks_a_branch_switch_from_the_backend_side() {
        assert!(blocks_switch("task"));
        // A shell is the user's own prompt, and an agent's phase is not visible here —
        // an idle claude pane must not be mistaken for a working one.
        assert!(!blocks_switch("shell"));
        assert!(!blocks_switch("claude"));
        // An unknown kind is not a blocker: `Session::kind` is set by our own spawners,
        // so a new one is a pane we added, not an unexplained hazard to refuse on.
        assert!(!blocks_switch(""));
    }

    /// The pair that must never disagree. The failure is silent and one-sided: the switch
    /// runs the right command, and only the *dirty tree* path — the one nobody exercises
    /// on purpose — hands a terminal a command that does something else.
    #[test]
    fn a_remote_only_switch_tracks_and_hands_over_the_same_command() {
        let (args, suggest) = switch_args("feat/x", Some("origin/feat/x"));
        assert_eq!(args, ["switch", "--track", "-c", "feat/x", "origin/feat/x"]);
        assert_eq!(suggest, "git switch --track -c \"feat/x\" \"origin/feat/x\"");
        // A branch that is already here is moved to, never cut again — `-c` on an
        // existing branch is a hard git error, and this is reached whenever the local ref
        // appeared between the list being read and the click.
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
        // The slug is what `gh` is handed. Producing one for another host would promise
        // issues and pull requests Episko cannot reach there.
        assert_eq!(p("git@gitlab.com:team/thing.git"),
                   (Some("gitlab.com".into()), None));
        assert_eq!(p("git@git.respeak.internal:team/thing.git"),
                   (Some("git.respeak.internal".into()), None));
        // Host case is normalised — GitHub URLs are written both ways.
        assert_eq!(p("git@GitHub.com:o/r.git").1, Some("o/r".into()));
    }

    #[test]
    fn an_ssh_host_alias_is_still_github() {
        // Two GitHub accounts on one machine means an `~/.ssh/config` `Host` alias per
        // identity, and the alias is what the remote URL carries. Matching the string
        // alone drops issues and pull requests for precisely those users.
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
        // Verbatim shape of `ssh -G`: ~60 `key value` lines, keys lowercased by ssh
        // itself, in no order we may depend on. Captured from OpenSSH 9.x.
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
        // A name that is not an alias: ssh still prints a `hostname`, echoing it back.
        // Accepting that would mint a slug for every host on earth.
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
        // The two are different tiers: one loses the whole git half of the dashboard,
        // the other only loses issues and pull requests.
        let plain = scratch_dir();
        assert_eq!(project_facts(plain.to_string_lossy().to_string()), ProjectFacts::default());

        let repo = scratch_dir();
        git(&repo, &["init", "-q", "-b", "main"]);
        let f = project_facts(repo.to_string_lossy().to_string());
        assert!(f.is_repo);
        assert!(f.root.is_some());
        assert_eq!(f.origin, None, "a repo with no remote is normal, not an error");
        assert_eq!(f.slug, None);

        // Deliberately NOT this repo's own remote. `git remote get-url` applies the
        // developer's `url.<base>.insteadOf` rewrites, so a fixture naming a real
        // owner can come back rewritten and the assertion then fails on the machine of
        // whoever configured it rather than on anything this test is about — which is
        // exactly what `respeak-io/episko` did here.
        git(&repo, &["remote", "add", "origin", "git@github.com:example-org/thing.git"]);
        let f = project_facts(repo.to_string_lossy().to_string());
        assert_eq!(f.slug, Some("example-org/thing".into()));
        assert_eq!(f.host, Some("github.com".into()));
    }

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


    /// The Trail asks for commits across every project folder it knows, and Episko is
    /// worktree-heavy — so the same repository arrives under several paths. Counting it
    /// once per checkout would triple a busy day's history.
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

        // And the sibling worktree alone answers identically — the dedupe key is the
        // repository, not whichever path happened to be listed first.
        assert_eq!(git_log_days(vec![side], 3650).len(), 2);

        let _ = std::fs::remove_dir_all(wt_root(&repo));
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A folder that isn't a repo (or has been deleted) must contribute nothing rather
    /// than failing the whole call — the Trail spans every project the user has open.
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

    /// `--since` is what bounds the scan; a commit outside the window must not appear,
    /// or the "last 30 days" window silently becomes "everything".
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

        // The clamp, asserted as behaviour rather than trusted: git's approxidate
        // matches NOTHING past ~100 years, so without clamping an over-wide window
        // would silently blank the Trail. It must widen, never empty.
        assert_eq!(git_log_days(vec![root.clone()], 36_500).len(), 1, "an over-wide window must not go blank");
        assert_eq!(git_log_days(vec![root], u64::MAX).len(), 1, "and neither must an absurd one");

        let _ = std::fs::remove_dir_all(&repo);
    }

    /// `repo_root_of` replaces a `git rev-parse` that cost ~140ms per call, so it has
    /// to give the same answer git does — including where git *refuses* one. Each case
    /// is asserted against `git_repo_info` in the same breath, which is what makes this
    /// a substitution test rather than a restatement of the implementation.
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

        // A linked worktree BESIDE the repo — `.git` is a file pointing into
        // `<repo>/.git/worktrees/<name>`. This is the case History exists for.
        let wt = wt_root(&repo).join("side");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(&repo, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
        assert!(wt.join(".git").is_file(), "fixture must be a linked worktree, not a clone");
        assert_eq!(agree(&wt), Some(root.clone()), "a worktree resolves to its repo");

        // Pruned admin dir: the `.git` file survives pointing at nothing. git calls that
        // "not a repository" and stops rather than searching upward, and so must we —
        // otherwise a dead checkout files itself under a repo that has forgotten it.
        std::fs::remove_dir_all(repo.join(".git/worktrees/side")).unwrap();
        assert_eq!(agree(&wt), None, "a stale worktree resolves to nothing");

        // Not a repository at all, at any level above it.
        let bare = std::env::temp_dir();
        assert_eq!(repo_root_of(&bare.to_string_lossy()), None);

        let _ = std::fs::remove_dir_all(wt_root(&repo));
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// `git_head` reads `.git` directly instead of spawning git twice per session per
    /// poll, so — exactly as with `repo_root_of` — the test that matters is a
    /// *substitution* one: every case is asserted against what git itself answers, not
    /// against a restatement of the implementation.
    ///
    /// The cases are the ones that actually differ in the file layout. An unborn HEAD
    /// is the subtle one: `.git/HEAD` names a branch whether or not any commit exists,
    /// so only the missing ref tells the two apart — and `projmenu.ts` relies on the
    /// `None` to drop its *Commit graph…* row for a fresh `git init`.
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

        // Packed refs: `pack-refs` deletes the loose file, so the ref now resolves
        // only via `packed-refs` — the fallback that would otherwise go untested.
        git(&repo, &["pack-refs", "--all"]);
        assert!(!repo.join(".git/refs/heads/main").exists(), "fixture must have packed the ref away");
        assert_eq!(agree(&repo, "packed").unwrap().branch.as_deref(), Some("main"));

        // A linked worktree has its OWN HEAD but shares the repo's refs — the case
        // the (gitdir, common) split exists for.
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

    /// One repo reached by two spellings must resolve to ONE root, because the sidebar
    /// groups projects by exact string equality — two spellings mean a repo that no
    /// longer merges with its own worktrees.
    ///
    /// This is the case the fixtures cannot catch on their own: `scratch_dir` hands back
    /// a physical path by design, so every other assertion here compares like with like
    /// and would pass whether or not `repo_root_of` resolves anything. A symlink put
    /// there on purpose is the only way to hold it to the same answer `git` gives, which
    /// is what the whole function promises.
    #[cfg(unix)]
    #[test]
    fn repo_root_of_resolves_a_symlinked_path_like_git_does() {
        let root = scratch_dir();
        let repo = root.join("real");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        // Committed before anything is asserted: `git_repo_info` asks for the branch in
        // the same `rev-parse` as the root, and an unborn HEAD fails the whole call, so
        // a fresh `init` would compare against None rather than against git's answer.
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
        // A subdirectory below the link resolves the same way — the walk starts from the
        // resolved path, so every level above it is resolved as well.
        let sub = link.join("src/deep");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(repo_root_of(&sub.to_string_lossy()), Some(physical.clone()));

        // The half that was already physical by accident: a linked worktree's root comes
        // out of the `gitdir:` file, which git wrote canonically. Its answer and the main
        // checkout's had to become the same string, or a worktree groups on its own.
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

    /// `worktree_heads` is the sidebar's polling path, so it has to agree with
    /// `list_worktrees` while spawning no git at all. Four things are load-bearing: it
    /// must answer identically from a *linked* checkout (whose `.git` is a file, a
    /// different branch of `repo_root_of`), it must take the path from `gitdir` rather
    /// than the bookkeeping folder name, it must track a branch switch — that is the
    /// whole reason it exists — and it must label a detached HEAD rather than drop the
    /// row, or a rebasing worktree would vanish from the sidebar mid-operation.
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
        // The linked entry is the CHECKOUT, not the repo root `repo_root_of` would map
        // it back to — and its folder is `feat-thing` while git's bookkeeping name is
        // whatever it chose, so this also pins that the path came out of `gitdir`.
        assert_eq!(linked.path, norm_path(&physical_cwd(&made)));
        assert!(linked.path.ends_with("feat-thing"), "the checkout dir, not the repo root: {}", linked.path);
        assert!(linked.exists);

        // Asked from *inside* the linked worktree the answer must be identical. That
        // dir's `.git` is a file, so this is a different resolution path reaching the
        // same repo — the asymmetry that produced two spellings of one root before.
        assert_eq!(worktree_heads(made.clone()), heads, "same repo, same answer from any checkout");

        // The point of the whole thing: a branch switch is visible with no git spawn.
        git(Path::new(&made), &["checkout", "-q", "-b", "second"]);
        assert_eq!(worktree_heads(repo.clone()).iter().find(|w| !w.is_main).unwrap().branch, "second");

        git(Path::new(&made), &["checkout", "-q", "--detach"]);
        assert_eq!(worktree_heads(repo.clone()).iter().find(|w| !w.is_main).unwrap().branch, "(detached)");

        // A checkout whose folder has gone stays LISTED, flagged `exists: false`. Both
        // halves matter and they pull in opposite directions: git keeps its record in
        // `.git/worktrees` until pruned, so dropping the row would hide the one thing
        // that still needs cleaning up — while treating it as a place to work would
        // spawn a PTY into nothing. The frontend reads this flag to decide between
        // "remove this worktree" and "prune git's record of it", which is the difference
        // between a destructive warning and a housekeeping one.
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

    /// The inspector's working-set strip ("+3 −1 · 2 files · 1 new") and the ahead/
    /// behind pair beside it.
    ///
    /// An untracked file's lines **are** insertions here, which reverses what this test
    /// used to assert. The old rule left the card printing `+0 −0` beside a count saying
    /// the tree had gained a file, while the peek — which renders untracked files as
    /// new-file diffs — showed the real number for the very same file. One tree with two
    /// answers is worse than either answer, so `new_file_lines` now folds them in and
    /// the two surfaces agree. What must still not happen: measuring the gap against
    /// anything other than the tracking ref, and reading a file the scan should refuse.
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
        // …and the same through `git_diffstat`, which reads the gap out of porcelain=v2
        // rather than asking separately: detached prints no `# branch.upstream` and no
        // `# branch.ab`, so this is the parser's absent-field path, not its zero path.
        let d = git_diffstat(path.clone()).expect("a detached checkout still has a working set");
        assert_eq!(d.upstream, None);
        assert_eq!((d.ahead, d.behind), (0, 0));
        assert_eq!((d.added, d.removed, d.untracked), (3, 1, 1), "detaching changed no files");

        // A clean tree takes the path that skips `--numstat` entirely, so it needs its
        // own assertion — every count zero, and still Some rather than None.
        git(&dir, &["checkout", "-q", "main"]);
        git(&dir, &["checkout", "-q", "--", "a.txt"]);
        std::fs::remove_file(dir.join("new.txt")).unwrap();
        let clean = git_diffstat(path.clone()).expect("clean is still a diffstat");
        assert_eq!((clean.added, clean.removed, clean.files, clean.untracked, clean.dirty), (0, 0, 0, 0, 0));
        assert_eq!(clean.upstream.as_deref(), Some("origin/main"), "clean does not lose the upstream");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote);
    }

    /// The explorer's row marks. The whole risk here is the parse: porcelain=v2 puts the
    /// path last after a *different* number of fields per entry type, so a wrong count
    /// silently yields a path that is half a hash — and a mark that never matches a row.
    /// The cases that catch it are the ones with a space in the name and a rename, which
    /// is where a naive `split_whitespace().last()` falls apart.
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
        // A rename is reported under its NEW name, which is the one a file list is about,
        // and the old name must not leak in as a row of its own.
        assert_eq!(by("new name.txt").as_deref(), Some("R"));
        assert!(by("old name.txt").is_none(), "the old name is not a file any more: {:?}",
            rows.iter().map(|r| &r.path).collect::<Vec<_>>());
        assert_eq!(rows.len(), 4);

        // Not a repo: an empty list, not an error — the explorer still works there.
        let plain = scratch_dir();
        assert!(git_changed(plain.to_string_lossy().to_string()).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&plain);
    }

    /// The bounds on the untracked scan, which are the whole reason it is safe to run on
    /// a 15s poll: a directory is one entry and is never opened, a binary file adds
    /// nothing, and an oversized file adds nothing. Each skip must leave the figure a
    /// lower bound rather than a guess — and must not stop the files after it counting.
    #[test]
    fn git_diffstat_bounds_what_it_reads_for_untracked_lines() {
        let dir = scratch_dir();
        let path = dir.to_str().unwrap().to_string();
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        git(&dir, &["add", "-A"]);
        commit(&dir, "init");

        // A whole untracked directory: one entry, counted as a folder, never walked —
        // so neither of the two files inside it reaches the line count.
        std::fs::create_dir_all(dir.join("scratch")).unwrap();
        std::fs::write(dir.join("scratch/a.txt"), "1\n2\n3\n").unwrap();
        std::fs::write(dir.join("scratch/b.txt"), "4\n").unwrap();
        let d = git_diffstat(path.clone()).unwrap();
        assert_eq!((d.untracked, d.new_dirs), (1, 1), "a new folder is one entry, and is a folder");
        assert_eq!(d.added, 0, "a folder's contents are not line-counted");

        // A file with no trailing newline still has a last line, exactly as `git diff`
        // reports it; a binary file has none.
        std::fs::write(dir.join("tail.txt"), "one\ntwo").unwrap();
        std::fs::write(dir.join("blob.bin"), [0x00, 0x01, 0x02, b'a', b'\n']).unwrap();
        std::fs::write(dir.join("empty.txt"), "").unwrap();
        let d = git_diffstat(path.clone()).unwrap();
        assert_eq!(d.added, 2, "2 lines from tail.txt, nothing from the binary or the empty file");
        assert_eq!((d.untracked, d.new_dirs), (4, 1), "all four entries still counted");

        // The size cap: over it, the file contributes nothing at all rather than a
        // partial count, and the files beside it are unaffected.
        std::fs::write(dir.join("huge.txt"), "x\n".repeat((NEW_FILE_MAX as usize / 2) + 10)).unwrap();
        let d = git_diffstat(path.clone()).unwrap();
        assert_eq!(d.added, 2, "an oversized file adds nothing, and does not break the others");

        let _ = std::fs::remove_dir_all(&dir);
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

        let bs = git_branch_list(dir.to_str().unwrap().to_string(), None);
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

    /// A branch that exists on a remote and nowhere locally is a destination too. Both
    /// halves matter and the second is the one with teeth: picking such a row must cut a
    /// branch from the remote's tip and TRACK it, not mint a same-named stranger off
    /// HEAD — which is precisely what the create path did before these rows existed.
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

        // A colleague pushes from their own clone; ours only ever fetches, so these two
        // branches exist under refs/remotes and nowhere else.
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
        // ahead/behind on a remote row are against the REMOTE's default branch, not
        // against a local upstream it doesn't have: one commit dev hasn't got, nothing
        // it is missing. `gone` stays false — there is no local ref to be orphaned.
        assert!(!f.gone, "a remote row has no upstream to lose: {bs:?}");
        assert_eq!((f.ahead, f.behind), (1, 0), "one commit ahead of origin/dev: {bs:?}");
        assert_eq!(f.base, "origin/dev", "and it says what it was measured against: {bs:?}");

        // The short ref has to be split back into remote + branch, and a branch name
        // containing a slash must not be split at the first one it happens to hold.
        assert_eq!(by("nested/topic").upstream, "origin/nested/topic", "{bs:?}");

        // dev has a local branch, so it is not remote-*only*; origin/HEAD is a symbolic
        // pointer at the default branch rather than a branch. Neither may appear. Both
        // spellings are asserted because git shortens that ref to a bare `origin`, so a
        // filter that only looked for "HEAD" would let it through as a phantom row.
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

    /// The broom. Two halves matter and the second is the one with teeth: it deletes the
    /// merged-and-gone branches in one pass, and it refuses to take the caller's word for
    /// which those are — a name that is no longer `gone`, or that a worktree holds, must
    /// survive a sweep that was explicitly asked to delete it.
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

    /// The deep-clean pane's two extra powers, which the broom deliberately lacks: a
    /// branch picked without a `gone` claim (merged, remote still live) still deletes,
    /// and a `force` picked per-branch escalates to `-D` — but a worktree's claim beats
    /// a force, because git refuses that with or without one.
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

    /// The remote rows carry what GitHub's branches view shows — how far each branch is
    /// from the default branch, and whose commit is on the end of it. Both are read
    /// against the REMOTE's default, never against local HEAD: a branch nothing here has
    /// checked out is not behind your working branch in any sense you'd act on.
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

    /// Deleting on a remote is the one write here that changes things for other people,
    /// so the guards are the test: the default branch is untouchable, a ref that moved
    /// since the list was read is refused, and every delete comes back with the sha that
    /// restores it.
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

    /// `merged` is what the deep-clean pane offers a branch on, so it has to mean exactly
    /// "already contained in the checked-out branch" — never the current branch itself
    /// (which `git branch --merged` does list), and never a squash-merge (which is why
    /// the pane needs GitHub at all).
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

        // A named base moves the whole question. This is the case it exists for: a repo
        // parked on a feature branch, where "merged into HEAD" answers nothing useful.
        let named = git_branch_list(dir.to_str().unwrap().to_string(), Some("ahead-of-dev".into()));
        let by2 = |n: &str| named.iter().find(|b| b.name == n).unwrap_or_else(|| panic!("{n} missing from {named:?}"));
        assert!(by2("contained").merged, "still contained, now measured against the named base: {named:?}");
        assert_eq!(by2("contained").base, "ahead-of-dev", "the row says what it was measured against: {named:?}");
        // The trunk is contained in itself and the checkout can't be deleted at all —
        // neither may come back as a cleanup candidate.
        assert!(!by2("ahead-of-dev").merged, "the base is never a candidate for deletion: {named:?}");
        assert!(!by2("dev").merged, "nor is the checked-out branch: {named:?}");

        // A base git can't resolve is ignored rather than obeyed into nonsense — every
        // branch would otherwise come back unmerged, which reads as "nothing to clean".
        let bogus = git_branch_list(dir.to_str().unwrap().to_string(), Some("no-such-ref".into()));
        assert_eq!(bogus.iter().find(|b| b.name == "contained").map(|b| b.base.as_str()), Some("dev"),
            "falls back to the real trunk: {bogus:?}");

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

        // Hand-deleted folder: it leaves the listing, whichever way git gets there.
        // Modern git removes a vanished checkout with exit 0; older gits fail and are
        // caught by the `still_registered` branch. Assert the outcome, not the route.
        let r = remove_worktree_impl(&repo, &gone, "gone-wt", false).expect("call returns");
        assert!(r.ok, "a vanished worktree should remove cleanly: {r:?}");
        assert!(r.stranded.is_none(), "nothing is on disk to strand: {r:?}");
        assert!(!list_worktrees(repo.clone()).iter().any(|w| w.branch == "gone-wt"),
            "gone-wt should be out of the listing");

        git(&dir, &["worktree", "unlock", &locked]);
        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The bug this whole path exists for.** `git worktree remove` deletes the
    /// checkout directory first and unregisters it second, and continues past a failed
    /// delete because — in git's own words — "there's no going back from here". So on
    /// Windows, where a directory any process holds open cannot be deleted, a non-zero
    /// exit leaves the worktree *already gone from git* with its folder still on disk.
    ///
    /// Read as a plain failure, that produced the one handoff guaranteed to fail:
    /// `git worktree remove --force <path>` → `fatal: '<path>' is not a working tree`.
    /// So the three assertions here are the three halves of the answer — it is not a
    /// refusal, it offers no force command, and it says what is left over.
    ///
    /// Windows-only because it is a Windows-only behaviour: POSIX unlinks a directory
    /// out from under its holders and this state cannot arise.
    ///
    /// The share mode is the fixture's whole trick, and it has to be exactly this.
    /// Rust's `File::open` passes all three share flags, so a plain open is deletable
    /// and reproduces nothing; denying *everything* (`share_mode(0)`) overshoots the
    /// other way — git can no longer read the file for its own cleanliness check, so
    /// it refuses with "contains modified or untracked files" and never reaches the
    /// delete this test is about. `READ | WRITE` (no `DELETE`) is the real-world shape:
    /// an editor holding a file open, which git reads happily and Windows will not
    /// unlink.
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

        // Release the handle and the repair goes through with nothing to kill: the
        // holder list is what a purge acts on, not what it needs to succeed.
        drop(held);
        let p = purge_worktree_folder(wt.clone(), vec![]).expect("purge returns");
        assert!(p.gone && p.stranded.is_none(), "an unheld folder purges cleanly: {p:?}");
        assert!(!Path::new(&wt).exists(), "the folder should be gone now");

        let _ = std::fs::remove_dir_all(wt_root(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The guard on the destructive command. `purge_worktree_folder` deletes a tree and
    /// kills processes, so the one thing it must never accept is a path shallow enough
    /// to be somebody's whole drive — a bug upstream of it must not become an erased
    /// disk. The depth rule is crude on purpose: it cannot be argued with.
    #[test]
    fn purge_refuses_a_top_level_path() {
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(purge_worktree_folder(root.to_string(), vec![]).is_err(), "a drive root must be refused");
        // A path that does not exist is not an error — it is the outcome being asked
        // for, and a retry after a successful purge lands here.
        let missing = scratch_dir().join("never-created");
        let r = purge_worktree_folder(missing.to_string_lossy().to_string(), vec![]).expect("call returns");
        assert!(r.gone, "nothing to delete counts as gone: {r:?}");
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
