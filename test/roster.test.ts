import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { applyWire, isRosterKey, mergeWire, rosterWire, wireDiff, type Roster } from "../src/roster";

// Machine A has /a/app and /a/site; machine B has the same projects at other paths, and one of its own.
const IDS: Record<string, string> = { "/a/app": "git:1", "/a/app-wt": "git:1", "/a/site": "git:2", "/b/app": "git:1", "/b/site": "git:2", "/b/mine": "git:3" };
const idOf = (p: string) => IDS[p];
const pathOfB = (id: string) => ({ "git:1": "/b/app", "git:2": "/b/site", "git:3": "/b/mine" } as Record<string, string>)[id];
const empty = (): Roster => ({ favorites: [], order: [], groups: { groups: [], of: {} }, colors: {}, icons: {}, agent: {}, gh: {}, share: {} });

describe("rosterWire", () => {
  it("speaks in ids, and leaves out a project that has none yet", () => {
    const r: Roster = {
      favorites: [{ name: "app", path: "/a/app" }, { name: "scratch", path: "/tmp/x" }],
      order: ["/a/site", "/tmp/x", "/a/app"],
      groups: { groups: [{ id: "g1", name: "Work", collapsed: true }], of: { "/a/app": "g1", "/tmp/x": "g1" } },
      colors: { "/a/app": "#f00" }, icons: {}, agent: { "/a/site": "codex" }, gh: {}, share: { "/a/app": "server" },
    };
    expect(rosterWire(r, idOf)).toEqual({
      "fav|git:1": { name: "app" },
      "color|git:1": "#f00",
      "agent|git:2": "codex",
      "share|git:1": "server",
      order: ["git:2", "git:1"],
      groups: { groups: [{ id: "g1", name: "Work" }], of: { "git:1": "g1" } },
    });
  });
  it("names a project once however many checkouts of it this machine has", () => {
    const r = { ...empty(), colors: { "/a/app": "#f00", "/a/app-wt": "#0f0" } };
    expect(rosterWire(r, idOf)).toEqual({ "color|git:1": "#f00" });
  });
});

describe("wireDiff", () => {
  it("lists changed, added and removed keys, and nothing that stayed", () => {
    expect(wireDiff({ a: 1, b: [1], c: "x" }, { a: 1, b: [2], d: true })).toEqual(["b", "c", "d"]);
    expect(wireDiff({ order: ["x"] }, { order: ["x"] })).toEqual([]);
  });
});

describe("applyWire", () => {
  it("lands an entry on this machine's own checkout of the project", () => {
    const r = empty();
    expect(applyWire(r, "color|git:1", "#f00", pathOfB, idOf)).toBe(true);
    expect(r.colors).toEqual({ "/b/app": "#f00" });
    expect(applyWire(r, "color|git:1", null, pathOfB, idOf)).toBe(true);
    expect(r.colors).toEqual({});
  });
  it("holds back an entry for a project not cloned here", () => {
    const r = empty();
    expect(applyWire(r, "color|git:9", "#f00", pathOfB, idOf)).toBe(false);
    expect(r.colors).toEqual({});
  });
  it("favourites and unfavourites by id, with this machine's name for the folder", () => {
    const r = empty();
    expect(applyWire(r, "fav|git:2", { name: "site-on-a" }, pathOfB, idOf)).toBe(true);
    expect(r.favorites).toEqual([{ name: "site", path: "/b/site" }]);
    expect(applyWire(r, "fav|git:2", { name: "x" }, pathOfB, idOf)).toBe(false);
    expect(applyWire(r, "fav|git:2", null, pathOfB, idOf)).toBe(true);
    expect(r.favorites).toEqual([]);
  });
  it("orders by the other machine's list and keeps its own projects in place", () => {
    const r = { ...empty(), order: ["/b/mine", "/b/app", "/b/local", "/b/site"] };
    applyWire(r, "order", ["git:2", "git:1"], pathOfB, idOf);
    expect(r.order).toEqual(["/b/site", "/b/app", "/b/mine", "/b/local"]);
    expect(applyWire(r, "order", "nonsense", pathOfB, idOf)).toBe(false);
  });
  it("takes the groups but keeps this screen's collapsed state and id-less members", () => {
    const r: Roster = { ...empty(), groups: { groups: [{ id: "g1", name: "Old", collapsed: true }], of: { "/b/local": "g1", "/b/app": "g1" } } };
    applyWire(r, "groups", { groups: [{ id: "g1", name: "Work" }, { id: "g2", name: "Side" }], of: { "git:1": "g2", "git:2": "g1" } }, pathOfB, idOf);
    expect(r.groups).toEqual({
      groups: [{ id: "g1", name: "Work", collapsed: true }, { id: "g2", name: "Side", collapsed: false }],
      of: { "/b/local": "g1", "/b/app": "g2", "/b/site": "g1" },
    });
  });
  it("round-trips: what one machine sends, another rebuilds", () => {
    const a: Roster = { ...empty(), favorites: [{ name: "site", path: "/a/site" }], colors: { "/a/app": "#123456" }, gh: { "/a/app": "me" } };
    const b = empty();
    for (const [k, v] of Object.entries(rosterWire(a, idOf))) applyWire(b, k, v, pathOfB, idOf);
    expect(rosterWire(b, idOf)).toEqual(rosterWire(a, idOf));
  });
});

describe("mergeWire", () => {
  const knownB = (id: string) => pathOfB(id) !== undefined;
  it("never sends the absence of a project this machine has no checkout of", () => {
    const prev = { "color|git:9": "#f00", "color|git:1": "#000" };
    const merged = mergeWire(prev, { "color|git:1": "#fff" }, knownB);
    expect(merged).toEqual({ "color|git:9": "#f00", "color|git:1": "#fff" });
    expect(wireDiff(prev, merged)).toEqual(["color|git:1"]);
  });
  it("still sends a real removal of a project that is here", () => {
    expect(wireDiff({ "fav|git:1": { name: "app" } }, mergeWire({ "fav|git:1": { name: "app" } }, {}, knownB))).toEqual(["fav|git:1"]);
  });
  it("re-sorts only the projects it can place and keeps the others in their slots", () => {
    const prev = { order: ["git:1", "git:9", "git:2", "git:8"] };
    expect(mergeWire(prev, { order: ["git:2", "git:1", "git:3"] }, knownB).order).toEqual(["git:2", "git:9", "git:1", "git:8", "git:3"]);
  });
  it("keeps another machine's group membership for projects not cloned here", () => {
    const prev = { groups: { groups: [{ id: "g1", name: "W" }], of: { "git:9": "g1", "git:1": "g1" } } };
    const mine = { groups: { groups: [{ id: "g1", name: "W" }], of: { "git:2": "g1" } } };
    expect(mergeWire(prev, mine, knownB).groups).toEqual({ groups: [{ id: "g1", name: "W" }], of: { "git:9": "g1", "git:2": "g1" } });
  });
});

describe("the roster's reach", () => {
  it("knows its own keys", () => {
    for (const k of ["order", "groups", "fav|git:1", "icon|remote:o/r"]) expect(isRosterKey(k), k).toBe(true);
    for (const k of ["cc-colors", "fav|", "task|git:1"]) expect(isRosterKey(k), k).toBe(false);
  });
  it("imports nothing that could reach storage or the network", () => {
    const src = readFileSync(new URL("../src/roster.ts", import.meta.url), "utf8");
    expect([...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["./projgroups"]);
    expect(src).not.toMatch(/\blocalStorage\s*[.[]|\bfetch\s*\(|\binvoke\s*\(/);
  });
});
