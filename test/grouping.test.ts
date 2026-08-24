import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CLAUDE_CLI, isExited, midFlight, pickAgent, type AgentCli, type ExtSession, type Restorable, type Sess, type WtHead } from "../src/types";
import { store } from "./localstorage"; // must precede the subject imports
import {
  accentFor, colorOverrides, dirtyByFolder, sessions, setActiveId, setAttnPrefs,
  setBackendLive, setDormants,
  setExternals, setFavorites, setProjGroups, setProjOrder, setSortMode, setWtGroup,
  worktreesByRepo,
} from "../src/state";
import { ATTN_DEFAULTS } from "../src/attn";
import {
  allProjects, attnPending, clusterByWorktree, clusterIsLive, dashHeads, dormantBusy,
  foldRunGroups,
  groupedProjects, groupPhase, groupSummary, needsYou, needsYouSessions,
  nextAfterClose, nextInGroup, orderedSessions, orphanAdoptions, projectList,
  reactorLabel, reactorState, splitByWorktree, syncAttn, urgencyRank,
  type ProjGroup, type SidebarSlot,
} from "../src/grouping";
import { NO_GROUPS } from "../src/projgroups";
import { taskPrefs } from "../src/tasks";

const NOW_MS = 1800000000000; // 2027-01-15T08:00:00Z

// A Sess as newSession() builds one, minus the DOM/xterm handles nothing here reads.
function sess(o: Partial<Sess> = {}): Sess {
  const explicitKind = o.kind;
  return {
    id: "sid", project: "epi", accent: "#fff", workdir: "/w/epi", colorKey: "/w/epi",
    resumeId: "sid", branch: "main", worktree: null, title: "",
    phase: "idle", phaseSince: 0, attnAt: 0, seenAt: 0, lastActivity: 0, attention: null,
    pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0, fanout: null, apiErr: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [],
    git: null, res: null, lastEvent: "", activity: [], files: [], tally: {},
    kind: "agent",
    provider: explicitKind === undefined ? "claude" : explicitKind === "agent" ? "codex" : null,
    capabilities: explicitKind === undefined ? [...CLAUDE_CLI.capabilities] : [],
    external: false, ...o,
  } as Sess;
}
/// The `Sess` fields of a session with a background fan-out up — `total` agents
/// launched, `done` of them landed. Spelled out rather than driven through applyHook,
/// which lives in a module this suite deliberately does not import.
const fleet = (total: number, done: number): Partial<Sess> => ({
  subagents: total - done,
  fanout: { name: "wf", detail: "", phases: [], since: 0, started: total, done, lastAt: Date.now() },
});
// Sessions reach grouping through the state map, in insertion order.
function open(...list: Sess[]): Sess[] { for (const s of list) sessions.set(s.id, s); return list; }
const ext = (o: Partial<ExtSession> = {}): ExtSession =>
  ({ pid: 1, session_id: "e1", cwd: "/w/epi", name: "epi", status: "idle", version: "2.1", ...o });
