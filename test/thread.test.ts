import { describe, it, expect } from "vitest";
import "./localstorage"; // ./grouping reads cc-* at import time
import type { DiffStat, Phase, Sess } from "../src/types";
import type { Note } from "../src/notes";
import { urgencyRank } from "../src/grouping";
import {
  bandsOf, buildThreads, dispatchable, fromBranchBehind, fromNote, fromSession,
  fromGh, groupThreads, initials, inProject, recencyGroups, recencyOf, sortThreads,
  threadBand, threadRank, type GhThread, type Thread,
} from "../src/thread";

// A Sess is large and mostly irrelevant here; only the fields the adapters read are
// meaningful, so the rest is filled with inert values rather than mocked.
const sess = (over: Partial<Sess> & { id: string }): Sess => ({
  project: "episko", accent: "#a78bfa", workdir: "/w/episko", colorKey: "/w/episko",
  resumeId: over.id, branch: "dev", worktree: null, title: "a session",
  phase: "idle" as Phase, phaseSince: 1000, lastActivity: 1000, attention: null,
  pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
  model: "opus", ctxPct: null, ctxTokens: null, cost: 1, durMs: null,
  curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
  lastEvent: "", activity: [], kind: "claude", external: false,
  pane: null as unknown as HTMLElement,
  ...over,
});

const note = (over: Partial<Note> & { id: string }): Note =>
  ({ text: "a note", project: "/w/episko", created: 5000, ...over });

const diff = (over: Partial<DiffStat>): DiffStat => ({
  added: 0, removed: 0, files: 0, untracked: 0, dirty: 0,
  upstream: "origin/main", ahead: 0, behind: 0, ...over,
});

const names = (k: string) => k.split("/").pop() || k;

describe("banding reuses urgencyRank rather than restating it", () => {
  // The point of the assertion: if someone changes urgencyRank, the bands must move
  // with it. A second hardcoded ranking here is exactly the drift this avoids.
  it("defers to urgencyRank for every session phase", () => {
    const cases: [Partial<Sess>, string][] = [
      [{ attention: "rm -rf" }, "needs"],
      [{ phase: "error" }, "needs"],
      [{ phase: "done" }, "move"],
      [{ phase: "working" }, "running"],
      [{ phase: "thinking" }, "running"],
      [{ phase: "idle" }, "open"],
      [{ phase: "ended" }, "open"],
    ];
    for (const [over, band] of cases) {
      const s = sess({ id: "s", ...over });
      const t = fromSession(s);
      expect(threadRank(t)).toBe(urgencyRank(s));
      expect(threadBand(t)).toBe(band);
    }
  });

  it("puts a failed task in 'needs you', like the sidebar does", () => {
    const t = fromSession(sess({ id: "t", kind: "task", phase: "error", run: { label: "pnpm test" } as Sess["run"] }));
    expect(threadBand(t)).toBe("needs");
    expect(t.source).toBe("task");
    expect(t.title).toBe("pnpm test");
  });

  it("ranks an unclaimed thread beside an idle session — unstarted is not urgent", () => {
    expect(threadRank(fromNote(note({ id: "n" }), names))).toBe(urgencyRank(sess({ id: "s", phase: "idle" })));
  });
});

describe("adapters", () => {
  it("describes a blocked session by what it is asking", () => {
    const t = fromSession(sess({ id: "s", attention: "git worktree remove x", phase: "working" }));
    expect(t.state).toBe("Asks: git worktree remove x");
  });

  it("prefers the current tool over a generic 'working'", () => {
    expect(fromSession(sess({ id: "s", phase: "working", curTool: "Edit", curArg: "src/main.ts" })).state)
      .toBe("Edit src/main.ts");
  });

  it("sorts within a band by how long it has been waiting, not by last activity", () => {
    // Two finished turns; the one that finished longer ago is the ruder wait.
    const older = fromSession(sess({ id: "a", phase: "done", phaseSince: 100, lastActivity: 9999 }));
    const newer = fromSession(sess({ id: "b", phase: "done", phaseSince: 900, lastActivity: 1 }));
    expect(sortThreads([newer, older]).map((t) => t.id)).toEqual(["session:a", "session:b"]);
  });

  it("shows unclaimed work newest first — the note you just wrote is the one you meant", () => {
    const old = fromNote(note({ id: "old", created: 10 }), names);
    const fresh = fromNote(note({ id: "new", created: 900 }), names);
    expect(sortThreads([old, fresh]).map((t) => t.id)).toEqual(["note:new", "note:old"]);
  });

  it("keeps an unfiled note, but says why it cannot be dispatched", () => {
    const t = fromNote(note({ id: "n", project: null }), names);
    expect(threadBand(t)).toBe("open");
    expect(dispatchable(t)).toBe(false);
    expect(t.state).toMatch(/pick a project/i);
  });

  it("is honest about whether a behind branch is safe to pull", () => {
    expect(fromBranchBehind("/w/x", "x", diff({ behind: 3 })).state).toMatch(/safe to pull/i);
    expect(fromBranchBehind("/w/x", "x", diff({ behind: 3, dirty: 2 })).state).toMatch(/review before pulling/i);
  });

  it("never offers to dispatch something already running", () => {
    expect(dispatchable(fromSession(sess({ id: "s" })))).toBe(false);
    expect(dispatchable(fromNote(note({ id: "n" }), names))).toBe(true);
  });
});

