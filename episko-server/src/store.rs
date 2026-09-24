//! The one SQLite file: the event log, one-use invites, and the tokens they were traded for.

use episko_proto::{Event, NewEvent, Stream, MAX_PAYLOAD, STREAMS};
use rusqlite::{params, Connection, OptionalExtension};
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
  actor TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS heads ON events (ws, stream, key, seq);
CREATE INDEX IF NOT EXISTS by_ws ON events (ws, seq);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, ws TEXT NOT NULL, user TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, ws TEXT NOT NULL, user TEXT NOT NULL, device TEXT NOT NULL,
  label TEXT NOT NULL, created INTEGER NOT NULL);
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
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn: Mutex::new(conn) })
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
        let token = hex(&random_bytes::<32>());
        let device = hex(&random_bytes::<6>());
        let label: String = label.trim().chars().take(64).collect();
        tx.execute(
            "INSERT INTO tokens (hash, ws, user, device, label, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![token_hash(&token), ws, user, device, label, now],
        )?;
        tx.commit()?;
        Ok(Some((token, Identity { ws, user, device })))
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
                "INSERT INTO events (ws, stream, key, actor, device, at, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![who.ws, e.stream.as_str(), e.key, who.user, who.device, e.at, payload],
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
    fn an_oversized_push_writes_nothing() {
        let s = Store::open_in_memory().unwrap();
        let who = Identity { ws: "default".into(), user: "me".into(), device: "d1".into() };
        let big = NewEvent { payload: json!("x".repeat(MAX_PAYLOAD)), ..ev("cc-sort", 1) };
        assert!(matches!(s.append(&who, &[ev("cc-foot", 1), big]), Err(PushError::TooLarge(_))));
        assert!(matches!(s.append(&who, &[ev("", 1)]), Err(PushError::TooLarge(_))));
        assert_eq!(s.head("default").unwrap(), 0);
    }
}
