// The launch layer: everything that starts a session, wherever its terminal lives.
//
// CLAUDE.md's "four launch engines, one telemetry path" is this module. `spawn_claude`
// (embedded xterm.js pane), `spawn_ghostty` and `spawn_external_terminal`
// (Terminal.app / iTerm2) all write the same `--settings` file, so the cockpit's
// telemetry is identical whichever the user picked; `available_terminals` reports
// which are installed so the UI only offers working ones.
//
// The three PTY entry points share `stream_pty_session`, which starts the reader
// thread (base64 -> `pty-output`) and the reaper (`pty-exit`). What separates them:
//
// - `spawn_claude` is instrumented and registers its pid in `owned_pids`, so
//   `list_external_sessions` can exclude our own sessions BY PID — an id-based
//   exclude breaks the moment Claude rotates its session_id on /resume.
// - `spawn_shell` is a plain login shell: no Claude, no instrumentation.
// - `spawn_task` is deliberately un-instrumented too, and its pid never enters
//   `owned_pids`. `Exec::Shell` runs through a *login* shell so a task inherits the
//   PATH and version-manager shims the user's own terminal has.
//
// `--resume` and `--session-id` are mutually exclusive, so all three spawners branch
// either/or on `resume: Option<String>` while `--settings` stays keyed to our launch
// uuid — routing is unaffected by whatever id Claude ends up running under.
//
// The cfg-gated helpers here have a single consumer module, which is why they are
// here rather than in `platform.rs`: `apply_utf8_locale` (and it takes a
// `portable_pty::CommandBuilder`, which the leaf layer must not import),
// `interactive_shell`, `task_shell`, `find_ghostty`.

use std::io::{Read, Write};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(not(windows))]
use crate::platform::sh_quote;
use crate::platform::{augmented_path, ps_one, resolve_claude, sys_command};
use crate::tasks;
use crate::telemetry::write_instrument_settings;
use crate::{AppState, Session};

/// Force a UTF-8 locale on a PTY child. A macOS app launched from Finder inherits no
/// `LANG`, so the child falls back to the C/POSIX locale and mangles non-ASCII output
/// (UTF-8 rendered as Mac Roman — `ü`→`√º`, emoji shredded). Terminal.app/iTerm set a
/// UTF-8 locale on startup; mirror that. Preserve an already-UTF-8 `LANG` (e.g. Episko
/// launched from a terminal), else default one; and pin `LC_CTYPE` so an inherited
/// `LC_CTYPE=C` can't re-break the charset behind a good `LANG`.
#[cfg(windows)]
fn apply_utf8_locale(_cmd: &mut CommandBuilder) {
    // No-op on Windows: the C-locale charset mangling this guards against is a
    // POSIX/Finder concern. ConPTY + claude.exe handle console encoding themselves.
}

#[cfg(not(windows))]
fn apply_utf8_locale(cmd: &mut CommandBuilder) {
    let is_utf8 = |var: &str| {
        std::env::var(var)
            .map(|v| { let u = v.to_ascii_uppercase(); u.contains("UTF-8") || u.contains("UTF8") })
            .unwrap_or(false)
    };
    if !is_utf8("LANG") {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if !is_utf8("LC_CTYPE") {
        cmd.env("LC_CTYPE", "en_US.UTF-8");
    }
}

#[tauri::command]
pub(crate) fn spawn_claude(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    workdir: String,
    rows: u16,
    cols: u16,
    resume: Option<String>,
) -> Result<(), String> {
    let port = state.port;
    // A resume must land in the session's ORIGINAL cwd: Claude looks the id up in
    // `~/.claude/projects/<enc(cwd)>/`, so resuming from elsewhere fails with "no
    // conversation found". Creating the dir would silently produce that failure
    // against an empty project, so refuse up front with something actionable.
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let claude = resolve_claude();
    let mut cmd = CommandBuilder::new(&claude);
    // `--resume` and `--session-id` are mutually exclusive — resume adopts the
    // stored id and ignores ours — so this is either/or, never both. `--settings`
    // stays keyed to OUR launch uuid either way, so every hook still POSTs the
    // `X-CC-Session` header the frontend routes by, whatever id Claude runs under.
    match &resume {
        Some(prev) => {
            cmd.arg("--resume");
            cmd.arg(prev);
        }
        None => {
            cmd.arg("--session-id");
            cmd.arg(&session_id);
        }
    }
    cmd.arg("--settings");
    cmd.arg(&settings_path);
    cmd.cwd(&workdir);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("CC_LAUNCHER_SESSION", &session_id);
    apply_utf8_locale(&mut cmd);

    log::info!(
        "spawn claude · {session_id} · {workdir}{}",
        resume.as_deref().map(|r| format!(" · resume {r}")).unwrap_or_default()
    );
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    // Record the claude pid so we can recognise this session on disk even after
    // its id changes (e.g. the user runs /resume). Captured before `child` moves
    // into the reaper thread below.
    let child_pid = child.process_id();
    if let Some(p) = child_pid {
        state.owned_pids.lock().unwrap().insert(p);
    }

    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session { master: pair.master, writer, killer, pid: child_pid, workdir },
    );

    stream_pty_session(app, session_id, reader, child, child_pid);
    Ok(())
}

