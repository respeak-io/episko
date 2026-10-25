// External (non-Episko) Claude Code sessions (docs/sessions.md), read from Claude's registry
// at `~/.claude/sessions/<pid>.json`. Ours are filtered out by pid, never by session id, which
// /resume and /clear rewrite. Listing is portable via `ProcTable`; only focusing is per OS.

use std::collections::{HashMap, HashSet};

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
    /// pid → start time (epoch secs); absent when the OS would not say
    started: std::collections::HashMap<u32, u64>,
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
        let started = sys
            .processes()
            .iter()
            .filter(|(_, p)| p.start_time() > 0)
            .map(|(pid, p)| (pid.as_u32(), p.start_time()))
            .collect();
        Self { procs, started }
    }

    /// `pid`'s parent, or None at the root. Windows keeps a dead parent's pid as the ppid, so a
    /// parent that started AFTER its child is a reused pid: an unrelated process, not an ancestor.
    fn parent(&self, pid: u32) -> Option<u32> {
        let ppid = self.procs.get(&pid)?.0?;
        if ppid <= 1 || ppid == pid {
            return None;
        }
        match (self.started.get(&pid), self.started.get(&ppid)) {
            (Some(child), Some(parent)) if parent > child => None,
            _ => Some(ppid),
        }
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
            match self.parent(cur) {
                Some(ppid) => cur = ppid,
                None => return false,
            }
        }
        false
    }
}

// ---------- which ports our sessions are actually listening on ----------

// camelCase: the frontend reads `sessionId`; snake_case filed every port under `undefined`.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionPort {
    session_id: String, // the pane whose PTY child this socket descends from
    port: u16,
    pid: u32, // the leaf holding the socket, several hops below the pane
    name: String, // that leaf's name (node.exe), not what the user or agent ran
    orphan: bool, // its pane is gone: attributed from `AppState.seen_ports`, not ancestry
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
/// the only one that sees a server nobody announced. A listener whose pane has since exited
/// is kept as an orphan only if a poll saw it under that pane first (`AppState.seen_ports`),
/// since ancestry dies with the pane. Spawn-free on every OS, because it is polled.
fn session_ports(state: &AppState, roster: &[(String, u32)], table: &ProcTable) -> Vec<SessionPort> {
    let mut seen = state.seen_ports.lock().unwrap();
    // With no panes and nothing remembered the whole scan is skipped.
    if roster.is_empty() && seen.is_empty() {
        return Vec::new();
    }
    let Ok(all) = listeners::get_all() else { return Vec::new() };
    let mut found = Vec::new();
    for l in all {
        // Listening TCP only: SSDP, NetBIOS and mDNS are UDP and would read as dev servers.
        if l.protocol != listeners::Protocol::TCP || l.state != listeners::SocketState::Listen {
            continue;
        }
        let key = (l.process.pid, l.socket.port());
        let owner = roster
            .iter()
            .find(|(_, root)| table.is_descendant_of(l.process.pid, *root))
            .map(|(id, _)| (id.clone(), false))
            .or_else(|| seen.get(&key).map(|id| (id.clone(), true)));
        let Some((id, orphan)) = owner else { continue };
        found.push(SessionPort { session_id: id, port: key.1, pid: key.0, name: l.process.name.clone(), orphan });
    }
    // Forget a closed listener at once, so a reused pid can never inherit a dead pane's port.
    seen.clear();
    for p in &found {
        seen.insert((p.pid, p.port), p.session_id.clone());
    }
    dedupe_ports(found)
}

fn pane_roots(state: &AppState) -> Vec<(String, u32)> {
    state.sessions.lock().unwrap().iter().filter_map(|(id, s)| s.pid.map(|p| (id.clone(), p))).collect()
}

