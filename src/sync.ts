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
  "cc-title": "pref", "cc-term-engine": "pref", "cc-term-font": "pref", "cc-term-split": "pref", "cc-drift-auto": "pref",
  "cc-agent": "pref", "cc-diff-mode": "pref", "cc-scrollback": "pref", "cc-sort": "pref",
  "cc-fleet-sort": "pref", "cc-fleet-layout": "pref", "cc-fleet-group": "pref", "cc-fleet-range": "pref",
  "cc-peek": "pref", "cc-outline": "pref", "cc-markdown": "pref", "cc-worktree-group": "pref", "cc-dash-summaries": "pref",

  "cc-usage": "account", "cc-usage-detail": "account",

  "cc-favorites": "roster", "cc-proj-order": "roster", "cc-proj-groups": "roster",
  "cc-custom-icons": "roster", "cc-colors": "roster",
  "cc-agent-by-project": "roster", "cc-gh-account": "roster", "cc-episko-share": "roster",

  "cc-perm-modes": "local", "cc-perm-mode": "local", "cc-trusted": "local", "cc-autofetch": "local", "cc-proj-prefs": "local",
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
  "cc-sync-roster": "local", "cc-sync-devices": "local", "cc-sync-pending": "local", "cc-sync-exclude": "local", "cc-proj-ids": "local", "cc-team-notes": "local", "cc-digest-no": "local", "cc-team-claims": "local",
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
export function prefOutbox(get: (key: string) => string | null, excluded: ReadonlySet<string> = new Set()): PrefOut[] {
  const out: PrefOut[] = [];
  for (const [key, cls] of Object.entries(SYNC_KEYS)) {
    if (cls !== "pref" || excluded.has(key)) continue;
    const value = get(key);
    if (value !== null) out.push({ key, value });
  }
  return out;
}

/** An incoming pref to write, or null. A key we would not send is a key we will not take. */
/** `excluded` is the keys kept to this machine (`cc-sync-exclude`): neither sent nor taken. */
export function acceptPref(ev: SyncEvent, held: Stamp | undefined, self: string, excluded: ReadonlySet<string> = new Set()): PrefIn | null {
  if (ev.stream !== "prefs" || ev.device === self || syncClass(ev.key) !== "pref" || excluded.has(ev.key)) return null;
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

// ---------- who is who: the server names every machine at welcome ----------

/** `user` is the name the machine was invited under: one name is one person's settings and spend. */
export interface DeviceInfo { user: string; device: string; label: string }

export function narrowDevices(v: unknown): DeviceInfo[] {
  if (!Array.isArray(v)) return [];
  const out: DeviceInfo[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.device !== "string" || !o.device) continue;
    out.push({
      device: o.device.slice(0, 80),
      user: typeof o.user === "string" ? o.user.slice(0, 80) : "",
      label: typeof o.label === "string" ? o.label.slice(0, 80) : "",
    });
  }
  return out;
}

/** What a device is called on screen; one this machine never heard named keeps a short id. */
export function deviceName(devices: DeviceInfo[], id: string, self: string): string {
  if (id === self) return "this machine";
  const d = devices.find((x) => x.device === id);
  return d?.label || `machine ${id.slice(0, 6)}`;
}

