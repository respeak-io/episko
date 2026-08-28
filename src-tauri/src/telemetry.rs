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

/// How long to wait before the *n*th attempt to re-bind the telemetry port.
///
/// Doubles from a second and caps at thirty. The cap matters more than the ladder:
/// the common cause of a failed re-bind is a TIME_WAIT window measured in tens of
/// seconds, so retrying forever at a bounded interval gets the port back on its own,
/// while a ladder with no ceiling would still be sleeping ten minutes later.
fn rebind_delay(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs(1u64 << attempt.min(5))
}

/// Attempts (≈ a minute at the ladder above) on the *original* port before giving up
/// on it and taking a fresh ephemeral one. Staying put is strongly preferred: every
/// instrument file already on disk names the old port, so re-binding it revives every
/// running pane at once, whereas a new port only helps sessions launched after it.
const REBIND_GIVE_UP: u32 = 8;

/// Get a listener back, and say which port it landed on.
///
/// **Sleeps before the first attempt, and that is not politeness.** `tiny_http`'s
/// `Drop` sets its close flag and pokes the accept thread awake, but never joins it —
/// so the old `TcpListener` is still bound for a short unbounded moment after the
/// `Server` is gone, and an immediate re-bind fails with `EADDRINUSE`. `SO_REUSEADDR`
/// (which `std`'s `TcpListener::bind` sets for us on unix) covers a socket in
/// TIME_WAIT; it does nothing about one that is still *listening*. A second is nothing
/// against a ~10s statusLine cadence, so the wait is free.
fn rebind_telemetry(port: u16) -> (tiny_http::Server, u16) {
    let mut attempt = 0u32;
    loop {
        std::thread::sleep(rebind_delay(attempt));
        // Past the give-up point, ask for an ephemeral port instead: the original is
        // held by something else and is not coming back.
        let want = if attempt >= REBIND_GIVE_UP { 0 } else { port };
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

/// Keep a telemetry server listening for the life of the app.
///
/// `run_telemetry_server` returns whenever its listener dies, and **one transient
/// error is enough**: `tiny_http`'s accept thread `break`s out of its loop on any
/// `accept()` error, pushes the error into the queue, and `IncomingRequests::next()`
/// is `self.server.recv().ok()` — so the `Err` becomes a `None` that ends the `for`
/// loop, drops the `Server`, and closes the socket. Nothing retries and nothing
/// complains.
///
/// That is not hypothetical. A single `ECONNABORTED` ("Software caused connection
/// abort", errno 53) took the server down after six days of uptime and it never came
/// back: `AppState.port` still held the dead number, so every session launched over
/// the following fourteen hours got an instrument file pointing at a closed socket and
/// sat at `idle` with no model, no context, no files and no tools. The whole path is
/// silent by design — the hooks are `"async": true` and both hooks and statusLine use
/// `curl -s` — so a refused connection produces no output anywhere, on either side.
///
/// So: re-bind, and re-bind **the same port**, because that is what makes the outage
/// transient rather than terminal. The instrument files are written at launch and
/// never revisited, so a pane that was deaf during the gap starts reporting again on
/// its next statusLine (~10s) without being relaunched. Only after `REBIND_GIVE_UP`
/// failures do we take a new port and publish it, so that at least new launches work.
///
/// Both transitions are announced to the frontend as `telemetry-health`, because the
/// original failure's real cost was that nothing on screen said anything was wrong.
pub(crate) fn serve_telemetry<R: Runtime>(server: tiny_http::Server, app: AppHandle<R>) {
    let mut server = server;
    loop {
        // Returns only when the listener is gone.
        run_telemetry_server(server, app.clone());

        let port = app.state::<AppState>().port.load(std::sync::atomic::Ordering::Relaxed);
        log::error!("telemetry: listener on 127.0.0.1:{port} died; re-binding");
        let _ = app.emit("telemetry-health", serde_json::json!({ "up": false, "port": port }));

        let (next, now) = rebind_telemetry(port);
        server = next;
        if now != port {
            // Everything already launched is permanently deaf at this point; say so
            // rather than letting the recovery read as a clean one.
            log::error!("telemetry: could not reclaim {port}, now on {now} — sessions launched before this stay silent until relaunched");
            app.state::<AppState>().port.store(now, std::sync::atomic::Ordering::Relaxed);
        } else {
            log::info!("telemetry: listener back on 127.0.0.1:{now}");
        }
        let _ = app.emit("telemetry-health", serde_json::json!({ "up": true, "port": now, "moved": now != port }));
    }
}

/// Receive hook + statusLine POSTs from Claude Code and forward each to the
/// frontend as a `telemetry` event. Every request carries Episko's stable launch
/// id (`X-CC-Session` header, or `?sid=` for the permission hook); we force it onto
/// the payload as `session_id` so the frontend routes by it — immune to Claude
/// rotating its own runtime session_id on /clear, /compact or /resume.
///
/// **Returns when the listener dies**, which is a thing that happens — see
/// `serve_telemetry`, which is what production runs and what puts it back.
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
/// **The hooks run no shell at all; the statusLine has to.** A command hook takes
/// an *exec form* — `command` plus an `args` array, each element passed as one
/// argument with no quoting and no shell in between — so the hooks name `curl`
/// directly. That is what removes the per-hook shell process: on Windows the
/// previous shell form was pinned to `"shell": "powershell"`, which meant a whole
/// PowerShell launch (~220 ms, and a second process) for every PreToolUse,
/// PostToolUse, Stop and Notification of every session, just to reach curl. It
/// also retires the entire quoting hazard, since nothing re-parses these strings.
///
/// The statusLine gets no such escape: Claude Code defines no `args` and no
/// `shell` for it, and routes it through Git Bash whenever Git Bash is installed
/// (else PowerShell). So that one command must still parse in *either* shell: no
/// `&` call operator, no `$null` (Git Bash would expand it away and leave a bare
/// `1>`), no `Write-Output`, and forward slashes, since Git Bash eats lone
/// backslashes as escapes. `echo` and single-quoted arguments mean the same thing
/// in both. Getting this wrong costs no hook and no error — just every figure the
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
    let (statusline_cmd, curl, null_dev): (String, &str, &str) = {
        // Shell-agnostic (see above): the statusLine can't say which shell it wants,
        // so it says nothing either shell would choke on. `-o NUL` replaces the
        // PowerShell-only `1>$null 2>$null`; `echo` replaces `Write-Output`.
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

    // Exec form: `args` elements reach curl verbatim, so there is no shell to pick
    // and nothing to quote. Built once and cloned per event.
    //
    // No `|| true` counterpart is needed for the shell form this replaces. These are
    // `async`, so Claude does not wait on them, and the only exit code that means
    // anything to a hook is 2 (block the tool) — which curl uses for "failed to
    // initialize" and never for a refused connection (7) or a timeout (28). A
    // telemetry POST that misses therefore stays what it was: invisible.
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
    //
    // `refreshInterval` is the *idle* cadence only — an active session's statusLine is
    // already re-run event-driven (new assistant message, /compact, a mode change) —
    // and it is baked into the settings file at launch, so it ticks for every running
    // session forever, on or off screen. On Windows each tick is a Git Bash + curl +
    // console (no `shell` field to pin it), which at 3s measured ~6 process spawns a
    // second on a 3-session fleet. Nothing read off the statusLine (model, context %,
    // cost, duration, rate limits) moves faster than minutes while a session is idle,
    // so 10s keeps the figures and the frontend's un-end backstop alive at a third of
    // the cost. Don't drop it entirely: idle sessions have no events to ride.
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
            // Exec form: `command` is the executable ITSELF, never shell command text,
            // and every argument is its own `args` element. That is what means no shell
            // is spawned per hook — the thing this shape exists for — so an equality
            // check here, not a `contains`: command text that happens to start with the
            // curl path would run through a shell again and still pass a substring test.
            assert_eq!(leaf["command"], curl, "{ev} must name the curl binary itself");
            let args: Vec<&str> = leaf["args"].as_array()
                .unwrap_or_else(|| panic!("{ev} must use exec form (an args array)"))
                .iter().map(|a| a.as_str().unwrap_or_else(|| panic!("{ev} arg is not a string"))).collect();
            assert!(args.contains(&format!("X-CC-Session: {sid}").as_str()),
                "{ev} must tag the POST with our stable id: {args:?}");
            assert!(args.contains(&"http://127.0.0.1:45678/hook"), "{ev} must POST to our port: {args:?}");
            assert!(args.contains(&"@-"), "{ev} must forward Claude's stdin payload: {args:?}");
            // Nothing may re-parse these, so nothing may need quoting. A stray quote
            // would reach curl as part of the value rather than being stripped.
            for a in &args {
                assert!(!a.contains('\'') && !a.contains('"'), "{ev} arg {a:?} is quoted — exec form takes it literally");
            }
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
        // …and now neither does a hook. `shell` only applies to the shell form; with
        // `args` set Claude Code ignores it, so carrying one would read as a pinned
        // shell while no shell runs at all — the same lie the statusLine one was.
        assert!(hooks["Stop"][0]["hooks"][0].get("shell").is_none(),
            "an exec-form hook has no shell to pin");
        assert!(perm.get("shell").is_none(), "an http hook has no shell to set");

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
            port: std::sync::atomic::AtomicU16::new(port),
            sessions: Mutex::new(HashMap::new()),
            agent_runtimes: Mutex::new(HashMap::new()),
            owned_pids: Mutex::new(HashSet::new()),
            io_samples: Mutex::new(HashMap::new()),
            io_retired: Mutex::new((0, 0)),
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

    /// The hook's **exec form**, actually executed — `command` spawned directly with
    /// its `args`, exactly as Claude Code runs it, with no shell anywhere.
    ///
    /// The sibling statusLine test exists because a shell might not parse our string.
    /// This one exists for the opposite hazard, and it is the one the exec form
    /// introduces: with no shell, nothing strips quotes and nothing splits words. An
    /// argument written the way it would be written *for* a shell — `'X-CC-Session:
    /// …'`, or a whole `-H foo` in one element — reaches curl with the quotes still
    /// on it or as a single unparsable argument. curl then fails, `-s` keeps it quiet,
    /// `async` means Claude never waits, and the pane loses every phase it has while
    /// looking perfectly healthy. Reading the JSON back cannot catch that: the strings
    /// are exactly what we meant to write. Only curl's own argv parsing is
    /// authoritative, so this runs it. No Claude and no tokens — it's just curl.
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

        // A PostToolUse body, trimmed to what `applyHook` and `noteGitCommand` read.
        // `session_id` differs from ours deliberately: the header is what routes it.
        let payload = concat!(
            r#"{"session_id":"claude-rotated","hook_event_name":"PostToolUse","#,
            r#""cwd":"/tmp/x","tool_name":"Bash","tool_input":{"command":"git checkout -b feat"}}"#
        );

        // Spawned with no shell in between — the argv Claude Code itself would build.
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
        // `-o <null device>` is per-platform and easy to get backwards; a wrong one
        // leaves the response body on stdout instead of discarding it.
        assert!(out.stdout.is_empty(), "the hook must print nothing: {:?}", String::from_utf8_lossy(&out.stdout));

        let raw = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the hook ran but nothing reached the telemetry server");
        let ev: serde_json::Value = serde_json::from_str(&raw).expect("event payload should be json");
        assert_eq!(ev["kind"], "hook");
        assert_eq!(ev["data"]["session_id"], sid.as_str(), "the -H arg must route it to our launch id");
        assert_eq!(ev["data"]["claude_session_id"], "claude-rotated", "the resume target must survive");
        // A quote that survived into the value, or a body mangled in transit, lands
        // here as a parse failure rather than as these fields.
        assert_eq!(ev["data"]["hook_event_name"], "PostToolUse");
        assert_eq!(ev["data"]["tool_input"]["command"], "git checkout -b feat");

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

    // ---------- surviving a dead listener ----------

    /// The premise of the whole recovery: after a listener dies we get **the same port**
    /// back, which is what revives every already-launched pane rather than only the ones
    /// started afterwards. Every instrument file on disk names that number and none of
    /// them is ever rewritten, so if this stops holding the fix is worth nothing.
    ///
    /// Driven through `rebind_telemetry` rather than a bare `Server::http`, because the
    /// wait is part of the answer: `tiny_http`'s `Drop` never joins its accept thread,
    /// so for a moment after the `Server` is gone the old listener is still bound and an
    /// immediate re-bind fails with `EADDRINUSE` — which is exactly what this test did
    /// before it was pointed at the real path.
    ///
    /// Served-then-closed, not merely bound: the request leaves a socket whose *local*
    /// end is the port being reclaimed, which is the TIME_WAIT case on top of the racing
    /// listener.
    #[test]
    fn the_telemetry_port_can_be_reclaimed_after_its_listener_dies() {
        let first = tiny_http::Server::http("127.0.0.1:0").expect("bind telemetry server");
        let port = first.server_addr().to_ip().expect("ip address").port();

        // Answer one request and drop the listener, exactly as the accept-error path
        // leaves things.
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

    /// The ladder backs off and then stops growing. The ceiling is the load-bearing
    /// half: the usual reason a re-bind fails is a TIME_WAIT window of tens of seconds,
    /// so an uncapped doubling would still be asleep long after the port came free.
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
        // The prompt asks for a *tool call*, not just a reply, and that is deliberate:
        // assertion 5 below checks `tool_input.command`, which only exists on a
        // PostToolUse hook. The old prompt ("reply with pong") used no tools at all, so
        // the whole tool-call half of the hook schema went unexercised — including the
        // field the sidebar's git invalidation now reads. `--allowedTools Bash` is what
        // lets it run without a UI to answer the permission prompt.
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

        // --- 3b. the tool-call fields, which only a hook from a *tool* carries ---
        // `tool_name` drives the activity timeline and the risk label; `tool_input`
        // carries the argument each surface shows. `tool_input.command` in particular
        // is the app's only warning that an agent moved HEAD or added a worktree —
        // `gitMutates` reads it off PostToolUse, and nothing else watches the
        // filesystem, so if this field goes away the sidebar silently stops noticing
        // a branch switch rather than failing. It is asserted here, against the real
        // binary, because no local test can see Claude Code changing its own schema.
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
        // Claude Code pins a session's `cwd` to its launch directory and actively undoes
        // any `cd` that leaves it ("Shell cwd was reset to …"), verified against 2.1.220.
        // So when an agent creates a worktree and moves into it, `cwd` never changes and
        // the sidebar would go on naming the checkout it left. What *does* name the new
        // one is a write's `file_path` — which is why `driftTarget` reads it, and why it
        // has to be absolute: a path relative to a cwd that never moved would resolve
        // back into the old checkout and the drift would be invisible.
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
