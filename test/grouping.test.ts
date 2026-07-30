import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ExtSession, Restorable, Sess } from "../src/types";
import { store } from "./localstorage"; // must precede the subject imports
import {
  accentFor, colorOverrides, sessions, setDormants, setExternals, setFavorites,
  setProjOrder, setSortMode, setWtGroup,
} from "../src/state";
import {
  allProjects, clusterByWorktree, foldRunGroups, groupPhase, needsYou, needsYouSessions,
  nextAfterClose, orderedSessions, projectList, reactorLabel, reactorState,
  splitByWorktree, urgencyRank, type ProjGroup,
} from "../src/grouping";
import { taskPrefs } from "../src/tasks";

const NOW_MS = 1800000000000; // 2027-01-15T08:00:00Z

// A Sess as newSession() builds one, minus the DOM/xterm handles nothing here reads.
function sess(o: Partial<Sess> = {}): Sess {
  return {
    id: "sid", project: "epi", accent: "#fff", workdir: "/w/epi", colorKey: "/w/epi",
    resumeId: "sid", branch: "main", worktree: null, title: "",
    phase: "idle", phaseSince: 0, lastActivity: 0, attention: null,
    pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [],
    git: null, res: null, lastEvent: "", activity: [],
    kind: "claude", external: false, ...o,
  } as Sess;
}
// Sessions reach grouping through the state map, in insertion order.
function open(...list: Sess[]): Sess[] { for (const s of list) sessions.set(s.id, s); return list; }
const ext = (o: Partial<ExtSession> = {}): ExtSession =>
  ({ pid: 1, session_id: "e1", cwd: "/w/epi", name: "epi", status: "idle", version: "2.1", ...o });
const dorm = (o: Partial<Restorable> = {}): Restorable =>
  ({ id: "d1", resumeId: "d1", project: "epi", workdir: "/w/epi", colorKey: "/w/epi",
     worktree: null, branch: "main", title: "", lastActivity: 0, ...o });
// A ProjGroup as allProjects() builds one, for the two functions that take one.
const grp = (o: Partial<ProjGroup> = {}): ProjGroup =>
  ({ name: "epi", path: "/w/epi", accent: "#fff", sessions: [], externals: [], dormants: [], ...o });
const names = (l: ProjGroup[]) => l.map((p) => p.path);
const ids = (l: Sess[]) => l.map((s) => s.id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  sessions.clear();
  setExternals([]); setDormants([]); setFavorites([]); setProjOrder([]);
  setSortMode("manual"); setWtGroup("off");
  for (const k of Object.keys(colorOverrides)) delete colorOverrides[k];
  taskPrefs.attention = true; // needsYou reads it; restore the shipped default
  store.clear();
});
afterEach(() => { vi.useRealTimers(); });

