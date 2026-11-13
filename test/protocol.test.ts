import { beforeEach, describe, expect, it } from "vitest";
import { store } from "./localstorage"; // must precede modules that read localStorage
import { readFileSync } from "node:fs";
import { applyAgentEvent } from "../src/agents";
import { PROTOCOL_METHOD, protocolEvents, protocolPermissionModes, setProtocolLogger } from "../src/providers/protocol";
import { REVIVE_DEFAULTS, reviveStep } from "../src/revive";
import { resetCostBaselines } from "../src/usage";
import { agentCapabilitySummary, isCommunityProvider, providerCapabilities, type Sess } from "../src/types";

// The receiving half of docs/agent-protocol.md. Everything arriving here was written by an
// extension Episko does not vet at runtime, so the tests are as much about what is refused.

const schema = JSON.parse(readFileSync(new URL("../src/providers/protocol-v1.schema.json", import.meta.url), "utf8"));

let pane = 0;
const post = (events: unknown[], sessionId = `pane-${pane}`) =>
  protocolEvents({ sessionId, provider: "omp", method: PROTOCOL_METHOD, params: { events }, requestId: null });

const sess = (): Sess => ({
  id: `pane-${pane}`, project: "demo", accent: "#fff", workdir: "/w/demo", colorKey: "/w/demo",
  resumeId: `pane-${pane}`, branch: "main", worktree: null, title: "OMP",
  phase: "idle", phaseSince: 0, lastActivity: 0, attention: null,
  pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], attnAt: 0, seenAt: 0,
  agents: new Map(), fanout: null, queuedPrompt: false, apiErr: null, revive: null, drift: null,
  model: "", effort: null, ctxPct: null, ctxTokens: null, cost: null, durMs: null, apiMs: null, apiMsSince: 0, tokenUsage: null, rateLimits: [], rateLimitScope: null,
  curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null,
  lastEvent: "", activity: [], prompts: [], files: [], tally: {}, servers: [], kind: "agent", external: false,
  provider: "omp", capabilities: providerCapabilities("omp"), pane: {} as HTMLElement,
});

// One smallest valid event per type the schema names; the test below holds the two together.
const MINIMAL: Record<string, Record<string, unknown>> = {
  "session": { type: "session" },
  "prompt": { type: "prompt", text: "hi" },
  "turn-start": { type: "turn-start" },
  "tool-start": { type: "tool-start", id: "t1", name: "read" },
  "tool-end": { type: "tool-end", id: "t1", name: "read" },
  "answer": { type: "answer", text: "done" },
  "turn-end": { type: "turn-end" },
  "plan": { type: "plan", items: [] },
  "usage": { type: "usage" },
  "cost": { type: "cost", totalUsd: 0 },
  "error": { type: "error", message: "boom" },
};

let logged: string[] = [];
beforeEach(() => {
  store.clear();
  resetCostBaselines();
  pane += 1;
  logged = [];
  setProtocolLogger((msg) => logged.push(msg));
});

