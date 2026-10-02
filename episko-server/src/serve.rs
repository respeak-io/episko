//! One thread per connection, like the app's telemetry server. A connection pairs or says
//! hello, is replayed everything after its cursor, and then hears every other device's pushes.

use crate::store::{valid_name, Identity, PushError, Store, INVITE_TTL_MS};
use episko_proto::{ClientMsg, ErrorCode, Event, ServerMsg, MAX_PUSH, PAGE, PRESENCE_TTL_MS, PROTOCOL};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::{Message, WebSocket};

const HELLO_WITHIN: Duration = Duration::from_secs(15);
// How often a connection looks up from its socket to deliver what other devices pushed.
const POLL: Duration = Duration::from_millis(100);
// A reverse proxy drops a silent connection; a ping keeps it open and finds a dead peer.
const PING_EVERY: Duration = Duration::from_secs(30);

type Sock = WebSocket<TcpStream>;

/// What the environment configured: the workspace everyone joins, and the code that lets a new
/// person register themselves (`EPISKO_REGISTER_CODE`); `None` keeps pairing invite-only.
pub struct Config {
    pub ws: String,
    pub register: Option<String>,
}

// A wrong code costs this long, so a registration code cannot be guessed at line speed.
const WRONG_CODE_DELAY: Duration = Duration::from_millis(400);

/// What the hub hands a connection: a batch of log events, or one device's presence.
#[derive(Clone)]
enum Out {
    Events(Arc<Vec<Event>>),
    Presence(ServerMsg),
}

struct Sub {
    id: u64,
    who: Identity,
    tx: Sender<Out>,
}

struct Seen {
    user: String,
    items: serde_json::Value,
    until: Instant,
}

#[derive(Default)]
pub struct Hub {
    next: AtomicU64,
    subs: Mutex<Vec<Sub>>,
    // Presence lives here and nowhere else: a crashed client fades, and the log never grows by it.
    presence: Mutex<HashMap<(String, String), Seen>>,
}

fn guard<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Hub {
    fn join(&self, who: &Identity) -> (u64, Receiver<Out>) {
        let (tx, rx) = channel();
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        for ((ws, device), seen) in guard(&self.presence).iter() {
            if *ws == who.ws && *device != who.device {
                let _ = tx.send(Out::Presence(ServerMsg::Presence { user: seen.user.clone(), device: device.clone(), items: seen.items.clone() }));
            }
        }
        guard(&self.subs).push(Sub { id, who: who.clone(), tx });
        (id, rx)
    }
    fn leave(&self, id: u64, who: &Identity) {
        guard(&self.subs).retain(|s| s.id != id);
        // Another connection from the same device (a reconnect racing this close) keeps it present.
        if !guard(&self.subs).iter().any(|s| s.who.device == who.device && s.who.ws == who.ws) {
            self.set_presence(who, serde_json::Value::Null);
        }
    }
    /// Log events go to the workspace, except a personal stream, which only its own user hears.
    fn publish(&self, from: u64, ws: &str, events: &[Event]) {
        for s in guard(&self.subs).iter().filter(|s| s.id != from && s.who.ws == ws) {
            let mine: Vec<Event> = events.iter().filter(|e| !e.stream.is_personal() || e.actor == s.who.user).cloned().collect();
            if !mine.is_empty() { let _ = s.tx.send(Out::Events(Arc::new(mine))); }
        }
    }
    fn set_presence(&self, who: &Identity, items: serde_json::Value) {
        let key = (who.ws.clone(), who.device.clone());
        let changed = {
            let mut p = guard(&self.presence);
            if items.is_null() { p.remove(&key).is_some() } else {
                let until = Instant::now() + Duration::from_millis(PRESENCE_TTL_MS);
                let prev = p.insert(key, Seen { user: who.user.clone(), items: items.clone(), until });
                prev.is_none_or(|s| s.items != items)
            }
        };
        if changed { self.announce(who, items); }
    }
    fn announce(&self, who: &Identity, items: serde_json::Value) {
        let msg = ServerMsg::Presence { user: who.user.clone(), device: who.device.clone(), items };
        for s in guard(&self.subs).iter().filter(|s| s.who.ws == who.ws && s.who.device != who.device) {
            let _ = s.tx.send(Out::Presence(msg.clone()));
        }
    }
    /// Drops every device whose heartbeat lapsed and tells the workspace it went away.
    pub fn sweep(&self, now: Instant) {
        let gone: Vec<Identity> = {
            let mut p = guard(&self.presence);
            let dead: Vec<_> = p.iter().filter(|(_, s)| s.until <= now).map(|(k, s)| (k.clone(), s.user.clone())).collect();
            dead.into_iter().map(|((ws, device), user)| { p.remove(&(ws.clone(), device.clone())); Identity { ws, user, device } }).collect()
        };
        for who in gone { self.announce(&who, serde_json::Value::Null); }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Accepts forever. Each connection's failure is its own and never reaches the listener.
pub fn serve(listener: TcpListener, store: Arc<Store>, cfg: Arc<Config>) {
    let hub = Arc::new(Hub::default());
    let sweeper = hub.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        sweeper.sweep(Instant::now());
    });
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let (store, hub, cfg) = (store.clone(), hub.clone(), cfg.clone());
        std::thread::spawn(move || {
            let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
            if let Err(e) = connection(stream, &store, &hub, &cfg) {
                eprintln!("[episko-server] {peer}: {e}");
            }
        });
    }
}

