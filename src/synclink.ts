// Sync's driver (docs/sync.md): watches what this machine writes, owes the server what changed,
// and applies what other machines sent. Every decision is ./sync's; this module only moves data
// between localStorage, the rules and `sync.rs`. With sync unconfigured it does nothing.
import { invoke } from "@tauri-apps/api/core";
import {
  SYNC_DOWN_MS, acceptDetail, acceptPref, acceptUsage, changedDays, mergeScoped, peerDays, peerDetailDays,
  readDetailPeers, readKeyList, readPeers, readStamps, stampKey, syncClass, syncHealth,
  type DetailPeers, type NewEvent, type Peers, type Stamps, type SyncEvent, type SyncHealth, type WireDetail,
} from "./sync";
import { dayKeyOf, setPeerUsage, usage, usageDetail } from "./usage";
import { mergeRl, rl, rlScoped } from "./rl";
import { readObj, safeParse } from "./store";

export interface SyncStatus {
  configured: boolean; url: string; user: string; device: string; label: string; cursor: number;
  connected: boolean; lastOkAt: number | null; error: string | null; halted: boolean;
}
type ServerMsg =
  | { t: "welcome"; user: string; device: string; head: number }
  | { t: "events"; events: SyncEvent[]; more: boolean }
  | { t: "error"; code: string; message: string }
  | { t: "presence"; user: string; device: string; items: unknown }
  | { t: "paired" | "pushed" };
export type SyncOut =
  | { kind: "status"; status: SyncStatus }
  | { kind: "server"; msg: ServerMsg }
  | { kind: "pushed"; id: number; seqs: number[] };

const OFF: SyncStatus = { configured: false, url: "", user: "", device: "", label: "", cursor: 0, connected: false, lastOkAt: null, error: null, halted: false };
export let status: SyncStatus = OFF;
/** Remote prefs were written: they take effect on the next reload, and the UI says so. */
export let prefsArrived = 0;
/** What this device sent, newest first, for Settings › Sync's debug list. Memory only. */
export const sentLog: { at: number; stream: string; key: string }[] = [];

let render: () => void = () => {};
let log: (lvl: "info" | "warn" | "error", msg: string) => void = () => {};
let onForeign: (ev: SyncEvent) => boolean = () => false;
let onPresence: (user: string, device: string, items: unknown) => void = () => {};
export function setSyncHost(h: {
  render: () => void; log: typeof log;
  /** Streams owned elsewhere (roster, notes, claims): true when the event was taken. */
  foreign?: (ev: SyncEvent) => boolean;
  presence?: (user: string, device: string, items: unknown) => void;
}) { render = h.render; log = h.log; if (h.foreign) onForeign = h.foreign; if (h.presence) onPresence = h.presence; }

// ---------- what this machine owes ----------

const STAMPS = "cc-sync-stamps", DIRTY = "cc-sync-dirty", SENT = "cc-sync-sent", LIMITS = "cc-sync-limits", SEED = "cc-sync-seed";
const stamps: Stamps = readStamps(localStorage.getItem(STAMPS));
const dirty = new Set(readKeyList(localStorage.getItem(DIRTY)));
// A newly paired machine's prefs, offered only after its first catch-up and only where the
// server had nothing: joining an existing setup adopts it rather than overwriting it.
const seed = new Set(readKeyList(localStorage.getItem(SEED)));
interface Sent { usage: Record<string, number>; detail: Record<string, number>; rl: string; scopedAt: number }
const numRec = (v: unknown): Record<string, number> => {
  const o: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, n] of Object.entries(v)) if (typeof n === "number" && Number.isFinite(n)) o[k] = n;
  return o;
};
const sentRaw = readObj<unknown>(SENT);
const sent: Sent = {
  usage: numRec(sentRaw.usage), detail: numRec(sentRaw.detail),
  rl: typeof sentRaw.rl === "string" ? sentRaw.rl : "",
  scopedAt: typeof sentRaw.scopedAt === "number" ? sentRaw.scopedAt : 0,
};
{
  const held = mergeScoped(null, safeParse(localStorage.getItem(LIMITS)));
  if (held && held.at > rlScoped.at) { rlScoped.at = held.at; rlScoped.wins = held.wins ?? []; }
}
let peers: Peers = readPeers(localStorage.getItem("cc-usage-peers"));
let detailPeers: DetailPeers = readDetailPeers(localStorage.getItem("cc-detail-peers"));
setPeerUsage(peerDays(peers), peerDetailDays(detailPeers));

let applying = false; // writes made while applying a remote event are not ours to send back
const raw = { set: Storage.prototype.setItem, remove: Storage.prototype.removeItem };
function quiet(fn: () => void) { applying = true; try { fn(); } finally { applying = false; } }
function saveBook() {
  quiet(() => {
    raw.set.call(localStorage, STAMPS, JSON.stringify(stamps));
    raw.set.call(localStorage, DIRTY, JSON.stringify([...dirty]));
    raw.set.call(localStorage, SENT, JSON.stringify(sent));
    raw.set.call(localStorage, SEED, JSON.stringify([...seed]));
  });
}

