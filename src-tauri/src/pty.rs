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

    let scroll = Arc::new(Mutex::new(ScrollBuf::new()));
    let win32 = Arc::new(AtomicBool::new(false));
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session { master: pair.master, writer, killer, pid: child_pid, workdir, kind: "agent", provider: Some("claude".into()), scrollback: scroll.clone(), win32_input: win32.clone() },
    );

    stream_pty_session(app, session_id, reader, child, child_pid, scroll, win32);
    Ok(())
}

/// ConPTY's request for win32 input records, and its withdrawal. ConPTY emits the
/// first thing in its first output chunk; nothing in a PTY on any other OS ever
/// sends either.
const WIN32_INPUT_ON: &[u8] = b"\x1b[?9001h";
const WIN32_INPUT_OFF: &[u8] = b"\x1b[?9001l";

/// Latch `ESC[?9001h` / `ESC[?9001l` out of a chunk of PTY output. `carry` holds the
/// tail of the previous chunk so a mode string split across two reads is still seen —
/// missing it is silent, and degrades exactly to the bug below.
///
/// Compiled everywhere so it is type-checked and unit-tested from a Mac (CLAUDE.md's
/// cfg-flip trick); only the Windows reader calls it.
#[cfg_attr(not(windows), allow(dead_code))]
fn note_win32_input_mode(chunk: &[u8], carry: &mut Vec<u8>, flag: &AtomicBool) {
    let mut buf = std::mem::take(carry);
    buf.extend_from_slice(chunk);
    // Last one wins: a chunk could carry both (it never does in practice).
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

/// Re-encode a keystroke for a ConPTY that asked for win32 input records.
///
/// **The bug this exists for.** ConPTY does not hand a terminal's bytes to the child:
/// it *parses* them and synthesizes console key events. For a character it can best-fit
/// into the console's OEM code page, conhost synthesizes an **Alt+numpad** sequence —
/// and the character rides on the Alt **key-up** record. `_getwch`, the CRT call behind
/// Python's `getpass` — so behind any script that asks you for a key — takes characters
/// from key-**down** records only, so those characters are dropped, silently, out of a
/// secret nobody can see. (Not every reader: gpg's own prompt and .NET's `Read-Host
/// -AsSecureString` were both measured intact. The CRT path is the one that loses.)
/// Measured on this machine, 54 of 86
/// sampled non-ASCII characters vanish that way, `§ ° ± ¿ – — ' ' " " • ✓` and, most
/// dangerously, `U+00A0` NO-BREAK SPACE, which is what a passphrase copied out of a
/// document carries. The failure is indistinguishable from a wrong secret: gpg reports
/// "Bad session key", the same error it gives for a genuinely wrong passphrase, and the
/// hunt starts in the secret store instead of the terminal.
///
/// Windows Terminal never hits this because it answers `ESC[?9001h` with key records
/// instead of text — which is exactly why the same key works there and not here.
/// So do we, for the characters at risk.
///
/// **Only non-ASCII is re-encoded.** All 95 printable ASCII characters round-trip
/// byte-exactly through the VT path (verified), so leaving them alone keeps every
/// existing key path — `^C`, arrows, Claude Code's TUI chords, bracketed paste — on
/// bytes identical to today's. An escape sequence is copied verbatim for the same
/// reason: its parameters are ours to deliver, not ours to re-encode.
///
/// Non-BMP characters go as their two UTF-16 surrogates, one record pair each, which
/// is what the mode's `Uc` field is: a UTF-16 code unit, not a scalar value.
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
            for unit in c.encode_utf16(&mut buf) {
                // Vk and Sc are 0: we know the character, not which key produced it,
                // and that is precisely what conhost needs to stop guessing.
                out.push_str(&format!("\x1b[0;0;{unit};1;0;1_"));
                out.push_str(&format!("\x1b[0;0;{unit};0;0;1_"));
            }
        }
    }
    out
}

/// What actually goes down the pipe for one write. Borrowed unless ConPTY asked for
/// records, so the common path writes the caller's bytes with no copy and no rewrite.
/// Split out of `write_pty` so the round-trip test drives the real decision rather
/// than a second copy of it.
fn pty_payload<'a>(win32_input: &AtomicBool, data: &'a str) -> std::borrow::Cow<'a, str> {
    if win32_input.load(Ordering::Relaxed) {
        std::borrow::Cow::Owned(win32_input_encode(data))
    } else {
        std::borrow::Cow::Borrowed(data)
    }
}

/// Copy one escape sequence through untouched, ESC already emitted. Belt and braces:
/// every sequence a terminal sends is ASCII, so the `is_ascii` arm above would pass it
/// through anyway — but that is a property of today's key rules, and this makes "we
/// never rewrite the inside of a sequence" a rule of the encoder instead.
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
        // ESC O A (SS3 arrows), ESC b (alt-chords), ESC ESC …: one byte, and whatever
        // follows is an ordinary character again.
        Some(_) => out.push(it.next().unwrap()),
        None => {}
    }
}

