//! Episko's own agent protocol (docs/agent-protocol.md). The launch half writes a bundled
//! extension into a per-launch folder and tells the agent where to report; the route half
//! checks what comes back and forwards it as `agent-event`. Vendor translation lives in the
//! extension, so nothing here knows a vendor's event names.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::agent::ProviderStart;
use crate::telemetry::{header_value, query_param};
use crate::AppState;

/// An extension batches; it never needs a transcript's worth of bytes in one POST.
const MAX_BODY: u64 = 1 << 20;
const MAX_EVENTS: usize = 500;
/// The `method` the frontend's protocol adapter is registered under.
pub(crate) const METHOD: &str = "protocol/v1";

/// The extensions Episko ships, vendored from episko-integrations (`src-tauri/integrations/`).
const EXTENSIONS: &[(&str, &str)] = &[
    ("omp", include_str!("../integrations/omp.ts")),
    ("opencode", include_str!("../integrations/opencode.ts")),
];

/// Who a launch token belongs to. Held from before the spawn, so the agent's first POST
/// routes even if it lands before `spawn_agent` has filed the `Session`.
pub(crate) struct AgentToken {
    token: String,
    provider: String,
}

#[derive(Deserialize)]
struct ManifestEntry {
    protocol: Option<Spec>,
}

/// The `protocol` block of a manifest entry: data only, so a new agent is a manifest row
/// and an extension rather than a branch here.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    extension: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    permission_modes: Vec<Mode>,
}

#[derive(Deserialize)]
struct Mode {
    id: String,
    #[serde(default)]
    args: Vec<String>,
}

fn spec(provider: &str) -> Option<Spec> {
    let mut all: HashMap<String, ManifestEntry> =
        serde_json::from_str(include_str!("../../src/providers/manifest.json")).ok()?;
    all.remove(provider)?.protocol
}

/// Pasted into a folder name: uuid characters only, so `..` can never leave `cc-launcher`.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn launch_dir(session_id: &str) -> PathBuf {
    std::env::temp_dir().join("cc-launcher").join(format!("ext-{session_id}"))
}

/// The manifest is ours, but a path that climbs out of the launch folder is refused anyway.
fn inside(rel: &str) -> bool {
    let p = Path::new(rel);
    !rel.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

/// The id is looked up, never passed through: an unknown one falls back to the agent's config.
fn mode_args(provider: &str, modes: &[Mode], mode: Option<&str>) -> Vec<String> {
    match mode.map(str::trim) {
        None | Some("") => Vec::new(),
        Some(id) => match modes.iter().find(|m| m.id == id) {
            Some(m) => m.args.clone(),
            None => {
                log::warn!("ignoring unknown {provider} permission mode {id:?} — using its config");
                Vec::new()
            }
        },
    }
}

/// Writes the extension and returns how to load it, or `None` for an agent that does not
/// speak the protocol. The token goes in the agent's environment, never its argv.
pub(crate) fn prepare(
    state: &AppState,
    provider: &str,
    port: u16,
    session_id: &str,
    mode: Option<&str>,
) -> Result<Option<ProviderStart>, String> {
    let Some(spec) = spec(provider) else {
        return Ok(None);
    };
    let source = EXTENSIONS
        .iter()
        .find(|(id, _)| *id == provider)
        .map(|(_, s)| *s)
        .ok_or_else(|| format!("no extension is bundled for {provider}"))?;
    if !valid_id(session_id) {
        return Err(format!("not a valid session id: {session_id}"));
    }
    if !inside(&spec.extension) {
        return Err(format!("{provider}'s extension path leaves its folder"));
    }
    let dir = launch_dir(session_id);
    let file = dir.join(&spec.extension);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create extension folder: {e}"))?;
    }
    std::fs::write(&file, source).map_err(|e| format!("write {provider} extension: {e}"))?;

    let token = crate::mcp::token()?;
    state.agent_tokens.lock().unwrap().insert(
        session_id.to_string(),
        AgentToken {
            token: token.clone(),
            provider: provider.to_string(),
        },
    );

    let dir_s = dir.to_string_lossy().to_string();
    let file_s = file.to_string_lossy().to_string();
    let fill = |s: &str| s.replace("{dir}", &dir_s).replace("{file}", &file_s);
    let mut args = mode_args(provider, &spec.permission_modes, mode);
    args.extend(spec.args.iter().map(|a| fill(a)));
    let mut env = vec![
        ("EPISKO_URL".to_string(), format!("http://127.0.0.1:{port}/agent?sid={session_id}")),
        ("EPISKO_TOKEN".to_string(), token),
    ];
    env.extend(spec.env.iter().map(|(k, v)| (k.clone(), fill(v))));
    log::info!("agent protocol · {provider} · {session_id} · extension at {file_s}");
    Ok(Some(ProviderStart { args, env }))
}

/// The pane is gone: its token stops working and its extension folder goes. Called again by
/// the reaper, since a Windows kill can still hold the file the first time.
pub(crate) fn forget_session(state: &AppState, session_id: &str) {
    state.agent_tokens.lock().unwrap().remove(session_id);
    if valid_id(session_id) {
        let _ = std::fs::remove_dir_all(launch_dir(session_id));
    }
}

/// Length is not secret; content is. A token compared byte by byte leaks its prefix.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn respond(request: tiny_http::Request, status: u16, error: &str) {
    let mut res = tiny_http::Response::from_string(if error.is_empty() {
        String::new()
    } else {
        json!({ "error": error }).to_string()
    })
    .with_status_code(status);
    if !error.is_empty() {
        res = res.with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
        );
    }
    let _ = request.respond(res);
}

