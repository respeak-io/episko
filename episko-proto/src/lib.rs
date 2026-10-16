//! Episko sync's wire types. The app and `episko-server` both compile against this crate, so
//! a message's shape cannot drift between them (docs/sync.md). Every message is one JSON
//! text frame over a WebSocket, tagged by `t`.

use serde::{Deserialize, Serialize};

/// Bumped on any change a peer on the previous version would misread.
pub const PROTOCOL: u32 = 1;
/// A catch-up is sent in pages of at most this many events.
pub const PAGE: usize = 500;
/// A single push may carry at most this many events.
pub const MAX_PUSH: usize = 1000;
/// An event's payload, serialised, may be at most this many bytes.
pub const MAX_PAYLOAD: usize = 256 * 1024;
/// A `Hello.features` entry: this client speaks the handoff channel (docs/handoff.md).
pub const FEATURE_HANDOFF: &str = "handoff";
/// A `Hello.features` entry: this client takes the memory stream.
pub const FEATURE_MEMORY: &str = "memory";
/// A handoff blob travels in parts of this many raw bytes, base64'd into one text frame each.
pub const HANDOFF_PART: usize = 512 * 1024;
/// A handoff's `meta` (title, brief, project id), serialised, may be at most this many bytes.
pub const HANDOFF_META_MAX: usize = 16 * 1024;

/// Which log an event belongs to. The server refuses a stream it does not know.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Prefs,
    Usage,
    Limits,
    /// Per-project settings keyed by project id, never by path.
    Roster,
    /// A day's spend split by model and project, per device.
    Detail,
    Notes,
    Claims,
    /// Claude's per-project memory files, for one person's own machines (docs/sync.md).
    Memory,
}

/// Every stream, for a peer that has to list them.
pub const STREAMS: [Stream; 8] =
    [Stream::Prefs, Stream::Usage, Stream::Limits, Stream::Roster, Stream::Detail, Stream::Notes, Stream::Claims, Stream::Memory];

impl Stream {
    pub fn as_str(self) -> &'static str {
        match self {
            Stream::Prefs => "prefs",
            Stream::Usage => "usage",
            Stream::Limits => "limits",
            Stream::Roster => "roster",
            Stream::Detail => "detail",
            Stream::Notes => "notes",
            Stream::Claims => "claims",
            Stream::Memory => "memory",
        }
    }
    /// A personal stream reaches only its own user's devices, even in a team workspace.
    pub fn is_personal(self) -> bool {
        !matches!(self, Stream::Notes | Stream::Claims)
    }
    pub fn parse(s: &str) -> Option<Stream> {
        match s {
            "prefs" => Some(Stream::Prefs),
            "usage" => Some(Stream::Usage),
            "limits" => Some(Stream::Limits),
            "roster" => Some(Stream::Roster),
            "detail" => Some(Stream::Detail),
            "notes" => Some(Stream::Notes),
            "claims" => Some(Stream::Claims),
            "memory" => Some(Stream::Memory),
            _ => None,
        }
    }
}

/// An event as a client writes it. Who wrote it is the server's to say, from the token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewEvent {
    pub stream: Stream,
    pub key: String,
    /// The writer's wall clock in ms; last-writer-wins compares these.
    pub at: i64,
    pub payload: serde_json::Value,
}