describe("assembly", () => {
  it("leaves plain shells out — a terminal you opened is not tracked work", () => {
    const threads = buildThreads({
      sessions: [sess({ id: "sh", kind: "shell" }), sess({ id: "cl" })],
      notes: [], dirty: new Map(), projectName: names,
    });
    expect(threads.map((t) => t.id)).toEqual(["session:cl"]);
  });

  it("does not add a behind-branch row for a repo that already has a session", () => {
    const dirty = new Map<string, DiffStat | null>([["/w/episko", diff({ behind: 4 })]]);
    const withSess = buildThreads({ sessions: [sess({ id: "s" })], notes: [], dirty, projectName: names });
    expect(withSess.filter((t) => t.source === "branch")).toHaveLength(0);
    // …but does when nothing is running there.
    const without = buildThreads({ sessions: [], notes: [], dirty, projectName: names });
    expect(without.filter((t) => t.source === "branch")).toHaveLength(1);
  });

  it("ignores a repo that is up to date", () => {
    const dirty = new Map<string, DiffStat | null>([["/w/a", diff({ behind: 0 })], ["/w/b", null]]);
    expect(buildThreads({ sessions: [], notes: [], dirty, projectName: names })).toEqual([]);
  });

  it("orders bands most-urgent first and drops empty ones", () => {
    const threads = buildThreads({
      sessions: [
        sess({ id: "work", phase: "working" }),
        sess({ id: "blocked", attention: "rm -rf" }),
        sess({ id: "done", phase: "done" }),
      ],
      notes: [note({ id: "n" })], dirty: new Map(), projectName: names,
    });
    expect(bandsOf(threads).map((g) => g.band)).toEqual(["needs", "running", "move", "open"]);

    const onlyRunning = buildThreads({
      sessions: [sess({ id: "work", phase: "working" })], notes: [], dirty: new Map(), projectName: names,
    });
    expect(bandsOf(onlyRunning).map((g) => g.band)).toEqual(["running"]);
  });

  it("is stable — two builds of identical state render identically", () => {
    const mk = () => buildThreads({
      sessions: [sess({ id: "a", phase: "done", phaseSince: 5 }), sess({ id: "b", phase: "done", phaseSince: 5 })],
      notes: [note({ id: "n1", created: 7 }), note({ id: "n2", created: 7 })],
      dirty: new Map(), projectName: names,
    });
    expect(mk().map((t) => t.id)).toEqual(mk().map((t) => t.id));
  });
});

describe("the two altitudes are one list and one predicate", () => {
  const threads: Thread[] = buildThreads({
    sessions: [sess({ id: "e" }), sess({ id: "a", project: "api", colorKey: "/w/api" })],
    notes: [note({ id: "n", project: "/w/api" })], dirty: new Map(), projectName: names,
  });

  it("meta altitude keeps everything", () => {
    expect(threads.filter((t) => inProject(t, null))).toHaveLength(3);
  });

  it("project altitude is the same list, filtered", () => {
    const api = threads.filter((t) => inProject(t, "/w/api"));
    expect(api.map((t) => t.id).sort()).toEqual(["note:n", "session:a"]);
    // Banding is unchanged by the filter — the component really is the same one.
    expect(bandsOf(api).map((g) => g.band)).toEqual(["open"]);
  });
});

