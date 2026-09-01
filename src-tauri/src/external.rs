// External (non-Episko) Claude Code sessions (docs/sessions.md), read from Claude's registry
// at `~/.claude/sessions/<pid>.json`. Ours are filtered out by pid, never by session id, which
// /resume and /clear rewrite. Listing is portable via `ProcTable`; only focusing is per OS.

use tauri::State;

// Only the macOS focus path uses `ps_one`; an unconditional import is unused on Windows.
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
    repo_root: Option<String>, // main worktree root, what the sidebar groups by; None outside a repo
    branch: Option<String>, // None when detached or not a repo
}

/// A snapshot of the process table (pid → parent + name) via `sysinfo`: no `ps` child, and
/// only the bare list is refreshed, since the frontend polls this every ~3s.
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

    /// Guards stale registry files and pid reuse. Loose match: `claude`, `claude.exe`,
    /// and a self-update's `claude.exe.old.<ts>`.
    fn is_live_claude(&self, pid: u32) -> bool {
        self.procs.get(&pid).is_some_and(|(_, name)| name.contains("claude"))
    }

    /// Walks the ppid chain. The cap also bounds the ppid cycles Windows produces after pid reuse.
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

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub(crate) struct SessionPort {
    session_id: String, // the pane whose PTY child this socket descends from
    port: u16,
    pid: u32, // the leaf holding the socket, several hops below the pane
    name: String, // that leaf's name (node.exe), not what the user or agent ran
}

/// One row per (session, port): a server bound "everywhere" is several listeners (`0.0.0.0`,
/// `[::]`, `127.0.0.1`, a LAN address). Lowest pid wins so the row is stable across polls.
fn dedupe_ports(mut found: Vec<SessionPort>) -> Vec<SessionPort> {
    found.sort_by(|a, b| {
        (a.session_id.as_str(), a.port, a.pid).cmp(&(b.session_id.as_str(), b.port, b.pid))
    });
    found.dedup_by(|a, b| a.session_id == b.session_id && a.port == b.port);
    found
}

/// Every TCP port listened on by a descendant of a pane's PTY child: the kernel's answer,
/// the only one that sees a server nobody announced. An orphan (chain broken by its
/// session's exit) is left out on purpose. Spawn-free on every OS, because it is polled.
#[tauri::command]
pub(crate) fn session_ports(state: State<AppState>) -> Vec<SessionPort> {
    // Roster first: with no panes open the whole scan is skipped.
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
        // Listening TCP only: SSDP, NetBIOS and mDNS are UDP and would read as dev servers.
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

/// None for a malformed file or a non-interactive entry (`claude -p`, SDK runs).
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

/// Sessions running outside Episko. `exclude` (ids we own) is belt-and-braces beside the
/// pid filter below; stale files are dropped by checking the pid is still a live `claude`.
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

    let table = ProcTable::snapshot();
    parsed.retain(|s| table.is_live_claude(s.pid));

    // `owned_pids` covers embedded PTYs; the ancestry walk catches a session launched into
    // a child terminal such as Ghostty. Never by session id: /resume and /clear rewrite it.
    let self_pid = std::process::id();
    let owned = state.owned_pids.lock().unwrap().clone();
    parsed.retain(|s| !owned.contains(&s.pid) && !table.is_descendant_of(s.pid, self_pid));

    // After the filters, so git never runs for a stale or owned pid.
    for s in parsed.iter_mut() {
        let (root, branch) = git_repo_info(&s.cwd);
        s.repo_root = root;
        s.branch = branch;
    }

    parsed.sort_by_key(|s| std::cmp::Reverse(s.status_updated_at.unwrap_or(0))); // most recently active first
    parsed
}

/// Walk up from `pid` to the first ancestor inside a `.app` bundle: (app_pid, exe path).
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

#[cfg(windows)]
struct Win {
    pid: u32,
    hwnd: isize,
    title: String,
}

/// Visible top-level windows in Z-order (front to back, so a pid's first entry is its most
/// recently fronted). Filtered like a taskbar button (visible, unowned, titled), or an app
/// also answers with its message-only and tool windows. `GetWindowTextW` reads a foreign
/// window's stored caption without `WM_GETTEXT`, so a wedged terminal cannot hang this.
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

/// Z-order's first window is the default, but one process can own a window per project
/// (VS Code), so `hint` (the project folder) is matched against the caption first. A hint
/// that matches nothing falls back to the topmost; it can never cross to another process.
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

/// Ancestors that are never "its terminal". `explorer.exe` is the one that matters: a shell
/// started from the Run box has it as parent, and fronting File Explorer is a wrong answer.
#[cfg(windows)]
const NOT_A_TERMINAL: [&str; 6] = [
    "explorer.exe",
    "services.exe",
    "svchost.exe",
    "wininit.exe",
    "winlogon.exe",
    "system",
];

/// Walk up from `pid` to its host terminal's window, with the desktop passed in as data.
/// Two shapes: the terminal is an ancestor (stop at the first one that owns a window, since
/// VS Code puts a windowless pty-host `Code.exe` in between), or the console host is a child
/// (`conhost.exe` is spawned by the shell), hence the per-level child scan. The cap bounds ppid cycles.
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

