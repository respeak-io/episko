import { describe, expect, it } from "vitest";
import {
  anyDeletable, branchRows, checkoutRows, chosenCheckouts, chosenWorktrees,
  filterCounts, filterRows, globMatch, localPicks, lockText, NO_PROTECT, orderRows, rangePick,
  removableCheckouts, remoteFor, remoteOf, remotePicks, selectable, switchable, switchOptions,
  trunkOf, trunkOptions, trunkText, whereText, midFlightText, syncText,
  type BranchInfo, type CheckoutCtx, type CleanCtx, type MergedPr, type ProtectCtx,
  type WtInfo,
} from "../src/branches";

// The module that decides to delete things, so these are the rules with teeth: what is
// offered, what is refused, and which of the two claims the backend re-checks. A branch is
// ONE row wherever its refs live, and each half of it carries its own permission.

const B = (name: string, o: Partial<BranchInfo> = {}): BranchInfo => ({
  name, current: false, checked_out: false, upstream: `origin/${name}`,
  ahead: 0, behind: 0, gone: false, merged: false, remote: false,
  base: "origin/main", author: "T", sha: "1a2b3c4", rel: "3 days ago", unix: 1,
  remote_ref: `origin/${name}`, remote_sha: "1a2b3c4", t_ahead: 0, t_behind: 0,
  is_default: false,
  ...o,
});
// A branch that lives only on this machine: nothing on any remote carries the name.
const LOCAL = (name: string, o: Partial<BranchInfo> = {}) =>
  B(name, { upstream: "", remote_ref: "", remote_sha: "", ...o });
const W = (branch: string, o: Partial<WtInfo> = {}): WtInfo => ({
  path: `/wt/${branch}`, branch, is_main: false, dirty: false, merged: true,
  locked: false, exists: true, ...o,
});
const PR = (number: number, branch: string): MergedPr =>
  ({ number, branch, title: "t", url: "u", merged_at: "2026-08-01T00:00:00Z" });

const ctx = (o: Partial<CleanCtx> = {}): CleanCtx => ({
  branches: [], worktrees: [], prs: [], liveIn: () => 0, externalIn: () => false,
  protect: NO_PROTECT, ...o,
});
// The two lists a lock can come from, as the dashboard reads them.
const PROT = (o: Partial<ProtectCtx> = {}): ProtectCtx => ({ ...NO_PROTECT, ...o });
const rows = (o: Partial<CleanCtx> = {}) => branchRows(ctx(o));
const row = (rs: ReturnType<typeof rows>, n: string) => rs.find((r) => r.name === n)!;

describe("one row per branch, wherever it lives", () => {
  it("says where a branch is, and counts a ref it merely has as living there", () => {
    const rs = rows({ branches: [
      B("tracked"),
      B("untracked", { upstream: "", remote_ref: "origin/untracked" }),
      LOCAL("mine"),
      B("theirs", { remote: true }),
      B("orphan", { gone: true }),
    ] });
    expect(whereText(row(rs, "tracked"))).toBe("local · origin");
    // Pushed without -u, so it follows nothing — and it is still on origin.
    expect(whereText(row(rs, "untracked"))).toBe("local · origin");
    expect(whereText(row(rs, "mine"))).toBe("local");
    expect(whereText(row(rs, "theirs"))).toBe("origin");
    // `gone` names a ref the remote no longer has, so it is not somewhere the branch lives.
    expect(whereText(row(rs, "orphan"))).toBe("local · remote deleted");
    expect(row(rs, "orphan").hasRemote).toBe(false);
  });

  it("never lists a branch twice, however many places it lives", () => {
    const rs = rows({ branches: [B("feat"), B("other", { remote: true })] });
    expect(rs.map((r) => r.name)).toEqual(["feat", "other"]);
  });
});

