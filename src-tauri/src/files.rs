//! The explorer's project index: `git ls-files` for a repo (git honours `.gitignore`, so no parser
//! of ours), a bounded walk for anything else. Nothing here watches anything (docs/explorer.md).

use crate::platform::sys_command;

const MAX_FILES: usize = 20_000; // so a mis-aimed open (a home directory, `/`) cannot hang the overlay
const MAX_DEPTH: usize = 8;      // deep enough for a monorepo, shallow enough to bound the walk
/// Ordinary names that hold generated trees; `.git` and friends are covered by the dot rule.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "__pycache__"];

#[derive(serde::Serialize)]
pub(crate) struct FileIndex {
    files: Vec<String>, // repo-relative, forward slashes, sorted, deduplicated
    truncated: bool,    // the cap stopped the walk early; the overlay says so
    repo: bool,         // whether git produced the list; the empty state reads differently
}

/// One flat list feeds both explorer modes, so they cannot disagree and no folder costs a round trip.
#[tauri::command(async)]
pub(crate) fn project_files(root: String) -> FileIndex {
    let (files, truncated, repo) = index_of(&root);
    FileIndex { files, truncated, repo }
}

/// The in-crate half: `health.rs` measures exactly the files the explorer lists.
pub(crate) fn index_of(root: &str) -> (Vec<String>, bool, bool) {
    if let Some((files, truncated)) = git_index(root) {
        return (files, truncated, true);
    }
    let (files, truncated) = walk_index(std::path::Path::new(root));
    (files, truncated, false)
}

/// None when this is not a repo or git is unavailable (the walk answers). Truncation is decided
/// before dedup: a mid-merge `--cached` lists a conflicted path once per stage.
fn git_index(root: &str) -> Option<(Vec<String>, bool)> {
    let out = sys_command("git")
        .env("LC_ALL", "C")
        .arg("-C").arg(root)
        .args(["--no-optional-locks", "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // `-z`: a path may contain a newline, never a NUL.
    let text = String::from_utf8_lossy(&out.stdout);
    let mut it = text.split('\0').filter(|s| !s.is_empty());
    let mut files: Vec<String> = it.by_ref().take(MAX_FILES).map(|s| s.to_string()).collect();
    let truncated = it.next().is_some();
    files.sort();
    files.dedup();
    Some((files, truncated))
}

/// The non-repo fallback: a bounded walk that skips what no file finder is looking for.
fn walk_index(root: &std::path::Path) -> (Vec<String>, bool) {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // A dot-entry is configuration or version control; this is also what keeps `.git` out.
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            // Before `is_dir`: `file_type()` never follows a link, so a symlink to a directory would
            // be listed as a file. Skipping links also bounds the walk.
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if depth + 1 < MAX_DEPTH {
                    stack.push((e.path(), depth + 1));
                } else {
                    truncated = true;
                }
            } else if let Ok(rel) = e.path().strip_prefix(root) {
                // Checked here rather than per entry: a dot-entry or a `SKIP_DIRS` folder
                // after the last file is nothing withheld, and must not say `truncated`.
                if files.len() >= MAX_FILES {
                    return (finish(files), true);
                }
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

    #[test]
    fn project_files_lists_tracked_and_unignored_untracked() {
        let dir = scratch_dir();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "ignored.txt\ntarget/\n").unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["add", "."]);
        git(&dir, &["-c", "user.email=t@e.st", "-c", "user.name=t",
                    "-c", "commit.gpgsign=false", "commit", "-q", "-m", "one"]);
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
