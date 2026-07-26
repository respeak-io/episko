// cc-launcher — Tauri backend (multi-session)
//
// - Manages N concurrent `claude` sessions, each in its own PTY (portable-pty),
//   keyed by a caller-supplied session UUID (also passed to `claude --session-id`
//   so every hook/statusline event correlates back to its pane).
// - Instruments each session per-launch via `claude --settings <file>` so Claude
//   Code's hooks + statusLine POST live status/cost/context to a local HTTP
//   server — no global config mutation, no transcript parsing.

mod git;
mod platform;
mod pty;
mod tasks;
mod telemetry;
#[cfg(test)]
mod testutil;

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use portable_pty::{ChildKiller, MasterPty};
use tauri::menu::MenuBuilder;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::git::git_repo_info;
#[cfg(not(windows))]
use crate::platform::sh_quote;
use crate::platform::{home_dir, norm_path};
use crate::telemetry::run_telemetry_server;

pub(crate) struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// OS pid of the spawned `claude` (embedded PTY only). Used to exclude our
    /// own sessions from `list_external_sessions` by pid rather than session id.
    pid: Option<u32>,
    /// Working directory this session runs in. Lets `remove_worktree` refuse to
    /// delete a worktree that still has a live embedded session inside it.
    workdir: String,
}

pub(crate) struct AppState {
    port: u16,
    sessions: Mutex<HashMap<String, Session>>,
    /// PIDs of the `claude` processes Episko spawned in an embedded PTY. Matched
    /// against the on-disk session registry so our own sessions never masquerade
    /// as "external" — robust to the session id changing under /resume or /clear
    /// (which rewrites `~/.claude/sessions/<pid>.json` with the new id).
    owned_pids: Mutex<HashSet<u32>>,
    /// Held-open PermissionRequest HTTP requests, keyed by an id we assign.
    /// Answered later by the `resolve_permission` command.
    pending: Mutex<HashMap<String, tiny_http::Request>>,
    next_perm: std::sync::atomic::AtomicU64,
    /// The single running `caffeinate` child, if the user has toggled it on.
    /// Started with `-w <our pid>` so it self-terminates if Episko ever dies
    /// without a clean stop — no orphaned process keeps the Mac awake forever.
    #[cfg(not(windows))]
    caffeinate: Mutex<Option<std::process::Child>>,
    /// The single live `SetThreadExecutionState` assertion, if the user has
    /// toggled keep-awake on. Windows' equivalent of the `caffeinate` child.
    #[cfg(windows)]
    caffeinate: Mutex<Option<KeepAwake>>,
}