describe("what the local half offers", () => {
  it("offers gone, merged and PR-merged branches — and nothing else", () => {
    const rs = rows({
      branches: [B("gone-one", { gone: true }), B("merged-one", { merged: true }),
        B("squashed"), B("busy")],
      prs: [PR(12, "squashed")],
    });
    expect(rs.filter((r) => r.local.ok).map((r) => r.name).sort())
      .toEqual(["gone-one", "merged-one", "squashed"]);
    expect(row(rs, "busy").local.block).toBe("nothing says it has landed");
  });

  it("never offers the branch you are on, whatever else is true of it", () => {
    const rs = rows({ branches: [B("main", { current: true, merged: true })] });
    expect(row(rs, "main").local.ok).toBe(false);
    expect(row(rs, "main").local.block).toBe("the branch you are on");
  });

  // The backend keeps the trunk out of `merged`, so a PR merged off it is the only way it
  // reaches here at all — and force-deleting what every number is measured against is not it.
  // The one the redesign nearly shipped wrong: with the trunk overridden to origin/dev,
  // `main` is genuinely contained in it, so every evidence test said yes.
  it("never offers the remote's default branch, whatever the trunk is set to", () => {
    const rs = rows({
      branches: [B("main", { merged: true, is_default: true, base: "origin/dev" })],
    });
    expect(row(rs, "main").local.ok).toBe(false);
    expect(row(rs, "main").local.block).toBe("the repository's default branch");
    expect(row(rs, "main").remote.ok).toBe(false);
  });

  it("never offers the trunk's own local ref, PR or no PR", () => {
    const rs = rows({
      branches: [B("dev", { upstream: "origin/dev", remote_ref: "origin/dev", base: "origin/dev" })],
      prs: [PR(2297, "dev")],
    });
    expect(row(rs, "dev").local.ok).toBe(false);
    expect(row(rs, "dev").local.force).toBe(false);
    expect(row(rs, "dev").remote.ok).toBe(false);
  });

  it("forces only with PR evidence, and only where -d will actually refuse", () => {
    const rs = rows({
      branches: [B("squashed"), B("really-merged", { merged: true }), B("orphan", { gone: true })],
      prs: [PR(9, "squashed"), PR(10, "really-merged")],
    });
    expect(row(rs, "squashed").local.force).toBe(true);
    // Contained in the trunk, so `-d` takes it: a force would be reaching for nothing.
    expect(row(rs, "really-merged").local.force).toBe(false);
    // An unmerged branch whose remote was deleted is unpushed work, never a force.
    expect(row(rs, "orphan").local.force).toBe(false);
  });

  it("blocks a branch whose checkout is busy, dirty, locked or someone else's", () => {
    const b = [B("live", { merged: true }), B("dirty", { merged: true }),
      B("locked", { merged: true }), B("theirs", { merged: true }), B("free", { merged: true })];
    const worktrees = [W("live"), W("dirty", { dirty: true }), W("locked", { locked: true }),
      W("theirs"), W("free")];
    const rs = rows({
      branches: b, worktrees,
      liveIn: (p) => (p === "/wt/live" ? 2 : 0),
      externalIn: (p) => p === "/wt/theirs",
    });
    expect(row(rs, "live").local.block).toBe("2 sessions open in its worktree");
    expect(row(rs, "dirty").local.block).toBe("its worktree has uncommitted changes");
    expect(row(rs, "locked").local.block).toBe("its worktree is locked");
    expect(row(rs, "theirs").local.block).toBe("a session outside Episko is running there");
    expect(row(rs, "free").local.ok).toBe(true);
    // A blocked row is still shown; the reason is how you learn why it isn't offered.
    expect(rs).toHaveLength(5);
  });
});

