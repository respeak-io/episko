import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { store } from "./localstorage"; // must precede the subject import
import {
  burnRate, forecast5h, forecast7d, mergeRl, pushRlSample, rl, rlPct, rlReset,
  rlSamples, forecastWin, fcLog, maybeMidSnap, midSnap, onRlUpdate, setRlLogger,
  lastClosed, H5_LEN,
} from "../src/rl";

// A fixed epoch so "one hour before the reset" is a number. 2027-01-15T08:00:00Z.
const NOW_MS = 1800000000000;
const NOW_S = NOW_MS / 1000;
const HOUR = 3600;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  // Both are module state the app itself resets on a window rotation (onRlUpdate
  // does exactly this), so tests clear them the same way.
  rlSamples.h5 = [];
  rlSamples.d7 = [];
  rl.h5 = rl.h5Reset = rl.d7 = rl.d7Reset = null;
  fcLog.length = 0;
  midSnap.h5 = midSnap.d7 = null;
  lastClosed.h5 = lastClosed.d7 = null;
  setRlLogger(() => {});
  store.clear();
});
afterEach(() => { vi.useRealTimers(); });

// Advance the fake clock by whole minutes.
const tick = (min: number) => vi.setSystemTime(Date.now() + min * 60_000);

describe("mergeRl — reconciling readings from sessions that lag each other", () => {
  it("ignores a reading whose percentage isn't a number", () => {
    expect(mergeRl(20, 1000, undefined, undefined)).toEqual([20, 1000]);
    expect(mergeRl(20, 1000, null, 2000)).toEqual([20, 1000]);
    expect(mergeRl(20, 1000, "30", 2000)).toEqual([20, 1000]);
  });
  it("takes the first reading as-is, including a legitimate 0%", () => {
    expect(mergeRl(null, null, 13, 1000)).toEqual([13, 1000]);
    expect(mergeRl(null, null, 0, 1000)).toEqual([0, 1000]); // 0 is data, not "missing"
  });
  it("keeps the peak within one window — the fix for the 13 ↔ 19 ↔ 21 flip", () => {
    // Usage only climbs inside a window, so a lower number is a staler snapshot.
    expect(mergeRl(13, 1000, 19, 1000)).toEqual([19, 1000]);
    expect(mergeRl(21, 1000, 13, 1000)).toEqual([21, 1000]);
  });
  it("treats a reset within ±2min as the same window (clock skew)", () => {
    expect(mergeRl(21, 1000, 13, 1060)).toEqual([21, 1060]);  // 60s later: same window
    expect(mergeRl(21, 1000, 13, 940)).toEqual([21, 1000]);   // 60s earlier: same window
  });
  it("lets a genuinely later window supersede, dropping the old peak", () => {
    // The whole point: after a reset the meter must fall, not cling to 97%.
    expect(mergeRl(97, 1000, 4, 2000)).toEqual([4, 2000]);
  });
  it("discards a reading from an earlier window, however high", () => {
    expect(mergeRl(50, 2000, 90, 1000)).toEqual([50, 2000]);
  });
  it("merges a percentage that arrives without a reset time", () => {
    expect(mergeRl(50, 2000, 60, undefined)).toEqual([60, 2000]);
    expect(mergeRl(50, null, 60, 3000)).toEqual([60, 3000]);
  });
});

describe("rlPct / rlReset — a window that has already reset", () => {
  it("shows 0% and no reset time once the reset moment has passed", () => {
    // Otherwise a maxed-out 1xx% meter lingers until some session refreshes it.
    expect(rlPct(97, NOW_S - 1)).toBe(0);
    expect(rlReset(NOW_S - 1)).toBeNull();
    expect(rlPct(97, NOW_S)).toBe(0); // the boundary counts as passed
    expect(rlReset(NOW_S)).toBeNull();
  });
  it("passes a live window through untouched", () => {
    expect(rlPct(97, NOW_S + 100)).toBe(97);
    expect(rlReset(NOW_S + 100)).toBe(NOW_S + 100);
  });
  it("leaves a missing percentage missing, and a missing reset unresolved", () => {
    expect(rlPct(null, NOW_S + 100)).toBeNull();
    expect(rlPct(97, null)).toBe(97);
    expect(rlReset(null)).toBeNull();
  });
});

