import { describe, expect, it } from "vitest";
import { emptyNav, locKind, NAV_CAP, navTip, peek, sameLoc, step, visit, type Loc, type Nav } from "../src/nav";

const ses = (id: string): Loc => ({ kind: "session", id });
const dash = (root: string, name = root): Loc => ({ kind: "dash", root, name });
const fleet: Loc = { kind: "fleet" };
const all = () => true;
const walk = (...locs: Loc[]): Nav => locs.reduce(visit, emptyNav());

describe("sameLoc", () => {
  it("compares identity, not labels", () => {
    expect(sameLoc(ses("a"), ses("a"))).toBe(true);
    expect(sameLoc(ses("a"), ses("b"))).toBe(false);
    expect(sameLoc(dash("/r", "old"), dash("/r", "new"))).toBe(true);
    expect(sameLoc(fleet, { kind: "fleet" })).toBe(true);
    expect(sameLoc(fleet, ses("a"))).toBe(false);
    expect(sameLoc(null, null)).toBe(true);
    expect(sameLoc(null, fleet)).toBe(false);
  });

  // Claude mints a new session id on /clear; the mirror re-binds by pid, and so must history.
  it("keys an external mirror by pid", () => {
    expect(sameLoc({ kind: "ext", id: "x", pid: 7 }, { kind: "ext", id: "y", pid: 7 })).toBe(true);
    expect(sameLoc({ kind: "ext", id: "x", pid: 7 }, { kind: "ext", id: "x", pid: 8 })).toBe(false);
  });

  it("tells reviews apart by project and number", () => {
    const r = (root: string, number: number): Loc => ({ kind: "review", root, name: "p", number });
    expect(sameLoc(r("/a", 1), r("/a", 1))).toBe(true);
    expect(sameLoc(r("/a", 1), r("/a", 2))).toBe(false);
    expect(sameLoc(r("/a", 1), r("/b", 1))).toBe(false);
  });

  // Clicking a tile moves activeId; the mosaic is still the one place.
  it("treats a tiled run group as one place whichever tile is focused", () => {
    const g = (id: string): Loc => ({ kind: "session", id, group: "g1" });
    expect(sameLoc(g("a"), g("b"))).toBe(true);
    expect(sameLoc(g("a"), ses("a"))).toBe(false);
  });

  it("never equates two kinds that share an id", () => {
    expect(sameLoc({ kind: "past", id: "a" }, { kind: "past", id: "a" })).toBe(true);
    expect(sameLoc({ kind: "past", id: "a" }, ses("a"))).toBe(false);
  });
});

describe("visit", () => {
  it("pushes the place you left and clears forward", () => {
    let n = walk(ses("a"), ses("b"), ses("c"));
    expect(n.back).toEqual([ses("a"), ses("b")]);
    expect(n.cur).toEqual(ses("c"));
    n = step(n, "back", all)!.nav;
    expect(n.fwd).toEqual([ses("c")]);
    n = visit(n, dash("/r"));
    expect(n.fwd).toEqual([]);
    expect(n.back).toEqual([ses("a"), ses("b")]);
  });

  it("records nothing for the place you are already on", () => {
    const n = walk(ses("a"), ses("b"));
    expect(visit(n, ses("b"))).toBe(n);
  });

  // A pass that lands mid-handover sees nothing on stage; that is not a place.
  it("ignores an empty stage", () => {
    const n = walk(ses("a"));
    expect(visit(n, null)).toBe(n);
  });

  it("refreshes the current entry's fields without recording a move", () => {
    const n = visit(walk(fleet, { kind: "ext", id: "x", pid: 7 }), { kind: "ext", id: "y", pid: 7 });
    expect(n.cur).toEqual({ kind: "ext", id: "y", pid: 7 });
    expect(n.back).toEqual([fleet]);
  });

  it("caps the back stack at the oldest end", () => {
    let n = emptyNav();
    for (let i = 0; i < NAV_CAP + 20; i++) n = visit(n, ses(String(i)));
    expect(n.back.length).toBe(NAV_CAP);
    expect(n.back[0]).toEqual(ses("19"));
    expect(n.back[NAV_CAP - 1]).toEqual(ses(String(NAV_CAP + 18)));
  });
});

