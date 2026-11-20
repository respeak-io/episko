// Episko integration for OpenCode: reports what the session on screen does to Episko over
// its agent protocol (episko/docs/agent-protocol.md). Inert unless Episko started this
// OpenCode, and it never throws or waits on Episko: the agent must not notice it.
// One export only: OpenCode calls every function a plugin file exports.

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

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});
const STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);
// OpenCode's name for a session nobody has titled yet; Episko keeps its own label instead.
const PLACEHOLDER_TITLE = /^New session - /;

function summary(input: Record<string, any>): string {
  const path = input.filePath ?? input.path;
  if (typeof path === "string" && path) return clip(leaf(path), 300);
  const other = input.command ?? input.pattern ?? input.query ?? input.url ?? input.description;
  return typeof other === "string" ? clip(other, 300) : "";
}

// What a tool did to a file, by OpenCode's tool names; `bash` is left to Episko's git view.
function touched(tool: string, input: Record<string, any>, metadata: Record<string, any>) {
  const path = input.filePath;
  if (typeof path !== "string" || !path) return null;
  if (tool === "read") return { path: clip(path, 4096), kind: "read" };
  if (tool === "edit" || tool === "multiedit") return { path: clip(path, 4096), kind: "edited" };
  if (tool === "write") return { path: clip(path, 4096), kind: metadata.exists === true ? "edited" : "created" };
  return null;
}

