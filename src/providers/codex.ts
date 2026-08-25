// Codex App Server -> Episko's provider-neutral agent events. This module is the only
// frontend code that knows App Server method names and item shapes.

import type { AgentEvent, AgentFileTouch, ProviderEvent } from "../agents";
import type { HistEntry } from "../history";
import { riskLevel } from "../phase";
import type { AgentPermissionMode, AgentTokenBreakdown, AgentTokenUsage, Todo, TouchKind } from "../types";

// Codex launch policy is expressed with the current CLI's stable approval/sandbox
// primitives. "Auto" is the useful, sandboxed meaning the old `--full-auto` shorthand
// carried: do not stop for approvals, but keep writes inside the workspace sandbox.
// The backend maps these ids to a whitelist; none is passed through as an argv value.
export const CODEX_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  { id: "default", label: "Codex config", sub: "Uses approval_policy and sandbox_mode from config.toml", glyph: "◇", asks: true },
  { id: "on-request", label: "On request", sub: "Codex asks when a command needs approval", glyph: "◆", asks: true },
  { id: "read-only", label: "Read only", sub: "No writes and no approval prompts", glyph: "⊙", asks: false },
  { id: "auto", label: "Auto", sub: "Runs unattended inside the workspace-write sandbox", glyph: "◈", asks: false },
  { id: "bypass", label: "Full access", sub: "Bypasses approvals and sandboxing entirely", glyph: "⚠", asks: false },
];

