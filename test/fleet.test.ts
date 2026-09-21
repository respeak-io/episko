import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import "./localstorage"; // must precede the subject imports (state.ts reads it at load)
import { sessions, setDormants, setFavorites } from "../src/state";
import {
  fleetCards, fleetSections, fleetSorted, fleetTally, needsSplit, TOP_LEVEL,
  type FleetCard, type FleetInput,
} from "../src/fleet";
import { NO_GROUPS, type GroupDef, type GroupStore } from "../src/projgroups";
import type { ProjGroup } from "../src/grouping";
import type { HistEntry } from "../src/history";
import type { TrailCommit } from "../src/trail";
import type { DiffStat, Sess, WtHead } from "../src/types";

const NOW = new Date(2026, 6, 31, 14, 0, 0).getTime(); // 31 Jul 2026, local
const secs = (msBack: number) => (NOW - msBack) / 1000;

const grp = (o: Partial<ProjGroup> = {}): ProjGroup =>
  ({ name: "epi", path: "/w/epi", accent: "#fff", sessions: [], externals: [], dormants: [], ...o });
// Only the injected `attnPending`/`urgency` ever read a session here, so a card carries the fields they take.
const sess = (id: string, o: Partial<Sess> = {}): Sess => ({ id, phase: "idle", ...o } as Sess);
const stat = (o: Partial<DiffStat> = {}): DiffStat =>
  ({ added: 0, removed: 0, files: 0, untracked: 0, dirty: 0, upstream: null, ahead: 0, behind: 0, ...o });
const commit = (o: Partial<TrailCommit> = {}): TrailCommit =>
  ({ sha: "abc1234", author: "Tim", when: secs(0), subject: "a commit", root: "/w/epi", ...o });
const hist = (o: Partial<HistEntry> = {}): HistEntry => ({
  provider: "claude", session_id: "h1", cwd: "/w/epi", project: "epi", branch: "main",
  title: "", last_prompt: "", last_active: secs(0), bytes: 10, exists: true, repo_root: "/w/epi", ...o,
});
const head = (o: Partial<WtHead> = {}): WtHead =>
  ({ path: "/w/epi", branch: "main", is_main: true, exists: true, ...o });
const input = (o: Partial<FleetInput> = {}): FleetInput => ({
  projects: [], commits: [], hist: [], heads: new Map(), dirty: new Map(), costFor: () => 0,
  groups: NO_GROUPS, attnPending: () => false, urgency: () => 6, days: 7, now: NOW, ...o,
});
const card = (o: Partial<FleetCard> = {}): FleetCard => ({
  path: "/w/epi", name: "epi", accent: "#fff", group: null, live: 0, needs: 0, urgency: 99,
  dirty: null, branch: "", checkouts: 0, lastCommit: 0, lastSession: 0,
  commits: 0, sessions: 0, spend: 0, ...o,
});
const paths = (l: FleetCard[]) => l.map((c) => c.path);

beforeEach(() => {
  // histProject resolves through the live maps; an empty fleet makes the join deterministic.
  sessions.clear(); setDormants([]); setFavorites([]);
});