/// Open a project's folder in the OS file manager (Explorer / Finder / the
/// desktop's default handler). Refuses a vanished directory rather than silently
/// doing nothing — deleted worktrees are real.
#[tauri::command]
fn open_folder(dir: String) -> Result<(), String> {
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
fn reveal_path(dir: String, rel: String) -> Result<(), String> {
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

/// Persist a debug snapshot (JSON built by the frontend) to a fixed, discoverable
/// path so an external tool — or an LLM agent debugging the running app — can read
/// live state and the recent event log. Returns the path written.
#[tauri::command]
fn write_debug_file(contents: String) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("episko-debug.json");
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Tee a frontend `dlog()` line into the backend rolling log (episko.log), tagged
/// `[ui]`. The UI's event stream is otherwise only an in-memory ring mirrored to
/// the *overwritten* episko-debug.json snapshot — so it doesn't survive a crash.
/// Forwarding it here puts the whole timeline (UI + backend) in one durable,
/// time-ordered file: after #12 the backend was crash-visible but the UI half
/// wasn't. Fire-and-forget from the frontend; a dropped line is not worth an error.
#[tauri::command]
fn log_frontend(level: String, msg: String) {
    match level.as_str() {
        "error" => log::error!("[ui] {msg}"),
        "warn" => log::warn!("[ui] {msg}"),
        _ => log::info!("[ui] {msg}"),
    }
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
fn set_caffeinate(state: State<AppState>, active: bool, flags: Vec<String>) -> Result<(), String> {
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
struct KeepAwake {
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
fn set_caffeinate(state: State<AppState>, active: bool, flags: Vec<String>) -> Result<(), String> {
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

// ---------- project favicon / logo discovery ----------

#[derive(serde::Serialize)]
struct ProjectIcon {
    path: String,
    data_uri: String,
}

/// Pick an image MIME from magic bytes, falling back to the file extension.
/// Repos routinely ship a PNG named `favicon.ico`; trusting the extension would
/// emit a `data:image/x-icon` URI wrapping PNG bytes, which the WebKit webview can
/// refuse to render — so the icon would be "found" yet show as broken.
fn sniff_mime(bytes: &[u8], ext: &str) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    // SVG is text — look for a `<svg` tag near the start (past any XML prolog).
    let head = &bytes[..bytes.len().min(256)];
    if head.windows(4).any(|w| w.eq_ignore_ascii_case(b"<svg")) {
        return Some("image/svg+xml");
    }
    // Couldn't sniff (e.g. an SVG with a long prolog) — trust the extension.
    match ext {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Read a candidate icon file into a base64 data-URI (small files only). The MIME
/// is sniffed from content (see `sniff_mime`), not assumed from the extension.
fn read_icon(p: &std::path::Path) -> Option<ProjectIcon> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 512 * 1024 {
        return None;
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = std::fs::read(p).ok()?;
    let mime = sniff_mime(&bytes, &ext)?;
    let b64 = STANDARD.encode(&bytes);
    Some(ProjectIcon {
        path: p.to_string_lossy().to_string(),
        data_uri: format!("data:{mime};base64,{b64}"),
    })
}

/// Conventional favicon / logo spots relative to a web / Tauri / Electron project
/// root. Returns the first that exists (no recursive walk — this stays cheap).
fn probe_icon_dir(base: &std::path::Path) -> Option<ProjectIcon> {
    const CANDIDATES: &[&str] = &[
        "favicon.ico", "favicon.svg", "favicon.png",
        "public/favicon.ico", "public/favicon.svg", "public/favicon.png",
        "public/apple-touch-icon.png", "public/logo.svg", "public/logo.png",
        "public/icon.svg", "public/icon.png",
        "static/favicon.ico", "static/favicon.svg", "static/favicon.png",
        "static/logo.svg", "static/logo.png",
        "app/favicon.ico", "app/icon.png", "app/icon.svg",
        "src/favicon.ico", "src/favicon.svg",
        "src/assets/favicon.ico", "src/assets/favicon.svg", "src/assets/favicon.png",
        "src/assets/logo.svg", "src/assets/logo.png",
        "src/assets/icon.svg", "src/assets/icon.png",
        "assets/favicon.png", "assets/logo.png", "assets/logo.svg", "assets/icon.png",
        "resources/icon.png", "build/icon.png",
        "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png",
    ];
    CANDIDATES.iter().find_map(|rel| read_icon(&base.join(rel)))
}

/// Scour a project directory for a favicon / logo we can show as its sidebar
/// glyph. Checks the conventional spots at the repo root, then — for monorepos
/// that keep the web app in a subdirectory (e.g. `01_frontend/`, `frontend/`,
/// `apps/web`) — one shallow level of subdirs, frontend-ish names first. This
/// finds a nested `01_frontend/public/favicon.ico` without a deep filesystem walk.
#[tauri::command]
fn find_project_icon(dir: String) -> Option<ProjectIcon> {
    let base = std::path::Path::new(&dir);
    if !base.is_dir() {
        return None;
    }
    // Fast path: conventional spots at the repo root.
    if let Some(hit) = probe_icon_dir(base) {
        return Some(hit);
    }
    // Fallback: probe immediate subdirectories, skipping heavy / build output dirs.
    let mut subs: Vec<std::path::PathBuf> = std::fs::read_dir(base)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            !name.starts_with('.')
                && !matches!(
                    name,
                    "node_modules" | "target" | "dist" | "build" | "out"
                        | "vendor" | "coverage" | "tmp" | "__pycache__"
                )
        })
        .collect();
    // Prefer frontend-ish directories, then fall back to alphabetical order so the
    // choice is deterministic (e.g. `01_frontend` before `02_backend`).
    subs.sort_by_key(|p| {
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let frontendish = ["front", "web", "client", "app", "ui", "site", "www"]
            .iter()
            .any(|k| name.contains(k));
        (!frontendish, name)
    });
    subs.iter().find_map(|p| probe_icon_dir(p))
}

/// Load a user-picked image as a project's logo. Deliberately runs the same
/// sniff/size gate as discovery (`read_icon`), so a file that isn't really an
/// image — or one too big to sit in localStorage as a data-URI — is rejected here
/// instead of becoming a broken `<img>` in the sidebar.
#[tauri::command]
fn read_custom_icon(path: String) -> Result<ProjectIcon, String> {
    read_icon(std::path::Path::new(&path))
        .ok_or_else(|| "Not a usable image (PNG, SVG, ICO, JPEG, WEBP or GIF, max 512 KB)".to_string())
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
                if best.as_ref().map_or(true, |(b, _)| sz > *b) {
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
fn read_legacy_localstorage() -> Result<std::collections::HashMap<String, String>, String> {
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

// ---------- external (non-Episko) Claude Code sessions ----------
//
// Claude Code writes a per-process registry file at
// `~/.claude/sessions/<pid>.json` for every running interactive session, e.g.
//   {"pid":80629,"sessionId":"…","cwd":"/…","name":"repo-a3","status":"idle",…}
// Episko's own sessions DO register here too (verified on CC 2.1.211), so we
// filter them out by pid — see `owned_pids` and the ancestry walk in
// `list_external_sessions`. We must NOT filter by session id alone: /resume and
// /clear rewrite this file with a new id, which would otherwise resurface our
// own live session as "external". What remains is the sessions started outside
// Episko (a plain terminal, an IDE, etc.) — we jump to their terminal window and
// show a read-only mirror of their transcript.
//
// The registry format and directory are identical on Windows (verified on CC
// 2.1.216: `%USERPROFILE%\.claude\sessions\<pid>.json`, VS Code-hosted sessions
// included), so LISTING is fully cross-platform: liveness/ownership checks go
// through `ProcTable`, an in-process `sysinfo` snapshot that works the same on
// macOS, Windows and Linux. Only `focus_external_session` (jumping to the
// owning terminal window) remains platform-specific — macOS-only today.

#[derive(serde::Serialize)]
struct ExternalSession {
    pid: u32,
    session_id: String,
    cwd: String,
    name: String,
    status: String,
    status_updated_at: Option<i64>,
    started_at: Option<i64>,
    version: String,
    /// Main worktree root of this session's repo — the key the sidebar groups by, so
    /// every worktree of one repo lands under it. None when cwd isn't a git repo.
    repo_root: Option<String>,
    /// Branch checked out in this session's cwd (None when detached / not a repo).
    branch: Option<String>,
}

/// A point-in-time snapshot of the system process table (pid → parent + name),
/// taken in-process via `sysinfo` so the exact same code serves macOS, Windows
/// and Linux — no `ps`/`tasklist` child processes. The frontend polls external
/// sessions every ~3s; refreshing only the bare process list (no CPU/memory/
/// exe/cmd lookups) keeps a snapshot to a few milliseconds.
struct ProcTable {
    /// pid → (ppid, lowercased process name)
    procs: std::collections::HashMap<u32, (Option<u32>, String)>,
}

impl ProcTable {
    fn snapshot() -> Self {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let procs = sys
            .processes()
            .iter()
            .map(|(pid, p)| {
                (
                    pid.as_u32(),
                    (p.parent().map(|pp| pp.as_u32()), p.name().to_string_lossy().to_lowercase()),
                )
            })
            .collect();
        Self { procs }
    }

    /// True if `pid` is currently a live process whose name contains "claude" —
    /// the identity check that guards against stale registry files and pid
    /// reuse. Matched loosely because the name varies: `claude` on macOS/Linux,
    /// `claude.exe` on Windows, and self-update renames like
    /// `claude.exe.old.<ts>` for a binary updated while running.
    fn is_live_claude(&self, pid: u32) -> bool {
        self.procs.get(&pid).is_some_and(|(_, name)| name.contains("claude"))
    }

    /// True if `pid` is `ancestor`, or a descendant of it (walks the ppid chain).
    /// Used to recognise `claude` processes Episko launched — directly (embedded
    /// PTY) or via a child terminal (e.g. Ghostty) — regardless of their session
    /// id. The iteration cap also bounds ppid cycles, which Windows can produce
    /// after pid reuse (a dead parent's pid handed to a new process).
    fn is_descendant_of(&self, pid: u32, ancestor: u32) -> bool {
        let mut cur = pid;
        for _ in 0..24 {
            if cur == ancestor {
                return true;
            }
            match self.procs.get(&cur).and_then(|(ppid, _)| *ppid) {
                Some(ppid) if ppid > 1 && ppid != cur => cur = ppid,
                _ => return false,
            }
        }
        false
    }
}

/// Parse one `~/.claude/sessions/<pid>.json` registry file into an
/// `ExternalSession` (repo_root/branch enriched later). None for malformed
/// files and non-interactive entries (`claude -p`, SDK runs).
fn parse_registry_entry(txt: &str) -> Option<ExternalSession> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    if v.get("kind").and_then(|k| k.as_str()) != Some("interactive") {
        return None;
    }
    let pid = v.get("pid").and_then(|x| x.as_u64())? as u32;
    let session_id = v.get("sessionId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if session_id.is_empty() {
        return None;
    }
    Some(ExternalSession {
        pid,
        session_id,
        cwd: norm_path(v.get("cwd").and_then(|x| x.as_str()).unwrap_or("")),
        name: v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        status: v.get("status").and_then(|x| x.as_str()).unwrap_or("idle").to_string(),
        status_updated_at: v.get("statusUpdatedAt").and_then(|x| x.as_i64()),
        started_at: v.get("startedAt").and_then(|x| x.as_i64()),
        version: v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        repo_root: None,
        branch: None,
    })
}

/// List interactive Claude Code sessions running OUTSIDE Episko. `exclude` is the
/// set of session ids Episko already owns (belt-and-suspenders — ours don't
/// register anyway). Dead/stale registry files are filtered by verifying the pid
/// is still a live `claude` process.
#[tauri::command(async)]
fn list_external_sessions(state: State<AppState>, exclude: Vec<String>) -> Vec<ExternalSession> {
    let home = home_dir();
    if home.is_empty() {
        return vec![];
    }
    let dir = std::path::Path::new(&home).join(".claude").join("sessions");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let exclude: std::collections::HashSet<String> =
        exclude.into_iter().map(|s| s.to_lowercase()).collect();

    let mut parsed: Vec<ExternalSession> = entries
        .flatten()
        .map(|ent| ent.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|txt| parse_registry_entry(&txt))
        .filter(|s| !exclude.contains(&s.session_id.to_lowercase()))
        .collect();
    if parsed.is_empty() {
        return parsed;
    }

    // Liveness + identity: one process-table snapshot for all pids; keep those
    // still running `claude` (guards against stale files and pid reuse).
    let table = ProcTable::snapshot();
    parsed.retain(|s| table.is_live_claude(s.pid));

    // Drop Episko's OWN sessions, matched by pid — NOT by session id. Their id on
    // disk changes when the user runs /resume or /clear (the pid file is rewritten
    // with the new id), so a session-id exclude alone lets a live, Episko-owned
    // session resurface here as "external". The pid is stable for the process'
    // lifetime. `owned_pids` covers embedded PTYs directly; the ancestry walk also
    // catches sessions launched into a child terminal (e.g. Ghostty).
    let self_pid = std::process::id();
    let owned = state.owned_pids.lock().unwrap().clone();
    parsed.retain(|s| !owned.contains(&s.pid) && !table.is_descendant_of(s.pid, self_pid));

    // Enrich survivors with their repo root + branch so worktrees of one repo group
    // together (and merge into that repo's project) rather than each cwd becoming its
    // own top-level entry. After the filters, so no git runs on stale or owned pids.
    for s in parsed.iter_mut() {
        let (root, branch) = git_repo_info(&s.cwd);
        s.repo_root = root;
        s.branch = branch;
    }

    // most-recently-active first
    parsed.sort_by(|a, b| b.status_updated_at.unwrap_or(0).cmp(&a.status_updated_at.unwrap_or(0)));
    parsed
}

/// Walk up the process tree from `pid` to the owning GUI terminal app.
/// Returns (app_pid, app_exe_path) — e.g. (719, "/…/Terminal.app/Contents/MacOS/Terminal").
#[cfg(not(windows))]
fn owning_terminal(pid: u32) -> Option<(u32, String)> {
    let mut cur = pid;
    for _ in 0..16 {
        let line = ps_one(cur, "ppid=,comm=")?;
        let line = line.trim();
        let mut it = line.splitn(2, char::is_whitespace);
        let ppid = it.next()?.trim().parse::<u32>().ok()?;
        let comm = it.next().unwrap_or("").trim().to_string();
        if comm.contains(".app/Contents/MacOS/") {
            return Some((cur, comm));
        }
        if ppid <= 1 {
            return None;
        }
        cur = ppid;
    }
    None
}

/// External-session surfacing (and thus focusing) is macOS-only for now.
#[cfg(windows)]
#[tauri::command]
fn focus_external_session(_pid: u32) -> Result<(), String> {
    Err("focusing external sessions isn't supported on Windows yet".to_string())
}

/// Bring the terminal window/tab hosting an external session to the front.
/// Exact tab focus for Terminal.app + iTerm2 (matched by tty); best-effort app
/// activation for anything else.
#[cfg(not(windows))]
#[tauri::command]
fn focus_external_session(pid: u32) -> Result<(), String> {
    let tty = ps_one(pid, "tty=").unwrap_or_default().trim().to_string();
    let (_app_pid, app_exe) =
        owning_terminal(pid).ok_or_else(|| "couldn't find the terminal window for this session".to_string())?;
    let lower = app_exe.to_lowercase();

    let script = if lower.contains("terminal.app") {
        format!(
            "tell application \"Terminal\"\n  activate\n  repeat with w in windows\n    repeat with t in tabs of w\n      try\n        if tty of t is \"/dev/{tty}\" then\n          set selected of t to true\n          set index of w to 1\n          set frontmost of w to true\n          return \"ok\"\n        end if\n      end try\n    end repeat\n  end repeat\nend tell"
        )
    } else if lower.contains("iterm") {
        format!(
            "tell application \"iTerm2\"\n  activate\n  repeat with w in windows\n    repeat with t in tabs of w\n      repeat with s in sessions of t\n        try\n          if tty of s ends with \"{tty}\" then\n            select t\n            select w\n            return \"ok\"\n          end if\n        end try\n      end repeat\n    end repeat\n  end repeat\nend tell"
        )
    } else {
        // Generic (VS Code, Warp, Ghostty, …): we can't address an individual
        // tab/pane by tty via AppleScript, and Electron apps run the shell under a
        // *helper* process that isn't in System Events' process list — targeting it
        // by unix id fails with -1719. So just bring the owning app to the front by
        // opening its top-level .app bundle (the first `.app` in the exe path).
        let app_bundle = app_exe
            .split_once(".app/")
            .map(|(head, _)| format!("{head}.app"))
            .unwrap_or_else(|| app_exe.clone());
        let out = std::process::Command::new("open")
            .arg(&app_bundle)
            .output()
            .map_err(|e| format!("open: {e}"))?;
        return if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        };
    };

    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct TranscriptMsg {
    role: String,
    text: String,
}

/// Claude stores a project's transcripts under `~/.claude/projects/<enc>/`, where
/// `<enc>` is the cwd with every non-ASCII-alphanumeric char replaced by `-`.
fn project_transcript_dir(cwd: &str) -> Option<std::path::PathBuf> {
    let home = home_dir();
    if home.is_empty() {
        return None;
    }
    let enc: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(std::path::Path::new(&home).join(".claude").join("projects").join(enc))
}

/// A finished (or at least not-currently-owned) session found on disk, offered to
/// the user as restorable via `claude --resume <id>`.
#[derive(serde::Serialize)]
struct PastSession {
    session_id: String,
    title: String,
    last_prompt: String,
    mtime: u64,
}

/// Enumerate the transcripts Claude has written for `workdir`, newest first, so
/// the frontend can label restorable sessions with something human-readable.
///
/// Titles come from the `ai-title` record Claude maintains; it is rewritten as the
/// session evolves, so the LAST occurrence wins. That record type is internal to
/// Claude Code and documented as unstable across releases, hence the fallback
/// chain: `ai-title` → `last-prompt` → first user message → "" (caller labels it).
/// Only the tail is scanned — `ai-title` recurs throughout the file, so a bounded
/// read reliably catches the latest one without paying for a 4MB transcript.
#[tauri::command(async)]
fn list_past_sessions(workdir: String) -> Result<Vec<PastSession>, String> {
    let dir = match project_transcript_dir(&workdir) {
        Some(d) => d,
        None => return Err("no home directory".to_string()),
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]), // project never had a session — not an error
    };

    let mut out: Vec<PastSession> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let (title, last_prompt) = match transcript_meta(&path) {
            Some(m) => m,
            None => continue,
        };
        out.push(PastSession { session_id, title, last_prompt, mtime });
    }

    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

/// Pull `(title, last_prompt)` out of one transcript. Split out of
/// `list_past_sessions` so it can be tested against a fixture file without
/// touching `$HOME` (which the parallel test threads share).
fn transcript_meta(path: &std::path::Path) -> Option<(String, String)> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    const CAP: u64 = 512 * 1024;
    let mut reader = BufReader::new(file);
    if len > CAP {
        reader.seek(SeekFrom::Start(len - CAP)).ok()?;
        let mut discard = String::new(); // drop the partial first line
        let _ = reader.read_line(&mut discard);
    }

    let (mut title, mut last_prompt, mut first_user) = (String::new(), String::new(), String::new());
    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
            // Both records recur through the file and are rewritten as the session
            // evolves — the LAST occurrence is the current one, so keep overwriting.
            "ai-title" => {
                if let Some(s) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    title = s.trim().to_string();
                }
            }
            "last-prompt" => {
                if let Some(s) = v.get("lastPrompt").and_then(|x| x.as_str()) {
                    last_prompt = s.trim().to_string();
                }
            }
            "user" if first_user.is_empty() => {
                if let Some(serde_json::Value::String(s)) =
                    v.get("message").and_then(|m| m.get("content"))
                {
                    first_user = s.trim().chars().take(200).collect();
                }
            }
            _ => {}
        }
    }
    if title.is_empty() {
        title = if !last_prompt.is_empty() { last_prompt.clone() } else { first_user };
    }
    if title.chars().count() > 120 {
        title = title.chars().take(120).collect::<String>() + "…";
    }
    Some((title, last_prompt))
}

/// The three model tiers collapsed to a family (matches the frontend's `modelFamily`).
fn model_family(model: &str) -> &'static str {
    let s = model.to_ascii_lowercase();
    if s.contains("opus") {
        "opus"
    } else if s.contains("sonnet") {
        "sonnet"
    } else if s.contains("haiku") {
        "haiku"
    } else {
        "other"
    }
}

