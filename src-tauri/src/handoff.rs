//! Handing a stopped session to another machine (docs/handoff.md): the `EPKH` container, the
//! staging folders, the transfer driver ./sync.rs runs on its socket, and the commands.

use crate::git::{self, HandoffGitMeta};
use crate::usage::{self, uuid_shaped};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use episko_proto::{ClientMsg, HandoffCaps, HandoffErr, HandoffInfo, HandoffState, ServerMsg, HANDOFF_META_MAX, HANDOFF_PART};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager, State};

const MAGIC: &[u8] = b"EPKH1\n";
const NAME_MAX: u32 = 256;
/// Puts or fetches outstanding at once; one more goes out per pass of the socket loop.
const IN_FLIGHT: usize = 2;
/// A part nobody answered is asked for again after this long.
const RESEND_AFTER: Duration = Duration::from_secs(60);
const ARCHIVE_KEEP: Duration = Duration::from_secs(14 * 24 * 3600);
/// Room kept in the meta for the git half, which is only known once the code has shipped.
const GIT_META_ROOM: usize = 512;

// ---------- the container ----------

/// The only names a blob may hold; anything else rejects the whole blob.
pub(crate) fn valid_name(n: &str) -> bool {
    let flat = |s: &str| {
        !s.is_empty() && !s.chars().all(|c| c == '.') && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if matches!(n, "manifest.json" | "transcript.jsonl" | "repo.bundle") {
        return true;
    }
    if let Some(rest) = n.strip_prefix("sidecar/tool-results/").or_else(|| n.strip_prefix("sidecar/subagents/")) {
        return flat(rest);
    }
    n.strip_prefix("memory/").is_some_and(usage::valid_memory_name)
}

pub(crate) enum Src {
    File(PathBuf),
    Bytes(Vec<u8>),
}

/// Counts and hashes what passes through, so a blob's sha256 costs no second read.
struct Hashed<W> {
    w: W,
    sha: Sha256,
    n: u64,
}

impl<W: Write> Write for Hashed<W> {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        let k = self.w.write(b)?;
        self.sha.update(&b[..k]);
        self.n += k as u64;
        Ok(k)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.w.flush()
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hash_file(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| format!("read {}: {e}", p.display()))?;
    let mut sha = Sha256::new();
    std::io::copy(&mut f, &mut sha).map_err(|e| format!("read {}: {e}", p.display()))?;
    Ok(hex(&sha.finalize()))
}

/// `"EPKH1\n"`, then per entry `u32 name_len | name | u64 len | bytes`, little-endian.
/// Returns the blob's size and sha256; it is written beside `out` and renamed into place.
pub(crate) fn pack(out: &Path, entries: &[(String, Src)]) -> Result<(u64, String), String> {
    let mut seen = HashSet::new();
    for (n, _) in entries {
        if !valid_name(n) || !seen.insert(n.as_str()) {
            return Err(format!("{n} cannot go in a handoff"));
        }
    }
    let tmp = out.with_extension("tmp");
    let io = |e: std::io::Error| format!("write {}: {e}", tmp.display());
    let f = std::fs::File::create(&tmp).map_err(io)?;
    let mut w = Hashed { w: BufWriter::new(f), sha: Sha256::new(), n: 0 };
    let written = (|| -> Result<(), String> {
        w.write_all(MAGIC).map_err(io)?;
        for (name, src) in entries {
            w.write_all(&(name.len() as u32).to_le_bytes()).map_err(io)?;
            w.write_all(name.as_bytes()).map_err(io)?;
            match src {
                Src::Bytes(b) => {
                    w.write_all(&(b.len() as u64).to_le_bytes()).map_err(io)?;
                    w.write_all(b).map_err(io)?;
                }
                Src::File(p) => {
                    let f = std::fs::File::open(p).map_err(|e| format!("read {}: {e}", p.display()))?;
                    let len = f.metadata().map_err(|e| format!("read {}: {e}", p.display()))?.len();
                    w.write_all(&len.to_le_bytes()).map_err(io)?;
                    let copied = std::io::copy(&mut f.take(len), &mut w).map_err(io)?;
                    if copied != len {
                        return Err(format!("{} changed while it was being packed", p.display()));
                    }
                }
            }
        }
        w.flush().map_err(io)
    })();
    let (size, sha) = (w.n, hex(&w.sha.clone().finalize()));
    drop(w);
    if let Err(e) = written.and_then(|_| std::fs::rename(&tmp, out).map_err(io)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok((size, sha))
}

/// Unpacks `blob` into `into`, replacing it whole; the names, in order. A bad name or a
/// length past the end rejects the blob and leaves nothing behind.
pub(crate) fn unpack(blob: &Path, into: &Path) -> Result<Vec<String>, String> {
    if into.exists() {
        std::fs::remove_dir_all(into).map_err(|e| format!("clear {}: {e}", into.display()))?;
    }
    let got = unpack_into(blob, into);
    if got.is_err() {
        let _ = std::fs::remove_dir_all(into);
    }
    got
}

fn unpack_into(blob: &Path, into: &Path) -> Result<Vec<String>, String> {
    let bad = |why: &str| format!("not a handoff Episko can read: {why}");
    let f = std::fs::File::open(blob).map_err(|e| format!("read {}: {e}", blob.display()))?;
    let mut left = f.metadata().map_err(|e| e.to_string())?.len();
    let mut r = BufReader::new(f);
    let mut magic = [0u8; 6];
    r.read_exact(&mut magic).map_err(|_| bad("too short"))?;
    if magic != MAGIC {
        return Err(bad("no EPKH1 header"));
    }
    left -= MAGIC.len() as u64;
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = Vec::new();
    while left > 0 {
        let mut n4 = [0u8; 4];
        r.read_exact(&mut n4).map_err(|_| bad("cut short"))?;
        let n = u32::from_le_bytes(n4);
        if n == 0 || n > NAME_MAX || u64::from(n) + 12 > left {
            return Err(bad("a name of impossible length"));
        }
        let mut name = vec![0u8; n as usize];
        r.read_exact(&mut name).map_err(|_| bad("cut short"))?;
        let name = String::from_utf8(name).map_err(|_| bad("a name that is not text"))?;
        if !valid_name(&name) || names.contains(&name) {
            return Err(bad(&format!("it holds {name:?}")));
        }
        let mut l8 = [0u8; 8];
        r.read_exact(&mut l8).map_err(|_| bad("cut short"))?;
        let len = u64::from_le_bytes(l8);
        left -= u64::from(n) + 12;
        if len > left {
            return Err(bad(&format!("{name} runs past the end")));
        }
        let dst = into.join(&name);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&dst).map_err(|e| format!("write {}: {e}", dst.display()))?;
        if std::io::copy(&mut (&mut r).take(len), &mut out).map_err(|e| e.to_string())? != len {
            return Err(bad("cut short"));
        }
        left -= len;
        names.push(name);
    }
    Ok(names)
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct FileEntry {
    name: String,
    len: u64,
    sha256: String,
}

/// What the sha-covered blob says about itself; install reads this, never the server's meta.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct Manifest {
    v: u32,
    resume_id: String,
    #[serde(default)]
    sidecar_prefixes: Vec<String>,
    cwd: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    git: Option<HandoffGitMeta>,
    files: Vec<FileEntry>,
}

/// The manifest, with every file it lists checked and nothing unlisted beside it.
fn read_manifest(dir: &Path, names: &[String]) -> Result<Manifest, String> {
    let raw = std::fs::read(dir.join("manifest.json")).map_err(|_| "this handoff has no manifest".to_string())?;
    let m: Manifest = serde_json::from_slice(&raw).map_err(|e| format!("unreadable manifest: {e}"))?;
    if m.v != 1 {
        return Err("this handoff comes from a newer Episko".into());
    }
    let listed: HashSet<&str> = m.files.iter().map(|f| f.name.as_str()).collect();
    if let Some(n) = names.iter().find(|n| *n != "manifest.json" && !listed.contains(n.as_str())) {
        return Err(format!("{n} is not in the manifest"));
    }
    if let Some(f) = m.files.iter().find(|f| f.name == "manifest.json" || !valid_name(&f.name) || !names.contains(&f.name)) {
        return Err(format!("the manifest lists {:?}, which is not in the handoff", f.name));
    }
    for f in &m.files {
        let p = dir.join(&f.name);
        let len = std::fs::metadata(&p).map(|m| m.len()).map_err(|_| format!("{} is missing", f.name))?;
        if len != f.len || hash_file(&p)? != f.sha256 {
            return Err(format!("{} does not match the manifest", f.name));
        }
    }
    Ok(m)
}

// ---------- staging (`<app local data>/handoff/{out,in}`) ----------

/// Not the cache dir: once the sender has archived, a received blob is the only live copy.
pub(crate) fn stage_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("episko")).join("handoff")
}

fn archive_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("handoff").join("handed"))
}

