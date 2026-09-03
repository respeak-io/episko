// Shared agent state reducer: provider adapters translate their protocol into this event
// vocabulary, and everything below mutates the same `Sess` Claude's hooks feed. A new
// adapter belongs beside ./providers/codex and needs no second cockpit.

import { absoluteTouchPath, bumpTally, noteTouch } from "./files";
import {
  abbr, beginAgentTurn, closeActivity, finishAgentTurn, noteAgentTouch,
  openActivity, pushHist, recordPrompt, setPhase,
} from "./phase";
import { addAgentTokenUsage, addUsage, costDelta } from "./usage";
import { queuePermission, removePermission } from "./permissions";
import type { AgentRateLimit, AgentTokenUsage, Risk, Sess, Todo, TouchKind } from "./types";

export interface ProviderEvent {
  sessionId: string; provider: string; method: string; params: any;
  requestId: string | null;
}

export interface AgentFileTouch { path: string; kind: TouchKind }

export type AgentEvent =
  | { type: "thread"; id: string; model?: string; title?: string }
  | { type: "thread-status"; status: string; waiting: boolean }
  | { type: "turn-started" }
  // Your own message. Separate from turn-started: a turn can open without one (a resume,
  // a retry), and the outline lists questions rather than turns.
  | { type: "prompt"; text: string }
  | { type: "turn-completed"; failed: boolean; detail: string; durationMs: number | null }
  | { type: "activity-started"; id: string; tool: string; arg: string; input: string; desc: string }
  | { type: "activity-completed"; id: string; tool: string; input: string; inputData: any; output: string; failed: boolean; files: AgentFileTouch[] }
  | { type: "permission"; id: string; tool: string; command: string; risk: Risk }
  | { type: "permission-resolved"; id: string }
  | { type: "plan"; todos: Todo[] }
  | { type: "usage"; usage: AgentTokenUsage }
  | { type: "cost"; totalUsd: number }
  | { type: "rate-limits"; windows: AgentRateLimit[]; scope: string | null }
  | { type: "error"; detail: string }
  | { type: "disconnected" };

export function applyAgentEvent(s: Sess, event: AgentEvent): void {
  const previousEvent = s.lastEvent;
  // Quota is account activity, not the session's; it must not float idle panes to the top.
  if (event.type !== "rate-limits") s.lastActivity = Date.now();
  s.lastEvent = event.type;
  switch (event.type) {
    case "thread":
      if (event.id) s.resumeId = event.id;
      if (event.model) s.model = event.model;
      if (event.title) s.title = event.title;
      break;
    case "thread-status":
      if (event.status === "active" && !event.waiting && s.phase !== "working") setPhase(s, "thinking");
      else if (event.status === "idle" && (s.phase === "ended" || !previousEvent)) setPhase(s, "idle");
      break;
    case "turn-started": beginAgentTurn(s); break;
    case "prompt": recordPrompt(s, event.text); break;
    case "turn-completed":
      if (event.durationMs != null) s.durMs = event.durationMs;
      finishAgentTurn(s, event.failed, event.detail);
      break;
    case "activity-started":
      setPhase(s, "working"); s.curTool = event.tool; s.curArg = event.arg;
      openActivity(s, event.tool, event.arg, event.id, event.input, event.desc);
      break;
    case "activity-completed":
      closeActivity(s, event.tool, event.id, event.input, "", event.output, event.failed);
      bumpTally(s.tally, event.tool);
      for (const file of event.files) noteTouch(s.files, absoluteTouchPath(file.path, s.workdir), file.kind, Date.now());
      noteAgentTouch(s, event.tool, { tool_input: event.inputData });
      if (event.failed) setPhase(s, "error");
      break;
    case "permission": queuePermission(s, event); break;
    case "permission-resolved": removePermission(s, event.id); break;
    case "plan": s.todos = event.todos; break;
    case "usage": {
      s.tokenUsage = event.usage;
      addAgentTokenUsage(s, event.usage);
      const used = event.usage.last.totalTokens;
      const cap = event.usage.contextWindow;
      s.ctxTokens = used;
      s.ctxPct = cap && cap > 0 ? used / cap * 100 : null;
      if (s.ctxPct != null) pushHist(s.ctxHist, s.ctxPct);
      break;
    }
    case "cost": {
      // Totals survive a move/resume (like Claude's statusLine total), so the baseline is
      // keyed by provider + thread; reopening a conversation must not book it twice.
      const id = `${s.provider || "agent"}:${s.resumeId || s.id}`;
      addUsage(costDelta(id, event.totalUsd, false, `${s.provider || "agent"}:${s.id}`), s);
      s.cost = event.totalUsd;
      pushHist(s.costHist, event.totalUsd);
      break;
    }
    case "rate-limits": s.rateLimits = event.windows; s.rateLimitScope = event.scope; break;
    case "error":
      s.apiErr = { kind: "unknown", detail: abbr(event.detail), at: Date.now() };
      setPhase(s, "error");
      break;
    case "disconnected":
      // The TUI stays usable if its observer drops; keep its last state, don't pretend it ended.
      s.lastEvent = "integration-disconnected";
      break;
  }
}

// Fans a rate-limit reading out to peers sharing its opaque scope; unrelated accounts never join.
export function applyAgentEventToFleet(s: Sess, event: AgentEvent, fleet: Iterable<Sess>): void {
  const previousScope = s.rateLimitScope;
  applyAgentEvent(s, event);
  if (event.type !== "rate-limits") return;
  // A null scope is account/updated clearing the old account before the new one is known;
  // fan that clear through the previous scope, or a stale sibling shows it forever.
  const fleetScope = event.scope ?? previousScope;
  if (!fleetScope) return;
  for (const peer of fleet) {
    if (peer !== s && peer.rateLimitScope === fleetScope) applyAgentEvent(peer, event);
  }
}