/// One assistant message's usage, pulled from a transcript line.
struct LineUsage {
    day: String,           // YYYY-MM-DD from the line's own ISO timestamp (UTC)
    tokens: [u64; 4],      // [input, output, cache_read, cache_write]
    family: &'static str,  // opus | sonnet | haiku | other
    project: String,       // basename of the line's cwd ("by working directory")
}

/// Parse one transcript line into a `LineUsage`, or `None` for the many lines with no
/// assistant `usage` record (user turns, tool results, meta). Split out of the scan so
/// the load-bearing, format-dependent parsing can be tested without a `$HOME` the
/// parallel tests share.
fn parse_usage_line(line: &str) -> Option<LineUsage> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let usage = v
        .get("message")
        .and_then(|m| m.get("usage"))
        .or_else(|| v.get("usage"))?;
    let day = match v.get("timestamp").and_then(|t| t.as_str()) {
        Some(ts) if ts.len() >= 10 => ts[..10].to_string(),
        _ => return None,
    };
    let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let model = v
        .get("message")
        .and_then(|m| m.get("model"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let project = v
        .get("cwd")
        .and_then(|x| x.as_str())
        .and_then(|c| c.rsplit(|ch: char| ch == '/' || ch == '\\').find(|s| !s.is_empty()))
        .unwrap_or("unknown")
        .to_string();
    Some(LineUsage {
        day,
        tokens: [
            g("input_tokens"),
            g("output_tokens"),
            g("cache_read_input_tokens"),
            g("cache_creation_input_tokens"),
        ],
        family: model_family(model),
        project,
    })
}

/// One calendar day, aggregated across every transcript: token totals by type, token
/// totals by model family, the number of distinct sessions active, and per-project
/// token totals ("by working directory"). Everything except the daily $ total (which
/// lives in the telemetry rollup and can't be recovered from transcripts) is here.
#[derive(serde::Serialize, Default)]
struct DayUsage {
    day: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    opus: u64,
    sonnet: u64,
    haiku: u64,
    other: u64,
    sessions: u64,
    projects: std::collections::BTreeMap<String, u64>,
}

/// Aggregate transcript usage per calendar day across every Claude Code transcript
/// touched within the last `days` days — tokens (by type and by model family), the
/// count of distinct sessions active, and per-project token totals.
///
/// Tokens et al. are the figures the statusLine never reports (it carries only
/// context-window *occupancy* and a $ total), so they're recovered from each assistant
/// message's own `usage` record. That record shape is internal to Claude Code and
/// documented as unstable (the risk `list_past_sessions` already lives with), hence
/// the defensive parsing and the cheap `contains("\"usage\"")` pre-filter that skips
/// the many lines carrying no tokens.
///
/// This is the heavy path: it reads whole transcripts, so the frontend calls it off
/// the render path and caches the result. The mtime filter skips transcripts not
/// written within the window — an old, untouched file cannot hold an in-range day —
/// which keeps a full year's scan bounded to recent work. All of the model / project /
/// session breakdown rides on this one pass; it adds no extra file reads.
#[tauri::command]
async fn token_usage_by_day(days: u64) -> Result<Vec<DayUsage>, String> {
    // The scan reads whole transcripts (the recent corpus can run to ~1GB), so hand
    // it to a blocking thread. A *synchronous* command runs on the main thread and
    // would freeze the entire UI for the length of the first, uncached scan.
    tauri::async_runtime::spawn_blocking(move || scan_usage(days))
        .await
        .map_err(|e| e.to_string())?
}

fn scan_usage(days: u64) -> Result<Vec<DayUsage>, String> {
    use std::collections::{HashMap, HashSet};
    use std::io::{BufRead, BufReader};
    let home = home_dir();
    if home.is_empty() {
        return Err("no home directory".to_string());
    }
    let root = std::path::Path::new(&home).join(".claude").join("projects");
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(days.saturating_mul(86_400)));

    let mut acc: HashMap<String, DayUsage> = HashMap::new();
    let projects = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]), // no transcripts yet — not an error
    };
    for proj in projects.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let files = match std::fs::read_dir(&pdir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in files.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // Skip transcripts untouched within the window: they can't hold in-range days.
            if let (Some(cut), Ok(meta)) = (cutoff, entry.metadata()) {
                if meta.modified().map(|m| m < cut).unwrap_or(false) {
                    continue;
                }
            }
            let file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            // One file == one session; remember the days it touched to count it once each.
            let mut file_days: HashSet<String> = HashSet::new();
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                let Some(lu) = parse_usage_line(&line) else { continue };
                let LineUsage { day, tokens, family, project } = lu;
                let tot: u64 = tokens.iter().sum();
                let e = acc.entry(day.clone()).or_default();
                if e.day.is_empty() {
                    e.day = day.clone();
                }
                e.input += tokens[0];
                e.output += tokens[1];
                e.cache_read += tokens[2];
                e.cache_write += tokens[3];
                match family {
                    "opus" => e.opus += tot,
                    "sonnet" => e.sonnet += tot,
                    "haiku" => e.haiku += tot,
                    _ => e.other += tot,
                }
                *e.projects.entry(project).or_insert(0) += tot;
                file_days.insert(day);
            }
            for d in file_days {
                let e = acc.entry(d.clone()).or_default();
                if e.day.is_empty() {
                    e.day = d;
                }
                e.sessions += 1;
            }
        }
    }
    let mut out: Vec<DayUsage> = acc.into_values().collect();
    out.sort_by(|a, b| a.day.cmp(&b.day));
    Ok(out)
}

