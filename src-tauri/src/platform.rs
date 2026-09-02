//! The OS layer: the leaves every module calls (first half) and the OS integrations
//! nobody else wants (second half). The first half imports nothing from the crate;
//! a cfg-gated helper with a single consumer module belongs to that module instead.

use tauri::State;

use crate::AppState;

pub(crate) fn home_dir() -> String {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").unwrap_or_default()
    }
}

/// Canonical spelling for a path the frontend compares by exact string equality: on
/// Windows git, the folder dialog and VS Code each spell one folder differently, so
/// every path handed to the frontend goes through here. Identity elsewhere.
pub(crate) fn norm_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let mut s = p.replace('/', "\\");
        if s.as_bytes().get(1) == Some(&b':') && s.as_bytes()[0].is_ascii_lowercase() {
            s[..1].make_ascii_uppercase();
        }
        s
    }
    #[cfg(not(windows))]
    {
        p.to_string()
    }
}

/// Windows `canonicalize` returns the verbatim form (`\\?\C:\Work`), which is not the
/// spelling Claude records. Split from `physical_cwd` so it is testable on every OS.
pub(crate) fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

/// The physical spelling of `cwd`: what `getcwd()` reports through a symlink, hence
/// what Claude's transcript encoding and `git` both use. Falls back to the input when
/// the path no longer resolves (a removed worktree is a real case).
pub(crate) fn physical_cwd(cwd: &str) -> String {
    match std::fs::canonicalize(cwd) {
        Ok(p) => strip_verbatim(&p.to_string_lossy()),
        Err(_) => cwd.to_string(),
    }
}

/// `Command::new` that never flashes a console window on Windows (`CREATE_NO_WINDOW`).
pub(crate) fn sys_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let c = std::process::Command::new(program);
    #[cfg(windows)]
    let mut c = c;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

// ---------- deleting a directory something else is holding ----------
// Windows refuses to delete a directory any process has open, where POSIX unlinks it
// and lets the last handle close later. The useful thing to report is who holds it.

/// One process keeping a path alive. `ours` lets a caller kill its own children
/// silently and never somebody else's editor without asking.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub(crate) struct PathHolder {
    pub pid: u32,
    pub name: String,      // as the OS spells it; shown verbatim
    pub why: &'static str, // "cwd" (sitting in it) or "file" (open handle)
    pub ours: bool,        // Episko itself or a descendant
}

/// `p` is `root` or beneath it; case-insensitive on Windows, where the filesystem is.
fn under(p: &std::path::Path, root: &std::path::Path) -> bool {
    let (a, b) = (p.to_string_lossy(), root.to_string_lossy());
    let (a, b) = if cfg!(windows) {
        (norm_path(&a).to_lowercase(), norm_path(&b).to_lowercase())
    } else {
        (a.to_string(), b.to_string())
    };
    a == b || a.starts_with(&format!("{b}{}", std::path::MAIN_SEPARATOR))
}

/// Which processes hold `dir`: by cwd everywhere, and by open handle on Windows when
/// `stuck` names the file that refused. Best-effort: this is a diagnostic shown after
/// a failure, so every probe degrades to "found nothing" rather than a second error.
pub(crate) fn path_holders(dir: &str, stuck: Option<&str>) -> Vec<PathHolder> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let root = std::path::PathBuf::from(norm_path(dir));
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    // pid → (ppid, name), both out of the one snapshot
    let procs: std::collections::HashMap<u32, (Option<u32>, String)> = sys
        .processes()
        .iter()
        .map(|(pid, p)| {
            (pid.as_u32(), (p.parent().map(|x| x.as_u32()), p.name().to_string_lossy().to_string()))
        })
        .collect();
    let us = std::process::id();
    // Same walk and cap as `ProcTable::is_descendant_of`; the cap is what stops a
    // ppid cycle, which pid reuse on Windows can produce.
    let ours = |mut pid: u32| {
        for _ in 0..24 {
            if pid == us {
                return true;
            }
            match procs.get(&pid).and_then(|(pp, _)| *pp) {
                Some(pp) if pp > 1 && pp != pid => pid = pp,
                _ => return false,
            }
        }
        false
    };

    let mut out: Vec<PathHolder> = Vec::new();
    for (pid, p) in sys.processes() {
        let pid = pid.as_u32();
        if pid == us {
            continue; // never offer to kill ourselves
        }
        if p.cwd().is_some_and(|c| under(c, &root)) {
            out.push(PathHolder {
                pid,
                name: p.name().to_string_lossy().to_string(),
                why: "cwd",
                ours: ours(pid),
            });
        }
    }
    if let Some(stuck) = stuck {
        for (pid, name) in file_handle_holders(stuck) {
            if pid != us && !out.iter().any(|h| h.pid == pid) {
                out.push(PathHolder { pid, name, why: "file", ours: ours(pid) });
            }
        }
    }
    // Ours first: the caller clears those without asking.
    out.sort_by_key(|h| (!h.ours, h.pid));
    out
}

