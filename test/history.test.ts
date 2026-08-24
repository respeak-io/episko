import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CLAUDE_CLI, type ExtSession, type Restorable, type Sess } from "../src/types";
import { store } from "./localstorage"; // must precede the subject imports
import { sessions, setBackendLive, setDormants, setExternals, setFavorites } from "../src/state";
import {
  histBucket, histBusy, histInProject, histLabel, histMatches, histProject,
  type HistEntry,
} from "../src/history";

const NOW_MS = 1800000000000; // 2027-01-15T08:00:00Z
const DAY = 86400000;

// A row as `list_session_history` returns one. Defaults describe the ordinary case:
// a repo checked out at its own root, still on disk.
const row = (o: Partial<HistEntry> = {}): HistEntry => ({
  provider: "claude", session_id: "s1", cwd: "/w/epi", project: "epi", branch: "main",
  title: "A past chat", last_prompt: "", last_active: NOW_MS / 1000, bytes: 2048,
  exists: true, repo_root: "/w/epi", ...o,
});
const sess = (o: Partial<Sess> = {}): Sess => ({
  id: "sid", project: "epi", accent: "#fff", workdir: "/w/epi", colorKey: "/w/epi",
  resumeId: "sid", branch: "main", worktree: null, title: "",
  phase: "idle", phaseSince: 0, lastActivity: 0, attention: null,
  pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0, fanout: null,
  model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
  curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [],
  git: null, res: null, lastEvent: "", activity: [], files: [], tally: {},
  kind: "agent", provider: "claude", capabilities: [...CLAUDE_CLI.capabilities], external: false, ...o,
} as Sess);
const dorm = (o: Partial<Restorable> = {}): Restorable =>
  ({ id: "d1", resumeId: "d1", provider: "claude", project: "epi", workdir: "/w/epi", colorKey: "/w/epi",
     worktree: null, branch: "main", title: "", lastActivity: 0, ...o });
const ext = (o: Partial<ExtSession> = {}): ExtSession =>
  ({ pid: 1, session_id: "e1", cwd: "/w/epi", name: "epi", status: "idle", version: "2.1", ...o });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  sessions.clear();
  setExternals([]); setDormants([]); setFavorites([]); setBackendLive(new Set());
  store.clear();
});
afterEach(() => { vi.useRealTimers(); });

describe("histProject — regrafting a row onto the sidebar's grouping", () => {
  it("groups a worktree under its repo, which no path test could do", () => {
    // The layout this exists for: the worktree is a SIBLING of the repo, so a prefix
    // match on the repo path finds nothing. Only the backend's repo_root can.
    const p = histProject(row({
      cwd: "/w/.cc-worktrees/epi/chore-tests", repo_root: "/w/epi", branch: "chore/tests",
    }));
    expect(p.colorKey).toBe("/w/epi");
    expect(p.project).toBe("epi");
    expect(p.worktree).toBe("chore/tests");
  });

  it("treats the repo's own checkout as the main one, not a worktree", () => {
    const p = histProject(row({ cwd: "/w/epi", repo_root: "/w/epi" }));
    expect(p.colorKey).toBe("/w/epi");
    expect(p.worktree).toBeNull();
  });

  it("prefers a session Episko already has — it carries the user's naming", () => {
    sessions.set("a", sess({ id: "a", workdir: "/w/epi", project: "Episko!", colorKey: "/custom/key", worktree: "wt" }));
    const p = histProject(row({ cwd: "/w/epi", repo_root: "/w/epi" }));
    expect(p).toEqual({ project: "Episko!", colorKey: "/custom/key", worktree: "wt" });
  });

  it("falls back to a dormant row when no session is live", () => {
    setDormants([dorm({ workdir: "/w/epi", project: "From roster", colorKey: "/roster/key" })]);
    expect(histProject(row()).project).toBe("From roster");
  });

  it("takes a favourite's name, and the innermost one when they nest", () => {
    setFavorites([{ name: "Outer", path: "/w" }, { name: "Inner", path: "/w/epi" }]);
    const p = histProject(row({ cwd: "/w/epi/sub", repo_root: "/w/epi" }));
    expect(p).toEqual({ project: "Inner", colorKey: "/w/epi", worktree: "main" });
  });

  it("falls back to the bare cwd when the folder is not a repo at all", () => {
    const p = histProject(row({ cwd: "/w/scratch", repo_root: null, branch: "" }));
    expect(p).toEqual({ project: "scratch", colorKey: "/w/scratch", worktree: null });
  });

  it("handles a Windows path, where the separator is the other one", () => {
    setFavorites([{ name: "Epi", path: "E:\\Work\\epi" }]);
    const p = histProject(row({ cwd: "E:\\Work\\epi\\sub", repo_root: "E:\\Work\\epi" }));
    expect(p.colorKey).toBe("E:\\Work\\epi");
    expect(p.project).toBe("Epi");
  });
});

