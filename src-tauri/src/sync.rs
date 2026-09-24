//! The app's side of sync (docs/sync.md): one WebSocket to a self-hosted `episko-server`, held
//! from Rust so the token never reaches the webview and the socket survives a reload. It
//! decides nothing about what syncs — ./sync.ts does — and emits every server message as
//! `sync-event`. With sync unconfigured it does nothing at all.

use episko_proto::{ClientMsg, ErrorCode, NewEvent, ServerMsg, PROTOCOL};
use serde::Serialize;
use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::HandshakeError;
use tungstenite::http::{HeaderName, HeaderValue, StatusCode};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(150);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
const CONFIG_FILE: &str = "sync.json";

/// What survives a restart, beside the token (which is sealed separately).
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, Serialize)]
pub(crate) struct SyncConfig {
    url: String,
    user: String,
    device: String,
    label: String,
    /// The last seq the frontend said it applied; a reconnect replays from here.
    cursor: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatus {
    configured: bool,
    url: String,
    user: String,
    device: String,
    label: String,
    cursor: u64,
    connected: bool,
    last_ok_at: Option<i64>,
    error: Option<String>,
    /// The server refused our token or protocol: retrying cannot help, re-pairing can.
    halted: bool,
    /// The extra headers' NAMES; their values are sealed with the token and never leave Rust.
    header_names: Vec<String>,
}

/// Extra handshake headers for a proxy in front of the server: Traefik's basic auth, or a
/// Cloudflare Access service token (`CF-Access-Client-Id` + `CF-Access-Client-Secret`).
pub(crate) type Headers = Vec<(String, String)>;
const MAX_HEADERS: usize = 16;
// The handshake's own: a proxy header must never be able to rewrite the upgrade itself.
const RESERVED: [&str; 6] = ["host", "connection", "upgrade", "content-length", "transfer-encoding", "origin"];

fn check_headers(h: &Headers) -> Result<(), String> {
    if h.len() > MAX_HEADERS { return Err(format!("at most {MAX_HEADERS} extra headers")); }
    let mut seen = std::collections::HashSet::new();
    for (k, v) in h {
        let lower = k.trim().to_ascii_lowercase();
        if RESERVED.contains(&lower.as_str()) || lower.starts_with("sec-websocket-") { return Err(format!("{k} is the WebSocket handshake's own header")); }
        HeaderName::from_bytes(k.trim().as_bytes()).map_err(|_| format!("{k:?} is not a header name"))?;
        HeaderValue::from_str(v.trim()).map_err(|_| format!("the value of {k} has characters a header cannot carry"))?;
        if !seen.insert(lower) { return Err(format!("{k} is given twice")); }
    }
    Ok(())
}

/// Everything the connection thread reports, emitted verbatim as `sync-event`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SyncOut {
    Status { status: SyncStatus },
    Server { msg: ServerMsg },
    Pushed { id: u64, seqs: Vec<u64> },
}

enum Ctl {
    Push(u64, Vec<NewEvent>),
    Presence(serde_json::Value),
    Reconnect,
}

pub(crate) struct SyncCtl {
    dir: Mutex<Option<PathBuf>>,
    status: Mutex<SyncStatus>,
    tx: Mutex<Option<Sender<Ctl>>>,
    /// Bumped by pair/forget/start: a thread holding an older generation stops on its own.
    generation: AtomicU64,
    ready: AtomicBool,
}

impl Default for SyncCtl {
    fn default() -> Self {
        SyncCtl { dir: Mutex::new(None), status: Mutex::new(SyncStatus::default()), tx: Mutex::new(None), generation: AtomicU64::new(0), ready: AtomicBool::new(false) }
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// `https://host` and `host:port` are what people paste; the socket wants `ws(s)://`.
fn norm_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let (scheme, rest) = match t.split_once("://") {
        Some(("https" | "wss", r)) => ("wss", r),
        Some(("http" | "ws", r)) => ("ws", r),
        Some((other, _)) => return Err(format!("{other}:// is not a sync server address")),
        None => ("ws", t),
    };
    let rest = rest.trim_end_matches('/');
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || host.contains(' ') || host.ends_with(':') { return Err(format!("{t} is not a server address")); }
    Ok(format!("{scheme}://{rest}/"))
}

fn host_port(url: &str) -> Result<(String, u16), String> {
    let tls = url.starts_with("wss://");
    let authority = url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or("");
    // An IPv6 literal carries its own colons, so the port is only what follows `]:`.
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(':') && p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h, p.parse().map_err(|_| "bad port")?),
        _ => (authority, if tls { 443 } else { 80 }),
    };
    Ok((host.trim_matches(['[', ']']).to_string(), port))
}

