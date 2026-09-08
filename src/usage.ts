// What agent sessions used, and when: the telemetry-fed cost rollup (`cc-usage` /
// `cc-usage-detail`) and token history (transcript scan + live provider counters), joined
// per calendar day by `usageWindow`. Storage cadences: docs/architecture.md.

import { hasAgentCapability, type AgentTokenBreakdown, type AgentTokenUsage, type InstallFile, type Sess } from "./types";
import { readList, readObj } from "./store";
import { basename } from "./format";

// ---------- the daily rollup (telemetry-fed) ----------

// Family, not display name: "Opus 4.8" changes across releases, the tier does not.
export function modelFamily(m: string): string {
  const s = (m || "").toLowerCase();
  if (s.includes("opus")) return "Opus";
  if (s.includes("sonnet")) return "Sonnet";
  if (s.includes("haiku")) return "Haiku";
  return m ? "Other" : "Unknown";
}

// `cc-usage` is the authoritative per-day total; `cc-usage-detail` layers the per-model /
// per-project / per-session split on it, each recorded only from the build that added it.
export interface DaySess { usd: number; title: string; project: string }
export interface DayDetail {
  models: Record<string, number>;
  projects: Record<string, number>;
  sess?: Record<string, DaySess>;
}
export const usage: Record<string, number> = readObj<number>("cc-usage");
export const usageDetail: Record<string, DayDetail> = readObj<DayDetail>("cc-usage-detail");
export function todayKey() { return dayKeyOf(Date.now()); }
// Local wall-clock day, never UTC, like every key in both stores. One formatter, two
// spellings: `uDkey` takes a Date, `dayKeyOf` the milliseconds.
export const uDkey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function dayKeyOf(ms: number) { return uDkey(new Date(ms)); }

// `cc-usage` is written eagerly (small, and lost spend is unreconstructable). The detail
// split is ~25x bigger and would otherwise be stringified about once a second on a working
// fleet, so its write is floored; a lost minute shows up as `unattributed` in `daySpend`.
const DETAIL_SAVE_FLOOR_MS = 30_000;
const USAGE_MAX_DAYS = 420; // the panel's widest range is 12 months
let detailSavedAt = 0;
let detailDirty = false;
let detailDay = "";
function trimDays(o: Record<string, unknown>) {
  const keys = Object.keys(o).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - USAGE_MAX_DAYS))) delete o[old];
}
// Test-only: the floor's bookkeeping is module state that outlives one `it`.
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
  if (!s || !hasAgentCapability(s, "usage")) return;
  const d = usageDetail[k] || (usageDetail[k] = { models: {}, projects: {} });
  const fam = modelFamily(s.model);
  d.models[fam] = (d.models[fam] || 0) + delta;
  const proj = s.project || basename(s.workdir) || "unknown";
  d.projects[proj] = (d.projects[proj] || 0) + delta;
  if (!s.id) return;
  const bag = d.sess || (d.sess = {});
  const e = bag[s.id] || (bag[s.id] = { usd: 0, title: "", project: proj });
  e.usd += delta;
  if (s.title) e.title = s.title; // re-stamped: the title arrives after the first dollar
  e.project = proj;
  // A day left behind is flushed regardless of the floor: nothing will write it again.
  const rolled = detailDay !== "" && detailDay !== k;
  detailDay = k;
  detailDirty = true;
  if (rolled || Date.now() - detailSavedAt >= DETAIL_SAVE_FLOOR_MS) flushUsageDetail();
}

// Each split gets its own `unattributed` remainder against `total`: the two record from
// different builds, so each can fall short on its own. An empty split stays empty (the
// day predates the record) rather than growing one anonymous row claiming the whole day.
export interface SpendRow { key: string; label: string; sub: string; usd: number }
export interface DaySpend { total: number; projects: SpendRow[]; sessions: SpendRow[]; split: number }
const SPEND_EPS = 0.005; // float slack: the same deltas summed in a different order
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

// Bytes per day in MiB, the only durable record: `all_sessions_resources` is a run figure
// that dies with the app. No back-fill; a missing day renders "not recorded", not zero.
export interface DayIo { r: number; w: number }
const IO_KEY = "cc-io";
const IO_MAX_DAYS = 420; // ~14 months; bounded by count like COST_BASE_MAX
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

