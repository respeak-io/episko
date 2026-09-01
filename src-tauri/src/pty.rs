// The launch layer: every way a session starts (embedded PTY, Ghostty, Terminal.app/iTerm2),
// all writing the same `--settings` file. `--resume` and `--session-id` are mutually exclusive,
// so every spawner branches either/or on `resume`; `--settings` stays keyed to our launch uuid.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent;
#[cfg(not(windows))]
use crate::platform::sh_quote;
use crate::platform::{augmented_path, norm_path, resolve_claude, sys_command};
use crate::tasks;
use crate::telemetry::write_instrument_settings;
use crate::{AppState, Session};

/// How many times Claude Code retries a request itself before ending the turn with
/// `StopFailure`; its own backoff spaces them. The frontend watchdog (`src/revive.ts`)
/// covers outages that outlast this.
const CLAUDE_RETRY_CEILING: &str = "12";

/// Never overrides a `CLAUDE_CODE_MAX_RETRIES` the user set themselves.
fn apply_retry_ceiling(cmd: &mut CommandBuilder) {
    if std::env::var_os("CLAUDE_CODE_MAX_RETRIES").is_none() {
        cmd.env("CLAUDE_CODE_MAX_RETRIES", CLAUDE_RETRY_CEILING);
    }
}

/// A macOS app launched from Finder inherits no `LANG`, so the child would mangle non-ASCII
/// output; pin `LANG` and `LC_CTYPE` to UTF-8 unless they already are.
#[cfg(windows)]
fn apply_utf8_locale(_cmd: &mut CommandBuilder) {
    // No-op: ConPTY and claude.exe handle console encoding themselves.
}

#[cfg(not(windows))]
fn apply_utf8_locale(cmd: &mut CommandBuilder) {
    let is_utf8 = |var: &str| {
        std::env::var(var)
            .map(|v| {
                let u = v.to_ascii_uppercase();
                u.contains("UTF-8") || u.contains("UTF8")
            })
            .unwrap_or(false)
    };
    if !is_utf8("LANG") {
        cmd.env("LANG", "en_US.UTF-8");
    }
    // An inherited `LC_CTYPE=C` overrides a good `LANG` for the charset, so pin it too.
    if !is_utf8("LC_CTYPE") {
        cmd.env("LC_CTYPE", "en_US.UTF-8");
    }
}

/// `claude --permission-mode`, as a whitelist: the caller's string never reaches a command
/// line (`spawn_external_terminal` interpolates this into a shell script). An unknown mode
/// launches standard rather than refusing; standard passes no flag, which is what it means.
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

// The parameter list is the frontend's wire format; a struct would change it on both sides.
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
    let port = state.port.load(std::sync::atomic::Ordering::Relaxed);
    // A resume must land in its ORIGINAL cwd: Claude looks the id up under
    // `~/.claude/projects/<enc(cwd)>/`, and creating the dir would only fail later.
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let claude = resolve_claude();
    let mut cmd = CommandBuilder::new(&claude);
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
    apply_retry_ceiling(&mut cmd);

    log::info!(
        "spawn claude · {session_id} · {workdir}{}{}",
        resume
            .as_deref()
            .map(|r| format!(" · resume {r}"))
            .unwrap_or_default(),
        perm.map(|m| format!(" · {m}")).unwrap_or_default()
    );
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    // Recorded so the session is still recognisable on disk after Claude rotates its id.
    let child_pid = child.process_id();
    if let Some(p) = child_pid {
        state.owned_pids.lock().unwrap().insert(p);
    }

    let scroll = Arc::new(Mutex::new(ScrollBuf::new()));
    let win32 = Arc::new(AtomicBool::new(false));
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
            pid: child_pid,
            workdir,
            kind: "agent",
            provider: Some("claude".into()),
            scrollback: scroll.clone(),
            win32_input: win32.clone(),
        },
    );

    stream_pty_session(app, session_id, reader, child, child_pid, scroll, win32);
    Ok(())
}

/// ConPTY's request for win32 input records, and its withdrawal; no other OS sends either.
const WIN32_INPUT_ON: &[u8] = b"\x1b[?9001h";
const WIN32_INPUT_OFF: &[u8] = b"\x1b[?9001l";

/// Latch `ESC[?9001h`/`l` out of PTY output. `carry` keeps the previous chunk's tail so a
/// mode string split across reads is still seen. Compiled everywhere so a Mac can test it.
#[cfg_attr(not(windows), allow(dead_code))]
fn note_win32_input_mode(chunk: &[u8], carry: &mut Vec<u8>, flag: &AtomicBool) {
    let mut buf = std::mem::take(carry);
    buf.extend_from_slice(chunk);
    // Last one wins.
    let mut set: Option<bool> = None;
    for w in buf.windows(WIN32_INPUT_ON.len()) {
        if w == WIN32_INPUT_ON {
            set = Some(true);
        } else if w == WIN32_INPUT_OFF {
            set = Some(false);
        }
    }
    if let Some(v) = set {
        flag.store(v, Ordering::Relaxed);
    }
    let keep = buf.len().min(WIN32_INPUT_ON.len() - 1);
    *carry = buf.split_off(buf.len() - keep);
}

/// Re-encode a keystroke for a ConPTY that asked for win32 input records. ConPTY best-fits
/// a non-ASCII character into an Alt+numpad sequence riding on the key-UP record, where
/// `_getwch` (Python's `getpass`) never looks, so a secret loses characters silently. Only
/// non-ASCII is re-encoded; ASCII and escape sequences pass byte-exact (docs/architecture.md).
fn win32_input_encode(data: &str) -> String {
    let mut out = String::with_capacity(data.len());
    let mut it = data.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            out.push(c);
            copy_escape(&mut it, &mut out);
        } else if c.is_ascii() {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            // `Uc` is a UTF-16 code unit, not a scalar, so a non-BMP character is two record pairs.
            for unit in c.encode_utf16(&mut buf) {
                // Vk and Sc are 0: we know the character, not the key that produced it.
                out.push_str(&format!("\x1b[0;0;{unit};1;0;1_"));
                out.push_str(&format!("\x1b[0;0;{unit};0;0;1_"));
            }
        }
    }
    out
}

/// Borrowed unless ConPTY asked for records; split out so the round-trip test drives the real decision.
fn pty_payload<'a>(win32_input: &AtomicBool, data: &'a str) -> std::borrow::Cow<'a, str> {
    if win32_input.load(Ordering::Relaxed) {
        std::borrow::Cow::Owned(win32_input_encode(data))
    } else {
        std::borrow::Cow::Borrowed(data)
    }
}

/// Copy one escape sequence through untouched (ESC already emitted); its inside is never rewritten.
fn copy_escape(it: &mut std::iter::Peekable<std::str::Chars>, out: &mut String) {
    match it.peek() {
        // CSI: parameters, then a final byte in @..~
        Some('[') => {
            out.push(it.next().unwrap());
            for c in it.by_ref() {
                out.push(c);
                if ('\u{40}'..='\u{7e}').contains(&c) {
                    break;
                }
            }
        }
        // OSC: terminated by BEL or ST (ESC \)
        Some(']') => {
            out.push(it.next().unwrap());
            while let Some(c) = it.next() {
                out.push(c);
                if c == '\u{7}' {
                    break;
                }
                if c == '\x1b' {
                    if let Some(n) = it.next() {
                        out.push(n);
                    }
                    break;
                }
            }
        }
        // ESC O A, ESC b, ESC ESC: one byte, then ordinary characters again.
        Some(_) => out.push(it.next().unwrap()),
        None => {}
    }
}

/// Recent raw output of one PTY, so a pane rebuilt after a webview reload is not blank (#47).
/// `seq` is taken under this lock as the reader appends, and `read_scrollback` snapshots under
/// the same lock, so a chunk with `seq <= snapshot.seq` is inside the snapshot, exactly.
pub(crate) struct ScrollBuf {
    buf: VecDeque<u8>,
    seq: u64,
    evicted: bool,
}

pub(crate) const SCROLLBACK_MAX: usize = 256 * 1024;

impl ScrollBuf {
    pub(crate) fn new() -> Self {
        ScrollBuf {
            buf: VecDeque::new(),
            seq: 0,
            evicted: false,
        }
    }
    pub(crate) fn push(&mut self, chunk: &[u8]) -> u64 {
        self.buf.extend(chunk.iter().copied());
        if self.buf.len() > SCROLLBACK_MAX {
            self.buf.drain(..self.buf.len() - SCROLLBACK_MAX);
            self.evicted = true;
        }
        self.seq += 1;
        self.seq
    }
    /// Once the front has been evicted the buffer starts mid-line, likely mid escape
    /// sequence, so it is trimmed to the first newline; a newline-free stream is kept whole.
    pub(crate) fn snapshot(&self) -> (Vec<u8>, u64) {
        let mut v: Vec<u8> = self.buf.iter().copied().collect();
        if self.evicted {
            if let Some(p) = v.iter().position(|&b| b == b'\n') {
                v.drain(..=p);
            }
        }
        (v, self.seq)
    }
}

/// The reader (`pty-output`) and reaper (`pty-exit` + cleanup) threads shared by every embedded pane.
fn stream_pty_session(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    child_pid: Option<u32>,
    scroll: Arc<Mutex<ScrollBuf>>,
    win32_input: Arc<AtomicBool>,
) {
    #[cfg(not(windows))]
    let _ = win32_input;
    let app_out = app.clone();
    let sid_out = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        #[cfg(windows)]
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Only ConPTY ever sends this; the hot path elsewhere skips the scan.
                    #[cfg(windows)]
                    note_win32_input_mode(&buf[..n], &mut carry, &win32_input);
                    let seq = scroll.lock().unwrap().push(&buf[..n]);
                    let encoded = STANDARD.encode(&buf[..n]);
                    if app_out
                        .emit("pty-output", serde_json::json!({ "sessionId": sid_out, "data": encoded, "seq": seq }))
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
            agent::stop_runtime(&st, &session_id);
            if let Some(p) = child_pid {
                st.owned_pids.lock().unwrap().remove(&p);
            }
        }
        let _ = app.emit(
            "pty-exit",
            serde_json::json!({ "sessionId": session_id, "code": code }),
        );
    });
}

/// The interactive shell for a scratch pane: `$SHELL -l` on Unix; on Windows pwsh, else
/// Windows PowerShell, else cmd.exe.
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

/// A plain login shell in an embedded pane: no Claude, no instrumentation.
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
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
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
    // Not added to owned_pids: not a claude process, so it cannot leak as "external".
    let scroll = Arc::new(Mutex::new(ScrollBuf::new()));
    let win32 = Arc::new(AtomicBool::new(false));
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
            pid: child_pid,
            workdir,
            kind: "shell",
            provider: None,
            scrollback: scroll.clone(),
            win32_input: win32.clone(),
        },
    );
    stream_pty_session(app, session_id, reader, child, child_pid, scroll, win32);
    Ok(())
}

/// The login shell that runs a `Shell` task; the args end with the flag that takes the line.
/// A login shell does NOT give a task the user's PATH (zsh sources `.zshrc` only when
/// interactive); `platform::augmented_path` is what closes that gap (docs/tasks.md).
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

/// Build the command for an `Exec::Argv` task; Windows needs a detour (below).
#[cfg(not(windows))]
fn argv_command(program: &str, args: Vec<String>) -> CommandBuilder {
    let mut c = CommandBuilder::new(program);
    for a in args {
        c.arg(a);
    }
    c
}

/// Whether `CreateProcessW` can start this file on its own. It cannot start a script, and
/// npm's `.cmd` shims (and the extensionless sh script beside them) are scripts, so a bare
/// `npm` fails with ERROR_BAD_EXE_FORMAT. Compiled everywhere so a Mac can test it.
#[cfg_attr(not(windows), allow(dead_code))]
fn win_runs_directly(resolved: &str) -> bool {
    let l = resolved.to_ascii_lowercase();
    l.ends_with(".exe") || l.ends_with(".com")
}

/// Resolve a bare Windows program name the way `cmd.exe` would (PATHEXT across the
/// augmented PATH). Unlike portable-pty's `search_path`, which prefers an exact
/// extensionless match: for `npm` that is the one file that cannot be launched.
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
        // The resolved absolute path, so portable-pty cannot re-resolve to an extensionless sibling.
        Some(exe) => CommandBuilder::new(exe),
        // A script shim, or nothing found: cmd.exe resolves PATHEXT and can run a script.
        // Not-found lands here too, so "'foo' is not recognized" prints in the pane.
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

/// Run a Runnable in an embedded PTY. Not instrumented: no `--settings`, no telemetry, and
/// its pid never enters `owned_pids`. The exit code arrives over `pty-exit`.
#[tauri::command]
pub(crate) fn spawn_task(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    spec: tasks::TaskSpec,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let tasks::TaskSpec {
        exec,
        cwd: workdir,
        env,
    } = spec;
    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("no such directory: {workdir}"));
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
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
    let scroll = Arc::new(Mutex::new(ScrollBuf::new()));
    let win32 = Arc::new(AtomicBool::new(false));
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
            pid: child_pid,
            workdir,
            kind: "task",
            provider: None,
            scrollback: scroll.clone(),
            win32_input: win32.clone(),
        },
    );
    stream_pty_session(app, session_id, reader, child, child_pid, scroll, win32);
    Ok(())
}

// ---------- other people's agents ----------

/// One coding-agent CLI Episko will drop into a pane. `bin` is the bare name, resolved
/// against the augmented PATH at detection time (twenty-one installers agree on no prefix);
/// one spelling covers both OSes since `win_resolve` walks PATHEXT.
struct AgentSpec {
    id: &'static str,
    label: &'static str,
    bin: &'static str,
    /// Legacy wire field kept for older frontends; never used to guess a logo.
    mark: &'static str,
}

