//! Provider control planes that run beside an interactive agent PTY.
//!
//! The terminal remains the vendor's real UI. An integrated provider adds a sidecar
//! transport that Episko observes independently and forwards as provider events; the
//! frontend adapter normalizes those into its shared session reducer. Codex uses one
//! loopback App Server per pane and connects its own TUI with `codex --remote`.

use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Error as WsError, Message, WebSocket};

use crate::AppState;

pub(crate) struct AgentRuntime {
    child: Child,
    control: Sender<Control>,
}

enum Control {
    Resolve { token: String, behavior: String },
    Refresh,
    Stop,
}

struct PendingApproval {
    id: Value,
    method: String,
    params: Value,
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

fn process_command(bin: &str) -> Command {
    #[cfg(windows)]
    {
        // Codex is commonly an npm `.cmd` shim. `CreateProcessW` cannot execute a
        // script directly, while a native installation should not pay a shell hop.
        let lower = bin.to_ascii_lowercase();
        if lower.ends_with(".exe") || lower.ends_with(".com") {
            Command::new(bin)
        } else {
            let mut cmd =
                Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()));
            cmd.args(["/D", "/C", bin]);
            cmd
        }
    }
    #[cfg(not(windows))]
    {
        Command::new(bin)
    }
}

fn send(socket: &mut Socket, value: Value) -> Result<(), String> {
    socket
        .send(Message::Text(value.to_string().into()))
        .map_err(|e| format!("Codex App Server write: {e}"))
}

fn stdio_send(stdin: &mut impl Write, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, value).map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

fn stdio_response(reader: &mut impl BufRead, id: u64) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("Codex App Server closed before answering".to_string());
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id") != Some(&json!(id)) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!("Codex App Server request failed: {error}"));
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn codex_stdio_request(method: &str, params: Value) -> Result<Value, String> {
    let bin =
        crate::pty::resolve_cli("codex").ok_or_else(|| "Codex isn't installed".to_string())?;
    let mut command = process_command(&bin);
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|e| format!("start Codex App Server: {e}"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let child = Arc::new(Mutex::new(child));
    let done = Arc::new(AtomicBool::new(false));
    let watchdog_child = child.clone();
    let watchdog_done = done.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(12));
        if !watchdog_done.load(Ordering::Relaxed) {
            if let Ok(mut child) = watchdog_child.lock() {
                let _ = child.kill();
            }
        }
    });
    let result = (|| {
        let mut stdin = stdin.ok_or_else(|| "Codex App Server stdin unavailable".to_string())?;
        let stdout = stdout.ok_or_else(|| "Codex App Server stdout unavailable".to_string())?;
        let mut reader = BufReader::new(stdout);
        stdio_send(
            &mut stdin,
            &json!({
                "method": "initialize", "id": 0,
                "params": { "clientInfo": { "name": "episko", "title": "Episko", "version": env!("CARGO_PKG_VERSION") } }
            }),
        )?;
        let _ = stdio_response(&mut reader, 0)?;
        stdio_send(
            &mut stdin,
            &json!({ "method": "initialized", "params": {} }),
        )?;
        stdio_send(
            &mut stdin,
            &json!({ "method": method, "id": 1, "params": params }),
        )?;
        stdio_response(&mut reader, 1)
    })();
    done.store(true, Ordering::Relaxed);
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

fn message_value(message: Message) -> Option<Value> {
    let text = match message {
        Message::Text(text) => text.to_string(),
        Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).ok()?,
        _ => return None,
    };
    serde_json::from_str(&text).ok()
}

fn initialize(socket: &mut Socket) -> Result<(), String> {
    send(
        socket,
        json!({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "episko",
                    "title": "Episko",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )?;
    loop {
        let message = socket
            .read()
            .map_err(|e| format!("Codex App Server initialize: {e}"))?;
        let Some(value) = message_value(message) else {
            continue;
        };
        if value.get("id") == Some(&json!(0)) {
            if let Some(error) = value.get("error") {
                return Err(format!("Codex App Server rejected Episko: {error}"));
            }
            break;
        }
    }
    send(socket, json!({ "method": "initialized", "params": {} }))
}

fn set_read_timeout(socket: &mut Socket) -> Result<(), String> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => stream
            .set_read_timeout(Some(Duration::from_millis(120)))
            .map_err(|e| format!("Codex App Server read timeout: {e}")),
        _ => Err("Codex loopback connection unexpectedly negotiated TLS".to_string()),
    }
}

fn emit_provider_event(
    app: &AppHandle,
    session_id: &str,
    method: &str,
    params: Value,
    request_id: Option<&str>,
) {
    let _ = app.emit(
        "agent-event",
        json!({
            "sessionId": session_id,
            "provider": "codex",
            "method": method,
            "params": params,
            "requestId": request_id,
        }),
    );
}