/// Spawn the reader (PTY output → `pty-output`) and reaper (`pty-exit` + session
/// cleanup) threads shared by every embedded PTY pane — a `claude` session or a
/// plain shell. `child_pid` is removed from `owned_pids` on exit (a no-op for a
/// shell, which was never inserted there).
fn stream_pty_session(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    child_pid: Option<u32>,
) {
    let app_out = app.clone();
    let sid_out = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = STANDARD.encode(&buf[..n]);
                    if app_out
                        .emit("pty-output", serde_json::json!({ "sessionId": sid_out, "data": encoded }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(0);
        log::info!("pty exit · {session_id} · code {code}");
        if let Some(st) = app.try_state::<AppState>() {
            st.sessions.lock().unwrap().remove(&session_id);
            if let Some(p) = child_pid {
                st.owned_pids.lock().unwrap().remove(&p);
            }
        }
        let _ = app.emit("pty-exit", serde_json::json!({ "sessionId": session_id, "code": code }));
    });
}

/// The interactive shell for a scratch terminal pane: `(program, args)`.
/// macOS/Linux: the user's `$SHELL` as a login shell. Windows: PowerShell 7
/// (`pwsh`) if installed, else Windows PowerShell, else `cmd.exe` — no login flag.
#[cfg(not(windows))]
fn interactive_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    (shell, vec!["-l".to_string()])
}

#[cfg(windows)]
fn interactive_shell() -> (String, Vec<String>) {
    let pwsh = r"C:\Program Files\PowerShell\7\pwsh.exe";
    if std::path::Path::new(pwsh).exists() {
        return (pwsh.to_string(), vec!["-NoLogo".to_string()]);
    }
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let powershell = format!(r"{sysroot}\System32\WindowsPowerShell\v1.0\powershell.exe");
    if std::path::Path::new(&powershell).exists() {
        return (powershell, vec!["-NoLogo".to_string()]);
    }
    (format!(r"{sysroot}\System32\cmd.exe"), vec![])
}

/// Open a plain login shell in an embedded PTY (no Claude, no instrumentation) — a
/// scratch terminal that lives in an Episko pane just like a session. Wired to the
/// same `pty-output` / `write_pty` / `pty-exit` path as `spawn_claude`.
#[tauri::command]
pub(crate) fn spawn_shell(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    workdir: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let (shell, shell_args) = interactive_shell();
    let mut cmd = CommandBuilder::new(&shell);
    for a in &shell_args {
        cmd.arg(a);
    }
    cmd.cwd(&workdir);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    apply_utf8_locale(&mut cmd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let child_pid = child.process_id();
    // Deliberately NOT added to owned_pids: a plain shell isn't a claude process
    // and never registers in ~/.claude/sessions, so it can't leak as "external".
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session { master: pair.master, writer, killer, pid: child_pid, workdir },
    );
    stream_pty_session(app, session_id, reader, child, child_pid);
    Ok(())
}

/// The login shell used to run a `Shell` task, as `(program, args)` — the args end
/// with the flag that takes the command string, so the caller just pushes the line.
/// A *login* shell (not `-c` alone) so tasks inherit the same PATH, nvm/mise shims
/// and aliases the user gets in their own terminal; a task that works in iTerm and
/// fails in Episko is the whole class of bug this avoids.
#[cfg(not(windows))]
fn task_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    (shell, vec!["-l".to_string(), "-c".to_string()])
}