describe("pushRlSample — the burn-rate sample buffer", () => {
  it("records nothing for a missing reading", () => {
    pushRlSample("h5", null);
    expect(rlSamples.h5).toHaveLength(0);
  });
  it("skips an unchanged reading inside 10s, keeps it after", () => {
    pushRlSample("h5", 10);
    vi.setSystemTime(Date.now() + 5_000);
    pushRlSample("h5", 10);            // same value, too soon
    expect(rlSamples.h5).toHaveLength(1);
    vi.setSystemTime(Date.now() + 5_000);
    pushRlSample("h5", 10);            // exactly 10s since the last recorded one
    expect(rlSamples.h5).toHaveLength(2);
  });
  it("always records a changed reading, however soon", () => {
    pushRlSample("h5", 10);
    vi.setSystemTime(Date.now() + 1_000);
    pushRlSample("h5", 11);
    expect(rlSamples.h5).toHaveLength(2);
  });
  it("trims past the look-back window but never below two samples", () => {
    pushRlSample("h5", 0); tick(10);
    pushRlSample("h5", 10); tick(10);
    pushRlSample("h5", 20); tick(20);
    pushRlSample("h5", 40);
    // h5 looks back 30min: the t0 sample is older than that and drops out.
    expect(rlSamples.h5.map((s) => s.pct)).toEqual([10, 20, 40]);
  });
  it("keeps two samples even when the older one has aged out of the look-back", () => {
    // A session that reports rarely would otherwise trim itself down to one
    // sample and never have a slope at all.
    pushRlSample("h5", 10); tick(40);
    pushRlSample("h5", 50);
    expect(rlSamples.h5.map((s) => s.pct)).toEqual([10, 50]);
    expect(burnRate("h5")).toBeCloseTo(60, 6);
  });
  it("keeps the two windows' buffers separate", () => {
    pushRlSample("h5", 10);
    expect(rlSamples.d7).toHaveLength(0);
  });
});

describe("burnRate — %/hour, or an honest null", () => {
  it("is null until two samples exist", () => {
    expect(burnRate("h5")).toBeNull();
    pushRlSample("h5", 10);
    expect(burnRate("h5")).toBeNull();
  });
  it("is null until the samples span enough time to trust a slope", () => {
    // h5 wants 3min; two readings 2min apart could be pure jitter.
    pushRlSample("h5", 10); tick(2);
    pushRlSample("h5", 14);
    expect(burnRate("h5")).toBeNull();
    tick(2);
    pushRlSample("h5", 18);
    expect(burnRate("h5")).toBeCloseTo((18 - 10) / (4 / 60), 6);
  });
  it("applies each window's own minimum span", () => {
    // The same 10min span that satisfies h5 is not enough for d7 (15min).
    pushRlSample("h5", 10); pushRlSample("d7", 10);
    tick(10);
    pushRlSample("h5", 20); pushRlSample("d7", 20);
    expect(burnRate("h5")).toBeCloseTo(60, 6); // 10 points in 1/6 h
    expect(burnRate("d7")).toBeNull();
  });
  it("measures the slope across the whole retained buffer", () => {
    pushRlSample("h5", 0); tick(10);
    pushRlSample("h5", 10); tick(10);
    pushRlSample("h5", 20); tick(20);
    pushRlSample("h5", 40);
    // After trimming: 10 → 40 over 30min.
    expect(burnRate("h5")).toBeCloseTo(60, 6);
  });
  it("clamps a falling percentage to zero rather than a negative burn", () => {
    pushRlSample("h5", 50); tick(10);
    pushRlSample("h5", 30);
    expect(burnRate("h5")).toBe(0);
  });
});