/// Read a read-only slice of an external session's transcript. The transcript
/// lives at `~/.claude/projects/<enc>/<session_id>.jsonl`, where `<enc>` is the
/// cwd with every non-alphanumeric char replaced by `-`. Only the tail (≤512KB)
/// is read; only human/assistant prose is extracted (tool calls, tool results and
/// thinking are dropped), and the last `limit` messages are returned.
#[tauri::command(async)]
fn read_transcript(cwd: String, session_id: String, limit: usize) -> Result<Vec<TranscriptMsg>, String> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};
    let path = project_transcript_dir(&cwd)
        .ok_or_else(|| "no home directory".to_string())?
        .join(format!("{session_id}.jsonl"));
    let file = std::fs::File::open(&path).map_err(|e| format!("transcript not found: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    const CAP: u64 = 512 * 1024;
    let mut reader = BufReader::new(file);
    if len > CAP {
        reader.seek(SeekFrom::Start(len - CAP)).map_err(|e| e.to_string())?;
        let mut discard = String::new(); // drop the partial first line
        let _ = reader.read_line(&mut discard);
    }

    let mut msgs: Vec<TranscriptMsg> = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t != "user" && t != "assistant" {
            continue;
        }
        let content = v.get("message").and_then(|m| m.get("content"));
        let mut text = String::new();
        match content {
            Some(serde_json::Value::String(s)) => text.push_str(s),
            Some(serde_json::Value::Array(arr)) => {
                // Only "text" blocks: tool calls (Bash, Read, Edit, …), tool_result
                // echoes and thinking blocks are noise in a read-only conversation
                // mirror — keep the human/assistant prose. An assistant turn that is
                // only tool calls collapses to empty and is dropped below.
                for blk in arr {
                    if blk.get("type").and_then(|x| x.as_str()) == Some("text") {
                        if let Some(s) = blk.get("text").and_then(|x| x.as_str()) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(s);
                        }
                    }
                }
            }
            _ => {}
        }
        let mut text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if text.len() > 4000 {
            text.truncate(4000);
            text.push('…');
        }
        msgs.push(TranscriptMsg { role: t.to_string(), text });
    }
    let n = msgs.len();
    if n > limit {
        msgs = msgs.split_off(n - limit);
    }
    Ok(msgs)
}

