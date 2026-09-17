import { describe, expect, it } from "vitest";
import {
  applyPick, emptyPick, pickAll, pickNone, pickState, rangeBetween, rangeOutcome, togglePickAll,
  type Pick, type PickCtx,
} from "../src/pick";

// One selection rule for the four tick-box tables (Branches, Checkouts, Advisories, Out of
// date). They had three answers to "select everything" and shift-click in exactly one of them.

const ctx = (order: string[], off: string[] = []): PickCtx =>
  ({ order, pickable: new Set(order.filter((k) => !off.includes(k))) });

const of = (keys: string[], anchor = ""): Pick => ({ picked: new Set(keys), anchor });
const list = (p: Pick) => [...p.picked].sort();

describe("the range a shift-click takes", () => {
  it("is inclusive of both ends, whichever way it was dragged", () => {
    const order = ["a", "b", "busy", "c", "d"];
    expect(rangeBetween(order, "b", "c")).toEqual(["b", "busy", "c"]);
    expect(rangeBetween(order, "c", "b")).toEqual(["b", "busy", "c"]);
    expect(rangeBetween(order, "b", "b")).toEqual(["b"]);
  });

  it("falls back to the row clicked when the anchor has scrolled out of the filter", () => {
    expect(rangeBetween(["a", "b"], "gone-from-view", "b")).toEqual(["b"]);
    expect(rangeBetween(["a", "b"], "a", "not-here")).toEqual([]);
  });
});

describe("one click on one row", () => {
  const c = ctx(["a", "b", "c", "d"], ["c"]);

  it("toggles, and moves the anchor to where you clicked", () => {
    const one = applyPick(emptyPick(), "b", c);
    expect(list(one)).toEqual(["b"]);
    expect(one.anchor).toBe("b");
    expect(list(applyPick(one, "b", c))).toEqual([]);
  });

  it("refuses a row that is shown for its reason, anchor and all", () => {
    // A blocked branch is listed so you can read why; ticking it would arm a delete git refuses.
    const p = applyPick(of(["a"], "a"), "c", c);
    expect(list(p)).toEqual(["a"]);
    expect(p.anchor).toBe("a");
  });

  it("ADDS a shift range rather than toggling it — a flip would undo half of itself", () => {
    const start = applyPick(emptyPick(), "a", c);       // anchor at a
    const ranged = applyPick(start, "d", { ...c, range: true });
    // `c` is inside the range and refused, so it is skipped rather than silently armed.
    expect(list(ranged)).toEqual(["a", "b", "d"]);
    // Shift again over the same span leaves it ticked instead of clearing it.
    expect(list(applyPick(ranged, "a", { ...c, range: true, order: c.order }))).toEqual(["a", "b", "d"]);
  });

  it("treats shift with no anchor, or on the anchor itself, as a plain click", () => {
    expect(list(applyPick(emptyPick(), "b", { ...c, range: true }))).toEqual(["b"]);
    const on = of(["b"], "b");
    expect(list(applyPick(on, "b", { ...c, range: true }))).toEqual([]);
  });

  it("measures the next range from the row just clicked", () => {
    const first = applyPick(emptyPick(), "a", c);
    const second = applyPick(first, "b", c);
    expect(second.anchor).toBe("b");
    expect(list(applyPick(second, "d", { ...c, range: true }))).toEqual(["a", "b", "d"]);
  });
});

describe("how a range landed", () => {
  // Most branches are not deletable, so a range over ten rows routinely ticks two. Silence
  // there is indistinguishable from the range not having worked, which is what it looked like.
  const c = ctx(["a", "b", "c", "d"], ["b", "c"]);

  it("counts what it took and what it refused", () => {
    expect(rangeOutcome(c, "a", "d")).toEqual({ took: 2, refused: 2 });
    expect(rangeOutcome(ctx(["a", "b"]), "a", "b")).toEqual({ took: 2, refused: 0 });
  });

  it("reports nothing for a range that no longer resolves", () => {
    expect(rangeOutcome(c, "a", "not-here")).toEqual({ took: 0, refused: 0 });
  });

  it("agrees with what applyPick actually ticked", () => {
    const took = applyPick(of(["a"], "a"), "d", { ...c, range: true });
    expect(took.picked.size).toBe(rangeOutcome(c, "a", "d").took);
  });
});

describe("the header tick", () => {
  const c = ctx(["a", "b", "c"], ["c"]);

  it("reads none, some and all over the PICKABLE rows on screen", () => {
    expect(pickState(c, new Set())).toBe("none");
    expect(pickState(c, new Set(["a"]))).toBe("some");
    // `c` is refused, so ticking every row that can be ticked is "all" — a box that could
    // never fill would be a control that never finishes.
    expect(pickState(c, new Set(["a", "b"]))).toBe("all");
  });

  it("is none when the filter shows nothing pickable, never all of an empty set", () => {
    expect(pickState(ctx([]), new Set())).toBe("none");
    expect(pickState(ctx(["a"], ["a"]), new Set())).toBe("none");
  });

  it("takes everything shown, then clears everything shown", () => {
    const full = togglePickAll(emptyPick(), c);
    expect(list(full)).toEqual(["a", "b"]);
    expect(list(togglePickAll(full, c))).toEqual([]);
  });

  it("clears only what is SHOWN, so a filtered-out tick survives", () => {
    // The bar still counts it, and silently dropping a row you cannot see would be a lie.
    const wide = of(["a", "b", "hidden"], "b");
    expect(list(togglePickAll(wide, c))).toEqual(["hidden"]);
  });

  it("adds to a selection made under another filter rather than replacing it", () => {
    expect(list(pickAll(of(["hidden"]), c))).toEqual(["a", "b", "hidden"]);
  });
});

describe("None", () => {
  it("drops the anchor too, so the next shift-click starts fresh", () => {
    const p = pickNone();
    expect(list(p)).toEqual([]);
    expect(p.anchor).toBe("");
  });
});
