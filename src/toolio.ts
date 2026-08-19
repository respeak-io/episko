// What a tool call actually *was*, and what actually came back from it — the two text
// blocks behind an expanded row in the inspector's Tools timeline.
//
// The timeline has always shown a tool name, one abbreviated field and a latency bar,
// which answers "what is it doing" and nothing else. The two questions people ask next
// — what exactly did it run, and what did it say — were never a data problem: the hooks
// POST their entire stdin and `run_telemetry_server` forwards the body whole, so
// `applyHook` has been holding the full `tool_input` and `tool_response` all along and
// dropping everything but one field of each on the floor. This module is what reads the
// rest of it.
//
// Pure logic, no DOM and no Tauri, and it sits *below* ./phase: the caps here are
// applied at capture, before anything lands on a `Sess`, because a `Read` response is a
// whole file and a `Grep` can be thousands of lines. A view-side truncation would keep
// the whole thing alive in memory for every one of the twelve calls a session rings.
//
// Three shapes are modelled by hand and everything else falls through to a generic
// key/value dump. That split is deliberate: the three are the ones whose raw payload is
// actively misleading (an `Edit` response carries `originalFile`, i.e. the entire file
// before the change, which would bury the one-line patch it also carries and eat the
// whole cap doing it), and guessing at the rest would put confident-looking wrong text
// on screen — the same reasoning that keeps Bash out of ./files.

/// How much of each side one call keeps, in characters.
///
/// Twelve calls × two sides × this is the per-session ceiling (~96 KB), and it is *only*
/// a memory ceiling: none of it is persisted and none of it is written to disk. A tool
/// payload must never reach `localStorage` — the telemetry path is a disk-write path.
export const DETAIL_CAP = 4000;

