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

/// How many times Claude Code retries a request of its own accord before it gives up
/// and ends the turn with `StopFailure`.
///
/// Its retry classifier already covers the whole transient set — 429 and 5xx, plus the
/// connection errors (`ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`,
/// `ENETUNREACH`, `EHOSTUNREACH`) that a laptop's Wi-Fi napping produces — so raising
/// the ceiling costs nothing on a healthy connection and buys real time on a sick one.
/// Every retry is spaced by Claude Code's own exponential backoff, so this is a wider
/// window rather than a busier one.
///
/// This is the first of Episko's two defences against an overnight outage and by far the
/// cheaper: a request that eventually succeeds never ends the turn, so the conversation
/// never needs reviving at all. The frontend watchdog (`src/revive.ts`) is what picks up
/// the outages that outlast even this.
const CLAUDE_RETRY_CEILING: &str = "12";

/// Apply the ceiling above, **without overriding a value the user set themselves**.
/// Anyone who has put `CLAUDE_CODE_MAX_RETRIES` in their shell profile has a reason for
/// the number they chose, and a launcher quietly replacing it would be the kind of thing
/// that takes an afternoon to find.
fn apply_retry_ceiling(cmd: &mut CommandBuilder) {
    if std::env::var_os("CLAUDE_CODE_MAX_RETRIES").is_none() {
        cmd.env("CLAUDE_CODE_MAX_RETRIES", CLAUDE_RETRY_CEILING);
    }
}

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
            .map(|v| {
                let u = v.to_ascii_uppercase();
                u.contains("UTF-8") || u.contains("UTF8")
            })
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
    let port = state.port.load(std::sync::atomic::Ordering::Relaxed);
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
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
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
        ScrollBuf {
            buf: VecDeque::new(),
            seq: 0,
            evicted: false,
        }
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
        let _ = app.emit(
            "pty-exit",
            serde_json::json!({ "sessionId": session_id, "code": code }),
        );
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
    // Deliberately NOT added to owned_pids: a plain shell isn't a claude process
    // and never registers in ~/.claude/sessions, so it can't leak as "external".
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
    /// Stable legacy mark kept in the command's wire shape for compatibility with
    /// older frontends. Current selectors resolve vetted SVGs at `src/providers/logos`;
    /// this must never be used to guess a logo from `label`.
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
    capabilities: Vec<String>,
}

#[derive(serde::Deserialize)]
struct ProviderManifestEntry {
    capabilities: Vec<String>,
}