describe("clusterByWorktree — one cluster per checkout dir", () => {
  it("buckets sessions by workdir, in first-appearance order", () => {
    const p = grp({ sessions: [
      sess({ id: "a", workdir: "/w/wt-b", branch: "b" }),
      sess({ id: "b", workdir: "/w/epi", branch: "main" }),
      sess({ id: "c", workdir: "/w/wt-b", branch: "b" }),
    ] });
    const cl = clusterByWorktree(p);
    expect(cl.map((c) => c.key)).toEqual(["/w/wt-b", "/w/epi"]); // order follows the sorted session list
    expect(ids(cl[0].sessions)).toEqual(["a", "c"]);
    expect(ids(cl[1].sessions)).toEqual(["b"]);
  });
  /// The bug this exists for: a task's `workdir` is where the *task* runs, and VS Code
  /// tasks routinely declare a subfolder (`options.cwd: 01_frontend`). Keying clusters
  /// on that gave one chain three "worktree" headers, all with the same branch on them,
  /// and — because the run-group fold happens inside a cluster — stopped the members of
  /// one launch from ever folding into a single row.
  it("clusters a task pane by its checkout, not by the subfolder it runs in", () => {
    const wt = "/w/wt-feat";
    const p = grp({ sessions: [
      sess({ id: "agent", workdir: wt, branch: "feat" }),
      taskSess("fe", { workdir: wt + "/01_frontend", branch: "feat" }, { root: wt, groupId: "g1", groupLabel: "Dev" }),
      taskSess("be", { workdir: wt + "/02_backend", branch: "feat" }, { root: wt, groupId: "g1", groupLabel: "Dev" }),
    ] });
    const cl = clusterByWorktree(p);
    expect(cl.map((c) => c.key)).toEqual([wt]);
    expect(ids(cl[0].sessions)).toEqual(["agent", "fe", "be"]);
    // And therefore the two run panes can actually fold into one row.
    const items = foldRunGroups(cl[0].sessions);
    expect(items.map((i) => (i.kind === "group" ? "GROUP" : i.s.id))).toEqual(["agent", "GROUP"]);
  });
  it("falls back to a task pane's workdir when it has no discovery root", () => {
    const p = grp({ sessions: [taskSess("t", { workdir: "/w/other" }, { root: "" })] });
    expect(clusterByWorktree(p).map((c) => c.key)).toEqual(["/w/other"]);
  });
  it("marks only the cluster at the project path as main", () => {
    const p = grp({ sessions: [sess({ id: "a", workdir: "/w/epi" }), sess({ id: "b", workdir: "/w/wt" })] });
    expect(clusterByWorktree(p).map((c) => c.isMain)).toEqual([true, false]);
  });
  it("treats a session with no workdir as the root checkout", () => {
    const p = grp({ sessions: [sess({ id: "a", workdir: "" })] });
    expect(clusterByWorktree(p)[0]).toMatchObject({ key: "/w/epi", isMain: true });
  });
  it("falls back to s.worktree when the live branch hasn't arrived yet", () => {
    // branch is filled from git after launch; worktree is what we launched with.
    const p = grp({ sessions: [sess({ id: "a", workdir: "/w/wt", branch: "", worktree: "feature" })] });
    expect(clusterByWorktree(p)[0].branch).toBe("feature");
  });
  it("backfills a cluster's branch from a later session that knows it", () => {
    const p = grp({ sessions: [
      sess({ id: "a", workdir: "/w/wt", branch: "", worktree: null }),
      sess({ id: "b", workdir: "/w/wt", branch: "feature" }),
    ] });
    expect(clusterByWorktree(p)[0].branch).toBe("feature");
  });
  it("does not let a later session rename a cluster that already has a branch", () => {
    const p = grp({ sessions: [
      sess({ id: "a", workdir: "/w/wt", branch: "feature" }),
      sess({ id: "b", workdir: "/w/wt", branch: "something-else" }),
    ] });
    expect(clusterByWorktree(p)[0].branch).toBe("feature");
  });
  it("labels an unbranded root cluster 'main' and any other by its folder", () => {
    const p = grp({ sessions: [
      sess({ id: "a", workdir: "/w/epi", branch: "", worktree: null }),
      sess({ id: "b", workdir: "/w/wt-x", branch: "", worktree: null }),
    ] });
    expect(clusterByWorktree(p).map((c) => c.branch)).toEqual(["main", "wt-x"]);
  });
  it("clusters externals alongside the sessions sharing their checkout", () => {
    const p = grp({
      sessions: [sess({ id: "a", workdir: "/w/wt", branch: "feature" })],
      externals: [ext({ session_id: "e1", cwd: "/w/wt" }), ext({ session_id: "e2", cwd: "/w/epi" })],
    });
    const cl = clusterByWorktree(p);
    expect(cl).toHaveLength(2);
    expect(cl[0]).toMatchObject({ key: "/w/wt" });
    expect(cl[0].externals.map((e) => e.session_id)).toEqual(["e1"]);
    expect(cl[1]).toMatchObject({ key: "/w/epi", isMain: true });
    expect(cl[1].externals.map((e) => e.session_id)).toEqual(["e2"]);
  });
  it("takes a cluster's branch from an external when no session carries one", () => {
    const p = grp({ externals: [ext({ cwd: "/w/wt", branch: "feature" })] });
    expect(clusterByWorktree(p)[0].branch).toBe("feature");
  });
});

