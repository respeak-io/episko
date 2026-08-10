// What a session has been *into*: the files it read, edited and created, kept as a set
// rather than as a log. The rules behind the inspector's Context card.
//
// It replaces "the last eight tool calls" with "the working set of this conversation",
// because those answer different questions. A timeline tells you what happened at
// 14:32; it cannot tell you whether the agent has opened the file you're worried about,
// and on a busy turn eight rows is roughly forty seconds of history — long enough to
// scroll `Bash`, `Bash`, `Grep`, `Bash` past you and nothing else. The set survives the
// whole conversation, dedupes by path, and sorts the two answers you actually want
// (what did it change / what did it look at) into their own groups.
//
// Pure logic, no DOM and no Tauri: the view is `filesHtml` in ./inspectorview and the
// only writer is `applyHook` in ./phase.
//
// **Bash is deliberately not modelled here.** `touch`, `>`, `sed -i` and `mv` all
// change files and none of them reaches us as a path — reconstructing that would mean
// parsing shell, and getting it half-right would put wrong filenames on screen with the
// same confidence as the right ones. What Bash actually did to the tree is already
// answered, correctly, by the working-set card above this one, which reads git. So the
// non-file tools are counted and summarised in one line (`otherTools`) rather than
// guessed at.

import type { FileTouch, TouchKind } from "./types";

/// Kinds rank, and a file's kind only ever moves up this ladder. Three reasons it is a
/// ladder rather than "the last thing that happened":
///
///   • an agent re-reads what it just wrote constantly (to check its own edit), so a
///     last-write-wins field would demote half the edited files to "read" seconds later;
///   • "created" is the fact with the shortest shelf life — it is only knowable at the
///     moment of the write — so it has to be the one that sticks;
///   • the groups are meant to be read as claims about the file ("this one is new"),
///     not as a most-recent-verb, and a claim that flickers is worse than no claim.
const RANK: Record<TouchKind, number> = { read: 0, edited: 1, created: 2 };

const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

/// How many paths one session keeps. A long session on a big repo genuinely reads
/// hundreds of files, and the card only ever draws a couple of dozen of them, so this
/// is a memory bound rather than a display one — generous, because the cheapest way to
/// make the card lie is to have silently dropped the file being asked about.
const CAP = 400;

/// Which of the three things a tool does to a file, or null if it does none of them.
/// Also the definition the "also ran" tally filters by, so the two halves of the card
/// can never disagree about what counts as a file tool.
export function touchTool(tool: string): "read" | "edit" | "write" | null {
  if (READ_TOOLS.has(tool)) return "read";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (tool === "Write") return "write";
  return null;
}

/// The path a file tool's input names. Absolute on every payload Claude Code sends,
/// which is what makes the row clickable at all. `notebook_path` is NotebookEdit's
/// spelling of the same field; `path` is deliberately NOT read — Glob and Grep use it
/// for a *directory*, and this is only ever consulted for the tools above, so leaving
/// it out costs nothing and removes the one way a folder could land in the file list.
export function touchPath(input: unknown): string {
  const i = input as Record<string, unknown> | null | undefined;
  const v = i?.file_path ?? i?.notebook_path;
  return typeof v === "string" && v.trim() ? v : "";
}

/// Did a `Write` create the file or overwrite one that was already there?
///
/// Claude Code answers this itself: the Write tool's PostToolUse `tool_response` carries
/// `type: "create" | "update"`. That is the authority when it's there — and it is
/// treated as optional, because it is one undocumented field of a payload shape we
/// don't control, and a card that goes blank when Claude Code renames a key is a worse
/// failure than one that occasionally mislabels a row.
///
/// The fallback: a path this session has never read or written before is one it has
/// just brought into existence. That is right in the normal case (an agent reads a file
/// before it rewrites it, essentially always) and wrong for a cold overwrite of an
/// existing file it never opened — which lands in "Created" instead of "Edited". The
/// row, its path and its click all still work; only the heading is optimistic.
function writeKind(list: readonly FileTouch[], path: string, response: unknown): TouchKind {
  const t = response && typeof response === "object" ? (response as Record<string, unknown>).type : "";
  if (t === "create") return "created";
  if (t === "update") return "edited";
  return list.some((f) => f.path === path) ? "edited" : "created";
}

/// Fold one completed tool call into the session's file set. Mutates in place, like
/// `openActivity` next door — the caller owns the array and there is exactly one.
/// A tool that touched no file leaves it untouched.
export function applyTouch(list: FileTouch[], tool: string, input: unknown, response: unknown, now: number): void {
  const act = touchTool(tool);
  if (!act) return;
  const path = touchPath(input);
  if (!path) return;
  const kind: TouchKind = act === "read" ? "read" : act === "edit" ? "edited" : writeKind(list, path, response);
  const at = list.findIndex((f) => f.path === path);
  if (at >= 0) {
    const f = list[at];
    f.n++;
    f.at = now;
    if (RANK[kind] > RANK[f.kind]) f.kind = kind;
    return;
  }
  list.push({ path, kind, n: 1, at: now });
  if (list.length > CAP) evict(list);
}

