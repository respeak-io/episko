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
//   `owned_pids`. `Exec::Shell` runs through a *login* shell, but that is not what
//   gives a task the user's PATH — see `task_shell`. `Exec::Argv` goes through
//   `argv_command`, which on Windows is the difference between a package.json script
//   running and not running at all.
//
// `--resume` and `--session-id` are mutually exclusive, so all three spawners branch
// either/or on `resume: Option<String>` while `--settings` stays keyed to our launch
// uuid — routing is unaffected by whatever id Claude ends up running under.
//
// The cfg-gated helpers here have a single consumer module, which is why they are
// here rather than in `platform.rs`: `apply_utf8_locale` (and it takes a
// `portable_pty::CommandBuilder`, which the leaf layer must not import),
// `interactive_shell`, `task_shell`, `find_ghostty`.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(not(windows))]
use crate::platform::sh_quote;
use crate::platform::{augmented_path, resolve_claude, sys_command};
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

/// The permission mode a session starts in — `claude --permission-mode`, chosen in
/// Settings › Sessions and passed by every spawner. Two properties are load-bearing:
///
/// - **It maps to a `&'static str`; the caller's string never reaches a command
///   line.** Here that would only be one argv element, but `spawn_external_terminal`
///   writes its launch into a generated `.command` *shell script*, so the whitelist is
///   what keeps the one path with a shell in it honest. An unrecognised mode launches
///   standard rather than not at all — a new mode name in some future frontend must
///   not be able to make a session refuse to start.
/// - **The standard mode passes no flag.** Claude's ask-me-each-time behaviour is what
///   an absent `--permission-mode` already means, and its own `--help` doesn't list
///   `default` among the choices (only `manual`), so spelling it out would lean on an
///   undocumented alias to say what silence says.
fn permission_mode_arg(mode: Option<&str>) -> Option<&'static str> {
    match mode?.trim() {
        "plan" => Some("plan"),
        "acceptEdits" => Some("acceptEdits"),
        "auto" => Some("auto"),
        "dontAsk" => Some("dontAsk"),
        "bypassPermissions" => Some("bypassPermissions"),
        "" | "default" | "manual" => None,
        other => {
            log::warn!("ignoring unknown permission mode {other:?} — launching standard");
            None
        }
    }
}

// A `#[tauri::command]`'s parameter list *is* its wire format: the frontend calls it by
// naming each one, and every one here is a distinct fact about the launch. Bundling
// them into a struct to satisfy the lint would change that contract on both sides (and
// the round-trip the `Exec` test pins for `spawn_task`) while making the call site say
// strictly less.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) fn spawn_claude(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    workdir: String,
    rows: u16,
    cols: u16,
    resume: Option<String>,
    mode: Option<String>,
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
    let perm = permission_mode_arg(mode.as_deref());
    if let Some(m) = perm {
        cmd.arg("--permission-mode");
        cmd.arg(m);
    }
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
        "spawn claude · {session_id} · {workdir}{}{}",
        resume.as_deref().map(|r| format!(" · resume {r}")).unwrap_or_default(),
        perm.map(|m| format!(" · {m}")).unwrap_or_default()
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
///
/// A *login* shell, but **do not** rely on that for the user's PATH: it does not
/// deliver one. zsh — macOS's default — sources `~/.zshrc` only when *interactive*,
/// and `.zshrc` is where nvm, `PNPM_HOME` and Homebrew's `shellenv` are exported, so
/// `-l -c` sees none of them. That is exactly how a task running `pnpm tauri dev`
/// died with `command not found: pnpm` while the same line worked in iTerm.
///
/// What actually closes that gap is `platform::augmented_path`, which harvests the
/// PATH from an *interactive* login shell once per run and is applied to every task's
/// env in `spawn_task`. It stays out of here on purpose: an interactive shell prints
/// its rc noise, which is fine to parse out of a one-off probe and unacceptable
/// prepended to every task's pane.
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