fn message_thread_id(value: &Value) -> Option<&str> {
    value
        .pointer("/params/threadId")
        .or_else(|| value.pointer("/params/thread/id"))
        .and_then(Value::as_str)
}

fn message_parent_thread_id(value: &Value) -> Option<&str> {
    value
        .pointer("/params/thread/parentThreadId")
        .and_then(Value::as_str)
}

fn child_params(mut params: Value, child: bool) -> Value {
    if child {
        if let Some(map) = params.as_object_mut() {
            map.insert("episkoChild".to_string(), Value::Bool(true));
        }
    }
    params
}

fn register_descendant(routed: &mut HashSet<String>, value: &Value) {
    let (Some(child), Some(parent)) = (message_thread_id(value), message_parent_thread_id(value))
    else {
        return;
    };
    if routed.contains(parent) {
        routed.insert(child.to_string());
    }
}

/// `None` means the message names an unrelated thread and must be dropped. Messages
/// without a thread id are account/server events and remain routed to the pane.
fn routed_child(bound: Option<&str>, routed: &HashSet<String>, value: &Value) -> Option<bool> {
    let (Some(bound), Some(message_thread)) = (bound, message_thread_id(value)) else {
        return Some(false);
    };
    routed
        .contains(message_thread)
        .then_some(message_thread != bound)
}

/// Rolling rate-limit notifications omit fields that have not changed and use null for
/// account metadata that is merely unavailable. Fold only concrete values into the last
/// complete `account/rateLimits/read` snapshot before anything reaches the frontend.
fn merge_sparse(base: &mut Value, update: &Value) {
    if update.is_null() {
        return;
    }
    match (base, update) {
        (Value::Object(base), Value::Object(update)) => {
            for (key, value) in update {
                if value.is_null() {
                    continue;
                }
                if let Some(old) = base.get_mut(key) {
                    merge_sparse(old, value);
                } else {
                    base.insert(key.clone(), value.clone());
                }
            }
        }
        (base, update) => *base = update.clone(),
    }
}

/// App Server exposes a stable identity only for ChatGPT auth. API-key and Bedrock
/// responses name the auth *kind* but not which credential is active, so sharing those
/// would merge unrelated accounts. Hash ChatGPT's native identity so the frontend can
/// share account-wide snapshots without receiving PII.
fn account_scope(result: &Value) -> Option<String> {
    let account = result.get("account")?;
    if account.get("type").and_then(Value::as_str) != Some("chatgpt") {
        return None;
    }
    let email = account.get("email")?.as_str()?.trim();
    if email.is_empty() {
        return None;
    }
    let identity = format!("chatgpt:{email}");
    let mut hasher = DefaultHasher::new();
    identity.hash(&mut hasher);
    Some(format!("codex:{:016x}", hasher.finish()))
}

fn rate_limits_request(id: u64) -> Value {
    json!({ "method": "account/rateLimits/read", "id": id })
}

fn account_request(id: u64) -> Value {
    json!({ "method": "account/read", "id": id, "params": { "refreshToken": false } })
}

/// Forget every value derived from the previous account before asking App Server for
/// identity again. In-flight quota reads are deliberately invalidated: their response
/// ids must not be allowed to inherit the next account's sharing scope.
fn invalidate_account_state(
    account_read_request: &mut Option<u64>,
    rate_limit_requests: &mut HashSet<u64>,
    rate_limit_snapshot: &mut Value,
    rate_limit_scope: &mut Option<String>,
) {
    *account_read_request = None;
    rate_limit_requests.clear();
    *rate_limit_snapshot = Value::Object(serde_json::Map::new());
    *rate_limit_scope = None;
}

fn request_account_refresh(
    socket: &mut Socket,
    next_id: &mut u64,
    account_read_request: &mut Option<u64>,
    rate_limit_requests: &mut HashSet<u64>,
    rate_limit_snapshot: &mut Value,
    rate_limit_scope: &mut Option<String>,
) -> Result<(), String> {
    invalidate_account_state(
        account_read_request,
        rate_limit_requests,
        rate_limit_snapshot,
        rate_limit_scope,
    );
    let id = *next_id;
    *next_id += 1;
    send(socket, account_request(id))?;
    *account_read_request = Some(id);
    Ok(())
}

fn thread_matches(value: &Value) -> bool {
    let Some(thread) = value.pointer("/params/thread") else {
        return false;
    };
    thread.get("parentThreadId").is_none_or(Value::is_null)
}

fn approval_token(method: &str, params: &Value, serial: u64) -> String {
    let item = params
        .get("itemId")
        .and_then(Value::as_str)
        .unwrap_or("request");
    format!("codex:{serial}:{method}:{item}")
}

