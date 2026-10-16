//! The one SQLite file: the event log, one-use invites, and the tokens they were traded for.

use episko_proto::{
    DeviceInfo, Event, HandoffErr, HandoffInfo, HandoffState, NewEvent, Stream, FEATURE_HANDOFF, HANDOFF_META_MAX, HANDOFF_PART,
    MAX_PAYLOAD, STREAMS,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Mutex;

/// An invite code is good for ten minutes, once.
pub const INVITE_TTL_MS: i64 = 10 * 60_000;
const MAX_KEY: usize = 256;
// Crockford base32: no I, L, O or U, so a code read aloud cannot be misheard as another.
const CODE_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, stream TEXT NOT NULL, key TEXT NOT NULL,
  actor TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
  rx INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS heads ON events (ws, stream, key, seq);
CREATE INDEX IF NOT EXISTS by_ws ON events (ws, seq);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, ws TEXT NOT NULL, user TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS by_rx ON events (rx);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, ws TEXT NOT NULL, user TEXT NOT NULL, device TEXT NOT NULL,
  label TEXT NOT NULL, created INTEGER NOT NULL, features TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, ws TEXT NOT NULL, from_user TEXT NOT NULL, from_device TEXT NOT NULL,
  to_user TEXT NOT NULL, to_device TEXT, state TEXT NOT NULL, taker TEXT, meta TEXT NOT NULL,
  size INTEGER NOT NULL, parts INTEGER NOT NULL, sha256 TEXT NOT NULL, created INTEGER NOT NULL,
  expires INTEGER NOT NULL, updated INTEGER NOT NULL, closed INTEGER);
CREATE INDEX IF NOT EXISTS handoffs_to ON handoffs (ws, to_user);
CREATE INDEX IF NOT EXISTS handoffs_from ON handoffs (ws, from_user);
CREATE TABLE IF NOT EXISTS handoff_parts (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part));
";

/// Who a token says is on the other end. Every event they push is stamped with this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub ws: String,
    pub user: String,
    pub device: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PushError {
    TooLarge(String),
    Db(String),
}

