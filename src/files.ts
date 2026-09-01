// The inspector's Context card: the files a session read, edited and created, as a set
// rather than a log. Bash is not modelled: what it did to the tree is git's answer, on the
// working-set card; the non-file tools are tallied in one line (`otherTools`) instead.

import type { FileTouch, TouchKind } from "./types";

// A provider may name a path relative to the thread cwd; everything downstream wants absolute,
// so resolve it once as it enters `Sess`. Absolute POSIX, UNC and drive paths pass through.
export function absoluteTouchPath(path: string, workdir: string): string {
  const p = path.trim();
  if (!p || !workdir || /^[A-Za-z]:[/\\]/.test(p) || p.startsWith("/") || p.startsWith("\\")) return p;
  const sep = workdir.includes("\\") && !workdir.includes("/") ? "\\" : "/";
  return `${workdir.replace(/[/\\]+$/, "")}${sep}${p.replace(/[/\\]/g, sep)}`;
}

// A kind only ever climbs: an agent re-reads what it just wrote, so last-write-wins would
// demote edited files to "read" seconds later, and "created" is only knowable at the write.
const RANK: Record<TouchKind, number> = { read: 0, edited: 1, created: 2 };

const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

const CAP = 400; // a memory bound, not a display one; the card draws a couple of dozen

// For an adapter that already knows the kind (Codex file-change items carry add/update/delete).
export function noteTouch(list: FileTouch[], path: string, kind: TouchKind, now: number): void {
  if (!path.trim()) return;
  const at = list.findIndex((f) => f.path === path);
  if (at >= 0) {
    const f = list[at]; f.n++; f.at = now;
    if (RANK[kind] > RANK[f.kind]) f.kind = kind;
    return;
  }
  list.push({ path, kind, n: 1, at: now });
  if (list.length > CAP) evict(list);
}

// Also what `otherTools` filters by, so the two halves of the card agree on what a file tool is.
export function touchTool(tool: string): "read" | "edit" | "write" | null {
  if (READ_TOOLS.has(tool)) return "read";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (tool === "Write") return "write";
  return null;
}

// `path` is not read: Glob and Grep use it for a directory.
export function touchPath(input: unknown): string {
  const i = input as Record<string, unknown> | null | undefined;
  const v = i?.file_path ?? i?.notebook_path;
  return typeof v === "string" && v.trim() ? v : "";
}

// The Write response's `type` is the authority but undocumented, so optional. Fallback: a path never
// seen before was created; a cold overwrite then lands in "Created", the heading being optimistic.
function writeKind(list: readonly FileTouch[], path: string, response: unknown): TouchKind {
  const t = response && typeof response === "object" ? (response as Record<string, unknown>).type : "";
  if (t === "create") return "created";
  if (t === "update") return "edited";
  return list.some((f) => f.path === path) ? "edited" : "created";
}

// Mutates in place; the caller owns the array. A tool that touched no file leaves it alone.
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

// Lowest rank first, then oldest: a read-heavy sweep must not push the morning's edits out.
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

// Most-recent-first: the file touched thirty seconds ago is the one you are looking for.
export function groupTouches(list: readonly FileTouch[]): FileGroups {
  const g: FileGroups = { created: [], edited: [], read: [] };
  for (const f of list) g[f.kind].push(f);
  for (const k of GROUP_ORDER) g[k].sort((a, b) => b.at - a.at);
  return g;
}

export interface FileLabel {
  name: string;
  dir: string;      // relative to the session's folder when inside it, else absolute; "" at the root
  outside: boolean; // a config in $HOME, a sibling checkout, a dependency: worth its own tint
}

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

// Compared case-insensitive and separator-levelled, like ./gitwatch's `norm`; only the
// comparison is normalised, the row shows the path as spelled.
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

// Every tool, file ones included; `otherTools` filters, so the raw tally stays a true record.
export function bumpTally(tally: Record<string, number>, tool: string): void {
  if (!tool) return;
  tally[tool] = (tally[tool] ?? 0) + 1;
}

// Busiest first. `TodoWrite` and `ExitPlanMode` are dropped too: the plan is its own card above.
export function otherTools(tally: Record<string, number>, top = 6): { tool: string; n: number }[] {
  return Object.entries(tally)
    .filter(([t]) => !touchTool(t) && t !== "TodoWrite" && t !== "ExitPlanMode")
    .map(([tool, n]) => ({ tool, n }))
    .sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool))
    .slice(0, top);
}

// `mcp__github__create_issue` → `github·create_issue`: the server says whose tool ran.
export function shortTool(tool: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  return m ? `${m[1]}·${m[2]}` : tool;
}
