import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  actKey, apiErrText, bgWaiting, CLAUDE_CLI, FANOUT_DEAD_MS, FANOUT_GRACE_MS, fanoutTally,
  liveAgents, liveCount, ORPHAN_DEAD_MS, orphanAgents, phaseText, statusKey, type Sess,
} from "../src/types";
import { store } from "./localstorage"; // must precede the subject imports
import { rl, rlSamples, fcLog, midSnap } from "../src/rl";
import { usage, usageDetail, resetCostBaselines } from "../src/usage";
import {
  abbr, applyHook, applyPlan, applyStatusline, applyTodos, clearPending, parseWorkflowMeta,
  permCmd, pushHist, riskLevel, setOnTurnEnd, setPhase, toolArg,
} from "../src/phase";
import { DETAIL_CAP } from "../src/toolio";

// clearPending releases a still-held blocking permission request through the
// backend. `invoke` is `window.__TAURI_INTERNALS__.invoke`, so a recording stub is
// all it takes to assert the release actually happens (and, more importantly, that
// it doesn't happen when there is nothing held).
const ipc: { cmd: string; args: any }[] = [];
(globalThis as any).window = {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: any) => { ipc.push({ cmd, args }); return Promise.resolve(null); } },
};

const NOW_MS = 1800000000000; // 2027-01-15T08:00:00Z
const NOW_S = NOW_MS / 1000;
const HOUR = 3600;

// A Sess as newSession() builds one, minus the DOM/xterm handles nothing here reads.
function sess(o: Partial<Sess> = {}): Sess {
  return {
    id: "sid", project: "epi", accent: "#fff", workdir: "/w/epi", colorKey: "/w/epi",
    resumeId: "sid", branch: "main", worktree: null, title: "",
    phase: "idle", phaseSince: Date.now(), lastActivity: 0, attention: null,
    pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], agents: new Map(), fanout: null, apiErr: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [], rateLimitScope: null,
    git: null, res: null, lastEvent: "", activity: [], files: [], tally: {}, servers: [],
    kind: "agent", provider: "claude", capabilities: [...CLAUDE_CLI.capabilities], external: false, ...o,
  } as Sess;
}
const hook = (s: Sess, hook_event_name: string, extra: Record<string, unknown> = {}) =>
  applyHook(s, { hook_event_name, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  ipc.length = 0;
  rl.h5 = rl.h5Reset = rl.d7 = rl.d7Reset = null;
  rlSamples.h5 = []; rlSamples.d7 = [];
  fcLog.length = 0; midSnap.h5 = midSnap.d7 = null;
  for (const k of Object.keys(usage)) delete usage[k];
  for (const k of Object.keys(usageDetail)) delete usageDetail[k];
  resetCostBaselines();
  setOnTurnEnd(() => {});
  store.clear();
});
afterEach(() => { vi.useRealTimers(); });

describe("setPhase — the anchor for every dwell clock", () => {
  it("stamps phaseSince only when the phase actually changes", () => {
    const s = sess({ phase: "idle", phaseSince: 1 });
    setPhase(s, "idle");
    expect(s.phaseSince).toBe(1); // a repeated event must not restart the timer
    setPhase(s, "working");
    expect(s).toMatchObject({ phase: "working", phaseSince: NOW_MS });
  });
});

