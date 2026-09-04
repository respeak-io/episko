//! Test-only helpers shared by several modules' `mod tests`; a single-owner helper stays with its owner.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

pub(crate) static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Run git in `dir`, asserting success; callers pass identity/signing via `-c`, not the global gitconfig.
pub(crate) fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(dir).args(args).output().expect("failed to spawn git");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// A fresh scratch dir in its physical spelling, so fixtures compare like with like (docs/testing.md).
pub(crate) fn scratch_dir() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("episko_git_diff_test_{}_{}", std::process::id(), n));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // After creation: `canonicalize` needs the directory to exist.
    PathBuf::from(crate::platform::physical_cwd(&dir.to_string_lossy()))
}
