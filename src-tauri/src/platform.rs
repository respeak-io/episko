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

/// A PATH that includes the usual per-user bin dirs, so the spawned `claude`
/// (and anything it shells out to) is found even under a stripped PATH.
#[cfg(not(windows))]
pub(crate) fn augmented_path() -> String {
    let home = home_dir();
    let base = std::env::var("PATH").unwrap_or_default();
    format!("{home}/.local/bin:{home}/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{base}")
}

/// Windows uses `;` as the PATH separator; include the native-installer bin dir and
/// System32 (where `curl.exe` lives), then whatever we inherited.
#[cfg(windows)]
pub(crate) fn augmented_path() -> String {
    let home = home_dir();
    let base = std::env::var("PATH").unwrap_or_default();
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    format!(r"{home}\.local\bin;{home}\.claude\local;{sysroot}\System32;{base}")
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
    /// Dropping this releases the assertion: the parked thread's `recv()` fails,
    /// it clears the execution state and exits.
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

/// Toggle a Windows power assertion on or off — the `caffeinate` counterpart.
/// Only ever one assertion is live: an existing one is dropped (which joins its
/// thread and clears the state) first, so switching presets is a stop+restart.
#[cfg(windows)]
#[tauri::command]
pub(crate) fn set_caffeinate(state: State<AppState>, active: bool, flags: Vec<String>) -> Result<(), String> {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
    let mut guard = state.caffeinate.lock().unwrap();
    guard.take(); // drop → releases whatever was asserted
    if !active || flags.is_empty() {
        return Ok(());
    }
    let es = execution_state_for(&flags);
    if es == 0 {
        return Err(format!("no Windows keep-awake equivalent for: {}", flags.join(" ")));
    }
    let (stop, rx) = std::sync::mpsc::channel::<()>();
    // The assertion must be set *and* released on the same thread, so the whole
    // lifetime lives inside this closure: assert, park, clear.
    let (ready, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let thread = std::thread::spawn(move || {
        // SAFETY: a plain flags-in/flags-out Win32 call with no pointers.
        let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | es) };
        if prev == 0 {
            let _ = ready.send(Err("SetThreadExecutionState refused the request".into()));
            return;
        }
        let _ = ready.send(Ok(()));
        let _ = rx.recv(); // park until the sender is dropped
        // SAFETY: same call; ES_CONTINUOUS alone clears our assertion.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    });
    // Surface a refusal as a command error instead of a thread that quietly did
    // nothing — the UI would otherwise paint the cup lit over a sleeping PC.
    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = thread.join();
            return Err(e);
        }
        Err(_) => return Err("keep-awake thread died before asserting".into()),
    }
    *guard = Some(KeepAwake { stop: Some(stop), thread: Some(thread) });
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
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
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
