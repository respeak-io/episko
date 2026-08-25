import { describe, it, expect } from "vitest";
import { alignHunk, parsePatch, tokenize, wordDiff, type DiffHunk, type DiffLine, type Span } from "../src/diff";

// Patches are built from real `git` output shapes. Lines are joined rather than
// written as template literals because diff bodies contain backticks and ${…}.
const patch = (...lines: string[]) => lines.join("\n");

describe("parsePatch", () => {
  it("returns [] for an empty or contentless patch", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch("\n\n")).toEqual([]);
    expect(parsePatch("not a diff at all")).toEqual([]);
  });

  it("parses a modified file: counts, hunk, and per-line numbers", () => {
    const [f] = parsePatch(patch(
      "diff --git a/tracked.txt b/tracked.txt",
      "index 83db48f..e0c9b5e 100644",
      "--- a/tracked.txt",
      "+++ b/tracked.txt",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+CHANGED",
      " line3",
      "+line4",
    ));
    expect(f.status).toBe("modified");
    expect(f.path).toBe("tracked.txt");
    expect(f.oldPath).toBe("tracked.txt");
    expect(f.binary).toBe(false);
    expect([f.added, f.removed]).toEqual([2, 1]);
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0].lines).toEqual([
      { kind: "ctx", text: "line1", oldNo: 1, newNo: 1 },
      { kind: "del", text: "line2", oldNo: 2, newNo: null },
      { kind: "add", text: "CHANGED", oldNo: null, newNo: 2 },
      { kind: "ctx", text: "line3", oldNo: 3, newNo: 3 },
      { kind: "add", text: "line4", oldNo: null, newNo: 4 },
    ]);
  });

  it("parses an added file (path from +++, oldPath stays null) and keeps blank added lines", () => {
    const [f] = parsePatch(patch(
      "diff --git a/GUIDE.md b/GUIDE.md",
      "new file mode 100644",
      "index 0000000..f4a5322",
      "--- /dev/null",
      "+++ b/GUIDE.md",
      "@@ -0,0 +1,3 @@",
      "+# demo",
      "+",
      "+A small helper library.",
    ));
    expect(f.status).toBe("added");
    expect(f.path).toBe("GUIDE.md");
    expect(f.oldPath).toBeNull();
    expect([f.added, f.removed]).toEqual([3, 0]);
    expect(f.hunks[0].lines[1]).toEqual({ kind: "add", text: "", oldNo: null, newNo: 2 });
  });

  it("parses a deleted file (+++ is /dev/null, so path comes from the header)", () => {
    const [f] = parsePatch(patch(
      "diff --git a/README.md b/README.md",
      "deleted file mode 100644",
      "index 6d4d468..0000000",
      "--- a/README.md",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-# demo",
      "-old readme",
    ));
    expect(f.status).toBe("deleted");
    expect(f.path).toBe("README.md");
    expect(f.oldPath).toBe("README.md");
    expect([f.added, f.removed]).toEqual([0, 2]);
  });

  it("handles paths with spaces and git's trailing-tab termination (untracked via --no-index)", () => {
    const [f] = parsePatch(patch(
      "diff --git a/weird näme.txt b/weird näme.txt",
      "new file mode 100644",
      "index 0000000..26ff09d",
      "--- /dev/null",
      "+++ b/weird näme.txt\t", // git appends a tab when the path has spaces
      "@@ -0,0 +1 @@",
      '+a "quoted" line',
    ));
    expect(f.status).toBe("added");
    expect(f.path).toBe("weird näme.txt");
    expect(f.added).toBe(1);
    // single-line hunk header (no ,count) still yields correct line numbers
    expect(f.hunks[0].lines[0]).toEqual({ kind: "add", text: 'a "quoted" line', oldNo: null, newNo: 1 });
  });

  it("marks binary files and gives them no hunks", () => {
    const [f] = parsePatch(patch(
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "index 0000000..6164d9f",
      "Binary files /dev/null and b/bin.dat differ",
    ));
    expect(f.status).toBe("added");
    expect(f.binary).toBe(true);
    expect(f.path).toBe("bin.dat");
    expect(f.hunks).toHaveLength(0);
    expect([f.added, f.removed]).toEqual([0, 0]);
  });

  it("parses a pure rename (100% similarity, no ---/+++ or hunks)", () => {
    const [f] = parsePatch(patch(
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
    ));
    expect(f.status).toBe("renamed");
    expect(f.path).toBe("new.txt");
    expect(f.oldPath).toBe("old.txt");
    expect(f.hunks).toHaveLength(0);
  });

  it("parses a rename with content changes (rename headers + a hunk)", () => {
    const [f] = parsePatch(patch(
      "diff --git a/old.txt b/new.txt",
      "similarity index 60%",
      "rename from old.txt",
      "rename to new.txt",
      "index 1111111..2222222 100644",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1,4 +1,5 @@",
      " aaaa",
      "-bbbb",
      "+CHANGED",
      " cccc",
      " dddd",
      "+eeee",
    ));
    expect(f.status).toBe("renamed");
    expect(f.path).toBe("new.txt");
    expect(f.oldPath).toBe("old.txt");
    expect([f.added, f.removed]).toEqual([2, 1]);
  });

  it("strips only the leading a//b/ prefix, so real paths under a dir named 'a' survive", () => {
    const [f] = parsePatch(patch(
      "diff --git a/a/weird.js b/a/weird.js",
      "index 1111111..2222222 100644",
      "--- a/a/weird.js",
      "+++ b/a/weird.js",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ));
    expect(f.path).toBe("a/weird.js");
    expect(f.oldPath).toBe("a/weird.js");
  });

  it("resets line numbers per hunk from each @@ header", () => {
    const [f] = parsePatch(patch(
      "diff --git a/multi.txt b/multi.txt",
      "index 1111111..2222222 100644",
      "--- a/multi.txt",
      "+++ b/multi.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -10,2 +10,3 @@ fn context()",
      " j",
      "+K",
      " l",
    ));
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[1].header).toBe("fn context()"); // trailing @@ context is captured
    expect(f.hunks[1].lines[0]).toEqual({ kind: "ctx", text: "j", oldNo: 10, newNo: 10 });
    expect(f.hunks[1].lines[1]).toEqual({ kind: "add", text: "K", oldNo: null, newNo: 11 });
    expect(f.hunks[1].lines[2]).toEqual({ kind: "ctx", text: "l", oldNo: 11, newNo: 12 });
  });

  it("ignores the '\\ No newline at end of file' marker without counting it", () => {
    const [f] = parsePatch(patch(
      "diff --git a/nonl.txt b/nonl.txt",
      "index 1111111..2222222 100644",
      "--- a/nonl.txt",
      "+++ b/nonl.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ));
    expect([f.added, f.removed]).toEqual([1, 1]);
    expect(f.hunks[0].lines).toHaveLength(2); // the two "\ No newline" lines dropped
  });

  it("splits a combined multi-file patch into ordered per-file records", () => {
    const files = parsePatch(patch(
      "diff --git a/GUIDE.md b/GUIDE.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/GUIDE.md",
      "@@ -0,0 +1 @@",
      "+hi",
      "diff --git a/README.md b/README.md",
      "deleted file mode 100644",
      "--- a/README.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/src/x.js b/src/x.js",
      "index 1111111..2222222 100644",
      "--- a/src/x.js",
      "+++ b/src/x.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ));
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["GUIDE.md", "added"],
      ["README.md", "deleted"],
      ["src/x.js", "modified"],
    ]);
  });
});