/// An event as the log holds it: `seq` is the server's, and only ever grows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    pub stream: Stream,
    pub key: String,
    pub actor: String,
    pub device: String,
    pub at: i64,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Trade a one-use invite code for a token. `label` is for people; the device id is the
    /// server's, so two machines both called "MacBook" never share a usage cell.
    /// With a server's registration code instead of an invite, `user` names the new person; a
    /// name already taken is refused, since a second machine of yours comes from `Invite`.
    Pair {
        code: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
    },
    /// After hello: a one-use code that pairs another machine of this same user.
    Invite {},
    /// Open a session; the server replays everything after `since`, then streams.
    /// `features` is opt-in: a server never sends a peer a message it did not advertise.
    Hello {
        token: String,
        since: u64,
        protocol: u32,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        features: Vec<String>,
    },
    Push { events: Vec<NewEvent> },
    /// After a welcome that says `memory`: replay this user's whole memory stream, once. A peer
    /// whose cursor passed memory it was never sent (an older client, the gate off) asks for it.
    MemoryReplay {},
    /// What this device has open right now. Held in memory with a TTL, never logged.
    Presence { items: serde_json::Value },
    /// Offer a session to `to_user` (one of their machines, or any); `data` follows as puts.
    HandoffOffer {
        id: String,
        to_user: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to_device: Option<String>,
        size: u64,
        parts: u32,
        sha256: String,
        meta: serde_json::Value,
    },
    /// One part of an offered blob, base64.
    HandoffPut { id: String, part: u32, data: String },
    HandoffClaim { id: String },
    HandoffFetch { id: String, part: u32 },
    HandoffComplete { id: String },
    HandoffRecall { id: String },
    /// From the recipient before a claim, or from the taker to give the session back.
    HandoffDecline {
        id: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadMessage,
    BadInvite,
    BadToken,
    Protocol,
    NotReady,
    TooLarge,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Paired { token: String, user: String, device: String },
    /// `devices` names every machine in the workspace, so the app can say whose a figure is.
    Welcome {
        user: String,
        device: String,
        head: u64,
        #[serde(default)]
        devices: Vec<DeviceInfo>,
        /// Absent is an older server and means "unknown"; `enabled: false` is a server with it off.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        handoff: Option<HandoffCaps>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        memory: bool,
    },
    /// `more` is true while a catch-up still has pages to send.
    Events { events: Vec<Event>, more: bool },
    /// The seqs the log gave a push's events, in the order they were sent.
    Pushed { seqs: Vec<u64> },
    /// `push`: this refuses the oldest unanswered push, which will never get its `Pushed`.
    Error {
        code: ErrorCode,
        message: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        push: bool,
    },
    /// The answer to `MemoryReplay`, in pages; it never moves the connection's cursor.
    MemoryReplay { events: Vec<Event>, more: bool },
    /// The answer to `Invite`: good once, until `expires` (ms).
    Invited { code: String, expires: i64 },
    /// A device's presence; `items: null` means it went away or its heartbeat lapsed.
    Presence { user: String, device: String, items: serde_json::Value },
    /// After the catch-up: every handoff this user sends or receives, so a missed change heals.
    HandoffList { records: Vec<HandoffInfo> },
    /// Any change to one; boxed, since it would otherwise triple every `ServerMsg`'s size.
    Handoff { info: Box<HandoffInfo> },
    /// A part fetched by the taker; sent on the taker's socket only.
    HandoffPart { id: String, part: u32, data: String },
    HandoffRefused { id: String, reason: HandoffErr, message: String },
}

/// A paired machine as the app shows it; `user` is the name it was invited under.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub user: String,
    pub device: String,
    pub label: String,
    /// Whether its last hello advertised the handoff channel.
    #[serde(default)]
    pub handoff: bool,
}

/// What a server allows for handoff, sent in `Welcome` even when it is off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffCaps {
    pub enabled: bool,
    pub max_bytes: u64,
    pub part_bytes: u32,
    pub ttl_ms: i64,
}

/// One handoff as the server holds it. `have` (parts received) is only ever sent to the sender.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HandoffInfo {
    pub id: String,
    pub from_user: String,
    pub from_device: String,
    pub to_user: String,
    #[serde(default)]
    pub to_device: Option<String>,
    pub state: HandoffState,
    #[serde(default)]
    pub taker: Option<String>,
    pub meta: serde_json::Value,
    pub size: u64,
    pub parts: u32,
    pub sha256: String,
    #[serde(default)]
    pub have: Vec<u32>,
    pub created: i64,
    pub expires: i64,
    pub updated: i64,
}

/// The server's state machine; `Unknown` is a state a newer server added.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffState {
    Uploading,
    Offered,
    Claimed,
    Done,
    Declined,
    Recalled,
    Expired,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffErr {
    Off,
    TooLarge,
    Quota,
    BadTarget,
    BadPart,
    Checksum,
    Gone,
    Conflict,
    #[serde(other)]
    Unknown,
}

