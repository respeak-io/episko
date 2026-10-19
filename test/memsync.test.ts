import { describe, it, expect } from "vitest";
import {
  HELD_MAX, KEY_MAX, MEM_NAME_MAX, PAYLOAD_MAX, PUSH_EVENTS, acceptMem, conflictName, diffLocal, holdMem, memChunks, memKey, mergeMemWire, narrowMem, narrowScan,
  parseMemKey, pickDir, readMemBook, validName, type MemBook,
} from "../src/memsync";

const sha = (c: string) => c.repeat(64);
const book = (b: Partial<MemBook> = {}): MemBook => ({ seen: {}, held: {}, dirs: {}, ...b });
const ev = (key: string, payload: unknown, at = 10, device = "d2") => ({ stream: "memory", key, at, device, payload });

describe("names and keys", () => {
  it("takes a plain memory file and nothing that could be the index or a path", () => {
    for (const ok of ["wip.md", "user_role.md", "a.b-c.md", "x".repeat(MEM_NAME_MAX - 3) + ".md"]) expect(validName(ok), ok).toBe(true);
    for (const bad of ["MEMORY.md", "memory.md", "Memory.MD", ".md", "..md", "../x.md", "a/b.md", "a\\b.md", "x.txt", "bad name.md", "", "x".repeat(MEM_NAME_MAX) + ".md", 7]) {
      expect(validName(bad), String(bad)).toBe(false);
    }
  });

  it("splits a key at its last bar, so a project id stays whole", () => {
    expect(parseMemKey(memKey("git:abc", "wip.md"))).toEqual({ pid: "git:abc", name: "wip.md" });
    expect(parseMemKey("a|b|wip.md")).toEqual({ pid: "a|b", name: "wip.md" });
    expect(parseMemKey("|wip.md")).toBeNull();
    expect(parseMemKey("p|MEMORY.md")).toBeNull();
    expect(parseMemKey("nowhere")).toBeNull();
  });
});

describe("narrowing", () => {
  it("tells a tombstone from an unusable payload", () => {
    expect(narrowMem(null)).toBeNull();
    expect(narrowMem({ text: "x", sha: sha("a") })).toEqual({ text: "x", sha: sha("a") });
    for (const bad of [undefined, "x", { text: "x" }, { text: 1, sha: sha("a") }, { text: "x", sha: "short" }]) expect(narrowMem(bad)).toBeUndefined();
  });

  it("keeps a scan's good files and drops the rest one by one", () => {
    const scan = narrowScan({ files: [{ name: "a.md", text: "t", sha: sha("a") }, { name: "MEMORY.md", text: "t", sha: sha("b") }, { name: "c.md" }], skipped: ["big.md", "../x.md"] });
    expect(scan).toEqual({ files: [{ name: "a.md", text: "t", sha: sha("a") }], skipped: ["big.md"], found: false });
    expect(narrowScan(null)).toBeNull();
    expect(narrowScan({ files: "x" })).toBeNull();
  });

  it("reads the book without trusting it", () => {
    for (const raw of [null, "", "{", "null", "[]", "7"]) expect(readMemBook(raw)).toEqual(book());
    const raw = JSON.stringify({
      seen: { "p|a.md": sha("a"), "p|MEMORY.md": sha("b"), "p|c.md": "short" },
      held: { "p|a.md": { payload: null, at: 3, device: "d2" }, "p|b.md": { payload: { text: "x" }, at: 3, device: "d2" }, "p|c.md": { payload: null, device: "d2" } },
    });
    expect(readMemBook(raw)).toEqual(book({ seen: { "p|a.md": sha("a") }, held: { "p|a.md": { payload: null, at: 3, device: "d2" } } }));
    expect(readMemBook(JSON.stringify({ caught: true })).caught).toBe(true);
    expect(readMemBook(JSON.stringify({ caught: "yes" })).caught).toBeUndefined();
  });
});