/// The envelope is checked here and every event in the frontend's adapter; a version this
/// build does not speak is refused whole rather than half-read.
fn envelope(mut value: Value) -> Result<Value, &'static str> {
    if value.get("v").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported protocol version: this Episko speaks v1");
    }
    match value.get_mut("events").map(Value::take) {
        Some(Value::Array(events)) if !events.is_empty() && events.len() <= MAX_EVENTS => {
            Ok(Value::Array(events))
        }
        _ => Err("events must be an array of 1 to 500 events"),
    }
}

/// `POST /agent?sid=<pane>` with `Authorization: Bearer <token>`. Never logs a body: it
/// carries prompts. Answers 204, or an error the extension author can read.
pub(crate) fn handle<R: Runtime>(mut request: tiny_http::Request, url: &str, app: &AppHandle<R>) {
    let sid = query_param(url, "sid").unwrap_or_default();
    let presented = header_value(&request, "Authorization")
        .and_then(|v| v.strip_prefix("Bearer ").map(str::to_string))
        .unwrap_or_default();
    let provider = {
        let state = app.state::<AppState>();
        let tokens = state.agent_tokens.lock().unwrap();
        tokens
            .get(&sid)
            .filter(|t| same(&t.token, &presented))
            .map(|t| t.provider.clone())
    };
    let Some(provider) = provider else {
        // Also every POST still in flight when a pane closes, so not a warning.
        log::debug!("agent protocol: 401 for sid {}", sid.get(..8).unwrap_or(&sid));
        return respond(request, 401, "unknown session or token");
    };
    let mut body = String::new();
    if request.as_reader().take(MAX_BODY + 1).read_to_string(&mut body).is_err() {
        return respond(request, 400, "body is not UTF-8");
    }
    if body.len() as u64 > MAX_BODY {
        log::warn!("agent protocol: {provider} sent more than {MAX_BODY} bytes in one POST");
        return respond(request, 413, "body over 1 MiB: send fewer events per POST");
    }
    let events = serde_json::from_str::<Value>(&body)
        .map_err(|_| "body is not JSON")
        .and_then(envelope);
    let events = match events {
        Ok(events) => events,
        Err(why) => {
            log::warn!("agent protocol: {provider} POST refused: {why}");
            return respond(request, 400, why);
        }
    };
    let _ = app.emit(
        "agent-event",
        json!({
            "sessionId": sid,
            "provider": provider,
            "method": METHOD,
            "params": { "events": events },
            "requestId": Value::Null,
        }),
    );
    respond(request, 204, "");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_protocol_provider_has_a_bundled_extension_and_a_safe_path() {
        let all: HashMap<String, ManifestEntry> =
            serde_json::from_str(include_str!("../../src/providers/manifest.json")).unwrap();
        let speaking: Vec<_> = all.iter().filter_map(|(id, e)| e.protocol.as_ref().map(|s| (id, s))).collect();
        assert!(!speaking.is_empty(), "no manifest entry speaks the protocol");
        for (id, spec) in speaking {
            assert!(EXTENSIONS.iter().any(|(e, _)| e == id), "{id} has no bundled extension");
            assert!(inside(&spec.extension), "{id}'s extension path climbs out");
            assert!(
                spec.args.iter().any(|a| a.contains("{file}") || a.contains("{dir}"))
                    || spec.env.values().any(|v| v.contains("{file}") || v.contains("{dir}")),
                "{id} never tells the agent where its extension is"
            );
        }
        for (id, _) in EXTENSIONS {
            assert!(spec(id).is_some(), "{id} is bundled but the manifest does not launch it");
        }
    }

    #[test]
    fn a_path_that_climbs_out_is_refused() {
        assert!(inside("episko.ts"));
        assert!(inside("plugins/episko.ts"));
        for bad in ["", "../x.ts", "plugins/../../x.ts", "/etc/x.ts", "./x.ts"] {
            assert!(!inside(bad), "{bad:?} should be refused");
        }
    }

    #[test]
    fn permission_modes_are_looked_up_never_passed_through() {
        let modes = vec![Mode {
            id: "write".into(),
            args: vec!["--approval-mode".into(), "write".into()],
        }];
        assert_eq!(mode_args("x", &modes, Some(" write ")), ["--approval-mode", "write"]);
        assert!(mode_args("x", &modes, None).is_empty());
        assert!(mode_args("x", &modes, Some("")).is_empty());
        assert!(mode_args("x", &modes, Some("--yolo; rm -rf /")).is_empty());
    }

    #[test]
    fn the_envelope_must_be_v1_with_a_bounded_event_list() {
        let ok = envelope(json!({ "v": 1, "events": [{ "type": "turn-start" }] })).unwrap();
        assert_eq!(ok, json!([{ "type": "turn-start" }]));
        assert!(envelope(json!({ "v": 2, "events": [{}] })).is_err());
        assert!(envelope(json!({ "v": "1", "events": [{}] })).is_err());
        assert!(envelope(json!({ "events": [{}] })).is_err());
        assert!(envelope(json!({ "v": 1, "events": [] })).is_err());
        assert!(envelope(json!({ "v": 1, "events": {} })).is_err());
        let many: Vec<Value> = (0..=MAX_EVENTS).map(|_| json!({})).collect();
        assert!(envelope(json!({ "v": 1, "events": many })).is_err());
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
        assert!(!same("", "a"));
    }

    #[test]
    fn a_session_id_outside_the_uuid_alphabet_never_reaches_a_path() {
        assert!(valid_id("0b6c1d5e-1f2a-4c3b-9d8e-7f6a5b4c3d2e"));
        for bad in ["", "..", "a/b", "a\\b", "x\"y", &"a".repeat(129)] {
            assert!(!valid_id(bad), "{bad:?} should be refused");
        }
    }
}
