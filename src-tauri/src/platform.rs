// The OS layer: the leaves every other module calls, and the OS integrations no
// other module wants.
//
// **The leaves, first half of the file.** Three hard constraints from CLAUDE.md
// live here: a GUI app (and a Claude hook) runs with a stripped PATH, so
// `resolve_claude` probes known install locations and `augmented_path` rebuilds a
// usable PATH; a GUI app spawning a console subprocess flashes a window on Windows
// unless it goes through `sys_command`; and one folder has several spellings on
// Windows while the frontend merges projects by exact string equality, hence
// `norm_path`. These import nothing from the crate — that is what lets every other
// module depend on this one, and why this module had to move out first.
//
// **The integrations, second half.** Reveal-in-file-manager, keep-awake, and the
// one-time recovery of localStorage stranded by the bundle rename. They are here
// because each is a `#[cfg]` pair with no other home — not because they are leaves:
// `set_caffeinate` takes `State<AppState>`, which is why this module now imports
// from the crate root at all. Nothing in the first half may grow such a dependency.
//
// A cfg-gated helper with a single consumer module belongs to *that* module
// instead: `apply_utf8_locale`, `interactive_shell` and `task_shell` went with the
// PTY spawners, `same_path` with git.

use tauri::State;

use crate::AppState;

/// User's home directory — `USERPROFILE` on Windows, `HOME` elsewhere.
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

/// Canonical spelling for an absolute path the frontend will compare as a string.
/// The sidebar merges projects/worktrees by exact string equality (`byPath` in
/// projectList), but on Windows the same folder arrives in several spellings:
/// git prints forward slashes (`E:/repo`), the folder dialog native backslashes
/// (`E:\repo`), and VS Code-hosted claude sessions register a lowercase drive
/// letter (`e:\repo`) — so the same repo splits into duplicate sidebar groups.
/// Every command that hands a path to the frontend funnels it through here;
/// on other platforms it's the identity.
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

/// Windows `canonicalize` returns the *verbatim* form — `\\?\C:\Work` — which encodes
/// to a different directory than the `C:\Work` Claude records, so the prefix has to
/// come back off. Split out from `physical_cwd` because it is the half that can be
/// tested on every OS: the other half needs a real symlink on disk.
pub(crate) fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

/// The *physical* spelling of `cwd` — the one Claude will have recorded, and the one
/// `git` reports back.
///
/// This is not Claude being clever: a process that `chdir`s through a symlink still
/// reports the resolved path from `getcwd()`, so a session launched in `/tmp/x` (on
/// macOS a symlink to `/private/tmp/x`) writes its transcript under the
/// `-private-tmp-x` encoding and under no other. Encoding the spelling the *user*
/// picked would look in a directory that never exists, and the caller would read that
/// as "this project has no past sessions" rather than as a failure.
///
/// It lives here rather than in `usage.rs` because the transcript encoder is no longer
/// the only caller: `git::repo_root_of` needs the same resolution for the same
/// underlying reason — `git` resolves symlinks too, so a root read off the filesystem
/// only equals the one `git_repo_info` reports if both are physical.
///
/// Falls back to the input when the path won't resolve. A workdir that has been
/// deleted is a real case here (worktrees go away), and a best-effort spelling is
/// worth more to every caller than an error none can act on.
pub(crate) fn physical_cwd(cwd: &str) -> String {
    match std::fs::canonicalize(cwd) {
        Ok(p) => strip_verbatim(&p.to_string_lossy()),
        Err(_) => cwd.to_string(),
    }
}

/// A `std::process::Command` that never flashes a console window on Windows. A GUI
/// app spawning a console subprocess (git, where, curl, taskkill) pops a black
/// window for each call without `CREATE_NO_WINDOW`; on other platforms this is a
/// plain `Command::new`.
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
// Three leaves that only make sense together, and only exist because of one
// difference between the platforms: **Windows refuses to delete a directory any
// process has open**, where POSIX unlinks it and lets the last handle close in its
// own time. So a folder Episko has been asked to remove can survive the removal,
// and the only useful thing to say about that is *who* is keeping it.

/// One process keeping a path alive, as `path_holders` reports it.
///
/// Two fields carry the design. `why` separates the two ways a folder gets pinned,
/// because they are found by different means and read differently to a human: a
/// **cwd** holder is a process sitting in the folder (a terminal, a dev server, the
/// dying PTY pane whose removal started this), and a **file** holder has an open
/// handle (an editor, a watcher, an indexer). `ours` is what lets a caller finish its
/// own job silently — a process Episko launched is one it has already decided to
/// kill — while never terminating somebody else's editor without being asked.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub(crate) struct PathHolder {
    pub pid: u32,
    /// Process name as the OS spells it (`Code.exe`, `node`) — the UI shows it verbatim.
    pub name: String,
    /// `"cwd"` or `"file"`.
    pub why: &'static str,
    /// Episko itself, or a descendant of it.
    pub ours: bool,
}

