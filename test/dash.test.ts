import { describe, expect, it } from "vitest";
import "./localstorage"; // must precede the subject imports (state.ts reads it at load)
import {
  canShare, clampRange, dashDays, dashPulse, densePerDay, DASH_RANGE_DEFAULT,
  mainCheckout, projectCost, projectTier, syncState, type ProjectFacts,
} from "../src/dash";
import type { HistEntry } from "../src/history";
import type { TrailCommit } from "../src/trail";
import type { DiffStat, WtHead } from "../src/types";
import type { UDay } from "../src/usage";

const facts = (o: Partial<ProjectFacts> = {}): ProjectFacts =>
  ({ is_repo: true, root: "/w/epi", origin: null, host: null, slug: null, ...o });

// A day key as ./usage writes them, for a local-midnight day N days before `now`.
const NOW = new Date(2026, 6, 31, 14, 0, 0).getTime(); // 31 Jul 2026, local
const dk = (back: number) => {
  const d = new Date(NOW - back * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const hist = (o: Partial<HistEntry> = {}): HistEntry => ({
  provider: "claude", session_id: "s1", cwd: "/w/epi", project: "epi", branch: "main",
  title: "a session", last_prompt: "", last_active: NOW / 1000, bytes: 10, exists: true,
  repo_root: "/w/epi", ...o,
});
const commit = (o: Partial<TrailCommit> = {}): TrailCommit =>
  ({ sha: "abc1234", author: "Tim", when: NOW / 1000, subject: "a commit", root: "/w/epi", ...o });
const uday = (key: string, cost = 0): UDay => ({ key, cost, tok: 0 } as UDay);

describe("projectTier — three gates, and they are not the same gate", () => {
  it("is github only when a slug was minted, which only github.com gets", () => {
    expect(projectTier(facts({ host: "github.com", slug: "respeak-io/episko" }))).toBe("github");
  });
  it("is git for a repo with no remote, or a remote that isn't GitHub", () => {
    expect(projectTier(facts())).toBe("git");
    expect(projectTier(facts({ host: "gitlab.com" }))).toBe("git");
    expect(projectTier(facts({ host: "git.respeak.internal" }))).toBe("git");
  });
  it("is none for a folder that isn't a repository", () => {
    expect(projectTier(facts({ is_repo: false }))).toBe("none");
    expect(projectTier(null)).toBe("none");
    expect(projectTier(undefined)).toBe("none");
  });
  it("gates sharing on git, NOT on GitHub — .episko only needs to be committable", () => {
    expect(canShare("github")).toBe(true);
    expect(canShare("git")).toBe(true);
    expect(canShare("none")).toBe(false);
  });
});

describe("projectCost", () => {
  const detail = { [dk(0)]: { projects: { epi: 4.5, other: 99 } } };
  it("returns this project's share of the day", () => {
    expect(projectCost(detail, dk(0), "epi")).toBe(4.5);
  });
  it("returns 0 — never the fleet total — for a day with no detail record", () => {
    // The plain cc-usage rollup is every project at once. Borrowing it here would
    // invent a number that looks like data.
    expect(projectCost({}, dk(0), "epi")).toBe(0);
    expect(projectCost(detail, dk(3), "epi")).toBe(0);
    expect(projectCost(detail, dk(0), "not-this-one")).toBe(0);
  });
  it("ignores a corrupt or negative value rather than propagating it", () => {
    expect(projectCost({ x: { projects: { epi: NaN } } }, "x", "epi")).toBe(0);
    expect(projectCost({ x: { projects: { epi: -1 } } }, "x", "epi")).toBe(0);
    expect(projectCost({ x: undefined }, "x", "epi")).toBe(0);
  });
});

describe("dashDays — scoped before assembly, not after", () => {
  const win = [uday(dk(0)), uday(dk(1))];
  it("keeps only this project's sessions and commits", () => {
    const days = dashDays(
      "/w/epi",
      [hist({ session_id: "mine" }), hist({ session_id: "theirs", cwd: "/w/other", repo_root: "/w/other", project: "other" })],
      [commit({ sha: "mine" }), commit({ sha: "theirs", root: "/w/other" })],
      win, () => 0,
    );
    expect(days).toHaveLength(1);
    expect(days[0].sessions.map((s) => s.id)).toEqual(["mine"]);
    expect(days[0].commits.map((c) => c.sha)).toEqual(["mine"]);
  });

  it("restates cost per project instead of carrying the fleet-wide figure", () => {
    // The window's UDay.cost is every project's spend that day. If it survived, the
    // pulse strip would describe somebody else's afternoon.
    const days = dashDays("/w/epi", [hist()], [], [uday(dk(0), 99)], () => 4.5);
    expect(days[0].cost).toBe(4.5);
  });

  it("drops a day this project had nothing on, even if the fleet was busy", () => {
    const days = dashDays("/w/epi", [hist()], [], [uday(dk(0)), uday(dk(1), 50)], () => 0);
    expect(days.map((d) => d.key)).toEqual([dk(0)]);
  });
});

describe("dashPulse", () => {
  const days = dashDays(
    "/w/epi",
    [hist({ session_id: "a" }), hist({ session_id: "b", last_active: (NOW - 86_400_000) / 1000 })],
    [
      commit({ sha: "c1", author: "Tim" }),
      commit({ sha: "c2", author: "Frederic" }),
      commit({ sha: "c3", author: "Tim", when: (NOW - 86_400_000) / 1000 }),
    ],
    [uday(dk(0)), uday(dk(1))],
    (k) => (k === dk(0) ? 4 : 1),
  );

  it("totals the window", () => {
    const p = dashPulse(days);
    expect(p.commits).toBe(3);
    expect(p.sessions).toBe(2);
    expect(p.spend).toBe(5);
  });
  it("ranks authors busiest first, ties by name so a repaint never reorders", () => {
    expect(dashPulse(days).authors).toEqual(["Tim", "Frederic"]);
  });
  it("emits the sparkline oldest-first — a chart reads left to right in time", () => {
    // `days` is newest-first for the list; the series must be the other way round.
    expect(dashPulse(days).perDay).toEqual([1, 2]);
  });
  it("is all zeroes for an empty window rather than throwing", () => {
    expect(dashPulse([])).toEqual({ commits: 0, sessions: 0, spend: 0, authors: [], perDay: [] });
  });
});

describe("densePerDay — the chart must not drop the quiet days", () => {
  it("fills days with nothing on them, which trailDays deliberately omits", () => {
    // Two busy days a week apart render as two adjacent bars without this, which reads
    // as "constantly busy" — the exact opposite of the truth.
    const days = dashDays("/w/epi",
      [hist({ last_active: NOW / 1000 }), hist({ session_id: "old", last_active: (NOW - 6 * 86_400_000) / 1000 })],
      [commit(), commit({ sha: "c2" }), commit({ sha: "c3", when: (NOW - 6 * 86_400_000) / 1000 })],
      [uday(dk(0)), uday(dk(6))], () => 0);
    expect(days).toHaveLength(2);          // the list keeps only the two real days…
    expect(densePerDay(days, 7, NOW)).toEqual([1, 0, 0, 0, 0, 0, 2]); // …the chart keeps all seven
  });
  it("is all zeroes when nothing happened at all", () => {
    expect(densePerDay([], 7, NOW)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("mainCheckout — which folder ⇣ Pull, ⇡ Push and ⇄ Switch act on", () => {
  const head = (o: Partial<WtHead> = {}): WtHead =>
    ({ path: "/w/epi", branch: "main", is_main: true, exists: true, ...o });

  it("is git's own main worktree, not whichever checkout sorts first", () => {
    const heads = [
      head({ path: "/w/epi-feat", branch: "feat/x", is_main: false }),
      head({ path: "/w/epi", branch: "main" }),
    ];
    expect(mainCheckout(heads, "/w/epi")).toBe("/w/epi");
  });
  it("falls back to the root when the heads probe answered with nothing", () => {
    // It runs after the timeline and is allowed to fail — the button stays live and
    // git_action refuses on its own terms, which beats the verb silently vanishing.
    expect(mainCheckout([], "/w/epi")).toBe("/w/epi");
  });
  it("ignores a checkout whose folder is gone — git cannot pull into it", () => {
    expect(mainCheckout([head({ path: "/w/deleted", exists: false })], "/w/epi")).toBe("/w/epi");
  });
});

describe("syncState — the numbers are as old as the last fetch, and it says so", () => {
  const ds = (o: Partial<DiffStat> = {}): DiffStat => ({
    added: 0, removed: 0, files: 0, untracked: 0, dirty: 0,
    upstream: "origin/main", ahead: 0, behind: 0, ...o,
  });

  it("is unknown before the probe answers, and for a folder git could not read", () => {
    expect(syncState(null)).toBe("unknown");
    expect(syncState(undefined)).toBe("unknown");
  });
  it("separates the two zeroes: no upstream is not up to date", () => {
    // Both read `behind: 0`, and conflating them swallows the one case that has a real
    // answer — the backend's refusal names the --set-upstream-to that fixes it.
    expect(syncState(ds({ upstream: null }))).toBe("no-upstream");
    expect(syncState(ds())).toBe("level");
  });
  it("calls a branch with work on both sides diverged, not behind", () => {
    // ff-only would fail; the backend refuses up front and hands over `git pull --rebase`.
    expect(syncState(ds({ ahead: 2, behind: 3 }))).toBe("diverged");
    expect(syncState(ds({ behind: 3 }))).toBe("behind");
  });
  it("gives unpushed-with-nothing-incoming its own answer, not `level`", () => {
    // The quiet case for ⇣ Pull and the entire point of ⇡ Push, from one reading. Folded
    // into `level` (which is what it was while pulling was all this pane could do), the
    // push row would read "nothing to push" over commits waiting to go out.
    expect(syncState(ds({ ahead: 2 }))).toBe("ahead");
    expect(syncState(ds())).toBe("level");
  });
  it("does not call a branch with no upstream ahead, however many commits it has", () => {
    // `git rev-list @{u}..` has nothing to count against, so ahead reads 0 anyway — but
    // the state has to be the one that names the fix, not the one that says "nothing to
    // push" about a branch that has never been published.
    expect(syncState(ds({ upstream: null, ahead: 4 }))).toBe("no-upstream");
  });
});

describe("clampRange", () => {
  it("accepts only the offered windows", () => {
    expect(clampRange(7)).toBe(7);
    expect(clampRange(30)).toBe(30);
    expect(clampRange(999)).toBe(DASH_RANGE_DEFAULT);
    expect(clampRange(NaN)).toBe(DASH_RANGE_DEFAULT);
  });
});
