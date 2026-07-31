import { describe, it, expect } from "vitest";
import {
  chipText, GRAPH_COLORS, graphWidth, laneColor, laneX, layoutGraph, lineRef, lineTip,
  mergeBranchName, parseRefs, refChips, refChipsHtml, rowSvg, shortRef, shortRel,
  type GraphCommit,
} from "../src/graph";

// A commit as git_graph hands it over. Only sha/parents shape the graph, so the rest
// is filled in once and ignored — every test here is about lanes or about refs.
const c = (sha: string, parents: string[] = [], refs = "", subject = ""): GraphCommit => ({
  sha, short: sha.slice(0, 7), parents, refs,
  subject: subject || `subject ${sha}`, author: "T", unix: 1700000000, rel: "1 day ago",
});
/** The lanes a row's segments touch, as a compact shape to assert against. */
const shape = (r: ReturnType<typeof layoutGraph>["rows"][number]) => ({
  lane: r.lane,
  above: r.above.map((l) => l.lane),
  below: r.below.map((l) => l.lane),
  through: r.through.map((l) => l.lane),
});

describe("layoutGraph", () => {
  it("has nothing to draw for an empty page", () => {
    expect(layoutGraph([])).toEqual({ rows: [], lanes: 0 });
  });

  it("keeps a linear history in one lane, one colour", () => {
    const l = layoutGraph([c("a", ["b"]), c("b", ["d"]), c("d")]);
    expect(l.lanes).toBe(1);
    expect(l.rows.map(shape)).toEqual([
      { lane: 0, above: [], below: [0], through: [] },      // tip: opens the lane
      { lane: 0, above: [0], below: [0], through: [] },
      { lane: 0, above: [0], below: [], through: [] },      // root: closes it
    ]);
    expect(new Set(l.rows.map((r) => r.line)).size).toBe(1);
  });

  it("forks a lane at a merge and folds it back in at the branch point", () => {
    //  m ── merge of (main, side); both sides land on base
    const l = layoutGraph([
      c("m", ["main1", "side1"]),
      c("main1", ["base"]),
      c("side1", ["base"]),
      c("base"),
    ]);
    expect(l.lanes).toBe(2);
    expect(l.rows.map(shape)).toEqual([
      // The merge opens a second lane for its second parent.
      { lane: 0, above: [], below: [0, 1], through: [] },
      // main1 takes lane 0; side1's lane crosses this row untouched.
      { lane: 0, above: [0], below: [0], through: [1] },
      // side1 keeps its own lane down to the shared parent rather than sidestepping
      // into lane 0 here — the two lines converge at `base`, one row lower.
      { lane: 1, above: [1], below: [1], through: [0] },
      // base is that convergence: two lanes were waiting for it, both end here.
      { lane: 0, above: [0, 1], below: [], through: [] },
    ]);
    // A merge's second parent starts a new line, so it gets its own identity (and so
    // its own colour); the first parent inherits, which is what keeps a branch one
    // colour down its whole length.
    expect(l.rows[0].below[0].line).toBe(l.rows[0].line);
    expect(l.rows[0].below[1].line).not.toBe(l.rows[0].line);
    expect(l.rows[2].line).toBe(l.rows[0].below[1].line);
  });

  it("gives every root/tip its own lane and reuses one that closed", () => {
    // Two unrelated histories, the first ending before the second starts.
    const l = layoutGraph([c("a", ["a2"]), c("a2"), c("b", ["b2"]), c("b2")]);
    expect(l.lanes).toBe(1); // lane 0 freed by a2 is reused by b
    expect(l.rows.map((r) => r.lane)).toEqual([0, 0, 0, 0]);
    // But identity (and so colour) follows the LINE, not the lane, so the reuse shows.
    expect(l.rows[2].line).not.toBe(l.rows[0].line);
  });

  it("leaves the frontier's lanes open, so the last rows' lines run off the bottom", () => {
    // `x` is the last loaded commit and its parent is on the next page.
    const l = layoutGraph([c("t", ["x"]), c("x", ["notloaded"])]);
    expect(shape(l.rows[1]).below).toEqual([0]);
    // A parent nobody loaded is not a row, and must not invent one.
    expect(l.rows).toHaveLength(2);
  });

  it("lets two tips with a shared parent run side by side and converge on it", () => {
    // Both `a` and `b` have parent `p`: a opens lane 0, b opens lane 1 (lane 0 is
    // already waiting for p), and p — waited for by both — closes the pair.
    const l = layoutGraph([c("a", ["p"]), c("b", ["p"]), c("p")]);
    expect(l.rows.map(shape)).toEqual([
      { lane: 0, above: [], below: [0], through: [] },
      { lane: 1, above: [], below: [1], through: [0] },
      { lane: 0, above: [0, 1], below: [], through: [] },
    ]);
    expect(l.lanes).toBe(2);
  });
});

