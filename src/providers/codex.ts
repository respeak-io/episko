// Codex App Server -> Episko's provider-neutral agent events. This module is the only
// frontend code that knows App Server method names and item shapes.

import type { AgentEvent, AgentFileTouch, ProviderEvent } from "../agents";
import type { HistEntry } from "../history";
import { riskLevel } from "../phase";
import type { AgentTokenBreakdown, AgentTokenUsage, Todo, TouchKind } from "../types";

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

function fileTouches(item: Record<string, any>): AgentFileTouch[] {
  if (item.type !== "fileChange" || !Array.isArray(item.changes)) return [];
  return item.changes.flatMap((c: any) => {
    const path = text(c?.path); if (!path) return [];
    const t = text(c?.kind?.type ?? c?.type);
    const kind: TouchKind = t === "add" ? "created" : "edited";
    return [{ path, kind }];
  });
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
    default: return null;
  }
}

function itemEvents(method: string, params: any): AgentEvent[] {
  const item = obj(params?.item); const p = itemParts(item); if (!p) return [];
  const id = text(item.id); if (!id) return [];
  if (method === "item/started") return [{ type: "activity-started", id, tool: p.tool, arg: p.arg, input: p.input, desc: "" }];
  return [{
    type: "activity-completed", id, tool: p.tool, input: p.input, inputData: p.inputData,
    output: p.output, failed: p.failed, files: fileTouches(item),
  }];
}

function permission(e: ProviderEvent): AgentEvent {
  const p = obj(e.params);
  const command = text(p.command ?? p.reason ?? p.grantRoot, "Review in terminal");
  const tool = e.method.includes("commandExecution") ? "Bash" : e.method.includes("fileChange") ? "Edit" : "Codex";
  return { type: "permission", id: e.requestId || text(p.itemId), tool, command, risk: riskLevel(tool, { command }) };
}

function plan(v: unknown): Todo[] {
  return Array.isArray(v) ? v.map((x: any) => ({
    content: text(x?.step), status: text(x?.status) === "inProgress" ? "in_progress" : text(x?.status, "pending"),
  })).filter((x) => x.content) : [];
}

export function codexEvents(e: ProviderEvent): AgentEvent[] {
  const p = obj(e.params);
  switch (e.method) {
    case "thread/started": {
      const t = obj(p.thread); return [{ type: "thread", id: text(t.id), title: text(t.name) || undefined }];
    }
    case "episko/thread/resumed": {
      const t = obj(p.thread); return [{ type: "thread", id: text(t.id), model: text(p.model) || undefined, title: text(t.name) || undefined }];
    }
    case "thread/name/updated": return [{ type: "thread", id: text(p.threadId), title: text(p.name) || undefined }];
    case "thread/status/changed": return [{ type: "thread-status", status: text(p.status?.type), waiting: Array.isArray(p.status?.activeFlags) && p.status.activeFlags.includes("waitingOnApproval") }];
    case "turn/started": return [{ type: "turn-started" }];
    case "turn/completed": {
      const t = obj(p.turn); const status = text(t.status);
      return [{ type: "turn-completed", failed: status !== "completed", detail: clip(t.error), durationMs: Number.isFinite(t.durationMs) ? Number(t.durationMs) : null }];
    }
    case "item/started": case "item/completed": return itemEvents(e.method, p);
    case "turn/plan/updated": return [{ type: "plan", todos: plan(p.plan) }];
    case "thread/tokenUsage/updated": return [{ type: "usage", usage: usage(p.tokenUsage) }];
    case "account/rateLimits/updated": {
      const r = obj(p.rateLimits); const windows = [r.primary, r.secondary].filter(Boolean).map((w: any) => ({
        usedPercent: Number(w.usedPercent) || 0,
        resetsAt: Number.isFinite(w.resetsAt) ? Number(w.resetsAt) : null,
        windowMins: Number.isFinite(w.windowDurationMins) ? Number(w.windowDurationMins) : null,
      }));
      return [{ type: "rate-limits", windows }];
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