describe("splitByWorktree — toplevel mode explodes a multi-checkout project", () => {
  it("passes a single-checkout project through untouched", () => {
    const p = grp({ sessions: [sess({ id: "a", workdir: "/w/epi" })] });
    const out = splitByWorktree([p]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(p); // the same object, not a rebuilt copy
  });
  it("splits root and worktree into separate groups, keyed by checkout dir", () => {
    const p = grp({ sessions: [
      sess({ id: "a", workdir: "/w/epi", branch: "main" }),
      sess({ id: "b", workdir: "/w/wt", branch: "feature" }),
    ] });
    const out = splitByWorktree([p]);
    expect(names(out)).toEqual(["/w/epi", "/w/wt"]);
    expect(ids(out[0].sessions)).toEqual(["a"]);
    expect(ids(out[1].sessions)).toEqual(["b"]);
    expect(out[0].wtBranch).toBeUndefined();      // the root keeps the project's identity
    expect(out[1]).toMatchObject({ name: "epi", accent: "#fff", wtBranch: "feature" });
  });
  it("drops the phantom root of a worktree-only repo", () => {
    const p = grp({ sessions: [sess({ id: "b", workdir: "/w/wt", branch: "feature" })] });
    expect(names(splitByWorktree([p]))).toEqual(["/w/wt"]);
  });
  it("keeps an empty root when the project is a favourite — it is a launch target", () => {
    setFavorites([{ name: "epi", path: "/w/epi" }]);
    const p = grp({ sessions: [sess({ id: "b", workdir: "/w/wt", branch: "feature" })] });
    const out = splitByWorktree([p]);
    expect(names(out)).toEqual(["/w/epi", "/w/wt"]);
    expect(out[0].sessions).toEqual([]);
  });
  it("leaves dormant rows on the root group, never on a worktree group", () => {
    setFavorites([{ name: "epi", path: "/w/epi" }]);
    const p = grp({
      sessions: [sess({ id: "b", workdir: "/w/wt", branch: "feature" })],
      dormants: [dorm({ id: "d1" })],
    });
    const out = splitByWorktree([p]);
    expect(out[0].dormants.map((d) => d.id)).toEqual(["d1"]);
    expect(out[1].dormants).toEqual([]);
  });
  it("moves each cluster's externals onto its own group", () => {
    const p = grp({
      sessions: [sess({ id: "a", workdir: "/w/epi" }), sess({ id: "b", workdir: "/w/wt", branch: "feature" })],
      externals: [ext({ session_id: "e1", cwd: "/w/wt" }), ext({ session_id: "e2", cwd: "/w/epi" })],
    });
    const out = splitByWorktree([p]);
    expect(out[0].externals.map((e) => e.session_id)).toEqual(["e2"]);
    expect(out[1].externals.map((e) => e.session_id)).toEqual(["e1"]);
  });
});

describe("allProjects — the one set the sidebar and the launch palette share", () => {
  it("lists favourites first, in their own order, with empty buckets", () => {
    setFavorites([{ name: "b", path: "/w/b" }, { name: "a", path: "/w/a" }]);
    const l = allProjects();
    expect(names(l)).toEqual(["/w/b", "/w/a"]);
    expect(l[0]).toMatchObject({ sessions: [], externals: [], dormants: [] });
  });
  it("merges a session into the favourite of the same name", () => {
    setFavorites([{ name: "epi", path: "/w/epi" }]);
    open(sess({ id: "a", project: "epi", colorKey: "/somewhere/else" }));
    const l = allProjects();
    expect(l).toHaveLength(1);
    expect(ids(l[0].sessions)).toEqual(["a"]);
  });
  it("merges a session into the favourite of the same path, whatever it calls itself", () => {
    setFavorites([{ name: "epi", path: "/w/epi" }]);
    open(sess({ id: "a", project: "renamed", colorKey: "/w/epi" }));
    expect(allProjects()).toHaveLength(1);
  });
  it("discovers a project from a session that matches no favourite", () => {
    open(sess({ id: "a", project: "other", colorKey: "/w/other" }));
    expect(allProjects()[0]).toMatchObject({ name: "other", path: "/w/other" });
  });
  it("groups every worktree of one repo under its repo_root, not the raw cwd", () => {
    setExternals([
      ext({ session_id: "e1", cwd: "/w/epi", repo_root: "/w/epi" }),
      ext({ session_id: "e2", cwd: "/w/wt", repo_root: "/w/epi" }),
    ]);
    const l = allProjects();
    expect(names(l)).toEqual(["/w/epi"]);
    expect(l[0].externals.map((e) => e.session_id)).toEqual(["e1", "e2"]);
  });
  it("falls back to the cwd when the backend resolved no repo root", () => {
    setExternals([ext({ session_id: "e1", cwd: "/w/loose", repo_root: null })]);
    expect(allProjects()[0]).toMatchObject({ name: "loose", path: "/w/loose" });
  });
  it("merges an external into the favourite whose path is its repo root", () => {
    setFavorites([{ name: "epi", path: "/w/epi" }]);
    setExternals([ext({ cwd: "/w/wt", repo_root: "/w/epi" })]);
    const l = allProjects();
    expect(l).toHaveLength(1);
    expect(l[0].externals).toHaveLength(1);
  });
  it("hangs dormant rows off their project, live or discovered", () => {
    open(sess({ id: "a", project: "epi", colorKey: "/w/epi" }));
    setDormants([dorm({ id: "d1", project: "epi", colorKey: "/w/epi" }), dorm({ id: "d2", project: "gone", colorKey: "/w/gone" })]);
    const l = allProjects();
    expect(names(l)).toEqual(["/w/epi", "/w/gone"]);
    expect(l[0].dormants.map((d) => d.id)).toEqual(["d1"]);
    expect(l[1].dormants.map((d) => d.id)).toEqual(["d2"]);
  });
  it("merges a dormant row into the favourite of the same name", () => {
    setFavorites([{ name: "epi", path: "/w/epi" }]);
    setDormants([dorm({ id: "d1", project: "epi", colorKey: "/somewhere/else" })]);
    const l = allProjects();
    expect(l).toHaveLength(1);
    expect(l[0].dormants.map((d) => d.id)).toEqual(["d1"]);
  });
  it("merges a dormant row into the favourite of the same path", () => {
    setFavorites([{ name: "epi", path: "/w/epi" }]);
    setDormants([dorm({ id: "d1", project: "renamed", colorKey: "/w/epi" })]);
    const l = allProjects();
    expect(l).toHaveLength(1);
    expect(l[0].dormants.map((d) => d.id)).toEqual(["d1"]);
  });
  it("colours a group from its path, honouring a hand-picked override", () => {
    setFavorites([{ name: "epi", path: "/w/epi" }, { name: "two", path: "/w/two" }]);
    colorOverrides["/w/epi"] = "#abcdef";
    const l = allProjects();
    expect(l[0].accent).toBe("#abcdef");
    expect(l[1].accent).toBe(accentFor("/w/two")); // the rest stay on the path hash
  });
  it("returns fresh arrays each call — a caller may sort them in place", () => {
    open(sess({ id: "a" }));
    const first = allProjects();
    first[0].sessions.length = 0;
    expect(allProjects()[0].sessions).toHaveLength(1);
  });
});

describe("projectList — manual order", () => {
  it("honours the drag-drop order", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }, { name: "c", path: "/w/c" }]);
    setProjOrder(["/w/c", "/w/a"]);
    expect(names(projectList())).toEqual(["/w/c", "/w/a", "/w/b"]);
  });
  it("leaves unlisted projects in their natural order, after the listed ones", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }, { name: "c", path: "/w/c" }]);
    setProjOrder(["/w/c"]);
    expect(names(projectList())).toEqual(["/w/c", "/w/a", "/w/b"]);
  });
  it("leaves the sessions within a project alone", () => {
    open(sess({ id: "a", lastActivity: 1 }), sess({ id: "b", lastActivity: 9 }));
    expect(ids(projectList()[0].sessions)).toEqual(["a", "b"]);
  });
});