describe("forecastWin — will this window run out before it resets?", () => {
  it("reports nothing to judge when no percentage has arrived", () => {
    const f = forecastWin(null, NOW_S + HOUR, 5);
    expect(f).toMatchObject({ status: "ok", used: null, proj: null, hasRate: false, runsOut: false });
    expect(f.secLeft).toBe(HOUR);
  });

  describe("without a trustworthy slope, it judges by level alone", () => {
    it("is ok below 85%, warns at 85, and is bad at 100", () => {
      expect(forecastWin(50, NOW_S + HOUR, null).status).toBe("ok");
      expect(forecastWin(85, NOW_S + HOUR, null).status).toBe("warn");
      expect(forecastWin(100, NOW_S + HOUR, null)).toMatchObject({ status: "bad", runsOut: true });
    });
    it("projects flat and admits it has no rate", () => {
      const f = forecastWin(60, NOW_S + HOUR, null);
      expect(f).toMatchObject({ used: 60, proj: 60, etaSec: null, hasRate: false });
    });
    it("falls back to the same branch when there is no live window to project into", () => {
      expect(forecastWin(90, null, 10)).toMatchObject({ status: "warn", hasRate: false, secLeft: null });
    });
    it("reads a window that already reset as 0% used", () => {
      // rlPct/rlReset run first, so a stale reset can't leave a hot meter behind.
      expect(forecastWin(97, NOW_S - 10, 10)).toMatchObject({
        status: "ok", used: 0, proj: 0, resetTs: null, secLeft: null, hasRate: false,
      });
    });
  });

  describe("with a slope, it extrapolates to the reset", () => {
    it("stays ok when the burn lands well short of the limit", () => {
      const f = forecastWin(50, NOW_S + HOUR, 10);
      expect(f).toMatchObject({ status: "ok", used: 50, proj: 60, runsOut: false, hasRate: true });
      expect(f.etaSec).toBeCloseTo(5 * HOUR, 6); // 50 points to go at 10/hr
      expect(f.secLeft).toBe(HOUR);
    });
    it("warns when the projection crosses 80 even though it never hits 100", () => {
      const f = forecastWin(50, NOW_S + HOUR, 35);
      expect(f).toMatchObject({ status: "warn", proj: 85, runsOut: false });
    });
    it("calls a lockout when 100% arrives before the reset does", () => {
      // The motivating case: 62% burning fast is trouble…
      const f = forecastWin(62, NOW_S + 4 * HOUR, 12);
      expect(f).toMatchObject({ status: "bad", runsOut: true, proj: 110 });
      expect(f.etaSec).toBeCloseTo((100 - 62) / 12 * HOUR, 6);
    });
    it("…while a higher percentage sitting flat is fine", () => {
      const f = forecastWin(68, NOW_S + 4 * HOUR, 0);
      expect(f).toMatchObject({ status: "ok", used: 68, proj: 68, runsOut: false, hasRate: true });
      expect(f.etaSec).toBeNull(); // a flat burn never reaches 100 — no eta, not "now"
    });
    it("treats an eta landing exactly on the reset as running out", () => {
      expect(forecastWin(50, NOW_S + HOUR, 50)).toMatchObject({ status: "bad", runsOut: true });
    });
    it("is already out at 100%, whatever the burn", () => {
      expect(forecastWin(100, NOW_S + HOUR, 0)).toMatchObject({ status: "bad", runsOut: true });
    });
  });

  // Extrapolating a burst across hours was the model's one systematic failure: over
  // 37 logged windows every large error was an over-projection (-80, -51, -41 points)
  // while under-projection never passed +12. Holding the projected rate down to the
  // pace the window has actually sustained fixes that without touching the steady
  // burner, who is the only reason the red alarm exists.
  describe("the projected rate is capped at the pace the window has sustained", () => {
    // 5h window, 1h left → 4h elapsed.
    const late = NOW_S + HOUR;
    it("ignores a burst the window's own history does not support", () => {
      // 10% in 4h is 2.5 %/hr sustained; the last half-hour ran at 60 %/hr.
      const f = forecastWin(10, late, 60, H5_LEN);
      expect(f.proj).toBeCloseTo(10 + 2.5 * 1, 6); // not 10 + 60
      expect(f.status).toBe("ok");
    });
    it("leaves a steady burner alone, so a real lockout still goes red", () => {
      // 80% in 4h *is* 20 %/hr — recent and sustained agree, nothing is damped.
      const f = forecastWin(80, late, 20, H5_LEN);
      expect(f.proj).toBeCloseTo(100, 6);
      expect(f).toMatchObject({ status: "bad", runsOut: true });
    });
    it("never raises a projection — a slow patch still reads as slow", () => {
      // Sustained 20 %/hr but only 4 %/hr lately: the cap is a ceiling, not a floor.
      expect(forecastWin(80, late, 4, H5_LEN).proj).toBeCloseTo(84, 6);
    });
    it("keeps out of the way early on, when the average means nothing", () => {
      // 6 min into a 5h window there is no sustained pace to speak of, so the
      // recent slope stands unaltered rather than being judged against noise.
      const f = forecastWin(2, NOW_S + H5_LEN - 360, 30, H5_LEN);
      expect(f.proj).toBeCloseTo(2 + 30 * ((H5_LEN - 360) / 3600), 6);
    });
    it("is unchanged when no window length is supplied", () => {
      expect(forecastWin(10, late, 60).proj).toBeCloseTo(70, 6);
    });
    it("moves the eta onto the sustained pace too, not just the projection", () => {
      // Otherwise the red branch would still fire off the uncapped burst rate and
      // the fix would be cosmetic — the status reads `runsOut`, which reads the eta.
      const f = forecastWin(10, late, 60, H5_LEN);
      expect(f.etaSec).toBeCloseTo((100 - 10) / 2.5 * HOUR, 6);
      expect(f.runsOut).toBe(false);
    });
  });
});

