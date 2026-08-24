import { beforeEach, describe, expect, it } from "vitest";
import { store } from "./localstorage"; // must precede modules that read localStorage
import { applyAgentEvent } from "../src/agents";
import { codexApiEquivalentUsd, codexEvents, codexHistoryEntries, codexHistoryMessages } from "../src/providers/codex";
import { rl } from "../src/rl";
import { resetCostBaselines, usage, usageDetail } from "../src/usage";
import type { Sess } from "../src/types";

const sess = (id = "pane-1"): Sess => ({
  id, project: "episko", accent: "#fff", workdir: "/w/episko", colorKey: "/w/episko",
  resumeId: id, branch: "main", worktree: null, title: "Codex",
  phase: "idle", phaseSince: 0, lastActivity: 0, attention: null,
  pendingCmd: "", pendingPermId: null, pendRisk: null, attnAt: 0, seenAt: 0,
  subagents: 0, fanout: null, apiErr: null, drift: null,
  model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null, tokenUsage: null, rateLimits: [],
  curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null,
  lastEvent: "", activity: [], files: [], tally: {}, kind: "agent", external: false,
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
  it("normalizes thread identity, commands and approvals", () => {
    expect(codexEvents(raw("thread/started", { thread: { id: "thread-1", name: "Fix it" } }))[0])
      .toEqual({ type: "thread", id: "thread-1", title: "Fix it" });
    expect(codexEvents(raw("item/started", { item: { type: "commandExecution", id: "call-1", command: "pnpm test", cwd: "/w/episko", status: "inProgress" } }))[0])
      .toMatchObject({ type: "activity-started", id: "call-1", tool: "Bash", input: "pnpm test" });
    expect(codexEvents(raw("item/commandExecution/requestApproval", { itemId: "call-1", command: "rm -rf build" }, "ask-1"))[0])
      .toMatchObject({ type: "permission", id: "ask-1", tool: "Bash", risk: "high" });
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