describe("what the remote half offers", () => {
  it("offers only what is provably in the trunk, or provably merged", () => {
    const rs = rows({
      branches: [B("landed", { remote: true, merged: true }),
        B("wip", { remote: true, t_ahead: 3 }),
        B("squashed", { remote: true, t_ahead: 2 })],
      prs: [PR(4, "squashed")],
    });
    expect(rs.filter((r) => r.remote.ok).map((r) => r.name).sort()).toEqual(["landed", "squashed"]);
    expect(row(rs, "wip").remote.block).toBe("3 commits not in origin/main");
  });

  it("refuses a row it could not compare at all", () => {
    const rs = rows({ branches: [B("x", { remote: true, base: "", upstream: "other/x", remote_ref: "other/x" })] });
    expect(row(rs, "x").remote.ok).toBe(false);
    expect(row(rs, "x").remote.block).toBe("no comparison against other's default branch");
  });

  it("never offers the trunk itself", () => {
    const rs = rows({ branches: [B("main", { merged: true, upstream: "origin/main", remote_ref: "origin/main" })] });
    expect(row(rs, "main").remote.ok).toBe(false);
  });

  // The evidence a local row gathers is about ITS tip; it only carries to the remote ref
  // while the two are the same commit. Anything else is one fetch away from being knowable.
  it("refuses the remote half of a local row whose ref is on another commit", () => {
    const rs = rows({ branches: [B("ahead-of-it", { merged: true, remote_sha: "9999999" })] });
    expect(row(rs, "ahead-of-it").local.ok).toBe(true);
    expect(row(rs, "ahead-of-it").remote.ok).toBe(false);
    expect(row(rs, "ahead-of-it").remote.block).toBe("origin/ahead-of-it is on another commit — fetch first");
  });

  it("splits <remote>/<name> at the right slash", () => {
    expect(remoteOf(B("feature/x", { remote: true, upstream: "origin/feature/x", remote_ref: "origin/feature/x" }))).toBe("origin");
    expect(remoteOf(B("x", { remote: true, upstream: "up/stream/x", remote_ref: "up/stream/x" }))).toBe("up/stream");
    expect(remoteFor(rows({ branches: [B("a", { remote: true, merged: true, upstream: "fork/a", remote_ref: "fork/a" })] }))).toBe("fork");
  });
});

describe("what the commands are asked for", () => {
  const rs = () => rows({
    branches: [B("gone-one", { gone: true }), B("merged-one", { merged: true }),
      B("squashed"), B("held", { merged: true }), B("theirs", { remote: true, merged: true })],
    worktrees: [W("merged-one"), W("held", { dirty: true })],
    prs: [PR(7, "squashed")],
  });

  it("passes each branch's own claims through", () => {
    const picks = localPicks(rs(), new Set(["gone-one", "squashed", "merged-one"]));
    expect(picks).toEqual([
      { branch: "gone-one", gone: true, force: false },
      { branch: "merged-one", gone: false, force: false },
      { branch: "squashed", gone: false, force: true },
    ]);
  });

  it("drops a blocked or unarmed row even when the caller asks for it", () => {
    expect(localPicks(rs(), new Set(["held"]))).toEqual([]);
    // A remote-only row has no local ref, so the local command can never name it.
    expect(localPicks(rs(), new Set(["theirs"])).map((p) => p.branch)).toEqual([]);
  });

  it("collects the checkouts that have to be removed first", () => {
    expect(chosenWorktrees(rs(), new Set(["merged-one", "held"])).map((w) => w.branch))
      .toEqual(["merged-one"]);
  });

  it("carries the sha the REMOTE ref was showing, never the local tip", () => {
    const list = rows({ branches: [B("landed", { merged: true, sha: "aaa", remote_sha: "aaa" })] });
    expect(remotePicks(list, new Set(["landed"]))).toEqual([{ branch: "landed", sha: "aaa" }]);
  });
});

describe("selecting", () => {
  const rs = () => rows({
    branches: [B("a", { merged: true }), B("b", { merged: true }), B("c", { merged: true }),
      B("busy"), B("d", { merged: true })],
  });

  // The scopes decide where a delete lands, never what may be ticked: a repo whose branches
  // all live on the remote would otherwise open with every row inert.
  it("offers every row either half can act on", () => {
    expect([...selectable(rs())].sort()).toEqual(["a", "b", "c", "d"]);
    expect(anyDeletable(row(rs(), "busy"))).toBe(false);
  });

  it("takes the inclusive range between two rows, in the order on screen", () => {
    const order = ["a", "b", "busy", "c", "d"];
    expect(rangePick(order, "b", "c")).toEqual(["b", "busy", "c"]);
    expect(rangePick(order, "c", "b")).toEqual(["b", "busy", "c"]);
    expect(rangePick(order, "b", "b")).toEqual(["b"]);
  });

  it("falls back to the row clicked when the anchor has scrolled out of the filter", () => {
    expect(rangePick(["a", "b"], "gone-from-view", "b")).toEqual(["b"]);
    expect(rangePick(["a", "b"], "a", "not-here")).toEqual([]);
  });

  it("puts what can go first and what can't at the back, keeping git's order in each", () => {
    const list = rows({
      branches: [B("x"), B("offered", { merged: true }), B("blocked", { merged: true }), B("y")],
      worktrees: [W("blocked", { locked: true })],
    });
    expect(orderRows(list).map((r) => r.name)).toEqual(["offered", "blocked", "x", "y"]);
  });
});

