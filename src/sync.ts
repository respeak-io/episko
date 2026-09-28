// Sync's rules: which `cc-` keys may leave the machine, how a remote event merges, and when
// the app must say sync is down. The server accelerates git and localStorage and is never the
// authority (docs/sync.md). Pure: storage is handed in, so nothing here can read a key the
// allowlist did not name — test/sync.test.ts holds that against the source.
import { safeParse } from "./store";

/** `pref` and `account` sync; `roster` waits on project identity; `local` never leaves. */
export type SyncClass = "pref" | "account" | "roster" | "local";

// An ALLOWLIST: a key missing here does not sync, and test/sync.test.ts fails until every
// `"cc-` literal in src/ is classified. Anything that changes what runs, or what is permitted,
// is `local` — that is why the permission modes, trust list, task rules and auto-fetch stay.
export const SYNC_KEYS: Readonly<Record<string, SyncClass>> = {
  "cc-keys": "pref", "cc-sound": "pref", "cc-motion": "pref", "cc-foot": "pref",
  "cc-title": "pref", "cc-term-engine": "pref", "cc-term-font": "pref", "cc-term-split": "pref",
  "cc-agent": "pref", "cc-diff-mode": "pref", "cc-scrollback": "pref", "cc-sort": "pref",
  "cc-fleet-sort": "pref", "cc-fleet-layout": "pref", "cc-fleet-group": "pref", "cc-fleet-range": "pref",
  "cc-peek": "pref", "cc-outline": "pref", "cc-worktree-group": "pref", "cc-dash-summaries": "pref",

  "cc-usage": "account", "cc-usage-detail": "account",

  "cc-favorites": "roster", "cc-proj-order": "roster", "cc-proj-groups": "roster",
  "cc-custom-icons": "roster", "cc-colors": "roster",
  "cc-agent-by-project": "roster", "cc-gh-account": "roster", "cc-episko-share": "roster",

  "cc-perm-modes": "local", "cc-perm-mode": "local", "cc-trusted": "local", "cc-autofetch": "local",
  "cc-task-prefs": "local", "cc-task-onstop": "local", "cc-task-runner": "local", "cc-task-inputs": "local",
  "cc-task-pins": "local", "cc-task-hidden": "local", "cc-digest-ok": "local", "cc-revive": "local",
  "cc-cost-base": "local", "cc-agent-token-base": "local", "cc-cmp-base": "local", "cc-restore": "local",
  "cc-attn": "local", "cc-caffeinate": "local", "cc-caf-timer": "local", "cc-caf-await": "local",
  "cc-tour": "local", "cc-seen-versions": "local", "cc-seen-version": "local", "cc-claims": "local",
  "cc-legacy-import-done": "local", "cc-icons-v": "local", "cc-usage-tokens-at": "local",
  "cc-forecast-log": "local", "cc-frecency": "local", "cc-vitals": "local", "cc-notes": "local",
  "cc-dash-seen": "local",
  // Measured on this machine (its disk, its transcripts): a sum across machines means nothing.
  "cc-io": "local", "cc-usage-tokens": "local", "cc-agent-usage-tokens": "local",
  // Sync's own bookkeeping, and what it received: never sent back.
  "cc-usage-peers": "local", "cc-detail-peers": "local", "cc-sync-stamps": "local",
  "cc-sync-dirty": "local", "cc-sync-sent": "local", "cc-sync-limits": "local", "cc-sync-seed": "local",
  "cc-sync-roster": "local", "cc-proj-ids": "local", "cc-team-notes": "local", "cc-digest-no": "local", "cc-team-claims": "local",
  // A cache of what each project's own site declares: every machine probes it for itself.
  "cc-icons": "local",
};

export const syncClass = (key: string): SyncClass => SYNC_KEYS[key] ?? "local";

// ---------- the wire's shape, as the client sees it ----------

export type Stream = "prefs" | "usage" | "limits" | "roster" | "detail" | "notes" | "claims";
export interface SyncEvent { seq: number; stream: Stream; key: string; actor: string; device: string; at: number; payload: unknown }
/** What a client pushes; `actor`, `device` and `seq` are the server's to stamp. */
export interface NewEvent { stream: Stream; key: string; at: number; payload: unknown }
/** What this machine last applied, per stream key: enough to decide last-writer-wins. */
export interface Stamp { at: number; device: string }