/// Which processes have `file` open, via the Restart Manager. RM answers about files,
/// never directories, which is why `remove_tree` reports which path refused.
#[cfg(windows)]
fn file_handle_holders(file: &str) -> Vec<(u32, String)> {
    use windows_sys::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
        RM_PROCESS_INFO,
    };
    // A give-up threshold, not a truncation: RmGetList refuses a short buffer outright.
    const MAX: u32 = 256;
    let wide: Vec<u16> = file.encode_utf16().chain(std::iter::once(0)).collect();
    let mut session: u32 = 0;
    let mut key = vec![0u16; CCH_RM_SESSION_KEY as usize + 1];
    unsafe {
        if RmStartSession(&mut session, 0, key.as_mut_ptr()) != 0 {
            return vec![];
        }
        let names = [wide.as_ptr() as windows_sys::core::PCWSTR];
        let mut found: Vec<(u32, String)> = vec![];
        if RmRegisterResources(session, 1, names.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null()) == 0 {
            let (mut needed, mut have, mut reason) = (0u32, 0u32, 0u32);
            // Size query first; it is expected to fail with ERROR_MORE_DATA.
            RmGetList(session, &mut needed, &mut have, std::ptr::null_mut(), &mut reason);
            if needed > 0 && needed <= MAX {
                let mut infos = vec![RM_PROCESS_INFO::default(); needed as usize];
                have = needed;
                if RmGetList(session, &mut needed, &mut have, infos.as_mut_ptr(), &mut reason) == 0 {
                    for i in infos.iter().take(have as usize) {
                        let n = i.strAppName.iter().position(|c| *c == 0).unwrap_or(i.strAppName.len());
                        found.push((i.Process.dwProcessId, String::from_utf16_lossy(&i.strAppName[..n])));
                    }
                }
            }
        }
        RmEndSession(session);
        found
    }
}

/// Nothing to ask elsewhere: a directory whose files are open still deletes there.
#[cfg(not(windows))]
fn file_handle_holders(_file: &str) -> Vec<(u32, String)> {
    vec![]
}

/// Kill `pid` and its descendants: on Windows a `node` the PTY child started outlives
/// it and keeps pinning the folder. Returns whether the kill was issued, not whether
/// the process is gone; callers re-probe.
pub(crate) fn kill_pid_tree(pid: u32) -> bool {
    if pid <= 4 {
        return false; // 0 and 4 are the kernel's own on Windows
    }
    #[cfg(windows)]
    {
        sys_command("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).status().is_ok_and(|s| s.success())
    }
    #[cfg(not(windows))]
    {
        // `-pid` kills the process group (the POSIX analogue of /T); bare pid if it leads none.
        let grp = sys_command("kill").arg("-9").arg(format!("-{pid}")).status().is_ok_and(|s| s.success());
        grp || sys_command("kill").arg("-9").arg(pid.to_string()).status().is_ok_and(|s| s.success())
    }
}

/// `remove_dir_all` that reports which path refused (the Restart Manager can only be
/// asked about a file) and clears the read-only attribute first (a Windows failure
/// with nothing holding the file). Never follows a link: a junction or symlink is
/// removed as the link, so its target is untouched.
pub(crate) fn remove_tree(path: &std::path::Path) -> Result<(), (std::path::PathBuf, std::io::Error)> {
    let fail = |e: std::io::Error| (path.to_path_buf(), e);
    let md = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        // Already gone is the outcome being asked for, not a failure to report.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(fail(e)),
    };
    let ft = md.file_type();
    if ft.is_symlink() {
        // A junction needs `remove_dir`, a file symlink `remove_file`, and
        // `symlink_metadata` does not reliably tell them apart; try both.
        return std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path)).map_err(fail);
    }
    if ft.is_dir() {
        for e in std::fs::read_dir(path).map_err(fail)?.flatten() {
            remove_tree(&e.path())?;
        }
        return std::fs::remove_dir(path).map_err(fail);
    }
    #[cfg(windows)]
    if md.permissions().readonly() {
        let mut perm = md.permissions();
        // Windows-only arm: this clears one attribute bit, not Unix mode bits.
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        let _ = std::fs::set_permissions(path, perm);
    }
    std::fs::remove_file(path).map_err(fail)
}