describe("maybeMidSnap — the halfway projection the log is later scored against", () => {
  // Give the window a trustworthy slope, then a reset `secLeft` from *now* (after
  // the clock has moved). 20 → 30 over 20 minutes = 30 %/hr, which clears both
  // windows' minimum span.
  const withRate = (win: "h5" | "d7", secLeft: number) => {
    pushRlSample(win, 20); tick(20); pushRlSample(win, 30);
    const reset = Math.floor(Date.now() / 1000) + secLeft;
    if (win === "h5") { rl.h5 = 30; rl.h5Reset = reset; } else { rl.d7 = 30; rl.d7Reset = reset; }
  };

  it("holds off until the window is past its halfway mark", () => {
    // A 5h window with 3h left hasn't reached the middle; projecting there would
    // measure the model against a much longer extrapolation than intended.
    withRate("h5", 3 * HOUR);
    maybeMidSnap("h5", rl.h5Reset);
    expect(midSnap.h5).toBeNull();
  });
  it("takes the projection once past it", () => {
    // 30% used with 2h left of a 5h window: the recent slope is 30 %/hr but the
    // window has only sustained 30/3 = 10 %/hr, and the projection uses the latter.
    withRate("h5", 2 * HOUR);
    maybeMidSnap("h5", rl.h5Reset);
    expect(midSnap.h5!.proj).toBeCloseTo(30 + 10 * 2, 6);
    expect(midSnap.h5!).toMatchObject({ used: 30, at: 0.6 });
    expect(midSnap.h5!.burn).toBeCloseTo(10, 6);
  });
  it("keeps the first snapshot — the midpoint is a moment, not a running value", () => {
    withRate("h5", 2 * HOUR);
    maybeMidSnap("h5", rl.h5Reset);
    const first = midSnap.h5!.proj;
    rl.h5 = 80;
    maybeMidSnap("h5", rl.h5Reset);
    expect(midSnap.h5!.proj).toBe(first);
  });
  it("replaces a flat snapshot until a real slope turns up", () => {
    // Catching the halfway mark during an idle patch locks in "it will end where it
    // is", which is a prediction of nothing. Keep looking while the burn reads zero.
    pushRlSample("h5", 30); tick(20); pushRlSample("h5", 30); // flat, but a real span
    rl.h5 = 30; rl.h5Reset = Math.floor(Date.now() / 1000) + 2 * HOUR;
    maybeMidSnap("h5", rl.h5Reset);
    expect(midSnap.h5).toMatchObject({ burn: 0, proj: 30 });
    tick(20); pushRlSample("h5", 50); // work resumes
    rl.h5 = 50; rl.h5Reset = Math.floor(Date.now() / 1000) + 100 * 60;
    maybeMidSnap("h5", rl.h5Reset);
    expect(midSnap.h5!.burn).toBeGreaterThan(0);
    expect(midSnap.h5!.proj).toBeGreaterThan(50);
  });
  it("records nothing without a trustworthy burn rate", () => {
    // One reading is a level, not a slope; a projection from it would be invented.
    rl.h5 = 30; rl.h5Reset = Math.floor(Date.now() / 1000) + 2 * HOUR;
    pushRlSample("h5", 30);
    maybeMidSnap("h5", rl.h5Reset);
    expect(midSnap.h5).toBeNull();
  });
  it("does nothing when there is no active window", () => {
    withRate("h5", 2 * HOUR);
    maybeMidSnap("h5", null);
    expect(midSnap.h5).toBeNull();
  });
  it("measures each window's halfway mark against its own length", () => {
    // 3 days out is well past the middle of a 7-day window, and nowhere near the
    // middle of a 5-hour one — the two must not share a threshold.
    withRate("d7", 3 * 86400);
    maybeMidSnap("d7", rl.d7Reset);
    expect(midSnap.d7).not.toBeNull();
    expect(midSnap.h5).toBeNull();
  });
});

