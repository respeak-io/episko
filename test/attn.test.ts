import { describe, expect, it } from "vitest";
import type { Sess } from "../src/types";
import {
  ATTN_DEFAULTS, ATTN_HIGHLIGHT_RANGE, ATTN_ORDERS, attnCleared, attnFlash,
  attnFlashDeadline, attnOrder, attnSeen, clampAttnPrefs, isDefaultAttnPrefs,
  type AttnPrefs,
} from "../src/attn";

const NOW = 1800000000000; // 2027-01-15T08:00:00Z

/// Only the five fields any of this reads. Everything here is pure over a Sess, so a
/// cast beats hauling in the xterm/DOM handles a real pane carries.
function sess(o: Partial<Sess> = {}): Sess {
  return { id: "s1", attnAt: 0, seenAt: 0, attention: null, phase: "idle", ...o } as Sess;
}
const prefs = (o: Partial<AttnPrefs> = {}): AttnPrefs => ({ ...ATTN_DEFAULTS, ...o });

describe("clampAttnPrefs — whatever localStorage held, made safe", () => {
  it("gives an absent blob the shipped defaults", () => {
    expect(clampAttnPrefs(null)).toEqual(ATTN_DEFAULTS);
    expect(clampAttnPrefs(undefined)).toEqual(ATTN_DEFAULTS);
    expect(clampAttnPrefs({})).toEqual(ATTN_DEFAULTS);
  });
  it("keeps a switch that was deliberately turned off", () => {
    // `!== false`, so a key that isn't there yet lands on the shipped default while an
    // explicit false survives — the same rule cc-peek's `enabled` follows.
    expect(clampAttnPrefs({ highlight: false }).highlight).toBe(false);
    expect(clampAttnPrefs({ clearOnOpen: false }).clearOnOpen).toBe(false);
    expect(clampAttnPrefs({ highlight: undefined }).highlight).toBe(true);
  });
  it("clamps the duration into the range either side of which it stops working", () => {
    expect(clampAttnPrefs({ highlightMs: 1 }).highlightMs).toBe(ATTN_HIGHLIGHT_RANGE.min);
    expect(clampAttnPrefs({ highlightMs: 1e9 }).highlightMs).toBe(ATTN_HIGHLIGHT_RANGE.max);
    expect(clampAttnPrefs({ highlightMs: 2500 }).highlightMs).toBe(2500);
  });
  it("decays a hand-edited duration rather than taking the app down", () => {
    expect(clampAttnPrefs({ highlightMs: NaN }).highlightMs).toBe(ATTN_DEFAULTS.highlightMs);
    expect(clampAttnPrefs({ highlightMs: "soon" as unknown as number }).highlightMs).toBe(ATTN_DEFAULTS.highlightMs);
  });
  it("only knows the two orders it ships", () => {
    expect(clampAttnPrefs({ order: "waiting" }).order).toBe("waiting");
    expect(clampAttnPrefs({ order: "sideways" as never }).order).toBe("recent");
    expect(ATTN_ORDERS.map((o) => o.id)).toEqual(["recent", "waiting"]);
  });
  it("says when nothing has been changed, which is what disables Reset", () => {
    expect(isDefaultAttnPrefs(ATTN_DEFAULTS)).toBe(true);
    expect(isDefaultAttnPrefs(prefs({ order: "waiting" }))).toBe(false);
    expect(isDefaultAttnPrefs(prefs({ highlightMs: ATTN_DEFAULTS.highlightMs + 400 }))).toBe(false);
    expect(isDefaultAttnPrefs(prefs({ clearOnOpen: false }))).toBe(false);
  });
});

describe("attnSeen — have you looked at this since it started wanting you", () => {
  it("is no while the stamp is newer than your last visit", () => {
    expect(attnSeen(sess({ attnAt: 500, seenAt: 100 }), false)).toBe(false);
  });
  it("is yes once you have been back", () => {
    expect(attnSeen(sess({ attnAt: 500, seenAt: 900 }), false)).toBe(true);
    expect(attnSeen(sess({ attnAt: 500, seenAt: 500 }), false)).toBe(true); // opened in the same beat
  });
  it("counts the pane on the stage without waiting for a click it will never get", () => {
    // It finished while you were looking straight at it. Nothing will stamp seenAt
    // again, and a badge pointing at the thing filling your screen is noise.
    expect(attnSeen(sess({ attnAt: 500, seenAt: 100 }), true)).toBe(true);
  });
  it("is no for a session that isn't in the set at all", () => {
    // attnAt 0 means "not wanting you", so an old seenAt must not read as an
    // acknowledgement of something that hasn't happened yet.
    expect(attnSeen(sess({ attnAt: 0, seenAt: 900 }), false)).toBe(false);
  });
});