let flushTimer: number | undefined;
function schedule(ms: number) {
  if (!status.configured) return;
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(() => { flushTimer = undefined; flush(); }, ms);
}

function onLocalWrite(key: string) {
  if (applying || !key.startsWith("cc-")) return;
  const cls = syncClass(key);
  if (cls === "pref") {
    dirty.add(key);
    stamps[stampKey("prefs", key)] = { at: Date.now(), device: status.device };
    saveBook();
    schedule(2_000);
  } else if (key === "cc-usage") schedule(15_000);
  else if (key === "cc-usage-detail") schedule(30_000);
}

/** One choke point for every write in the app, so no call site has to remember sync exists. */
export function hookStorage() {
  Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
    raw.set.call(this, k, v);
    if (this === localStorage) onLocalWrite(k);
  };
  Storage.prototype.removeItem = function (this: Storage, k: string) {
    raw.remove.call(this, k);
    if (this === localStorage) onLocalWrite(k);
  };
}

// ---------- the outbox ----------

interface Inflight { prefs: Map<string, number>; usage: Record<string, number>; detail: Record<string, number>; rl?: string; scopedAt?: number }
const inflight = new Map<number, Inflight>();
let nextId = 1;
const detailTotal = (day: string) => {
  const d = usageDetail[day];
  return d ? Object.values(d.models).reduce((a, b) => a + b, 0) + Object.values(d.projects).reduce((a, b) => a + b, 0) : 0;
};
const wireDetail = (day: string): WireDetail => ({ models: { ...usageDetail[day].models }, projects: { ...usageDetail[day].projects } });

/** Everything owed right now, as one push; nothing leaves while the server is not answering. */
export function flush() {
  if (!status.connected || !status.device) return;
  const me = status.device, now = Date.now();
  const events: NewEvent[] = [];
  const f: Inflight = { prefs: new Map(), usage: {}, detail: {} };
  for (const key of dirty) {
    const at = stamps[stampKey("prefs", key)]?.at ?? now;
    events.push({ stream: "prefs", key, at, payload: localStorage.getItem(key) });
    f.prefs.set(key, at);
  }
  for (const day of changedDays(usage, sent.usage)) {
    events.push({ stream: "usage", key: `${day}|${me}`, at: now, payload: usage[day] });
    f.usage[day] = usage[day];
  }
  const detailNow: Record<string, number> = {};
  for (const day of Object.keys(usageDetail)) detailNow[day] = detailTotal(day);
  for (const day of changedDays(detailNow, sent.detail)) {
    events.push({ stream: "detail", key: `${day}|${me}`, at: now, payload: wireDetail(day) });
    f.detail[day] = detailNow[day];
  }
  const rlNow = JSON.stringify(rl);
  if (rl.h5 !== null || rl.d7 !== null) {
    if (rlNow !== sent.rl) { events.push({ stream: "limits", key: "rl", at: now, payload: { ...rl } }); f.rl = rlNow; }
  }
  if (rlScoped.at > sent.scopedAt && rlScoped.avail) {
    events.push({ stream: "limits", key: "scoped", at: rlScoped.at, payload: { at: rlScoped.at, wins: rlScoped.wins } });
    f.scopedAt = rlScoped.at;
  }
  if (!events.length) return;
  // The server takes at most 1000 per push; a first sync of a long history is several.
  for (let i = 0; i < events.length; i += 900) {
    const chunk = events.slice(i, i + 900);
    const id = nextId++;
    inflight.set(id, i === 0 ? f : { prefs: new Map(), usage: {}, detail: {} });
    for (const e of chunk) sentLog.unshift({ at: now, stream: e.stream, key: e.key });
    invoke<boolean>("sync_push", { id, events: chunk }).catch((e) => log("warn", `sync push: ${e}`));
  }
  sentLog.splice(200);
}

function pushed(id: number) {
  const f = inflight.get(id);
  if (!f) return;
  inflight.delete(id);
  // A key edited again while its push was in flight stays owed: its stamp has moved on.
  for (const [key, at] of f.prefs) if (stamps[stampKey("prefs", key)]?.at === at) dirty.delete(key);
  Object.assign(sent.usage, f.usage);
  Object.assign(sent.detail, f.detail);
  if (f.rl !== undefined) sent.rl = f.rl;
  if (f.scopedAt !== undefined) sent.scopedAt = f.scopedAt;
  saveBook();
}

// ---------- what arrives ----------