describe("agent protocol v1", () => {
  it("translates every event type the schema defines, and no other", () => {
    expect(Object.keys(MINIMAL).sort()).toEqual([...schema.$defs.event.properties.type.enum].sort());
    for (const event of Object.values(MINIMAL)) expect(post([event]), String(event.type)).toHaveLength(1);
    expect(post([{ type: "from-v1.7" }])).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("drives a pane through a whole turn", () => {
    const s = sess();
    const events = post([
      { type: "session", id: "sess-1", model: "fake-model", title: "Fix it" },
      { type: "prompt", text: "Read the README" },
      { type: "turn-start" },
      { type: "tool-start", id: "c1", name: "read", summary: "README.md", input: "{\"path\":\"README.md\"}" },
      { type: "tool-end", id: "c1", name: "read", output: "# Hi", files: [{ path: "README.md", kind: "read" }] },
      { type: "tool-start", id: "c2", name: "bash", summary: "git commit", command: "git commit -m x" },
      { type: "tool-end", id: "c2", name: "bash", command: "git commit -m x", failed: false },
      { type: "plan", items: [{ text: "Read it", status: "completed" }] },
      { type: "usage", totals: { input: 1000, output: 50, cacheRead: 200 }, contextTokens: 1200, contextWindow: 64000 },
      { type: "cost", totalUsd: 0.01 },
      { type: "answer", text: "It says hi." },
      { type: "turn-end", durationMs: 1500 },
    ]);
    const phases: string[] = [];
    for (const ev of events) { applyAgentEvent(s, ev); phases.push(s.phase); }
    expect(phases).toEqual(["idle", "idle", "thinking", "working", "working", "working", "working", "working", "working", "working", "working", "done"]);
    expect([s.resumeId, s.model, s.title]).toEqual(["sess-1", "fake-model", "Fix it"]);
    expect(s.activity.map((a) => [a.tool, a.arg, a.durMs != null])).toEqual([["bash", "git commit", true], ["read", "README.md", true]]);
    expect(s.files.map((f) => [f.path, f.kind])).toEqual([["/w/demo/README.md", "read"]]);
    expect(s.todos).toEqual([{ content: "Read it", status: "completed" }]);
    expect(s.prompts.map((p) => [p.text, p.answer])).toEqual([["Read the README", "It says hi."]]);
    expect(s.ctxPct).toBeCloseTo(1200 / 64000 * 100);
    expect(s.cost).toBe(0.01);
    expect(s.durMs).toBe(1500);
  });

  it("counts cache reads into input the way the shared reducer does", () => {
    const [usage] = post([{ type: "usage", totals: { input: 1000, output: 50, cacheRead: 200, cacheWrite: 10, reasoning: 5 } }]);
    expect(usage).toMatchObject({ usage: { total: {
      inputTokens: 1200, cachedInputTokens: 200, cacheWriteInputTokens: 10, outputTokens: 50, reasoningOutputTokens: 5, totalTokens: 1260,
    } } });
  });

  it("remembers what a partial usage event leaves out, until the agent session changes", () => {
    post([{ type: "usage", totals: { input: 100, output: 10 }, contextTokens: 500, contextWindow: 1000 }]);
    const [later] = post([{ type: "usage", totals: { output: 20 } }]);
    expect(later).toMatchObject({ usage: { total: { inputTokens: 100, outputTokens: 20 }, last: { totalTokens: 500 }, contextWindow: 1000 } });
    post([{ type: "session", id: "another" }]);
    const [fresh] = post([{ type: "usage", totals: { output: 1 } }]);
    expect(fresh).toMatchObject({ usage: { total: { inputTokens: 0, outputTokens: 1 }, last: { totalTokens: 0 } } });
  });

  it("drops a malformed event whole, keeps its neighbours, and logs the field but never the value", () => {
    const secret = "my password is hunter2";
    const events = post([
      { type: "turn-start" },
      { type: "tool-start", id: "c1", name: 42, summary: secret },
      { type: "prompt", text: 7 },
      { type: "tool-end", id: "c1", name: "read", files: [{ path: "/etc/passwd", kind: "deleted" }] },
      { type: "plan", items: [{ text: "x", status: "blocked" }] },
      { type: "usage", contextWindow: 0 },
      { type: "cost", totalUsd: -1 },
      { type: "session", id: "../../etc" },
      { type: "turn-end", failed: "yes" },
      null, "turn-end", { type: 3 },
      { type: "answer", text: secret },
    ]);
    expect(events.map((e) => e.type)).toEqual(["turn-started", "answer"]);
    expect(logged).toHaveLength(11);
    expect(logged.join("\n")).not.toContain("hunter2");
    expect(logged[0]).toBe("omp sent a malformed tool-start (name): dropped");
  });

  it("clips what is too long instead of refusing it", () => {
    const [prompt] = post([{ type: "prompt", text: "x".repeat(40_000) }]);
    expect(prompt).toMatchObject({ type: "prompt" });
    expect((prompt as { text: string }).text.length).toBe(32_000);
  });

  it("reads nothing but its own method, and an envelope without events is empty", () => {
    expect(protocolEvents({ sessionId: "p", provider: "omp", method: "item/started", params: { events: [{ type: "turn-start" }] }, requestId: null })).toEqual([]);
    expect(protocolEvents({ sessionId: "p", provider: "omp", method: PROTOCOL_METHOD, params: null, requestId: null })).toEqual([]);
  });

  it("a failed turn shows as an error that Episko never retries by typing into the agent", () => {
    const s = sess();
    for (const ev of post([{ type: "turn-start" }, { type: "turn-end", failed: true, error: "529 overloaded" }])) applyAgentEvent(s, ev);
    expect(s.phase).toBe("error");
    expect(s.apiErr?.detail).toContain("529");
    const prefs = { ...REVIVE_DEFAULTS, enabled: true }; // "other", which an unnamed failure is, is on by default
    expect(reviveStep(s, prefs, Date.now() + 3_600_000, true)).toEqual({ do: "none", why: "community" });
  });

  it("knows which providers are community integrations and offers OMP's launch modes", () => {
    expect(["omp", "opencode"].map(isCommunityProvider)).toEqual([true, true]);
    expect(["claude", "codex", "amp", "", null].map(isCommunityProvider)).toEqual([false, false, false, false, false]);
    expect(protocolPermissionModes("omp").map((m) => m.id)).toEqual(["default", "always-ask", "write", "yolo"]);
    expect(protocolPermissionModes("omp")[0]).not.toHaveProperty("args");
    expect(protocolPermissionModes("opencode")).toEqual([]);
    expect(agentCapabilitySummary({ id: "omp", label: "OMP", mark: "", bin: "omp", path: null, capabilities: providerCapabilities("omp") }))
      .toBe("usage, context, community");
  });
});