fn staged(stage: &Path, side: &str, id: &str, ext: &str) -> PathBuf {
    stage.join(side).join(format!("{id}.{ext}"))
}

fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn write_json<T: Serialize>(p: &Path, v: &T) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| format!("write {}: {e}", p.display()))
}

/// A packed blob waiting to go; `state` is the last the server said, None until it answered.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
struct OutRec {
    #[serde(default)]
    to_user: String,
    #[serde(default)]
    to_device: Option<String>,
    size: u64,
    parts: u32,
    sha256: String,
    meta: Value,
    #[serde(default)]
    state: Option<HandoffState>,
    /// The server refused the offer for good; a reconnect does not offer it again.
    #[serde(default)]
    refused: bool,
}

/// A refusal no retry of the same offer can fix.
fn permanent(reason: HandoffErr) -> bool {
    matches!(reason, HandoffErr::TooLarge | HandoffErr::BadTarget | HandoffErr::Conflict)
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Got {
    #[default]
    Fetching,
    Fetched,
    Done,
}

/// A blob this machine claimed. Only `Done` (the server's word) lets install touch anything.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
struct InRec {
    size: u64,
    parts: u32,
    sha256: String,
    #[serde(default)]
    meta: Value,
    #[serde(default)]
    got: Got,
    #[serde(default)]
    retried: bool,
    /// The worktree and branch a first install made, so a retry does not make another.
    #[serde(default)]
    applied: Option<(String, String)>,
}

fn drop_in(stage: &Path, id: &str) {
    for ext in ["epkh", "part", "json"] {
        let _ = std::fs::remove_file(staged(stage, "in", id, ext));
    }
    let _ = std::fs::remove_dir_all(stage.join("in").join(id));
}

fn read_part(blob: &Path, part: u32) -> std::io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(blob)?;
    f.seek(SeekFrom::Start(u64::from(part) * HANDOFF_PART as u64))?;
    let mut buf = Vec::with_capacity(HANDOFF_PART);
    f.take(HANDOFF_PART as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

// ---------- the transfer driver, one per connection ----------

/// What the webview hears of a handoff, as `sync-event` `{kind: "handoff", ev}`; part bytes never.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum HandoffEv {
    List { records: Vec<HandoffInfo> },
    Info { info: Box<HandoffInfo> },
    Progress { id: String, dir: &'static str, done: u32, total: u32 },
    Ready { id: String },
    Refused { id: String, reason: HandoffErr, message: String },
}

/// What the commands ask of the connection; `Complete` is the driver's own, after a good sha.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HandoffCtl {
    Offer { id: String },
    Claim { id: String },
    Recall { id: String },
    Decline { id: String, reason: Option<String> },
}

impl HandoffCtl {
    fn id(&self) -> &str {
        match self {
            HandoffCtl::Offer { id } | HandoffCtl::Claim { id } | HandoffCtl::Recall { id } | HandoffCtl::Decline { id, .. } => id,
        }
    }
}

pub(crate) type Step = (Vec<ClientMsg>, Vec<HandoffEv>);

fn join(step: &mut Step, more: Step) {
    step.0.extend(more.0);
    step.1.extend(more.1);
}

fn refuse(id: &str, reason: HandoffErr, message: impl Into<String>) -> Step {
    (vec![], vec![HandoffEv::Refused { id: id.to_string(), reason, message: message.into() }])
}

pub(crate) fn is_handoff(msg: &ServerMsg) -> bool {
    matches!(msg, ServerMsg::HandoffList { .. } | ServerMsg::Handoff { .. } | ServerMsg::HandoffPart { .. } | ServerMsg::HandoffRefused { .. })
}

enum Caps {
    Unheard,
    Absent,
    Known(HandoffCaps),
}

struct Up {
    parts: u32,
    have: BTreeSet<u32>,
    sent: BTreeMap<u32, Instant>,
    resent: bool,
}

struct Down {
    parts: u32,
    next: u32,
    asked: BTreeMap<u32, Instant>,
    held: BTreeMap<u32, Vec<u8>>,
}

/// Rebuilt from the staging folders on every connection: uploads resume from the server's
/// `have`, downloads from the length already staged.
pub(crate) struct Transfers {
    stage: PathBuf,
    me: String,
    caps: Caps,
    held: Vec<HandoffCtl>,
    ups: BTreeMap<String, Up>,
    downs: BTreeMap<String, Down>,
}

impl Transfers {
    pub(crate) fn new(stage: PathBuf) -> Self {
        Transfers { stage, me: String::new(), caps: Caps::Unheard, held: vec![], ups: BTreeMap::new(), downs: BTreeMap::new() }
    }

    fn enabled(&self) -> bool {
        matches!(&self.caps, Caps::Known(c) if c.enabled)
    }

    /// An absent `caps` is an older server: nothing is ever sent to it.
    pub(crate) fn on_welcome(&mut self, device: &str, caps: Option<&HandoffCaps>) -> Step {
        self.me = device.to_string();
        self.caps = caps.map_or(Caps::Absent, |c| Caps::Known(c.clone()));
        let mut step = Step::default();
        for c in std::mem::take(&mut self.held) {
            join(&mut step, self.on_ctl(c));
        }
        step
    }

    pub(crate) fn on_ctl(&mut self, c: HandoffCtl) -> Step {
        if matches!(self.caps, Caps::Unheard) {
            self.held.push(c);
            return Step::default();
        }
        if !self.enabled() {
            let why = if matches!(self.caps, Caps::Absent) { "this sync server predates handoff" } else { "handoff is off on this sync server" };
            return refuse(c.id(), HandoffErr::Off, why);
        }
        match c {
            HandoffCtl::Offer { id } => match self.offer(&id) {
                Ok(m) => (vec![m], vec![]),
                Err((reason, why)) => {
                    self.mark_refused(&id, reason);
                    refuse(&id, reason, why)
                }
            },
            HandoffCtl::Claim { id } => (vec![ClientMsg::HandoffClaim { id }], vec![]),
            HandoffCtl::Recall { id } => (vec![ClientMsg::HandoffRecall { id }], vec![]),
            HandoffCtl::Decline { id, reason } => {
                self.downs.remove(&id);
                (vec![ClientMsg::HandoffDecline { id, reason }], vec![])
            }
        }
    }

    fn offer(&self, id: &str) -> Result<ClientMsg, (HandoffErr, String)> {
        let rec: OutRec = read_json(&staged(&self.stage, "out", id, "json")).ok_or((HandoffErr::Gone, "nothing is packed under this id".to_string()))?;
        if rec.to_user.is_empty() {
            return Err((HandoffErr::BadTarget, "nobody was chosen to receive it".into()));
        }
        if let Caps::Known(c) = &self.caps {
            if rec.size > c.max_bytes {
                return Err((HandoffErr::TooLarge, format!("{} bytes is more than this sync server takes ({})", rec.size, c.max_bytes)));
            }
        }
        Ok(ClientMsg::HandoffOffer {
            id: id.to_string(), to_user: rec.to_user, to_device: rec.to_device, size: rec.size, parts: rec.parts, sha256: rec.sha256, meta: rec.meta,
        })
    }

    /// Packed blobs the server has never acknowledged: offered again after a reconnect.
    fn unsent(&self, records: &[HandoffInfo]) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(self.stage.join("out")) else { return vec![] };
        let mut ids: Vec<String> = rd
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
            .filter(|id| uuid_shaped(id) && !records.iter().any(|r| r.id == *id))
            .filter(|id| read_json::<OutRec>(&staged(&self.stage, "out", id, "json")).is_some_and(|r| r.state.is_none() && !r.refused))
            .collect();
        ids.sort();
        ids
    }

    /// Records a permanent refusal of an offer the server never acknowledged.
    fn mark_refused(&self, id: &str, reason: HandoffErr) {
        let jp = staged(&self.stage, "out", id, "json");
        let Some(mut rec) = read_json::<OutRec>(&jp).filter(|r| permanent(reason) && r.state.is_none() && !r.refused) else { return };
        rec.refused = true;
        if let Err(e) = write_json(&jp, &rec) {
            log::warn!("handoff {id}: {e}");
        }
    }

    /// Commands a connection that never reached its welcome was still holding.
    pub(crate) fn take_held(&mut self) -> Vec<HandoffCtl> {
        std::mem::take(&mut self.held)
    }

    /// A server with handoff off still lists, so senders can reconcile; it is never answered.
    pub(crate) fn on_server(&mut self, msg: &ServerMsg) -> Step {
        let mut step = self.heard(msg);
        if !self.enabled() {
            step.0.clear();
        }
        step
    }

    fn heard(&mut self, msg: &ServerMsg) -> Step {
        match msg {
            ServerMsg::HandoffList { records } => {
                let mut step = (vec![], vec![HandoffEv::List { records: records.clone() }]);
                for r in records {
                    join(&mut step, self.track(r));
                }
                if self.enabled() {
                    for id in self.unsent(records) {
                        match self.offer(&id) {
                            Ok(m) => step.0.push(m),
                            Err((reason, _)) => self.mark_refused(&id, reason),
                        }
                    }
                }
                step
            }
            ServerMsg::Handoff { info } => {
                let mut step = (vec![], vec![HandoffEv::Info { info: info.clone() }]);
                join(&mut step, self.track(info));
                step
            }
            ServerMsg::HandoffPart { id, part, data } => self.on_part(id, *part, data),
            ServerMsg::HandoffRefused { id, reason, message } => self.on_refused(id, *reason, message),
            _ => Step::default(),
        }
    }

    fn track(&mut self, h: &HandoffInfo) -> Step {
        let mut step = Step::default();
        if !uuid_shaped(&h.id) {
            return step;
        }
        let out_json = staged(&self.stage, "out", &h.id, "json");
        if h.from_device == self.me {
            if let Some(mut rec) = read_json::<OutRec>(&out_json) {
                if rec.state != Some(h.state) {
                    rec.state = Some(h.state);
                    if let Err(e) = write_json(&out_json, &rec) {
                        log::warn!("handoff {}: {e}", h.id);
                    }
                }
                if h.state == HandoffState::Uploading && staged(&self.stage, "out", &h.id, "epkh").is_file() {
                    let up = self.ups.entry(h.id.clone()).or_insert_with(|| Up { parts: h.parts, have: BTreeSet::new(), sent: BTreeMap::new(), resent: false });
                    up.have = h.have.iter().copied().collect();
                    let have = &up.have;
                    up.sent.retain(|p, _| !have.contains(p));
                    step.1.push(HandoffEv::Progress { id: h.id.clone(), dir: "out", done: up.have.len() as u32, total: up.parts });
                } else {
                    self.ups.remove(&h.id);
                }
            }
        }
        if !self.me.is_empty() && h.taker.as_deref() == Some(self.me.as_str()) {
            match h.state {
                HandoffState::Claimed => join(&mut step, self.claimed(h)),
                HandoffState::Done => join(&mut step, self.done(&h.id)),
                _ => {}
            }
        }
        let gone = matches!(h.state, HandoffState::Declined | HandoffState::Recalled | HandoffState::Expired);
        if gone && staged(&self.stage, "in", &h.id, "json").exists() {
            self.downs.remove(&h.id);
            drop_in(&self.stage, &h.id);
        }
        step
    }

    fn claimed(&mut self, h: &HandoffInfo) -> Step {
        let id = &h.id;
        let jp = staged(&self.stage, "in", id, "json");
        let fresh = || InRec { size: h.size, parts: h.parts, sha256: h.sha256.clone(), meta: h.meta.clone(), ..Default::default() };
        let mut rec = read_json::<InRec>(&jp).filter(|r| r.sha256 == h.sha256 && r.size == h.size).unwrap_or_else(fresh);
        if rec.got != Got::Fetching {
            return (vec![ClientMsg::HandoffComplete { id: id.clone() }], vec![]);
        }
        if self.downs.contains_key(id) {
            return Step::default();
        }
        if rec.meta.is_null() {
            rec.meta = h.meta.clone();
        }
        let part = staged(&self.stage, "in", id, "part");
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let next = if have >= rec.size { rec.parts } else { (have / HANDOFF_PART as u64) as u32 };
        // Every byte staged: trim to the size, never pad a short last part out to a full one.
        let keep = (u64::from(next) * HANDOFF_PART as u64).min(rec.size);
        let resized = write_json(&jp, &rec).and_then(|_| {
            let f = std::fs::OpenOptions::new().create(true).write(true).truncate(false).open(&part).map_err(|e| e.to_string())?;
            f.set_len(keep).map_err(|e| e.to_string())
        });
        if let Err(e) = resized {
            return refuse(id, HandoffErr::Unknown, format!("could not stage the download: {e}"));
        }
        self.downs.insert(id.clone(), Down { parts: rec.parts, next: next.min(rec.parts), asked: BTreeMap::new(), held: BTreeMap::new() });
        if next >= rec.parts {
            return self.finish(id);
        }
        (vec![], vec![HandoffEv::Progress { id: id.clone(), dir: "in", done: next, total: rec.parts }])
    }

    /// The server says the session is ours: the only moment `Ready` is raised.
    fn done(&mut self, id: &str) -> Step {
        let jp = staged(&self.stage, "in", id, "json");
        let Some(mut rec) = read_json::<InRec>(&jp) else { return Step::default() };
        if !staged(&self.stage, "in", id, "epkh").is_file() {
            self.downs.remove(id);
            drop_in(&self.stage, id);
            return refuse(id, HandoffErr::Gone, "the received session is no longer on this machine; ask for it to be sent again");
        }
        self.downs.remove(id);
        if rec.got != Got::Done {
            rec.got = Got::Done;
            if let Err(e) = write_json(&jp, &rec) {
                return refuse(id, HandoffErr::Unknown, format!("could not record the handoff: {e}"));
            }
        }
        (vec![], vec![HandoffEv::Ready { id: id.to_string() }])
    }

    /// Every part is staged: a good sha completes; a bad one is fetched again once, then refused.
    fn finish(&mut self, id: &str) -> Step {
        let (part, jp) = (staged(&self.stage, "in", id, "part"), staged(&self.stage, "in", id, "json"));
        let Some(mut rec) = read_json::<InRec>(&jp) else {
            self.downs.remove(id);
            return Step::default();
        };
        if hash_file(&part).is_ok_and(|s| s == rec.sha256) {
            self.downs.remove(id);
            rec.got = Got::Fetched;
            let placed = std::fs::rename(&part, staged(&self.stage, "in", id, "epkh")).map_err(|e| e.to_string()).and_then(|_| write_json(&jp, &rec));
            if let Err(e) = placed {
                return refuse(id, HandoffErr::Unknown, format!("could not keep the download: {e}"));
            }
            let total = rec.parts;
            return (vec![ClientMsg::HandoffComplete { id: id.to_string() }], vec![HandoffEv::Progress { id: id.to_string(), dir: "in", done: total, total }]);
        }
        let _ = std::fs::remove_file(&part);
        if !rec.retried {
            rec.retried = true;
            let _ = write_json(&jp, &rec);
            self.downs.insert(id.to_string(), Down { parts: rec.parts, next: 0, asked: BTreeMap::new(), held: BTreeMap::new() });
            return Step::default();
        }
        self.downs.remove(id);
        refuse(id, HandoffErr::Checksum, "what arrived does not match what was sent; give it back so it can be sent again")
    }

    fn on_part(&mut self, id: &str, part: u32, data: &str) -> Step {
        let path = staged(&self.stage, "in", id, "part");
        let Some(d) = self.downs.get_mut(id) else { return Step::default() };
        d.asked.remove(&part);
        if part < d.next || part >= d.parts {
            return Step::default();
        }
        let Ok(bytes) = B64.decode(data) else {
            self.downs.remove(id);
            return refuse(id, HandoffErr::BadPart, "a downloaded part was not base64");
        };
        d.held.insert(part, bytes);
        let before = d.next;
        let appended = (|| -> std::io::Result<()> {
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
            while let Some(b) = d.held.remove(&d.next) {
                f.write_all(&b)?;
                d.next += 1;
            }
            Ok(())
        })();
        let (done, total) = (d.next, d.parts);
        if let Err(e) = appended {
            self.downs.remove(id);
            return refuse(id, HandoffErr::Unknown, format!("could not stage the download: {e}"));
        }
        if done >= total {
            return self.finish(id);
        }
        if done == before {
            return Step::default();
        }
        (vec![], vec![HandoffEv::Progress { id: id.to_string(), dir: "in", done, total }])
    }

    fn on_refused(&mut self, id: &str, reason: HandoffErr, message: &str) -> Step {
        if let Some(up) = self.ups.get_mut(id) {
            // The server dropped the parts and is still taking them: send them all once more.
            if reason == HandoffErr::Checksum && !up.resent {
                up.resent = true;
                up.have.clear();
                up.sent.clear();
                return Step::default();
            }
            self.ups.remove(id);
        }
        self.downs.remove(id);
        self.mark_refused(id, reason);
        refuse(id, reason, message)
    }

    /// At most one new put or fetch, keeping IN_FLIGHT unanswered at once.
    pub(crate) fn pump(&mut self, now: Instant) -> Option<ClientMsg> {
        if !self.enabled() {
            return None;
        }
        let fresh = |t: &Instant| now.saturating_duration_since(*t) < RESEND_AFTER;
        let stage = &self.stage;
        let mut dead = None;
        for (id, up) in self.ups.iter_mut() {
            if up.sent.values().filter(|t| fresh(t)).count() >= IN_FLIGHT {
                continue;
            }
            let Some(part) = (0..up.parts).find(|p| !up.have.contains(p) && !up.sent.get(p).is_some_and(fresh)) else { continue };
            match read_part(&staged(stage, "out", id, "epkh"), part) {
                Ok(bytes) => {
                    up.sent.insert(part, now);
                    return Some(ClientMsg::HandoffPut { id: id.clone(), part, data: B64.encode(bytes) });
                }
                Err(e) => {
                    log::warn!("handoff {id}: the packed blob is unreadable: {e}");
                    dead = Some(id.clone());
                    break;
                }
            }
        }
        if let Some(id) = dead {
            self.ups.remove(&id);
        }
        for (id, d) in self.downs.iter_mut() {
            if d.asked.values().filter(|t| fresh(t)).count() >= IN_FLIGHT {
                continue;
            }
            let Some(part) = (d.next..d.parts).find(|p| !d.held.contains_key(p) && !d.asked.get(p).is_some_and(fresh)) else { continue };
            d.asked.insert(part, now);
            return Some(ClientMsg::HandoffFetch { id: id.clone(), part });
        }
        None
    }
}

