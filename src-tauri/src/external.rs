// External (non-Episko) Claude Code sessions.
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
// owning terminal window) is written twice — AppleScript on macOS, the window
// APIs on Windows — because "which window is that pid's terminal" has no
// portable answer.

use tauri::State;

// `ps_one` is reached only from the macOS focus path, so on Windows an
// unconditional import is an unused-import warning; `sys_command` isn't wanted at
// all here — `osascript` is spawned directly.
#[cfg(not(windows))]
use crate::platform::ps_one;
use crate::git::git_repo_info;
use crate::platform::{home_dir, norm_path};
use crate::AppState;

#[derive(serde::Serialize)]
pub(crate) struct ExternalSession {
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
pub(crate) struct ProcTable {
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

// ---------- which ports our sessions are actually listening on ----------

/// One TCP port a session's process tree has open, as the frontend reads it.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub(crate) struct SessionPort {
    /// The Episko pane whose PTY child this socket descends from.
    session_id: String,
    port: u16,
    /// The process actually holding the socket — `node.exe`, `python.exe`. It is
    /// several hops below the pane (a real chain measured here was
    /// `node <- cmd <- node <- cmd <- node <- cmd <- pwsh <- claude <- episko`), so
    /// this is a leaf's name, not the command the user or the agent ran.
    pid: u32,
    name: String,
}

/// Collapse the several sockets one server really has down to one row per
/// (session, port).
///
/// A dev server binding "everywhere" is three or four listeners: `0.0.0.0`, `[::]`,
/// and often `127.0.0.1` and a LAN address besides — a real one measured here showed
/// up five times. They are one server and one row. The lowest pid wins so the answer
/// is stable across polls rather than reordering with the OS's enumeration.
fn dedupe_ports(mut found: Vec<SessionPort>) -> Vec<SessionPort> {
    found.sort_by(|a, b| {
        (a.session_id.as_str(), a.port, a.pid).cmp(&(b.session_id.as_str(), b.port, b.pid))
    });
    found.dedup_by(|a, b| a.session_id == b.session_id && a.port == b.port);
    found
}

/// Every TCP port listened on by a process descended from one of our panes.
///
/// **This is the ground truth the rest of the running-server feature only approximates.**
/// A parsed log line is a guess about somebody else's output format; a listening socket
/// either exists or it does not. It is also the only thing that can see a server nobody
/// announced — one started by hand in a shell pane, or one whose banner we cannot parse
/// — because it asks the kernel rather than the process.
///
/// Attribution is by ancestry, and it reaches: the chain from a `vite` leaf back to
/// `episko.exe` measured **eight** hops on Windows (node → cmd → node → cmd → node →
/// cmd → pwsh → claude), well inside `is_descendant_of`'s cap. What it cannot do is
/// name a server whose chain is *broken* — an orphan whose session has exited — and
/// that is deliberate: those have no pane to belong to, and inventing one would be
/// worse than leaving them out.
///
/// Spawn-free on every platform (`GetExtendedTcpTable`, libproc, `/proc`), like
/// `ProcTable` above, because this is polled.
#[tauri::command]
pub(crate) fn session_ports(state: State<AppState>) -> Vec<SessionPort> {
    // The roster first: with no panes open there is nothing any socket could belong
    // to, and the whole scan is skipped.
    let roster: Vec<(String, u32)> = state
        .sessions
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(id, s)| s.pid.map(|p| (id.clone(), p)))
        .collect();
    if roster.is_empty() {
        return Vec::new();
    }
    let Ok(all) = listeners::get_all() else { return Vec::new() };
    let table = ProcTable::snapshot();
    let mut found = Vec::new();
    for l in all {
        // TCP only, and only actually-listening sockets: SSDP, NetBIOS and mDNS are
        // UDP and would otherwise read as somebody's dev server.
        if l.protocol != listeners::Protocol::TCP || l.state != listeners::SocketState::Listen {
            continue;
        }
        let Some((id, _)) = roster.iter().find(|(_, root)| table.is_descendant_of(l.process.pid, *root))
        else {
            continue;
        };
        found.push(SessionPort {
            session_id: id.clone(),
            port: l.socket.port(),
            pid: l.process.pid,
            name: l.process.name.clone(),
        });
    }
    dedupe_ports(found)
}