describe("applyHook — the lifecycle state machine", () => {
  it("records the event name and bumps lastActivity on every hook", () => {
    // lastActivity is what "sort by activity" orders the sidebar on.
    const s = sess({ lastActivity: 0 });
    hook(s, "PostToolUse", { tool_name: "Read" });
    expect(s).toMatchObject({ lastEvent: "PostToolUse", lastActivity: NOW_MS });
  });
  it("names an event-less payload rather than crashing on it", () => {
    const s = sess();
    applyHook(s, {});
    expect(s.lastEvent).toBe("?");
  });

  it("walks a plain turn idle → thinking → working → done", () => {
    const s = sess();
    hook(s, "SessionStart");
    expect(s.phase).toBe("idle");
    hook(s, "UserPromptSubmit");
    expect(s.phase).toBe("thinking");
    hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "/a/b/c.ts" } });
    expect(s).toMatchObject({ phase: "working", curTool: "Read", curArg: "c.ts" });
    hook(s, "Stop");
    expect(s).toMatchObject({ phase: "done", curTool: "", curArg: "" });
  });
  it("ends on SessionEnd and errors on a failed tool or turn", () => {
    const s = sess();
    hook(s, "PostToolUseFailure", { tool_name: "Bash" });
    expect(s.phase).toBe("error");
    hook(s, "StopFailure");
    expect(s.phase).toBe("error");
    hook(s, "SessionEnd");
    expect(s).toMatchObject({ phase: "ended", curTool: "", curArg: "" });
  });

  describe("attention", () => {
    it("raises it on a PermissionRequest, with the command and its risk", () => {
      const s = sess();
      hook(s, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "git push --force" } });
      expect(s).toMatchObject({
        attention: "permission: Bash", pendingCmd: "git push --force", pendRisk: "high",
      });
    });
    it("raises it on a permission Notification, by type or by message", () => {
      const byType = sess();
      hook(byType, "Notification", { notification_type: "tool_permission" });
      expect(byType.attention).toBe("permission needed");
      const byMsg = sess();
      hook(byMsg, "Notification", { notification_type: "other", message: "Claude needs your permission to use Bash" });
      expect(byMsg).toMatchObject({ attention: "permission needed", pendingCmd: "Claude needs your permission to use Bash" });
    });
    it("treats an idle prompt as the turn being over, not as an ask", () => {
      const s = sess({ phase: "working" });
      hook(s, "Notification", { notification_type: "idle_prompt" });
      expect(s).toMatchObject({ phase: "done", attention: null });
    });
    it("passes any other notification through as its own attention text", () => {
      const s = sess();
      hook(s, "Notification", { notification_type: "", message: "" });
      expect(s.attention).toBe("notification"); // never a blank badge
      hook(s, "Notification", { message: "build finished" });
      expect(s.attention).toBe("build finished");
    });

    it("clears on any lifecycle event past the permission point", () => {
      // The user may have answered in the CLI instead of in Episko; the next
      // lifecycle event is then our only signal that the ask is done.
      for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]) {
        const s = sess({ attention: "permission: Bash", pendingCmd: "rm -rf /", pendingPermId: null });
        hook(s, ev);
        expect(s, ev).toMatchObject({ attention: null, pendingCmd: "" });
      }
    });
    it("releases a still-held blocking request when it clears", () => {
      const s = sess({ pendingPermId: "perm-7", attention: "permission: Bash" });
      hook(s, "Stop");
      // Left held, the tiny_http server never answers and Claude hangs forever.
      expect(ipc).toEqual([{ cmd: "resolve_permission", args: { id: "perm-7", behavior: "terminal" } }]);
      expect(s.pendingPermId).toBeNull();
    });
    it("releases every queued parallel request when lifecycle moves on", () => {
      const s = sess({
        pendingPermId: "perm-1", attention: "permission: Bash",
        pendingPermissions: [
          { id: "perm-1", tool: "Bash", command: "git push", risk: "high" },
          { id: "perm-2", tool: "Edit", command: "write app.ts", risk: "med" },
        ],
      });
      hook(s, "Stop");
      expect(ipc).toEqual([
        { cmd: "resolve_permission", args: { id: "perm-1", behavior: "terminal" } },
        { cmd: "resolve_permission", args: { id: "perm-2", behavior: "terminal" } },
      ]);
      expect(s.pendingPermissions).toEqual([]);
      expect(s.pendingPermId).toBeNull();
    });
    it("calls the backend only when something is actually held", () => {
      clearPending(sess({ pendingPermId: null }));
      expect(ipc).toHaveLength(0);
    });
  });

  // The bug this guards: a 529 killed the turn, StopFailure painted the row red —
  // and sixty seconds later Claude Code's idle Notification painted it green again.
  // Same nudge fires whether the turn finished or died, so nothing downstream could
  // tell the difference, and the sidebar ended up claiming "your turn" over a pane
  // reading "API Error: 529 Overloaded".
  describe("a turn the API killed", () => {
    it("records why, from the StopFailure hook", () => {
      const s = sess({ phase: "working", curTool: "Bash", curArg: "ls" });
      hook(s, "StopFailure", { error: "overloaded", error_details: "API Error: 529 Overloaded." });
      expect(s).toMatchObject({ phase: "error", curTool: "", curArg: "" });
      expect(s.apiErr).toMatchObject({ kind: "overloaded", detail: "API Error: 529 Overloaded." });
    });
    it("still records something when the payload carries no reason", () => {
      const s = sess();
      hook(s, "StopFailure");
      expect(s.apiErr).toMatchObject({ kind: "unknown", detail: "" });
    });
    it("stays failed when the idle nudge arrives a minute later", () => {
      const s = sess({ phase: "working" });
      hook(s, "StopFailure", { error: "overloaded" });
      vi.setSystemTime(NOW_MS + 60_000);
      hook(s, "Notification", { notification_type: "idle_prompt" });
      expect(s).toMatchObject({ phase: "error", attention: null }); // never "done"
    });
    it("stays failed even if a Stop somehow follows, and skips the run-on-stop rule", () => {
      let runs = 0;
      setOnTurnEnd(() => { runs++; });
      const s = sess({ phase: "working" });
      hook(s, "StopFailure", { error: "rate_limit" });
      hook(s, "Stop");
      expect(s.phase).toBe("error");
      expect(runs).toBe(0); // verifying half-written files helps nobody
    });
    it("clears the moment the session starts another turn", () => {
      for (const [ev, extra] of [["UserPromptSubmit", {}], ["PreToolUse", { tool_name: "Read" }], ["SessionStart", {}], ["SessionEnd", {}]] as const) {
        const s = sess({ phase: "error", apiErr: { kind: "overloaded", detail: "", at: 1 } });
        hook(s, ev, extra);
        expect(s.apiErr, ev).toBeNull();
      }
    });
    it("lets the next turn end green again", () => {
      const s = sess({ phase: "working" });
      hook(s, "StopFailure", { error: "overloaded" });
      hook(s, "UserPromptSubmit");
      hook(s, "Stop");
      expect(s).toMatchObject({ phase: "done", apiErr: null });
    });
    it("names the failure wherever a state is spelled out", () => {
      const s = sess({ phase: "error", apiErr: { kind: "overloaded", detail: "", at: 1 } });
      expect(phaseText(s)).toBe("API overloaded");
      expect(phaseText(sess({ phase: "error" }))).toBe("error");   // no reason to name
      expect(phaseText(sess({ phase: "done" }))).toBe("your turn"); // unchanged otherwise
      // An enum value Claude adds later still reads as itself, not as a blank.
      expect(apiErrText({ kind: "teapot_error", detail: "", at: 1 })).toBe("teapot error");
      expect(apiErrText({ kind: "", detail: "", at: 1 })).toBe("API error");
    });
  });

  describe("the activity timeline", () => {
    it("opens an entry on PreToolUse and closes it with its latency", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
      expect(s.activity[0]).toMatchObject({ tool: "Bash", arg: "ls", durMs: null });
      vi.setSystemTime(NOW_MS + 250);
      hook(s, "PostToolUse", { tool_name: "Bash" });
      expect(s.activity[0].durMs).toBe(250);
    });
    // The next three drive the *fallback*: no payload here carries a `tool_use_id`, so
    // pairing falls back to the tool name, which is what this did for every call before
    // the id join existed. Kept as the fallback's spec, not as the preferred path.
    it("closes the most recent still-open call of that tool", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "a.ts" } });
      vi.setSystemTime(NOW_MS + 100);
      hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "b.ts" } });
      vi.setSystemTime(NOW_MS + 300);
      hook(s, "PostToolUse", { tool_name: "Read" });
      // unshift means [0] is the newest; it is the one that gets the latency.
      expect(s.activity.map((a) => [a.arg, a.durMs])).toEqual([["b.ts", 200], ["a.ts", null]]);
    });
    it("skips an already-closed entry and reaches the one still open behind it", () => {
      // Two parallel Reads: the second Post must land on the *older* open call, not
      // overwrite the latency the first Post already recorded on the newer one.
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "a.ts" } });
      vi.setSystemTime(NOW_MS + 100);
      hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "b.ts" } });
      vi.setSystemTime(NOW_MS + 300);
      hook(s, "PostToolUse", { tool_name: "Read" }); // closes b.ts at 200ms
      vi.setSystemTime(NOW_MS + 900);
      hook(s, "PostToolUse", { tool_name: "Read" }); // closes a.ts at 900ms
      expect(s.activity.map((a) => [a.arg, a.durMs])).toEqual([["b.ts", 200], ["a.ts", 900]]);
    });
    it("caps the timeline at 12 entries, newest first", () => {
      const s = sess();
      for (let i = 0; i < 15; i++) hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: `f${i}.ts` } });
      expect(s.activity).toHaveLength(12);
      expect(s.activity[0].arg).toBe("f14.ts");
    });
    it("keeps the plan tools off the timeline — the plan is its own module", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "TodoWrite", tool_input: { todos: [{ content: "a", status: "pending" }] } });
      hook(s, "PreToolUse", { tool_name: "ExitPlanMode", tool_input: { plan: "- step one" } });
      expect(s.activity).toHaveLength(0);
      expect(s.todos.map((t) => t.content)).toEqual(["step one"]);
    });
    it("ignores a PostToolUse with no matching open call", () => {
      const s = sess();
      hook(s, "PostToolUse", { tool_name: "Grep" });
      expect(s.activity).toHaveLength(0);
    });
    it("drops a Post whose id matches nothing rather than closing another call's row", () => {
      // The id is present and unknown — its Pre row aged out past ACT_CAP, or never
      // opened. Falling back to the tool name here would close the oldest still-open
      // Bash and staple this output onto it, which under parallel subagents is routine
      // and is a row claiming it ran something it did not. The name match is for a
      // payload with NO id; it is not a second chance for one that missed.
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } });
      vi.setSystemTime(NOW_MS + 400);
      hook(s, "PostToolUse", { tool_name: "Bash", tool_use_id: "gone", tool_response: { stdout: "not mine" } });
      expect(s.activity.map((a) => [a.arg, a.durMs])).toEqual([["ls", null]]);
      expect(s.activity[0].out).toBe("");
      // The right id still closes it.
      hook(s, "PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_response: { stdout: "mine" } });
      expect(s.activity[0].durMs).toBe(400);
    });
  });

  // What was executed and what came back, kept on the row so the inspector can expand it.
  //
  // The pairing is the load-bearing half. Matching on the tool name picks the most
  // recent open call so named, which is wrong the moment two calls of one tool overlap —
  // the normal state of affairs under parallel subagents. That only ever misplaced a
  // latency bar, so it went unnoticed for a year; hanging a command's *output* off the
  // wrong row is a lie the card states in full, so `tool_use_id` — which Claude Code puts
  // on both payloads of a call — is what joins them now.
  describe("what a tool call ran and what it returned", () => {
    it("pairs Pre with Post by tool_use_id, whatever order the answers arrive in", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "slow" } });
      vi.setSystemTime(NOW_MS + 100);
      hook(s, "PreToolUse", { tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "fast" } });
      vi.setSystemTime(NOW_MS + 200);
      // t2 answers first. The name match would have closed it too — and then put its
      // output on t2 as well, because t2 is the newest open Bash. The id says otherwise.
      hook(s, "PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_response: { stdout: "from-slow" } });
      expect(s.activity.map((a) => [a.arg, a.out, a.durMs])).toEqual([
        ["fast", "", null],
        ["slow", "from-slow", 200],
      ]);
      hook(s, "PostToolUse", { tool_name: "Bash", tool_use_id: "t2", tool_response: { stdout: "from-fast" } });
      expect(s.activity.map((a) => [a.arg, a.out])).toEqual([["fast", "from-fast"], ["slow", "from-slow"]]);
    });
    it("keeps the whole command, not the 64 characters the row label shows", () => {
      const s = sess();
      const cmd = "echo " + "x".repeat(300);
      hook(s, "PreToolUse", { tool_name: "Bash", tool_use_id: "t", tool_input: { command: cmd } });
      expect(s.activity[0].arg).toHaveLength(64);
      expect(s.activity[0].inp).toBe(cmd);
    });
    // A PostToolUseFailure carries no `tool_response` whatsoever — the reason is a plain
    // string in `error`, and before this it had no surface anywhere in the app.
    it("records a failure and its reason", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Bash", tool_use_id: "t", tool_input: { command: "cat nope" } });
      hook(s, "PostToolUseFailure", {
        tool_name: "Bash", tool_use_id: "t", tool_response: null,
        error: "Exit code 1\ncat: nope: No such file or directory",
      });
      expect(s.activity[0]).toMatchObject({ failed: true, out: "Exit code 1\ncat: nope: No such file or directory" });
    });
    it("leaves a successful call unmarked", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Bash", tool_use_id: "t", tool_input: { command: "ls" } });
      hook(s, "PostToolUse", { tool_name: "Bash", tool_use_id: "t", tool_response: { stdout: "a" } });
      expect(s.activity[0].failed).toBe(false);
    });
    // The cap belongs here rather than in the view: a Read response is an entire file,
    // and a view-side truncation would keep the whole of it alive for all twelve rows.
    it("caps both sides as they land, not when they are drawn", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Bash", tool_use_id: "t", tool_input: { command: "x".repeat(50_000) } });
      hook(s, "PostToolUse", { tool_name: "Bash", tool_use_id: "t", tool_response: { stdout: "y".repeat(50_000) } });
      expect(s.activity[0].inp.length).toBeLessThan(DETAIL_CAP + 80);
      expect(s.activity[0].out.length).toBeLessThan(DETAIL_CAP + 80);
    });
    it("fills an input the Pre hook lacked, and never overwrites one it had", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Bash", tool_use_id: "t", tool_input: {} });
      hook(s, "PostToolUse", { tool_name: "Bash", tool_use_id: "t", tool_input: { command: "ls" }, tool_response: { stdout: "" } });
      expect(s.activity[0].inp).toBe("ls");

      const s2 = sess();
      hook(s2, "PreToolUse", { tool_name: "Bash", tool_use_id: "u", tool_input: { command: "as submitted" } });
      hook(s2, "PostToolUse", { tool_name: "Bash", tool_use_id: "u", tool_input: {}, tool_response: { stdout: "" } });
      expect(s2.activity[0].inp).toBe("as submitted");
    });
    // The expansion is addressed by key rather than by index: the ring shifts under a
    // live session, and an index would move an open row onto whatever arrived next.
    it("keys a row by its tool_use_id, falling back to when it started", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_abc", tool_input: { command: "a" } });
      hook(s, "PreToolUse", { tool_name: "Bash", tool_input: { command: "b" } });
      expect(actKey(s.activity[1])).toBe("toolu_abc");
      expect(actKey(s.activity[0])).toBe(`t${NOW_MS}`);
    });
  });

  describe("subagent depth suppresses the phase flips", () => {
    // A Task subagent's own tool calls arrive on the parent session's hooks. Letting
    // them drive the phase would flap the glyph between the parent's real state and
    // whatever the subagent happens to be doing.
    it("counts SubagentStart/Stop, never below zero", () => {
      const s = sess();
      hook(s, "SubagentStart"); hook(s, "SubagentStart");
      expect(liveCount(s)).toBe(2);
      hook(s, "SubagentStop"); hook(s, "SubagentStop"); hook(s, "SubagentStop");
      expect(liveCount(s)).toBe(0); // a Stop we never saw the Start for must not go negative
    });
    it("leaves the phase and the vital header alone while a subagent is running", () => {
      const s = sess({ phase: "thinking", curTool: "", curArg: "" });
      hook(s, "SubagentStart");
      hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "x.ts" } });
      expect(s).toMatchObject({ phase: "thinking", curTool: "", curArg: "" });
      hook(s, "PostToolUse", { tool_name: "Read" });
      expect(s.phase).toBe("thinking");
      hook(s, "PostToolUseFailure", { tool_name: "Read" });
      expect(s.phase).toBe("thinking"); // a subagent's failed tool is not the session's error
    });
    it("still records the subagent's calls on the timeline", () => {
      // Suppression is about the phase, not about hiding what happened.
      const s = sess({ phase: "thinking" });
      hook(s, "SubagentStart");
      hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "x.ts" } });
      expect(s.activity[0]).toMatchObject({ tool: "Read", arg: "x.ts" });
    });
    it("resumes driving the phase once the last subagent stops", () => {
      const s = sess({ phase: "thinking" });
      hook(s, "SubagentStart"); hook(s, "SubagentStop");
      hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "x.ts" } });
      expect(s).toMatchObject({ phase: "working", curArg: "x.ts" });
    });
    it("applies the same guard to a finished turn", () => {
      // Once "done" — your turn — a late tool call must not silently take the pane
      // back to "working" and lose the you-are-needed signal.
      const s = sess({ phase: "done" });
      hook(s, "PreToolUse", { tool_name: "Read", tool_input: { file_path: "x.ts" } });
      expect(s.phase).toBe("done");
    });
  });

  // A background fan-out is the one case where the turn ending says nothing about the
  // work ending: the Workflow tool returns a run id in about two seconds and `Stop`
  // fires, while its fleet runs for another twenty minutes. Everything the cockpit shows
  // for that is assembled here, from hooks alone — see the Fanout doc comment in types.
  describe("background fan-outs", () => {
    const WF = `export const meta = {
  name: 'legal-launch-audit',
  description: 'Audit every German-law surface before the lawyer meeting',
  phases: [
    { title: 'Repo-Audit', detail: 'read every legal surface in the codebase' },
    { title: 'Verifikation', detail: 'adversarial verify' },
  ],
}
const DIMENSIONS = [{ key: 'agb', prompt: 'you are named Bob and your title is auditor' }]
await parallel(DIMENSIONS.map((d) => () => agent(d.prompt, { label: \`audit:\${d.key}\` })))
`;

    describe("parseWorkflowMeta", () => {
      it("lifts the name, the description and the phase titles out of the script", () => {
        expect(parseWorkflowMeta(WF)).toEqual({
          name: "legal-launch-audit",
          detail: "Audit every German-law surface before the lawyer meeting",
          phases: ["Repo-Audit", "Verifikation"],
        });
      });
      it("stops at the meta literal, so an agent prompt can't supply a name or a phase", () => {
        // The script below the literal is arbitrary JavaScript full of the same words —
        // `name:` and `title:` occur throughout real prompts. An unbounded match would
        // pick "Bob" out of a prompt and label the whole run with it.
        const m = parseWorkflowMeta(WF);
        expect(m.name).not.toBe("Bob");
        expect(m.phases).not.toContain("auditor");
      });
      it("survives a script with no meta at all", () => {
        // Never throws and never blocks the fan-out: the counts come from the hooks, and
        // an unnamed fleet is still worth showing.
        expect(parseWorkflowMeta("await agent('go')")).toEqual({ name: "", detail: "", phases: [] });
        expect(parseWorkflowMeta("")).toEqual({ name: "", detail: "", phases: [] });
      });
      it("takes double quotes, backticks and escaped quotes", () => {
        const m = parseWorkflowMeta(`export const meta = {\n  name: "it's-fine",\n  description: \`a \\\`quoted\\\` run\`,\n  phases: [{ title: "One" }],\n}\n`);
        expect(m.name).toBe("it's-fine");
        expect(m.phases).toEqual(["One"]);
      });
      it("bounds what it stores, so a 4kB description can't reach a tooltip", () => {
        const m = parseWorkflowMeta(`export const meta = {\n  name: '${"n".repeat(400)}',\n  description: '${"d".repeat(4000)}',\n}\n`);
        expect(m.name.length).toBeLessThanOrEqual(56);
        expect(m.detail.length).toBeLessThanOrEqual(120);
      });
    });

    it("names the fleet from the Workflow call, before a single agent has started", () => {
      // The whole point of reading the hook rather than Claude Code's own run-state
      // file: that file is written when the run FINISHES. This lands 2s in.
      const s = sess({ phase: "working" });
      hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: { script: WF } });
      expect(s.fanout).toMatchObject({ name: "legal-launch-audit", started: 0, done: 0 });
      expect(s.fanout!.phases).toEqual(["Repo-Audit", "Verifikation"]);
    });
    it("counts cumulatively while the agent set stays the live one", () => {
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: { script: WF } });
      for (let i = 0; i < 3; i++) hook(s, "SubagentStart");
      hook(s, "SubagentStop");
      expect(liveCount(s)).toBe(2);
      expect(s.fanout).toMatchObject({ started: 3, done: 1 });
    });
    it("mints an unnamed fleet for a plain Task burst", () => {
      // No Workflow call, so nothing names it — but the counts and the elapsed are
      // exactly as useful, and the sidebar reads them the same way.
      const s = sess();
      hook(s, "SubagentStart"); hook(s, "SubagentStart");
      expect(s.fanout).toMatchObject({ name: "", started: 2, done: 0 });
    });
    it("never books a completion it has no start for", () => {
      const s = sess();
      hook(s, "SubagentStop"); hook(s, "SubagentStop");
      expect(s.fanout).toBeNull();      // a Stop alone is not a fan-out
      expect(liveCount(s)).toBe(0);
      hook(s, "SubagentStart"); hook(s, "SubagentStop"); hook(s, "SubagentStop");
      expect(s.fanout).toMatchObject({ started: 1, done: 1 }); // done never passes started
    });
    it("clears the fleet on SessionStart and SessionEnd", () => {
      // /clear, /compact and a resume all mint a new Claude session, and a SubagentStop
      // we will now never see would otherwise pin the count above zero forever — a fleet
      // that never finishes, on a session that has nothing running at all.
      for (const ev of ["SessionStart", "SessionEnd"]) {
        const s = sess();
        hook(s, "SubagentStart"); hook(s, "SubagentStart");
        hook(s, ev);
        expect({ ev, n: liveCount(s), f: s.fanout }).toEqual({ ev, n: 0, f: null });
      }
    });
    it("keeps the fleet across a prompt typed while it runs", () => {
      // You are allowed to talk to a session whose workflow is still going. Clearing on
      // UserPromptSubmit would drop the run's name mid-flight and leave `subagents`
      // counting agents nothing could account for.
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: { script: WF } });
      hook(s, "SubagentStart");
      hook(s, "UserPromptSubmit");
      expect(s.fanout).toMatchObject({ name: "legal-launch-audit", started: 1 });
      expect(liveCount(s)).toBe(1);
    });
    it("names a resumed run from its script path, since a resume carries no script", () => {
      // Iterate/resume calls pass `scriptPath` + `resumeFromRunId` and no `script`;
      // parsing the missing script made every resumed workflow an unnamed one. The
      // persisted file is named `<meta.name>-<runId>.js`, so the basename has the name.
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: {
        scriptPath: "/x/y/workflows/scripts/tabs-refactor-wf_36528eec-064.js", resumeFromRunId: "wf_36528eec-064",
      } });
      expect(s.fanout).toMatchObject({ name: "tabs-refactor", started: 0, done: 0 });
    });
    it("keeps the description and phases across a resume the pane launched inline", () => {
      // The filename can recover the name but not the rest; the record already held —
      // written when the inline call's script was parsed — carries both, and it wins
      // whenever the two names agree.
      const s = sess();
      hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: { script: WF } });
      hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: {
        scriptPath: "/x/scripts/legal-launch-audit-wf_12ab34cd-001.js", resumeFromRunId: "wf_12ab34cd-001",
      } });
      expect(s.fanout).toMatchObject({
        name: "legal-launch-audit",
        detail: "Audit every German-law surface before the lawyer meeting",
        started: 0,
      });
      expect(s.fanout!.phases).toEqual(["Repo-Audit", "Verifikation"]);
    });

    describe("what the cockpit reads off it", () => {
      /// A session in exactly the state the screenshot showed: the turn is over, the
      /// fleet is not.
      const fleet = (o: Partial<Sess> = {}) => {
        const s = sess({ phase: "done", ...o });
        hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: { script: WF } });
        for (let i = 0; i < 13; i++) hook(s, "SubagentStart");
        for (let i = 0; i < 12; i++) hook(s, "SubagentStop");
        setPhase(s, "done");
        return s;
      };
      it("stops calling it your turn", () => {
        const s = fleet();
        expect(statusKey(s)).toBe("background");
        expect(phaseText(s)).toBe("1 agent working");
        expect(bgWaiting(s)).toBe(true);
      });
      it("hands the sidebar a done/total the bar and the row agree on", () => {
        expect(fanoutTally(fleet())).toEqual({ done: 12, total: 13 });
      });
      it("counts a second workflow's agents rather than showing 14 of 2", () => {
        // Launching another fan-out restarts the counters while the first fleet is still
        // up, so `started` alone would be behind the live count — a bar past its own end.
        const s = fleet();
        hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: { script: WF } });
        setPhase(s, "done");
        expect(fanoutTally(s)).toEqual({ done: 0, total: 1 });
      });
      it("yields to a permission and to a broken turn", () => {
        // Both outrank it: one is Claude blocked on you right now, the other is a turn
        // that died and will not come back on its own.
        expect(statusKey(fleet({ attention: "permission: Bash" }))).toBe("attention");
        const err = fleet();
        hook(err, "StopFailure", { error: "overloaded" });
        expect(statusKey(err)).toBe("error");
      });
      it("stands down once the fleet has been quiet for the grace window", () => {
        // The window exists for the lulls BETWEEN a workflow's stages, where the live
        // count is legitimately 0 and the run is very much alive. Long enough that a
        // barrier can't flip the sidebar back to a green ✓ and out again.
        const s = fleet();
        hook(s, "SubagentStop");                 // the last one lands
        expect(bgWaiting(s)).toBe(true);
        vi.setSystemTime(NOW_MS + FANOUT_GRACE_MS - 1000);
        expect(bgWaiting(s)).toBe(true);
        vi.setSystemTime(NOW_MS + FANOUT_GRACE_MS + 1000);
        expect(bgWaiting(s)).toBe(false);
        expect(phaseText(s)).toBe("your turn");  // and it really is, now
      });
      it("keeps a long-running agent alive past the window", () => {
        // A workflow agent can run eighteen minutes without the parent seeing one event.
        // A rule that needed recent activity would drop the biggest runs first.
        const s = fleet();
        vi.setSystemTime(NOW_MS + FANOUT_GRACE_MS * 10);
        expect(bgWaiting(s)).toBe(true);
      });
      it("writes the fleet off once the silence outlasts what any real run has shown", () => {
        // The count is differenced from fire-and-forget hooks, and a SubagentStop can
        // genuinely never come (an interrupted run's agents, a dropped POST) — one real
        // pane read "2/8 background" an hour after its run completed, and would have
        // forever. Past FANOUT_DEAD_MS the silence outvotes the counter.
        const s = fleet();                                // one agent up, per the counter
        vi.setSystemTime(NOW_MS + FANOUT_DEAD_MS - 60_000);
        expect(bgWaiting(s)).toBe(true);                  // still believed…
        vi.setSystemTime(NOW_MS + FANOUT_DEAD_MS + 1000);
        expect(bgWaiting(s)).toBe(false);                 // …and now written off
        expect(statusKey(s)).toBe("done");
        expect(fanoutTally(s)).toBeNull();
      });
      it("zeroes the leaked count on the next event, so no later fleet inherits it", () => {
        // fanoutTally's total is `done + running`: a ghost agent left in the set would
        // put a fresh one-agent burst at 0/2 before it had done anything.
        const s = fleet();
        vi.setSystemTime(NOW_MS + FANOUT_DEAD_MS + 1000);
        hook(s, "UserPromptSubmit");
        expect(liveCount(s)).toBe(0);
        hook(s, "SubagentStart");
        setPhase(s, "done");                              // the turn ends; the burst runs on
        expect(s.fanout).toMatchObject({ started: 1, done: 0 });
        expect(fanoutTally(s)).toEqual({ done: 0, total: 1 });
      });
      it("starts a new fleet for a burst after the old one stood down", () => {
        // Resuming the retired record would show "12 of 14 done" for two agents that
        // just launched — page two of a run that already ended.
        const s = fleet();
        hook(s, "SubagentStop");                          // the 13th lands; all done
        vi.setSystemTime(NOW_MS + FANOUT_GRACE_MS * 2);   // the grace window passes
        hook(s, "SubagentStart");
        expect(s.fanout).toMatchObject({ name: "", started: 1, done: 0 });
        expect(liveCount(s)).toBe(1);
      });
      it("says nothing about a session that never fanned out", () => {
        const s = sess({ phase: "done" });
        expect(statusKey(s)).toBe("done");
        expect(fanoutTally(s)).toBeNull();
      });
    });

    // Both hooks carry `agent_id` and `agent_type`, so an agent is retired by name. The
    // counter this replaced could only ever drift up, and every repair for it was a guess
    // about a number; these are the things identity makes answerable outright.
    it("ages an inherited agent faster than a live fleet, which is the whole point", () => {
      // The hour is safe for a fleet only because a real event re-stamps `lastAt` and
      // revives the readout. An orphan has no run left to report it, so the same hour
      // is a ghost's life support. If these ever meet, the bug is back.
      expect(ORPHAN_DEAD_MS).toBeLessThan(FANOUT_DEAD_MS);
    });

    describe("agents by id", () => {
      it("retires the agent the Stop names, not whichever started first", () => {
        const s = sess();
        hook(s, "SubagentStart", { agent_id: "a1", agent_type: "Explore" });
        hook(s, "SubagentStart", { agent_id: "a2", agent_type: "code-reviewer" });
        hook(s, "SubagentStop", { agent_id: "a1", agent_type: "Explore" });
        expect(liveAgents(s).map((a) => a.type)).toEqual(["code-reviewer"]);
      });
      it("ignores a Start replayed under an id already up", () => {
        // A curl the CLI retried, or a POST that landed twice. A counter incremented
        // twice and stayed one too high for the rest of the run with nothing to notice.
        const s = sess();
        hook(s, "SubagentStart", { agent_id: "a1" });
        hook(s, "SubagentStart", { agent_id: "a1" });
        expect(liveCount(s)).toBe(1);
      });
      it("falls back to the oldest agent when the payload carries no id", () => {
        // An older CLI, or a hook shape we mis-read. The whole readout must not vanish
        // on it: no id means a synthetic one in, and oldest-first out.
        const s = sess();
        hook(s, "SubagentStart"); hook(s, "SubagentStart");
        expect(liveCount(s)).toBe(2);
        hook(s, "SubagentStop");
        expect(liveCount(s)).toBe(1);
      });
    });

    // The bug this was written for, at the sizes it actually happened: four agents up
    // when the machine slept, the user asking whether everything was done, the agent
    // starting a FRESH 34-agent workflow — and the pane reading "34 / 36" with every one
    // of that run's agents finished, because `startFanout` restarts the counters while
    // the live count carried over whole. See `Agent.orphanedAt`.
    describe("a fan-out that inherits the last one's agents", () => {
      /// The interrupted burst, then the replacement run, then all of the replacement's
      /// agents landing. `orphans` left behind; `total` agents in the new run.
      const inherit = (orphans: number, total: number) => {
        const s = sess({ phase: "working" });
        hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: { script: WF } });
        for (let i = 0; i < orphans; i++) hook(s, "SubagentStart", { agent_id: `old${i}`, agent_type: "Explore" });
        hook(s, "PreToolUse", { tool_name: "Workflow", tool_input: { script: WF } }); // the restart
        for (let i = 0; i < total; i++) hook(s, "SubagentStart", { agent_id: `new${i}`, agent_type: "general-purpose" });
        for (let i = 0; i < total; i++) hook(s, "SubagentStop", { agent_id: `new${i}`, agent_type: "general-purpose" });
        setPhase(s, "done");
        return s;
      };
      it("keeps counting them while they could still be real", () => {
        // Not dropped on sight: launching a second workflow over one still finishing is
        // ordinary, and a bar that ignored the first fleet would read 34/34 with six
        // agents demonstrably up. This is the state the report described.
        const s = inherit(2, 34);
        expect(fanoutTally(s)).toEqual({ done: 34, total: 36 });
        expect(bgWaiting(s)).toBe(true);
      });
      it("names them apart from the run that inherited them", () => {
        // The half that was missing: "36" was arithmetic nobody could check. An orphan
        // says which run it is from and what kind of agent it is.
        const s = inherit(2, 34);
        expect(orphanAgents(s).map((a) => a.type)).toEqual(["Explore", "Explore"]);
        expect(liveAgents(s)).toHaveLength(2);
      });
      it("does not credit their Stops to the run that inherited them", () => {
        // A straggler from the old fleet landing must not read as progress on the new
        // one — that is how "34 / 34 done" was reached with two of the Stops owed
        // elsewhere. `done` is this run's agents and nobody else's.
        const s = inherit(2, 34);
        hook(s, "SubagentStop", { agent_id: "old0" });
        expect(s.fanout).toMatchObject({ started: 34, done: 34 });
        expect(orphanAgents(s)).toHaveLength(1);
        expect(fanoutTally(s)).toEqual({ done: 34, total: 35 });
      });
      it("writes them off on their own clock, not the live run's", () => {
        // The heart of it. The inheriting run keeps re-stamping `lastAt`, so the hour
        // that guards a live fleet never elapses and the leftovers never expire: the
        // real pane held "34 / 36" from 19:31 until it was restarted. An orphan has no
        // run left to report it, so it ages from the moment it was inherited.
        const s = inherit(2, 34);
        vi.setSystemTime(NOW_MS + ORPHAN_DEAD_MS - 1000);
        expect(fanoutTally(s)).toEqual({ done: 34, total: 36 });   // still believed…
        vi.setSystemTime(NOW_MS + ORPHAN_DEAD_MS + 1000);
        expect(orphanAgents(s)).toEqual([]);                       // …and now written off
        expect(liveCount(s)).toBe(0);
      });
      it("hands the session back to you once they expire", () => {
        // What the wrong number actually cost: `bgWaiting` suppresses the reactor badge,
        // the tray title and the palette's "Needs you" group, so a finished session that
        // wanted a human read as busy for as long as the ghosts survived.
        const s = inherit(2, 34);
        expect(statusKey(s)).toBe("background");
        vi.setSystemTime(NOW_MS + ORPHAN_DEAD_MS + FANOUT_GRACE_MS);
        expect(statusKey(s)).toBe("done");
        expect(phaseText(s)).toBe("your turn");
        expect(fanoutTally(s)).toBeNull();
      });
      it("sweeps the expired ones out of the set on the next event", () => {
        // The read side applies the window, so the display is right with no hook at all;
        // this is the state catching up, so a LATER fleet cannot inherit the ghosts in
        // turn — which is how two of them survived a whole generation to begin with.
        const s = inherit(2, 34);
        vi.setSystemTime(NOW_MS + ORPHAN_DEAD_MS + 1000);
        hook(s, "UserPromptSubmit");
        expect(s.agents.size).toBe(0);
      });
      it("still counts a genuinely overlapping fleet", () => {
        // The case the window must not break: a second workflow launched while the first
        // is really running. Its agents report normally and are retired by name.
        const s = inherit(3, 2);
        expect(fanoutTally(s)).toEqual({ done: 2, total: 5 });
        for (let i = 0; i < 3; i++) hook(s, "SubagentStop", { agent_id: `old${i}` });
        expect(liveCount(s)).toBe(0);
        expect(fanoutTally(s)).toEqual({ done: 2, total: 2 });
      });
    });
  });

  describe("the end of a turn", () => {
    it("hands the session to whatever main.ts wired as the run-on-stop hook", () => {
      const seen: string[] = [];
      setOnTurnEnd((s) => seen.push(s.id));
      hook(sess({ id: "abc" }), "Stop");
      expect(seen).toEqual(["abc"]);
    });
    it("fires only on Stop, not on a failed turn or a session end", () => {
      let n = 0;
      setOnTurnEnd(() => { n++; });
      const s = sess();
      hook(s, "StopFailure"); hook(s, "SessionEnd"); hook(s, "PostToolUse", { tool_name: "Read" });
      expect(n).toBe(0);
      hook(s, "Stop");
      expect(n).toBe(1);
    });
    it("is a no-op by default, so the module stands alone", () => {
      expect(() => hook(sess(), "Stop")).not.toThrow();
    });
  });
});

