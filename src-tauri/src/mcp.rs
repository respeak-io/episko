// The Episko MCP server a Claude pane is launched with (`--mcp-config`): JSON-RPC over the
// telemetry listener's `/mcp`, answered here for the protocol and by the frontend for every
// tool call, since the task launch path lives there. docs/mcp.md.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::telemetry::{header_value, query_param};
use crate::AppState;

const PROTOCOL: &str = "2025-06-18";

/// Read into the agent's system prompt by Claude Code; the one steering lever that costs nothing.
const INSTRUCTIONS: &str = "You are running inside Episko, a desktop app that hosts several coding-agent \
sessions side by side. Run this project's tests, builds, lint and type checks through `run_task` \
rather than Bash: the run gets its own pane the user can watch and stop, with their PATH, their \
task overrides and their inputs. Use Bash freely for one-off commands no task covers. Ids are \
`<source>:<name>` (npm:test, just:lint, episko:typecheck); guess one, and a miss lists them all.";

/// 128 bits from the OS, hex. A tool call can launch processes, so the endpoint is not open
/// to whatever else on the machine (or a rebinding web page) can reach 127.0.0.1.
fn token() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| format!("mcp token: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// The per-launch `--mcp-config` file. A file and not an inline argument, because an
/// argument (and the token in it) is readable by every user through `ps`.
pub(crate) fn write_mcp_config(state: &AppState, port: u16, session_id: &str) -> std::io::Result<String> {
    let tok = token().map_err(std::io::Error::other)?;
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir)?;
    let cfg = json!({ "mcpServers": { "episko": {
        "type": "http",
        "url": format!("http://127.0.0.1:{port}/mcp?sid={session_id}"),
        "headers": { "Authorization": format!("Bearer {tok}") },
    }}});
    let path = dir.join(format!("mcp-{session_id}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&cfg)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    state.mcp_tokens.lock().unwrap().insert(session_id.to_string(), tok);
    Ok(path.to_string_lossy().to_string())
}

pub(crate) fn forget_session(state: &AppState, session_id: &str) {
    state.mcp_tokens.lock().unwrap().remove(session_id);
}

fn tools() -> Value {
    let wait = json!({ "type": "integer", "minimum": 0, "maximum": 1800,
        "description": "Seconds to wait for the run to exit before returning a handle (default 600)." });
    json!([
        {
            "name": "list_runnables",
            "description": "List the tasks this project defines (package.json scripts, justfile recipes, \
VS Code tasks, Makefile targets, .episko/tasks.toml, ...) as Episko discovers them for this session's \
folder, with the id run_task takes and the command each runs.",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "run_task",
            "description": "Run one of the project's tasks in its own Episko pane, which the user can \
watch, and wait for it to finish. Returns the exit code and the tail of its output. Prefer this \
over Bash for tests, builds and checks. An unknown id is answered with the full list, so there is \
no need to list first. One-shot tasks only; a dev server is refused.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string", "description": "`<source>:<name>`: an npm script is npm:<script>, a .episko/tasks.toml task episko:<label>, a just recipe just:<recipe>." },
                "inputs": { "type": "object", "additionalProperties": { "type": "string" },
                    "description": "Values for the task's declared inputs, by input id." },
                "wait_seconds": wait,
            }, "required": ["id"] },
        },
        {
            "name": "task_status",
            "description": "Keep waiting for a run that run_task returned before it finished, then \
report its exit code and output.",
            "inputSchema": { "type": "object", "properties": {
                "handle": { "type": "string", "description": "The handle run_task returned." },
                "wait_seconds": wait,
            }, "required": ["handle"] },
        },
    ])
}

fn respond(req: tiny_http::Request, status: u16, body: Option<Value>) {
    let text = body.map(|b| b.to_string()).unwrap_or_default();
    let mut res = tiny_http::Response::from_string(text).with_status_code(status);
    if status == 200 {
        res = res.with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
        );
    }
    let _ = req.respond(res);
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Byte-for-byte, without an early exit on the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorised(state: &AppState, req: &tiny_http::Request, sid: &str) -> bool {
    let Some(want) = state.mcp_tokens.lock().unwrap().get(sid).cloned() else { return false };
    header_value(req, "Authorization")
        .and_then(|h| h.strip_prefix("Bearer ").map(str::to_string))
        .is_some_and(|got| same(&got, &want))
}

/// One `/mcp` request. Only `tools/call` is held open: it goes to the frontend as `mcp-call`
/// and is answered by `resolve_mcp`, the PermissionRequest shape.
pub(crate) fn handle<R: Runtime>(req: tiny_http::Request, url: &str, body: &str, app: &AppHandle<R>) {
    let st = app.state::<AppState>();
    let sid = query_param(url, "sid").unwrap_or_default();
    if !authorised(&st, &req, &sid) {
        log::warn!("mcp: refused an unauthorised request for sid {sid:?}");
        return respond(req, 401, None);
    }
    // Streamable HTTP lets a server decline the GET stream; nothing here is pushed.
    if *req.method() != tiny_http::Method::Post {
        return respond(req, 405, None);
    }
    let Ok(msg) = serde_json::from_str::<Value>(body) else {
        return respond(req, 400, Some(rpc_error(&Value::Null, -32700, "parse error")));
    };
    let Some(id) = msg.get("id").cloned() else {
        return respond(req, 202, None); // a notification: nothing to answer
    };
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            let version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL);
            respond(req, 200, Some(rpc_result(&id, json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "episko", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }))));
        }
        "ping" => respond(req, 200, Some(rpc_result(&id, json!({})))),
        "tools/list" => respond(req, 200, Some(rpc_result(&id, json!({ "tools": tools() })))),
        "tools/call" => {
            let call = format!("m{}", st.next_perm.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
            // Parked before the emit, or an answer quicker than this thread finds nothing to answer.
            st.mcp_pending.lock().unwrap().insert(call.clone(), (req, id));
            let _ = app.emit("mcp-call", json!({
                "id": call,
                "sessionId": sid,
                "tool": params.get("name").and_then(Value::as_str).unwrap_or(""),
                "args": params.get("arguments").cloned().unwrap_or(json!({})),
            }));
        }
        _ => respond(req, 200, Some(rpc_error(&id, -32601, "method not found"))),
    }
}

/// Answer a held `tools/call` with the frontend's text.
#[tauri::command]
pub(crate) fn resolve_mcp(state: State<AppState>, id: String, text: String, is_error: bool) {
    if let Some((req, rpc_id)) = state.mcp_pending.lock().unwrap().remove(&id) {
        respond(req, 200, Some(rpc_result(&rpc_id, json!({
            "content": [{ "type": "text", "text": text }],
            "isError": is_error,
        }))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_128_bits_of_hex_and_never_repeats() {
        let (a, b) = (token().unwrap(), token().unwrap());
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn same_compares_whole_strings() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
        assert!(!same("", "a"));
    }

    #[test]
    fn every_tool_declares_an_object_schema() {
        for t in tools().as_array().unwrap() {
            assert!(t["name"].as_str().is_some_and(|n| !n.is_empty()));
            assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
        }
    }
}
