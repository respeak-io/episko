import { describe, expect, it } from "vitest";
import {
  applyTouch, bumpTally, fileLabel, groupTouches, otherTools, shortTool, touchPath, touchTool,
} from "../src/files";
import type { FileTouch } from "../src/types";

// Helpers: one tool call, at a chosen instant.
const read = (l: FileTouch[], p: string, t = 1000) => applyTouch(l, "Read", { file_path: p }, null, t);
const edit = (l: FileTouch[], p: string, t = 1000) => applyTouch(l, "Edit", { file_path: p }, null, t);
const write = (l: FileTouch[], p: string, resp: unknown = null, t = 1000) =>
  applyTouch(l, "Write", { file_path: p }, resp, t);
const kindOf = (l: FileTouch[], p: string) => l.find((f) => f.path === p)?.kind;

describe("touchTool", () => {
  it("classifies the file tools and only the file tools", () => {
    expect(touchTool("Read")).toBe("read");
    expect(touchTool("NotebookRead")).toBe("read");
    expect(touchTool("Edit")).toBe("edit");
    expect(touchTool("MultiEdit")).toBe("edit");
    expect(touchTool("NotebookEdit")).toBe("edit");
    expect(touchTool("Write")).toBe("write");
    for (const t of ["Bash", "Grep", "Glob", "WebFetch", "Task", "TodoWrite", "mcp__x__y", ""])
      expect(touchTool(t), t).toBeNull();
  });
});

