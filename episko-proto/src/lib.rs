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

/// Which log an event belongs to. The server refuses a stream it does not know.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Prefs,
    Usage,
    Limits,
}

impl Stream {
    pub fn as_str(self) -> &'static str {
        match self {
            Stream::Prefs => "prefs",
            Stream::Usage => "usage",
            Stream::Limits => "limits",
        }
    }
    pub fn parse(s: &str) -> Option<Stream> {
        match s {
            "prefs" => Some(Stream::Prefs),
            "usage" => Some(Stream::Usage),
            "limits" => Some(Stream::Limits),
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
    Pair { code: String, label: String },
    /// Open a session; the server replays everything after `since`, then streams.
    Hello { token: String, since: u64, protocol: u32 },
    Push { events: Vec<NewEvent> },
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
    Welcome { user: String, device: String, head: u64 },
    /// `more` is true while a catch-up still has pages to send.
    Events { events: Vec<Event>, more: bool },
    /// The seqs the log gave a push's events, in the order they were sent.
    Pushed { seqs: Vec<u64> },
    Error { code: ErrorCode, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn messages_have_the_shape_the_other_side_parses() {
        let hello = ClientMsg::Hello { token: "tk".into(), since: 7, protocol: PROTOCOL };
        assert_eq!(serde_json::to_value(&hello).unwrap(), json!({"t":"hello","token":"tk","since":7,"protocol":1}));
        let push: ClientMsg = serde_json::from_value(json!({"t":"push","events":[
            {"stream":"prefs","key":"cc-sort","at":5,"payload":"manual"}]})).unwrap();
        let ClientMsg::Push { events } = push else { panic!("not a push") };
        assert_eq!(events[0].stream, Stream::Prefs);
        let err = ServerMsg::Error { code: ErrorCode::BadToken, message: "no".into() };
        assert_eq!(serde_json::to_value(&err).unwrap(), json!({"t":"error","code":"bad_token","message":"no"}));
    }

    #[test]
    fn an_unknown_stream_is_refused_at_the_parse() {
        let bad = json!({"t":"push","events":[{"stream":"tasks","key":"k","at":1,"payload":null}]});
        assert!(serde_json::from_value::<ClientMsg>(bad).is_err());
        for s in [Stream::Prefs, Stream::Usage, Stream::Limits] { assert_eq!(Stream::parse(s.as_str()), Some(s)); }
        assert_eq!(Stream::parse("tasks"), None);
    }
}