describe("parseRefs", () => {
  it("has no chips for an undecorated commit", () => {
    expect(parseRefs("")).toEqual([]);
    expect(parseRefs("  ")).toEqual([]);
  });

  it("types HEAD, branches, remotes and tags from their full paths", () => {
    expect(parseRefs("HEAD -> refs/heads/dev, refs/remotes/origin/main, refs/remotes/origin/dev, tag: refs/tags/v1.2")).toEqual([
      { kind: "head", label: "dev" },
      { kind: "remote", label: "origin/main" },
      { kind: "remote", label: "origin/dev" },
      { kind: "tag", label: "v1.2" },
    ]);
  });

  it("does not mistake a slashed local branch for a remote", () => {
    // The whole reason the backend asks for --decorate=full: `feat/graph` and
    // `origin/main` are the same shape once abbreviated.
    expect(parseRefs("refs/heads/feat/graph, refs/remotes/origin/feat/graph")).toEqual([
      { kind: "branch", label: "feat/graph" },
      { kind: "remote", label: "origin/feat/graph" },
    ]);
  });

  it("shows a detached HEAD as itself", () => {
    expect(parseRefs("HEAD, refs/tags/v9")).toEqual([
      { kind: "head", label: "HEAD" },
      { kind: "tag", label: "v9" },
    ]);
  });

  it("keeps a ref from a namespace it doesn't know rather than dropping it", () => {
    expect(parseRefs("refs/notes/commits")).toEqual([{ kind: "branch", label: "notes/commits" }]);
    expect(shortRef("refs/pull/12/head")).toBe("pull/12/head");
    expect(shortRef("weird")).toBe("weird");
  });
});

