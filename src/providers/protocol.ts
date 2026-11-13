// Episko's own agent protocol (docs/agent-protocol.md) -> the shared reducer's events. The
// extension inside the agent did the vendor translation; this side only checks and clips,
// since every byte here was written by code Episko does not run or review at runtime.

import type { AgentEvent, AgentFileTouch, ProviderEvent } from "../agents";
import type { AgentPermissionMode, AgentTokenBreakdown, Todo, TouchKind } from "../types";
import manifest from "./manifest.json";

/** The `method` protocol.rs forwards a POST under. */
export const PROTOCOL_METHOD = "protocol/v1";

// Clipped rather than refused: the schema's limits are for senders; a receiver trims.
const MAX = { text: 32_000, io: 4_000, summary: 300, short: 200, error: 2_000, path: 4_096, list: 200, item: 500 };
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const KINDS: ReadonlySet<string> = new Set<TouchKind>(["read", "edited", "created"]);
const PLAN_STATUS: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "cancelled"]);

class Invalid extends Error {}
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function text(o: Obj, key: string, max: number): string {
  const v = o[key];
  if (typeof v !== "string" || !v) throw new Invalid(key);
  return clip(v, max);
}
function optText(o: Obj, key: string, max: number): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Invalid(key);
  return clip(v, max);
}
function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new Invalid(key);
  return v;
}
function optCount(o: Obj, key: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Invalid(key);
  return v;
}
function list(o: Obj, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new Invalid(key);
  return v.slice(0, MAX.list);
}

const ZERO: AgentTokenBreakdown = {
  totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
};
interface PaneUsage { session: string; totals: AgentTokenBreakdown; context: number; window: number | null }
// Keyed by pane: a `usage` event may carry only what changed, so the rest is remembered.
const panes = new Map<string, PaneUsage>();
const paneUsage = (pane: string): PaneUsage => {
  let u = panes.get(pane);
  if (!u) panes.set(pane, u = { session: "", totals: ZERO, context: 0, window: null });
  return u;
};

// The protocol counts input without cache reads (as Anthropic and OpenCode do); the reducer's
// breakdown counts it with them (as OpenAI does), so cache reads are added back here.
function breakdown(t: Obj, prev: AgentTokenBreakdown): AgentTokenBreakdown {
  const input = optCount(t, "input") ?? Math.max(0, prev.inputTokens - prev.cachedInputTokens);
  const cacheRead = optCount(t, "cacheRead") ?? prev.cachedInputTokens;
  const cacheWrite = optCount(t, "cacheWrite") ?? prev.cacheWriteInputTokens;
  const output = optCount(t, "output") ?? prev.outputTokens;
  const reasoning = optCount(t, "reasoning") ?? prev.reasoningOutputTokens;
  return {
    totalTokens: input + cacheRead + cacheWrite + output, inputTokens: input + cacheRead,
    cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite, outputTokens: output, reasoningOutputTokens: reasoning,
  };
}