// ---------- app quit ----------

/// Actually terminate the app. The Cmd+Q accelerator is bound to our own menu
/// item (see the app menu in `run`), which asks the frontend to confirm instead
/// of quitting; the frontend calls this once the user (or an empty session list)
/// has approved the quit. Kept as a command so the *only* immediate-exit paths
/// are this and the tray's "Quit Episko".
#[tauri::command]
fn confirm_quit(app: AppHandle) {
    app.exit(0);
}

// ---------- macOS menu-bar (tray) ----------

#[derive(serde::Deserialize)]
struct TrayItem {
    id: String,
    label: String,
}

/// Rebuild the tray menu to mirror the sidebar: one clickable row per session
/// (with its status), plus Show / Quit. `title` is the short text shown next to
/// the menu-bar icon (macOS); `tooltip` is the hover text.
#[tauri::command]
fn update_tray(
    app: AppHandle,
    title: String,
    tooltip: String,
    items: Vec<TrayItem>,
) -> Result<(), String> {
    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return Ok(()),
    };
    let mut mb = MenuBuilder::new(&app);
    if items.is_empty() {
        mb = mb.text("none", "No active sessions");
    } else {
        for it in &items {
            mb = mb.text(it.id.clone(), it.label.clone());
        }
    }
    let menu = mb
        .separator()
        .text("show", "Show Episko")
        // Keep this trio in sync with the initial menu built in `run()` — this
        // command *replaces* the whole menu, so anything missing here vanishes the
        // moment the frontend first renders.
        .text("check-updates", "Check for Updates…")
        .separator()
        .text("quit", "Quit Episko")
        .build()
        .map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    let _ = tray.set_tooltip(Some(&tooltip));
    // macOS-only: text label rendered next to the menu-bar icon.
    let _ = tray.set_title(Some(&title));
    Ok(())
}