describe("fleetCards — one card per project, from data the frontend already holds", () => {
  it("gives a project with no sessions and no commits a card: a favourite is a project", () => {
    const [c] = fleetCards(input({ projects: [grp()] }));
    expect(c).toMatchObject({
      path: "/w/epi", name: "epi", accent: "#fff",
      live: 0, needs: 0, urgency: 99, branch: "", checkouts: 0,
      lastCommit: 0, lastSession: 0, commits: 0, sessions: 0, spend: 0,
    });
  });
  it("counts the live sessions, the ones that need you, and takes the most urgent rank", () => {
    const busy = sess("a"), asking = sess("b");
    const c = fleetCards(input({
      projects: [grp({ sessions: [busy, asking] })],
      attnPending: (s) => s === asking,
      urgency: (s) => (s === asking ? 0 : 3),
    }))[0];
    expect(c).toMatchObject({ live: 2, needs: 1, urgency: 0 });
  });
  it("joins a worktree group's commits by its repo root, not by its checkout folder", () => {
    const c = fleetCards(input({
      projects: [grp({ path: "/w/epi-wt", repoRoot: "/w/epi" })],
      commits: [commit({ when: secs(0) }), commit({ when: secs(60_000) }), commit({ root: "/w/other" })],
    }))[0];
    expect(c).toMatchObject({ commits: 2, lastCommit: NOW });
  });
  it("takes the newest past session through histProject's colorKey", () => {
    const c = fleetCards(input({
      projects: [grp()],
      hist: [hist({ last_active: secs(86_400_000) }), hist({ session_id: "h2", last_active: secs(0) }),
        hist({ session_id: "h3", cwd: "/w/other", repo_root: "/w/other" })],
    }))[0];
    expect(c.lastSession).toBe(NOW);
  });
  it("asks costFor by project NAME, and a project with no detail record spends 0", () => {
    const cards = fleetCards(input({
      projects: [grp(), grp({ name: "other", path: "/w/other" })],
      costFor: (n) => (n === "epi" ? 4.5 : 0),
    }));
    expect(cards.map((c) => c.spend)).toEqual([4.5, 0]);
  });
});

describe("the branch and the checkouts come from worktree_heads, by repo root", () => {
  it("takes the MAIN checkout's branch: every other figure on the card is that folder's", () => {
    const c = fleetCards(input({
      projects: [grp()],
      heads: new Map([["/w/epi", [head({ branch: "wip", is_main: false, path: "/w/epi-wt" }), head({ branch: "dev" })]]]),
    }))[0];
    expect(c).toMatchObject({ branch: "dev", checkouts: 2 });
  });
  it("leaves a folder nothing could read blank rather than inventing a branch", () => {
    const c = fleetCards(input({ projects: [grp()], heads: new Map([["/w/other", [head()]]]) }))[0];
    expect(c).toMatchObject({ branch: "", checkouts: 0 });
  });
  it("keys the lookup on the repo root, as the commits are", () => {
    const c = fleetCards(input({
      projects: [grp({ path: "/w/epi-wt", repoRoot: "/w/epi" })],
      heads: new Map([["/w/epi", [head({ branch: "dev" })]]]),
    }))[0];
    expect(c.branch).toBe("dev");
  });
});

describe("sessions — the ones inside the window, never the whole scan", () => {
  it("counts a project's past sessions in range and drops the older ones", () => {
    const c = fleetCards(input({
      projects: [grp()], days: 7,
      hist: [
        hist({ last_active: secs(0) }),
        hist({ session_id: "h2", last_active: secs(3 * 86_400_000) }),
        hist({ session_id: "h3", last_active: secs(30 * 86_400_000) }),
      ],
    }))[0];
    // The 30-day-old one is still the newest-session join's business, just not the count's.
    expect(c).toMatchObject({ sessions: 2, lastSession: NOW });
  });
});

describe("needsSplit — the Needs you tile's sub-line", () => {
  it("leads with asking, the only one of the three holding a process open", () => {
    expect(needsSplit(["done", "error", "attention"])).toBe("1 asking, 1 done, 1 failed");
  });
  it("plurals each count and drops the kinds with nothing in them", () => {
    expect(needsSplit(["done", "done"])).toBe("2 done");
    expect(needsSplit(["attention", "error", "error"])).toBe("1 asking, 2 failed");
  });
  it("says so in words when nothing is waiting: a blank sub-line reads as broken", () => {
    expect(needsSplit([])).toBe("nothing waiting");
  });
});

