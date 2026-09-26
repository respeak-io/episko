// Sync's driver (docs/sync.md): watches what this machine writes, owes the server what changed,
// and applies what other machines sent. Every decision is ./sync's; this module only moves data
// between localStorage, the rules and `sync.rs`. With sync unconfigured it does nothing.
import { invoke } from "@tauri-apps/api/core";
import {
  SYNC_DOWN_MS, acceptDetail, acceptPref, acceptUsage, changedDays, mergeScoped, peerDays, peerDetailDays,
  readDetailPeers, readKeyList, readPeers, readStamps, stampKey, syncClass, syncHealth, wins,
  narrowPresence, teamRows, type PresenceItem, type TeamRow,
  type DetailPeers, type NewEvent, type Peers, type Stamps, type Stream, type SyncEvent, type SyncHealth, type WireDetail,
} from "./sync";
import { dayKeyOf, markDetailDirty, rekeyDetail, setPeerUsage, setProjectKeyer, usage, usageDetail } from "./usage";
import { mergeRl, rl, rlScoped } from "./rl";
import { readObj, safeParse } from "./store";
import { applyWire, idOfKey, isRosterKey, mergeWire, rosterWire, wireDiff, type Roster, type Wire } from "./roster";
import {
  FAVORITES, agentByProject, colorOverrides, ghAccountByProject, projGroups, projOrder, shareByProject,
  setFavorites, setProjGroups, setProjOrder,
} from "./state";
import { customIcons } from "./icons";
import { basename } from "./format";
import { LEASE_MS, leaseDue, leaseKey, leaseLive, narrowLease, type Lease } from "./claim";