// Counters restart on every Episko launch, so a reading below the last one is normal and
// clamps to zero. With no previous reading the whole figure is this run's.
export function ioDelta(cur: DayIo, prev: DayIo | null): DayIo {
  const p = prev ?? { r: 0, w: 0 };
  return { r: Math.max(0, cur.r - p.r), w: Math.max(0, cur.w - p.w) };
}

const nextMidnight = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0); // not +86_400_000: DST days are not 24 hours
  return d.getTime();
};

// A wider window is a clock jump or a laptop that slept; the excess lands on the end day.
const IO_SPLIT_MAX_MS = 7 * 86_400_000;

// Spread an increment over the days its window covers: the poll can go quiet for hours, so
// a reading after midnight is partly yesterday's. Split by wall-clock share, with the float
// remainder on the last bucket so the parts sum to exactly the increment.
export function splitIo(d: DayIo, fromMs: number, toMs: number): Array<[string, DayIo]> {
  // No window (first poll of a run, or a clock that went backwards): all of it is today's.
  // Must come before the clamp, which would turn an absent window into a week-wide one.
  if (!(fromMs > 0) || fromMs >= toMs) return [[dayKeyOf(toMs), { r: d.r, w: d.w }]];
  const from = Math.max(fromMs, toMs - IO_SPLIT_MAX_MS);
  if (dayKeyOf(from) === dayKeyOf(toMs)) return [[dayKeyOf(toMs), { r: d.r, w: d.w }]];

  const span = toMs - from;
  const out: Array<[string, DayIo]> = [];
  let r = 0, w = 0;
  for (let cur = from; cur < toMs;) {
    const end = Math.min(nextMidnight(cur), toMs);
    const share = (end - cur) / span;
    const part = { r: d.r * share, w: d.w * share };
    out.push([dayKeyOf(cur), part]);
    r += part.r; w += part.w;
    cur = end;
  }
  const last = out[out.length - 1][1];
  last.r += d.r - r; last.w += d.w - w;
  return out;
}

// The 4s poll must not write on every reading, so only the write is floored; a minute
// lost to a crash is fine for a disk meter, unlike money.
const IO_SAVE_FLOOR_MS = 60_000;
let ioPrev: DayIo | null = null;
let ioPrevAt = 0; // the increment belongs to [ioPrevAt, now]; see splitIo
let ioSavedAt = 0;
let ioDirty = false;
let ioDay = "";

// ---------- keeping a Claude Code self-update out of the figures ----------

// The `claude` binaries at the previous poll, name → MiB. A self-update writes a ~290 MiB
// binary from a session pid the meter sums, so its growth on disk comes off the figure:
// evidence, never a size threshold, which would also swallow a runaway agent.
let instPrev: Map<string, number> | null = null;
export function installGrown(cur: InstallFile[], prev: Map<string, number> | null): number {
  if (!prev) return 0;
  let grown = 0;
  for (const f of cur) grown += Math.max(0, f.mb - (prev.get(f.name) ?? 0));
  return grown;
}

let ioCredit = 0; // MiB of new claude binary not yet taken off a write figure
let ioCreditAt = 0;
// An unclaimed credit is an update some claude outside Episko did, whose bytes we were
// never charged for; dropping it stops it becoming a standing discount on real churn.
const IO_CREDIT_TTL_MS = 10 * 60_000;
let ioExcluded = 0; // MiB discounted this run; bounds the discount and nets pollIo's run figure
export const ioExcludedMb = (): number => ioExcluded;

export interface IoBank {
  credited: number; // MiB discounted as a self-update on this poll
  windowMs: number; // 0 on a run's first reading
}

// The self-update share of a poll's write rate, from the same sample as the total, so the
// bar cannot spike over bytes the figure beside it has disowned.
export function ioCreditBps(b: IoBank): number {
  return b.windowMs > 0 ? (b.credited * 1024 * 1024) / (b.windowMs / 1000) : 0;
}

