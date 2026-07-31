import { describe, expect, it } from "vitest";
import {
  clampPeekPrefs, PEEK_CLOSE_RANGE, PEEK_DEFAULTS, PEEK_IDLE, PEEK_OPEN_RANGE,
  peekEnter, peekLeave, peekLeaveAll, peekNextDeadline, peekTick, type PeekPrefs,
} from "../src/peek";

const P: PeekPrefs = { enabled: true, openMs: 1000, closeMs: 3000 };
const T = 1_000_000;

/** Drive the machine the way ./sidebar does: apply every deadline up to `now`. */
function run(s: Parameters<typeof peekTick>[0], now: number) {
  let next = peekTick(s, now);
  // One tick can arm→open; a second can then close. Loop until it settles.
  while (next !== s) { s = next; next = peekTick(s, now); }
  return s;
}

describe("clampPeekPrefs", () => {
  it("defaults a missing or corrupt value rather than throwing", () => {
    expect(clampPeekPrefs(null)).toEqual(PEEK_DEFAULTS);
    expect(clampPeekPrefs({})).toEqual(PEEK_DEFAULTS);
    expect(clampPeekPrefs({ openMs: NaN, closeMs: undefined })).toEqual(PEEK_DEFAULTS);
    // A hand-edited string is the realistic corruption, not a random object.
    expect(clampPeekPrefs({ openMs: "abc" } as never).openMs).toBe(PEEK_DEFAULTS.openMs);
  });

  it("holds both timings inside the range where the feature actually works", () => {
    expect(clampPeekPrefs({ openMs: 0 }).openMs).toBe(PEEK_OPEN_RANGE.min);
    expect(clampPeekPrefs({ openMs: 99_999 }).openMs).toBe(PEEK_OPEN_RANGE.max);
    expect(clampPeekPrefs({ closeMs: 1 }).closeMs).toBe(PEEK_CLOSE_RANGE.min);
    expect(clampPeekPrefs({ closeMs: 99_999 }).closeMs).toBe(PEEK_CLOSE_RANGE.max);
  });

  it("only treats an explicit false as off, so a missing key stays enabled", () => {
    expect(clampPeekPrefs({}).enabled).toBe(true);
    expect(clampPeekPrefs({ enabled: false }).enabled).toBe(false);
  });

  it("rounds, because a fractional millisecond in a stepper reads as a bug", () => {
    expect(clampPeekPrefs({ openMs: 1000.6 }).openMs).toBe(1001);
  });
});

describe("peek: opening", () => {
  it("arms on enter and opens only once the delay has passed", () => {
    const armed = peekEnter(PEEK_IDLE, "/a", T, P);
    expect(armed.arming).toEqual({ path: "/a", at: T + 1000 });
    expect(armed.open).toBeNull();

    expect(run(armed, T + 999).open).toBeNull();
    const open = run(armed, T + 1000);
    expect(open.open).toBe("/a");
    expect(open.arming).toBeNull();
  });

  it("leaving before the delay cancels it — a pointer passing over opens nothing", () => {
    const armed = peekEnter(PEEK_IDLE, "/a", T, P);
    const gone = peekLeave(armed, "/a", T + 300, P);
    expect(gone.arming).toBeNull();
    expect(run(gone, T + 5000)).toEqual(PEEK_IDLE);
  });

  it("re-entering the same group does not restart its timer", () => {
    const armed = peekEnter(PEEK_IDLE, "/a", T, P);
    expect(peekEnter(armed, "/a", T + 500, P).arming).toEqual({ path: "/a", at: T + 1000 });
  });

  it("does nothing at all when peek is switched off", () => {
    const off = { ...P, enabled: false };
    expect(peekEnter(PEEK_IDLE, "/a", T, off)).toEqual(PEEK_IDLE);
    expect(peekNextDeadline(peekEnter(PEEK_IDLE, "/a", T, off))).toBeNull();
  });

  it("collapses an already-open group when peek is switched off mid-hover", () => {
    const open = run(peekEnter(PEEK_IDLE, "/a", T, P), T + 1000);
    expect(peekEnter(open, "/a", T + 1200, { ...P, enabled: false })).toEqual(PEEK_IDLE);
  });
});