describe("line labels", () => {
  it("labels a commit with the NEAREST ref above it on its line, not the topmost", () => {
    // The real shape this gets wrong if you take the topmost: a feature branch's tip is
    // simply the newest commit, sitting on top of dev's own line. Everything below the
    // dev ref belongs to dev — labelling it `feat/x` would be actively misleading.
    const l = layoutGraph([
      c("a", ["b"], "refs/heads/feat/x"),
      c("b", ["d"], "HEAD -> refs/heads/dev"),
      c("d", ["e"]),
      c("e", [], "refs/heads/ancient"),
    ]);
    expect(l.rows.map((r) => r.label?.name)).toEqual(["feat/x", "dev", "dev", "ancient"]);
    expect(l.rows[1].label).toEqual({ name: "dev", from: "ref" });
  });

  it("labels each line separately, and prefers a branch over a tag", () => {
    const l = layoutGraph([
      c("m", ["main1", "side1"]),
      c("main1", ["base"], "refs/heads/main"),
      c("side1", ["base"], "tag: refs/tags/v1, refs/remotes/origin/side"),
      c("base"),
    ]);
    expect(l.rows[1].label?.name).toBe("main");
    // A tag names a moment, a remote branch names a line — so the remote wins.
    expect(l.rows[2].label).toEqual({ name: "origin/side", from: "ref" });
    // The merge above carries no ref and opened no line of its own, so it stays unnamed
    // rather than borrowing a name from below.
    expect(l.rows[0].label).toBeNull();
  });

  it("falls back to the merge subject for a branch that was deleted after merging", () => {
    const l = layoutGraph([
      c("m", ["main1", "side1"], "HEAD -> refs/heads/dev", "Merge pull request #30 from respeak-io/feat/x"),
      c("main1", ["base"]),
      c("side1", ["base"]), // no ref anywhere: the branch is gone
      c("base"),
    ]);
    expect(l.rows[2].label).toEqual({ name: "respeak-io/feat/x", from: "merge" });
    expect(lineTip(l.rows[2])).toContain("merged in as respeak-io/feat/x");
    // …and it is attributed, because a subject is a message and not a ref.
    expect(lineTip(l.rows[2])).toContain("merge's subject");
  });

  it("leaves a line unnamed rather than inventing one, and says so", () => {
    const l = layoutGraph([c("a", ["b"]), c("b")]);
    expect(l.rows.every((r) => r.label === null)).toBe(true);
    expect(lineTip(l.rows[0])).toContain("No branch or tag above this commit");
  });

  it("does not let a tag name the stretch of history below it", () => {
    const l = layoutGraph([
      c("a", ["b"], "HEAD -> refs/heads/dev"),
      c("b", ["d"], "tag: refs/tags/v1.0"),  // a release tag on dev's line
      c("d"),
    ]);
    expect(l.rows.map((r) => r.label?.name)).toEqual(["dev", "dev", "dev"]);
  });

  it("names a merge's source from a ref BELOW it, never one above", () => {
    // The trap: `feat/next` is cut from dev above the merge and shares dev's line, so a
    // "first ref on the line" lookup would report the merge as having taken it in.
    const l = layoutGraph([
      c("tip", ["m"], "refs/heads/feat/next"),
      c("m", ["main1", "side1"], "HEAD -> refs/heads/dev", "Merge pull request #7 from o/hotfix"),
      c("main1", ["base"]),
      c("side1", ["base"], "refs/remotes/origin/hotfix"),
      c("base"),
    ]);
    expect(l.rows[1].merged).toEqual(["origin/hotfix"]);
    expect(l.rows[1].merged).not.toContain("feat/next");
  });

  it("names what a merge took in — the one thing the drawing can't show", () => {
    const l = layoutGraph([
      c("m", ["main1", "side1"], "HEAD -> refs/heads/dev"),
      c("main1", ["base"]),
      c("side1", ["base"], "refs/heads/feature"),
      c("base"),
    ]);
    expect(l.rows[0].merged).toEqual(["feature"]);
    expect(lineTip(l.rows[0])).toBe("On the line leading up to dev · merges feature");
    // A plain commit has one parent, so it never claims to merge anything.
    expect(l.rows[1].merged).toEqual([]);
    expect(lineTip(l.rows[1])).not.toContain("merges");
  });

  it("names a merged-in line from the merge subject when the branch left no ref", () => {
    const l = layoutGraph([
      c("m", ["main1", "side1"], "", "Merge branch 'hotfix/1' into dev"),
      c("main1", ["base"]),
      c("side1", ["base"]),
      c("base"),
    ]);
    expect(l.rows[0].merged).toEqual(["hotfix/1"]);
  });
});

describe("lineRef / mergeBranchName", () => {
  it("ranks HEAD over branch over remote, and never names a line after a tag", () => {
    expect(lineRef(parseRefs("tag: refs/tags/v1, refs/remotes/origin/x, refs/heads/x, HEAD -> refs/heads/dev"))).toBe("dev");
    expect(lineRef(parseRefs("tag: refs/tags/v1, refs/remotes/origin/x, refs/heads/x"))).toBe("x");
    expect(lineRef(parseRefs("tag: refs/tags/v1, refs/remotes/origin/x"))).toBe("origin/x");
    // A tag marks a moment, and a line label propagates downward — "on v0.11.1" for a
    // stretch of history would read as a lineage it never had.
    expect(lineRef(parseRefs("tag: refs/tags/v1"))).toBeNull();
    expect(lineRef([])).toBeNull();
  });

  it("reads git's and GitHub's merge wordings, and nothing else", () => {
    expect(mergeBranchName("Merge branch 'feat/x' into dev")).toBe("feat/x");
    expect(mergeBranchName("Merge branch 'feat/x'")).toBe("feat/x");
    expect(mergeBranchName("Merge remote-tracking branch 'origin/main' into dev")).toBe("origin/main");
    expect(mergeBranchName("Merge pull request #30 from respeak-io/dev")).toBe("respeak-io/dev");
    // Prose names nothing. Guessing a lane name out of it would be worse than blank.
    expect(mergeBranchName("Merge everything, finally")).toBeNull();
    expect(mergeBranchName("fix: not a merge at all")).toBeNull();
  });
});

