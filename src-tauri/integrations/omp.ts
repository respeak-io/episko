// Episko integration for OMP (oh-my-pi): reports what the main agent does to Episko over
// its agent protocol (episko/docs/agent-protocol.md). Inert unless Episko started this OMP,
// and it never throws, blocks a tool or waits on Episko: the agent must not notice it.
// Based on Jason Perez's OMP adapter (jasonmarkperez/episko).

// ---- episko client: identical in every integration (test/client.test.mjs) ----
type EpiskoEvent = { type: string; [key: string]: unknown };
const EPISKO_URL = process.env.EPISKO_URL ?? "";
const EPISKO_TOKEN = process.env.EPISKO_TOKEN ?? "";
const ENABLED = EPISKO_URL.startsWith("http://127.0.0.1:") && EPISKO_TOKEN.length > 0;
const queue: EpiskoEvent[] = [];
let sending = false;

/** Queues one event; never throws, never waits. Order is kept: one POST in flight at a time. */
function send(event: EpiskoEvent): void {
  if (!ENABLED) return;
  if (queue.length >= 2000) queue.shift(); // Episko is gone; don't grow forever
  queue.push(event);
  if (!sending) void flush();
}

async function flush(): Promise<void> {
  sending = true;
  try {
    while (queue.length) {
      const events = queue.splice(0, 100);
      try {
        await fetch(EPISKO_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${EPISKO_TOKEN}` },
          body: JSON.stringify({ v: 1, events }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        // Episko closed or busy: the agent carries on, and these events are gone.
      }
    }
  } finally {
    sending = false;
  }
}

function clip(value: unknown, max: number): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try { s = JSON.stringify(value) ?? ""; } catch { s = String(value); }
  }
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const leaf = (path: string): string => path.split(/[/\\]/).filter(Boolean).pop() ?? path;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
// ---- end client ----

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number };
const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});

// What a tool did to a file, by OMP's tool names; `bash` is left to Episko's git view.
const TOUCH: Record<string, "read" | "edited" | "created"> = {
  read: "read", write: "created", edit: "edited", apply_patch: "edited", notebook: "edited",
};
const STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.filter((c) => obj(c).type === "text").map((c) => String(obj(c).text ?? "")).join("\n");
}

function summary(input: Record<string, any>): string {
  const path = input.path ?? input.file_path ?? input.dst;
  if (typeof path === "string" && path) return clip(leaf(path), 300);
  const other = input.command ?? input.pattern ?? input.query ?? input.url;
  return typeof other === "string" ? clip(other, 300) : "";
}

function planFrom(details: unknown): EpiskoEvent | null {
  const phases = obj(details).phases;
  if (!Array.isArray(phases)) return null;
  const items: { text: string; status: string }[] = [];
  for (const phase of phases) {
    for (const task of Array.isArray(obj(phase).tasks) ? obj(phase).tasks : []) {
      const text = clip(obj(task).content ?? "", 500);
      const status = String(obj(task).status ?? "pending");
      if (text) items.push({ text, status: STATUS.has(status) ? status : "pending" });
    }
  }
  return { type: "plan", items: items.slice(0, 200) };
}

export default function episko(pi: any): void {
  if (!ENABLED) return;
  // Totals and cost are per OMP session, as the protocol asks: a /resume or /new restarts them.
  let session = "";
  let totals = zero();
  let cost = 0;
  let inTurn = false;
  let turnStart = 0;
  let lastText = "";

  // Every handler runs inside this: a throw here must never reach OMP.
  const on = (name: string, fn: (event: any, ctx: any) => void) => {
    pi.on(name, (event: any, ctx: any) => {
      try {
        // Subagents and the advisor load this extension too; their turns are not the pane's.
        if (ctx?.agent && ctx.agent.kind !== "main") return;
        fn(obj(event), ctx);
      } catch {
        // An integration bug is not the agent's problem.
      }
    });
  };

  const announce = (ctx: any, force = false) => {
    let id = "";
    try { id = String(ctx?.sessionManager?.getSessionId?.() ?? ""); } catch { /* older OMP */ }
    if (id && id !== session) {
      session = id;
      totals = zero();
      cost = 0;
      force = true;
    }
    if (!force) return;
    let title = "";
    try { title = String(pi.getSessionName?.() ?? ""); } catch { /* unnamed */ }
    const model = typeof ctx?.model?.id === "string" ? ctx.model.id : "";
    send({
      type: "session",
      ...(SESSION_ID.test(session) ? { id: session } : {}),
      ...(model ? { model: clip(model, 200) } : {}),
      ...(title ? { title: clip(title, 200) } : {}),
    });
  };

  const usage = (ctx: any) => {
    let context: any;
    try { context = ctx?.getContextUsage?.(); } catch { /* no model yet */ }
    const tokens = num(obj(context).tokens);
    const window = num(obj(context).contextWindow);
    send({
      type: "usage",
      totals: { ...totals },
      ...(context ? { contextTokens: tokens } : {}),
      ...(window ? { contextWindow: window } : {}),
    });
  };

  on("session_start", (_event, ctx) => {
    announce(ctx, true);
    usage(ctx);
  });

  on("before_agent_start", (event) => {
    if (typeof event.prompt === "string" && event.prompt.trim()) send({ type: "prompt", text: clip(event.prompt, 32000) });
  });

  on("agent_start", () => {
    // A continuation (retry, compaction) starts again inside the same turn.
    if (inTurn) return;
    inTurn = true;
    turnStart = Date.now();
    lastText = "";
    send({ type: "turn-start" });
  });

  on("tool_call", (event) => {
    const input = obj(event.input);
    const name = String(event.toolName ?? "");
    const id = String(event.toolCallId ?? "");
    if (!name || !id) return;
    send({
      type: "tool-start",
      id: clip(id, 200),
      name: clip(name, 100),
      summary: summary(input),
      input: clip(input, 4000),
      ...(name === "bash" && typeof input.command === "string" ? { command: clip(input.command, 4000) } : {}),
    });
  });

  on("tool_result", (event) => {
    const input = obj(event.input);
    const name = String(event.toolName ?? "");
    const id = String(event.toolCallId ?? "");
    if (!name || !id) return;
    const failed = event.isError === true;
    const path = input.path ?? input.file_path ?? input.dst;
    const kind = TOUCH[name];
    send({
      type: "tool-end",
      id: clip(id, 200),
      name: clip(name, 100),
      output: clip(textOf(event.content) || event.content || "", 4000),
      failed,
      ...(name === "bash" && typeof input.command === "string" ? { command: clip(input.command, 4000) } : {}),
      ...(!failed && kind && typeof path === "string" && path ? { files: [{ path: clip(path, 4096), kind }] } : {}),
    });
    if (name === "todo" && !failed) {
      const plan = planFrom(event.details);
      if (plan) send(plan);
    }
  });

  on("message_end", (event, ctx) => {
    const message = obj(event.message);
    if (message.role !== "assistant") return;
    announce(ctx);
    const u = obj(message.usage);
    totals = {
      input: totals.input + num(u.input),
      output: totals.output + num(u.output),
      cacheRead: totals.cacheRead + num(u.cacheRead),
      cacheWrite: totals.cacheWrite + num(u.cacheWrite),
    };
    const text = textOf(message.content).trim();
    if (text) lastText = text;
    usage(ctx);
    const spent = obj(u.cost).total;
    if (typeof spent === "number" && Number.isFinite(spent) && spent > 0) {
      cost += spent;
      send({ type: "cost", totalUsd: cost });
    }
  });

  on("agent_end", (event, ctx) => {
    // isTerminal: false means OMP resumes on its own (a retry, a compaction): same turn.
    if (event.isTerminal === false || !inTurn) return;
    inTurn = false;
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const last = obj([...messages].reverse().find((m) => obj(m).role === "assistant"));
    const failed = last.stopReason === "error";
    if (lastText) send({ type: "answer", text: clip(lastText, 32000) });
    send({
      type: "turn-end",
      failed,
      ...(failed && last.errorMessage ? { error: clip(last.errorMessage, 2000) } : {}),
      durationMs: Math.max(0, Date.now() - turnStart),
    });
    usage(ctx);
  });
}