type Sock = WebSocket<MaybeTlsStream<TcpStream>>;

/// What a proxy's refusal means, in words that point at the fix rather than at HTTP.
fn refused(code: StatusCode) -> String {
    let n = code.as_u16();
    match n {
        401 | 403 => format!("the proxy in front of the server refused this machine (HTTP {n}); check the extra headers in Settings › Sync"),
        300..=399 => format!("the address redirects (HTTP {n}), usually to a login page; Cloudflare Access and similar need a service token in the extra headers"),
        _ => format!("the server answered HTTP {n} instead of opening a sync connection"),
    }
}

fn open(url: &str, headers: &Headers) -> Result<Sock, String> {
    let (host, port) = host_port(url)?;
    let mut req = url.into_client_request().map_err(|e| format!("{url} is not a server address: {e}"))?;
    for (k, v) in headers {
        let name = HeaderName::from_bytes(k.trim().as_bytes()).map_err(|_| format!("{k:?} is not a header name"))?;
        req.headers_mut().insert(name, HeaderValue::from_str(v.trim()).map_err(|_| format!("bad value for {k}"))?);
    }
    let addr = (host.as_str(), port).to_socket_addrs().map_err(|e| format!("cannot resolve {host}: {e}"))?
        .next().ok_or_else(|| format!("{host} has no address"))?;
    let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| format!("cannot reach {host}:{port}: {e}"))?;
    tcp.set_read_timeout(Some(CONNECT_TIMEOUT)).map_err(|e| e.to_string())?;
    match tungstenite::client_tls(req, tcp) {
        Ok((sock, _)) => Ok(sock),
        Err(HandshakeError::Failure(tungstenite::Error::Http(r))) => Err(refused(r.status())),
        Err(e) => Err(format!("handshake with {url} failed: {e}")),
    }
}

fn tcp_of(sock: &Sock) -> &TcpStream {
    match sock.get_ref() {
        MaybeTlsStream::Plain(s) => s,
        MaybeTlsStream::NativeTls(s) => s.get_ref(),
        _ => unreachable!("only plain and native-tls streams are built"),
    }
}

fn say(sock: &mut Sock, m: &ClientMsg) -> Result<(), String> {
    sock.send(Message::text(serde_json::to_string(m).expect("a ClientMsg always serialises"))).map_err(|e| e.to_string())
}