fn approval_response(method: &str, behavior: &str, params: &Value) -> Option<Value> {
    match (method, behavior) {
        // Leave the App Server request unanswered on this connection. The TUI owns
        // another copy and can answer it; `serverRequest/resolved` then reaches us.
        (_, "terminal") => None,
        ("item/permissions/requestApproval", "allow") => Some(json!({
            "permissions": params.get("permissions").cloned().unwrap_or_else(|| json!({})),
            "scope": "turn"
        })),
        ("item/permissions/requestApproval", _) => {
            Some(json!({ "permissions": {}, "scope": "turn" }))
        }
        (_, "allow") => Some(json!({ "decision": "accept" })),
        (_, "deny") => Some(json!({ "decision": "decline" })),
        _ => Some(json!({ "decision": "decline" })),
    }
}

fn thread_usage_request(id: u64, thread_id: &str) -> Value {
    json!({
        "method": "account/usage/read",
        "id": id,
        "params": { "threadId": thread_id }
    })
}

fn method_not_found(value: &Value) -> bool {
    value.pointer("/error/code").and_then(Value::as_i64) == Some(-32601)
        || value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .is_some_and(|s| s.to_ascii_lowercase().contains("method not found"))
}

fn observer_loop(
    app: AppHandle,
    session_id: String,
    mut socket: Socket,
    control: Receiver<Control>,
) {
    let mut thread_id: Option<String> = None;
    let mut routed_threads: HashSet<String> = HashSet::new();
    // Request id 1 identifies the account without exposing it to the frontend. Its
    // response earns the initial complete quota read; reload refreshes take the same
    // route so an account switch cannot accidentally reuse the old sharing scope.
    let mut account_read_request = Some(1u64);
    let mut rate_limit_requests: HashSet<u64> = HashSet::new();
    let mut rate_limit_snapshot = Value::Object(serde_json::Map::new());
    let mut rate_limit_scope: Option<String> = None;
    let mut next_id = 2u64;
    let mut resume_request: Option<u64> = None;
    // `account/usage/read` is the App Server's own API-equivalent estimate for a
    // thread. Only keep one request in flight: token notifications can arrive in a
    // burst at turn end, and an older estimate racing a newer one would make the live
    // cost gauge move backwards. `usage_dirty` earns exactly one follow-up read.
    let mut usage_request: Option<u64> = None;
    let mut usage_dirty = false;
    let mut usage_supported = true;
    let mut approval_serial = 0u64;
    let mut pending: HashMap<String, PendingApproval> = HashMap::new();
    let mut stopped = false;

    loop {
        loop {
            match control.try_recv() {
                Ok(Control::Stop) => {
                    stopped = true;
                    break;
                }
                Ok(Control::Resolve { token, behavior }) => {
                    let Some(request) = pending.remove(&token) else {
                        continue;
                    };
                    if let Some(result) =
                        approval_response(&request.method, &behavior, &request.params)
                    {
                        if let Err(e) =
                            send(&mut socket, json!({ "id": request.id, "result": result }))
                        {
                            log::warn!("codex observer resolve failed · {session_id}: {e}");
                        }
                    }
                }
                Ok(Control::Refresh) => {
                    // One account read in flight is enough. It is followed by a complete
                    // quota snapshot below; thread/cost refreshes can run alongside it.
                    if account_read_request.is_none() {
                        match request_account_refresh(
                            &mut socket,
                            &mut next_id,
                            &mut account_read_request,
                            &mut rate_limit_requests,
                            &mut rate_limit_snapshot,
                            &mut rate_limit_scope,
                        ) {
                            Ok(()) => {}
                            Err(e) => {
                                log::warn!("Codex account refresh failed · {session_id}: {e}")
                            }
                        }
                    }
                    if let Some(thread) = thread_id.as_deref() {
                        let id_num = next_id;
                        next_id += 1;
                        match send(
                            &mut socket,
                            json!({ "method": "thread/resume", "id": id_num, "params": { "threadId": thread } }),
                        ) {
                            Ok(()) => resume_request = Some(id_num),
                            Err(e) => log::warn!("Codex thread refresh failed · {session_id}: {e}"),
                        }
                        if usage_supported {
                            if usage_request.is_some() {
                                usage_dirty = true;
                            } else {
                                let usage_id = next_id;
                                next_id += 1;
                                match send(&mut socket, thread_usage_request(usage_id, thread)) {
                                    Ok(()) => usage_request = Some(usage_id),
                                    Err(e) => {
                                        log::warn!("Codex usage refresh failed · {session_id}: {e}")
                                    }
                                }
                            }
                        }
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    stopped = true;
                    break;
                }
            }
        }
        if stopped {
            break;
        }

        let message = match socket.read() {
            Ok(message) => message,
            Err(WsError::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => break,
            Err(e) => {
                log::warn!("codex observer read failed · {session_id}: {e}");
                break;
            }
        };
        let Some(value) = message_value(message) else {
            continue;
        };

        if account_read_request.is_some_and(|id| value.get("id") == Some(&json!(id))) {
            account_read_request = None;
            if let Some(result) = value.get("result") {
                rate_limit_scope = account_scope(result);
            } else if let Some(error) = value.get("error") {
                rate_limit_scope = None;
                log::warn!("Codex account identity read failed · {session_id}: {error}");
            }
            let id_num = next_id;
            next_id += 1;
            match send(&mut socket, rate_limits_request(id_num)) {
                Ok(()) => {
                    rate_limit_requests.insert(id_num);
                }
                Err(e) => log::warn!("Codex rate-limit read failed · {session_id}: {e}"),
            }
            continue;
        }

        let response_id = value.get("id").and_then(Value::as_u64);
        if response_id.is_some_and(|id| rate_limit_requests.remove(&id)) {
            if let Some(result) = value.get("result") {
                rate_limit_snapshot = result
                    .get("rateLimits")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                let mut payload = result.clone();
                if let Some(map) = payload.as_object_mut() {
                    map.insert("episkoScope".to_string(), json!(rate_limit_scope.clone()));
                }
                emit_provider_event(
                    &app,
                    &session_id,
                    "account/rateLimits/updated",
                    payload,
                    None,
                );
            }
            continue;
        }

        if usage_request.is_some_and(|id| value.get("id") == Some(&json!(id))) {
            usage_request = None;
            if let Some(result) = value.get("result") {
                emit_provider_event(
                    &app,
                    &session_id,
                    "episko/thread/usage",
                    result.clone(),
                    None,
                );
            } else if let Some(error) = value.get("error") {
                if method_not_found(&value) {
                    // This method was added after the first App Server releases. A
                    // stale CLI must lose the estimate, not its whole observer.
                    usage_supported = false;
                    log::debug!("Codex App Server has no thread usage estimate · {session_id}");
                } else {
                    // Authentication and provider failures can heal. Leave the method
                    // enabled so the next token update gets another honest attempt.
                    log::warn!("codex observer usage estimate failed · {session_id}: {error}");
                }
            }
            if usage_dirty && usage_supported {
                usage_dirty = false;
                if let Some(thread) = thread_id.as_deref() {
                    let id_num = next_id;
                    next_id += 1;
                    match send(&mut socket, thread_usage_request(id_num, thread)) {
                        Ok(()) => usage_request = Some(id_num),
                        Err(e) => {
                            log::warn!("codex observer usage refresh failed · {session_id}: {e}")
                        }
                    }
                }
            } else {
                usage_dirty = false;
            }
            continue;
        }

        // The response to our subscription carries the complete thread plus model and
        // sandbox settings. Forward it as a synthetic provider event so the adapter
        // needn't know which JSON-RPC id this observer happened to allocate.
        if resume_request.is_some_and(|id| value.get("id") == Some(&json!(id))) {
            resume_request = None;
            if let Some(result) = value.get("result") {
                emit_provider_event(
                    &app,
                    &session_id,
                    "episko/thread/resumed",
                    result.clone(),
                    None,
                );
            } else if let Some(error) = value.get("error") {
                log::warn!("Codex observer subscribe failed · {session_id}: {error}");
            }
            continue;
        }

        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        let mut params = value.get("params").cloned().unwrap_or(Value::Null);

        // Sign-in, sign-out and account switches invalidate both the opaque sharing
        // scope and the complete quota snapshot. Always supersede any account read
        // already in flight: the notification is newer evidence than its response.
        if method == "account/updated" {
            if let Err(e) = request_account_refresh(
                &mut socket,
                &mut next_id,
                &mut account_read_request,
                &mut rate_limit_requests,
                &mut rate_limit_snapshot,
                &mut rate_limit_scope,
            ) {
                log::warn!("Codex account update refresh failed · {session_id}: {e}");
            }
            // Clear the webview's old scope immediately too. If authentication is
            // broken, the follow-up reads may never succeed; leaving yesterday's
            // account quota visible and shareable would be worse than no reading.
            emit_provider_event(
                &app,
                &session_id,
                "account/rateLimits/updated",
                json!({ "rateLimits": {}, "episkoScope": null }),
                None,
            );
            continue;
        }

        // Live quota notifications are sparse. Publish the rolling complete view under
        // the account scope established above so reloads and sibling panes never replace
        // a known window with an omitted one.
        if method == "account/rateLimits/updated" {
            // Until identity is known, a notification could belong to either side of
            // an account switch. The complete read chained from account/read will
            // publish an authoritative snapshot under the new scope.
            if account_read_request.is_some() {
                continue;
            }
            if let Some(update) = params.get("rateLimits") {
                merge_sparse(&mut rate_limit_snapshot, update);
            }
            emit_provider_event(
                &app,
                &session_id,
                method,
                json!({
                    "rateLimits": rate_limit_snapshot.clone(),
                    "episkoScope": rate_limit_scope.clone()
                }),
                None,
            );
            continue;
        }

        // Each pane owns a dedicated App Server, so its root thread is unambiguous.
        // Do not compare `cwd`: App Server reports a resolved path while the launcher
        // may retain the user's symlink spelling. A byte-for-byte comparison prevented
        // the observer from ever subscribing, leaving its terminal alive but all item
        // (tool/file) events invisible. A later root is `/clear`; replace the route.
        if method == "thread/started" && thread_matches(&value) {
            let Some(id) = message_thread_id(&value).map(str::to_owned) else {
                continue;
            };
            if thread_id.as_deref() == Some(id.as_str()) {
                continue;
            }
            thread_id = Some(id.clone());
            routed_threads.clear();
            routed_threads.insert(id.clone());
            emit_provider_event(&app, &session_id, method, params.clone(), None);
            let id_num = next_id;
            next_id += 1;
            if let Err(e) = send(
                &mut socket,
                json!({ "method": "thread/resume", "id": id_num, "params": { "threadId": id } }),
            ) {
                log::warn!("codex observer subscribe failed · {session_id}: {e}");
            } else {
                resume_request = Some(id_num);
            }
            continue;
        }

        // A spawned thread belongs to this pane when its parent is already routed. Keep
        // the full descendant set so nested subagents work too, while unrelated
        // top-level work observed on the same server remains invisible to this pane.
        if method == "thread/started" {
            register_descendant(&mut routed_threads, &value);
        }

        let Some(is_child) = routed_child(thread_id.as_deref(), &routed_threads, &value) else {
            continue;
        };
        params = child_params(params, is_child);

        if value.get("id").is_some() && method.ends_with("/requestApproval") {
            approval_serial += 1;
            let token = approval_token(method, &params, approval_serial);
            pending.insert(
                token.clone(),
                PendingApproval {
                    id: value["id"].clone(),
                    method: method.to_string(),
                    params: params.clone(),
                },
            );
            emit_provider_event(&app, &session_id, method, params, Some(&token));
            continue;
        }

        if method == "serverRequest/resolved" {
            let raw = params.get("requestId");
            let resolved: Vec<String> = pending
                .iter()
                .filter(|(_, request)| Some(&request.id) == raw)
                .map(|(token, _)| token.clone())
                .collect();
            for token in resolved {
                pending.remove(&token);
                emit_provider_event(
                    &app,
                    &session_id,
                    "episko/request/resolved",
                    json!({ "requestId": token }),
                    None,
                );
            }
            continue;
        }

        if !method.is_empty() {
            emit_provider_event(&app, &session_id, method, params, None);
            // The token event says the cumulative estimate may have changed. Ask for
            // the provider's per-model grouped reading rather than repricing one latest
            // aggregate; its USD value wins, with the adapter supplying the public-rate
            // fallback for subscription routes that only return groups.
            if method == "thread/tokenUsage/updated" && !is_child && usage_supported {
                if usage_request.is_some() {
                    usage_dirty = true;
                } else if let Some(thread) = thread_id.as_deref() {
                    let id_num = next_id;
                    next_id += 1;
                    match send(&mut socket, thread_usage_request(id_num, thread)) {
                        Ok(()) => usage_request = Some(id_num),
                        Err(e) => {
                            log::warn!("codex observer usage read failed · {session_id}: {e}")
                        }
                    }
                }
            }
        }
    }

    if !stopped {
        emit_provider_event(&app, &session_id, "episko/disconnected", Value::Null, None);
        if let Some(state) = app.try_state::<AppState>() {
            if let Some(mut runtime) = state.agent_runtimes.lock().unwrap().remove(&session_id) {
                let _ = runtime.child.kill();
                let _ = runtime.child.wait();
            }
        }
    }
}

/// Provider control-plane registry. `pty.rs` owns the generic PTY and deliberately
/// knows no vendor command shape; a future integrated provider adds its sidecar and
/// launch arguments here, while an unlisted provider keeps the terminal-only path.
pub(crate) struct ProviderLaunch<'a> {
    session_id: &'a str,
    workdir: &'a str,
    bin: &'a str,
    resume: Option<&'a str>,
    mode: Option<&'a str>,
}

impl<'a> ProviderLaunch<'a> {
    pub(crate) fn new(
        session_id: &'a str,
        workdir: &'a str,
        bin: &'a str,
        resume: Option<&'a str>,
        mode: Option<&'a str>,
    ) -> Self {
        Self {
            session_id,
            workdir,
            bin,
            resume,
            mode,
        }
    }
}

pub(crate) fn start_provider(
    provider: &str,
    app: AppHandle,
    state: &AppState,
    launch: ProviderLaunch<'_>,
) -> Result<Vec<String>, String> {
    match provider {
        "codex" => {
            let endpoint = start_codex(app, state, launch.session_id, launch.workdir, launch.bin)?;
            Ok(codex_launch_args(
                &endpoint,
                launch.workdir,
                launch.resume,
                launch.mode,
            ))
        }
        _ => Ok(Vec::new()),
    }
}

/// Map Episko's provider-owned Codex policy ids to stable CLI primitives. The mode
/// string itself never becomes an argument: this is the same security/correctness
/// boundary as Claude's `permission_mode_arg`, and an unknown future id degrades to
/// Codex's own config rather than making every launch fail.
fn codex_permission_args(mode: Option<&str>) -> &'static [&'static str] {
    match mode.map(str::trim) {
        None | Some("") | Some("default") => &[],
        Some("on-request") => &["--ask-for-approval", "on-request"],
        Some("read-only") => &["--ask-for-approval", "never", "--sandbox", "read-only"],
        // The current stable spelling of the old full-auto behavior: no approval
        // pauses, but writes remain constrained to the workspace sandbox.
        Some("auto") => &[
            "--ask-for-approval",
            "never",
            "--sandbox",
            "workspace-write",
        ],
        Some("bypass") => &["--dangerously-bypass-approvals-and-sandbox"],
        Some(other) => {
            log::warn!("ignoring unknown Codex permission mode {other:?} — using config");
            &[]
        }
    }
}