/// Build the command for an `Exec::Argv` task. On Unix this is the obvious thing;
/// Windows needs a detour, which is why it exists at all.
#[cfg(not(windows))]
fn argv_command(program: &str, args: Vec<String>) -> CommandBuilder {
    let mut c = CommandBuilder::new(program);
    for a in args {
        c.arg(a);
    }
    c
}

/// Whether `CreateProcessW` can start this file on its own.
///
/// It can't start a *script*, and most of PATHEXT is scripts. portable-pty passes
/// the resolved program as `lpApplicationName`, so a `.cmd`/`.bat` — or the
/// extensionless `npm`/`yarn`/`pnpm` shell script Node's Windows installer ships
/// beside them — comes back as ERROR_BAD_EXE_FORMAT, not as a run. That is why
/// *every* `package.json` script failed to launch on Windows while the identical
/// task ran fine on macOS: the npm provider emits `Argv`, and on Windows `npm` is
/// never an executable.
///
/// Compiled on every platform, not `cfg(windows)`, for two reasons: the decision is
/// then checkable from a Mac (the other half, resolution, needs a real Windows PATH),
/// and CLAUDE.md's cfg-flip lint trick can reach it. Only the dead-code lint needs
/// silencing off Windows — the code itself is portable and wants type-checking there.
#[cfg_attr(not(windows), allow(dead_code))]
fn win_runs_directly(resolved: &str) -> bool {
    let l = resolved.to_ascii_lowercase();
    l.ends_with(".exe") || l.ends_with(".com")
}