/// Log every panic — message, location, thread, backtrace — before the process
/// dies. A panic that unwinds out of `main` terminates a GUI app *cleanly* as far
/// as the OS is concerned: no crash dump, no WER/CrashReporter entry, the window
/// just vanishes. This hook is the only on-disk trace of that failure class. It
/// writes through the `log` facade (→ the rolling episko.log) AND appends raw to
/// `panic.log` in the same directory, in case the logger itself is what broke.
fn install_panic_hook(log_dir: std::path::PathBuf) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current();
        let msg = format!(
            "panic on thread '{}': {info}\n{backtrace}",
            thread.name().unwrap_or("<unnamed>")
        );
        log::error!("{msg}");
        let _ = std::fs::create_dir_all(&log_dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("panic.log"))
        {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[unix {secs}] {msg}\n");
        }
        prev(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("episko".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Windows analog of the macOS Cmd+Q catcher in `setup` below: Windows gets
        // no app menu (see there), so quitting means closing the window. Intercept
        // the close and run the same frontend confirm flow — only `confirm_quit`
        // actually exits, and the frontend calls it straight away when idle.
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("quit-requested", ());
            }
            #[cfg(not(windows))]
            let _ = (window, event);
        })
        .setup(|app| {
            // Before anything that can panic: from here on, panics leave a trace.
            install_panic_hook(app.path().app_log_dir()?);
            log::info!("episko v{} starting", app.package_info().version);

            let server = tiny_http::Server::http("127.0.0.1:0")
                .expect("bind telemetry server on 127.0.0.1");
            let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
            log::info!("telemetry server on 127.0.0.1:{port}");

            app.manage(AppState {
                port,
                sessions: Mutex::new(HashMap::new()),
                owned_pids: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                next_perm: std::sync::atomic::AtomicU64::new(1),
                caffeinate: Mutex::new(None),
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || run_telemetry_server(server, handle));

            // macOS menu-bar (tray) icon — its menu mirrors the sidebar and is
            // rebuilt from the frontend via `update_tray`.
            let tray_menu = MenuBuilder::new(app)
                .text("show", "Show Episko")
                .text("check-updates", "Check for Updates…")
                .separator()
                .text("quit", "Quit Episko")
                .build()?;
            // Monochrome `>_` glyph, rendered as a macOS template image so it
            // adapts to the light/dark menu bar. Falls back to the app icon.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate.png"))
                .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Episko")
                .menu(&tray_menu)
                // Double-click the icon → show the window. NOTE: on macOS the tray
                // crate never emits DoubleClick (it's Windows/Linux-only), so there
                // the "Show Episko" menu item is the reliable path; this handler
                // covers the other platforms.
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    let id = event.id().0.as_str();
                    match id {
                        "quit" => app.exit(0),
                        "show" | "none" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        // Must be matched before the `sid` arm below, which treats
                        // any unknown id as a session to select. The window is shown
                        // first because the check reports itself as a toast/chip in
                        // the UI — checking from a hidden window would look like a
                        // menu item that does nothing.
                        "check-updates" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("tray-check-updates", ());
                        }
                        // Cmd+Q is handled by the app menu's own quit item, but that
                        // MenuEvent also reaches this handler — every menu handler shares
                        // one global listener list — so swallow it here instead of letting
                        // it fall through to the session catch-all below.
                        "quit-confirm" => {}
                        sid => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("tray-select", sid.to_string());
                        }
                    }
                })
                .build(app)?;

            // ---- App menu with a Cmd+Q catcher (macOS only) ----
            // Cmd+Q is a "special Apple event" that Tauri does not reliably surface
            // as an app/window event on macOS (tauri-apps/tauri#9198), so
            // RunEvent::ExitRequested/prevent_exit can't be trusted to intercept it.
            // Instead we *own* the Quit item: binding our own menu item to Cmd+Q means
            // the keystroke fires `on_menu_event` (deterministic) rather than the OS
            // `terminate:`. The handler asks the frontend to confirm; only `confirm_quit`
            // actually exits. Replacing the default menu means we must re-add the Edit
            // submenu ourselves, or Cmd+C/X/V/Z/A stop working in the app's inputs.
            //
            // Never install this on Windows: `set_menu` would render it as an
            // in-window menu bar full of mac-only items — and muda's predefined
            // Hide item there does a raw Win32 ShowWindow(SW_HIDE) behind tao's
            // visibility flags, after which tao's show() no-ops and the window is
            // unrecoverable, tray "Show Episko" included (muda 0.19.3
            // windows/mod.rs:1217 vs tao 0.35.3 window_state.rs apply_diff).
            // Windows needs no menu at all: WebView2 handles the edit shortcuts
            // natively, and quitting goes through the CloseRequested hook on the
            // builder above.
            #[cfg(target_os = "macos")]
            {
                let quit_item = MenuItemBuilder::with_id("quit-confirm", "Quit Episko")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Episko")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .item(&quit_item)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .fullscreen()
                    .separator()
                    .close_window()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().0.as_str() == "quit-confirm" {
                        // Surface the window so the confirm dialog has context, then let the
                        // frontend decide (it quits straight away when nothing is running).
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        let _ = app.emit("quit-requested", ());
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_claude,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_session,
            git::git_branch,
            git::git_head,
            git::git_diffstat,
            git::git_diff,
            git::git_action,
            pty::session_resources,
            git::create_worktree,
            set_caffeinate,
            telemetry::resolve_permission,
            git::list_worktrees,
            git::remove_worktree,
            git::git_branch_list,
            git::delete_branch,
            git::switch_branch,
            git::git_commit_info,
            pty::spawn_ghostty,
            pty::spawn_shell,
            pty::spawn_task,
            tasks::discover_runnables,
            tasks::rescan_runnables,
            tasks::save_episko_task,
            tasks::delete_episko_task,
            tasks::save_task_override,
            tasks::remove_task_override,
            tasks::list_task_overrides,
            tasks::episko_tasks_file,
            pty::available_terminals,
            pty::spawn_external_terminal,
            pty::open_terminal_here,
            list_external_sessions,
            focus_external_session,
            read_transcript,
            list_past_sessions,
            token_usage_by_day,
            find_project_icon,
            read_custom_icon,
            read_legacy_localstorage,
            open_folder,
            reveal_path,
            write_debug_file,
            log_frontend,
            update_tray,
            confirm_quit
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // Record clean shutdowns: a log that ends WITHOUT one of these lines is an
        // abnormal termination — that alone answers "did it crash or was it quit?".
        .run(|_app, event| match event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                log::info!(
                    "exit requested{}",
                    code.map(|c| format!(" (code {c})")).unwrap_or_default()
                );
            }
            tauri::RunEvent::Exit => log::info!("exit · clean shutdown"),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::scratch_dir;

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

    #[test]
    fn parse_usage_line_extracts_day_tokens_family_and_project() {
        let line = r#"{"type":"assistant","timestamp":"2026-07-21T10:00:00.000Z","cwd":"/Users/tim/dev/episko","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":300,"cache_creation_input_tokens":4}}}"#;
        let lu = parse_usage_line(line).expect("assistant usage line should parse");
        assert_eq!(lu.day, "2026-07-21");
        assert_eq!(lu.tokens, [10, 20, 300, 4]);
        assert_eq!(lu.family, "opus");
        assert_eq!(lu.project, "episko"); // basename of cwd
        // Missing token fields default to 0; unknown model → "other"; no cwd → "unknown".
        let partial = r#"{"timestamp":"2026-07-21T10:00:00Z","message":{"usage":{"output_tokens":7}}}"#;
        let lu = parse_usage_line(partial).expect("should parse");
        assert_eq!(lu.tokens, [0, 7, 0, 0]);
        assert_eq!(lu.family, "other");
        assert_eq!(lu.project, "unknown");
    }

    #[test]
    fn parse_usage_line_skips_lines_without_usage() {
        // The cheap pre-filter and the shape checks both reject non-usage lines.
        assert!(parse_usage_line(r#"{"type":"user","timestamp":"2026-07-21T10:00:00Z"}"#).is_none());
        assert!(parse_usage_line("not json at all").is_none());
        // A usage record with no timestamp can't be bucketed, so it's dropped.
        assert!(parse_usage_line(r#"{"message":{"usage":{"input_tokens":5}}}"#).is_none());
    }

    #[test]
    fn model_family_buckets_by_tier() {
        assert_eq!(model_family("claude-opus-4-8"), "opus");
        assert_eq!(model_family("claude-sonnet-4-5"), "sonnet");
        assert_eq!(model_family("claude-haiku-4-5-20251001"), "haiku");
        assert_eq!(model_family("some-future-model"), "other");
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

    /// Repos routinely ship a PNG named `favicon.ico`. Trusting the extension would
    /// emit `data:image/x-icon` wrapping PNG bytes, which the webview may refuse —
    /// the icon reads as "found" but renders broken. So content wins over extension,
    /// and the extension is only the fallback.
    #[test]
    fn sniff_mime_trusts_content_over_extension() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\nIHDR", "ico"), Some("image/png"));
        assert_eq!(sniff_mime(&[0x00, 0x00, 0x01, 0x00, 0x01, 0x00], "png"), Some("image/x-icon"));
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0], "png"), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"GIF89a\x10\x00", "png"), Some("image/gif"));
        assert_eq!(sniff_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 ", "png"), Some("image/webp"));
        assert_eq!(sniff_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\">", "png"), Some("image/svg+xml"));
        // SVG is text, so it's found by tag — past an XML prolog, and case-insensitively.
        assert_eq!(sniff_mime(b"<?xml version=\"1.0\"?>\n<SVG width=\"16\">", "bin"), Some("image/svg+xml"));
        // Unsniffable (e.g. an SVG behind a long prolog) falls back to the extension.
        assert_eq!(sniff_mime(b"", "svg"), Some("image/svg+xml"));
        assert_eq!(sniff_mime(b"nothing recognisable", "webp"), Some("image/webp"));
        // Neither content nor extension says image → no icon, rather than a guess.
        assert_eq!(sniff_mime(b"nothing recognisable", "txt"), None);
    }




    /// `ai-title` and `last-prompt` are rewritten repeatedly as a session evolves,
    /// so the newest one at the end of the file has to win over the earlier ones.
    #[test]
    fn transcript_meta_takes_the_last_title_and_prompt() {
        let dir = scratch_dir();
        let path = dir.join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","message":{"content":"the very first thing I asked"}}"#, "\n",
                r#"{"type":"ai-title","aiTitle":"An early guess"}"#, "\n",
                r#"{"type":"last-prompt","lastPrompt":"an early prompt"}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#, "\n",
                r#"{"type":"ai-title","aiTitle":"What it settled on"}"#, "\n",
                r#"{"type":"last-prompt","lastPrompt":"the latest prompt"}"#, "\n",
            ),
        )
        .unwrap();
        let (title, last) = transcript_meta(&path).unwrap();
        assert_eq!(title, "What it settled on");
        assert_eq!(last, "the latest prompt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The record types are internal to Claude Code and documented as unstable, so a
    /// transcript without `ai-title` must still yield something human-readable.
    #[test]
    fn transcript_meta_falls_back_when_no_ai_title() {
        let dir = scratch_dir();

        // No ai-title → the last prompt stands in.
        let a = dir.join("a.jsonl");
        std::fs::write(
            &a,
            concat!(
                r#"{"type":"user","message":{"content":"opening message"}}"#, "\n",
                r#"{"type":"last-prompt","lastPrompt":"what I asked most recently"}"#, "\n",
            ),
        )
        .unwrap();
        assert_eq!(transcript_meta(&a).unwrap().0, "what I asked most recently");

        // Neither → the first user message stands in.
        let b = dir.join("b.jsonl");
        std::fs::write(&b, "{\"type\":\"user\",\"message\":{\"content\":\"opening message\"}}\n").unwrap();
        assert_eq!(transcript_meta(&b).unwrap().0, "opening message");

        // Garbage lines are skipped, not fatal — a torn write must not lose the title.
        let c = dir.join("c.jsonl");
        std::fs::write(
            &c,
            concat!("not json at all\n", r#"{"type":"ai-title","aiTitle":"Survived"}"#, "\n", "{\"truncated\":"),
        )
        .unwrap();
        assert_eq!(transcript_meta(&c).unwrap().0, "Survived");

        // An empty transcript yields an empty title (the frontend labels it).
        let d = dir.join("d.jsonl");
        std::fs::write(&d, "").unwrap();
        assert_eq!(transcript_meta(&d).unwrap().0, "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A transcript bigger than the 512KB tail cap must still surface the newest
    /// title — the whole point of scanning the tail rather than the head.
    #[test]
    fn transcript_meta_reads_the_tail_of_a_large_transcript() {
        let dir = scratch_dir();
        let path = dir.join("big.jsonl");
        let filler = format!(
            "{}\n",
            serde_json::json!({ "type": "assistant", "message": { "content": "x".repeat(4000) } })
        );
        let mut body = String::new();
        body.push_str(r#"{"type":"ai-title","aiTitle":"Stale head title"}"#);
        body.push('\n');
        while body.len() < 900 * 1024 {
            body.push_str(&filler);
        }
        body.push_str(r#"{"type":"ai-title","aiTitle":"Fresh tail title"}"#);
        body.push('\n');
        std::fs::write(&path, &body).unwrap();

        assert!(body.len() as u64 > 512 * 1024, "fixture must exceed the tail cap");
        assert_eq!(transcript_meta(&path).unwrap().0, "Fresh tail title");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn table(entries: &[(u32, Option<u32>, &str)]) -> ProcTable {
        ProcTable {
            procs: entries.iter().map(|&(pid, ppid, name)| (pid, (ppid, name.to_string()))).collect(),
        }
    }

    #[test]
    fn proc_table_identity_and_ancestry() {
        // episko(100) → ghostty(200) → claude(300); unrelated claude(400) under init.
        let t = table(&[
            (100, Some(1), "episko"),
            (200, Some(100), "ghostty"),
            (300, Some(200), "claude"),
            (400, Some(1), "claude.exe"),
        ]);
        assert!(t.is_descendant_of(300, 100), "grandchild via child terminal");
        assert!(t.is_descendant_of(100, 100), "a pid is its own ancestor");
        assert!(!t.is_descendant_of(400, 100), "unrelated session must stay external");
        assert!(t.is_live_claude(300));
        assert!(t.is_live_claude(400), "windows .exe name still matches");
        assert!(!t.is_live_claude(200), "live but not claude");
        assert!(!t.is_live_claude(999), "dead pid");
    }

    #[test]
    fn proc_table_ancestry_survives_ppid_cycles() {
        // Windows pid reuse can produce ppid cycles; the walk must terminate.
        let t = table(&[(10, Some(20), "a"), (20, Some(10), "b")]);
        assert!(!t.is_descendant_of(10, 99));
    }

    #[test]
    fn proc_table_snapshot_sees_this_process() {
        // Real sysinfo snapshot on whatever OS runs the tests: our own pid must
        // be present and count as its own descendant.
        let t = ProcTable::snapshot();
        let me = std::process::id();
        assert!(t.procs.contains_key(&me), "own pid missing from process snapshot");
        assert!(t.is_descendant_of(me, me));
    }

    #[test]
    fn parse_registry_entry_accepts_interactive_rejects_rest() {
        // Shape verified against a real CC 2.1.216 registry file on Windows;
        // the keys are identical on macOS.
        let win = r#"{"pid":41708,"sessionId":"20283E01-6874-4FBB-B696-C29A89F13CC6","cwd":"E:\\Programming\\Work\\Respeak\\episko","startedAt":1784613714619,"procStart":"639202177128968910","version":"2.1.216","peerProtocol":1,"kind":"interactive","entrypoint":"cli","name":"episko-15","nameSource":"derived","status":"busy","updatedAt":1784614124255,"statusUpdatedAt":1784614124255}"#;
        let s = parse_registry_entry(win).expect("interactive entry should parse");
        assert_eq!(s.pid, 41708);
        assert_eq!(s.cwd, r"E:\Programming\Work\Respeak\episko");
        assert_eq!(s.status, "busy");
        assert_eq!(s.status_updated_at, Some(1784614124255));

        // Non-interactive (`claude -p`, SDK) and malformed entries are skipped.
        assert!(parse_registry_entry(r#"{"pid":1,"sessionId":"x","kind":"print"}"#).is_none());
        assert!(parse_registry_entry(r#"{"sessionId":"x","kind":"interactive"}"#).is_none());
        assert!(parse_registry_entry("not json").is_none());
    }

}