pub struct Store {
    conn: Mutex<Connection>,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("the OS random source is unavailable");
    b
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// Only a hash is stored, so a copied `episko.db` does not hand out working tokens.
fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn new_code() -> String {
    let b = random_bytes::<8>();
    let c: String = b.iter().map(|x| CODE_ALPHABET[(*x as usize) % CODE_ALPHABET.len()] as char).collect();
    format!("EPSK-{}-{}", &c[..4], &c[4..])
}

/// What a person typed, in the spelling `new_code` stores: case and stray spaces forgiven.
fn norm_code(code: &str) -> String {
    code.trim().to_ascii_uppercase().replace(' ', "")
}

/// A token for one new device of `user`; the device id is the server's, never the client's.
fn mint(tx: &rusqlite::Transaction, ws: &str, user: &str, label: &str, now: i64) -> rusqlite::Result<(String, Identity)> {
    let token = hex(&random_bytes::<32>());
    let device = hex(&random_bytes::<6>());
    let label: String = label.trim().chars().take(64).collect();
    tx.execute(
        "INSERT INTO tokens (hash, ws, user, device, label, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![token_hash(&token), ws, user, device, label, now],
    )?;
    Ok((token, Identity { ws: ws.into(), user: user.into(), device }))
}

/// A person's name as typed, or why it cannot be one: 1 to 40 letters, digits, spaces, `.`, `-`, `_`.
pub fn valid_name(raw: &str) -> Result<String, &'static str> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() { return Err("enter your name"); }
    if name.chars().count() > 40 { return Err("a name is at most 40 characters"); }
    if !name.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_')) {
        return Err("a name is letters, digits, spaces, dots, dashes and underscores");
    }
    Ok(name)
}

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Store> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Store::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        Store::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Store> {
        // A database from before `rx` existed gains it; every old row reads as received at 0.
        let has_rx = conn.prepare("SELECT rx FROM events LIMIT 0").is_ok();
        let events_exist = conn.prepare("SELECT 1 FROM events LIMIT 0").is_ok();
        if events_exist && !has_rx {
            conn.execute_batch("ALTER TABLE events ADD COLUMN rx INTEGER NOT NULL DEFAULT 0")?;
        }
        // Likewise `features`: a token from before handoff advertised nothing.
        let tokens_exist = conn.prepare("SELECT 1 FROM tokens LIMIT 0").is_ok();
        if tokens_exist && conn.prepare("SELECT features FROM tokens LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE tokens ADD COLUMN features TEXT NOT NULL DEFAULT ''")?;
        }
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    /// Drops every event a newer one of the same key has superseded, once it is older than
    /// `keep_ms`. The latest per key always stays, so a device that was away still converges.
    pub fn compact(&self, now: i64, keep_ms: i64) -> rusqlite::Result<usize> {
        self.db().execute(
            "DELETE FROM events WHERE rx < ?1 AND seq NOT IN (SELECT MAX(seq) FROM events GROUP BY ws, stream, key)",
            params![now - keep_ms],
        )
    }

    /// Every paired device: (user, device, label, created).
    pub fn devices(&self) -> rusqlite::Result<Vec<(String, String, String, i64)>> {
        let db = self.db();
        let mut q = db.prepare("SELECT user, device, label, created FROM tokens ORDER BY created")?;
        let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect()
    }

    /// The machines paired into one workspace, oldest first.
    pub fn devices_in(&self, ws: &str) -> rusqlite::Result<Vec<DeviceInfo>> {
        let db = self.db();
        let mut q = db.prepare("SELECT user, device, label, features FROM tokens WHERE ws = ?1 ORDER BY created")?;
        let rows = q.query_map(params![ws], |r| {
            let features: String = r.get(3)?;
            let handoff = features.split(',').any(|f| f == FEATURE_HANDOFF);
            Ok(DeviceInfo { user: r.get(0)?, device: r.get(1)?, label: r.get(2)?, handoff })
        })?;
        rows.collect()
    }

    /// Shuts a device out: its next hello is refused, and the app asks to pair again. Its open
    /// handoffs end with it; the transitions come back so the caller can say so.
    pub fn revoke(&self, device: &str) -> rusqlite::Result<(usize, Vec<(String, HandoffInfo)>)> {
        self.revoke_at(device, crate::serve::now_ms())
    }

    pub fn revoke_at(&self, device: &str, now: i64) -> rusqlite::Result<(usize, Vec<(String, HandoffInfo)>)> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let open: Vec<RevokeRow> = {
            let mut q = tx.prepare(&format!(
                "SELECT id, state, from_device, to_device, taker FROM handoffs WHERE state IN {OPEN} AND (from_device = ?1 OR to_device = ?1 OR taker = ?1)"
            ))?;
            let rows = q.query_map(params![device], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut moved = Vec::new();
        for (id, state, from, to, taker) in open {
            let state = parse_state(&state);
            // A claimed blob stays with its taker, who may hold the only surviving copy.
            let to = if (from == device || to.as_deref() == Some(device)) && state != HandoffState::Claimed {
                HandoffState::Recalled
            } else if taker.as_deref() == Some(device) && state == HandoffState::Claimed {
                HandoffState::Expired
            } else {
                continue;
            };
            if close(&tx, &id, state, to, &json!({}), now)? {
                moved.extend(load(&tx, &id)?);
            }
        }
        let n = tx.execute("DELETE FROM tokens WHERE device = ?1", params![device])?;
        tx.commit()?;
        Ok((n, moved))
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panicked writer left no half-applied state: every write is one statement or one transaction.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn create_invite(&self, ws: &str, user: &str, now: i64) -> rusqlite::Result<String> {
        let code = new_code();
        self.db().execute(
            "INSERT INTO invites (code, ws, user, expires) VALUES (?1, ?2, ?3, ?4)",
            params![code, ws, user, now + INVITE_TTL_MS],
        )?;
        Ok(code)
    }

    /// A new person joins with the server's registration code. `Ok(None)` when the name is taken:
    /// anyone holding the team code could otherwise claim your name and read your settings.
    pub fn register(&self, ws: &str, user: &str, label: &str, now: i64) -> rusqlite::Result<Option<(String, Identity)>> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let taken: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tokens WHERE ws = ?1 AND lower(user) = lower(?2))",
            params![ws, user],
            |r| r.get(0),
        )?;
        if taken { return Ok(None); }
        let (token, who) = mint(&tx, ws, user, label, now)?;
        tx.commit()?;
        Ok(Some((token, who)))
    }

    /// Renames a person everywhere their name is the key: tokens, pending invites and the log's
    /// actor column, which is what keeps a personal stream personal. Refuses a name in use.
    pub fn rename(&self, from: &str, to: &str) -> rusqlite::Result<Option<usize>> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let taken: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM tokens WHERE lower(user) = lower(?1))", params![to], |r| r.get(0))?;
        if taken && !from.eq_ignore_ascii_case(to) { return Ok(None); }
        let n = tx.execute("UPDATE tokens SET user = ?2 WHERE user = ?1", params![from, to])?;
        tx.execute("UPDATE invites SET user = ?2 WHERE user = ?1", params![from, to])?;
        tx.execute("UPDATE events SET actor = ?2 WHERE actor = ?1", params![from, to])?;
        tx.execute("UPDATE handoffs SET from_user = ?2 WHERE from_user = ?1", params![from, to])?;
        tx.execute("UPDATE handoffs SET to_user = ?2 WHERE to_user = ?1", params![from, to])?;
        tx.commit()?;
        Ok(Some(n))
    }

    /// Spends an invite and returns the token and who it names; `None` for a bad or used code.
    pub fn redeem(&self, code: &str, label: &str, now: i64) -> rusqlite::Result<Option<(String, Identity)>> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let row: Option<(String, String)> = tx
            .query_row(
                "DELETE FROM invites WHERE code = ?1 AND expires > ?2 RETURNING ws, user",
                params![norm_code(code), now],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((ws, user)) = row else { return Ok(None) };
        let (token, who) = mint(&tx, &ws, &user, label, now)?;
        tx.commit()?;
        Ok(Some((token, who)))
    }

    pub fn auth(&self, token: &str) -> rusqlite::Result<Option<Identity>> {
        self.db()
            .query_row(
                "SELECT ws, user, device FROM tokens WHERE hash = ?1",
                params![token_hash(token)],
                |r| Ok(Identity { ws: r.get(0)?, user: r.get(1)?, device: r.get(2)? }),
            )
            .optional()
    }

    pub fn head(&self, ws: &str) -> rusqlite::Result<u64> {
        self.db().query_row("SELECT COALESCE(MAX(seq), 0) FROM events WHERE ws = ?1", params![ws], |r| r.get(0))
    }

    /// Appends a push as one transaction, stamped with `who` whatever the client claimed.
    pub fn append(&self, who: &Identity, events: &[NewEvent]) -> Result<Vec<Event>, PushError> {
        self.append_at(who, events, crate::serve::now_ms())
    }

    pub fn append_at(&self, who: &Identity, events: &[NewEvent], now: i64) -> Result<Vec<Event>, PushError> {
        let mut rows = Vec::with_capacity(events.len());
        for e in events {
            let payload = e.payload.to_string();
            if e.key.is_empty() || e.key.len() > MAX_KEY {
                return Err(PushError::TooLarge(format!("key must be 1..={MAX_KEY} bytes")));
            }
            if payload.len() > MAX_PAYLOAD {
                return Err(PushError::TooLarge(format!("payload for {} exceeds {MAX_PAYLOAD} bytes", e.key)));
            }
            rows.push((e, payload));
        }
        let db_err = |e: rusqlite::Error| PushError::Db(e.to_string());
        let mut db = self.db();
        let tx = db.transaction().map_err(db_err)?;
        let mut out = Vec::with_capacity(rows.len());
        for (e, payload) in rows {
            tx.execute(
                "INSERT INTO events (ws, stream, key, actor, device, at, payload, rx) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![who.ws, e.stream.as_str(), e.key, who.user, who.device, e.at, payload, now],
            )
            .map_err(db_err)?;
            out.push(Event {
                seq: tx.last_insert_rowid() as u64,
                stream: e.stream,
                key: e.key.clone(),
                actor: who.user.clone(),
                device: who.device.clone(),
                at: e.at,
                payload: e.payload.clone(),
            });
        }
        tx.commit().map_err(db_err)?;
        Ok(out)
    }

    /// Up to `limit` events after `cursor` that `user` may see, oldest first: the team's
    /// shared streams, and only their own personal ones.
    pub fn since(&self, ws: &str, user: &str, cursor: u64, limit: usize) -> rusqlite::Result<Vec<Event>> {
        let shared = STREAMS.iter().filter(|s| !s.is_personal()).map(|s| format!("'{}'", s.as_str())).collect::<Vec<_>>().join(",");
        let db = self.db();
        let mut q = db.prepare_cached(&format!(
            "SELECT seq, stream, key, actor, device, at, payload FROM events              WHERE ws = ?1 AND seq > ?2 AND (actor = ?4 OR stream IN ({shared})) ORDER BY seq LIMIT ?3",
        ))?;
        let rows = q.query_map(params![ws, cursor, limit as i64, user], |r| {
            let stream: String = r.get(1)?;
            let payload: String = r.get(6)?;
            Ok((r.get::<_, u64>(0)?, stream, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, payload))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, stream, key, actor, device, at, payload) = row?;
            // A row this build cannot read is skipped rather than ending the catch-up for everyone.
            let (Some(stream), Ok(payload)) = (Stream::parse(&stream), serde_json::from_str(&payload)) else { continue };
            out.push(Event { seq, stream, key, actor, device, at, payload });
        }
        Ok(out)
    }
}

/// What `EPISKO_HANDOFF*` configured (docs/handoff.md); serve holds `None` when it is off.
#[cfg_attr(not(test), allow(dead_code))] // wired into serve.rs by the next slice
#[derive(Debug, Clone, Copy)]
pub struct HandoffCfg {
    pub ttl_ms: i64,
    pub max_bytes: u64,
}

// id, state, from_device, to_device, taker
type RevokeRow = (String, String, String, Option<String>, Option<String>);

/// A closed handoff's row outlives its parts this long, so an offline sender still learns the outcome.
pub const HANDOFF_KEEP_MS: i64 = 7 * 86_400_000;
// A claim holds the blob at least this long, so a download started near the TTL can finish.
const CLAIM_HOLD_MS: i64 = 3_600_000;
const MAX_OPEN_SENT: i64 = 10;
const MAX_PENDING_BYTES: i64 = 256 << 20;
const OPEN: &str = "('uploading', 'offered', 'claimed')";
const COLS: &str = "ws, id, from_user, from_device, to_user, to_device, state, taker, meta, size, parts, sha256, created, expires, updated";