/// GUI apps get a stripped PATH, so probe known install locations before `command -v`.
#[cfg(not(windows))]
pub(crate) fn resolve_claude() -> String {
    let home = home_dir();
    let candidates = [
        format!("{home}/.local/bin/claude"),
        format!("{home}/.claude/local/claude"),
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
        "/usr/bin/claude".to_string(),
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if let Ok(o) = sys_command(&shell).args(["-lic", "command -v claude"]).output() {
        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "claude".to_string()
}

/// Windows: prefer the native installer's `claude.exe` (spawnable directly, unlike the
/// npm `.cmd` shim which needs a shell), then `where`.
#[cfg(windows)]
pub(crate) fn resolve_claude() -> String {
    let home = home_dir();
    let candidates = [
        format!(r"{home}\.local\bin\claude.exe"),
        format!(r"{home}\.claude\local\claude.exe"),
        format!(r"{home}\AppData\Local\Programs\claude\claude.exe"),
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    // `where` may print several lines (claude.exe + claude.cmd); prefer a .exe.
    if let Ok(o) = sys_command("where").arg("claude").output() {
        let text = String::from_utf8_lossy(&o.stdout);
        let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        if let Some(exe) = lines.iter().find(|l| l.to_lowercase().ends_with(".exe")) {
            return exe.to_string();
        }
        if let Some(first) = lines.first() {
            return first.to_string();
        }
    }
    "claude".to_string()
}

/// Fences the PATH in a shell probe's output, so rc-file chatter is not read as PATH.
#[cfg(not(windows))]
const PATH_MARK: &str = "__EPISKO_PATH__";

/// The user's own terminal PATH, probed once per run; `None` when the probe failed.
#[cfg(not(windows))]
static SHELL_PATH: std::sync::LazyLock<Option<String>> =
    std::sync::LazyLock::new(probe_shell_path);

/// Pull the PATH out of a shell probe's stdout. Rc files print things, so the value is
/// fenced by markers; anything that is not a colon-separated list of existing dirs is
/// rejected (fish prints `$PATH` space-separated, and half a PATH shadows the fallback).
#[cfg(not(windows))]
fn path_from_probe(out: &str) -> Option<String> {
    let val = out.split(PATH_MARK).nth(1)?.trim();
    let dirs: Vec<&str> = val.split(':').filter(|d| !d.is_empty()).collect();
    if dirs.len() < 2 || !dirs.iter().any(|d| std::path::Path::new(d).is_dir()) {
        return None;
    }
    Some(val.to_string())
}

/// Ask the login shell for its PATH interactively: zsh reads `~/.zshrc` (where nvm,
/// pnpm, mise and Homebrew export) only for `-i` shells, and a plain `-l -c` misses
/// them all. Never used for a task itself, since an interactive shell prints rc noise.
#[cfg(not(windows))]
fn probe_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = format!("printf '%s%s%s' '{PATH_MARK}' \"$PATH\" '{PATH_MARK}'");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = std::process::Command::new(&shell)
            .args(["-i", "-l", "-c"])
            .arg(&script)
            // An rc file that reads stdin would otherwise wait forever.
            .stdin(std::process::Stdio::null())
            .output();
        let _ = tx.send(out.ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()));
    });
    // A hung rc file must cost a fallback, not a hung UI (the git poll reaches this).
    let out = rx.recv_timeout(std::time::Duration::from_secs(5)).ok()??;
    path_from_probe(&out)
}

/// Warm `SHELL_PATH` off the UI's back; `LazyLock` blocks its first caller.
#[cfg(not(windows))]
pub(crate) fn warm_shell_path() {
    std::thread::spawn(|| {
        let _ = SHELL_PATH.as_deref();
    });
}

#[cfg(windows)]
pub(crate) fn warm_shell_path() {}