describe("projectList — active order", () => {
  beforeEach(() => setSortMode("active"));
  it("floats the most recently active project to the top", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    open(sess({ id: "s1", project: "a", colorKey: "/w/a", lastActivity: 10 }));
    open(sess({ id: "s2", project: "b", colorKey: "/w/b", lastActivity: 20 }));
    expect(names(projectList())).toEqual(["/w/b", "/w/a"]);
  });
  it("sorts sessions within a project newest-first", () => {
    open(sess({ id: "a", lastActivity: 5 }), sess({ id: "b", lastActivity: 50 }), sess({ id: "c", lastActivity: 20 }));
    expect(ids(projectList()[0].sessions)).toEqual(["b", "c", "a"]);
  });
  it("ranks a project by its liveliest session, not its total", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    open(sess({ id: "s1", project: "a", colorKey: "/w/a", lastActivity: 30 }));
    open(sess({ id: "s2", project: "a", colorKey: "/w/a", lastActivity: 1 }));
    open(sess({ id: "s3", project: "b", colorKey: "/w/b", lastActivity: 20 }));
    expect(names(projectList())).toEqual(["/w/a", "/w/b"]);
  });
  it("sinks a project with no sessions at all", () => {
    setFavorites([{ name: "idle", path: "/w/idle" }, { name: "live", path: "/w/live" }]);
    open(sess({ id: "s1", project: "live", colorKey: "/w/live", lastActivity: 1 }));
    expect(names(projectList())).toEqual(["/w/live", "/w/idle"]);
  });
});

