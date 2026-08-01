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
export interface DayDetail { models: Record<string, number>; projects: Record<string, number>; sessions: string[] }
export const usage: Record<string, number> = JSON.parse(localStorage.getItem("cc-usage") || "{}");
export const usageDetail: Record<string, DayDetail> = JSON.parse(localStorage.getItem("cc-usage-detail") || "{}");
export function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
export function addUsage(delta: number, s?: Sess) {
  if (!(delta > 0)) return;
  const k = todayKey();
  usage[k] = (usage[k] || 0) + delta;
  localStorage.setItem("cc-usage", JSON.stringify(usage));
  if (!s || !isAgent(s)) return;
  // Attribute the cost delta to whichever model is active right now and to the
  // session's project — the closest honest split the statusLine data allows.
  const d = usageDetail[k] || (usageDetail[k] = { models: {}, projects: {}, sessions: [] });
  const fam = modelFamily(s.model);
  d.models[fam] = (d.models[fam] || 0) + delta;
  const proj = s.project || basename(s.workdir) || "unknown";
  d.projects[proj] = (d.projects[proj] || 0) + delta;
  if (s.id && !d.sessions.includes(s.id)) d.sessions.push(s.id);
  localStorage.setItem("cc-usage-detail", JSON.stringify(usageDetail));
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
  saveBaselines();
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