describe("touchPath", () => {
  it("reads file_path and NotebookEdit's spelling of it", () => {
    expect(touchPath({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(touchPath({ notebook_path: "/a/b.ipynb" })).toBe("/a/b.ipynb");
  });
  it("never takes `path` — Glob and Grep use it for a DIRECTORY", () => {
    // The one way a folder could end up drawn as a file in the card.
    expect(touchPath({ path: "/a/src" })).toBe("");
  });
  it("ignores a missing, blank or non-string field", () => {
    expect(touchPath(null)).toBe("");
    expect(touchPath({})).toBe("");
    expect(touchPath({ file_path: "   " })).toBe("");
    expect(touchPath({ file_path: 7 })).toBe("");
  });
});

describe("applyTouch", () => {
  it("records one entry per path, not one per call", () => {
    const l: FileTouch[] = [];
    read(l, "/p/a.ts", 10); read(l, "/p/a.ts", 20); read(l, "/p/a.ts", 30);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ path: "/p/a.ts", kind: "read", n: 3, at: 30 });
  });

  it("leaves the set alone for a tool that touches no file", () => {
    const l: FileTouch[] = [];
    applyTouch(l, "Bash", { command: "ls" }, null, 1);
    applyTouch(l, "Grep", { pattern: "x", path: "/p/src" }, null, 1);
    expect(l).toEqual([]);
  });

  // The ladder. This is the behaviour the whole card leans on, so it is tested from
  // both directions: the promotion has to happen, and the demotion must not.
  it("promotes read → edited", () => {
    const l: FileTouch[] = [];
    read(l, "/p/a.ts"); edit(l, "/p/a.ts");
    expect(kindOf(l, "/p/a.ts")).toBe("edited");
  });
  it("does NOT demote edited back to read when the agent re-reads its own work", () => {
    const l: FileTouch[] = [];
    edit(l, "/p/a.ts"); read(l, "/p/a.ts");
    expect(kindOf(l, "/p/a.ts")).toBe("edited");
  });
  it("keeps `created` through every later edit and read", () => {
    const l: FileTouch[] = [];
    write(l, "/p/new.ts");
    edit(l, "/p/new.ts"); read(l, "/p/new.ts"); edit(l, "/p/new.ts");
    expect(kindOf(l, "/p/new.ts")).toBe("created");
    expect(l[0].n).toBe(4);
  });

  it("believes tool_response.type over the heuristic, in both directions", () => {
    const l: FileTouch[] = [];
    // Never seen before, yet Claude says it overwrote something: trust Claude.
    write(l, "/p/old.ts", { type: "update" });
    expect(kindOf(l, "/p/old.ts")).toBe("edited");
    // Seen before (read), yet Claude says it created it: trust Claude.
    const l2: FileTouch[] = [];
    read(l2, "/p/x.ts");
    write(l2, "/p/x.ts", { type: "create" });
    expect(kindOf(l2, "/p/x.ts")).toBe("created");
  });

  it("falls back to seen-before when the payload says nothing", () => {
    const l: FileTouch[] = [];
    write(l, "/p/fresh.ts", null);
    expect(kindOf(l, "/p/fresh.ts")).toBe("created");
    const l2: FileTouch[] = [];
    read(l2, "/p/known.ts");
    write(l2, "/p/known.ts", { ok: true });   // an object, but no `type`
    expect(kindOf(l2, "/p/known.ts")).toBe("edited");
  });

  it("caps the set, and sheds reads before it sheds work", () => {
    const l: FileTouch[] = [];
    edit(l, "/p/precious.ts", 1);                       // the oldest entry of all
    for (let i = 0; i < 500; i++) read(l, `/p/r${i}.ts`, 100 + i);
    expect(l.length).toBeLessThanOrEqual(400);
    // A plain oldest-first eviction would have dropped this first; it must survive.
    expect(kindOf(l, "/p/precious.ts")).toBe("edited");
    // And what it shed is the oldest reads, not the newest.
    expect(kindOf(l, "/p/r0.ts")).toBeUndefined();
    expect(kindOf(l, "/p/r499.ts")).toBe("read");
  });
});

describe("groupTouches", () => {
  it("splits by kind, most recent first in each", () => {
    const l: FileTouch[] = [];
    read(l, "/p/a.ts", 10); edit(l, "/p/b.ts", 30); read(l, "/p/c.ts", 20); write(l, "/p/d.ts", null, 40);
    const g = groupTouches(l);
    expect(g.created.map((f) => f.path)).toEqual(["/p/d.ts"]);
    expect(g.edited.map((f) => f.path)).toEqual(["/p/b.ts"]);
    expect(g.read.map((f) => f.path)).toEqual(["/p/c.ts", "/p/a.ts"]);
  });
  it("gives every group an array, empty or not", () => {
    const g = groupTouches([]);
    expect(g).toEqual({ created: [], edited: [], read: [] });
  });
});

describe("fileLabel", () => {
  const wd = "/Users/t/proj";
  it("splits into basename and a workdir-relative folder", () => {
    expect(fileLabel("/Users/t/proj/src/a.ts", wd)).toEqual({ name: "a.ts", dir: "src", outside: false });
  });
  it("leaves the folder empty for a file in the root", () => {
    expect(fileLabel("/Users/t/proj/README.md", wd)).toEqual({ name: "README.md", dir: "", outside: false });
  });
  it("flags a file outside the session's folder and keeps its whole path", () => {
    expect(fileLabel("/Users/t/.zshrc", wd)).toEqual({ name: ".zshrc", dir: "/Users/t", outside: true });
  });
  it("does not mistake a sibling with a shared prefix for a child", () => {
    // `/Users/t/proj-old` starts with `/Users/t/proj` as a STRING but is a different
    // folder — the trailing separator in the comparison is what keeps them apart.
    const l = fileLabel("/Users/t/proj-old/src/a.ts", wd);
    expect(l.outside).toBe(true);
    expect(l.dir).toBe("/Users/t/proj-old/src");
  });
  it("levels separators and case, and shows the path as it really is", () => {
    const l = fileLabel("C:\\Users\\T\\Proj\\src\\a.ts", "c:/users/t/proj");
    expect(l).toEqual({ name: "a.ts", dir: "src", outside: false });
  });
  it("survives a session with no workdir", () => {
    expect(fileLabel("/a/b/c.ts", "")).toEqual({ name: "c.ts", dir: "/a/b", outside: false });
  });
});

describe("the tally and its footer", () => {
  it("counts every tool but only reports the ones the file list doesn't", () => {
    const t: Record<string, number> = {};
    for (const x of ["Bash", "Bash", "Bash", "Read", "Grep", "TodoWrite", "Edit"]) bumpTally(t, x);
    expect(t.Read).toBe(1);                     // the raw tally keeps everything…
    expect(otherTools(t).map((o) => o.tool)).toEqual(["Bash", "Grep"]);  // …the footer doesn't
  });
  it("orders by count, then by name, and takes a bounded slice", () => {
    const t: Record<string, number> = { Bash: 3, WebFetch: 9, Task: 3, Glob: 1 };
    expect(otherTools(t, 3)).toEqual([
      { tool: "WebFetch", n: 9 }, { tool: "Bash", n: 3 }, { tool: "Task", n: 3 },
    ]);
  });
  it("ignores a blank tool name rather than counting an empty key", () => {
    const t: Record<string, number> = {};
    bumpTally(t, "");
    expect(t).toEqual({});
  });
  it("shortens an MCP tool to server·tool and leaves everything else alone", () => {
    expect(shortTool("mcp__github__create_issue")).toBe("github·create_issue");
    expect(shortTool("mcp__claude_ai_Slack__slack_send_message")).toBe("claude_ai_Slack·slack_send_message");
    expect(shortTool("Bash")).toBe("Bash");
  });
});
