// What Claude Code cost, and when. Two stores that answer different questions and
// are deliberately kept apart:
//
//   • the *rollup* (`cc-usage` / `cc-usage-detail`) — written here from telemetry,
//     every time a statusLine reports a higher session cost. Authoritative for the
//     daily $ total, and the only source for the per-model / per-project split.
//   • the *token scan* (`cc-usage-tokens`) — read from Claude's own transcripts by
//     the backend, so it carries full history including tokens and session counts,
//     which telemetry can't give us. The scan itself needs `invoke`, so it stays in
//     main.ts and hands its result down through `setTokenDays`.
//
// `usageWindow` is where the two meet: the last n calendar days, each joined to its
// cost, its detail and its scanned tokens. Everything below it is arithmetic over
// that join — no DOM, no Tauri — so it unit-tests in isolation, like ./rl.
// See test/usage.test.ts.

import { isAgent, type Sess } from "./types";
import { basename } from "./format";

// ---------- the daily rollup (telemetry-fed) ----------

// The three Claude models collapse to a family so cost splits by tier, not by the
// exact display name ("Opus 4.8", "Sonnet 4.5", …) which changes across releases.
export function modelFamily(m: string): string {
  const s = (m || "").toLowerCase();
  if (s.includes("opus")) return "Opus";
  if (s.includes("sonnet")) return "Sonnet";
  if (s.includes("haiku")) return "Haiku";
  return m ? "Other" : "Unknown";
}

// Persisted daily usage rollup (survives app + system restarts). `cc-usage` is the
// authoritative per-day *total* cost — untouched here so the footer keeps working —
// and `cc-usage-detail` layers on the per-model / per-project split + session ids,
// which the Usage analytics tab reads. The split is telemetry-only, so it records
// from the day this ships forward; the totals (and the transcript-scanned tokens)
// still carry full history. See the Usage panel section below.
/// What one session spent on one day. This replaced a bare `sessions: string[]`, which
/// recorded *which* ids contributed but not what any of them cost — write-only for its
/// whole life, and unable to answer the only question anyone asks of it ("where did
/// today go?"). Old stored days therefore have no `sess` at all, exactly as they have no
/// `projects`: the split records from the day it ships forward, and a day without one
/// says so rather than showing zeros.
export interface DaySess { usd: number; title: string; project: string }
export interface DayDetail {
  models: Record<string, number>;
  projects: Record<string, number>;
  sess?: Record<string, DaySess>;
}
export const usage: Record<string, number> = JSON.parse(localStorage.getItem("cc-usage") || "{}");
export const usageDetail: Record<string, DayDetail> = JSON.parse(localStorage.getItem("cc-usage-detail") || "{}");
export function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

/**
 * The two rollups are written on different terms, and the split is the point.
 *
 * `cc-usage` is the day's money and the footer reads it directly — it stays **eager**,
 * because losing spend to a crash is the one thing here nobody can reconstruct, and it
 * is small (measured: 980 chars over 33 days).
 *
 * `cc-usage-detail` is *attribution*, it is **25× bigger** (24,586 chars over the same
 * 33 days, and growing with every session now that it carries a per-session map), and
 * it was written on the same trigger — every cost delta, so up to once per session per
 * `refreshInterval` (3s). That is a 25KB `stringify` + synchronous `setItem` roughly
 * once a second on a working fleet, to record a breakdown read once a day.
 *
 * So the detail write is floored. Divergence after a crash is not a silent loss:
 * `daySpend` already puts what the split cannot account for on screen as
 * `unattributed`, which is exactly what a lost minute of attribution looks like.
 */