/** Newer `at` wins; a tie goes to the larger device id, so every machine picks the same one. */
export function wins(incoming: Stamp, held: Stamp | undefined): boolean {
  if (!held) return true;
  return incoming.at !== held.at ? incoming.at > held.at : incoming.device > held.device;
}

/** A cursor only moves forward: a replayed or reordered page must not rewind it. */
export const advance = (cursor: number, seq: unknown): number =>
  typeof seq === "number" && Number.isSafeInteger(seq) && seq > cursor ? seq : cursor;

// ---------- prefs: last-writer-wins per key ----------

export interface PrefOut { key: string; value: string }
/** An incoming pref: `null` is the key removed, which is how a pref says "back to the default". */
export interface PrefIn { key: string; value: string | null }

/** The one payload builder for prefs. It reads only through `get`, and only `pref` keys. */
export function prefOutbox(get: (key: string) => string | null): PrefOut[] {
  const out: PrefOut[] = [];
  for (const [key, cls] of Object.entries(SYNC_KEYS)) {
    if (cls !== "pref") continue;
    const value = get(key);
    if (value !== null) out.push({ key, value });
  }
  return out;
}

/** An incoming pref to write, or null. A key we would not send is a key we will not take. */
export function acceptPref(ev: SyncEvent, held: Stamp | undefined, self: string): PrefIn | null {
  if (ev.stream !== "prefs" || ev.device === self || syncClass(ev.key) !== "pref") return null;
  if (!wins(ev, held)) return null;
  if (ev.payload === null) return { key: ev.key, value: null };
  if (typeof ev.payload !== "string") return null;
  // A JSON pref arrives as its stored text; one that no longer parses is dropped on its own.
  if (/^[[{]/.test(ev.payload) && safeParse(ev.payload) === null) return null;
  return { key: ev.key, value: ev.payload };
}

// ---------- usage: partitioned by device, summed on read ----------

// Keyed `day|device`, so two machines never write one cell and the sum is conflict-free.
// `cc-usage` keeps meaning THIS machine; the others land in `cc-usage-peers` beside it.
export type Peers = Record<string, Record<string, number>>; // device → day → usd
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function usageOutbox(usage: Record<string, number>, device: string): PrefOut[] {
  return Object.entries(usage)
    .filter(([day, usd]) => DAY.test(day) && Number.isFinite(usd) && usd > 0)
    .map(([day, usd]) => ({ key: `${day}|${device}`, value: String(usd) }));
}

/** Folds one usage event into `peers`. Our own device is never taken back from the server. */
export function acceptUsage(peers: Peers, ev: SyncEvent, self: string): boolean {
  if (ev.stream !== "usage") return false;
  const bar = ev.key.indexOf("|");
  const day = ev.key.slice(0, bar), device = ev.key.slice(bar + 1);
  if (bar < 0 || !DAY.test(day) || !device || device !== ev.device || device === self) return false;
  const usd = typeof ev.payload === "string" ? Number(ev.payload) : ev.payload;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return false;
  const row = peers[device] || (peers[device] = {});
  // A day's spend only grows, so a late page carrying an older figure must not lower it.
  if (usd <= (row[day] ?? 0)) return false;
  row[day] = usd;
  return true;
}

/** Every other machine's spend per day, for `uBuckets`/`daySpend` to add to this one's. */
export function peerDays(peers: Peers): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of Object.values(peers)) for (const [day, usd] of Object.entries(row)) out[day] = (out[day] ?? 0) + usd;
  return out;
}

/** `cc-usage-peers` read without trusting it: a bad row or cell is dropped on its own. */
export function readPeers(raw: string | null): Peers {
  const v = safeParse<Peers>(raw);
  const out: Peers = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [device, row] of Object.entries(v)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const days: Record<string, number> = {};
    for (const [day, usd] of Object.entries(row)) if (DAY.test(day) && typeof usd === "number" && Number.isFinite(usd) && usd >= 0) days[day] = usd;
    out[device] = days;
  }
  return out;
}