export const EpiskoPlugin = async (ctx: any) => {
  if (!ENABLED) return {};
  const children = new Set<string>(); // subagent sessions: their turns are not the pane's
  let session = "";
  let title = "";
  let model = { provider: "", id: "" };
  let window = 0;
  const windows = new Map<string, number>();
  const messages = new Map<string, { tokens: Totals; cost: number; context: number }>();
  let lastReport = "";
  let inTurn = false;
  let turnStart = 0;
  let turnError = "";
  let lastText = "";
  const started = new Set<string>();
  const ended = new Set<string>();
  const asked = new Set<string>(); // the user's messages: their text arrives through chat.message

  const announce = (id: string, force = false) => {
    if (id !== session) {
      session = id;
      messages.clear();
      lastReport = "";
      force = true;
    }
    if (!force) return;
    send({
      type: "session",
      ...(SESSION_ID.test(session) ? { id: session } : {}),
      ...(model.id ? { model: clip(model.id, 200) } : {}),
      ...(title ? { title: clip(title, 200) } : {}),
    });
  };

  // The model's context window is in OpenCode's provider config, not in any event.
  const learnWindow = async (provider: string, id: string) => {
    const key = `${provider}/${id}`;
    if (windows.has(key)) return;
    windows.set(key, 0);
    try {
      const res = await ctx.client.config.providers();
      const list = res?.data?.providers ?? res?.providers ?? [];
      const found = obj(list.find((p: any) => obj(p).id === provider)).models?.[id];
      windows.set(key, num(obj(obj(found).limit).context));
    } catch {
      // Unknown window: Episko shows tokens without a percentage.
    }
    if (model.provider === provider && model.id === id) window = windows.get(key) ?? 0;
  };

  const report = () => {
    const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    let cost = 0;
    let context = 0;
    for (const m of messages.values()) {
      totals.input += m.tokens.input;
      totals.output += m.tokens.output;
      totals.cacheRead += m.tokens.cacheRead;
      totals.cacheWrite += m.tokens.cacheWrite;
      totals.reasoning += m.tokens.reasoning;
      cost += m.cost;
      if (m.context) context = m.context;
    }
    const key = JSON.stringify([totals, cost, context, window]);
    if (key === lastReport) return;
    lastReport = key;
    send({ type: "usage", totals, contextTokens: context, ...(window ? { contextWindow: window } : {}) });
    if (cost > 0) send({ type: "cost", totalUsd: cost });
  };

  const startTurn = () => {
    if (inTurn) return;
    inTurn = true;
    turnStart = Date.now();
    turnError = "";
    lastText = "";
    send({ type: "turn-start" });
  };

  const endTurn = () => {
    if (!inTurn) return;
    inTurn = false;
    if (lastText) send({ type: "answer", text: clip(lastText, 32000) });
    send({
      type: "turn-end",
      failed: !!turnError,
      ...(turnError ? { error: clip(turnError, 2000) } : {}),
      durationMs: Math.max(0, Date.now() - turnStart),
    });
  };

  const onTool = (part: Record<string, any>) => {
    const id = String(part.callID ?? part.id ?? "");
    const name = String(part.tool ?? "");
    const state = obj(part.state);
    const status = String(state.status ?? "");
    if (!id || !name || status === "pending") return; // pending has no input yet
    const input = obj(state.input);
    if (!started.has(id)) {
      started.add(id);
      send({
        type: "tool-start",
        id: clip(id, 200),
        name: clip(name, 100),
        summary: summary(input),
        input: clip(input, 4000),
        ...(name === "bash" && typeof input.command === "string" ? { command: clip(input.command, 4000) } : {}),
      });
    }
    if ((status !== "completed" && status !== "error") || ended.has(id)) return;
    ended.add(id);
    const failed = status === "error";
    const file = failed ? null : touched(name, input, obj(state.metadata));
    send({
      type: "tool-end",
      id: clip(id, 200),
      name: clip(name, 100),
      output: clip(failed ? state.error ?? "" : state.output ?? "", 4000),
      failed,
      ...(name === "bash" && typeof input.command === "string" ? { command: clip(input.command, 4000) } : {}),
      ...(file ? { files: [file] } : {}),
    });
  };

  const onEvent = (event: Record<string, any>) => {
    const p = obj(event.properties);
    const sid = String(p.sessionID ?? obj(p.info).sessionID ?? obj(p.part).sessionID ?? "");
    if (event.type === "session.created" || event.type === "session.updated") {
      const info = obj(p.info);
      if (info.parentID) {
        children.add(String(info.id));
        return;
      }
      if (info.id !== session && event.type === "session.updated") return; // another session's rename
      const named = typeof info.title === "string" && !PLACEHOLDER_TITLE.test(info.title) ? info.title : "";
      const changed = named !== title;
      title = named;
      announce(String(info.id ?? ""), changed);
      return;
    }
    if (!sid || children.has(sid)) return;
    if (sid !== session) announce(sid);
    switch (event.type) {
      case "session.status": {
        const type = obj(p.status).type;
        if (type === "busy") startTurn();
        else if (type === "idle") endTurn();
        return;
      }
      case "session.idle":
        endTurn();
        return;
      case "session.error": {
        const error = obj(p.error);
        turnError = String(obj(error.data).message ?? error.name ?? "error");
        send({ type: "error", message: clip(turnError, 2000) });
        return;
      }
      case "todo.updated": {
        const todos = Array.isArray(p.todos) ? p.todos : [];
        const items = todos
          .map((t: any) => ({ text: clip(obj(t).content ?? "", 500), status: STATUS.has(obj(t).status) ? obj(t).status : "pending" }))
          .filter((t: { text: string }) => t.text);
        send({ type: "plan", items: items.slice(0, 200) });
        return;
      }
      case "message.updated": {
        const info = obj(p.info);
        if (info.role === "user") asked.add(String(info.id));
        if (info.role !== "assistant") return;
        if (typeof info.modelID === "string" && info.modelID && (info.modelID !== model.id || info.providerID !== model.provider)) {
          model = { provider: String(info.providerID ?? ""), id: info.modelID };
          window = windows.get(`${model.provider}/${model.id}`) ?? 0;
          announce(session, true);
          void learnWindow(model.provider, model.id).then(report, () => {});
        }
        const t = obj(info.tokens);
        const cache = obj(t.cache);
        const tokens = { input: num(t.input), output: num(t.output), cacheRead: num(cache.read), cacheWrite: num(cache.write), reasoning: num(t.reasoning) };
        const context = tokens.input + tokens.cacheRead + tokens.cacheWrite;
        messages.set(String(info.id), { tokens, cost: num(info.cost), context });
        if (info.error) turnError = String(obj(obj(info.error).data).message ?? obj(info.error).name ?? "error");
        report();
        return;
      }
      case "message.part.updated": {
        const part = obj(p.part);
        if (part.type === "tool") onTool(part);
        else if (part.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string" && part.text.trim()) {
          if (inTurn && !asked.has(String(part.messageID))) lastText = part.text;
        }
        return;
      }
    }
  };

  return {
    event: async ({ event }: { event: unknown }) => {
      try { onEvent(obj(event)); } catch { /* an integration bug is not the agent's problem */ }
    },
    "chat.message": async (input: any, output: any) => {
      try {
        const sid = String(obj(input).sessionID ?? "");
        if (!sid || children.has(sid)) return;
        if (sid !== session) announce(sid);
        asked.add(String(obj(obj(output).message).id ?? ""));
        const parts = Array.isArray(obj(output).parts) ? obj(output).parts : [];
        const text = parts
          .filter((x: any) => obj(x).type === "text" && !obj(x).synthetic && !obj(x).ignored)
          .map((x: any) => String(obj(x).text ?? ""))
          .join("\n")
          .trim();
        startTurn();
        if (text) send({ type: "prompt", text: clip(text, 32000) });
      } catch { /* never the agent's problem */ }
    },
  };
};
