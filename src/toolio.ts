// What a tool call was and what came back: the two blocks ./callsheet shows. Caps apply at
// capture, below ./phase, since a Read response is a whole file. Three shapes are modelled
// by hand; everything else is a generic key/value dump rather than a confident wrong guess.

import type { Act } from "./types";

export const DETAIL_CAP = 4000; // per side per call; memory only, a payload must never reach localStorage

// The marker is in the string itself so every consumer sees the same truncated text.
export function clip(s: string, max = DETAIL_CAP): string {
  const t = s.replace(/\s+$/, "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n… ${t.length - max} more characters`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function scalar(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function json(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
}

// The one field that *is* the call, printed bare and first: a Bash heredoc under a
// `command:` label, re-indented, is no longer the thing that ran. Unlisted tools lose nothing.
const PRIMARY: Record<string, string> = {
  Bash: "command",
  SlashCommand: "command",
  Write: "content",
  Task: "prompt",
  Agent: "prompt",
  Workflow: "script",
  ExitPlanMode: "plan",
};

const INLINE_MAX = 72; // a longer single-line value gets its own block

export const DESC_CAP = 200; // a guard against a pathological description, not a budget

// Claude's `description` is lifted out of `tool_input` so the Executed block stays pasteable, but
// only for tools with a PRIMARY field: elsewhere (an MCP calendar event) it is the payload itself.
export function descText(tool: string, input: unknown): string {
  if (!PRIMARY[tool] || !isObj(input)) return "";
  const d = str(input.description).trim();
  return d ? clip(d, DESC_CAP) : "";
}

// Block values are not indented: the copy button would hand over heredocs that no longer terminate.
export function fieldsText(o: Record<string, unknown>, primary?: string): string {
  const keys = Object.keys(o);
  const order = primary && keys.includes(primary) ? [primary, ...keys.filter((k) => k !== primary)] : keys;
  const out: string[] = [];
  for (const k of order) {
    const v = o[k];
    // Absent is not information; empty is (`matches: []` answers what a search found).
    if (v == null || v === "") continue;
    const s = scalar(v);
    if (k === primary && s !== null) { out.push(s.replace(/\s+$/, "")); continue; }
    const text = (s ?? json(v)).replace(/\s+$/, "");
    if (!text) continue;
    out.push(!text.includes("\n") && text.length <= INLINE_MAX ? `${k}: ${text}` : `${k}:\n${text}`);
  }
  return out.join("\n");
}

export function inputText(tool: string, input: unknown): string {
  if (!isObj(input)) {
    const s = scalar(input);
    return s ? clip(s) : "";
  }
  const o = descText(tool, input) ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== "description")) : input;
  return clip(fieldsText(o, PRIMARY[tool]));
}

// An empty stdout says so: "nothing came back" and "we kept nothing" look identical otherwise.
function bashText(o: Record<string, unknown>): string {
  const out = str(o.stdout).replace(/\s+$/, "");
  const err = str(o.stderr).replace(/\s+$/, "");
  const parts: string[] = [];
  if (out) parts.push(out);
  if (err) parts.push(`stderr:\n${err}`);
  if (o.interrupted === true) parts.push("(interrupted)");
  return parts.length ? parts.join("\n") : "(no output)";
}

// From the patch, never from `originalFile` (the whole file before the change).
function patchText(o: Record<string, unknown>): string {
  const hunks = Array.isArray(o.structuredPatch) ? o.structuredPatch : [];
  // `type` is Write-only; an Edit reply has just the patch, so hunks fall back to "updated".
  const head = o.type === "create" ? "created"
    : o.type === "update" || hunks.length ? "updated" : "wrote";
  // Filter on `lines`, not the joined string: every element carries a newline after the
  // `@@` header, so a string test would keep a bare header and starve the fallback below.
  const body = hunks
    .map((h) => {
      const g = isObj(h) ? h : {};
      const lines = Array.isArray(g.lines) ? g.lines.map((l) => String(l)) : [];
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      return { head: `@@ -${n(g.oldStart)},${n(g.oldLines)} +${n(g.newStart)},${n(g.newLines)} @@`, lines };
    })
    .filter((h) => h.lines.length > 0)
    .map((h) => `${h.head}\n${h.lines.join("\n")}`)
    .join("\n");
  if (body) return `${head}\n${body}`;
  const content = str(o.content);
  return content ? `${head} · ${content.split("\n").length} lines` : head;
}

// `error` first: a PostToolUseFailure has no `tool_response` and puts the reason in a plain
// string. Responses are recognised by shape, not tool name: `stdout` covers tools never seen.
export function outputText(resp: unknown, error: unknown): string {
  const err = typeof error === "string" ? error : "";
  if (err.trim()) return clip(err);
  if (resp == null) return "";
  if (!isObj(resp)) {
    const s = scalar(resp);
    if (s) return clip(s);
    // An array reaches neither `scalar` nor `fieldsText`; "" here read as "(nothing returned)".
    return Array.isArray(resp) ? clip(json(resp)) : "";
  }
  // Order matters: a Write response carries `structuredPatch` AND `content`, so the patch must win.
  if ("stdout" in resp || "stderr" in resp) return clip(bashText(resp));
  if ("structuredPatch" in resp) return clip(patchText(resp));
  if (resp.type === "text" && isObj(resp.file)) {
    const content = str(resp.file.content);
    return content.trim() ? clip(content) : "(empty file)";
  }
  return clip(fieldsText(resp));
}

// What the Copy button hands over: both blocks, labelled. Here rather than the renderer so it is tested.
export function actClipText(a: Act): string {
  const out = a.out || (a.durMs == null ? "still running" : "(nothing returned)");
  const why = a.desc ? `${a.desc}\n` : ""; // in the header, never inside `# executed`
  return `${a.tool}${a.arg ? ` · ${a.arg}` : ""}\n${why}\n# executed\n${a.inp || "(no arguments)"}\n\n# ${a.failed ? "failed" : "returned"}\n${out}\n`;
}