const DETAIL_SAVE_FLOOR_MS = 30_000;
/// Both rollups were unbounded, which on a daily key means "grows forever". The Usage
/// panel's widest range is 12 months, so a year and a bit is everything anything reads.
const USAGE_MAX_DAYS = 420;
let detailSavedAt = 0;
let detailDirty = false;
let detailDay = "";
function trimDays(o: Record<string, unknown>) {
  const keys = Object.keys(o).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - USAGE_MAX_DAYS))) delete o[old];
}
/// Write the attribution split out now — on the floor, across a midnight, and from the
/// quit path. Kept separate from `flushIo` because the two have different triggers and
/// only ./main's quit handler ever wants both.
/// Only a test needs this: the floor's bookkeeping is module state that outlives one
/// `it`, so without it a later case inherits an earlier one's "written just now" and
/// sees a write it expected to be held back (or the reverse).
export function resetUsageWrites() { detailSavedAt = 0; detailDirty = false; detailDay = ""; }
export function flushUsageDetail(): void {
  if (!detailDirty) return;
  detailDirty = false;
  detailSavedAt = Date.now();
  trimDays(usageDetail);
  localStorage.setItem("cc-usage-detail", JSON.stringify(usageDetail));
}

export function addUsage(delta: number, s?: Sess) {
  if (!(delta > 0)) return;
  const k = todayKey();
  usage[k] = (usage[k] || 0) + delta;
  trimDays(usage);
  localStorage.setItem("cc-usage", JSON.stringify(usage));
  if (!s || !isAgent(s)) return;
  // Attribute the cost delta to whichever model is active right now and to the
  // session's project — the closest honest split the statusLine data allows.
  const d = usageDetail[k] || (usageDetail[k] = { models: {}, projects: {} });
  const fam = modelFamily(s.model);
  d.models[fam] = (d.models[fam] || 0) + delta;
  const proj = s.project || basename(s.workdir) || "unknown";
  d.projects[proj] = (d.projects[proj] || 0) + delta;
  if (!s.id) return;
  const bag = d.sess || (d.sess = {});
  const e = bag[s.id] || (bag[s.id] = { usd: 0, title: "", project: proj });
  e.usd += delta;
  // Re-stamped on every increment, not written once: a session's title arrives *after*
  // its first dollar — Claude sets it from the conversation, and the pane starts with
  // an empty one — so first-write-wins would leave the busiest rows unnamed.
  if (s.title) e.title = s.title;
  e.project = proj;
  // A day left behind is written regardless of the floor — nothing adds to it again,
  // so a throttled write would drop its tail permanently rather than merely late.
  const rolled = detailDay !== "" && detailDay !== k;
  detailDay = k;
  detailDirty = true;
  if (rolled || Date.now() - detailSavedAt >= DETAIL_SAVE_FLOOR_MS) flushUsageDetail();
}

/// One day's spend, split the two ways anyone actually asks for it. Pure arithmetic over
/// the stored rollup so ./footer only has to paint it.
///
/// **The remainder is part of the answer, and BOTH splits need one.** `total` is
/// `cc-usage` for that day; each split is a different slice of `cc-usage-detail` for the
/// same day, and each can fall short on its own. The case is not exotic — it is the day
/// you upgrade: the day's total is already banked, and a split introduced by that build
/// starts from whatever is spent after it. So the two lists routinely disagree with each
/// other as well as with the total, and a list that quietly summed lower than the footer
/// segment that opened it would be the exact defect the projects row was added to avoid.
///
/// A split with *nothing* in it is left empty rather than given a lone `unattributed`
/// row: the reader says "this day predates the record", which is the true statement, and
/// one anonymous row claiming the whole day reads like a session nobody can identify.
export interface SpendRow { key: string; label: string; sub: string; usd: number }
export interface DaySpend { total: number; projects: SpendRow[]; sessions: SpendRow[]; split: number }
/// Half a cent, not zero: both figures are sums of the same deltas in a different order,
/// so a fully attributed day still differs in the last place, and a `$0.00 unattributed`
/// row is noise that reads as a bug.
const SPEND_EPS = 0.005;
export function daySpend(
  detail: Record<string, DayDetail | undefined>, day: string, total: number,
): DaySpend {
  const d = detail[day];
  const rest = (rows: SpendRow[]): SpendRow[] => {
    const missing = total - rows.reduce((n, r) => n + r.usd, 0);
    if (rows.length && missing > SPEND_EPS) rows.push({ key: "", label: "unattributed", sub: "", usd: missing });
    return rows;
  };
  const projects = Object.entries(d?.projects || {}).filter(([, v]) => v > 0)
    .map(([k, v]) => ({ key: k, label: k, sub: "", usd: v }))
    .sort((a, b) => b.usd - a.usd);
  const split = projects.reduce((n, r) => n + r.usd, 0);
  const sessions = Object.entries(d?.sess || {}).filter(([, v]) => v.usd > 0)
    .map(([id, v]) => ({ key: id, label: v.title || "untitled session", sub: v.project, usd: v.usd }))
    .sort((a, b) => b.usd - a.usd);
  return { total, projects: rest(projects), sessions: rest(sessions), split };
}