/// Kill the process listening on `port` and its descendants; true once the port is free.
/// Refused unless `pid` holds that port right now AND is ours (under a live pane, or an
/// orphan `session_ports` saw under one), so a stale row cannot kill a pid that was reused.
#[tauri::command]
pub(crate) async fn kill_listener(state: State<'_, AppState>, pid: u32, port: u16) -> Result<bool, String> {
    let holds = |pid: u32, port: u16| {
        listeners::get_all().is_ok_and(|all| {
            all.iter().any(|l| {
                l.protocol == listeners::Protocol::TCP
                    && l.state == listeners::SocketState::Listen
                    && l.process.pid == pid
                    && l.socket.port() == port
            })
        })
    };
    if !holds(pid, port) {
        return Err(format!("nothing with pid {pid} is listening on port {port} any more"));
    }
    let roster = pane_roots(&state);
    let table = ProcTable::snapshot();
    let ours = roster.iter().any(|(_, root)| table.is_descendant_of(pid, *root))
        || state.seen_ports.lock().unwrap().contains_key(&(pid, port));
    if !ours {
        return Err(format!("pid {pid} was not started from an Episko pane"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::platform::kill_pid_tree(pid) {
            return Err(format!("could not kill pid {pid}"));
        }
        // taskkill and kill -9 return before the socket closes; give it a moment.
        for _ in 0..15 {
            if !holds(pid, port) {
                return Ok(true);
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Ok(false)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- processes a pane left behind ----------

/// A process once seen under a pane. The start time is what tells it from a later process
/// that reused its pid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SeenProc {
    session_id: String,
    started: u64,
}

/// A process tree still running after it lost its pane: the pane closed, or the parent
/// that tied it to one died (Windows never kills a child with its parent). `session_id` is
/// None for one no poll saw under a pane, found by its folder instead (`root`).
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LeftBehind {
    pid: u32, // the top of the tree; killing it with its descendants ends the lot
    started: u64,
    session_id: Option<String>,
    root: Option<String>,
    procs: Vec<ProcInfo>,
}

/// Everything running under one live pane, its own root process left out. `started` is the
/// root's, so the frontend can tell what the agent launched with itself from what came later.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaneProcs {
    session_id: String,
    started: u64,
    procs: Vec<ProcInfo>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcInfo {
    pid: u32,
    ppid: Option<u32>,
    started: u64,
    name: String,
    cmd: Vec<String>,
    cwd: String,
    mem: u64, // bytes resident
}

/// Runtimes a stray dev process is made of. Only these are matched by folder, since an
/// editor's own processes carry the project path too and must never be accused.
const RUNTIMES: &[&str] = &[
    "node", "bun", "deno", "python", "python3", "pythonw", "ruby", "java", "dotnet", "cargo", "go", "php", "esbuild",
];

fn is_runtime(name: &str) -> bool {
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    RUNTIMES.contains(&stem)
}

impl ProcTable {
    /// The pane a process currently runs under, never the pane's own root process.
    fn pane_of<'a>(&self, pid: u32, roster: &'a [(String, u32)]) -> Option<&'a str> {
        roster
            .iter()
            .find(|(_, root)| pid != *root && self.is_descendant_of(pid, *root))
            .map(|(id, _)| id.as_str())
    }

    /// Lost its parent: the recorded ppid is dead or reused, or (POSIX) init adopted it.
    fn orphaned(&self, pid: u32) -> bool {
        match self.procs.get(&pid).and_then(|p| p.0) {
            Some(ppid) if ppid <= 1 => cfg!(not(windows)),
            Some(_) => self.parent(pid).is_none_or(|pp| !self.procs.contains_key(&pp)),
            None => false,
        }
    }

    fn subtree(&self, top: u32) -> Vec<u32> {
        let mut out: Vec<u32> = self.procs.keys().copied().filter(|&p| self.is_descendant_of(p, top)).collect();
        out.sort_unstable();
        out
    }
}

/// Records every process now under a pane, forgets the ones that exited (or whose pid was
/// reused), and returns the tops of the recorded trees no live pane holds any more.
fn track_left(table: &ProcTable, roster: &[(String, u32)], seen: &mut HashMap<u32, SeenProc>) -> Vec<u32> {
    let started = |pid: u32| table.started.get(&pid).copied().unwrap_or(0);
    for &pid in table.procs.keys() {
        if let Some(id) = table.pane_of(pid, roster) {
            seen.insert(pid, SeenProc { session_id: id.to_string(), started: started(pid) });
        }
    }
    seen.retain(|&pid, s| table.procs.contains_key(&pid) && started(pid) == s.started);
    let left: HashSet<u32> = seen.keys().copied().filter(|&p| table.pane_of(p, roster).is_none()).collect();
    let mut tops: Vec<u32> =
        left.iter().copied().filter(|&p| table.parent(p).is_none_or(|pp| !left.contains(&pp))).collect();
    tops.sort_unstable();
    tops
}

/// The servers popover's one poll (docs/stack.md): the ports panes listen on, what each pane
/// runs, and what panes left running, all off one process snapshot. `async` keeps its ~100ms
/// on Windows off the main thread, which is the one that moves and paints the window.
#[derive(serde::Serialize)]
pub(crate) struct ProcPoll {
    ports: Vec<SessionPort>,
    panes: Vec<PaneProcs>,
    left: Vec<LeftBehind>,
}

#[tauri::command(async)]
pub(crate) fn process_poll(state: State<AppState>, roots: Vec<String>) -> ProcPoll {
    let roster = pane_roots(&state);
    let table = ProcTable::snapshot();
    let ports = session_ports(&state, &roster, &table);
    let (panes, left) = pane_procs(&state, &roster, &table, &roots);
    ProcPoll { ports, panes, left }
}

/// What each pane runs, and what panes have left running. A left-behind tree comes from two
/// sources: one a poll saw under a pane, and a runtime whose parent is gone and whose command or
/// cwd lies in one of `roots`, which catches a stray from before this run or another terminal.
fn pane_procs(
    state: &AppState,
    roster: &[(String, u32)],
    table: &ProcTable,
    roots: &[String],
) -> (Vec<PaneProcs>, Vec<LeftBehind>) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let us = std::process::id();
    let started = |pid: u32| table.started.get(&pid).copied().unwrap_or(0);
    let mut seen = state.seen_procs.lock().unwrap();
    let mut groups: Vec<(u32, Option<String>)> =
        track_left(table, roster, &mut seen).into_iter().map(|p| (p, Some(seen[&p].session_id.clone()))).collect();
    drop(seen);
    let candidates: Vec<u32> = table
        .procs
        .iter()
        .filter(|(pid, (_, name))| {
            is_runtime(name) && table.orphaned(**pid) && !groups.iter().any(|(t, _)| t == *pid)
        })
        .map(|(pid, _)| *pid)
        .filter(|&pid| pid != us && !table.is_descendant_of(pid, us))
        .collect();
    let live: Vec<(&str, u32, Vec<u32>)> = roster
        .iter()
        .map(|(id, root)| (id.as_str(), *root, table.subtree(*root).into_iter().filter(|p| p != root).collect()))
        .collect();
    let wanted: Vec<Pid> = groups
        .iter()
        .flat_map(|(t, _)| table.subtree(*t))
        .chain(candidates.iter().flat_map(|c| table.subtree(*c)))
        .chain(live.iter().flat_map(|(_, _, pids)| pids.iter().copied()))
        .map(Pid::from_u32)
        .collect();
    if wanted.is_empty() {
        state.proc_last.lock().unwrap().clear();
        return (Vec::new(), Vec::new());
    }
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&wanted),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always).with_cwd(UpdateKind::Always).with_memory(),
    );
    let detail = |pid: u32| -> Option<ProcInfo> {
        let p = sys.process(Pid::from_u32(pid))?;
        Some(ProcInfo {
            pid,
            ppid: table.procs.get(&pid).and_then(|x| x.0),
            started: started(pid),
            name: p.name().to_string_lossy().to_string(),
            cmd: p.cmd().iter().map(|a| a.to_string_lossy().to_string()).collect(),
            cwd: p.cwd().map(|c| norm_path(&c.to_string_lossy())).unwrap_or_default(),
            mem: p.memory(),
        })
    };
    let roots: Vec<std::path::PathBuf> = roots.iter().filter(|r| !r.is_empty()).map(|r| norm_path(r).into()).collect();
    let root_of = |lp: &ProcInfo| {
        let hit = |s: &str| roots.iter().find(|r| crate::platform::under(std::path::Path::new(s), r));
        hit(&lp.cwd).or_else(|| lp.cmd.iter().find_map(|a| hit(a))).map(|r| r.to_string_lossy().to_string())
    };
    for &c in &candidates {
        if detail(c).as_ref().and_then(root_of).is_some() {
            groups.push((c, None));
        }
    }
    let left: Vec<LeftBehind> = groups
        .into_iter()
        .filter_map(|(top, session_id)| {
            let procs: Vec<ProcInfo> = table.subtree(top).into_iter().filter_map(detail).collect();
            if procs.is_empty() {
                return None; // exited between the snapshot and the detail read
            }
            let root = procs.iter().find_map(root_of);
            Some(LeftBehind { pid: top, started: started(top), session_id, root, procs })
        })
        .collect();
    let panes: Vec<PaneProcs> = live
        .into_iter()
        .map(|(id, root, pids)| PaneProcs {
            session_id: id.to_string(),
            started: started(root),
            procs: pids.into_iter().filter_map(detail).collect(),
        })
        .filter(|p| !p.procs.is_empty())
        .collect();
    let reported = panes.iter().flat_map(|p| &p.procs).chain(left.iter().flat_map(|g| &g.procs));
    *state.proc_last.lock().unwrap() = reported.map(|p| (p.pid, p.started)).collect();
    (panes, left)
}