// ---------- packing, installing and settling ----------

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct Packed {
    size: u64,
    parts: u32,
    sha256: String,
    left_behind: Vec<String>,
}

/// Memory types a teammate may receive; `user` and `feedback` are about the sender, never theirs.
const TEAM_MEMORY: [&str; 2] = ["project", "reference"];
/// The most memories one handoff carries; handoff.ts narrows the meta to the same.
const MEMORY_MAX: usize = 50;

/// The ticked memories as they travel, `originSessionId` stripped; refused before anything ships.
fn pack_memories(base: &Path, workdir: &str, names: &[String], teammate: bool) -> Result<Vec<(usage::MemoryFile, Vec<u8>)>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    if names.len() > MEMORY_MAX {
        return Err(format!("at most {MEMORY_MAX} memories go with one handoff"));
    }
    let dir = usage::memory_dir(base, workdir).ok_or("this project's memories cannot be found")?;
    let all = usage::list_memories_in(&dir);
    let mut out = Vec::with_capacity(names.len());
    for n in names {
        let f = all.iter().find(|f| &f.name == n).ok_or_else(|| format!("no memory named {n}"))?;
        if teammate && !TEAM_MEMORY.contains(&f.kind.as_str()) {
            let kind = if f.kind.is_empty() { "untyped" } else { &f.kind };
            return Err(format!("{n} is a {kind} memory, which never goes to a teammate"));
        }
        let text = std::fs::read_to_string(dir.join(n)).map_err(|e| format!("read {n}: {e}"))?;
        out.push((f.clone(), usage::strip_origin(&text).into_bytes()));
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)] // the command's own arguments, plus where to read and write
fn pack_in(
    stage: &Path, base: &Path, id: &str, workdir: &str, resume_id: &str, how: &str, memories: &[String], teammate: bool, meta: Value,
) -> Result<Packed, String> {
    if !uuid_shaped(id) {
        return Err(format!("not a handoff id: {id}"));
    }
    let mems = pack_memories(base, workdir, memories, teammate)?;
    let Value::Object(mut meta) = meta else { return Err("a handoff's meta is an object".into()) };
    let provider = meta.get("provider").and_then(Value::as_str).unwrap_or("claude").to_string();
    if provider != "claude" {
        return Err("only a Claude session can be handed over".into());
    }
    let json = staged(stage, "out", id, "json");
    if read_json::<OutRec>(&json).is_some_and(|r| r.state.is_some()) {
        return Err("this handoff was already sent".into());
    }
    std::fs::create_dir_all(stage.join("out")).map_err(|e| e.to_string())?;
    let export = usage::transcript_export_in(base, workdir, resume_id)?;
    let project_id = git::project_id(workdir.to_string());
    for (k, v) in [("v", Value::from(1)), ("resume_id", resume_id.into()), ("provider", provider.clone().into())] {
        meta.insert(k.into(), v);
    }
    if let Some(p) = &project_id {
        meta.insert("project_id".into(), p.clone().into());
    }
    if !mems.is_empty() {
        let list: Vec<&usage::MemoryFile> = mems.iter().map(|(f, _)| f).collect();
        meta.insert("memories".into(), serde_json::to_value(list).map_err(|e| e.to_string())?);
    }
    // Checked before anything is pushed; the git meta still to come is a few hundred bytes.
    if Value::Object(meta.clone()).to_string().len() + GIT_META_ROOM > HANDOFF_META_MAX {
        return Err("the brief is too long to send".into());
    }
    let bundle = staged(stage, "out", id, "bundle");
    let packed = git::handoff_ship(workdir, id, how, &bundle).and_then(|shipped| ship_rest(stage, id, workdir, resume_id, provider, project_id, export, mems, meta, shipped));
    let _ = std::fs::remove_file(&bundle);
    if packed.is_err() && how != "none" {
        // Nothing staged, so nobody will settle this id: take back what was shipped.
        if let Err(e) = git::handoff_forget(workdir, id, how == "branch") {
            log::warn!("handoff {id}: {e}");
        }
    }
    packed
}