/// Parse one `~/.claude/sessions/<pid>.json` registry file into an
/// `ExternalSession` (repo_root/branch enriched later). None for malformed
/// files and non-interactive entries (`claude -p`, SDK runs).
pub(crate) fn parse_registry_entry(txt: &str) -> Option<ExternalSession> {
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
pub(crate) fn list_external_sessions(state: State<AppState>, exclude: Vec<String>) -> Vec<ExternalSession> {
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

    // most-recently-active first (Reverse, because sort_by_key sorts ascending)
    parsed.sort_by_key(|s| std::cmp::Reverse(s.status_updated_at.unwrap_or(0)));
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

/// One visible top-level window: who owns it, which window, and its caption.
#[cfg(windows)]
struct Win {
    pid: u32,
    hwnd: isize,
    title: String,
}

/// Every visible top-level window on the desktop, in Z-order — `EnumWindows`
/// enumerates front-to-back, so the *first* entry for a pid is that app's most
/// recently fronted window. The filter is the one that decides a taskbar button:
/// visible, unowned, and titled. Without it a single app answers with the
/// invisible message-only and tool windows it also owns, and raising one of
/// those does nothing the user can see.
///
/// `GetWindowTextW` is safe to call across processes — for a window owned by
/// another process it reads the stored caption rather than sending `WM_GETTEXT`,
/// so a wedged terminal can't hang this walk.
#[cfg(windows)]
fn top_level_windows() -> Vec<Win> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        GW_OWNER,
    };
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        unsafe {
            let out = &mut *(lparam as *mut Vec<Win>);
            if IsWindowVisible(hwnd) != 0 && GetWindow(hwnd, GW_OWNER).is_null() {
                let len = GetWindowTextLengthW(hwnd);
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, &mut pid);
                if len > 0 && pid != 0 {
                    let mut buf = vec![0u16; len as usize + 1];
                    let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
                    out.push(Win { pid, hwnd: hwnd as isize, title: String::from_utf16_lossy(&buf[..n]) });
                }
            }
        }
        1 // keep enumerating
    }
    let mut out: Vec<Win> = Vec::new();
    unsafe { EnumWindows(Some(collect), &mut out as *mut Vec<Win> as LPARAM) };
    out
}

/// Pick one of `pid`'s windows. Z-order makes the first its most recently
/// fronted, which is the right default — but one process can own a window per
/// project, and then the default is right once and wrong every other time: three
/// VS Code windows here are all owned by a single `code.exe`, so every jump
/// landed on whichever was last in front. `hint` (the session's project folder)
/// breaks that tie against the caption, which both VS Code and Windows Terminal
/// put the folder in. A hint that matches nothing falls back to the topmost, and
/// a hint that matches the *wrong* window can only ever pick another window of
/// the terminal we already resolved — never a different app.
#[cfg(windows)]
fn pick_window(pid: u32, wins: &[Win], hint: &str) -> Option<isize> {
    let mine = || wins.iter().filter(|w| w.pid == pid);
    let hint = hint.to_lowercase();
    if !hint.is_empty() {
        if let Some(w) = mine().find(|w| w.title.to_lowercase().contains(&hint)) {
            return Some(w.hwnd);
        }
    }
    mine().next().map(|w| w.hwnd) // Z-order: this app's most recently fronted window
}

/// Processes a console session can hang off that are never "its terminal". Only
/// `explorer.exe` really matters — the others own no titled window anyway — but
/// it matters a lot: a shell started from the Run box or a shortcut has the
/// desktop shell as its parent, and returning *that* would front a File Explorer
/// window (or the desktop) instead of admitting we didn't find the terminal.
#[cfg(windows)]
const NOT_A_TERMINAL: [&str; 6] = [
    "explorer.exe",
    "services.exe",
    "svchost.exe",
    "wininit.exe",
    "winlogon.exe",
    "system",
];

