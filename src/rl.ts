// Account-wide usage limits: merge the readings, forecast whether the burn rate runs the window out.

// Shared by every session: each statusLine reports the same account numbers.
export const rl: { h5: number | null; h5Reset: number | null; d7: number | null; d7Reset: number | null } =
  { h5: null, h5Reset: null, d7: null, d7Reset: null };
// Same window (resets_at ±2min skew): usage only climbs, so keep the max. A later window
// replaces it; an earlier one is a lagging session's stale reading and is ignored.
export function mergeRl(curPct: number | null, curReset: number | null, pct: unknown, reset: unknown): [number | null, number | null] {
  const p = typeof pct === "number" ? pct : null;
  const r = typeof reset === "number" ? reset : null;
  if (p == null) return [curPct, curReset];
  if (r != null && curReset != null) {
    if (r > curReset + 120) return [p, r];
    if (r < curReset - 120) return [curPct, curReset];
  }
  const np = curPct == null ? p : Math.max(curPct, p);
  return [np, r != null ? Math.max(r, curReset ?? r) : curReset];
}
// Past the reset, show 0% until the next statusLine; a maxed-out meter must not linger.
export function rlPct(pct: number | null, reset: number | null): number | null {
  if (reset != null && reset * 1000 <= Date.now()) return 0;
  return pct;
}
export function rlReset(reset: number | null): number | null {
  return (reset != null && reset * 1000 <= Date.now()) ? null : reset;
}

// ---------- Usage-limit forecast ----------
// A level alone says nothing (62% burning fast is a lockout, 68% flat is fine), so sample
// used-% over time and extrapolate to the reset. Until two samples span `minSpan`, judge by level.
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
  if (last && now - last.t < 10_000 && pct === last.pct) return;
  buf.push({ t: now, pct });
  const cutoff = now - BURN_CFG[win].look;
  while (buf.length > 2 && buf[0].t < cutoff) buf.shift();
}
// %/hour over the recent samples, or null until enough span has been seen.
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
  rate: number | null; // the %/hr the projection ran on; the Usage card shows this, never the raw slope
}
// The recent slope is a burst rate and over-projects across hours, so the projection runs on
// the lower of it and the pace the window has sustained (used / elapsed). A steady burner is
// uncapped, so a real run-out still goes red; a time-decay damping would lose that.
const SUSTAIN_MIN_FRAC = 1 / 30; // ignore the sustained rate before this much of the window has run
export function forecastWin(pct: number | null, reset: number | null, burnPerHr: number | null, winLen?: number): Forecast {
  const used = rlPct(pct, reset);
  const resetTs = rlReset(reset);
  const secLeft = resetTs != null ? Math.max(0, resetTs - Math.floor(Date.now() / 1000)) : null;
  if (used == null) return { status: "ok", used: null, proj: null, etaSec: null, secLeft, resetTs, runsOut: false, hasRate: false, rate: null };
  if (burnPerHr == null || secLeft == null) {
    const status: FcStatus = used >= 100 ? "bad" : used >= 85 ? "warn" : "ok";
    return { status, used, proj: used, etaSec: null, secLeft, resetTs, runsOut: used >= 100, hasRate: false, rate: null };
  }
  const hLeft = secLeft / 3600;
  const rate = sustainedRate(used, secLeft, burnPerHr, winLen);
  const proj = used + rate * hLeft;
  const etaHr = rate > 1e-6 ? (100 - used) / rate : Infinity; // hours until 100%
  const runsOut = used >= 100 || etaHr <= hLeft;
  const status: FcStatus = runsOut ? "bad" : (proj >= 80 || used >= 85) ? "warn" : "ok";
  return { status, used, proj, etaSec: isFinite(etaHr) ? etaHr * 3600 : null, secLeft, resetTs, runsOut, hasRate: true, rate };
}
// Exported for the debug panel.
export function sustainedRate(used: number, secLeft: number, burnPerHr: number, winLen?: number): number {
  if (winLen == null) return burnPerHr;
  const elapsed = winLen - secLeft;
  if (used <= 0 || elapsed < winLen * SUSTAIN_MIN_FRAC) return burnPerHr;
  return Math.min(burnPerHr, used / (elapsed / 3600));
}
export const forecast5h = (): Forecast => forecastWin(rl.h5, rl.h5Reset, burnRate("h5"), H5_LEN);
export const forecast7d = (): Forecast => forecastWin(rl.d7, rl.d7Reset, burnRate("d7"), D7_LEN);