describe("histBusy — a live session must not be resumed twice", () => {
  it("is busy when Episko launched it, by id or by the id it resumed", () => {
    sessions.set("a", sess({ id: "a", resumeId: "a" }));
    sessions.set("b", sess({ id: "b", resumeId: "rot" })); // rotated by /clear or /compact
    expect(histBusy(row({ session_id: "a" }))).toBe(true);
    expect(histBusy(row({ session_id: "rot" }))).toBe(true);
    expect(histBusy(row({ session_id: "other" }))).toBe(false);
  });

  it("is busy when it runs in someone else's terminal", () => {
    setExternals([ext({ session_id: "e1" })]);
    expect(histBusy(row({ session_id: "e1" }))).toBe(true);
  });

  it("matches ids case-insensitively, like the telemetry router", () => {
    sessions.set("a", sess({ id: "AbC", resumeId: "AbC" }));
    expect(histBusy(row({ session_id: "abc" }))).toBe(true);
  });

  it("is busy when only the backend still holds the PTY — a reload orphan (#47)", () => {
    // A webview reload empties the frontend map while the process runs on, and an
    // owned pid is excluded from externals — so this set is the only witness.
    setBackendLive(new Set(["claude:orph"]));
    expect(histBusy(row({ session_id: "orph" }))).toBe(true);
    expect(histBusy(row({ session_id: "other" }))).toBe(false);
  });

  it("reaches an orphan's rotated id through the roster, which saved the rotation", () => {
    // The orphan ran /clear before the reload: its transcript now lives under "rot",
    // an id the backend never sees. Only cc-restore links the two.
    setBackendLive(new Set(["claude:orph"]));
    setDormants([dorm({ id: "orph", resumeId: "rot" })]);
    expect(histBusy(row({ session_id: "rot" }))).toBe(true);
  });

  it("a roster entry whose launch is not live in the backend proves nothing", () => {
    setDormants([dorm({ id: "gone", resumeId: "rot" })]);
    expect(histBusy(row({ session_id: "rot" }))).toBe(false);
  });

  it("does not confuse equal thread ids owned by different providers", () => {
    sessions.set("codex-pane", sess({ id: "same", resumeId: "same", provider: "codex" }));
    setBackendLive(new Set(["codex:orphan"]));
    expect(histBusy(row({ provider: "claude", session_id: "same" }))).toBe(false);
    expect(histBusy(row({ provider: "claude", session_id: "orphan" }))).toBe(false);
    expect(histBusy(row({ provider: "codex", session_id: "same" }))).toBe(true);
  });
});

describe("histInProject — what the ◧ chip narrows to", () => {
  it("includes a worktree of the scoped repo", () => {
    const wt = row({ cwd: "/w/.cc-worktrees/epi/x", repo_root: "/w/epi" });
    expect(histInProject(wt, "/w/epi")).toBe(true);
    expect(histInProject(wt, "/w/other")).toBe(false);
  });

  it("still matches by path when the repo could not be resolved", () => {
    // No git, or the folder is gone — repo_root is null and only the path is left.
    const gone = row({ cwd: "/w/epi/sub", repo_root: null, exists: false });
    expect(histInProject(gone, "/w/epi")).toBe(true);
  });

  it("does not match a sibling whose path merely shares a prefix", () => {
    expect(histInProject(row({ cwd: "/w/epi-two", repo_root: "/w/epi-two" }), "/w/epi")).toBe(false);
  });
});

describe("histLabel / histMatches", () => {
  it("falls back title → last prompt → a placeholder", () => {
    expect(histLabel(row({ title: "T", last_prompt: "P" }))).toBe("T");
    expect(histLabel(row({ title: "", last_prompt: "P" }))).toBe("P");
    expect(histLabel(row({ title: "", last_prompt: "" }))).toBe("untitled session");
  });

  it("searches the path and branch too, not just what the row shows", () => {
    const h = row({ title: "Fix the parser", branch: "feat/x", cwd: "/w/deep/epi" });
    expect(histMatches(h, "parser")).toBe(true);
    expect(histMatches(h, "FEAT/X")).toBe(true);   // case-insensitive
    expect(histMatches(h, "deep")).toBe(true);     // path is searchable, though unshown
    expect(histMatches(h, "nope")).toBe(false);
    expect(histMatches(h, "")).toBe(true);
  });
});

describe("histBucket — coarse day buckets", () => {
  const at = (ms: number) => histBucket(ms, NOW_MS);
  it("buckets by calendar day, not elapsed hours", () => {
    expect(at(NOW_MS)).toBe("Today");
    expect(at(NOW_MS - 1 * DAY)).toBe("Yesterday");
    expect(at(NOW_MS - 3 * DAY)).toBe("Earlier this week");
    expect(at(NOW_MS - 20 * DAY)).toBe("This month");
    expect(at(NOW_MS - 200 * DAY)).toBe("This year");
    expect(at(NOW_MS - 500 * DAY)).toBe("Older");
  });
  it("keeps a future last-active in Today rather than inventing a bucket", () => {
    // Clock skew, or a transcript still being written to.
    expect(at(NOW_MS + 60000)).toBe("Today");
  });
});
