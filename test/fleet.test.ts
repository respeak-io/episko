import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import "./localstorage"; // must precede the subject imports (state.ts reads it at load)
import { sessions, setDormants, setFavorites } from "../src/state";
import {
  fleetCards, fleetSorted, fleetTally,
  type FleetCard, type FleetInput,
} from "../src/fleet";
import type { ProjGroup } from "../src/grouping";
import type { HistEntry } from "../src/history";
import type { TrailCommit } from "../src/trail";
import type { DiffStat, Sess } from "../src/types";

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
const input = (o: Partial<FleetInput> = {}): FleetInput => ({
  projects: [], commits: [], hist: [], dirty: new Map(), costFor: () => 0,
  attnPending: () => false, urgency: () => 6, now: NOW, ...o,
});
const card = (o: Partial<FleetCard> = {}): FleetCard => ({
  path: "/w/epi", name: "epi", accent: "#fff", live: 0, needs: 0, urgency: 99,
  dirty: null, lastCommit: 0, lastSession: 0, commits: 0, spend: 0, ...o,
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
      live: 0, needs: 0, urgency: 99, lastCommit: 0, lastSession: 0, commits: 0, spend: 0,
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

describe("fleetTally", () => {
  it("sums the fleet and keeps dirty and unread apart", () => {
    const cards = [
      card({ path: "/w/a", live: 2, needs: 1, dirty: stat({ dirty: 4 }) }),
      card({ path: "/w/b", live: 1, dirty: undefined }),
      card({ path: "/w/c", live: 0, needs: 2, dirty: stat() }),
    ];
    expect(fleetTally(cards)).toEqual({ projects: 3, live: 3, needs: 3, dirty: 1, unread: 1 });
  });
  it("zeroes everything for an empty fleet rather than fabricating a row", () => {
    expect(fleetTally([])).toEqual({ projects: 0, live: 0, needs: 0, dirty: 0, unread: 0 });
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
