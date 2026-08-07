import { describe, expect, it } from "vitest";
import {
  chosenWorktrees, localCands, localStanding, remoteCands, remoteFor, remoteOf, remotePicks,
  orderCands, selectable, standing, sweepPicks, trunkOf, trunkOptions,
  type BranchInfo, type CleanCtx, type MergedPr, type WtInfo,
} from "../src/branches";

// The module that decides to delete things, so these are the rules with teeth: what is
// offered, what is refused, and which of the two claims the backend re-checks. It lived
// in the ⑃ dialog's markup before, where the only way to verify it was to open the dialog
// and look at it.

const B = (name: string, o: Partial<BranchInfo> = {}): BranchInfo => ({
  name, current: false, checked_out: false, upstream: `origin/${name}`,
  ahead: 0, behind: 0, gone: false, merged: false, remote: false,
  base: "origin/main", author: "T", sha: "1a2b3c4", rel: "3 days ago", unix: 1,
  ...o,
});
const W = (branch: string, o: Partial<WtInfo> = {}): WtInfo => ({
  path: `/wt/${branch}`, branch, is_main: false, dirty: false, merged: true,
  locked: false, exists: true, ...o,
});
const PR = (number: number, branch: string): MergedPr =>
  ({ number, branch, title: "t", url: "u", merged_at: "2026-08-01T00:00:00Z" });

const ctx = (o: Partial<CleanCtx> = {}): CleanCtx => ({
  branches: [], worktrees: [], prs: [], liveIn: () => 0, externalIn: () => false, ...o,
});

describe("what a local cleanup offers", () => {
  it("offers gone, merged and PR-merged branches — and nothing else", () => {
    const branches = [
      B("gone-one", { gone: true }),
      B("merged-one", { merged: true }),
      B("squashed", { ahead: 3 }),          // neither gone nor merged: only its PR vouches
      B("live-work", { ahead: 2 }),         // nothing vouches for it at all
    ];
    const c = localCands(ctx({ branches, prs: [PR(63, "squashed")] }));
    expect(c.map((x) => x.br.name).sort()).toEqual(["gone-one", "merged-one", "squashed"]);
    expect(c.find((x) => x.br.name === "live-work")).toBeUndefined();
  });

  it("never offers the branch you are on, whatever else is true of it", () => {
    // git refuses to delete a checked-out branch, so an offer could only ever be an error.
    const branches = [B("dev", { current: true, merged: true, gone: true })];
    expect(localCands(ctx({ branches }))).toEqual([]);
  });

  it("forces only with PR evidence, and only where -d will actually refuse", () => {
    const branches = [
      B("squashed", { ahead: 3 }),                  // PR merged, contained in nothing
      B("pr-and-merged", { merged: true }),         // PR merged AND already in the trunk
      B("gone-unmerged", { gone: true, ahead: 1 }), // gone, but nothing says it landed
    ];
    const prs = [PR(1, "squashed"), PR(2, "pr-and-merged")];
    const by = Object.fromEntries(localCands(ctx({ branches, prs })).map((c) => [c.br.name, c]));
    expect(by["squashed"].force).toBe(true);
    // A merged branch needs no force; claiming one would inflate the warning into noise.
    expect(by["pr-and-merged"].force).toBe(false);
    // The one that matters: `gone` is not evidence that the work landed. An unmerged
    // branch whose remote someone deleted is unpushed work.
    expect(by["gone-unmerged"].force).toBe(false);
  });

  it("blocks a branch whose checkout is busy, dirty, locked or someone else's", () => {
    const branches = ["busy", "dirty", "locked", "foreign", "free"].map((n) => B(n, { gone: true }));
    const worktrees = [
      W("busy"), W("dirty", { dirty: true }), W("locked", { locked: true }),
      W("foreign"), W("free"),
    ];
    const c = localCands(ctx({
      branches, worktrees,
      liveIn: (p) => (p === "/wt/busy" ? 2 : 0),
      externalIn: (p) => p === "/wt/foreign",
    }));
    const by = Object.fromEntries(c.map((x) => [x.br.name, x]));
    expect(by["busy"].block).toContain("2 sessions");
    expect(by["dirty"].block).toContain("uncommitted");
    expect(by["locked"].block).toContain("locked");
    expect(by["foreign"].block).toContain("outside Episko");
    // A clean, idle checkout is not a blocker — it goes with the branch.
    expect(by["free"].block).toBe("");
    expect(by["free"].wt?.path).toBe("/wt/free");
    expect(selectable(c)).toEqual(new Set(["free"]));
  });

  it("puts what can go first and what can't at the back, keeping git's order in each", () => {
    // The rows you can tick should not sit behind the ones you can't — and the blocked
    // ones still belong on screen, because "why isn't this offered?" needs an answer.
    const branches = [
      B("blocked-newest", { gone: true }), B("free-a", { gone: true }),
      B("blocked-older", { gone: true }), B("free-b", { merged: true }),
    ];
    const worktrees = [W("blocked-newest", { dirty: true }), W("blocked-older", { dirty: true })];
    const ordered = orderCands(localCands(ctx({ branches, worktrees })));
    expect(ordered.map((c) => c.br.name)).toEqual(["free-a", "free-b", "blocked-newest", "blocked-older"]);
  });

  it("names the trunk it is measuring against, not 'the main branch'", () => {
    const c = localCands(ctx({ branches: [B("m", { merged: true, base: "origin/develop" })] }));
    expect(c[0].why).toBe("merged into origin/develop");
  });
});