fn hear(sock: &mut Sock) -> Result<Option<ServerMsg>, String> {
    match sock.read() {
        Ok(Message::Text(t)) => serde_json::from_str(&t).map(Some).map_err(|e| format!("unreadable server message: {e}")),
        Ok(Message::Close(_)) => Err("the server closed the connection".into()),
        Ok(_) => Ok(None),
        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Trades an invite code for a token over a short-lived connection of its own.
fn pair_with(url: &str, code: &str, label: &str, headers: &Headers) -> Result<(String, String, String), String> {
    let mut sock = open(url, headers)?;
    say(&mut sock, &ClientMsg::Pair { code: code.trim().to_string(), label: label.to_string() })?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    while Instant::now() < deadline {
        match hear(&mut sock)? {
            Some(ServerMsg::Paired { token, user, device }) => { let _ = sock.close(None); return Ok((token, user, device)); }
            Some(ServerMsg::Error { message, .. }) => return Err(message),
            _ => {}
        }
    }
    Err("the server did not answer the pairing".into())
}

/// Why a session ended: `Halt` means retrying is pointless until the user re-pairs.
#[derive(Debug, PartialEq)]
enum End { Retry(String), Halt(String), Stopped }

/// One connected session: hello, then relay both ways until it fails or `rx` says reconnect.
#[allow(clippy::too_many_arguments)] // one connection's whole context; a struct would only rename it
fn session(url: &str, token: &str, headers: &Headers, since: u64, rx: &Receiver<Ctl>, out: &dyn Fn(SyncOut), alive: &dyn Fn() -> bool, on_ok: &dyn Fn()) -> End {
    let mut sock = match open(url, headers) { Ok(s) => s, Err(e) => return End::Retry(e) };
    if let Err(e) = say(&mut sock, &ClientMsg::Hello { token: token.to_string(), since, protocol: PROTOCOL }) { return End::Retry(e); }
    if let Err(e) = tcp_of(&sock).set_read_timeout(Some(POLL)) { return End::Retry(e.to_string()); }
    let mut inflight: std::collections::VecDeque<u64> = Default::default();
    loop {
        if !alive() { let _ = sock.close(None); return End::Stopped; }
        match hear(&mut sock) {
            Ok(Some(ServerMsg::Error { code: code @ (ErrorCode::BadToken | ErrorCode::Protocol), message })) => {
                out(SyncOut::Server { msg: ServerMsg::Error { code, message: message.clone() } });
                return End::Halt(message);
            }
            Ok(Some(ServerMsg::Pushed { seqs })) => { on_ok(); out(SyncOut::Pushed { id: inflight.pop_front().unwrap_or(0), seqs }); }
            Ok(Some(msg)) => { on_ok(); out(SyncOut::Server { msg }); }
            Ok(None) => {}
            Err(e) => return End::Retry(e),
        }
        loop {
            match rx.recv_timeout(Duration::ZERO) {
                Ok(Ctl::Push(id, events)) => {
                    inflight.push_back(id);
                    if let Err(e) = say(&mut sock, &ClientMsg::Push { events }) { return End::Retry(e); }
                }
                Ok(Ctl::Presence(items)) => {
                    if let Err(e) = say(&mut sock, &ClientMsg::Presence { items }) { return End::Retry(e); }
                }
                Ok(Ctl::Reconnect) => { let _ = sock.close(None); return End::Retry("reconnecting".into()); }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return End::Stopped,
            }
        }
    }
}

// ---------- secrets, sealed per OS (docs/sync.md) ----------

/// The token and the extra headers, each sealed on its own: DPAPI, a keychain item, a 0600 file.
#[derive(Clone, Copy)]
enum Secret { Token, Headers }
impl Secret {
    fn file(self) -> &'static str { match self { Secret::Token => "sync.token", Secret::Headers => "sync.headers" } }
    #[cfg(target_os = "macos")]
    fn account(self) -> &'static str { match self { Secret::Token => "sync", Secret::Headers => "sync-headers" } }
}
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Episko sync";

#[cfg(windows)]
fn dpapi(data: &[u8], seal: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: both blobs outlive the call; the output buffer is LocalAlloc'd and freed below.
    let ok = unsafe {
        if seal { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output) }
        else { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output) }
    };
    if ok == 0 { return Err(std::io::Error::last_os_error().to_string()); }
    // SAFETY: on success `pbData` points at `cbData` bytes owned by us until LocalFree.
    let v = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _) };
    Ok(v)
}

/// `value` must be printable ASCII with no spaces or quotes (the keychain arm types it): hex is.
fn save_secret(dir: &std::path::Path, which: Secret, value: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    { std::fs::write(dir.join(which.file()), dpapi(value.as_bytes(), true)?).map_err(|e| e.to_string()) }
    #[cfg(target_os = "macos")]
    {
        let _ = dir;
        // `-i` reads the command from stdin, so the secret never appears in a process listing.
        let mut child = std::process::Command::new("/usr/bin/security").arg("-i")
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).spawn().map_err(|e| e.to_string())?;
        use std::io::Write;
        let line = format!("add-generic-password -U -a {} -s \"{KEYCHAIN_SERVICE}\" -w {value}\n", which.account());
        child.stdin.take().ok_or("no stdin")?.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        let st = child.wait().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err("the keychain refused the secret".into()) }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600)
            .open(dir.join(which.file())).map_err(|e| e.to_string())?;
        f.write_all(value.as_bytes()).map_err(|e| e.to_string())
    }
}