describe("the filter chips, which are also the quick-selects", () => {
  const NOW = 1_800_000_000_000;
  const day = (n: number) => Math.round((NOW - n * 864e5) / 1000);
  const list = () => rows({
    branches: [
      B("fresh-merged", { merged: true, unix: day(1) }),
      B("old-merged", { merged: true, unix: day(90) }),
      B("orphan", { gone: true, unix: day(2) }),
      LOCAL("only-here", { unix: day(3) }),
      B("theirs", { remote: true, unix: day(4) }),
      B("held", { merged: true, unix: day(5) }),
    ],
    worktrees: [W("held")],
  });

  it("narrows to what each chip names", () => {
    const only = (f: Parameters<typeof filterRows>[1]) =>
      filterRows(list(), f, "", NOW).map((r) => r.name).sort();
    expect(only("merged")).toEqual(["fresh-merged", "held", "old-merged"]);
    expect(only("gone")).toEqual(["orphan"]);
    expect(only("stale")).toEqual(["old-merged"]);
    // A gone branch IS only on this machine now, so the two chips overlap, correctly.
    expect(only("localonly")).toEqual(["only-here", "orphan"]);
    expect(only("checkout")).toEqual(["held"]);
    expect(only("all")).toHaveLength(6);
  });

  it("filters by name on top of the chip", () => {
    expect(filterRows(list(), "merged", "old", NOW).map((r) => r.name)).toEqual(["old-merged"]);
    expect(filterRows(list(), "gone", "old", NOW)).toEqual([]);
  });

  // A chip reading 0 because another chip is on would say nothing about the repo.
  it("counts over every row, never over the shown ones", () => {
    const c = filterCounts(list(), NOW);
    expect(c.all).toBe(6);
    expect(c.merged).toBe(3);
    expect(c.gone).toBe(1);
    expect(c.localonly).toBe(2);
  });
});

describe("what a row says", () => {
  it("measures every row against the trunk, so the column means one thing", () => {
    expect(trunkText(B("x", { t_ahead: 2, t_behind: 30 }))).toBe("↑2 ↓30");
    expect(trunkText(B("x", { t_behind: 30 }))).toBe("↓30");
    expect(trunkText(B("x"))).toBe("even");
    expect(trunkText(B("x", { base: "" }))).toBe("not compared");
  });

  it("answers a different question about the ref a branch follows", () => {
    expect(syncText(B("x", { ahead: 2 }))).toBe("2 unpushed");
    expect(syncText(B("x"))).toBe("in sync with origin/x");
    expect(syncText(LOCAL("x"))).toBe("never pushed");
    expect(syncText(B("x", { upstream: "", remote_ref: "origin/x" }))).toBe("not tracking origin/x");
    expect(syncText(B("x", { gone: true }))).toBe("its remote branch was deleted");
  });
});

describe("the trunk", () => {
  const list = [B("main", { upstream: "origin/main" }), B("dev", { upstream: "origin/dev" })];

  it("is read off the rows, not off what was asked for", () => {
    expect(trunkOf(list)).toBe("origin/main");
    expect(trunkOf([B("x", { base: "" })])).toBe("");
  });

  it("always offers the trunk in force, which nothing need track", () => {
    const opts = trunkOptions([B("dev", { upstream: "origin/dev", base: "origin/main" })]);
    expect(opts.map((o) => o.name)).toContain("origin/main");
    expect(opts[0].name).toBe("");
  });
});