/// A device that has not repeated its presence within this long is dropped.
pub const PRESENCE_TTL_MS: u64 = 45_000;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_welcome_from_an_older_server_still_parses() {
        let m: ServerMsg = serde_json::from_value(json!({"t": "welcome", "user": "me", "device": "d1", "head": 3})).unwrap();
        assert_eq!(m, ServerMsg::Welcome { user: "me".into(), device: "d1".into(), head: 3, devices: vec![], handoff: None, memory: false });
    }

    #[test]
    fn messages_have_the_shape_the_other_side_parses() {
        let hello = ClientMsg::Hello { token: "tk".into(), since: 7, protocol: PROTOCOL, features: vec![] };
        assert_eq!(serde_json::to_value(&hello).unwrap(), json!({"t":"hello","token":"tk","since":7,"protocol":1}));
        let push: ClientMsg = serde_json::from_value(json!({"t":"push","events":[
            {"stream":"prefs","key":"cc-sort","at":5,"payload":"manual"}]})).unwrap();
        let ClientMsg::Push { events } = push else { panic!("not a push") };
        assert_eq!(events[0].stream, Stream::Prefs);
        let err = ServerMsg::Error { code: ErrorCode::BadToken, message: "no".into(), push: false };
        assert_eq!(serde_json::to_value(&err).unwrap(), json!({"t":"error","code":"bad_token","message":"no"}));
        let refused = ServerMsg::Error { code: ErrorCode::TooLarge, message: "big".into(), push: true };
        assert_eq!(serde_json::to_value(&refused).unwrap(), json!({"t":"error","code":"too_large","message":"big","push":true}));
        assert_eq!(serde_json::to_value(ClientMsg::MemoryReplay {}).unwrap(), json!({"t":"memory_replay"}));
        let replay: ServerMsg = serde_json::from_value(json!({"t":"memory_replay","events":[],"more":false})).unwrap();
        assert_eq!(replay, ServerMsg::MemoryReplay { events: vec![], more: false });
    }

    #[test]
    fn an_unknown_stream_is_refused_at_the_parse() {
        let bad = json!({"t":"push","events":[{"stream":"tasks","key":"k","at":1,"payload":null}]});
        assert!(serde_json::from_value::<ClientMsg>(bad).is_err());
        for s in STREAMS { assert_eq!(Stream::parse(s.as_str()), Some(s)); }
        assert_eq!(Stream::parse("tasks"), None);
    }

    #[test]
    fn the_memory_stream_parses_and_stays_with_its_own_user() {
        let push: ClientMsg = serde_json::from_value(json!({"t":"push","events":[
            {"stream":"memory","key":"p1|notes.md","at":5,"payload":{"text":"x","sha":"ab"}}]})).unwrap();
        let ClientMsg::Push { events } = push else { panic!("not a push") };
        assert_eq!(events[0].stream, Stream::Memory);
        assert_eq!(Stream::Memory.as_str(), "memory");
        assert!(STREAMS.contains(&Stream::Memory));
        assert!(Stream::Memory.is_personal(), "a memory never reaches a teammate through the log");
    }

    fn round_trips<T: Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug>(m: T) {
        let back: T = serde_json::from_value(serde_json::to_value(&m).unwrap()).unwrap();
        assert_eq!(back, m);
    }

    fn info() -> HandoffInfo {
        HandoffInfo {
            id: "h1".into(), from_user: "anna".into(), from_device: "d1".into(), to_user: "ben".into(), to_device: Some("d2".into()),
            state: HandoffState::Claimed, taker: Some("d2".into()), meta: json!({"v": 1}), size: 10, parts: 1,
            sha256: "ab".into(), have: vec![0], created: 1, expires: 2, updated: 3,
        }
    }

    #[test]
    fn every_handoff_message_round_trips() {
        let id = || "h1".to_string();
        for m in [
            ClientMsg::Hello { token: "tk".into(), since: 1, protocol: PROTOCOL, features: vec![FEATURE_HANDOFF.into(), FEATURE_MEMORY.into()] },
            ClientMsg::HandoffOffer { id: id(), to_user: "ben".into(), to_device: None, size: 9, parts: 1, sha256: "ab".into(), meta: json!({"v": 1}) },
            ClientMsg::HandoffOffer { id: id(), to_user: "ben".into(), to_device: Some("d2".into()), size: 9, parts: 1, sha256: "ab".into(), meta: json!(null) },
            ClientMsg::HandoffPut { id: id(), part: 0, data: "AAAA".into() },
            ClientMsg::HandoffClaim { id: id() },
            ClientMsg::HandoffFetch { id: id(), part: 2 },
            ClientMsg::HandoffComplete { id: id() },
            ClientMsg::HandoffRecall { id: id() },
            ClientMsg::HandoffDecline { id: id(), reason: Some("busy".into()) },
            ClientMsg::HandoffDecline { id: id(), reason: None },
        ] {
            round_trips(m);
        }
        let caps = HandoffCaps { enabled: true, max_bytes: 64 << 20, part_bytes: HANDOFF_PART as u32, ttl_ms: 3_600_000 };
        for m in [
            ServerMsg::Welcome { user: "me".into(), device: "d1".into(), head: 3, devices: vec![], handoff: Some(caps), memory: true },
            ServerMsg::HandoffList { records: vec![info()] },
            ServerMsg::Handoff { info: Box::new(info()) },
            ServerMsg::HandoffPart { id: id(), part: 0, data: "AAAA".into() },
            ServerMsg::HandoffRefused { id: id(), reason: HandoffErr::BadTarget, message: "no".into() },
        ] {
            round_trips(m);
        }
    }

    #[test]
    fn peers_that_predate_handoff_still_parse_and_are_sent_nothing_new() {
        let hello: ClientMsg = serde_json::from_value(json!({"t":"hello","token":"tk","since":7,"protocol":1})).unwrap();
        assert_eq!(hello, ClientMsg::Hello { token: "tk".into(), since: 7, protocol: 1, features: vec![] });
        let d: DeviceInfo = serde_json::from_value(json!({"user":"me","device":"d1","label":"Mac"})).unwrap();
        assert!(!d.handoff);
        let w = ServerMsg::Welcome { user: "me".into(), device: "d1".into(), head: 3, devices: vec![], handoff: None, memory: false };
        assert_eq!(serde_json::to_value(&w).unwrap(), json!({"t":"welcome","user":"me","device":"d1","head":3,"devices":[]}));
        let off = ServerMsg::Welcome { user: "me".into(), device: "d1".into(), head: 3, devices: vec![],
            handoff: Some(HandoffCaps { enabled: false, max_bytes: 0, part_bytes: 0, ttl_ms: 0 }), memory: false };
        let ServerMsg::Welcome { handoff, .. } = serde_json::from_value(serde_json::to_value(&off).unwrap()).unwrap() else { panic!("not a welcome") };
        assert_eq!(handoff.map(|c| c.enabled), Some(false));
    }

    #[test]
    fn a_state_or_reason_from_a_newer_server_parses_as_unknown() {
        let mut v = serde_json::to_value(info()).unwrap();
        v["state"] = json!("parked");
        assert_eq!(serde_json::from_value::<HandoffInfo>(v).unwrap().state, HandoffState::Unknown);
        let r: ServerMsg = serde_json::from_value(json!({"t":"handoff_refused","id":"h1","reason":"rate_limited","message":"m"})).unwrap();
        assert!(matches!(r, ServerMsg::HandoffRefused { reason: HandoffErr::Unknown, .. }));
    }

    #[test]
    fn handoff_is_snake_case_on_the_wire() {
        let m = ClientMsg::HandoffOffer { id: "h1".into(), to_user: "ben".into(), to_device: None, size: 9, parts: 1, sha256: "ab".into(), meta: json!({}) };
        assert_eq!(serde_json::to_value(&m).unwrap(), json!({"t":"handoff_offer","id":"h1","to_user":"ben","size":9,"parts":1,"sha256":"ab","meta":{}}));
        let r = ServerMsg::HandoffRefused { id: "h1".into(), reason: HandoffErr::TooLarge, message: "m".into() };
        assert_eq!(serde_json::to_value(&r).unwrap()["reason"], "too_large");
        let v = serde_json::to_value(info()).unwrap();
        assert_eq!((v["state"].clone(), v["from_user"].clone()), (json!("claimed"), json!("anna")));
        assert_eq!(serde_json::to_value(ClientMsg::HandoffClaim { id: "h1".into() }).unwrap()["t"], "handoff_claim");
    }
}