fn load_secret(dir: &std::path::Path, which: Secret) -> Option<String> {
    #[cfg(windows)]
    { String::from_utf8(dpapi(&std::fs::read(dir.join(which.file())).ok()?, false).ok()?).ok() }
    #[cfg(target_os = "macos")]
    {
        let _ = dir;
        let o = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-a", which.account(), "-s", KEYCHAIN_SERVICE, "-w"]).output().ok()?;
        let t = String::from_utf8(o.stdout).ok()?.trim().to_string();
        (o.status.success() && !t.is_empty()).then_some(t)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    { std::fs::read_to_string(dir.join(which.file())).ok().map(|s| s.trim().to_string()) }
}

fn drop_secret(dir: &std::path::Path, which: Secret) {
    let _ = std::fs::remove_file(dir.join(which.file()));
    #[cfg(target_os = "macos")]
    { let _ = std::process::Command::new("/usr/bin/security").args(["delete-generic-password", "-a", which.account(), "-s", KEYCHAIN_SERVICE]).output(); }
}

fn save_token(dir: &std::path::Path, token: &str) -> Result<(), String> { save_secret(dir, Secret::Token, token) }
fn load_token(dir: &std::path::Path) -> Option<String> { load_secret(dir, Secret::Token) }

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn unhex(s: &str) -> Option<Vec<u8>> {
    (s.len() % 2 == 0).then_some(())?;
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}
/// Stored as hex JSON, which every arm can carry verbatim. None is sealed as no file at all.
fn save_headers(dir: &std::path::Path, h: &Headers) -> Result<(), String> {
    if h.is_empty() { drop_secret(dir, Secret::Headers); return Ok(()); }
    save_secret(dir, Secret::Headers, &hex(serde_json::to_string(h).map_err(|e| e.to_string())?.as_bytes()))
}
fn load_headers(dir: &std::path::Path) -> Headers {
    load_secret(dir, Secret::Headers).and_then(|s| unhex(&s)).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn names(h: &Headers) -> Vec<String> { h.iter().map(|(k, _)| k.trim().to_string()).collect() }

fn read_config(dir: &std::path::Path) -> Option<SyncConfig> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(CONFIG_FILE)).ok()?).ok()
}

fn write_config(dir: &std::path::Path, c: &SyncConfig) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(c).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dir.join(CONFIG_FILE)).map_err(|e| e.to_string())
}

// ---------- the supervisor thread ----------

fn emit_status(app: &AppHandle, ctl: &SyncCtl) {
    let status = lock(&ctl.status).clone();
    let _ = app.emit("sync-event", SyncOut::Status { status });
}

fn set_status(app: &AppHandle, ctl: &SyncCtl, f: impl FnOnce(&mut SyncStatus)) {
    let changed = {
        let mut s = lock(&ctl.status);
        let before = (s.connected, s.error.clone(), s.halted, s.configured, s.header_names.clone());
        f(&mut s);
        before != (s.connected, s.error.clone(), s.halted, s.configured, s.header_names.clone())
    };
    if changed { emit_status(app, ctl); }
}

/// (Re)starts the connection thread for the current config; any older thread retires itself.
fn restart(app: &AppHandle, ctl: &Arc<SyncCtl>) {
    let gen = ctl.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = channel();
    *lock(&ctl.tx) = Some(tx);
    let dir = lock(&ctl.dir).clone();
    let Some(dir) = dir else { return };
    let Some(cfg) = read_config(&dir) else {
        set_status(app, ctl, |s| *s = SyncStatus::default());
        return;
    };
    let token = load_token(&dir);
    let headers = load_headers(&dir);
    set_status(app, ctl, |s| {
        s.configured = true; s.url = cfg.url.clone(); s.user = cfg.user.clone(); s.device = cfg.device.clone();
        s.label = cfg.label.clone(); s.cursor = cfg.cursor; s.halted = false; s.header_names = names(&headers);
        s.error = token.is_none().then(|| "this device's sync token is missing; pair it again".to_string());
    });
    if token.is_none() || !ctl.ready.load(Ordering::SeqCst) { return; }
    let (app, ctl, token) = (app.clone(), ctl.clone(), token.unwrap_or_default());
    std::thread::spawn(move || supervise(app, ctl, gen, cfg.url, token, headers, rx));
}