describe("step", () => {
  it("moves the cursor rather than recording", () => {
    const n = walk(ses("a"), ses("b"), ses("c"));
    const r = step(n, "back", all)!;
    expect(r.to).toEqual(ses("b"));
    expect(r.nav).toEqual({ back: [ses("a")], cur: ses("b"), fwd: [ses("c")] });
    // The pass after the step sees the stage where the step put it: nothing new is recorded.
    expect(visit(r.nav, ses("b"))).toBe(r.nav);
    const f = step(r.nav, "forward", all)!;
    expect(f.to).toEqual(ses("c"));
    expect(f.nav).toEqual({ back: [ses("a"), ses("b")], cur: ses("c"), fwd: [] });
  });

  it("answers null at either end", () => {
    const n = walk(ses("a"));
    expect(step(n, "back", all)).toBeNull();
    expect(step(n, "forward", all)).toBeNull();
    expect(step(emptyNav(), "back", all)).toBeNull();
  });

  it("skips and drops what is no longer alive", () => {
    const n = walk(ses("a"), ses("dead"), ses("c"));
    const r = step(n, "back", (l) => !(l.kind === "session" && l.id === "dead"))!;
    expect(r.to).toEqual(ses("a"));
    expect(r.nav.back).toEqual([]);
    expect(r.nav.fwd).toEqual([ses("c")]);
  });

  it("answers null when everything behind is dead, and leaves history alone", () => {
    const n = walk(ses("a"), ses("b"));
    expect(step(n, "back", () => false)).toBeNull();
    expect(n.back).toEqual([ses("a")]);
  });

  // A dead entry between two visits to one place would otherwise step onto where you stand.
  it("skips an entry equal to the current place", () => {
    const n: Nav = { back: [fleet, ses("a")], cur: ses("a"), fwd: [] };
    expect(step(n, "back", all)!.to).toEqual(fleet);
  });

  it("caps the back stack on a forward step too", () => {
    const back = Array.from({ length: NAV_CAP }, (_, i) => ses(`b${i}`));
    const n: Nav = { back, cur: ses("x"), fwd: [ses("y")] };
    const r = step(n, "forward", all)!;
    expect(r.nav.back.length).toBe(NAV_CAP);
    expect(r.nav.back[NAV_CAP - 1]).toEqual(ses("x"));
  });
});

describe("peek", () => {
  it("names the live entry a step would land on, without moving", () => {
    const n = walk(ses("a"), ses("dead"), ses("c"));
    const alive = (l: Loc) => !(l.kind === "session" && l.id === "dead");
    expect(peek(n, "back", alive)).toEqual(ses("a"));
    expect(peek(n, "forward", alive)).toBeNull();
    expect(n.back).toEqual([ses("a"), ses("dead")]);
    expect(peek(n, "back", () => false)).toBeNull();
  });

  it("agrees with step", () => {
    const n = step(walk(ses("a"), fleet, ses("c")), "back", all)!.nav;
    for (const dir of ["back", "forward"] as const) expect(peek(n, dir, all)).toEqual(step(n, dir, all)?.to ?? null);
  });
});

describe("labels", () => {
  it("names each kind", () => {
    expect(locKind(ses("a"))).toBe("session");
    expect(locKind({ kind: "session", id: "a", group: "g" })).toBe("task group");
    expect(locKind({ kind: "ext", id: "a", pid: 1 })).toBe("external session");
    expect(locKind({ kind: "past", id: "a" })).toBe("shelved session");
    expect(locKind(dash("/r"))).toBe("dashboard");
    expect(locKind(fleet)).toBe("all projects");
    expect(locKind({ kind: "review", root: "/r", name: "p", number: 12 })).toBe("pull request #12");
  });

  it("writes a tooltip with the destination and the chord", () => {
    expect(navTip("back", dash("/r"), "episko", "⌘[")).toBe("Back to episko · dashboard (⌘[)");
    expect(navTip("forward", ses("a"), "episko: fix it", "Alt+→")).toBe("Forward to episko: fix it · session (Alt+→)");
    expect(navTip("back", fleet, "", "")).toBe("Back to All projects");
    expect(navTip("back", ses("a"), "", "")).toBe("Back to session");
  });

  it("says when there is nowhere to go, chord included", () => {
    expect(navTip("back", null, "", "⌘[")).toBe("Nothing to go back to (⌘[)");
    expect(navTip("forward", null, "", "")).toBe("Nothing to go forward to");
  });
});