/// A `HandoffOffer` as the store takes it; who sends it comes from the token.
#[cfg_attr(not(test), allow(dead_code))]
pub struct Offer {
    pub id: String,
    pub to_user: String,
    pub to_device: Option<String>,
    pub size: u64,
    pub parts: u32,
    pub sha256: String,
    pub meta: Value,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, PartialEq)]
pub enum HandoffError {
    Refused(HandoffErr, String),
    Db(String),
}

impl From<rusqlite::Error> for HandoffError {
    fn from(e: rusqlite::Error) -> Self {
        HandoffError::Db(e.to_string())
    }
}

fn refused<T>(reason: HandoffErr, message: impl Into<String>) -> Result<T, HandoffError> {
    Err(HandoffError::Refused(reason, message.into()))
}

fn state_str(s: HandoffState) -> &'static str {
    match s {
        HandoffState::Uploading => "uploading",
        HandoffState::Offered => "offered",
        HandoffState::Claimed => "claimed",
        HandoffState::Done => "done",
        HandoffState::Declined => "declined",
        HandoffState::Recalled => "recalled",
        HandoffState::Expired => "expired",
        HandoffState::Unknown => "unknown",
    }
}

fn parse_state(s: &str) -> HandoffState {
    serde_json::from_value(Value::String(s.into())).unwrap_or(HandoffState::Unknown)
}

fn uuid_shaped(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_hexdigit() })
}

fn part_len(size: u64, parts: u32, part: u32) -> u64 {
    if part + 1 < parts { HANDOFF_PART as u64 } else { size - (u64::from(parts) - 1) * HANDOFF_PART as u64 }
}

fn row_info(r: &rusqlite::Row) -> rusqlite::Result<(String, HandoffInfo)> {
    let state: String = r.get(6)?;
    let meta: String = r.get(8)?;
    let info = HandoffInfo {
        id: r.get(1)?,
        from_user: r.get(2)?,
        from_device: r.get(3)?,
        to_user: r.get(4)?,
        to_device: r.get(5)?,
        state: parse_state(&state),
        taker: r.get(7)?,
        meta: serde_json::from_str(&meta).unwrap_or_else(|_| json!({})),
        size: r.get(9)?,
        parts: r.get(10)?,
        sha256: r.get(11)?,
        have: vec![],
        created: r.get(12)?,
        expires: r.get(13)?,
        updated: r.get(14)?,
    };
    Ok((r.get(0)?, info))
}