describe("issues and pull requests", () => {
  const gh = (over: Partial<GhThread> & { number: number }): GhThread => ({
    kind: "issue", title: "a thing", url: "u", assignees: [], labels: [],
    branch: null, author: null, draft: false, updated_at: "2026-07-30T07:48:37Z", ...over,
  });

  it("turns a login into initials, not an avatar", () => {
    // Deliberately initials: the API tells us who was *assigned*, never who is at
    // their desk, and a face would imply liveness we cannot see.
    expect(initials("FAbrahamDev")).toBe("FA");
    expect(initials("tr-evo")).toBe("TR");
    expect(initials("octocat")).toBe("OC");
  });

  it("says who already has it, and distinguishes that from you", () => {
    const mine = fromGh(gh({ number: 1, assignees: ["tr-evo"] }), "/w/e", "e", "tr-evo");
    expect(mine.who).toEqual({ login: "tr-evo", isMe: true });
    expect(mine.state).toBe("Assigned to you");

    const theirs = fromGh(gh({ number: 2, assignees: ["FAbrahamDev"] }), "/w/e", "e", "tr-evo");
    expect(theirs.who).toEqual({ login: "FAbrahamDev", isMe: false });
    expect(theirs.state).toMatch(/already on it/);
    expect(theirs.whoShort).toBe("FA");
  });

  it("lands unclaimed — GitHub knows about assignees, not about agents", () => {
    const t = fromGh(gh({ number: 3 }), "/w/e", "e", "tr-evo");
    expect(t.phase).toBe("unclaimed");
    expect(threadBand(t)).toBe("open");
    expect(dispatchable(t)).toBe(true);
  });

  it("survives a malformed timestamp instead of poisoning the sort with NaN", () => {
    // NaN compares false against everything and would make the order non-deterministic.
    const t = fromGh(gh({ number: 4, updated_at: "not a date" }), "/w/e", "e", null);
    expect(t.since).toBe(0);
    expect(sortThreads([t]).length).toBe(1);
  });

  it("shows a PR's head branch, which is what links it to a local checkout", () => {
    const t = fromGh(gh({ number: 42, kind: "pr", branch: "feat/x", author: "FAbrahamDev" }), "/w/e", "e", "tr-evo");
    expect(t.source).toBe("pr");
    expect(t.where).toBe("⎇ feat/x");
    expect(t.id).toBe("pr:/w/e:42");
  });

  it("hides a PR whose branch a live session is already on", () => {
    // Two rows for one piece of work, and the pane is the more truthful of the two.
    const ghMap = new Map([["/w/episko", {
      threads: [gh({ number: 42, kind: "pr", branch: "feat/x" }), gh({ number: 7 })],
      viewer: "tr-evo",
    }]]);
    const threads = buildThreads({
      sessions: [sess({ id: "s", branch: "feat/x" })], notes: [], dirty: new Map(),
      projectName: names, gh: ghMap,
    });
    expect(threads.filter((t) => t.source === "pr")).toHaveLength(0);
    expect(threads.filter((t) => t.source === "issue")).toHaveLength(1);
  });

  it("keeps a PR whose branch nothing is checked out on", () => {
    const ghMap = new Map([["/w/episko", {
      threads: [gh({ number: 42, kind: "pr", branch: "feat/other" })], viewer: null,
    }]]);
    const threads = buildThreads({
      sessions: [sess({ id: "s", branch: "feat/x" })], notes: [], dirty: new Map(),
      projectName: names, gh: ghMap,
    });
    expect(threads.filter((t) => t.source === "pr")).toHaveLength(1);
  });
});

describe("two ways to read the same list", () => {
  const NOW = 1_700_000_000_000;
  const ago = (ms: number) => NOW - ms;
  const t = (id: string, since: number): Thread => ({
    id, source: "note", title: id, project: "e", colorKey: "/w/e", where: "", state: "",
    phase: "unclaimed", since, cost: null,
  });

  it("buckets by how recent, coarsely and in human terms", () => {
    const groups = recencyGroups([
      t("today", ago(2 * 3600e3)),
      t("twoDays", ago(2 * 24 * 3600e3)),
      t("fiveDays", ago(5 * 24 * 3600e3)),
      t("ages", ago(90 * 24 * 3600e3)),
    ], NOW);
    expect(groups.map((g) => g.id)).toEqual(["today", "3d", "week", "older"]);
    expect(groups[0].threads[0].id).toBe("today");
  });

  it("drops empty buckets rather than rendering blank headers", () => {
    expect(recencyGroups([t("a", ago(1000))], NOW).map((g) => g.id)).toEqual(["today"]);
  });

  it("files an ageless row with the oldest — it is the one you haven't looked at", () => {
    expect(recencyOf(t("x", 0), NOW).id).toBe("older");
  });

  it("sorts newest first inside a bucket", () => {
    const groups = recencyGroups([t("old", ago(20 * 3600e3)), t("new", ago(1000))], NOW);
    expect(groups[0].threads.map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("urgency grouping still defers to urgencyRank", () => {
    const groups = groupThreads([
      fromSession(sess({ id: "blocked", attention: "x" })),
      fromSession(sess({ id: "work", phase: "working" })),
    ], "urgency");
    expect(groups.map((g) => g.id)).toEqual(["needs", "running"]);
  });

  it("the two modes are the same threads, only regrouped", () => {
    const list = [t("a", ago(1000)), fromSession(sess({ id: "b", phase: "working" }))];
    const count = (gs: ReturnType<typeof groupThreads>) => gs.reduce((n, g) => n + g.threads.length, 0);
    expect(count(groupThreads(list, "urgency", NOW))).toBe(count(groupThreads(list, "recency", NOW)));
  });
});
