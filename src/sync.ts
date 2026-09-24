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

  "cc-usage": "account", "cc-usage-detail": "account", "cc-usage-tokens": "account",
  "cc-agent-usage-tokens": "account", "cc-io": "account",

  "cc-favorites": "roster", "cc-proj-order": "roster", "cc-proj-groups": "roster",
  "cc-icons": "roster", "cc-custom-icons": "roster", "cc-colors": "roster",
  "cc-agent-by-project": "roster", "cc-gh-account": "roster",

  "cc-perm-modes": "local", "cc-perm-mode": "local", "cc-trusted": "local", "cc-autofetch": "local",
  "cc-task-prefs": "local", "cc-task-onstop": "local", "cc-task-runner": "local", "cc-task-inputs": "local",
  "cc-task-pins": "local", "cc-task-hidden": "local", "cc-digest-ok": "local", "cc-revive": "local",
  "cc-cost-base": "local", "cc-agent-token-base": "local", "cc-cmp-base": "local", "cc-restore": "local",
  "cc-attn": "local", "cc-caffeinate": "local", "cc-caf-timer": "local", "cc-caf-await": "local",
  "cc-tour": "local", "cc-seen-versions": "local", "cc-seen-version": "local", "cc-claims": "local",
  "cc-legacy-import-done": "local", "cc-icons-v": "local", "cc-usage-tokens-at": "local",
  "cc-forecast-log": "local", "cc-frecency": "local", "cc-vitals": "local", "cc-notes": "local",
  "cc-dash-seen": "local",
};

export const syncClass = (key: string): SyncClass => SYNC_KEYS[key] ?? "local";

// ---------- the wire's shape, as the client sees it ----------

export type Stream = "prefs" | "usage" | "limits";
export interface SyncEvent { seq: number; stream: Stream; key: string; device: string; at: number; payload: unknown }
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
export function acceptPref(ev: SyncEvent, held: Stamp | undefined, self: string): PrefOut | null {
  if (ev.stream !== "prefs" || ev.device === self || syncClass(ev.key) !== "pref") return null;
  if (typeof ev.payload !== "string" || !wins(ev, held)) return null;
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