// ---------- the daily disk-I/O rollup ----------

/// Bytes read and written per day, in MiB. **This is the only durable record of it.**
///
/// `all_sessions_resources` reports a *run* figure — the kernel's per-process counters
/// for every claude pid Episko owns, plus `io_retired` for the ones that have exited —
/// and all of that lives in `AppState`, so quitting the app takes it with it. "Total
/// read/written" therefore meant "since this Episko started", which is a window nobody
/// chose and which reads as a lifetime figure sitting next to a lifetime-shaped label.
///
/// So the increments are banked here, keyed by day, in the shape `cc-usage` already
/// uses. There is deliberately no back-fill: days before this shipped have no entry,
/// which the reader renders as "not recorded" rather than as zero.
export interface DayIo { r: number; w: number }
const IO_KEY = "cc-io";
/// ~14 months of days at ~40 bytes each. Same reasoning as `COST_BASE_MAX`: bounded by
/// count so the key can't grow without limit on a machine that is never cleared.
const IO_MAX_DAYS = 420;
export const dayIo: Record<string, DayIo> = ((): Record<string, DayIo> => {
  try {
    const raw = JSON.parse(localStorage.getItem(IO_KEY) || "{}") as Record<string, DayIo>;
    const out: Record<string, DayIo> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.r === "number" && typeof v.w === "number") out[k] = v;
    }
    return out;
  } catch { return {}; }
})();

/// The increment between two readings of a cumulative counter that restarts.
///
/// A restart is the *normal* case here, not an edge one: every Episko launch begins a
/// new run whose counters start near zero, so the reading routinely goes down. Clamping
/// at zero rather than trusting the difference is what keeps a restart from booking a
/// negative day — the same drop-branch reasoning as `costDelta` above, arrived at for
/// the same reason. With no previous reading the whole figure is the increment: this
/// process spawned those pids, so everything they have churned belongs to this run.
export function ioDelta(cur: DayIo, prev: DayIo | null): DayIo {
  const p = prev ?? { r: 0, w: 0 };
  return { r: Math.max(0, cur.r - p.r), w: Math.max(0, cur.w - p.w) };
}

/// **A disk-I/O meter must not be a heavy writer**, and the naive version was one: the
/// poll behind it runs every 4s for as long as a session is on stage, so persisting on
/// every reading meant a synchronous `JSON.stringify` + `setItem` ~900 times an hour,
/// forever, to record a figure nobody reads more than once a day. The accumulation is
/// free and stays per-poll; only the *write* is floored.
///
/// Losing up to a minute of it to a crash is the right trade — this is a disk meter, not
/// money, and `cc-usage`'s own baselines are the thing that gets flushed eagerly.
const IO_SAVE_FLOOR_MS = 60_000;
let ioPrev: DayIo | null = null;
let ioSavedAt = 0;
let ioDirty = false;
let ioDay = "";
/// Bank a fresh `all_sessions_resources` reading into today. Called from the same poll
/// that updates `ioAll`, so the rollup and the live bars can never describe different
/// samples.
///
/// **A gap in the polling costs nothing**, which is why the floor above is safe and why
/// the poll stopping while the dashboard is on stage doesn't skew the day: the counters
/// are cumulative and `io_retired` preserves a session's bytes past its exit, so the
/// first reading after a quiet hour carries the whole hour, and `setActive` takes one
/// the moment a pane is back on stage.
///
/// The one genuine loss is the stretch after the *last* reading of a run — quitting
/// straight from the dashboard leaves however long it was open unsampled. `flushIo`
/// does not rescue that: it persists what has been read, it does not take a reading.
/// Living with it is deliberate — the alternative is an IPC on the quit path to improve
/// a disk meter, and the figure is a rough one by nature.
export function addIo(cur: DayIo): void {
  const d = ioDelta(cur, ioPrev);
  ioPrev = cur;
  if (d.r <= 0 && d.w <= 0) return;
  const k = todayKey();
  // A day that has been left behind must be written before the floor would allow it:
  // nothing adds to yesterday again, so a throttled write would drop its last minutes
  // permanently rather than merely late.
  const rolled = ioDay !== "" && ioDay !== k;
  ioDay = k;
  const day = dayIo[k] || (dayIo[k] = { r: 0, w: 0 });
  day.r += d.r;
  day.w += d.w;
  ioDirty = true;
  if (rolled || Date.now() - ioSavedAt >= IO_SAVE_FLOOR_MS) flushIo();
}

