import { beforeEach, describe, expect, it } from "vitest";
import { store } from "./localstorage"; // must precede modules that read localStorage
import { applyAgentEvent, applyAgentEventToFleet } from "../src/agents";
import { CODEX_PERMISSION_MODES, codexApiEquivalentUsd, codexEvents, codexHistoryEntries, codexHistoryMessages } from "../src/providers/codex";
import { rl } from "../src/rl";
import { resetCostBaselines, usage, usageDetail } from "../src/usage";
import type { Sess } from "../src/types";

const sess = (id = "pane-1"): Sess => ({
  id, project: "episko", accent: "#fff", workdir: "/w/episko", colorKey: "/w/episko",
  resumeId: id, branch: "main", worktree: null, title: "Codex",
  phase: "idle", phaseSince: 0, lastActivity: 0, attention: null,
  pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], attnAt: 0, seenAt: 0,
  agents: new Map(), fanout: null, queuedPrompt: false, apiErr: null, revive: null, drift: null,
  model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null, tokenUsage: null, rateLimits: [], rateLimitScope: null,
  curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null,
  lastEvent: "", activity: [], files: [], tally: {}, servers: [], kind: "agent", external: false,
  provider: "codex", capabilities: ["session-state", "activity", "context", "usage", "permissions", "resume", "history"],
  pane: {} as HTMLElement,
});

const raw = (method: string, params: any = {}, requestId: string | null = null) =>
  ({ sessionId: "pane-1", provider: "codex", method, params, requestId });

beforeEach(() => {
  store.clear();
  for (const k of Object.keys(usage)) delete usage[k];
  for (const k of Object.keys(usageDetail)) delete usageDetail[k];
  resetCostBaselines();
  rl.h5 = rl.h5Reset = rl.d7 = rl.d7Reset = null;
});