/// Walk up from `pid` to the window of the terminal hosting it, taking the
/// desktop as data (`wins`) so the whole walk is testable without one.
///
/// Two shapes have to come out right, and only one of them walks upward:
///
/// - **The terminal is an ancestor** — Windows Terminal (`WindowsTerminal.exe` →
///   `OpenConsole.exe` → shell → claude) and Electron hosts alike. VS Code puts a
///   *windowless* `Code.exe` pty-host between the shell and the windowed
///   `Code.exe`, so this must not stop at the first ancestor, only at the first
///   ancestor that owns a window (verified against live VS Code-hosted sessions).
/// - **The console host is a CHILD** — the classic `conhost.exe` case. It owns
///   the window but is spawned *by* the console process, so no upward walk can
///   reach it; hence the per-level child scan. Verified on Win11 with the console
///   delegation GUIDs unset.
///
/// The 16-level cap is not decoration: pid reuse hands a dead parent's pid to a
/// new process, and this machine's own table contains a two-process ppid cycle.
#[cfg(windows)]
fn terminal_window_for(pid: u32, table: &ProcTable, wins: &[Win], hint: &str) -> Option<isize> {
    let mut cur = pid;
    for _ in 0..16 {
        if let Some(h) = pick_window(cur, wins, hint) {
            return Some(h);
        }
        if let Some(h) = table
            .procs
            .iter()
            .filter(|(_, (ppid, name))| *ppid == Some(cur) && (name.contains("conhost") || name.contains("openconsole")))
            .find_map(|(child, _)| pick_window(*child, wins, hint))
        {
            return Some(h);
        }
        let ppid = table.procs.get(&cur).and_then(|(ppid, _)| *ppid)?;
        if ppid <= 1 || ppid == cur {
            return None;
        }
        if table.procs.get(&ppid).is_some_and(|(_, name)| NOT_A_TERMINAL.contains(&name.as_str())) {
            return None;
        }
        cur = ppid;
    }
    None
}

/// Bring the terminal window hosting an external session to the front.
///
/// Window-level only: Windows has no tty to match a tab by, so a Windows
/// Terminal window with five tabs comes forward showing whichever tab it was
/// last on — the same tradeoff macOS accepts for Electron hosts, one rung
/// coarser. `SetForegroundWindow` is allowed here because Episko *is* the
/// foreground process when the user clicks the jump button; if that ever isn't
/// true Windows silently refuses, so say so rather than reporting success.
///
/// The session's own registry file supplies the project folder used to
/// disambiguate a host that owns several windows — the frontend already knows
/// that cwd, but re-reading one small file keeps this command's signature (and
/// the whole macOS half) untouched.
#[cfg(windows)]
#[tauri::command]
pub(crate) fn focus_external_session(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE};

    let hint = std::fs::read_to_string(
        std::path::Path::new(&home_dir()).join(".claude").join("sessions").join(format!("{pid}.json")),
    )
    .ok()
    .and_then(|txt| parse_registry_entry(&txt))
    .and_then(|s| std::path::Path::new(&s.cwd).file_name().map(|n| n.to_string_lossy().into_owned()))
    .unwrap_or_default();

    let table = ProcTable::snapshot();
    let wins = top_level_windows();
    let hwnd = terminal_window_for(pid, &table, &wins, &hint)
        .ok_or_else(|| "couldn't find the terminal window for this session".to_string())?;

    let hwnd = hwnd as HWND;
    unsafe {
        // Foreground and minimised are independent: raising a minimised window
        // leaves it minimised, so restore first or the jump does nothing visible.
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd) == 0 {
            return Err("Windows wouldn't bring that terminal window forward".to_string());
        }
    }
    Ok(())
}