// ---- forecast-vs-actual log: the substrate that makes the model improvable ----
// On each window rotation, record what it reached vs. the halfway projection. Nothing consumes
// it yet. The logger is injected (`setRlLogger`) because ./debug is render layer.
let rlLog: (lvl: "info" | "warn" | "error", msg: string) => void = () => {};
export function setRlLogger(fn: (lvl: "info" | "warn" | "error", msg: string) => void) { rlLog = fn; }

// Inputs kept beside the outcome; the optional fields mark entries a calibration must discard.
export interface FcLogEntry {
  w: RlWin; closed: number; final: number; midProj: number | null; err: number | null;
  used?: number | null;   // used-% when the snapshot was taken
  burn?: number | null;   // %/hr the snapshot projected from
  at?: number;            // fraction of the window elapsed at the snapshot
  late?: number;          // seconds between the window's real reset and us noticing
  flat?: boolean;         // snapshot had ~no burn: correct-but-uninformative
}
export const fcLog: FcLogEntry[] = JSON.parse(localStorage.getItem("cc-forecast-log") || "[]");
export interface MidSnap { proj: number; used: number; burn: number; at: number }
export const midSnap: Record<RlWin, MidSnap | null> = { h5: null, d7: null };
// Snapshot the projection once past halfway. A flat-burn snapshot predicts nothing, so keep
// re-taking it until a real slope shows up or the window is SNAP_SETTLE gone.
const SNAP_SETTLE = 0.75;
export function maybeMidSnap(win: RlWin, reset: number | null) {
  if (reset == null) return;
  const len = win === "h5" ? H5_LEN : D7_LEN;
  const left = reset - Date.now() / 1000;
  if (left > len / 2) return;
  const at = Math.min(1, Math.max(0, (len - left) / len));
  const held = midSnap[win];
  if (held && (held.burn > 0 || at >= SNAP_SETTLE)) return; // already have one worth keeping
  const f = win === "h5" ? forecast5h() : forecast7d();
  if (!f.hasRate || f.proj == null || f.used == null) return;
  const burn = f.secLeft ? (f.proj - f.used) / (f.secLeft / 3600) : 0;
  midSnap[win] = { proj: f.proj, used: f.used, burn, at };
}
function logWindowClose(win: RlWin, finalPct: number | null, prevReset: number | null) {
  if (typeof finalPct !== "number") return;
  const snap = midSnap[win];
  const now = Math.floor(Date.now() / 1000);
  const e: FcLogEntry = {
    w: win, closed: now, final: finalPct,
    midProj: snap ? snap.proj : null, err: snap ? finalPct - snap.proj : null,
    used: snap ? snap.used : null, burn: snap ? snap.burn : null,
    at: snap ? snap.at : undefined,
    late: prevReset != null ? Math.max(0, now - prevReset) : undefined,
    flat: snap ? snap.burn <= 0 : undefined,
  };
  fcLog.push(e);
  if (fcLog.length > 200) fcLog.splice(0, fcLog.length - 200);
  localStorage.setItem("cc-forecast-log", JSON.stringify(fcLog));
  rlLog("info", `forecast · ${win} window closed at ${Math.round(finalPct)}%` +
    (snap ? ` (predicted ~${Math.round(snap.proj)}%, err ${e.err! >= 0 ? "+" : ""}${Math.round(e.err!)})` : "") +
    (e.late && e.late > 1800 ? `, noticed ${Math.round(e.late / 60)}min late` : ""));
}
// A later resets_at means the old window closed: log it once (`lastClosed` guards a lagging
// session repeating the rotation) and clear the samples. Exported so a test can reset it.
export const lastClosed: Record<RlWin, number | null> = { h5: null, d7: null };
export function onRlUpdate(win: RlWin, prevPct: number | null, prevReset: number | null, newReset: number | null) {
  if (newReset != null && prevReset != null && newReset > prevReset + 120) {
    if (lastClosed[win] !== prevReset) {
      lastClosed[win] = prevReset;
      logWindowClose(win, prevPct, prevReset);
    }
    rlSamples[win] = [];
    midSnap[win] = null;
  }
  pushRlSample(win, rlPct(win === "h5" ? rl.h5 : rl.d7, newReset));
  maybeMidSnap(win, newReset);
}