describe("Codex provider adapter", () => {
  it("owns a distinct, sandbox-aware launch policy list", () => {
    expect(CODEX_PERMISSION_MODES.map((mode) => mode.id)).toEqual([
      "default", "on-request", "read-only", "auto", "bypass",
    ]);
    expect(CODEX_PERMISSION_MODES.find((mode) => mode.id === "auto"))
      .toMatchObject({ asks: false, sub: expect.stringContaining("workspace-write") });
  });

  it("normalizes thread identity, commands and approvals", () => {
    expect(codexEvents(raw("thread/started", { thread: { id: "thread-1", name: "Fix it" } }))[0])
      .toEqual({ type: "thread", id: "thread-1", title: "Fix it" });
    // App Server's generated schema calls this `threadName`; the thread snapshot's
    // `name` spelling does not carry over to this notification.
    expect(codexEvents(raw("thread/name/updated", { threadId: "thread-1", threadName: "Fixed" }))[0])
      .toEqual({ type: "thread", id: "thread-1", title: "Fixed" });
    expect(codexEvents(raw("item/started", { item: { type: "commandExecution", id: "call-1", command: "pnpm test", cwd: "/w/episko", status: "inProgress" } }))[0])
      .toMatchObject({ type: "activity-started", id: "call-1", tool: "Bash", input: "pnpm test" });
    expect(codexEvents(raw("item/commandExecution/requestApproval", { itemId: "call-1", command: "rm -rf build" }, "ask-1"))[0])
      .toMatchObject({ type: "permission", id: "ask-1", tool: "Bash", risk: "high" });
  });

  // A turn you stopped yourself must not look like an outage. The chain this guards is
  // four modules long and every link already existed: `failed: true` → `finishAgentTurn`
  // stamps `apiErr {kind:"unknown"}` → ./revive buckets `unknown` as `other` → `other` is
  // in `REVIVE_DEFAULTS.kinds`, so the watchdog types the prompt back in and presses
  // Enter. Asserting on `failed` alone would pass against the bug for the wrong reason,
  // so this asserts the thing that actually matters: no `apiErr` on the session.
  it("treats a turn somebody stopped as done, not as a failure to be revived", () => {
    for (const status of ["aborted", "cancelled", "canceled", "interrupted", "stopped"]) {
      const s = sess();
      for (const ev of codexEvents(raw("turn/completed", { turn: { status } }))) applyAgentEvent(s, ev);
      expect(s.apiErr, `${status} stamped an apiErr`).toBeNull();
      expect(s.phase, `${status} left the pane in error`).toBe("done");
    }
  });

  it("still reports a real failure, and an unfamiliar status, as one", () => {
    for (const status of ["failed", "some_status_codex_adds_later"]) {
      const s = sess();
      for (const ev of codexEvents(raw("turn/completed", { turn: { status, error: "500 upstream" } }))) applyAgentEvent(s, ev);
      expect(s.apiErr, `${status} lost its error`).not.toBeNull();
      expect(s.phase).toBe("error");
    }
  });

  it("keeps child tools and approvals while ignoring child lifecycle", () => {
    const child = { threadId: "child-1", episkoChild: true };
    expect(codexEvents(raw("turn/completed", { ...child, turn: { status: "completed" } }))).toEqual([]);
    expect(codexEvents(raw("item/started", { ...child, item: {
      type: "commandExecution", id: "call-1", command: "pnpm test", status: "inProgress",
    } }))[0]).toMatchObject({ id: "child-1:call-1", tool: "Subagent · Bash" });
    expect(codexEvents(raw("item/commandExecution/requestApproval", {
      ...child, itemId: "call-1", command: "git push",
    }, "ask-child"))[0]).toMatchObject({ id: "ask-child", tool: "Subagent · Bash", risk: "high" });
  });

  it("normalizes token usage and rate-limit windows", () => {
    const usage = codexEvents(raw("thread/tokenUsage/updated", { tokenUsage: {
      total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 20, outputTokens: 20, reasoningOutputTokens: 5 },
      last: { totalTokens: 60, inputTokens: 50, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 2 },
      modelContextWindow: 200,
    } }))[0];
    expect(usage).toMatchObject({ type: "usage", usage: { total: { totalTokens: 120 }, last: { totalTokens: 60 }, contextWindow: 200 } });
    const limits = codexEvents(raw("account/rateLimits/updated", { rateLimits: {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 10 },
      secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 20 },
    } }))[0];
    expect(limits).toMatchObject({ type: "rate-limits", windows: [{ usedPercent: 12 }, { usedPercent: 34 }] });
  });

  it("keeps structured file reads, edits and newer tools visible in Context", () => {
    const command = codexEvents(raw("item/completed", { item: {
      type: "commandExecution", id: "cmd-read", command: "cat src/app.ts", status: "completed",
      commandActions: [
        { type: "read", name: "app.ts", path: "/w/episko/src/app.ts", command: "cat src/app.ts" },
        { type: "listFiles", path: "/w/episko/src", command: "ls src" },
      ],
    } }))[0];
    expect(command).toMatchObject({
      type: "activity-completed",
      files: [{ path: "/w/episko/src/app.ts", kind: "read" }],
    });

    const changed = codexEvents(raw("item/completed", { item: {
      type: "fileChange", id: "edit-1", status: "completed", changes: [
        { path: "/w/episko/src/new.ts", kind: { type: "add" } },
        { path: "/w/episko/src/old.ts", kind: { type: "update" } },
        { path: "src/before.ts", kind: { type: "move", move_path: "src/after.ts" } },
      ],
    } }))[0];
    expect(changed).toMatchObject({ files: [
      { path: "/w/episko/src/new.ts", kind: "created" },
      { path: "/w/episko/src/old.ts", kind: "edited" },
      { path: "src/before.ts", kind: "edited" },
      { path: "src/after.ts", kind: "edited" },
    ] });

    const image = codexEvents(raw("item/completed", { item: {
      type: "imageView", id: "image-1", path: "/w/episko/mock.png",
    } }))[0];
    expect(image).toMatchObject({ tool: "Read", files: [{ path: "/w/episko/mock.png", kind: "read" }] });

    const collab = codexEvents(raw("item/completed", { item: {
      type: "collabAgentToolCall", id: "agent-1", tool: "spawnAgent", status: "completed",
      prompt: "Review the adapter", receiverThreadIds: ["child-1"], agentsStates: { "child-1": { status: "completed" } },
    } }))[0];
    expect(collab).toMatchObject({ type: "activity-completed", tool: "Agent · spawnAgent", failed: false });
  });

  it("normalizes App Server's cumulative API-equivalent estimate", () => {
    expect(codexApiEquivalentUsd({ estimatedUsageUsdMicros: 2_345_678 })).toBeCloseTo(2.345678, 10);
    expect(codexApiEquivalentUsd({
      estimatedUsageUsdMicros: null,
      groups: [{ model: "gpt-5.6-sol", netNewInputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 }],
    })).toBeCloseTo(24.4, 10);
    expect(codexApiEquivalentUsd({
      estimatedUsageUsdMicros: null,
      groups: [{ model: "gpt-5.6-sol", speed: "fast", netNewInputTokens: 1_000_000, outputTokens: 1_000_000 }],
    })).toBeCloseTo(48, 10);
    expect(codexApiEquivalentUsd({
      estimatedUsageUsdMicros: null,
      groups: [{ model: "future-model", netNewInputTokens: 1_000 }],
    })).toBeNull();
    expect(codexEvents(raw("episko/thread/usage", {
      threadUsage: { threadId: "thread-1", estimatedUsageUsdMicros: 1_250_000 },
    }))[0]).toEqual({ type: "cost", totalUsd: 1.25 });
  });

  it("maps public App Server history without reading Codex rollout files", () => {
    const rows = codexHistoryEntries({ data: [{
      id: "t1", cwd: "/w/episko", name: "A fix", preview: "please fix", updatedAt: 100,
      gitInfo: { branch: "feat" }, episkoExists: true, episkoBytes: 42,
      episkoRepoRoot: "/w/episko", parentThreadId: null,
    }] });
    expect(rows[0]).toMatchObject({
      provider: "codex", session_id: "t1", title: "A fix", branch: "feat",
      bytes: 42, repo_root: "/w/episko",
    });
    const msgs = codexHistoryMessages({ thread: { turns: [{ items: [
      { type: "userMessage", content: [{ type: "text", text: "hello" }] },
      { type: "commandExecution", command: "pwd" },
      { type: "agentMessage", text: "done" },
    ] }] } }, 8);
    expect(msgs).toEqual([{ role: "user", text: "hello" }, { role: "assistant", text: "done" }]);
  });
});