describe("where a checkout can move to", () => {
  const branches = [
    B("here", { current: true }), B("free"), B("held"),
    B("theirs", { remote: true, upstream: "origin/theirs" }),
  ];
  const wts = [W("held", { path: "/wt/held" })];

  it("lists a held branch disabled rather than dropping it", () => {
    const opts = switchOptions(branches, wts, "/repo");
    const by = (n: string) => opts.find((o) => o.name === n)!;
    expect(by("held").disabled).toBe(true);
    expect(by("held").note).toBe("checked out in held/");
    expect(by("here").disabled).toBe(true);
    expect(by("free").disabled).toBeUndefined();
    expect(switchable(opts).map((o) => o.name)).toEqual(["free", "theirs"]);
  });

  it("does not call the checkout you are switching a holder of its own branch", () => {
    const opts = switchOptions([B("held")], [W("held", { path: "/wt/held" })], "/wt/held");
    expect(opts[0].disabled).toBeUndefined();
  });

  it("marks a remote-only target and carries the ref it is cut from", () => {
    const t = switchOptions(branches, wts, "/repo").find((o) => o.name === "theirs")!;
    expect(t.base).toBe("origin/theirs");
    expect(t.note).toBe("only on origin; creates a local branch tracking it");
  });

  it("says what a switch would interrupt, and nothing when it would interrupt nothing", () => {
    expect(midFlightText(1, 0, 0)).toBe("1 agent is mid-turn");
    expect(midFlightText(2, 1, 3))
      .toBe("2 agents are mid-turn, 1 task is still running, 3 sessions are working outside Episko");
    expect(midFlightText(0, 0, 0)).toBe("");
  });
});

describe("the checkouts half", () => {
  const cctx = (o: Partial<CheckoutCtx> = {}): CheckoutCtx => ({
    worktrees: [], liveIn: () => 0, externalIn: () => false, protect: NO_PROTECT, ...o,
  });
  const list = () => checkoutRows(cctx({
    worktrees: [
      W("main", { path: "/repo", is_main: true }),
      W("clean"),
      W("busy"),
      W("dirty", { dirty: true }),
      W("locked", { locked: true }),
      W("vanished", { exists: false }),
    ],
    liveIn: (p) => (p === "/wt/busy" ? 1 : 0),
  }));
  const at = (n: string) => list().find((c) => c.wt.branch === n)!;

  it("never offers the project's own folder", () => {
    expect(at("main").ok).toBe(false);
    expect(at("main").block).toBe("the project's own folder");
  });

  it("refuses what remove_worktree would refuse, in its own words", () => {
    expect(at("busy").block).toBe("1 session open here");
    expect(at("dirty").block).toBe("uncommitted changes");
    expect(at("locked").block).toBe("locked");
    expect(at("clean").ok).toBe(true);
  });

  // A folder git records and disk has lost is a prune: dirty and locked mean nothing there.
  it("offers a vanished folder and says removing it loses nothing", () => {
    expect(at("vanished").ok).toBe(true);
    expect(at("vanished").note).toBe("folder is gone — removing only clears git's record");
  });

  it("hands the command only what it may act on", () => {
    expect([...removableCheckouts(list())].sort()).toEqual(["/wt/clean", "/wt/vanished"]);
    const picked = new Set(["/wt/clean", "/wt/dirty", "/repo"]);
    expect(chosenCheckouts(list(), picked).map((c) => c.wt.branch)).toEqual(["clean"]);
  });
});