function translate(pane: string, e: Obj): AgentEvent | null {
  switch (e.type) {
    case "session": {
      const id = optText(e, "id", 128);
      if (id !== undefined && !SESSION_ID.test(id)) throw new Invalid("id");
      const thread: AgentEvent = { type: "thread", id: id ?? "", model: optText(e, "model", MAX.short), title: optText(e, "title", MAX.short) };
      const u = paneUsage(pane);
      // Totals are per agent session: a new one starts from nothing.
      if (id && id !== u.session) Object.assign(u, { session: id, totals: ZERO, context: 0 });
      return thread;
    }
    case "prompt": return { type: "prompt", text: text(e, "text", MAX.text) };
    case "turn-start": return { type: "turn-started" };
    case "tool-start":
      return {
        type: "activity-started", id: text(e, "id", MAX.short), tool: text(e, "name", 100),
        arg: optText(e, "summary", MAX.summary) ?? "", input: optText(e, "input", MAX.io) ?? "", desc: "",
      };
    case "tool-end": {
      const files: AgentFileTouch[] = [];
      for (const f of e.files === undefined ? [] : list(e, "files")) {
        if (!isObj(f) || typeof f.kind !== "string" || !KINDS.has(f.kind)) throw new Invalid("files");
        files.push({ path: text(f, "path", MAX.path), kind: f.kind as TouchKind });
      }
      const command = optText(e, "command", MAX.io);
      return {
        type: "activity-completed", id: text(e, "id", MAX.short), tool: text(e, "name", 100), input: "",
        inputData: command ? { command } : {}, output: optText(e, "output", MAX.io) ?? "",
        failed: optBool(e, "failed") ?? false, files,
      };
    }
    case "answer": return { type: "answer", text: text(e, "text", MAX.text) };
    case "turn-end":
      return {
        type: "turn-completed", failed: optBool(e, "failed") ?? false,
        detail: optText(e, "error", MAX.error) ?? "", durationMs: optCount(e, "durationMs") ?? null,
      };
    case "plan": {
      const todos: Todo[] = [];
      for (const item of list(e, "items")) {
        if (!isObj(item) || typeof item.status !== "string" || !PLAN_STATUS.has(item.status)) throw new Invalid("items");
        todos.push({ content: text(item, "text", MAX.item), status: item.status });
      }
      return { type: "plan", todos };
    }
    case "usage": {
      const u = paneUsage(pane);
      if (e.totals !== undefined && !isObj(e.totals)) throw new Invalid("totals");
      const totals = isObj(e.totals) ? breakdown(e.totals, u.totals) : u.totals;
      const context = optCount(e, "contextTokens");
      const window = optCount(e, "contextWindow");
      if (window === 0) throw new Invalid("contextWindow");
      u.totals = totals;
      u.context = context ?? u.context;
      u.window = window ?? u.window;
      return { type: "usage", usage: { total: u.totals, last: { ...ZERO, totalTokens: u.context }, contextWindow: u.window } };
    }
    case "cost": {
      const total = optCount(e, "totalUsd");
      if (total === undefined) throw new Invalid("totalUsd");
      return { type: "cost", totalUsd: total };
    }
    case "error": return { type: "error", detail: text(e, "message", MAX.error) };
    default: return null; // a type from a later 1.x: ignored, by the spec
  }
}

let log: (msg: string) => void = () => {};
export function setProtocolLogger(fn: typeof log) { log = fn; }

/** One POST's events; a malformed event is dropped whole and the rest still apply. */
export function protocolEvents(event: ProviderEvent): AgentEvent[] {
  if (event.method !== PROTOCOL_METHOD) return [];
  const raw = isObj(event.params) && Array.isArray(event.params.events) ? event.params.events : [];
  const out: AgentEvent[] = [];
  for (const e of raw) {
    try {
      if (!isObj(e) || typeof e.type !== "string") throw new Invalid("type");
      const mapped = translate(event.sessionId, e);
      if (mapped) out.push(mapped);
    } catch (err) {
      if (!(err instanceof Invalid)) throw err;
      // The field, never the value: it may hold a prompt.
      log(`${event.provider} sent a malformed ${isObj(e) && typeof e.type === "string" ? clip(e.type, 40) : "event"} (${err.message}): dropped`);
    }
  }
  return out;
}

type ManifestMode = AgentPermissionMode & { args?: string[] };
type ProtocolSpec = { permissionModes?: ManifestMode[] };
const PROTOCOL = manifest as Record<string, { protocol?: ProtocolSpec }>;

/** The launch choices a manifest row declares; their argv stays with protocol.rs. */
export function protocolPermissionModes(id: string): readonly AgentPermissionMode[] {
  return (PROTOCOL[id]?.protocol?.permissionModes ?? []).map(({ id, label, sub, glyph, asks }) => ({ id, label, sub, glyph, asks }));
}