describe("shortRel", () => {
  it("shortens git's own wordings", () => {
    expect(["3 seconds ago", "12 minutes ago", "17 hours ago", "2 days ago", "3 weeks ago", "5 months ago", "2 years ago"]
      .map(shortRel)).toEqual(["3s", "12m", "17h", "2d", "3w", "5mo", "2y"]);
    expect(shortRel("1 day ago")).toBe("1d"); // singular
    expect(shortRel("1 year, 3 months ago")).toBe("1y"); // leading component wins
  });

  it("returns anything it doesn't recognise untouched", () => {
    // %cr's wording belongs to git, and a date we can't parse must still be shown.
    expect(shortRel("just now")).toBe("just now");
    expect(shortRel("")).toBe("");
    expect(shortRel("in the future somehow")).toBe("in the future somehow");
  });
});

describe("geometry & colour", () => {
  it("spaces lanes evenly and sizes the column to the widest row", () => {
    expect(laneX(0)).toBeLessThan(laneX(1));
    expect(laneX(2) - laneX(1)).toBe(laneX(1) - laneX(0));
    expect(graphWidth(1)).toBeLessThan(graphWidth(3));
    expect(graphWidth(0)).toBeGreaterThan(0); // an empty page still has a column
  });

  it("cycles colours instead of running out", () => {
    expect(laneColor(0)).toBe(GRAPH_COLORS[0]);
    expect(laneColor(GRAPH_COLORS.length)).toBe(GRAPH_COLORS[0]);
    expect(laneColor(GRAPH_COLORS.length * 3 + 2)).toBe(GRAPH_COLORS[2]);
  });
});

describe("refChips", () => {
  const names = (d: string, max?: number) => refChips(d, max).map((c) => c.label);

  it("collapses a local branch and its remote twin into one chip that says it is pushed", () => {
    const [chip, ...rest] = refChips("HEAD -> refs/heads/main, refs/remotes/origin/main");
    expect(chip).toMatchObject({ kind: "head", label: "main", also: ["origin"] });
    expect(rest).toEqual([]);
    expect(chipText(chip)).toBe("main (also on origin)");
    // Several remotes fold into the same chip rather than multiplying it.
    expect(refChips("refs/heads/x, refs/remotes/origin/x, refs/remotes/fork/x")[0].also).toEqual(["origin", "fork"]);
  });

  it("keeps a remote that has no local counterpart, prefix and all", () => {
    // "not checked out here" is the entire difference between the two, so the prefix
    // has to survive.
    expect(names("refs/remotes/origin/feat/next")).toEqual(["origin/feat/next"]);
    expect(names("refs/heads/feat/next, refs/remotes/origin/other")).toEqual(["feat/next", "origin/other"]);
  });

  it("drops origin/HEAD — a symref that always duplicates another chip", () => {
    expect(names("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/remotes/origin/dev"))
      .toEqual(["main", "origin/dev"]);
  });

  it("orders HEAD, then local, then remote, then tags — whatever order git listed", () => {
    // Git's own order is not stable across repos (HEAD can come last), and the leftmost
    // chip is the one that survives a narrow column.
    expect(names("tag: refs/tags/v2, refs/remotes/origin/next, refs/heads/side, HEAD -> refs/heads/dev", 9))
      .toEqual(["dev", "side", "origin/next", "v2"]);
    // And the ordering is what decides who survives the cap: the tag folds, not HEAD.
    expect(names("tag: refs/tags/v2, refs/remotes/origin/next, refs/heads/side, HEAD -> refs/heads/dev"))
      .toEqual(["dev", "side", "origin/next", "+1"]);
  });

  it("folds the tail into a +N chip that names what it hides", () => {
    const chips = refChips("refs/heads/a, refs/heads/b, refs/heads/c, refs/heads/d, tag: refs/tags/v1", 3);
    expect(chips.map((c) => c.label)).toEqual(["a", "b", "c", "+2"]);
    const more = chips[3];
    expect(more.kind).toBe("more");
    expect(chipText(more)).toBe("d, v1");
    // Under the cap, nothing is folded.
    expect(refChips("refs/heads/a, refs/heads/b", 3).some((c) => c.kind === "more")).toBe(false);
  });

  it("has nothing to show for an undecorated commit", () => {
    expect(refChips("")).toEqual([]);
  });
});