describe("onRlUpdate — spotting a window rotation", () => {
  // Called after every merge with the reset time before and after. A genuinely later
  // reset (>2min, the same skew tolerance mergeRl uses) means the old window closed.
  it("samples the new reading without rotating when the window is unchanged", () => {
    rl.h5 = 40;
    onRlUpdate("h5", 30, NOW_S + HOUR, NOW_S + HOUR);
    expect(rlSamples.h5.map((s) => s.pct)).toEqual([40]);
    expect(fcLog).toHaveLength(0);
  });
  it("treats a reset that moved less than 2min as the same window", () => {
    rl.h5 = 40;
    onRlUpdate("h5", 30, NOW_S + HOUR, NOW_S + HOUR + 60);
    expect(fcLog).toHaveLength(0);
    expect(rlSamples.h5).toHaveLength(1);
  });
  it("clears the burn samples on rotation, so the new window's slope starts clean", () => {
    pushRlSample("h5", 10); tick(10);
    pushRlSample("h5", 90);
    expect(burnRate("h5")).not.toBeNull();
    rl.h5 = 3;
    onRlUpdate("h5", 90, NOW_S + 600, NOW_S + 600 + 5 * HOUR);
    // The old samples are gone; only the post-rotation reading remains, which alone
    // isn't a slope — carrying the old window's burn across would be nonsense.
    expect(rlSamples.h5.map((s) => s.pct)).toEqual([3]);
    expect(burnRate("h5")).toBeNull();
  });
  it("records what the closing window actually reached", () => {
    onRlUpdate("h5", 93, NOW_S + 600, NOW_S + 600 + 5 * HOUR);
    expect(fcLog).toHaveLength(1);
    expect(fcLog[0]).toMatchObject({ w: "h5", final: 93, midProj: null, err: null });
    expect(fcLog[0].closed).toBe(Math.floor(NOW_MS / 1000));
    expect(JSON.parse(store.get("cc-forecast-log")!)).toHaveLength(1);
  });
  it("scores the halfway projection against the outcome when it took one", () => {
    // Past the halfway mark of a 5h window with a real slope → midSnap is taken…
    pushRlSample("h5", 20); tick(10);
    pushRlSample("h5", 30);
    const reset = Math.floor(Date.now() / 1000) + HOUR;   // 1h left of a 5h window
    rl.h5 = 30; rl.h5Reset = reset;
    onRlUpdate("h5", 30, reset, reset);
    expect(midSnap.h5).not.toBeNull();
    const proj = midSnap.h5!.proj;
    // …and the rotation compares it to what really happened.
    onRlUpdate("h5", 88, reset, reset + 5 * HOUR);
    expect(fcLog[0].midProj).toBeCloseTo(proj, 6);
    expect(fcLog[0].err).toBeCloseTo(88 - proj, 6);
    expect(midSnap.h5).toBeNull(); // the new window starts without a snapshot
  });
  it("logs nothing for a window that never reported a percentage", () => {
    onRlUpdate("h5", null, NOW_S + 600, NOW_S + 600 + 5 * HOUR);
    expect(fcLog).toHaveLength(0);
  });
  it("caps the log at 200 entries, dropping the oldest", () => {
    for (let i = 0; i < 205; i++) {
      onRlUpdate("h5", i, NOW_S + i * 1000, NOW_S + (i + 1) * 1000 + 200);
      midSnap.h5 = null;
    }
    expect(fcLog).toHaveLength(200);
    expect(fcLog[0].final).toBe(5); // 0–4 rolled off
  });
  it("keeps the two windows' rotations independent", () => {
    onRlUpdate("h5", 50, NOW_S + 600, NOW_S + 600 + 5 * HOUR);
    expect(fcLog.map((e) => e.w)).toEqual(["h5"]);
    expect(rlSamples.d7).toHaveLength(0);
  });
  it("logs one rotation once, however many sessions report it", () => {
    // Every session's statusLine carries the same account-wide numbers, so a lagging
    // session announces a rotation the freshest session already announced. The real
    // log has a pair of h5 closes six minutes apart from exactly this.
    const closing = NOW_S + 600;
    onRlUpdate("h5", 50, closing, closing + 5 * HOUR);
    tick(6);
    onRlUpdate("h5", 50, closing, closing + 5 * HOUR);
    expect(fcLog).toHaveLength(1);
  });
  it("records the inputs, not just the outcome, so an error can be decomposed", () => {
    // {final, midProj} alone cannot tell a bad slope from a stale level, which is
    // why the first 38 entries could not be calibrated against without going back
    // to the transcripts.
    // A reset ten minutes gone: `late` is how long the window had really been over
    // by the time a statusLine told us, which is what separates a mid-window
    // forecast from one scored against a window that closed while the app was shut.
    const reset = NOW_S - 600;
    midSnap.h5 = { proj: 70, used: 55, burn: 6, at: 0.5 };
    onRlUpdate("h5", 62, reset, reset + 5 * HOUR);
    expect(fcLog[0]).toMatchObject({ used: 55, burn: 6, at: 0.5, flat: false, late: 600 });
  });
  it("marks a flat snapshot, which is right for no reason", () => {
    // An idle moment projects `used` unchanged; if the window stays idle that scores
    // a perfect zero. Nine of the first 38 entries were this, and averaging them in
    // flattered the model — so they are labelled rather than silently counted.
    const reset = NOW_S + 600;
    midSnap.h5 = { proj: 40, used: 40, burn: 0, at: 0.5 };
    onRlUpdate("h5", 40, reset, reset + 5 * HOUR);
    expect(fcLog[0]).toMatchObject({ err: 0, flat: true });
  });
});