// ---------- the day's split: models and projects, per device like the total ----------

// Session titles stay home: they are written from the conversation (the privacy floor).
export interface WireDetail { models: Record<string, number>; projects: Record<string, number>; names?: Record<string, string> }
export type DetailPeers = Record<string, Record<string, WireDetail>>; // device → day → split

const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v)) if (typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
};
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, n] of Object.entries(v)) if (typeof n === "string") out[k] = n;
  return out;
};
export function narrowDetail(v: unknown): WireDetail | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const d: WireDetail = { models: numMap(o.models), projects: numMap(o.projects) };
  const names = strMap(o.names);
  if (Object.keys(names).length) d.names = names;
  return d;
}
const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

/** Folds one detail event in; like a total, a day's split only grows. */
export function acceptDetail(peers: DetailPeers, ev: SyncEvent, self: string): boolean {
  if (ev.stream !== "detail") return false;
  const bar = ev.key.indexOf("|");
  const day = ev.key.slice(0, bar), device = ev.key.slice(bar + 1);
  if (bar < 0 || !DAY.test(day) || !device || device !== ev.device || device === self) return false;
  const d = narrowDetail(ev.payload);
  if (!d) return false;
  const row = peers[device] || (peers[device] = {});
  const held = row[day];
  if (held && total(d.models) + total(d.projects) <= total(held.models) + total(held.projects)) return false;
  row[day] = d;
  return true;
}

/** Every other machine's split per day, summed, for the day's own split to add to. */
export function peerDetailDays(peers: DetailPeers): Record<string, WireDetail> {
  const out: Record<string, WireDetail> = {};
  for (const row of Object.values(peers)) for (const [day, d] of Object.entries(row)) {
    const o = out[day] || (out[day] = { models: {}, projects: {} });
    for (const [k, v] of Object.entries(d.models)) o.models[k] = (o.models[k] ?? 0) + v;
    for (const [k, v] of Object.entries(d.projects)) o.projects[k] = (o.projects[k] ?? 0) + v;
    if (d.names) o.names = { ...o.names, ...d.names };
  }
  return out;
}

export function readDetailPeers(raw: string | null): DetailPeers {
  const v = safeParse<DetailPeers>(raw);
  const out: DetailPeers = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [device, row] of Object.entries(v)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const days: Record<string, WireDetail> = {};
    for (const [day, d] of Object.entries(row)) { const n = DAY.test(day) ? narrowDetail(d) : null; if (n) days[day] = n; }
    out[device] = days;
  }
  return out;
}

// ---------- what this machine still owes the server ----------

/** Per stream key, the stamp of the value this machine holds; `cc-sync-stamps`. */
export type Stamps = Record<string, Stamp>;
export const stampKey = (stream: Stream, key: string) => `${stream}:${key}`;

export function readStamps(raw: string | null): Stamps {
  const v = safeParse<Stamps>(raw);
  const out: Stamps = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, s] of Object.entries(v)) {
    if (s && typeof s === "object" && typeof s.at === "number" && Number.isFinite(s.at) && typeof s.device === "string") out[k] = { at: s.at, device: s.device };
  }
  return out;
}

export function readKeyList(raw: string | null): string[] {
  const v = safeParse<unknown[]>(raw);
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : [];
}

/** A day's figure worth sending: it grew since the last one the server took. */
export function changedDays(now: Record<string, number>, sent: Record<string, number>): string[] {
  return Object.keys(now).filter((d) => DAY.test(d) && Number.isFinite(now[d]) && now[d] > (sent[d] ?? 0) + 1e-9).sort();
}

// ---------- limits: the freshest reading wins, and absent is not empty ----------

export interface ScopedReading { at: number; wins?: { label: string; pct: number | null; resetTs: number | null }[] }

/** A reading with no `wins` learned nothing, so the last one stands (the `model_scoped` rule). */
export function mergeScoped(held: ScopedReading | null, incoming: unknown): ScopedReading | null {
  if (!incoming || typeof incoming !== "object") return held;
  const r = incoming as Partial<ScopedReading>;
  if (typeof r.at !== "number" || !Array.isArray(r.wins)) return held;
  if (held && r.at <= held.at) return held;
  const wins = r.wins.filter((w) => w && typeof w.label === "string" && w.label).map((w) => ({
    label: w.label,
    pct: typeof w.pct === "number" && Number.isFinite(w.pct) ? w.pct : null,
    resetTs: typeof w.resetTs === "number" && Number.isFinite(w.resetTs) ? w.resetTs : null,
  }));
  return { at: r.at, wins };
}