/// The agents Episko can launch, sorted by label (the picker's order; a test holds it).
/// `agy`, `kiro-cli` and `cursor-agent` are the vendors' own binary names. Claude Code is
/// deliberately absent: a catalogue entry would bypass its instrumented launcher.
const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "amp",
        label: "Amp",
        bin: "amp",
        mark: "Am",
    },
    AgentSpec {
        id: "antigravity",
        label: "Antigravity CLI",
        bin: "agy",
        mark: "Ag",
    },
    AgentSpec {
        id: "cline",
        label: "Cline",
        bin: "cline",
        mark: "Cl",
    },
    AgentSpec {
        id: "codex",
        label: "Codex",
        bin: "codex",
        mark: "Cx",
    },
    AgentSpec {
        id: "cursor",
        label: "Cursor Agent CLI",
        bin: "cursor-agent",
        mark: "Cu",
    },
    AgentSpec {
        id: "devin",
        label: "Devin CLI",
        bin: "devin",
        mark: "Dv",
    },
    AgentSpec {
        id: "droid",
        label: "Droid",
        bin: "droid",
        mark: "Dr",
    },
    AgentSpec {
        id: "gemini",
        label: "Gemini CLI",
        bin: "gemini",
        mark: "Gm",
    },
    AgentSpec {
        id: "copilot",
        label: "GitHub Copilot CLI",
        bin: "copilot",
        mark: "Cp",
    },
    AgentSpec {
        id: "grok",
        label: "Grok CLI",
        bin: "grok",
        mark: "Gr",
    },
    AgentSpec {
        id: "hermes",
        label: "Hermes Agent",
        bin: "hermes",
        mark: "He",
    },
    AgentSpec {
        id: "kilo",
        label: "Kilo Code CLI",
        bin: "kilo",
        mark: "Kl",
    },
    AgentSpec {
        id: "kimi",
        label: "Kimi Code CLI",
        bin: "kimi",
        mark: "Km",
    },
    AgentSpec {
        id: "kiro",
        label: "Kiro CLI",
        bin: "kiro-cli",
        mark: "Kr",
    },
    AgentSpec {
        id: "maki",
        label: "Maki",
        bin: "maki",
        mark: "Mk",
    },
    AgentSpec {
        id: "mastracode",
        label: "MastraCode",
        bin: "mastracode",
        mark: "Ms",
    },
    AgentSpec {
        id: "omp",
        label: "OMP",
        bin: "omp",
        mark: "Om",
    },
    AgentSpec {
        id: "opencode",
        label: "OpenCode",
        bin: "opencode",
        mark: "Oc",
    },
    AgentSpec {
        id: "pi",
        label: "Pi",
        bin: "pi",
        mark: "Pi",
    },
    AgentSpec {
        id: "qodercli",
        label: "Qoder CLI",
        bin: "qodercli",
        mark: "Qo",
    },
    AgentSpec {
        id: "qwen",
        label: "Qwen Code",
        bin: "qwen",
        mark: "Qw",
    },
];

fn agent_spec(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// Where an agent CLI is, or `None`. Unlike `resolve_claude` it never falls back to the
/// bare name (that would put every agent in every picker) and never spawns a login shell
/// (twenty-one probes is a visible stall); `augmented_path()` already harvested that PATH.
#[cfg(not(windows))]
pub(crate) fn resolve_cli(bin: &str) -> Option<String> {
    let home = crate::platform::home_dir();
    // Where per-user installers land things the Finder PATH may not carry.
    let extra = [
        format!("{home}/.local/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.deno/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.npm-global/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    let path = augmented_path();
    std::env::split_paths(&path)
        .chain(extra.iter().map(std::path::PathBuf::from))
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(windows)]
pub(crate) fn resolve_cli(bin: &str) -> Option<String> {
    // The same call `argv_command` makes at launch, so detection and spawn agree.
    if let Some(p) = win_resolve(bin) {
        return Some(p.to_string_lossy().into_owned());
    }
    // npm's global bin dir is the one common location `augmented_path` lacks.
    let home = crate::platform::home_dir();
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| format!(r"{home}\AppData\Roaming"));
    for dir in [format!(r"{appdata}\npm"), format!(r"{home}\.bun\bin")] {
        for ext in [".cmd", ".exe", ".bat", ".ps1"] {
            let cand = std::path::Path::new(&dir).join(format!("{bin}{ext}"));
            if cand.is_file() {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[derive(serde::Serialize)]
pub(crate) struct AgentInfo {
    id: &'static str,
    label: &'static str,
    mark: &'static str,
    bin: &'static str, // what was looked for; the only useful fact about an agent that is missing
    path: Option<String>, // None when this machine hasn't got it
    capabilities: Vec<String>, // from the provider manifest; the terminal-only fallback advertises none
}

#[derive(serde::Deserialize)]
struct ProviderManifestEntry {
    capabilities: Vec<String>,
}

/// The one capability matrix shared with the TypeScript provider registry (checked-in JSON).
fn provider_manifest() -> std::collections::HashMap<String, ProviderManifestEntry> {
    serde_json::from_str(include_str!("../../src/providers/manifest.json"))
        .expect("src/providers/manifest.json must be valid provider metadata")
}

/// The whole catalogue, each entry saying whether it is installed. Never a filtered list:
/// an agent that silently fails to appear is indistinguishable from Episko not supporting
/// it. What can't be used says why rather than vanishing (the `tasks.rs` rule).
#[tauri::command]
pub(crate) fn list_agents() -> Vec<AgentInfo> {
    let providers = provider_manifest();
    AGENTS
        .iter()
        .map(|a| AgentInfo {
            id: a.id,
            label: a.label,
            mark: a.mark,
            bin: a.bin,
            path: resolve_cli(a.bin),
            capabilities: providers
                .get(a.id)
                .map(|p| p.capabilities.clone())
                .unwrap_or_default(),
        })
        .collect()
}

/// Run a coding-agent provider in an embedded PTY. Codex starts a loopback App Server
/// beside the TUI; providers without an adapter are terminal-only. The TUI pid stays out
/// of `owned_pids`, which exists only to filter Claude's external-session registry.
#[allow(clippy::too_many_arguments)] // Tauri command parameters are the frontend wire format.
#[tauri::command]
pub(crate) fn spawn_agent(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    workdir: String,
    agent: String,
    rows: u16,
    cols: u16,
    resume: Option<String>,
    mode: Option<String>,
) -> Result<(), String> {
    let spec = agent_spec(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    // Resolve here so a miss names the agent rather than opening a pane onto "not recognized".
    let bin = resolve_cli(spec.bin).ok_or_else(|| {
        format!(
            "{} isn't installed — `{}` is not on PATH",
            spec.label, spec.bin
        )
    })?;
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Through `argv_command`: on Windows most of these are npm `.cmd` shims CreateProcessW cannot start.
    let args = agent::start_provider(
        spec.id,
        app.clone(),
        &state,
        agent::ProviderLaunch::new(
            &session_id,
            &workdir,
            &bin,
            resume.as_deref(),
            mode.as_deref(),
        ),
    )?;
    let mut cmd = argv_command(&bin, args);
    cmd.cwd(&workdir);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    apply_utf8_locale(&mut cmd);

    log::info!(
        "spawn agent · {} · {session_id} · {workdir} · {bin}",
        spec.id
    );
    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            agent::stop_runtime(&state, &session_id);
            return Err(e.to_string());
        }
    };
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let child_pid = child.process_id();
    let scroll = Arc::new(Mutex::new(ScrollBuf::new()));
    let win32 = Arc::new(AtomicBool::new(false));
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
            pid: child_pid,
            workdir,
            kind: "agent",
            provider: Some(spec.id.into()),
            scrollback: scroll.clone(),
            win32_input: win32.clone(),
        },
    );
    stream_pty_session(app, session_id, reader, child, child_pid, scroll, win32);
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

/// The instrumented `claude` session in an external Ghostty window tinted to the project
/// accent; telemetry still flows via the hooks.
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
    let port = state.port.load(std::sync::atomic::Ordering::Relaxed);
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    let settings_path =
        write_instrument_settings(port, &session_id).map_err(|e| format!("write settings: {e}"))?;
    let bin = find_ghostty().ok_or_else(|| {
        "Ghostty not found — install it or add `ghostty` to your PATH".to_string()
    })?;

    let bg = accent.trim_start_matches('#').to_string();
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(format!("--background={bg}"));
    cmd.arg(format!("--title={title}"));
    cmd.arg(format!("--working-directory={workdir}"));
    cmd.arg("-e");
    cmd.arg(resolve_claude());
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

/// Which external terminals are installed (the embedded one is always available). Empty on Windows.
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

/// No external-terminal engine on Windows yet; guard so a stray call fails cleanly.
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
    Err(
        "external terminals aren't supported on Windows yet — use the embedded terminal"
            .to_string(),
    )
}

/// An instrumented `claude` session in Terminal.app / iTerm2, via a generated `.command`
/// wrapper handed to `open -a`.
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
    let port = state.port.load(std::sync::atomic::Ordering::Relaxed);
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

    let id_args = match &resume {
        Some(prev) => format!("--resume {}", sh_quote(prev)),
        None => format!("--session-id {}", sh_quote(&session_id)),
    };
    // Interpolated into a shell script: safe only because `permission_mode_arg` is a whitelist.
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

/// Windows: a scratch terminal at `workdir`, Windows Terminal if installed, else a
/// PowerShell window; `engine` is ignored.
#[cfg(windows)]
#[tauri::command]
pub(crate) fn open_terminal_here(workdir: String, _engine: String) -> Result<(), String> {
    if !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    // Windows Terminal opens a new tab/window rooted at a directory via `-d`.
    if sys_command("wt.exe")
        .arg("-d")
        .arg(&workdir)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }
    // `cmd /c start` gets a new console window; a bare spawn from a GUI app gets none.
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let powershell = format!(r"{sysroot}\System32\WindowsPowerShell\v1.0\powershell.exe");
    std::process::Command::new(format!(r"{sysroot}\System32\cmd.exe"))
        .args(["/C", "start", "", &powershell, "-NoExit"])
        .current_dir(&workdir)
        .spawn()
        .map_err(|e| format!("open terminal: {e}"))?;
    Ok(())
}

/// A plain shell in an external terminal at `workdir`: not instrumented, so it never
/// appears in the cockpit. The embedded engine falls back to Terminal.app.
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
    let app_name = if engine == "iterm" && std::path::Path::new("/Applications/iTerm.app").exists()
    {
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

/// The one place that decides what a PTY's child receives (docs/architecture.md).
#[tauri::command]
pub(crate) fn write_pty(
    state: State<AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    if let Some(s) = map.get_mut(&session_id) {
        let payload = pty_payload(&s.win32_input, &data);
        s.writer
            .write_all(payload.as_bytes())
            .map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn resize_pty(
    state: State<AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    if let Some(s) = map.get(&session_id) {
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
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
        agent::stop_runtime(&state, &session_id);
        if let Some(p) = s.pid {
            state.owned_pids.lock().unwrap().remove(&p);
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub(crate) struct LiveSession {
    id: String,
    kind: &'static str,
    provider: Option<String>,
    workdir: String,
}

/// Every embedded PTY the backend holds. Exists for the one state where the frontend map
/// disagrees: a webview reload empties it while every PTY runs on (#47). Feeds the busy
/// guards (`dormantBusy`/`histBusy`) and startup adoption.
#[tauri::command]
pub(crate) fn live_sessions(state: State<AppState>) -> Vec<LiveSession> {
    state
        .sessions
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| LiveSession {
            id: id.clone(),
            kind: s.kind,
            provider: s.provider.clone(),
            workdir: s.workdir.clone(),
        })
        .collect()
}

#[derive(serde::Serialize)]
pub(crate) struct ScrollbackSnapshot {
    data: String, // base64, as `pty-output` uses
    seq: u64, // a queued `pty-output` with seq at or below this is already in `data`
}

/// Retained output for a pane rebuilt after a reload; read under the reader's lock so `seq` is exact.
#[tauri::command]
pub(crate) fn read_scrollback(
    state: State<AppState>,
    session_id: String,
) -> Result<ScrollbackSnapshot, String> {
    let map = state.sessions.lock().unwrap();
    let s = map
        .get(&session_id)
        .ok_or_else(|| format!("no such session: {session_id}"))?;
    let (bytes, seq) = s.scrollback.lock().unwrap().snapshot();
    Ok(ScrollbackSnapshot {
        data: STANDARD.encode(&bytes),
        seq,
    })
}

#[derive(serde::Serialize)]
pub(crate) struct Resources {
    read_bps: f64, // averaged over the gap since the previous sample
    write_bps: f64, // same window
    read_mb: f64, // lifetime totals across every owned session, exited ones included
    written_mb: f64,
    primed: bool, // false until some pid has a previous reading; the UI shows "—" rather than 0 B/s
    install: Vec<InstallFile>, // installed `claude` binaries, so usage.ts can discount a self-update
}

/// One installed `claude` binary: name and size, so one that just appeared can be discounted.
#[derive(serde::Serialize)]
pub(crate) struct InstallFile {
    name: String,
    mb: f64,
}

/// Resolved once per run: `resolve_claude()` can end in a login-shell probe, and this is
/// read by a four-second poll.
static VERSIONS_DIR: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();

fn versions_dir() -> Option<&'static std::path::Path> {
    VERSIONS_DIR
        .get_or_init(|| {
            // `~/.local/bin/claude` symlinks into `…/share/claude/versions/<ver>`, so the real
            // binary's parent is the directory; npm/Homebrew installs have none, correctly.
            let real = std::fs::canonicalize(crate::platform::resolve_claude()).ok();
            let by_link = real
                .as_deref()
                .and_then(|p| p.parent())
                .filter(|p| p.file_name().is_some_and(|n| n == "versions"))
                .map(|p| p.to_path_buf());
            by_link.or_else(|| {
                let p = std::path::Path::new(&crate::platform::home_dir())
                    .join(".local")
                    .join("share")
                    .join("claude")
                    .join("versions");
                p.is_dir().then_some(p)
            })
        })
        .as_deref()
}

/// The installed `claude` binaries and their sizes. A self-update writes a ~290 MiB binary
/// here from a process that is ours, so the kernel charges it to a session; `installGrown`
/// in `usage.ts` takes it back out. Takes the dir so the scan is testable.
fn version_files_in(dir: &std::path::Path) -> Vec<InstallFile> {
    let mut out: Vec<InstallFile> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            md.is_file().then(|| InstallFile {
                name: e.file_name().to_string_lossy().into_owned(),
                mb: md.len() as f64 / (1024.0 * 1024.0),
            })
        })
        .collect();
    // Sorted so two polls describe the install in the same order.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Where a pane's process is right now. `Session.workdir` is where it was launched and never
/// moves, which is wrong for a shell that has `cd`ed; the link resolver asks here first. The
/// pid is the PTY child itself, so this is what `pwd` would say. `None` once it has exited.
#[tauri::command]
pub(crate) fn session_cwd(state: State<AppState>, session_id: String) -> Option<String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let pid = state.sessions.lock().unwrap().get(&session_id)?.pid?;
    let spid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[spid]),
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    let cwd = sys.process(spid)?.cwd()?;
    Some(norm_path(&cwd.to_string_lossy()))
}

/// App-wide disk I/O of every embedded pane's child process (not its subtree), one reading
/// for the whole fleet. Rates are differenced per pid from lifetime totals and then summed, so a
/// session exiting between polls stops contributing rather than zeroing the window; the
/// totals carry `io_retired` so closing a pane never walks the run backwards (docs/architecture.md).
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
            // The lifetime totals, never sysinfo's per-refresh deltas: this `System` is fresh every call.
            Some((*pid, usage.total_read_bytes, usage.total_written_bytes))
        })
        .collect();

    // Keyed by the session roster, NOT `owned_pids`: shells and tasks never join that set
    // and would be re-banked as exited on every poll.
    let live: HashSet<u32> = pids.iter().copied().collect();
    let now = std::time::Instant::now();
    let mut samples = state.io_samples.lock().unwrap();
    let mut retired = state.io_retired.lock().unwrap();
    retire_missing(&mut samples, &live, &mut retired);
    let folded = fold_io(&readings, &mut samples, now);

    const MIB: f64 = 1024.0 * 1024.0;
    Resources {
        read_bps: folded.read_bps,
        write_bps: folded.write_bps,
        read_mb: folded.read.saturating_add(retired.0) as f64 / MIB,
        written_mb: folded.written.saturating_add(retired.1) as f64 / MIB,
        primed: folded.primed,
        // Reported raw; `usage.ts` decides what an installed binary means for the figures.
        install: versions_dir().map(version_files_in).unwrap_or_default(),
    }
}

