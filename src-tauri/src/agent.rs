//! Provider control planes that run beside an interactive agent PTY.
//!
//! The terminal remains the vendor's real UI. An integrated provider adds a sidecar
//! transport that Episko observes independently and forwards as provider events; the
//! frontend adapter normalizes those into its shared session reducer. Codex uses one
//! loopback App Server per pane and connects its own TUI with `codex --remote`.

use std::collections::HashMap;
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

fn thread_matches(value: &Value, workdir: &str) -> bool {
    let Some(thread) = value.pointer("/params/thread") else {
        return false;
    };
    thread.get("cwd").and_then(Value::as_str) == Some(workdir)
        && thread.get("parentThreadId").is_none_or(Value::is_null)
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

fn observer_loop(
    app: AppHandle,
    session_id: String,
    workdir: String,
    mut socket: Socket,
    control: Receiver<Control>,
) {
    let mut thread_id: Option<String> = None;
    // Request id 1 is the initial account snapshot sent after initialize. Live
    // notifications are sparse, so starting from that complete response keeps the
    // inspector useful before the first turn produces a rolling update.
    let rate_limits_request = 1u64;
    let mut next_id = 2u64;
    let mut resume_request: Option<u64> = None;
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

        if value.get("id") == Some(&json!(rate_limits_request)) {
            if let Some(result) = value.get("result") {
                emit_provider_event(
                    &app,
                    &session_id,
                    "account/rateLimits/updated",
                    result.clone(),
                    None,
                );
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
            }
            continue;
        }

        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        let params = value.get("params").cloned().unwrap_or(Value::Null);

        if method == "thread/started" && thread_id.is_none() && thread_matches(&value, &workdir) {
            let Some(id) = message_thread_id(&value).map(str::to_owned) else {
                continue;
            };
            thread_id = Some(id.clone());
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

        // Ignore other top-level threads (for example a subagent) once this pane has
        // claimed its TUI's thread. Account-wide notifications intentionally pass.
        if let (Some(bound), Some(message_thread)) =
            (thread_id.as_deref(), message_thread_id(&value))
        {
            if message_thread != bound {
                continue;
            }
        }

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

/// Start the loopback App Server and Episko observer. The returned endpoint is passed
/// to the real Codex TUI; both clients then share the same thread and approvals.
pub(crate) fn start_codex(
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
        .and_then(|()| {
            send(
                &mut socket,
                json!({ "method": "account/rateLimits/read", "id": 1 }),
            )
        })
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
    let cwd = workdir.to_string();
    std::thread::spawn(move || observer_loop(app, sid, cwd, socket, control_rx));
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
    fn claims_only_top_level_threads_in_the_panes_workdir() {
        let top = json!({ "params": { "thread": { "id": "t", "cwd": "/work", "parentThreadId": null } } });
        let child =
            json!({ "params": { "thread": { "id": "c", "cwd": "/work", "parentThreadId": "t" } } });
        assert!(thread_matches(&top, "/work"));
        assert!(!thread_matches(&top, "/other"));
        assert!(!thread_matches(&child, "/work"));
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
}