fn codex_launch_args(
    endpoint: &str,
    workdir: &str,
    resume: Option<&str>,
    mode: Option<&str>,
) -> Vec<String> {
    let mut args = codex_permission_args(mode)
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    args.extend([
        "--remote".to_string(),
        endpoint.to_string(),
        "-C".to_string(),
        workdir.to_string(),
    ]);
    if let Some(thread) = resume {
        args.extend(["resume".to_string(), thread.to_string()]);
    }
    args
}

/// Start the loopback App Server and Episko observer. The returned endpoint is passed
/// to the real Codex TUI; both clients then share the same thread and approvals.
fn start_codex(
    app: AppHandle,
    state: &AppState,
    session_id: &str,
    workdir: &str,
    codex_bin: &str,
) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("reserve Codex App Server port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    let endpoint = format!("ws://127.0.0.1:{port}");

    let mut command = process_command(codex_bin);
    command
        .args(["app-server", "--listen", &endpoint])
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|e| format!("start Codex App Server: {e}"))?;

    let mut last_error = String::new();
    let mut socket = None;
    for _ in 0..60 {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("Codex App Server exited during startup ({status})"));
        }
        match connect(endpoint.as_str()) {
            Ok((connected, _)) => {
                socket = Some(connected);
                break;
            }
            Err(e) => last_error = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let Some(mut socket) = socket else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "Codex App Server did not become ready: {last_error}"
        ));
    };
    if let Err(e) = initialize(&mut socket)
        .and_then(|()| send(&mut socket, account_request(1)))
        .and_then(|()| set_read_timeout(&mut socket))
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }

    let (control_tx, control_rx) = mpsc::channel();
    state.agent_runtimes.lock().unwrap().insert(
        session_id.to_string(),
        AgentRuntime {
            child,
            control: control_tx,
        },
    );
    let sid = session_id.to_string();
    std::thread::spawn(move || observer_loop(app, sid, socket, control_rx));
    log::info!("codex app-server · {session_id} · {endpoint}");
    Ok(endpoint)
}