describe("dirty — three states, and `undefined` is the one that matters", () => {
  it("leaves a folder no sweep has reached undefined, never clean", () => {
    const c = fleetCards(input({ projects: [grp()], dirty: new Map([["/w/other", stat()]]) }))[0];
    expect(c.dirty).toBeUndefined();
    expect(fleetTally([c])).toMatchObject({ unread: 1, dirty: 0 });
  });
  it("reads the map by FOLDER, so a worktree answers for its own checkout", () => {
    const c = fleetCards(input({
      projects: [grp({ path: "/w/epi-wt", repoRoot: "/w/epi" })],
      dirty: new Map([["/w/epi", stat({ dirty: 9 })], ["/w/epi-wt", stat({ dirty: 2 })]]),
    }))[0];
    expect(c.dirty?.dirty).toBe(2);
  });
  it("counts a swept folder as dirty only when it has uncommitted work", () => {
    const swept = fleetCards(input({
      projects: [grp(), grp({ name: "b", path: "/w/b" }), grp({ name: "c", path: "/w/c" })],
      dirty: new Map([["/w/epi", stat({ dirty: 3 })], ["/w/b", stat()], ["/w/c", null]]),
    }));
    expect(fleetTally(swept)).toMatchObject({ projects: 3, dirty: 1, unread: 0 });
  });
});

describe("fleetSorted", () => {
  it("attention takes urgency first, then the needs-you count, then the newest session", () => {
    const cards = [
      card({ path: "/w/quiet", urgency: 6 }),
      card({ path: "/w/old", urgency: 2, needs: 1, lastSession: NOW - 86_400_000 }),
      card({ path: "/w/asking", urgency: 0 }),
      card({ path: "/w/fresh", urgency: 2, needs: 1, lastSession: NOW }),
      card({ path: "/w/two", urgency: 2, needs: 2 }),
    ];
    expect(paths(fleetSorted(cards, "attention")))
      .toEqual(["/w/asking", "/w/two", "/w/fresh", "/w/old", "/w/quiet"]);
  });
  it("recent takes whichever of the last commit and the last session is newer", () => {
    const cards = [
      card({ path: "/w/a", lastCommit: NOW - 86_400_000, lastSession: 0 }),
      card({ path: "/w/b", lastCommit: 0, lastSession: NOW }),
      card({ path: "/w/c" }),
    ];
    expect(paths(fleetSorted(cards, "recent"))).toEqual(["/w/b", "/w/a", "/w/c"]);
  });
  it("name is a localeCompare over the project name, not the path", () => {
    const cards = [card({ path: "/z/one", name: "api" }), card({ path: "/a/two", name: "Zed" }),
      card({ path: "/m/three", name: "epi" })];
    expect(paths(fleetSorted(cards, "name"))).toEqual(["/z/one", "/m/three", "/a/two"]);
  });
  it("ends every sort on the path, so a repaint of unchanged state never reorders", () => {
    const cards = [card({ path: "/w/b" }), card({ path: "/w/a" })];
    for (const s of ["attention", "recent", "name"] as const) {
      expect(paths(fleetSorted(cards, s))).toEqual(["/w/a", "/w/b"]);
    }
  });
  it("returns a new array and leaves its input alone", () => {
    const cards = [card({ path: "/w/b" }), card({ path: "/w/a" })];
    const out = fleetSorted(cards, "name");
    expect(out).not.toBe(cards);
    expect(paths(cards)).toEqual(["/w/b", "/w/a"]);
  });
});