const dorm = (o: Partial<Restorable> = {}): Restorable =>
  ({ id: "d1", resumeId: "d1", provider: "claude", project: "epi", workdir: "/w/epi", colorKey: "/w/epi",
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
  setBackendLive(new Set());
  setSortMode("manual"); setWtGroup("off"); setProjGroups(NO_GROUPS);
  worktreesByRepo.clear();
  dirtyByFolder.clear();
  for (const k of Object.keys(colorOverrides)) delete colorOverrides[k];
  taskPrefs.attention = true; // needsYou reads it; restore the shipped default
  setAttnPrefs(ATTN_DEFAULTS); // ditto for the reactor's queue (./attn)
  setActiveId(null);
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
  /// The same bug through a different door, which `run.root` could not close: a task's
  /// cwd reaches a **shell** too. `❯ Terminal` opens one in `activeCwd()` — the raw
  /// workdir of whatever owns the stage — so a shell opened while a finished task pane
  /// is on stage starts in that task's subfolder, and a shell has no `run` to unwrap.
  /// The roster places it. Spelled as it really arrived on Windows: the checkout in
  /// backslashes (the folder the user picked), the declared cwd's own forward slashes
  /// pasted on by `${workspaceFolder}` substitution.
  it("clusters a shell started in a subfolder by its checkout", () => {
    const repo = "E:\\w\\epi", wt = "E:\\w\\wt-feat";
    worktreesByRepo.set(repo, [
      { path: repo, branch: "main", is_main: true, exists: true },
      { path: wt, branch: "feat", is_main: false, exists: true },
    ]);
    const p = grp({ path: repo, sessions: [
      sess({ id: "agent", workdir: wt, colorKey: repo, branch: "feat" }),
      sess({ id: "sh", kind: "shell", colorKey: repo, branch: "feat",
             workdir: wt + "/00_scripts/clone_db_locally" }),
    ] });
    const cl = clusterByWorktree(p);
    expect(cl.map((c) => c.key)).toEqual([wt]);
    expect(ids(cl[0].sessions)).toEqual(["agent", "sh"]);
  });
  /// The roster's spelling must not escape into a cluster key for a checkout the group
  /// already names: `isMain` compares that key against the project path, and the roster
  /// side has been through `norm_path` in Rust while the project side is however the
  /// folder was picked. Only a path genuinely *inside* a checkout is rewritten.
  it("keeps the group's own spelling of a checkout the roster spells differently", () => {
    const repo = "E:\\w\\epi";
    worktreesByRepo.set(repo, [{ path: "E:/w/epi", branch: "main", is_main: true, exists: true }]);
    const p = grp({ path: repo, sessions: [sess({ id: "a", workdir: repo, colorKey: repo })] });
    expect(clusterByWorktree(p)[0]).toMatchObject({ key: repo, isMain: true });
  });
  it("leaves a folder the roster cannot place as its own cluster", () => {
    worktreesByRepo.set("/w/epi", [{ path: "/w/epi", branch: "main", is_main: true, exists: true }]);
    const p = grp({ sessions: [
      sess({ id: "a", workdir: "/w/epi" }),
      sess({ id: "b", kind: "shell", workdir: "/tmp/scratch" }),
    ] });
    expect(clusterByWorktree(p).map((c) => c.key)).toEqual(["/w/epi", "/tmp/scratch"]);
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

// The line the sidebar draws: live clusters are rows, the rest are peek rows that
// only appear while the pointer rests on the project (./peek, ./sidebarview).
describe("clusterIsLive", () => {
  it("counts a checkout with an Episko session as live", () => {
    const p = grp({ sessions: [sess({ workdir: "/w/epi" })] });
    expect(clusterByWorktree(p).map(clusterIsLive)).toEqual([true]);
  });
  it("counts an EXTERNAL session as live too — a colleague's pane still holds the row", () => {
    const p = grp({ externals: [ext({ cwd: "/w/wt" })] });
    expect(clusterByWorktree(p).map(clusterIsLive)).toEqual([true]);
  });
  it("is false for a roster checkout nobody has started anything in", () => {
    worktreesByRepo.set("/w/epi", [
      { path: "/w/epi", branch: "main", is_main: true, exists: true },
      { path: "/w/wt-x", branch: "feat/x", is_main: false, exists: true },
    ]);
    const p = grp({ sessions: [sess({ workdir: "/w/epi" })] });
    const cl = clusterByWorktree(p, true);
    expect(cl.map((c) => [c.key, clusterIsLive(c)])).toEqual([["/w/epi", true], ["/w/wt-x", false]]);
  });
});

// The roster half: checkouts that exist on disk with nothing running in them. Off
// unless asked for, because only the sidebar body wants them — see the note on the
// parameter for why splitByWorktree must not get them.
describe("clusterByWorktree — session-less checkouts from the worktree roster", () => {
  const roster = (l: WtHead[]) => { worktreesByRepo.set("/w/epi", l); };
  const main = (o: Partial<WtHead> = {}): WtHead =>
    ({ path: "/w/epi", branch: "main", is_main: true, exists: true, ...o });
  const linked = (o: Partial<WtHead> = {}): WtHead =>
    ({ path: "/w/wt-x", branch: "feat/x", is_main: false, exists: true, ...o });

  it("ignores the roster entirely unless withEmpty is asked for", () => {
    roster([main(), linked()]);
    const p = grp({ sessions: [sess({ id: "a", workdir: "/w/epi" })] });
    expect(clusterByWorktree(p).map((c) => c.key)).toEqual(["/w/epi"]);
  });
  it("adds a checkout with no session, after the ones that have sessions", () => {
    roster([main(), linked()]);
    const p = grp({ sessions: [sess({ id: "a", workdir: "/w/epi" })] });
    const cl = clusterByWorktree(p, true);
    expect(cl.map((c) => c.key)).toEqual(["/w/epi", "/w/wt-x"]);
    expect(cl[1]).toMatchObject({ branch: "feat/x", isMain: false });
    expect(cl[1].sessions).toEqual([]);
    expect(cl[1].externals).toEqual([]);
  });
  it("does not duplicate a checkout that already has a session", () => {
    roster([main(), linked()]);
    const p = grp({ sessions: [
      sess({ id: "a", workdir: "/w/epi" }),
      sess({ id: "b", workdir: "/w/wt-x", branch: "feat/x" }),
    ] });
    const cl = clusterByWorktree(p, true);
    expect(cl.map((c) => c.key)).toEqual(["/w/epi", "/w/wt-x"]);
    expect(ids(cl[1].sessions)).toEqual(["b"]);
  });
  it("prefers the roster's branch over a session's cached one — it read HEAD directly", () => {
    roster([main(), linked({ branch: "renamed" })]);
    const p = grp({ sessions: [sess({ id: "b", workdir: "/w/wt-x", branch: "stale" })] });
    expect(clusterByWorktree(p, true).find((c) => c.key === "/w/wt-x")!.branch).toBe("renamed");
  });
  it("skips a registered checkout whose folder is gone — that is git bookkeeping", () => {
    roster([main(), linked({ exists: false })]);
    const p = grp({ sessions: [sess({ id: "a", workdir: "/w/epi" })] });
    expect(clusterByWorktree(p, true).map((c) => c.key)).toEqual(["/w/epi"]);
  });
  // The guard: a project pinned AT a linked worktree resolves to the same repo, and
  // folding the roster in there would sprout a row for the main checkout and every
  // sibling — silently redefining what that group means.
  it("leaves a group alone when it is not the repo's main checkout", () => {
    worktreesByRepo.set("/w/wt-x", [main(), linked()]);
    const p = grp({ path: "/w/wt-x", sessions: [sess({ id: "b", workdir: "/w/wt-x" })] });
    expect(clusterByWorktree(p, true).map((c) => c.key)).toEqual(["/w/wt-x"]);
  });
  it("adds nothing when the repo has no roster yet", () => {
    const p = grp({ sessions: [sess({ id: "a", workdir: "/w/epi" })] });
    expect(clusterByWorktree(p, true).map((c) => c.key)).toEqual(["/w/epi"]);
  });
  it("gives a project with NOTHING running every checkout it has", () => {
    // The reported "the hover bar sometimes doesn't come". This function was always
    // willing; what was missing is the roster, which `refreshWorktrees` only built for
    // repos with a live session — so an idle project reached `peekBody` with zero
    // clusters and rendered no rows at all. Both checkouts are vacant here, which is
    // exactly what the peek exists to reveal.
    roster([main(), linked()]);
    const cl = clusterByWorktree(grp({ sessions: [] }), true);
    expect(cl.map((c) => c.key)).toEqual(["/w/epi", "/w/wt-x"]);
    expect(cl.every((c) => !clusterIsLive(c))).toBe(true);
    // The main checkout is a launchable row too, and keeps its identity so the sidebar
    // can give it the ⌂ glyph rather than a branch's.
    expect(cl[0].isMain).toBe(true);
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
  it("carries the repo root onto every worktree group, and onto no other", () => {
    // A checkout is not a project, and splitting is the only thing that severs the two.
    // The sidebar's project header opens `repoRoot ?? path`, so losing it here keys a
    // worktree's dashboard by its checkout dir — where `histProject` regrafts every
    // history row onto the repo root, so the timeline matches no sessions at all.
    const p = grp({ sessions: [
      sess({ id: "a", workdir: "/w/epi", branch: "main" }),
      sess({ id: "b", workdir: "/w/wt", branch: "feature" }),
    ] });
    const out = splitByWorktree([p]);
    expect(out[0].repoRoot).toBeUndefined();   // the root group IS the project
    expect(out[1].repoRoot).toBe("/w/epi");
  });
  it("leaves an unsplit project without a repoRoot, so `repoRoot ?? path` is its own path", () => {
    const p = grp({ sessions: [sess({ id: "a", workdir: "/w/epi" })] });
    expect(splitByWorktree([p])[0].repoRoot).toBeUndefined();
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

describe("dashHeads — which sidebar row the open dashboard is marked on", () => {
  const wt = (path: string, repoRoot: string) => grp({ path, repoRoot, wtBranch: "feature" });
  it("marks nothing when no dashboard holds the stage", () => {
    expect(dashHeads([grp()], null).size).toBe(0);
  });
  it("marks the row whose project the dashboard is of", () => {
    const list = [grp(), grp({ name: "other", path: "/w/other" })];
    expect([...dashHeads(list, "/w/epi")]).toEqual(["/w/epi"]);
  });
  it("marks nothing when the dashboard's project is not in the list", () => {
    // It can leave it: a project with nothing running drops off a filtered list while
    // its dashboard is still on stage. No row is better than the wrong row.
    expect(dashHeads([grp({ path: "/w/other" })], "/w/epi").size).toBe(0);
  });
  it("marks the root row alone when a repo is split across checkouts", () => {
    // Every one of these rows opens the SAME dashboard (`repoRoot ?? path`), and
    // lighting all three would say the project is on stage three times over.
    const list = [grp(), wt("/w/wt-a", "/w/epi"), wt("/w/wt-b", "/w/epi")];
    expect([...dashHeads(list, "/w/epi")]).toEqual(["/w/epi"]);
  });
  it("falls back to the checkouts when the repo has no root row", () => {
    // splitByWorktree drops the phantom root of a worktree-only repo, and that row is
    // what would otherwise carry the mark — leaving the click that opened the dashboard
    // with nothing to show for it.
    const list = [wt("/w/wt-a", "/w/epi"), wt("/w/wt-b", "/w/epi")];
    expect([...dashHeads(list, "/w/epi")]).toEqual(["/w/wt-a", "/w/wt-b"]);
  });
  it("never marks another project's checkout", () => {
    const list = [grp(), wt("/w/other-wt", "/w/other")];
    expect([...dashHeads(list, "/w/other")]).toEqual(["/w/other-wt"]);
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

describe("groupedProjects — the user's named groups folded over that list", () => {
  // What each slot is, flattened to something an assertion can read: a project by its
  // path, a group as "Name[member, member]".
  const shape = (l: SidebarSlot[]) =>
    l.map((s) => (s.kind === "project" ? s.project.path : `${s.group.name}[${s.projects.map((p) => p.path).join(", ")}]`));
  const threeFavs = () => setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }, { name: "c", path: "/w/c" }]);

  it("passes everything through untouched when there are no groups", () => {
    threeFavs();
    expect(shape(groupedProjects())).toEqual(["/w/a", "/w/b", "/w/c"]);
  });

  it("collects a group's members and leaves the rest at the top level", () => {
    threeFavs();
    setProjGroups({ groups: [{ id: "g1", name: "Work", collapsed: false }], of: { "/w/a": "g1", "/w/c": "g1" } });
    expect(shape(groupedProjects())).toEqual(["Work[/w/a, /w/c]", "/w/b"]);
  });

  it("puts the group where its FIRST member sits, not where the group was made", () => {
    // The whole reason there is no group order to persist: the position is derived, so
    // a drag that moves a member moves the group with it and the two cannot disagree.
    threeFavs();
    setProjOrder(["/w/b", "/w/c", "/w/a"]);
    setProjGroups({ groups: [{ id: "g1", name: "Work", collapsed: false }], of: { "/w/a": "g1", "/w/c": "g1" } });
    expect(shape(groupedProjects())).toEqual(["/w/b", "Work[/w/c, /w/a]"]);
  });

  it("floats a group up in the attention sort when one of its projects needs you", () => {
    setSortMode("attention");
    open(
      sess({ id: "quiet", project: "b", colorKey: "/w/b", phase: "idle" }),
      sess({ id: "blocked", project: "a", colorKey: "/w/a", attention: "Bash" }),
    );
    setProjGroups({ groups: [{ id: "g1", name: "Work", collapsed: false }], of: { "/w/a": "g1" } });
    expect(shape(groupedProjects())).toEqual(["Work[/w/a]", "/w/b"]);
  });

  it("keeps an emptied group, at the end — it has no member to be ranked by", () => {
    // Dropping it would read as Episko having deleted a heading the user named, and it
    // is also the only drop target that could ever refill it.
    threeFavs();
    setProjGroups({ groups: [{ id: "g1", name: "Work", collapsed: false }], of: {} });
    expect(shape(groupedProjects())).toEqual(["/w/a", "/w/b", "/w/c", "Work[]"]);
  });

  it("ignores a membership pointing at a group that is gone", () => {
    // clampGroups repairs this on load; this is the render side refusing to lose a
    // project to a fold nothing draws even if one ever got through.
    threeFavs();
    setProjGroups({ groups: [{ id: "g1", name: "Work", collapsed: false }], of: { "/w/a": "ghost" } });
    expect(shape(groupedProjects())).toEqual(["/w/a", "/w/b", "/w/c", "Work[]"]);
  });

  it("keeps a grouped repo's worktrees together in toplevel mode", () => {
    // There the repo has exploded into one group per checkout, each keyed by its own
    // dir — but the user filed the *repo*, so every checkout has to answer with it or a
    // grouped repo scatters across the rail the moment a second worktree opens.
    setWtGroup("toplevel");
    open(sess({ id: "a", workdir: "/w/epi", branch: "main" }), sess({ id: "b", workdir: "/w/wt", branch: "feature" }));
    setProjGroups({ groups: [{ id: "g1", name: "Work", collapsed: false }], of: { "/w/epi": "g1" } });
    expect(shape(groupedProjects())).toEqual(["Work[/w/epi, /w/wt]"]);
  });
});

describe("groupSummary — what a collapsed group still has to say", () => {
  it("counts sessions and externals across every project in it", () => {
    const l = [grp({ path: "/w/a", sessions: [sess({ id: "x" }), sess({ id: "y" })] }),
               grp({ path: "/w/b", externals: [ext()] })];
    expect(groupSummary(l).count).toBe(3);
  });
  it("reports the most urgent session, so folding never hides one waiting on you", () => {
    const blocked = sess({ id: "blocked", attention: "Bash" });
    const l = [grp({ path: "/w/a", sessions: [sess({ id: "done", phase: "done" })] }),
               grp({ path: "/w/b", sessions: [blocked] })];
    expect(groupSummary(l).urgent).toBe(blocked);
  });
  it("breaks a tie on who has been waiting longest", () => {
    const older = sess({ id: "older", phase: "done", phaseSince: 10 });
    const l = [grp({ sessions: [sess({ id: "newer", phase: "done", phaseSince: 99 }), older] })];
    expect(groupSummary(l).urgent).toBe(older);
  });
  it("has no urgent session when nothing in it wants anything", () => {
    expect(groupSummary([grp({ sessions: [sess({ phase: "working" })] })]).urgent).toBeNull();
  });
  it("lights dirty when ANY member folder has uncommitted changes", () => {
    expect(groupSummary([grp({ sessions: [sess({ workdir: "/w/a" })] })]).dirty).toBe(false);
    dirtyByFolder.set("/w/a", { added: 3, removed: 1, files: 2, untracked: 0, dirty: 2, upstream: null, ahead: 0, behind: 0 });
    expect(groupSummary([grp({ sessions: [sess({ workdir: "/w/a" })] })]).dirty).toBe(true);
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
  it("never lets a third-party agent demand attention either — same missing telemetry", () => {
    // The row for a `codex` pane has no hooks behind it, so nothing it shows can be
    // urgent. `attention` is checked too: it is a field on every Sess, and if the rank
    // ever consulted it before the kind, a stale value would outrank a real permission.
    for (const phase of ["error", "done", "working", "idle", "ended"] as const) {
      expect(urgencyRank(sess({ kind: "agent", phase }))).toBe(6);
    }
    expect(urgencyRank(sess({ kind: "agent", attention: "Bash" }))).toBe(6);
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
  it("follows the order GROUPS put the sidebar in, not the ungrouped one", () => {
    // A group physically moves its members, so reading the ungrouped list would make
    // ⌘4 land on the fourth session in an order nothing on screen is in.
    open(
      sess({ id: "a", project: "a", colorKey: "/w/a" }),
      sess({ id: "b", project: "b", colorKey: "/w/b" }),
      sess({ id: "c", project: "c", colorKey: "/w/c" }),
    );
    expect(ids(orderedSessions())).toEqual(["a", "b", "c"]);
    setProjGroups({ groups: [{ id: "g1", name: "W", collapsed: false }], of: { "/w/a": "g1", "/w/c": "g1" } });
    expect(ids(orderedSessions())).toEqual(["a", "c", "b"]);
  });
  it("keeps a collapsed group's sessions reachable — they are still running", () => {
    open(sess({ id: "a", project: "a", colorKey: "/w/a" }), sess({ id: "b", project: "b", colorKey: "/w/b" }));
    setProjGroups({ groups: [{ id: "g1", name: "W", collapsed: true }], of: { "/w/a": "g1" } });
    expect(ids(orderedSessions())).toEqual(["a", "b"]);
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
  it("never counts a third-party agent — nothing can say it is waiting on you", () => {
    for (const phase of ["done", "error", "working", "idle", "ended"] as const) {
      expect(needsYou(sess({ kind: "agent", phase }))).toBe(false);
    }
    expect(needsYou(sess({ kind: "agent", attention: "Bash" }))).toBe(false);
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
  it("does not count a session whose background fleet is still running", () => {
    // The Workflow tool ends the parent's turn in about two seconds and its agents run
    // for another twenty minutes. Counting that as "your turn" put a workflow in the
    // reactor badge and the tray title as one more session waiting on a human who had
    // nothing to answer — for the whole run.
    expect(needsYou(sess({ phase: "done", ...fleet(13, 12) }))).toBe(false);
    expect(urgencyRank(sess({ phase: "done", ...fleet(13, 12) }))).toBe(3); // ranks with the work it is
  });
  it("still counts one that hit a permission or died mid-fleet", () => {
    // Both outrank the fan-out: Claude is blocked on you now, or the turn is not coming
    // back on its own. Neither resolves itself when the agents land.
    expect(needsYou(sess({ phase: "done", attention: "Bash", ...fleet(13, 12) }))).toBe(true);
    expect(needsYou(sess({ phase: "error", ...fleet(13, 12) }))).toBe(true);
  });
});

describe("syncAttn — when each pane started wanting you", () => {
  it("stamps a session on the way into the set and clears it on the way out", () => {
    const [s] = open(sess({ id: "a", phase: "working" }));
    syncAttn();
    expect(s.attnAt).toBe(0);
    s.phase = "done";
    syncAttn();
    expect(s.attnAt).toBe(NOW_MS);
    s.phase = "thinking";
    syncAttn();
    expect(s.attnAt).toBe(0);
  });
  it("does not move a stamp that is already set", () => {
    // It runs on every paint, and a fleet paints several times a second: a stamp that
    // re-took `now` each time would leave every highlight one frame long and the
    // "longest waiting" order meaningless.
    const [s] = open(sess({ id: "a", phase: "done", attnAt: NOW_MS - 5000 }));
    syncAttn();
    expect(s.attnAt).toBe(NOW_MS - 5000);
  });
  it("stamps a permission that never moved the phase", () => {
    // The reason this is not `phaseSince`: a PermissionRequest arrives mid-tool-call
    // and leaves the phase exactly where it was.
    const [s] = open(sess({ id: "a", phase: "working", phaseSince: NOW_MS - 60000 }));
    syncAttn();
    expect(s.attnAt).toBe(0);
    s.attention = "permission: Bash";
    syncAttn();
    expect(s.attnAt).toBe(NOW_MS);
  });
  it("stamps a fan-out whose grace window has expired, which no event announces", () => {
    const [s] = open(sess({ id: "a", phase: "done", ...fleet(4, 4) }));
    s.subagents = 0;
    s.fanout!.lastAt = NOW_MS - 1000;   // still inside FANOUT_GRACE_MS
    syncAttn();
    expect(s.attnAt).toBe(0);           // the fleet is between stages, not finished
    s.fanout!.lastAt = NOW_MS - 200_000;
    syncAttn();
    expect(s.attnAt).toBe(NOW_MS);      // …and now it is your turn, with no hook to say so
  });
  it("leaves a session it has never seen alone", () => {
    const [s] = open(sess({ id: "a", kind: "shell", phase: "error" }));
    syncAttn();
    expect(s.attnAt).toBe(0);
  });
});

describe("attnPending — the needs-you set minus what you have been to", () => {
  it("drops a finished turn you have opened since", () => {
    const [s] = open(sess({ id: "a", phase: "done", attnAt: 500, seenAt: 900 }));
    expect(needsYou(s)).toBe(true);      // the raw fact is unchanged…
    expect(attnPending(s)).toBe(false);  // …but you have already read it
  });
  it("keeps one you have not been back to", () => {
    const [s] = open(sess({ id: "a", phase: "done", attnAt: 500, seenAt: 100 }));
    expect(attnPending(s)).toBe(true);
  });
  it("keeps a blocking permission you have looked at, because looking is not answering", () => {
    const [s] = open(sess({ id: "a", phase: "working", attention: "permission: Bash", attnAt: 500, seenAt: 900 }));
    expect(attnPending(s)).toBe(true);
  });
  it("drops the pane on the stage without waiting for a second click", () => {
    const [s] = open(sess({ id: "a", phase: "done", attnAt: 500, seenAt: 100 }));
    setActiveId("a");
    expect(attnPending(s)).toBe(false);
  });
  it("drops nothing with the clearing rule switched off", () => {
    setAttnPrefs({ ...ATTN_DEFAULTS, clearOnOpen: false });
    const [s] = open(sess({ id: "a", phase: "done", attnAt: 500, seenAt: 900 }));
    expect(attnPending(s)).toBe(true);
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
  it("keeps the urgency tier ahead of the order, whichever order is picked", () => {
    // The badge takes its wording and its colour from list[0]. A permission sorting
    // below a finished turn because the turn is newer would have it announce "1 your
    // turn" with Claude sitting blocked — which is the one thing it must never say.
    open(
      sess({ id: "turn", phase: "done", attnAt: 900 }),
      sess({ id: "blocked", phase: "working", attention: "Bash", attnAt: 100 }),
    );
    expect(ids(needsYouSessions())).toEqual(["blocked", "turn"]);
    setAttnPrefs({ ...ATTN_DEFAULTS, order: "waiting" });
    expect(ids(needsYouSessions())).toEqual(["blocked", "turn"]);
  });
  it("breaks a tie with the one that just landed, by default", () => {
    open(
      sess({ id: "recent", phase: "done", attnAt: 900 }),
      sess({ id: "oldest", phase: "done", attnAt: 100 }),
      sess({ id: "middle", phase: "done", attnAt: 500 }),
    );
    expect(ids(needsYouSessions())).toEqual(["recent", "middle", "oldest"]);
  });
  it("breaks it the other way when the order is set to longest-waiting", () => {
    setAttnPrefs({ ...ATTN_DEFAULTS, order: "waiting" });
    open(
      sess({ id: "recent", phase: "done", attnAt: 900 }),
      sess({ id: "oldest", phase: "done", attnAt: 100 }),
      sess({ id: "middle", phase: "done", attnAt: 500 }),
    );
    expect(ids(needsYouSessions())).toEqual(["oldest", "middle", "recent"]);
  });
  it("is independent of the sidebar sort, so the reactor stays stable", () => {
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    setProjOrder(["/w/b", "/w/a"]);
    open(
      sess({ id: "a1", project: "a", colorKey: "/w/a", phase: "done", attnAt: 900 }),
      sess({ id: "b1", project: "b", colorKey: "/w/b", phase: "done", attnAt: 100 }),
    );
    expect(ids(orderedSessions())).toEqual(["b1", "a1"]); // the sidebar puts b first…
    expect(ids(needsYouSessions())).toEqual(["a1", "b1"]); // …the reactor still asks when
  });
  it("does not consult the sidebar order even to break an exact tie", () => {
    // Same urgency, same stamp: the stable sort falls back to the order the sessions
    // were opened in, NOT to where the sidebar happens to be showing them.
    setFavorites([{ name: "a", path: "/w/a" }, { name: "b", path: "/w/b" }]);
    setProjOrder(["/w/b", "/w/a"]);
    open(
      sess({ id: "a1", project: "a", colorKey: "/w/a", phase: "done", attnAt: 100 }),
      sess({ id: "b1", project: "b", colorKey: "/w/b", phase: "done", attnAt: 100 }),
    );
    expect(ids(orderedSessions())).toEqual(["b1", "a1"]);
    expect(ids(needsYouSessions())).toEqual(["a1", "b1"]);
  });
  it("sorts a failed run in beside the agents, by its own urgency", () => {
    open(
      sess({ id: "turn", phase: "done", attnAt: 900 }),
      sess({ id: "run", kind: "task", phase: "error", attnAt: 100 }),
    );
    expect(ids(needsYouSessions())).toEqual(["run", "turn"]); // error outranks your turn
  });
  it("leaves out the ones you have already been to", () => {
    open(
      sess({ id: "read", phase: "done", attnAt: 100, seenAt: 500 }),
      sess({ id: "fresh", phase: "done", attnAt: 900, seenAt: 500 }),
    );
    expect(ids(needsYouSessions())).toEqual(["fresh"]);
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
      sess({ id: "c", run: { groupId: "g1" } as never }),
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

describe("nextInGroup — closing one tile stays in the mosaic", () => {
  const m = (...ids: string[]) => ids.map((id) => taskSess(id, {}, { groupId: "g1" }));
  it("promotes the tile that FOLLOWS the one closing", () => {
    // The grid reflows into the gap, so closing the top-left tile makes the next one
    // top-left — that is the one to look at.
    expect(nextInGroup(m("a", "b", "c"), "a")?.id).toBe("b");
    expect(nextInGroup(m("a", "b", "c"), "b")?.id).toBe("c");
  });
  it("falls back to the previous tile when the last one closes", () => {
    expect(nextInGroup(m("a", "b", "c"), "c")?.id).toBe("b");
  });
  it("has nothing to offer when the group had one member", () => {
    expect(nextInGroup(m("only"), "only")).toBeNull();
  });
  it("returns null for a session that isn't in the group at all", () => {
    // The caller then falls back to nextAfterClose, i.e. the sidebar's own answer.
    expect(nextInGroup(m("a", "b"), "elsewhere")).toBeNull();
  });
});

describe("isExited — the process behind the pane is gone", () => {
  it("reads the phase for claude and shell panes", () => {
    expect(isExited(sess({ phase: "ended" }))).toBe(true);
    expect(isExited(sess({ kind: "shell", phase: "ended" }))).toBe(true);
    expect(isExited(sess({ phase: "working" }))).toBe(false);
    // "done" is a live claude pane whose turn finished — NOT an exited one.
    expect(isExited(sess({ phase: "done" }))).toBe(false);
  });
  it("reads the phase for an agent pane too — pty-exit is the only thing that ends one", () => {
    expect(isExited(sess({ kind: "agent", phase: "ended" }))).toBe(true);
    expect(isExited(sess({ kind: "agent", phase: "idle" }))).toBe(false);
  });
  it("reads the exit code for a task — its done/error phases are live states elsewhere", () => {
    expect(isExited(taskSess("t"))).toBe(false);                                   // running
    expect(isExited(taskSess("t", { phase: "done" }, { exitCode: 0 }))).toBe(true);
    expect(isExited(taskSess("t", { phase: "error" }, { exitCode: 1 }))).toBe(true);
    // A task pane with no run record yet cannot claim to have exited.
    expect(isExited(sess({ kind: "task", phase: "error" }))).toBe(false);
  });
});

describe("midFlight — work in flight, the question a branch switch asks", () => {
  it("counts a claude pane only while its turn is actually moving", () => {
    expect(midFlight(sess({ phase: "working" }))).toBe(true);
    expect(midFlight(sess({ phase: "thinking" }))).toBe(true);
    // A blocking permission is mid-turn too: the tool call fires the instant you allow
    // it, so the ground must not have moved between the ask and the answer.
    expect(midFlight(sess({ phase: "idle", attention: "Bash" }))).toBe(true);
    // The three ways an agent waits on YOU. None of them is touching the tree, and this
    // is the whole point of the predicate — one parked conversation used to make a
    // folder unswitchable.
    expect(midFlight(sess({ phase: "idle" }))).toBe(false);
    expect(midFlight(sess({ phase: "done" }))).toBe(false);
    expect(midFlight(sess({ phase: "error" }))).toBe(false);
    expect(midFlight(sess({ phase: "ended" }))).toBe(false);
  });
  it("never counts a shell — it is the prompt you would type `git switch` into", () => {
    expect(midFlight(sess({ kind: "shell", phase: "working" }))).toBe(false);
    expect(midFlight(sess({ kind: "shell", phase: "idle" }))).toBe(false);
  });
  it("never counts a third-party agent — it would block the checkout forever", () => {
    // Not the shell's reasoning. Nothing reports an agent pane idle, so a `true` here
    // would mean a checkout holding one could never be switched again for as long as
    // the pane stayed open — which is most of a working day.
    expect(midFlight(sess({ kind: "agent", phase: "idle" }))).toBe(false);
    expect(midFlight(sess({ kind: "agent", phase: "working" }))).toBe(false);
    expect(midFlight(sess({ kind: "agent", attention: "Bash" }))).toBe(false);
  });
  it("counts a task until it exits, whatever phase it is showing", () => {
    expect(midFlight(taskSess("build"))).toBe(true);
    // A run's done/error are its exit code, not a live state — once it has one, the
    // build it was verifying is over and the branch under it is free to move.
    expect(midFlight(taskSess("build", { phase: "done" }, { exitCode: 0 }))).toBe(false);
    expect(midFlight(taskSess("build", { phase: "error" }, { exitCode: 1 }))).toBe(false);
    // A background run is still a run: it holds the tree for as long as it lives.
    expect(midFlight(taskSess("watch", {}, { background: true }))).toBe(true);
  });
});

describe("dormantBusy — a live session must not be offered for restore", () => {
  it("is busy while an Episko pane holds it, by launch id or rotated resume id", () => {
    open(sess({ id: "a", resumeId: "rot" }));
    expect(dormantBusy(dorm({ id: "a", resumeId: "rot" }))).toBe(true);
    expect(dormantBusy(dorm({ id: "other", resumeId: "rot" }))).toBe(true);
    expect(dormantBusy(dorm({ id: "other", resumeId: "other" }))).toBe(false);
  });

  it("is busy while it runs in someone else's terminal", () => {
    setExternals([ext({ session_id: "d1" })]);
    expect(dormantBusy(dorm({ id: "d1", resumeId: "d1" }))).toBe(true);
  });

  it("is busy while only the BACKEND holds its PTY — a webview reload orphan (#47)", () => {
    // The reload state: frontend map empty, roster row back on screen, process
    // alive. `list_external_sessions` excludes owned pids, so without this set the
    // row would read resumable and a second --resume would interleave the
    // transcript the live process still owns.
    setBackendLive(new Set(["claude:d1"]));
    expect(dormantBusy(dorm({ id: "d1", resumeId: "d1" }))).toBe(true);
    // Rotation before the reload changes nothing: the backend map is keyed by the
    // launch id, which is exactly what the roster's `id` still holds.
    expect(dormantBusy(dorm({ id: "d1", resumeId: "rotated-later" }))).toBe(true);
    expect(dormantBusy(dorm({ id: "gone", resumeId: "gone" }))).toBe(false);
  });

  it("frees the row once the orphan's process exits and the poll catches up", () => {
    setBackendLive(new Set());
    expect(dormantBusy(dorm({ id: "d1", resumeId: "d1" }))).toBe(false);
  });

  it("keys live conversations by provider as well as thread id", () => {
    setBackendLive(new Set(["codex:d1"]));
    expect(dormantBusy(dorm({ id: "d1", provider: "claude" }))).toBe(false);
    expect(dormantBusy(dorm({ id: "d1", provider: "codex" }))).toBe(true);
  });
});

describe("orphanAdoptions — which reload orphans get a pane rebuilt (#47)", () => {
  const live = (o: Partial<{ id: string; kind: string; provider: string | null; workdir: string }> = {}) =>
    ({ id: "o1", kind: "agent", provider: "claude", workdir: "/w/epi", ...o });

  it("adopts a claude orphan under its roster identity", () => {
    const out = orphanAdoptions([live()], [dorm({ id: "o1", resumeId: "rot", project: "Epi!" })]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("o1");
    expect(out[0].meta?.resumeId).toBe("rot");
    expect(out[0].meta?.project).toBe("Epi!");
  });

  it("still adopts an orphan the roster forgot, with meta null", () => {
    // A running conversation is worth more than a tidy label — the caller derives
    // one from the workdir.
    const out = orphanAdoptions([live()], []);
    expect(out).toEqual([{ id: "o1", workdir: "/w/epi", provider: "claude", meta: null }]);
  });

  it("reattaches an integrated Codex pane with its provider identity", () => {
    const out = orphanAdoptions([live({ provider: "codex" })], [dorm({ id: "o1", provider: "codex" })]);
    expect(out[0]?.provider).toBe("codex");
    expect(out[0]?.meta?.provider).toBe("codex");
  });

  it("leaves shells and tasks alone — their metadata did not survive the reload", () => {
    expect(orphanAdoptions([live({ kind: "shell" }), live({ id: "o2", kind: "task" })], [])).toEqual([]);
  });

  it("never adopts a pane the frontend already has", () => {
    open(sess({ id: "o1" }));
    expect(orphanAdoptions([live()], [])).toEqual([]);
  });
});

describe("pickAgent — which agent a launch in this project starts", () => {
  const cli = (id: string, label = id): AgentCli =>
    ({ id, label, mark: id.slice(0, 2), bin: id, path: `/usr/local/bin/${id}`, capabilities: [] });
  /// Known to Episko, absent from this machine — what `list_agents` now returns for
  /// the twelve you haven't installed, and what the picker greys out.
  const gone = (id: string, label = id): AgentCli => ({ ...cli(id, label), path: null });
  const avail = [cli("codex", "Codex"), cli("gemini", "Gemini CLI")];

  it("prefers the project override, then the global default, then Claude", () => {
    expect(pickAgent("/repo", "claude", {}, avail).id).toBe("claude");
    expect(pickAgent("/repo", "codex", {}, avail).id).toBe("codex");
    expect(pickAgent("/repo", "codex", { "/repo": "gemini" }, avail).id).toBe("gemini");
    // The override is per project, so another repo still follows the default.
    expect(pickAgent("/other", "codex", { "/repo": "gemini" }, avail).id).toBe("codex");
  });

  it("falls back to Claude when a stored id is no longer installed", () => {
    // The point of the whole function. Both prefs are ids in localStorage and `avail`
    // is re-probed every startup, so uninstalling an agent must not break ⌘N — the
    // worst case has to be "it started the wrong one", never "nothing starts".
    expect(pickAgent("/repo", "opencode", {}, avail).id).toBe("claude");
    expect(pickAgent("/repo", "codex", {}, []).id).toBe("claude");
    // A dead override drops to the DEFAULT, not straight to Claude — the plain cascade
    // every settings system has, and the least astonishing: "my override broke, so I
    // get my default". Claude is the floor of that cascade, not a special case of it.
    expect(pickAgent("/repo", "codex", { "/repo": "opencode" }, avail).id).toBe("codex");
    // …and when the default is dead too, the floor is where it lands.
    expect(pickAgent("/repo", "kiro", { "/repo": "opencode" }, avail).id).toBe("claude");
  });

  it("refuses an agent that is listed but not installed", () => {
    // The rule that arrived with the greyed rows. `list_agents` returns the whole
    // catalogue now, so being *in* `avail` stopped meaning the binary is there —
    // without the installed check, a preference naming an uninstalled agent (set on a
    // machine that had it, synced or carried over) would launch a row the picker draws
    // as unpickable, and ⌘N would die on a missing binary.
    const mixed = [...avail, gone("opencode", "OpenCode")];
    expect(pickAgent("/repo", "opencode", {}, mixed).id).toBe("claude");
    expect(pickAgent("/repo", "codex", { "/repo": "opencode" }, mixed).id).toBe("codex");
    // And the installed ones in the same list still resolve, so the filter is not just
    // rejecting everything.
    expect(pickAgent("/repo", "gemini", {}, mixed).id).toBe("gemini");
  });

  it("never needs claude to be in the probed list", () => {
    // `available_agents` deliberately omits it — claude goes through spawn_claude, not
    // spawn_agent — so resolving "claude" must work against an empty probe.
    expect(pickAgent("/repo", "claude", {}, [])).toEqual(CLAUDE_CLI);
    expect(pickAgent("/repo", "claude", { "/repo": "claude" }, [])).toEqual(CLAUDE_CLI);
  });

  it("returns the whole entry, so a caller gets the label and mark it will render", () => {
    expect(pickAgent("/repo", "codex", {}, avail)).toEqual(avail[0]);
  });
});