/// Cut a block to the cap and *say so*. The marker is part of the string rather than a
/// flag on the side so that everything downstream — the `<pre>`, the copy button, a
/// test — sees the same truncated text and cannot disagree about whether it is whole.
export function clip(s: string, max = DETAIL_CAP): string {
  const t = s.replace(/\s+$/, "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n… ${t.length - max} more characters`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/// A value that renders as itself, or null when it needs JSON.
function scalar(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function json(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
}

/// The one field whose value simply *is* the call, printed bare and first.
///
/// Everything else is rendered `key: value`, which is right for a payload of several
/// small fields and wrong for the case this feature exists for: a `Bash` heredoc under a
/// `command:` label, re-indented, is no longer the thing that ran. A tool that isn't
/// here loses nothing — its fields are all keyed, which is what an unfamiliar payload
/// (an MCP tool, a tool that ships next month) should look like anyway.
const PRIMARY: Record<string, string> = {
  Bash: "command",
  SlashCommand: "command",
  Write: "content",
  Task: "prompt",
  Agent: "prompt",
  Workflow: "script",
  ExitPlanMode: "plan",
};

/// Where a single-line value stops being a label's tail and starts wanting its own block.
const INLINE_MAX = 72;

/// A payload object as readable text: `key: value` for anything short and single-line,
/// `key:` + the value on its own lines for anything that isn't.
///
/// Block values are **not indented**, deliberately. Indenting reads better and would
/// mean the copy button hands you a script whose heredocs no longer terminate.
export function fieldsText(o: Record<string, unknown>, primary?: string): string {
  const keys = Object.keys(o);
  const order = primary && keys.includes(primary) ? [primary, ...keys.filter((k) => k !== primary)] : keys;
  const out: string[] = [];
  for (const k of order) {
    const v = o[k];
    // An absent field is not information. Dropping it keeps a two-field payload two
    // lines long instead of ten of `foo: null`. An *empty* one is left in, though — a
    // `matches: []` is the answer to what a search found, not the absence of an answer.
    if (v == null || v === "") continue;
    const s = scalar(v);
    if (k === primary && s !== null) { out.push(s.replace(/\s+$/, "")); continue; }
    const text = (s ?? json(v)).replace(/\s+$/, "");
    if (!text) continue;
    out.push(!text.includes("\n") && text.length <= INLINE_MAX ? `${k}: ${text}` : `${k}:\n${text}`);
  }
  return out.join("\n");
}

/// What was executed. `tool_input`, whole, capped.
export function inputText(tool: string, input: unknown): string {
  if (!isObj(input)) {
    const s = scalar(input);
    return s ? clip(s) : "";
  }
  return clip(fieldsText(input, PRIMARY[tool]));
}

/// `stdout`, then `stderr` if there is any, then whether it was cut short.
///
/// A command that printed nothing says so rather than expanding to a blank box: an
/// empty `stdout` is a real and common answer (`mkdir`, `git add`), and "nothing came
/// back" and "we kept nothing" look identical otherwise.
function bashText(o: Record<string, unknown>): string {
  const out = str(o.stdout).replace(/\s+$/, "");
  const err = str(o.stderr).replace(/\s+$/, "");
  const parts: string[] = [];
  if (out) parts.push(out);
  if (err) parts.push(`stderr:\n${err}`);
  if (o.interrupted === true) parts.push("(interrupted)");
  return parts.length ? parts.join("\n") : "(no output)";
}

/// What a `Write` or an `Edit` did, from the patch Claude Code hands back — never from
/// `originalFile`, which is the whole file before the change and is the reason this
/// shape is modelled at all.
function patchText(o: Record<string, unknown>): string {
  const hunks = Array.isArray(o.structuredPatch) ? o.structuredPatch : [];
  // `type` is a Write-only field — an `Edit` reply has no such discriminant, just the
  // patch. So hunks are the fallback: a patch at all means there was something there to
  // patch, which is the same claim `update` makes.
  const head = o.type === "create" ? "created"
    : o.type === "update" || hunks.length ? "updated" : "wrote";
  const body = hunks
    .map((h) => {
      const g = isObj(h) ? h : {};
      const lines = Array.isArray(g.lines) ? g.lines.map((l) => String(l)) : [];
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      return `@@ -${n(g.oldStart)},${n(g.oldLines)} +${n(g.newStart)},${n(g.newLines)} @@\n${lines.join("\n")}`;
    })
    .filter((h) => h.includes("\n"))
    .join("\n");
  if (body) return `${head}\n${body}`;
  // A fresh file has no hunks to show, and its content is already on the input side.
  const content = str(o.content);
  return content ? `${head} · ${content.split("\n").length} lines` : head;
}

/// What came back. `error` when the call failed, `tool_response` when it didn't.
///
/// Those are genuinely different fields rather than two spellings of one: a
/// `PostToolUseFailure` payload carries **no `tool_response` at all** — it is null — and
/// puts the reason in a plain-string `error` ("Exit code 1\ncat: …: No such file"). That
/// is the single highest-value thing on this card and it has no surface anywhere else in
/// the app, so it is read first and the caller styles it as a failure.
/// No tool name is taken, unlike `inputText`: a response is recognised by its *shape*,
/// and that is the more durable half of the join — `stdout`/`stderr` is every shell-ish
/// tool including ones we have never seen, whereas an input's dominant field is a fact
/// about the tool's own schema, knowable only by name.
export function outputText(resp: unknown, error: unknown): string {
  const err = typeof error === "string" ? error : "";
  if (err.trim()) return clip(err);
  if (resp == null) return "";
  if (!isObj(resp)) {
    const s = scalar(resp);
    return s ? clip(s) : "";
  }
  // Order matters: a Write response carries `type`, `content` AND `structuredPatch`, so
  // the patch has to win before the generic dump prints the whole file back at you.
  if ("stdout" in resp || "stderr" in resp) return clip(bashText(resp));
  if ("structuredPatch" in resp) return clip(patchText(resp));
  if (resp.type === "text" && isObj(resp.file)) {
    const content = str(resp.file.content);
    return content.trim() ? clip(content) : "(empty file)";
  }
  return clip(fieldsText(resp));
}