fn send(sock: &mut Sock, msg: &ServerMsg) -> tungstenite::Result<()> {
    sock.send(Message::text(serde_json::to_string(msg).expect("a ServerMsg always serialises")))
}

fn refuse(sock: &mut Sock, code: ErrorCode, message: impl Into<String>) -> tungstenite::Result<()> {
    send(sock, &ServerMsg::Error { code, message: message.into() })
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if matches!(io.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut))
}

/// Equal-time comparison: how long a refusal takes must not say how much of the code was right.
fn same_code(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim().as_bytes(), b.trim().as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// An invite pairs a machine of the user it names; the registration code makes a new person.
fn pair(store: &Store, cfg: &Config, code: &str, label: &str, user: Option<&str>) -> Result<(String, Identity), (ErrorCode, String)> {
    let internal = |e: rusqlite::Error| (ErrorCode::Internal, e.to_string());
    if let Some(hit) = store.redeem(code, label, now_ms()).map_err(internal)? { return Ok(hit); }
    if !cfg.register.as_deref().is_some_and(|r| !r.trim().is_empty() && same_code(code, r)) {
        std::thread::sleep(WRONG_CODE_DELAY);
        return Err((ErrorCode::BadInvite, "that code is wrong, used or expired".into()));
    }
    let name = valid_name(user.unwrap_or("")).map_err(|m| (ErrorCode::BadInvite, format!("this is the team's registration code: {m}")))?;
    match store.register(&cfg.ws, &name, label, now_ms()).map_err(internal)? {
        Some(hit) => Ok(hit),
        None => Err((ErrorCode::BadInvite, format!(
            "{name} is already registered here. To add another machine of yours, open Settings › Sync on one that is paired and choose Add a machine"))),
    }
}

fn connection(stream: TcpStream, store: &Store, hub: &Hub, cfg: &Config) -> Result<(), String> {
    stream.set_read_timeout(Some(HELLO_WITHIN)).map_err(|e| e.to_string())?;
    let mut sock = tungstenite::accept(stream).map_err(|e| e.to_string())?;
    let (who, since) = loop {
        let text = match sock.read() {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => continue,
            Err(e) => return Err(format!("before hello: {e}")),
        };
        match serde_json::from_str::<ClientMsg>(&text) {
            Ok(ClientMsg::Pair { code, label, user }) => match pair(store, cfg, &code, &label, user.as_deref()) {
                Ok((token, who)) => send(&mut sock, &ServerMsg::Paired { token, user: who.user, device: who.device }),
                Err((code, message)) => refuse(&mut sock, code, message),
            }
            .map_err(|e| e.to_string())?,
            Ok(ClientMsg::Hello { protocol, .. }) if protocol != PROTOCOL => {
                let _ = refuse(&mut sock, ErrorCode::Protocol, format!("server speaks protocol {PROTOCOL}, client {protocol}"));
                return Ok(());
            }
            Ok(ClientMsg::Hello { token, since, .. }) => match store.auth(&token) {
                Ok(Some(who)) => break (who, since),
                Ok(None) => {
                    let _ = refuse(&mut sock, ErrorCode::BadToken, "this device's token is not known here");
                    return Ok(());
                }
                Err(e) => return Err(e.to_string()),
            },
            Ok(ClientMsg::Push { .. } | ClientMsg::Presence { .. } | ClientMsg::Invite {}) => refuse(&mut sock, ErrorCode::NotReady, "say hello first").map_err(|e| e.to_string())?,
            Err(e) => refuse(&mut sock, ErrorCode::BadMessage, e.to_string()).map_err(|e| e.to_string())?,
        }
    };
    // Join before replaying, so a push landing mid-catch-up is queued rather than missed.
    let (id, rx) = hub.join(&who);
    let out = session(&mut sock, store, hub, id, &rx, &who, since);
    hub.leave(id, &who);
    out
}

fn session(sock: &mut Sock, store: &Store, hub: &Hub, id: u64, rx: &Receiver<Out>, who: &Identity, since: u64) -> Result<(), String> {
    let err = |e: tungstenite::Error| e.to_string();
    let head = store.head(&who.ws).map_err(|e| e.to_string())?;
    let devices = store.devices_in(&who.ws).map_err(|e| e.to_string())?;
    send(sock, &ServerMsg::Welcome { user: who.user.clone(), device: who.device.clone(), head, devices }).map_err(err)?;
    let mut sent = since;
    loop {
        let mut page = store.since(&who.ws, &who.user, sent, PAGE + 1).map_err(|e| e.to_string())?;
        let more = page.len() > PAGE;
        page.truncate(PAGE);
        if let Some(last) = page.last() { sent = last.seq; }
        send(sock, &ServerMsg::Events { events: page, more }).map_err(err)?;
        if !more { break; }
    }
    sock.get_mut().set_read_timeout(Some(POLL)).map_err(|e| e.to_string())?;
    let mut pinged = Instant::now();
    loop {
        match sock.read() {
            Ok(Message::Text(t)) => push(sock, store, hub, id, who, &t).map_err(err)?,
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(e) if is_timeout(&e) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
        while let Ok(out) = rx.try_recv() {
            match out {
                Out::Events(batch) => {
                    let fresh: Vec<Event> = batch.iter().filter(|e| e.seq > sent).cloned().collect();
                    if let Some(last) = fresh.last() { sent = last.seq; }
                    if !fresh.is_empty() { send(sock, &ServerMsg::Events { events: fresh, more: false }).map_err(err)?; }
                }
                Out::Presence(msg) => send(sock, &msg).map_err(err)?,
            }
        }
        if pinged.elapsed() >= PING_EVERY {
            sock.send(Message::Ping(Vec::new().into())).map_err(err)?;
            pinged = Instant::now();
        }
    }
}

fn push(sock: &mut Sock, store: &Store, hub: &Hub, id: u64, who: &Identity, text: &str) -> tungstenite::Result<()> {
    let events = match serde_json::from_str::<ClientMsg>(text) {
        Ok(ClientMsg::Push { events }) => events,
        Ok(ClientMsg::Presence { items }) => {
            if items.to_string().len() > episko_proto::MAX_PAYLOAD { return refuse(sock, ErrorCode::TooLarge, "presence too large"); }
            hub.set_presence(who, items);
            return Ok(());
        }
        // Another machine of the same person: the code names this connection's user, never another.
        Ok(ClientMsg::Invite {}) => {
            let now = now_ms();
            return match store.create_invite(&who.ws, &who.user, now) {
                Ok(code) => send(sock, &ServerMsg::Invited { code, expires: now + INVITE_TTL_MS }),
                Err(e) => refuse(sock, ErrorCode::Internal, e.to_string()),
            };
        }
        Ok(_) => return refuse(sock, ErrorCode::BadMessage, "already said hello; only push from here"),
        Err(e) => return refuse(sock, ErrorCode::BadMessage, e.to_string()),
    };
    if events.len() > MAX_PUSH {
        return refuse(sock, ErrorCode::TooLarge, format!("at most {MAX_PUSH} events per push"));
    }
    match store.append(who, &events) {
        Ok(out) => {
            let seqs = out.iter().map(|e| e.seq).collect();
            hub.publish(id, &who.ws, &out);
            send(sock, &ServerMsg::Pushed { seqs })
        }
        Err(PushError::TooLarge(m)) => refuse(sock, ErrorCode::TooLarge, m),
        Err(PushError::Db(m)) => refuse(sock, ErrorCode::Internal, m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use episko_proto::{NewEvent, Stream};
    use serde_json::json;
    use std::net::SocketAddr;

    type Client = WebSocket<TcpStream>;

    fn start() -> (SocketAddr, Arc<Store>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let store = Arc::new(Store::open_in_memory().unwrap());
        let s = store.clone();
        let cfg = Arc::new(Config { ws: "default".into(), register: Some("TEAM-CODE-1234".into()) });
        std::thread::spawn(move || serve(listener, s, cfg));
        (addr, store)
    }

    fn connect(addr: SocketAddr) -> Client {
        let tcp = TcpStream::connect(addr).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        tungstenite::client(format!("ws://{addr}/"), tcp).unwrap().0
    }

    fn say(c: &mut Client, m: &ClientMsg) {
        c.send(Message::text(serde_json::to_string(m).unwrap())).unwrap();
    }

    fn hear(c: &mut Client) -> ServerMsg {
        loop {
            if let Message::Text(t) = c.read().unwrap() { return serde_json::from_str(&t).unwrap(); }
        }
    }

    fn pair(addr: SocketAddr, store: &Store, label: &str) -> (String, String) {
        let mut c = connect(addr);
        let code = store.create_invite("default", "me", now_ms()).unwrap();
        say(&mut c, &ClientMsg::Pair { code, label: label.into(), user: None });
        match hear(&mut c) {
            ServerMsg::Paired { token, device, .. } => (token, device),
            m => panic!("expected Paired, got {m:?}"),
        }
    }

    fn hello(addr: SocketAddr, token: &str, since: u64) -> (Client, Vec<Event>) {
        let mut c = connect(addr);
        say(&mut c, &ClientMsg::Hello { token: token.into(), since, protocol: PROTOCOL });
        assert!(matches!(hear(&mut c), ServerMsg::Welcome { .. }));
        let mut got = Vec::new();
        loop {
            match hear(&mut c) {
                ServerMsg::Events { events, more } => { got.extend(events); if !more { break; } }
                m => panic!("expected Events, got {m:?}"),
            }
        }
        (c, got)
    }

    fn pref(key: &str) -> NewEvent {
        NewEvent { stream: Stream::Prefs, key: key.into(), at: 1, payload: json!("x") }
    }

    #[test]
    fn a_push_from_one_device_reaches_the_other_live() {
        let (addr, store) = start();
        let (ta, da) = pair(addr, &store, "laptop");
        let (tb, _) = pair(addr, &store, "desk");
        let (mut a, _) = hello(addr, &ta, 0);
        let (mut b, caught_up) = hello(addr, &tb, 0);
        assert!(caught_up.is_empty());
        say(&mut a, &ClientMsg::Push { events: vec![pref("cc-sort")] });
        assert_eq!(hear(&mut a), ServerMsg::Pushed { seqs: vec![1] });
        match hear(&mut b) {
            ServerMsg::Events { events, .. } => {
                assert_eq!(events.len(), 1);
                assert_eq!((events[0].key.as_str(), events[0].device.as_str()), ("cc-sort", da.as_str()));
            }
            m => panic!("expected Events, got {m:?}"),
        }
    }

    #[test]
    fn a_device_that_was_away_replays_from_its_cursor_in_pages() {
        let (addr, store) = start();
        let (token, _) = pair(addr, &store, "laptop");
        let who = store.auth(&token).unwrap().unwrap();
        let batch: Vec<NewEvent> = (0..PAGE + 3).map(|i| pref(&format!("k{i}"))).collect();
        store.append(&who, &batch).unwrap();
        assert_eq!(hello(addr, &token, 0).1.len(), PAGE + 3);
        let tail = hello(addr, &token, PAGE as u64).1;
        assert_eq!(tail.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![PAGE as u64 + 1, PAGE as u64 + 2, PAGE as u64 + 3]);
    }

    #[test]
    fn presence_reaches_the_rest_of_the_workspace_and_clears_when_the_device_leaves() {
        let (addr, store) = start();
        let (ta, da) = pair(addr, &store, "laptop");
        let (tb, _) = pair(addr, &store, "desk");
        let (mut a, _) = hello(addr, &ta, 0);
        let (mut b, _) = hello(addr, &tb, 0);
        say(&mut a, &ClientMsg::Presence { items: json!([{"project": "p1", "phase": "working"}]) });
        match hear(&mut b) {
            ServerMsg::Presence { device, items, .. } => { assert_eq!(device, da); assert_eq!(items[0]["phase"], "working"); }
            m => panic!("expected Presence, got {m:?}"),
        }
        let (mut c, _) = hello(addr, &tb, 0);
        assert!(matches!(hear(&mut c), ServerMsg::Presence { .. }), "a late joiner is told who is already here");
        a.close(None).unwrap();
        loop {
            if let ServerMsg::Presence { items, .. } = hear(&mut b) { assert!(items.is_null()); break; }
        }
    }

    #[test]
    fn a_lapsed_heartbeat_is_swept() {
        let hub = Hub::default();
        let who = Identity { ws: "w".into(), user: "u".into(), device: "d".into() };
        let watcher = Identity { device: "e".into(), ..who.clone() };
        let (_, rx) = hub.join(&watcher);
        hub.set_presence(&who, json!(["x"]));
        assert!(matches!(rx.try_recv(), Ok(Out::Presence(_))));
        hub.sweep(Instant::now() + Duration::from_millis(PRESENCE_TTL_MS + 1));
        match rx.try_recv() { Ok(Out::Presence(ServerMsg::Presence { items, .. })) => assert!(items.is_null()), _ => panic!("no sweep") }
    }

    fn register(addr: SocketAddr, code: &str, user: Option<&str>) -> ServerMsg {
        let mut c = connect(addr);
        say(&mut c, &ClientMsg::Pair { code: code.into(), label: "lap".into(), user: user.map(Into::into) });
        hear(&mut c)
    }

    #[test]
    fn a_person_registers_once_and_adds_machines_by_invite() {
        let (addr, _) = start();
        let token = match register(addr, "TEAM-CODE-1234", Some("Ana")) {
            ServerMsg::Paired { token, user, .. } => { assert_eq!(user, "Ana"); token }
            m => panic!("expected Paired, got {m:?}"),
        };
        assert!(matches!(register(addr, "TEAM-CODE-1234", Some("ana")), ServerMsg::Error { code: ErrorCode::BadInvite, .. }),
            "the team code cannot claim a name that exists");
        assert!(matches!(register(addr, "TEAM-CODE-1234", None), ServerMsg::Error { code: ErrorCode::BadInvite, .. }));
        assert!(matches!(register(addr, "TEAM-CODE-0000", Some("bob")), ServerMsg::Error { code: ErrorCode::BadInvite, .. }));
        let (mut c, _) = hello(addr, &token, 0);
        say(&mut c, &ClientMsg::Invite {});
        let code = loop {
            if let ServerMsg::Invited { code, .. } = hear(&mut c) { break code; }
        };
        match register(addr, &code, None) {
            ServerMsg::Paired { user, .. } => assert_eq!(user, "Ana", "an invite pairs the asker's own user"),
            m => panic!("expected Paired, got {m:?}"),
        }
    }

    #[test]
    fn a_stranger_gets_an_answer_and_nothing_else() {
        let (addr, _) = start();
        let mut c = connect(addr);
        say(&mut c, &ClientMsg::Push { events: vec![pref("cc-sort")] });
        assert!(matches!(hear(&mut c), ServerMsg::Error { code: ErrorCode::NotReady, .. }));
        say(&mut c, &ClientMsg::Pair { code: "EPSK-0000-0000".into(), label: "x".into(), user: None });
        assert!(matches!(hear(&mut c), ServerMsg::Error { code: ErrorCode::BadInvite, .. }));
        say(&mut c, &ClientMsg::Hello { token: "nope".into(), since: 0, protocol: PROTOCOL });
        assert!(matches!(hear(&mut c), ServerMsg::Error { code: ErrorCode::BadToken, .. }));
    }

    #[test]
    fn an_older_client_is_told_why_rather_than_misread() {
        let (addr, store) = start();
        let (token, _) = pair(addr, &store, "laptop");
        let mut c = connect(addr);
        say(&mut c, &ClientMsg::Hello { token, since: 0, protocol: PROTOCOL + 1 });
        assert!(matches!(hear(&mut c), ServerMsg::Error { code: ErrorCode::Protocol, .. }));
    }
}