/// Write the rollup out now. Called on the floor above, across a midnight, and from the
/// quit path — the one moment there is no later poll to catch what is pending.
export function flushIo(): void {
  if (!ioDirty) return;
  ioDirty = false;
  ioSavedAt = Date.now();
  const keys = Object.keys(dayIo).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - IO_MAX_DAYS))) delete dayIo[old];
  localStorage.setItem(IO_KEY, JSON.stringify(dayIo));
}

/// Only a test needs to clear it; the app's own copy is meant to outlive the run.
export function resetIoRollup() {
  for (const k of Object.keys(dayIo)) delete dayIo[k];
  ioPrev = null;
  ioSavedAt = 0;
  ioDirty = false;
  ioDay = "";
  localStorage.removeItem(IO_KEY);
}

/// Everything the rollup has ever recorded. Not a lifetime figure and does not pretend
/// to be one — it starts the day this ships, which is why the label says "recorded"
/// rather than "all time".
///
/// **Null when nothing has been recorded**, never `{r:0,w:0}`: an empty rollup means we
/// did not keep this, and a confident zero would say the disk was idle. Same distinction
/// the per-project cost strip makes with its dash.
export function ioTotal(): DayIo | null {
  const days = Object.values(dayIo);
  if (!days.length) return null;
  let r = 0, w = 0;
  for (const v of days) { r += v.r; w += v.w; }
  return { r, w };
}

/** How many days the rollup holds — what tells `all` apart from `today`. */
export function ioDayCount(): number {
  return Object.keys(dayIo).length;
}

/**
 * Why the I/O row does not change when you click it.
 *
 * The three windows *genuinely* coincide in the ordinary early case, and the arithmetic
 * makes it more common than it sounds. `all` equals `today` whenever one day is
 * recorded — which is every install for the first day after the rollup ships. And `run`
 * equals `today` whenever the run's first poll is also the day's first: `ioDelta` banks
 * the entire cumulative counter when there is no previous reading, so a single run
 * started today telescopes to exactly today's total.
 *
 * That is correct, and it is indistinguishable from a broken control. A cycling row
 * whose three positions carry identical numbers reads as a click that does nothing, so
 * it has to say why. Returns null once they diverge, so the note is absent rather than
 * empty — the same stance as `missingCard`.
 *
 * Compared on the RENDERED strings, not the floats: two figures that differ by a byte
 * are the same figure to the person reading the row, and that reader is who the note is
 * for.
 */
export function ioSameNote(today: string, run: string, all: string, days: number): string | null {
  if (today === run && run === all) {
    return days <= 1
      ? "All three windows are the same so far: today is the only day recorded, and all of it is this run."
      : "All three windows happen to read the same right now.";
  }
  if (today === run) return "Today is all this run — nothing was recorded earlier today.";
  if (today === all) return "Today is everything recorded so far.";
  return null;
}