export interface UserDevices { user: string; mine: boolean; devices: DeviceInfo[] }
/** Your machines first (this one leading), then each teammate's, grouped by user. */
export function devicesByUser(devices: DeviceInfo[], selfUser: string, self: string): UserDevices[] {
  const by = new Map<string, DeviceInfo[]>();
  for (const d of devices) {
    const list = by.get(d.user) ?? [];
    list.push(d);
    by.set(d.user, list);
  }
  return [...by.entries()]
    .map(([user, ds]) => ({ user, mine: user === selfUser, devices: [...ds].sort((a, b) => Number(b.device === self) - Number(a.device === self)) }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || a.user.localeCompare(b.user));
}

// ---------- where a day's spend came from ----------

export interface SpendSource { device: string; label: string; usd: number; self: boolean }

/** The days' spend per machine, this one included; only rows that spent anything, largest first. */
export function spendSources(own: Record<string, number>, peers: Peers, days: string[], devices: DeviceInfo[], self: string): SpendSource[] {
  const sum = (row: Record<string, number> | undefined) => days.reduce((n, d) => n + (row?.[d] ?? 0), 0);
  const rows: SpendSource[] = [{ device: self, label: deviceName(devices, self, self), usd: sum(own), self: true }];
  for (const [device, row] of Object.entries(peers)) {
    if (device !== self) rows.push({ device, label: deviceName(devices, device, self), usd: sum(row), self: false });
  }
  return rows.filter((r) => r.usd > 0.005).sort((a, b) => b.usd - a.usd);
}

// ---------- what a synced preference changed, in words ----------

export const PREF_LABEL: Readonly<Record<string, string>> = {
  "cc-keys": "Keyboard shortcuts", "cc-sound": "Sounds", "cc-motion": "Motion and effects", "cc-foot": "Status bar",
  "cc-title": "Session titles", "cc-term-engine": "Terminal engine", "cc-term-font": "Terminal font size",
  "cc-term-split": "Shell beside a session", "cc-drift-auto": "Follow a session's checkout", "cc-agent": "Default agent", "cc-diff-mode": "Diff layout",
  "cc-scrollback": "Scrollback", "cc-sort": "Sidebar sort", "cc-fleet-sort": "Fleet sort", "cc-fleet-layout": "Fleet layout",
  "cc-fleet-group": "Fleet grouping", "cc-fleet-range": "Fleet range", "cc-peek": "Hover to reveal",
  "cc-outline": "Conversation outline", "cc-markdown": "Markdown reader", "cc-worktree-group": "Worktree grouping", "cc-dash-summaries": "Generated summaries",
};
export const prefLabel = (key: string) => PREF_LABEL[key] ?? key.replace(/^cc-/, "");

export interface DiffLine { path: string; from: string; to: string }
const shown = (v: unknown): string => {
  if (v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
};
function leaves(v: unknown, path: string, out: Map<string, unknown>, depth: number) {
  if (v && typeof v === "object" && !Array.isArray(v) && depth < 3) {
    for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out, depth + 1);
  } else out.set(path, v);
}
/** The fields a remote value changed, at most `max` of them; `more` counts the rest. */
export function prefDiff(before: string | null, after: string | null, max = 8): { lines: DiffLine[]; more: number } {
  const parse = (s: string | null): unknown => (s === null ? undefined : /^[[{]/.test(s) ? safeParse(s) ?? s : s);
  const ma = new Map<string, unknown>(), mb = new Map<string, unknown>();
  leaves(parse(before), "", ma, 0);
  leaves(parse(after), "", mb, 0);
  const lines: DiffLine[] = [];
  for (const k of [...new Set([...ma.keys(), ...mb.keys()])].sort()) {
    const x = ma.get(k), y = mb.get(k);
    if (JSON.stringify(x) !== JSON.stringify(y)) lines.push({ path: k, from: shown(x), to: shown(y) });
  }
  return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}

/** A preference another machine changed, held until you say whether it applies here. */
export interface PendingPref { key: string; value: string | null; at: number; device: string; lines: DiffLine[]; more: number }
export function readPending(raw: string | null): Record<string, PendingPref> {
  const v = safeParse<Record<string, unknown>>(raw);
  const out: Record<string, PendingPref> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    const p = x as Partial<PendingPref> | null;
    if (!p || typeof p !== "object" || p.key !== k || syncClass(k) !== "pref") continue;
    if (typeof p.at !== "number" || typeof p.device !== "string" || !Array.isArray(p.lines)) continue;
    if (p.value !== null && typeof p.value !== "string") continue;
    out[k] = { key: k, value: p.value ?? null, at: p.at, device: p.device, lines: p.lines, more: typeof p.more === "number" ? p.more : 0 };
  }
  return out;
}

// ---------- what each stream carries, and who it reaches ----------

/** `you` reaches only machines invited under your user name; `team` reaches everyone on the server. */
export const STREAM_INFO: Readonly<Record<Stream, { label: string; scope: "you" | "team"; what: string }>> = {
  prefs: { label: "Preferences", scope: "you", what: "display and keyboard settings; never permission modes, trust or tasks" },
  usage: { label: "Spend", scope: "you", what: "each machine's daily total, summed on read" },
  detail: { label: "Spend split", scope: "you", what: "each day by model and project; never session titles" },
  limits: { label: "Limits", scope: "you", what: "the freshest rate-limit reading" },
  roster: { label: "Projects", scope: "you", what: "favourites, order, groups, colours, icons, agent, gh account, sharing" },
  notes: { label: "Notes and work log", scope: "team", what: "shared notes, each day's project line, the sharing channel, and each person's spend on a shared project" },
  claims: { label: "Claims", scope: "team", what: "who dispatched at an issue or PR, while that session runs" },
};

// ---------- the work log on the server: which commits a line covers ----------

// A line knows which commits it summarised, so a machine holding commits it missed can redo it.
export interface DigestLine { line: string; covers: string[] | null }
export const COVER_MAX = 400;
const shaKey = (sha: string) => sha.slice(0, 12);

/** A legacy plain string covers an unknown set, and is trusted as it stands. */
export function narrowDigest(v: unknown): DigestLine | null {
  if (typeof v === "string") return v.trim() ? { line: v.slice(0, 2000), covers: null } : null;
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.line !== "string" || !o.line.trim()) return null;
  const covers = Array.isArray(o.covers)
    ? o.covers.filter((s): s is string => typeof s === "string").map(shaKey).slice(0, COVER_MAX) : null;
  return { line: o.line.slice(0, 2000), covers };
}

/** True when this machine has commits that day the server's line never saw. */
export function digestMisses(d: DigestLine | undefined, shas: string[]): boolean {
  if (!d || !d.covers) return false;
  const have = new Set(d.covers);
  return shas.some((s) => !have.has(shaKey(s)));
}

/** What a redone line covers: everything the old one did, plus what this machine summarised. */
export function digestCover(prev: DigestLine | undefined, shas: string[]): string[] {
  return [...new Set([...(prev?.covers ?? []), ...shas.map(shaKey)])].slice(0, COVER_MAX);
}

/** A project's sharing channel as the team set it: `share|<pid>` on the notes stream. */
export const narrowShare = (v: unknown): "git" | "server" | null => (v === "git" || v === "server" ? v : null);

// ---------- a shared project's spend, per person ----------

// `spend|<pid>|<day>|<device>` on the team stream: one cell per machine, so nobody overwrites anybody.
export interface TeamSpend { usd: number; user: string }
export const spendKey = (pid: string, day: string, device: string) => `spend|${pid}|${day}|${device}`;
export function narrowSpend(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Every teammate's spend on a project over `days`, per person, largest first; your own machines excluded. */
export function teamSpend(cells: Record<string, unknown>, pid: string, days: string[], selfUser: string): { user: string; usd: number }[] {
  const want = new Set(days), by = new Map<string, number>();
  const pre = `spend|${pid}|`;
  for (const [k, v] of Object.entries(cells)) {
    if (!k.startsWith(pre)) continue;
    const day = k.slice(pre.length).split("|")[0];
    const c = v as Partial<TeamSpend> | null;
    if (!want.has(day) || !c || typeof c.user !== "string" || c.user === selfUser) continue;
    const usd = narrowSpend(c.usd);
    if (usd) by.set(c.user, (by.get(c.user) ?? 0) + usd);
  }
  return [...by.entries()].map(([user, usd]) => ({ user, usd })).sort((a, b) => b.usd - a.usd);
}