#[allow(clippy::too_many_arguments)] // pack_in's state at the moment the code has shipped
fn ship_rest(
    stage: &Path, id: &str, workdir: &str, resume_id: &str, provider: String, project_id: Option<String>, export: usage::TranscriptExport,
    mems: Vec<(usage::MemoryFile, Vec<u8>)>, mut meta: serde_json::Map<String, Value>, shipped: git::Shipped,
) -> Result<Packed, String> {
    let bundle = staged(stage, "out", id, "bundle");
    meta.insert("git".into(), serde_json::to_value(&shipped.git).map_err(|e| e.to_string())?);
    let meta = Value::Object(meta);
    if meta.to_string().len() > HANDOFF_META_MAX {
        return Err("the brief is too long to send".into());
    }
    let mut entries: Vec<(String, Src)> = export.files.into_iter().map(|(n, p)| (n, Src::File(p))).collect();
    if shipped.bundle {
        entries.push(("repo.bundle".into(), Src::File(bundle.clone())));
    }
    entries.extend(mems.into_iter().map(|(f, b)| (format!("memory/{}", f.name), Src::Bytes(b))));
    let mut files = Vec::with_capacity(entries.len());
    for (name, src) in &entries {
        let (len, sha256) = match src {
            Src::File(p) => (std::fs::metadata(p).map_err(|e| format!("read {}: {e}", p.display()))?.len(), hash_file(p)?),
            Src::Bytes(b) => (b.len() as u64, hex(&Sha256::digest(b))),
        };
        files.push(FileEntry { name: name.clone(), len, sha256 });
    }
    let manifest = Manifest {
        v: 1, resume_id: resume_id.into(), sidecar_prefixes: export.prefixes, cwd: workdir.into(), project_id, provider, git: shipped.git, files,
    };
    entries.insert(0, ("manifest.json".into(), Src::Bytes(serde_json::to_vec(&manifest).map_err(|e| e.to_string())?)));
    let (size, sha256) = pack(&staged(stage, "out", id, "epkh"), &entries)?;
    let parts = size.div_ceil(HANDOFF_PART as u64) as u32;
    write_json(&staged(stage, "out", id, "json"), &OutRec { size, parts, sha256: sha256.clone(), meta, ..Default::default() })?;
    Ok(Packed { size, parts, sha256, left_behind: shipped.left_behind })
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub(crate) struct Installed {
    workdir: String,
    resume_id: String,
    branch: Option<String>,
    worktree: bool,
    /// Ticked memories left alone because this machine already had a different one of that name.
    kept: Vec<String>,
    /// `name: reason` for each ticked memory that could not be written; the session lands anyway.
    failed: Vec<String>,
    /// Ticked memories not written because auto memory is off for this project here.
    memory_off: Vec<String>,
}

/// Best effort: a memory is an extra, so no failure here may keep the session from landing.
/// Never replaces a memory already here; one identical to the incoming copy counts as written.
fn install_memories(base: &Path, workdir: &str, dir: &Path, names: &[String], picked: &[String], teammate: bool, out: &mut Installed) {
    if picked.is_empty() {
        return;
    }
    let off = usage::auto_memory_off(base, workdir);
    let to = usage::memory_dir(base, workdir);
    for n in picked {
        if !names.contains(&format!("memory/{n}")) {
            out.failed.push(format!("{n}: did not come with this handoff"));
            continue;
        }
        if off {
            out.memory_off.push(n.clone());
            continue;
        }
        let Ok(text) = std::fs::read_to_string(dir.join("memory").join(n)) else {
            out.failed.push(format!("{n}: unreadable in the handoff"));
            continue;
        };
        let kind = usage::memory_meta(&text).0;
        if teammate && !TEAM_MEMORY.contains(&kind.as_str()) {
            out.failed.push(format!("{n}: a {} memory, which a teammate's handoff may not carry", if kind.is_empty() { "untyped" } else { &kind }));
            continue;
        }
        let Some(to) = &to else {
            out.failed.push(format!("{n}: this project's memory folder cannot be found"));
            continue;
        };
        match usage::write_memory_in(to, n, Some(&text), true) {
            Ok(true) => {}
            Ok(false) if std::fs::read_to_string(to.join(n)).is_ok_and(|have| have == text) => {}
            Ok(false) => out.kept.push(n.clone()),
            Err(e) => out.failed.push(format!("{n}: {e}")),
        }
    }
}

/// Only after the server said `done`: unpack, refuse another project, land the code, file the
/// transcript, add the ticked memories. Every step is safe to repeat, so a failed install is retried.
fn install_in(stage: &Path, base: &Path, id: &str, checkout: &str, memories: &[String], teammate: bool) -> Result<Installed, String> {
    if !uuid_shaped(id) {
        return Err(format!("not a handoff id: {id}"));
    }
    let jp = staged(stage, "in", id, "json");
    let mut rec: InRec = read_json(&jp).ok_or("nothing was received under this id")?;
    if rec.got != Got::Done {
        return Err("not handed over yet: the sender still owns this session".into());
    }
    let dir = stage.join("in").join(id);
    let names = unpack(&staged(stage, "in", id, "epkh"), &dir)?;
    let man = read_manifest(&dir, &names)?;
    if man.provider != "claude" {
        return Err("only a Claude session can be resumed from a handoff".into());
    }
    if man.project_id.is_some() && git::project_id(checkout.to_string()) != man.project_id {
        return Err(format!("{checkout} is a different project from the one this session was handed over in"));
    }
    let (workdir, branch, worktree) = match (&rec.applied, &man.git) {
        (Some((wt, b)), _) => (wt.clone(), Some(b.clone()), true),
        (None, None) => (checkout.to_string(), None, false),
        (None, Some(g)) if g.via == "none" && git::clean_at(checkout, &g.head, g.branch.as_deref()) => (checkout.to_string(), g.branch.clone(), false),
        (None, Some(g)) => {
            let bundle = names.iter().any(|n| n == "repo.bundle").then(|| dir.join("repo.bundle"));
            let a = git::handoff_land(checkout, id, g, bundle.as_deref())?;
            if let Some(l) = &a.leftover {
                log::warn!("handoff {id}: {l}");
            }
            rec.applied = Some((a.worktree.clone(), a.branch.clone()));
            write_json(&jp, &rec)?;
            (a.worktree, Some(a.branch), true)
        }
    };
    let sidecar: Vec<(String, PathBuf)> = names.iter().filter(|n| n.starts_with("sidecar/")).map(|n| (n.clone(), dir.join(n))).collect();
    usage::transcript_import_in(base, &workdir, &man.resume_id, &dir.join("transcript.jsonl"), &sidecar, &man.sidecar_prefixes)?;
    let mut out = Installed { workdir, resume_id: man.resume_id, branch, worktree, ..Default::default() };
    install_memories(base, &out.workdir.clone(), &dir, &names, memories, teammate, &mut out);
    Ok(out)
}

/// Whether the staged send pushed a `handoff/<id>` branch; only then is a remote delete worth a push.
fn pushed_branch(stage: &Path, id: &str) -> bool {
    read_json::<OutRec>(&staged(stage, "out", id, "json")).is_some_and(|r| r.meta.pointer("/git/via").and_then(Value::as_str) == Some("branch"))
}

#[allow(clippy::too_many_arguments)] // the command's own arguments, plus where to read and write
fn settle_in(stage: &Path, archive: &Path, base: &Path, id: &str, dir: &str, workdir: Option<&str>, resume_id: Option<&str>, keep: bool) -> Result<(), String> {
    if !uuid_shaped(id) {
        return Err(format!("not a handoff id: {id}"));
    }
    match dir {
        "out" => {
            if keep {
                let (Some(wd), Some(rid)) = (workdir, resume_id) else { return Err("archiving needs the session's folder and id".into()) };
                usage::transcript_archive_in(base, wd, rid, &archive.join(id))?;
            }
            // Taken back or refused: nobody will fetch the pushed branch, so it goes too.
            if let Some(wd) = workdir {
                if let Err(e) = git::handoff_forget(wd, id, !keep && pushed_branch(stage, id)) {
                    log::warn!("handoff {id}: {e}");
                }
            }
            for ext in ["epkh", "json", "bundle", "tmp"] {
                let _ = std::fs::remove_file(staged(stage, "out", id, ext));
            }
            Ok(())
        }
        "in" => {
            drop_in(stage, id);
            Ok(())
        }
        other => Err(format!("not a handoff direction: {other}")),
    }
}

/// Drops sender archives older than ARCHIVE_KEEP; run once at boot.
fn prune_archive(root: &Path, now: SystemTime) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age > ARCHIVE_KEEP));
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