// ---------- what a reader gets: the word diff and the line pairing ----------
//
// These are the two judgement calls in the module, and both fail *quietly*: a bad
// pairing hangs a mark on the wrong line, and a bad threshold either lights a rewritten
// line up like confetti or marks nothing at all. Neither throws and neither is visible
// in a screenshot of a diff you don't already know the answer to.

const line = (kind: "ctx" | "add" | "del", text: string): DiffLine =>
  ({ kind, text, oldNo: kind === "add" ? null : 1, newNo: kind === "del" ? null : 1 });
const hunk = (...lines: DiffLine[]): DiffHunk => ({ header: "", lines });
/// The marked text of one side, which is what the reader actually sees.
const marks = (spans: Span[] | null) => (spans ?? []).filter((s) => s.changed).map((s) => s.text);

describe("tokenize", () => {
  it("keeps identifiers whole and every other character apart", () => {
    expect(tokenize("a.foo($x, 1)")).toEqual(["a", ".", "foo", "(", "$x", ",", " ", "1", ")"]);
  });
  it("runs of whitespace are one token, so indentation is never marked piecemeal", () => {
    expect(tokenize("    if (x)")).toEqual(["    ", "if", " ", "(", "x", ")"]);
  });
  it("has no tokens for an empty line", () => expect(tokenize("")).toEqual([]));
});

