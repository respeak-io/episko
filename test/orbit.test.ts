import { describe, it, expect } from "vitest";
import "./localstorage"; // ./grouping reads cc-* at import time
import type { Phase, Sess } from "../src/types";
import { fromSession, type Thread } from "../src/thread";
import { collapseUnclaimed, layout, pressure, radiusFraction, sectors } from "../src/orbit";

const NOW = 1_700_000_000_000;
const minsAgo = (m: number) => NOW - m * 60_000;

const sess = (over: Partial<Sess> & { id: string }): Sess => ({
  project: "episko", accent: "#a78bfa", workdir: "/w/episko", colorKey: "/w/episko",
  resumeId: over.id, branch: "dev", worktree: null, title: "a session",
  phase: "idle" as Phase, phaseSince: NOW, lastActivity: NOW, attention: null,
  pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
  model: "opus", ctxPct: null, ctxTokens: null, cost: 0, durMs: null,
  curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
  lastEvent: "", activity: [], kind: "claude", external: false,
  pane: null as unknown as HTMLElement,
  ...over,
});

const unclaimed = (id: string, colorKey = "/w/episko"): Thread => ({
  id, source: "note", title: id, project: "e", colorKey, where: "", state: "",
  phase: "unclaimed", since: NOW, cost: null,
});

describe("radius is pressure, not phase", () => {
  it("separates two threads in the SAME state by how long they have waited", () => {
    // The whole reason this view exists. A static state→radius map would put these on
    // top of each other, and the picture would only move when something changed state.
    const fresh = fromSession(sess({ id: "a", phase: "done", phaseSince: minsAgo(2) }));
    const stale = fromSession(sess({ id: "b", phase: "done", phaseSince: minsAgo(45) }));
    expect(pressure(stale, NOW)).toBeGreaterThan(pressure(fresh, NOW));
    // …and that difference is visible as radius, not just as a number.
    expect(radiusFraction(pressure(stale, NOW))).toBeLessThan(radiusFraction(pressure(fresh, NOW)));
  });

  it("keeps the ordering between states intact — blocked always outranks working", () => {
    const blocked = fromSession(sess({ id: "a", attention: "rm -rf", phaseSince: NOW }));
    const workingForever = fromSession(sess({ id: "b", phase: "working", phaseSince: minsAgo(600) }));
    expect(pressure(blocked, NOW)).toBeGreaterThan(pressure(workingForever, NOW));
  });

  it("saturates rather than running away", () => {
    const ancient = fromSession(sess({ id: "a", phase: "done", phaseSince: minsAgo(100000) }));
    expect(pressure(ancient, NOW)).toBeLessThanOrEqual(1);
    expect(radiusFraction(pressure(ancient, NOW))).toBeGreaterThan(0.15);
  });

  it("treats an unknown age as brand new, not infinitely old", () => {
    // A branch row and a malformed timestamp both carry since = 0. Read as an epoch
    // that is 55 years of waiting, and it would slam against the centre forever.
    const t: Thread = { ...unclaimed("x"), since: 0 };
    expect(pressure(t, NOW)).toBeLessThan(0.2);
  });

  it("never reaches the centre, which belongs to the user", () => {
    expect(radiusFraction(1)).toBeGreaterThan(0.15);
    expect(radiusFraction(0)).toBeCloseTo(1, 5);
    // Out-of-range input is clamped rather than producing a dot outside the plot.
    expect(radiusFraction(2)).toBe(radiusFraction(1));
    expect(radiusFraction(-1)).toBe(radiusFraction(0));
  });
});

describe("sectors are stable", () => {
  it("assigns the same arc to a project regardless of who else is present", () => {
    // A repaint must not spin the picture — the dot you were watching has to stay put.
    const two = sectors(["/w/api", "/w/episko"]);
    const twoAgain = sectors(["/w/episko", "/w/api"]);
    expect(two).toEqual(twoAgain);
  });

  it("starts at the top rather than at 3 o'clock", () => {
    expect(sectors(["/w/a"])[0].from).toBeLessThan(0);
  });

  it("handles the empty fleet", () => {
    expect(sectors([])).toEqual([]);
  });
});