describe("projectList — attention order", () => {
  beforeEach(() => setSortMode("attention"));
  it("floats the project that needs you most", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    open(sess({ id: "s1", project: "a", colorKey: "/w/a", phase: "working" }));
    open(sess({ id: "s2", project: "b", colorKey: "/w/b", phase: "error" }));
    expect(names(projectList())).toEqual(["/w/b", "/w/a"]);
  });
  it("breaks a tie by who has been waiting longest", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    open(sess({ id: "s1", project: "a", colorKey: "/w/a", phase: "done", phaseSince: 500 }));
    open(sess({ id: "s2", project: "b", colorKey: "/w/b", phase: "done", phaseSince: 100 }));
    expect(names(projectList())).toEqual(["/w/b", "/w/a"]);
  });
  it("ranks a project by its most urgent session, not its calmest", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    open(sess({ id: "s1", project: "a", colorKey: "/w/a", phase: "working" }));  // 3
    open(sess({ id: "s2", project: "a", colorKey: "/w/a", phase: "error" }));    // 1
    open(sess({ id: "s3", project: "b", colorKey: "/w/b", phase: "done" }));     // 2
    expect(names(projectList())).toEqual(["/w/a", "/w/b"]);
  });
  it("times a project by its longest-waiting session, not its most recent", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    open(sess({ id: "s1", project: "a", colorKey: "/w/a", phase: "done", phaseSince: 100 }));
    open(sess({ id: "s2", project: "a", colorKey: "/w/a", phase: "done", phaseSince: 900 }));
    open(sess({ id: "s3", project: "b", colorKey: "/w/b", phase: "done", phaseSince: 500 }));
    open(sess({ id: "s4", project: "b", colorKey: "/w/b", phase: "done", phaseSince: 600 }));
    expect(names(projectList())).toEqual(["/w/a", "/w/b"]);
  });
  it("sinks a project with no sessions — nothing there can want you", () => {
    setFavorites([{ name: "empty", path: "/w/empty" }, { name: "live", path: "/w/live" }]);
    open(sess({ id: "s1", project: "live", colorKey: "/w/live", phase: "ended" }));
    expect(names(projectList())).toEqual(["/w/live", "/w/empty"]);
  });
  it("sorts sessions within a project by urgency, then by wait", () => {
    open(
      sess({ id: "working", phase: "working", phaseSince: 1 }),
      sess({ id: "recent-done", phase: "done", phaseSince: 900 }),
      sess({ id: "old-done", phase: "done", phaseSince: 100 }),
      sess({ id: "blocked", phase: "working", attention: "Bash", phaseSince: 999 }),
    );
    expect(ids(projectList()[0].sessions)).toEqual(["blocked", "old-done", "recent-done", "working"]);
  });
});

describe("projectList — worktree grouping", () => {
  it("splits into top-level groups only in toplevel mode", () => {
    open(sess({ id: "a", workdir: "/w/epi", branch: "main" }), sess({ id: "b", workdir: "/w/wt", branch: "feature" }));
    for (const m of ["off", "subheader", "chip"] as const) {
      setWtGroup(m);
      expect(names(projectList())).toEqual(["/w/epi"]);
    }
    setWtGroup("toplevel");
    expect(names(projectList())).toEqual(["/w/epi", "/w/wt"]);
  });
  it("sorts sessions before splitting, so each split group inherits the order", () => {
    setSortMode("active");
    setWtGroup("toplevel");
    open(
      sess({ id: "wt-old", workdir: "/w/wt", branch: "feature", lastActivity: 1 }),
      sess({ id: "root", workdir: "/w/epi", branch: "main", lastActivity: 5 }),
      sess({ id: "wt-new", workdir: "/w/wt", branch: "feature", lastActivity: 9 }),
    );
    const out = projectList();
    expect(names(out)).toEqual(["/w/wt", "/w/epi"]);   // the worktree holds the liveliest session
    expect(ids(out[0].sessions)).toEqual(["wt-new", "wt-old"]);
  });
});

describe("urgencyRank — who needs you first", () => {
  it("ranks a blocking permission above everything else", () => {
    expect(urgencyRank(sess({ attention: "Bash", phase: "working" }))).toBe(0);
  });
  it("orders the phases: error, your turn, busy, idle, ended", () => {
    const rank = (phase: Sess["phase"]) => urgencyRank(sess({ phase }));
    expect(rank("error")).toBe(1);
    expect(rank("done")).toBe(2);
    expect(rank("working")).toBe(3);
    expect(rank("thinking")).toBe(3);
    expect(rank("idle")).toBe(4);
    expect(rank("ended")).toBe(5);
  });
  it("keeps that order strictly ascending in urgency", () => {
    const ranks = (["error", "done", "working", "idle", "ended"] as const).map((p) => urgencyRank(sess({ phase: p })));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });
  it("never lets a shell demand attention — it has no telemetry to earn it", () => {
    for (const phase of ["error", "done", "working", "idle", "ended"] as const) {
      expect(urgencyRank(sess({ kind: "shell", phase }))).toBe(6);
    }
    expect(urgencyRank(sess({ kind: "shell", attention: "Bash" }))).toBe(6);
  });
  it("raises a task only when it failed — a red build reads like a broken session", () => {
    expect(urgencyRank(sess({ kind: "task", phase: "error" }))).toBe(1);
    expect(urgencyRank(sess({ kind: "task", phase: "done" }))).toBe(6);
    expect(urgencyRank(sess({ kind: "task", phase: "working" }))).toBe(6);
  });
  it("sits a healthy task and a shell below an ended session", () => {
    expect(urgencyRank(sess({ kind: "task", phase: "done" }))).toBeGreaterThan(urgencyRank(sess({ phase: "ended" })));
  });
});

describe("orderedSessions — the sidebar read as one flat list", () => {
  it("concatenates each project's sessions in sidebar order", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    setProjOrder(["/w/b", "/w/a"]);
    open(sess({ id: "a1", project: "a", colorKey: "/w/a" }), sess({ id: "b1", project: "b", colorKey: "/w/b" }));
    expect(ids(orderedSessions())).toEqual(["b1", "a1"]);
  });
  it("skips externals and dormants — they are not sessions you can activate", () => {
    open(sess({ id: "a1" }));
    setExternals([ext()]);
    setDormants([dorm()]);
    expect(ids(orderedSessions())).toEqual(["a1"]);
  });
});