const obj = (v: unknown): Record<string, any> => v && typeof v === "object" ? v as Record<string, any> : {};
const text = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;
const clip = (v: unknown, n = 12_000): string => {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const leaf = (p: string) => p.split(/[/\\]/).pop() || p;

function breakdown(v: unknown): AgentTokenBreakdown {
  const x = obj(v); const n = (k: string) => Number.isFinite(x[k]) ? Number(x[k]) : 0;
  return {
    totalTokens: n("totalTokens"), inputTokens: n("inputTokens"),
    cachedInputTokens: n("cachedInputTokens"), cacheWriteInputTokens: n("cacheWriteInputTokens"),
    outputTokens: n("outputTokens"), reasoningOutputTokens: n("reasoningOutputTokens"),
  };
}

function usage(v: unknown): AgentTokenUsage {
  const x = obj(v);
  return {
    total: breakdown(x.total), last: breakdown(x.last),
    contextWindow: Number.isFinite(x.modelContextWindow) ? Number(x.modelContextWindow) : null,
  };
}

type TokenPrice = { input: number; cached: number; cacheWrite?: number; output: number };

// Standard API dollars per million tokens, checked against OpenAI's pricing/model
// pages on 2026-08-24. App Server's own USD estimate wins whenever it is available;
// this table is the subscription-login fallback, where the server can return token
// groups and credits but no USD route. Snapshot suffixes inherit their base model.
//
// GPT-5.5/5.4 long-context and regional uplifts cannot be recovered from the grouped
// cumulative response, so the fallback deliberately means the ordinary standard API
// equivalent — the same sort of useful approximation Claude presents, not a bill.
const API_PRICES: Record<string, TokenPrice> = {
  "gpt-5.6": { input: 4, cached: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cached: 0.175, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cached: 0.175, output: 14 },
  "gpt-5.1-codex": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5.1-codex-max": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5-codex": { input: 1.25, cached: 0.125, output: 10 },
  "codex-mini-latest": { input: 1.5, cached: 0.375, output: 6 },
};
const PRICE_IDS = Object.keys(API_PRICES).sort((a, b) => b.length - a.length);
const priceFor = (model: string): TokenPrice | null => {
  const id = model.toLowerCase();
  const base = PRICE_IDS.find((x) => id === x || id.startsWith(`${x}-20`));
  return base ? API_PRICES[base] : null;
};
const tokens = (v: unknown): number => Number.isFinite(v) ? Math.max(0, Number(v)) : 0;

/**
 * App Server groups every model/cache/service-tier route used by the thread. Prefer
 * its cumulative USD-micros estimate; if a ChatGPT subscription route omits USD, price
 * those same groups at public API rates. Repricing only the latest aggregate token
 * counter would make a mid-thread model change rewrite all of the older turns.
 */
export function codexApiEquivalentUsd(v: unknown): number | null {
  const x = obj(v); const micros = x.estimatedUsageUsdMicros;
  if (Number.isFinite(micros) && micros >= 0) return Number(micros) / 1_000_000;
  if (!Array.isArray(x.groups) || !x.groups.length) return null;
  let usd = 0; let sawUsage = false;
  for (const raw of x.groups) {
    const g = obj(raw); const cached = tokens(g.cachedInputTokens);
    const writes = tokens(g.cacheWriteInputTokens);
    const fresh = Number.isFinite(g.netNewInputTokens)
      ? Math.max(0, tokens(g.netNewInputTokens) - writes)
      : Math.max(0, tokens(g.inputTokens) - cached - writes);
    const output = tokens(g.outputTokens);
    if (!(fresh > 0 || cached > 0 || writes > 0 || output > 0)) continue;
    sawUsage = true;
    const price = priceFor(text(g.model));
    if (!price) return null; // a partial thread total would be worse than no estimate
    const speed = text(g.speed).toLowerCase();
    const mul = speed === "fast" || speed === "priority" ? 2 : 1;
    usd += mul * (
      fresh * price.input + cached * price.cached
      + writes * (price.cacheWrite ?? price.input) + output * price.output
    ) / 1_000_000;
  }
  return sawUsage ? usd : 0;
}

function fileTouches(item: Record<string, any>): AgentFileTouch[] {
  if (item.status === "declined") return [];
  const found: AgentFileTouch[] = [];
  if (item.type === "fileChange" && item.status !== "failed" && Array.isArray(item.changes)) {
    for (const c of item.changes) {
      const path = text(c?.path); if (!path) continue;
      const t = text(c?.kind?.type ?? c?.type);
      const kind: TouchKind = t === "add" ? "created" : "edited";
      found.push({ path, kind });
      // An update can also be a move. Keep the destination as a real file touch; the
      // source may no longer exist, but both paths are useful history and the neutral
      // reducer resolves either relative spelling against the session cwd.
      const moved = text(c?.kind?.move_path ?? c?.kind?.movePath);
      if (moved) found.push({ path: moved, kind: "edited" });
    }
  } else if (item.type === "imageView") {
    const path = text(item.path); if (path) found.push({ path, kind: "read" });
  } else if (item.type === "commandExecution" && Array.isArray(item.commandActions)) {
    // App Server already parsed these commands and only calls an action `read` when it
    // has a concrete file path. Do not infer paths from shell text, listFiles folders,
    // search roots or unknown commands.
    for (const action of item.commandActions) {
      if (action?.type !== "read") continue;
      const path = text(action.path); if (path) found.push({ path, kind: "read" });
    }
  } else if (item.type === "imageGeneration" && item.status !== "failed") {
    const path = text(item.savedPath); if (path) found.push({ path, kind: "created" });
  }
  // A command can contain the same read action more than once. One completed item is
  // one touch in the set, so de-duplicate here before the neutral reducer counts it.
  return found.filter((touch, i) => found.findIndex((x) => x.path === touch.path && x.kind === touch.kind) === i);
}

function itemParts(item: Record<string, any>) {
  switch (item.type) {
    case "commandExecution": return {
      tool: "Bash", arg: text(item.command), inputData: { command: text(item.command), cwd: text(item.cwd) },
      input: text(item.command), output: text(item.aggregatedOutput),
      failed: item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0),
    };
    case "fileChange": {
      const paths = Array.isArray(item.changes) ? item.changes.map((c: any) => text(c?.path)).filter(Boolean) : [];
      return { tool: "Edit", arg: paths.map(leaf).join(", "), inputData: { changes: item.changes }, input: clip(item.changes), output: text(item.status), failed: item.status === "failed" || item.status === "declined" };
    }
    case "mcpToolCall": return {
      tool: `mcp__${text(item.server, "server")}__${text(item.tool, "tool")}`, arg: text(item.tool),
      inputData: item.arguments, input: clip(item.arguments), output: clip(item.error ?? item.result),
      failed: item.status === "failed" || !!item.error,
    };
    case "dynamicToolCall": return {
      tool: text(item.namespace) ? `mcp__${item.namespace}__${text(item.tool, "tool")}` : text(item.tool, "Tool"),
      arg: text(item.tool), inputData: item.arguments, input: clip(item.arguments), output: clip(item.contentItems),
      failed: item.status === "failed" || item.success === false,
    };
    case "webSearch": return { tool: "WebSearch", arg: text(item.query), inputData: { query: text(item.query) }, input: text(item.query), output: clip(item.results), failed: false };
    case "imageView": return { tool: "Read", arg: leaf(text(item.path)), inputData: { file_path: text(item.path) }, input: text(item.path), output: "image viewed", failed: false };
    // `collabToolCall` is the public App Server spelling; recent schemas renamed the
    // richer item to `collabAgentToolCall`. Supporting both keeps the timeline useful
    // across that protocol transition without leaking either spelling past this file.
    case "collabToolCall": case "collabAgentToolCall": {
      const tool = text(item.tool, "agent");
      const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
      const inputData = { prompt: item.prompt, model: item.model, receiverThreadIds: receivers };
      return {
        tool: `Agent · ${tool}`, arg: text(item.prompt) || receivers.join(", "),
        inputData, input: clip(inputData), output: clip(item.agentsStates ?? item.status),
        failed: item.status === "failed",
      };
    }
    case "subAgentActivity": return {
      tool: "Agent", arg: `${text(item.kind, "activity")} · ${leaf(text(item.agentPath))}`,
      inputData: { agentPath: item.agentPath, agentThreadId: item.agentThreadId, kind: item.kind },
      input: clip({ agentPath: item.agentPath, agentThreadId: item.agentThreadId }),
      output: text(item.kind), failed: text(item.kind).includes("fail"),
    };
    case "sleep": return {
      tool: "Wait", arg: `${Number(item.durationMs) || 0}ms`, inputData: { durationMs: item.durationMs },
      input: clip({ durationMs: item.durationMs }), output: "completed", failed: false,
    };
    case "imageGeneration": return {
      tool: "ImageGen", arg: leaf(text(item.savedPath)) || text(item.revisedPrompt),
      inputData: { prompt: item.revisedPrompt, transparentBackground: item.transparentBackground },
      input: text(item.revisedPrompt), output: text(item.savedPath) || clip(item.failure ?? item.result),
      failed: item.status === "failed" || !!item.failure,
    };
    default: return null;
  }
}