/// The recent raw output of one PTY, kept so a pane rebuilt after a webview reload
/// does not start blank (#47 stage 2). Bounded — this is scrollback, not a
/// transcript — and grown only as used, so an idle fleet pays nothing up front.
///
/// `seq` counts chunks, and it is what makes adoption replay exact: the reader
/// appends and takes the seq under this lock, then emits the chunk tagged with it,
/// and `read_scrollback` snapshots bytes-plus-seq under the same lock. So a chunk
/// with `seq <= snapshot.seq` is *inside* the snapshot and one above it is not —
/// without that, a chunk emitted around the snapshot either duplicates or goes
/// missing in the rebuilt pane, and both corrupt the REPL's screen state.
pub(crate) struct ScrollBuf {
    buf: VecDeque<u8>,
    seq: u64,
    evicted: bool,
}

pub(crate) const SCROLLBACK_MAX: usize = 256 * 1024;

impl ScrollBuf {
    pub(crate) fn new() -> Self {
        ScrollBuf { buf: VecDeque::new(), seq: 0, evicted: false }
    }
    /// Append one reader chunk and return the seq that names it.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> u64 {
        self.buf.extend(chunk.iter().copied());
        if self.buf.len() > SCROLLBACK_MAX {
            self.buf.drain(..self.buf.len() - SCROLLBACK_MAX);
            self.evicted = true;
        }
        self.seq += 1;
        self.seq
    }
    /// Everything retained, plus the seq of the last chunk it contains. Once the
    /// front has been evicted the buffer starts mid-line — likely mid escape
    /// sequence, which would eat characters up to the next terminator on replay —
    /// so it is trimmed to the first newline. A stream with no newline at all
    /// (one alternate-screen repaint) is kept whole rather than dropped.
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

/// Spawn the reader (PTY output → `pty-output`) and reaper (`pty-exit` + session
/// cleanup) threads shared by every embedded PTY pane — a `claude` session or a
/// plain shell. `child_pid` is removed from `owned_pids` on exit (a no-op for a
/// shell, which was never inserted there). `scroll` is the same buffer the session
/// in `AppState` holds; the reader appends before it emits (see `ScrollBuf`).
fn stream_pty_session(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    child_pid: Option<u32>,
    scroll: Arc<Mutex<ScrollBuf>>,
    win32_input: Arc<AtomicBool>,
) {
    // Nothing on a real tty ever asks for win32 input records, so the flag stays as
    // `write_pty` found it: false, i.e. bytes through untouched.
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
                    // Windows only: on every other OS nothing ever sends this, and the
                    // output path is hot enough not to pay for a scan that can't hit.
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
    let scroll = Arc::new(Mutex::new(ScrollBuf::new()));
    let win32 = Arc::new(AtomicBool::new(false));
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session { master: pair.master, writer, killer, pid: child_pid, workdir, kind: "shell", provider: None, scrollback: scroll.clone(), win32_input: win32.clone() },
    );
    stream_pty_session(app, session_id, reader, child, child_pid, scroll, win32);
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
    let scroll = Arc::new(Mutex::new(ScrollBuf::new()));
    let win32 = Arc::new(AtomicBool::new(false));
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        Session { master: pair.master, writer, killer, pid: child_pid, workdir, kind: "task", provider: None, scrollback: scroll.clone(), win32_input: win32.clone() },
    );
    stream_pty_session(app, session_id, reader, child, child_pid, scroll, win32);
    Ok(())
}

// ---------- other people's agents ----------

/// One coding-agent CLI Episko will drop into a pane.
///
/// `bin` is the interactive executable's *bare* name, resolved against the augmented
/// PATH at detection time rather than stored as an install path: these are twenty-one
/// third-party tools with twenty-one installers (npm, brew, curl-to-`~/.local/bin`,
/// bun, a vendor MSI) and no two agree on a prefix, so the PATH the user's own shell
/// has is the only thing that knows where any of them landed.
///
/// One spelling covers both OSes. `win_resolve` walks PATHEXT, so `cursor-agent`
/// finds `cursor-agent.cmd` without a second field to keep in step.
struct AgentSpec {
    id: &'static str,
    label: &'static str,
    bin: &'static str,
    /// Two letters for the picker's icon slot, where every other row in that menu has
    /// a glyph. Vendor logos were the obvious answer and are not available: the CC0
    /// sets have no mark for Codex, Grok, Kiro, Devin, Droid, Antigravity, Kilo, Maki,
    /// MastraCode, OMP or Qoder (OpenAI's and xAI's have been *removed* on request),
    /// and two of the names that do resolve resolve to the wrong product entirely —
    /// `AMP` is Google's web framework, `Hermes` is a German parcel courier. Half a set
    /// of logos plus two wrong ones is worse than no logos, so every agent gets the
    /// same kind of mark instead.
    ///
    /// Lives here rather than being derived on the frontend from `label` because the
    /// four C's (Codex, Cursor, Cline, Copilot) need deciding by hand, and a collision
    /// between two derived monograms would be silent.
    mark: &'static str,
}