// What the statusLine reports is a running total, so the day only wants the increment
// — and the thing that total belongs to is the *conversation*, not the pane showing it.
// Claude's counter survives a relaunch: `--resume` hands the new process a figure that
// already includes everything the old one spent. Diffing against the pane therefore
// books that carried-over total a second time, because a fresh `Sess` starts at
// `cost: null`. It is not hypothetical — one drift `Move session` (kill, move the
// transcript, relaunch seconds later) put ~$28 into the day twice, so the day read $68
// while the pane that had earned all of it read $39. Restore and a History reopen take
// the same path and had the same bug.
//
// So the baseline is keyed by Claude's runtime session id, which `--resume` preserves
// and which main.ts keeps on `Sess.resumeId`. A reading *below* the baseline means the
// counter itself restarted — `/clear`, `/compact`, or a cold start hours later — so the
// whole new reading is fresh spend and the baseline follows it down.
//
// **Persisted, because a restart is the same case.** Held only in memory this covered a
// `Move session` and an in-session History reopen, and still booked the whole total again
// for the commonest path of all: quit Episko with the day's spend recorded, reopen, and
// restore. `cc-usage` survives that — it is localStorage — while an in-memory baseline
// does not, so the first statusLine of the restored pane met an empty map and counted its
// carried-over total into a day that already had it.
//
// An earlier note here worried that a baseline outliving the counter it describes would
// *swallow* real spend, which is the failure nobody can see. That is what the drop branch
// below is for: a counter that restarted reads below its old baseline, so the whole new
// reading is booked as fresh and the baseline follows it down. The one shape that gets
// past it is a counter that reset and then climbed back above the old baseline before we
// read it even once — which needs the statusLine at session start to be missed, and it
// fires on start and every refreshInterval regardless. Retention is therefore generous:
// the drop branch, not an expiry, is what makes a stale entry harmless.
const COST_BASE_KEY = "cc-cost-base";
/// Enough that no realistic history evicts a conversation still being resumed, small
/// enough that the key stays a few tens of KB on a machine that never clears it.
const COST_BASE_MAX = 500;
interface CostBase { t: number; at: number }
const costBaseline = ((): Map<string, CostBase> => {
  const m = new Map<string, CostBase>();
  try {
    const raw = JSON.parse(localStorage.getItem(COST_BASE_KEY) || "{}") as Record<string, CostBase>;
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.t === "number" && typeof v.at === "number") m.set(k, v);
    }
  } catch { /* a corrupt key costs one over-counted session, not a boot */ }
  return m;
})();
function saveBaselines() {
  if (costBaseline.size > COST_BASE_MAX) {
    // Oldest touch goes first — a conversation nobody has resumed in months is the one
    // least likely to still be carrying a live counter.
    const keep = [...costBaseline.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, COST_BASE_MAX);
    costBaseline.clear();
    for (const [k, v] of keep) costBaseline.set(k, v);
  }
  localStorage.setItem(COST_BASE_KEY, JSON.stringify(Object.fromEntries(costBaseline)));
}
export function costDelta(conv: string, total: number): number {
  const prev = costBaseline.get(conv)?.t;
  costBaseline.set(conv, { t: total, at: Date.now() });
  // **Only when the figure moved.** A statusLine fires every `refreshInterval` (3s) per
  // session whether or not anything was spent, and this used to serialise and write the
  // whole map every time — so an idle fleet wrote the same bytes to disk once a second,
  // forever. An unchanged total leaves nothing to persist but `at`, and `at` exists
  // solely to order eviction, where seconds do not matter: it rides along on the next
  // write this conversation earns.
  if (prev !== total) saveBaselines();
  return prev === undefined || total < prev ? total : total - prev;
}
// Only a test needs to clear it; the app's own copy is meant to outlive the run.
export function resetCostBaselines() { costBaseline.clear(); localStorage.removeItem(COST_BASE_KEY); }