describe("setRlLogger — narrating a window close without reaching into main.ts", () => {
  it("is silent by default, so importing the module logs nothing", () => {
    onRlUpdate("h5", 93, NOW_S + 600, NOW_S + 600 + 5 * HOUR);
    expect(fcLog).toHaveLength(1); // the close still happened…
  });
  it("hands the close to whatever main.ts wired up", () => {
    const lines: [string, string][] = [];
    setRlLogger((lvl, msg) => lines.push([lvl, msg]));
    onRlUpdate("h5", 93, NOW_S + 600, NOW_S + 600 + 5 * HOUR);
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toBe("info");
    expect(lines[0][1]).toContain("h5 window closed at 93%");
    expect(lines[0][1]).not.toContain("predicted"); // no midpoint snapshot was taken
  });
  it("includes the prediction and its error when there was one", () => {
    const lines: string[] = [];
    setRlLogger((_l, msg) => lines.push(msg));
    midSnap.h5 = { proj: 80, used: 60, burn: 8, at: 0.5 };
    onRlUpdate("h5", 93, NOW_S + 600, NOW_S + 600 + 5 * HOUR);
    expect(lines[0]).toContain("predicted ~80%, err +13");
  });
});

describe("forecast5h / forecast7d — each reads its own window", () => {
  it("pairs the right percentage, reset and burn buffer", () => {
    pushRlSample("h5", 20); pushRlSample("d7", 80);
    tick(30);
    pushRlSample("h5", 40); pushRlSample("d7", 90);
    // Reset times are set after the clock has moved, so they read as "from now".
    rl.h5 = 40; rl.h5Reset = NOW_S + 1800 + HOUR;
    rl.d7 = 90; rl.d7Reset = NOW_S + 1800 + 3 * 86400;

    const f5 = forecast5h(), f7 = forecast7d();
    expect(f5).toMatchObject({ used: 40, secLeft: HOUR, hasRate: true });
    // 20 points in 30min is a 40 %/hr burst, but 4h of the window has produced only
    // 40 points — 10 %/hr — so the projection runs on the pace actually sustained.
    expect(f5.proj).toBeCloseTo(40 + 10 * 1, 6);
    expect(f7).toMatchObject({ used: 90, secLeft: 3 * 86400, hasRate: true });
    expect(f7.status).toBe("bad"); // 90% with days to go and a real slope
  });
});