/// The agents Episko can launch, in the order the picker lists them — sorted by label
/// here so no call site sorts, and `agents_are_sorted_by_label` stops a new entry
/// being dropped in wherever it happened to be typed.
///
/// Three binaries are not their agent's name and cannot be guessed: Antigravity
/// installs `agy`, Kiro installs `kiro-cli`, Cursor installs `cursor-agent`. Getting
/// one wrong fails silently — the agent simply never appears in the picker on a
/// machine that has it — so these come from each vendor's own installer rather than
/// from the product name.
///
/// **Claude Code is deliberately absent.** Its dedicated launcher supplies hooks,
/// statusLine telemetry and external-terminal support; a generic catalogue entry would
/// offer the same binary while silently bypassing that provider adapter.
const AGENTS: &[AgentSpec] = &[
    AgentSpec { id: "amp", label: "Amp", bin: "amp", mark: "Am" },
    AgentSpec { id: "antigravity", label: "Antigravity CLI", bin: "agy", mark: "Ag" },
    AgentSpec { id: "cline", label: "Cline", bin: "cline", mark: "Cl" },
    AgentSpec { id: "codex", label: "Codex", bin: "codex", mark: "Cx" },
    AgentSpec { id: "cursor", label: "Cursor Agent CLI", bin: "cursor-agent", mark: "Cu" },
    AgentSpec { id: "devin", label: "Devin CLI", bin: "devin", mark: "Dv" },
    AgentSpec { id: "droid", label: "Droid", bin: "droid", mark: "Dr" },
    AgentSpec { id: "gemini", label: "Gemini CLI", bin: "gemini", mark: "Gm" },
    AgentSpec { id: "copilot", label: "GitHub Copilot CLI", bin: "copilot", mark: "Cp" },
    AgentSpec { id: "grok", label: "Grok CLI", bin: "grok", mark: "Gr" },
    AgentSpec { id: "hermes", label: "Hermes Agent", bin: "hermes", mark: "He" },
    AgentSpec { id: "kilo", label: "Kilo Code CLI", bin: "kilo", mark: "Kl" },
    AgentSpec { id: "kimi", label: "Kimi Code CLI", bin: "kimi", mark: "Km" },
    AgentSpec { id: "kiro", label: "Kiro CLI", bin: "kiro-cli", mark: "Kr" },
    AgentSpec { id: "maki", label: "Maki", bin: "maki", mark: "Mk" },
    AgentSpec { id: "mastracode", label: "MastraCode", bin: "mastracode", mark: "Ms" },
    AgentSpec { id: "omp", label: "OMP", bin: "omp", mark: "Om" },
    AgentSpec { id: "opencode", label: "OpenCode", bin: "opencode", mark: "Oc" },
    AgentSpec { id: "pi", label: "Pi", bin: "pi", mark: "Pi" },
    AgentSpec { id: "qodercli", label: "Qoder CLI", bin: "qodercli", mark: "Qo" },
    AgentSpec { id: "qwen", label: "Qwen Code", bin: "qwen", mark: "Qw" },
];

fn agent_spec(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// Where an agent CLI actually is, or `None` if this machine hasn't got it.
///
/// A sibling of `platform::resolve_claude`, deliberately not beside it. The Windows
/// half *is* `win_resolve`, which belongs to this module (it exists for
/// `argv_command`), and `platform.rs`'s first half has to stay free of crate
/// dependencies — so the helper moves to its consumer rather than dragging PATHEXT
/// resolution down into the leaf layer.
///
/// Two things it does differently from `resolve_claude`, both because here the answer
/// *is* the detection rather than a best effort at one:
///
/// - **It never falls back to the bare name.** `resolve_claude` returns `"claude"`
///   when it finds nothing, because the alternative is refusing to launch the app's
///   whole reason for existing. A fallback here would instead put all twenty-one
///   agents in the picker on every machine, and twenty of those rows would be a way
///   to open a pane onto "command not found".
/// - **It never spawns a login shell.** `resolve_claude` can afford one probe; this
///   runs over the entire table at once, and twenty-one login shells is a visible
///   stall on a Mac. `augmented_path()` already harvested that shell's PATH once for
///   the whole app run, so scanning it directly answers the same question for free.
#[cfg(not(windows))]
pub(crate) fn resolve_cli(bin: &str) -> Option<String> {
    let home = crate::platform::home_dir();
    // Where per-user installers land things the *process* PATH may not carry under
    // Finder. `augmented_path` already lists some of these; the overlap costs one
    // `is_file` each and lets this list be read on its own.
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
    // `win_resolve` walks PATHEXT across the augmented PATH, which is what "is this
    // installed?" means on Windows — and it is the same call `argv_command` makes at
    // launch, so detection and spawn cannot disagree about which file this is.
    if let Some(p) = win_resolve(bin) {
        return Some(p.to_string_lossy().into_owned());
    }
    // npm's global bin dir is the one common install location `augmented_path` does
    // not carry, and it is where every npm-distributed agent lands.
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
    /// What was looked for. Sent even when it was found, because it is the only useful
    /// thing to say about an agent that *wasn't*: "Episko searched your PATH for
    /// `cursor-agent`" is the answer to the question a missing row provokes.
    bin: &'static str,
    /// Where it is, or `None` if this machine hasn't got it.
    path: Option<String>,
    /// Features supplied by this provider adapter. The generic launcher is a
    /// terminal-only fallback; integrated adapters opt into these without teaching
    /// shared frontend surfaces provider names.
    capabilities: &'static [&'static str],
}

const CODEX_CAPABILITIES: &[&str] = &[
    "session-state", "activity", "context", "usage", "permissions", "resume", "history",
];

