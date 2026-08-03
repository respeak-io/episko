import { describe, expect, it } from "vitest";
import {
  assignGroup, clampGroups, cleanGroupName, collapseAll, createGroup, deleteGroup,
  groupById, groupOf, groupPaths, nextGroupId, NO_GROUPS, renameGroup, setCollapsed,
  type GroupStore,
} from "../src/projgroups";

// A store as the app would hold one. Written out rather than built with the mutators,
// so a bug in one of them can't make its own fixture agree with it.
const store = (o: Partial<GroupStore> = {}): GroupStore => ({ groups: [], of: {}, ...o });
const work = { id: "g1", name: "Work", collapsed: false };
const side = { id: "g2", name: "Side", collapsed: true };
const names = (st: GroupStore) => st.groups.map((g) => g.name);

describe("cleanGroupName — what a heading is allowed to be", () => {
  it("trims and collapses whitespace to one line", () => {
    expect(cleanGroupName("  Work   stuff \n here ")).toBe("Work stuff here");
  });
  it("bounds the length — a 220px rail cannot show more", () => {
    expect(cleanGroupName("x".repeat(200))).toHaveLength(40);
  });
  it("returns empty for nothing at all, so callers can refuse it", () => {
    expect(cleanGroupName("   ")).toBe("");
    expect(cleanGroupName(null)).toBe("");
    expect(cleanGroupName(undefined)).toBe("");
  });
});

describe("clampGroups — what comes back out of localStorage", () => {
  it("passes a sound store through", () => {
    const st = clampGroups({ groups: [work, side], of: { "/w/a": "g1" } });
    expect(names(st)).toEqual(["Work", "Side"]);
    expect(st.of).toEqual({ "/w/a": "g1" });
    expect(st.groups[1].collapsed).toBe(true);
  });
  it("survives null, junk and a hand-edited half-store", () => {
    expect(clampGroups(null)).toEqual(NO_GROUPS);
    expect(clampGroups("nonsense")).toEqual(NO_GROUPS);
    expect(clampGroups({ groups: "no" })).toEqual(NO_GROUPS);
    expect(clampGroups({ groups: [work] }).of).toEqual({});
  });
  it("DROPS a membership whose group is gone — the one corruption a user can't see", () => {
    // The project would belong to a fold nothing draws, so it would simply vanish from
    // the sidebar with no row, no error and nothing to right-click.
    const st = clampGroups({ groups: [work], of: { "/w/a": "g1", "/w/b": "ghost" } });
    expect(st.of).toEqual({ "/w/a": "g1" });
  });
  it("drops a duplicate id rather than letting two groups answer to one key", () => {
    const st = clampGroups({ groups: [work, { id: "g1", name: "Other", collapsed: false }] });
    expect(names(st)).toEqual(["Work"]);
  });
  it("drops an id-less group and names an unnamed one", () => {
    const st = clampGroups({ groups: [{ name: "x" }, { id: "g9" }] });
    expect(st.groups).toEqual([{ id: "g9", name: "Group", collapsed: false }]);
  });
  it("treats a missing collapsed flag as open", () => {
    expect(clampGroups({ groups: [{ id: "g1", name: "W" }] }).groups[0].collapsed).toBe(false);
  });
});

describe("nextGroupId — deterministic, so nothing here needs a clock", () => {
  it("takes the lowest free slot rather than the next number", () => {
    expect(nextGroupId(NO_GROUPS)).toBe("g1");
    expect(nextGroupId(store({ groups: [work, side] }))).toBe("g3");
    // g1 was deleted: reuse it rather than climbing forever.
    expect(nextGroupId(store({ groups: [side] }))).toBe("g1");
  });
});

describe("createGroup — a group is born with something in it", () => {
  it("files the paths it was given under the new id", () => {
    const st = createGroup(NO_GROUPS, "Work", ["/w/a", "/w/b"]);
    expect(st.groups).toEqual([{ id: "g1", name: "Work", collapsed: false }]);
    expect(st.of).toEqual({ "/w/a": "g1", "/w/b": "g1" });
  });
  it("moves a project that already had a group — one project, one group", () => {
    const st = createGroup(store({ groups: [work], of: { "/w/a": "g1" } }), "Side", ["/w/a"]);
    expect(st.of).toEqual({ "/w/a": "g2" });
  });
  it("falls back to a name rather than minting an unlabelled heading", () => {
    expect(createGroup(NO_GROUPS, "   ").groups[0].name).toBe("Group");
  });
});

