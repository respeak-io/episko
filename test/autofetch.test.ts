import { describe, expect, it } from "vitest";
import {
  AUTOFETCH_DEFAULTS, AUTOFETCH_EVERY, clampAutoFetchPrefs, FETCH_BACKOFF_MAX,
  fetchDue, fetchGapMs, noteFetch, type AutoFetchPrefs, type FetchState,
} from "../src/autofetch";

const P: AutoFetchPrefs = { enabled: true, everyMs: 300_000 };
const st = (at: number, ok = true, fails = 0): FetchState => ({ at, ok, fails });

describe("what a stored blob is allowed to say", () => {
  it("ships on, since the counts being stale is the bug it exists for", () => {
    expect(clampAutoFetchPrefs(null)).toEqual(AUTOFETCH_DEFAULTS);
    expect(AUTOFETCH_DEFAULTS.enabled).toBe(true);
  });
  it("keeps an explicit off, and takes only a cadence the picker offers", () => {
    expect(clampAutoFetchPrefs({ enabled: false }).enabled).toBe(false);
    for (const ms of AUTOFETCH_EVERY) expect(clampAutoFetchPrefs({ everyMs: ms }).everyMs).toBe(ms);
    // A hand-edited value falls back to the default rather than the nearest option: honouring
    // `1` would hammer a remote, and 24h would look like the switch had stopped working.
    for (const bad of [1, 30_000, 86_400_000, NaN, "5m", null, undefined]) {
      expect(clampAutoFetchPrefs({ everyMs: bad as number }).everyMs).toBe(AUTOFETCH_DEFAULTS.everyMs);
    }
  });
  it("survives a value of the wrong shape entirely", () => {
    expect(clampAutoFetchPrefs([] as unknown as AutoFetchPrefs)).toEqual(AUTOFETCH_DEFAULTS);
    expect(clampAutoFetchPrefs("nope" as unknown as AutoFetchPrefs)).toEqual(AUTOFETCH_DEFAULTS);
  });
});

describe("when a repo is due", () => {
  it("is due the first time it is ever asked about", () => {
    expect(fetchDue(undefined, P, 1_000_000)).toBe(true);
  });
  it("holds off until the gap has passed", () => {
    expect(fetchDue(st(1_000_000), P, 1_000_000 + 299_999)).toBe(false);
    expect(fetchDue(st(1_000_000), P, 1_000_000 + 300_000)).toBe(true);
  });
  it("says no to everything while the switch is off", () => {
    const off = { ...P, enabled: false };
    expect(fetchDue(undefined, off, 1_000_000)).toBe(false);
    expect(fetchDue(st(0), off, 1_000_000_000)).toBe(false);
  });
  // A laptop waking with a corrected clock left `at` in the future; without this the repo
  // would wait out the difference, which can be hours.
  it("treats a clock that jumped backwards as due", () => {
    expect(fetchDue(st(9_000_000), P, 1_000_000)).toBe(true);
  });
});

describe("a remote that cannot be reached", () => {
  it("doubles the gap per failure and then stops doubling", () => {
    expect(fetchGapMs(P, 0)).toBe(300_000);
    expect(fetchGapMs(P, 1)).toBe(600_000);
    expect(fetchGapMs(P, 3)).toBe(2_400_000);
    expect(fetchGapMs(P, FETCH_BACKOFF_MAX)).toBe(300_000 * 2 ** FETCH_BACKOFF_MAX);
    expect(fetchGapMs(P, 99)).toBe(fetchGapMs(P, FETCH_BACKOFF_MAX));
    expect(fetchGapMs(P, -3)).toBe(300_000);
  });
  it("counts failures up to the cap and clears them on one success", () => {
    let s = noteFetch(undefined, false, 10);
    expect(s).toEqual({ at: 10, ok: false, fails: 1 });
    s = noteFetch(s, false, 20);
    expect(s.fails).toBe(2);
    expect(noteFetch({ at: 0, ok: false, fails: FETCH_BACKOFF_MAX }, false, 30).fails).toBe(FETCH_BACKOFF_MAX);
    expect(noteFetch(s, true, 40)).toEqual({ at: 40, ok: true, fails: 0 });
  });
  it("waits out the backed-off gap, not the plain one", () => {
    const failed = st(1_000_000, false, 2);
    expect(fetchDue(failed, P, 1_000_000 + 600_000)).toBe(false);
    expect(fetchDue(failed, P, 1_000_000 + 1_200_000)).toBe(true);
  });
});