describe("provider-neutral agent reducer", () => {
  it("folds adapter file touches into the shared inspector set", () => {
    const s = sess("files-pane");
    const item = {
      type: "commandExecution", id: "read-1", command: "cat src/app.ts", cwd: "/w/episko",
      status: "completed", commandActions: [
        { type: "read", name: "app.ts", path: "/w/episko/src/app.ts", command: "cat src/app.ts" },
      ],
    };
    for (const event of codexEvents(raw("item/started", { item: { ...item, status: "inProgress" } }))) applyAgentEvent(s, event);
    for (const event of codexEvents(raw("item/completed", { item }))) applyAgentEvent(s, event);
    expect(s.files).toMatchObject([{ path: "/w/episko/src/app.ts", kind: "read", n: 1 }]);
    expect(s.activity[0]).toMatchObject({ tool: "Bash", id: "read-1", failed: false });
  });

  it("drives the shared lifecycle, timeline and permission state", () => {
    const s = sess();
    for (const event of codexEvents(raw("thread/started", { thread: { id: "thread-1", name: "Fix it" } }))) applyAgentEvent(s, event);
    applyAgentEvent(s, { type: "turn-started" });
    applyAgentEvent(s, { type: "activity-started", id: "c1", tool: "Bash", arg: "pnpm test", input: "pnpm test", desc: "" });
    applyAgentEvent(s, { type: "activity-completed", id: "c1", tool: "Bash", input: "pnpm test", inputData: { command: "pnpm test" }, output: "ok", failed: false, files: [] });
    applyAgentEvent(s, { type: "permission", id: "ask", tool: "Bash", command: "git push", risk: "high" });
    expect(s).toMatchObject({ resumeId: "thread-1", title: "Fix it", phase: "working", pendingPermId: "ask", pendRisk: "high" });
    expect(s.activity[0]).toMatchObject({ id: "c1", out: "ok", failed: false });
    expect(s.tally.Bash).toBe(1);
    applyAgentEvent(s, { type: "permission-resolved", id: "ask" });
    applyAgentEvent(s, { type: "turn-completed", failed: false, detail: "", durationMs: 250 });
    expect(s.phase).toBe("done"); expect(s.pendingPermId).toBeNull(); expect(s.durMs).toBe(250);
  });

  it("queues parallel approvals and promotes the next request after a resolution", () => {
    const s = sess();
    applyAgentEvent(s, { type: "permission", id: "ask-1", tool: "Bash", command: "git push", risk: "high" });
    applyAgentEvent(s, { type: "permission", id: "ask-2", tool: "Edit", command: "write app.ts", risk: "med" });
    expect(s.pendingPermissions).toHaveLength(2);
    expect(s).toMatchObject({ pendingPermId: "ask-1", pendingCmd: "git push" });
    applyAgentEvent(s, { type: "permission-resolved", id: "ask-1" });
    expect(s).toMatchObject({ pendingPermId: "ask-2", pendingCmd: "write app.ts", pendRisk: "med" });
    applyAgentEvent(s, { type: "permission-resolved", id: "ask-2" });
    expect(s).toMatchObject({ pendingPermId: null, attention: null, pendingPermissions: [] });
  });

  it("shares quotas only across panes with the same opaque account scope", () => {
    const owner = sess("owner"); const sibling = sess("sibling"); const other = sess("other");
    owner.rateLimitScope = sibling.rateLimitScope = "scope-a";
    other.rateLimitScope = "scope-b";
    const event = { type: "rate-limits" as const, scope: "scope-a", windows: [
      { usedPercent: 42, resetsAt: 100, windowMins: 300 },
    ] };
    applyAgentEventToFleet(owner, event, [owner, sibling, other]);
    expect(owner.rateLimits).toEqual(event.windows);
    expect(sibling.rateLimits).toEqual(event.windows);
    expect(other.rateLimits).toEqual([]);
  });

  it("clears every pane that shared the account's previous scope", () => {
    const owner = sess("owner"); const sibling = sess("sibling"); const other = sess("other");
    owner.rateLimitScope = sibling.rateLimitScope = "scope-a";
    owner.rateLimits = sibling.rateLimits = [{ usedPercent: 42, resetsAt: 100, windowMins: 300 }];
    other.rateLimitScope = "scope-b";
    other.rateLimits = [{ usedPercent: 7, resetsAt: 200, windowMins: 300 }];
    applyAgentEventToFleet(owner, { type: "rate-limits", scope: null, windows: [] }, [owner, sibling, other]);
    expect(owner).toMatchObject({ rateLimitScope: null, rateLimits: [] });
    expect(sibling).toMatchObject({ rateLimitScope: null, rateLimits: [] });
    expect(other).toMatchObject({ rateLimitScope: "scope-b", rateLimits: [{ usedPercent: 7 }] });
  });

  it("resolves relative provider file paths before they reach the inspector", () => {
    const s = sess();
    applyAgentEvent(s, {
      type: "activity-completed", id: "edit", tool: "Edit", input: "", inputData: {},
      output: "completed", failed: false, files: [
        { path: "src/before.ts", kind: "edited" }, { path: "src/after.ts", kind: "edited" },
      ],
    });
    expect(s.files.map((file) => file.path)).toEqual([
      "/w/episko/src/before.ts", "/w/episko/src/after.ts",
    ]);
  });

  it("uses last-call tokens for context and cumulative tokens for analytics", () => {
    const s = sess("usage-pane"); s.resumeId = "usage-thread";
    applyAgentEvent(s, { type: "usage", usage: {
      total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 },
      last: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2 },
      contextWindow: 200,
    } });
    expect(s.ctxTokens).toBe(50); expect(s.ctxPct).toBe(25);
    expect(JSON.parse(store.get("cc-agent-usage-tokens")!)[0]).toMatchObject({ input: 80, cache_read: 20, output: 20, sessions: 1 });
  });

  it("rolls up only new Codex equivalent spend across updates and resumes", () => {
    const before = sess("cost-pane"); before.resumeId = "cost-thread"; before.model = "gpt-5.6-sol";
    applyAgentEvent(before, { type: "cost", totalUsd: 1.25 });
    applyAgentEvent(before, { type: "cost", totalUsd: 3 });
    applyAgentEvent(before, { type: "cost", totalUsd: 2.5 }); // a revised estimate, not a reset
    expect(before.cost).toBe(2.5);
    expect(Object.values(usage)[0]).toBeCloseTo(3, 10);

    const after = sess("resumed-pane"); after.resumeId = "cost-thread"; after.model = "gpt-5.6-sol";
    applyAgentEvent(after, { type: "cost", totalUsd: 3 });
    applyAgentEvent(after, { type: "cost", totalUsd: 3.5 });
    expect(after.cost).toBe(3.5);
    expect(after.costHist).toEqual([3, 3.5]);
    expect(Object.values(usage)[0]).toBeCloseTo(3.5, 10);
  });
});