describe("assignGroup — filing a project, and taking it back out", () => {
  const st = store({ groups: [work, side], of: { "/w/a": "g1" } });
  it("moves it between groups", () => {
    expect(assignGroup(st, "/w/a", "g2").of).toEqual({ "/w/a": "g2" });
  });
  it("null returns it to the top level", () => {
    expect(assignGroup(st, "/w/a", null).of).toEqual({});
  });
  it("refuses a group that doesn't exist — that's the dangling membership again", () => {
    expect(assignGroup(st, "/w/a", "ghost")).toBe(st);
  });
  it("returns the SAME store for a no-op, so the call site can skip the repaint", () => {
    // The whole reason these are pure: `commitProjGroups` compares by identity, and a
    // sidebar repaint measures 7ms.
    expect(assignGroup(st, "/w/a", "g1")).toBe(st);
    expect(assignGroup(st, "/w/b", null)).toBe(st);
    expect(assignGroup(st, "", "g1")).toBe(st);
  });
});

describe("renameGroup", () => {
  const st = store({ groups: [work, side] });
  it("renames without touching the id the memberships point at", () => {
    const next = renameGroup(store({ groups: [work], of: { "/w/a": "g1" } }), "g1", " Day  job ");
    expect(next.groups[0]).toEqual({ id: "g1", name: "Day job", collapsed: false });
    expect(next.of).toEqual({ "/w/a": "g1" });
  });
  it("refuses an empty name — a nameless heading is unreachable", () => {
    expect(renameGroup(st, "g1", "  ")).toBe(st);
  });
  it("ignores an unknown group", () => {
    expect(renameGroup(st, "ghost", "x")).toBe(st);
  });
});

describe("deleteGroup — the heading goes, the projects stay", () => {
  it("drops the group and every membership pointing at it, and nothing else", () => {
    const st = deleteGroup(store({ groups: [work, side], of: { "/w/a": "g1", "/w/b": "g2" } }), "g1");
    expect(names(st)).toEqual(["Side"]);
    expect(st.of).toEqual({ "/w/b": "g2" });
  });
  it("ignores an unknown group", () => {
    const st = store({ groups: [work] });
    expect(deleteGroup(st, "ghost")).toBe(st);
  });
});

describe("setCollapsed / collapseAll", () => {
  const st = store({ groups: [work, side] });
  it("folds one group without touching its neighbour", () => {
    expect(setCollapsed(st, "g1", true).groups.map((g) => g.collapsed)).toEqual([true, true]);
  });
  it("is a no-op when it already is that way", () => {
    expect(setCollapsed(st, "g1", false)).toBe(st);
    expect(setCollapsed(st, "ghost", true)).toBe(st);
  });
  it("collapseAll moves every group, and no-ops when they all agree", () => {
    expect(collapseAll(st, true).groups.every((g) => g.collapsed)).toBe(true);
    expect(collapseAll(store({ groups: [side] }), true)).toEqual(store({ groups: [side] }));
    const already = store({ groups: [side] });
    expect(collapseAll(already, true)).toBe(already);
  });
});

describe("the readers", () => {
  const st = store({ groups: [work, side], of: { "/w/a": "g1", "/w/b": "g1", "/w/c": "g2" } });
  it("groupOf answers null for an ungrouped project rather than undefined", () => {
    expect(groupOf(st, "/w/a")).toBe("g1");
    expect(groupOf(st, "/w/zzz")).toBeNull();
  });
  it("groupById answers null for one that is gone", () => {
    expect(groupById(st, "g2")).toEqual(side);
    expect(groupById(st, "ghost")).toBeNull();
  });
  it("groupPaths lists a group's members", () => {
    expect(groupPaths(st, "g1").sort()).toEqual(["/w/a", "/w/b"]);
    expect(groupPaths(st, "ghost")).toEqual([]);
  });
});