function itemEvents(method: string, params: any): AgentEvent[] {
  const item = obj(params?.item); const p = itemParts(item); if (!p) return [];
  const rawId = text(item.id); if (!rawId) return [];
  const child = params?.episkoChild === true;
  const thread = text(params?.threadId);
  const id = child && thread ? `${thread}:${rawId}` : rawId;
  const tool = child ? `Subagent · ${p.tool}` : p.tool;
  if (method === "item/started") return [{ type: "activity-started", id, tool, arg: p.arg, input: p.input, desc: "" }];
  return [{
    type: "activity-completed", id, tool, input: p.input, inputData: p.inputData,
    output: p.output, failed: p.failed, files: fileTouches(item),
  }];
}

function permission(e: ProviderEvent): AgentEvent {
  const p = obj(e.params);
  const command = text(p.command ?? p.reason ?? p.grantRoot, "Review in terminal");
  const nativeTool = e.method.includes("commandExecution") ? "Bash" : e.method.includes("fileChange") ? "Edit" : "Codex";
  const tool = p.episkoChild === true ? `Subagent · ${nativeTool}` : nativeTool;
  return { type: "permission", id: e.requestId || text(p.itemId), tool, command, risk: riskLevel(nativeTool, { command }) };
}

function plan(v: unknown): Todo[] {
  return Array.isArray(v) ? v.map((x: any) => ({
    content: text(x?.step), status: text(x?.status) === "inProgress" ? "in_progress" : text(x?.status, "pending"),
  })).filter((x) => x.content) : [];
}

