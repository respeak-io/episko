import { describe, expect, it } from "vitest";
import { store } from "./localstorage"; // must precede the subject imports (state.ts reads it at load)
import {
  bandFacts, canShare, clampRange, dashDays, dashPulse, dayCard, DAY_ROWS, densePerDay, DASH_RANGE_DEFAULT, DASH_SEEN_KEY,
  mainCheckout, projectCost, projectTier, readSeen, saveSeen, SEEN_MAX, seenAt, sinceFacts,
  stampSeen, syncState, type ProjectFacts,
} from "../src/dash";
import type { HistEntry } from "../src/history";
import type { TrailCommit, TrailDay, TrailSession } from "../src/trail";
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

// `back` days ago, so a fixture day's own sessions carry a timestamp inside it: `sinceFacts`
// cuts the window at the instant you left, and a session stamped `NOW` on a two-day-old day
// would land in every window ever asked about.
const sess = (id: string, back = 0): TrailSession =>
  ({ id, title: "a session", project: "epi", colorKey: "/w/epi", branch: "main", cwd: "/w/epi",
     when: NOW - back * 86_400_000, exists: true });
// `when` is local midnight, as `trailDays` buckets it — the whole point of the in-range rule.
const tday = (back: number, o: Partial<TrailDay> = {}): TrailDay => ({
  key: dk(back), when: new Date(NOW - back * 86_400_000).setHours(0, 0, 0, 0),
  cost: 0, tokens: 0, sessions: [], commits: [], events: [], ...o,
});
const bot = (author: string) => /\[bot\]$/i.test(author);

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
  it("adds a day's id-keyed and name-keyed halves of one project", () => {
    const both = { [dk(0)]: { projects: { "git:abc": 2, epi: 1.5, other: 9 } } };
    expect(projectCost(both, dk(0), ["git:abc", "epi"])).toBe(3.5);
    expect(projectCost(both, dk(0), [undefined, "epi", "epi"])).toBe(1.5);
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
    expect(densePerDay(days, 7, NOW).map((d) => d.n)).toEqual([1, 0, 0, 0, 0, 0, 2]); // …the chart keeps all seven
  });
  it("is all zeroes when nothing happened at all", () => {
    expect(densePerDay([], 7, NOW).map((d) => d.n)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
  it("stamps each bar with its own midnight, oldest first — the strip has to name its days", () => {
    const bars = densePerDay([], 3, NOW);
    expect(bars.map((b) => b.when)).toEqual([
      new Date(NOW - 2 * 86_400_000).setHours(0, 0, 0, 0),
      new Date(NOW - 86_400_000).setHours(0, 0, 0, 0),
      new Date(NOW).setHours(0, 0, 0, 0),
    ]);
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
    expect(clampRange(30)).toBe(DASH_RANGE_DEFAULT); // the ribbon is 30 days, so 30 is the window
    expect(clampRange(999)).toBe(DASH_RANGE_DEFAULT);
    expect(clampRange(NaN)).toBe(DASH_RANGE_DEFAULT);
  });
});

describe("readSeen — a stamp is narrowed on its own, never trusted wholesale", () => {
  const seed = (raw: string | null) => {
    store.clear();
    if (raw !== null) store.set(DASH_SEEN_KEY, raw);
  };

  it("is {} for a key nobody has written yet", () => {
    seed(null);
    expect(readSeen()).toEqual({});
  });
  it("is {} for a value that parses but is the wrong shape, and for one that does not parse", () => {
    // `"null"` and `"[]"` survive JSON.parse and only fail at the first property access,
    // somewhere else entirely; a crash mid-write truncates.
    for (const raw of ["null", "[]", '{"/w/epi": 1']) {
      seed(raw);
      expect(readSeen()).toEqual({});
    }
  });
  it("drops a stamp that is not a usable time and keeps its siblings", () => {
    // `null` is what JSON.stringify writes for a NaN, so that is how a broken stamp arrives.
    seed('{"/w/a": null, "/w/b": 0, "/w/c": -1, "/w/d": "soon", "/w/e": 1700}');
    expect(readSeen()).toEqual({ "/w/e": 1700 });
  });
  it("reads a decomposed path back precomposed — a path has one spelling", () => {
    seed(JSON.stringify({ "/w/scho\u0308n": 1700 }));
    expect(readSeen()).toEqual({ "/w/sch\u00f6n": 1700 });
  });
});

describe("seenAt / stampSeen / saveSeen", () => {
  it("answers 0 for a project never opened", () => {
    expect(seenAt({}, "/w/epi")).toBe(0);
  });
  it("answers 0 for a decomposed key until readSeen has repaired it", () => {
    // The record straight off the store is not yet one spelling; readSeen is what makes it so.
    expect(seenAt({ "/w/scho\u0308n": 1700 }, "/w/sch\u00f6n")).toBe(0);
    store.clear();
    store.set(DASH_SEEN_KEY, JSON.stringify({ "/w/scho\u0308n": 1700 }));
    expect(seenAt(readSeen(), "/w/sch\u00f6n")).toBe(1700);
  });
  it("returns a new record and leaves its input alone", () => {
    const before = { "/w/epi": 1 };
    const after = stampSeen(before, "/w/epi", 2);
    expect(before).toEqual({ "/w/epi": 1 });
    expect(after).not.toBe(before);
    expect(seenAt(after, "/w/epi")).toBe(2);
  });
  it("stamps under the precomposed spelling whatever the caller passed", () => {
    expect(seenAt(stampSeen({}, "/w/scho\u0308n", 5), "/w/sch\u00f6n")).toBe(5);
  });
  it("evicts the oldest stamp rather than growing with every folder ever opened", () => {
    const full: Record<string, number> = {};
    for (let i = 1; i <= SEEN_MAX; i++) full[`/w/p${i}`] = i;
    const next = stampSeen(full, "/w/new", 1000);
    expect(Object.keys(next)).toHaveLength(SEEN_MAX);
    expect(next["/w/p1"]).toBeUndefined();   // the oldest goes…
    expect(next["/w/p2"]).toBe(2);           // …and everything newer stays
    expect(next["/w/new"]).toBe(1000);
  });
  it("writes through the one key, and only when asked to", () => {
    store.clear();
    stampSeen({}, "/w/epi", 5);
    expect(store.get(DASH_SEEN_KEY)).toBeUndefined();
    saveSeen({ "/w/epi": 5 });
    expect(store.get(DASH_SEEN_KEY)).toBe('{"/w/epi":5}');
  });
});

describe("bandFacts — the band never shows nothing", () => {
  const days = [
    tday(0, { cost: 4, sessions: [sess("a")], commits: [commit({ sha: "c1", author: "Tim" })] }),
  ];

  it("shows the gap when there is something in it", () => {
    // An hour ago, so the stamp is inside the loaded days and `capped` does not claim it.
    const f = bandFacts(days, NOW - 3_600_000, NOW, bot);
    expect(f.window).toBe(false);
    expect(f.quiet).toBe(false);
    expect(f.commits).toBe(1);
  });
  it("falls back to the window when the gap is empty, rather than emptying the card", () => {
    // The ribbon and the last days' sentences hang off these figures: a blank card takes
    // them with it, and a card that blanks itself reads as breakage.
    const f = bandFacts(days, NOW + 1_000, NOW, bot);
    expect(f.window).toBe(true);
    expect(f.commits).toBe(1);        // the window's, not the gap's
    expect(f.keys).toEqual([dk(0)]);  // so there are still sentences to print
  });
  it("keeps the gap's own floor in the fallback — the wording is about your visit", () => {
    const since = NOW + 1_000;
    const f = bandFacts(days, since, NOW, bot);
    expect(f.quiet).toBe(true);       // "nothing new since <when>"
    expect(f.since).toBe(since);
    expect(f.first).toBe(false);      // a caught-up visit is not a first look
  });
  it("leaves a first look and a capped stamp exactly as they were", () => {
    // Both already count the window, so there is nothing to fall back to.
    expect(bandFacts(days, 0, NOW, bot)).toEqual(sinceFacts(days, 0, NOW, bot));
    const old = NOW - 90 * 86_400_000;
    expect(bandFacts(days, old, NOW, bot)).toEqual(sinceFacts(days, old, NOW, bot));
  });
  it("marks a first look and a capped stamp as the window's figures", () => {
    expect(bandFacts(days, 0, NOW, bot).window).toBe(true);
    expect(bandFacts(days, NOW - 90 * 86_400_000, NOW, bot).window).toBe(true);
  });
  it("has nothing to fall back to for a project with no days, and says so without throwing", () => {
    const f = bandFacts([], NOW, NOW, bot);
    expect(f.quiet).toBe(true);
    expect(f.commits).toBe(0);
  });
});

describe("dayCard — what a clicked bar says", () => {
  const cs = (n: number) => Array.from({ length: n }, (_, i) =>
    commit({ sha: `${i}`.repeat(8) + "abcdef", author: "Tim", subject: `commit ${i}` }));

  it("leads with the figures the bar was drawn from", () => {
    const d = tday(0, { cost: 2.4, sessions: [sess("a")], commits: cs(3) });
    expect(dayCard(d).tally).toBe("3 commits · 1 session · $2.40");
  });
  it("leaves out a figure the day has nothing of, rather than printing a zero", () => {
    expect(dayCard(tday(0, { commits: cs(1) })).tally).toBe("1 commit");
  });
  it("still answers for a day nothing is recorded on — a quiet bar is clickable too", () => {
    const card = dayCard(undefined);
    expect(card.tally).toBe("0 commits");
    // The one door out survives an empty day: ./menu drops the two groups with no items.
    expect(card.groups.flatMap((g) => g.items).map((i) => i.id)).toEqual(["graph"]);
  });
  it("counts the tail instead of printing it, and the count is never pickable", () => {
    const rows = dayCard(tday(0, { commits: cs(DAY_ROWS + 5) })).groups[0].items;
    expect(rows).toHaveLength(DAY_ROWS + 1);
    expect(rows[DAY_ROWS]).toMatchObject({ label: "+5 more", disabled: true });
  });
  it("carries every character git kept in the pick, and seven in the row", () => {
    // `git_log_days` keeps 9; the row has no width for them and `git show` needs more than 7.
    const row = dayCard(tday(0, { commits: cs(1) })).groups[0].items[0];
    expect(row.id).toBe("sha:00000000abcdef");
    expect(row.sub).toBe("0000000 · Tim");
  });
  it("names a subjectless commit by its sha rather than by nothing at all", () => {
    const row = dayCard(tday(0, { commits: [commit({ sha: "deadbeefcafe", subject: "" })] })).groups[0].items[0];
    expect(row.label).toBe("deadbee");
  });
  it("shows a session and does not offer it — there is nowhere for it to go yet", () => {
    const rows = dayCard(tday(0, { sessions: [sess("a")] })).groups[1].items;
    expect(rows).toHaveLength(1);
    expect(rows[0].disabled).toBe(true);
  });
});

describe("sinceFacts — what moved while you were away", () => {
  const ago = (back: number) => (NOW - back * 86_400_000) / 1000;
  const days = [
    tday(0, { cost: 4, sessions: [sess("a")], commits: [commit({ sha: "c1", author: "Tim" })] }),
    tday(2, { cost: 1, sessions: [sess("b", 2)],
              commits: [commit({ sha: "c2", author: "dependabot[bot]", when: ago(2) })] }),
  ];

  it("calls a project with no stamp a first look, which is not a capped window", () => {
    // Two different facts with two different wordings: neither may be told as the other.
    const f = sinceFacts(days, 0, NOW, bot);
    expect(f.first).toBe(true);
    expect(f.capped).toBe(false);
    expect(f.days).toBe(0);
  });
  it("caps when the stamp predates the window, because the figures are then the window's", () => {
    expect(sinceFacts(days, NOW - 10 * 86_400_000, NOW, bot).capped).toBe(true);
    expect(sinceFacts(days, NOW - 86_400_000, NOW, bot).capped).toBe(false);
  });
  it("cuts the window at the instant you left, not at that morning's midnight", () => {
    // The whole-day rule this replaced re-counted everything you had already seen, so
    // "Mark read" on a busy afternoon moved no figure and looked like a dead button.
    const noon = new Date(NOW).setHours(12, 0, 0, 0);
    const d = tday(0, { commits: [
      commit({ sha: "early", author: "Tim", when: (noon - 3_600_000) / 1000 }),
      commit({ sha: "late", author: "Tim", when: (noon + 3_600_000) / 1000 }),
    ] });
    expect(sinceFacts([d], noon, NOW, bot).commits).toBe(1);
    expect(sinceFacts([d], noon + 7_200_000, NOW, bot).commits).toBe(0);
  });
  it("goes quiet only when nothing at all is left in the window", () => {
    // What "Mark read" produces, and the one state the band draws as a single line.
    expect(sinceFacts(days, 0, NOW, bot).quiet).toBe(false);
    expect(sinceFacts(days, NOW, NOW, bot).quiet).toBe(true);
    expect(sinceFacts([], NOW, NOW, bot).quiet).toBe(true);
  });
  it("credits a day's spend only once the whole day is in the window", () => {
    // `cc-usage` is one figure a day and cannot be split, so the day you left is dropped
    // rather than have the hour since you left charged with the whole of it.
    const d = tday(0, { cost: 9 });
    expect(sinceFacts([d], d.when, NOW, bot).spend).toBe(9);
    expect(sinceFacts([d], d.when + 1, NOW, bot).spend).toBe(0);
  });
  it("keeps in-range days newest first and drops the rest", () => {
    const f = sinceFacts(days, NOW - 86_400_000, NOW, bot);
    expect(f.keys).toEqual([dk(0)]);
    expect(f.days).toBe(1);
  });
  it("counts a bot's commit but never names it as somebody you worked with", () => {
    const f = sinceFacts(days, 0, NOW, bot);
    expect(f.commits).toBe(2);
    expect(f.authors).toEqual(["Tim"]);
  });
  it("ranks authors busiest first, ties by name so a repaint never reorders", () => {
    const busy = [tday(0, { commits: [
      commit({ sha: "x1", author: "Tim" }), commit({ sha: "x2", author: "Tim" }),
      commit({ sha: "x3", author: "Ada" }), commit({ sha: "x4", author: "Zoe" }),
      commit({ sha: "x5", author: "bot[bot]" }),
    ] })];
    expect(sinceFacts(busy, 0, NOW, bot).authors).toEqual(["Tim", "Ada", "Zoe"]);
  });
  it("sums the day's own cost, never the fleet's", () => {
    const f = sinceFacts(days, 0, NOW, bot);
    expect(f.spend).toBe(5);
    expect(f.sessions).toBe(2);
  });
  it("is zeroed rather than thrown for a project with no days at all", () => {
    const f = sinceFacts([], NOW - 86_400_000, NOW, bot);
    expect(f).toEqual({ first: false, since: NOW - 86_400_000, capped: false, days: 1, keys: [], commits: 0, sessions: 0, spend: 0, authors: [], quiet: true, window: false });
  });
});