#[cfg(windows)]
fn task_shell() -> (String, Vec<String>) {
    let (prog, mut args) = interactive_shell();
    if prog.to_ascii_lowercase().ends_with("cmd.exe") {
        args.push("/C".to_string());
    } else {
        args.push("-Command".to_string());
    }
    (prog, args)
}

/// Run a Runnable in an embedded PTY — the third kind of pane, after a `claude`
/// session and a plain shell. Deliberately *not* instrumented: a task gets no
/// `--settings` file, no telemetry, no cost, and its pid never enters `owned_pids`
/// (it isn't a `claude` process and can't masquerade as an external session).
///
/// The exit code is what the frontend turns into done / error, and it arrives over
/// the existing `pty-exit` event — no new channel.
#[tauri::command]
pub(crate) fn spawn_task(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    spec: tasks::TaskSpec,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let tasks::TaskSpec { exec, cwd: workdir, env } = spec;
    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("no such directory: {workdir}"));
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = match exec {
        tasks::Exec::Argv { program, args } => {
            if program.trim().is_empty() {
                return Err("task has no command".into());
            }
            let mut c = CommandBuilder::new(&program);
            for a in args {
                c.arg(a);
            }
            c
        }
        tasks::Exec::Shell { line } => {
            if line.trim().is_empty() {
                return Err("task has no command".into());
            }
            let (shell, shell_args) = task_shell();
            let mut c = CommandBuilder::new(&shell);
            for a in shell_args {
                c.arg(a);
            }
            c.arg(&line);
            c
        }
    };
    cmd.cwd(&workdir);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // The task's own env last, so a task can deliberately override any of the above.
    for (k, v) in env {
        cmd.env(k, v);
    }
    apply_utf8_locale(&mut cmd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let child_pid = child.process_id();
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session { master: pair.master, writer, killer, pid: child_pid, workdir },
    );
    stream_pty_session(app, session_id, reader, child, child_pid);
    Ok(())
}

/// No Ghostty engine on Windows — the embedded xterm.js pane is the only engine.
#[cfg(windows)]
fn find_ghostty() -> Option<String> {
    None
}