/// Bank the bytes of pids that left the roster into `retired`, then drop their samples. A
/// pid still in `live` keeps its sample, which makes the bank a once-per-lifetime event.
fn retire_missing(
    samples: &mut HashMap<u32, (u64, u64, std::time::Instant)>,
    live: &HashSet<u32>,
    retired: &mut (u64, u64),
) {
    samples.retain(|p, (r, w, _)| {
        let keep = live.contains(p);
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

/// The arithmetic half of `all_sessions_resources`, testable without an app: differences
/// per pid, then sums the rates.
fn fold_io(
    readings: &[(u32, u64, u64)],
    samples: &mut HashMap<u32, (u64, u64, std::time::Instant)>,
    now: std::time::Instant,
) -> Folded {
    let mut f = Folded {
        read_bps: 0.0,
        write_bps: 0.0,
        read: 0,
        written: 0,
        primed: false,
    };
    for &(pid, r, w) in readings {
        f.read = f.read.saturating_add(r);
        f.written = f.written.saturating_add(w);
        // saturating_sub: a pid reused after a missed exit would otherwise underflow.
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

// ---------- the log of a background shell an agent started ----------
// The root is Claude's, not ours: `${CLAUDE_CODE_TMPDIR ?? "/tmp"}/claude-<uid>/`, never
// `env::temp_dir()`, which the CLI ignores on macOS. So the root is probed and remembered,
// never asserted, and the probe carries both directory shapes on every platform.

/// Every consumer reads the end of the log (URL, sentinel, peek), so only the tail crosses IPC.
const BG_LOG_TAIL: u64 = 32 * 1024;

/// Process-wide throttle on the last-resort directory scan: ten blind shells polled every
/// four seconds must not `read_dir` `/tmp` 150 times a minute.
const BG_SCAN_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

/// Cap on candidate roots per record; bases × names is already the whole believable space.
const BG_ROOT_MAX: usize = 8;

/// Claude Code's layout as a VALUE rather than a `#[cfg]`, so the Windows row is
/// assertable from a Mac.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ClaudeOs {
    Mac,
    Windows,
    Unix,
}

impl ClaudeOs {
    fn current() -> Self {
        match std::env::consts::OS {
            "macos" => Self::Mac,
            "windows" => Self::Windows,
            _ => Self::Unix,
        }
    }
}

/// Everything the root table depends on, gathered in the one impure place. `current()` is
/// the ONLY reader of env/uid in this half of the file; the table and probe are pure, which
/// is what lets the macOS leg of CI assert the Windows candidate order.
struct BgLogEnv {
    os: ClaudeOs,
    /// `$CLAUDE_CODE_TMPDIR`, the one knob the CLI honours; `$TMPDIR` is not a fallback for it.
    override_tmp: Option<std::path::PathBuf>,
    /// `env::temp_dir()`: wrong on macOS, likely right on Windows, kept as a candidate.
    sys_tmp: std::path::PathBuf,
    /// `$XDG_RUNTIME_DIR`, last: where a Linux box can have both others wrong at once.
    xdg_runtime: Option<std::path::PathBuf>,
    uid: Option<u32>, // names the `claude-<uid>` directory; None where there is no uid
}

impl BgLogEnv {
    fn current() -> Self {
        // An empty variable is not a base: `PathBuf::from("")` joins to a relative path.
        let dir = |k: &str| {
            std::env::var_os(k).map(std::path::PathBuf::from).filter(|p| !p.as_os_str().is_empty())
        };
        Self {
            os: ClaudeOs::current(),
            override_tmp: dir("CLAUDE_CODE_TMPDIR"),
            sys_tmp: std::env::temp_dir(),
            xdg_runtime: dir("XDG_RUNTIME_DIR"),
            uid: current_uid(),
        }
    }
}

/// Read off the owner of `$HOME`: no libc dependency, and the two numbers are the same one.
#[cfg(unix)]
fn current_uid() -> Option<u32> {
    use std::os::unix::fs::MetadataExt as _;
    std::fs::metadata(crate::platform::home_dir()).ok().map(|m| m.uid())
}

#[cfg(not(unix))]
fn current_uid() -> Option<u32> {
    None
}

/// The `claude*` directory names Claude Code may use, most-believed first. Both shapes on
/// every platform; only the order changes. With no uid to read (every Windows build) the
/// suffixed shape is `claude-0`, which is what the bundle's `getuid?.() ?? 0` computes.
/// `claude_layout_still_names_its_temp_dir_the_way_we_probe_for_it` settles the Windows row.
fn bg_log_dir_names(os: ClaudeOs, uid: Option<u32>) -> Vec<String> {
    let owned = format!("claude-{}", uid.unwrap_or(0));
    let bare = "claude".to_string();
    match os {
        ClaudeOs::Windows => vec![bare, owned],
        ClaudeOs::Mac | ClaudeOs::Unix => vec![owned, bare],
    }
}

/// The directories a `claude*` tree could sit in, most-believed first. Separate from
/// `bg_log_roots` because the last-resort scan walks these bases for a name nobody predicted.
fn bg_log_bases(e: &BgLogEnv) -> Vec<std::path::PathBuf> {
    // `/tmp` first on macOS (the CLI hard-codes it), `env::temp_dir()` first elsewhere;
    // each keeps the other as a fallback.
    let hard_tmp = std::path::PathBuf::from("/tmp");
    let (first, second) = match e.os {
        ClaudeOs::Mac => (hard_tmp, e.sys_tmp.clone()),
        ClaudeOs::Windows | ClaudeOs::Unix => (e.sys_tmp.clone(), hard_tmp),
    };
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    for b in e
        .override_tmp
        .iter()
        .cloned()
        .chain([first, second])
        .chain(e.xdg_runtime.iter().cloned())
    {
        if !out.contains(&b) {
            out.push(b);
        }
    }
    out
}

/// The candidate roots, most-believed first. Pure. Each index is a `rootRank` the frontend
/// reads, so the order is part of the contract.
fn bg_log_roots(e: &BgLogEnv) -> Vec<std::path::PathBuf> {
    let names = bg_log_dir_names(e.os, e.uid);
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    for base in bg_log_bases(e) {
        for name in &names {
            let cand = base.join(name);
            if !out.contains(&cand) {
                out.push(cand);
            }
            if out.len() == BG_ROOT_MAX {
                return out;
            }
        }
    }
    out
}

/// `~/.claude/projects/<slug>/<uuid>.jsonl` → `(<slug>, <uuid>)`.
fn bg_log_session(transcript: &str) -> Option<(String, String)> {
    let t = std::path::Path::new(transcript);
    let uuid = t.file_stem()?.to_str()?;
    let slug = t.parent()?.file_name()?.to_str()?;
    if uuid.is_empty() || slug.is_empty() {
        return None;
    }
    Some((slug.to_string(), uuid.to_string()))
}

/// A background log's path GIVEN a root (the `claude*` component is probed, not computed):
/// `<root>/<slug>/<uuid>/tasks/<task_id>.output`. The layout is not ours, so this returns
/// `None` rather than guessing.
fn bg_log_path(root: &std::path::Path, transcript: &str, task_id: &str) -> Option<std::path::PathBuf> {
    // The id comes from a hook payload and lands in a path: only Claude's own alphabet is accepted.
    if task_id.is_empty() || !task_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    let (slug, uuid) = bg_log_session(transcript)?;
    Some(root.join(slug).join(uuid).join("tasks").join(format!("{task_id}.output")))
}

/// A log the probe actually found, and how far down it had to go to find it.
struct BgResolved {
    path: std::path::PathBuf,
    /// Index into `bg_log_roots`, or `-1` when the directory scan found it.
    rank: i32,
    discovered: bool,
    /// The memo answered, so there is nothing new to remember.
    from_memo: bool,
}

/// Why the probe has no log, in the shape a row can say out loud. `NotYet` carries the file
/// it waits for; the others carry every path tested. `Debug` so a failing test prints the paths.
#[derive(Debug)]
enum BgResolveErr {
    BadId,
    NotYet(std::path::PathBuf, Vec<std::path::PathBuf>),
    NoRoot(Vec<std::path::PathBuf>),
    Ambiguous(Vec<std::path::PathBuf>),
}

/// The probe's memo, held in `AppState`. The ROOT is memoised and the FILE never is (a log
/// appears seconds after the record naming it), and the memo is invalidated rather than
/// defended: `$CLAUDE_CODE_TMPDIR` can change under a running app and `/tmp` gets reaped.
pub(crate) struct BgRootState {
    root: Option<std::path::PathBuf>,
    rank: i32,
    /// The `<root>/<slug>/<uuid>` directory a SCAN resolved: Claude splices a hash into a long
    /// slug, so the root alone cannot rebuild it. Answers only for the uuid it was learned for.
    sess: Option<std::path::PathBuf>,
    /// Last `bglog-health` state announced PER RECORD, so the event fires on transition only;
    /// one slot for the process flaps once two live records disagree. Keyed by transcript and
    /// task id, since a task id is unique only within its session.
    announced: std::collections::HashMap<(String, String), BgHealth>,
    last_scan: Option<std::time::Instant>,
}

impl Default for BgRootState {
    fn default() -> Self {
        Self {
            root: None,
            rank: -1,
            sess: None,
            announced: std::collections::HashMap::new(),
            last_scan: None,
        }
    }
}

/// Find the log, or say exactly where you looked. Five steps, cheapest and
/// most-believed first, and every one of them ends in an answer a row can draw.
fn bg_log_resolve(
    e: &BgLogEnv,
    memo: &mut BgRootState,
    transcript: &str,
    task_id: &str,
    now: std::time::Instant,
) -> Result<BgResolved, BgResolveErr> {
    let Some((slug, uuid)) = bg_log_session(transcript) else {
        return Err(BgResolveErr::BadId);
    };
    let roots = bg_log_roots(e);
    // Root and candidate file together, so a rank indexes one list.
    let cands: Vec<(std::path::PathBuf, std::path::PathBuf)> = roots
        .iter()
        .filter_map(|r| bg_log_path(r, transcript, task_id).map(|p| (r.clone(), p)))
        .collect();
    if cands.is_empty() {
        // The transcript parsed, so this can only be a task id that is not one.
        return Err(BgResolveErr::BadId);
    }
    let tried = |c: &[(std::path::PathBuf, std::path::PathBuf)]| {
        c.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>()
    };

    // (1) The remembered root: one `is_file()` against a table of up to eight.
    let mut won: Option<(BgResolved, std::path::PathBuf)> = None;
    if let Some(root) = memo.root.clone() {
        if let Some(p) = bg_log_path(&root, transcript, task_id) {
            if p.is_file() {
                won = Some((
                    BgResolved { path: p, rank: memo.rank, discovered: memo.rank < 0, from_memo: true },
                    root,
                ));
            }
        }
    }

    // ...and the session directory a scan resolved. The uuid is checked, not assumed: this
    // slot is shared by the whole fleet.
    if won.is_none() {
        if let Some(dir) = memo.sess.clone() {
            if dir.file_name().and_then(|n| n.to_str()) == Some(uuid.as_str()) {
                let p = dir.join("tasks").join(format!("{task_id}.output"));
                if p.is_file() {
                    let root = dir.ancestors().nth(2).unwrap_or(&dir).to_path_buf();
                    won = Some((
                        BgResolved { path: p, rank: -1, discovered: true, from_memo: true },
                        root,
                    ));
                }
            }
        }
    }

    // (2) The table, in order. The first existing FILE, never the first existing ROOT: a
    // stale `claude/` from an older layout exists and holds nothing.
    if won.is_none() {
        for (i, (root, cand)) in cands.iter().enumerate() {
            if cand.is_file() {
                won = Some((
                    BgResolved { path: cand.clone(), rank: i as i32, discovered: false, from_memo: false },
                    root.clone(),
                ));
                break;
            }
        }
    }
    if let Some((r, root)) = won {
        // A hit that came out of the memo has nothing to teach it.
        if !r.from_memo {
            memo.root = Some(root);
            memo.rank = r.rank;
        }
        return Ok(r);
    }

    // (3) A root holding THIS SESSION but not yet this log: Claude mkdirs `scratchpad` at
    // start and `tasks/` only on the first background shell. `notYet` is the state the
    // frontend retires a row on; `noRoot` is not.
    for (root, cand) in &cands {
        let sess = root.join(&slug).join(&uuid);
        if sess.is_dir() || sess.join("scratchpad").exists() {
            return Err(BgResolveErr::NotYet(cand.clone(), tried(&cands)));
        }
    }

    // (4) Last resort: a `claude*` directory nobody predicted, or this uuid under a slug we
    // did not derive. Throttled process-wide (`BG_SCAN_EVERY`).
    let due = match memo.last_scan {
        Some(t) => now.duration_since(t) >= BG_SCAN_EVERY,
        None => true,
    };
    if !due {
        // "Come back later" is not "there is no root": only step (5), which actually looked,
        // may drop the process-wide memo.
        return Err(BgResolveErr::NoRoot(tried(&cands)));
    }
    memo.last_scan = Some(now);
    let mut hits: Vec<std::path::PathBuf> = Vec::new();
    for base in bg_log_bases(e) {
        let Ok(entries) = std::fs::read_dir(&base) else { continue };
        for ent in entries.flatten() {
            let raw = ent.file_name();
            let name = raw.to_string_lossy();
            if name != "claude" && !name.starts_with("claude-") {
                continue;
            }
            let root = ent.path();
            if let Some(p) = bg_log_path(&root, transcript, task_id) {
                if p.is_file() && !hits.contains(&p) {
                    hits.push(p);
                }
            }
            // The same uuid under a slug we did not derive (Claude splices a hash into long slugs;
            // we do not reproduce it). One `read_dir`, no recursion.
            let Ok(slugs) = std::fs::read_dir(&root) else { continue };
            for s in slugs.flatten() {
                let p = s.path().join(&uuid).join("tasks").join(format!("{task_id}.output"));
                if p.is_file() && !hits.contains(&p) {
                    hits.push(p);
                }
            }
        }
    }
    match hits.len() {
        1 => {
            let path = hits.remove(0);
            // `<root>/<slug>/<uuid>/tasks/<id>.output`: the root is four levels up, the session dir two.
            memo.root = path.ancestors().nth(4).map(|p| p.to_path_buf());
            memo.sess = path.ancestors().nth(2).map(|p| p.to_path_buf());
            memo.rank = -1;
            Ok(BgResolved { path, rank: -1, discovered: true, from_memo: false })
        }
        // (5) A total miss drops the memo: this branch looked and found nothing.
        0 => {
            memo.root = None;
            memo.sess = None;
            Err(BgResolveErr::NoRoot(tried(&cands)))
        }
        // Two roots holding one session: a guess would put this row's peek on another log.
        _ => {
            memo.root = None;
            memo.sess = None;
            Err(BgResolveErr::Ambiguous(hits))
        }
    }
}

/// Why a read came back empty: not-yet, wrong root and unreadable are three states with
/// three different answers.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BgMiss {
    None,
    BadId,
    NotYet,
    NoRoot,
    Ambiguous,
    Unreadable,
}

/// What the app says about its own probe (`serve_telemetry`'s rule, one level down).
/// `Moved` means the probe still works via a fallback: one release of warning.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BgHealth {
    Ok,
    Moved,
    Blind,
}

#[derive(serde::Serialize)]
// camelCase is load-bearing: a snake_case key reaches the frontend as `undefined` with
// every gate green. `test/ipc.test.ts` joins the two sides.
#[serde(rename_all = "camelCase")]
pub(crate) struct BgLog {
    /// The file being read, or waited for; empty when there is no single path to name (see `tried`).
    path: String,
    /// The last `BG_LOG_TAIL` bytes, lossily decoded: the cut can land mid-character.
    text: String,
    /// Temporary after a shell starts, standing when the layout moved; `reason` tells them apart.
    missing: bool,
    /// Full length; the caller passes it back as `known_len`.
    len: u64,
    /// Length matched `known_len`, so nothing was read; exact because the log is append-only.
    unchanged: bool,
    /// `None` whenever the file was read, including the empty and unchanged cases.
    reason: BgMiss,
    /// Every candidate tested when none was found; exactly one of `path` and `tried` is the answer.
    tried: Vec<String>,
    /// Index into `bg_log_roots`, or `-1` for a scan hit or nothing; anything but `0` is a fallback.
    root_rank: i32,
    /// Found by scanning rather than by the table — the fallback is load-bearing.
    discovered: bool,
}

/// Announced on `bglog-health` on TRANSITION only; `tried` is filled for `Blind` alone.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BgLogHealth {
    state: BgHealth,
    root: String,
    rank: i32,
    discovered: bool,
    tried: Vec<String>,
}

/// A read that produced no text, with the reason it did not.
fn bg_miss(path: String, len: u64, reason: BgMiss, tried: Vec<String>) -> BgLog {
    BgLog {
        path,
        text: String::new(),
        missing: true,
        len,
        unchanged: false,
        reason,
        tried,
        root_rank: -1,
        discovered: false,
    }
}

/// The half of `read_bg_log` that already has a path the probe saw as a file; split out so
/// a test can drive it against a real file. Every failure here is `Unreadable`, not missing:
/// a permission wall is a different thing from a log that has not appeared.
fn bg_log_at(path: &std::path::Path, known_len: u64) -> BgLog {
    let disp = path.to_string_lossy().to_string();
    let miss = |len: u64| bg_miss(disp.clone(), len, BgMiss::Unreadable, Vec::new());
    let Ok(mut f) = std::fs::File::open(path) else { return miss(0) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // Nothing appended since the caller last looked; an empty log is also unchanged.
    if len == known_len {
        return BgLog {
            path: disp,
            text: String::new(),
            missing: false,
            len,
            unchanged: true,
            reason: BgMiss::None,
            tried: Vec::new(),
            root_rank: -1,
            discovered: false,
        };
    }
    if len > BG_LOG_TAIL {
        use std::io::Seek;
        if f.seek(std::io::SeekFrom::Start(len - BG_LOG_TAIL)).is_err() {
            return miss(len);
        }
    }
    let mut buf = Vec::new();
    use std::io::Read as _;
    if f.read_to_end(&mut buf).is_err() {
        return miss(len);
    }
    BgLog {
        path: disp,
        text: String::from_utf8_lossy(&buf).to_string(),
        missing: false,
        len,
        unchanged: false,
        reason: BgMiss::None,
        tried: Vec::new(),
        root_rank: -1,
        discovered: false,
    }
}

/// What this read says about the probe. Only layout states speak: not-yet, bad id and
/// unreadable are facts about one record and must not flicker the badge.
fn bg_log_health_state(log: &BgLog) -> Option<BgHealth> {
    match log.reason {
        BgMiss::None => {
            Some(if log.root_rank == 0 && !log.discovered { BgHealth::Ok } else { BgHealth::Moved })
        }
        BgMiss::NoRoot | BgMiss::Ambiguous => Some(BgHealth::Blind),
        BgMiss::NotYet | BgMiss::BadId | BgMiss::Unreadable => None,
    }
}

/// The whole read against an injected environment and memo, so tests drive the real ladder.
fn read_bg_log_at_env(
    e: &BgLogEnv,
    memo: &mut BgRootState,
    transcript: &str,
    task_id: &str,
    known_len: u64,
) -> BgLog {
    let strs = |v: Vec<std::path::PathBuf>| {
        v.into_iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()
    };
    match bg_log_resolve(e, memo, transcript, task_id, std::time::Instant::now()) {
        Ok(r) => {
            let mut log = bg_log_at(&r.path, known_len);
            log.root_rank = r.rank;
            log.discovered = r.discovered;
            log
        }
        // No address at all: there is nothing to name and nothing that was tried.
        Err(BgResolveErr::BadId) => bg_miss(String::new(), 0, BgMiss::BadId, Vec::new()),
        // The root is right and the log not yet written: the path is the answer, the candidates ride along.
        Err(BgResolveErr::NotYet(path, tried)) => {
            bg_miss(path.to_string_lossy().to_string(), 0, BgMiss::NotYet, strs(tried))
        }
        Err(BgResolveErr::NoRoot(tried)) => bg_miss(String::new(), 0, BgMiss::NoRoot, strs(tried)),
        Err(BgResolveErr::Ambiguous(hits)) => {
            bg_miss(String::new(), 0, BgMiss::Ambiguous, strs(hits))
        }
    }
}

/// `read_bg_log_at_env` plus the one announcement it can make. Generic over the
/// runtime so the mock app in the tests below emits through exactly this code.
fn read_bg_log_announced<R: tauri::Runtime>(
    app: &AppHandle<R>,
    e: &BgLogEnv,
    memo: &mut BgRootState,
    transcript: &str,
    task_id: &str,
    known_len: u64,
) -> BgLog {
    let log = read_bg_log_at_env(e, memo, transcript, task_id, known_len);
    if let Some(state) = bg_log_health_state(&log) {
        // Per record: a single slot flaps once one record resolves while another is blind.
        let who = (transcript.to_string(), task_id.to_string());
        if memo.announced.get(&who) != Some(&state) {
            memo.announced.insert(who, state);
            let _ = app.emit(
                "bglog-health",
                BgLogHealth {
                    state,
                    root: memo.root.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                    rank: log.root_rank,
                    discovered: log.discovered,
                    tried: if state == BgHealth::Blind { log.tried.clone() } else { Vec::new() },
                },
            );
        }
    }
    log
}

/// Read the tail of one background shell's log. `transcript` is the session's transcript
/// path AS IT STOOD when the shell spawned (see `BgServer` in types.ts). Errors are states
/// a row can draw. `known_len` keeps the poll cheap: the log is append-only, so an unchanged
/// length means one `metadata()` call instead of a 32 KiB read; pass 0 to force a read.
#[tauri::command]
pub(crate) fn read_bg_log(
    app: AppHandle,
    state: State<crate::AppState>,
    transcript: String,
    task_id: String,
    known_len: u64,
) -> BgLog {
    let mut memo = state.bg_root.lock().unwrap();
    read_bg_log_announced(&app, &BgLogEnv::current(), &mut memo, &transcript, &task_id, known_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- what a program reading a secret receives ----------

    #[test]
    fn ascii_input_is_never_rewritten() {
        for s in [
            "hunter2\r",
            "\x03",                     // ^C
            "\x1b[A\x1b[B\x1b[C\x1b[D", // arrows
            "\x1b[200~pasted\x1b[201~", // bracketed paste, markers included
            "\x1bOA",                   // SS3
            "~!@#$%^&*()_+-=[]{}|;':\",./<>?`\\",
        ] {
            assert_eq!(
                win32_input_encode(s),
                s,
                "rewrote an ASCII-only write: {s:?}"
            );
        }
    }

    #[test]
    fn a_non_ascii_character_becomes_a_key_record_pair() {
        assert_eq!(
            win32_input_encode("ä"),
            "\x1b[0;0;228;1;0;1_\x1b[0;0;228;0;0;1_"
        );
        // U+2713 CHECK MARK — one of the 54-of-86 sampled characters that vanish.
        assert_eq!(
            win32_input_encode("✓"),
            "\x1b[0;0;10003;1;0;1_\x1b[0;0;10003;0;0;1_"
        );
    }

    #[test]
    fn a_non_bmp_character_goes_as_its_two_surrogates() {
        assert_eq!(
            win32_input_encode("🔑"), // U+1F511 -> D83D DD11
            "\x1b[0;0;55357;1;0;1_\x1b[0;0;55357;0;0;1_\
             \x1b[0;0;56593;1;0;1_\x1b[0;0;56593;0;0;1_"
        );
    }

    #[test]
    fn escape_sequences_are_delivered_untouched() {
        assert_eq!(
            win32_input_encode("\x1b[200~é\x1b[201~"),
            "\x1b[200~\x1b[0;0;233;1;0;1_\x1b[0;0;233;0;0;1_\x1b[201~"
        );
        // An OSC's payload is the app's business, terminator included.
        assert_eq!(
            win32_input_encode("\x1b]11;rgb:00/00/00\x07"),
            "\x1b]11;rgb:00/00/00\x07"
        );
    }

    #[test]
    fn the_mode_is_latched_from_conptys_announcement() {
        let flag = AtomicBool::new(false);
        let mut carry = Vec::new();
        note_win32_input_mode(b"\x1b[?25h hello", &mut carry, &flag);
        assert!(!flag.load(Ordering::Relaxed), "latched on unrelated output");
        assert_eq!(
            pty_payload(&flag, "ä"),
            "ä",
            "should still be the untouched path"
        );

        note_win32_input_mode(b"\x1b[6n\x1b[?9001h\x1b[?1004h", &mut carry, &flag);
        assert!(flag.load(Ordering::Relaxed));
        assert_eq!(
            pty_payload(&flag, "ä"),
            "\x1b[0;0;228;1;0;1_\x1b[0;0;228;0;0;1_"
        );

        note_win32_input_mode(b"\x1b[?9001l", &mut carry, &flag);
        assert!(
            !flag.load(Ordering::Relaxed),
            "withdrawal must be honoured too"
        );
    }

    #[test]
    fn the_mode_is_latched_across_a_chunk_boundary() {
        let flag = AtomicBool::new(false);
        let mut carry = Vec::new();
        note_win32_input_mode(b"junk\x1b[?90", &mut carry, &flag);
        assert!(!flag.load(Ordering::Relaxed));
        note_win32_input_mode(b"01h more", &mut carry, &flag);
        assert!(
            flag.load(Ordering::Relaxed),
            "a split announcement was missed"
        );
    }

    // ---------- the round trip, over a real PTY ----------

    /// Set for the child half of `secret_input_reaches_the_child_byte_exact` (this binary re-run
    /// with a filter); without it the helper would wait for input in a plain `--ignored` pass.
    const CHILD_ENV: &str = "EPISKO_PTY_ROUNDTRIP_CHILD";

    /// The child: reads a secret the way a hidden prompt does and reports the exact bytes.
    /// The `#[test]` is how the parent re-enters this binary without a second executable.
    #[test]
    #[ignore = "helper process for secret_input_reaches_the_child_byte_exact"]
    fn pty_roundtrip_child() {
        if std::env::var(CHILD_ENV).is_err() {
            return;
        }
        println!("READY");
        let got = read_secret();
        // Hex, so the report survives the terminal it travels over.
        println!(
            "GOT:{}",
            got.as_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        use std::io::Write as _;
        let _ = std::io::stdout().flush();
    }

    /// Exactly what `_getwch` (Python's `getpass`) does: characters from key-DOWN records only.
    #[cfg(windows)]
    fn read_secret() -> String {
        use windows_sys::Win32::System::Console::{
            GetStdHandle, ReadConsoleInputW, INPUT_RECORD, KEY_EVENT, STD_INPUT_HANDLE,
        };
        let h = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        let mut out = String::new();
        let mut units: Vec<u16> = Vec::new();
        loop {
            let mut rec: INPUT_RECORD = unsafe { std::mem::zeroed() };
            let mut n = 0u32;
            if unsafe { ReadConsoleInputW(h, &mut rec, 1, &mut n) } == 0 || n == 0 {
                break;
            }
            if rec.EventType != KEY_EVENT as u16 {
                continue;
            }
            let k = unsafe { rec.Event.KeyEvent };
            if k.bKeyDown == 0 {
                continue; // <- the drop: a synthesized character rides on the key UP
            }
            let ch = unsafe { k.uChar.UnicodeChar };
            if ch == 0 {
                continue;
            }
            if ch == 13 || ch == 10 {
                break;
            }
            units.push(ch);
            // Decode as we go so a surrogate pair lands as one character.
            out = String::from_utf16_lossy(&units);
        }
        out
    }

    /// A canonical-mode tty hands over the line; the terminator is the tty's own, not the secret's.
    #[cfg(not(windows))]
    fn read_secret() -> String {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        line.trim_end_matches(['\r', '\n']).to_string()
    }

    /// Over a real PTY; fails on Windows without `win32_input_encode`.
    #[test]
    fn secret_input_reaches_the_child_byte_exact() {
        let cases: [(&str, &str, &str); 4] = [
            ("plain typed", "hunter2\r", "hunter2"),
            (
                "pasted",
                "\x1b[200~Correct-Horse-42\x1b[201~\r",
                "Correct-Horse-42",
            ),
            ("non-ascii", "sëcrét✓§\r", "sëcrét✓§"),
            ("no-break space", "ab\u{a0}cd\r", "ab\u{a0}cd"),
        ];
        for (name, send, want) in cases {
            let got = round_trip(send);
            // A real tty passes the paste brackets to the child; ConPTY consumes them.
            let got = got.replace("\x1b[200~", "").replace("\x1b[201~", "");
            assert_eq!(got, want, "{name}: the child did not receive what was sent");
        }
    }

    fn round_trip(send: &str) -> String {
        use std::time::{Duration, Instant};
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(std::env::current_exe().expect("current_exe"));
        cmd.arg("--exact");
        cmd.arg("pty::tests::pty_roundtrip_child");
        cmd.arg("--ignored");
        cmd.arg("--nocapture");
        cmd.env(CHILD_ENV, "1");
        cmd.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(cmd).expect("spawn child");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));
        let out = Arc::new(Mutex::new(String::new()));
        let flag = Arc::new(AtomicBool::new(false));

        let (o2, w2, f2) = (out.clone(), writer.clone(), flag.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut carry = Vec::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                note_win32_input_mode(&buf[..n], &mut carry, &f2);
                // ConPTY asks where the cursor is and stalls the child until something answers
                // (xterm.js does this in the app).
                if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                    let mut g = w2.lock().unwrap();
                    let _ = g.write_all(b"\x1b[1;1R");
                    let _ = g.flush();
                }
                o2.lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });

        let wait_for = |marker: &str| {
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs(30) {
                if out.lock().unwrap().contains(marker) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            false
        };
        assert!(
            wait_for("READY"),
            "child never started: {}",
            out.lock().unwrap()
        );
        std::thread::sleep(Duration::from_millis(200));
        {
            let payload = pty_payload(&flag, send);
            let mut g = writer.lock().unwrap();
            g.write_all(payload.as_bytes()).expect("write");
            g.flush().expect("flush");
        }
        let seen = wait_for("GOT:");
        let _ = child.kill();
        let text = out.lock().unwrap().clone();
        assert!(seen, "child never reported what it read: {text}");
        let hex: String = text
            .split("GOT:")
            .nth(1)
            .unwrap_or("")
            .chars()
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
            .collect();
        String::from_utf8_lossy(&bytes).to_string()
    }

    // ---------- scrollback ring buffer (#47 stage 2) ----------

    #[test]
    fn snapshot_plus_later_chunks_reconstructs_the_stream_exactly() {
        let chunks: Vec<&[u8]> = vec![b"alpha\n", b"beta", b"\x1b[31mred\x1b[0m\n", b"tail"];
        for split in 0..=chunks.len() {
            let mut sb = ScrollBuf::new();
            let mut emitted: Vec<(u64, &[u8])> = Vec::new();
            let mut snap = None;
            for (i, c) in chunks.iter().enumerate() {
                if i == split {
                    snap = Some(sb.snapshot());
                }
                emitted.push((sb.push(c), c));
            }
            let (mut replay, seq) = snap.unwrap_or_else(|| sb.snapshot());
            for (s, c) in &emitted {
                if *s > seq {
                    replay.extend_from_slice(c);
                }
            }
            let whole: Vec<u8> = chunks.concat();
            assert_eq!(
                replay, whole,
                "split at chunk {split} lost or doubled bytes"
            );
        }
    }

    #[test]
    fn overflow_evicts_the_front_and_keeps_the_tail() {
        let mut sb = ScrollBuf::new();
        sb.push(b"old line\n");
        sb.push(&vec![b'x'; SCROLLBACK_MAX]);
        let (bytes, _) = sb.snapshot();
        assert!(bytes.len() <= SCROLLBACK_MAX);
        assert!(
            bytes.iter().all(|&b| b == b'x'),
            "the old line must be gone, not the fill"
        );
    }

    /// Before any eviction it must NOT trim: a young session's first bytes are real output.
    #[test]
    fn snapshot_trims_to_a_newline_only_after_eviction() {
        let mut sb = ScrollBuf::new();
        sb.push(b"first\nsecond\n");
        assert_eq!(
            sb.snapshot().0,
            b"first\nsecond\n",
            "no eviction, nothing to trim"
        );

        let mut sb = ScrollBuf::new();
        // Fill so that eviction leaves a torn fragment ahead of a clean line.
        sb.push(&vec![b'a'; SCROLLBACK_MAX]);
        sb.push(b"\ncomplete line\n");
        let (bytes, _) = sb.snapshot();
        assert!(
            bytes.starts_with(b"complete line\n"),
            "the torn front must go"
        );
    }

    /// An alternate-screen repaint can be newline-free; trimming would throw away the screen.
    #[test]
    fn snapshot_keeps_a_newline_free_buffer_whole_even_after_eviction() {
        let mut sb = ScrollBuf::new();
        sb.push(&vec![b'y'; SCROLLBACK_MAX + 10]);
        let (bytes, _) = sb.snapshot();
        assert_eq!(bytes.len(), SCROLLBACK_MAX);
    }

    #[test]
    fn a_session_exiting_does_not_zero_the_rate_of_the_ones_still_running() {
        let t0 = std::time::Instant::now();
        let t1 = t0 + std::time::Duration::from_secs(1);
        let mut samples = HashMap::new();
        // First poll: both agents seen, nothing to difference against yet.
        let first = fold_io(&[(10, 50_000_000, 0), (11, 1_000, 0)], &mut samples, t0);
        assert!(
            !first.primed,
            "no previous reading, so the rate is unknown, not zero"
        );
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

    #[test]
    fn concurrent_sessions_sum_their_rates_and_totals() {
        let t0 = std::time::Instant::now();
        let t1 = t0 + std::time::Duration::from_secs(1);
        let mut samples = HashMap::new();
        fold_io(&[(1, 0, 0), (2, 0, 0)], &mut samples, t0);
        let f = fold_io(
            &[(1, 1024 * 1024, 512), (2, 1024 * 1024, 512)],
            &mut samples,
            t1,
        );
        assert!(
            (f.read_bps - 2.0 * 1024.0 * 1024.0).abs() < 1.0,
            "got {}",
            f.read_bps
        );
        assert_eq!(f.read, 2 * 1024 * 1024, "lifetime totals add too");
        assert_eq!(f.written, 1024);
    }

    #[test]
    fn retiring_a_pid_banks_its_bytes_instead_of_losing_them() {
        let now = std::time::Instant::now();
        let mut samples = HashMap::from([(7u32, (900u64, 100u64, now)), (8u32, (5u64, 6u64, now))]);
        let live = HashSet::from([8u32]);
        let mut retired = (0u64, 0u64);
        retire_missing(&mut samples, &live, &mut retired);

        assert_eq!(retired, (900, 100), "the departed pid's bytes are kept");
        assert!(!samples.contains_key(&7), "but its sample entry is dropped");
        assert!(samples.contains_key(&8), "a still-live pid is untouched");

        // And a second sweep must not double-count what it already banked.
        retire_missing(&mut samples, &live, &mut retired);
        assert_eq!(
            retired,
            (900, 100),
            "already-retired bytes are not banked twice"
        );
    }

    #[test]
    fn a_live_pane_is_never_retired_however_many_polls_it_survives() {
        let t0 = std::time::Instant::now();
        let mut samples = HashMap::new();
        let mut retired = (0u64, 0u64);
        let live = HashSet::from([42u32]);

        for poll in 0..5u64 {
            // The counter grows a little each poll, the way a real pane's does.
            let reading = [(42u32, 1_000_000 + poll * 1_000, 500 + poll)];
            retire_missing(&mut samples, &live, &mut retired);
            let f = fold_io(
                &reading,
                &mut samples,
                t0 + std::time::Duration::from_secs(poll),
            );
            assert_eq!(
                f.read,
                1_000_000 + poll * 1_000,
                "the live total is the reading"
            );
        }
        assert_eq!(retired, (0, 0), "a pane still in the roster banks nothing");

        // Only when it leaves the roster do its bytes retire — once, at the last reading.
        retire_missing(&mut samples, &HashSet::new(), &mut retired);
        assert_eq!(
            retired,
            (1_004_000, 504),
            "and then exactly its final sample"
        );
    }

    /// Per-process disk counters are easy to wire up and get a permanent zero, which renders
    /// as a confident idle gauge; this asserts the counter moves.
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

        // fsync, so the bytes are charged to disk rather than the page cache.
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

    /// A size read wrong here silently discounts the wrong number of bytes from a real day.
    #[test]
    fn version_files_reports_each_installed_binary_by_size() {
        use crate::testutil::scratch_dir;
        let dir = scratch_dir();
        std::fs::write(dir.join("2.1.232"), vec![0u8; 3 * 1024 * 1024]).unwrap();
        std::fs::write(dir.join("2.1.233"), vec![0u8; 1024 * 1024]).unwrap();
        // A subdirectory is not a version, and neither is anything inside it.
        std::fs::create_dir(dir.join("staging")).unwrap();
        std::fs::write(dir.join("staging").join("part"), vec![0u8; 512]).unwrap();

        let files = version_files_in(&dir);
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["2.1.232", "2.1.233"], "files only, sorted");
        assert_eq!(files[0].mb, 3.0, "MiB, not bytes");
        assert_eq!(files[1].mb, 1.0);

        // A missing directory answers "nothing installed": npm/Homebrew installs have none.
        assert!(version_files_in(&dir.join("nope")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The `-l -c` vs `/C` argument construction fails only at runtime in a PTY, and a run's
    /// exit code is its phase in the UI.
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

    /// The Windows `Argv` shim decision, checkable from a Mac: scripts go through cmd.exe, a `.exe` must not.
    #[test]
    fn windows_only_spawns_real_executables_directly() {
        for exe in [
            "node.exe",
            r"C:\Program Files\nodejs\node.exe",
            "PYTHON.EXE",
            "foo.com",
        ] {
            assert!(win_runs_directly(exe), "{exe} is directly executable");
        }
        for script in [
            r"C:\Program Files\nodejs\npm.cmd",
            r"C:\Program Files\nodejs\npm", // the extensionless bash script beside it
            r"C:\tools\build.bat",
            r"C:\tools\deploy.ps1",
        ] {
            assert!(!win_runs_directly(script), "{script} needs a shell");
        }
    }

    /// The whitelist is the security boundary for `spawn_external_terminal`, which interpolates
    /// this into a shell script: everything unknown must collapse to "no flag".
    #[test]
    fn permission_mode_is_whitelisted_and_the_standard_mode_passes_no_flag() {
        for m in [
            "plan",
            "acceptEdits",
            "auto",
            "dontAsk",
            "bypassPermissions",
        ] {
            assert_eq!(
                permission_mode_arg(Some(m)),
                Some(m),
                "{m} should reach the command line"
            );
        }
        // The standard mode is spelled by silence, whichever name it arrives under.
        assert_eq!(permission_mode_arg(None), None);
        assert_eq!(permission_mode_arg(Some("default")), None);
        assert_eq!(permission_mode_arg(Some("manual")), None);
        assert_eq!(permission_mode_arg(Some("")), None);
        assert_eq!(permission_mode_arg(Some("  ")), None);
        // Case matters: a near-miss must not be quietly corrected into a mode the user didn't pick.
        assert_eq!(permission_mode_arg(Some("acceptedits")), None);
        assert_eq!(permission_mode_arg(Some("PLAN")), None);
        // Nothing that could do something in a shell script gets through.
        for hostile in [
            "plan; rm -rf /",
            "plan --dangerously-skip-permissions",
            "$(id)",
            "plan\nrm x",
        ] {
            assert_eq!(
                permission_mode_arg(Some(hostile)),
                None,
                "{hostile:?} must not reach a command line"
            );
        }
    }

    /// The mode names are an external contract validated by Claude Code itself. `--version`
    /// short-circuits before any API call, so this costs no tokens; `#[ignore]`d only because
    /// it needs the real binary (a RELEASE.md step).
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
                .unwrap_or_else(|e| {
                    panic!(
                        "could not run `claude` at {claude:?}: {e}\n\
                     This test needs Claude Code installed and on PATH."
                    )
                })
        };

        for m in [
            "plan",
            "acceptEdits",
            "auto",
            "dontAsk",
            "bypassPermissions",
        ] {
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

    // ---------- where a background shell's log lives ----------
    // The oracle is a real filesystem, preferably one somebody else wrote: a table test can
    // only agree with our intent, and the intent was the bug.

    /// The uuid is synthetic on purpose: the probe tests that reach the directory scan walk the
    /// real `/tmp`, and a real id would make them depend on yesterday's sessions.
    const TR: &str =
        "/home/u/.claude/projects/E--tmp-episko-probe/5f6a1c2e-0b3d-4e5f-8a9b-1c2d3e4f5a6b.jsonl";
    const SLUG: &str = "E--tmp-episko-probe";
    const UUID: &str = "5f6a1c2e-0b3d-4e5f-8a9b-1c2d3e4f5a6b";
    const TASK: &str = "ep0kt3st9";

    /// Nothing ambient: the override base is a fixture and `sys_tmp` points nowhere, so a test
    /// passes only because of the tree it planted. The OS is an argument.
    fn fixture_env(os: ClaudeOs, base: &std::path::Path, uid: Option<u32>) -> BgLogEnv {
        BgLogEnv {
            os,
            override_tmp: Some(base.to_path_buf()),
            sys_tmp: base.join("no-such-sys-tmp"),
            xdg_runtime: None,
            uid,
        }
    }

    /// Build a real `<root>/<slug>/<uuid>/tasks/<id>.output`. `log: None` plants only the
    /// `scratchpad` Claude mkdirs at start (no `tasks/`) and returns the session dir.
    fn plant(
        root: &std::path::Path,
        slug: &str,
        uuid: &str,
        log: Option<(&str, &str)>,
    ) -> std::path::PathBuf {
        let sess = root.join(slug).join(uuid);
        match log {
            Some((id, body)) => {
                let tasks = sess.join("tasks");
                std::fs::create_dir_all(&tasks).unwrap();
                let f = tasks.join(format!("{id}.output"));
                std::fs::write(&f, body).unwrap();
                f
            }
            None => {
                std::fs::create_dir_all(sess.join("scratchpad")).unwrap();
                sess
            }
        }
    }

    /// `canonicalize` both: a scratch dir and a probed path can differ by `/private` or an 8.3
    /// short name without differing on disk.
    fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
        match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => a == b,
        }
    }

    /// All three rows from whichever machine runs. Assertions go through `file_name()`/`parent()`
    /// because a spelled-out `C:\…` literal fails on the macOS leg for the separator alone.
    #[test]
    fn bg_log_roots_carry_every_platforms_shape_in_a_per_platform_order() {
        let sys = std::path::PathBuf::from("/sys-tmp");
        let mk = |os| BgLogEnv {
            os,
            override_tmp: None,
            sys_tmp: sys.clone(),
            xdg_runtime: None,
            uid: Some(501),
        };

        let mac = bg_log_roots(&mk(ClaudeOs::Mac));
        assert_eq!(
            mac[0],
            std::path::Path::new("/tmp").join("claude-501"),
            "the macOS layout is measured, not believed: the CLI hard-codes /tmp and \
             ignores $TMPDIR entirely"
        );

        let win = bg_log_roots(&mk(ClaudeOs::Windows));
        assert_eq!(win[0].file_name().unwrap(), std::ffi::OsStr::new("claude"));
        assert_eq!(win[0].parent().unwrap(), sys, "Windows has no /tmp to hard-code");

        let unix = bg_log_roots(&mk(ClaudeOs::Unix));
        assert_eq!(unix[0], sys.join("claude-501"));

        for (os, list) in [("mac", &mac), ("windows", &win), ("unix", &unix)] {
            let names: Vec<String> = list
                .iter()
                .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
                .collect();
            assert!(
                names.iter().any(|n| n == "claude"),
                "the {os} table dropped the bare shape — a platform's row is a belief \
                 about ORDER, never a claim that the other shape cannot happen"
            );
            assert!(
                names.iter().any(|n| n == "claude-501"),
                "the {os} table dropped the suffixed shape"
            );
            let mut uniq = list.to_vec();
            uniq.sort();
            uniq.dedup();
            assert_eq!(uniq.len(), list.len(), "the {os} table probes a path twice a poll");
            assert!(list.len() <= BG_ROOT_MAX, "the {os} table is {} candidates long", list.len());
        }
    }

    #[test]
    fn bg_log_roots_let_the_env_override_replace_only_the_base() {
        let ovr = std::path::PathBuf::from("/ovr");
        let sys = std::path::PathBuf::from("/sys-tmp");
        for (os, want) in [
            (ClaudeOs::Mac, "claude-501"),
            (ClaudeOs::Unix, "claude-501"),
            (ClaudeOs::Windows, "claude"),
        ] {
            let e = BgLogEnv {
                os,
                override_tmp: Some(ovr.clone()),
                sys_tmp: sys.clone(),
                xdg_runtime: None,
                uid: Some(501),
            };
            let got = bg_log_roots(&e);
            assert_eq!(got[0], ovr.join(want), "{os:?} put the wrong shape first under the override");
            assert!(
                got.iter().any(|p| p.parent() == Some(sys.as_path())),
                "{os:?} lost its default base to the override"
            );
        }
    }

    #[test]
    fn bg_log_dir_names_never_drop_a_shape_we_cannot_observe() {
        for os in [ClaudeOs::Mac, ClaudeOs::Windows, ClaudeOs::Unix] {
            let both = bg_log_dir_names(os, Some(501));
            assert_eq!(both.len(), 2, "{os:?} named {both:?}");
            assert!(both.contains(&"claude".to_string()), "{os:?} dropped the bare shape");
            assert!(both.contains(&"claude-501".to_string()), "{os:?} dropped the suffixed shape");
            let nouid = bg_log_dir_names(os, None);
            assert_eq!(nouid.len(), 2, "{os:?} named {nouid:?} with no uid to spell");
            assert!(nouid.contains(&"claude-0".to_string()), "{os:?} dropped the suffixed shape");
            assert_eq!(
                nouid[0],
                if os == ClaudeOs::Windows { "claude" } else { "claude-0" },
                "{os:?} put the wrong shape first"
            );
        }
    }

    /// The first existing FILE wins, never the first existing ROOT. The stale root is planted
    /// FIRST at rank 0; the other way round the test passes whether or not the rule holds.
    #[test]
    fn bg_log_probe_walks_past_a_stale_root_to_the_one_holding_this_session() {
        let base = crate::testutil::scratch_dir();
        // Rank 0 on a Mac, a real directory, and holding a session that is not ours.
        plant(&base.join("claude-501"), SLUG, "11111111-2222-3333-4444-555555555555", None);
        let real = plant(
            &base.join("claude"),
            SLUG,
            UUID,
            Some((TASK, "  Local:   http://localhost:5173/\n")),
        );

        let mut memo = BgRootState::default();
        let got = bg_log_resolve(
            &fixture_env(ClaudeOs::Mac, &base, Some(501)),
            &mut memo,
            TR,
            TASK,
            std::time::Instant::now(),
        )
        .expect("the planted log must resolve");
        assert!(same_file(&got.path, &real), "resolved {:?}, not {real:?}", got.path);
        assert_eq!(got.rank, 1, "the file is at rank 1 — rank 0 is the stale root it walked past");
        assert!(!got.discovered, "the table answered, so the scan must not have run");
    }

    #[test]
    fn bg_log_probe_reports_moved_when_it_wins_below_the_first_candidate() {
        let base = crate::testutil::scratch_dir();
        let real = plant(&base.join("claude"), SLUG, UUID, Some((TASK, "listening\n")));

        let mut memo = BgRootState::default();
        let got = bg_log_resolve(
            // A Mac believes the suffixed name; this tree carries the other shape.
            &fixture_env(ClaudeOs::Mac, &base, Some(501)),
            &mut memo,
            TR,
            TASK,
            std::time::Instant::now(),
        )
        .expect("the shape we do not believe in must still resolve");
        assert!(same_file(&got.path, &real), "resolved {:?}, not {real:?}", got.path);
        assert!(got.rank > 0, "rank {} would have read as the believed layout", got.rank);
        assert!(!got.discovered, "the table still answered — this is a fallback, not a scan");
    }

    #[test]
    fn bg_log_probe_says_not_yet_when_the_session_dir_exists_but_the_log_does_not() {
        let base = crate::testutil::scratch_dir();
        plant(&base.join("claude-501"), SLUG, UUID, None);

        let mut memo = BgRootState::default();
        let got = read_bg_log_at_env(&fixture_env(ClaudeOs::Mac, &base, Some(501)), &mut memo, TR, TASK, 0);
        assert_eq!(got.reason, BgMiss::NotYet);
        assert!(got.missing, "there is genuinely no file yet");
        assert!(
            got.path.ends_with(&format!("{TASK}.output")),
            "not-yet must name the file it is waiting for, got {:?}",
            got.path
        );
        assert!(!got.tried.is_empty(), "the candidate list rides along even when one root won");
    }

    #[test]
    fn bg_log_probe_names_every_path_it_tried_when_nothing_anywhere_matches() {
        let base = crate::testutil::scratch_dir();
        let mut memo = BgRootState::default();
        let got = read_bg_log_at_env(&fixture_env(ClaudeOs::Mac, &base, Some(501)), &mut memo, TR, TASK, 0);
        assert_eq!(got.reason, BgMiss::NoRoot);
        assert_eq!(got.path, "", "a total miss has no single path to name");
        assert!(got.tried.len() >= 3, "only {} candidates were tested: {:?}", got.tried.len(), got.tried);
        for t in &got.tried {
            assert!(t.ends_with(&format!("{TASK}.output")), "{t:?} is not a candidate for this shell");
        }
    }

    #[test]
    fn bg_log_probe_refuses_to_choose_between_two_roots_holding_the_same_session() {
        let base = crate::testutil::scratch_dir();
        plant(&base.join("claude-501"), SLUG, UUID, Some((TASK, "one\n")));
        plant(&base.join("claude-0"), SLUG, UUID, Some((TASK, "the other\n")));

        // A uid matching neither, so only the scan finds both.
        let mut memo = BgRootState::default();
        let got = read_bg_log_at_env(&fixture_env(ClaudeOs::Mac, &base, Some(4242)), &mut memo, TR, TASK, 0);
        assert_eq!(got.reason, BgMiss::Ambiguous);
        assert_eq!(got.path, "", "an ambiguous probe must not name one of them anyway");
        assert_eq!(got.tried.len(), 2, "tried was {:?}", got.tried);
    }

    #[test]
    fn bg_log_probe_finds_a_log_whose_slug_is_not_the_one_we_derived() {
        let base = crate::testutil::scratch_dir();
        let real = plant(
            &base.join("claude-501"),
            "E--tmp-episko-probe-a1b2c3",
            UUID,
            Some((TASK, "  ➜  Local:   http://localhost:4321/\n")),
        );

        let mut memo = BgRootState::default();
        let got = bg_log_resolve(
            &fixture_env(ClaudeOs::Mac, &base, Some(501)),
            &mut memo,
            TR,
            TASK,
            std::time::Instant::now(),
        )
        .expect("a divergent slug must not cost us the log");
        assert!(same_file(&got.path, &real), "resolved {:?}, not {real:?}", got.path);
        assert!(got.discovered, "only the scan can find this one");
        assert_eq!(got.rank, -1, "a scan hit has no rank in the table");
    }

    #[test]
    fn bg_log_probe_remembers_the_root_it_won_on_and_drops_it_when_it_stops_holding() {
        let base = crate::testutil::scratch_dir();
        let won = base.join("claude-501");
        plant(&won, SLUG, UUID, Some((TASK, "up\n")));
        let e = fixture_env(ClaudeOs::Mac, &base, Some(501));
        let mut memo = BgRootState::default();

        let first = bg_log_resolve(&e, &mut memo, TR, TASK, std::time::Instant::now()).expect("resolves");
        assert!(!first.from_memo, "nothing was remembered yet");
        assert_eq!(memo.root.as_deref(), Some(won.as_path()));

        let again = bg_log_resolve(&e, &mut memo, TR, TASK, std::time::Instant::now()).expect("resolves");
        assert!(again.from_memo, "the second look must not walk the table again");

        // The root moves to the shape one row down, so there is still a right answer.
        std::fs::rename(&won, base.join("claude")).unwrap();
        let after = bg_log_resolve(&e, &mut memo, TR, TASK, std::time::Instant::now())
            .expect("the probe must re-walk the table rather than defend a stale memo");
        assert!(!after.from_memo, "the memo answered for a root that no longer holds the log");
        assert_eq!(after.rank, 1, "it should have landed on the other shape");
        assert_eq!(memo.root.as_deref(), Some(base.join("claude").as_path()));
    }

    #[test]
    fn bg_log_probe_scans_at_most_once_a_minute_however_many_records_are_blind() {
        let base = crate::testutil::scratch_dir();
        let e = fixture_env(ClaudeOs::Mac, &base, Some(501));
        let mut memo = BgRootState::default();
        let now = std::time::Instant::now();
        let first = bg_log_resolve(&e, &mut memo, TR, TASK, now);
        assert!(matches!(first, Err(BgResolveErr::NoRoot(_))), "the empty base is blind");
        assert_eq!(memo.last_scan, Some(now), "the first read must scan");

        // The log lands under a root name no table candidate can spell, so ONLY the scan can see
        // it; that is what makes the throttle observable.
        let planted = plant(&base.join("claude-9999"), SLUG, UUID, Some((TASK, "up\n")));
        for i in 0..5 {
            let r = bg_log_resolve(&e, &mut memo, TR, TASK, now);
            assert!(
                matches!(r, Err(BgResolveErr::NoRoot(_))),
                "read {i} scanned inside the window and found {planted:?}"
            );
            assert_eq!(memo.last_scan, Some(now), "read {i} restamped the window");
        }
        // ...and it comes back: a throttle that latched could never recover.
        let later = now + BG_SCAN_EVERY;
        let got = bg_log_resolve(&e, &mut memo, TR, TASK, later)
            .expect("the scan must resume once its window is up");
        assert!(same_file(&got.path, &planted), "resolved {:?}, not {planted:?}", got.path);
        assert!(got.discovered, "only the scan can reach a root the table cannot spell");
        assert_eq!(memo.last_scan, Some(later), "the scan never resumed after its window");
    }

    /// A log only the SCAN can find must be cheap to re-find, or every poll inside the scan's
    /// minute reports `noRoot` about a file already read.
    #[test]
    fn bg_log_probe_re_finds_a_scanned_log_without_waiting_for_the_next_scan() {
        let base = crate::testutil::scratch_dir();
        let real = plant(
            &base.join("claude-501"),
            "E--tmp-episko-probe-a1b2c3",
            UUID,
            Some((TASK, "up\n")),
        );
        let e = fixture_env(ClaudeOs::Mac, &base, Some(501));
        let mut memo = BgRootState::default();
        let now = std::time::Instant::now();

        let first = bg_log_resolve(&e, &mut memo, TR, TASK, now).expect("the scan finds it");
        assert!(first.discovered, "the table cannot spell this slug");

        // Four seconds later: the next poll, well inside the scan's window.
        let again = bg_log_resolve(&e, &mut memo, TR, TASK, now + std::time::Duration::from_secs(4))
            .expect("the memo must answer for a log only the scan could have found");
        assert!(same_file(&again.path, &real), "resolved {:?}, not {real:?}", again.path);
        assert!(again.from_memo, "the second look re-scanned instead of remembering");
        assert_eq!(memo.last_scan, Some(now), "it scanned again inside the window");
    }

    /// Declining to scan is not evidence the remembered root stopped holding; the memo is
    /// process-wide, so one blind record must not send the fleet back through the table.
    #[test]
    fn a_throttled_scan_leaves_the_root_the_rest_of_the_fleet_is_using_alone() {
        const GONE: &str =
            "/home/u/.claude/projects/E--tmp-episko-gone/7a8b9c0d-1e2f-4a5b-8c9d-0e1f2a3b4c5d.jsonl";
        let base = crate::testutil::scratch_dir();
        let won = base.join("claude-501");
        plant(&won, SLUG, UUID, Some((TASK, "up\n")));
        let e = fixture_env(ClaudeOs::Mac, &base, Some(501));
        let mut memo = BgRootState::default();
        let now = std::time::Instant::now();

        // A record with nothing anywhere: it scans, finds nothing, and stamps the window.
        let miss = bg_log_resolve(&e, &mut memo, GONE, TASK, now);
        assert!(matches!(miss, Err(BgResolveErr::NoRoot(_))), "the gone session must be blind");
        assert_eq!(memo.last_scan, Some(now));

        // A healthy record resolves off the table, and now the fleet has a root.
        let sec = std::time::Duration::from_secs(1);
        bg_log_resolve(&e, &mut memo, TR, TASK, now + 4 * sec).expect("resolves");
        assert_eq!(memo.root.as_deref(), Some(won.as_path()));

        // The blind record polls again inside the window, so the scan declines to run.
        let throttled = bg_log_resolve(&e, &mut memo, GONE, TASK, now + 8 * sec);
        assert!(matches!(throttled, Err(BgResolveErr::NoRoot(_))), "still blind, still honest");
        assert_eq!(
            memo.root.as_deref(),
            Some(won.as_path()),
            "a scan the throttle refused to run dropped the root every other record resolves through"
        );

        let again = bg_log_resolve(&e, &mut memo, TR, TASK, now + 12 * sec).expect("resolves");
        assert!(again.from_memo, "the healthy record paid for somebody else's throttled miss");
    }

    #[test]
    fn bg_log_serializes_the_keys_the_frontend_declares() {
        let base = crate::testutil::scratch_dir();
        let mut memo = BgRootState::default();
        let got = read_bg_log_at_env(&fixture_env(ClaudeOs::Mac, &base, Some(501)), &mut memo, TR, TASK, 0);

        let v = serde_json::to_value(&got).expect("BgLog serializes");
        let obj = v.as_object().expect("BgLog is an object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            ["discovered", "len", "missing", "path", "reason", "rootRank", "text", "tried", "unchanged"]
        );
        assert!(keys.iter().all(|k| !k.contains('_')), "a snake_case key reaches the frontend as undefined");
        // Wire vocabulary, not a Rust identifier: `NoRoot` would match nothing in `BgMissReason`.
        assert_eq!(v["reason"], serde_json::json!("noRoot"));
    }

    /// `bglog-health` fires on TRANSITION only: one event per poll per blind record would
    /// empty the debug console's 400-entry ring in a minute.
    #[test]
    fn a_blind_probe_announces_itself_once_rather_than_every_poll() {
        use tauri::Listener;
        let app = tauri::test::mock_app();
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = heard.clone();
        app.listen("bglog-health", move |e| sink.lock().unwrap().push(e.payload().to_string()));

        let base = crate::testutil::scratch_dir();
        let e = fixture_env(ClaudeOs::Mac, &base, Some(501));
        let mut memo = BgRootState::default();
        for i in 0..5 {
            let got = read_bg_log_announced(app.handle(), &e, &mut memo, TR, TASK, 0);
            assert_eq!(got.reason, BgMiss::NoRoot, "poll {i}");
        }
        let blind = heard.lock().unwrap().clone();
        assert_eq!(blind.len(), 1, "five blind polls announced themselves {} times", blind.len());
        let ev: serde_json::Value = serde_json::from_str(&blind[0]).expect("the event is JSON");
        assert_eq!(ev["state"], "blind");
        assert!(
            ev["tried"].as_array().map(|a| a.len()).unwrap_or(0) >= 3,
            "a blind announcement must carry where it looked: {ev}"
        );

        // ...and coming back is a transition too, or the badge would never clear.
        plant(&base.join("claude-501"), SLUG, UUID, Some((TASK, "up\n")));
        let got = read_bg_log_announced(app.handle(), &e, &mut memo, TR, TASK, 0);
        assert!(!got.missing, "the planted log must read");
        let all = heard.lock().unwrap().clone();
        assert_eq!(all.len(), 2, "recovery was not announced");
        let back: serde_json::Value = serde_json::from_str(&all[1]).expect("the event is JSON");
        assert_eq!(back["state"], "ok");
        assert_eq!(back["rank"], 0);
    }

    #[test]
    fn two_records_in_different_states_do_not_re_announce_each_other_every_poll() {
        use tauri::Listener;
        const GONE: &str =
            "/home/u/.claude/projects/E--tmp-episko-gone/7a8b9c0d-1e2f-4a5b-8c9d-0e1f2a3b4c5d.jsonl";
        let app = tauri::test::mock_app();
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = heard.clone();
        app.listen("bglog-health", move |e| sink.lock().unwrap().push(e.payload().to_string()));

        let base = crate::testutil::scratch_dir();
        plant(&base.join("claude-501"), SLUG, UUID, Some((TASK, "up\n")));
        let e = fixture_env(ClaudeOs::Mac, &base, Some(501));
        let mut memo = BgRootState::default();
        // The same task id under two sessions: an id is unique only within the session that minted it.
        for i in 0..4 {
            let ok = read_bg_log_announced(app.handle(), &e, &mut memo, TR, TASK, 0);
            assert!(!ok.missing, "poll {i}: the planted log must read");
            let blind = read_bg_log_announced(app.handle(), &e, &mut memo, GONE, TASK, 0);
            assert_eq!(blind.reason, BgMiss::NoRoot, "poll {i}");
        }

        let all = heard.lock().unwrap().clone();
        assert_eq!(
            all.len(),
            2,
            "eight reads of two steady records announced themselves {} times: {all:?}",
            all.len()
        );
        let states: Vec<String> =
            all.iter().map(|s| serde_json::from_str::<serde_json::Value>(s).unwrap()["state"].to_string()).collect();
        assert_eq!(states, vec!["\"ok\"".to_string(), "\"blind\"".to_string()]);
    }

    #[test]
    fn bg_log_health_says_moved_while_it_is_still_working() {
        use tauri::Listener;
        let app = tauri::test::mock_app();
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = heard.clone();
        app.listen("bglog-health", move |e| sink.lock().unwrap().push(e.payload().to_string()));

        let base = crate::testutil::scratch_dir();
        plant(&base.join("claude"), SLUG, UUID, Some((TASK, "up\n")));
        let mut memo = BgRootState::default();
        let got = read_bg_log_announced(
            app.handle(),
            &fixture_env(ClaudeOs::Mac, &base, Some(501)),
            &mut memo,
            TR,
            TASK,
            0,
        );
        assert!(!got.missing, "the log resolved — this is a working state");

        let all = heard.lock().unwrap().clone();
        assert_eq!(all.len(), 1, "a working fallback said nothing");
        let ev: serde_json::Value = serde_json::from_str(&all[0]).expect("the event is JSON");
        assert_eq!(ev["state"], "moved");
        assert_eq!(ev["rank"], 1);
        assert_eq!(ev["discovered"], false);
    }

    #[test]
    fn bg_log_path_refuses_a_task_id_that_is_not_one() {
        let root = std::path::Path::new("/tmproot/claude-501");
        let tr = "/home/u/.claude/projects/slug/uuid.jsonl";
        for bad in ["", "..", "../../etc/passwd", "a/b", r"a\b", "a.output", "a b"] {
            assert!(
                bg_log_path(root, tr, bad).is_none(),
                "{bad:?} was accepted as a task id and would have escaped the tasks dir"
            );
        }
        assert!(bg_log_path(root, tr, "bs0hhu7b4").is_some(), "a real id must still resolve");
    }

    #[test]
    fn bg_log_path_refuses_a_transcript_without_both_halves() {
        let root = std::path::Path::new("/tmproot/claude-501");
        for bad in ["", "uuid.jsonl", "/"] {
            assert!(bg_log_path(root, bad, "bs0hhu7b4").is_none(), "{bad:?} resolved");
        }
    }

    #[test]
    fn read_bg_log_returns_the_end_of_a_long_log() {
        let dir = crate::testutil::scratch_dir();
        let f = dir.join("long.output");
        let mut body = "x".repeat(BG_LOG_TAIL as usize + 4096);
        body.push_str("\nLocal:   http://localhost:5555/\n[exited with code 0]\n");
        std::fs::write(&f, &body).unwrap();

        let got = bg_log_at(&f, 0);
        assert!(!got.missing && !got.unchanged);
        assert_eq!(got.reason, BgMiss::None, "a file that read has no reason to give");
        assert!(got.text.len() as u64 <= BG_LOG_TAIL, "the whole file came back, not its tail");
        assert_eq!(got.len, body.len() as u64, "the caller needs the FULL length to gate on");
        assert!(got.text.contains("[exited with code 0]"), "the sentinel must survive the cut");
        assert!(got.text.contains("http://localhost:5555/"), "the URL must survive the cut");
    }

    #[test]
    fn read_bg_log_skips_the_read_only_until_something_is_appended() {
        let dir = crate::testutil::scratch_dir();
        let f = dir.join("dev.output");
        std::fs::write(&f, "  Local:   http://localhost:5555/\n").unwrap();

        let first = bg_log_at(&f, 0);
        assert!(!first.unchanged, "a first look must read");
        assert!(first.text.contains("5555"));

        // The poll's steady state: the log has not moved, so nothing is read.
        let again = bg_log_at(&f, first.len);
        assert!(again.unchanged, "an unmoved log must not be re-read");
        assert!(again.text.is_empty(), "unchanged must carry no text for the caller to fold");
        assert_eq!(again.len, first.len);

        // ...and the moment it does move, the gate opens.
        std::fs::write(&f, "  Local:   http://localhost:5555/\n[exited with code 1]\n").unwrap();
        let after = bg_log_at(&f, first.len);
        assert!(!after.unchanged, "an appended log must be read again");
        assert!(after.text.contains("[exited with code 1]"), "the sentinel must reach the caller");
    }

    #[test]
    fn read_bg_log_treats_an_empty_log_as_unchanged_not_missing() {
        let dir = crate::testutil::scratch_dir();
        let f = dir.join("silent.output");
        std::fs::write(&f, "").unwrap();
        let got = bg_log_at(&f, 0);
        assert!(!got.missing, "the file is there");
        assert!(got.unchanged && got.len == 0);
        assert_eq!(got.reason, BgMiss::None, "an empty log is not a missing one");
    }

    /// The oracle is a tree Anthropic wrote: it searches this machine for a log Claude Code
    /// produced, through bases written out independently (NEVER via `bg_log_roots`), and asks
    /// the real resolver. In the default suite so a moved layout is found the day it moves;
    /// a machine with no witness skips out loud.
    #[test]
    fn read_bg_log_finds_a_log_claude_code_actually_wrote() {
        struct Witness {
            slug: String,
            uuid: String,
            id: String,
            log: std::path::PathBuf,
            when: std::time::SystemTime,
        }

        let mut bases: Vec<std::path::PathBuf> =
            vec![std::path::PathBuf::from("/tmp"), std::env::temp_dir()];
        for k in ["CLAUDE_CODE_TMPDIR", "XDG_RUNTIME_DIR"] {
            if let Some(v) = std::env::var_os(k).filter(|v| !v.is_empty()) {
                bases.push(std::path::PathBuf::from(v));
            }
        }
        let projects = std::path::PathBuf::from(crate::platform::home_dir()).join(".claude").join("projects");

        let mut found: Vec<Witness> = Vec::new();
        for base in &bases {
            let Ok(entries) = std::fs::read_dir(base) else { continue };
            for ent in entries.flatten() {
                let raw = ent.file_name();
                let name = raw.to_string_lossy();
                if name != "claude" && !name.starts_with("claude-") {
                    continue;
                }
                let Ok(slugs) = std::fs::read_dir(ent.path()) else { continue };
                for sd in slugs.flatten() {
                    let Some(slug) = sd.file_name().to_str().map(str::to_string) else { continue };
                    let Ok(sessions) = std::fs::read_dir(sd.path()) else { continue };
                    for ud in sessions.flatten() {
                        let Some(uuid) = ud.file_name().to_str().map(str::to_string) else { continue };
                        // A log with its transcript beside it; half a pair proves nothing about the join.
                        if !projects.join(&slug).join(format!("{uuid}.jsonl")).is_file() {
                            continue;
                        }
                        let Ok(logs) = std::fs::read_dir(ud.path().join("tasks")) else { continue };
                        for l in logs.flatten() {
                            let log = l.path();
                            if log.extension().and_then(|e| e.to_str()) != Some("output") {
                                continue;
                            }
                            let Some(id) = log.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
                                continue;
                            };
                            let when = l
                                .metadata()
                                .and_then(|m| m.modified())
                                .unwrap_or(std::time::UNIX_EPOCH);
                            found.push(Witness { slug: slug.clone(), uuid: uuid.clone(), id, log, when });
                        }
                    }
                }
            }
        }
        if found.is_empty() {
            eprintln!(
                "skipping: no <root>/<slug>/<uuid>/tasks/*.output with a matching transcript under \
                 {bases:?} — this machine has no evidence to check"
            );
            return;
        }
        found.sort_by_key(|w| std::cmp::Reverse(w.when));

        // The rank-0 claim is about the AMBIENT layout: made once, about the newest log, and
        // only when nothing has re-pointed the base.
        let pinned = std::env::var_os("CLAUDE_CODE_TMPDIR").is_some();
        let mut matched = 0usize;
        for (i, w) in found.iter().enumerate() {
            let transcript = projects.join(&w.slug).join(format!("{}.jsonl", w.uuid));
            let mut memo = BgRootState::default();
            let got = read_bg_log_at_env(
                &BgLogEnv::current(),
                &mut memo,
                &transcript.to_string_lossy(),
                &w.id,
                0,
            );
            match got.reason {
                BgMiss::NoRoot => panic!(
                    "Claude Code wrote {:?} and the probe looked in {:?}. The layout has moved and \
                     every background-shell row on this platform is blind.",
                    w.log, got.tried
                ),
                // Refusing to choose is the designed answer; the real file must be among those seen.
                BgMiss::Ambiguous => {
                    assert!(
                        got.tried.iter().any(|t| same_file(std::path::Path::new(t), &w.log)),
                        "the probe found {:?} ambiguous and {:?} was not among them",
                        got.tried,
                        w.log
                    );
                    eprintln!("note: {:?} resolved ambiguously across {} roots", w.log, got.tried.len());
                    matched += 1;
                }
                _ => {
                    assert!(
                        same_file(std::path::Path::new(&got.path), &w.log),
                        "the probe resolved {:?}, but Claude Code wrote {:?}",
                        got.path,
                        w.log
                    );
                    if i == 0 {
                        if pinned {
                            eprintln!(
                                "note: $CLAUDE_CODE_TMPDIR is set, so rank {} is not the ambient layout",
                                got.root_rank
                            );
                        } else {
                            assert_eq!(
                                got.root_rank, 0,
                                "the newest log Claude Code wrote resolved at rank {} — the believed \
                                 layout is no longer the real one, and only the fallback is carrying it",
                                got.root_rank
                            );
                        }
                    }
                    matched += 1;
                }
            }
        }
        eprintln!("bg log round-trip: matched {matched} log(s) Claude Code wrote");
    }

    /// The only way the WINDOWS row of `bg_log_dir_names` stops being a belief: run the real
    /// binary and look. Spawned, polled and killed, never waited on, so a renamed
    /// `CLAUDE_CODE_MAX_RETRIES` cannot hang the pass. `EPISKO_REQUIRE_CLAUDE` makes not-installed
    /// a failure; the name prefix keeps it out of the token-spending `claude_cli_still_` filter.
    #[test]
    #[ignore = "runs the real `claude` binary (no tokens, no auth) — `cargo test -- --ignored`"]
    fn claude_layout_still_names_its_temp_dir_the_way_we_probe_for_it() {
        let root = crate::testutil::scratch_dir();
        let cwd = crate::testutil::scratch_dir();
        let claude = resolve_claude();
        let required = std::env::var_os("EPISKO_REQUIRE_CLAUDE").is_some_and(|v| !v.is_empty());
        let spawned = std::process::Command::new(&claude)
            .current_dir(&cwd)
            .args(["-p", "noop", "--strict-mcp-config", "--mcp-config", r#"{"mcpServers":{}}"#])
            .env("PATH", augmented_path())
            .env("CLAUDE_CODE_TMPDIR", &root)
            .env("CLAUDE_CODE_MAX_RETRIES", "0")
            .env("ANTHROPIC_BASE_URL", "http://127.0.0.1:1")
            .env("ANTHROPIC_API_KEY", "not-a-real-key")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            // Not installed is a skip unless the runner says it installed it. On Windows an npm
            // global install leaves an sh shim CreateProcessW cannot start: a different bug report.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !required => {
                eprintln!("skipping: `claude` is not installed (looked at {claude:?})");
                return;
            }
            Err(e) => panic!(
                "could not launch `claude` at {claude:?}: {e}. This machine was told it has the \
                 CLI, so the layout stayed unobserved — which is not the same thing as unchanged."
            ),
        };

        // Poll for the tree: the root appears at session start, the exit long after.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let appeared = || {
            std::fs::read_dir(&root).map(|d| d.flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n == "claude" || n.starts_with("claude-")
            }))
        };
        while std::time::Instant::now() < deadline && !appeared().unwrap_or(false) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();

        let mut made: Vec<String> = std::fs::read_dir(&root)
            .expect("the pinned CLAUDE_CODE_TMPDIR must still be there")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n == "claude" || n.starts_with("claude-"))
            .collect();
        made.sort();
        assert_eq!(
            made.len(),
            1,
            "expected exactly one `claude*` directory under the pinned root {root:?} within 30s, \
             got {made:?} — an empty list means the session never got as far as making one"
        );
        eprintln!("claude layout: {} created {:?}", std::env::consts::OS, made[0]);
        let names = bg_log_dir_names(ClaudeOs::current(), current_uid());
        assert!(
            names.contains(&made[0]),
            "Claude Code created {:?} under its temp root and the probe only knows {names:?}. Every \
             background-shell row on this platform is blind, and this is the machine that can say so.",
            made[0]
        );
    }
    // ---------- the agent table ----------
    // A wrong `bin` compiles and ships; the only symptom is an agent missing from the picker.

    #[test]
    fn agents_are_sorted_by_label() {
        // The picker renders in table order and does not sort.
        let labels: Vec<String> = AGENTS.iter().map(|a| a.label.to_lowercase()).collect();
        let mut sorted = labels.clone();
        sorted.sort();
        assert_eq!(
            labels, sorted,
            "AGENTS is the picker's order — keep it sorted by label"
        );
    }

    #[test]
    fn agent_ids_and_labels_are_unique_and_populated() {
        let mut ids = std::collections::HashSet::new();
        let mut labels = std::collections::HashSet::new();
        let mut marks = std::collections::HashSet::new();
        for a in AGENTS {
            assert!(
                !a.id.is_empty() && !a.label.is_empty() && !a.bin.is_empty() && !a.mark.is_empty(),
                "{} has an empty field",
                a.id
            );
            // The id is the wire value and the pane's stored key: a stable slug, not a display name.
            assert!(
                a.id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
                "agent id {:?} must be a lowercase ascii slug",
                a.id
            );
            assert!(ids.insert(a.id), "duplicate agent id {:?}", a.id);
            assert!(
                labels.insert(a.label),
                "duplicate agent label {:?}",
                a.label
            );
            // Compatibility field: well-formed and collision-free even though frontends paint an SVG.
            assert_eq!(
                a.mark.chars().count(),
                2,
                "agent mark {:?} must be two characters",
                a.mark
            );
            assert!(
                marks.insert(a.mark),
                "duplicate agent mark {:?} ({})",
                a.mark,
                a.id
            );
        }
    }

    #[test]
    fn claude_is_not_in_the_agent_table() {
        // Launching claude here would strip the instrumentation the cockpit is built on.
        assert!(
            agent_spec("claude").is_none() && !AGENTS.iter().any(|a| a.bin == "claude"),
            "claude belongs to spawn_claude, which instruments it — see the AGENTS comment"
        );
    }

    #[test]
    fn provider_manifest_names_real_agents_and_known_capabilities() {
        const KNOWN: &[&str] = &[
            "session-state",
            "activity",
            "context",
            "usage",
            "permissions",
            "resume",
            "history",
            "external-terminal",
            "launch-permissions",
        ];
        let providers = provider_manifest();
        for (id, provider) in &providers {
            assert!(
                id == "claude" || agent_spec(id).is_some(),
                "provider manifest names {id:?}, which is absent from AGENTS"
            );
            assert!(
                provider.capabilities.is_empty()
                    || provider.capabilities.iter().any(|c| c == "session-state"),
                "integrated provider {id:?} must advertise session-state"
            );
            for capability in &provider.capabilities {
                assert!(
                    KNOWN.contains(&capability.as_str()),
                    "provider {id:?} advertises unknown capability {capability:?}"
                );
            }
        }
    }

    #[test]
    fn spawn_agent_only_answers_to_ids_in_the_table() {
        for a in AGENTS {
            assert_eq!(agent_spec(a.id).map(|s| s.bin), Some(a.bin));
        }
        // A label, a binary name or a stale id must not fall through to launching something.
        for bogus in ["", "Codex", "cursor-agent", "claude", "opencode2"] {
            assert!(
                agent_spec(bogus).is_none(),
                "{bogus:?} should not resolve to an agent"
            );
        }
    }

    #[test]
    fn list_agents_reports_the_whole_table_and_marks_what_it_found() {
        // Machine-dependent (CI has none installed), so assert shape: the list is the WHOLE table.
        let list = list_agents();
        assert_eq!(list.len(), AGENTS.len(), "list_agents must not filter");
        for info in list {
            let spec = agent_spec(info.id).expect("list_agents invented an id");
            assert_eq!(
                (spec.label, spec.bin, spec.mark),
                (info.label, info.bin, info.mark)
            );
            // A `Some` path is a promise the agent will start, so it must be a real file.
            if let Some(p) = &info.path {
                assert!(
                    std::path::Path::new(p).is_file(),
                    "{} reported {p}, not a file",
                    info.id
                );
            }
        }
    }

    #[test]
    fn resolve_cli_says_no_to_something_nobody_ships() {
        assert!(resolve_cli("episko-definitely-not-a-real-binary").is_none());
    }
}
