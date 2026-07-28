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
/// present since Win10 1803). curl reads Claude's payload straight from the
/// shell's *inherited* stdin (`--data-binary @-`); we deliberately do NOT
/// round-trip it through a PowerShell string (`$x=[Console]::In.ReadToEnd(); $x |
/// curl`), because PowerShell prepends a UTF-8 BOM when piping a string to a
/// native process, which `serde_json` then refuses to parse — silently dropping
/// every payload. (Verified empirically.)
///
/// **Windows runs the two halves in different shells, and only one of them can be
/// told which.** `shell` is a *hook* field; Claude Code has no such field for the
/// statusLine and routes it through Git Bash whenever Git Bash is installed (else
/// PowerShell). So the hooks are pinned to `powershell` and written in it, while
/// the statusLine command must parse in *either* shell: no `&` call operator, no
/// `$null` (Git Bash would expand it away and leave a bare `1>`), no
/// `Write-Output`, and forward slashes, since Git Bash eats lone backslashes as
/// escapes. `echo` and single-quoted arguments mean the same thing in both.
/// Getting this wrong costs no hook and no error — just every figure the
/// statusLine carries (model, context %, cost, duration, rate limits), silently.
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
        // Shell-agnostic (see above): the statusLine can't say which shell it wants,
        // so it says nothing either shell would choke on. `-o NUL` replaces the
        // PowerShell-only `1>$null 2>$null`; `echo` replaces `Write-Output`.
        let statusline = format!(
            "C:/Windows/System32/curl.exe -s -o NUL --max-time 1 -X POST 'http://127.0.0.1:{port}/statusline' -H 'X-CC-Session: {session_id}' --data-binary '@-'; echo cc-launcher"
        );
        // Hooks *are* pinned to PowerShell below, so this half stays PowerShell.
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

    // No `shell` here: Claude Code doesn't define one for the statusLine, so setting
    // it would be silently ignored while reading as though the shell were pinned.
    let statusline = serde_json::json!({ "type": "command", "command": statusline_cmd, "refreshInterval": 3, "padding": 0 });

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

        // The statusLine spells its curl with forward slashes on Windows — Git Bash,
        // which may be the shell that runs it, would eat the backslashes as escapes.
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

        // `shell` is a *hook* field, and only a hook may carry it. Claude Code defines
        // none for the statusLine — on Windows it runs that command through Git Bash
        // whenever Git Bash is installed — so setting one there is worse than useless:
        // it is ignored, while reading as though the shell were pinned. It isn't; the
        // command parses in either shell, which `statusline_command_posts_from_every_
        // shell_claude_might_pick` proves by running the string this file generates.
        assert!(statusline.get("shell").is_none(), "the statusLine has no shell field to set: {statusline}");
        #[cfg(windows)]
        {
            // Claude Code's default hook shell on Windows is Git Bash, so the
            // PowerShell hook commands must say so.
            assert_eq!(hooks["Stop"][0]["hooks"][0]["shell"], "powershell");
            assert!(perm.get("shell").is_none(), "an http hook has no shell to set");
        }
        #[cfg(not(windows))]
        {
            // Off Windows the field must be absent, not empty.
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

    /// The bash Claude Code would actually use on Windows: *Git* Bash, not whatever
    /// `bash` happens to come first on PATH. On a machine with WSL that is
    /// `C:\Windows\System32\bash.exe` — a Linux shell, where `C:/Windows/...` genuinely
    /// doesn't exist and a passing or failing result would say nothing about the
    /// product. Claude Code reads `CLAUDE_CODE_GIT_BASH_PATH` for the same reason, so
    /// honour it first, then the default install locations, then git's own directory.
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
        // `git --exec-path` lands somewhere under the install root (…/Git/mingw64/
        // libexec/git-core), so walk back up looking for the one with bin/bash.exe.
        if let Ok(out) = std::process::Command::new("git").arg("--exec-path").output() {
            let p = std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
            roots.extend(p.ancestors().map(|a| a.to_path_buf()));
        }
        roots.into_iter().map(|r| r.join("bin").join("bash.exe")).find(|p| p.is_file())
    }

    /// The statusLine's command string, actually **executed**. Everything the cockpit
    /// shows that isn't a phase — model, context %, cost, duration and the account-wide
    /// rate limits — arrives on this one path and nowhere else, so a command the shell
    /// won't parse takes all of them out at once while the hooks keep the pane looking
    /// perfectly healthy. That is not hypothetical: Windows shipped exactly that. The
    /// statusLine was written in PowerShell and marked `"shell": "powershell"`, but
    /// `shell` is a hook field with no statusLine counterpart, so Claude handed the
    /// string to Git Bash, which failed on the leading `&` and posted nothing.
    ///
    /// Reading the generated JSON cannot catch this — such a test agrees with our
    /// intent, and our intent was the bug (the old one asserted that very `"shell"`
    /// key, and stayed green throughout). Only the shell's own parser is authoritative,
    /// so run the real string through every shell Claude might pick and require the
    /// payload out the far end. No Claude and no tokens: the command is just curl.
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

        // Claude's own payload shape, trimmed to the fields `applyStatusline` reads.
        // `session_id` differs from ours on purpose: a statusLine fires after /clear
        // too, and the header is what routes it back to the pane.
        let payload = concat!(
            r#"{"session_id":"claude-rotated","model":{"display_name":"Opus"},"#,
            r#""context_window":{"used_percentage":37},"cost":{"total_cost_usd":1.25},"#,
            r#""rate_limits":{"five_hour":{"used_percentage":42}}}"#
        );

        // On Windows Claude picks Git Bash when it's installed and PowerShell when it
        // isn't, and never tells us which — so both have to work.
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
                // Claude only picks a shell that exists, and so does this test. A box
                // without Git Bash is one where Claude would use PowerShell anyway.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    eprintln!("skipping {bin}: not installed");
                    continue;
                }
                Err(e) => panic!("could not spawn {bin}: {e}"),
            };
            // Dropping the handle at the end of the statement closes the pipe, which is
            // the EOF `--data-binary @-` waits for.
            let mut sin = child.stdin.take().expect("child stdin");
            sin.write_all(payload.as_bytes()).expect("pipe the payload in");
            drop(sin);
            let out = child.wait_with_output().expect("wait for the statusLine command");
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            // The trailing `; echo` makes the exit status echo's, so it stays 0 even
            // when curl never ran — stderr is the honest channel here. A shell that
            // can't parse the command, or can't find curl, says so there and nowhere
            // else, because `-s` means curl itself is silent either way.
            assert!(
                out.status.success() && err.is_empty(),
                "{bin} could not run the statusLine command ({}):\n  {cmd}\n  {err}",
                out.status
            );
            // Whatever it prints is what Claude renders in the status bar.
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
            // A body mangled in transit — a PowerShell BOM, a lost pipe, a shell that
            // ate a quote — lands here as a parse failure rather than these figures.
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

    // ---------- the CLI contract, against the real `claude` ----------
    //
    // The only test here that runs the external binary, and the only one that is
    // #[ignore]d. Everything above proves *our* two ends agree with each other; this
    // proves they still agree with **Claude Code**, which ships weekly and whose hook
    // schema and transcript layout CLAUDE.md itself calls unstable.
    //
    // That gap is the reason it exists. If a release renames `hook_event_name`, or
    // stops passing `cwd`, or moves `message.usage`, everything here still compiles,
    // every other test stays green, and the app simply goes quiet — a pane with no
    // phase, a cost meter stuck at zero. Nothing else in this repo can see that.
    //
    //   cargo test -- --ignored --nocapture
    //
    // Never a PR gate: it needs `claude` on PATH, an authenticated account, and it
    // **spends tokens**. It belongs to the release checklist (see RELEASE.md).
    //
    // What it CANNOT cover, and why the coverage is not a lie by omission:
    //
    // - **The statusLine half.** `claude -p` is non-interactive and statusLine only
    //   fires from a live REPL, so model / context % / cost / duration and every
    //   rate-limit field are out of reach here. That is exactly the half that has
    //   been observed missing on Windows, so this test passing says nothing about it.
    // - **`~/.claude/sessions/<pid>.json`.** That registry holds one entry per running
    //   *interactive* session; a `-p` run is not one. External-session discovery
    //   stays a click-through check.
    // - **PermissionRequest.** Answering it needs a UI; `-p` would either
    //   auto-approve or hang. The blocking behaviour is covered against our own
    //   server above, which is the part we own.

    /// A v4-shaped uuid for the throwaway session. Episko's real ids come from the
    /// frontend's `crypto.randomUUID`, so the backend has never needed to mint one
    /// and this stays test-local rather than becoming a dependency.
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
        // A throwaway directory, and emphatically NOT a real session's: `--session-id`
        // on an existing conversation appends to its transcript.
        //
        // Canonicalized, because on macOS `$TMPDIR` is under `/var/folders`, itself a
        // symlink to `/private/var/folders`. Claude records the *resolved* cwd and
        // derives the project dir from that, so encoding the symlinked spelling looks
        // for a directory that will never exist. Resolving it here keeps assertion 4 a
        // check of Claude's encoding rather than of macOS's symlinks — and matches what
        // the app passes, since a workdir comes from a real folder the user picked.
        let cwd = std::fs::canonicalize(scratch_dir()).expect("resolve the scratch dir");
        let sid = throwaway_uuid();

        let (app, port) = mock_telemetry_app();
        let (tx, rx) = std::sync::mpsc::channel();
        app.listen("telemetry", move |e| {
            let _ = tx.send(e.payload().to_string());
        });

        let settings = write_instrument_settings(port, &sid).expect("write the instrument file");

        // stdout/stderr go to files rather than pipes: nothing reads a pipe while the
        // child runs, so a chatty response could fill the buffer and deadlock.
        let out_path = cwd.join("claude-stdout.txt");
        let err_path = cwd.join("claude-stderr.txt");
        let mut child = std::process::Command::new(&claude)
            .arg("-p")
            .arg("Reply with exactly the word pong and nothing else.")
            .arg("--session-id")
            .arg(&sid)
            .arg("--settings")
            .arg(&settings)
            .current_dir(&cwd)
            // A GUI-spawned app gets a stripped PATH, and so does a cargo test runner
            // launched from one — the same reason the app rebuilds it before spawning.
            .env("PATH", augmented_path())
            .stdin(std::process::Stdio::null())
            .stdout(std::fs::File::create(&out_path).expect("create stdout capture"))
            .stderr(std::fs::File::create(&err_path).expect("create stderr capture"))
            .spawn()
            .unwrap_or_else(|e| panic!("could not run `claude` at {claude:?}: {e}\n\
                 This test needs Claude Code installed and on PATH."));

        // std has no timeout on wait(), and a hung `claude` would otherwise hang a
        // release checklist indefinitely.
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

        // Hooks are fire-and-forget (`async: true`), so the last few can still be in
        // flight when the process exits. Drain until the channel goes quiet.
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

        // `cwd` is how a hook is correlated with the pane's workdir.
        let hook = events.iter().find(|e| e["kind"] == "hook").expect("a hook event");
        assert!(
            hook["data"]["cwd"].as_str().is_some_and(|c| !c.is_empty()),
            "hooks no longer carry `cwd`: {hook}"
        );

        // --- 4. the transcript layout the usage ledger reads ---
        // Deliberately parsed raw rather than through parse_usage_line: the point is
        // to check the EXTERNAL format, not our reader's agreement with itself.
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
            // Only the records the ledger actually buckets are our contract. Claude
            // also writes bookkeeping rows with no timestamp at all (`last-prompt`,
            // `ai-title` — which `list_past_sessions` reads for labels, never for a
            // day), and `parse_usage_line` filters on `"usage"` before it looks for
            // one, so asserting a timestamp on every line tests Claude's file, not ours.
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
        // The transcript is deliberately left on disk: it is under a throwaway temp
        // path in ~/.claude/projects, and deleting things there is not this test's job.
    }
}
