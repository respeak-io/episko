// The explorer's rules (docs/explorer.md): one flat index feeds both browse and find, so
// git's answer to "what is in this folder" is the only one, and the working set and the
// Context card are scopes over the same rows. No DOM, no Tauri.

import { fuzzy } from "./palette";
import type { Sess, TouchKind } from "./types";

// A file from the index, or a folder synthesised from the paths beneath it.
export interface ExpRow {
  name: string;              // what the row shows: a leaf name browsing, a full path finding
  path: string;              // always project-relative, forward slashes
  dir: boolean;
  n?: number;                // files beneath a folder (browse only)
  html?: string;             // fuzzy-highlighted `name` (find only)
  score?: number;
}
export type ExpScope = "all" | "changed" | "touched";

// Shared by ⌫ and the breadcrumb so the two cannot disagree about "up".
export function parentDir(cwd: string): string {
  const cut = cwd.lastIndexOf("/");
  return cut === -1 ? "" : cwd.slice(0, cut);
}

export function crumbs(cwd: string, rootLabel: string): { label: string; path: string }[] {
  const out = [{ label: rootLabel, path: "" }];
  if (!cwd) return out;
  const segs = cwd.split("/");
  segs.forEach((s, i) => out.push({ label: s, path: segs.slice(0, i + 1).join("/") }));
  return out;
}

// A folder counts only in-scope files beneath it, so with a scope chip on, a folder with
// nothing in scope is absent rather than empty.
export function browseRows(paths: readonly string[], cwd: string, keep: (p: string) => boolean): ExpRow[] {
  const dirs = new Map<string, number>();
  const files: ExpRow[] = [];
  const prefix = cwd ? cwd + "/" : "";
  for (const p of paths) {
    if (prefix && !p.startsWith(prefix)) continue;
    if (!keep(p)) continue;
    const rest = p.slice(prefix.length);
    const cut = rest.indexOf("/");
    if (cut === -1) files.push({ name: rest, path: p, dir: false });
    else {
      const name = rest.slice(0, cut);
      dirs.set(name, (dirs.get(name) ?? 0) + 1);
    }
  }
  const dirRows: ExpRow[] = [...dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, n]) => ({ name, path: prefix + name, dir: true, n }));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirRows, ...files];
}

// One fuzzy matcher in the app: a second scorer would drift from ⌘K's.
export function findRows(
  paths: readonly string[],
  q: string,
  keep: (p: string) => boolean,
  limit = 60,
): ExpRow[] {
  const out: ExpRow[] = [];
  for (const p of paths) {
    if (!keep(p)) continue;
    const m = fuzzy(p, q);
    if (m) out.push({ name: p, path: p, dir: false, html: m.html, score: m.score });
  }
  // Score first, then path, so an identical score never reorders between keystrokes.
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

export function scopeKeep(
  scope: ExpScope,
  changed: ReadonlyMap<string, string>,
  touched: ReadonlyMap<string, TouchKind>,
): (p: string) => boolean {
  if (scope === "changed") return (p) => changed.has(p);
  if (scope === "touched") return (p) => touched.has(p);
  return () => true;
}

// Null outside the project is common, not an error. The prefix compares case-insensitively:
// macOS and Windows return paths whose case differs from what was typed, and a mismatch
// here would silently drop every mark.
export function relPath(abs: string, root: string): string | null {
  const a = abs.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!r) return null;
  if (a.toLowerCase() === r.toLowerCase()) return null;
  if (!a.toLowerCase().startsWith(r.toLowerCase() + "/")) return null;
  return a.slice(r.length + 1);
}

// Same ladder as the Context card's (files.ts); keep them in step.
const TOUCH_RANK: Record<TouchKind, number> = { read: 0, edited: 1, created: 2 };

// Sessions in another folder contribute nothing: a worktree's explorer is about that worktree.
export function touchIndex(sessions: Iterable<Sess>, root: string): Map<string, TouchKind> {
  const out = new Map<string, TouchKind>();
  for (const s of sessions) {
    for (const f of s.files) {
      const rel = relPath(f.path, root);
      if (rel === null) continue;
      const prev = out.get(rel);
      if (prev === undefined || TOUCH_RANK[f.kind] > TOUCH_RANK[prev]) out.set(rel, f.kind);
    }
  }
  return out;
}

// The app shows changes, the OS shows contents: a changed file opens in the existing
// peek, anything else is handed to the OS, and the explorer needs no viewer of its own.
export type ExpAction = { kind: "enter"; path: string } | { kind: "diff"; path: string } | { kind: "open"; path: string };
export function rowAction(row: ExpRow | undefined, changed: ReadonlyMap<string, string>): ExpAction | null {
  if (!row) return null;
  if (row.dir) return { kind: "enter", path: row.path };
  return { kind: changed.has(row.path) ? "diff" : "open", path: row.path };
}
