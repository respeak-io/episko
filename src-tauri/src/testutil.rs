// Test-only helpers shared by more than one module's `mod tests`.
//
// `scratch_dir` is the only one that qualifies: the git tests, the transcript tests
// and (later) the usage tests all need a fresh temp directory, and duplicating it
// per module is the drift bug PLAN warns about for `SORT_META`. Helpers with a
// single owner stay in that owner's test mod — `wt_root`, `git()` and `commit()`
// went to `git.rs` for exactly that reason.
//
// Compiled only under `cfg(test)`; `lib.rs` declares it as `#[cfg(test)] mod testutil;`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

pub(crate) static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Run a git command in `dir`, asserting success. Identity/signing are passed via
/// `-c` so the test doesn't depend on (or touch) the developer's global gitconfig.
///
/// It lived in `git.rs`'s test mod while that was its only owner. `usage.rs` now needs
/// a real repo too — a History row's `repo_root` is resolved by `git_repo_info`, and a
/// fixture that can't be a repo can't exercise it — which makes this exactly the
/// "shared by more than one module" case this file exists for.
pub(crate) fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(dir).args(args).output().expect("failed to spawn git");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// A fresh, empty scratch directory under the OS temp dir. No randomness (pid +
/// an atomic counter keep it unique even under cargo's parallel test threads).
pub(crate) fn scratch_dir() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("episko_git_diff_test_{}_{}", std::process::id(), n));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