pub(crate) fn init(app: &AppHandle) {
    if let Ok(root) = archive_root(app) {
        prune_archive(&root, SystemTime::now());
    }
}

// ---------- commands ----------

fn claude_base() -> Result<PathBuf, String> {
    usage::claude_dir().ok_or_else(|| "no home directory".to_string())
}

#[allow(clippy::too_many_arguments)] // the send sheet's whole answer
#[tauri::command(async)]
pub(crate) fn handoff_pack(
    app: AppHandle, id: String, workdir: String, resume_id: String, git: String, memories: Vec<String>, teammate: bool, meta: Value,
) -> Result<Packed, String> {
    pack_in(&stage_dir(&app), &claude_base()?, &id, &workdir, &resume_id, &git, &memories, teammate, meta)
}

/// The project's saved memories the send sheet can tick; empty where auto memory is off.
#[tauri::command(async)]
pub(crate) fn handoff_memories(workdir: String) -> Result<Vec<usage::MemoryFile>, String> {
    let base = claude_base()?;
    if usage::auto_memory_off(&base, &workdir) {
        return Ok(Vec::new());
    }
    Ok(usage::memory_dir(&base, &workdir).map(|d| usage::list_memories_in(&d)).unwrap_or_default())
}

/// Names the recipient and offers the packed blob; `false` when sync is down, in which case
/// the next connection offers it.
#[tauri::command]
pub(crate) fn handoff_send(app: AppHandle, state: State<'_, crate::AppState>, id: String, to_user: String, to_device: Option<String>) -> Result<bool, String> {
    if !uuid_shaped(&id) {
        return Err(format!("not a handoff id: {id}"));
    }
    let json = staged(&stage_dir(&app), "out", &id, "json");
    let mut rec: OutRec = read_json(&json).ok_or("nothing is packed under this id")?;
    if rec.state.is_some() {
        return Err("this handoff was already sent".into());
    }
    (rec.to_user, rec.to_device, rec.refused) = (to_user, to_device, false);
    write_json(&json, &rec)?;
    Ok(crate::sync::send_handoff(&state.sync, HandoffCtl::Offer { id }))
}

fn ask(state: &crate::AppState, c: HandoffCtl) -> Result<(), String> {
    if !uuid_shaped(c.id()) {
        return Err(format!("not a handoff id: {}", c.id()));
    }
    if crate::sync::send_handoff(&state.sync, c) { Ok(()) } else { Err("sync is not connected".into()) }
}

#[tauri::command]
pub(crate) fn handoff_claim(state: State<'_, crate::AppState>, id: String) -> Result<(), String> {
    ask(&state, HandoffCtl::Claim { id })
}

#[tauri::command]
pub(crate) fn handoff_recall(state: State<'_, crate::AppState>, id: String) -> Result<(), String> {
    ask(&state, HandoffCtl::Recall { id })
}

#[tauri::command]
pub(crate) fn handoff_decline(state: State<'_, crate::AppState>, id: String, reason: Option<String>) -> Result<(), String> {
    ask(&state, HandoffCtl::Decline { id, reason })
}

#[tauri::command(async)]
pub(crate) fn handoff_install(app: AppHandle, id: String, checkout: String, memories: Vec<String>, teammate: bool) -> Result<Installed, String> {
    install_in(&stage_dir(&app), &claude_base()?, &id, &checkout, &memories, teammate)
}

#[tauri::command(async)]
pub(crate) fn handoff_settle(app: AppHandle, id: String, dir: String, workdir: Option<String>, resume_id: Option<String>, archive: bool) -> Result<(), String> {
    settle_in(&stage_dir(&app), &archive_root(&app)?, &claude_base()?, &id, &dir, workdir.as_deref(), resume_id.as_deref(), archive)
}

/// A blob staged for sending as `handoff_pack` would leave it, for the sync tests.
#[cfg(test)]
pub(crate) fn stage_out(stage: &Path, id: &str, bytes: &[u8], to_user: &str) -> String {
    std::fs::create_dir_all(stage.join("out")).unwrap();
    std::fs::write(staged(stage, "out", id, "epkh"), bytes).unwrap();
    let sha = hex(&Sha256::digest(bytes));
    let rec = OutRec { to_user: to_user.into(), size: bytes.len() as u64, parts: bytes.len().div_ceil(HANDOFF_PART) as u32, sha256: sha.clone(), meta: serde_json::json!({"v": 1}), ..Default::default() };
    write_json(&staged(stage, "out", id, "json"), &rec).unwrap();
    sha
}