/// A PATH with the usual per-user bin dirs, for a stripped-PATH launch. `~/.cargo/bin`
/// is for the task introspectors (`just`, `mise`), not for `claude`.
#[cfg(not(windows))]
pub(crate) fn augmented_path() -> String {
    let home = home_dir();
    let fallbacks = format!(
        "{home}/.local/bin:{home}/.claude/local:{home}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    );
    match SHELL_PATH.as_deref() {
        // The user's own ordering first: a task must get nvm's node, not /usr/local/bin's.
        Some(p) => format!("{p}:{fallbacks}"),
        // No probe: under Finder the fallbacks do all the work.
        None => format!("{fallbacks}:{}", std::env::var("PATH").unwrap_or_default()),
    }
}

/// `;`-separated; System32 is where `curl.exe` lives.
#[cfg(windows)]
pub(crate) fn augmented_path() -> String {
    let home = home_dir();
    let base = std::env::var("PATH").unwrap_or_default();
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    format!(r"{home}\.local\bin;{home}\.claude\local;{home}\.cargo\bin;{sysroot}\System32;{base}")
}

/// Single-quote a string for safe inclusion in a POSIX shell script.
#[cfg(not(windows))]
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// One `ps -o <fields>=` line for a pid, or None. Not compiled on Windows, and that is
/// load-bearing: its only caller is the macOS half of `focus_external_session`, and a
/// stub with no callers is `dead_code`, a CI failure under `-D warnings`.
#[cfg(not(windows))]
pub(crate) fn ps_one(pid: u32, fields: &str) -> Option<String> {
    let out = sys_command("ps")
        .args(["-p", &pid.to_string(), "-o", fields])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Open a folder in the OS file manager; refuses a vanished directory rather than
/// silently doing nothing.
#[tauri::command]
pub(crate) fn open_folder(dir: String) -> Result<(), String> {
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    #[cfg(windows)]
    {
        // Explorer only understands backslashes; given a forward-slash path (git emits
        // `E:/…`) it silently opens Documents instead. `is_dir` accepts either form.
        let dir = dir.replace('/', "\\");
        // explorer.exe exits non-zero even when the window opened; never wait on it.
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        std::process::Command::new(format!(r"{sysroot}\explorer.exe"))
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("open Explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("open Finder: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
    }
    Ok(())
}

/// Reveal `dir/rel` selected in the file manager (Reveal source on a task). `rel` is
/// repo-relative so a malformed override cannot escape the project; falls back to the
/// folder where the OS cannot select a file.
#[tauri::command]
pub(crate) fn reveal_path(dir: String, rel: String) -> Result<(), String> {
    let root = std::path::Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    // `rel` comes from discovery data, so don't trust it. A rooted (`/x`) or
    // drive-prefixed component makes `join` replace the whole base, and `/x` is not
    // `is_absolute()` on Windows, so the component check is the guard.
    let rel_path = std::path::Path::new(&rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!("not a project-relative path: {rel}"));
    }
    let target = root.join(rel_path);
    // A source since deleted: reveal the project folder rather than erroring.
    let exists = target.is_file();
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("open");
        if exists {
            c.arg("-R").arg(&target);
        } else {
            c.arg(root);
        }
        c.spawn().map_err(|e| format!("open Finder: {e}"))?;
    }
    #[cfg(windows)]
    {
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let mut c = std::process::Command::new(format!(r"{sysroot}\explorer.exe"));
        if exists {
            // /select, takes one argument: the file to highlight in its folder.
            c.arg(format!("/select,{}", target.display().to_string().replace('/', "\\")));
        } else {
            c.arg(dir.replace('/', "\\"));
        }
        c.spawn().map_err(|e| format!("open Explorer: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "select the file" across Linux file managers; open the folder.
        let open_target = if exists { target.parent().unwrap_or(root) } else { root };
        std::process::Command::new("xdg-open")
            .arg(open_target)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
    }
    Ok(())
}

/// Probe ceiling per `resolve_link_path` call. Must clear `MAX_CANDS` x the base list
/// (24 x 24) with room: running out mid-list drops the tail, and the shortest reading,
/// proposed last, is the one that usually wins.
const LINK_PROBE_BUDGET: usize = 1024;

/// Which of the paths a terminal printed exists: the backend half of src/termlinks.ts.
/// `cands` arrives longest-first and the first that resolves wins; `bases` is tried in
/// order for a relative one. No globbing or fuzzy match: this is what keeps links off
/// ordinary prose. The index says how many words of the line the underline claims.
#[tauri::command]
pub(crate) fn resolve_link_path(bases: Vec<String>, cands: Vec<String>) -> Option<(usize, String)> {
    let home = home_dir();
    let mut budget = LINK_PROBE_BUDGET;
    for (i, raw) in cands.iter().enumerate() {
        let c = raw.trim();
        // `.`/`..` resolve against every base; one character is leftover punctuation.
        // Counted in chars, not bytes: `ä` is two bytes and still one character.
        if c.chars().nth(1).is_none() || c == ".." {
            continue;
        }
        let cand = match c.strip_prefix("~/") {
            Some(rest) if !home.is_empty() => format!("{home}/{rest}"),
            Some(_) => continue,
            None => c.to_string(),
        };
        let p = std::path::Path::new(&cand);
        if p.is_absolute() {
            if budget == 0 {
                break;
            }
            budget -= 1;
            if p.exists() {
                return Some((i, norm_path(&cand)));
            }
            continue;
        }
        for b in &bases {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let joined = std::path::Path::new(b).join(&cand);
            if joined.exists() {
                return Some((i, norm_path(&joined.to_string_lossy())));
            }
        }
    }
    None
}

/// Open a file with the OS handler (primary click on a Context row). Separate from
/// `reveal_path` because the trust story differs: the path is one the agent already
/// read or wrote, so it may legitimately sit outside the project. On macOS falls back
/// to revealing when no app claims the extension (a stock machine has none for `.rs`).
#[tauri::command]
pub(crate) fn open_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("no longer there: {path}"));
    }
    #[cfg(target_os = "macos")]
    {
        // `.status()`, not `.spawn()`: the exit code is the only signal that no app
        // claimed the file, and `open` returns it in milliseconds.
        let opened = std::process::Command::new("open")
            .arg(&path)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !opened {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map_err(|e| format!("open Finder: {e}"))?;
        }
    }
    #[cfg(windows)]
    {
        // Same backslash rule as `open_folder`.
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        std::process::Command::new(format!(r"{sysroot}\explorer.exe"))
            .arg(path.replace('/', "\\"))
            .spawn()
            .map_err(|e| format!("open Explorer: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
    }
    Ok(())
}

/// Show an absolute path selected in the file manager (the ⌂ on a Context row). Same
/// trust story as `open_file`.
#[tauri::command]
pub(crate) fn reveal_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("no longer there: {path}"));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open Finder: {e}"))?;
    }
    #[cfg(windows)]
    {
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        std::process::Command::new(format!(r"{sysroot}\explorer.exe"))
            .arg(format!("/select,{}", path.replace('/', "\\")))
            .spawn()
            .map_err(|e| format!("open Explorer: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "select the file" across Linux file managers; open the folder.
        let target = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
    }
    Ok(())
}

/// A caffeinate flag worth passing through: a cluster over `-dimsu`, `-t`, or a bare
/// number (its seconds). The UI only sends presets; this guards the shell-less spawn.
#[cfg(not(windows))]
fn valid_caffeinate_flag(f: &str) -> bool {
    if let Some(rest) = f.strip_prefix('-') {
        return !rest.is_empty() && rest.chars().all(|c| "dimsut".contains(c));
    }
    !f.is_empty() && f.chars().all(|c| c.is_ascii_digit())
}

/// Toggle the macOS `caffeinate` assertion. Only one child ever runs: the existing one
/// is killed first, so a preset switch is stop+restart.
#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn set_caffeinate(state: State<AppState>, active: bool, flags: Vec<String>) -> Result<(), String> {
    let mut guard = state.caffeinate.lock().unwrap();
    // Tear down whatever's running (also reaps a child that self-exited on -t).
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if !active || flags.is_empty() {
        return Ok(());
    }
    if let Some(bad) = flags.iter().find(|f| !valid_caffeinate_flag(f)) {
        return Err(format!("refusing unknown caffeinate flag: {bad}"));
    }
    // `-w <our pid>`: caffeinate exits with Episko, so a crash cannot leave the display pinned.
    let mut cmd = std::process::Command::new("/usr/bin/caffeinate");
    cmd.arg("-w").arg(std::process::id().to_string());
    for f in &flags {
        cmd.arg(f);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("caffeinate: {e}"))?;
    *guard = Some(child);
    Ok(())
}

