// Account-wide usage limits: merging the readings, and forecasting whether the
// current burn rate runs the window out before it resets. Pure arithmetic over
// numbers and the clock — no DOM, no Tauri — so it can be unit-tested in
// isolation, like ./diff. See test/rl.test.ts.
//
// The window-rotation bookkeeping (the forecast-vs-actual log) lives here too. It
// writes localStorage, which is fine, and narrates to the debug console, which is
// not — so the one line that repaints reaches this module through `setRlLogger`
// rather than this module reaching up into main.ts.

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
  // The %/hr the projection actually ran on — the recent slope, or the window's
  // sustained pace where that is lower. Surfaced so the Usage card can show the
  // rate its own "Projected @ reset" follows from; displaying the raw slope beside
  // a capped projection invites the reader to check the arithmetic and find it wrong.
  rate: number | null;
}
// The recent slope alone is a *burst* rate, and extrapolating a burst across hours
// is what wrecked the old projections: 37 logged windows put every large error on
// the over-projection side (-80, -51, -41 points) while under-projection never
// passed +12, and the one red alarm ever raised projected 127% on a window that
// closed at 47%. So cap the projected rate at the pace the window has actually
// sustained (used / elapsed). For a steady burner the two rates are equal, so the
// cap does nothing and a genuine run-out still goes red — the property a plain
// time-decay damping loses (it drops a dead-on 100% path to 83% at the midpoint).
// It binds only when a burst outruns the window's own history. Back-tested over
// the 14 windows whose logged close lines up with a real window boundary: mean
// error 7.0 → 4.8 points, worst over-projection 72 → 39, and not one window made
// worse. Needs the window length to know how long the window has been open.
const SUSTAIN_MIN_FRAC = 1 / 30; // ignore the sustained rate before this much of the window has run
export function forecastWin(pct: number | null, reset: number | null, burnPerHr: number | null, winLen?: number): Forecast {
  const used = rlPct(pct, reset);
  const resetTs = rlReset(reset);
  const secLeft = resetTs != null ? Math.max(0, resetTs - Math.floor(Date.now() / 1000)) : null;
  if (used == null) return { status: "ok", used: null, proj: null, etaSec: null, secLeft, resetTs, runsOut: false, hasRate: false, rate: null };
  // No trustworthy slope yet, or no active window → judge by level alone (treat as flat).
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
// The recent slope, held down to the window's own average pace once the window has
// run long enough for that average to mean anything. Exported for the debug panel.
export function sustainedRate(used: number, secLeft: number, burnPerHr: number, winLen?: number): number {
  if (winLen == null) return burnPerHr;
  const elapsed = winLen - secLeft;
  if (used <= 0 || elapsed < winLen * SUSTAIN_MIN_FRAC) return burnPerHr;
  return Math.min(burnPerHr, used / (elapsed / 3600));
}
export const forecast5h = (): Forecast => forecastWin(rl.h5, rl.h5Reset, burnRate("h5"), H5_LEN);
export const forecast7d = (): Forecast => forecastWin(rl.d7, rl.d7Reset, burnRate("d7"), D7_LEN);

// ---- forecast-vs-actual log: the substrate that makes the model improvable ----
// On every window rotation we record what the closing window actually reached vs.
// what we'd projected at its halfway mark. Purely a measurement store for now
// (localStorage, capped) — nothing consumes it yet; it's what a future threshold-
// calibration / error-band pass reads. Expensive to backfill, cheap to keep.
// Narrating a window close repaints the debug panel, which is wiring; main.ts hands
// `dlog` over at startup and until then the log is silent.
let rlLog: (lvl: "info" | "warn" | "error", msg: string) => void = () => {};
export function setRlLogger(fn: (lvl: "info" | "warn" | "error", msg: string) => void) { rlLog = fn; }

// An entry is only worth calibrating against if it records the *inputs* as well as
// the outcome, and if we know how trustworthy it is. The first version of this log
// stored only {final, midProj, err}, and reading 38 real entries back showed why
// that is not enough: `used` and `burn` are gone, so an error cannot be decomposed
// (a 20-point miss from a bad slope and one from a stale level look identical), and
// 24 of the 38 closes were detected so long after the window really ended that they
// are not mid-window forecasts at all. Nine more scored a perfect zero because the
// snapshot caught an idle moment — a flat projection of a window that stayed idle is
// right for no reason, and averaging those in flattered the accuracy. So: keep the
// inputs, and mark the entries a calibration must throw away rather than silently
// mixing them in.
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
// Take the projection once the window is past halfway. A snapshot caught while the
// burn is flat predicts nothing, so keep re-taking it until either a real slope
// shows up or the window is three-quarters gone and flat is the honest answer.
const SNAP_SETTLE = 0.75;
export function maybeMidSnap(win: RlWin, reset: number | null) {
  if (reset == null) return;
  const len = win === "h5" ? H5_LEN : D7_LEN;
  const left = reset - Date.now() / 1000;
  if (left > len / 2) return; // not yet past the halfway mark
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
    (e.late && e.late > 1800 ? ` — noticed ${Math.round(e.late / 60)}min late` : ""));
}
// Called after each merge with the pre/post reset so we can spot a window rotation
// (a genuinely later resets_at). On rotation the old window closed: log how it went,
// and clear the burn samples so the new window's slope starts clean.
// `lastClosed` guards the double-log seen in the real data (two h5 closes six minutes
// apart): a second lagging session reporting the same rotation must not log it twice.
// Exported for the same reason `rlSamples`/`midSnap` are — it is module state a test
// has to clear between cases, exactly as a rotation clears the rest.
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