/// Drop one entry when the cap is hit: the lowest-ranked, and among equals the oldest.
/// Reads go first and that ordering is the point — a read is the cheapest fact in the
/// set (the agent looked at something), while an edit or a create is the expensive one
/// (the agent *changed* something, and that is what you came to the card to find). A
/// plain oldest-first eviction would let a long read-heavy sweep push the morning's
/// edits out of a list that has room for them.
function evict(list: FileTouch[]): void {
  let worst = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i], b = list[worst];
    if (RANK[a.kind] < RANK[b.kind] || (RANK[a.kind] === RANK[b.kind] && a.at < b.at)) worst = i;
  }
  list.splice(worst, 1);
}

export interface FileGroups { created: FileTouch[]; edited: FileTouch[]; read: FileTouch[] }
export const GROUP_ORDER = ["created", "edited", "read"] as const;

/// The set split into the card's three sections, each most-recent-first. Recency rather
/// than alphabetical: the file the agent touched thirty seconds ago is the one you are
/// looking for, and a name sort would bury it under whatever starts with an `a`.
export function groupTouches(list: readonly FileTouch[]): FileGroups {
  const g: FileGroups = { created: [], edited: [], read: [] };
  for (const f of list) g[f.kind].push(f);
  for (const k of GROUP_ORDER) g[k].sort((a, b) => b.at - a.at);
  return g;
}

export interface FileLabel {
  /// The basename — what the row leads with, because it is what you are scanning for.
  name: string;
  /// Where it sits: relative to the session's folder when it's inside it, absolute when
  /// it isn't. Empty for a file in the folder's root.
  dir: string;
  /// True when the file is outside the session's own folder — a config in `$HOME`, a
  /// sibling checkout, a dependency's source. Worth its own tint: it is the one case
  /// where the folder matters more than the filename.
  outside: boolean;
}

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/// Split a path into what the row shows. Comparison is case-insensitive and
/// separator-levelled for the same reason ./gitwatch's `norm` is: one side is however
/// the user spelled the project folder, the other is however Claude Code spelled the
/// path, and both mainstream desktop filesystems are case-insensitive anyway. The
/// *original* spelling is what gets sliced and returned — only the comparison is
/// normalised, so the row shows the path as it really is.
export function fileLabel(path: string, workdir: string): FileLabel {
  const p = slash(path);
  const cut = p.lastIndexOf("/");
  const name = (cut >= 0 ? p.slice(cut + 1) : p) || p;
  const dir = cut > 0 ? p.slice(0, cut) : cut === 0 ? "/" : "";
  const root = slash(workdir);
  if (!root) return { name, dir, outside: false };
  const lo = dir.toLowerCase(), rlo = root.toLowerCase();
  if (lo === rlo) return { name, dir: "", outside: false };
  if (lo.startsWith(rlo + "/")) return { name, dir: dir.slice(root.length + 1), outside: false };
  return { name, dir, outside: true };
}

/// Count one tool call. Every tool, including the file ones — `otherTools` filters, so
/// the raw tally stays a true record of what the session ran and a later surface can
/// ask it a different question without this having thrown the answer away.
export function bumpTally(tally: Record<string, number>, tool: string): void {
  if (!tool) return;
  tally[tool] = (tally[tool] ?? 0) + 1;
}

/// The one-line footer: the tools that moved no file, busiest first. This is what the
/// old timeline is reduced to, and reducing it is the point — "Bash ×47" is the whole
/// of what forty-seven `Bash` rows were telling you, in one line, without crowding out
/// the files.
///
/// `TodoWrite` and `ExitPlanMode` are dropped as well as the file tools: they are the
/// plan, and the plan is its own card directly above.
export function otherTools(tally: Record<string, number>, top = 6): { tool: string; n: number }[] {
  return Object.entries(tally)
    .filter(([t]) => !touchTool(t) && t !== "TodoWrite" && t !== "ExitPlanMode")
    .map(([tool, n]) => ({ tool, n }))
    .sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool))
    .slice(0, top);
}

/// `mcp__github__create_issue` → `github·create_issue`. MCP tool names are namespaced
/// three deep and the footer has one line; the server is the half worth keeping, since
/// it is what tells you *whose* tool ran.
export function shortTool(tool: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  return m ? `${m[1]}·${m[2]}` : tool;
}