fn supervise(app: AppHandle, ctl: Arc<SyncCtl>, gen: u64, url: String, token: String, headers: Headers, rx: Receiver<Ctl>) {
    let alive = || ctl.generation.load(Ordering::SeqCst) == gen;
    let mut backoff = Duration::from_secs(1);
    while alive() {
        let since = lock(&ctl.status).cursor;
        let out = |o: SyncOut| {
            if let SyncOut::Server { msg: ServerMsg::Welcome { .. } } = &o {
                set_status(&app, &ctl, |s| { s.connected = true; s.error = None; });
                log::info!("sync: connected to {url}");
            }
            let _ = app.emit("sync-event", o);
        };
        let on_ok = || lock(&ctl.status).last_ok_at = Some(now_ms());
        let end = session(&url, &token, &headers, since, &rx, &out, &alive, &on_ok);
        let was_up = lock(&ctl.status).connected;
        match end {
            End::Stopped => { set_status(&app, &ctl, |s| s.connected = false); return; }
            End::Halt(e) => {
                log::error!("sync: halted: {e}");
                set_status(&app, &ctl, |s| { s.connected = false; s.halted = true; s.error = Some(e); });
                return;
            }
            End::Retry(e) => {
                if was_up { log::warn!("sync: lost {url}: {e}"); backoff = Duration::from_secs(1); }
                set_status(&app, &ctl, |s| { s.connected = false; s.error = Some(e); });
            }
        }
        let until = Instant::now() + backoff;
        while alive() && Instant::now() < until {
            // A reconnect asked for during the wait is answered at once rather than after it.
            if let Ok(Ctl::Reconnect) = rx.recv_timeout(Duration::from_millis(200)) { break; }
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// Called once from `setup()`: finds the config dir. Nothing connects until the frontend is ready.
pub(crate) fn init(app: &AppHandle) {
    let st = app.state::<crate::AppState>();
    *lock(&st.sync.dir) = app.path().app_config_dir().ok();
}

// ---------- commands ----------

#[tauri::command]
pub(crate) fn sync_status(state: State<'_, crate::AppState>) -> SyncStatus {
    lock(&state.sync.status).clone()
}

/// The frontend has its listeners up: connect, and replay from the last applied cursor.
#[tauri::command]
pub(crate) fn sync_start(app: AppHandle, state: State<'_, crate::AppState>) -> SyncStatus {
    state.sync.ready.store(true, Ordering::SeqCst);
    restart(&app, &state.sync);
    lock(&state.sync.status).clone()
}

#[tauri::command]
pub(crate) async fn sync_pair(app: AppHandle, url: String, code: String, label: String, headers: Headers) -> Result<SyncStatus, String> {
    let url = norm_url(&url)?;
    check_headers(&headers)?;
    let label = if label.trim().is_empty() { "this machine".to_string() } else { label.trim().to_string() };
    let (token, user, device) = tauri::async_runtime::spawn_blocking({
        let (url, label, headers) = (url.clone(), label.clone(), headers.clone());
        move || pair_with(&url, &code, &label, &headers)
    }).await.map_err(|e| e.to_string())??;
    let state = app.state::<crate::AppState>();
    let dir = lock(&state.sync.dir).clone().ok_or("no config directory")?;
    save_token(&dir, &token)?;
    save_headers(&dir, &headers)?;
    write_config(&dir, &SyncConfig { url, user, device, label, cursor: 0 })?;
    restart(&app, &state.sync);
    let status = lock(&state.sync.status).clone();
    Ok(status)
}

#[tauri::command]
pub(crate) fn sync_forget(app: AppHandle, state: State<'_, crate::AppState>) -> SyncStatus {
    if let Some(dir) = lock(&state.sync.dir).clone() {
        drop_secret(&dir, Secret::Token);
        drop_secret(&dir, Secret::Headers);
        let _ = std::fs::remove_file(dir.join(CONFIG_FILE));
    }
    restart(&app, &state.sync);
    lock(&state.sync.status).clone()
}

/// Replaces the extra headers (a rotated Access secret, say) and reconnects with them.
#[tauri::command]
pub(crate) fn sync_set_headers(app: AppHandle, state: State<'_, crate::AppState>, headers: Headers) -> Result<SyncStatus, String> {
    check_headers(&headers)?;
    let dir = lock(&state.sync.dir).clone().ok_or("no config directory")?;
    save_headers(&dir, &headers)?;
    restart(&app, &state.sync);
    let status = lock(&state.sync.status).clone();
    Ok(status)
}

#[tauri::command]
pub(crate) fn sync_push(state: State<'_, crate::AppState>, id: u64, events: Vec<NewEvent>) -> bool {
    lock(&state.sync.tx).as_ref().is_some_and(|tx| tx.send(Ctl::Push(id, events)).is_ok())
}

#[tauri::command]
pub(crate) fn sync_presence(state: State<'_, crate::AppState>, items: serde_json::Value) -> bool {
    lock(&state.sync.tx).as_ref().is_some_and(|tx| tx.send(Ctl::Presence(items)).is_ok())
}

/// The frontend applied everything up to `seq`: the next reconnect replays from there.
#[tauri::command]
pub(crate) fn sync_ack(state: State<'_, crate::AppState>, seq: u64) -> Result<(), String> {
    let ctl = &state.sync;
    {
        let mut s = lock(&ctl.status);
        if seq <= s.cursor { return Ok(()); }
        s.cursor = seq;
    }
    let dir = lock(&ctl.dir).clone().ok_or("no config directory")?;
    let Some(mut cfg) = read_config(&dir) else { return Ok(()) };
    cfg.cursor = seq;
    write_config(&dir, &cfg)
}

#[tauri::command]
pub(crate) fn sync_reconnect(state: State<'_, crate::AppState>) {
    if let Some(tx) = lock(&state.sync.tx).as_ref() { let _ = tx.send(Ctl::Reconnect); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use episko_proto::{Event, Stream};
    use std::net::TcpListener;

    #[test]
    fn a_pasted_address_becomes_a_socket_url() {
        assert_eq!(norm_url("https://sync.example.com/").unwrap(), "wss://sync.example.com/");
        assert_eq!(norm_url("http://box:7878").unwrap(), "ws://box:7878/");
        assert_eq!(norm_url(" 100.64.0.2:7878 ").unwrap(), "ws://100.64.0.2:7878/");
        assert_eq!(norm_url("wss://x").unwrap(), "wss://x/");
        assert!(norm_url("").is_err());
        assert!(norm_url("http://").is_err());
        assert!(norm_url("ftp://x").is_err());
    }

    #[test]
    fn extra_headers_may_not_touch_the_handshake() {
        let ok: Headers = vec![("CF-Access-Client-Id".into(), "x".into()), ("Authorization".into(), "Basic dTpw".into())];
        assert!(check_headers(&ok).is_ok());
        for bad in [("Host", "evil"), ("Upgrade", "h2c"), ("Sec-WebSocket-Key", "x"), ("bad name", "x"), ("X-A", "line\nbreak")] {
            assert!(check_headers(&vec![(bad.0.into(), bad.1.into())]).is_err(), "{bad:?}");
        }
        assert!(check_headers(&vec![("X-A".into(), "1".into()), ("x-a".into(), "2".into())]).is_err(), "twice, whatever the case");
    }

    #[test]
    fn a_proxy_refusal_says_where_to_look() {
        assert!(refused(StatusCode::FORBIDDEN).contains("extra headers"));
        assert!(refused(StatusCode::FOUND).contains("service token"));
        assert!(refused(StatusCode::BAD_GATEWAY).contains("502"));
    }

    #[test]
    fn the_extra_headers_ride_the_handshake_and_a_refusal_is_named() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}/", l.local_addr().unwrap());
        let seen = std::sync::Arc::new(Mutex::new(None::<String>));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let _ = tungstenite::accept_hdr(s, |req: &tungstenite::handshake::server::Request, resp| {
                *lock(&s2) = req.headers().get("cf-access-client-id").and_then(|v| v.to_str().ok()).map(String::from);
                Ok(resp)
            });
            // The second connection plays a proxy that says no.
            let (mut s, _) = l.accept().unwrap();
            use std::io::{Read, Write};
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
        });
        let h: Headers = vec![("CF-Access-Client-Id".into(), "abc.access".into())];
        assert!(open(&url, &h).is_ok());
        assert_eq!(lock(&seen).as_deref(), Some("abc.access"));
        let Err(err) = open(&url, &h) else { panic!("the proxy said no, so the handshake must fail") };
        assert!(err.contains("HTTP 403") && err.contains("extra headers"), "{err}");
    }

    #[test]
    fn host_and_port_come_out_of_every_shape() {
        assert_eq!(host_port("wss://sync.example.com/").unwrap(), ("sync.example.com".into(), 443));
        assert_eq!(host_port("ws://box:7878/").unwrap(), ("box".into(), 7878));
        assert_eq!(host_port("ws://[::1]:7878/").unwrap(), ("::1".into(), 7878));
    }

    // Not on macOS: that arm writes the login keychain, which a test must never touch.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn the_token_round_trips_through_its_seal() {
        let dir = crate::testutil::scratch_dir();
        save_token(&dir, "abc123").unwrap();
        #[cfg(windows)]
        assert_ne!(std::fs::read(dir.join(Secret::Token.file())).unwrap(), b"abc123", "sealed, not plain");
        assert_eq!(load_token(&dir).as_deref(), Some("abc123"));
        drop_secret(&dir, Secret::Token);
        assert_eq!(load_token(&dir), None);
        let h: Headers = vec![("CF-Access-Client-Id".into(), "id.access".into()), ("CF-Access-Client-Secret".into(), "s3 cr\"et".into())];
        save_headers(&dir, &h).unwrap();
        assert_eq!(load_headers(&dir), h);
        save_headers(&dir, &vec![]).unwrap();
        assert!(load_headers(&dir).is_empty() && !dir.join(Secret::Headers.file()).exists());
    }

    #[test]
    fn the_config_survives_a_restart() {
        let dir = crate::testutil::scratch_dir();
        let c = SyncConfig { url: "ws://x/".into(), user: "me".into(), device: "d1".into(), label: "lap".into(), cursor: 42 };
        write_config(&dir, &c).unwrap();
        assert_eq!(read_config(&dir), Some(c));
    }

    // A one-connection stand-in for episko-server, speaking the real protocol types.
    fn mock(script: impl FnOnce(&mut WebSocket<TcpStream>) + Send + 'static) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}/", l.local_addr().unwrap());
        std::thread::spawn(move || { let (s, _) = l.accept().unwrap(); let mut ws = tungstenite::accept(s).unwrap(); script(&mut ws); });
        url
    }
    fn read_msg(ws: &mut WebSocket<TcpStream>) -> ClientMsg {
        loop { if let Message::Text(t) = ws.read().unwrap() { return serde_json::from_str(&t).unwrap(); } }
    }
    fn write_msg(ws: &mut WebSocket<TcpStream>, m: &ServerMsg) { ws.send(Message::text(serde_json::to_string(m).unwrap())).unwrap(); }

    #[test]
    fn a_session_says_hello_from_its_cursor_and_relays_both_ways() {
        let url = mock(|ws| {
            assert_eq!(read_msg(ws), ClientMsg::Hello { token: "tk".into(), since: 7, protocol: PROTOCOL });
            write_msg(ws, &ServerMsg::Welcome { user: "me".into(), device: "d1".into(), head: 8 });
            let ev = Event { seq: 8, stream: Stream::Prefs, key: "cc-sort".into(), actor: "me".into(), device: "d2".into(), at: 1, payload: "x".into() };
            write_msg(ws, &ServerMsg::Events { events: vec![ev], more: false });
            assert!(matches!(read_msg(ws), ClientMsg::Push { .. }));
            write_msg(ws, &ServerMsg::Pushed { seqs: vec![9] });
            let _ = ws.read();
        });
        let (tx, rx) = channel();
        tx.send(Ctl::Push(5, vec![NewEvent { stream: Stream::Prefs, key: "cc-foot".into(), at: 2, payload: "y".into() }])).unwrap();
        let seen = Mutex::new(Vec::new());
        let stop = AtomicBool::new(false);
        let out = |o: SyncOut| {
            if matches!(o, SyncOut::Pushed { .. }) { stop.store(true, Ordering::SeqCst); }
            lock(&seen).push(serde_json::to_value(&o).unwrap());
        };
        let end = session(&url, "tk", &vec![], 7, &rx, &out, &|| !stop.load(Ordering::SeqCst), &|| {});
        assert_eq!(end, End::Stopped);
        let kinds: Vec<String> = lock(&seen).iter().map(|v| v["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["server", "server", "pushed"]);
        assert_eq!(lock(&seen)[2]["id"], 5);
    }

    #[test]
    fn a_refused_token_halts_rather_than_hammering() {
        let url = mock(|ws| {
            read_msg(ws);
            write_msg(ws, &ServerMsg::Error { code: ErrorCode::BadToken, message: "unknown".into() });
        });
        let (_tx, rx) = channel();
        assert_eq!(session(&url, "tk", &vec![], 0, &rx, &|_| {}, &|| true, &|| {}), End::Halt("unknown".into()));
    }

    // Against a real episko-server: EPISKO_E2E_URL and two fresh invite codes in EPISKO_E2E_CODES.
    #[test]
    #[ignore]
    fn two_devices_meet_through_a_real_server() {
        let url = norm_url(&std::env::var("EPISKO_E2E_URL").expect("EPISKO_E2E_URL")).unwrap();
        let codes = std::env::var("EPISKO_E2E_CODES").expect("EPISKO_E2E_CODES");
        let (ca, cb) = codes.split_once(',').expect("two codes, comma-separated");
        let (ta, _, da) = pair_with(&url, ca, "laptop", &vec![]).unwrap();
        let (tb, _, db) = pair_with(&url, cb, "desk", &vec![]).unwrap();
        assert_ne!(da, db);
        let heard = std::sync::Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let (h, u) = (heard.clone(), url.clone());
        let listener = std::thread::spawn(move || {
            let (_tx, rx) = channel();
            let start = Instant::now();
            session(&u, &tb, &vec![], 0, &rx, &|o| lock(&h).push(serde_json::to_value(&o).unwrap()),
                &|| start.elapsed() < Duration::from_secs(4), &|| {})
        });
        std::thread::sleep(Duration::from_millis(500));
        let (tx, rx) = channel();
        tx.send(Ctl::Push(1, vec![NewEvent { stream: episko_proto::Stream::Prefs, key: "cc-sort".into(), at: 1, payload: "active".into() }])).unwrap();
        let start = Instant::now();
        session(&url, &ta, &vec![], 0, &rx, &|_| {}, &|| start.elapsed() < Duration::from_secs(2), &|| {});
        assert_eq!(listener.join().unwrap(), End::Stopped);
        let got = lock(&heard).clone();
        let ev = got.iter().flat_map(|v| v["msg"]["events"].as_array().cloned().unwrap_or_default())
            .find(|e| e["key"] == "cc-sort").expect("the desk heard the laptop's push");
        assert_eq!((ev["device"].as_str(), ev["payload"].as_str()), (Some(da.as_str()), Some("active")));
    }

    #[test]
    fn an_unreachable_server_is_a_retry() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (_tx, rx) = channel();
        assert!(matches!(session(&format!("ws://127.0.0.1:{port}/"), "tk", &vec![], 0, &rx, &|_| {}, &|| true, &|| {}), End::Retry(_)));
    }
}
