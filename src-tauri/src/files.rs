//! The project index behind the explorer: one list of the files a project contains.
//!
//! For a repo the whole implementation is `git ls-files --cached --others
//! --exclude-standard`, and deliberately so. It answers "tracked, plus untracked that
//! git would not ignore" in a single process — which is exactly the set a person means
//! by *the project's files* — with `.gitignore` honoured by the tool that owns it
//! rather than by a parser of ours. Every alternative (a walker plus an ignore crate,
//! a cached tree, a watcher) is more code that agrees with git less often.
//!
//! A folder that is not a repo still has to work, since Episko will open any directory,
//! so that case gets a bounded walk instead. The bounds are the point: no depth beyond
//! `MAX_DEPTH`, no dot-directories, none of the build directories nobody means, and a
//! hard cap on the count. A truncated index says so and the UI repeats it, because a
//! file list that silently stops is a file list that lies about what a project holds.
//!
//! Nothing here watches anything. The index is read when the explorer opens and cached
//! on the frontend for the length of that visit; the app has no filesystem watcher by
//! design (docs/worktrees.md), and this must not be what introduces one.

use crate::platform::sys_command;

/// The cap exists so a mis-aimed open (a home directory, `/`) cannot hang the overlay.
const MAX_FILES: usize = 20_000;
/// Deep enough for a monorepo, shallow enough that a symlink loop cannot outlive the call.
const MAX_DEPTH: usize = 8;
/// Directories a file *finder* is never asking about. `.git` and friends are covered by
/// the dot rule; these are the ones that are ordinary names but hold generated trees.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "__pycache__"];

#[derive(serde::Serialize)]
pub(crate) struct FileIndex {
    /// Repo-relative paths with forward slashes, sorted, deduplicated.
    files: Vec<String>,
    /// True when the cap stopped the walk early — the overlay says so rather than
    /// letting a partial list read as the whole project.
    truncated: bool,
    /// Whether git produced this list. The empty state reads differently for a folder
    /// that is not a repo, and it is the only honest way to explain a missing file.
    repo: bool,
}

/// Every file in the project, for the explorer's find and browse modes.
///
/// Browse is derived from this same flat list on the frontend rather than from a second
/// `read_dir` command: one source means the two modes cannot disagree about what the
/// project contains, and there is no second round trip per folder you step into.
#[tauri::command(async)]
pub(crate) fn project_files(root: String) -> FileIndex {
    if let Some(files) = git_index(&root) {
        let truncated = files.len() >= MAX_FILES;
        return FileIndex { files, truncated, repo: true };
    }
    let (files, truncated) = walk_index(std::path::Path::new(&root));
    FileIndex { files, truncated, repo: false }
}

/// `git ls-files`, or None when this is not a repo (or git is unavailable, which is the
/// same thing from here: the walk is the answer either way).
fn git_index(root: &str) -> Option<Vec<String>> {
    let out = sys_command("git")
        .env("LC_ALL", "C")
        .arg("-C").arg(root)
        .args(["--no-optional-locks", "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // `-z` rather than lines: a path may contain anything but NUL, and this is the one
    // place a quoted or newline-bearing filename would silently split into two rows.
    let mut files: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .take(MAX_FILES)
        .map(|s| s.to_string())
        .collect();
    // `--cached` lists a conflicted path once per stage, so the same name can arrive
    // three times mid-merge.
    files.sort();
    files.dedup();
    Some(files)
}

/// The non-repo fallback: a bounded, breadth-limited walk that skips what no file
/// finder is looking for.
fn walk_index(root: &std::path::Path) -> (Vec<String>, bool) {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            if files.len() >= MAX_FILES {
                return (finish(files), true);
            }
            let name = e.file_name().to_string_lossy().to_string();
            // A dot-entry is configuration or version control, not what "find a file"
            // means; skipping them here is also what keeps `.git` out of the list.
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                // A symlinked directory is not descended into: it is the one way a
                // bounded walk still becomes an unbounded one.
                if depth + 1 < MAX_DEPTH && !ft.is_symlink() {
                    stack.push((e.path(), depth + 1));
                } else if depth + 1 >= MAX_DEPTH {
                    truncated = true;
                }
            } else if let Ok(rel) = e.path().strip_prefix(root) {
                files.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    (finish(files), truncated)
}

fn finish(mut files: Vec<String>) -> Vec<String> {
    files.sort();
    files.dedup();
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{git, scratch_dir};

    /// The repo path is the one that matters: it must return tracked *and* untracked
    /// files, and must not return anything `.gitignore` names — the property that lets
    /// the explorer skip having an ignore parser at all.
    #[test]
    fn project_files_lists_tracked_and_unignored_untracked() {
        let dir = scratch_dir();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "ignored.txt\ntarget/\n").unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["add", "."]);
        git(&dir, &["-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-q", "-m", "one"]);
        // one untracked-but-visible file, and two git is told to ignore
        std::fs::write(dir.join("notes.md"), "hi\n").unwrap();
        std::fs::write(dir.join("ignored.txt"), "no\n").unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(dir.join("target/out.bin"), "no\n").unwrap();

        let idx = project_files(dir.to_string_lossy().to_string());
        assert!(idx.repo, "a git repo should be indexed by git");
        assert!(idx.files.contains(&"src/main.rs".to_string()), "tracked file missing: {:?}", idx.files);
        assert!(idx.files.contains(&"notes.md".to_string()), "untracked file missing: {:?}", idx.files);
        assert!(idx.files.contains(&".gitignore".to_string()), "dotfiles are project files: {:?}", idx.files);
        assert!(!idx.files.iter().any(|f| f == "ignored.txt"), "ignored file listed: {:?}", idx.files);
        assert!(!idx.files.iter().any(|f| f.starts_with("target/")), "ignored dir listed: {:?}", idx.files);
        assert!(!idx.truncated);
    }

    /// The fallback has to work in a plain folder, and has to skip the two things that
    /// would otherwise dominate it: dot-directories and generated trees.
    #[test]
    fn project_files_walks_a_folder_that_is_not_a_repo() {
        let dir = scratch_dir();
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("top.txt"), "x").unwrap();
        std::fs::write(dir.join("a/b/deep.txt"), "x").unwrap();
        std::fs::write(dir.join(".hidden/secret.txt"), "x").unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), "x").unwrap();

        let idx = project_files(dir.to_string_lossy().to_string());
        assert!(!idx.repo, "a plain folder is not a repo");
        assert_eq!(idx.files, vec!["a/b/deep.txt".to_string(), "top.txt".to_string()]);
    }
}