/// Window-level only: Windows has no tty to match a tab by. `SetForegroundWindow` works
/// because Episko is the foreground process at the click; when it is not, Windows refuses
/// silently, so the return value is checked. The hint is re-read from the registry file
/// rather than passed in, to keep the command's signature shared with the macOS half.
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
        // Raising a minimised window leaves it minimised, so restore first.
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd) == 0 {
            return Err("Windows wouldn't bring that terminal window forward".to_string());
        }
    }
    Ok(())
}

/// Exact tab focus for Terminal.app and iTerm2 (by tty); best-effort app activation otherwise.
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
        // Electron hosts run the shell under a helper absent from System Events' process
        // list (targeting it by unix id fails with -1719), so just open the .app bundle.
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

    /// A server bound "everywhere" appears once per address and must be one row, or the
    /// header counts one `pnpm dev` as four.
    #[test]
    fn dedupe_ports_collapses_one_server_to_one_row() {
        let got = dedupe_ports(vec![
            sp("a", 5555, 64828), sp("a", 5555, 64828), sp("a", 5555, 64828),
            sp("a", 8787, 81320),
        ]);
        assert_eq!(got.len(), 2, "one row per (session, port): {got:?}");
        assert_eq!(got.iter().map(|p| p.port).collect::<Vec<_>>(), vec![5555, 8787]);
    }

    /// Two worktrees each running a dev server: the same port in two panes is two servers.
    #[test]
    fn dedupe_ports_keeps_the_same_port_in_two_panes_apart() {
        let got = dedupe_ports(vec![sp("a", 5555, 1), sp("b", 5555, 2)]);
        assert_eq!(got.len(), 2, "sessions must not collapse into each other: {got:?}");
    }

    #[test]
    fn dedupe_ports_is_stable_across_enumeration_order() {
        let a = dedupe_ports(vec![sp("s", 3000, 900), sp("s", 3000, 100)]);
        let b = dedupe_ports(vec![sp("s", 3000, 100), sp("s", 3000, 900)]);
        assert_eq!(a, b);
        assert_eq!(a[0].pid, 100);
    }

    /// `listeners` has one implementation per OS, and a broken arm would empty the header's
    /// server list with every other test still green. Opening our own socket is the one
    /// assertion that is neither vacuous (well-formed rows) nor machine-dependent (at least one).
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
        let t = ProcTable::snapshot();
        let me = std::process::id();
        assert!(t.procs.contains_key(&me), "own pid missing from process snapshot");
        assert!(t.is_descendant_of(me, me));
    }

    #[cfg(windows)]
    fn wins(entries: &[(u32, isize, &str)]) -> Vec<Win> {
        entries.iter().map(|&(pid, hwnd, title)| Win { pid, hwnd, title: title.to_string() }).collect()
    }

    #[cfg(windows)]
    #[test]
    fn terminal_window_finds_the_host_in_every_shape() {
        let win = |pid: u32| wins(&[(pid, 0x1234, "a terminal")]);

        // VS Code: a windowless Code.exe pty host sits between the shell and the windowed one.
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

        // Classic conhost: the window's owner is a child of the shell, not an ancestor.
        let conhost = table(&[
            (300, Some(200), "claude.exe"),
            (200, Some(50), "powershell.exe"),
            (400, Some(200), "conhost.exe"),
            (50, Some(1), "explorer.exe"),
        ]);
        assert_eq!(terminal_window_for(300, &conhost, &win(400), ""), Some(0x1234));
    }

    #[cfg(windows)]
    #[test]
    fn terminal_window_refuses_the_desktop_shell_and_survives_pid_reuse() {
        // A shell from the Run box: no conhost, and explorer.exe owns a real File Explorer window.
        let orphan = table(&[
            (300, Some(200), "claude.exe"),
            (200, Some(50), "powershell.exe"),
            (50, Some(1), "explorer.exe"),
        ]);
        assert_eq!(terminal_window_for(300, &orphan, &wins(&[(50, 0x1234, "Downloads")]), ""), None);

        // A ppid cycle from pid reuse; the walk must terminate.
        let cycle = table(&[(300, Some(10), "claude.exe"), (10, Some(20), "a.exe"), (20, Some(10), "b.exe")]);
        assert_eq!(terminal_window_for(300, &cycle, &[], ""), None);
    }

    /// One host process, one window per project: VS Code.
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
        // A real registry file from Windows; the keys are identical on macOS.
        let win = r#"{"pid":41708,"sessionId":"20283E01-6874-4FBB-B696-C29A89F13CC6","cwd":"E:\\Programming\\Work\\Respeak\\episko","startedAt":1784613714619,"procStart":"639202177128968910","version":"2.1.216","peerProtocol":1,"kind":"interactive","entrypoint":"cli","name":"episko-15","nameSource":"derived","status":"busy","updatedAt":1784614124255,"statusUpdatedAt":1784614124255}"#;
        let s = parse_registry_entry(win).expect("interactive entry should parse");
        assert_eq!(s.pid, 41708);
        assert_eq!(s.cwd, r"E:\Programming\Work\Respeak\episko");
        assert_eq!(s.status, "busy");
        assert_eq!(s.status_updated_at, Some(1784614124255));

        assert!(parse_registry_entry(r#"{"pid":1,"sessionId":"x","kind":"print"}"#).is_none());
        assert!(parse_registry_entry(r#"{"sessionId":"x","kind":"interactive"}"#).is_none());
        assert!(parse_registry_entry("not json").is_none());
    }

}