describe("rowSvg / refChipsHtml", () => {
  it("draws one path per segment plus the node", () => {
    const l = layoutGraph([c("m", ["main1", "side1"]), c("main1", ["base"]), c("side1", ["base"]), c("base")]);
    const svg = rowSvg(l.rows[1]); // above:[0] below:[0] through:[1]
    expect((svg.match(/<path/g) || []).length).toBe(3);
    expect((svg.match(/<circle/g) || []).length).toBe(1);
    // A vertical segment stays vertical; only a lane change curves.
    expect(svg).toContain(`M${laneX(1)},0V26`);
    expect(rowSvg(l.rows[0])).toContain("C"); // the merge's fork does curve
  });

  it("draws each row only as wide as its OWN lanes", () => {
    // The point of the per-row span: in a page whose widest row uses 3 lanes, a 1-lane
    // row must not be padded out to 3 — the chips beside it would sit past empty space.
    const l = layoutGraph([
      c("m", ["a1", "b1"]), c("a1", ["base"]), c("b1", ["base"]), c("base"), c("older"),
    ]);
    expect(l.lanes).toBe(2);
    // `base` is 2 wide despite its node being in lane 0: the two lines converging into
    // it arrive from lane 1, and a narrower SVG would clip that curve.
    expect(l.rows.map((r) => r.span)).toEqual([2, 2, 2, 2, 1]);
    expect(rowSvg(l.rows[4])).toContain(`width="${graphWidth(1)}"`);
    expect(rowSvg(l.rows[0])).toContain(`width="${graphWidth(2)}"`);
    // A lane merely passing through still has to fit, or its line gets clipped.
    expect(l.rows[1].through.map((t) => t.lane)).toEqual([1]);
    expect(l.rows[1].span).toBe(2);
  });

  it("marks the HEAD commit's node differently", () => {
    const l = layoutGraph([c("a")]);
    expect(rowSvg(l.rows[0], { head: true })).toContain("ghead");
    expect(rowSvg(l.rows[0])).not.toContain("ghead");
  });

  it("escapes a ref name in text and in the title attribute", () => {
    expect(refChipsHtml([])).toBe("");
    // A branch name can contain almost anything, and it lands in innerHTML *and* in a
    // quoted attribute — esc() neutralises the angle bracket, attr() also the quote.
    const html = refChipsHtml(refChips('refs/heads/<script>, refs/heads/a"b'));
    expect(html).toContain("&lt;script");
    expect(html).not.toContain("<script");
    expect(html).toContain("&quot;");
    expect(html).not.toContain('title="a"b"');
  });

  it("marks a pushed branch with a glyph instead of a second chip", () => {
    const html = refChipsHtml(refChips("refs/heads/main, refs/remotes/origin/main"));
    expect(html).toContain("⇡");
    expect(html).toContain('title="main (also on origin)"');
    // A remote that isn't origin is named, since "pushed where" then matters.
    expect(refChipsHtml(refChips("refs/heads/x, refs/remotes/fork/x"))).toContain("⇡fork");
  });

  it("keeps the marker out of the truncating part of the chip", () => {
    // The name is what ellipsises; the ⇡ must not, or a long branch loses the one thing
    // the collapse added.
    const html = refChipsHtml(refChips("refs/heads/a-very-long-branch-name-indeed, refs/remotes/origin/a-very-long-branch-name-indeed"));
    expect(html).toContain('<span class="gn">a-very-long-branch-name-indeed</span>');
    expect(html.indexOf('class="gr"')).toBeGreaterThan(html.indexOf('class="gn"'));
  });
});