#[cfg(test)]
pub(crate) fn sha_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{git as run_git, scratch_dir};
    use serde_json::json;

    const ID: &str = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const SID: &str = "11111111-2222-4333-8444-555555555555";

    fn caps() -> HandoffCaps {
        HandoffCaps { enabled: true, max_bytes: 64 << 20, part_bytes: HANDOFF_PART as u32, ttl_ms: 3_600_000 }
    }

    fn info(state: HandoffState, from: &str, taker: Option<&str>, size: u64, sha: &str) -> HandoffInfo {
        HandoffInfo {
            id: ID.into(), from_user: "anna".into(), from_device: from.into(), to_user: "ben".into(), to_device: None, state,
            taker: taker.map(str::to_string), meta: json!({"v": 1}), size, parts: size.div_ceil(HANDOFF_PART as u64) as u32,
            sha256: sha.into(), have: vec![], created: 1, expires: 9, updated: 1,
        }
    }

    fn blob(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    fn info_msg(h: HandoffInfo) -> ServerMsg {
        ServerMsg::Handoff { info: Box::new(h) }
    }

    fn part_msg(data: &[u8], part: u32) -> ServerMsg {
        let at = part as usize * HANDOFF_PART;
        let chunk = &data[at..(at + HANDOFF_PART).min(data.len())];
        ServerMsg::HandoffPart { id: ID.into(), part, data: B64.encode(chunk) }
    }

    fn put_part(m: Option<ClientMsg>) -> Option<u32> {
        match m {
            Some(ClientMsg::HandoffPut { part, .. }) => Some(part),
            Some(other) => panic!("expected a put, got {other:?}"),
            None => None,
        }
    }

    fn fetch_part(m: Option<ClientMsg>) -> Option<u32> {
        match m {
            Some(ClientMsg::HandoffFetch { part, .. }) => Some(part),
            Some(other) => panic!("expected a fetch, got {other:?}"),
            None => None,
        }
    }

    #[test]
    fn a_blob_round_trips_through_the_container() {
        let dir = scratch_dir();
        std::fs::write(dir.join("t.jsonl"), "{\"a\":1}\n").unwrap();
        let entries = vec![
            ("manifest.json".to_string(), Src::Bytes(b"{}".to_vec())),
            ("transcript.jsonl".to_string(), Src::File(dir.join("t.jsonl"))),
            ("sidecar/tool-results/r1.txt".to_string(), Src::Bytes(vec![0, 1, 2, 255])),
            ("sidecar/subagents/agent-1.jsonl".to_string(), Src::Bytes(vec![])),
        ];
        let out = dir.join("x.epkh");
        let (size, sha) = pack(&out, &entries).unwrap();
        assert_eq!(size, std::fs::metadata(&out).unwrap().len());
        assert_eq!(sha, hash_file(&out).unwrap());
        let names = unpack(&out, &dir.join("u")).unwrap();
        assert_eq!(names, entries.iter().map(|e| e.0.clone()).collect::<Vec<_>>());
        assert_eq!(std::fs::read(dir.join("u/transcript.jsonl")).unwrap(), b"{\"a\":1}\n");
        assert_eq!(std::fs::read(dir.join("u/sidecar/tool-results/r1.txt")).unwrap(), vec![0, 1, 2, 255]);
        assert!(pack(&dir.join("y.epkh"), &[("notes/x".into(), Src::Bytes(vec![]))]).is_err());
    }

    fn raw_blob(name: &str, body: &[u8]) -> Vec<u8> {
        let mut v = MAGIC.to_vec();
        for (n, b) in [("transcript.jsonl", &b"ok"[..]), (name, body)] {
            v.extend((n.len() as u32).to_le_bytes());
            v.extend(n.as_bytes());
            v.extend((b.len() as u64).to_le_bytes());
            v.extend(b);
        }
        v
    }

    #[test]
    fn one_bad_name_rejects_the_whole_blob() {
        for ok in ["manifest.json", "repo.bundle", "sidecar/tool-results/a.txt", "memory/user_role.md"] {
            assert!(valid_name(ok), "{ok}");
        }
        let bad = ["../x", "/etc/passwd", "C:/x", "sidecar\\tool-results\\a", "notes/x", "sidecar/tool-results/..",
            "sidecar/tool-results/a/b", "sidecar/other/a", "memory/x.txt", "memory/.md", "memory/MEMORY.md", ""];
        let dir = scratch_dir();
        for name in bad {
            assert!(!valid_name(name), "{name}");
            let file = dir.join("bad.epkh");
            std::fs::write(&file, raw_blob(name, b"x")).unwrap();
            let into = dir.join("u");
            assert!(unpack(&file, &into).is_err(), "{name}");
            assert!(!into.exists(), "nothing of {name:?} stays behind");
        }
        let mut cut = raw_blob("repo.bundle", b"abcdef");
        cut.truncate(cut.len() - 2);
        std::fs::write(dir.join("cut.epkh"), cut).unwrap();
        assert!(unpack(&dir.join("cut.epkh"), &dir.join("u")).is_err(), "a length past the end");
    }

    #[test]
    fn an_offer_uploads_two_parts_at_a_time() {
        let stage = scratch_dir();
        let data = blob(2 * HANDOFF_PART + 100);
        let sha = stage_out(&stage, ID, &data, "ben");
        let mut t = Transfers::new(stage.clone());
        assert_eq!(t.on_ctl(HandoffCtl::Offer { id: ID.into() }), Step::default(), "held until the welcome");
        let (msgs, _) = t.on_welcome("d1", Some(&caps()));
        assert!(matches!(&msgs[..], [ClientMsg::HandoffOffer { parts: 3, to_user, .. }] if to_user == "ben"), "{msgs:?}");
        t.on_server(&info_msg(info(HandoffState::Uploading, "d1", None, data.len() as u64, &sha)));
        let now = Instant::now();
        assert_eq!(put_part(t.pump(now)), Some(0));
        assert_eq!(put_part(t.pump(now)), Some(1));
        assert_eq!(put_part(t.pump(now)), None, "two unanswered at most");
        let mut h = info(HandoffState::Uploading, "d1", None, data.len() as u64, &sha);
        h.have = vec![0];
        let (_, evs) = t.on_server(&info_msg(h));
        assert!(evs.contains(&HandoffEv::Progress { id: ID.into(), dir: "out", done: 1, total: 3 }));
        assert_eq!(put_part(t.pump(now)), Some(2));
        assert_eq!(put_part(t.pump(now)), None);
        t.on_server(&info_msg(info(HandoffState::Offered, "d1", None, data.len() as u64, &sha)));
        assert_eq!(put_part(t.pump(now + RESEND_AFTER * 2)), None, "sealed: nothing left to send");
        let rec: OutRec = read_json(&staged(&stage, "out", ID, "json")).unwrap();
        assert_eq!(rec.state, Some(HandoffState::Offered));
    }

    #[test]
    fn a_reconnect_resumes_an_upload_from_have_and_a_lost_put_is_resent() {
        let stage = scratch_dir();
        let data = blob(2 * HANDOFF_PART + 1);
        let sha = stage_out(&stage, ID, &data, "ben");
        let mut t = Transfers::new(stage);
        t.on_welcome("d1", Some(&caps()));
        let mut h = info(HandoffState::Uploading, "d1", None, data.len() as u64, &sha);
        h.have = vec![0, 2];
        let (msgs, _) = t.on_server(&ServerMsg::HandoffList { records: vec![h] });
        assert!(msgs.is_empty(), "a record the server knows is not offered again: {msgs:?}");
        let now = Instant::now();
        assert_eq!(put_part(t.pump(now)), Some(1));
        assert_eq!(put_part(t.pump(now)), None);
        assert_eq!(put_part(t.pump(now + RESEND_AFTER)), Some(1), "unanswered for a minute");
    }

    #[test]
    fn an_unacknowledged_blob_is_offered_on_the_list_and_never_to_an_old_server() {
        let stage = scratch_dir();
        stage_out(&stage, ID, &blob(10), "ben");
        let mut t = Transfers::new(stage.clone());
        t.on_welcome("d1", Some(&caps()));
        let (msgs, _) = t.on_server(&ServerMsg::HandoffList { records: vec![] });
        assert!(matches!(&msgs[..], [ClientMsg::HandoffOffer { .. }]), "{msgs:?}");
        let mut old = Transfers::new(stage);
        old.on_welcome("d1", None);
        let (msgs, evs) = old.on_ctl(HandoffCtl::Claim { id: ID.into() });
        assert!(msgs.is_empty());
        assert!(matches!(&evs[..], [HandoffEv::Refused { reason: HandoffErr::Off, .. }]), "{evs:?}");
        assert_eq!(old.pump(Instant::now()), None);
    }

    #[test]
    fn a_refused_offer_is_not_offered_again_and_an_oversized_one_never_leaves() {
        let stage = scratch_dir();
        stage_out(&stage, ID, &blob(10), "ben");
        let mut t = Transfers::new(stage.clone());
        t.on_welcome("d1", Some(&caps()));
        let (_, evs) = t.on_server(&ServerMsg::HandoffRefused { id: ID.into(), reason: HandoffErr::TooLarge, message: "no".into() });
        assert_eq!(evs.len(), 1);
        let (msgs, _) = t.on_server(&ServerMsg::HandoffList { records: vec![] });
        assert!(msgs.is_empty(), "{msgs:?}");

        let stage = scratch_dir();
        stage_out(&stage, ID, &blob(10), "ben");
        let mut t = Transfers::new(stage.clone());
        t.on_welcome("d1", Some(&HandoffCaps { max_bytes: 5, ..caps() }));
        let (msgs, evs) = t.on_ctl(HandoffCtl::Offer { id: ID.into() });
        assert!(msgs.is_empty() && matches!(&evs[..], [HandoffEv::Refused { reason: HandoffErr::TooLarge, .. }]), "{msgs:?} {evs:?}");
        assert!(read_json::<OutRec>(&staged(&stage, "out", ID, "json")).unwrap().refused);
    }

    #[test]
    fn a_server_with_handoff_off_hears_nothing_back() {
        let stage = scratch_dir();
        let data = blob(100);
        let sha = sha_hex(&data);
        std::fs::create_dir_all(stage.join("in")).unwrap();
        let rec = InRec { size: 100, parts: 1, sha256: sha.clone(), got: Got::Fetched, ..Default::default() };
        write_json(&staged(&stage, "in", ID, "json"), &rec).unwrap();
        let mut t = Transfers::new(stage);
        t.on_welcome("d2", Some(&HandoffCaps { enabled: false, ..caps() }));
        let (msgs, _) = t.on_server(&ServerMsg::HandoffList { records: vec![info(HandoffState::Claimed, "d1", Some("d2"), 100, &sha)] });
        assert!(msgs.is_empty(), "{msgs:?}");
    }

    #[test]
    fn a_part_file_already_whole_completes_without_padding() {
        let stage = scratch_dir();
        let data = blob(HANDOFF_PART + 7);
        let sha = sha_hex(&data);
        std::fs::create_dir_all(stage.join("in")).unwrap();
        std::fs::write(staged(&stage, "in", ID, "part"), &data).unwrap();
        let mut t = Transfers::new(stage.clone());
        t.on_welcome("d2", Some(&caps()));
        let (msgs, _) = t.on_server(&info_msg(info(HandoffState::Claimed, "d1", Some("d2"), data.len() as u64, &sha)));
        assert_eq!(msgs, vec![ClientMsg::HandoffComplete { id: ID.into() }]);
        assert_eq!(std::fs::read(staged(&stage, "in", ID, "epkh")).unwrap(), data);
    }

    #[test]
    fn a_download_appends_resumes_from_the_staged_length_and_is_ready_only_on_done() {
        let stage = scratch_dir();
        let data = blob(2 * HANDOFF_PART + 100);
        let sha = sha_hex(&data);
        let claimed = || info(HandoffState::Claimed, "d1", Some("d2"), data.len() as u64, &sha);
        let mut t = Transfers::new(stage.clone());
        t.on_welcome("d2", Some(&caps()));
        t.on_server(&info_msg(claimed()));
        let now = Instant::now();
        assert_eq!(fetch_part(t.pump(now)), Some(0));
        assert_eq!(fetch_part(t.pump(now)), Some(1));
        assert_eq!(fetch_part(t.pump(now)), None);
        assert_eq!(t.on_server(&part_msg(&data, 1)), Step::default(), "held until part 0");
        let (_, evs) = t.on_server(&part_msg(&data, 0));
        assert_eq!(evs, vec![HandoffEv::Progress { id: ID.into(), dir: "in", done: 2, total: 3 }]);

        // A fresh connection: two parts are already on disk.
        let mut t = Transfers::new(stage.clone());
        t.on_welcome("d2", Some(&caps()));
        t.on_server(&ServerMsg::HandoffList { records: vec![claimed()] });
        assert_eq!(fetch_part(t.pump(now)), Some(2));
        let (msgs, evs) = t.on_server(&part_msg(&data, 2));
        assert_eq!(msgs, vec![ClientMsg::HandoffComplete { id: ID.into() }]);
        assert!(!evs.iter().any(|e| matches!(e, HandoffEv::Ready { .. })), "not ours until done");
        assert_eq!(std::fs::read(staged(&stage, "in", ID, "epkh")).unwrap(), data);

        let (_, evs) = t.on_server(&info_msg(info(HandoffState::Done, "d1", Some("d2"), data.len() as u64, &sha)));
        assert!(evs.contains(&HandoffEv::Ready { id: ID.into() }), "{evs:?}");
        let rec: InRec = read_json(&staged(&stage, "in", ID, "json")).unwrap();
        assert_eq!(rec.got, Got::Done);
    }

    #[test]
    fn a_bad_sha_is_fetched_again_once_then_refused_and_never_completed() {
        let stage = scratch_dir();
        let data = blob(100);
        let mut t = Transfers::new(stage.clone());
        t.on_welcome("d2", Some(&caps()));
        t.on_server(&info_msg(info(HandoffState::Claimed, "d1", Some("d2"), 100, &"0".repeat(64))));
        let now = Instant::now();
        assert_eq!(fetch_part(t.pump(now)), Some(0));
        let (msgs, evs) = t.on_server(&part_msg(&data, 0));
        assert!(msgs.is_empty() && evs.is_empty(), "{msgs:?} {evs:?}");
        assert_eq!(fetch_part(t.pump(now)), Some(0), "fetched once more");
        let (msgs, evs) = t.on_server(&part_msg(&data, 0));
        assert!(msgs.is_empty(), "no Complete after a bad sha: {msgs:?}");
        assert!(matches!(&evs[..], [HandoffEv::Refused { reason: HandoffErr::Checksum, .. }]), "{evs:?}");
        assert!(!staged(&stage, "in", ID, "epkh").exists() && !staged(&stage, "in", ID, "part").exists());
        assert_eq!(t.pump(now), None);
    }

    #[test]
    fn someone_elses_claim_and_a_done_without_a_blob_raise_nothing() {
        let stage = scratch_dir();
        let mut t = Transfers::new(stage);
        t.on_welcome("d2", Some(&caps()));
        let sha = "a".repeat(64);
        let (msgs, evs) = t.on_server(&info_msg(info(HandoffState::Claimed, "d1", Some("d3"), 10, &sha)));
        assert!(msgs.is_empty() && evs.len() == 1, "only the info itself: {evs:?}");
        assert_eq!(t.pump(Instant::now()), None);
        let (_, evs) = t.on_server(&info_msg(info(HandoffState::Done, "d1", Some("d2"), 10, &sha)));
        assert!(!evs.iter().any(|e| matches!(e, HandoffEv::Ready { .. })));
    }

    #[test]
    fn a_done_whose_blob_vanished_says_so_once() {
        let stage = scratch_dir();
        received(&stage, manifest_for(None, b"x"), Got::Fetched);
        std::fs::remove_file(staged(&stage, "in", ID, "epkh")).unwrap();
        let mut t = Transfers::new(stage);
        t.on_welcome("d2", Some(&caps()));
        let done = || info_msg(info(HandoffState::Done, "d1", Some("d2"), 10, &"a".repeat(64)));
        let (_, evs) = t.on_server(&done());
        assert!(evs.iter().any(|e| matches!(e, HandoffEv::Refused { reason: HandoffErr::Gone, .. })), "{evs:?}");
        let (_, evs) = t.on_server(&done());
        assert!(!evs.iter().any(|e| matches!(e, HandoffEv::Refused { .. })), "{evs:?}");
    }

    fn received(stage: &Path, entries: Vec<(String, Src)>, got: Got) {
        std::fs::create_dir_all(stage.join("in")).unwrap();
        let (size, sha256) = pack(&staged(stage, "in", ID, "epkh"), &entries).unwrap();
        let rec = InRec { size, parts: 1, sha256, got, ..Default::default() };
        write_json(&staged(stage, "in", ID, "json"), &rec).unwrap();
    }

    fn manifest_for(project_id: Option<String>, body: &[u8]) -> Vec<(String, Src)> {
        let files = vec![FileEntry { name: "transcript.jsonl".into(), len: body.len() as u64, sha256: sha_hex(body) }];
        let m = Manifest { v: 1, resume_id: SID.into(), sidecar_prefixes: vec![], cwd: "/x".into(), project_id, provider: "claude".into(), git: None, files };
        vec![("manifest.json".into(), Src::Bytes(serde_json::to_vec(&m).unwrap())), ("transcript.jsonl".into(), Src::Bytes(body.to_vec()))]
    }

    #[test]
    fn install_waits_for_done_and_refuses_another_project() {
        let root = scratch_dir();
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q", "-b", "main"]);
        run_git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
        let checkout = repo.to_string_lossy().into_owned();
        let (stage, base) = (root.join("stage"), root.join("claude"));
        let body = b"{\"type\":\"user\"}\n";

        received(&stage, manifest_for(git::project_id(checkout.clone()), body), Got::Fetched);
        let e = install_in(&stage, &base, ID, &checkout, &[], false);
        assert!(e.as_ref().is_err_and(|e| e.contains("not handed over")), "{e:?}");

        received(&stage, manifest_for(Some("git:0000".into()), body), Got::Done);
        let e = install_in(&stage, &base, ID, &checkout, &[], false);
        assert!(e.as_ref().is_err_and(|e| e.contains("different project")), "{e:?}");

        received(&stage, manifest_for(git::project_id(checkout.clone()), body), Got::Done);
        let done = install_in(&stage, &base, ID, &checkout, &[], false).expect("installed");
        assert_eq!((done.workdir.as_str(), done.resume_id.as_str(), done.worktree), (checkout.as_str(), SID, false));
        let filed = usage::project_transcript_dir(&base, &checkout).join(format!("{SID}.jsonl"));
        assert_eq!(std::fs::read(&filed).unwrap(), body);
        assert!(install_in(&stage, &base, ID, &checkout, &[], false).is_ok(), "a retry is harmless");
    }

    #[test]
    fn a_ticked_memory_travels_stripped_and_lands_beside_the_recipients_own() {
        let root = scratch_dir();
        let (sbase, sender) = (root.join("sender-claude"), root.join("sender"));
        std::fs::create_dir_all(&sender).unwrap();
        let cwd = sender.to_string_lossy().into_owned();
        let tdir = usage::project_transcript_dir(&sbase, &cwd);
        std::fs::create_dir_all(&tdir).unwrap();
        std::fs::write(tdir.join(format!("{SID}.jsonl")), "{\"type\":\"user\"}\n").unwrap();
        let mdir = usage::memory_dir(&sbase, &cwd).unwrap();
        std::fs::create_dir_all(&mdir).unwrap();
        let project = "---\nname: wip\ndescription: the parser\nmetadata:\n  type: project\n  originSessionId: 87cba454-0cba-4cd5-84d5-ab14c42b6083\n---\nbody\n";
        std::fs::write(mdir.join("wip.md"), project).unwrap();
        std::fs::write(mdir.join("me.md"), "---\ntype: user\n---\nprivate\n").unwrap();
        let out = root.join("out-stage");

        let e = pack_in(&out, &sbase, ID, &cwd, SID, "none", &["me.md".into()], true, json!({}));
        assert!(e.as_ref().is_err_and(|e| e.contains("never goes to a teammate")), "{e:?}");
        assert!(!staged(&out, "out", ID, "json").exists(), "a refusal stages nothing");
        let e = pack_in(&out, &sbase, ID, &cwd, SID, "none", &vec!["wip.md".to_string(); MEMORY_MAX + 1], false, json!({}));
        assert!(e.as_ref().is_err_and(|e| e.contains("at most")), "{e:?}");
        // My own machine may carry a user memory; a teammate's install must still refuse it.
        let packed = pack_in(&out, &sbase, ID, &cwd, SID, "none", &["wip.md".into(), "me.md".into()], false, json!({"title": "t"})).expect("packed");
        let rec: OutRec = read_json(&staged(&out, "out", ID, "json")).unwrap();
        assert_eq!(rec.meta["memories"][0], json!({"name": "wip.md", "type": "project", "description": "the parser"}));

        let (stage, rbase, recv) = (root.join("in-stage"), root.join("recv-claude"), root.join("recv"));
        std::fs::create_dir_all(stage.join("in")).unwrap();
        std::fs::create_dir_all(&recv).unwrap();
        std::fs::copy(staged(&out, "out", ID, "epkh"), staged(&stage, "in", ID, "epkh")).unwrap();
        let rec = InRec { size: packed.size, parts: packed.parts, sha256: packed.sha256, got: Got::Done, ..Default::default() };
        write_json(&staged(&stage, "in", ID, "json"), &rec).unwrap();
        let checkout = recv.to_string_lossy().into_owned();

        let picked: Vec<String> = ["wip.md", "me.md", "absent.md"].map(String::from).to_vec();
        let done = install_in(&stage, &rbase, ID, &checkout, &picked, true).expect("a memory never fails the install");
        assert!(done.kept.is_empty() && done.memory_off.is_empty());
        assert_eq!(done.failed.len(), 2, "{:?}", done.failed);
        assert!(done.failed[0].starts_with("me.md: a user memory") && done.failed[1].contains("did not come"), "{:?}", done.failed);
        let landed = usage::memory_dir(&rbase, &checkout).unwrap();
        assert!(!landed.join("me.md").exists());
        let text = std::fs::read_to_string(landed.join("wip.md")).unwrap();
        assert!(text.contains("  type: project") && !text.contains("originSessionId"), "{text}");
        assert!(std::fs::read_to_string(landed.join("MEMORY.md")).unwrap().contains("(wip.md)"));

        std::fs::write(landed.join("me.md"), "mine").unwrap();
        let again = install_in(&stage, &rbase, ID, &checkout, &["wip.md".into(), "me.md".into()], false).expect("a retry is harmless");
        assert_eq!(again.kept, vec!["me.md".to_string()], "the copy an earlier attempt wrote is not reported as kept");
        assert!(again.failed.is_empty(), "{:?}", again.failed);

        std::fs::write(rbase.join("settings.json"), r#"{"autoMemoryEnabled": false}"#).unwrap();
        std::fs::remove_file(landed.join("wip.md")).unwrap();
        let off = install_in(&stage, &rbase, ID, &checkout, &["wip.md".into()], true).expect("installed");
        assert_eq!(off.memory_off, vec!["wip.md".to_string()]);
        assert!(!landed.join("wip.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_manifest_that_lies_about_a_file_is_refused() {
        let stage = scratch_dir();
        let mut entries = manifest_for(None, b"one");
        entries[1] = ("transcript.jsonl".into(), Src::Bytes(b"two".to_vec()));
        received(&stage, entries, Got::Done);
        let e = install_in(&stage, &scratch_dir(), ID, &stage.to_string_lossy(), &[], false);
        assert!(e.as_ref().is_err_and(|e| e.contains("does not match")), "{e:?}");

        for name in ["../../x", "memory/absent.md"] {
            let body = b"one";
            let files = vec![
                FileEntry { name: "transcript.jsonl".into(), len: 3, sha256: sha_hex(body) },
                FileEntry { name: name.into(), len: 3, sha256: sha_hex(body) },
            ];
            let m = Manifest { v: 1, resume_id: SID.into(), sidecar_prefixes: vec![], cwd: "/x".into(), project_id: None, provider: "claude".into(), git: None, files };
            received(&stage, vec![("manifest.json".into(), Src::Bytes(serde_json::to_vec(&m).unwrap())), ("transcript.jsonl".into(), Src::Bytes(body.to_vec()))], Got::Done);
            let e = install_in(&stage, &scratch_dir(), ID, &stage.to_string_lossy(), &[], false);
            assert!(e.as_ref().is_err_and(|e| e.contains("not in the handoff")), "{name}: {e:?}");
        }
    }

    #[test]
    fn settling_clears_staging_and_old_archives_go() {
        let stage = scratch_dir();
        stage_out(&stage, ID, b"abc", "ben");
        assert!(!pushed_branch(&stage, ID), "no git meta: nothing was pushed");
        let jp = staged(&stage, "out", ID, "json");
        let mut rec: OutRec = read_json(&jp).unwrap();
        rec.meta = json!({"v": 1, "git": {"via": "branch"}});
        write_json(&jp, &rec).unwrap();
        assert!(pushed_branch(&stage, ID));
        settle_in(&stage, &stage.join("handed"), &stage, ID, "out", None, None, false).unwrap();
        assert!(!staged(&stage, "out", ID, "json").exists() && !staged(&stage, "out", ID, "epkh").exists());
        assert!(settle_in(&stage, &stage, &stage, ID, "out", None, None, true).is_err(), "an archive needs a session");
        assert!(settle_in(&stage, &stage, &stage, "../x", "in", None, None, false).is_err());

        let root = scratch_dir();
        std::fs::create_dir_all(root.join(ID)).unwrap();
        prune_archive(&root, SystemTime::now());
        assert!(root.join(ID).exists(), "a fresh archive stays");
        prune_archive(&root, SystemTime::now() + ARCHIVE_KEEP + Duration::from_secs(60));
        assert!(!root.join(ID).exists());
    }
}