describe("nextAfterClose — which pane takes the stage", () => {
  it("prefers the sibling directly above", () => {
    const [, b, c] = open(sess({ id: "a" }), sess({ id: "b" }), sess({ id: "c" }));
    expect(nextAfterClose(c)).toBe(b);
  });
  it("prefers above over below when a session has both", () => {
    const [a, b] = open(sess({ id: "a" }), sess({ id: "b" }), sess({ id: "c" }));
    expect(nextAfterClose(b)).toBe(a);
  });
  it("takes the one below when closing the first of a project", () => {
    const [a, b] = open(sess({ id: "a" }), sess({ id: "b" }));
    expect(nextAfterClose(a)).toBe(b);
  });
  it("stays inside the project even when a neighbouring one is closer in the flat list", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    const [, a2, b1] = open(
      sess({ id: "a1", project: "a", colorKey: "/w/a" }),
      sess({ id: "a2", project: "a", colorKey: "/w/a" }),
      sess({ id: "b1", project: "b", colorKey: "/w/b" }),
    );
    expect(ids(orderedSessions())).toEqual(["a1", "a2", "b1"]); // b1 is adjacent to a2…
    expect(nextAfterClose(b1)).toBe(a2);                        // …but only because its own project is empty
    expect(nextAfterClose(a2)).not.toBe(b1);
  });
  it("leaves the project only once it is the last session there", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    const [a1, b1] = open(
      sess({ id: "a1", project: "a", colorKey: "/w/a" }),
      sess({ id: "b1", project: "b", colorKey: "/w/b" }),
    );
    expect(nextAfterClose(a1)).toBe(b1); // nothing above, so the next in sidebar order
  });
  it("goes DOWN the sidebar first when leaving a project, not up", () => {
    // The in-project rule prefers the row above; once the project is empty the
    // fallback is the other way round — the nearest row *below* in sidebar order.
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }, { name: "c", path: "/w/c" }]);
    const [, b1, c1] = open(
      sess({ id: "a1", project: "a", colorKey: "/w/a" }),
      sess({ id: "b1", project: "b", colorKey: "/w/b" }),
      sess({ id: "c1", project: "c", colorKey: "/w/c" }),
    );
    expect(nextAfterClose(b1)).toBe(c1);
  });
  it("falls back to the previous project when the closed one was last in the list", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    const [a1, b1] = open(
      sess({ id: "a1", project: "a", colorKey: "/w/a" }),
      sess({ id: "b1", project: "b", colorKey: "/w/b" }),
    );
    expect(nextAfterClose(b1)).toBe(a1);
  });
  it("returns null for the only session there is", () => {
    const [a] = open(sess({ id: "a" }));
    expect(nextAfterClose(a)).toBeNull();
  });
  it("returns null for a session that was already removed from the map", () => {
    // Documented precondition: call it BEFORE the map delete, or it can't find a home.
    const s = sess({ id: "gone" });
    expect(nextAfterClose(s)).toBeNull();
  });
  it("reads the order the user actually sees, not insertion order", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    setProjOrder(["/w/b", "/w/a"]);
    const [a1, b1] = open(
      sess({ id: "a1", project: "a", colorKey: "/w/a" }),
      sess({ id: "b1", project: "b", colorKey: "/w/b" }),
    );
    expect(ids(orderedSessions())).toEqual(["b1", "a1"]);
    expect(nextAfterClose(a1)).toBe(b1); // above it in the sidebar, though opened first
  });
  it("hands over within the worktree group in toplevel mode", () => {
    setWtGroup("toplevel");
    const [, wt1, wt2] = open(
      sess({ id: "root", workdir: "/w/epi", branch: "main" }),
      sess({ id: "wt1", workdir: "/w/wt", branch: "feature" }),
      sess({ id: "wt2", workdir: "/w/wt", branch: "feature" }),
    );
    expect(nextAfterClose(wt2)).toBe(wt1); // its own worktree group, not the root one
  });
});

