// The core mechanism, both ends of it.
//
// `write_instrument_settings` generates the throwaway `--settings` file whose hooks
// and statusLine POST to us; `run_telemetry_server` receives those POSTs and
// forwards each to the frontend as one `telemetry` event. They are one module
// because they are one contract — a field renamed on either side goes quiet rather
// than failing, which is what the Phase-0 server test exists to catch.
//
// The two hard constraints CLAUDE.md names:
//
// - **Route by our stable launch id, never Claude's runtime `session_id`.** Claude
//   mints a new one on /clear, /compact and /resume. Every request carries ours in
//   `X-CC-Session` (or `?sid=` for the permission hook, which is `type:"http"` and
//   has no shell to add a header), and the server *forces* it onto the payload —
//   keeping Claude's incoming id as `claude_session_id`, because that, not ours, is
//   what `--resume` must target.
// - **`PermissionRequest` is a *blocking* hook.** Its request is held open in
//   `AppState.pending` and answered only by `resolve_permission`, which is why that
//   command lives here and not with the other `State<AppState>` commands. Do not
//   make it async or respond early — Claude hangs or loses the decision.

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::AppState;

/// Find a request header by (case-insensitive) name.
fn header_value(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

/// Read a query-string param from a URL like `/permission?sid=abc` (no decoding —
/// our values are uuids).
fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split('?').nth(1)?;
    q.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        (it.next() == Some(key)).then(|| it.next().unwrap_or("").to_string())
    })
}

/// Receive hook + statusLine POSTs from Claude Code and forward each to the
/// frontend as a `telemetry` event. Every request carries Episko's stable launch
/// id (`X-CC-Session` header, or `?sid=` for the permission hook); we force it onto
/// the payload as `session_id` so the frontend routes by it — immune to Claude
/// rotating its own runtime session_id on /clear, /compact or /resume.
///
/// Generic over the runtime so the tests can drive the real server against
/// `tauri::test::mock_app()`; production passes the concrete `AppHandle<Wry>`.
pub(crate) fn run_telemetry_server<R: Runtime>(server: tiny_http::Server, app: AppHandle<R>) {
    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        let stable_sid = header_value(&request, "X-CC-Session").or_else(|| query_param(&url, "sid"));
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);
        // A parse failure here silently degrades the whole pane (session shows but
        // no model/cost/phase) — e.g. the PowerShell-BOM class of bug — so it must
        // be loud. Log length + error only, never the body (it can carry prompts).
        let mut data: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => {
                if !body.is_empty() {
                    log::warn!(
                        "telemetry: dropping unparseable {} payload ({} bytes, sid {}): {e}",
                        url,
                        body.len(),
                        stable_sid.as_deref().unwrap_or("?")
                    );
                }
                serde_json::Value::Null
            }
        };
        if let Some(sid) = &stable_sid {
            if !data.is_object() {
                data = serde_json::json!({});
            }
            // Keep Claude's *runtime* id before forcing ours onto the payload. It
            // rotates on /clear, /compact and /resume — and each rotation starts a
            // NEW transcript file. So the runtime id, not our stable launch id, is
            // what `--resume` must target; the frontend records it for restore.
            // Routing still uses `session_id` (ours) and is unaffected.
            if let Some(rt) = data.get("session_id").and_then(|v| v.as_str()) {
                if rt != sid {
                    let rt = rt.to_string();
                    data["claude_session_id"] = serde_json::Value::String(rt);
                }
            }
            data["session_id"] = serde_json::Value::String(sid.clone());
        }

        // Blocking permission hook: hold the request open, ask the UI, answer later.
        if url.contains("permission") {
            let st = app.state::<AppState>();
            let id = format!("p{}", st.next_perm.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
            let _ = app.emit("permission", serde_json::json!({ "id": id, "data": data }));
            st.pending.lock().unwrap().insert(id, request);
            continue; // do NOT respond — resolve_permission will
        }

        let kind = if url.contains("statusline") { "statusline" } else { "hook" };
        let _ = app.emit("telemetry", serde_json::json!({ "kind": kind, "data": data }));
        let _ = request.respond(tiny_http::Response::from_string(""));
    }
}