export interface SyncStatus {
  configured: boolean; url: string; user: string; device: string; label: string; cursor: number;
  connected: boolean; lastOkAt: number | null; error: string | null; halted: boolean;
  headerNames: string[]; // what the proxy headers are called; their values never reach this side
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

const OFF: SyncStatus = { configured: false, url: "", user: "", device: "", label: "", cursor: 0, connected: false, lastOkAt: null, error: null, halted: false, headerNames: [] };
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
// Every entry is a `stream:key` stamp key; prefs and roster entries share one ledger.
const OWED = ["prefs:", "roster:", "notes:", "claims:"];
const dirty = new Set(readKeyList(localStorage.getItem(DIRTY)).filter((k) => OWED.some((p) => k.startsWith(p))));
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

function owe(stream: Stream, key: string, at: number) {
  const sk = stampKey(stream, key);
  dirty.add(sk);
  stamps[sk] = { at, device: status.device };
}

function onLocalWrite(key: string) {
  if (applying || !key.startsWith("cc-")) return;
  const cls = syncClass(key);
  if (cls === "pref") {
    if (!status.configured) return;
    owe("prefs", key, Date.now());
    saveBook();
    schedule(2_000);
  } else if (key in ROSTER_STORES) {
    if (status.configured) void rosterWritten();
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

interface Inflight { owed: Map<string, number>; usage: Record<string, number>; detail: Record<string, number>; rl?: string; scopedAt?: number }
const inflight = new Map<number, Inflight>();
let nextId = 1;
const detailTotal = (day: string) => {
  const d = usageDetail[day];
  return d ? Object.values(d.models).reduce((a, b) => a + b, 0) + Object.values(d.projects).reduce((a, b) => a + b, 0) : 0;
};
const wireDetail = (day: string): WireDetail => {
  const d = usageDetail[day];
  return { models: { ...d.models }, projects: { ...d.projects }, ...(d.names ? { names: { ...d.names } } : {}) };
};

// The team streams' values live with their owners below.
const owedValue = (stream: Stream, key: string): unknown => {
  if (stream === "notes") return team[key] ?? null;
  const l = leases[key];
  return l ? { who: l.who, until: l.until } : null;
};

/** Everything owed right now, as one push; nothing leaves while the server is not answering. */
export function flush() {
  if (!status.connected || !status.device) return;
  const me = status.device, now = Date.now();
  const events: NewEvent[] = [];
  const f: Inflight = { owed: new Map(), usage: {}, detail: {} };
  for (const sk of dirty) {
    const i = sk.indexOf(":");
    const stream = sk.slice(0, i) as Stream, key = sk.slice(i + 1);
    const at = stamps[sk]?.at ?? now;
    const payload = stream === "prefs" ? localStorage.getItem(key) : stream === "roster" ? wire[key] ?? null : owedValue(stream, key);
    events.push({ stream, key, at, payload });
    f.owed.set(sk, at);
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
    inflight.set(id, i === 0 ? f : { owed: new Map(), usage: {}, detail: {} });
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
  for (const [sk, at] of f.owed) if (stamps[sk]?.at === at) dirty.delete(sk);
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
      dirty.delete(k);
      seed.delete(p.key);
      prefsArrived++;
      return true;
    }
    case "roster": {
      const sk = stampKey("roster", ev.key);
      if (ev.device === me || !isRosterKey(ev.key) || !wins(ev, stamps[sk])) return false;
      stamps[sk] = { at: ev.at, device: ev.device };
      dirty.delete(sk);
      if (ev.payload === null || ev.payload === undefined) delete wire[ev.key]; else wire[ev.key] = ev.payload;
      const r = rosterNow();
      if (applyWire(r, ev.key, ev.payload, pathOf, idOf)) saveRoster(r);
      saveWire();
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
    case "notes": return applyTeam(ev);
    case "claims": return applyLease(ev);
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
    for (const k of seed) if (k !== ROSTER_SEED) owe("prefs", k, 1);
    if (seed.has(ROSTER_SEED)) rosterEdited(true);
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
    if (was.connected && !status.connected) {
      log("warn", `sync: disconnected${status.error ? ` (${status.error})` : ""}`);
      presence.clear(); // nobody can vouch for it any more
    }
    render();
  } else if (o.kind === "pushed") pushed(o.id);
  else if (o.msg.t === "welcome") {
    status = { ...status, connected: true, error: null, device: o.msg.device, user: o.msg.user };
    // Whatever was in flight on the old socket is lost with it; the outbox is rebuilt from scratch.
    inflight.clear();
    flush();
    render();
  } else if (o.msg.t === "events") applyAll(o.msg.events, o.msg.more);
  else if (o.msg.t === "presence") {
    const items = narrowPresence(o.msg.items);
    if (items.length) presence.set(o.msg.device, { user: o.msg.user, items }); else presence.delete(o.msg.device);
    onPresence(o.msg.user, o.msg.device, o.msg.items);
    render();
  }
  else if (o.msg.t === "error") log("error", `sync server: ${o.msg.code}: ${o.msg.message}`);
}

export function health(now = Date.now()): SyncHealth {
  return syncHealth(status.configured, status.connected, status.lastOkAt, now);
}
export { SYNC_DOWN_MS };

// ---------- verbs the UI calls ----------

export async function startSync() {
  setProjectKeyer((s) => {
    const id = ids[s.colorKey];
    if (id === undefined && s.colorKey) void resolveIds([s.colorKey]);
    return id || undefined;
  });
  try { status = await invoke<SyncStatus>("sync_start"); } catch (e) { log("warn", `sync_start: ${e}`); }
  render();
  // Ids are worth having unsynced too: they are what keeps two `api` checkouts' spend apart.
  await resolveIds(rosterPaths());
}
export async function pairSync(url: string, code: string, label: string, headers: [string, string][]) {
  status = await invoke<SyncStatus>("sync_pair", { url, code, label, headers });
  // A newly paired machine owes the server all its spend, and offers its prefs (see `seed`).
  dirty.clear();
  seed.clear();
  for (const k of Object.keys(localStorage)) if (syncClass(k) === "pref") seed.add(k);
  seed.add(ROSTER_SEED);
  wire = {};
  saveWire();
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
/** Replaces the proxy headers (an empty list removes them) and reconnects with the new set. */
export async function setSyncHeaders(headers: [string, string][]) {
  status = await invoke<SyncStatus>("sync_set_headers", { headers });
  render();
}
/** A tick from main.ts: renews this machine's leases, sends what is owed, repaints the health. */
export function tickSync(alive: (sessionId: string) => boolean = () => true) {
  renewLeases(alive);
  if (status.connected) flush();
  render();
}
export const todaySent = () => sentLog.filter((e) => dayKeyOf(e.at) === dayKeyOf(Date.now())).length;

// ---------- project identity and the roster (docs/sync.md) ----------

const ROSTER_STORES: Record<string, keyof Roster> = {
  "cc-favorites": "favorites", "cc-proj-order": "order", "cc-proj-groups": "groups", "cc-colors": "colors",
  "cc-custom-icons": "icons", "cc-agent-by-project": "agent", "cc-gh-account": "gh", "cc-episko-share": "share",
};
const IDS = "cc-proj-ids", WIRE = "cc-sync-roster", ROSTER_SEED = "@roster";
// Path → project id, or "" for a folder git gave none (asked again next run, never mid-run).
const ids: Record<string, string> = {};
for (const [p, v] of Object.entries(readObj<unknown>(IDS))) if (typeof v === "string") ids[p] = v;
const asked = new Set<string>();
// The roster as this machine last agreed it with the server, entries for absent projects included.
let wire: Wire = readObj<unknown>(WIRE);

export const projectIdOf = (path: string): string | undefined => ids[path] || undefined;
const idOf = projectIdOf;
function pathOf(id: string): string | undefined {
  const cands = Object.keys(ids).filter((p) => ids[p] === id);
  return cands.find((p) => projOrder.includes(p)) ?? cands.find((p) => FAVORITES.some((f) => f.path === p)) ?? cands[0];
}
const known = (id: string) => pathOf(id) !== undefined;
/** Every id this machine resolved for a folder of that name, if exactly one: a spend row's owner. */
function idForName(name: string): string | undefined {
  const found = new Set(Object.entries(ids).filter(([p, id]) => id && basename(p) === name).map(([, id]) => id));
  return found.size === 1 ? [...found][0] : undefined;
}
/** The ids a project name's spend may sit under, for the fleet's by-name rows. */
export const idsNamed = (name: string): string[] =>
  [...new Set(Object.entries(ids).filter(([p, id]) => id && basename(p) === name).map(([, id]) => id))];

function rosterNow(): Roster {
  return { favorites: FAVORITES, order: projOrder, groups: projGroups, colors: colorOverrides, icons: customIcons, agent: agentByProject, gh: ghAccountByProject, share: shareByProject };
}
function rosterPaths(): string[] {
  const r = rosterNow();
  return [...new Set([
    ...r.favorites.map((f) => f.path), ...r.order, ...Object.keys(r.groups.of),
    ...Object.keys(r.colors), ...Object.keys(r.icons), ...Object.keys(r.agent), ...Object.keys(r.gh), ...Object.keys(r.share),
  ])];
}
function saveRoster(r: Roster) {
  setFavorites(r.favorites); setProjOrder(r.order); setProjGroups(r.groups);
  quiet(() => {
    raw.set.call(localStorage, "cc-favorites", JSON.stringify(r.favorites));
    raw.set.call(localStorage, "cc-proj-order", JSON.stringify(r.order));
    raw.set.call(localStorage, "cc-proj-groups", JSON.stringify(r.groups));
    raw.set.call(localStorage, "cc-colors", JSON.stringify(r.colors));
    raw.set.call(localStorage, "cc-custom-icons", JSON.stringify(r.icons));
    raw.set.call(localStorage, "cc-agent-by-project", JSON.stringify(r.agent));
    raw.set.call(localStorage, "cc-gh-account", JSON.stringify(r.gh));
    raw.set.call(localStorage, "cc-episko-share", JSON.stringify(r.share));
  });
  render();
}
function saveWire() { quiet(() => raw.set.call(localStorage, WIRE, JSON.stringify(wire))); }

/**
 * What changed in the roster, owed to the server. `reveal` is for entries that merely became
 * visible (a pairing, an id resolving): they go at the oldest stamp and never over one the
 * server already holds, so they cannot undo another machine's real edit.
 */
function rosterEdited(reveal: boolean) {
  const next = mergeWire(wire, rosterWire(rosterNow(), idOf), known);
  const changed = wireDiff(wire, next);
  if (!changed.length) return;
  for (const k of changed) {
    if (reveal) {
      if (k in wire) continue;
      wire[k] = next[k];
      owe("roster", k, 1);
    } else owe("roster", k, Date.now());
  }
  if (!reveal) wire = next;
  saveWire();
  saveBook();
  schedule(2_000);
}

/** A roster store was written here: name any new folders first, so the edit speaks in ids. */
async function rosterWritten() {
  await resolveIds(rosterPaths());
  rosterEdited(false);
}

let resolving: Promise<unknown> = Promise.resolve();
/** Asks git for each unknown folder's id, one at a time; then lands whatever was waiting for them. */
function resolveIds(paths: string[]): Promise<unknown> {
  resolving = resolving.then(async () => {
    const fresh = new Set<string>();
    for (const p of paths) {
      if (!p || asked.has(p) || (ids[p] !== undefined && ids[p] !== "")) continue;
      asked.add(p);
      const id = await invoke<string | null>("project_id", { dir: p }).catch(() => null);
      ids[p] = id ?? "";
      if (id) fresh.add(id);
    }
    if (!fresh.size) return;
    quiet(() => raw.set.call(localStorage, IDS, JSON.stringify(ids)));
    const moved = rekeyDetail(usageDetail, idForName);
    if (moved.length) { for (const d of moved) delete sent.detail[d]; markDetailDirty(); }
    if (!status.configured) return;
    const r = rosterNow();
    let changed = false;
    for (const [k, v] of Object.entries(wire)) {
      const id = idOfKey(k);
      if ((id === undefined || fresh.has(id)) && applyWire(r, k, v, pathOf, idOf)) changed = true;
    }
    if (changed) saveRoster(r);
    rosterEdited(true);
  });
  return resolving;
}

// ---------- the team half: shared notes and the work log (docs/sync.md) ----------

// Wire key → value: `<pid>|<note id>` a note, `digest|<pid>|<day>` a work-log line. The file
// in git stays the record wherever a project keeps one; this is the channel beside it.
export interface TeamNote { id: string; text: string; who: string; at: string }
const TEAM = "cc-team-notes";
const team: Record<string, unknown> = readObj<unknown>(TEAM);
function saveTeam() { quiet(() => raw.set.call(localStorage, TEAM, JSON.stringify(team))); }

function narrowNote(v: unknown): Omit<TeamNote, "id"> | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.slice(0, 4000) : "";
  if (!text.trim()) return null;
  return { text, who: typeof o.who === "string" ? o.who.slice(0, 80) : "", at: typeof o.at === "string" ? o.at.slice(0, 32) : "" };
}

function applyTeam(ev: SyncEvent): boolean {
  const sk = stampKey(ev.stream, ev.key);
  if (!wins(ev, stamps[sk])) return false;
  const digest = ev.key.startsWith("digest|");
  if (ev.payload !== null && (digest ? typeof ev.payload !== "string" : !narrowNote(ev.payload))) return false;
  stamps[sk] = { at: ev.at, device: ev.device };
  dirty.delete(sk);
  if (ev.payload === null) delete team[ev.key];
  else team[ev.key] = digest ? String(ev.payload).slice(0, 2000) : narrowNote(ev.payload);
  saveTeam();
  return true;
}

/** The notes this project's team shared through the server. */
export function serverNotes(pid: string | undefined): TeamNote[] {
  if (!pid) return [];
  const out: TeamNote[] = [];
  for (const [k, v] of Object.entries(team)) {
    if (!k.startsWith(`${pid}|`)) continue;
    const n = narrowNote(v);
    if (n) out.push({ id: k.slice(pid.length + 1), ...n });
  }
  return out;
}
/** The project's work-log lines the team published, by day. */
export function serverDigest(pid: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!pid) return out;
  const pre = `digest|${pid}|`;
  for (const [k, v] of Object.entries(team)) if (k.startsWith(pre) && typeof v === "string") out[k.slice(pre.length)] = v;
  return out;
}
function publish(key: string, value: unknown) {
  if (!status.configured) return;
  if (value === null) delete team[key]; else team[key] = value;
  owe("notes", key, Date.now());
  saveTeam();
  saveBook();
  schedule(500);
}
export const publishNote = (pid: string, note: TeamNote | null, id: string) =>
  publish(`${pid}|${id}`, note && { text: note.text, who: note.who, at: note.at });
export const publishDigest = (pid: string, day: string, line: string) => publish(`digest|${pid}|${day}`, line);
export const syncOn = () => status.configured;

// ---------- presence: held in memory, gone with the connection ----------

const presence = new Map<string, { user: string; items: PresenceItem[] }>();
/** Everyone else's open sessions right now, or null when sync is not set up at all. */
export const teamNow = (): TeamRow[] | null => status.configured ? teamRows(Object.fromEntries(presence), status.user) : null;
let beat = "", beatAt = 0;
/** What this machine has open; sent on a change, and repeated inside the server's TTL. */
export function beatPresence(items: PresenceItem[]) {
  if (!status.connected) { beat = ""; return; }
  const j = JSON.stringify(items), now = Date.now();
  if (j === beat && now - beatAt < 15_000) return;
  beat = j; beatAt = now;
  invoke("sync_presence", { items }).catch((e) => log("warn", `sync presence: ${e}`));
}

// ---------- claims as leases (docs/sync.md) ----------

const CLAIMS = "cc-team-claims";
// Everyone's leases as last heard; `sid` marks one this machine holds, and never leaves it.
const leases: Record<string, Lease & { sid?: string }> = {};
for (const [k, v] of Object.entries(readObj<unknown>(CLAIMS))) {
  const l = narrowLease(v);
  const sid = (v as { sid?: unknown })?.sid;
  if (l) leases[k] = typeof sid === "string" ? { ...l, sid } : l;
}
function saveLeases() { quiet(() => raw.set.call(localStorage, CLAIMS, JSON.stringify(leases))); }

function applyLease(ev: SyncEvent): boolean {
  const sk = stampKey("claims", ev.key);
  if (ev.device === status.device || !wins(ev, stamps[sk])) return false;
  const l = ev.payload === null ? null : narrowLease(ev.payload);
  if (ev.payload !== null && !l) return false;
  stamps[sk] = { at: ev.at, device: ev.device };
  if (l) leases[ev.key] = l; else delete leases[ev.key];
  saveLeases();
  return true;
}
function publishLease(key: string) {
  owe("claims", key, Date.now());
  saveLeases();
  saveBook();
  schedule(500);
}

export function leaseFor(pid: string | undefined, kind: "issue" | "pr", number: number): Lease | null {
  if (!pid) return null;
  const l = leases[leaseKey(pid, kind, number)];
  return leaseLive(l, Date.now()) ? l : null;
}
/** A dispatch at shared work: the team sees it within a second, and it lapses with the session. */
export function takeLease(pid: string, kind: "issue" | "pr", number: number, who: string, sid: string) {
  if (!status.configured) return;
  const key = leaseKey(pid, kind, number);
  leases[key] = { who, until: Date.now() + LEASE_MS, sid };
  publishLease(key);
}
/** The session ended: every lease it held goes, rather than waiting out its time. */
export function releaseLeases(sid: string) {
  for (const [k, l] of Object.entries(leases)) if (l.sid === sid) { delete leases[k]; publishLease(k); }
}
function renewLeases(alive: (sid: string) => boolean) {
  const now = Date.now();
  for (const [k, l] of Object.entries(leases)) {
    if (!l.sid) { if (!leaseLive(l, now - LEASE_MS)) delete leases[k]; continue; }
    if (!alive(l.sid)) { delete leases[k]; publishLease(k); }
    else if (leaseDue(l, now)) { l.until = now + LEASE_MS; publishLease(k); }
  }
}