/// The one capability matrix shared with the TypeScript provider registry. Keeping
/// this as checked-in JSON lets Rust advertise the exact promises the frontend gates
/// on without maintaining a second Codex/Claude list in another language.
fn provider_manifest() -> std::collections::HashMap<String, ProviderManifestEntry> {
    serde_json::from_str(include_str!("../../src/providers/manifest.json"))
        .expect("src/providers/manifest.json must be valid provider metadata")
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
    mode: Option<String>,
) -> Result<(), String> {
    let spec = agent_spec(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    if resume.is_some() && !std::path::Path::new(&workdir).is_dir() {
        return Err(format!("can't resume: {workdir} no longer exists"));
    }
    // Resolve here rather than handing `argv_command` the bare name. The picker only
    // lists agents the probe found, so a miss at this point means it was uninstalled
    // between the poll and the click — and naming it beats a pane that opens onto a
    // shell's "not recognized" with no clue which of the two halves failed.
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

    // Through `argv_command`, not `CommandBuilder::new`, and that is load-bearing on
    // Windows: most of these ship as an npm `.cmd` shim, which `CreateProcessW` cannot
    // start on its own (ERROR_BAD_EXE_FORMAT) — the same wall every `package.json`
    // script hit before `argv_command` existed. Codex keeps its real TUI while an
    // independent App Server client feeds Episko's inspector; other providers retain
    // this path's terminal-only fallback until they gain an adapter.
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
    Err(
        "external terminals aren't supported on Windows yet — use the embedded terminal"
            .to_string(),
    )
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
    if sys_command("wt.exe")
        .arg("-d")
        .arg(&workdir)
        .spawn()
        .is_ok()
    {
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

/// Every keystroke, paste and app-written line goes through here — the one place that
/// decides what a PTY's child actually receives, which is why the encoding decision
/// lives here rather than in any one spawner or in the frontend.
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

// ---------- the log of a background shell an agent started ----------
//
// The root under all of this is NOT ours and cannot be computed. Claude Code writes a
// backgrounded shell's output under `${CLAUDE_CODE_TMPDIR ?? "/tmp"}/claude-<uid>/`,
// while Episko asked `env::temp_dir()/claude/` for this feature's entire life — a
// directory that has never existed on macOS, where `$TMPDIR` is a per-user
// `/var/folders/…` box the CLI ignores outright (measured: launching `claude` with
// `TMPDIR` pointed at a scratch dir creates nothing under it at all). So every read
// missed. No row ever got a URL, a peek, or an exit sentinel; nothing ever set
// `ended`; and every background shell sat at "starting…" until its session died.
// Nothing anywhere said so, because a miss is a perfectly legitimate state one second
// after a shell starts and the row draws either way.
//
// So the root is **probed and remembered**, never asserted, and the probe carries BOTH
// directory shapes on EVERY platform — only their order differs, because the Windows
// row is one nobody working on this has ever observed and pinning an unobserved guess
// as the only possible answer is precisely what cost this feature its life. A wrong
// extra candidate costs one `is_file()` per poll; a missing one costs the feature.

/// How much of a background log to hand the frontend. A dev server left running all
/// afternoon writes megabytes (a real one measured 300 KiB in three hours of HMR), and
/// every consumer — the URL, the sentinel, a twelve-line peek — reads the *end*. So the
/// tail is all that crosses the IPC boundary, and it is read without loading the front
/// of the file at all.
const BG_LOG_TAIL: u64 = 32 * 1024;

/// How often the probe's last-resort directory scan may run, PROCESS-WIDE.
///
/// `read_bg_log` is called every four seconds per live record. A fleet with ten blind
/// shells would otherwise `read_dir` a busy `/tmp` a hundred and fifty times a minute
/// to get the same answer a hundred and fifty times, and a permanently blind fleet is
/// exactly the fleet that must not pay for its own blindness twenty times a tick.
const BG_SCAN_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

/// How many candidate roots one record will ever be tested against. Each is a single
/// `is_file()`, but the list is a cross-product of bases and names, and a cross-product
/// is how a cheap poll quietly becomes an expensive one. Four bases by two names is
/// already the whole believable space.
const BG_ROOT_MAX: usize = 8;

/// Which layout Claude Code is using, as a VALUE rather than a `#[cfg]`.
///
/// Same reasoning as `win_runs_directly` above, one feature along: half this file is
/// invisible to any one machine, and a `#[cfg(windows)]` arm cannot be asserted from a
/// Mac. The Windows root is precisely the row nobody here has ever seen, so it has to
/// be the row a macOS test can pin — and it can only be that if the OS arrives as data.
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

/// Everything the root table is a function of, gathered in one impure place so that
/// nothing below it reads the environment at all.
///
/// `BgLogEnv::current()` is the ONLY caller of `env::var`, `env::temp_dir`,
/// `env::consts::OS` or the uid in this half of the file; the table, the path builder
/// and the probe all take it as an argument and are pure. That is what lets the macOS
/// leg of CI assert the Windows candidate order — and it is also what makes CI's
/// poisoned `CLAUDE_CODE_TMPDIR` a real guard rather than a decoration: anyone who
/// reaches for `env::var` inside the table sends the pure tests, which pass
/// `override_tmp: None`, somewhere else entirely and turns them red.
struct BgLogEnv {
    os: ClaudeOs,
    /// `$CLAUDE_CODE_TMPDIR` — the one knob the CLI honours here. `$TMPDIR` is **not**
    /// a fallback for it; the bundle reads this variable and otherwise hard-codes
    /// `/tmp`, which is the whole reason `env::temp_dir()` was the wrong basis.
    override_tmp: Option<std::path::PathBuf>,
    /// `env::temp_dir()`. Wrong on macOS and kept anyway, because it is very likely
    /// the right answer on Windows and a candidate list that drops a shape is how
    /// this broke in the first place.
    sys_tmp: std::path::PathBuf,
    /// `$XDG_RUNTIME_DIR`, last: a Linux box that keeps per-user runtime state there
    /// is the one place `/tmp` and `env::temp_dir()` can both be wrong at once.
    xdg_runtime: Option<std::path::PathBuf>,
    /// The uid the `claude-<uid>` directory is named for, or `None` where we have no
    /// uid to name it with.
    uid: Option<u32>,
}

impl BgLogEnv {
    fn current() -> Self {
        // An empty variable is not a base. `PathBuf::from("")` joins to a relative
        // path, so an exported-but-blank `CLAUDE_CODE_TMPDIR` would otherwise put
        // `claude-501/<slug>/…` — resolved against the app's cwd — at rank 0.
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

/// The uid Claude Code names its temp directory after. Read off the owner of `$HOME`
/// rather than through a `libc` call, because this crate has no libc dependency and
/// the two numbers are the same one.
#[cfg(unix)]
fn current_uid() -> Option<u32> {
    use std::os::unix::fs::MetadataExt as _;
    std::fs::metadata(crate::platform::home_dir()).ok().map(|m| m.uid())
}

#[cfg(not(unix))]
fn current_uid() -> Option<u32> {
    None
}

/// The `claude*` directory names Claude Code may have used, most-believed first.
///
/// BOTH shapes are returned on every platform and only their ORDER changes: on macOS
/// and Linux the suffixed name is what a real tree on disk is called, and on Windows
/// the bare name is a belief and nothing more.
///
/// **A platform with no uid to read still gets a suffixed shape, spelled `claude-0`.**
/// `current_uid()` reads the owner of `$HOME` through a Unix-only API, so it is `None`
/// on every Windows build — and the bundle computes `claude-${process.getuid?.() ?? 0}`,
/// which is `claude-0` exactly where `getuid` is undefined. That is a reading of
/// minified source rather than a directory anybody has watched appear, which is why it
/// is not FIRST on Windows; leaving it out altogether was the worse mistake, because it
/// left that platform's table one entry long and that entry the name we have the least
/// reason to believe. A wrong extra candidate costs one `is_file()`; a missing one cost
/// this feature its entire life.
/// `claude_layout_still_names_its_temp_dir_the_way_we_probe_for_it` is what settles
/// the Windows row, by running the binary on a Windows runner and looking; until it
/// has, a wrong first row degrades to a working probe that announces `moved`, which is
/// a whole different kind of wrong from the outage above.
fn bg_log_dir_names(os: ClaudeOs, uid: Option<u32>) -> Vec<String> {
    let owned = format!("claude-{}", uid.unwrap_or(0));
    let bare = "claude".to_string();
    match os {
        ClaudeOs::Windows => vec![bare, owned],
        ClaudeOs::Mac | ClaudeOs::Unix => vec![owned, bare],
    }
}

/// The directories a `claude*` tree could sit in, most-believed first.
///
/// Separate from `bg_log_roots` because the last-resort scan walks these BASES looking
/// for a `claude*` entry nobody predicted — the one way this probe can survive a
/// directory name we have never seen without shipping a release first.
fn bg_log_bases(e: &BgLogEnv) -> Vec<std::path::PathBuf> {
    // `/tmp` is first on macOS because the CLI hard-codes it and ignores `$TMPDIR`;
    // `env::temp_dir()` is first everywhere else because on Windows it is the only
    // base there is. Each keeps the other as a fallback: the point of this list is
    // that neither platform's answer is asserted as the only one.
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

/// The candidate roots, most-believed first. **Pure**: no I/O, no env, no `cfg`. Every
/// index into this list is a `rootRank` the frontend can read, so its order is part of
/// the contract and not an implementation detail.
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

/// The two components of a background log's address that genuinely mirror the
/// transcript: the project slug from its directory, the session uuid from its file
/// stem. `~/.claude/projects/<slug>/<uuid>.jsonl` gives `(<slug>, <uuid>)`.
fn bg_log_session(transcript: &str) -> Option<(String, String)> {
    let t = std::path::Path::new(transcript);
    let uuid = t.file_stem()?.to_str()?;
    let slug = t.parent()?.file_name()?.to_str()?;
    if uuid.is_empty() || slug.is_empty() {
        return None;
    }
    Some((slug.to_string(), uuid.to_string()))
}

/// Where Claude Code writes a backgrounded shell's output, GIVEN a root.
///
/// `root` already includes the `claude*` directory, because that component is not
/// computable from anything we hold — `bg_log_resolve` probes for it and remembers it.
/// What is left is the half that genuinely mirrors the transcript: a transcript at
/// `~/.claude/projects/<slug>/<uuid>.jsonl` puts its background logs under
/// `<root>/<slug>/<uuid>/tasks/<task_id>.output`. The layout is undocumented and not
/// ours, so this fails by returning `None` rather than by guessing, and the probe
/// around it reports every path it LOOKED AT rather than asserting the one it
/// computed — a row that can say where it looked is a row somebody can fix.
fn bg_log_path(root: &std::path::Path, transcript: &str, task_id: &str) -> Option<std::path::PathBuf> {
    // The id reaches us from a hook payload and lands in a path, so it is checked
    // rather than trusted: anything but Claude's own alphabet is refused outright.
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
    /// The memo answered — its root, or the session directory a scan taught it — so
    /// there is nothing new to remember.
    from_memo: bool,
}

/// Why the probe has no log, in the shape a row needs to say so out loud.
///
/// `NotYet` carries the file it is waiting for; the other two carry every path that
/// was tested. A row that can only say "missing" is the silence this whole block
/// exists to end — and the three states have three different answers, one of which
/// (nothing found anywhere) must never be mistaken for a shell that has simply not
/// written its first line yet.
///
/// `Debug` because a test that fails here should print the paths it looked at rather
/// than the word "Err": the list is the whole diagnosis.
#[derive(Debug)]
enum BgResolveErr {
    BadId,
    NotYet(std::path::PathBuf, Vec<std::path::PathBuf>),
    NoRoot(Vec<std::path::PathBuf>),
    Ambiguous(Vec<std::path::PathBuf>),
}

/// The one thing the probe remembers between calls, held in `AppState`.
///
/// The ROOT is memoised and the FILE never is. A background log appears seconds
/// *after* the record that names it does, so a memo on the resolved file would freeze
/// the first miss in place forever — which is the bug being fixed, reintroduced by its
/// own fix. And the memo is INVALIDATED rather than defended: `$CLAUDE_CODE_TMPDIR`
/// can change under a running app and `/tmp` gets reaped, so a remembered root that
/// stops holding is dropped on the spot and the ladder starts again from the top.
pub(crate) struct BgRootState {
    root: Option<std::path::PathBuf>,
    rank: i32,
    /// The `<root>/<slug>/<uuid>` directory a SCAN resolved, kept beside the root
    /// because the root alone cannot re-find it: Claude splices a base-36 hash into a
    /// slug that grows too long, so step (1) rebuilds the path from the slug we DERIVE
    /// and misses a tree whose slug is not that one. Without this such a record is
    /// re-found only by the scan, which runs once a minute — fourteen of every fifteen
    /// polls would report `noRoot` about a log the probe has already held in its hand,
    /// flapping the row's peek and its health state every four seconds. It answers only
    /// for the uuid it was learned for, checked rather than assumed: one slot,
    /// process-wide, and a wrong hit here puts this row's peek on another session's log.
    sess: Option<std::path::PathBuf>,
    /// The last `bglog-health` state announced FOR EACH record, so that event fires on
    /// TRANSITION only. One slot for the whole process reads as transition-only right
    /// up until two live records disagree — one resolving, one blind — after which
    /// every read flips the slot the other one set and the event fires twice per poll
    /// forever: 30 `dlog` lines a minute, which empties the debug console's 400-entry
    /// ring in about a quarter of an hour. `bg_log_health_state` answers per RECORD, so
    /// the guard on it has to be per record too. Keyed by transcript AND task id
    /// because a task id is Claude's and is only unique within one session, exactly as
    /// the frontend keys a `BgServer` inside one pane's list. It holds one small enum
    /// per shell an agent has backgrounded, for the life of the process.
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
    // Root and candidate file together, so a rank is an index into one list rather
    // than an assumption that two lists stayed the same length.
    let cands: Vec<(std::path::PathBuf, std::path::PathBuf)> = roots
        .iter()
        .filter_map(|r| bg_log_path(r, transcript, task_id).map(|p| (r.clone(), p)))
        .collect();
    if cands.is_empty() {
        // The transcript parsed, so this can only be a task id that is not one. There
        // is no address to look for and no amount of disk I/O improves that.
        return Err(BgResolveErr::BadId);
    }
    let tried = |c: &[(std::path::PathBuf, std::path::PathBuf)]| {
        c.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>()
    };

    // (1) The remembered root: one `is_file()` where the table is up to eight, and
    // the overwhelmingly common case once anything at all has resolved.
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

    // ...and the session directory a scan resolved, for the tree whose slug is not the
    // one we derive. The uuid on the end of it is checked rather than assumed, because
    // this is one slot shared by the whole fleet and answering with somebody else's
    // tree would put this row's peek on another session's log. Joining the task id
    // here adds no new trust: an id that is not one left as `BadId` above, before
    // `cands` was built.
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

    // (2) The table, in order. The first existing FILE, never the first existing
    // ROOT: a stale `claude/` left behind by an older layout is a directory that
    // exists and holds nothing, and a probe that stopped at it would pick the empty
    // one every time while the real log sat one row further down.
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

    // (3) A root that holds THIS SESSION but not (yet) this log. Claude mkdirs the
    // session's `scratchpad` eagerly at start and only creates `tasks/` once a shell
    // has actually been backgrounded, so a session directory with no log under it is
    // the honest "starting…" state. Reporting it as a missing root would be a lie
    // with teeth: `noRoot` is the state the frontend refuses to retire a row on, and
    // `notYet` is the one it does.
    for (root, cand) in &cands {
        let sess = root.join(&slug).join(&uuid);
        if sess.is_dir() || sess.join("scratchpad").exists() {
            return Err(BgResolveErr::NotYet(cand.clone(), tried(&cands)));
        }
    }

    // (4) Last resort: a `claude*` directory nobody predicted, and this session's uuid
    // under a slug we did not derive. Throttled process-wide — see `BG_SCAN_EVERY`.
    let due = match memo.last_scan {
        Some(t) => now.duration_since(t) >= BG_SCAN_EVERY,
        None => true,
    };
    if !due {
        // The memo is left exactly as it was. "Come back later" is not "there is no
        // root": this branch has established nothing about whether the remembered root
        // still holds, and the memo is process-wide — dropping it here would make one
        // record's throttled poll send every OTHER live record back through the full
        // table on its next read. Only step (5), which actually looked, drops it.
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
            // The same uuid under a slug we did not derive. Claude's slug is a
            // sanitised cwd with a base-36 hash spliced in once it grows too long,
            // and reproducing that hash would be one more piece of somebody else's
            // build written down as ours. A v4 uuid one level down is collision-free
            // enough to find the tree without it: ONE `read_dir`, no recursion.
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
            // `<root>/<slug>/<uuid>/tasks/<id>.output` — the root is four levels up,
            // and the session directory two, which is the half the derived slug cannot
            // rebuild when Claude spliced its hash into one.
            memo.root = path.ancestors().nth(4).map(|p| p.to_path_buf());
            memo.sess = path.ancestors().nth(2).map(|p| p.to_path_buf());
            memo.rank = -1;
            Ok(BgResolved { path, rank: -1, discovered: true, from_memo: false })
        }
        // (5) A total miss drops the memo rather than defending it. This is the branch
        // that looked and found nothing, so it is the one entitled to.
        0 => {
            memo.root = None;
            memo.sess = None;
            Err(BgResolveErr::NoRoot(tried(&cands)))
        }
        // Two roots holding one session is not something we can pick between, and a
        // guess would put this row's peek on somebody else's log. Say so instead.
        _ => {
            memo.root = None;
            memo.sess = None;
            Err(BgResolveErr::Ambiguous(hits))
        }
    }
}

/// Why a read came back with nothing. `missing` alone could never distinguish a log
/// that has not appeared yet from a root that is not where we looked from a file that
/// is there and unreadable — three states with three different answers, and the row
/// had no way to say which of them it was in.
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

/// What the app says out loud about its own probe. This is `serve_telemetry`'s
/// re-bind announcement one level down: a fleet nobody can hear must never look like a
/// quiet one. `Moved` is the state nobody would think to build — the probe still
/// WORKS and the app says so anyway, which buys one release of warning before the
/// fallback stops matching too.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BgHealth {
    Ok,
    Moved,
    Blind,
}

#[derive(serde::Serialize)]
// `root_rank` is the first multi-word field this struct has ever had, and a snake_case
// key arriving at a camelCase interface is a silent `undefined`: every rule reading it
// answers "no", and tsc, vitest and cargo all stay green. That is the original bug's
// exact shape, so the rename is not cosmetic. `test/ipc.test.ts` holds the two sides
// together from source.
#[serde(rename_all = "camelCase")]
pub(crate) struct BgLog {
    /// The resolved path, so a row can name (and reveal) the file it is reading — or,
    /// when the log has not appeared yet, the file it is waiting for. Empty exactly
    /// when there is no single path to name, in which case `tried` is the answer.
    path: String,
    /// The last `BG_LOG_TAIL` bytes, lossily decoded — a dev server's output is
    /// whatever the process emitted, and a truncated multi-byte character at the cut
    /// must not cost the whole read.
    text: String,
    /// The file isn't there. Normal and temporary right after a shell starts, and a
    /// standing state when the layout has moved — `reason` is what tells those apart.
    missing: bool,
    /// The file's full length, which the caller keeps and passes back as `known_len`.
    len: u64,
    /// The length matched `known_len`, so nothing was read and `text` is empty. A
    /// background log is append-only, which is what makes a length comparison an exact
    /// "has anything happened" test rather than a heuristic.
    unchanged: bool,
    /// Why there is nothing, in the frontend's vocabulary. `None` whenever the file
    /// was read, including the empty and unchanged cases.
    reason: BgMiss,
    /// Every candidate the probe tested when it found none. Exactly one of `path` and
    /// `tried` is ever the answer, and the row can copy or reveal whichever it is —
    /// which is the difference between "no output yet" and a bug report.
    tried: Vec<String>,
    /// Index into `bg_log_roots` of the root this resolved under, or `-1` when the
    /// directory scan found it or nothing did. `0` is the believed layout; anything
    /// else means the app is working on a fallback and should say so.
    root_rank: i32,
    /// Found by scanning rather than by the table — the fallback is load-bearing.
    discovered: bool,
}

/// Announced on `bglog-health`, on TRANSITION only. `tried` is filled for `Blind`
/// alone, because that is the only state where the interesting fact is the list of
/// places that turned out to be wrong.
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

/// The half of `read_bg_log` that has a path already, and one the probe has just seen
/// as a file. Split out so the test can drive it against a real file: the command
/// resolves through the environment, which a test must not go anywhere near
/// (CLAUDE.md's fixture-path rule), and a test that asserts about a `BgLog` it built
/// itself would prove nothing about either half.
///
/// Every failure here is `Unreadable` rather than a missing file, because the caller
/// only gets this far having watched `is_file()` answer yes: a permission wall or a
/// file that vanished mid-read is a different thing from a log that has not appeared.
fn bg_log_at(path: &std::path::Path, known_len: u64) -> BgLog {
    let disp = path.to_string_lossy().to_string();
    let miss = |len: u64| bg_miss(disp.clone(), len, BgMiss::Unreadable, Vec::new());
    let Ok(mut f) = std::fs::File::open(path) else { return miss(0) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // Nothing has been appended since the caller last looked. Note this is checked
    // BEFORE the zero-length shortcut would matter: a log that is still empty is also
    // a log that has not moved, and both answers are "there is nothing to fold in".
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

/// What this read says about the probe, or `None` when it says nothing.
///
/// Only the states that are *about the layout* speak. A log that has not appeared
/// yet, a task id that is not one and a file we could not open are all facts about one
/// record, and letting any of them move the announced state would make the badge
/// flicker on a shell that started two seconds ago.
fn bg_log_health_state(log: &BgLog) -> Option<BgHealth> {
    match log.reason {
        BgMiss::None => {
            Some(if log.root_rank == 0 && !log.discovered { BgHealth::Ok } else { BgHealth::Moved })
        }
        BgMiss::NoRoot | BgMiss::Ambiguous => Some(BgHealth::Blind),
        BgMiss::NotYet | BgMiss::BadId | BgMiss::Unreadable => None,
    }
}

/// The whole read against an injected environment and memo, with no `AppHandle` in
/// sight — so every test below drives the real ladder rather than a stand-in.
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
        // The root is right and the log has not been written yet — so the path is the
        // answer and the candidate list rides along for the row that wants to say
        // which of eight places it settled on.
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
        // Per task id, because the state is a per-record answer. A single slot holds
        // right up until one record resolves while another is blind, at which point
        // each read "transitions" the slot the other one set and the event fires on
        // every poll of every record — the flood this guard exists to prevent.
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

/// Read the tail of one background shell's log. `transcript` is the session's
/// `transcript_path` **as it stood when the shell was spawned** — see the note on
/// `BgServer` in types.ts for why it must not be re-derived from the session's current
/// one. Errors are states, not failures: an unresolvable address, a root that is not
/// where we looked and an unreadable file each come back with a `reason` the row can
/// print, because every one of them is a row that should still draw.
///
/// **`known_len` is what keeps this poll cheap.** It runs every few seconds against
/// every running server, and the overwhelmingly common case is a dev server nobody is
/// hitting, whose log has not moved since the last look. The file is append-only, so
/// its length is an exact test for that — one `metadata()` call instead of a 32 KiB
/// read. Same trick, and the same reasoning, as the discovery stamp in `tasks.rs`:
/// this is not a watcher, it is a cheap question asked often. Pass 0 to force a read.
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

    /// ASCII is left alone, byte for byte. Every existing key path — `^C`, an arrow
    /// key, Claude Code's chords, an ordinary line — must go down the pipe exactly as
    /// it does today, because all 95 printable ASCII characters already round-trip
    /// exactly and a rewrite could only lose that.
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
        assert_eq!(
            win32_input_encode("\x1b]11;rgb:00/00/00\x07"),
            "\x1b]11;rgb:00/00/00\x07"
        );
    }

    /// The flag is latched from ConPTY's own announcement, and only that. A PTY that
    /// never asks — every PTY on macOS and Linux — keeps the untouched byte path.
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

    /// The announcement split across two reads is still seen. Missing it is silent and
    /// degrades to exactly the bug, so the carry is not an optimisation.
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
                // ConPTY asks the terminal where the cursor is and stalls the child
                // until something answers. xterm.js does this for us in the app; a
                // PTY test that skips it simply hangs.
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
            assert_eq!(
                replay, whole,
                "split at chunk {split} lost or doubled bytes"
            );
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
        assert!(
            bytes.iter().all(|&b| b == b'x'),
            "the old line must be gone, not the fill"
        );
    }

    /// An evicted buffer starts mid-line — likely mid escape sequence, which on
    /// replay eats characters up to the next terminator — so the snapshot trims to
    /// the first newline. Before any eviction it must NOT trim: the first bytes a
    /// young session produced are real output, not a torn line.
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

    /// Rates add across concurrent agents — the figure is "what is Episko doing to the
    /// disk", so two agents reading 1 MiB/s each is 2 MiB/s, not an average.
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

    /// Closing a pane must not walk the run's churn backwards. The pid leaves
    /// `io_samples`, and its bytes have to land in `io_retired` on the way out or the
    /// app-wide total visibly drops.
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

    /// Every mode Settings offers, and nothing else. The whitelist is the security
    /// boundary for `spawn_external_terminal`, which interpolates this into a generated
    /// `.command` script — so what matters is not only that the six known spellings
    /// survive, but that everything else collapses to "no flag" instead of reaching a
    /// shell. The standard mode passing no flag is the other half: an absent
    /// `--permission-mode` is what ask-me-each-time already means.
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
        // Case matters: these are Claude Code's own spellings, and a near-miss must not
        // be quietly "corrected" into a mode the user didn't pick.
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
    //
    // The oracle for this half is a real filesystem, and where it can be, a filesystem
    // somebody else wrote. The test that used to stand here spelled the layout out
    // against a hand-written `/tmproot` and was green for this feature's entire life
    // while every read in production missed — because it and the code it checked were
    // written five minutes apart, from the same belief, by the same person. A table
    // test can only ever agree with our intent, and the intent was the bug.

    /// A transcript, and the two halves the address is derived from. The uuid is
    /// synthetic on purpose: three of the probe tests reach the directory scan, which
    /// walks the real `/tmp`, and an id that could collide with a session actually on
    /// this machine would make those tests pass or fail on what the developer did
    /// yesterday.
    const TR: &str =
        "/home/u/.claude/projects/E--tmp-episko-probe/5f6a1c2e-0b3d-4e5f-8a9b-1c2d3e4f5a6b.jsonl";
    const SLUG: &str = "E--tmp-episko-probe";
    const UUID: &str = "5f6a1c2e-0b3d-4e5f-8a9b-1c2d3e4f5a6b";
    const TASK: &str = "ep0kt3st9";

    /// A `BgLogEnv` with nothing ambient in it: the override base is a fixture, and
    /// `sys_tmp` points somewhere that does not exist so a test can only pass because
    /// of the tree it planted. The OS arrives as an argument, which is the whole point
    /// of `ClaudeOs` — the Windows row is assertable from a Mac.
    fn fixture_env(os: ClaudeOs, base: &std::path::Path, uid: Option<u32>) -> BgLogEnv {
        BgLogEnv {
            os,
            override_tmp: Some(base.to_path_buf()),
            sys_tmp: base.join("no-such-sys-tmp"),
            xdg_runtime: None,
            uid,
        }
    }

    /// Build a real `<root>/<slug>/<uuid>/tasks/<id>.output` and hand back its path.
    /// `log: None` plants the session directory with the `scratchpad` Claude mkdirs at
    /// start and no `tasks/` at all — the shape of a session whose first background
    /// shell has not run yet — and hands back the session directory instead.
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

    /// Two paths naming one file. `canonicalize` on both sides because a scratch dir
    /// and a probed path can differ by a `/private` symlink on macOS and by an 8.3
    /// short name on the Windows runner without differing by a single byte on disk.
    fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
        match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => a == b,
        }
    }

    /// The candidate table, all three rows, from whichever machine is running.
    ///
    /// The macOS row is the one that was wrong in production; the Windows row is the
    /// one **nobody here has ever observed**, and it is asserted from a Mac only
    /// because the OS is a value rather than a `#[cfg]`. Assertions go through
    /// `file_name()`/`parent()` rather than a spelled-out literal: `C:\…\claude` would
    /// fail on the macOS leg for the separator, which says nothing about the ordering
    /// this test exists to hold.
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

    /// `$CLAUDE_CODE_TMPDIR` is the one knob the CLI reads, and it moves the BASE.
    /// Everything below it still holds: the shapes the platform believes in, and the
    /// fallbacks under them, because an override that emptied the list would turn one
    /// mis-set variable into the same silent outage.
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

    /// Both shapes, every platform, with or without a uid to read. The Windows row
    /// orders the bare name first and that is all it does — pinning it as the only
    /// possibility is the mistake this whole block is a fix for, one layout along.
    #[test]
    fn bg_log_dir_names_never_drop_a_shape_we_cannot_observe() {
        for os in [ClaudeOs::Mac, ClaudeOs::Windows, ClaudeOs::Unix] {
            let both = bg_log_dir_names(os, Some(501));
            assert_eq!(both.len(), 2, "{os:?} named {both:?}");
            assert!(both.contains(&"claude".to_string()), "{os:?} dropped the bare shape");
            assert!(both.contains(&"claude-501".to_string()), "{os:?} dropped the suffixed shape");
            // No uid to read — every Windows build, since `current_uid()` goes through
            // a Unix-only API — is `claude-0`, which is what the bundle's
            // `claude-${process.getuid?.() ?? 0}` computes there. Dropping the shape
            // instead left Windows probing ONE name, the one we believe least, with
            // the throttled directory scan as the only thing behind it.
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

    /// The first existing FILE wins, never the first existing ROOT. A stale root left
    /// behind by an older layout — or by another session of ours that has since been
    /// reaped — is a directory that exists and holds nothing for THIS shell, and a
    /// probe that stopped at it would pick the empty one on every poll for the life of
    /// the app: every row would report `notYet`, and `notYet` is the one reason the
    /// frontend retires a row on, so "rows that never leave" would become "rows that
    /// always leave" with every gate green.
    ///
    /// So the stale root is planted FIRST, at rank 0, and the real log one row down.
    /// Planted the other way round the test passes whether or not the rule holds,
    /// which is what it did until a mutation — stop at the first existing root — went
    /// green through the whole suite.
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

    /// The state nobody would think to build: the probe won, one row down. The app
    /// still works and says so anyway, which is the release of warning between "the
    /// fallback is carrying us" and "the fallback stopped matching too".
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

    /// A session directory with no log under it is a shell that is *starting*, not a
    /// root that has moved. The two are one word apart on the wire and worlds apart in
    /// effect: `notYet` is the state the frontend retires a row on after ten minutes,
    /// and `noRoot` is the outage it must never retire on.
    #[test]
    fn bg_log_probe_says_not_yet_when_the_session_dir_exists_but_the_log_does_not() {
        let base = crate::testutil::scratch_dir();
        // `scratchpad` and nothing else: Claude mkdirs it at session start, while
        // `tasks/` appears only once a shell has actually been backgrounded.
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

    /// Nothing anywhere. The row's whole value here is the LIST: "no log found —
    /// looked in six places" is a bug report, and "no output yet" is the silence that
    /// let this ship broken. So `path` is empty and `tried` is the answer; exactly one
    /// of the two ever is.
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

    /// Two roots holding one session, and we refuse to choose. A guess here puts this
    /// row's peek — and its URL, and its exit sentinel — on somebody else's log, which
    /// is a confident lie where the honest answer costs one line of prose.
    #[test]
    fn bg_log_probe_refuses_to_choose_between_two_roots_holding_the_same_session() {
        let base = crate::testutil::scratch_dir();
        plant(&base.join("claude-501"), SLUG, UUID, Some((TASK, "one\n")));
        plant(&base.join("claude-0"), SLUG, UUID, Some((TASK, "the other\n")));

        // A uid that matches neither, so the table cannot settle it and the scan is
        // what finds both — which is exactly the situation ambiguity is for.
        let mut memo = BgRootState::default();
        let got = read_bg_log_at_env(&fixture_env(ClaudeOs::Mac, &base, Some(4242)), &mut memo, TR, TASK, 0);
        assert_eq!(got.reason, BgMiss::Ambiguous);
        assert_eq!(got.path, "", "an ambiguous probe must not name one of them anyway");
        assert_eq!(got.tried.len(), 2, "tried was {:?}", got.tried);
    }

    /// The slug is a sanitised cwd with a base-36 hash spliced in once it grows too
    /// long, and we deliberately do not reproduce that hash — reproducing somebody
    /// else's build is how the root component got written down wrong in the first
    /// place. The uuid one level down is enough to find the tree without it.
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

    /// The memo is remembered and then INVALIDATED, never defended. It exists because
    /// the alternative — one `is_file()` times eight roots times every live record
    /// every four seconds — is the cost this feature would otherwise pay forever; it
    /// is dropped the moment it stops holding because `$CLAUDE_CODE_TMPDIR` can change
    /// under a running app and `/tmp` gets reaped, and a memo that outlives its root is
    /// the same permanent silence in a new coat.
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

        // The root moves out from under it — to the shape one row down, so there is
        // still a right answer and "stopped resolving" cannot pass for correct.
        std::fs::rename(&won, base.join("claude")).unwrap();
        let after = bg_log_resolve(&e, &mut memo, TR, TASK, std::time::Instant::now())
            .expect("the probe must re-walk the table rather than defend a stale memo");
        assert!(!after.from_memo, "the memo answered for a root that no longer holds the log");
        assert_eq!(after.rank, 1, "it should have landed on the other shape");
        assert_eq!(memo.root.as_deref(), Some(base.join("claude").as_path()));
    }

    /// The scan is the expensive step and the blind fleet is the one that would run it
    /// most: `read_bg_log` is called every four seconds per live record, so ten blind
    /// shells is a `read_dir` of a busy `/tmp` a hundred and fifty times a minute for
    /// a hundred and fifty identical answers. The throttle is process-wide for exactly
    /// that reason — per record it would not throttle the case that needs it.
    #[test]
    fn bg_log_probe_scans_at_most_once_a_minute_however_many_records_are_blind() {
        let base = crate::testutil::scratch_dir();
        let e = fixture_env(ClaudeOs::Mac, &base, Some(501));
        let mut memo = BgRootState::default();
        let now = std::time::Instant::now();
        let first = bg_log_resolve(&e, &mut memo, TR, TASK, now);
        assert!(matches!(first, Err(BgResolveErr::NoRoot(_))), "the empty base is blind");
        assert_eq!(memo.last_scan, Some(now), "the first read must scan");

        // The log lands a moment later, under a root name no candidate in the table
        // can spell — so ONLY the scan can see it. That is what makes the throttle
        // observable: with it, the reads below cannot find this file; without it, the
        // very next one does. Timestamping `last_scan` proves nothing on its own,
        // since a skipped read and a re-run one leave the same instant in it.
        let planted = plant(&base.join("claude-9999"), SLUG, UUID, Some((TASK, "up\n")));
        for i in 0..5 {
            let r = bg_log_resolve(&e, &mut memo, TR, TASK, now);
            assert!(
                matches!(r, Err(BgResolveErr::NoRoot(_))),
                "read {i} scanned inside the window and found {planted:?}"
            );
            assert_eq!(memo.last_scan, Some(now), "read {i} restamped the window");
        }
        // ...and it does come back. A throttle that latched would be the memo bug
        // again: a probe that stops looking is a probe that can never recover.
        let later = now + BG_SCAN_EVERY;
        let got = bg_log_resolve(&e, &mut memo, TR, TASK, later)
            .expect("the scan must resume once its window is up");
        assert!(same_file(&got.path, &planted), "resolved {:?}, not {planted:?}", got.path);
        assert!(got.discovered, "only the scan can reach a root the table cannot spell");
        assert_eq!(memo.last_scan, Some(later), "the scan never resumed after its window");
    }

    /// A log only the SCAN can find has to be cheap to find again, or the throttle
    /// turns one hit into a flap: step (1) rebuilds the path from the slug we derive,
    /// which is precisely the slug this tree does not use, so every poll inside the
    /// scan's minute would report `noRoot` about a file the probe has already read.
    /// The row's peek would flip to "no log found" for fourteen polls out of fifteen.
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

    /// Declining to scan is not evidence that the remembered root stopped holding —
    /// and the memo is process-wide, so treating it as evidence takes the whole fleet
    /// down with one blind record: every OTHER live server re-walks the eight-candidate
    /// table on its next poll because somebody else's read hit the throttle.
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

    /// The wire shape, in the frontend's spelling. `root_rank` is the first multi-word
    /// field this struct has ever had, and a snake_case key arriving at a camelCase
    /// interface is a silent `undefined`: every rule reading it answers "no", and tsc,
    /// vitest and cargo all stay green. That is the original bug's exact shape, which
    /// is why the rename is checked here and joined to the TS side in ipc.test.ts.
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
        // The enum is wire vocabulary, not a Rust identifier: `NoRoot` on the wire
        // would match nothing in `BgMissReason` and every rule would answer "no".
        assert_eq!(v["reason"], serde_json::json!("noRoot"));
    }

    /// A fleet nobody can hear must never look like a quiet one — and it must not
    /// shout either. `bglog-health` fires on TRANSITION only, because one event per
    /// poll per blind record would push the debug console's 400-entry ring clean out
    /// inside a minute, emptying the panel that exists to show it.
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

        // ...and coming back is a transition too. Without this the app would go quiet
        // about its own recovery and the badge would never clear.
        plant(&base.join("claude-501"), SLUG, UUID, Some((TASK, "up\n")));
        let got = read_bg_log_announced(app.handle(), &e, &mut memo, TR, TASK, 0);
        assert!(!got.missing, "the planted log must read");
        let all = heard.lock().unwrap().clone();
        assert_eq!(all.len(), 2, "recovery was not announced");
        let back: serde_json::Value = serde_json::from_str(&all[1]).expect("the event is JSON");
        assert_eq!(back["state"], "ok");
        assert_eq!(back["rank"], 0);
    }

    /// Two records, two different answers, and neither may re-announce the other. The
    /// state is a per-RECORD fact, so a single announced slot holds only until one
    /// record resolves while another is blind — after which each read "transitions" the
    /// slot the other one set, and a fleet that is behaving exactly as designed emits
    /// two events every four seconds forever. That is 30 `dlog` lines a minute into a
    /// 400-entry ring: the debug console empties itself in about a quarter of an hour,
    /// and it is the panel this event exists to reach.
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
        // The same task id under two sessions, which is the case the key is a PAIR for:
        // an id is Claude's and unique only within the session that minted it.
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

    /// `moved` is the announcement for a probe that is WORKING. Nobody would think to
    /// build it, which is why it is the one worth a test: it is the only warning
    /// anyone gets between the believed layout going stale and the fallback going
    /// stale too, and by then every row is blind again.
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

    /// The id lands in a path, so it is validated rather than trusted. It arrives in a
    /// hook payload — the one part of this whole feature that is neither ours nor
    /// checked by anything upstream of us.
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

    /// A transcript path that isn't one resolves to nothing rather than to a plausible
    /// wrong file. The frontend draws the row either way; what it must not do is offer
    /// to reveal a path we invented.
    #[test]
    fn bg_log_path_refuses_a_transcript_without_both_halves() {
        let root = std::path::Path::new("/tmproot/claude-501");
        for bad in ["", "uuid.jsonl", "/"] {
            assert!(bg_log_path(root, bad, "bs0hhu7b4").is_none(), "{bad:?} resolved");
        }
    }

    /// The tail is the point: only the end of the file crosses the IPC boundary, and a
    /// log longer than the window must come back cut at the front, not at the back. A
    /// real dev server left running an afternoon measured 300 KiB, so this is the
    /// normal case rather than the extreme one.
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

    /// The poll's cheap path, and the two halves of it that must both hold. Without the
    /// gate, every running server costs a 32 KiB read every few seconds forever, and a
    /// dev server nobody is hitting is exactly the case whose log never moves. Without
    /// the gate *breaking* on an append, a server's death would never be noticed — the
    /// sentinel arrives the same way everything else does.
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

    /// An empty log - a shell that has started but printed nothing yet - is *unchanged*
    /// rather than missing. The distinction matters: missing means the row has no file
    /// to name, and a shell that simply has not spoken yet does.
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

    /// **The oracle here is a tree Anthropic wrote**, which is the one thing a table
    /// test could never be: it cannot agree with our intent, because our intent had no
    /// hand in it. It searches this machine for a log Claude Code actually produced —
    /// through bases written out independently, NEVER through `bg_log_roots`, since
    /// deriving the search from the table it checks is precisely how the test this
    /// replaced stayed green while every read in production missed — and asks the real
    /// resolver to find it.
    ///
    /// In the DEFAULT suite on purpose. A developer runs this twenty times a day and
    /// `--ignored` runs about monthly, so this is the difference between finding out
    /// the layout moved on the day it moves and finding out a release later. A machine
    /// with no witness skips out loud rather than passing quietly.
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
                        // A log with its transcript beside it. The pair is what the app
                        // resolves; half of one would prove nothing about the join.
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

        // The rank-0 claim is about the AMBIENT layout, so it is made once, about the
        // newest log, and only when nothing has moved the base out from under us. An
        // old log under a root that has since been re-pointed is not a layout failure.
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
                // Refusing to choose between two roots holding one session is the
                // designed answer, not a layout failure — what matters is that the
                // real file was among the ones it saw.
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

    /// The other oracle that is not ours, and the only way the WINDOWS row of
    /// `bg_log_dir_names` ever stops being a belief: run the real binary and look at
    /// what it created.
    ///
    /// It costs **no tokens and needs no auth** — the request is pointed at a dead
    /// loopback port with a bogus key, and the temp root is made within a second of
    /// the session starting (measured). Its exit status is deliberately not asserted;
    /// the filesystem is the answer, so it is **spawned, polled for and killed** rather
    /// than waited on. Blocking on the process instead would leave the only bound on
    /// this test an env var nobody documents: `CLAUDE_CODE_MAX_RETRIES=0` is what stops
    /// `claude -p` retrying the dead endpoint with backoff, and a release that renames
    /// it — precisely the class of upstream change this test exists to catch — would
    /// hang a developer's `--ignored` pass with no timeout at all.
    ///
    /// **A skip is a lie on a machine that just installed the CLI**, so
    /// `EPISKO_REQUIRE_CLAUDE` turns the not-installed case into a failure. The weekly
    /// workflow sets it: a green leg that observed nothing is indistinguishable from a
    /// green leg that confirmed the layout, and the Windows row is the whole reason
    /// that job exists.
    ///
    /// The `claude_layout_` name prefix is load-bearing. A `claude_cli_still_` one
    /// would be swept up by the same filter that selects
    /// `claude_cli_still_honours_our_instrumentation`, which needs real auth and spends
    /// tokens — and the obvious fix for the resulting red would be an API key billing
    /// tokens on a schedule, on two runners.
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
            // A box without Claude Code installed is one this can say nothing about —
            // unless the runner has just installed it, in which case the silence is the
            // failure. `claude` at {claude:?} is printed either way: on Windows an npm
            // global install leaves an extensionless sh shim that `CreateProcessW`
            // cannot start, and "could not be launched" is a different bug report from
            // "the layout moved".
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !required => {
                eprintln!("skipping: `claude` is not installed (looked at {claude:?})");
                return;
            }
            Err(e) => panic!(
                "could not launch `claude` at {claude:?}: {e}. This machine was told it has the \
                 CLI, so the layout stayed unobserved — which is not the same thing as unchanged."
            ),
        };

        // Poll for the tree rather than waiting for the process: the root appears at
        // session start and the CLI goes on failing its way to an exit long afterwards.
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
            // The id is the wire value `spawn_agent` takes and the key the frontend
            // stores on a pane, so it has to be a stable slug rather than a display
            // name that might get prettied up later.
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
            // Keep the compatibility field well-formed and collision-free even though
            // current frontends paint a provider-owned SVG instead.
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
        // Deliberate, and easy to "fix" by someone who reads the list as an omission:
        // launching claude through this path would strip the instrumentation the whole
        // cockpit is built on. See the AGENTS doc comment.
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
        // The lookup `spawn_agent` refuses on. A frontend that sent a label, a binary
        // name or a stale id must not fall through to launching *something*.
        for bogus in ["", "Codex", "cursor-agent", "claude", "opencode2"] {
            assert!(
                agent_spec(bogus).is_none(),
                "{bogus:?} should not resolve to an agent"
            );
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
            assert_eq!(
                (spec.label, spec.bin, spec.mark),
                (info.label, info.bin, info.mark)
            );
            // A `Some` path is a promise the agent will start, so it has to be a real
            // file — that is what the picker lets you click.
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
        // The other half of the contract above: a miss is `None`, never a bare-name
        // fallback. If this ever returns Some, every agent is in every picker.
        assert!(resolve_cli("episko-definitely-not-a-real-binary").is_none());
    }
}