describe("fleetSections — the sidebar's own groups, over the cards", () => {
  const gdef = (id: string, name: string): GroupDef => ({ id, name, collapsed: false });
  const store = (of: Record<string, string>, ...groups: GroupDef[]): GroupStore => ({ groups, of });
  const names = (l: { name: string }[]) => l.map((s) => s.name);

  it("files a card by its own path", () => {
    const [c] = fleetCards(input({
      projects: [grp()], groups: store({ "/w/epi": "g1" }, gdef("g1", "Work")),
    }));
    expect(c.group).toBe("g1");
  });
  it("falls back to the repo the checkout belongs to, as the sidebar's foldIdOf does", () => {
    const [c] = fleetCards(input({
      projects: [grp({ path: "/w/epi-wt", repoRoot: "/w/epi" })],
      groups: store({ "/w/epi": "g1" }, gdef("g1", "Work")),
    }));
    expect(c.group).toBe("g1");
  });
  it("leaves a project filed nowhere ungrouped", () => {
    const cards = fleetCards(input({
      projects: [grp()], groups: store({ "/w/other": "g1" }, gdef("g1", "Work")),
    }));
    expect(cards[0].group).toBeNull();
  });
  // `groupOf` reports what the store says; `clampGroups` is what drops a membership pointing
  // at a group that no longer exists, and ./state runs every write through it.
  it("carries a dangling id rather than second-guessing the store, and sections absorb it", () => {
    const [c] = fleetCards(input({
      projects: [grp()], groups: store({ "/w/epi": "gone" }, gdef("g1", "Work")),
    }));
    expect(c.group).toBe("gone");
    expect(fleetSections([c], [gdef("g1", "Work")])).toEqual([{ name: TOP_LEVEL, cards: [c] }]);
  });

  it("puts every run where its first member sits, so the switch reorders nothing", () => {
    const cards = [
      card({ path: "/w/a", group: null }), card({ path: "/w/b", group: "g1" }),
      card({ path: "/w/c", group: null }), card({ path: "/w/d", group: "g1" }),
    ];
    const secs = fleetSections(cards, [gdef("g1", "Work")]);
    expect(names(secs)).toEqual([TOP_LEVEL, "Work"]);
    expect(secs.map((x) => paths(x.cards))).toEqual([["/w/a", "/w/c"], ["/w/b", "/w/d"]]);
  });
  it("drops a group nothing is filed in: here it is a heading over nothing", () => {
    const secs = fleetSections([card({ group: "g1" })], [gdef("g1", "Work"), gdef("g2", "Empty")]);
    expect(names(secs)).toEqual(["Work"]);
  });
  it("keeps two groups of one name apart, since the id is what files a card", () => {
    const secs = fleetSections(
      [card({ path: "/w/a", group: "g1" }), card({ path: "/w/b", group: "g2" })],
      [gdef("g1", "Work"), gdef("g2", "Work")]);
    expect(secs.map((x) => paths(x.cards))).toEqual([["/w/a"], ["/w/b"]]);
  });
  it("loses no card, whatever the store says", () => {
    const cards = [card({ path: "/w/a", group: "g1" }), card({ path: "/w/b", group: "gone" }),
      card({ path: "/w/c", group: null })];
    const secs = fleetSections(cards, [gdef("g1", "Work")]);
    expect(secs.flatMap((x) => paths(x.cards)).sort()).toEqual(["/w/a", "/w/b", "/w/c"]);
    expect(names(secs)).toEqual(["Work", TOP_LEVEL]);
  });
  it("answers nothing for an empty fleet rather than one empty run", () => {
    expect(fleetSections([], [gdef("g1", "Work")])).toEqual([]);
  });
});

describe("fleetTally", () => {
  it("sums the fleet and keeps dirty and unread apart", () => {
    const cards = [
      card({ path: "/w/a", live: 2, needs: 1, dirty: stat({ dirty: 4 }) }),
      card({ path: "/w/b", live: 1, dirty: undefined }),
      card({ path: "/w/c", live: 0, needs: 2, dirty: stat() }),
    ];
    expect(fleetTally(cards))
      .toEqual({ projects: 3, checkouts: 3, live: 3, liveProjects: 2, needs: 3, dirty: 1, unread: 1 });
  });
  it("zeroes everything for an empty fleet rather than fabricating a row", () => {
    expect(fleetTally([]))
      .toEqual({ projects: 0, checkouts: 0, live: 0, liveProjects: 0, needs: 0, dirty: 0, unread: 0 });
  });
});

// Read the source: the predicate is injected, so nothing this file can call would notice the
// pane handing it the raw fact — and then one screen would carry two figures for one set.
describe("the pane counts at the user, never the raw fact", () => {
  const src = readFileSync(new URL("../src/fleetui.ts", import.meta.url), "utf8");
  it("injects ./grouping's attnPending, the set `needsYouSessions` draws", () => {
    expect(src).toMatch(/\battnPending,\s*urgency: urgencyRank\b/);
    expect(src).not.toMatch(/\bneedsYou\b(?!Sessions)/);
  });
});