pub(crate) fn stop_runtime(state: &AppState, session_id: &str) {
    let Some(mut runtime) = state.agent_runtimes.lock().unwrap().remove(session_id) else {
        return;
    };
    let _ = runtime.control.send(Control::Stop);
    let _ = runtime.child.kill();
    let _ = runtime.child.wait();
}

#[tauri::command]
pub(crate) fn resolve_agent_request(
    state: State<AppState>,
    session_id: String,
    request_id: String,
    behavior: String,
) -> Result<(), String> {
    let control = state
        .agent_runtimes
        .lock()
        .unwrap()
        .get(&session_id)
        .map(|runtime| runtime.control.clone())
        .ok_or_else(|| format!("no integrated agent runtime for {session_id}"))?;
    control
        .send(Control::Resolve {
            token: request_id,
            behavior,
        })
        .map_err(|_| "agent observer has stopped".to_string())
}

/// Re-publish provider state that can have changed while the webview was absent. The
/// PTY and observer survive a frontend reload, so orphan adoption asks the existing
/// control plane for a fresh thread snapshot, usage estimate and account quota.
#[tauri::command]
pub(crate) fn refresh_agent_state(
    state: State<AppState>,
    session_id: String,
) -> Result<(), String> {
    let control = state
        .agent_runtimes
        .lock()
        .unwrap()
        .get(&session_id)
        .map(|runtime| runtime.control.clone())
        .ok_or_else(|| format!("no integrated agent runtime for {session_id}"))?;
    control
        .send(Control::Refresh)
        .map_err(|_| "agent observer has stopped".to_string())
}