describe("applyStatusline — the meters, and the proof a session is alive", () => {
  it("un-ends a session that keeps sending statusLines", () => {
    // The documented backstop for id rotation: /clear and /compact fire a SessionEnd
    // while the REPL runs on. A statusLine only comes from a live REPL, so it wins —
    // otherwise the pane sits on the "ended" glyph while Claude is still working.
    const s = sess({ phase: "ended", phaseSince: 1 });
    applyStatusline(s, {});
    expect(s).toMatchObject({ phase: "idle", phaseSince: NOW_MS });
  });
  it("leaves any other phase alone", () => {
    for (const p of ["idle", "thinking", "working", "done", "error"] as const) {
      const s = sess({ phase: p });
      applyStatusline(s, {});
      expect(s.phase, p).toBe(p);
    }
  });

  it("fills model, context and duration when they are present", () => {
    const s = sess();
    applyStatusline(s, {
      model: { display_name: "Opus 4.8" },
      context_window: { used_percentage: 41, used_tokens: 82_000 },
      cost: { total_duration_ms: 90_000 },
    });
    expect(s).toMatchObject({ model: "Opus 4.8", ctxPct: 41, ctxTokens: 82_000, durMs: 90_000 });
    expect(s.ctxHist).toEqual([41]);
  });
  it("accepts the older `tokens` spelling of the context field", () => {
    const s = sess();
    applyStatusline(s, { context_window: { tokens: 5 } });
    expect(s.ctxTokens).toBe(5);
  });
  it("leaves every field it wasn't told about untouched", () => {
    // Fields come and go across Claude Code releases; a payload missing one must
    // not blank a meter that was already showing a real number.
    const s = sess({ model: "Opus 4.8", ctxPct: 41, cost: 1.5, durMs: 90_000 });
    applyStatusline(s, { model: {}, context_window: {}, cost: {} });
    expect(s).toMatchObject({ model: "Opus 4.8", ctxPct: 41, cost: 1.5, durMs: 90_000 });
  });
  it("keeps a reported worktree but never clears one", () => {
    const s = sess({ worktree: "wt-a" });
    applyStatusline(s, { workspace: {} });
    expect(s.worktree).toBe("wt-a"); // the live git poll owns this label, not us
    applyStatusline(s, { workspace: { git_worktree: "wt-b" } });
    expect(s.worktree).toBe("wt-b");
  });

  describe("cost", () => {
    it("rolls up only the increment, since the statusLine reports a running total", () => {
      const s = sess({ model: "Opus 4.8" });
      applyStatusline(s, { cost: { total_cost_usd: 1.25 } });
      applyStatusline(s, { cost: { total_cost_usd: 3.0 } });
      expect(s.cost).toBe(3.0);
      expect(Object.values(usage)[0]).toBeCloseTo(3.0, 10); // 1.25 + 1.75, not 4.25
      expect(Object.values(usageDetail)[0].models).toEqual({ Opus: 3.0 });
    });
    it("adds nothing when a repeated statusLine reports the same total", () => {
      const s = sess();
      applyStatusline(s, { cost: { total_cost_usd: 2 } });
      applyStatusline(s, { cost: { total_cost_usd: 2 } });
      expect(Object.values(usage)[0]).toBe(2);
    });
    it("does not re-book the running total when a resume replaces the pane", () => {
      // The shipped bug, end to end. `Move session` (and restore, and a History
      // reopen) closes the pane and launches a new `Sess` — `cost: null` — for the
      // same conversation, which Claude resumes with its running total intact. The
      // day used to gain that whole total a second time: $30 spent, $58 recorded.
      const before = sess({ resumeId: "conv", model: "Opus 4.8" });
      applyStatusline(before, { cost: { total_cost_usd: 28 } });
      const after = sess({ id: "relaunched", resumeId: "conv", model: "Opus 4.8" });
      applyStatusline(after, { cost: { total_cost_usd: 28 } });
      applyStatusline(after, { cost: { total_cost_usd: 30 } });
      expect(after.cost).toBe(30);
      expect(Object.values(usage)[0]).toBeCloseTo(30, 10); // not 58
      // Both panes are still named — the money moved once, the attribution didn't.
      expect(Object.keys(Object.values(usageDetail)[0].sess!)).toEqual(["sid", "relaunched"]);
      // …and it lands where it was earned: the first pane booked 28 before the move,
      // the relaunched one only the 2 it added on top.
      expect(Object.values(usageDetail)[0].sess!.sid.usd).toBeCloseTo(28, 10);
      expect(Object.values(usageDetail)[0].sess!.relaunched.usd).toBeCloseTo(2, 10);
    });
    it("counts a rotated conversation from scratch, since its counter restarted too", () => {
      // /clear mints a new runtime id *and* zeroes the total. main.ts re-points
      // resumeId before the statusLine lands, so the new id starts its own baseline.
      const s = sess({ resumeId: "conv" });
      applyStatusline(s, { cost: { total_cost_usd: 5 } });
      s.resumeId = "conv2";
      applyStatusline(s, { cost: { total_cost_usd: 0.25 } });
      expect(Object.values(usage)[0]).toBeCloseTo(5.25, 10);
    });
    it("keeps a history for the sparkline, capped", () => {
      const s = sess();
      for (let i = 1; i <= 30; i++) applyStatusline(s, { cost: { total_cost_usd: i } });
      expect(s.costHist).toHaveLength(24);
      expect(s.costHist[23]).toBe(30);
    });
  });

  describe("rate limits", () => {
    it("merges both windows into the one account-wide copy", () => {
      applyStatusline(sess(), {
        rate_limits: {
          five_hour: { used_percentage: 22, resets_at: NOW_S + HOUR },
          seven_day: { used_percentage: 61, resets_at: NOW_S + 3 * 86400 },
        },
      });
      expect(rl).toMatchObject({ h5: 22, h5Reset: NOW_S + HOUR, d7: 61, d7Reset: NOW_S + 3 * 86400 });
    });
    it("keeps the peak when a lagging session reports a staler number", () => {
      // The 13 ↔ 19 ↔ 21 flip: each session's statusLine carries the account numbers
      // only as fresh as *that* session last refreshed them.
      const limits = (pct: number) => ({ rate_limits: { five_hour: { used_percentage: pct, resets_at: NOW_S + HOUR } } });
      applyStatusline(sess({ id: "busy" }), limits(21));
      applyStatusline(sess({ id: "idle" }), limits(13));
      expect(rl.h5).toBe(21);
    });
    it("feeds the burn-rate sampler as readings arrive", () => {
      const limits = (pct: number) => ({ rate_limits: { five_hour: { used_percentage: pct, resets_at: NOW_S + HOUR } } });
      applyStatusline(sess(), limits(20));
      vi.setSystemTime(NOW_MS + 10 * 60_000);
      applyStatusline(sess(), limits(30));
      expect(rlSamples.h5.map((x) => x.pct)).toEqual([20, 30]);
    });
    it("logs the close and resets the samples when a window rotates", () => {
      const limits = (pct: number, reset: number) => ({ rate_limits: { five_hour: { used_percentage: pct, resets_at: reset } } });
      applyStatusline(sess(), limits(95, NOW_S + 60));
      vi.setSystemTime(NOW_MS + 120_000); // the old window has now passed its reset
      applyStatusline(sess(), limits(4, NOW_S + 5 * HOUR));
      expect(rl).toMatchObject({ h5: 4, h5Reset: NOW_S + 5 * HOUR });
      expect(fcLog.map((e) => [e.w, e.final])).toEqual([["h5", 95]]);
    });
    it("ignores a window the payload doesn't mention", () => {
      applyStatusline(sess(), { rate_limits: { five_hour: { used_percentage: 10, resets_at: NOW_S + HOUR } } });
      expect(rl.d7).toBeNull();
    });
  });
});