/// A live Windows power assertion. `SetThreadExecutionState` is scoped to the calling
/// thread, so a thread is parked for as long as the assertion should hold; it dies
/// with the process, which is the safety net `caffeinate -w` gives macOS.
#[cfg(windows)]
pub(crate) struct KeepAwake {
    /// Dropping this disconnects the channel; the parked thread clears the state and exits.
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(windows)]
impl Drop for KeepAwake {
    fn drop(&mut self) {
        drop(self.stop.take());
        // Join so the state is cleared before a replacement is set up, or a preset
        // switch races the old thread's clearing call and lands on ES_CONTINUOUS.
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The UI's `caffeinate` flags as Windows execution-state bits: `-d` → display (and
/// system), `-i`/`-s` → system; `-m`, `-u` and `-t` have no equivalent and are
/// dropped. 0 when nothing was requested. `ES_AWAYMODE_REQUIRED` is not mapped on
/// purpose: where away mode is off the whole call fails and asserts nothing.
#[cfg(windows)]
fn execution_state_for(flags: &[String]) -> u32 {
    use windows_sys::Win32::System::Power::{ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
    let mut es = 0u32;
    for f in flags {
        let Some(rest) = f.strip_prefix('-') else { continue }; // bare `-t` argument
        for c in rest.chars() {
            match c {
                'd' => es |= ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED,
                'i' | 's' => es |= ES_SYSTEM_REQUIRED,
                _ => {} // m / u / t — nothing to assert
            }
        }
    }
    es
}

/// How often the parked thread re-states its execution state: Windows does not keep
/// it across suspend/resume, and the frontend only re-invokes on a flag change. 30s is
/// under the one-minute minimum "Sleep after" Windows allows, so a resume never outruns it.
#[cfg(windows)]
const REASSERT_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

/// Park a thread holding `es` until the handle drops, re-stating it every `every`.
/// Set and release must happen on the same thread. Takes the interval so a test can
/// drive the cycle without an `AppState` or a half-minute suite.
#[cfg(windows)]
fn spawn_keep_awake(
    es: u32,
    every: std::time::Duration,
    on_reassert: impl Fn() + Send + 'static,
) -> Result<KeepAwake, String> {
    use std::sync::mpsc::{channel, RecvTimeoutError};
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
    let (stop, rx) = channel::<()>();
    let (ready, ready_rx) = channel::<Result<(), String>>();
    let thread = std::thread::spawn(move || {
        // SAFETY: a plain flags-in/flags-out Win32 call with no pointers.
        let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | es) };
        if prev == 0 {
            let _ = ready.send(Err("SetThreadExecutionState refused the request".into()));
            return;
        }
        let _ = ready.send(Ok(()));
        // `recv_timeout` reports `Disconnected` the moment the sender drops, not at
        // the next tick, so `Drop`'s join never stalls the caller.
        while let Err(RecvTimeoutError::Timeout) = rx.recv_timeout(every) {
            // SAFETY: same pointer-free call. Idempotent except after a resume, which is when it matters.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | es) };
            on_reassert();
        }
        // SAFETY: same call; ES_CONTINUOUS alone clears our assertion.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    });
    // A refusal is an error, or the UI paints the cup lit over a sleeping PC.
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(KeepAwake { stop: Some(stop), thread: Some(thread) }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err("keep-awake thread died before asserting".into()),
    }
}

/// The Windows `caffeinate` counterpart; only one assertion is ever live.
#[cfg(windows)]
#[tauri::command]
pub(crate) fn set_caffeinate(state: State<AppState>, active: bool, flags: Vec<String>) -> Result<(), String> {
    let mut guard = state.caffeinate.lock().unwrap();
    guard.take(); // drop → releases whatever was asserted
    if !active || flags.is_empty() {
        return Ok(());
    }
    let es = execution_state_for(&flags);
    if es == 0 {
        return Err(format!("no Windows keep-awake equivalent for: {}", flags.join(" ")));
    }
    *guard = Some(spawn_keep_awake(es, REASSERT_EVERY, || {})?);
    Ok(())
}

// ---------- one-time recovery of localStorage stranded by a rename ----------
// macOS keys a WKWebView's localStorage to the bundle id, so `io.respeak.cclauncher`
// -> `io.respeak.episko` left every `cc-*` key behind. This reads them off the old
// SQLite; the boot shim in `main.ts` imports only keys it does not already have.

/// WebKit stores localStorage values as UTF-16LE BLOBs (no BOM).
#[cfg(target_os = "macos")]
fn decode_utf16le(bytes: &[u8]) -> String {
    // `as_chunks`, not `chunks_exact`: clippy's `chunks_exact_to_as_chunks` is a CI gate.
    let (pairs, _) = bytes.as_chunks::<2>();
    let units: Vec<u16> = pairs.iter().copied().map(u16::from_le_bytes).collect();
    String::from_utf16_lossy(&units)
}

/// Depth-limited walk for `localstorage.sqlite3` (the origin hash dirs are minted at
/// runtime). The largest match wins: a stale empty store can sit beside the real one.
#[cfg(target_os = "macos")]
fn newest_localstorage_db(base: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut best: Option<(u64, std::path::PathBuf)> = None;
    let mut stack = vec![(base.to_path_buf(), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 6 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push((p, depth + 1));
            } else if p.file_name().and_then(|n| n.to_str()) == Some("localstorage.sqlite3") {
                let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
                if best.as_ref().is_none_or(|(b, _)| sz > *b) {
                    best = Some((sz, p));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Every `cc-*` key from a WebKit `localstorage.sqlite3`, read off a private copy so
/// SQLite can fold in a stranded `-wal` without touching the original.
#[cfg(target_os = "macos")]
fn read_itemtable_cc_keys(
    db: &std::path::Path,
) -> Result<std::collections::HashMap<String, String>, String> {
    let tmp_dir = std::env::temp_dir().join("cc-launcher");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let tmp = tmp_dir.join("legacy-localstorage.sqlite3");
    for ext in ["sqlite3", "sqlite3-wal", "sqlite3-shm"] {
        let _ = std::fs::remove_file(tmp.with_extension(ext));
    }
    std::fs::copy(db, &tmp).map_err(|e| format!("copy legacy store: {e}"))?;
    for ext in ["sqlite3-wal", "sqlite3-shm"] {
        let src = db.with_extension(ext);
        if src.exists() {
            let _ = std::fs::copy(&src, tmp.with_extension(ext));
        }
    }

    let read = (|| -> Result<std::collections::HashMap<String, String>, String> {
        let conn = rusqlite::Connection::open(&tmp).map_err(|e| format!("open legacy store: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM ItemTable")
            .map_err(|e| format!("query legacy store: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let key: String = row.get(0)?;
                let val: rusqlite::types::Value = row.get(1)?;
                Ok((key, val))
            })
            .map_err(|e| format!("read legacy rows: {e}"))?;
        let mut out = std::collections::HashMap::new();
        for (key, val) in rows.flatten() {
            if !key.starts_with("cc-") {
                continue;
            }
            let text = match val {
                rusqlite::types::Value::Blob(b) => decode_utf16le(&b),
                rusqlite::types::Value::Text(t) => t,
                _ => continue,
            };
            out.insert(key, text);
        }
        Ok(out)
    })();

    for ext in ["sqlite3", "sqlite3-wal", "sqlite3-shm"] {
        let _ = std::fs::remove_file(tmp.with_extension(ext));
    }
    read
}

#[tauri::command]
pub(crate) fn read_legacy_localstorage() -> Result<std::collections::HashMap<String, String>, String> {
    #[cfg(target_os = "macos")]
    {
        // Previous bundle ids, newest first; the `pnpm tauri dev` store is excluded on purpose.
        const LEGACY_IDS: &[&str] = &["io.respeak.cclauncher"];
        let home = home_dir();
        for id in LEGACY_IDS {
            let base = std::path::Path::new(&home)
                .join("Library/WebKit")
                .join(id)
                .join("WebsiteData/Default");
            let Some(db) = newest_localstorage_db(&base) else {
                continue;
            };
            let map = read_itemtable_cc_keys(&db)?;
            if !map.is_empty() {
                return Ok(map);
            }
        }
        Ok(std::collections::HashMap::new())
    }
    #[cfg(not(target_os = "macos"))]
    {
        // WebView2 uses LevelDB, and no pre-rename Windows build exists: nothing to recover.
        Ok(std::collections::HashMap::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Gated with the macOS-only test that uses them; an unused import fails clippy.
    #[cfg(target_os = "macos")]
    use crate::testutil::COUNTER;
    #[cfg(target_os = "macos")]
    use std::sync::atomic::Ordering;

    /// `ours` matters as much as the find: the caller clears its own processes
    /// silently and only ever puts somebody else's in a dialog.
    #[test]
    fn path_holders_finds_a_process_sitting_in_the_folder_and_knows_it_is_ours() {
        let dir = crate::testutil::scratch_dir();
        let path = dir.to_string_lossy().to_string();
        // Something that stays alive without stdin and exists on a bare runner.
        #[cfg(windows)]
        let mut child = sys_command("cmd.exe")
            .args(["/c", "ping -n 30 127.0.0.1"])
            .current_dir(&dir)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn a child in the folder");
        #[cfg(not(windows))]
        let mut child = sys_command("sleep")
            .arg("30")
            .current_dir(&dir)
            .spawn()
            .expect("spawn a child in the folder");

        // A just-spawned child need not be in the first snapshot; retry briefly.
        let mut found = None;
        for _ in 0..20 {
            if let Some(h) = path_holders(&path, None).into_iter().find(|h| h.pid == child.id()) {
                found = Some(h);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);

        let h = found.expect("the child should be reported as holding its own cwd");
        assert_eq!(h.why, "cwd", "found by working directory, not by handle: {h:?}");
        assert!(h.ours, "a child of the test process is ours: {h:?}");
        assert!(!h.name.is_empty(), "a holder must be nameable to be shown: {h:?}");
    }

    #[test]
    fn remove_tree_deletes_a_nested_read_only_tree_and_reports_what_refuses() {
        let dir = crate::testutil::scratch_dir();
        let deep = dir.join("a").join("b");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("plain.txt"), "x").unwrap();
        let ro = deep.join("locked.txt");
        std::fs::write(&ro, "x").unwrap();
        let mut perm = std::fs::metadata(&ro).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&ro, perm).unwrap();

        assert!(remove_tree(&dir).is_ok(), "a read-only file must not stop the delete");
        assert!(!dir.exists(), "the whole tree should be gone");

        // `ensure_folder_gone` retries, so deleting nothing is hit on every second pass.
        assert!(remove_tree(&dir).is_ok(), "deleting nothing succeeds");
    }

    /// A symlink inside a checkout (a shared `node_modules`) is ordinary, and following
    /// it would delete the target's contents.
    #[cfg(unix)]
    #[test]
    fn remove_tree_removes_a_link_and_never_what_it_points_at() {
        let dir = crate::testutil::scratch_dir();
        let outside = dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("precious.txt"), "keep me").unwrap();
        let tree = dir.join("tree");
        std::fs::create_dir_all(&tree).unwrap();
        std::os::unix::fs::symlink(&outside, tree.join("link")).unwrap();

        assert!(remove_tree(&tree).is_ok());
        assert!(!tree.exists(), "the tree itself goes");
        assert!(outside.join("precious.txt").exists(), "the link's target must survive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn norm_path_unifies_windows_spellings() {
        assert_eq!(norm_path("E:/Programming/Work/repo"), r"E:\Programming\Work\repo");
        assert_eq!(norm_path(r"e:\Programming\Work\repo"), r"E:\Programming\Work\repo");
        assert_eq!(norm_path(r"E:\already\native"), r"E:\already\native");
        assert_eq!(norm_path(r"\\server\share\x"), r"\\server\share\x");
        assert_eq!(norm_path(""), "");
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_probe_survives_rc_file_chatter() {
        let noisy = format!(
            "  Restart Zsh to retry gitstatus initialization:\n\n    exec zsh\n\
             {PATH_MARK}/opt/homebrew/bin:/usr/bin:/bin{PATH_MARK}\n"
        );
        assert_eq!(path_from_probe(&noisy).as_deref(), Some("/opt/homebrew/bin:/usr/bin:/bin"));
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_probe_refuses_what_is_not_a_path() {
        // fish: no separators at all.
        assert_eq!(path_from_probe(&format!("{PATH_MARK}/usr/bin /bin{PATH_MARK}")), None);
        // The shell died before printing, or printed only noise.
        assert_eq!(path_from_probe("command not found: printf"), None);
        assert_eq!(path_from_probe(&format!("{PATH_MARK}{PATH_MARK}")), None);
        // Colon-separated but nothing on it exists.
        assert_eq!(
            path_from_probe(&format!("{PATH_MARK}/nope/one:/nope/two{PATH_MARK}")),
            None
        );
    }

    /// Against this machine's real shell; must pass whether or not the probe lands.
    #[cfg(not(windows))]
    #[test]
    fn augmented_path_carries_the_fallback_dirs_whether_or_not_the_probe_lands() {
        let p = augmented_path();
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            assert!(p.contains(dir), "augmented PATH lost {dir}: {p}");
        }
        assert!(p.contains(".cargo/bin"), "cargo-installed tools need this: {p}");
    }

    #[cfg(not(windows))]
    #[test]
    fn norm_path_is_identity_off_windows() {
        assert_eq!(norm_path("/Users/tim/dev/episko"), "/Users/tim/dev/episko");
        assert_eq!(norm_path("a\\b"), "a\\b"); // a backslash is a legal filename char here
    }

    /// Pure string work, so it runs on every OS rather than only on the leg that can
    /// produce a verbatim path.
    #[test]
    fn verbatim_prefixes_are_stripped() {
        assert_eq!(strip_verbatim(r"\\?\C:\Work\Respeak"), r"C:\Work\Respeak");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\proj"), r"\\srv\share\proj");
        assert_eq!(strip_verbatim(r"C:\Work\Respeak"), r"C:\Work\Respeak");
        assert_eq!(strip_verbatim("/Users/tim/dev"), "/Users/tim/dev");
    }

    /// The external-terminal engines hand `open -a` a generated `.command` script, so
    /// a quote in a workdir or title must not be able to close the quoting.
    #[cfg(not(windows))]
    #[test]
    fn sh_quote_neutralises_embedded_quotes() {
        assert_eq!(sh_quote("/Users/tim/dev/episko"), "'/Users/tim/dev/episko'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("a'; rm -rf /; echo '"), r"'a'\''; rm -rf /; echo '\'''");
    }
    /// Fixture mirrors the real `ItemTable` schema so no machine-specific store is needed.
    #[cfg(target_os = "macos")]
    #[test]
    fn read_itemtable_decodes_utf16le_and_filters_cc_keys() {
        let dir = std::env::temp_dir().join(format!(
            "episko-legacy-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("localstorage.sqlite3");
        let _ = std::fs::remove_file(&db);
        let utf16le = |s: &str| -> Vec<u8> { s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect() };
        {
            let c = rusqlite::Connection::open(&db).unwrap();
            c.execute_batch(
                "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL);",
            )
            .unwrap();
            c.execute(
                "INSERT INTO ItemTable(key,value) VALUES(?1,?2)",
                rusqlite::params!["cc-usage", utf16le(r#"{"2026-07-21":603.45}"#)],
            )
            .unwrap();
            c.execute(
                "INSERT INTO ItemTable(key,value) VALUES(?1,?2)",
                rusqlite::params!["not-a-cc-key", utf16le("ignore me")],
            )
            .unwrap();
        }
        let map = read_itemtable_cc_keys(&db).unwrap();
        assert_eq!(map.get("cc-usage").map(String::as_str), Some(r#"{"2026-07-21":603.45}"#));
        assert!(!map.contains_key("not-a-cc-key"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn caffeinate_flags_map_to_execution_state() {
        use windows_sys::Win32::System::Power::{ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
        let f = |args: &[&str]| execution_state_for(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());

        assert_eq!(f(&["-d"]), ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        assert_eq!(f(&["-i"]), ES_SYSTEM_REQUIRED);
        assert_eq!(f(&["-dimsu"]), ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        // `-t` and its bare seconds must not be mistaken for a flag cluster.
        assert_eq!(f(&["-di", "-t", "3600"]), ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        // Nothing translatable → 0, which the command reports as an error.
        assert_eq!(f(&["-m"]), 0);
        assert_eq!(f(&[]), 0);
    }

    /// Three things at once: the assertion is re-stated, a tick is not a release, and
    /// a release is prompt. None is visible from outside, so they are counted.
    #[cfg(windows)]
    #[test]
    fn keep_awake_holds_across_reassert_ticks_and_still_releases_promptly() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;
        use std::time::{Duration, Instant};
        use windows_sys::Win32::System::Power::ES_SYSTEM_REQUIRED;
        let every = Duration::from_millis(5);
        let ticks = Arc::new(AtomicU32::new(0));
        let seen = Arc::clone(&ticks);
        let awake = spawn_keep_awake(ES_SYSTEM_REQUIRED, every, move || {
            seen.fetch_add(1, Ordering::Relaxed);
        })
        .expect("assertion refused");

        // A bare `recv()` would park and release identically; only the re-state count
        // tells the two apart.
        std::thread::sleep(every * 20);
        assert!(ticks.load(Ordering::Relaxed) > 0, "assertion was never re-stated");
        // A timeout must not be treated as a release.
        assert!(!awake.thread.as_ref().unwrap().is_finished(), "thread exited on a tick instead of holding");

        // `Drop` joins from a `#[tauri::command]`, so a release that waited for a tick
        // would freeze the UI for REASSERT_EVERY on every preset switch.
        let t = Instant::now();
        drop(awake);
        assert!(t.elapsed() < Duration::from_secs(1), "release waited for a tick: {:?}", t.elapsed());
    }

    #[cfg(not(windows))]
    #[test]
    fn caffeinate_flags_are_whitelisted() {
        for ok in ["-d", "-i", "-dimsu", "-t", "3600", "0"] {
            assert!(valid_caffeinate_flag(ok), "{ok} is one of the UI's own presets");
        }
        for bad in ["", "-", "--", "-x", "-d;", "-d -i", "36 00", "/usr/bin/evil"] {
            assert!(!valid_caffeinate_flag(bad), "{bad} must be refused");
        }
    }

    /// A folder a person named has spaces in it, so only disk knows where the path
    /// stopped and the sentence started.
    #[test]
    fn resolve_link_path_takes_the_longest_candidate_that_exists() {
        let root = crate::testutil::scratch_dir();
        let deep = root.join("I_Projekte/BA Reinickendorf/2_Kickoff");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("deck.pdf"), b"pdf").unwrap();
        let base = root.to_string_lossy().to_string();

        // The order ./termlinks emits: the whole path, then each shorter reading.
        let cands = vec![
            "I_Projekte/BA Reinickendorf/2_Kickoff/deck.pdf".to_string(),
            "I_Projekte/BA Reinickendorf/2_Kickoff".to_string(),
            "I_Projekte/BA".to_string(),
        ];
        let (i, hit) = resolve_link_path(vec![base.clone()], cands).expect("the deck resolves");
        assert_eq!(i, 0, "the index says how far the underline reaches");
        assert!(hit.ends_with("deck.pdf"), "resolved to {hit}");

        // A prefix that is a directory still resolves when nothing longer does.
        let (i, hit) = resolve_link_path(
            vec![base.clone()],
            vec!["I_Projekte/BA Reinickendorf/nope.pdf".to_string(), "I_Projekte/BA Reinickendorf".to_string()],
        )
        .expect("the folder resolves");
        assert_eq!(i, 1);
        assert!(hit.ends_with("Reinickendorf"), "resolved to {hit}");
    }

    /// Nothing is a link until disk says so; an absolute candidate skips the bases.
    #[test]
    fn resolve_link_path_answers_nothing_for_what_is_not_there() {
        let root = crate::testutil::scratch_dir();
        let base = root.to_string_lossy().to_string();
        std::fs::write(root.join("notes.md"), b"x").unwrap();

        assert!(resolve_link_path(vec![base.clone()], vec!["Kurzfassung".to_string()]).is_none());
        assert!(resolve_link_path(vec![base.clone()], vec!["docs/tour.md".to_string()]).is_none());
        assert!(resolve_link_path(vec![base.clone()], vec!["..".to_string(), ".".to_string()]).is_none());
        // No bases at all is the ordinary state of a brand-new pane.
        let abs = root.join("notes.md").to_string_lossy().to_string();
        let (_, hit) = resolve_link_path(vec![], vec![abs]).expect("an absolute path needs no base");
        assert!(hit.ends_with("notes.md"), "resolved to {hit}");
    }
}