/// Per-session settings file layered on top of the user's ~/.claude via
/// `claude --settings`. The generated hook/statusLine commands POST their stdin
/// payload to our telemetry server. Both platforms use absolute paths to a
/// guaranteed `curl` because Claude runs hooks/statusLine with a stripped PATH:
/// `/usr/bin/curl` (macOS/Linux) or `C:\Windows\System32\curl.exe` (Windows,
/// present since Win10 1803). On Windows the command is PowerShell — forced via
/// the hook's `shell` field, since Claude Code's default hook shell there is Git
/// Bash. curl reads Claude's payload straight from the shell's *inherited* stdin
/// (`--data-binary @-`); we deliberately do NOT round-trip it through a PowerShell
/// string (`$x=[Console]::In.ReadToEnd(); $x | curl`), because PowerShell prepends
/// a UTF-8 BOM when piping a string to a native process, which `serde_json` then
/// refuses to parse — silently dropping every payload. (Verified empirically.)
pub(crate) fn write_instrument_settings(port: u16, session_id: &str) -> std::io::Result<String> {
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir)?;

    // Tag every POST with Episko's STABLE launch id via an `X-CC-Session` header,
    // so telemetry keeps routing to the right pane even after Claude rotates its own
    // runtime session_id (/clear, /compact, /resume all mint a new one). The id is
    // baked into the generated command — no dependence on env propagation.
    #[cfg(windows)]
    let (statusline_cmd, hook_cmd, shell): (String, String, Option<&str>) = {
        let curl = r"C:\Windows\System32\curl.exe";
        let statusline = format!(
            "& '{curl}' -s --max-time 1 -X POST 'http://127.0.0.1:{port}/statusline' -H 'X-CC-Session: {session_id}' --data-binary '@-' 1>$null 2>$null; Write-Output 'cc-launcher'"
        );
        let hook = format!(
            "& '{curl}' -s --max-time 2 -X POST 'http://127.0.0.1:{port}/hook' -H 'X-CC-Session: {session_id}' --data-binary '@-' 1>$null 2>$null"
        );
        (statusline, hook, Some("powershell"))
    };
    #[cfg(not(windows))]
    let (statusline_cmd, hook_cmd, shell): (String, String, Option<&str>) = {
        let statusline = format!(
            "i=$(/bin/cat); printf '%s' \"$i\" | /usr/bin/curl -s --max-time 1 -X POST 'http://127.0.0.1:{port}/statusline' -H 'X-CC-Session: {session_id}' --data-binary @- >/dev/null 2>&1; printf 'cc-launcher'"
        );
        let hook = format!(
            "/usr/bin/curl -s --max-time 2 -X POST 'http://127.0.0.1:{port}/hook' -H 'X-CC-Session: {session_id}' --data-binary @- >/dev/null 2>&1 || true"
        );
        (statusline, hook, None)
    };

    // Build the command-hook leaf once (adding `shell` on Windows) and clone it per
    // event, so the platform choice lives in exactly one place.
    let mut hook_leaf = serde_json::json!({ "type": "command", "command": hook_cmd, "async": true, "timeout": 5 });
    if let Some(sh) = shell {
        hook_leaf["shell"] = serde_json::Value::String(sh.to_string());
    }

    let events = [
        "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
        "PostToolUseFailure", "Notification", "Stop", "StopFailure", "SubagentStart",
        "SubagentStop",
    ];
    let mut hooks = serde_json::Map::new();
    for ev in events {
        hooks.insert(
            ev.to_string(),
            serde_json::json!([ { "matcher": "", "hooks": [ hook_leaf.clone() ] } ]),
        );
    }
    // PermissionRequest is a BLOCKING http hook — Claude waits for the app's
    // decision. It's `type:"http"`, so it's shell-independent and identical on
    // every platform.
    hooks.insert(
        "PermissionRequest".to_string(),
        serde_json::json!([
            { "matcher": "", "hooks": [ { "type": "http", "url": format!("http://127.0.0.1:{port}/permission?sid={session_id}"), "timeout": 600 } ] }
        ]),
    );

    let mut statusline = serde_json::json!({ "type": "command", "command": statusline_cmd, "refreshInterval": 3, "padding": 0 });
    if let Some(sh) = shell {
        statusline["shell"] = serde_json::Value::String(sh.to_string());
    }

    let settings = serde_json::json!({
        "statusLine": statusline,
        "hooks": hooks
    });

    let path = dir.join(format!("instrument-{session_id}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&settings)?)?;
    Ok(path.to_string_lossy().to_string())
}

/// Answer a held-open PermissionRequest. behavior = "allow" | "deny" | "terminal"
/// ("terminal" returns 204 so Claude falls back to its own in-terminal prompt).
#[tauri::command]
pub(crate) fn resolve_permission(state: State<AppState>, id: String, behavior: String) {
    if let Some(req) = state.pending.lock().unwrap().remove(&id) {
        if behavior == "terminal" {
            let _ = req.respond(tiny_http::Response::from_string("").with_status_code(204));
        } else {
            let body = if behavior == "deny" {
                r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}"#
            } else {
                r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
            };
            let header =
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
            let _ = req.respond(tiny_http::Response::from_string(body).with_header(header));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::COUNTER;
    use std::collections::{HashMap, HashSet};
    use std::io::{Read, Write};
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;


    /// The core mechanism: every launch writes a throwaway `--settings` file whose
    /// hooks and statusLine POST to our telemetry server. Four properties of it are
    /// load-bearing and invisible to the compiler — our stable launch id must ride on
    /// every request (routing), curl must be called by absolute path (Claude runs
    /// hooks with a stripped PATH), the lifecycle hooks must stay fire-and-forget, and
    /// PermissionRequest must stay a *blocking* `type:"http"` hook carrying its id in
    /// `?sid=` (it has no shell to add a header). Break any one and telemetry goes
    /// quiet or Claude hangs, both at runtime only.
    #[test]
    fn instrument_settings_wire_every_hook_to_our_server() {
        let sid = format!("test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst));
        let path = write_instrument_settings(45678, &sid).expect("settings file should be written");
        assert!(path.ends_with(&format!("instrument-{sid}.json")), "unexpected path {path}");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        #[cfg(windows)]
        let curl = r"C:\Windows\System32\curl.exe";
        #[cfg(not(windows))]
        let curl = "/usr/bin/curl";

        let statusline = &v["statusLine"];
        assert_eq!(statusline["type"], "command");
        let sl = statusline["command"].as_str().expect("statusLine command");
        assert!(sl.contains(curl), "statusLine must call curl by absolute path: {sl}");
        assert!(sl.contains(&format!("X-CC-Session: {sid}")), "statusLine must tag our stable id");
        assert!(sl.contains("http://127.0.0.1:45678/statusline"), "statusLine must POST to our port");

        let hooks = v["hooks"].as_object().expect("hooks object");
        for ev in ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop"] {
            assert!(hooks.contains_key(ev), "lifecycle hook {ev} not instrumented");
        }
        for (ev, matchers) in hooks.iter().filter(|(ev, _)| ev.as_str() != "PermissionRequest") {
            let leaf = &matchers[0]["hooks"][0];
            assert_eq!(leaf["type"], "command", "{ev}");
            assert_eq!(leaf["async"], true, "{ev} must stay fire-and-forget");
            let cmd = leaf["command"].as_str().unwrap_or_else(|| panic!("{ev} has no command"));
            assert!(cmd.contains(curl), "{ev} must call curl by absolute path: {cmd}");
            assert!(cmd.contains(&format!("X-CC-Session: {sid}")), "{ev} must tag the POST with our stable id");
            assert!(cmd.contains("http://127.0.0.1:45678/hook"), "{ev} must POST to our port");
        }

        let perm = &hooks["PermissionRequest"][0]["hooks"][0];
        assert_eq!(perm["type"], "http", "PermissionRequest is shell-independent");
        assert_eq!(perm["url"], format!("http://127.0.0.1:45678/permission?sid={sid}"));
        assert!(perm.get("async").is_none(), "PermissionRequest must block until the user answers");
        assert!(perm["timeout"].as_u64().unwrap_or(0) >= 60, "a human needs longer than a hook default to decide");

        // Claude Code's default hook shell on Windows is Git Bash, so the PowerShell
        // commands must say so; off Windows the field must be absent, not empty.
        #[cfg(windows)]
        {
            assert_eq!(statusline["shell"], "powershell");
            assert_eq!(hooks["Stop"][0]["hooks"][0]["shell"], "powershell");
            assert!(perm.get("shell").is_none(), "an http hook has no shell to set");
        }
        #[cfg(not(windows))]
        {
            assert!(statusline.get("shell").is_none(), "no shell override off Windows");
            assert!(hooks["Stop"][0]["hooks"][0].get("shell").is_none());
        }

        let _ = std::fs::remove_file(&path);
    }

    /// How the *blocking* permission hook identifies itself: it's `type:"http"`, so
    /// there's no shell to add the `X-CC-Session` header and the id rides in `?sid=`
    /// instead. Getting nothing back here means the request can't be routed.
    #[test]
    fn query_param_reads_the_permission_sid() {
        assert_eq!(query_param("/permission?sid=abc-123", "sid").as_deref(), Some("abc-123"));
        assert_eq!(query_param("/permission?x=1&sid=abc&y=2", "sid").as_deref(), Some("abc"));
        // A key that merely ends with ours is a different key.
        assert_eq!(query_param("/permission?xsid=abc", "sid"), None);
        // The other endpoints carry no query string at all.
        assert_eq!(query_param("/hook", "sid"), None);
        assert_eq!(query_param("/statusline?", "sid"), None);
        // Degenerate spellings yield an empty id rather than panicking.
        assert_eq!(query_param("/permission?sid=", "sid").as_deref(), Some(""));
        assert_eq!(query_param("/permission?sid", "sid").as_deref(), Some(""));
    }

    // ---------- telemetry server ----------
    //
    // The app's core mechanism, driven for real: a `tiny_http` server on an ephemeral
    // port, a windowless `mock_app()` to emit through, and raw sockets standing in for
    // the curl commands `write_instrument_settings` generates. No Claude, no PTY.

    /// Bring the real server up against a mock app. The returned `App` must be kept
    /// alive by the caller — it owns the listeners the assertions read.
    fn mock_telemetry_app() -> (tauri::App<tauri::test::MockRuntime>, u16) {
        let app = tauri::test::mock_app();
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind telemetry server");
        let port = server.server_addr().to_ip().expect("ip address").port();
        app.manage(AppState {
            port,
            sessions: Mutex::new(HashMap::new()),
            owned_pids: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
            next_perm: std::sync::atomic::AtomicU64::new(1),
            caffeinate: Mutex::new(None),
        });
        let handle = app.handle().clone();
        std::thread::spawn(move || run_telemetry_server(server, handle));
        (app, port)
    }

    /// Send one POST and leave the connection open, the way a hook's curl does.
    fn open_post(port: u16, path: &str, headers: &[(&str, &str)], body: &str) -> std::net::TcpStream {
        let extra: String = headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect to telemetry server");
        write!(
            s,
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
            body.len()
        )
        .expect("send request");
        s.flush().expect("flush request");
        s
    }

    /// Read one response, stopping at the end of its body rather than waiting for the
    /// connection to close (so a keep-alive server can't stall the test), and
    /// returning whatever arrived if `wait` elapses first.
    fn read_response(mut s: std::net::TcpStream, wait: std::time::Duration) -> String {
        s.set_read_timeout(Some(wait)).expect("set read timeout");
        let mut out = Vec::new();
        let mut buf = [0u8; 512];
        loop {
            match s.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
            }
            let text = String::from_utf8_lossy(&out);
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let len = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
                    .and_then(|l| l.split(':').nth(1).and_then(|v| v.trim().parse::<usize>().ok()))
                    .unwrap_or(0);
                if body.len() >= len {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// The routing-drift bug class, end to end. Claude mints a NEW session_id on
    /// /clear, /compact and /resume, so the id in the payload drifts away from the one
    /// we launched with. Every POST therefore carries our stable id in `X-CC-Session`
    /// and the server forces it onto the payload — get this wrong and telemetry routes
    /// to nothing: the inspector freezes while the process runs on.
    #[test]
    fn telemetry_forces_our_session_id_and_preserves_claudes() {
        use tauri::Listener;
        let (app, port) = mock_telemetry_app();
        let (tx, rx) = std::sync::mpsc::channel();
        app.listen("telemetry", move |e| {
            let _ = tx.send(e.payload().to_string());
        });
        let next = || -> serde_json::Value {
            let raw = rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("server emitted no telemetry event");
            serde_json::from_str(&raw).expect("event payload should be json")
        };
        let wait = std::time::Duration::from_secs(5);

        // A hook fired after a rotation: the body carries Claude's *new* runtime id,
        // the header carries ours.
        read_response(
            open_post(port, "/hook", &[("X-CC-Session", "ours-abc")], r#"{"session_id":"claude-rotated","hook_event_name":"Stop"}"#),
            wait,
        );
        let ev = next();
        assert_eq!(ev["kind"], "hook");
        assert_eq!(ev["data"]["session_id"], "ours-abc", "routing must use OUR launch id");
        assert_eq!(ev["data"]["claude_session_id"], "claude-rotated", "the resume target must survive");
        assert_eq!(ev["data"]["hook_event_name"], "Stop", "the rest of the payload is untouched");

        // Same id on both sides (the pre-rotation common case): there's nothing to
        // preserve, so no resume target is invented.
        read_response(
            open_post(port, "/statusline", &[("X-CC-Session", "ours-abc")], r#"{"session_id":"ours-abc","model":{"display_name":"Opus"}}"#),
            wait,
        );
        let ev = next();
        assert_eq!(ev["kind"], "statusline", "the endpoint decides the kind");
        assert_eq!(ev["data"]["session_id"], "ours-abc");
        assert!(ev["data"].get("claude_session_id").is_none(), "no rotation, no second id");
        assert_eq!(ev["data"]["model"]["display_name"], "Opus");

        // An unparseable body (the PowerShell-BOM class of bug) must still route, so
        // the pane degrades to "no detail" rather than the event vanishing.
        read_response(open_post(port, "/hook", &[("X-CC-Session", "ours-abc")], "\u{feff}{not json}"), wait);
        let ev = next();
        assert_eq!(ev["data"]["session_id"], "ours-abc");
    }

    /// The one *blocking* hook. Claude sits on the open request until the user
    /// answers, so the server must hold it rather than respond, route it by the
    /// `?sid=` in the URL (it's `type:"http"` — no shell to add a header), and hand
    /// back the decision only when `resolve_permission` supplies one.
    #[test]
    fn permission_request_is_held_open_until_the_ui_answers() {
        use tauri::Listener;
        let (app, port) = mock_telemetry_app();
        let (tx, rx) = std::sync::mpsc::channel();
        app.listen("permission", move |e| {
            let _ = tx.send(e.payload().to_string());
        });

        let mut conn = open_post(port, "/permission?sid=ours-xyz", &[], r#"{"session_id":"claude-rotated","tool_name":"Bash"}"#);
        let raw = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("server emitted no permission event");
        let ev: serde_json::Value = serde_json::from_str(&raw).expect("event payload should be json");
        let id = ev["id"].as_str().expect("the UI needs an id to answer with").to_string();
        assert_eq!(ev["data"]["session_id"], "ours-xyz", "routed by ?sid=, with no header to read");
        assert_eq!(ev["data"]["claude_session_id"], "claude-rotated");
        assert_eq!(ev["data"]["tool_name"], "Bash");

        // Nothing on the wire yet: answering early would lose the user's decision.
        conn.set_read_timeout(Some(std::time::Duration::from_millis(400))).unwrap();
        let mut byte = [0u8; 1];
        match conn.read(&mut byte) {
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Ok(0) => panic!("server closed the request before the user answered"),
            Ok(n) => panic!("server answered before the user did ({n} bytes)"),
            Err(e) => panic!("unexpected socket error: {e}"),
        }

        resolve_permission(app.state(), id.clone(), "deny".to_string());
        let resp = read_response(conn, std::time::Duration::from_secs(10));
        assert!(resp.starts_with("HTTP/1.1 200"), "expected a 200 with the decision, got:\n{resp}");
        assert!(resp.contains(r#""behavior":"deny""#), "the decision must reach Claude:\n{resp}");

        // The held request is consumed by answering: a second decision (a double
        // click, a stale dialog) is a no-op rather than a panic on a gone request.
        resolve_permission(app.state(), id, "allow".to_string());
    }

}