describe("diffLocal: what the server would refuse never goes", () => {
  it("skips a key past the server's limit and a payload past its size once escaped", () => {
    const long = "git:" + "a".repeat(KEY_MAX);
    expect(diffLocal(long, { files: [{ name: "a.md", text: "x", sha: sha("a") }], skipped: [], found: true }, book(), () => false)).toEqual([]);
    const pid = "git:" + "b".repeat(KEY_MAX - 10);
    const files = [{ name: "a.md", text: "x", sha: sha("a") }, { name: "much-longer-name.md", text: "x", sha: sha("b") }];
    expect(diffLocal(pid, { files, skipped: [], found: true }, book(), () => false).map((o) => o.key)).toEqual([`${pid}|a.md`]);
    const ansi = String.fromCharCode(27).repeat(Math.ceil(PAYLOAD_MAX / 6) + 1);
    expect(diffLocal("p", { files: [{ name: "a.md", text: ansi, sha: sha("c") }], skipped: [], found: true }, book(), () => false)).toEqual([]);
  });
});

describe("diffLocal", () => {
  const scan = { files: [{ name: "a.md", text: "A", sha: sha("a") }, { name: "b.md", text: "B2", sha: sha("c") }, { name: "new.md", text: "N", sha: sha("d") }], skipped: ["big.md"], found: true };
  const seen = { "p|a.md": sha("a"), "p|b.md": sha("b"), "p|gone.md": sha("e"), "p|big.md": sha("f"), "q|other.md": sha("1") };

  it("owes what changed, reveals only a first discovery, and tombstones only a file it saw go", () => {
    const out = diffLocal("p", scan, book({ seen }), () => false);
    expect(out).toEqual([
      { key: "p|b.md", payload: { text: "B2", sha: sha("c") }, reveal: false },
      { key: "p|gone.md", payload: null, reveal: false },
      { key: "p|new.md", payload: { text: "N", sha: sha("d") }, reveal: true },
    ]);
  });

  it("does not reveal a file the server already spoke of, nor touch one still waiting to be applied", () => {
    const held = { "p|b.md": { payload: { text: "B3", sha: sha("9") }, at: 5, device: "d2" }, "p|gone.md": { payload: null, at: 5, device: "d2" } };
    const out = diffLocal("p", scan, book({ seen, held }), (k) => k === "p|new.md");
    expect(out).toEqual([{ key: "p|new.md", payload: { text: "N", sha: sha("d") }, reveal: false }]);
  });

  it("owes nothing when the disk is what was agreed", () => {
    expect(diffLocal("p", { files: [scan.files[0]], skipped: [], found: true }, book({ seen: { "p|a.md": sha("a") } }), () => false)).toEqual([]);
  });

  it("never reads a missing folder as every file removed", () => {
    expect(diffLocal("p", { files: [], skipped: [], found: false }, book({ seen }), () => false)).toEqual([]);
  });
});

describe("where a project's memories live", () => {
  it("keeps the checkout it scanned while that is still here, and calls any new pick a move", () => {
    expect(pickDir("/b", ["/a", "/b"])).toEqual({ dir: "/b", moved: false });
    expect(pickDir("/gone", ["/a", "/b"])).toEqual({ dir: "/a", moved: true });
    expect(pickDir(undefined, ["/a"])).toEqual({ dir: "/a", moved: true });
    expect(pickDir("/a", [])).toBeNull();
  });

  it("names a conflicting arrival beside the original, still a memory that may travel", () => {
    expect(conflictName("user_role.md", "d2:abc/xyz")).toBe("user_role.from-d2abcxyz.md");
    expect(conflictName("a.md", "")).toBe("a.from-other.md");
    const long = conflictName("x".repeat(MEM_NAME_MAX - 3) + ".md", "device123456");
    expect(long.length).toBe(MEM_NAME_MAX);
    expect(validName(long)).toBe(true);
  });
});