export function codexEvents(e: ProviderEvent): AgentEvent[] {
  const p = obj(e.params);
  const child = p.episkoChild === true;
  // Child tools and approvals belong in the parent's cockpit; child lifecycle, plan,
  // token and error events do not. Letting a child turn complete would mark the parent
  // done, and letting its plan through would replace the plan the user is looking at.
  if (child && e.method !== "item/started" && e.method !== "item/completed"
    && !e.method.endsWith("/requestApproval") && e.method !== "episko/request/resolved") return [];
  switch (e.method) {
    case "thread/started": {
      const t = obj(p.thread); return [{ type: "thread", id: text(t.id), title: text(t.name) || undefined }];
    }
    case "episko/thread/resumed": {
      const t = obj(p.thread); return [{ type: "thread", id: text(t.id), model: text(p.model) || undefined, title: text(t.name) || undefined }];
    }
    case "thread/name/updated": return [{ type: "thread", id: text(p.threadId), title: text(p.threadName) || undefined }];
    case "thread/status/changed": return [{ type: "thread-status", status: text(p.status?.type), waiting: Array.isArray(p.status?.activeFlags) && p.status.activeFlags.includes("waitingOnApproval") }];
    case "turn/started": return [{ type: "turn-started" }];
    case "turn/completed": {
      const t = obj(p.turn); const status = text(t.status);
      return [{ type: "turn-completed", failed: status !== "completed", detail: clip(t.error), durationMs: Number.isFinite(t.durationMs) ? Number(t.durationMs) : null }];
    }
    case "item/started": case "item/completed": return itemEvents(e.method, p);
    case "turn/plan/updated": return [{ type: "plan", todos: plan(p.plan) }];
    case "thread/tokenUsage/updated": return [{ type: "usage", usage: usage(p.tokenUsage) }];
    case "episko/thread/usage": {
      const totalUsd = codexApiEquivalentUsd(p.threadUsage);
      return totalUsd == null ? [] : [{ type: "cost", totalUsd }];
    }
    case "account/rateLimits/updated": {
      const r = obj(p.rateLimits); const windows = [r.primary, r.secondary].filter(Boolean).map((w: any) => ({
        usedPercent: Number(w.usedPercent) || 0,
        resetsAt: Number.isFinite(w.resetsAt) ? Number(w.resetsAt) : null,
        windowMins: Number.isFinite(w.windowDurationMins) ? Number(w.windowDurationMins) : null,
      }));
      return [{ type: "rate-limits", windows, scope: text(p.episkoScope) || null }];
    }
    case "episko/request/resolved": return [{ type: "permission-resolved", id: text(p.requestId) }];
    case "error": return [{ type: "error", detail: text(p.message) || clip(p.error) }];
    case "episko/disconnected": return [{ type: "disconnected" }];
    default:
      return e.requestId && e.method.endsWith("/requestApproval") ? [permission(e)] : [];
  }
}

export function codexHistoryEntries(result: any): HistEntry[] {
  const rows = Array.isArray(result?.data) ? result.data : [];
  return rows.filter((t: any) => !t?.parentThreadId && t?.id && t?.cwd).map((t: any) => ({
    provider: "codex", session_id: text(t.id), cwd: text(t.cwd), project: leaf(text(t.cwd)),
    branch: text(t.gitInfo?.branch), title: text(t.name), last_prompt: text(t.preview),
    bytes: Number(t.episkoBytes) || 0, exists: t.episkoExists !== false,
    last_active: Number(t.recencyAt ?? t.updatedAt ?? t.createdAt) || 0,
    repo_root: text(t.episkoRepoRoot) || null,
  }));
}

export function codexHistoryMessages(result: any, limit: number): { role: string; text: string }[] {
  const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
  const messages: { role: string; text: string }[] = [];
  for (const turn of turns) for (const item of Array.isArray(turn?.items) ? turn.items : []) {
    if (item?.type === "userMessage") {
      const body = (Array.isArray(item.content) ? item.content : [])
        .filter((x: any) => x?.type === "text" && typeof x.text === "string")
        .map((x: any) => x.text).join("\n");
      if (body.trim()) messages.push({ role: "user", text: body });
    } else if (item?.type === "agentMessage" && text(item.text).trim()) {
      messages.push({ role: "assistant", text: text(item.text) });
    }
  }
  return messages.slice(-Math.max(0, limit));
}