describe("needsYou — is this pane waiting on the human", () => {
  it("counts a blocking permission whatever phase it interrupted", () => {
    for (const phase of ["idle", "thinking", "working", "ended"] as const) {
      expect(needsYou(sess({ phase, attention: "Bash" }))).toBe(true);
    }
  });
  it("counts your turn and an error, but not work in progress", () => {
    expect(needsYou(sess({ phase: "done" }))).toBe(true);
    expect(needsYou(sess({ phase: "error" }))).toBe(true);
    expect(needsYou(sess({ phase: "working" }))).toBe(false);
    expect(needsYou(sess({ phase: "thinking" }))).toBe(false);
    expect(needsYou(sess({ phase: "idle" }))).toBe(false);
    expect(needsYou(sess({ phase: "ended" }))).toBe(false);
  });
  it("never counts a shell — not even a blocked-looking one", () => {
    for (const phase of ["done", "error", "working", "idle", "ended"] as const) {
      expect(needsYou(sess({ kind: "shell", phase }))).toBe(false);
    }
    expect(needsYou(sess({ kind: "shell", attention: "Bash" }))).toBe(false);
  });
  it("counts a failed run only — a green one settles quietly and auto-dismisses", () => {
    expect(needsYou(sess({ kind: "task", phase: "error" }))).toBe(true);
    expect(needsYou(sess({ kind: "task", phase: "done" }))).toBe(false);
    expect(needsYou(sess({ kind: "task", phase: "working" }))).toBe(false);
  });
  it("ignores a task's attention string — only its exit code speaks for it", () => {
    expect(needsYou(sess({ kind: "task", phase: "working", attention: "Bash" }))).toBe(false);
  });
  it("lets the task preference switch a failed run off, and nothing else", () => {
    taskPrefs.attention = false;
    expect(needsYou(sess({ kind: "task", phase: "error" }))).toBe(false);
    expect(needsYou(sess({ phase: "error" }))).toBe(true); // an agent is not the switch's business
  });
});

describe("needsYouSessions — the reactor's queue", () => {
  it("keeps only the sessions that want you", () => {
    open(
      sess({ id: "busy", phase: "working" }),
      sess({ id: "turn", phase: "done" }),
      sess({ id: "shell", kind: "shell", phase: "error" }),
    );
    expect(ids(needsYouSessions())).toEqual(["turn"]);
  });
  it("orders by urgency: blocked, error, your turn", () => {
    open(
      sess({ id: "turn", phase: "done" }),
      sess({ id: "blocked", phase: "working", attention: "Bash" }),
      sess({ id: "broken", phase: "error" }),
    );
    expect(ids(needsYouSessions())).toEqual(["blocked", "broken", "turn"]);
  });
  it("breaks a tie by who has been waiting longest", () => {
    open(
      sess({ id: "recent", phase: "done", phaseSince: 900 }),
      sess({ id: "oldest", phase: "done", phaseSince: 100 }),
      sess({ id: "middle", phase: "done", phaseSince: 500 }),
    );
    expect(ids(needsYouSessions())).toEqual(["oldest", "middle", "recent"]);
  });
  it("is independent of the sidebar sort, so the reactor stays stable", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    setProjOrder(["/w/b", "/w/a"]);
    open(
      sess({ id: "a1", project: "a", colorKey: "/w/a", phase: "done", phaseSince: 100 }),
      sess({ id: "b1", project: "b", colorKey: "/w/b", phase: "done", phaseSince: 900 }),
    );
    expect(ids(orderedSessions())).toEqual(["b1", "a1"]); // the sidebar puts b first…
    expect(ids(needsYouSessions())).toEqual(["a1", "b1"]); // …the reactor still asks who waited
  });
  it("does not consult the sidebar order even to break an exact tie", () => {
    // Same urgency, same wait: the stable sort falls back to the order the sessions
    // were opened in, NOT to where the sidebar happens to be showing them.
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    setProjOrder(["/w/b", "/w/a"]);
    open(
      sess({ id: "a1", project: "a", colorKey: "/w/a", phase: "done", phaseSince: 100 }),
      sess({ id: "b1", project: "b", colorKey: "/w/b", phase: "done", phaseSince: 100 }),
    );
    expect(ids(orderedSessions())).toEqual(["b1", "a1"]);
    expect(ids(needsYouSessions())).toEqual(["a1", "b1"]);
  });
  it("sorts a failed run in beside the agents, by its own wait", () => {
    open(
      sess({ id: "turn", phase: "done", phaseSince: 100 }),
      sess({ id: "run", kind: "task", phase: "error", phaseSince: 900 }),
    );
    expect(ids(needsYouSessions())).toEqual(["run", "turn"]); // error outranks your turn
  });
  it("is empty when nothing wants you", () => {
    open(sess({ id: "a", phase: "working" }));
    expect(needsYouSessions()).toEqual([]);
  });
});

describe("reactorState / reactorLabel — the badge's one rollup", () => {
  it("lets a blocking permission outrank an error it interrupted", () => {
    expect(reactorState(sess({ phase: "error", attention: "Bash" }))).toBe("attention");
  });
  it("reads an error as an error and everything else as your turn", () => {
    expect(reactorState(sess({ phase: "error" }))).toBe("error");
    expect(reactorState(sess({ phase: "done" }))).toBe("done");
  });
  it("labels each state, singular and plural", () => {
    expect(reactorLabel("attention", 1)).toBe("1 needs you");
    expect(reactorLabel("attention", 3)).toBe("3 need you");
    expect(reactorLabel("error", 1)).toBe("1 error");
    expect(reactorLabel("error", 2)).toBe("2 errors");
    expect(reactorLabel("done", 1)).toBe("1 your turn");
    expect(reactorLabel("done", 4)).toBe("4 your turn");
  });
});

