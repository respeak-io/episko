// Both ends of the instrumentation contract: `write_instrument_settings` generates the
// `--settings` file whose hooks and statusLine POST here, and `run_telemetry_server`
// forwards each POST as one `telemetry` event. The routing and blocking rules: CLAUDE.md.

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::AppState;

fn header_value(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

/// No percent-decoding: the only value read this way is a uuid.
fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split('?').nth(1)?;
    q.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        (it.next() == Some(key)).then(|| it.next().unwrap_or("").to_string())
    })
}

/// Doubles from 1s and caps at 32s. The cap matters more than the ladder: a failed
/// re-bind is usually a TIME_WAIT window of tens of seconds, which an uncapped ladder outsleeps.
fn rebind_delay(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs(1u64 << attempt.min(5))
}

/// Attempts on the original port before taking a fresh ephemeral one. Every
/// instrument file on disk names the old port, so reclaiming it revives every running pane.
const REBIND_GIVE_UP: u32 = 8;

/// Get a listener back on `port`, and say where it landed. Must sleep before the first try:
/// `tiny_http`'s `Drop` never joins its accept thread, so the old listener is briefly still
/// bound, and `SO_REUSEADDR` covers TIME_WAIT, not a socket that is still listening.
fn rebind_telemetry(port: u16) -> (tiny_http::Server, u16) {
    let mut attempt = 0u32;
    loop {
        std::thread::sleep(rebind_delay(attempt));
        let want = if attempt >= REBIND_GIVE_UP { 0 } else { port }; // 0: any ephemeral port
        match tiny_http::Server::http(("127.0.0.1", want)) {
            Ok(s) => {
                let got = s.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
                return (s, got);
            }
            Err(e) => {
                log::warn!("telemetry: re-bind of 127.0.0.1:{want} failed (attempt {attempt}): {e}");
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

/// Keep a listener up for the life of the app: tiny_http drops its socket on any `accept()`
/// error and nothing retries, and a dead port is silent everywhere (async hooks, `curl -s`).
/// Re-bind the SAME port, or every pane already launched stays deaf; CLAUDE.md has the story.
pub(crate) fn serve_telemetry<R: Runtime>(server: tiny_http::Server, app: AppHandle<R>) {
    let mut server = server;
    loop {
        run_telemetry_server(server, app.clone()); // returns only when the listener is gone

        let port = app.state::<AppState>().port.load(std::sync::atomic::Ordering::Relaxed);
        log::error!("telemetry: listener on 127.0.0.1:{port} died; re-binding");
        let _ = app.emit("telemetry-health", serde_json::json!({ "up": false, "port": port }));

        let (next, now) = rebind_telemetry(port);
        server = next;
        if now != port {
            log::error!("telemetry: could not reclaim {port}, now on {now} — sessions launched before this stay silent until relaunched");
            app.state::<AppState>().port.store(now, std::sync::atomic::Ordering::Relaxed);
        } else {
            log::info!("telemetry: listener back on 127.0.0.1:{now}");
        }
        let _ = app.emit("telemetry-health", serde_json::json!({ "up": true, "port": now, "moved": now != port }));
    }
}

/// Forward each hook/statusLine POST as one `telemetry` event, with our stable launch id
/// forced onto `session_id`. Returns when the listener dies; `serve_telemetry` puts it back.
/// Generic over the runtime so tests can drive it against `tauri::test::mock_app()`.
pub(crate) fn run_telemetry_server<R: Runtime>(server: tiny_http::Server, app: AppHandle<R>) {
    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        let stable_sid = header_value(&request, "X-CC-Session").or_else(|| query_param(&url, "sid"));
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);
        // Loud on purpose (a dropped payload blanks the pane), but never log the body:
        // it can carry prompts.
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
            // Claude's runtime id rotates on /clear, /compact and /resume, and each rotation
            // starts a new transcript, so it (not ours) is what `--resume` must target.
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



/// The per-launch `--settings` file whose hooks and statusLine POST to our server. curl by
/// absolute path (Claude strips PATH), reading Claude's payload from inherited stdin, never
/// via a PowerShell string (it prepends a BOM serde_json rejects). Hooks use the exec form
/// (no shell); the statusLine must parse in Git Bash AND PowerShell. Details: CLAUDE.md.
pub(crate) fn write_instrument_settings(port: u16, session_id: &str) -> std::io::Result<String> {
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir)?;

    // The stable id is baked into each command as the X-CC-Session header, never read from env.
    #[cfg(windows)]
    let (statusline_cmd, curl, null_dev): (String, &str, &str) = {
        // Must parse in Git Bash and PowerShell alike: -o NUL, not 1>$null; echo, not Write-Output.
        let statusline = format!(
            "C:/Windows/System32/curl.exe -s -o NUL --max-time 1 -X POST 'http://127.0.0.1:{port}/statusline' -H 'X-CC-Session: {session_id}' --data-binary '@-'; echo cc-launcher"
        );
        (statusline, r"C:\Windows\System32\curl.exe", "NUL")
    };
    #[cfg(not(windows))]
    let (statusline_cmd, curl, null_dev): (String, &str, &str) = {
        let statusline = format!(
            "i=$(/bin/cat); printf '%s' \"$i\" | /usr/bin/curl -s --max-time 1 -X POST 'http://127.0.0.1:{port}/statusline' -H 'X-CC-Session: {session_id}' --data-binary @- >/dev/null 2>&1; printf 'cc-launcher'"
        );
        (statusline, "/usr/bin/curl", "/dev/null")
    };

    // Exec form: each arg reaches curl verbatim, so no shell runs and nothing is quoted.
    // No `|| true` needed: the hooks are async, and the one exit code a hook reads (2, block
    // the tool) is curl's "failed to initialize", never a refused connection or a timeout.
    let hook_leaf = serde_json::json!({
        "type": "command",
        "command": curl,
        "args": [
            "-s", "-o", null_dev, "--max-time", "2",
            "-X", "POST", format!("http://127.0.0.1:{port}/hook"),
            "-H", format!("X-CC-Session: {session_id}"),
            "--data-binary", "@-",
        ],
        "async": true,
        "timeout": 5,
    });

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
    // The one BLOCKING hook; `type:"http"`, so shell-independent and identical on every platform.
    hooks.insert(
        "PermissionRequest".to_string(),
        serde_json::json!([
            { "matcher": "", "hooks": [ { "type": "http", "url": format!("http://127.0.0.1:{port}/permission?sid={session_id}"), "timeout": 600 } ] }
        ]),
    );

    // No `shell`: Claude Code defines none for the statusLine and would silently ignore it.
    // `refreshInterval` is the idle cadence only (an active session re-runs it on events),
    // and each tick is a shell + curl spawn per running session, so 10s, not 3s. Don't drop
    // it: idle sessions have no events to ride, and the frontend's un-end backstop needs it.
    let statusline = serde_json::json!({ "type": "command", "command": statusline_cmd, "refreshInterval": 10, "padding": 0 });

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


    /// Four properties the compiler cannot see: our stable id on every request, curl by
    /// absolute path (Claude strips PATH), lifecycle hooks fire-and-forget, and
    /// PermissionRequest a blocking `type:"http"` hook carrying its id in `?sid=`.
    #[test]
    fn instrument_settings_wire_every_hook_to_our_server() {
        let sid = format!("test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst));
        let path = write_instrument_settings(45678, &sid).expect("settings file should be written");
        assert!(path.ends_with(&format!("instrument-{sid}.json")), "unexpected path {path}");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        // Forward slashes in the statusLine's curl: Git Bash eats lone backslashes as escapes.
        #[cfg(windows)]
        let (curl, sl_curl) = (r"C:\Windows\System32\curl.exe", "C:/Windows/System32/curl.exe");
        #[cfg(not(windows))]
        let (curl, sl_curl) = ("/usr/bin/curl", "/usr/bin/curl");

        let statusline = &v["statusLine"];
        assert_eq!(statusline["type"], "command");
        let sl = statusline["command"].as_str().expect("statusLine command");
        assert!(sl.contains(sl_curl), "statusLine must call curl by absolute path: {sl}");
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
            // Equality, not `contains`: command text that merely starts with the curl path
            // would run through a shell again and still pass a substring test.
            assert_eq!(leaf["command"], curl, "{ev} must name the curl binary itself");
            let args: Vec<&str> = leaf["args"].as_array()
                .unwrap_or_else(|| panic!("{ev} must use exec form (an args array)"))
                .iter().map(|a| a.as_str().unwrap_or_else(|| panic!("{ev} arg is not a string"))).collect();
            assert!(args.contains(&format!("X-CC-Session: {sid}").as_str()),
                "{ev} must tag the POST with our stable id: {args:?}");
            assert!(args.contains(&"http://127.0.0.1:45678/hook"), "{ev} must POST to our port: {args:?}");
            assert!(args.contains(&"@-"), "{ev} must forward Claude's stdin payload: {args:?}");
            // Nothing re-parses these, so a quote would reach curl as part of the value.
            for a in &args {
                assert!(!a.contains('\'') && !a.contains('"'), "{ev} arg {a:?} is quoted — exec form takes it literally");
            }
        }

        let perm = &hooks["PermissionRequest"][0]["hooks"][0];
        assert_eq!(perm["type"], "http", "PermissionRequest is shell-independent");
        assert_eq!(perm["url"], format!("http://127.0.0.1:45678/permission?sid={sid}"));
        assert!(perm.get("async").is_none(), "PermissionRequest must block until the user answers");
        assert!(perm["timeout"].as_u64().unwrap_or(0) >= 60, "a human needs longer than a hook default to decide");

        // `shell` is a hook field; the statusLine has none, and one set there is ignored
        // while reading as though the shell were pinned.
        assert!(statusline.get("shell").is_none(), "the statusLine has no shell field to set: {statusline}");
        // With `args` set Claude Code ignores `shell` too, so an exec-form hook must not carry one.
        assert!(hooks["Stop"][0]["hooks"][0].get("shell").is_none(),
            "an exec-form hook has no shell to pin");
        assert!(perm.get("shell").is_none(), "an http hook has no shell to set");

        let _ = std::fs::remove_file(&path);
    }

    /// `type:"http"` has no shell to add a header, so the permission hook's id rides in `?sid=`.
    #[test]
    fn query_param_reads_the_permission_sid() {
        assert_eq!(query_param("/permission?sid=abc-123", "sid").as_deref(), Some("abc-123"));
        assert_eq!(query_param("/permission?x=1&sid=abc&y=2", "sid").as_deref(), Some("abc"));
        assert_eq!(query_param("/permission?xsid=abc", "sid"), None);
        assert_eq!(query_param("/hook", "sid"), None);
        assert_eq!(query_param("/statusline?", "sid"), None);
        // Degenerate spellings yield an empty id rather than panicking.
        assert_eq!(query_param("/permission?sid=", "sid").as_deref(), Some(""));
        assert_eq!(query_param("/permission?sid", "sid").as_deref(), Some(""));
    }

    // ---------- telemetry server ----------
    // The real server on an ephemeral port, a windowless `mock_app()` to emit through, and
    // raw sockets standing in for curl. No Claude, no PTY.

    /// The caller keeps the returned `App` alive: it owns the listeners the assertions read.
    fn mock_telemetry_app() -> (tauri::App<tauri::test::MockRuntime>, u16) {
        let app = tauri::test::mock_app();
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind telemetry server");
        let port = server.server_addr().to_ip().expect("ip address").port();
        app.manage(AppState {
            port: std::sync::atomic::AtomicU16::new(port),
            sessions: Mutex::new(HashMap::new()),
            agent_runtimes: Mutex::new(HashMap::new()),
            owned_pids: Mutex::new(HashSet::new()),
            io_samples: Mutex::new(HashMap::new()),
            io_retired: Mutex::new((0, 0)),
            bg_root: Mutex::new(crate::pty::BgRootState::default()),
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

    /// Stops at the end of the body, not at close: a keep-alive server would stall the test.
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

    /// Claude mints a new session_id on /clear, /compact and /resume; the header must win
    /// over the payload, or telemetry routes to nothing while the process runs on.
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

        // After a rotation: the body carries Claude's new runtime id, the header ours.
        read_response(
            open_post(port, "/hook", &[("X-CC-Session", "ours-abc")], r#"{"session_id":"claude-rotated","hook_event_name":"Stop"}"#),
            wait,
        );
        let ev = next();
        assert_eq!(ev["kind"], "hook");
        assert_eq!(ev["data"]["session_id"], "ours-abc", "routing must use OUR launch id");
        assert_eq!(ev["data"]["claude_session_id"], "claude-rotated", "the resume target must survive");
        assert_eq!(ev["data"]["hook_event_name"], "Stop", "the rest of the payload is untouched");

        // Same id on both sides: no resume target is invented.
        read_response(
            open_post(port, "/statusline", &[("X-CC-Session", "ours-abc")], r#"{"session_id":"ours-abc","model":{"display_name":"Opus"}}"#),
            wait,
        );
        let ev = next();
        assert_eq!(ev["kind"], "statusline", "the endpoint decides the kind");
        assert_eq!(ev["data"]["session_id"], "ours-abc");
        assert!(ev["data"].get("claude_session_id").is_none(), "no rotation, no second id");
        assert_eq!(ev["data"]["model"]["display_name"], "Opus");

        // An unparseable body (a BOM, say) still routes, so the pane degrades rather than vanishes.
        read_response(open_post(port, "/hook", &[("X-CC-Session", "ours-abc")], "\u{feff}{not json}"), wait);
        let ev = next();
        assert_eq!(ev["data"]["session_id"], "ours-abc");
    }

    /// Git Bash specifically, not the first `bash` on PATH: with WSL that is System32's Linux
    /// bash, where `C:/Windows/...` does not exist and the result would say nothing about the
    /// product. `CLAUDE_CODE_GIT_BASH_PATH` first, as Claude Code itself reads it.
    #[cfg(windows)]
    fn git_bash() -> Option<std::path::PathBuf> {
        if let Some(p) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").map(std::path::PathBuf::from) {
            if p.is_file() {
                return Some(p);
            }
        }
        let mut roots = vec![
            std::path::PathBuf::from(r"C:\Program Files\Git"),
            std::path::PathBuf::from(r"C:\Program Files (x86)\Git"),
        ];
        // `git --exec-path` sits under the install root (…/mingw64/libexec/git-core); walk up.
        if let Ok(out) = std::process::Command::new("git").arg("--exec-path").output() {
            let p = std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
            roots.extend(p.ancestors().map(|a| a.to_path_buf()));
        }
        roots.into_iter().map(|r| r.join("bin").join("bash.exe")).find(|p| p.is_file())
    }

    /// The statusLine string, executed by every shell Claude might pick: only a shell's own
    /// parser can say it parses, and one that rejects it silently drops every figure the
    /// statusLine carries while the hooks keep the pane looking healthy. No Claude, no tokens.
    #[test]
    fn statusline_command_posts_from_every_shell_claude_might_pick() {
        use tauri::Listener;
        let (app, port) = mock_telemetry_app();
        let (tx, rx) = std::sync::mpsc::channel();
        app.listen("telemetry", move |e| {
            let _ = tx.send(e.payload().to_string());
        });

        let sid = format!("test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst));
        let path = write_instrument_settings(port, &sid).expect("settings file should be written");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let cmd = v["statusLine"]["command"].as_str().expect("statusLine command").to_string();

        // Trimmed to what `applyStatusline` reads. `session_id` differs from ours on purpose:
        // a statusLine fires after /clear too, and the header is what routes it back.
        let payload = concat!(
            r#"{"session_id":"claude-rotated","model":{"display_name":"Opus"},"#,
            r#""context_window":{"used_percentage":37},"cost":{"total_cost_usd":1.25},"#,
            r#""rate_limits":{"five_hour":{"used_percentage":42}}}"#
        );

        // Claude picks Git Bash when installed, else PowerShell, and never says which.
        #[cfg(windows)]
        let shells: Vec<(std::path::PathBuf, &[&str])> = {
            let mut v: Vec<(std::path::PathBuf, &[&str])> = Vec::new();
            match git_bash() {
                Some(b) => v.push((b, &["-c"][..])),
                None => eprintln!("skipping Git Bash: not installed (Claude would use PowerShell here too)"),
            }
            v.push((std::path::PathBuf::from("powershell"), &["-NoProfile", "-Command"][..]));
            v
        };
        #[cfg(not(windows))]
        let shells: Vec<(std::path::PathBuf, &[&str])> = vec![(std::path::PathBuf::from("sh"), &["-c"][..])];

        let mut ran = Vec::new();
        for (prog, args) in shells {
            let bin = prog.display().to_string();
            let spawned = std::process::Command::new(&prog)
                .args(args)
                .arg(&cmd)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn();
            let mut child = match spawned {
                Ok(c) => c,
                // A shell Claude could not pick either is skipped, not failed.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    eprintln!("skipping {bin}: not installed");
                    continue;
                }
                Err(e) => panic!("could not spawn {bin}: {e}"),
            };
            let mut sin = child.stdin.take().expect("child stdin");
            sin.write_all(payload.as_bytes()).expect("pipe the payload in");
            drop(sin); // EOF is what `--data-binary @-` waits for
            let out = child.wait_with_output().expect("wait for the statusLine command");
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            // The trailing `; echo` makes the exit status echo's, so a shell that cannot parse
            // the command or find curl says so on stderr and nowhere else (`-s` keeps curl quiet).
            assert!(
                out.status.success() && err.is_empty(),
                "{bin} could not run the statusLine command ({}):\n  {cmd}\n  {err}",
                out.status
            );
            assert!(
                String::from_utf8_lossy(&out.stdout).contains("cc-launcher"),
                "{bin} ran it but printed no marker: {:?}",
                String::from_utf8_lossy(&out.stdout)
            );

            let raw = rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap_or_else(|_| panic!("{bin} ran the statusLine command but nothing reached the telemetry server"));
            let ev: serde_json::Value = serde_json::from_str(&raw).expect("event payload should be json");
            assert_eq!(ev["kind"], "statusline", "{bin}");
            assert_eq!(ev["data"]["session_id"], sid.as_str(), "{bin}: the header must route it to our launch id");
            assert_eq!(ev["data"]["claude_session_id"], "claude-rotated", "{bin}: the resume target must survive");
            // A body mangled in transit (a BOM, a lost pipe, an eaten quote) fails here.
            assert_eq!(ev["data"]["model"]["display_name"], "Opus", "{bin}");
            assert_eq!(ev["data"]["context_window"]["used_percentage"], 37, "{bin}");
            assert_eq!(ev["data"]["cost"]["total_cost_usd"], 1.25, "{bin}");
            assert_eq!(ev["data"]["rate_limits"]["five_hour"]["used_percentage"], 42, "{bin}");
            ran.push(bin);
        }
        assert!(!ran.is_empty(), "no shell was available to run the statusLine command in");
        eprintln!("statusLine verified through: {}", ran.join(", "));

        let _ = std::fs::remove_file(&path);
    }

    /// The hook's exec form, spawned exactly as Claude Code spawns it: no shell anywhere, so
    /// nothing strips quotes or splits words, and shell-style quoting reaches curl verbatim and
    /// fails silently (`-s`, `async`). Only curl's own argv parsing can say the args are right.
    #[test]
    fn hook_exec_form_posts_without_any_shell() {
        use tauri::Listener;
        let (app, port) = mock_telemetry_app();
        let (tx, rx) = std::sync::mpsc::channel();
        app.listen("telemetry", move |e| {
            let _ = tx.send(e.payload().to_string());
        });

        let sid = format!("test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst));
        let path = write_instrument_settings(port, &sid).expect("settings file should be written");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let leaf = &v["hooks"]["PostToolUse"][0]["hooks"][0];
        let prog = leaf["command"].as_str().expect("hook command").to_string();
        let args: Vec<String> = leaf["args"].as_array().expect("hook args (exec form)")
            .iter().map(|a| a.as_str().expect("arg is a string").to_string()).collect();

        // Trimmed to what `applyHook` reads. `session_id` is not ours: the -H arg has to route it.
        let payload = concat!(
            r#"{"session_id":"claude-rotated","hook_event_name":"PostToolUse","#,
            r#""cwd":"/tmp/x","tool_name":"Bash","tool_input":{"command":"git checkout -b feat"}}"#
        );

        let mut child = std::process::Command::new(&prog)
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("could not spawn the hook binary {prog}: {e}"));
        let mut sin = child.stdin.take().expect("child stdin");
        sin.write_all(payload.as_bytes()).expect("pipe the payload in");
        drop(sin); // EOF is what `--data-binary @-` waits for
        let out = child.wait_with_output().expect("wait for the hook command");
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        assert!(
            out.status.success() && err.is_empty(),
            "the hook argv did not run cleanly ({}):\n  {prog} {args:?}\n  {err}",
            out.status
        );
        // A wrong `-o` null device leaves the response body on stdout.
        assert!(out.stdout.is_empty(), "the hook must print nothing: {:?}", String::from_utf8_lossy(&out.stdout));

        let raw = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the hook ran but nothing reached the telemetry server");
        let ev: serde_json::Value = serde_json::from_str(&raw).expect("event payload should be json");
        assert_eq!(ev["kind"], "hook");
        assert_eq!(ev["data"]["session_id"], sid.as_str(), "the -H arg must route it to our launch id");
        assert_eq!(ev["data"]["claude_session_id"], "claude-rotated", "the resume target must survive");
        // A quote that survived into the value, or a mangled body, fails here.
        assert_eq!(ev["data"]["hook_event_name"], "PostToolUse");
        assert_eq!(ev["data"]["tool_input"]["command"], "git checkout -b feat");

        let _ = std::fs::remove_file(&path);
    }

    /// Claude sits on the open request until the user answers: the server must hold it, route
    /// it by `?sid=`, and answer only when `resolve_permission` supplies the decision.
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

        // A second decision (a double click, a stale dialog) is a no-op, not a panic.
        resolve_permission(app.state(), id, "allow".to_string());
    }

    // ---------- surviving a dead listener ----------

    /// Driven through `rebind_telemetry` because the wait is part of the answer (tiny_http's
    /// `Drop` never joins its accept thread), and served-then-closed so the reclaimed port is
    /// also sitting in TIME_WAIT.
    #[test]
    fn the_telemetry_port_can_be_reclaimed_after_its_listener_dies() {
        let first = tiny_http::Server::http("127.0.0.1:0").expect("bind telemetry server");
        let port = first.server_addr().to_ip().expect("ip address").port();

        // Answer one request and drop the listener, as the accept-error path leaves things.
        let served = std::thread::spawn(move || {
            let rq = first.recv().expect("one request");
            let _ = rq.respond(tiny_http::Response::from_string(""));
        });
        read_response(
            open_post(port, "/hook", &[("X-CC-Session", "ours")], r#"{"hook_event_name":"Stop"}"#),
            std::time::Duration::from_secs(5),
        );
        served.join().expect("server thread");

        let (again, got) = rebind_telemetry(port);
        assert_eq!(
            got, port,
            "the telemetry port must be reclaimable once its listener dies — serve_telemetry's \
             recovery, and every instrument file already on disk, name this number"
        );
        assert_eq!(again.server_addr().to_ip().expect("ip address").port(), port);
    }

    #[test]
    fn rebind_delay_backs_off_to_a_ceiling() {
        let ladder: Vec<u64> = (0..9).map(|n| rebind_delay(n).as_secs()).collect();
        assert_eq!(ladder, vec![1, 2, 4, 8, 16, 32, 32, 32, 32]);
        assert!(
            ladder.iter().take(REBIND_GIVE_UP as usize).sum::<u64>() >= 60,
            "give up on the original port only after a real wait — a port held by a \
             TIME_WAIT window comes back on its own, and moving ports strands every \
             session already launched"
        );
    }

    // ---------- the CLI contract, against the real `claude` ----------
    // The one #[ignore]d test: `cargo test -- --ignored` needs `claude` on PATH and spends
    // tokens, so it is a RELEASE.md step, never a PR gate. It cannot cover the statusLine
    // (`-p` has no REPL), the sessions registry (interactive only) or PermissionRequest (UI).

    /// Test-local v4 uuid: real ids come from the frontend's `crypto.randomUUID`, so no dependency.
    fn throwaway_uuid() -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mix = nanos ^ ((std::process::id() as u128) << 96)
            ^ ((COUNTER.fetch_add(1, Ordering::SeqCst) as u128) << 64);
        let h = format!("{mix:032x}");
        // Set the version (4) and variant (8) nibbles so it is a well-formed v4.
        format!("{}-{}-4{}-8{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
    }

    #[test]
    #[ignore = "runs the real `claude` binary and spends tokens — `cargo test -- --ignored`"]
    fn claude_cli_still_honours_our_instrumentation() {
        use crate::platform::{augmented_path, resolve_claude};
        use crate::testutil::scratch_dir;
        use tauri::Listener;

        let claude = resolve_claude();
        // A throwaway dir, never a real session's (`--session-id` on an existing conversation
        // appends to its transcript). Canonicalized: Claude records the resolved cwd and derives
        // the project dir from it, and on macOS $TMPDIR is a symlink under /var/folders.
        let cwd = std::fs::canonicalize(scratch_dir()).expect("resolve the scratch dir");
        let sid = throwaway_uuid();

        let (app, port) = mock_telemetry_app();
        let (tx, rx) = std::sync::mpsc::channel();
        app.listen("telemetry", move |e| {
            let _ = tx.send(e.payload().to_string());
        });

        let settings = write_instrument_settings(port, &sid).expect("write the instrument file");

        // Files, not pipes: nothing drains a pipe while the child runs, so a long reply deadlocks.
        let out_path = cwd.join("claude-stdout.txt");
        let err_path = cwd.join("claude-stderr.txt");
        // The prompt demands a Bash call and a Write so the tool-call half of the hook schema
        // is exercised; `--allowedTools` is what lets them run with no UI to answer a prompt.
        let mut child = std::process::Command::new(&claude)
            .arg("-p")
            .arg("Do exactly two things and reply with nothing else: run the shell \
                  command `echo pong` using the Bash tool, then use the Write tool to \
                  create a file named pong.txt containing the word pong.")
            .arg("--allowedTools")
            .arg("Bash,Write")
            .arg("--session-id")
            .arg(&sid)
            .arg("--settings")
            .arg(&settings)
            .current_dir(&cwd)
            .env("PATH", augmented_path()) // a test runner launched from a GUI has a stripped PATH too
            .stdin(std::process::Stdio::null())
            .stdout(std::fs::File::create(&out_path).expect("create stdout capture"))
            .stderr(std::fs::File::create(&err_path).expect("create stderr capture"))
            .spawn()
            .unwrap_or_else(|e| panic!("could not run `claude` at {claude:?}: {e}\n\
                 This test needs Claude Code installed and on PATH."));

        // `wait()` has no timeout, and a hung `claude` must not hang the release checklist.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(240);
        let status = loop {
            match child.try_wait().expect("poll the claude process") {
                Some(st) => break st,
                None if std::time::Instant::now() > deadline => {
                    let _ = child.kill();
                    panic!("`claude -p` did not finish within 240s");
                }
                None => std::thread::sleep(std::time::Duration::from_millis(250)),
            }
        };
        let stdout = std::fs::read_to_string(&out_path).unwrap_or_default();
        let stderr = std::fs::read_to_string(&err_path).unwrap_or_default();
        assert!(
            status.success(),
            "`claude -p` exited {status}.\nstdout:\n{stdout}\nstderr:\n{stderr}"
        );

        // Async hooks can still be in flight at exit; drain until the channel goes quiet.
        let mut events: Vec<serde_json::Value> = Vec::new();
        while let Ok(raw) = rx.recv_timeout(std::time::Duration::from_secs(5)) {
            events.push(serde_json::from_str(&raw).expect("telemetry payload should be json"));
        }

        // --- 1. the mechanism works at all ---
        assert!(
            !events.is_empty(),
            "Claude ran but NOTHING reached our telemetry server. Either the hook \
             schema changed, or the generated command no longer executes.\nstdout:\n{stdout}"
        );

        // --- 2. every event routes to the launch id we chose ---
        for ev in &events {
            assert_eq!(
                ev["data"]["session_id"], sid.as_str(),
                "an event was not tagged with our stable id — routing is broken: {ev}"
            );
        }

        // --- 3. the hook fields the phase state machine branches on still exist ---
        let names: Vec<String> = events
            .iter()
            .filter(|e| e["kind"] == "hook")
            .filter_map(|e| e["data"]["hook_event_name"].as_str().map(str::to_string))
            .collect();
        assert!(
            !names.is_empty(),
            "hook events arrived but none carried `hook_event_name`; applyHook keys \
             the entire phase state machine off that field. Got: {events:#?}"
        );
        for want in ["SessionStart", "UserPromptSubmit", "Stop"] {
            assert!(
                names.iter().any(|n| n == want),
                "no {want} hook arrived — got {names:?}"
            );
        }

        // --- 3b. the tool-call fields, which only a hook from a *tool* carries ---
        // `tool_input.command` is the app's only warning that an agent moved HEAD (`gitMutates`
        // reads it off PostToolUse); nothing else watches the filesystem.
        let tool_hook = events
            .iter()
            .find(|e| e["kind"] == "hook" && e["data"]["hook_event_name"] == "PostToolUse")
            .unwrap_or_else(|| panic!(
                "no PostToolUse hook arrived, though the prompt asked for a Bash call. \
                 Either the hook name changed, or `--allowedTools Bash` no longer \
                 permits one non-interactively. Got: {names:?}"
            ));
        assert_eq!(
            tool_hook["data"]["tool_name"], "Bash",
            "PostToolUse arrived without the tool name the timeline reads: {tool_hook}"
        );
        assert!(
            tool_hook["data"]["tool_input"]["command"]
                .as_str()
                .is_some_and(|c| c.contains("echo")),
            "PostToolUse no longer carries `tool_input.command`; the sidebar's git \
             invalidation reads it to know a checkout may have moved: {tool_hook}"
        );

        // --- 3c. `file_path`, absolute — the only signal that an agent changed checkout ---
        // Claude Code pins `cwd` to the launch dir and undoes any `cd` out of it, so a write's
        // `file_path` is what names a new worktree (`driftTarget`), and only an absolute one can.
        let write_hook = events
            .iter()
            .find(|e| e["kind"] == "hook"
                && e["data"]["hook_event_name"] == "PostToolUse"
                && e["data"]["tool_name"] == "Write")
            .unwrap_or_else(|| panic!(
                "no PostToolUse hook for a Write arrived, though the prompt asked for \
                 one. Got tools: {:?}",
                events.iter().filter_map(|e| e["data"]["tool_name"].as_str()).collect::<Vec<_>>()
            ));
        let fp = write_hook["data"]["tool_input"]["file_path"]
            .as_str()
            .unwrap_or_else(|| panic!(
                "Write's PostToolUse no longer carries `tool_input.file_path`; drift \
                 detection has no other signal that an agent changed checkout: {write_hook}"
            ));
        assert!(
            std::path::Path::new(fp).is_absolute(),
            "Write's `file_path` is no longer absolute ({fp:?}); driftTarget matches it \
             against checkout roots, which only works for an absolute path"
        );

        // `cwd` is how a hook is correlated with the pane's workdir.
        let hook = events.iter().find(|e| e["kind"] == "hook").expect("a hook event");
        assert!(
            hook["data"]["cwd"].as_str().is_some_and(|c| !c.is_empty()),
            "hooks no longer carry `cwd`: {hook}"
        );

        // --- 4. the transcript layout the usage ledger reads ---
        // Parsed raw rather than through `parse_usage_line`: the point is the EXTERNAL format.
        let enc: String = cwd
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let transcript = std::path::Path::new(&crate::platform::home_dir())
            .join(".claude")
            .join("projects")
            .join(&enc)
            .join(format!("{sid}.jsonl"));
        assert!(
            transcript.is_file(),
            "no transcript at {transcript:?} — the cwd->dir encoding or the naming \
             scheme changed, which breaks resume labels and the cost ledger"
        );
        let text = std::fs::read_to_string(&transcript).expect("read the transcript");
        let mut saw_usage = false;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue, // a record we don't read; not our contract
            };
            // Only the records the ledger buckets are our contract: Claude also writes
            // bookkeeping rows with no timestamp (`last-prompt`, `ai-title`), which
            // `parse_usage_line` filters out on "usage" before it looks for one.
            let Some(usage) = v.get("message").and_then(|m| m.get("usage")) else { continue };
            saw_usage = true;
            assert!(
                v.get("timestamp").and_then(|t| t.as_str()).is_some_and(|t| t.len() >= 10),
                "a usage record lost its ISO `timestamp`; the daily rollup keys every \
                 total off `timestamp[..10]`, and drops a record without one: {line}"
            );
            for field in ["input_tokens", "output_tokens"] {
                assert!(
                    usage.get(field).and_then(|x| x.as_u64()).is_some(),
                    "message.usage.{field} is gone — the token ledger reads it by name: {line}"
                );
            }
            assert!(
                v["message"]["model"].as_str().is_some_and(|m| !m.is_empty()),
                "message.model is gone — the per-model split falls back to `other`: {line}"
            );
            assert!(
                v.get("cwd").and_then(|x| x.as_str()).is_some(),
                "a transcript record lost `cwd` — the per-project spend split reads it: {line}"
            );
        }
        assert!(
            saw_usage,
            "the transcript has no `message.usage` record at all, so the cost ledger \
             would silently total zero"
        );

        let _ = std::fs::remove_file(&settings);
        let _ = std::fs::remove_dir_all(&cwd);
        // The transcript stays: deleting inside ~/.claude/projects is not this test's job.
    }
}
