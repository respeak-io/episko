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