// The lock: the one refusal no evidence lifts, and the only rule here with two sources.
// `.episko/episko.toml` is committed, so it refuses the delete for everyone who pulls;
// GitHub's own protection is read-only evidence about the remote ref.
describe("a protected branch", () => {
  // Two merged branches, so nothing but the lock can be what refuses one of them; `keep` is
  // not the trunk, which is refused for a reason of its own.
  const two = (protect: Partial<ProtectCtx>) =>
    rows({ branches: [B("keep", { merged: true }), B("go", { merged: true })], protect: PROT(protect) });
  const locked = (protect: Partial<ProtectCtx>) => row(two(protect), "keep");

  it("refuses both halves whatever the evidence says", () => {
    const r = locked({ patterns: ["keep"] });
    expect(r.local.ok).toBe(false);
    expect(r.remote.ok).toBe(false);
    expect(r.local.block).toBe("protected in .episko/episko.toml");
    expect(anyDeletable(r)).toBe(false);
    // …and its neighbour is untouched: a lock is about one name, not about the repo.
    expect(row(two({ patterns: ["keep"] }), "go").local.ok).toBe(true);
  });

  it("never reaches the commands, however it was ticked", () => {
    const rs = two({ patterns: ["keep"] });
    const on = new Set(["keep", "go"]);
    expect(localPicks(rs, on).map((p) => p.branch)).toEqual(["go"]);
    expect(remotePicks(rs, on).map((p) => p.branch)).toEqual(["go"]);
    expect([...selectable(rs)]).toEqual(["go"]);
  });

  // A glob covers siblings nobody named on this row, so the menu must not offer to lift it.
  it("says which entry caught it, and whether a click can lift it", () => {
    const rs = rows({ branches: [B("release/1.2"), B("main")], protect: PROT({ patterns: ["release/*", "main"] }) });
    expect(row(rs, "release/1.2").lock).toEqual({ by: "episko", pattern: "release/*", exact: false });
    expect(row(rs, "main").lock).toEqual({ by: "episko", pattern: "main", exact: true });
    expect(lockText(row(rs, "release/1.2").lock)).toBe("protected by release/* in .episko/episko.toml");
  });

  it("wears GitHub's protection too, and never claims that one is ours to edit", () => {
    const r = locked({ github: ["keep"] });
    expect(r.lock).toEqual({ by: "github", pattern: "keep", exact: false });
    expect(lockText(r.lock)).toBe("protected on GitHub");
    expect(r.local.ok).toBe(false);
  });

  // Our own list first: it is the one a click can change, and the one the backend re-reads.
  it("prefers the committed list when both say so", () => {
    expect(locked({ patterns: ["keep"], github: ["keep"] }).lock?.by).toBe("episko");
  });

  it("protects nothing when the file could not be parsed", () => {
    // `readable: false` is the view's cue to say so; the rules themselves just see no patterns.
    expect(locked({ patterns: [], readable: false }).local.ok).toBe(true);
  });

  it("survives its checkout: removing the folder is not a way around it", () => {
    const one = (protect: ProtectCtx) => checkoutRows({
      worktrees: [W("keep", { merged: true })], liveIn: () => 0, externalIn: () => false, protect,
    })[0];
    expect(one(NO_PROTECT).note).toBe("merged; its branch goes with it");
    expect(one(PROT({ patterns: ["keep"] })).note).toBe("its branch is protected and stays");
  });
});

describe("globMatch", () => {
  it("matches a pattern with no star exactly", () => {
    expect(globMatch("main", "main")).toBe(true);
    expect(globMatch("main", "maint")).toBe(false);
    expect(globMatch("main", "origin/main")).toBe(false);
  });

  it("lets a star cross a slash, which is what release/* is for", () => {
    expect(globMatch("release/*", "release/1.2")).toBe(true);
    expect(globMatch("release/*", "release/next/1.2")).toBe(true);
    expect(globMatch("release/*", "release")).toBe(false);
    expect(globMatch("*", "anything/at/all")).toBe(true);
  });

  it("anchors both ends and honours a star in the middle", () => {
    expect(globMatch("*-wip", "feat-wip")).toBe(true);
    expect(globMatch("*-wip", "feat-wip-2")).toBe(false);
    expect(globMatch("feat/*/old", "feat/a/old")).toBe(true);
    expect(globMatch("feat/*/old", "feat/a/new")).toBe(false);
  });

  it("never matches a shorter name than the pattern's fixed halves", () => {
    // `rest.endsWith(part)` on an empty remainder would otherwise let `ab*ab` match `abab`… twice.
    expect(globMatch("ab*ab", "ab")).toBe(false);
    expect(globMatch("ab*ab", "abab")).toBe(true);
  });
});