describe("what a remote cleanup offers", () => {
  const rows = [
    B("landed", { remote: true, merged: true, behind: 3 }),
    B("squashed", { remote: true, ahead: 2, behind: 5 }),
    B("in-flight", { remote: true, ahead: 4 }),
    B("uncomparable", { remote: true, base: "", upstream: "upstream/uncomparable" }),
  ];
  const c = remoteCands(rows, [PR(63, "squashed")]);
  const by = Object.fromEntries(c.map((x) => [x.br.name, x]));

  it("offers only what is provably in the trunk, or provably merged", () => {
    expect(by["landed"].block).toBe("");
    expect(by["squashed"].block).toBe("");
    // The one with real work on it: refused, and the row says how much.
    expect(by["in-flight"].block).toContain("4 commits not in origin/main");
  });

  it("refuses a row it could not compare at all", () => {
    // A second remote, a missing origin/HEAD, or a git too old for %(ahead-behind:).
    // Not knowing is a reason to refuse — the zeros do NOT mean "in sync".
    expect(by["uncomparable"].block).toContain("upstream");
    expect(selectable(c)).toEqual(new Set(["landed", "squashed"]));
  });

  it("never offers a force, whatever the evidence", () => {
    // `git push --delete` is public and there is no safe/forced distinction to make: a
    // protected-branch refusal is the server's answer, not ours to route around.
    expect(c.every((x) => !x.force)).toBe(true);
  });

  it("splits <remote>/<name> at the right slash", () => {
    // git permits a branch name with slashes in it; splitting at the first one would
    // name the wrong remote.
    expect(remoteOf(B("feat/deep/name", { remote: true, upstream: "origin/feat/deep/name" }))).toBe("origin");
    expect(remoteFor(c)).toBe("origin");
    // With nothing selectable, the remote still comes from a row rather than a guess.
    expect(remoteFor(remoteCands([rows[3]], []))).toBe("upstream");
  });
});

describe("what the commands are asked for", () => {
  const branches = [
    B("gone-one", { gone: true }),
    B("squashed", { ahead: 3 }),
    B("held", { gone: true }),
    B("busy", { gone: true }),
  ];
  const worktrees = [W("held"), W("busy")];
  const cands = localCands(ctx({
    branches, worktrees, prs: [PR(9, "squashed")],
    liveIn: (p) => (p === "/wt/busy" ? 1 : 0),
  }));

  it("passes each branch's own claims through", () => {
    const picks = sweepPicks(cands, new Set(["gone-one", "squashed"]));
    expect(picks).toEqual([
      { branch: "gone-one", gone: true, force: false },
      { branch: "squashed", gone: false, force: true },
    ]);
  });

  it("drops a blocked row even when the caller asks for it", () => {
    // Defence in depth: the UI can't tick a blocked row, but nothing downstream should
    // depend on the UI being the only caller.
    expect(sweepPicks(cands, new Set(["busy"]))).toEqual([]);
    expect(chosenWorktrees(cands, new Set(["busy"]))).toEqual([]);
  });

  it("collects the checkouts that have to be removed first", () => {
    // git refuses to delete a branch a worktree holds, so this ordering is not a
    // preference — a branch whose checkout is still there cannot go.
    expect(chosenWorktrees(cands, new Set(["held", "gone-one"])).map((w) => w.path)).toEqual(["/wt/held"]);
  });

  it("carries the sha a remote row was showing", () => {
    // The backend refuses the delete if the ref has moved since; that check is only
    // possible because the sha travels with the pick.
    const rc = remoteCands([B("landed", { remote: true, merged: true, sha: "deadbee" })], []);
    expect(remotePicks(rc, new Set(["landed"]))).toEqual([{ branch: "landed", sha: "deadbee" }]);
  });
});

describe("the trunk", () => {
  const branches = [
    B("dev", { current: true, upstream: "origin/dev" }),
    B("feat", { upstream: "" }),
    B("theirs", { remote: true, upstream: "origin/theirs" }),
  ];

  it("is read off the rows, not off what was asked for", () => {
    // A stored override that no longer resolves comes back as git's real default, so the
    // chip shows what was used rather than a lie.
    expect(trunkOf(branches)).toBe("origin/main");
    expect(trunkOf([B("x", { base: "" })])).toBe("");
  });

  it("always offers the trunk in force, which nothing need track", () => {
    const opts = trunkOptions(branches).map((o) => o.name);
    expect(opts[0]).toBe("");            // automatic — clears the override
    expect(opts[1]).toBe("origin/main"); // in use now, and in nobody's `upstream`
    expect(opts).toContain("origin/dev");
    expect(opts).toContain("feat");      // a local branch is a legitimate trunk
    expect(new Set(opts).size).toBe(opts.length);   // no duplicates
  });

  it("says a remote row's standing in words, without naming the trunk on every row", () => {
    // The view names the trunk once, in its footer. Repeating it down the column is what
    // squeezed the branch name — the one thing each row is actually about.
    expect(standing(B("a", { ahead: 2, behind: 3 }))).toBe("2 ahead · 3 behind");
    expect(standing(B("b"))).toBe("even");
    // Not "even": the comparison could not be made at all, and the two must not look alike.
    expect(standing(B("c", { base: "" }))).toBe("not compared");
  });

  it("answers a different question for a local row, because it is one", () => {
    // A local branch's ahead/behind are versus its OWN upstream, not versus the trunk —
    // putting both under one heading would mix two incompatible numbers in one column.
    expect(localStanding(B("a", { ahead: 2 }))).toBe("2 unpushed");
    expect(localStanding(B("b", { gone: true }))).toBe("remote deleted");
    expect(localStanding(B("c", { upstream: "" }))).toBe("never pushed");
    expect(localStanding(B("d"))).toBe("pushed");
  });
});