// Bank a reading, from the same poll that updates `ioAll`. A polling gap loses nothing (the
// counters are cumulative) but decides which day gets the bytes, hence `splitIo`. `ioPrev`
// keeps the raw reading: deltas are taken gross and the discount applied afterwards.
export function addIo(cur: DayIo, install: InstallFile[] = [], now: number = Date.now()): IoBank {
  const grown = installGrown(install, instPrev);
  instPrev = new Map(install.map((f) => [f.name, f.mb]));
  if (grown > 0) { ioCredit += grown; ioCreditAt = now; }
  else if (ioCredit > 0 && now - ioCreditAt > IO_CREDIT_TTL_MS) ioCredit = 0;

  const d = ioDelta(cur, ioPrev);
  const from = ioPrevAt;
  // Advanced on a zero increment too, so an idle stretch shortens the next window.
  ioPrev = cur;
  ioPrevAt = now;

  // Spend the credit against this window first, then today's stored figure: the file's
  // bytes and its directory entry can land in different polls, in either order.
  let credited = 0;
  let retro = 0;
  if (ioCredit > 0) {
    // Never give back more than this run reported (an outside claude's update is not ours).
    const room = () => Math.max(0, cur.w - ioExcluded - credited);
    const off = (avail: number) => {
      const take = Math.min(ioCredit, Math.max(0, avail), room());
      ioCredit -= take;
      credited += take;
      return take;
    };
    d.w -= off(d.w);                       // 1. this window's increment, before it is booked
    // 2. what an earlier window already booked, today only: further back is a guess.
    const today = dayIo[dayKeyOf(now)];
    if (today) {
      retro = off(today.w);
      today.w -= retro;
      if (retro > 0) ioDirty = true;
    }
    ioExcluded += credited;
  }

  const bank: IoBank = { credited, windowMs: from > 0 && now > from ? now - from : 0 };
  if (d.r <= 0 && d.w <= 0 && credited === 0) return bank;

  let rolled = false;
  if (d.r > 0 || d.w > 0) {
    const parts = splitIo(d, from, now);
    const k = parts[parts.length - 1][0];
    // A day left behind is flushed regardless of the floor (nothing writes it again); a
    // split across days has left one behind by construction.
    rolled = parts.length > 1 || (ioDay !== "" && ioDay !== k);
    ioDay = k;
    for (const [key, part] of parts) {
      const day = dayIo[key] || (dayIo[key] = { r: 0, w: 0 });
      day.r += part.r;
      day.w += part.w;
    }
    ioDirty = true;
  }
  // `retro` took bytes back out of a stored day, so it flushes early too. Not `credited`:
  // that would flush on every poll for as long as a binary was still growing on disk.
  if (ioDirty && (rolled || retro > 0 || now - ioSavedAt >= IO_SAVE_FLOOR_MS)) flushIo();
  return bank;
}

export function flushIo(): void {
  if (!ioDirty) return;
  ioDirty = false;
  ioSavedAt = Date.now();
  const keys = Object.keys(dayIo).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - IO_MAX_DAYS))) delete dayIo[old];
  localStorage.setItem(IO_KEY, JSON.stringify(dayIo));
}

export function resetIoRollup() { // test-only; the app's own copy outlives the run
  for (const k of Object.keys(dayIo)) delete dayIo[k];
  ioPrev = null;
  ioPrevAt = 0;
  ioSavedAt = 0;
  ioDirty = false;
  ioDay = "";
  instPrev = null;
  ioCredit = 0;
  ioCreditAt = 0;
  ioExcluded = 0;
  localStorage.removeItem(IO_KEY);
}

// Null when nothing is recorded, never `{r:0,w:0}`: an empty rollup means "not kept",
// and a confident zero would say the disk was idle.
export function ioTotal(): DayIo | null {
  const days = Object.values(dayIo);
  if (!days.length) return null;
  let r = 0, w = 0;
  for (const v of days) { r += v.r; w += v.w; }
  return { r, w };
}

export function ioDayCount(): number {
  return Object.keys(dayIo).length;
}

// The three windows genuinely coincide early on, which reads as a click that does nothing,
// so the row says why. Compared on rendered strings: a byte apart is the same to the reader.
export function ioSameNote(today: string, run: string, all: string, days: number): string | null {
  if (today === run && run === all) {
    return days <= 1
      ? "All three windows are the same so far: today is the only day recorded, and all of it is this run."
      : "All three windows happen to read the same right now.";
  }
  if (today === run) return "Today is all this run; nothing was recorded earlier today.";
  if (today === all) return "Today is everything recorded so far.";
  return null;
}

