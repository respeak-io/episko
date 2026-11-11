import { describe, expect, it } from "vitest";
import { parsePatch, type DiffFile, type DiffHunk } from "../src/diff";
import {
  agentBrief, anchorOf, canComment, checkTally, clampDrafts, clampViewed, commentableIn, commitsHeading, commitsSince,
  commitTotal, dirStates, draftBrief, expandGap, filesUnder, fileSig, gapAt, isLargeDiff, isViewed, LARGE_ROWS, lastReviewed, liveSides,
  mergeBlock, mergeWarn, place, prFromUrl, rangeArgs, rangeLabel, reviewComments, setViewed, sortChecks, submitBlock,
  threadBrief, threadPin, timeline, treeOrder, treeRows, withDraft, type PrReview, type PrThread, type ReviewDraft,
} from "../src/review";

const patch = (...lines: string[]) => lines.join("\n");

// Two hunks in one file, plus a second file: lines 1-4 and 20-23 of the new side.
const FULL = parsePatch(patch(
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  "+two and a half",
  " three",
  "@@ -18,3 +19,3 @@ function f() {",
  " a",
  "-b",
  "+B",
  " c",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
));

const pr = (o: Partial<PrReview> = {}): PrReview => ({
  available: true, reason: null, number: 7, slug: "o/r", title: "Make it so", url: "https://github.com/o/r/pull/7",
  state: "OPEN", draft: false, author: "ana", body: "", created_at: "2026-10-01T10:00:00Z", updated_at: "",
  base_ref: "main", head_ref: "feat/x", base_oid: "b".repeat(40), head_oid: "c3".padEnd(40, "0"), same_repo: true,
  mergeable: "MERGEABLE", merge_state: "CLEAN", review_decision: null, merge_methods: ["squash", "merge"],
  viewer: "me", checks: [], threads: [], reviews: [], comments: [], commit_count: 3, forced_at: null,
  commits: [
    { oid: "c1".padEnd(40, "0"), headline: "first", author: "ana", at: "2026-10-01T10:00:00Z", parent: null },
    { oid: "c2".padEnd(40, "0"), headline: "second", author: "ana", at: "2026-10-02T10:00:00Z", parent: null },
    { oid: "c3".padEnd(40, "0"), headline: "third", author: "ana", at: "2026-10-03T10:00:00Z", parent: null },
  ],
  ...o,
});

const thread = (o: Partial<PrThread> = {}): PrThread => ({
  id: "T1", resolved: false, outdated: false, path: "src/a.ts", line: 2, start_line: null,
  original_line: 2, original_start_line: null, side: "RIGHT", subject: "LINE",
  comments: [{ id: "C1", db_id: 11, author: "bo", body: "why?", at: "2026-10-02T11:00:00Z", url: "", diff_hunk: "" }],
  ...o,
});