// ---------- health: a sync nobody can hear must never look like a quiet one ----------

export type SyncHealth = "off" | "ok" | "lagging" | "down";
/** Past this with no successful exchange, the top bar's red badge goes up. */
export const SYNC_DOWN_MS = 2 * 60_000;

export function syncHealth(configured: boolean, connected: boolean, lastOkAt: number | null, now: number): SyncHealth {
  if (!configured) return "off";
  if (connected) return "ok";
  if (lastOkAt === null || now - lastOkAt >= SYNC_DOWN_MS) return "down";
  return "lagging";
}

// ---------- presence: what a device has open, never what was said in it ----------

// Project, branch and state only: a session's title is written from the conversation.
export interface PresenceItem { pid: string; project: string; branch: string; state: string }
const STATES = new Set(["attention", "working", "thinking", "done", "donebg", "idle", "error", "ended", "background"]);
export const PRESENCE_MAX = 40;

export function narrowPresence(v: unknown): PresenceItem[] {
  if (!Array.isArray(v)) return [];
  const out: PresenceItem[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const project = typeof o.project === "string" ? o.project.slice(0, 80) : "";
    const state = typeof o.state === "string" && STATES.has(o.state) ? o.state : "";
    if (!project || !state) continue;
    out.push({ pid: typeof o.pid === "string" ? o.pid.slice(0, 200) : "", project, branch: typeof o.branch === "string" ? o.branch.slice(0, 120) : "", state });
    if (out.length >= PRESENCE_MAX) break;
  }
  return out;
}

export interface TeamRow extends PresenceItem { user: string; device: string; mine: boolean }
const URGENT: Record<string, number> = { attention: 0, error: 1, working: 2, thinking: 2, background: 3, done: 4, donebg: 4, idle: 5, ended: 6 };

/** Every other device's sessions, what needs someone first; your own other machines say so. */
export function teamRows(peers: Record<string, { user: string; items: PresenceItem[] }>, selfUser: string): TeamRow[] {
  const rows: TeamRow[] = [];
  for (const [device, p] of Object.entries(peers)) for (const it of p.items) rows.push({ ...it, user: p.user, device, mine: p.user === selfUser });
  return rows.sort((a, b) => (URGENT[a.state] ?? 9) - (URGENT[b.state] ?? 9) || a.user.localeCompare(b.user) || a.project.localeCompare(b.project));
}

// ---------- extra headers for a proxy in front of the server ----------

// One per line, `Name: value`; `#` starts a comment. The handshake's own headers are refused
// here and again in sync.rs, so a pasted line can never rewrite the upgrade itself.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set(["host", "connection", "upgrade", "content-length", "transfer-encoding", "origin"]);
export const MAX_HEADERS = 16;

export function parseHeaders(text: string): { headers: [string, string][]; error: string | null } {
  const headers: [string, string][] = [];
  const seen = new Set<string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    const name = at > 0 ? line.slice(0, at).trim() : "";
    const value = at > 0 ? line.slice(at + 1).trim() : "";
    const where = `line ${i + 1}`;
    if (!name) return { headers: [], error: `${where}: write it as Name: value` };
    if (!HEADER_NAME.test(name)) return { headers: [], error: `${where}: "${name}" is not a header name` };
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || lower.startsWith("sec-websocket-")) return { headers: [], error: `${where}: ${name} belongs to the connection itself` };
    if (!value) return { headers: [], error: `${where}: ${name} has no value` };
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return { headers: [], error: `${where}: the value has characters a header cannot carry` };
    if (seen.has(lower)) return { headers: [], error: `${where}: ${name} is given twice` };
    seen.add(lower);
    headers.push([name, value]);
  }
  if (headers.length > MAX_HEADERS) return { headers: [], error: `at most ${MAX_HEADERS} headers` };
  return { headers, error: null };
}