/// Kill a process `process_poll` reported, and everything under it. Refused unless the last
/// poll reported this very pid with this start time, so a stale row cannot kill a reused pid;
/// a pane's own root is never reported, so its ✕ stays the only way to end a pane.
#[tauri::command]
pub(crate) async fn kill_proc_tree(state: State<'_, AppState>, pid: u32, started: u64) -> Result<bool, String> {
    if state.proc_last.lock().unwrap().get(&pid) != Some(&started) {
        return Err(format!("pid {pid} is no longer one Episko is showing"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let table = ProcTable::snapshot();
        if table.started.get(&pid).copied().unwrap_or(0) != started {
            return Err(format!("pid {pid} has already exited"));
        }
        // POSIX `kill -pid` only reaches a group leader's group, so every member is named too.
        let tree = table.subtree(pid);
        crate::platform::kill_pid_tree(pid);
        for p in tree.iter().filter(|&&p| p != pid) {
            crate::platform::kill_pid_tree(*p);
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        let after = ProcTable::snapshot();
        Ok(tree.iter().all(|p| after.started.get(p) != table.started.get(p) || !after.procs.contains_key(p)))
    })
    .await
    .map_err(|e| e.to_string())?
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
        let ppid = table.parent(cur)?;
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
            started: Default::default(),
        }
    }

    /// (pid, ppid, start time): `parent` refuses a parent that started after its child.
    fn timed(entries: &[(u32, Option<u32>, u64)]) -> ProcTable {
        ProcTable {
            procs: entries.iter().map(|&(pid, ppid, _)| (pid, (ppid, "node.exe".to_string()))).collect(),
            started: entries.iter().map(|&(pid, _, t)| (pid, t)).collect(),
        }
    }

    fn pane(id: &str, root: u32) -> Vec<(String, u32)> {
        vec![(id.to_string(), root)]
    }

    /// The shape that leaked nine `vite build --watch` on Windows: an agent's dev script
    /// died, its watcher grandchild did not, and the pane above it is still open.
    #[test]
    fn a_watcher_whose_parent_died_is_left_behind_under_a_live_pane() {
        let mut seen = HashMap::new();
        // pane 10 > sh 11 > dev.mjs 12 > cmd 13 > vite 14
        let all = timed(&[(10, None, 1), (11, Some(10), 2), (12, Some(11), 3), (13, Some(12), 4), (14, Some(13), 5)]);
        assert!(track_left(&all, &pane("a", 10), &mut seen).is_empty(), "everything still hangs off the pane");
        assert_eq!(seen.len(), 4, "the pane's root is never recorded, every process below it is");
        let after = timed(&[(10, None, 1), (11, Some(10), 2), (14, Some(13), 5)]);
        assert_eq!(track_left(&after, &pane("a", 10), &mut seen), vec![14]);
        assert_eq!(seen[&14].session_id, "a");
    }

    /// A closed pane leaves one tree, reported once at its top rather than once per process.
    #[test]
    fn a_closed_pane_reports_the_top_of_its_tree_only() {
        let mut seen = HashMap::new();
        let all = timed(&[(10, None, 1), (11, Some(10), 2), (12, Some(11), 3), (13, Some(12), 4)]);
        track_left(&all, &pane("a", 10), &mut seen);
        let gone = timed(&[(11, Some(10), 2), (12, Some(11), 3), (13, Some(12), 4)]);
        assert_eq!(track_left(&gone, &[], &mut seen), vec![11]);
    }

    /// A pid reused by an unrelated process must never inherit the pane of the one before.
    #[test]
    fn a_reused_pid_is_forgotten_not_reported() {
        let mut seen = HashMap::new();
        track_left(&timed(&[(10, None, 1), (11, Some(10), 2)]), &pane("a", 10), &mut seen);
        assert!(track_left(&timed(&[(11, Some(900), 50)]), &[], &mut seen).is_empty());
        assert!(seen.is_empty());
    }

    /// Only what a poll saw under a pane is tracked: an orphan nobody saw is not ours to name.
    #[test]
    fn a_process_never_seen_under_a_pane_is_not_tracked() {
        let mut seen = HashMap::new();
        assert!(track_left(&timed(&[(40, Some(39), 5)]), &pane("a", 10), &mut seen).is_empty());
    }

    #[test]
    fn orphaned_means_a_dead_or_reused_parent() {
        let t = timed(&[(1000, None, 1), (20, Some(1000), 5), (21, Some(77), 5), (22, Some(23), 5), (23, None, 9)]);
        assert!(!t.orphaned(20), "live parent");
        assert!(t.orphaned(21), "parent pid is gone");
        assert!(t.orphaned(22), "parent pid now belongs to a process younger than its child");
        assert!(!t.orphaned(1000), "no recorded parent at all is a root, not an orphan");
    }

    #[test]
    fn only_runtimes_are_matched_by_folder() {
        for n in ["node.exe", "node", "python3", "bun.exe"] {
            assert!(is_runtime(n), "{n}");
        }
        for n in ["code.exe", "explorer.exe", "nodemon-helper", "pwsh.exe"] {
            assert!(!is_runtime(n), "{n}");
        }
    }

    /// The real leak on real processes: `cmd` starts a background child and exits, and the
    /// child runs on, its ppid naming a dead process. Windows only, which is where it leaks.
    #[cfg(windows)]
    #[test]
    fn a_real_grandchild_outliving_its_parent_is_found() {
        let mut cmd = std::process::Command::new("cmd")
            .args(["/c", "start /b ping -n 20 127.0.0.1 >nul & ping -n 5 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        let root = cmd.id();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let mut seen = HashMap::new();
        assert!(track_left(&ProcTable::snapshot(), &pane("a", root), &mut seen).is_empty());
        assert!(seen.len() >= 2, "both pings were seen under the pane: {seen:?}");
        cmd.wait().unwrap();
        let t = ProcTable::snapshot();
        let tops = track_left(&t, &[], &mut seen);
        for p in &tops {
            crate::platform::kill_pid_tree(*p);
        }
        assert_eq!(tops.len(), 1, "only the backgrounded ping outlived cmd: {tops:?}");
        assert!(t.procs[&tops[0]].1.starts_with("ping"));
        assert!(t.orphaned(tops[0]), "its parent is gone");
    }

    fn sp(session: &str, port: u16, pid: u32) -> SessionPort {
        SessionPort { session_id: session.into(), port, pid, name: "node.exe".into(), orphan: false }
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

    /// A vite started on the 18th sat under a pane launched on the 21st: its dead parent's pid
    /// had gone to that pane's MCP launcher, so a gh watcher adopted vite's port as its URL.
    #[test]
    fn proc_table_ancestry_rejects_a_parent_younger_than_its_child() {
        let mut t = table(&[(74328, Some(27252), "node.exe"), (27252, Some(55464), "sh.exe"),
            (55464, Some(89368), "cmd.exe"), (89368, Some(83984), "claude.exe")]);
        t.started = [(74328, 100), (27252, 100), (55464, 900), (89368, 895)].into_iter().collect();
        assert!(!t.is_descendant_of(74328, 89368), "a reused pid is not an ancestor");
        assert!(t.is_descendant_of(55464, 89368));
        t.started.remove(&55464); // an unknown start time proves nothing either way
        assert!(t.is_descendant_of(74328, 89368));
    }

    #[test]
    fn proc_table_snapshot_sees_this_process() {
        let t = ProcTable::snapshot();
        let me = std::process::id();
        assert!(t.procs.contains_key(&me), "own pid missing from process snapshot");
        assert!(t.started.contains_key(&me), "no start time without a refresh kind asking for one");
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