fn agent_capabilities(id: &str) -> &'static [&'static str] {
    match id {
        "codex" => CODEX_CAPABILITIES,
        _ => &[],
    }
}

/// The whole catalogue, each entry saying whether it is installed — **not** a filtered
/// list, which is what this used to be and was wrong.
///
/// `available_terminals` filters, and copying that contract here was a mistake worth
/// recording: an external terminal Episko doesn't offer is one you can plainly see is
/// not on your Mac, whereas an agent that silently fails to appear is indistinguishable
/// from Episko not supporting it. That difference is a support issue — "why is Codex
/// not in the list?" has no discoverable answer if there is no row to read. The rule
/// this now follows is the one `tasks.rs` already follows for a Runnable that cannot
/// run, and `projmenu.ts` for a worktree that cannot be removed: **what can't be used
/// says why, rather than vanishing.**
///
/// The frontend decides what to do with a `path: None` row (the picker greys it and
/// makes it inert); what this owes it is the fact and the binary name.
#[tauri::command]
pub(crate) fn list_agents() -> Vec<AgentInfo> {
    AGENTS
        .iter()
        .map(|a| AgentInfo { id: a.id, label: a.label, mark: a.mark, bin: a.bin, path: resolve_cli(a.bin), capabilities: agent_capabilities(a.id) })
        .collect()
}