describe("which diff a view asks for", () => {
  const p = pr();
  it("reads the whole PR against its merge base, and a commit against its predecessor", () => {
    expect(rangeArgs(p, { kind: "all" })).toEqual({ headOid: p.head_oid, fromOid: null });
    expect(rangeArgs(p, { kind: "since", from: p.commits[0].oid })).toEqual({ headOid: p.head_oid, fromOid: p.commits[0].oid });
    expect(rangeArgs(p, { kind: "commit", oid: p.commits[1].oid })).toEqual({ headOid: p.commits[1].oid, fromOid: p.commits[0].oid });
    // The first commit has no predecessor in the PR: three-dot against the base is its diff.
    expect(rangeArgs(p, { kind: "commit", oid: p.commits[0].oid })).toEqual({ headOid: p.commits[0].oid, fromOid: null });
  });

  it("only lets a side take a comment where its numbers are GitHub's", () => {
    expect([...liveSides(p, { kind: "all" })].sort()).toEqual(["LEFT", "RIGHT"]);
    expect([...liveSides(p, { kind: "since", from: p.commits[0].oid })]).toEqual(["RIGHT"]);
    expect([...liveSides(p, { kind: "commit", oid: p.head_oid })]).toEqual(["RIGHT"]);
    expect(liveSides(p, { kind: "commit", oid: p.commits[0].oid }).size).toBe(0);
  });

  it("finds the head your last review saw, and only when the PR has moved on", () => {
    const rev = (author: string, commit: string, at: string, state = "COMMENTED") => ({ author, commit, at, state, body: "" });
    expect(lastReviewed(pr())).toBeNull();
    const p2 = pr({ reviews: [rev("me", "c1".padEnd(40, "0"), "2026-10-01T12:00:00Z"), rev("me", "c2".padEnd(40, "0"), "2026-10-02T12:00:00Z"), rev("bo", "c3".padEnd(40, "0"), "2026-10-03T12:00:00Z")] });
    expect(lastReviewed(p2)).toBe("c2".padEnd(40, "0"));
    expect(commitsSince(p2, "c2".padEnd(40, "0"))).toBe(1);
    expect(commitsSince(p2, "dead".padEnd(40, "0"))).toBeNull();
    expect(lastReviewed(pr({ reviews: [rev("me", p2.head_oid, "2026-10-03T12:00:00Z")] }))).toBeNull();
    // A pending review of your own has not been seen by anybody, you included.
    expect(lastReviewed(pr({ reviews: [rev("me", "c1".padEnd(40, "0"), "", "PENDING")] }))).toBeNull();
  });

  it("diffs a commit against its own parent, and the commit before it when GitHub sent none", () => {
    const withParents = pr({ commits: p.commits.map((c, i) => ({ ...c, parent: `p${i}`.padEnd(40, "0") })) });
    expect(rangeArgs(withParents, { kind: "commit", oid: p.commits[0].oid }).fromOid).toBe("p0".padEnd(40, "0"));
    expect(rangeArgs(withParents, { kind: "commit", oid: p.commits[2].oid }).fromOid).toBe("p2".padEnd(40, "0"));
    expect(rangeArgs(p, { kind: "commit", oid: p.commits[2].oid }).fromOid).toBe(p.commits[1].oid);
  });

  it("counts past a partial commit list rather than calling the branch rewritten", () => {
    const windowed = pr({ commit_count: 162 });
    expect(commitsSince(windowed, "c2".padEnd(40, "0"))).toBe(1);
    expect(commitsSince(windowed, "old".padEnd(40, "0"))).toEqual({ atLeast: 3 });
    expect(commitsSince(pr(), "old".padEnd(40, "0"))).toBeNull();
  });

  it("calls a reviewed head missing from a partial list rewritten when a force-push followed the review", () => {
    const old = "old".padEnd(40, "0");
    const reviewed = (forced_at: string | null) => pr({ commit_count: 162, forced_at,
      reviews: [{ author: "me", commit: old, at: "2026-10-05T12:00:00Z", state: "COMMENTED", body: "" }] });
    expect(commitsSince(reviewed("2026-10-06T09:00:00Z"), old)).toBeNull();
    expect(commitsSince(reviewed("2026-10-04T09:00:00Z"), old)).toEqual({ atLeast: 3 });
    expect(commitsSince(reviewed(null), old)).toEqual({ atLeast: 3 });
    // A head no review of yours saw cannot be dated against the push, so the push wins.
    expect(commitsSince(reviewed("2026-10-04T09:00:00Z"), "other".padEnd(40, "0"))).toBeNull();
  });

  it("numbers a commit in the whole pull request, and says when the list is only the latest", () => {
    const windowed = pr({ commit_count: 162 });
    expect(rangeLabel(windowed, { kind: "commit", oid: p.commits[0].oid })).toBe("Commit 160 of 162");
    expect(rangeLabel(windowed, { kind: "commit", oid: p.commits[2].oid })).toBe("Commit 162 of 162");
    expect(rangeLabel(p, { kind: "commit", oid: p.commits[1].oid })).toBe("Commit 2 of 3");
    expect(rangeLabel(p, { kind: "commit", oid: "gone" })).toBe("One commit");
    expect(rangeLabel(p, { kind: "all" })).toBe("All changes");
    expect(rangeLabel(p, { kind: "since", from: p.commits[0].oid })).toBe("Since your review");
    expect(commitsHeading(windowed)).toBe("One commit · latest 3 of 162");
    expect(commitsHeading(p)).toBe("One commit");
    // A count GitHub did not send never claims fewer commits than the list holds.
    expect(commitTotal(pr({ commit_count: 0 }))).toBe(3);
  });
});