/// Bring the terminal window/tab hosting an external session to the front.
/// Exact tab focus for Terminal.app + iTerm2 (matched by tty); best-effort app
/// activation for anything else.
#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn focus_external_session(pid: u32) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;


    fn table(entries: &[(u32, Option<u32>, &str)]) -> ProcTable {
        ProcTable {
            procs: entries.iter().map(|&(pid, ppid, name)| (pid, (ppid, name.to_string()))).collect(),
        }
    }

    fn sp(session: &str, port: u16, pid: u32) -> SessionPort {
        SessionPort { session_id: session.into(), port, pid, name: "node.exe".into() }
    }

    /// One dev server is several sockets. Vite binding "everywhere" shows up as
    /// `0.0.0.0`, `[::]`, `127.0.0.1` and a LAN address — a real process measured on
    /// this machine appeared five times — and every one of them is the same server and
    /// must be one row. Without this the header would count a single `pnpm dev` as four.
    #[test]
    fn dedupe_ports_collapses_one_server_to_one_row() {
        let got = dedupe_ports(vec![
            sp("a", 5555, 64828), sp("a", 5555, 64828), sp("a", 5555, 64828),
            sp("a", 8787, 81320),
        ]);
        assert_eq!(got.len(), 2, "one row per (session, port): {got:?}");
        assert_eq!(got.iter().map(|p| p.port).collect::<Vec<_>>(), vec![5555, 8787]);
    }

    /// The same port in two panes is two servers, not one. Two worktrees of the same
    /// repo each running their own dev server is the normal way this happens — they
    /// cannot both hold 5555, but a `--strictPort`-less vite will land one on 5556, and
    /// collapsing across sessions would still be wrong the moment the ports differ.
    #[test]
    fn dedupe_ports_keeps_the_same_port_in_two_panes_apart() {
        let got = dedupe_ports(vec![sp("a", 5555, 1), sp("b", 5555, 2)]);
        assert_eq!(got.len(), 2, "sessions must not collapse into each other: {got:?}");
    }

    /// The lowest pid wins, so a row does not reshuffle between polls just because the
    /// OS enumerated its sockets in a different order.
    #[test]
    fn dedupe_ports_is_stable_across_enumeration_order() {
        let a = dedupe_ports(vec![sp("s", 3000, 900), sp("s", 3000, 100)]);
        let b = dedupe_ports(vec![sp("s", 3000, 100), sp("s", 3000, 900)]);
        assert_eq!(a, b);
        assert_eq!(a[0].pid, 100);
    }

    /// A contract test for somebody else's crate, on whatever OS is running the suite.
    ///
    /// `listeners` is the one dependency here whose whole job is a platform API we do not
    /// own — three separate implementations (`GetExtendedTcpTable`, libproc, `/proc`) of
    /// the same question — and it is the half of this feature that cannot be checked from
    /// a developer's machine, because only one OS is in front of you at a time. A release
    /// that broke its macOS arm would leave every other test in this file green while the
    /// header's server list silently emptied.
    ///
    /// **So the test opens a socket and demands the crate find it.** Merely asserting that
    /// the returned rows are well-formed would pass *vacuously* on an implementation that
    /// returned nothing at all, which is precisely the failure being guarded against —
    /// and "assert it found at least one" would lean on the machine happening to have a
    /// server up. Binding our own removes both problems: the answer is known, it is ours,
    /// and the assertion covers the whole chain this feature needs — the socket, its port,
    /// and the owning pid that `session_ports` walks ancestry from.
    #[test]
    fn listeners_sees_a_socket_we_just_opened() {
        // Port 0 → the kernel picks a free one, so this cannot collide with anything.
        let sock = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a local listener");
        let port = sock.local_addr().unwrap().port();
        let us = std::process::id();

        let all = listeners::get_all().expect("listeners::get_all failed on this OS");
        let mine = all.iter().find(|l| {
            l.protocol == listeners::Protocol::TCP
                && l.state == listeners::SocketState::Listen
                && l.socket.port() == port
        });
        let mine = mine.unwrap_or_else(|| {
            panic!(
                "listeners did not report a socket this process is holding open on port \
                 {port}. It saw {} listening TCP sockets. Attribution in `session_ports` \
                 is built on this, so the header's server list is empty on this OS.",
                all.iter()
                    .filter(|l| l.protocol == listeners::Protocol::TCP
                        && l.state == listeners::SocketState::Listen)
                    .count()
            )
        });
        assert_eq!(
            mine.process.pid, us,
            "the socket was found but attributed to pid {} rather than ours ({us}); \
             ancestry would then place every server under the wrong pane",
            mine.process.pid
        );
        drop(sock);
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

    #[cfg(windows)]
    fn wins(entries: &[(u32, isize, &str)]) -> Vec<Win> {
        entries.iter().map(|&(pid, hwnd, title)| Win { pid, hwnd, title: title.to_string() }).collect()
    }

    /// The window walk, exercised over the three process shapes a Windows session
    /// actually comes in. No desktop involved — `wins` is the desktop.
    #[cfg(windows)]
    #[test]
    fn terminal_window_finds_the_host_in_every_shape() {
        let win = |pid: u32| wins(&[(pid, 0x1234, "a terminal")]);

        // VS Code (the shape live sessions on this machine have): a *windowless*
        // Code.exe pty host between the shell and the windowed Code.exe. Stopping
        // at the first ancestor would find nothing.
        let vscode = table(&[
            (300, Some(200), "claude.exe"),
            (200, Some(100), "code.exe"),
            (100, Some(50), "code.exe"),
            (50, Some(1), "explorer.exe"),
        ]);
        assert_eq!(terminal_window_for(300, &vscode, &win(100), ""), Some(0x1234));

        // Windows Terminal: the terminal really is an ancestor.
        let wt = table(&[
            (300, Some(200), "claude.exe"),
            (200, Some(100), "openconsole.exe"),
            (100, Some(50), "windowsterminal.exe"),
            (50, Some(1), "explorer.exe"),
        ]);
        assert_eq!(terminal_window_for(300, &wt, &win(100), ""), Some(0x1234));

        // Classic conhost: the host owns the window but is a CHILD of the shell,
        // so only the per-level child scan can reach it.
        let conhost = table(&[
            (300, Some(200), "claude.exe"),
            (200, Some(50), "powershell.exe"),
            (400, Some(200), "conhost.exe"),
            (50, Some(1), "explorer.exe"),
        ]);
        assert_eq!(terminal_window_for(300, &conhost, &win(400), ""), Some(0x1234));
    }

    /// The two ways the walk must give up rather than guess. Both are failures
    /// the user sees as a wrong window, not as an error, if they aren't caught.
    #[cfg(windows)]
    #[test]
    fn terminal_window_refuses_the_desktop_shell_and_survives_pid_reuse() {
        // A shell started from the Run box: no conhost, and explorer.exe owns a
        // real (File Explorer) window. Fronting it would be a wrong answer that
        // looks like a right one.
        let orphan = table(&[
            (300, Some(200), "claude.exe"),
            (200, Some(50), "powershell.exe"),
            (50, Some(1), "explorer.exe"),
        ]);
        assert_eq!(terminal_window_for(300, &orphan, &wins(&[(50, 0x1234, "Downloads")]), ""), None);

        // Pid reuse produces ppid cycles — this machine's own process table has
        // one. The walk must terminate instead of spinning.
        let cycle = table(&[(300, Some(10), "claude.exe"), (10, Some(20), "a.exe"), (20, Some(10), "b.exe")]);
        assert_eq!(terminal_window_for(300, &cycle, &[], ""), None);
    }

    /// One host process, one window per project — the live VS Code case, where
    /// Z-order alone sends every jump to the same window.
    #[cfg(windows)]
    #[test]
    fn pick_window_prefers_the_project_over_the_topmost() {
        let desktop = wins(&[
            (21388, 0x10, "Investigate CI - document_expert - Visual Studio Code"),
            (21388, 0x20, "Refactor head animation - fabraham - Visual Studio Code"),
            (76700, 0x30, "wirksam"),
        ]);
        assert_eq!(pick_window(21388, &desktop, "fabraham"), Some(0x20), "hint wins over Z-order");
        assert_eq!(pick_window(21388, &desktop, "document_expert"), Some(0x10));
        assert_eq!(pick_window(21388, &desktop, "some-other-repo"), Some(0x10), "no match → topmost");
        assert_eq!(pick_window(21388, &desktop, ""), Some(0x10), "no hint → topmost");
        assert_eq!(pick_window(76700, &desktop, "WIRKSAM"), Some(0x30), "matching is case-insensitive");
        assert_eq!(pick_window(999, &desktop, "fabraham"), None, "a hint must not cross processes");
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