/// Read provider history through its public control plane, never by depending on its
/// private on-disk rollout format. The History dialog asks for either the recent list
/// or one thread with turns populated.
#[tauri::command]
pub(crate) async fn agent_history(
    provider: String,
    thread_id: Option<String>,
    limit: usize,
) -> Result<Value, String> {
    if provider != "codex" {
        return Err(format!("history is not integrated for {provider}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(id) = thread_id {
            codex_stdio_request(
                "thread/read",
                json!({ "threadId": id, "includeTurns": true }),
            )
        } else {
            let mut result = codex_stdio_request(
                "thread/list",
                json!({
                    "limit": limit, "sortKey": "updated_at", "sortDirection": "desc"
                }),
            )?;
            if let Some(rows) = result.get_mut("data").and_then(Value::as_array_mut) {
                for row in rows {
                    let cwd = row
                        .get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    row["episkoExists"] = json!(std::path::Path::new(&cwd).is_dir());
                    row["episkoRepoRoot"] = json!(crate::git::repo_root_of(&cwd));
                    let bytes = row
                        .get("path")
                        .and_then(Value::as_str)
                        .and_then(|p| std::fs::metadata(p).ok())
                        .map(|m| m.len())
                        .unwrap_or(0);
                    row["episkoBytes"] = json!(bytes);
                }
            }
            Ok(result)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_top_level_threads_without_requiring_a_byte_identical_cwd() {
        let top = json!({ "params": { "thread": { "id": "t", "cwd": "/work", "parentThreadId": null } } });
        let child =
            json!({ "params": { "thread": { "id": "c", "cwd": "/work", "parentThreadId": "t" } } });
        assert!(thread_matches(&top));
        assert!(!thread_matches(&child));
    }

    #[test]
    fn maps_episko_permission_verbs_to_each_app_server_response_shape() {
        let params = json!({ "permissions": { "network": { "enabled": true } } });
        assert_eq!(
            approval_response("item/commandExecution/requestApproval", "allow", &params),
            Some(json!({ "decision": "accept" }))
        );
        assert_eq!(
            approval_response("item/fileChange/requestApproval", "deny", &params),
            Some(json!({ "decision": "decline" }))
        );
        assert_eq!(
            approval_response("item/permissions/requestApproval", "allow", &params),
            Some(json!({
                "permissions": { "network": { "enabled": true } }, "scope": "turn"
            }))
        );
        assert_eq!(
            approval_response("item/permissions/requestApproval", "deny", &params),
            Some(json!({ "permissions": {}, "scope": "turn" }))
        );
        assert_eq!(
            approval_response("item/commandExecution/requestApproval", "terminal", &params),
            None
        );
    }

    #[test]
    fn approval_tokens_are_opaque_and_unique_even_for_one_item() {
        let p = json!({ "itemId": "call-1" });
        assert_ne!(
            approval_token("item/commandExecution/requestApproval", &p, 1),
            approval_token("item/commandExecution/requestApproval", &p, 2)
        );
    }

    #[test]
    fn sparse_rate_limits_preserve_omitted_and_null_fields() {
        let mut complete = json!({
            "primary": { "usedPercent": 12, "resetsAt": 100 },
            "secondary": { "usedPercent": 34, "resetsAt": 200 }
        });
        merge_sparse(
            &mut complete,
            &json!({
                "primary": { "usedPercent": 20, "resetsAt": null },
                "credits": { "balance": 4 }
            }),
        );
        assert_eq!(
            complete,
            json!({
                "primary": { "usedPercent": 20, "resetsAt": 100 },
                "secondary": { "usedPercent": 34, "resetsAt": 200 },
                "credits": { "balance": 4 }
            })
        );
    }

    #[test]
    fn account_scopes_are_opaque_stable_and_distinct() {
        let a = json!({ "account": { "type": "chatgpt", "email": "a@example.com" } });
        let b = json!({ "account": { "type": "chatgpt", "email": "b@example.com" } });
        let a_scope = account_scope(&a).unwrap();
        assert_eq!(account_scope(&a), Some(a_scope.clone()));
        assert_ne!(account_scope(&b), Some(a_scope.clone()));
        assert!(a_scope.starts_with("codex:"));
        assert!(!a_scope.contains("example.com"));
        assert_eq!(account_scope(&json!({ "account": null })), None);
        assert_eq!(account_scope(&json!({ "account": { "type": "apiKey" } })), None);
        assert_eq!(
            account_scope(&json!({ "account": { "type": "chatgpt", "email": null } })),
            None
        );
        assert_eq!(
            account_scope(&json!({ "account": { "type": "chatgpt", "email": "  " } })),
            None
        );
    }

    #[test]
    fn account_updates_invalidate_identity_and_every_old_quota_read() {
        let mut account_request = Some(8);
        let mut rate_requests = HashSet::from([9, 10]);
        let mut snapshot = json!({ "primary": { "usedPercent": 42 } });
        let mut scope = Some("codex:old".to_string());
        invalidate_account_state(
            &mut account_request,
            &mut rate_requests,
            &mut snapshot,
            &mut scope,
        );
        assert_eq!(account_request, None);
        assert!(rate_requests.is_empty());
        assert_eq!(snapshot, json!({}));
        assert_eq!(scope, None);
    }

    #[test]
    fn routes_nested_descendants_but_not_unrelated_threads() {
        let mut routed = HashSet::from(["parent".to_string()]);
        let child = json!({ "params": { "thread": {
            "id": "child", "parentThreadId": "parent"
        } } });
        register_descendant(&mut routed, &child);
        assert_eq!(routed_child(Some("parent"), &routed, &child), Some(true));

        let grandchild = json!({ "params": { "thread": {
            "id": "grandchild", "parentThreadId": "child"
        } } });
        register_descendant(&mut routed, &grandchild);
        assert_eq!(
            routed_child(Some("parent"), &routed, &grandchild),
            Some(true)
        );

        let unrelated = json!({ "params": { "threadId": "other" } });
        assert_eq!(routed_child(Some("parent"), &routed, &unrelated), None);
        assert_eq!(
            routed_child(Some("parent"), &routed, &json!({ "params": {} })),
            Some(false)
        );
        assert_eq!(
            child_params(json!({ "threadId": "child" }), true),
            json!({ "threadId": "child", "episkoChild": true })
        );
    }

    #[test]
    fn requests_the_provider_owned_estimate_for_one_thread() {
        assert_eq!(
            thread_usage_request(7, "thread-1"),
            json!({
                "method": "account/usage/read",
                "id": 7,
                "params": { "threadId": "thread-1" }
            })
        );
    }

    #[test]
    fn only_an_unknown_method_permanently_disables_the_optional_estimate() {
        assert!(method_not_found(
            &json!({ "error": { "code": -32601, "message": "nope" } })
        ));
        assert!(method_not_found(
            &json!({ "error": { "code": 500, "message": "Method not found: account/usage/read" } })
        ));
        assert!(!method_not_found(
            &json!({ "error": { "code": 401, "message": "sign in again" } })
        ));
    }

    #[test]
    fn codex_launch_policies_are_whitelisted_and_precede_resume() {
        assert_eq!(codex_permission_args(None), &[] as &[&str]);
        assert_eq!(codex_permission_args(Some("default")), &[] as &[&str]);
        assert_eq!(
            codex_permission_args(Some("on-request")),
            &["--ask-for-approval", "on-request"]
        );
        assert_eq!(
            codex_permission_args(Some("auto")),
            &[
                "--ask-for-approval",
                "never",
                "--sandbox",
                "workspace-write"
            ]
        );
        assert_eq!(
            codex_permission_args(Some("read-only")),
            &["--ask-for-approval", "never", "--sandbox", "read-only"]
        );
        assert_eq!(
            codex_permission_args(Some("bypass")),
            &["--dangerously-bypass-approvals-and-sandbox"]
        );
        for hostile in ["auto; rm -rf /", "--yolo", "$(id)", "AUTO"] {
            assert!(codex_permission_args(Some(hostile)).is_empty());
        }

        assert_eq!(
            codex_launch_args("ws://127.0.0.1:9", "/work", Some("thread-1"), Some("auto")),
            [
                "--ask-for-approval",
                "never",
                "--sandbox",
                "workspace-write",
                "--remote",
                "ws://127.0.0.1:9",
                "-C",
                "/work",
                "resume",
                "thread-1",
            ]
        );
    }
}
