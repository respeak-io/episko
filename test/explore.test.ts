import { describe, expect, it } from "vitest";
// explore.ts reaches palette.ts for the matcher, and palette.ts reads its frecency
// store at import time — so the stub has to exist first (see ./localstorage).
import "./localstorage";
import {
  browseRows, crumbs, findRows, parentDir, relPath, rowAction, scopeKeep, touchIndex,
} from "../src/explore";
import type { Sess, TouchKind } from "../src/types";

// The explorer's rules. The interesting ones are all about *agreement*: browse and find
// read the same index, the scopes are filters over the same rows rather than three
// lists, and a touch mark has to survive the trip from an absolute hook path back to
// the project-relative string the index speaks.

const IDX = [
  "CHANGELOG.md",
  "docs/architecture.md",
  "docs/testing.md",
  "src/explore.ts",
  "src/inspector.ts",
  "src/inspectorview.ts",
  "src/main.ts",
  "src-tauri/src/git.rs",
  "test/explore.test.ts",
];
const CHANGED = new Map([["src/explore.ts", "A"], ["CHANGELOG.md", "M"]]);
const TOUCHED = new Map<string, TouchKind>([["src/explore.ts", "created"], ["src/main.ts", "read"]]);
const all = () => true;

describe("browse", () => {
  it("puts folders first, each alphabetical, and counts what is beneath them", () => {
    const rows = browseRows(IDX, "", all);
    expect(rows.filter((r) => r.dir).map((r) => r.name)).toEqual(["docs", "src", "src-tauri", "test"]);
    // Folders lead, so the first non-dir is where the files start.
    expect(rows.findIndex((r) => !r.dir)).toBe(4);
    expect(rows.find((r) => r.name === "docs")?.n).toBe(2);
    expect(rows.find((r) => r.name === "src")?.n).toBe(4);
  });

  it("descends without a round trip — a folder's rows come from the same flat index", () => {
    const rows = browseRows(IDX, "src", all);
    expect(rows.map((r) => r.name)).toEqual(["explore.ts", "inspector.ts", "inspectorview.ts", "main.ts"]);
    expect(rows.every((r) => !r.dir)).toBe(true);
    // Nested folders synthesise the same way one level down.
    expect(browseRows(IDX, "src-tauri", all).map((r) => r.name)).toEqual(["src"]);
    expect(browseRows(IDX, "src-tauri/src", all).map((r) => r.name)).toEqual(["git.rs"]);
  });

  it("does not let a prefix match half a folder name", () => {
    // "src" must not swallow "src-tauri/…": the separator is part of the prefix.
    expect(browseRows(IDX, "src", all).some((r) => r.path.startsWith("src-tauri"))).toBe(false);
  });

  it("hides a folder with nothing in scope, rather than showing it empty", () => {
    const keep = scopeKeep("changed", CHANGED, TOUCHED);
    const rows = browseRows(IDX, "", keep);
    expect(rows.map((r) => r.name)).toEqual(["src", "CHANGELOG.md"]);
    expect(rows.find((r) => r.name === "src")?.n).toBe(1);
  });
});

describe("find", () => {
  it("ranks with the palette's matcher and is stable between keystrokes", () => {
    const rows = findRows(IDX, "insp", all);
    expect(rows[0].path).toBe("src/inspector.ts");
    expect(rows.map((r) => r.path)).toContain("src/inspectorview.ts");
    // Equal scores must not reorder run to run: the tie-break is the path.
    const twice = findRows(IDX, "s", all).map((r) => r.path);
    expect(findRows(IDX, "s", all).map((r) => r.path)).toEqual(twice);
  });

  it("matches across separators, and highlights what matched", () => {
    const [hit] = findRows(IDX, "srcgit", all);
    expect(hit.path).toBe("src-tauri/src/git.rs");
    expect(hit.html).toContain("hit");
  });

  it("honours the scope and the limit", () => {
    expect(findRows(IDX, "s", scopeKeep("touched", CHANGED, TOUCHED)).map((r) => r.path))
      .toEqual(["src/explore.ts", "src/main.ts"]);
    expect(findRows(IDX, "s", all, 2)).toHaveLength(2);
  });

  it("returns nothing for a query no path contains", () => {
    expect(findRows(IDX, "zzq", all)).toEqual([]);
  });
});

describe("the breadcrumb", () => {
  it("names the root and then every segment, each with where it leads", () => {
    expect(crumbs("", "episko")).toEqual([{ label: "episko", path: "" }]);
    expect(crumbs("src-tauri/src", "episko")).toEqual([
      { label: "episko", path: "" },
      { label: "src-tauri", path: "src-tauri" },
      { label: "src", path: "src-tauri/src" },
    ]);
  });
  it("goes up one level at a time and stops at the root", () => {
    expect(parentDir("src-tauri/src")).toBe("src-tauri");
    expect(parentDir("src")).toBe("");
    expect(parentDir("")).toBe("");
  });
});

describe("touch marks", () => {
  const sess = (workdir: string, files: { path: string; kind: TouchKind }[]) =>
    ({ workdir, files: files.map((f) => ({ ...f, n: 1, at: 0 })) } as Sess);

  it("maps an absolute hook path back to the index's spelling", () => {
    expect(relPath("/w/proj/src/main.ts", "/w/proj")).toBe("src/main.ts");
    expect(relPath("/w/proj/src/main.ts", "/w/proj/")).toBe("src/main.ts");
    expect(relPath("C:\\w\\proj\\src\\main.ts", "C:\\w\\proj")).toBe("src/main.ts");
  });

  it("drops what is outside the project instead of misplacing it", () => {
    // The three real cases: a file in $HOME, a sibling checkout, and the root itself.
    expect(relPath("/home/me/.claude/settings.json", "/w/proj")).toBeNull();
    expect(relPath("/w/proj-other/src/main.ts", "/w/proj")).toBeNull();
    expect(relPath("/w/proj", "/w/proj")).toBeNull();
  });

  it("is case-insensitive on the root, since the OS is", () => {
    expect(relPath("/Users/Me/Proj/src/a.ts", "/users/me/proj")).toBe("src/a.ts");
  });

  it("climbs the ladder rather than letting the last verb win", () => {
    const idx = touchIndex([
      sess("/w/proj", [{ path: "/w/proj/a.ts", kind: "created" }, { path: "/w/proj/b.ts", kind: "read" }]),
      // A second session re-reads what the first one created: created must survive.
      sess("/w/proj", [{ path: "/w/proj/a.ts", kind: "read" }, { path: "/w/proj/b.ts", kind: "edited" }]),
    ], "/w/proj");
    expect(idx.get("a.ts")).toBe("created");
    expect(idx.get("b.ts")).toBe("edited");
  });

  it("ignores a session working somewhere else", () => {
    const idx = touchIndex([sess("/w/other", [{ path: "/w/other/x.ts", kind: "edited" }])], "/w/proj");
    expect(idx.size).toBe(0);
  });
});

describe("what ↵ does", () => {
  it("enters a folder, diffs a changed file, and hands anything else to the OS", () => {
    expect(rowAction({ name: "src", path: "src", dir: true }, CHANGED)).toEqual({ kind: "enter", path: "src" });
    expect(rowAction({ name: "explore.ts", path: "src/explore.ts", dir: false }, CHANGED))
      .toEqual({ kind: "diff", path: "src/explore.ts" });
    expect(rowAction({ name: "main.ts", path: "src/main.ts", dir: false }, CHANGED))
      .toEqual({ kind: "open", path: "src/main.ts" });
    expect(rowAction(undefined, CHANGED)).toBeNull();
  });
});