describe("toolArg — the one field worth showing from a tool call", () => {
  it("collapses a path to its basename, on either separator", () => {
    expect(toolArg("Read", { file_path: "/a/b/c.ts" })).toBe("c.ts");
    expect(toolArg("Edit", { file_path: "E:\\proj\\src\\main.ts" })).toBe("main.ts");
    expect(toolArg("Write", { path: "/a/b/c.ts" })).toBe("c.ts");
  });
  it("shows a bare filename whole, and keeps other tools' paths whole", () => {
    expect(toolArg("Read", { file_path: "notes.md" })).toBe("notes.md");
    expect(toolArg("Bash", { command: "cat /a/b/c.ts" })).toBe("cat /a/b/c.ts");
  });
  it("prefers file_path, then path, then command, over the rest", () => {
    expect(toolArg("Bash", { command: "ls", query: "q" })).toBe("ls");
    expect(toolArg("Grep", { pattern: "TODO", query: "q" })).toBe("TODO");
    expect(toolArg("Task", { description: "d" })).toBe("d");
  });
  it("returns nothing rather than a placeholder when there is nothing to show", () => {
    expect(toolArg("Bash", null)).toBe("");
    expect(toolArg("Bash", "not an object")).toBe("");
    expect(toolArg("Bash", {})).toBe("");
    expect(toolArg("Bash", { command: "   " })).toBe("");
    expect(toolArg("Bash", { command: 42 })).toBe("");
  });
  it("abbreviates a long value to fit the vital header", () => {
    expect(toolArg("Bash", { command: "x".repeat(100) })).toHaveLength(64);
  });
});