describe("peek: moving between groups", () => {
  it("opens the next group with NO delay once one is already expanded", () => {
    const a = run(peekEnter(PEEK_IDLE, "/a", T, P), T + 1000);
    expect(a.open).toBe("/a");
    // Real sequence: mouseout of /a, then mouseover of /b.
    const leaving = peekLeave(a, "/a", T + 2000, P);
    const b = peekEnter(leaving, "/b", T + 2001, P);
    expect(b.open).toBe("/b");
    expect(b.arming).toBeNull();
    // …and /a's pending collapse is dropped rather than firing later onto /b.
    expect(b.closingAt).toBeNull();
    expect(run(b, T + 99_999).open).toBe("/b");
  });

  it("never shows two groups at once", () => {
    const a = run(peekEnter(PEEK_IDLE, "/a", T, P), T + 1000);
    const b = peekEnter(a, "/b", T + 1500, P);
    expect(b.open).toBe("/b");   // a single field — /a cannot still be open
  });
});

describe("peek: closing", () => {
  it("holds the group for the grace period after the pointer leaves", () => {
    const a = run(peekEnter(PEEK_IDLE, "/a", T, P), T + 1000);
    const leaving = peekLeave(a, "/a", T + 2000, P);
    expect(leaving.closingAt).toBe(T + 5000);
    expect(run(leaving, T + 4999).open).toBe("/a");
    expect(run(leaving, T + 5000)).toEqual(PEEK_IDLE);
  });

  it("coming back cancels the collapse", () => {
    const a = run(peekEnter(PEEK_IDLE, "/a", T, P), T + 1000);
    const leaving = peekLeave(a, "/a", T + 2000, P);
    const back = peekEnter(leaving, "/a", T + 3000, P);
    expect(back.closingAt).toBeNull();
    expect(run(back, T + 99_999).open).toBe("/a");
  });

  it("does not extend an already-running grace period on a second leave", () => {
    // mouseout can fire more than once on the way out (a child, then the group).
    const a = run(peekEnter(PEEK_IDLE, "/a", T, P), T + 1000);
    const once = peekLeave(a, "/a", T + 2000, P);
    const twice = peekLeave(once, "/a", T + 2500, P);
    expect(twice.closingAt).toBe(T + 5000);
  });

  it("leaving the sidebar closes whatever is open and cancels whatever is arming", () => {
    const armed = peekEnter(PEEK_IDLE, "/a", T, P);
    expect(peekLeaveAll(armed, T + 100, P)).toEqual(PEEK_IDLE);

    const a = run(peekEnter(PEEK_IDLE, "/a", T, P), T + 1000);
    const out = peekLeaveAll(a, T + 2000, P);
    expect(out.closingAt).toBe(T + 5000);
    expect(run(out, T + 5000)).toEqual(PEEK_IDLE);
  });

  it("leaving a group that was only arming closes nothing", () => {
    const armed = peekEnter(PEEK_IDLE, "/a", T, P);
    expect(peekLeave(armed, "/a", T + 100, P).closingAt).toBeNull();
  });
});

describe("peekNextDeadline", () => {
  it("is null when idle, so an untouched sidebar schedules no timer at all", () => {
    expect(peekNextDeadline(PEEK_IDLE)).toBeNull();
    const open = run(peekEnter(PEEK_IDLE, "/a", T, P), T + 1000);
    expect(peekNextDeadline(open)).toBeNull();   // open and hovered — nothing pending
  });

  it("reports the arm deadline, then the close deadline", () => {
    const armed = peekEnter(PEEK_IDLE, "/a", T, P);
    expect(peekNextDeadline(armed)).toBe(T + 1000);
    const open = run(armed, T + 1000);
    expect(peekNextDeadline(peekLeave(open, "/a", T + 2000, P))).toBe(T + 5000);
  });
});

describe("peek: identity survives a re-render", () => {
  it("tracks a project path, not an element — the sidebar rebuilds its DOM constantly", () => {
    const open = run(peekEnter(PEEK_IDLE, "/Users/t/repo", T, P), T + 1000);
    // Whatever the driver does to the DOM, this is all it needs to re-apply.
    expect(open.open).toBe("/Users/t/repo");
    expect(typeof open.open).toBe("string");
  });
});