#[cfg(not(windows))]
fn find_ghostty() -> Option<String> {
    if let Ok(o) = sys_command("which").arg("ghostty").output() {
        if o.status.success() {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !p.is_empty() {
                return Some(p);
            }
        }
    }
    for c in [
        "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        "/opt/homebrew/bin/ghostty",
        "/usr/local/bin/ghostty",
    ] {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

/// Launch the instrumented `claude` session in an external Ghostty window,
/// tinted to the project's accent. Telemetry still flows via the hooks/statusline,
/// so the session appears in Episko's cockpit — just without an embedded terminal.
#[tauri::command]
pub(crate) fn spawn_ghostty(
    state: State<AppState>,
    session_id: String,
    workdir: String,
    accent: String,
    title: String,
    resume: Option<String>,
) -> Result<(), String> {
    let port = state.port;
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;
    let bin = find_ghostty()
        .ok_or_else(|| "Ghostty not found — install it or add `ghostty` to your PATH".to_string())?;

    let bg = accent.trim_start_matches('#').to_string();
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(format!("--background={bg}"));
    cmd.arg(format!("--title={title}"));
    cmd.arg(format!("--working-directory={workdir}"));
    cmd.arg("-e");
    cmd.arg(resolve_claude());
    // Either/or, never both — see the note in `spawn_claude`.
    match &resume {
        Some(prev) => {
            cmd.arg("--resume");
            cmd.arg(prev);
        }
        None => {
            cmd.arg("--session-id");
            cmd.arg(&session_id);
        }
    }
    cmd.arg("--settings");
    cmd.arg(&settings_path);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.spawn().map_err(|e| format!("launch Ghostty: {e}"))?;
    Ok(())
}

/// Which external terminals are installed, so the UI only offers ones that work.
/// (The embedded terminal is always available and isn't listed here.) Windows has
/// no external-terminal engine yet, so this is empty there and the UI falls back to
/// the embedded pane.
#[cfg(windows)]
#[tauri::command]
pub(crate) fn available_terminals() -> Vec<String> {
    Vec::new()
}

#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn available_terminals() -> Vec<String> {
    let mut v = Vec::new();
    if find_ghostty().is_some() {
        v.push("ghostty".to_string());
    }
    // Terminal.app ships with macOS.
    if std::path::Path::new("/System/Applications/Utilities/Terminal.app").exists()
        || std::path::Path::new("/Applications/Utilities/Terminal.app").exists()
    {
        v.push("terminal".to_string());
    }
    if std::path::Path::new("/Applications/iTerm.app").exists() {
        v.push("iterm".to_string());
    }
    v
}

/// No external-terminal engine on Windows yet — the frontend won't offer one (see
/// `available_terminals`), but guard the command so a stray call fails cleanly.
#[cfg(windows)]
#[tauri::command]
pub(crate) fn spawn_external_terminal(
    _session_id: String,
    _workdir: String,
    _engine: String,
    _title: String,
    _resume: Option<String>,
) -> Result<(), String> {
    Err("external terminals aren't supported on Windows yet — use the embedded terminal".to_string())
}

/// Launch an instrumented `claude` session in a generic external terminal app
/// (Terminal.app / iTerm2). We write an executable `.command` wrapper that sets
/// up PATH, cd's into the workdir and execs claude, then hand it to `open -a`.
/// Telemetry still flows via the per-session settings hooks, so the session shows
/// up in Episko's cockpit just like an embedded/Ghostty one.
#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn spawn_external_terminal(
    state: State<AppState>,
    session_id: String,
    workdir: String,
    engine: String,
    title: String,
    resume: Option<String>,
) -> Result<(), String> {
    let port = state.port;
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;
    let claude = resolve_claude();

    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join(format!("run-{session_id}.command"));

    // Either/or, never both — see the note in `spawn_claude`.
    let id_args = match &resume {
        Some(prev) => format!("--resume {}", sh_quote(prev)),
        None => format!("--session-id {}", sh_quote(&session_id)),
    };
    let body = format!(
        "#!/bin/zsh\n# Episko session: {title}\nexport PATH={path}\ncd {wd} || exit 1\nexec {claude} {id_args} --settings {settings}\n",
        title = title.replace(['\n', '\r'], " "),
        path = sh_quote(&augmented_path()),
        wd = sh_quote(&workdir),
        claude = sh_quote(&claude),
        settings = sh_quote(&settings_path),
    );
    std::fs::write(&script, body).map_err(|e| format!("write launcher: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }

    let app_name = match engine.as_str() {
        "iterm" => "iTerm",
        _ => "Terminal",
    };
    std::process::Command::new("open")
        .arg("-a")
        .arg(app_name)
        .arg(&script)
        .spawn()
        .map_err(|e| format!("open {app_name}: {e}"))?;
    Ok(())
}

/// Windows: pop a plain scratch terminal at `workdir` — Windows Terminal (`wt.exe`)
/// if installed, else a PowerShell window via `cmd /c start`. `engine` is ignored
/// (there's only the embedded engine on Windows).
#[cfg(windows)]
#[tauri::command]
pub(crate) fn open_terminal_here(workdir: String, _engine: String) -> Result<(), String> {
    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    // Windows Terminal opens a new tab/window rooted at a directory via `-d`.
    if sys_command("wt.exe").arg("-d").arg(&workdir).spawn().is_ok() {
        return Ok(());
    }
    // Fallback: `cmd /c start` spawns a *new console window* (a bare Command::spawn
    // of powershell from a GUI app gets no window). `-NoExit` keeps it open.
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let powershell = format!(r"{sysroot}\System32\WindowsPowerShell\v1.0\powershell.exe");
    std::process::Command::new(format!(r"{sysroot}\System32\cmd.exe"))
        .args(["/C", "start", "", &powershell, "-NoExit"])
        .current_dir(&workdir)
        .spawn()
        .map_err(|e| format!("open terminal: {e}"))?;
    Ok(())
}

/// Open a plain (non-Claude) shell in an external terminal at `workdir` — a quick
/// scratch terminal for running commands next to a session. There's no
/// instrumentation here: it's just a shell, so it does NOT appear in Episko's
/// cockpit. `engine` is a hint (the user's chosen launch engine); embedded has no
/// external window, so it falls back to Terminal.app.
#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn open_terminal_here(workdir: String, engine: String) -> Result<(), String> {
    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    // Ghostty opens its default shell in the given dir via a CLI flag.
    if engine == "ghostty" {
        if let Some(bin) = find_ghostty() {
            let mut cmd = std::process::Command::new(bin);
            cmd.arg(format!("--working-directory={workdir}"));
            for (k, v) in std::env::vars() {
                cmd.env(k, v);
            }
            cmd.env("PATH", augmented_path());
            cmd.spawn().map_err(|e| format!("launch Ghostty: {e}"))?;
            return Ok(());
        }
    }
    // Terminal.app / iTerm both open a new window at a directory passed to `open -a`.
    let app_name = if engine == "iterm" && std::path::Path::new("/Applications/iTerm.app").exists() {
        "iTerm"
    } else {
        "Terminal"
    };
    std::process::Command::new("open")
        .arg("-a")
        .arg(app_name)
        .arg(&workdir)
        .spawn()
        .map_err(|e| format!("open {app_name}: {e}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn write_pty(state: State<AppState>, session_id: String, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    if let Some(s) = map.get_mut(&session_id) {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn resize_pty(state: State<AppState>, session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    if let Some(s) = map.get(&session_id) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn kill_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    let killed = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(mut s) = killed {
        log::info!("kill session · {session_id}");
        let _ = s.killer.kill();
        if let Some(p) = s.pid {
            state.owned_pids.lock().unwrap().remove(&p);
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub(crate) struct Resources {
    /// %CPU as reported by `ps` (a decaying lifetime average on macOS, so it reads
    /// as a rough gauge, not an instantaneous sample).
    cpu: f32,
    /// Resident set size in MiB.
    mem_mb: f32,
}

/// Per-session CPU/RAM for the embedded-PTY `claude` process, looked up by the
/// session id's stored pid. Measures the `claude` process itself (not its whole
/// subtree) — enough for the inspector's "what's this costing my machine" readout.
/// None for external/shell sessions (no owned pid) or a process that has exited.
#[tauri::command(async)]
pub(crate) fn session_resources(state: State<AppState>, session_id: String) -> Option<Resources> {
    let pid = state.sessions.lock().unwrap().get(&session_id)?.pid?;
    let line = ps_one(pid, "%cpu=,rss=")?;
    let mut it = line.split_whitespace();
    let cpu: f32 = it.next()?.parse().ok()?;
    let rss_kb: f32 = it.next()?.parse().ok()?;
    Some(Resources { cpu, mem_mb: rss_kb / 1024.0 })
}

#[cfg(test)]
mod tests {
    use super::*;


    /// `spawn_task` hands `Exec::Shell` to a *login* shell so a task inherits the
    /// PATH and version-manager shims the user's own terminal has. That argument
    /// construction is the fragile part — `-l -c` vs `-lc` vs `/C` differs per
    /// shell, and getting it wrong fails only at runtime, in a PTY, where nothing
    /// else in this suite would notice. Exit codes matter as much as output: a
    /// run's exit code *is* its phase in the UI.
    #[test]
    fn login_shell_runs_a_command_and_reports_its_exit_code() {
        let (shell, args) = task_shell();
        let run = |line: &str| {
            std::process::Command::new(&shell)
                .args(&args)
                .arg(line)
                .output()
                .expect("login shell should be spawnable")
        };

        let ok = run("echo episko-task-ok");
        assert!(ok.status.success());
        assert_eq!(String::from_utf8_lossy(&ok.stdout).trim(), "episko-task-ok");

        // Non-zero must survive to the caller — the frontend turns it into `error`.
        let bad = run("exit 3");
        assert_eq!(bad.status.code(), Some(3));

        // Shell syntax has to actually reach a shell, not be treated as one argv.
        let piped = run("printf 'a\\nb\\n' | wc -l | tr -d ' '");
        assert_eq!(String::from_utf8_lossy(&piped.stdout).trim(), "2");
    }

}