// The statusLine total belongs to the conversation, which `--resume` carries across panes
// and restarts, so the baseline is keyed by Claude's runtime session id (`Sess.resumeId`)
// and persisted. A reading below it means the counter restarted: the whole reading is
// fresh and the baseline follows it down, which is what makes a stale entry harmless.
const COST_BASE_KEY = "cc-cost-base";
const COST_BASE_MAX = 500; // enough that a conversation still being resumed is never evicted
// `t` is the conversation's tip, `o` the last total per pane: one conversation can have
// two live panes, each with its own counter, and a shared baseline would read their
// interleaved readings as endless drops. The tip only seeds a pane `o` has never met.
interface CostBase { t: number; at: number; o?: Record<string, number> }
const costBaseline = ((): Map<string, CostBase> => {
  const m = new Map<string, CostBase>();
  try {
    const raw = JSON.parse(localStorage.getItem(COST_BASE_KEY) || "{}") as Record<string, CostBase>;
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.t === "number" && typeof v.at === "number") {
        // Narrowed a value at a time: a bad `o` loses the per-pane split, never the boot.
        const o = v.o && typeof v.o === "object"
          ? Object.fromEntries(Object.entries(v.o).filter(([, n]) => typeof n === "number"))
          : undefined;
        m.set(k, o && Object.keys(o).length ? { t: v.t, at: v.at, o } : { t: v.t, at: v.at });
      }
    }
  } catch { /* a corrupt key costs one over-counted session, not a boot */ }
  return m;
})();
function saveBaselines() {
  if (costBaseline.size > COST_BASE_MAX) {
    // Evict the oldest touch: least likely to still carry a live counter.
    const keep = [...costBaseline.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, COST_BASE_MAX);
    costBaseline.clear();
    for (const [k, v] of keep) costBaseline.set(k, v);
  }
  localStorage.setItem(COST_BASE_KEY, JSON.stringify(Object.fromEntries(costBaseline)));
}
export function costDelta(conv: string, total: number, dropsAreReset = true, owner = conv): number {
  const e = costBaseline.get(conv);
  // This pane's own last reading, else the conversation's tip (what a restored pane inherits).
  const prev = e ? e.o?.[owner] ?? e.t : undefined;
  // A Claude drop is a counter restart; a provider's derived estimate can be revised down
  // by a pricing update, so those callers keep the high-water mark instead.
  const baseline = !dropsAreReset && prev !== undefined ? Math.max(prev, total) : total;
  let o = { ...e?.o, [owner]: baseline };
  if (Object.keys(o).length > 8) o = { [owner]: baseline }; // this many panes is churn, not history
  costBaseline.set(conv, { t: baseline, at: Date.now(), o });
  // Only when the figure moved: statusLines land every 10s per session, spent or not.
  // `at` only orders eviction and rides along on the next real write.
  if (prev !== baseline) saveBaselines();
  if (prev === undefined) return total;
  if (total < prev) return dropsAreReset ? total : 0;
  return total - prev;
}
// Test-only; the app's own copy outlives the run.
export function resetCostBaselines() { costBaseline.clear(); localStorage.removeItem(COST_BASE_KEY); }

// ---------- Usage analytics (the Usage & spend window) ----------
// One day's tokens by type and model family. Claude's come from the transcript scan
// (full history); provider deltas record from the first integrated session onward.
export interface DayUsage {
  day: string; input: number; output: number; cache_read: number; cache_write: number;
  opus: number; sonnet: number; haiku: number; other: number;
  sessions: number; projects: Record<string, number>;
}
export type UDay = { key: string; cost: number; tok: number; u?: DayUsage };
interface LiveTokenDay extends DayUsage { session_ids: string[] }
const scannedTokenDays: { value: DayUsage[] } = { value: readList<DayUsage>("cc-usage-tokens") };
const liveTokenDays: LiveTokenDay[] = readList<LiveTokenDay>("cc-agent-usage-tokens");
function mergeTokenDays(scanned: DayUsage[], live: LiveTokenDay[]): DayUsage[] {
  const by = new Map<string, DayUsage>();
  const add = (d: DayUsage) => {
    let x = by.get(d.day);
    if (!x) {
      x = { day: d.day, input: 0, output: 0, cache_read: 0, cache_write: 0, opus: 0, sonnet: 0, haiku: 0, other: 0, sessions: 0, projects: {} };
      by.set(d.day, x);
    }
    for (const k of ["input", "output", "cache_read", "cache_write", "opus", "sonnet", "haiku", "other", "sessions"] as const) x[k] += d[k] || 0;
    for (const [project, tokens] of Object.entries(d.projects || {})) x.projects[project] = (x.projects[project] || 0) + tokens;
  };
  scanned.forEach(add); live.forEach(add);
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}
export let tokenDays: DayUsage[] = mergeTokenDays(scannedTokenDays.value, liveTokenDays);
export let tokenScanAt = +(localStorage.getItem("cc-usage-tokens-at") || 0);
// The scan needs `invoke`, so main.ts runs it and hands the result here.
export function setTokenDays(days: DayUsage[]) {
  scannedTokenDays.value = days;
  tokenDays = mergeTokenDays(scannedTokenDays.value, liveTokenDays);
  tokenScanAt = Date.now();
  localStorage.setItem("cc-usage-tokens", JSON.stringify(scannedTokenDays.value));
  localStorage.setItem("cc-usage-tokens-at", String(tokenScanAt));
}