function apply(ev: SyncEvent): boolean {
  const me = status.device;
  switch (ev.stream) {
    case "prefs": {
      const k = stampKey("prefs", ev.key);
      const p = acceptPref(ev, stamps[k], me);
      if (!p) return false;
      quiet(() => (p.value === null ? raw.remove.call(localStorage, p.key) : raw.set.call(localStorage, p.key, p.value)));
      stamps[k] = { at: ev.at, device: ev.device };
      dirty.delete(p.key);
      seed.delete(p.key);
      prefsArrived++;
      return true;
    }
    case "usage": return acceptUsage(peers, ev, me);
    case "detail": return acceptDetail(detailPeers, ev, me);
    case "limits": {
      if (ev.device === me || !ev.payload || typeof ev.payload !== "object") return false;
      const p = ev.payload as Record<string, unknown>;
      if (ev.key === "rl") {
        [rl.h5, rl.h5Reset] = mergeRl(rl.h5, rl.h5Reset, p.h5, p.h5Reset);
        [rl.d7, rl.d7Reset] = mergeRl(rl.d7, rl.d7Reset, p.d7, p.d7Reset);
        return true;
      }
      if (ev.key === "scoped") {
        const held = { at: rlScoped.at, wins: rlScoped.wins };
        const next = mergeScoped(held, p);
        if (!next || next === held) return false;
        rlScoped.at = next.at; rlScoped.wins = next.wins ?? []; rlScoped.avail = true;
        quiet(() => raw.set.call(localStorage, LIMITS, JSON.stringify(next)));
        return true;
      }
      return false;
    }
    default: return onForeign(ev);
  }
}

function applyAll(events: SyncEvent[], more: boolean) {
  let usageMoved = false, prefsBefore = prefsArrived, top = 0;
  for (const ev of events) {
    if (!ev || typeof ev.seq !== "number") continue;
    top = Math.max(top, ev.seq);
    try {
      if (apply(ev) && (ev.stream === "usage" || ev.stream === "detail")) usageMoved = true;
    } catch (e) { log("warn", `sync: skipped ${ev.stream}:${ev.key} (${e})`); }
  }
  if (usageMoved) {
    setPeerUsage(peerDays(peers), peerDetailDays(detailPeers));
    quiet(() => {
      raw.set.call(localStorage, "cc-usage-peers", JSON.stringify(peers));
      raw.set.call(localStorage, "cc-detail-peers", JSON.stringify(detailPeers));
    });
  }
  if (!more && seed.size) {
    // Caught up: what the server never had is this machine's to give, at the oldest possible stamp.
    for (const k of seed) { dirty.add(k); stamps[stampKey("prefs", k)] = { at: 1, device: status.device }; }
    seed.clear();
    flush();
  }
  saveBook();
  if (prefsArrived > prefsBefore) log("info", `sync: ${prefsArrived - prefsBefore} preference(s) from another machine, applied on reload`);
  if (top) invoke("sync_ack", { seq: top }).catch((e) => log("warn", `sync ack: ${e}`));
  render();
}

/** main.ts's `sync-event` listener. */
export function onSyncEvent(o: SyncOut) {
  if (o.kind === "status") {
    const was = status;
    status = o.status;
    if (was.connected && !status.connected) log("warn", `sync: disconnected${status.error ? ` (${status.error})` : ""}`);
    render();
  } else if (o.kind === "pushed") pushed(o.id);
  else if (o.msg.t === "welcome") {
    status = { ...status, connected: true, error: null, device: o.msg.device, user: o.msg.user };
    // Whatever was in flight on the old socket is lost with it; the outbox is rebuilt from scratch.
    inflight.clear();
    flush();
    render();
  } else if (o.msg.t === "events") applyAll(o.msg.events, o.msg.more);
  else if (o.msg.t === "presence") onPresence(o.msg.user, o.msg.device, o.msg.items);
  else if (o.msg.t === "error") log("error", `sync server: ${o.msg.code}: ${o.msg.message}`);
}

export function health(now = Date.now()): SyncHealth {
  return syncHealth(status.configured, status.connected, status.lastOkAt, now);
}
export { SYNC_DOWN_MS };

// ---------- verbs the UI calls ----------

export async function startSync() {
  try { status = await invoke<SyncStatus>("sync_start"); } catch (e) { log("warn", `sync_start: ${e}`); }
  render();
}
export async function pairSync(url: string, code: string, label: string) {
  status = await invoke<SyncStatus>("sync_pair", { url, code, label });
  // A newly paired machine owes the server all its spend, and offers its prefs (see `seed`).
  dirty.clear();
  seed.clear();
  for (const k of Object.keys(localStorage)) if (syncClass(k) === "pref") seed.add(k);
  sent.usage = {}; sent.detail = {}; sent.rl = ""; sent.scopedAt = 0;
  saveBook();
  render();
}
export async function forgetSync() {
  status = await invoke<SyncStatus>("sync_forget");
  inflight.clear();
  render();
}
export function reconnectSync() { void invoke("sync_reconnect"); }
/** A tick from main.ts: sends what the last minute left owed, and repaints the health. */
export function tickSync() { if (status.connected) flush(); render(); }
export const todaySent = () => sentLog.filter((e) => dayKeyOf(e.at) === dayKeyOf(Date.now())).length;