describe("how much a view draws at once", () => {
  const file = (rows: number): DiffFile => ({
    path: `f${rows}.ts`, oldPath: null, status: "modified", binary: false, large: null, added: rows, removed: 0,
    hunks: [{ at: "@@ -1 +1 @@", header: "", lines: Array.from({ length: rows }, (_, i) => ({ kind: "add" as const, text: "x", oldNo: null, newNo: i + 1 })) }],
  });
  it("is large only past LARGE_ROWS rows, counted across every file", () => {
    expect(isLargeDiff(FULL)).toBe(false);
    expect(isLargeDiff([file(LARGE_ROWS)])).toBe(false);
    expect(isLargeDiff([file(LARGE_ROWS + 1)])).toBe(true);
    expect(isLargeDiff([file(LARGE_ROWS / 2), file(LARGE_ROWS / 2 + 1)])).toBe(true);
    expect(isLargeDiff([])).toBe(false);
  });
});

describe("where a comment may go", () => {
  const c = commentableIn(FULL);
  it("anchors a deletion on the old side and everything else on the new", () => {
    const [ctx, del, add] = FULL[0].hunks[0].lines;
    expect(anchorOf(ctx)).toEqual({ side: "RIGHT", line: 1 });
    expect(anchorOf(del)).toEqual({ side: "LEFT", line: 2 });
    expect(anchorOf(add)).toEqual({ side: "RIGHT", line: 2 });
  });

  it("takes a line or a range inside one hunk, and refuses one GitHub would 422", () => {
    expect(canComment(c, "src/a.ts", "RIGHT", 3)).toBe(true);
    expect(canComment(c, "src/a.ts", "RIGHT", 1, 4)).toBe(true);
    expect(canComment(c, "src/a.ts", "RIGHT", 4, 1)).toBe(true);
    expect(canComment(c, "src/a.ts", "RIGHT", 10)).toBe(false); // between the hunks
    expect(canComment(c, "src/a.ts", "RIGHT", 3, 20)).toBe(false); // across two hunks
    expect(canComment(c, "src/a.ts", "LEFT", 19)).toBe(true);
    expect(canComment(c, "nope.ts", "RIGHT", 1)).toBe(false);
  });
});

describe("placing threads and drafts", () => {
  const all = new Set(["LEFT", "RIGHT"] as const);
  it("hangs a thread off its row, a file comment at the file's head, and the rest aside", () => {
    const ts = [thread(), thread({ id: "F", subject: "FILE", line: null }), thread({ id: "O", outdated: true }), thread({ id: "X", path: "gone.ts" })]
      .map(threadPin);
    const p = place(ts, FULL, all);
    expect(p.at.get("src/a.ts\u0000RIGHT\u00002")?.map((t) => t.id)).toEqual(["T1"]);
    expect(p.loose.get("src/a.ts")?.map((t) => t.id)).toEqual(["F", "O"]);
    expect(p.elsewhere.map((t) => t.id)).toEqual(["X"]);
  });

  it("finds an old-side pin on a context row, which is drawn under its new number", () => {
    // Old line 18 is context `a`, new line 19.
    const p = place([threadPin(thread({ side: "LEFT", line: 18 }))], FULL, all);
    expect([...p.at.keys()]).toEqual(["src/a.ts\u0000RIGHT\u000019"]);
  });

  it("keeps a pin off a side whose numbers this view does not share", () => {
    const p = place([threadPin(thread({ side: "LEFT", line: 2 }))], FULL, new Set(["RIGHT"] as const));
    expect(p.at.size).toBe(0);
    expect(p.loose.get("src/a.ts")).toHaveLength(1);
  });

  it("places alike on a second pass, and on a file with context revealed", () => {
    const pins = [threadPin(thread()), threadPin(thread({ id: "R", path: "README.md", line: 1 }))];
    const once = place(pins, FULL, all);
    expect(place(pins, FULL, all)).toEqual(once);
    expect([...once.at.keys()]).toEqual(["src/a.ts\u0000RIGHT\u00002", "README.md\u0000RIGHT\u00001"]);
    // Line 16 is only drawn once the gap above the second hunk is opened.
    const at16 = [threadPin(thread({ line: 16 }))];
    expect(place(at16, FULL, all).loose.get("src/a.ts")).toHaveLength(1);
    const head = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n");
    const opened = [expandGap(FULL[0], 1, head, 3), FULL[1]];
    expect([...place(at16, opened, all).at.keys()]).toEqual(["src/a.ts\u0000RIGHT\u000016"]);
  });
});