// Provider token counters are cumulative, so the baseline is persisted per provider thread
// (like the cost baseline). Claude is excluded: its transcript scan is already authoritative.
const TOKEN_BASE_KEY = "cc-agent-token-base";
interface TokenBase extends AgentTokenBreakdown { at: number }
const tokenBase = new Map<string, TokenBase>(Object.entries(readObj<TokenBase>(TOKEN_BASE_KEY)));
const tokenFields = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
function tokenDiff(cur: AgentTokenBreakdown, prev?: TokenBase): AgentTokenBreakdown {
  const reset = !!prev && tokenFields.some((k) => cur[k] < prev[k]);
  const n = (k: typeof tokenFields[number]) => !prev || reset ? cur[k] : Math.max(0, cur[k] - prev[k]);
  return {
    totalTokens: n("totalTokens"), inputTokens: n("inputTokens"), cachedInputTokens: n("cachedInputTokens"),
    cacheWriteInputTokens: n("cacheWriteInputTokens"), outputTokens: n("outputTokens"), reasoningOutputTokens: n("reasoningOutputTokens"),
  };
}
export function addAgentTokenUsage(s: Sess, reading: AgentTokenUsage): void {
  if (!s.provider || s.provider === "claude") return;
  const id = `${s.provider}:${s.resumeId || s.id}`;
  const prev = tokenBase.get(id);
  const d = tokenDiff(reading.total, prev);
  if (!prev || tokenFields.some((k) => prev[k] !== reading.total[k])) {
    tokenBase.set(id, { ...reading.total, at: Date.now() });
    localStorage.setItem(TOKEN_BASE_KEY, JSON.stringify(Object.fromEntries(tokenBase)));
  }
  if (!(d.totalTokens > 0 || d.inputTokens > 0 || d.outputTokens > 0)) return;
  const day = todayKey();
  let row = liveTokenDays.find((x) => x.day === day);
  if (!row) {
    row = { day, input: 0, output: 0, cache_read: 0, cache_write: 0, opus: 0, sonnet: 0, haiku: 0, other: 0, sessions: 0, projects: {}, session_ids: [] };
    liveTokenDays.push(row);
  }
  // OpenAI's input total includes its cached subset; keep `input + cache_read` equal to it.
  const input = Math.max(0, d.inputTokens - d.cachedInputTokens);
  const processed = input + d.cachedInputTokens + d.cacheWriteInputTokens + d.outputTokens;
  row.input += input; row.cache_read += d.cachedInputTokens; row.cache_write += d.cacheWriteInputTokens; row.output += d.outputTokens;
  row.other += processed;
  const project = s.project || basename(s.workdir) || "unknown";
  row.projects[project] = (row.projects[project] || 0) + processed;
  if (!row.session_ids.includes(id)) { row.session_ids.push(id); row.sessions++; }
  liveTokenDays.sort((a, b) => a.day.localeCompare(b.day));
  while (liveTokenDays.length > USAGE_MAX_DAYS) liveTokenDays.shift();
  localStorage.setItem("cc-agent-usage-tokens", JSON.stringify(liveTokenDays));
  tokenDays = mergeTokenDays(scannedTokenDays.value, liveTokenDays);
}
export let usageRange = 30; // days the analytics panel looks back
export function setUsageRange(n: number) { usageRange = n; }

export const U_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Sum a day's per-model tokens into a fixed-key record (backfill fields are lowercase).
export const uModels = (a: UDay[]): Record<string, number> => {
  const m: Record<string, number> = { Opus: 0, Sonnet: 0, Haiku: 0, Other: 0 };
  for (const d of a) if (d.u) { m.Opus += d.u.opus; m.Sonnet += d.u.sonnet; m.Haiku += d.u.haiku; m.Other += d.u.other; }
  return m;
};

// The last n calendar days ending today, oldest first, each joined to its cost and tokens.
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