// `have` only means something while uploading: before that nothing is held, after it everything was.
fn fill_have(c: &Connection, h: &mut HandoffInfo) -> rusqlite::Result<()> {
    if h.state == HandoffState::Uploading {
        let mut q = c.prepare_cached("SELECT part FROM handoff_parts WHERE id = ?1 ORDER BY part")?;
        h.have = q.query_map(params![h.id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    }
    Ok(())
}

fn load(c: &Connection, id: &str) -> rusqlite::Result<Option<(String, HandoffInfo)>> {
    let row = c.query_row(&format!("SELECT {COLS} FROM handoffs WHERE id = ?1"), params![id], row_info).optional()?;
    let Some((ws, mut h)) = row else { return Ok(None) };
    fill_have(c, &mut h)?;
    Ok(Some((ws, h)))
}

// Missing, another workspace's, or between two other people all read the same: gone.
fn mine(c: &Connection, who: &Identity, id: &str) -> Result<HandoffInfo, HandoffError> {
    match load(c, id)? {
        Some((ws, h)) if ws == who.ws && (h.from_user.eq_ignore_ascii_case(&who.user) || h.to_user.eq_ignore_ascii_case(&who.user)) => Ok(h),
        _ => refused(HandoffErr::Gone, "no such handoff"),
    }
}

fn is_recipient(h: &HandoffInfo, who: &Identity) -> bool {
    h.to_user.eq_ignore_ascii_case(&who.user) && h.from_device != who.device && h.to_device.as_ref().is_none_or(|d| *d == who.device)
}

fn is_taker(h: &HandoffInfo, who: &Identity) -> bool {
    h.taker.as_deref() == Some(who.device.as_str())
}

/// One compare-and-set into a terminal state: the parts go, `meta` is replaced, `closed` is stamped.
fn close(c: &Connection, id: &str, from: HandoffState, to: HandoffState, meta: &Value, now: i64) -> rusqlite::Result<bool> {
    let n = c.execute(
        "UPDATE handoffs SET state = ?3, meta = ?4, closed = ?5, updated = ?5 WHERE id = ?1 AND state = ?2",
        params![id, state_str(from), state_str(to), meta.to_string(), now],
    )?;
    if n == 1 { c.execute("DELETE FROM handoff_parts WHERE id = ?1", params![id])?; }
    Ok(n == 1)
}

// The handoff half of the store (docs/handoff.md): every transition is one guarded UPDATE.
#[cfg_attr(not(test), allow(dead_code))]
impl Store {
    /// Records what this device's last hello advertised; unknown spellings are dropped.
    pub fn set_features(&self, device: &str, features: &[String]) -> rusqlite::Result<()> {
        let ok = |f: &&String| !f.is_empty() && f.len() <= 32 && f.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        let keep: Vec<&str> = features.iter().filter(ok).take(16).map(String::as_str).collect();
        self.db().execute("UPDATE tokens SET features = ?2 WHERE device = ?1", params![device, keep.join(",")])?;
        Ok(())
    }

    /// A new offer, or the same one again from the same machine, which answers with `have`.
    pub fn handoff_offer(&self, who: &Identity, req: &Offer, cfg: &HandoffCfg, now: i64) -> Result<HandoffInfo, HandoffError> {
        let meta = req.meta.to_string();
        if !uuid_shaped(&req.id) { return refused(HandoffErr::BadPart, "a handoff id is a uuid"); }
        if req.size > cfg.max_bytes { return refused(HandoffErr::TooLarge, format!("this server takes at most {} bytes", cfg.max_bytes)); }
        if meta.len() > HANDOFF_META_MAX { return refused(HandoffErr::TooLarge, format!("meta exceeds {HANDOFF_META_MAX} bytes")); }
        if req.size == 0 || u64::from(req.parts) != req.size.div_ceil(HANDOFF_PART as u64) {
            return refused(HandoffErr::BadPart, format!("{} bytes do not make {} parts", req.size, req.parts));
        }
        let sha = req.sha256.to_ascii_lowercase();
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) { return refused(HandoffErr::BadPart, "sha256 is 64 hex digits"); }
        let mut db = self.db();
        let tx = db.transaction()?;
        if let Some((ws, old)) = load(&tx, &req.id)? {
            if ws != who.ws || old.from_device != who.device || old.sha256 != sha || old.size != req.size {
                return refused(HandoffErr::Conflict, "that id is already another handoff");
            }
            return Ok(old);
        }
        let to_user: Option<String> = tx
            .query_row("SELECT user FROM tokens WHERE ws = ?1 AND lower(user) = lower(?2) LIMIT 1", params![who.ws, req.to_user], |r| r.get(0))
            .optional()?;
        let Some(to_user) = to_user else { return refused(HandoffErr::BadTarget, format!("nobody called {} is paired here", req.to_user)) };
        if let Some(d) = &req.to_device {
            let theirs: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM tokens WHERE ws = ?1 AND user = ?2 AND device = ?3)",
                params![who.ws, to_user, d],
                |r| r.get(0),
            )?;
            if !theirs || *d == who.device { return refused(HandoffErr::BadTarget, format!("{d} is not one of {to_user}'s other machines")); }
        }
        let open: i64 = tx.query_row(
            &format!("SELECT COUNT(*) FROM handoffs WHERE ws = ?1 AND lower(from_user) = lower(?2) AND state IN {OPEN}"),
            params![who.ws, who.user],
            |r| r.get(0),
        )?;
        if open >= MAX_OPEN_SENT { return refused(HandoffErr::Quota, format!("at most {MAX_OPEN_SENT} handoffs open at once")); }
        let pending: i64 = tx.query_row(
            &format!("SELECT COALESCE(SUM(size), 0) FROM handoffs WHERE ws = ?1 AND to_user = ?2 AND state IN {OPEN}"),
            params![who.ws, to_user],
            |r| r.get(0),
        )?;
        if pending.saturating_add(req.size as i64) > MAX_PENDING_BYTES.max(cfg.max_bytes as i64) {
            return refused(HandoffErr::Quota, format!("{to_user} already has {pending} bytes waiting"));
        }
        tx.execute(
            "INSERT INTO handoffs (id, ws, from_user, from_device, to_user, to_device, state, meta, size, parts, sha256, created, expires, updated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'uploading', ?7, ?8, ?9, ?10, ?11, ?12, ?11)",
            params![req.id, who.ws, who.user, who.device, to_user, req.to_device, meta, req.size, req.parts, sha, now, now + cfg.ttl_ms],
        )?;
        let h = mine(&tx, who, &req.id)?;
        tx.commit()?;
        Ok(h)
    }

    /// One part, overwritten if sent twice. The last one in seals the blob against its sha256.
    pub fn handoff_put(&self, who: &Identity, id: &str, part: u32, bytes: &[u8], now: i64) -> Result<HandoffInfo, HandoffError> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let h = mine(&tx, who, id)?;
        if h.from_device != who.device || h.state != HandoffState::Uploading || h.expires <= now {
            return refused(HandoffErr::Gone, "this handoff is not taking parts from this machine");
        }
        if part >= h.parts || bytes.len() as u64 != part_len(h.size, h.parts, part) {
            return refused(HandoffErr::BadPart, format!("part {part} is out of range or the wrong length"));
        }
        tx.execute("INSERT OR REPLACE INTO handoff_parts (id, part, data) VALUES (?1, ?2, ?3)", params![id, part, bytes])?;
        tx.execute("UPDATE handoffs SET updated = ?2 WHERE id = ?1", params![id, now])?;
        let held: u32 = tx.query_row("SELECT COUNT(*) FROM handoff_parts WHERE id = ?1", params![id], |r| r.get(0))?;
        if held == h.parts {
            let mut sha = Sha256::new();
            {
                let mut q = tx.prepare("SELECT data FROM handoff_parts WHERE id = ?1 ORDER BY part")?;
                let mut rows = q.query(params![id])?;
                while let Some(r) = rows.next()? { sha.update(r.get::<_, Vec<u8>>(0)?); }
            }
            if hex(&sha.finalize()) != h.sha256 {
                tx.execute("DELETE FROM handoff_parts WHERE id = ?1", params![id])?;
                tx.commit()?;
                return refused(HandoffErr::Checksum, "the parts do not hash to the offered sha256; send them again");
            }
            tx.execute("UPDATE handoffs SET state = 'offered' WHERE id = ?1 AND state = 'uploading'", params![id])?;
        }
        let h = mine(&tx, who, id)?;
        tx.commit()?;
        Ok(h)
    }

    /// Exactly one recipient machine wins; a repeat from the winner is answered as a win.
    pub fn handoff_claim(&self, who: &Identity, id: &str, now: i64) -> Result<HandoffInfo, HandoffError> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let h = mine(&tx, who, id)?;
        if !is_recipient(&h, who) { return refused(HandoffErr::BadTarget, "this handoff is not addressed to this machine"); }
        if h.state == HandoffState::Claimed && is_taker(&h, who) { return Ok(h); }
        let n = tx.execute(
            "UPDATE handoffs SET state = 'claimed', taker = ?2, expires = MAX(expires, ?3), updated = ?4 WHERE id = ?1 AND state = 'offered' AND expires > ?4",
            params![id, who.device, now + CLAIM_HOLD_MS, now],
        )?;
        if n != 1 { return refused(HandoffErr::Gone, "already taken, taken back or expired"); }
        let h = mine(&tx, who, id)?;
        tx.commit()?;
        Ok(h)
    }

    /// One part of a claimed blob, for the machine that claimed it and nobody else.
    pub fn handoff_part(&self, who: &Identity, id: &str, part: u32, now: i64) -> Result<Vec<u8>, HandoffError> {
        let db = self.db();
        let h = mine(&db, who, id)?;
        if h.state != HandoffState::Claimed || !is_taker(&h, who) || h.expires <= now {
            return refused(HandoffErr::Gone, "this machine does not hold a claim on it");
        }
        if part >= h.parts { return refused(HandoffErr::BadPart, format!("part {part} is out of range")); }
        let data = db.query_row("SELECT data FROM handoff_parts WHERE id = ?1 AND part = ?2", params![id, part], |r| r.get(0)).optional()?;
        data.map_or_else(|| refused(HandoffErr::Gone, format!("part {part} is no longer held")), Ok)
    }

    /// The taker has the blob: ownership moves for good. Repeating it is harmless.
    pub fn handoff_complete(&self, who: &Identity, id: &str, now: i64) -> Result<HandoffInfo, HandoffError> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let h = mine(&tx, who, id)?;
        if h.state == HandoffState::Done && is_taker(&h, who) { return Ok(h); }
        if h.state != HandoffState::Claimed || !is_taker(&h, who) || h.expires <= now {
            return refused(HandoffErr::Gone, "this machine does not hold a claim on it");
        }
        close(&tx, id, HandoffState::Claimed, HandoffState::Done, &json!({}), now)?;
        let h = mine(&tx, who, id)?;
        tx.commit()?;
        Ok(h)
    }

    /// The sending machine takes it back, while nobody has claimed it yet.
    pub fn handoff_recall(&self, who: &Identity, id: &str, now: i64) -> Result<HandoffInfo, HandoffError> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let h = mine(&tx, who, id)?;
        let open = matches!(h.state, HandoffState::Uploading | HandoffState::Offered);
        if h.from_device != who.device || !open || !close(&tx, id, h.state, HandoffState::Recalled, &json!({}), now)? {
            return refused(HandoffErr::Gone, "it can no longer be taken back from here");
        }
        let h = mine(&tx, who, id)?;
        tx.commit()?;
        Ok(h)
    }

    /// A recipient says no before claiming, or the taker gives it back before completing.
    pub fn handoff_decline(&self, who: &Identity, id: &str, reason: Option<&str>, now: i64) -> Result<HandoffInfo, HandoffError> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let h = mine(&tx, who, id)?;
        let theirs = match h.state {
            HandoffState::Offered => is_recipient(&h, who),
            HandoffState::Claimed => is_taker(&h, who),
            _ => false,
        };
        let meta = reason.map_or_else(|| json!({}), |r| json!({ "reason": r.chars().take(200).collect::<String>() }));
        if !theirs || !close(&tx, id, h.state, HandoffState::Declined, &meta, now)? {
            return refused(HandoffErr::Gone, "it is not this machine's to decline");
        }
        let h = mine(&tx, who, id)?;
        tx.commit()?;
        Ok(h)
    }

    /// Every handoff a person sends or receives, oldest first, closed ones included. A recipient
    /// never sees one still uploading, and only the sending machine sees `have`.
    pub fn handoffs_for(&self, who: &Identity) -> rusqlite::Result<Vec<HandoffInfo>> {
        let db = self.db();
        let mut q = db.prepare(&format!(
            "SELECT {COLS} FROM handoffs WHERE ws = ?1 AND (lower(from_user) = lower(?2)
               OR (lower(to_user) = lower(?2) AND state != 'uploading')) ORDER BY created, id"
        ))?;
        let rows = q.query_map(params![who.ws, who.user], row_info)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(rows.len());
        for (_, mut h) in rows {
            if h.from_device == who.device { fill_have(&db, &mut h)?; }
            out.push(h);
        }
        Ok(out)
    }

    /// Open handoffs past their TTL expire and lose their parts; closed rows past the keep go.
    /// Returns what expired, with its workspace, so both parties can be told.
    pub fn handoff_sweep(&self, now: i64) -> rusqlite::Result<Vec<(String, HandoffInfo)>> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let due: Vec<(String, String)> = {
            let mut q = tx.prepare(&format!("SELECT id, state FROM handoffs WHERE state IN {OPEN} AND expires <= ?1"))?;
            let rows = q.query_map(params![now], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut moved = Vec::new();
        for (id, state) in due {
            if close(&tx, &id, parse_state(&state), HandoffState::Expired, &json!({}), now)? { moved.extend(load(&tx, &id)?); }
        }
        tx.execute("DELETE FROM handoffs WHERE closed IS NOT NULL AND closed + ?1 < ?2", params![HANDOFF_KEEP_MS, now])?;
        tx.execute("DELETE FROM handoff_parts WHERE id NOT IN (SELECT id FROM handoffs)", [])?;
        tx.commit()?;
        Ok(moved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(key: &str, at: i64) -> NewEvent {
        NewEvent { stream: Stream::Prefs, key: key.into(), at, payload: json!("v") }
    }

    #[test]
    fn an_invite_pays_out_once_and_only_in_time() {
        let s = Store::open_in_memory().unwrap();
        let code = s.create_invite("default", "me", 0).unwrap();
        assert!(code.starts_with("EPSK-") && code.len() == 14, "{code}");
        assert!(s.redeem(&code, "laptop", INVITE_TTL_MS).unwrap().is_none(), "expired");
        let code = s.create_invite("default", "me", 0).unwrap();
        let (token, who) = s.redeem(&code.to_lowercase(), "laptop", 1).unwrap().expect("valid");
        assert_eq!((who.ws.as_str(), who.user.as_str()), ("default", "me"));
        assert!(s.redeem(&code, "desk", 2).unwrap().is_none(), "spent");
        assert_eq!(s.auth(&token).unwrap(), Some(who));
        assert_eq!(s.auth("not-a-token").unwrap(), None);
    }

    #[test]
    fn two_machines_with_one_label_get_two_devices() {
        let s = Store::open_in_memory().unwrap();
        let a = s.redeem(&s.create_invite("default", "me", 0).unwrap(), "MacBook", 1).unwrap().unwrap().1;
        let b = s.redeem(&s.create_invite("default", "me", 0).unwrap(), "MacBook", 1).unwrap().unwrap().1;
        assert_ne!(a.device, b.device);
    }

    #[test]
    fn append_stamps_identity_and_since_pages_in_order() {
        let s = Store::open_in_memory().unwrap();
        let who = Identity { ws: "default".into(), user: "me".into(), device: "d1".into() };
        let out = s.append(&who, &[ev("cc-sort", 5), ev("cc-foot", 6)]).unwrap();
        assert_eq!(out.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(out[0].device, "d1");
        assert_eq!(s.head("default").unwrap(), 2);
        assert_eq!(s.since("default", "me", 0, 1).unwrap()[0].key, "cc-sort");
        assert_eq!(s.since("default", "me", 1, 10).unwrap()[0].key, "cc-foot");
        assert!(s.since("other", "me", 0, 10).unwrap().is_empty(), "workspaces never see each other");
    }

    #[test]
    fn a_teammate_sees_shared_streams_and_none_of_your_personal_ones() {
        let s = Store::open_in_memory().unwrap();
        let me = Identity { ws: "team".into(), user: "me".into(), device: "d1".into() };
        let note = NewEvent { stream: Stream::Notes, key: "n1".into(), at: 1, payload: json!({"text": "hi"}) };
        s.append(&me, &[ev("cc-sort", 1), note]).unwrap();
        let theirs: Vec<_> = s.since("team", "them", 0, 10).unwrap().into_iter().map(|e| e.key).collect();
        assert_eq!(theirs, vec!["n1"]);
        assert_eq!(s.since("team", "me", 0, 10).unwrap().len(), 2);
    }

    #[test]
    fn compaction_keeps_the_latest_per_key_and_anything_recent() {
        let s = Store::open_in_memory().unwrap();
        let who = Identity { ws: "w".into(), user: "me".into(), device: "d".into() };
        s.append_at(&who, &[ev("cc-sort", 1), ev("cc-foot", 1)], 100).unwrap();
        s.append_at(&who, &[ev("cc-sort", 2)], 200).unwrap();
        s.append_at(&who, &[ev("cc-sort", 3)], 10_000).unwrap();
        // Inside the window a superseded event is kept, so a device a day behind still sees it.
        assert_eq!(s.compact(10_050, 9_900).unwrap(), 1, "only the rx-100 cc-sort is both old and superseded");
        let keys: Vec<_> = s.since("w", "me", 0, 10).unwrap().into_iter().map(|e| (e.key, e.at)).collect();
        assert_eq!(keys, vec![("cc-foot".to_string(), 1), ("cc-sort".to_string(), 2), ("cc-sort".to_string(), 3)]);
        assert_eq!(s.compact(1_000_000, 0).unwrap(), 1);
        assert_eq!(s.compact(1_000_000, 0).unwrap(), 0, "the latest per key always stays");
    }

    #[test]
    fn a_workspace_lists_its_own_machines_and_nobody_elses() {
        let s = Store::open_in_memory().unwrap();
        s.redeem(&s.create_invite("team", "me", 0).unwrap(), "Laptop", 1).unwrap();
        s.redeem(&s.create_invite("team", "ana", 0).unwrap(), "Desk", 2).unwrap();
        s.redeem(&s.create_invite("other", "bob", 0).unwrap(), "Box", 3).unwrap();
        let got: Vec<_> = s.devices_in("team").unwrap().into_iter().map(|d| (d.user, d.label)).collect();
        assert_eq!(got, [("me".to_string(), "Laptop".to_string()), ("ana".to_string(), "Desk".to_string())]);
    }

    #[test]
    fn registering_takes_a_free_name_once() {
        let s = Store::open_in_memory().unwrap();
        let (_, who) = s.register("default", "Ana", "Desk", 1).unwrap().unwrap();
        assert_eq!(who.user, "Ana");
        assert!(s.register("default", "ana", "Laptop", 2).unwrap().is_none(), "a name is taken whatever its case");
        assert!(s.register("other", "ana", "Box", 2).unwrap().is_some(), "names are per workspace");
    }

    #[test]
    fn a_name_is_checked_before_it_is_a_user() {
        assert_eq!(valid_name("  Ana   Lopez "), Ok("Ana Lopez".into()));
        assert!(valid_name("").is_err());
        assert!(valid_name("ana; drop").is_err());
        assert!(valid_name(&"a".repeat(41)).is_err());
    }

    #[test]
    fn renaming_carries_the_personal_log_with_it() {
        let s = Store::open_in_memory().unwrap();
        let (token, who) = s.redeem(&s.create_invite("default", "me", 0).unwrap(), "lap", 1).unwrap().unwrap();
        s.append(&who, &[ev("cc-sort", 1)]).unwrap();
        s.register("default", "ana", "desk", 1).unwrap().unwrap();
        assert_eq!(s.rename("me", "ana").unwrap(), None, "a name in use is refused");
        assert_eq!(s.rename("me", "Frederic").unwrap(), Some(1));
        assert_eq!(s.auth(&token).unwrap().unwrap().user, "Frederic");
        assert_eq!(s.since("default", "Frederic", 0, 10).unwrap().len(), 1, "their prefs follow the new name");
        assert!(s.since("default", "me", 0, 10).unwrap().is_empty());
    }

    #[test]
    fn a_revoked_device_is_refused() {
        let s = Store::open_in_memory().unwrap();
        let (token, who) = s.redeem(&s.create_invite("default", "me", 0).unwrap(), "lap", 1).unwrap().unwrap();
        assert_eq!(s.devices().unwrap().len(), 1);
        assert_eq!(s.revoke(&who.device).unwrap().0, 1);
        assert_eq!(s.auth(&token).unwrap(), None);
    }

    #[test]
    fn an_oversized_push_writes_nothing() {
        let s = Store::open_in_memory().unwrap();
        let who = Identity { ws: "default".into(), user: "me".into(), device: "d1".into() };
        let big = NewEvent { payload: json!("x".repeat(MAX_PAYLOAD)), ..ev("cc-sort", 1) };
        assert!(matches!(s.append(&who, &[ev("cc-foot", 1), big]), Err(PushError::TooLarge(_))));
        assert!(matches!(s.append(&who, &[ev("", 1)]), Err(PushError::TooLarge(_))));
        assert_eq!(s.head("default").unwrap(), 0);
    }

    const CFG: HandoffCfg = HandoffCfg { ttl_ms: 72 * 3_600_000, max_bytes: 64 << 20 };

    struct Team {
        s: Store,
        lap: Identity,
        desk: Identity,
        ana: Identity,
        ana2: Identity,
    }

    // Two machines of "me" and two of "Ana", in one workspace.
    fn team() -> Team {
        let s = Store::open_in_memory().unwrap();
        let pair = |user: &str, label: &str| s.redeem(&s.create_invite("w", user, 0).unwrap(), label, 1).unwrap().unwrap().1;
        let (lap, desk) = (pair("me", "Laptop"), pair("me", "Desk"));
        let ana = s.register("w", "Ana", "Mac", 1).unwrap().unwrap().1;
        let ana2 = pair("Ana", "Tower");
        Team { s, lap, desk, ana, ana2 }
    }

    fn uid(n: u32) -> String {
        format!("{n:08x}-0000-4000-8000-000000000000")
    }

    fn blob(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    fn offer(n: u32, to_user: &str, data: &[u8]) -> Offer {
        let size = data.len() as u64;
        let parts = size.div_ceil(HANDOFF_PART as u64) as u32;
        Offer { id: uid(n), to_user: to_user.into(), to_device: None, size, parts, sha256: hex(&Sha256::digest(data)), meta: json!({"v": 1}) }
    }

    fn upload(s: &Store, who: &Identity, id: &str, data: &[u8]) -> HandoffInfo {
        let mut last = None;
        for (i, chunk) in data.chunks(HANDOFF_PART).enumerate() {
            last = Some(s.handoff_put(who, id, i as u32, chunk, 10).unwrap());
        }
        last.unwrap()
    }

    // Offered from the laptop to Ana, two parts' worth.
    fn offered(t: &Team, n: u32) -> (String, Vec<u8>) {
        let data = blob(HANDOFF_PART + 10);
        t.s.handoff_offer(&t.lap, &offer(n, "Ana", &data), &CFG, 0).unwrap();
        assert_eq!(upload(&t.s, &t.lap, &uid(n), &data).state, HandoffState::Offered);
        (uid(n), data)
    }

    fn why<T: std::fmt::Debug>(r: Result<T, HandoffError>) -> HandoffErr {
        match r {
            Err(HandoffError::Refused(e, _)) => e,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    fn held(s: &Store, id: &str) -> i64 {
        s.db().query_row("SELECT COUNT(*) FROM handoff_parts WHERE id = ?1", params![id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn an_offer_must_name_a_real_target_and_a_sane_blob() {
        let t = team();
        let data = blob(10);
        let bad = |o: Offer, who: &Identity| why(t.s.handoff_offer(who, &o, &CFG, 0));
        assert_eq!(bad(offer(1, "nobody", &data), &t.lap), HandoffErr::BadTarget);
        assert_eq!(bad(Offer { to_device: Some(t.desk.device.clone()), ..offer(1, "Ana", &data) }, &t.lap), HandoffErr::BadTarget, "not Ana's machine");
        assert_eq!(bad(Offer { to_device: Some(t.lap.device.clone()), ..offer(1, "me", &data) }, &t.lap), HandoffErr::BadTarget, "the sender itself");
        assert_eq!(bad(Offer { parts: 2, ..offer(1, "Ana", &data) }, &t.lap), HandoffErr::BadPart);
        assert_eq!(bad(Offer { id: "h1".into(), ..offer(1, "Ana", &data) }, &t.lap), HandoffErr::BadPart);
        assert_eq!(bad(Offer { sha256: "xyz".into(), ..offer(1, "Ana", &data) }, &t.lap), HandoffErr::BadPart);
        let big = Offer { size: CFG.max_bytes + 1, parts: (CFG.max_bytes + 1).div_ceil(HANDOFF_PART as u64) as u32, ..offer(1, "Ana", &data) };
        assert_eq!(bad(big, &t.lap), HandoffErr::TooLarge);
        assert_eq!(bad(Offer { meta: json!("x".repeat(HANDOFF_META_MAX)), ..offer(1, "Ana", &data) }, &t.lap), HandoffErr::TooLarge);
        let h = t.s.handoff_offer(&t.lap, &offer(1, "ana", &data), &CFG, 5).unwrap();
        assert_eq!((h.to_user.as_str(), h.from_device.as_str(), h.state, h.expires), ("Ana", t.lap.device.as_str(), HandoffState::Uploading, 5 + CFG.ttl_ms));
        let mine = Offer { to_device: Some(t.desk.device.clone()), ..offer(2, "me", &data) };
        assert!(t.s.handoff_offer(&t.lap, &mine, &CFG, 5).is_ok(), "to another machine of your own");
    }

    #[test]
    fn a_sender_and_a_recipient_each_have_a_quota() {
        let t = team();
        for n in 0..10 { t.s.handoff_offer(&t.lap, &offer(n, "Ana", &blob(10)), &CFG, 0).unwrap(); }
        assert_eq!(why(t.s.handoff_offer(&t.desk, &offer(10, "Ana", &blob(10)), &CFG, 0)), HandoffErr::Quota, "ten open per person");
        let roomy = HandoffCfg { max_bytes: 256 << 20, ..CFG };
        let sized = |n: u32, mb: u64| Offer { size: mb << 20, parts: ((mb << 20) / HANDOFF_PART as u64) as u32, ..offer(n, "me", &blob(1)) };
        t.s.handoff_offer(&t.ana, &sized(20, 200), &roomy, 0).unwrap();
        assert_eq!(why(t.s.handoff_offer(&t.ana, &sized(21, 100), &roomy, 0)), HandoffErr::Quota, "256 MiB waiting per recipient");
    }

    #[test]
    fn the_last_part_seals_the_blob_and_a_bad_sha_starts_over() {
        let t = team();
        let data = blob(HANDOFF_PART + 10);
        t.s.handoff_offer(&t.lap, &offer(1, "Ana", &data), &CFG, 0).unwrap();
        let id = uid(1);
        assert_eq!(why(t.s.handoff_put(&t.lap, &id, 1, &data[..9], 1)), HandoffErr::BadPart, "the wrong length");
        assert_eq!(why(t.s.handoff_put(&t.lap, &id, 2, &data[..10], 1)), HandoffErr::BadPart, "past the last part");
        assert_eq!(why(t.s.handoff_put(&t.desk, &id, 0, &data[..HANDOFF_PART], 1)), HandoffErr::Gone, "another machine");
        let h = t.s.handoff_put(&t.lap, &id, 1, &data[HANDOFF_PART..], 1).unwrap();
        assert_eq!((h.state, h.have), (HandoffState::Uploading, vec![1]));
        assert_eq!(t.s.handoff_put(&t.lap, &id, 0, &data[..HANDOFF_PART], 2).unwrap().state, HandoffState::Offered);

        let wrong = Offer { sha256: hex(&Sha256::digest(b"other")), ..offer(2, "Ana", &data) };
        t.s.handoff_offer(&t.lap, &wrong, &CFG, 0).unwrap();
        t.s.handoff_put(&t.lap, &uid(2), 0, &data[..HANDOFF_PART], 1).unwrap();
        assert_eq!(why(t.s.handoff_put(&t.lap, &uid(2), 1, &data[HANDOFF_PART..], 1)), HandoffErr::Checksum);
        assert_eq!(held(&t.s, &uid(2)), 0);
        assert_eq!(t.s.handoffs_for(&t.lap).unwrap()[1].state, HandoffState::Uploading, "it can be sent again");
    }

    #[test]
    fn offering_again_answers_with_what_arrived() {
        let t = team();
        let data = blob(HANDOFF_PART + 10);
        t.s.handoff_offer(&t.lap, &offer(1, "Ana", &data), &CFG, 0).unwrap();
        t.s.handoff_put(&t.lap, &uid(1), 0, &data[..HANDOFF_PART], 1).unwrap();
        let again = t.s.handoff_offer(&t.lap, &offer(1, "Ana", &data), &CFG, 9).unwrap();
        assert_eq!((again.state, again.have, again.created), (HandoffState::Uploading, vec![0], 0));
        assert_eq!(why(t.s.handoff_offer(&t.desk, &offer(1, "Ana", &data), &CFG, 9)), HandoffErr::Conflict);
        assert_eq!(why(t.s.handoff_offer(&t.lap, &offer(1, "Ana", &blob(3)), &CFG, 9)), HandoffErr::Conflict);
    }

    #[test]
    fn exactly_one_machine_wins_a_claim_and_it_holds_the_blob_an_hour() {
        let t = team();
        let short = HandoffCfg { ttl_ms: 1000, ..CFG };
        let data = blob(10);
        t.s.handoff_offer(&t.lap, &offer(1, "Ana", &data), &short, 0).unwrap();
        let id = uid(1);
        assert_eq!(why(t.s.handoff_claim(&t.ana, &id, 1)), HandoffErr::Gone, "still uploading");
        upload(&t.s, &t.lap, &id, &data);
        assert_eq!(why(t.s.handoff_claim(&t.desk, &id, 1)), HandoffErr::BadTarget, "not addressed to me");
        let won = t.s.handoff_claim(&t.ana, &id, 500).unwrap();
        assert_eq!((won.state, won.taker.as_deref(), won.expires), (HandoffState::Claimed, Some(t.ana.device.as_str()), 500 + CLAIM_HOLD_MS));
        assert_eq!(why(t.s.handoff_claim(&t.ana2, &id, 501)), HandoffErr::Gone, "the loser");
        assert!(t.s.handoff_claim(&t.ana, &id, 502).is_ok(), "a repeat from the winner");
    }

    #[test]
    fn only_the_taker_fetches_and_completes_and_completing_twice_is_harmless() {
        let t = team();
        let (id, data) = offered(&t, 1);
        assert_eq!(why(t.s.handoff_part(&t.ana, &id, 0, 20)), HandoffErr::Gone, "nobody has claimed it");
        t.s.handoff_claim(&t.ana, &id, 20).unwrap();
        assert_eq!(t.s.handoff_part(&t.ana, &id, 1, 21).unwrap(), data[HANDOFF_PART..]);
        assert_eq!(why(t.s.handoff_part(&t.ana, &id, 2, 21)), HandoffErr::BadPart);
        assert_eq!(why(t.s.handoff_part(&t.ana2, &id, 0, 21)), HandoffErr::Gone);
        assert_eq!(why(t.s.handoff_complete(&t.ana2, &id, 21)), HandoffErr::Gone);
        assert_eq!(why(t.s.handoff_complete(&t.lap, &id, 21)), HandoffErr::Gone, "the sender cannot finish it");
        let done = t.s.handoff_complete(&t.ana, &id, 22).unwrap();
        assert_eq!((done.state, done.meta.clone()), (HandoffState::Done, json!({})));
        assert_eq!(held(&t.s, &id), 0);
        assert_eq!(t.s.handoff_complete(&t.ana, &id, 30).unwrap(), done, "idempotent");
        assert_eq!(why(t.s.handoff_part(&t.ana, &id, 0, 31)), HandoffErr::Gone);
    }

    #[test]
    fn taking_back_declining_and_giving_back_belong_to_their_roles() {
        let t = team();
        let (a, _) = offered(&t, 1);
        assert_eq!(why(t.s.handoff_recall(&t.ana, &a, 20)), HandoffErr::Gone, "the recipient cannot recall");
        assert_eq!(why(t.s.handoff_recall(&t.desk, &a, 20)), HandoffErr::Gone, "nor another machine of the sender");
        assert_eq!(t.s.handoff_recall(&t.lap, &a, 20).unwrap().state, HandoffState::Recalled);
        assert_eq!(held(&t.s, &a), 0);

        let (b, _) = offered(&t, 2);
        assert_eq!(why(t.s.handoff_decline(&t.lap, &b, None, 20)), HandoffErr::Gone, "the sender recalls, never declines");
        let no = t.s.handoff_decline(&t.ana2, &b, Some("not today"), 20).unwrap();
        assert_eq!((no.state, no.meta), (HandoffState::Declined, json!({"reason": "not today"})));
        assert_eq!(held(&t.s, &b), 0);

        let (c, _) = offered(&t, 3);
        t.s.handoff_claim(&t.ana, &c, 20).unwrap();
        assert_eq!(why(t.s.handoff_recall(&t.lap, &c, 21)), HandoffErr::Gone, "claimed is past taking back");
        assert_eq!(why(t.s.handoff_decline(&t.ana2, &c, None, 21)), HandoffErr::Gone, "only the taker gives it back");
        assert_eq!(t.s.handoff_decline(&t.ana, &c, None, 21).unwrap().state, HandoffState::Declined);
        assert_eq!(held(&t.s, &c), 0);
    }

    #[test]
    fn the_sweep_expires_open_handoffs_then_forgets_closed_ones_after_a_week() {
        let t = team();
        let short = HandoffCfg { ttl_ms: 1000, ..CFG };
        t.s.handoff_offer(&t.lap, &offer(1, "Ana", &blob(10)), &short, 0).unwrap();
        upload(&t.s, &t.lap, &uid(1), &blob(10));
        t.s.handoff_offer(&t.lap, &offer(2, "Ana", &blob(10)), &short, 0).unwrap();
        upload(&t.s, &t.lap, &uid(2), &blob(10));
        t.s.handoff_claim(&t.ana, &uid(2), 10).unwrap();
        assert!(t.s.handoff_sweep(999).unwrap().is_empty());
        let gone = t.s.handoff_sweep(1000).unwrap();
        assert_eq!(gone.iter().map(|(ws, h)| (ws.as_str(), h.id.clone(), h.state)).collect::<Vec<_>>(), [("w", uid(1), HandoffState::Expired)]);
        assert_eq!(held(&t.s, &uid(1)), 0);
        assert_eq!(why(t.s.handoff_complete(&t.ana, &uid(2), 10 + CLAIM_HOLD_MS)), HandoffErr::Gone, "a claim past its hold");
        assert_eq!(t.s.handoff_sweep(10 + CLAIM_HOLD_MS).unwrap()[0].1.state, HandoffState::Expired);
        assert_eq!(t.s.handoffs_for(&t.ana).unwrap().len(), 2, "kept so an offline sender learns the outcome");
        t.s.handoff_sweep(1000 + HANDOFF_KEEP_MS + 1).unwrap();
        assert_eq!(t.s.handoffs_for(&t.lap).unwrap().len(), 1);
        t.s.handoff_sweep(10 + CLAIM_HOLD_MS + HANDOFF_KEEP_MS + 1).unwrap();
        assert!(t.s.handoffs_for(&t.lap).unwrap().is_empty());
    }

    #[test]
    fn renaming_rewrites_both_ends_of_a_handoff() {
        let t = team();
        offered(&t, 1);
        assert_eq!(t.s.rename("me", "Frederic").unwrap(), Some(2));
        assert_eq!(t.s.rename("Ana", "Anna").unwrap(), Some(2));
        let h = &t.s.handoffs_for(&Identity { user: "frederic".into(), ..t.lap.clone() }).unwrap()[0];
        assert_eq!((h.from_user.as_str(), h.to_user.as_str()), ("Frederic", "Anna"));
    }

    #[test]
    fn revoking_a_machine_ends_its_handoffs_by_role() {
        let t = team();
        let data = blob(10);
        let send = |who: &Identity, o: Offer| {
            t.s.handoff_offer(who, &o, &CFG, 0).unwrap();
            upload(&t.s, who, &o.id, &data);
        };
        send(&t.lap, offer(1, "Ana", &data));
        send(&t.ana, Offer { to_device: Some(t.desk.device.clone()), ..offer(2, "me", &data) });
        send(&t.desk, offer(3, "Ana", &data));
        t.s.handoff_claim(&t.ana2, &uid(3), 20).unwrap();
        let ended = |who: &Identity| {
            let (n, moved) = t.s.revoke_at(&who.device, 30).unwrap();
            assert_eq!(n, 1);
            moved.into_iter().map(|(_, h)| (h.id, h.state)).collect::<Vec<_>>()
        };
        assert_eq!(ended(&t.lap), [(uid(1), HandoffState::Recalled)], "the sender's");
        assert_eq!(ended(&t.ana2), [(uid(3), HandoffState::Expired)], "the taker's");
        assert_eq!(ended(&t.desk), [(uid(2), HandoffState::Recalled)], "the one addressed to it; uid(3) is closed already");
        assert!([1, 2, 3].iter().all(|n| held(&t.s, &uid(*n)) == 0));
    }

    #[test]
    fn revoking_the_sender_leaves_a_claimed_handoff_with_its_taker() {
        let t = team();
        let (id, data) = offered(&t, 1);
        t.s.handoff_claim(&t.ana, &id, 10).unwrap();
        let (_, moved) = t.s.revoke_at(&t.lap.device, 20).unwrap();
        assert!(moved.is_empty());
        assert_eq!(t.s.handoff_part(&t.ana, &id, 1, 30).unwrap(), data[HANDOFF_PART..]);
        assert_eq!(t.s.handoff_complete(&t.ana, &id, 40).unwrap().state, HandoffState::Done);
    }

    #[test]
    fn a_blob_the_server_takes_is_never_over_the_pending_quota() {
        let t = team();
        let big = HandoffCfg { max_bytes: 512 << 20, ..CFG };
        let size: u64 = 300 << 20;
        let o = Offer { size, parts: size.div_ceil(HANDOFF_PART as u64) as u32, ..offer(1, "Ana", &blob(10)) };
        assert_eq!(t.s.handoff_offer(&t.lap, &o, &big, 0).unwrap().state, HandoffState::Uploading);
    }

    #[test]
    fn a_recipient_lists_no_upload_in_progress_and_no_progress() {
        let t = team();
        let data = blob(HANDOFF_PART + 10);
        t.s.handoff_offer(&t.lap, &offer(1, "Ana", &data), &CFG, 0).unwrap();
        t.s.handoff_put(&t.lap, &uid(1), 0, &data[..HANDOFF_PART], 1).unwrap();
        assert_eq!(t.s.handoffs_for(&t.lap).unwrap()[0].have, vec![0]);
        assert!(t.s.handoffs_for(&t.desk).unwrap()[0].have.is_empty(), "the sender's other machine");
        assert!(t.s.handoffs_for(&t.ana).unwrap().is_empty());
        t.s.handoff_put(&t.lap, &uid(1), 1, &data[HANDOFF_PART..], 2).unwrap();
        assert_eq!(t.s.handoffs_for(&t.ana).unwrap()[0].state, HandoffState::Offered);
    }

    #[test]
    fn a_database_from_before_handoff_gains_its_tables_and_features() {
        let old = Connection::open_in_memory().unwrap();
        old.execute_batch(
            "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, stream TEXT NOT NULL, key TEXT NOT NULL,
               actor TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, rx INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE tokens (hash TEXT PRIMARY KEY, ws TEXT NOT NULL, user TEXT NOT NULL, device TEXT NOT NULL,
               label TEXT NOT NULL, created INTEGER NOT NULL);
             INSERT INTO tokens VALUES ('h', 'w', 'me', 'd1', 'Laptop', 1);",
        )
        .unwrap();
        let s = Store::init(old).unwrap();
        assert!(!s.devices_in("w").unwrap()[0].handoff);
        s.set_features("d1", &["memory".into(), "handoff".into(), "Bad Name".into()]).unwrap();
        assert!(s.devices_in("w").unwrap()[0].handoff, "the last hello's features");
        s.set_features("d1", &[]).unwrap();
        assert!(!s.devices_in("w").unwrap()[0].handoff);
        assert!(s.handoffs_for(&Identity { ws: "w".into(), user: "me".into(), device: "d1".into() }).unwrap().is_empty());
    }
}