describe("attnCleared — what drops out of the badge", () => {
  it("drops one you have been back to", () => {
    expect(attnCleared(sess({ attnAt: 500, seenAt: 900 }), prefs(), false)).toBe(true);
  });
  it("keeps one you have not", () => {
    expect(attnCleared(sess({ attnAt: 500, seenAt: 100 }), prefs(), false)).toBe(false);
  });
  it("never clears a blocking permission, however often you look at it", () => {
    // Looking at a permission is not answering one: Claude is stopped until the
    // decision is made, so this is the one thing the badge must not forget.
    const blocked = sess({ attnAt: 500, seenAt: 900, attention: "permission: Bash" });
    expect(attnCleared(blocked, prefs(), false)).toBe(false);
    expect(attnCleared(blocked, prefs(), true)).toBe(false);
  });
  it("clears nothing at all with the switch off", () => {
    expect(attnCleared(sess({ attnAt: 500, seenAt: 900 }), prefs({ clearOnOpen: false }), false)).toBe(false);
    expect(attnCleared(sess({ attnAt: 500, seenAt: 100 }), prefs({ clearOnOpen: false }), true)).toBe(false);
  });
});

describe("attnFlash — how far into its highlight a row is", () => {
  it("reports the age while the light lasts", () => {
    expect(attnFlash(sess({ attnAt: NOW - 1200 }), prefs({ highlightMs: 4000 }), false, NOW)).toBe(1200);
  });
  it("goes out at the end of the window", () => {
    expect(attnFlash(sess({ attnAt: NOW - 4000 }), prefs({ highlightMs: 4000 }), false, NOW)).toBeNull();
    expect(attnFlash(sess({ attnAt: NOW - 3999 }), prefs({ highlightMs: 4000 }), false, NOW)).toBe(3999);
  });
  it("never lights a session that isn't wanting you", () => {
    expect(attnFlash(sess({ attnAt: 0 }), prefs(), false, NOW)).toBeNull();
  });
  it("stops the moment you open the pane", () => {
    expect(attnFlash(sess({ attnAt: NOW - 100, seenAt: NOW - 50 }), prefs(), false, NOW)).toBeNull();
    expect(attnFlash(sess({ attnAt: NOW - 100, seenAt: 0 }), prefs(), true, NOW)).toBeNull();
  });
  it("stops when you open it even with the badge's clearing rule switched off", () => {
    // That switch is about the *badge*. A row still flashing at you while its pane is
    // on screen would be arguing with what you are already doing.
    const s = sess({ attnAt: NOW - 100, seenAt: NOW - 50 });
    expect(attnFlash(s, prefs({ clearOnOpen: false }), false, NOW)).toBeNull();
  });
  it("stops for a permission you have looked at, even though the badge keeps it", () => {
    // The mirror image of attnCleared: the BADGE keeps a blocking permission, the light
    // does not. You are looking at the card; being pointed at it is over.
    const s = sess({ attnAt: NOW - 100, seenAt: NOW - 50, attention: "permission: Bash" });
    expect(attnFlash(s, prefs(), false, NOW)).toBeNull();
  });
  it("is off entirely with the highlight switched off", () => {
    expect(attnFlash(sess({ attnAt: NOW - 100 }), prefs({ highlight: false }), false, NOW)).toBeNull();
  });
  it("ignores a stamp from the future rather than lighting up forever", () => {
    expect(attnFlash(sess({ attnAt: NOW + 5000 }), prefs(), false, NOW)).toBeNull();
  });
});

describe("attnFlashDeadline — the one timeout the driver schedules", () => {
  it("is the earliest light to go out", () => {
    const list = [
      sess({ id: "a", attnAt: NOW - 3000 }),
      sess({ id: "b", attnAt: NOW - 500 }),
    ];
    expect(attnFlashDeadline(list, prefs({ highlightMs: 4000 }), null, NOW)).toBe(NOW - 3000 + 4000);
  });
  it("is null when nothing is lit, so an idle rail keeps no timer", () => {
    expect(attnFlashDeadline([sess({ attnAt: 0 })], prefs(), null, NOW)).toBeNull();
    expect(attnFlashDeadline([sess({ attnAt: NOW - 9000 })], prefs({ highlightMs: 4000 }), null, NOW)).toBeNull();
    expect(attnFlashDeadline([], prefs(), null, NOW)).toBeNull();
  });
  it("skips the pane on the stage, which is not lit", () => {
    const list = [sess({ id: "on", attnAt: NOW - 100 }), sess({ id: "off", attnAt: NOW - 3000 })];
    expect(attnFlashDeadline(list, prefs({ highlightMs: 4000 }), "on", NOW)).toBe(NOW - 3000 + 4000);
  });
});

describe("attnOrder — which end of the queue the badge starts from", () => {
  const a = sess({ id: "old", attnAt: 100 });
  const b = sess({ id: "new", attnAt: 900 });
  it("puts the one that just landed first by default", () => {
    expect([a, b].sort(attnOrder(prefs())).map((s) => s.id)).toEqual(["new", "old"]);
  });
  it("puts the longest wait first when asked", () => {
    expect([b, a].sort(attnOrder(prefs({ order: "waiting" }))).map((s) => s.id)).toEqual(["old", "new"]);
  });
  it("leaves an exact tie to the caller's own order", () => {
    const x = sess({ id: "x", attnAt: 400 }), y = sess({ id: "y", attnAt: 400 });
    expect([x, y].sort(attnOrder(prefs())).map((s) => s.id)).toEqual(["x", "y"]);
    expect([y, x].sort(attnOrder(prefs({ order: "waiting" }))).map((s) => s.id)).toEqual(["y", "x"]);
  });
});
