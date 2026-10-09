import { describe, expect, it } from "vitest";
import { canDiscardHunk, commitBlock, discardQuestion, filePaths, stashElsewhere } from "../src/gitops";
import type { DiffFile } from "../src/diff";
import type { StashEntry } from "../src/types";

const file = (path: string, o: Partial<DiffFile> = {}): DiffFile => ({
  path, oldPath: null, status: "modified", binary: false, added: 1, removed: 1,
  hunks: [{ at: "@@ -1 +1 @@", header: "", lines: [] }], ...o,
});

describe("filePaths", () => {
  it("names both ends of a rename, once each", () => {
    expect(filePaths([file("b.ts", { status: "renamed", oldPath: "a.ts" }), file("c.ts", { oldPath: "c.ts" })]))
      .toEqual(["b.ts", "a.ts", "c.ts"]);
  });
});

describe("canDiscardHunk", () => {
  it("is a plain modification's alone", () => {
    expect(canDiscardHunk(file("x"))).toBe(true);
    for (const status of ["added", "deleted", "renamed"] as const) expect(canDiscardHunk(file("x", { status }))).toBe(false);
    expect(canDiscardHunk(file("x", { binary: true }))).toBe(false);
    expect(canDiscardHunk(file("x", { hunks: [] }))).toBe(false);
  });
});

describe("commitBlock", () => {
  it("asks for files before a message, and clears when both are there", () => {
    expect(commitBlock("", 0)).toMatch(/Tick/);
    expect(commitBlock("  ", 2)).toMatch(/message/);
    expect(commitBlock("fix", 2)).toBe("");
  });
});

describe("discardQuestion", () => {
  it("says a new file is deleted rather than reverted", () => {
    const q = discardQuestion([file("src/new.ts", { status: "added" })], 0);
    expect(q.title).toBe("Discard changes to new.ts?");
    expect(q.message).toMatch(/is new, so it will be deleted/);
    expect(q.message).toMatch(/cannot be undone/);
  });

  it("counts both kinds in a batch and warns about a live agent", () => {
    const q = discardQuestion([file("a"), file("b"), file("c", { status: "added" })], 2);
    expect(q.title).toBe("Discard changes to 3 files?");
    expect(q.message).toMatch(/2 files go back/);
    expect(q.message).toMatch(/1 new file will be deleted/);
    expect(q.message).toMatch(/2 agents are working/);
  });
});

describe("stashElsewhere", () => {
  const e = (branch: string): StashEntry => ({ sha: "abc1234", branch, message: "m", unix: 0, rel: "now" });
  it("flags only a stash that names a different branch", () => {
    expect(stashElsewhere(e("main"), "main")).toBe(false);
    expect(stashElsewhere(e("feat"), "main")).toBe(true);
    expect(stashElsewhere(e(""), "main")).toBe(false);   // detached: no claim either way
    expect(stashElsewhere(e("feat"), "")).toBe(false);
  });
});