/// Resolve a bare Windows program name the way `cmd.exe` would — PATHEXT across the
/// augmented PATH — and hand back the first hit.
///
/// Deliberately *unlike* portable-pty's own `search_path`, which takes an exact
/// extensionless match in preference to anything else: for `npm` that match is the
/// bash script, i.e. the one file that cannot be launched.
#[cfg(windows)]
fn win_resolve(program: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(program);
    // Already qualified — a path, or a name carrying its own extension. Trust it.
    if p.components().count() > 1 || p.extension().is_some() {
        return p.is_file().then(|| p.to_path_buf());
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    for dir in std::env::split_paths(&augmented_path()) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let cand = dir.join(format!("{program}{ext}"));
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

#[cfg(windows)]
fn argv_command(program: &str, args: Vec<String>) -> CommandBuilder {
    let direct = win_resolve(program).filter(|p| win_runs_directly(&p.to_string_lossy()));
    let mut c = match direct {
        // Spawn the resolved absolute path, not the bare name: it stops portable-pty
        // re-resolving it and preferring an extensionless sibling.
        Some(exe) => CommandBuilder::new(exe),
        // A `.cmd`/`.bat` shim, or nothing found. cmd.exe resolves PATHEXT itself and
        // can actually run a script. Not-found lands here on purpose too, so the
        // "'foo' is not recognized" line prints in the pane the user is watching
        // instead of surfacing as a spawn error with no context.
        None => {
            let mut c = CommandBuilder::new(
                std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
            );
            c.arg("/C");
            c.arg(program);
            c
        }
    };
    for a in args {
        c.arg(a);
    }
    c
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
            argv_command(&program, args)
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
    mode: Option<String>,
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
    if let Some(m) = permission_mode_arg(mode.as_deref()) {
        cmd.arg("--permission-mode");
        cmd.arg(m);
    }
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
    _mode: Option<String>,
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
    mode: Option<String>,
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
    // The one launch path that goes through a shell, so the whitelist in
    // `permission_mode_arg` is what makes interpolating this safe: it can only ever be
    // one of six literals, never anything the frontend sent.
    let mode_args = permission_mode_arg(mode.as_deref())
        .map(|m| format!(" --permission-mode {m}"))
        .unwrap_or_default();
    let body = format!(
        "#!/bin/zsh\n# Episko session: {title}\nexport PATH={path}\ncd {wd} || exit 1\nexec {claude} {id_args}{mode_args} --settings {settings}\n",
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

/// The session ids of every embedded PTY the backend currently holds — claude,
/// shell and task panes alike. The frontend's own map answers this in normal
/// operation; this command exists for the one state where the two disagree: a
/// webview reload empties the frontend map while every PTY here runs on (#47).
/// `dormantBusy`/`histBusy` consult it so such an orphan reads "running right
/// now" and Resume is refused — a second `--resume` against a transcript a live
/// process still owns silently interleaves both conversations into one file.
#[tauri::command]
pub(crate) fn live_session_ids(state: State<AppState>) -> Vec<String> {
    state.sessions.lock().unwrap().keys().cloned().collect()
}

#[derive(serde::Serialize)]
pub(crate) struct Resources {
    /// Bytes/second read from disk, averaged over the gap since the previous sample.
    read_bps: f64,
    /// Bytes/second written to disk, same window.
    write_bps: f64,
    /// Lifetime totals across every owned session, in MiB, including ones that have
    /// since exited — the "how much has Episko actually churned" number a rate alone
    /// can't tell you.
    read_mb: f64,
    written_mb: f64,
    /// False until some process has a previous reading to difference against, when the
    /// rates are 0 rather than measured. Lets the UI show "—" instead of a confident,
    /// wrong "0 B/s".
    primed: bool,
}

/// App-wide **disk I/O**: every embedded-PTY `claude` process Episko owns, summed into
/// one reading. Measures the `claude` processes themselves (not their subtrees), and
/// ignores external/shell/task sessions, which have no owned pid.
///
/// **Deliberately not per-session.** What a reader wants from this panel is "how hard is
/// Episko working the disk right now", and with several agents running, a figure for
/// whichever pane happens to be on screen answers a question nobody asked — worse, it
/// reads as the whole when it is a part. So it is account-wide in the same sense the
/// rate limits are: one number, shown identically on every session.
///
/// I/O rather than CPU/RAM because that is the resource a Claude session actually
/// spends: it reads your tree and writes files, and a runaway agent shows up as
/// sustained throughput long before it shows up as CPU. Read via `sysinfo` (macOS:
/// `proc_pid_rusage` → `ri_diskio_*`) rather than a `ps` child, because `ps` cannot
/// report I/O at all — and one refresh covering N pids is still a single call.
///
/// Rates are computed here from the **lifetime totals** and our own timestamp, not from
/// sysinfo's per-refresh deltas: those are relative to the last refresh of that
/// `System`, and we build a fresh one per call. Differencing totals ourselves makes the
/// window explicit and survives a missed or irregular poll.
///
/// Two things the summing makes subtle, and both are why this differences **per pid and
/// then adds the rates**, rather than differencing one summed total:
///
/// - A session that exits between polls shrinks the sum. Differencing the sum would read
///   that fall as a window with no I/O in it (`saturating_sub` → 0) and blank the rate
///   for every *other* running agent. Per-pid, its contribution simply stops.
/// - A session that *starts* between polls has no previous sample, so it contributes its
///   whole lifetime total as one window's worth. It therefore contributes 0 to the rate
///   until its second reading, exactly as a single session did before.
///
/// `primed` is true once at least one pid has a previous sample to difference against —
/// with nothing running, or on the very first poll, the rate is unknown rather than zero
/// and the UI says so.
///
/// The **totals** carry `io_retired`, the bytes of sessions that have since exited, so
/// closing a pane doesn't make the run's churn appear to go backwards.
#[tauri::command(async)]
pub(crate) fn all_sessions_resources(state: State<AppState>) -> Resources {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let pids: Vec<u32> = state
        .sessions
        .lock()
        .unwrap()
        .values()
        .filter_map(|s| s.pid)
        .collect();
    let spids: Vec<Pid> = pids.iter().map(|p| Pid::from_u32(*p)).collect();

    let mut sys = System::new();
    if !spids.is_empty() {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&spids),
            true,
            ProcessRefreshKind::nothing().with_disk_usage(),
        );
    }

    let readings: Vec<(u32, u64, u64)> = pids
        .iter()
        .zip(spids.iter())
        .filter_map(|(pid, spid)| {
            let usage = sys.process(*spid)?.disk_usage();
            Some((*pid, usage.total_read_bytes, usage.total_written_bytes))
        })
        .collect();

    let now = std::time::Instant::now();
    let mut samples = state.io_samples.lock().unwrap();
    let mut retired = state.io_retired.lock().unwrap();
    retire_missing(
        &mut samples,
        &state.owned_pids.lock().unwrap(),
        &mut retired,
    );
    let folded = fold_io(&readings, &mut samples, now);

    const MIB: f64 = 1024.0 * 1024.0;
    Resources {
        read_bps: folded.read_bps,
        write_bps: folded.write_bps,
        read_mb: folded.read.saturating_add(retired.0) as f64 / MIB,
        written_mb: folded.written.saturating_add(retired.1) as f64 / MIB,
        primed: folded.primed,
    }
}

/// Move the bytes of pids we no longer own out of `samples` and into `retired`.
///
/// Both halves matter: dropping the entries stops a long-lived app accumulating one per
/// session it has ever run, and banking their bytes first is what stops the app-wide
/// total falling when a pane closes.
fn retire_missing(
    samples: &mut HashMap<u32, (u64, u64, std::time::Instant)>,
    owned: &HashSet<u32>,
    retired: &mut (u64, u64),
) {
    samples.retain(|p, (r, w, _)| {
        let keep = owned.contains(p);
        if !keep {
            retired.0 = retired.0.saturating_add(*r);
            retired.1 = retired.1.saturating_add(*w);
        }
        keep
    });
}

struct Folded {
    read_bps: f64,
    write_bps: f64,
    read: u64,
    written: u64,
    primed: bool,
}

/// The arithmetic half of `all_sessions_resources`, split out because it is the part
/// with the decisions in it and the only part testable without a running app.
///
/// Differences **per pid and then sums the rates**, rather than differencing one summed
/// total, so that a session exiting between polls simply stops contributing instead of
/// making the sum fall — which, differenced, would read as a window with no I/O in it
/// and blank the rate for every other running agent.
fn fold_io(
    readings: &[(u32, u64, u64)],
    samples: &mut HashMap<u32, (u64, u64, std::time::Instant)>,
    now: std::time::Instant,
) -> Folded {
    let mut f = Folded { read_bps: 0.0, write_bps: 0.0, read: 0, written: 0, primed: false };
    for &(pid, r, w) in readings {
        f.read = f.read.saturating_add(r);
        f.written = f.written.saturating_add(w);
        // saturating_sub: the counters are monotonic, but a pid reused after an exit we
        // missed would otherwise underflow into a nonsense spike.
        if let Some((pr, pw, pt)) = samples.insert(pid, (r, w, now)) {
            let secs = now.duration_since(pt).as_secs_f64();
            if secs > 0.0 {
                f.read_bps += r.saturating_sub(pr) as f64 / secs;
                f.write_bps += w.saturating_sub(pw) as f64 / secs;
                f.primed = true;
            }
        }
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole reason `fold_io` differences per pid instead of over one summed total.
    ///
    /// Two agents are running; between polls one exits. Its lifetime bytes leave the
    /// sum, so a summed-total difference would `saturating_sub` to zero and report "no
    /// I/O at all" for the window — blanking the rate of the agent that is still
    /// working. Per pid, the survivor's own 1 MiB/s is unaffected.
    #[test]
    fn a_session_exiting_does_not_zero_the_rate_of_the_ones_still_running() {
        let t0 = std::time::Instant::now();
        let t1 = t0 + std::time::Duration::from_secs(1);
        let mut samples = HashMap::new();
        // First poll: both agents seen, nothing to difference against yet.
        let first = fold_io(&[(10, 50_000_000, 0), (11, 1_000, 0)], &mut samples, t0);
        assert!(!first.primed, "no previous reading, so the rate is unknown, not zero");
        assert_eq!(first.read_bps, 0.0);

        // Second poll: pid 11 is gone; pid 10 read another MiB in one second.
        let second = fold_io(&[(10, 50_000_000 + 1024 * 1024, 0)], &mut samples, t1);
        assert!(second.primed);
        assert!(
            (second.read_bps - 1024.0 * 1024.0).abs() < 1.0,
            "the surviving agent's rate must be its own, not diluted by the one that left \
             (got {})",
            second.read_bps
        );
    }

    /// Rates add across concurrent agents — the figure is "what is Episko doing to the
    /// disk", so two agents reading 1 MiB/s each is 2 MiB/s, not an average.
    #[test]
    fn concurrent_sessions_sum_their_rates_and_totals() {
        let t0 = std::time::Instant::now();
        let t1 = t0 + std::time::Duration::from_secs(1);
        let mut samples = HashMap::new();
        fold_io(&[(1, 0, 0), (2, 0, 0)], &mut samples, t0);
        let f = fold_io(&[(1, 1024 * 1024, 512), (2, 1024 * 1024, 512)], &mut samples, t1);
        assert!((f.read_bps - 2.0 * 1024.0 * 1024.0).abs() < 1.0, "got {}", f.read_bps);
        assert_eq!(f.read, 2 * 1024 * 1024, "lifetime totals add too");
        assert_eq!(f.written, 1024);
    }

    /// Closing a pane must not walk the run's churn backwards. The pid leaves
    /// `io_samples`, and its bytes have to land in `io_retired` on the way out or the
    /// app-wide total visibly drops.
    #[test]
    fn retiring_a_pid_banks_its_bytes_instead_of_losing_them() {
        let now = std::time::Instant::now();
        let mut samples = HashMap::from([
            (7u32, (900u64, 100u64, now)),
            (8u32, (5u64, 6u64, now)),
        ]);
        let owned = HashSet::from([8u32]);
        let mut retired = (0u64, 0u64);
        retire_missing(&mut samples, &owned, &mut retired);

        assert_eq!(retired, (900, 100), "the departed pid's bytes are kept");
        assert!(!samples.contains_key(&7), "but its sample entry is dropped");
        assert!(samples.contains_key(&8), "a still-owned pid is untouched");

        // And a second sweep must not double-count what it already banked.
        retire_missing(&mut samples, &owned, &mut retired);
        assert_eq!(retired, (900, 100), "already-retired bytes are not banked twice");
    }

    /// The inspector's I/O readout is only worth showing if the platform actually
    /// accounts for it. Per-process disk counters are easy to wire up and get back a
    /// permanent zero — `proc_pid_rusage` on macOS, `/proc/<pid>/io` on Linux, the IO
    /// counters on Windows all have their own preconditions — and a silently-zero
    /// counter renders as a confident, permanently-idle gauge rather than as a bug.
    /// This asserts the counter moves; the rate arithmetic on top is plain division.
    #[test]
    fn process_disk_usage_actually_counts_bytes() {
        use crate::testutil::scratch_dir;
        use std::io::Write;
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let me = Pid::from_u32(std::process::id());
        let sample = || {
            let mut sys = System::new();
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[me]),
                true,
                ProcessRefreshKind::nothing().with_disk_usage(),
            );
            sys.process(me).map(|p| p.disk_usage().total_written_bytes)
        };
        let before = sample().expect("our own process is visible to sysinfo");

        // fsync, so the bytes are charged to real disk I/O rather than sitting in the
        // page cache where the counter would never see them.
        let dir = scratch_dir();
        let mut f = std::fs::File::create(dir.join("blob")).unwrap();
        f.write_all(&vec![7u8; 8 * 1024 * 1024]).unwrap();
        f.sync_all().unwrap();
        drop(f);

        let after = sample().expect("still visible");
        assert!(
            after > before,
            "written-bytes counter must move after an 8 MiB fsync'd write (before={before}, after={after})"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    /// The Windows `Argv` shim decision, checkable from a Mac. Everything the npm
    /// provider emits — `npm`, `pnpm`, `yarn` — resolves on Windows to a script, and
    /// a script must be routed through cmd.exe rather than handed to CreateProcessW.
    /// A `.exe` must NOT be, because the cmd.exe detour would then have to survive
    /// cmd's quoting rules for no reason.
    #[test]
    fn windows_only_spawns_real_executables_directly() {
        for exe in ["node.exe", r"C:\Program Files\nodejs\node.exe", "PYTHON.EXE", "foo.com"] {
            assert!(win_runs_directly(exe), "{exe} is directly executable");
        }
        for script in [
            r"C:\Program Files\nodejs\npm.cmd",
            r"C:\Program Files\nodejs\npm",   // the extensionless bash script beside it
            r"C:\tools\build.bat",
            r"C:\tools\deploy.ps1",
        ] {
            assert!(!win_runs_directly(script), "{script} needs a shell");
        }
    }

    /// Every mode Settings offers, and nothing else. The whitelist is the security
    /// boundary for `spawn_external_terminal`, which interpolates this into a generated
    /// `.command` script — so what matters is not only that the six known spellings
    /// survive, but that everything else collapses to "no flag" instead of reaching a
    /// shell. The standard mode passing no flag is the other half: an absent
    /// `--permission-mode` is what ask-me-each-time already means.
    #[test]
    fn permission_mode_is_whitelisted_and_the_standard_mode_passes_no_flag() {
        for m in ["plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"] {
            assert_eq!(permission_mode_arg(Some(m)), Some(m), "{m} should reach the command line");
        }
        // The standard mode is spelled by silence, whichever name it arrives under.
        assert_eq!(permission_mode_arg(None), None);
        assert_eq!(permission_mode_arg(Some("default")), None);
        assert_eq!(permission_mode_arg(Some("manual")), None);
        assert_eq!(permission_mode_arg(Some("")), None);
        assert_eq!(permission_mode_arg(Some("  ")), None);
        // Case matters: these are Claude Code's own spellings, and a near-miss must not
        // be quietly "corrected" into a mode the user didn't pick.
        assert_eq!(permission_mode_arg(Some("acceptedits")), None);
        assert_eq!(permission_mode_arg(Some("PLAN")), None);
        // Nothing that could do something in a shell script gets through.
        for hostile in ["plan; rm -rf /", "plan --dangerously-skip-permissions", "$(id)", "plan\nrm x"] {
            assert_eq!(permission_mode_arg(Some(hostile)), None, "{hostile:?} must not reach a command line");
        }
    }

    /// The mode names are an external contract, exactly like the hook schema the
    /// `#[ignore]`d test in telemetry.rs guards: they go on Claude Code's command line
    /// verbatim, and Claude Code validates them against its own choice list — a mode
    /// renamed or dropped upstream turns every launch in that mode into an instant
    /// "option argument is invalid" and a pane that dies before it starts.
    ///
    /// Unlike that test this one costs **no tokens and needs no auth**: `--version`
    /// short-circuits before any API call, while commander still validates the choice
    /// first. It is `#[ignore]`d only because it needs the real binary, which CI hasn't
    /// got — so it belongs to the release checklist. It also asserts the negative case,
    /// because a build that stopped validating modes at all would otherwise pass.
    #[test]
    #[ignore = "runs the real `claude` binary (no tokens, no auth) — `cargo test -- --ignored`"]
    fn claude_cli_still_accepts_every_permission_mode_we_offer() {
        let claude = resolve_claude();
        let try_mode = |m: &str| {
            std::process::Command::new(&claude)
                .arg("--permission-mode")
                .arg(m)
                .arg("--version")
                .env("PATH", augmented_path())
                .output()
                .unwrap_or_else(|e| panic!("could not run `claude` at {claude:?}: {e}\n\
                     This test needs Claude Code installed and on PATH."))
        };

        for m in ["plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"] {
            let out = try_mode(m);
            assert!(
                out.status.success(),
                "`claude --permission-mode {m}` was rejected ({}). Settings offers this \
                 mode, so every launch in it would fail:\n{}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        // Proof the check above means something: an invalid mode must still be refused.
        let bogus = try_mode("episko-not-a-mode");
        assert!(
            !bogus.status.success(),
            "claude accepted a nonsense --permission-mode, so the assertions above prove nothing"
        );
    }
}