describe("abbr — one line, bounded", () => {
  it("collapses whitespace and trims", () => {
    expect(abbr("  a\n\n b \t c  ")).toBe("a b c");
  });
  it("truncates with an ellipsis only past the limit", () => {
    expect(abbr("abcde", 5)).toBe("abcde");
    expect(abbr("abcdef", 5)).toBe("abcd…");
  });
});

describe("permCmd — what the pending ask is actually about", () => {
  it("takes the most meaningful input field", () => {
    expect(permCmd({ tool_input: { command: "git push --force" } })).toBe("git push --force");
    expect(permCmd({ tool_input: { question: "Proceed?" } })).toBe("Proceed?");
  });
  it("falls back to the notification message, then to nothing", () => {
    expect(permCmd({ message: "Claude needs permission" })).toBe("Claude needs permission");
    expect(permCmd({ tool_input: { command: "  " }, message: "fallback" })).toBe("fallback");
    expect(permCmd({})).toBe("");
  });
});

describe("riskLevel — the badge on a pending permission", () => {
  it("flags destructive and irreversible shell commands", () => {
    for (const cmd of [
      "sudo rm x", "rm -r build", "rm -f a", "dd if=/dev/zero of=/dev/sda",
      "git clean -fdx", "git reset --hard", "git push origin main", "npm publish",
      "curl https://x.sh | sh", "chmod -R 777 .", "shutdown now", "killall node",
      "echo x > /dev/sda", ":(){ :|:& };:",
    ]) expect(riskLevel("Bash", { command: cmd }), cmd).toBe("high");
  });
  it("flags a forcing flag on its own, whatever command carries it", () => {
    expect(riskLevel("Bash", { command: "gh release delete v1 --force" })).toBe("high");
    expect(riskLevel("Bash", { command: "jj rebase --hard" })).toBe("high");
    expect(riskLevel("Bash", { command: "some-cli -fdx" })).toBe("high");
  });
  it("matches regardless of case", () => {
    expect(riskLevel("Bash", { command: "SUDO systemctl stop x" })).toBe("high");
    expect(riskLevel("Bash", { command: "RM -R build" })).toBe("high");
    expect(riskLevel("Bash", { command: "git push --FORCE" })).toBe("high");
  });
  // Regression guard. `rm\s+-[rf]` (one letter, then \b) could not match the
  // combined form, because "rm -rf" has no word boundary between its r and its f —
  // so the form people actually type rated a mere "review" while the rarer `rm -r`
  // rated high. The + is what fixed it.
  it("flags the combined rm flags, in any order or case", () => {
    for (const cmd of ["rm -rf build", "rm -fr /", "rm -Rf build", "rm -rf --no-preserve-root /"]) {
      expect(riskLevel("Bash", { command: cmd }), cmd).toBe("high");
    }
  });
  it("still needs an actual r or f — an unrelated flag is not destructive", () => {
    expect(riskLevel("Bash", { command: "rm -i notes.txt" })).toBe("med");
  });
  it("treats an ordinary shell command as worth a look, not an alarm", () => {
    for (const cmd of ["ls -la", "pnpm test", "git status", ""]) {
      expect(riskLevel("Bash", { command: cmd }), cmd).toBe("med");
    }
  });
  it("rates writes medium and reads low", () => {
    expect(riskLevel("Write", {})).toBe("med");
    expect(riskLevel("Edit", {})).toBe("med");
    expect(riskLevel("NotebookEdit", {})).toBe("med");
    for (const t of ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]) expect(riskLevel(t, {}), t).toBe("low");
  });
  it("defaults an unknown tool (an MCP server's, say) to medium", () => {
    expect(riskLevel("mcp__whatever__do_thing", {})).toBe("med");
    expect(riskLevel("Bash", null)).toBe("med");
  });
});