/// Run a coding-agent provider in an embedded PTY — the fourth kind of pane.
///
/// Provider capabilities decide the integration. Codex starts a loopback App Server
/// beside the real TUI, so phase, activity, context, usage, approvals, history and
/// resume arrive through its public protocol. Providers without an adapter keep the
/// terminal-only fallback: worktree, project tree, palette, git working set and exit.
///
/// The TUI pid stays out of `owned_pids`: that set exists specifically to exclude
/// Episko-launched Claude processes from Claude's external-session registry. Provider
/// runtimes have their own lifecycle in `agent.rs` instead.
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
) -> Result<(), String> {
    let spec = agent_spec(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    // Resolve here rather than handing `argv_command` the bare name. The picker only
    // lists agents the probe found, so a miss at this point means it was uninstalled
    // between the poll and the click — and naming it beats a pane that opens onto a
    // shell's "not recognized" with no clue which of the two halves failed.
    let bin = resolve_cli(spec.bin)
        .ok_or_else(|| format!("{} isn't installed — `{}` is not on PATH", spec.label, spec.bin))?;
    std::fs::create_dir_all(&workdir).map_err(|e| format!("create workdir: {e}"))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // Through `argv_command`, not `CommandBuilder::new`, and that is load-bearing on
    // Windows: most of these ship as an npm `.cmd` shim, which `CreateProcessW` cannot
    // start on its own (ERROR_BAD_EXE_FORMAT) — the same wall every `package.json`
    // script hit before `argv_command` existed. Codex keeps its real TUI while an
    // independent App Server client feeds Episko's inspector; other providers retain
    // this path's terminal-only fallback until they gain an adapter.
    let remote = if spec.id == "codex" {
        Some(agent::start_codex(app.clone(), &state, &session_id, &workdir, &bin)?)
    } else {
        None
    };
    let args = remote.as_ref().map(|endpoint| {
        let mut args = vec!["--remote".to_string(), endpoint.clone(), "-C".to_string(), workdir.clone()];
        if let Some(thread) = resume.as_ref() {
            args.extend(["resume".to_string(), thread.clone()]);
        }
        args
    }).unwrap_or_default();
    let mut cmd = argv_command(&bin, args);
    cmd.cwd(&workdir);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    apply_utf8_locale(&mut cmd);

    log::info!("spawn agent · {} · {session_id} · {workdir} · {bin}", spec.id);
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
        Session { master: pair.master, writer, killer, pid: child_pid, workdir, kind: "agent", provider: Some(spec.id.into()), scrollback: scroll.clone(), win32_input: win32.clone() },
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

/// Every keystroke, paste and app-written line goes through here — the one place that
/// decides what a PTY's child actually receives, which is why the encoding decision
/// lives here rather than in any one spawner or in the frontend.
#[tauri::command]
pub(crate) fn write_pty(state: State<AppState>, session_id: String, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    if let Some(s) = map.get_mut(&session_id) {
        let payload = pty_payload(&s.win32_input, &data);
        s.writer.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
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

/// Every embedded PTY the backend currently holds — claude, shell and task panes
/// alike. The frontend's own map answers this in normal operation; this command
/// exists for the one state where the two disagree: a webview reload empties the
/// frontend map while every PTY here runs on (#47). Two consumers: the busy
/// guards (`dormantBusy`/`histBusy` read the ids off the externals poll, so an
/// orphan reads "running right now" and a second `--resume` can't interleave the
/// transcript its live process still owns), and startup adoption, which uses
/// `kind` and `workdir` to rebuild a pane per claude orphan.
#[tauri::command]
pub(crate) fn live_sessions(state: State<AppState>) -> Vec<LiveSession> {
    state
        .sessions
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| LiveSession { id: id.clone(), kind: s.kind, provider: s.provider.clone(), workdir: s.workdir.clone() })
        .collect()
}

#[derive(serde::Serialize)]
pub(crate) struct ScrollbackSnapshot {
    /// base64 of the retained bytes — the same encoding `pty-output` uses.
    data: String,
    /// Seq of the last chunk the snapshot contains. A queued `pty-output` event
    /// with `seq` at or below this is already in `data` and must be dropped by
    /// the adopter; one above it is not and must be written after it.
    seq: u64,
}

/// The retained output of one live PTY, for a pane being rebuilt after a webview
/// reload (#47 stage 2). Read under the same lock the reader appends under, so
/// the returned seq is exact — see `ScrollBuf` for why that matters.
#[tauri::command]
pub(crate) fn read_scrollback(state: State<AppState>, session_id: String) -> Result<ScrollbackSnapshot, String> {
    let map = state.sessions.lock().unwrap();
    let s = map.get(&session_id).ok_or_else(|| format!("no such session: {session_id}"))?;
    let (bytes, seq) = s.scrollback.lock().unwrap().snapshot();
    Ok(ScrollbackSnapshot { data: STANDARD.encode(&bytes), seq })
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
    /// The `claude` binaries installed right now — the evidence `usage.ts` needs to keep
    /// a **self-update** out of the write figures. See `version_files_in`.
    install: Vec<InstallFile>,
}

/// One installed `claude` binary: a name to tell it from its neighbours between two
/// polls, and the size to discount when it is one that just appeared.
#[derive(serde::Serialize)]
pub(crate) struct InstallFile {
    name: String,
    mb: f64,
}

/// Where the native installer keeps its version binaries, resolved **once per run**.
///
/// `resolve_claude()` can end in a login-shell probe, and this is read from a poll that
/// runs every four seconds: a meter whose whole design rule is "do not add churn to the
/// thing you are measuring" certainly must not spawn a shell per sample. The directory
/// does not move during a run — only its contents change, which is the entire point.
static VERSIONS_DIR: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();

fn versions_dir() -> Option<&'static std::path::Path> {
    VERSIONS_DIR
        .get_or_init(|| {
            // `~/.local/bin/claude` is a symlink into `…/share/claude/versions/<ver>`, so
            // the real binary's parent IS the directory to watch. The well-known path is
            // the fallback for an install we reached some other way (a shell probe, a
            // shim); anything else — npm, Homebrew — updates through a package manager
            // whose writes are charged to *its* process, never to a session of ours, so
            // finding nothing here is the correct answer rather than a miss.
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

/// The installed `claude` binaries and their sizes in MiB.
///
/// **Why a disk meter reads a directory:** a Claude Code self-update writes a whole new
/// ~290 MiB binary in here, and the `claude` process doing it is one of ours, so the
/// kernel charges those bytes to a session and the day reads as 300 MiB of agent churn.
/// The size on disk is the exact number to take back out — see `installGrown` in
/// `usage.ts`, which owns that decision.
///
/// Takes the directory rather than finding it so the scan is testable; one `read_dir`
/// over the two or three entries an install holds, with no file contents read.
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
    // Sorted so two polls describe the same install in the same order; the frontend keys
    // by name, but a stable list keeps the payload diffable by eye in the 🐞 console.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
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

    // Keyed by the session roster, NOT `owned_pids`: shells and tasks are sessions
    // that never join `owned_pids` (that set exists to filter *claude* pids out of
    // the external listing), so keying on it read every live shell/task pane as
    // "exited" and re-banked its whole cumulative counter into `retired` on every
    // poll — one vitest run booked gigabytes of reads that never happened.
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
        // Reported raw, every poll: this half only states what is installed, and
        // `usage.ts` decides what that means for the figures. Which keeps the decision in
        // a module a test can reach — the counters above cannot be faked in a unit test,
        // but "a binary that was not there last time" is pure arithmetic.
        install: versions_dir().map(version_files_in).unwrap_or_default(),
    }
}

/// Move the bytes of pids that left the session roster out of `samples` and into
/// `retired`.
///
/// Both halves matter: dropping the entries stops a long-lived app accumulating one per
/// session it has ever run, and banking their bytes first is what stops the app-wide
/// total falling when a pane closes. `live` must be the pids of the sessions being
/// polled — a pid still in it keeps its sample untouched, which is what makes the bank
/// a once-per-lifetime event rather than a per-poll one.
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

    // ---------- what a program reading a secret receives ----------

    /// ASCII is left alone, byte for byte. Every existing key path — `^C`, an arrow
    /// key, Claude Code's chords, an ordinary line — must go down the pipe exactly as
    /// it does today, because all 95 printable ASCII characters already round-trip
    /// exactly and a rewrite could only lose that.
    #[test]
    fn ascii_input_is_never_rewritten() {
        for s in [
            "hunter2\r",
            "\x03",                       // ^C
            "\x1b[A\x1b[B\x1b[C\x1b[D",   // arrows
            "\x1b[200~pasted\x1b[201~",   // bracketed paste, markers included
            "\x1bOA",                     // SS3
            "~!@#$%^&*()_+-=[]{}|;':\",./<>?`\\",
        ] {
            assert_eq!(win32_input_encode(s), s, "rewrote an ASCII-only write: {s:?}");
        }
    }

    /// A non-ASCII character becomes a key-DOWN/key-UP record pair carrying its exact
    /// UTF-16 code unit. Without this the character is best-fit-mapped into an
    /// Alt+numpad sequence by conhost and arrives on a key-UP record, where every
    /// hidden-prompt reader on Windows drops it.
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

    /// `Uc` is a UTF-16 code unit, not a scalar value, so a non-BMP character is two
    /// record pairs — its surrogates. Sending the scalar would deliver garbage.
    #[test]
    fn a_non_bmp_character_goes_as_its_two_surrogates() {
        assert_eq!(
            win32_input_encode("🔑"), // U+1F511 -> D83D DD11
            "\x1b[0;0;55357;1;0;1_\x1b[0;0;55357;0;0;1_\
             \x1b[0;0;56593;1;0;1_\x1b[0;0;56593;0;0;1_"
        );
    }

    /// Only the characters are re-encoded — the sequence around them is delivered as
    /// it was written. A pasted value keeps its brackets so the child's own request
    /// for bracketed paste is still honoured.
    #[test]
    fn escape_sequences_are_delivered_untouched() {
        assert_eq!(
            win32_input_encode("\x1b[200~é\x1b[201~"),
            "\x1b[200~\x1b[0;0;233;1;0;1_\x1b[0;0;233;0;0;1_\x1b[201~"
        );
        // An OSC's payload is the app's business, terminator included.
        assert_eq!(win32_input_encode("\x1b]11;rgb:00/00/00\x07"), "\x1b]11;rgb:00/00/00\x07");
    }

    /// The flag is latched from ConPTY's own announcement, and only that. A PTY that
    /// never asks — every PTY on macOS and Linux — keeps the untouched byte path.
    #[test]
    fn the_mode_is_latched_from_conptys_announcement() {
        let flag = AtomicBool::new(false);
        let mut carry = Vec::new();
        note_win32_input_mode(b"\x1b[?25h hello", &mut carry, &flag);
        assert!(!flag.load(Ordering::Relaxed), "latched on unrelated output");
        assert_eq!(pty_payload(&flag, "ä"), "ä", "should still be the untouched path");

        note_win32_input_mode(b"\x1b[6n\x1b[?9001h\x1b[?1004h", &mut carry, &flag);
        assert!(flag.load(Ordering::Relaxed));
        assert_eq!(pty_payload(&flag, "ä"), "\x1b[0;0;228;1;0;1_\x1b[0;0;228;0;0;1_");

        note_win32_input_mode(b"\x1b[?9001l", &mut carry, &flag);
        assert!(!flag.load(Ordering::Relaxed), "withdrawal must be honoured too");
    }

    /// The announcement split across two reads is still seen. Missing it is silent and
    /// degrades to exactly the bug, so the carry is not an optimisation.
    #[test]
    fn the_mode_is_latched_across_a_chunk_boundary() {
        let flag = AtomicBool::new(false);
        let mut carry = Vec::new();
        note_win32_input_mode(b"junk\x1b[?90", &mut carry, &flag);
        assert!(!flag.load(Ordering::Relaxed));
        note_win32_input_mode(b"01h more", &mut carry, &flag);
        assert!(flag.load(Ordering::Relaxed), "a split announcement was missed");
    }

    // ---------- the round trip, over a real PTY ----------

    /// Set for the child half of `secret_input_reaches_the_child_byte_exact`, which is
    /// this same test binary re-run with a filter. Without it the helper would sit and
    /// wait for input during a plain `cargo test -- --ignored` pass (RELEASE.md's).
    const CHILD_ENV: &str = "EPISKO_PTY_ROUNDTRIP_CHILD";

    /// The child: read a secret the way a hidden prompt does, and report the exact
    /// bytes it got. Not a test — the `#[test]` is how the parent re-enters this
    /// binary without shipping a second executable or depending on a python.
    #[test]
    #[ignore = "helper process for secret_input_reaches_the_child_byte_exact"]
    fn pty_roundtrip_child() {
        if std::env::var(CHILD_ENV).is_err() {
            return;
        }
        println!("READY");
        let got = read_secret();
        // Hex, so the report survives the terminal it travels over.
        println!("GOT:{}", got.as_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>());
        use std::io::Write as _;
        let _ = std::io::stdout().flush();
    }

    /// Windows: exactly what `_getwch` does — and therefore what Python's `getpass`,
    /// and every other hidden-prompt reader on Windows, does. Characters come from
    /// key-DOWN records only; that is the whole bug.
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

    /// Unix: a real tty in canonical mode hands over the line; the terminator is the
    /// tty's own (ICRNL turns the CR into NL) and is not part of the secret.
    #[cfg(not(windows))]
    fn read_secret() -> String {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        line.trim_end_matches(['\r', '\n']).to_string()
    }

    /// **The regression test.** Feed a real PTY the known-tricky inputs — a value
    /// terminated by CR, a pasted value, and one carrying non-ASCII — and require the
    /// child to read back exactly the characters that were sent.
    ///
    /// Fails on Windows without `win32_input_encode`: `✓`, `§` and `U+00A0` are
    /// best-fit-mapped by conhost into Alt+numpad sequences and arrive on key-UP
    /// records, where a hidden-prompt reader never looks — so the secret comes out
    /// short and gpg calls it a bad passphrase.
    #[test]
    fn secret_input_reaches_the_child_byte_exact() {
        // "typed then Enter", "pasted then Enter", "non-ASCII, including the
        // no-break space a passphrase copied out of a document carries".
        let cases: [(&str, &str, &str); 4] = [
            ("plain typed", "hunter2\r", "hunter2"),
            ("pasted", "\x1b[200~Correct-Horse-42\x1b[201~\r", "Correct-Horse-42"),
            ("non-ascii", "sëcrét✓§\r", "sëcrét✓§"),
            ("no-break space", "ab\u{a0}cd\r", "ab\u{a0}cd"),
        ];
        for (name, send, want) in cases {
            let got = round_trip(send);
            // A real tty passes the paste brackets to the child (the child asked for
            // them); ConPTY consumes them. Either way the *value* must be exact.
            let got = got.replace("\x1b[200~", "").replace("\x1b[201~", "");
            assert_eq!(got, want, "{name}: the child did not receive what was sent");
        }
    }

    /// Drive one value through a real PTY the way the app does: latch the mode from
    /// the child's output, encode the write through `pty_payload`, read the report.
    fn round_trip(send: &str) -> String {
        use std::time::{Duration, Instant};
        let pair = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
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
                // ConPTY asks the terminal where the cursor is and stalls the child
                // until something answers. xterm.js does this for us in the app; a
                // PTY test that skips it simply hangs.
                if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                    let mut g = w2.lock().unwrap();
                    let _ = g.write_all(b"\x1b[1;1R");
                    let _ = g.flush();
                }
                o2.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
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
        assert!(wait_for("READY"), "child never started: {}", out.lock().unwrap());
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

    /// The invariant adoption stands on: snapshot at ANY point mid-stream, keep the
    /// chunks whose seq is above the snapshot's, and snapshot + kept chunks must
    /// equal the stream's tail exactly — no byte doubled, none lost. This is the
    /// protocol the frontend runs (queue while the snapshot is in flight, drop
    /// `seq <= snapshot.seq`, write the rest), driven over every split point.
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
            assert_eq!(replay, whole, "split at chunk {split} lost or doubled bytes");
        }
    }

    /// The cap keeps the newest bytes, not the oldest — scrollback answers "what
    /// just happened", so the front is what an overflow must sacrifice.
    #[test]
    fn overflow_evicts_the_front_and_keeps_the_tail() {
        let mut sb = ScrollBuf::new();
        sb.push(b"old line\n");
        sb.push(&vec![b'x'; SCROLLBACK_MAX]);
        let (bytes, _) = sb.snapshot();
        assert!(bytes.len() <= SCROLLBACK_MAX);
        assert!(bytes.iter().all(|&b| b == b'x'), "the old line must be gone, not the fill");
    }

    /// An evicted buffer starts mid-line — likely mid escape sequence, which on
    /// replay eats characters up to the next terminator — so the snapshot trims to
    /// the first newline. Before any eviction it must NOT trim: the first bytes a
    /// young session produced are real output, not a torn line.
    #[test]
    fn snapshot_trims_to_a_newline_only_after_eviction() {
        let mut sb = ScrollBuf::new();
        sb.push(b"first\nsecond\n");
        assert_eq!(sb.snapshot().0, b"first\nsecond\n", "no eviction, nothing to trim");

        let mut sb = ScrollBuf::new();
        // Fill so that eviction leaves a torn fragment ahead of a clean line.
        sb.push(&vec![b'a'; SCROLLBACK_MAX]);
        sb.push(b"\ncomplete line\n");
        let (bytes, _) = sb.snapshot();
        assert!(bytes.starts_with(b"complete line\n"), "the torn front must go");
    }

    /// One alternate-screen repaint can be 100% newline-free; trimming would then
    /// throw away the entire screen, so a no-newline buffer is kept whole.
    #[test]
    fn snapshot_keeps_a_newline_free_buffer_whole_even_after_eviction() {
        let mut sb = ScrollBuf::new();
        sb.push(&vec![b'y'; SCROLLBACK_MAX + 10]);
        let (bytes, _) = sb.snapshot();
        assert_eq!(bytes.len(), SCROLLBACK_MAX);
    }

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
        let live = HashSet::from([8u32]);
        let mut retired = (0u64, 0u64);
        retire_missing(&mut samples, &live, &mut retired);

        assert_eq!(retired, (900, 100), "the departed pid's bytes are kept");
        assert!(!samples.contains_key(&7), "but its sample entry is dropped");
        assert!(samples.contains_key(&8), "a still-live pid is untouched");

        // And a second sweep must not double-count what it already banked.
        retire_missing(&mut samples, &live, &mut retired);
        assert_eq!(retired, (900, 100), "already-retired bytes are not banked twice");
    }

    /// The retirement key is the session roster, not `owned_pids` — shells and tasks
    /// never join `owned_pids`, and keying on it read every live shell/task pane as
    /// exited: each poll banked the pane's whole cumulative counter into `retired`
    /// again, then `fold_io` re-created the sample for the next poll to bank again.
    /// One test run's pane inflated a day's read figure by two orders of magnitude
    /// before this was a rule. This drives the actual per-poll sequence and asserts a
    /// pane that stays in the roster retires nothing for as long as it lives.
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
            let f = fold_io(&reading, &mut samples, t0 + std::time::Duration::from_secs(poll));
            assert_eq!(f.read, 1_000_000 + poll * 1_000, "the live total is the reading");
        }
        assert_eq!(retired, (0, 0), "a pane still in the roster banks nothing");

        // Only when it leaves the roster do its bytes retire — once, at the last reading.
        retire_missing(&mut samples, &HashSet::new(), &mut retired);
        assert_eq!(retired, (1_004_000, 504), "and then exactly its final sample");
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

    /// The evidence behind discounting a self-update: what is installed, and how big.
    /// Only the *sizes* matter to the frontend's arithmetic, and a size read wrong (a
    /// directory counted as a binary, MiB confused with bytes) would discount the wrong
    /// number of bytes from a real day, silently.
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

        // A directory that isn't there answers "nothing installed" rather than failing:
        // an npm or Homebrew install has no versions dir, and its updates are charged to
        // the package manager, so there is nothing for this to find and nothing to fix.
        assert!(version_files_in(&dir.join("nope")).is_empty());
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

    // ---------- the agent table ----------
    //
    // Nothing else can check this half. A wrong `bin` compiles, passes clippy and
    // ships; the only symptom is that the agent never appears in the picker on a
    // machine that has it installed, which looks exactly like not having installed it.
    // So the table gets the checks a table can have: no duplicates, no empties, and
    // the ordering the picker relies on.

    #[test]
    fn agents_are_sorted_by_label() {
        // The picker renders `available_agents()` in table order and does not sort, so
        // an entry appended at the bottom (the obvious way to add one) would show up
        // after Qwen with no test to say otherwise.
        let labels: Vec<String> = AGENTS.iter().map(|a| a.label.to_lowercase()).collect();
        let mut sorted = labels.clone();
        sorted.sort();
        assert_eq!(labels, sorted, "AGENTS is the picker's order — keep it sorted by label");
    }

    #[test]
    fn agent_ids_and_labels_are_unique_and_populated() {
        let mut ids = std::collections::HashSet::new();
        let mut labels = std::collections::HashSet::new();
        let mut marks = std::collections::HashSet::new();
        for a in AGENTS {
            assert!(!a.id.is_empty() && !a.label.is_empty() && !a.bin.is_empty() && !a.mark.is_empty(), "{} has an empty field", a.id);
            // The id is the wire value `spawn_agent` takes and the key the frontend
            // stores on a pane, so it has to be a stable slug rather than a display
            // name that might get prettied up later.
            assert!(
                a.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
                "agent id {:?} must be a lowercase ascii slug",
                a.id
            );
            assert!(ids.insert(a.id), "duplicate agent id {:?}", a.id);
            assert!(labels.insert(a.label), "duplicate agent label {:?}", a.label);
            // The mark is the only thing distinguishing two rows at a glance, so a
            // duplicate is exactly as bad as a duplicate label — and far easier to
            // introduce, since `Codex`, `Cursor`, `Cline` and `Copilot` all want "Co".
            assert_eq!(a.mark.chars().count(), 2, "agent mark {:?} must be two characters", a.mark);
            assert!(marks.insert(a.mark), "duplicate agent mark {:?} ({})", a.mark, a.id);
        }
    }

    #[test]
    fn claude_is_not_in_the_agent_table() {
        // Deliberate, and easy to "fix" by someone who reads the list as an omission:
        // launching claude through this path would strip the instrumentation the whole
        // cockpit is built on. See the AGENTS doc comment.
        assert!(
            agent_spec("claude").is_none() && !AGENTS.iter().any(|a| a.bin == "claude"),
            "claude belongs to spawn_claude, which instruments it — see the AGENTS comment"
        );
    }

    #[test]
    fn spawn_agent_only_answers_to_ids_in_the_table() {
        for a in AGENTS {
            assert_eq!(agent_spec(a.id).map(|s| s.bin), Some(a.bin));
        }
        // The lookup `spawn_agent` refuses on. A frontend that sent a label, a binary
        // name or a stale id must not fall through to launching *something*.
        for bogus in ["", "Codex", "cursor-agent", "claude", "opencode2"] {
            assert!(agent_spec(bogus).is_none(), "{bogus:?} should not resolve to an agent");
        }
    }

    #[test]
    fn list_agents_reports_the_whole_table_and_marks_what_it_found() {
        // Machine-dependent by nature — CI has none of these installed and a dev box
        // has some — so the assertions are about shape rather than contents. The one
        // that matters: the list is the *whole* table, because a picker built from a
        // filtered one cannot explain an agent that is missing.
        let list = list_agents();
        assert_eq!(list.len(), AGENTS.len(), "list_agents must not filter");
        for info in list {
            let spec = agent_spec(info.id).expect("list_agents invented an id");
            assert_eq!((spec.label, spec.bin, spec.mark), (info.label, info.bin, info.mark));
            // A `Some` path is a promise the agent will start, so it has to be a real
            // file — that is what the picker lets you click.
            if let Some(p) = &info.path {
                assert!(std::path::Path::new(p).is_file(), "{} reported {p}, not a file", info.id);
            }
        }
    }

    #[test]
    fn resolve_cli_says_no_to_something_nobody_ships() {
        // The other half of the contract above: a miss is `None`, never a bare-name
        // fallback. If this ever returns Some, every agent is in every picker.
        assert!(resolve_cli("episko-definitely-not-a-real-binary").is_none());
    }

}