// ---------- Usage analytics (the Usage settings tab) ----------
// Money comes from the rollup above: full history for the daily *totals*, plus the
// per-model / per-project split from cc-usage-detail (recorded going forward). Tokens
// are the one figure telemetry can't give us, so they come from an async, cached scan
// of Claude's transcripts (`token_usage_by_day`) and fill in the moment it returns —
// the panel never blocks on the scan.
// One day's transcript-scanned usage: token totals (by type and by model family),
// distinct sessions active, and per-project token totals. Full history — unlike the
// telemetry-only $ split, which records forward from install.
export interface DayUsage {
  day: string; input: number; output: number; cache_read: number; cache_write: number;
  opus: number; sonnet: number; haiku: number; other: number;
  sessions: number; projects: Record<string, number>;
}
export type UDay = { key: string; cost: number; tok: number; u?: DayUsage };
export let tokenDays: DayUsage[] = JSON.parse(localStorage.getItem("cc-usage-tokens") || "[]");
export let tokenScanAt = +(localStorage.getItem("cc-usage-tokens-at") || 0);
// The scan runs in main.ts (it needs `invoke`) but its result belongs to this
// module, so the state and its persistence stay together rather than half here.
export function setTokenDays(days: DayUsage[]) {
  tokenDays = days;
  tokenScanAt = Date.now();
  localStorage.setItem("cc-usage-tokens", JSON.stringify(tokenDays));
  localStorage.setItem("cc-usage-tokens-at", String(tokenScanAt));
}
// How far back the analytics tab looks. A live binding: the range buttons call the
// setter, every reader (here and in the render code) sees the new value.
export let usageRange = 30;
export function setUsageRange(n: number) { usageRange = n; }

export const U_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Sum a day's per-model tokens into a fixed-key record (backfill fields are lowercase).
export const uModels = (a: UDay[]): Record<string, number> => {
  const m: Record<string, number> = { Opus: 0, Sonnet: 0, Haiku: 0, Other: 0 };
  for (const d of a) if (d.u) { m.Opus += d.u.opus; m.Sonnet += d.u.sonnet; m.Haiku += d.u.haiku; m.Other += d.u.other; }
  return m;
};

export const uDkey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// The last n calendar days ending today, oldest→newest, each joined to its cost,
// per-model/project detail and scanned token total.
export function usageWindow(n: number): UDay[] {
  const tk = new Map(tokenDays.map((t) => [t.day, t]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out: UDay[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = uDkey(d); const t = tk.get(key);
    out.push({ key, cost: usage[key] || 0, tok: t ? t.input + t.output + t.cache_read + t.cache_write : 0, u: t });
  }
  return out;
}

export function uSum(a: UDay[], f: (d: UDay) => number): number { return a.reduce((s, d) => s + f(d), 0); }

export type UBucket = { label: string; tip: string; total: number; models: Record<string, number> };
export function uBuckets(): UBucket[] {
  const cur = usageWindow(usageRange);
  const mk = (label: string, tip: string, days: UDay[]): UBucket => {
    const models = uModels(days);
    return { label, tip, total: models.Opus + models.Sonnet + models.Haiku + models.Other, models };
  };
  if (usageRange <= 31) return cur.map((d) => { const dt = new Date(d.key + "T00:00:00"); return mk(String(dt.getDate()), `${U_MONTHS[dt.getMonth()]} ${dt.getDate()}`, [d]); });
  if (usageRange === 90) {
    const out: UBucket[] = [];
    for (let i = 0; i < cur.length; i += 7) { const wk = cur.slice(i, i + 7); if (!wk.length) continue; const s = new Date(wk[0].key + "T00:00:00"); out.push(mk(`${s.getMonth() + 1}/${s.getDate()}`, `Week of ${U_MONTHS[s.getMonth()]} ${s.getDate()}`, wk)); }
    return out;
  }
  const by = new Map<string, UDay[]>();
  for (const d of cur) { const dt = new Date(d.key + "T00:00:00"); const k = dt.getFullYear() + "-" + dt.getMonth(); let arr = by.get(k); if (!arr) { arr = []; by.set(k, arr); } arr.push(d); }
  return [...by.values()].map((days) => { const dt = new Date(days[0].key + "T00:00:00"); return mk(U_MONTHS[dt.getMonth()], `${U_MONTHS[dt.getMonth()]} ${dt.getFullYear()}`, days); });
}