describe("wordDiff", () => {
  it("marks only what moved, on both sides", () => {
    const w = wordDiff("const a = one(x);", "const a = two(x);")!;
    expect(marks(w.a)).toEqual(["one"]);
    expect(marks(w.b)).toEqual(["two"]);
  });

  it("marks an insertion in the middle without touching the shared ends", () => {
    const w = wordDiff('const L = ["a", "b"];', 'const L = ["a", "mid", "b"];')!;
    expect(marks(w.a)).toEqual([]);
    expect(marks(w.b).join("")).toContain("mid");
    // the unchanged spans are the whole line minus the insertion, not a scattering
    expect(w.b.filter((s) => !s.changed).map((s) => s.text).join("")).toBe('const L = ["a", "b"];');
  });

  it("returns null when there is nothing to say", () => {
    expect(wordDiff("same", "same")).toBeNull();
    expect(wordDiff("", "x")).toBeNull();
    expect(wordDiff("x", "")).toBeNull();
  });

  it("refuses a rewritten line rather than lighting nine fragments of it", () => {
    // Two prose lines that share only articles. Positional pairing puts them together
    // and the reader gets no help from `the`, `is` and `a` being highlighted — this is
    // the shape that made the first cut of the feature unreadable.
    expect(wordDiff(
      "// Which window the inspector's read/written total covers. `run` is the figure",
      "// Whether the panel is open — and, when it is, a `Date.now()` it opened at",
    )).toBeNull();
  });

  it("absorbs a short gap between two changes instead of leaving confetti", () => {
    // `foo` and `x` change with `(` between them: three marks would be two too many.
    const w = wordDiff("a.foo(x);", "a.bar(y);")!;
    expect(marks(w.b)).toEqual(["bar(y"]);
  });

  it("still marks a long line whose ends match", () => {
    const pad = "x".repeat(80);
    const w = wordDiff(`${pad} one ${pad}`, `${pad} two ${pad}`)!;
    expect(marks(w.a)).toEqual(["one"]);
  });

  it("a span list always reassembles into the line it came from", () => {
    const a = "  return s < 60 ? `${s}s` : `${m}m`;", b = "  return s < 90 ? `${s}s` : `${m}m`;";
    const w = wordDiff(a, b)!;
    expect(w.a.map((s) => s.text).join("")).toBe(a);
    expect(w.b.map((s) => s.text).join("")).toBe(b);
  });
});

describe("alignHunk", () => {
  it("keeps git's order in the unified list", () => {
    const { unified } = alignHunk(hunk(
      line("ctx", "keep"), line("del", "a"), line("del", "b"), line("add", "A"), line("add", "B"),
    ));
    expect(unified.map((c) => [c.line.kind, c.line.text]))
      .toEqual([["ctx", "keep"], ["del", "a"], ["del", "b"], ["add", "A"], ["add", "B"]]);
  });

  it("puts a context line on both sides of one row", () => {
    const { rows } = alignHunk(hunk(line("ctx", "keep")));
    expect(rows).toHaveLength(1);
    expect(rows[0].left).toBe(rows[0].right); // one cell, so the two halves cannot drift
  });

  it("leaves the overhang of an uneven replacement one-sided", () => {
    const { rows } = alignHunk(hunk(line("del", "gone"), line("add", "new one"), line("add", "new two")));
    expect(rows.map((r) => [r.left?.line.text ?? null, r.right?.line.text ?? null]))
      .toContainEqual([null, "new two"]);
    expect(rows).toHaveLength(2);
  });

  it("pairs a changed line with its real counterpart, not with the comment added above it", () => {
    // The single most common shape an agent's edit has, and the one positional pairing
    // gets wrong: the changed line is the LAST addition, not the first.
    const { rows, unified } = alignHunk(hunk(
      line("del", "const L = [\"a\", \"b\"];"),
      line("add", "// why this list is what it is"),
      line("add", "// and a second line about it"),
      line("add", "const L = [\"a\", \"mid\", \"b\"];"),
    ));
    const paired = rows.find((r) => r.left && r.right)!;
    expect(paired.left!.line.text).toContain("const L");
    expect(paired.right!.line.text).toContain("mid");
    // the two comment lines get a blank left half rather than a bogus partner
    expect(rows.filter((r) => !r.left)).toHaveLength(2);
    // and the marks reached the unified list too — both renderings share one cell
    const u = unified.find((c) => c.line.text.includes("mid"))!;
    expect(marks(u.spans).join("")).toContain("mid");
  });

  it("marks nothing when a replacement has no partner at all", () => {
    const { rows, unified } = alignHunk(hunk(line("add", "brand new line")));
    expect(rows).toEqual([{ left: null, right: unified[0] }]);
    expect(unified[0].spans).toBeNull();
  });

  it("pairs positionally once a replacement is too big to be worth aligning", () => {
    // Over the run cap this falls back rather than running a 200x200 table; the fallback
    // must still produce one row per line and lose nothing.
    const dels = Array.from({ length: 70 }, (_, i) => line("del", `old ${i}`));
    const adds = Array.from({ length: 70 }, (_, i) => line("add", `new ${i}`));
    const { rows, unified } = alignHunk(hunk(...dels, ...adds));
    expect(rows).toHaveLength(70);
    expect(unified).toHaveLength(140);
    expect(rows[0].left!.line.text).toBe("old 0");
    expect(rows[0].right!.line.text).toBe("new 0");
  });

  it("survives a hunk of nothing but context", () => {
    const { rows, unified } = alignHunk(hunk(line("ctx", "a"), line("ctx", "b")));
    expect(rows).toHaveLength(2);
    expect(unified.every((c) => c.spans === null)).toBe(true);
  });
});