// A task pane, optionally in a run group. `run` carries everything the fold reads.
function taskSess(id: string, o: Partial<Sess> = {}, run: Partial<NonNullable<Sess["run"]>> = {}): Sess {
  return sess({
    id, kind: "task", ...o,
    run: {
      id: "npm:" + id, label: id, source: "npm", sourceFile: "package.json",
      cmd: "npm run " + id, background: false, startedAt: NOW_MS, exitCode: null,
      tail: [], root: "/w/epi", ...run,
    },
  });
}

describe("foldRunGroups — a dependsOn chain as one sidebar row", () => {
  it("collapses the members of one launch and leaves everything else alone", () => {
    const items = foldRunGroups([
      sess({ id: "agent" }),
      taskSess("typecheck", {}, { groupId: "g1", groupLabel: "fe-check" }),
      taskSess("lint", {}, { groupId: "g1", groupLabel: "fe-check" }),
      taskSess("test", {}, { groupId: "g1", groupLabel: "fe-check" }),
      taskSess("solo"),
    ]);
    expect(items.map((i) => (i.kind === "group" ? `group:${i.label}` : i.s.id)))
      .toEqual(["agent", "group:fe-check", "solo"]);
    const g = items[1];
    expect(g.kind).toBe("group");
    if (g.kind === "group") expect(ids(g.members)).toEqual(["typecheck", "lint", "test"]);
  });

  it("puts the group where its FIRST member sat, so the caller's sort still decides", () => {
    // If the fold re-sorted, `solo` could not stay ahead of a group whose first
    // member follows it — which is exactly what projectList already ordered.
    const items = foldRunGroups([
      taskSess("solo"),
      taskSess("build", {}, { groupId: "g1", groupLabel: "ship" }),
      taskSess("sign", {}, { groupId: "g1", groupLabel: "ship" }),
    ]);
    expect(items.map((i) => (i.kind === "group" ? "GROUP" : i.s.id))).toEqual(["solo", "GROUP"]);
  });

  it("keeps two launches of the same chain apart", () => {
    // The whole reason groupId is minted per launch: running `fe-check` twice must
    // give two rows to compare, not one row with six steps.
    const items = foldRunGroups([
      taskSess("a1", {}, { groupId: "g1", groupLabel: "fe-check" }),
      taskSess("a2", {}, { groupId: "g1", groupLabel: "fe-check" }),
      taskSess("b1", {}, { groupId: "g2", groupLabel: "fe-check" }),
      taskSess("b2", {}, { groupId: "g2", groupLabel: "fe-check" }),
    ]);
    expect(items.length).toBe(2);
    expect(items.every((i) => i.kind === "group")).toBe(true);
  });

  it("renders a group of one as a plain row — a header over one step is noise", () => {
    const items = foldRunGroups([taskSess("only", {}, { groupId: "g1", groupLabel: "fe-check" })]);
    expect(items).toEqual([{ kind: "one", s: expect.objectContaining({ id: "only" }) }]);
  });

  it("never groups a claude or shell pane, whatever it carries", () => {
    const items = foldRunGroups([
      sess({ id: "c", kind: "claude", run: { groupId: "g1" } as never }),
      sess({ id: "sh", kind: "shell", run: { groupId: "g1" } as never }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["one", "one"]);
  });
});

describe("groupPhase — worst-of, so one row answers 'did my chain pass?'", () => {
  const p = (...phases: Sess["phase"][]) => groupPhase(phases.map((ph, i) => taskSess("s" + i, { phase: ph })));

  it("lets a failure outrank anything that came after it", () => {
    // The case worst-of exists for: a failed build stops the chain, so the steps
    // behind it never run. Last-of would report `done` on a broken chain.
    expect(p("error", "done")).toBe("error");
    expect(p("done", "error", "idle")).toBe("error");
  });
  it("is not done while any step is still going", () => {
    expect(p("done", "working")).toBe("working");
    expect(p("done", "thinking")).toBe("working");
  });
  it("reads a step queued behind a sequential dependency as still working", () => {
    expect(p("done", "idle")).toBe("working");
  });
  it("is done only when every step is", () => {
    expect(p("done", "done", "done")).toBe("done");
  });
  it("is ended only when every step is", () => {
    expect(p("ended", "ended")).toBe("ended");
    expect(p("ended", "done")).toBe("done");
  });
});