describe("the pending review", () => {
  const d: ReviewDraft = {
    body: "", at: 5, comments: [
      { id: "a", path: "src/a.ts", side: "RIGHT", line: 4, start: 2, body: "range", at: 1 },
      { id: "b", path: "src/a.ts", side: "LEFT", line: 2, start: null, body: "one", at: 2 },
      { id: "c", path: "README.md", side: null, line: null, start: null, body: "file", at: 3 },
    ],
  };

  it("sends a range only when it is one, and never a side on a file comment", () => {
    expect(reviewComments(d)).toEqual([
      { path: "src/a.ts", body: "range", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT" },
      { path: "src/a.ts", body: "one", line: 2, side: "LEFT", start_line: null, start_side: null },
      { path: "README.md", body: "file", line: null, side: null, start_line: null, start_side: null },
    ]);
  });

  it("survives what a crash or a hand edit leaves in storage", () => {
    expect(clampDrafts(null)).toEqual({});
    expect(clampDrafts([])).toEqual({});
    expect(clampDrafts({ k: "x" })).toEqual({});
    const got = clampDrafts({ k: { body: 3, at: "no", comments: [{ id: "a", path: "p", body: " " }, { id: "b", path: "p", body: "ok", line: 4 }, null] } });
    // A line with no side cannot be sent, so it becomes a file comment rather than a 422.
    expect(got).toEqual({ k: { body: "", at: 0, comments: [{ id: "b", path: "p", body: "ok", at: 0, line: null, side: null, start: null }] } });
  });

  it("drops an empty draft instead of keeping it, and caps the store", () => {
    expect(withDraft({ k: d }, "k", { body: " ", comments: [], at: 9 })).toEqual({});
    let s = {};
    for (let i = 0; i < 45; i++) s = withDraft(s, `k${i}`, { body: "x", comments: [], at: i });
    expect(Object.keys(s)).toHaveLength(40);
    expect(s).not.toHaveProperty("k0");
    expect(s).toHaveProperty("k44");
  });

  it("says why a review cannot be sent", () => {
    expect(submitBlock(undefined, "COMMENT", pr())).toMatch(/Write/);
    expect(submitBlock(undefined, "APPROVE", pr())).toBeNull();
    expect(submitBlock(undefined, "REQUEST_CHANGES", pr())).toMatch(/what needs/);
    expect(submitBlock(d, "APPROVE", pr({ author: "me" }))).toMatch(/your own/);
    expect(submitBlock(d, "COMMENT", pr({ state: "MERGED" }))).toMatch(/merged/);
  });
});

describe("viewed", () => {
  it("is undone by a change to the file, and by nothing else", () => {
    const [a, readme] = FULL;
    let s = setViewed({}, "o/r#7", [a], true, 1);
    expect(isViewed(s, "o/r#7", a)).toBe(true);
    expect(isViewed(s, "o/r#7", readme)).toBe(false);
    const pushed = parsePatch(patch("diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-one", "+ONE"))[0];
    expect(fileSig(pushed)).not.toBe(fileSig(a));
    expect(isViewed(s, "o/r#7", pushed)).toBe(false);
    s = setViewed(s, "o/r#7", [a], false, 2);
    expect(s).toEqual({});
    expect(clampViewed({ k: { at: 1, files: { p: "ab", q: 3 } }, j: { files: [] } })).toEqual({ k: { at: 1, files: { p: "ab" } } });
  });

  it("takes a whole folder's files in one tick, and clears them as one", () => {
    const [a, readme] = FULL;
    let s = setViewed({}, "o/r#7", [a, readme], true, 1);
    expect(isViewed(s, "o/r#7", a) && isViewed(s, "o/r#7", readme)).toBe(true);
    s = setViewed(s, "o/r#7", [a], false, 2);
    expect(isViewed(s, "o/r#7", a)).toBe(false);
    expect(isViewed(s, "o/r#7", readme)).toBe(true);
    expect(setViewed(s, "o/r#7", [readme], false, 3)).toEqual({});
  });

  it("never hashes a file nobody ticked, and hashes each file once", () => {
    const trap = { ...FULL[1], get hunks(): DiffHunk[] { throw new Error("hashed"); } } as DiffFile;
    expect(isViewed({}, "o/r#7", trap)).toBe(false);
    expect(isViewed({ "o/r#7": { at: 1, files: { "src/a.ts": "x" } } }, "o/r#7", trap)).toBe(false);
    expect(() => isViewed({ "o/r#7": { at: 1, files: { "README.md": "x" } } }, "o/r#7", trap)).toThrow("hashed");
    const [a] = FULL;
    expect(fileSig(a)).toBe(fileSig(a));
    expect(fileSig(expandGap(a, 1, Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n"), 3))).not.toBe(fileSig(a));
  });

  it("signs a file the review's cap left out by its blob ids, and afresh once it loads whole", () => {
    const stub = (index: string, counts: string) => parsePatch(patch(
      "diff --git a/b.py b/b.py", index, "--- a/b.py", "+++ b/b.py", `Diff not loaded: ${counts}`))[0];
    const cut = stub("index 3333333..4444444 100644", "+120 -7");
    expect(fileSig(stub("index 3333333..4444444 100644", "+120 -7"))).toBe(fileSig(cut));
    expect(fileSig(stub("index 3333333..5555555 100644", "+121 -7"))).not.toBe(fileSig(cut));
    const whole = parsePatch(patch(
      "diff --git a/b.py b/b.py", "index 3333333..4444444 100644", "--- a/b.py", "+++ b/b.py", "@@ -1 +1 @@", "-x", "+y"))[0];
    expect(fileSig(whole)).not.toBe(fileSig(cut));
  });
});

describe("the file tree", () => {
  const paths = ["src/b.ts", "README.md", "src/lib/deep/x.ts", "src/a.ts", "docs/review.md", "src/lib/deep/y.ts"];
  it("draws a folder's files before its folders and folds a single-folder chain", () => {
    expect(treeRows(paths).map((r) => (r.kind === "dir" ? `${"  ".repeat(r.depth)}${r.name}/` : `${"  ".repeat(r.depth)}${paths[r.index]}`))).toEqual([
      "README.md",
      "docs/",
      "  docs/review.md",
      "src/",
      "  src/a.ts",
      "  src/b.ts",
      "  lib/deep/",
      "    src/lib/deep/x.ts",
      "    src/lib/deep/y.ts",
    ]);
  });

  it("hides a folded folder's rows and keeps the folder", () => {
    const rows = treeRows(paths, new Set(["src"]));
    expect(rows.filter((r) => r.kind === "dir").map((r) => r.kind === "dir" && r.path)).toEqual(["docs", "src"]);
    expect(rows).toHaveLength(4);
  });

  it("orders the stream as the tree does, so both lists read top to bottom alike", () => {
    expect(treeOrder(paths.map((path) => ({ path }))).map((f) => f.path))
      .toEqual(["README.md", "docs/review.md", "src/a.ts", "src/b.ts", "src/lib/deep/x.ts", "src/lib/deep/y.ts"]);
  });

  it("finds a folder's whole subtree, and not a sibling that merely starts the same", () => {
    const named = (dir: string, of: string[]) => filesUnder(of, dir).map((i) => of[i]);
    expect(named("src", paths)).toEqual(["src/b.ts", "src/lib/deep/x.ts", "src/a.ts", "src/lib/deep/y.ts"]);
    expect(named("src/lib/deep", paths)).toEqual(["src/lib/deep/x.ts", "src/lib/deep/y.ts"]);
    expect(named("src/lib", ["src/lib/a.ts", "src/library/b.ts", "src/lib.ts"])).toEqual(["src/lib/a.ts"]);
  });

  it("gives every folder row a state over its subtree, shut or not", () => {
    const on = new Set(["src/lib/deep/x.ts", "src/lib/deep/y.ts", "docs/review.md"]);
    const st = dirStates(paths, (i) => on.has(paths[i]));
    expect(st.get("docs")).toBe("all");
    expect(st.get("src")).toBe("some");
    expect(st.get("src/lib/deep")).toBe("all");
    expect(dirStates(paths, () => false).get("src")).toBe("none");
    // A folded chain's row names the whole chain, and a root file belongs to no folder.
    for (const r of treeRows(paths, new Set(["src"]))) if (r.kind === "dir") expect(st.has(r.path)).toBe(true);
    expect(st.has("")).toBe(false);
  });
});

describe("expanding context", () => {
  const head = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
  // Hunk 2 starts at new line 19 (old 18): sixteen lines hidden between line 4 and it.
  it("measures each gap, the tail included", () => {
    expect(gapAt(FULL[0], 0, 30)).toBe(0);
    expect(gapAt(FULL[0], 1, 30)).toBe(14);
    expect(gapAt(FULL[0], 2, 30)).toBe(9);
  });

  it("reveals lines above a hunk with both numbers right, and below the last", () => {
    const up = expandGap(FULL[0], 1, head, 3);
    expect(up.hunks[1].lines.slice(0, 3)).toEqual([
      { kind: "ctx", text: "L16", oldNo: 15, newNo: 16 },
      { kind: "ctx", text: "L17", oldNo: 16, newNo: 17 },
      { kind: "ctx", text: "L18", oldNo: 17, newNo: 18 },
    ]);
    expect(up.hunks[1].at).toBe("@@ -15 +16 @@");
    expect(gapAt(up, 1, 30)).toBe(11);
    expect(FULL[0].hunks[1].lines[0].text).toBe("a"); // the input is not mutated

    // Closing the gap entirely joins the two hunks, so no empty separator is left between them.
    const shut = expandGap(FULL[0], 1, head, 20);
    expect(shut.hunks).toHaveLength(1);
    expect(shut.hunks[0].lines.map((l) => l.newNo).filter(Boolean)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(gapAt(shut, 1, 30)).toBe(9);

    const down = expandGap(FULL[0], 2, head, 2);
    expect(down.hunks[1].lines.slice(-2)).toEqual([
      { kind: "ctx", text: "L22", oldNo: 21, newNo: 22 },
      { kind: "ctx", text: "L23", oldNo: 22, newNo: 23 },
    ]);
  });
});

describe("the header's facts", () => {
  const ck = (name: string, state: string) => ({ name, state, url: "", workflow: "" });
  it("tallies checks and lists the failures first", () => {
    const cs = [ck("lint", "pass"), ck("e2e", "pending"), ck("build", "fail"), ck("docs", "skip")];
    expect(checkTally(cs)).toEqual({ pass: 1, fail: 1, pending: 1, skip: 1, total: 4 });
    expect(sortChecks(cs).map((c) => c.name)).toEqual(["build", "e2e", "lint", "docs"]);
  });

  it("refuses a merge GitHub would, and warns about one it might", () => {
    expect(mergeBlock(pr())).toBeNull();
    expect(mergeBlock(pr({ draft: true }))).toMatch(/draft/);
    expect(mergeBlock(pr({ mergeable: "CONFLICTING" }))).toMatch(/conflicts/);
    expect(mergeBlock(pr({ state: "MERGED" }))).toMatch(/merged/);
    expect(mergeWarn(pr())).toBeNull();
    expect(mergeWarn(pr({ checks: [ck("x", "fail")] }))).toMatch(/1 check failed/);
    expect(mergeWarn(pr({ merge_state: "BLOCKED" }))).toMatch(/rules/);
  });

  it("interleaves the conversation by time", () => {
    const t = timeline(pr({ comments: [{ who: "bo", at: "2026-10-01T11:00:00Z", body: "hi" }] }));
    expect(t.map((i) => i.kind)).toEqual(["commit", "comment", "commit", "commit"]);
  });
});

describe("the brief an agent is handed", () => {
  it("says where each point is and what was said, in order", () => {
    const text = agentBrief(pr(), [
      threadBrief(thread({ start_line: 1, line: 3 })),
      draftBrief({ id: "d", path: "README.md", side: null, line: null, start: null, body: "rename it", at: 0 }),
    ]);
    expect(text).toContain("PR #7 \"Make it so\" (branch feat/x)");
    expect(text).toContain("1. src/a.ts:1-3\n   bo: why?");
    expect(text).toContain("2. README.md (the whole file)\n   rename it");
    expect(text).toMatch(/Don't push/);
  });

  it("points an outdated thread at the line it was written against", () => {
    const b = threadBrief(thread({ outdated: true, line: null, original_line: 9 }));
    expect(b.line).toBe(9);
  });
});

describe("prFromUrl", () => {
  it("reads the repo and number off any tab of a pull request", () => {
    expect(prFromUrl("https://github.com/respeak-io/pii-reduction/pull/390")).toEqual({ slug: "respeak-io/pii-reduction", number: 390 });
    expect(prFromUrl("https://github.com/o/r/pull/7/files#diff-abc")).toEqual({ slug: "o/r", number: 7 });
    expect(prFromUrl("http://www.github.com/o/r.js/pull/12?w=1")).toEqual({ slug: "o/r.js", number: 12 });
  });
  it("is null for anything that is not a github.com pull request", () => {
    expect(prFromUrl("https://github.com/o/r/issues/7")).toBeNull();
    expect(prFromUrl("https://github.com/o/r/pull/7x")).toBeNull();
    expect(prFromUrl("https://github.com/o/r/pull/0")).toBeNull();
    expect(prFromUrl("https://github.example.com/o/r/pull/7")).toBeNull();
    expect(prFromUrl("https://evil.com/github.com/o/r/pull/7")).toBeNull();
  });
});