describe("applyTodos — Claude's own plan, off the TodoWrite payload", () => {
  it("takes content and status, falling back to activeForm", () => {
    const s = sess();
    applyTodos(s, { todos: [{ content: "one", status: "completed" }, { activeForm: "two-ing" }] });
    expect(s.todos).toEqual([
      { content: "one", status: "completed" },
      { content: "two-ing", status: "pending" },
    ]);
  });
  it("drops empty items and leaves an existing plan alone when the payload isn't a list", () => {
    const s = sess({ todos: [{ content: "kept", status: "pending" }] });
    applyTodos(s, { todos: "nope" });
    applyTodos(s, undefined);
    expect(s.todos).toEqual([{ content: "kept", status: "pending" }]);
    applyTodos(s, { todos: [{ content: "" }, { content: "real" }] });
    expect(s.todos.map((t) => t.content)).toEqual(["real"]);
  });
});

describe("applyPlan — plan mode's markdown, into the same plan module", () => {
  it("parses bullets, numbered steps and checkboxes alike", () => {
    const s = sess();
    applyPlan(s, { plan: "# Plan\n- one\n* two\n+ three\n1. four\n2) five\n- [x] six" });
    expect(s.todos.map((t) => t.content)).toEqual(["one", "two", "three", "four", "five", "six"]);
    expect(s.todos.every((t) => t.status === "pending")).toBe(true); // a proposal, not in flight
  });
  it("strips inline markdown from a step", () => {
    const s = sess();
    applyPlan(s, { plan: "- run **`pnpm test`** first" });
    expect(s.todos[0].content).toBe("run pnpm test first");
  });
  it("falls back to prose lines when there is no list, skipping headings", () => {
    const s = sess();
    applyPlan(s, { plan: "## Heading\nfirst thing\nsecond thing" });
    expect(s.todos.map((t) => t.content)).toEqual(["first thing", "second thing"]);
  });
  it("caps the plan at 12 steps", () => {
    const s = sess();
    applyPlan(s, { plan: Array.from({ length: 20 }, (_, i) => `- step ${i}`).join("\n") });
    expect(s.todos).toHaveLength(12);
  });
  it("leaves an existing plan alone for an empty or non-string payload", () => {
    const s = sess({ todos: [{ content: "kept", status: "pending" }] });
    applyPlan(s, { plan: "   " });
    applyPlan(s, { plan: 42 });
    applyPlan(s, {});
    expect(s.todos).toEqual([{ content: "kept", status: "pending" }]);
  });
});

describe("pushHist — the sparkline buffers", () => {
  it("appends and keeps only the most recent cap entries", () => {
    const a: number[] = [];
    for (let i = 0; i < 30; i++) pushHist(a, i);
    expect(a).toHaveLength(24);
    expect([a[0], a[23]]).toEqual([6, 29]);
  });
  it("honours an explicit cap", () => {
    const a: number[] = [];
    for (let i = 0; i < 5; i++) pushHist(a, i, 3);
    expect(a).toEqual([2, 3, 4]);
  });
});