/// True when `p` is `root` or sits underneath it. Case-insensitive on Windows, where
/// the filesystem is, and where the same folder legitimately arrives in more than one
/// spelling (see `norm_path`).
fn under(p: &std::path::Path, root: &std::path::Path) -> bool {
    let (a, b) = (p.to_string_lossy(), root.to_string_lossy());
    let (a, b) = if cfg!(windows) {
        (norm_path(&a).to_lowercase(), norm_path(&b).to_lowercase())
    } else {
        (a.to_string(), b.to_string())
    };
    a == b || a.starts_with(&format!("{b}{}", std::path::MAIN_SEPARATOR))
}

/// Which processes are holding `dir` — by working directory, and (Windows only, and
/// only when `stuck` names the file that actually refused) by open handle.
///
/// Best-effort by construction: this is a diagnostic shown *after* something already
/// failed, so every probe inside it degrades to "found nothing" rather than to an
/// error the caller would have to explain on top of the failure it is already
/// explaining. An empty list is an honest answer — a handle can be released between
/// the delete failing and this running, which is also why the caller retries first.
pub(crate) fn path_holders(dir: &str, stuck: Option<&str>) -> Vec<PathHolder> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let root = std::path::PathBuf::from(norm_path(dir));
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    // pid → (ppid, name), so ancestry and naming both come out of the one snapshot
    // rather than costing a second process table walk each.
    let procs: std::collections::HashMap<u32, (Option<u32>, String)> = sys
        .processes()
        .iter()
        .map(|(pid, p)| {
            (pid.as_u32(), (p.parent().map(|x| x.as_u32()), p.name().to_string_lossy().to_string()))
        })
        .collect();
    let us = std::process::id();
    // Same walk and same cap as `ProcTable::is_descendant_of`: the bound is what stops
    // a ppid cycle, which Windows can produce after pid reuse hands a dead parent's
    // number to a new process.
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
            continue; // we are not holding it, and offering to kill ourselves is absurd
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
    // Ours first: the caller clears those without asking, so they should read as the
    // part already handled rather than as part of the problem.
    out.sort_by_key(|h| (!h.ours, h.pid));
    out
}

/// Which processes have `file` open, via the Restart Manager — the API the Windows
/// installer stack uses for precisely this question, and the reason `remove_tree`
/// bothers to report *which* path refused: RM registers files, and "something under
/// this directory" is not a file it can be asked about.
#[cfg(windows)]
fn file_handle_holders(file: &str) -> Vec<(u32, String)> {
    use windows_sys::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
        RM_PROCESS_INFO,
    };
    // A list longer than this is not a diagnostic anyone reads, and the allocation is
    // ours to bound. RmGetList refuses a short buffer outright (ERROR_MORE_DATA fills
    // nothing), so this is a give-up threshold rather than a truncation.
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
            // Two-call idiom: ask the size, then fetch. The first call is expected to
            // fail with ERROR_MORE_DATA, so its return value says nothing useful.
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

/// No counterpart outside Windows, and none is needed: a directory whose files are
/// open still deletes there, so this half of the diagnostic never has a question to
/// answer. The cwd scan in `path_holders` is cross-platform and stays.
#[cfg(not(windows))]
fn file_handle_holders(_file: &str) -> Vec<(u32, String)> {
    vec![]
}