describe("arrivals", () => {
  it("holds another machine's newer write, and never its own echo or an older one", () => {
    expect(acceptMem(ev("p|a.md", { text: "x", sha: sha("a") }), undefined, "d1")).toEqual({ payload: { text: "x", sha: sha("a") }, at: 10, device: "d2" });
    expect(acceptMem(ev("p|a.md", null), undefined, "d1")?.payload).toBeNull();
    expect(acceptMem(ev("p|a.md", null), undefined, "d2")).toBeNull();
    expect(acceptMem({ ...ev("p|a.md", null), stream: "prefs" }, undefined, "d1")).toBeNull();
    expect(acceptMem(ev("p|MEMORY.md", null), undefined, "d1")).toBeNull();
    expect(acceptMem(ev("p|a.md", { text: "x" }), undefined, "d1")).toBeNull();
    expect(acceptMem(ev("p|a.md", null, 10), { at: 11, device: "d0" }, "d1")).toBeNull();
    // A tie goes to the larger device id, the rule every stream shares.
    expect(acceptMem(ev("p|a.md", null, 10, "d2"), { at: 10, device: "d3" }, "d1")).toBeNull();
    expect(acceptMem(ev("p|a.md", null, 10, "d4"), { at: 10, device: "d3" }, "d1")).not.toBeNull();
  });

  it("holds within a cap, a replacement counted once", () => {
    const b = book();
    const big = (n: number) => ({ payload: { text: "x".repeat(n), sha: sha("a") }, at: 1, device: "d2" });
    expect(holdMem(b, "p|a.md", big(HELD_MAX - 10)).held).toBe(true);
    expect(holdMem(b, "p|b.md", big(20)).held).toBe(false);
    expect(holdMem(b, "p|a.md", big(HELD_MAX)).held).toBe(true);
    expect(holdMem(b, "p|b.md", { payload: null, at: 1, device: "d2" }).held).toBe(true);
  });

  it("past the cap lets the oldest carries go first, and never a cloned project's", () => {
    const h = (n: number, at: number) => ({ payload: { text: "x".repeat(n), sha: sha("a") }, at, device: "d2" });
    const b = book({ held: { "far|old.md": h(HELD_MAX / 2, 1), "far|new.md": h(HELD_MAX / 4, 5), "p|mine.md": h(HELD_MAX / 4, 2) } });
    const known = (pid: string) => pid === "p";
    expect(holdMem(b, "p|b.md", h(100, 9), known)).toEqual({ held: true, evicted: ["far|old.md"] });
    expect(Object.keys(b.held).sort()).toEqual(["far|new.md", "p|b.md", "p|mine.md"]);
    expect(holdMem(b, "p|c.md", h(HELD_MAX, 9), known)).toEqual({ held: false, evicted: [] });
    expect("far|new.md" in b.held).toBe(true);
  });

  it("applies what this machine has a checkout for and carries the rest untouched", () => {
    const h = { payload: null, at: 1, device: "d2" };
    const split = mergeMemWire({ "q|b.md": h, "p|a.md": h, "z|c.md": h }, (pid) => pid !== "z");
    expect(split.apply.map(([k]) => k)).toEqual(["p|a.md", "q|b.md"]);
    expect(split.carry).toEqual(["z|c.md"]);
  });
});

describe("memChunks", () => {
  it("keeps each push near its budget and sends an oversize memory alone", () => {
    const e = (n: number) => ({ payload: { text: "x".repeat(n), sha: sha("a") } });
    expect(memChunks([e(200), e(200), e(200)], 1000).map((c) => c.length)).toEqual([2, 1]);
    expect(memChunks([e(5000), e(10)], 1000).map((c) => c.length)).toEqual([1, 1]);
    expect(memChunks([])).toEqual([]);
  });
  it("never puts more events in one push than the server takes", () => {
    const tomb = Array.from({ length: 2000 }, () => ({ payload: null }));
    expect(memChunks(tomb).map((c) => c.length)).toEqual([PUSH_EVENTS, PUSH_EVENTS, 2000 - 2 * PUSH_EVENTS]);
  });
});
