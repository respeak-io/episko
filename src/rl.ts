// Account-wide usage limits: merging the readings, and forecasting whether the
// current burn rate runs the window out before it resets. Pure arithmetic over
// numbers and the clock — no DOM, no Tauri — so it can be unit-tested in
// isolation, like ./diff. See test/rl.test.ts.
//
// The window-rotation bookkeeping (the forecast-vs-actual log) stays in main.ts:
// it writes localStorage and logs to the debug console, which is wiring, not math.

// Account-wide rate limits. Every session's statusLine reports the same account
// numbers, but only as fresh as *that* session last refreshed them — an idle
// session lags a busy one. Kept as ONE copy shown identically across all sessions.
export const rl: { h5: number | null; h5Reset: number | null; d7: number | null; d7Reset: number | null } =
  { h5: null, h5Reset: null, d7: null, d7Reset: null };
// Merge a session's rate-limit reading into the shared copy. Naive last-writer-wins
// made the % flip between sessions' stale snapshots (e.g. 13 ↔ 19 ↔ 21). Within one
// window (same resets_at, ±2min tolerance for clock skew) usage only climbs, so we
// keep the MAX; a genuinely later window supersedes and replaces (so a reset drops
// the number instead of clinging to the old peak). Stale readings from a lagging
// session (an earlier window) are ignored.
export function mergeRl(curPct: number | null, curReset: number | null, pct: unknown, reset: unknown): [number | null, number | null] {
  const p = typeof pct === "number" ? pct : null;
  const r = typeof reset === "number" ? reset : null;
  if (p == null) return [curPct, curReset];
  if (r != null && curReset != null) {
    if (r > curReset + 120) return [p, r];              // a genuinely newer window
    if (r < curReset - 120) return [curPct, curReset];  // stale reading from a lagging session
  }
  const np = curPct == null ? p : Math.max(curPct, p);  // same window → the peak is freshest
  return [np, r != null ? Math.max(r, curReset ?? r) : curReset];
}
// Once a window's reset time passes, show 0% until the next statusLine refreshes
// it — otherwise a maxed-out (1xx%) meter would linger past the reset.
export function rlPct(pct: number | null, reset: number | null): number | null {
  if (reset != null && reset * 1000 <= Date.now()) return 0;
  return pct;
}
export function rlReset(reset: number | null): number | null {
  return (reset != null && reset * 1000 <= Date.now()) ? null : reset;
}

// ---------- Usage-limit forecast ----------
// A percentage alone can't tell you if you're in trouble: 62% burning fast is a
// lockout, 68% sitting flat is fine. So we sample the (merged, monotonic) used-%
// over time, estimate a burn rate, extrapolate it to the window's reset, and turn
// that into a green/amber/red verdict. Samples are in-memory per app run — burn is
// "unknown" until we've seen >=2 readings spanning a little time, and until then we
// colour by level alone rather than invent a slope from a single reading.
export const H5_LEN = 5 * 3600, D7_LEN = 7 * 86400; // window lengths, seconds
export type RlWin = "h5" | "d7";
export interface RlSample { t: number; pct: number }
export const rlSamples: Record<RlWin, RlSample[]> = { h5: [], d7: [] };
// look = how far back the slope is measured; minSpan = least span we'll trust.
const BURN_CFG: Record<RlWin, { look: number; minSpan: number }> = {
  h5: { look: 30 * 60_000, minSpan: 3 * 60_000 },
  d7: { look: 6 * 3_600_000, minSpan: 15 * 60_000 },
};
export function pushRlSample(win: RlWin, pct: number | null) {
  if (pct == null) return;
  const buf = rlSamples[win], now = Date.now(), last = buf[buf.length - 1];
  if (last && now - last.t < 10_000 && pct === last.pct) return; // nothing new to record
  buf.push({ t: now, pct });
  const cutoff = now - BURN_CFG[win].look;
  while (buf.length > 2 && buf[0].t < cutoff) buf.shift();
}
// %/hour at the recent pace, or null when there isn't enough to trust one.
export function burnRate(win: RlWin): number | null {
  const buf = rlSamples[win];
  if (buf.length < 2) return null;
  const a = buf[0], b = buf[buf.length - 1], spanMs = b.t - a.t;
  if (spanMs < BURN_CFG[win].minSpan) return null;
  return Math.max(0, (b.pct - a.pct) / (spanMs / 3_600_000)); // usage only climbs; clamp jitter
}

export type FcStatus = "ok" | "warn" | "bad";
export interface Forecast {
  status: FcStatus; used: number | null; proj: number | null;
  etaSec: number | null; secLeft: number | null; resetTs: number | null;
  runsOut: boolean; hasRate: boolean;
}
export function forecastWin(pct: number | null, reset: number | null, burnPerHr: number | null): Forecast {
  const used = rlPct(pct, reset);
  const resetTs = rlReset(reset);
  const secLeft = resetTs != null ? Math.max(0, resetTs - Math.floor(Date.now() / 1000)) : null;
  if (used == null) return { status: "ok", used: null, proj: null, etaSec: null, secLeft, resetTs, runsOut: false, hasRate: false };
  // No trustworthy slope yet, or no active window → judge by level alone (treat as flat).
  if (burnPerHr == null || secLeft == null) {
    const status: FcStatus = used >= 100 ? "bad" : used >= 85 ? "warn" : "ok";
    return { status, used, proj: used, etaSec: null, secLeft, resetTs, runsOut: used >= 100, hasRate: false };
  }
  const hLeft = secLeft / 3600;
  const proj = used + burnPerHr * hLeft;
  const etaHr = burnPerHr > 1e-6 ? (100 - used) / burnPerHr : Infinity; // hours until 100%
  const runsOut = used >= 100 || etaHr <= hLeft;
  const status: FcStatus = runsOut ? "bad" : (proj >= 80 || used >= 85) ? "warn" : "ok";
  return { status, used, proj, etaSec: isFinite(etaHr) ? etaHr * 3600 : null, secLeft, resetTs, runsOut, hasRate: true };
}
export const forecast5h = (): Forecast => forecastWin(rl.h5, rl.h5Reset, burnRate("h5"));
export const forecast7d = (): Forecast => forecastWin(rl.d7, rl.d7Reset, burnRate("d7"));