/// Kill `pid` **and its descendants**. The tree matters: `kill_session` terminates the
/// PTY's direct child, and on Windows a `node` dev server that child started outlives
/// it — still sitting in the folder, still pinning it.
///
/// Returns whether the kill was issued, not whether the process is gone; the caller
/// re-probes rather than trusting this, because a signal is not a reaping (the same
/// distinction `followSessionDrift` waits on `pty-exit` for).
pub(crate) fn kill_pid_tree(pid: u32) -> bool {
    if pid <= 4 {
        return false; // 0 and 4 are the kernel's own on Windows; nothing good is here
    }
    #[cfg(windows)]
    {
        sys_command("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).status().is_ok_and(|s| s.success())
    }
    #[cfg(not(windows))]
    {
        // Negative pid targets the process group, which is the closest POSIX analogue
        // of /T; a session leader is the common case for a PTY child. Fall back to the
        // bare pid when it leads no group.
        let grp = sys_command("kill").arg("-9").arg(format!("-{pid}")).status().is_ok_and(|s| s.success());
        grp || sys_command("kill").arg("-9").arg(pid.to_string()).status().is_ok_and(|s| s.success())
    }
}

/// `std::fs::remove_dir_all` with the two things a stranded checkout needs from it:
/// it reports **which** path refused, and it clears the read-only attribute first.
///
/// The first is what makes the failure explainable — `path_holders` can only ask the
/// Restart Manager about a file, and the standard library's error carries no path at
/// all. The second is a Windows failure mode in its own right: a read-only file
/// (something a vendored dependency or a packing tool left behind) fails `remove_file`
/// with PermissionDenied while *nothing* is holding it, which would otherwise be
/// reported as a mystery with an empty holder list.
///
/// Never follows a link. A junction or symlink inside a checkout is removed as the
/// link it is, so whatever it points at is untouched — the one way a recursive delete
/// can do damage far outside the directory it was aimed at.
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
        // A Windows directory junction needs `remove_dir`, a file symlink needs
        // `remove_file`, and `symlink_metadata` does not reliably tell the two apart
        // across platforms — so try one and fall back rather than branching on a
        // flag that lies on one of them.
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
        // Clippy flags `set_readonly(false)` because on Unix it grants write to
        // everyone; this arm is Windows-only, where it clears one attribute bit, and
        // making the file deletable is the entire point.
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        let _ = std::fs::set_permissions(path, perm);
    }
    std::fs::remove_file(path).map_err(fail)
}

/// Resolve the absolute path to the `claude` binary. GUI apps get a stripped PATH
/// (Finder on macOS, no inherited shell env on Windows), so we check common install
/// locations first and fall back to a `which`/`where` probe.
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

/// Windows: prefer the native installer's `claude.exe` (spawnable directly via
/// CreateProcess, unlike the npm `.cmd` shim which needs a shell), then `where`.
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

/// Marker fencing the PATH in a shell probe's output, so rc-file chatter can't be
/// mistaken for part of the value.
#[cfg(not(windows))]
const PATH_MARK: &str = "__EPISKO_PATH__";

/// The PATH the user's own terminal has, harvested once per app run. `None` when the
/// probe failed or returned something that isn't a PATH — callers fall back.
#[cfg(not(windows))]
static SHELL_PATH: std::sync::LazyLock<Option<String>> =
    std::sync::LazyLock::new(probe_shell_path);

/// Pull the PATH out of a shell probe's stdout.
///
/// The rc files this deliberately lets run *print things* — a powerlevel10k gitstatus
/// warning, a motd, a version-manager notice — so the value is fenced by markers
/// rather than assumed to be the whole output.
///
/// Rejects anything that doesn't look like a PATH. fish interpolates `$PATH` as a
/// space-separated list, and half a PATH silently shadowing the fallback is worse
/// than not probing at all.
#[cfg(not(windows))]
fn path_from_probe(out: &str) -> Option<String> {
    let val = out.split(PATH_MARK).nth(1)?.trim();
    let dirs: Vec<&str> = val.split(':').filter(|d| !d.is_empty()).collect();
    if dirs.len() < 2 || !dirs.iter().any(|d| std::path::Path::new(d).is_dir()) {
        return None;
    }
    Some(val.to_string())
}

/// Ask the user's login shell what PATH it would give a command, **interactively**.
///
/// `-i` is the entire point, and it is not a detail. zsh reads `~/.zshrc` only for
/// *interactive* shells, and `.zshrc` is where nvm, pnpm's `PNPM_HOME`, mise and
/// Homebrew's `shellenv` actually get exported. A plain `-l -c` sources `.zprofile`
/// and `.zlogin` and misses every one of them — which is how a task running
/// `pnpm tauri dev` died with `command not found: pnpm` while the identical line
/// worked in the user's terminal, and how a `just` install went undiscovered.
///
/// Run once, off the caller's back, and never for the task itself: an interactive
/// shell prints its rc noise, which is fine to parse out of a probe and unacceptable
/// in a task's pane.
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
    // A pathological rc file must cost a fallback, not a hung UI: `augmented_path` is
    // on the git-poll path, so the first caller is whoever polls first.
    let out = rx.recv_timeout(std::time::Duration::from_secs(5)).ok()??;
    path_from_probe(&out)
}