describe("layout", () => {
  it("places a thread by a hash of its id, so adding one does not move the others", () => {
    // Index-based placement makes every dot jump sideways whenever a thread appears,
    // which is exactly what makes an ambient display unwatchable.
    const a = unclaimed("aaa"), b = unclaimed("bbb"), c = unclaimed("ccc");
    const before = layout([a, b], NOW);
    const after = layout([a, b, c], NOW);
    const angleOf = (dots: ReturnType<typeof layout>, id: string) => dots.find((d) => d.thread.id === id)!.angle;
    expect(angleOf(after, "aaa")).toBeCloseTo(angleOf(before, "aaa"), 9);
    expect(angleOf(after, "bbb")).toBeCloseTo(angleOf(before, "bbb"), 9);
  });

  it("marks only blocked and errored threads as pulling a line to the centre", () => {
    const dots = layout([
      fromSession(sess({ id: "blocked", attention: "x" })),
      fromSession(sess({ id: "err", phase: "error" })),
      fromSession(sess({ id: "work", phase: "working" })),
      unclaimed("note"),
    ], NOW);
    expect(dots.filter((d) => d.urgent).map((d) => d.thread.id).sort())
      .toEqual(["session:blocked", "session:err"]);
  });

  it("sizes by spend without letting one expensive session swallow the view", () => {
    const cheap = layout([fromSession(sess({ id: "a", cost: 0.1 }))], NOW)[0];
    const dear = layout([fromSession(sess({ id: "b", cost: 400 }))], NOW)[0];
    expect(dear.size).toBeGreaterThan(cheap.size);
    expect(dear.size).toBeLessThanOrEqual(8);
  });

  it("keeps every dot inside the plot", () => {
    for (const d of layout([unclaimed("a"), fromSession(sess({ id: "b", attention: "x" }))], NOW)) {
      expect(d.radius).toBeGreaterThan(0);
      expect(d.radius).toBeLessThanOrEqual(1);
    }
  });
});

describe("crowding", () => {
  it("leaves a small fleet alone", () => {
    const few = [unclaimed("a"), unclaimed("b")];
    const { shown, collapsed } = collapseUnclaimed(few);
    expect(shown).toHaveLength(2);
    expect(collapsed.size).toBe(0);
  });

  it("collapses inventory once the outer band would smear", () => {
    const many = Array.from({ length: 20 }, (_, i) => unclaimed(`n${i}`));
    const { shown, collapsed } = collapseUnclaimed(many, 12);
    expect(shown).toHaveLength(0);
    expect(collapsed.get("/w/episko")).toBe(20);
  });

  it("never collapses anything running or waiting on you", () => {
    // Those are the only reasons to be looking at this view at all.
    const threads = [
      ...Array.from({ length: 20 }, (_, i) => unclaimed(`n${i}`)),
      fromSession(sess({ id: "blocked", attention: "x" })),
      fromSession(sess({ id: "work", phase: "working" })),
      fromSession(sess({ id: "done", phase: "done" })),
    ];
    const { shown } = collapseUnclaimed(threads, 12);
    expect(shown.map((t) => t.id).sort()).toEqual(["session:blocked", "session:done", "session:work"]);
  });

  it("counts collapsed inventory per project", () => {
    const threads = [
      ...Array.from({ length: 10 }, (_, i) => unclaimed(`a${i}`, "/w/api")),
      ...Array.from({ length: 8 }, (_, i) => unclaimed(`e${i}`, "/w/episko")),
    ];
    const { collapsed } = collapseUnclaimed(threads, 12);
    expect(collapsed.get("/w/api")).toBe(10);
    expect(collapsed.get("/w/episko")).toBe(8);
  });
});