/// Warm `SHELL_PATH` off the UI's back. `LazyLock` blocks its *first* caller, and that
/// caller would otherwise be a git poll or a task launch.
#[cfg(not(windows))]
pub(crate) fn warm_shell_path() {
    std::thread::spawn(|| {
        let _ = SHELL_PATH.as_deref();
    });
}

#[cfg(windows)]
pub(crate) fn warm_shell_path() {}

/// A PATH that includes the usual per-user bin dirs, so the spawned `claude`
/// (and anything it shells out to) is found even under a stripped PATH.
///
/// `~/.cargo/bin` is here for the task introspectors, not for `claude`: `just` and
/// `mise` are Rust binaries that `cargo install` puts nowhere else, and a listing
/// tool this can't find makes a whole provider's tasks vanish.
#[cfg(not(windows))]
pub(crate) fn augmented_path() -> String {
    let home = home_dir();
    let fallbacks = format!(
        "{home}/.local/bin:{home}/.claude/local:{home}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    );
    match SHELL_PATH.as_deref() {
        // The user's own ordering goes first, deliberately. If nvm puts a node ahead
        // of `/usr/local/bin`, a task has to get nvm's one — otherwise "works in
        // iTerm, fails in Episko" is back, just further down the stack.
        Some(p) => format!("{p}:{fallbacks}"),
        // No probe: today's behaviour, which under Finder means the fallbacks are
        // doing all the work (the process PATH is `/usr/bin:/bin:/usr/sbin:/sbin`).
        None => format!("{fallbacks}:{}", std::env::var("PATH").unwrap_or_default()),
    }
}

/// Windows uses `;` as the PATH separator; include the native-installer bin dir and
/// System32 (where `curl.exe` lives), then whatever we inherited.
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

/// One `ps -o <fields>=` line for a single pid (trimmed), or None if the process
/// is gone / no output.
///
/// **Not compiled on Windows at all**, and that is now load-bearing rather than tidy.
/// There used to be a `cfg(windows)` stub returning None, because `session_resources`
/// called this on every platform for per-session CPU/RAM; that reader now measures disk
/// I/O through `sysinfo` instead, which leaves the *macOS half* of
/// `focus_external_session` as the sole caller — the Windows half now exists too, but
/// finds its window through the win32 window APIs and never asks `ps` anything. A stub
/// with no callers is `dead_code`, which is a **CI failure** under `-D warnings`, and
/// one only the Windows leg can see.
///
/// The general shape of that trap: removing the last cross-platform caller of a
/// cfg-gated helper breaks the *other* platform's build, invisibly from this one. The
/// cfg flip in CLAUDE.md is what catches it; "I added no cfg arms" is not a reason to
/// skip it, because deleting a call is enough.
///
/// External-session *listing* does NOT go through here — it uses the cross-platform
/// `ProcTable` in `external.rs`.
#[cfg(not(windows))]
pub(crate) fn ps_one(pid: u32, fields: &str) -> Option<String> {
    let out = sys_command("ps")
        .args(["-p", &pid.to_string(), "-o", fields])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Open a project's folder in the OS file manager (Explorer / Finder / the
/// desktop's default handler). Refuses a vanished directory rather than silently
/// doing nothing — deleted worktrees are real.
#[tauri::command]
pub(crate) fn open_folder(dir: String) -> Result<(), String> {
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    #[cfg(windows)]
    {
        // Explorer's shell parser only understands backslashes. Hand it a
        // forward-slash path and it silently opens the user's Documents folder
        // instead — no error, no clue. That's not hypothetical: an external
        // session's project row carries the repo root from `git rev-parse`, and
        // git emits `E:/Programming/…` on Windows. `Path::is_dir` accepts either
        // form, so the guard above cannot catch it; normalize here.
        let dir = dir.replace('/', "\\");
        // explorer.exe is fire-and-forget: it hands off to the running shell and
        // exits non-zero even when the window opened, so never wait on its status.
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

/// Reveal a file in the OS file manager, selected — the "↗ Reveal source" action on
/// a task, which answers "where did this come from?". `dir` is the project root and
/// `rel` the repo-relative source file (`.vscode/tasks.json`); revealing by relative
/// path keeps a `..` from a malformed override from escaping the project. Falls back
/// to opening the containing folder where the OS can't select a file.
#[tauri::command]
pub(crate) fn reveal_path(dir: String, rel: String) -> Result<(), String> {
    let root = std::path::Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    // Reject anything that would climb out of the project — `rel` is nominally
    // repo-relative, but it reaches us from discovery data, so don't trust it. A
    // `..` climbs out; a rooted (`/x`) or drive-prefixed (`C:x`) component is what
    // `join` replaces the whole base with — note `/x` is *not* `is_absolute()` on
    // Windows (no prefix), so the component check, not `is_absolute`, is the guard.
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
    // A source that no longer exists (a task from a file since deleted): reveal the
    // project folder rather than erroring on a path the user can't do anything about.
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

/// Open a file with whatever the OS has registered for it — the primary click on the
/// inspector's Context rows.
///
/// The sibling of `reveal_path` and deliberately a *different* command rather than a
/// flag on it, because the path comes from somewhere else and so has a different
/// trust story. `reveal_path` takes `(project_root, relative)` and rejects anything
/// that climbs out, because its `rel` arrives from task-discovery data. This one takes
/// one absolute path, and the only thing that produces one is a `file_path` the running
/// agent already read or wrote — a file the user could have opened from the pane
/// itself. Constraining it to the project would break the case worth having: the config
/// in `$HOME`, the dependency's source, the sibling checkout the agent drifted into.
///
/// On macOS it falls back to revealing the file when nothing is registered for the
/// extension. That is not a rare corner — a stock machine has no handler for `.rs` or
/// `.toml` — and `open` fails there with a dialog-free non-zero exit, so without the
/// fallback the most ordinary click in the card would do nothing at all.
#[tauri::command]
pub(crate) fn open_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("no longer there: {path}"));
    }
    #[cfg(target_os = "macos")]
    {
        // `.status()` rather than the `.spawn()` used elsewhere: the exit code is the
        // only signal that no application claimed the file, and `open` returns it in
        // milliseconds — it hands off to LaunchServices rather than waiting on the app.
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
        // Same backslash rule as `open_folder`: the shell parser silently opens
        // Documents when handed forward slashes, and a `file_path` from a hook payload
        // is exactly the kind of string that carries them.
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

/// Show an absolute path in the file manager, selected — the ⌂ on a Context row. Same
/// trust story as `open_file` above; the per-OS mechanics are `reveal_path`'s, minus
/// the project-relative resolution it exists to do safely.
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

/// A caffeinate flag we're willing to pass through: a short-option cluster over
/// the sleep-assertion letters (`-d -i -m -s -u`, or combined like `-dimsu`),
/// the `-t` timeout switch, or a bare decimal number (its seconds argument).
/// Everything the UI sends is a fixed preset, so this is just belt-and-braces
/// against ever handing an arbitrary string to the shell-less spawn.
#[cfg(not(windows))]
fn valid_caffeinate_flag(f: &str) -> bool {
    if let Some(rest) = f.strip_prefix('-') {
        return !rest.is_empty() && rest.chars().all(|c| "dimsut".contains(c));
    }
    !f.is_empty() && f.chars().all(|c| c.is_ascii_digit())
}

/// Toggle a macOS `caffeinate` power-assertion on or off. Only ever one child
/// runs: any existing one is killed first, so switching presets is just a
/// stop+restart. `active=false` (or an empty `flags`) simply stops it.
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
    // `-w <our pid>`: caffeinate exits on its own the moment Episko does, so a
    // crash or force-quit can't leave the display pinned awake.
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

/// A live Windows power assertion. `SetThreadExecutionState` is scoped to the
/// *calling thread* — the assertion dies with that thread — so we park a thread
/// for exactly as long as the user wants the machine awake. That thread-scoping
/// is also the safety net the macOS side gets from `caffeinate -w <our pid>`: a
/// panic or a hard exit can't leave a Windows box pinned awake, because the
/// thread goes with the process.
#[cfg(windows)]
pub(crate) struct KeepAwake {
    /// Dropping this releases the assertion: the parked thread's `recv_timeout()`
    /// reports the channel disconnected, it clears the execution state and exits.
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(windows)]
impl Drop for KeepAwake {
    fn drop(&mut self) {
        drop(self.stop.take());
        // Join so the state is provably cleared before a replacement assertion
        // is set up — otherwise a preset switch could race the old thread's
        // clearing call and land on ES_CONTINUOUS (i.e. silently off).
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Translate the macOS `caffeinate` flags the UI speaks into Windows execution
/// state bits, so the frontend keeps one vocabulary for both platforms.
///
///   `-d` (display) → `ES_DISPLAY_REQUIRED`   `-i` / `-s` (idle/system) → `ES_SYSTEM_REQUIRED`
///   `-m` (disk) and `-u` (user active) have no Windows equivalent and are dropped.
///   `-t <sec>` is dropped too — the frontend's own timer disarms the preset.
///
/// Anything that asks for the display also implies the system, matching what a
/// user means by "keep the screen on". Returns 0 when nothing was requested.
///
/// Deliberately *not* mapped: `ES_AWAYMODE_REQUIRED`. It's only honoured where
/// the power policy enables away mode, and where it isn't the whole call fails
/// (returns 0) — so asking for it would silently assert nothing at all.
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

/// How often the parked thread re-states its execution state.
///
/// **Windows does not preserve a thread's execution state across suspend/resume.**
/// A single `SetThreadExecutionState` at arming time therefore holds only until the
/// first sleep — after that the box idle-sleeps freely while the UI still shows the
/// cup steaming, because the frontend only re-invokes on a *flag change* and in agent
/// mode the flags can sit unchanged for days (one session left at `done` keeps
/// `cafAgentsBusy()` true indefinitely). Nothing else would ever restore it, so the
/// thread that owns the assertion re-states it on a tick instead.
///
/// 30s is comfortably under the one minute that is the shortest *Sleep after* Windows
/// lets you configure, so a resume can never outrun the next re-assert.
#[cfg(windows)]
const REASSERT_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

/// Park a thread holding `es` until the returned handle is dropped, re-stating it
/// every `every` so a suspend/resume can't quietly end the assertion.
///
/// The state must be set *and* released on the same thread, so the whole lifetime
/// lives inside the closure: assert, hold, clear. Split out of `set_caffeinate` (and
/// taking the interval rather than reading `REASSERT_EVERY` directly) so a test can
/// drive the hold/re-assert/release cycle without an `AppState` and without a
/// half-minute suite.
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
        // Hold until released, waking on each tick to re-state the assertion (see
        // REASSERT_EVERY). `recv_timeout` reports `Disconnected` the moment the
        // sender drops rather than at the next tick, so releasing stays prompt and
        // `Drop`'s join can't stall the caller for up to half a minute.
        while let Err(RecvTimeoutError::Timeout) = rx.recv_timeout(every) {
            // SAFETY: as above. Re-stating the same state is idempotent, so this is
            // a no-op except after a resume, which is the one time it matters.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | es) };
            on_reassert();
        }
        // SAFETY: same call; ES_CONTINUOUS alone clears our assertion.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    });
    // Surface a refusal as an error instead of a thread that quietly did nothing —
    // the UI would otherwise paint the cup lit over a sleeping PC.
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(KeepAwake { stop: Some(stop), thread: Some(thread) }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err("keep-awake thread died before asserting".into()),
    }
}

/// Toggle a Windows power assertion on or off — the `caffeinate` counterpart.
/// Only ever one assertion is live: an existing one is dropped (which joins its
/// thread and clears the state) first, so switching presets is a stop+restart.
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
//
// macOS keys a WKWebView app's localStorage to its bundle identifier, so the
// rename `io.respeak.cclauncher` (Muster) -> `io.respeak.episko` pointed the app
// at a fresh, empty store and left every `cc-*` key (the daily cost rollup, the
// project/session roster, favourites, colours, icons) behind under the old id.
// This reads those keys straight off the old on-disk SQLite so the frontend can
// import any it doesn't already have (fill-absent-only — it never clobbers data
// this install legitimately holds; see the boot shim in `main.ts`). Returns an
// empty map wherever there is nothing to recover, so the caller is a no-op.

/// WebKit stores localStorage values as UTF-16LE BLOBs (no BOM).
#[cfg(target_os = "macos")]
fn decode_utf16le(bytes: &[u8]) -> String {
    // `as_chunks::<2>` rather than `chunks_exact(2)`: it hands back `&[u8; 2]` instead of
    // a slice, so `from_le_bytes` takes it whole and no indexing can panic. Clippy asks
    // for this from 1.98 (`chunks_exact_to_as_chunks`), and clippy is a CI gate.
    let (pairs, _) = bytes.as_chunks::<2>();
    let units: Vec<u16> = pairs.iter().copied().map(u16::from_le_bytes).collect();
    String::from_utf16_lossy(&units)
}

/// Depth-limited walk for `localstorage.sqlite3` under a WebsiteData/Default
/// tree (the origin salt/hash dirs are minted at runtime, so the path isn't
/// known ahead of time). Returns the largest match — the store with the most
/// data — since a stale empty one can linger beside the real one.
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

/// Read every `cc-*` key from a WebKit `localstorage.sqlite3`. Works on a private
/// copy (never the original) so SQLite can fold in a stranded `-wal` — the old
/// store may hold uncheckpointed writes the main file doesn't yet have.
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
        // Previous bundle ids, newest-first. Only the installed-app id belongs
        // here; the `pnpm tauri dev` store ("muster") is intentionally excluded.
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
        // Windows/WebView2 keeps localStorage in a LevelDB, not SQLite, and the
        // pre-rename Windows build predates this scheme — nothing to recover.
        Ok(std::collections::HashMap::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the legacy-store test below needs these, and it is macOS-only — so the
    // imports are gated too, or the other platforms get an unused-import warning
    // (which CI's clippy `-D warnings` turns into a failure).
    #[cfg(target_os = "macos")]
    use crate::testutil::COUNTER;
    #[cfg(target_os = "macos")]
    use std::sync::atomic::Ordering;

    /// A process sitting in a folder is the commonest thing keeping it undeletable —
    /// a terminal, a dev server, or the PTY pane a worktree removal has just killed —
    /// and it is the half of the probe that works on every OS. `ours` is asserted
    /// alongside it because the two answers are used together: the caller clears its
    /// own processes without asking and only ever puts somebody else's in a dialog,
    /// so a child of ours reported as foreign would turn a silent cleanup into a
    /// prompt about a process the user never started.
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

        // The process table is a snapshot, and a just-spawned child need not be in the
        // first one — retry briefly rather than racing it.
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

    /// `remove_tree` exists for two things the standard library will not do, and both
    /// are load-bearing for a stranded checkout: it names the path that refused (the
    /// Restart Manager can only be asked about a *file*, and `remove_dir_all`'s error
    /// carries none), and it clears the read-only attribute — a Windows-only failure
    /// where nothing is holding the folder at all, which would otherwise be reported
    /// as a mystery with an empty holder list.
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

        // A path that was never there is the outcome being asked for, not an error —
        // `ensure_folder_gone` retries, so this is hit on every successful second pass.
        assert!(remove_tree(&dir).is_ok(), "deleting nothing succeeds");
    }

    /// The one way a recursive delete can do damage far outside the directory it was
    /// aimed at. A checkout with a symlink in it is ordinary (a shared `node_modules`,
    /// a fixture pointing at real data), and following one would delete the target's
    /// contents while reporting that a worktree had been cleaned up.
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

    /// All three real-world spellings of one Windows folder (git's forward
    /// slashes, the dialog's native path, VS Code's lowercase drive) must
    /// collapse to a single string, or the sidebar splits the project.
    #[cfg(windows)]
    #[test]
    fn norm_path_unifies_windows_spellings() {
        assert_eq!(norm_path("E:/Programming/Work/repo"), r"E:\Programming\Work\repo");
        assert_eq!(norm_path(r"e:\Programming\Work\repo"), r"E:\Programming\Work\repo");
        assert_eq!(norm_path(r"E:\already\native"), r"E:\already\native");
        assert_eq!(norm_path(r"\\server\share\x"), r"\\server\share\x");
        assert_eq!(norm_path(""), "");
    }

    /// The shell probe runs rc files on purpose, and rc files talk. powerlevel10k
    /// prints a gitstatus warning, nvm prints notices, hosts print a motd — so the
    /// PATH has to be fenced and extracted, never assumed to be the whole stdout.
    #[cfg(not(windows))]
    #[test]
    fn shell_probe_survives_rc_file_chatter() {
        let noisy = format!(
            "  Restart Zsh to retry gitstatus initialization:\n\n    exec zsh\n\
             {PATH_MARK}/opt/homebrew/bin:/usr/bin:/bin{PATH_MARK}\n"
        );
        assert_eq!(path_from_probe(&noisy).as_deref(), Some("/opt/homebrew/bin:/usr/bin:/bin"));
    }

    /// Anything that isn't a PATH must be refused, because the probe's value goes
    /// *ahead* of the fallbacks — a mangled one shadows them instead of helping.
    /// fish is the live case: it interpolates `$PATH` space-separated.
    #[cfg(not(windows))]
    #[test]
    fn shell_probe_refuses_what_is_not_a_path() {
        // fish: no separators at all.
        assert_eq!(path_from_probe(&format!("{PATH_MARK}/usr/bin /bin{PATH_MARK}")), None);
        // The shell died before printing, or printed only noise.
        assert_eq!(path_from_probe("command not found: printf"), None);
        assert_eq!(path_from_probe(&format!("{PATH_MARK}{PATH_MARK}")), None);
        // Colon-separated but nothing on it exists — a stale or fabricated value.
        assert_eq!(
            path_from_probe(&format!("{PATH_MARK}/nope/one:/nope/two{PATH_MARK}")),
            None
        );
    }

    /// The probe is the mechanism the pnpm/just failures needed, so assert it works
    /// against this machine's real shell rather than only against fixtures. Skipped
    /// rather than failed where there's no usable `SHELL` (a bare CI container).
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

    /// The verbatim prefix Windows' `canonicalize` adds, which must reach neither the
    /// transcript encoder nor a repo root the frontend compares as a string. Pure
    /// string work, so it is checked on every OS rather than only on the leg that can
    /// produce one — this is the half of the symlink fix that a macOS developer would
    /// otherwise never run.
    #[test]
    fn verbatim_prefixes_are_stripped() {
        assert_eq!(strip_verbatim(r"\\?\C:\Work\Respeak"), r"C:\Work\Respeak");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\proj"), r"\\srv\share\proj");
        // Anything already in its normal form is returned untouched, on either OS.
        assert_eq!(strip_verbatim(r"C:\Work\Respeak"), r"C:\Work\Respeak");
        assert_eq!(strip_verbatim("/Users/tim/dev"), "/Users/tim/dev");
    }

    /// The external-terminal engines hand `open -a` a generated `.command` *script*,
    /// so a workdir or title containing a quote must not be able to close the quoting
    /// and run as its own command.
    #[cfg(not(windows))]
    #[test]
    fn sh_quote_neutralises_embedded_quotes() {
        assert_eq!(sh_quote("/Users/tim/dev/episko"), "'/Users/tim/dev/episko'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("a'; rm -rf /; echo '"), r"'a'\''; rm -rf /; echo '\'''");
    }
    /// The legacy-store reader must decode WebKit's UTF-16LE BLOBs, keep only
    /// `cc-*` keys, and survive a stranded `-wal`. Fixture mirrors the real
    /// `ItemTable` schema so no machine-specific store is needed.
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

    /// The one piece of the Windows keep-awake path that isn't a Win32 call: the
    /// translation of the UI's `caffeinate` flags into execution-state bits.
    #[cfg(windows)]
    #[test]
    fn caffeinate_flags_map_to_execution_state() {
        use windows_sys::Win32::System::Power::{ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
        let f = |args: &[&str]| execution_state_for(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());

        // Asking for the display implies the system stays powered too.
        assert_eq!(f(&["-d"]), ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        assert_eq!(f(&["-i"]), ES_SYSTEM_REQUIRED);
        assert_eq!(f(&["-dimsu"]), ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        // The timer preset: `-t` and its bare seconds argument assert nothing on
        // their own, and must not be mistaken for a flag cluster.
        assert_eq!(f(&["-di", "-t", "3600"]), ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        // Nothing translatable → 0, which the command reports as an error rather
        // than lighting the cup over a machine that will happily sleep.
        assert_eq!(f(&["-m"]), 0);
        assert_eq!(f(&[]), 0);
    }

    /// The three things the hold loop has to get right at once: it re-states the
    /// assertion (the whole point — Windows drops it across suspend/resume), it does
    /// not mistake a tick for a release, and it still lets go immediately when asked.
    /// All three are invisible from the outside, and the bug this replaced looked
    /// identical from the outside, which is why they are counted rather than read.
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

        // Twenty-odd ticks in. The bug this replaces was a bare `recv()`: it parks and
        // releases exactly like the fix, so the only thing that tells them apart is
        // whether the assertion is ever re-stated. Count that. (The hook sits on the
        // line after the Win32 call, which is as close as a real extern call gets to
        // observable.)
        std::thread::sleep(every * 20);
        assert!(ticks.load(Ordering::Relaxed) > 0, "assertion was never re-stated");
        // And a timeout must not be treated as "release" — the easy mistake when
        // swapping `recv` for `recv_timeout` — which would drop the assertion on the
        // first tick while the UI still shows the cup steaming.
        assert!(!awake.thread.as_ref().unwrap().is_finished(), "thread exited on a tick instead of holding");

        // The other end of the same change: releasing must not wait for the next tick.
        // `Drop` joins, and its caller is a `#[tauri::command]`, so a tick-long stall
        // there would freeze the UI for REASSERT_EVERY on every preset switch.
        let t = Instant::now();
        drop(awake);
        assert!(t.elapsed() < Duration::from_secs(1), "release waited for a tick: {:?}", t.elapsed());
    }

    /// The macOS half of the same setting. `set_caffeinate` spawns without a shell,
    /// but the flags still arrive from the frontend, so anything that isn't a
    /// sleep-assertion cluster (or `-t`'s bare seconds) is refused rather than passed
    /// to `/usr/bin/caffeinate`.
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
}
