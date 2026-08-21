// The explorer's rules: what the project index turns into on screen, in either of its
// two modes, and what marks a row carries.
//
// This is the third file list in the app, and the design that makes it worth having is
// that it is a *superset* of the other two rather than a fourth idea: the working set
// (git) and the Context card (the hook stream) become scopes over the same rows, so a
// path is described the same way wherever you meet it.
//
// Browse is derived from the same flat index as find — not from a directory listing —
// which is the one decision here worth defending. A second source would mean two answers
// to "what is in this folder" (git's, and the filesystem's), and they differ constantly:
// an ignored build directory is on disk and not in the project. One list, one answer,
// and stepping into a folder costs no round trip.
//
// No DOM, no Tauri, no render imports. See test/explore.test.ts.

import { fuzzy } from "./palette";
import type { Sess, TouchKind } from "./types";

/// One row: a file from the index, or a folder synthesised from the paths inside it.
export interface ExpRow {
  name: string;              // what the row shows: a leaf name browsing, a full path finding
  path: string;              // always project-relative, forward slashes
  dir: boolean;
  n?: number;                // files beneath a folder (browse only)
  html?: string;             // fuzzy-highlighted `name` (find only)
  score?: number;
}
export type ExpScope = "all" | "changed" | "touched";

/// The folder above `cwd`, or "" at the root. Kept here rather than inline so the ⌫ key
/// and a breadcrumb click cannot disagree about what "up" means.
export function parentDir(cwd: string): string {
  const cut = cwd.lastIndexOf("/");
  return cut === -1 ? "" : cwd.slice(0, cut);
}

/// The breadcrumb, root first. The root's label is the project name; every later segment
/// names itself and carries the path that clicking it should go to.
export function crumbs(cwd: string, rootLabel: string): { label: string; path: string }[] {
  const out = [{ label: rootLabel, path: "" }];
  if (!cwd) return out;
  const segs = cwd.split("/");
  segs.forEach((s, i) => out.push({ label: s, path: segs.slice(0, i + 1).join("/") }));
  return out;
}

/// One folder's contents, folders first then files, each alphabetical.
///
/// A folder's count is the number of *in-scope* files anywhere beneath it, which is what
/// makes the scope chips read correctly while browsing: with `Changed` on, a folder
/// holding nothing changed does not appear at all rather than appearing empty.
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

/// Find mode: every in-scope path the query matches, best first.
///
/// The matcher is `palette.ts`'s, deliberately and permanently — one fuzzy in the app.
/// A file you keep opening should rank like a command you keep running, and a second
/// scorer would drift from ⌘K's on exactly the inputs where they should agree.
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

/// The predicate behind the scope chips. `all` is a constant true rather than an
/// `undefined` the callers have to test for.
export function scopeKeep(
  scope: ExpScope,
  changed: ReadonlyMap<string, string>,
  touched: ReadonlyMap<string, TouchKind>,
): (p: string) => boolean {
  if (scope === "changed") return (p) => changed.has(p);
  if (scope === "touched") return (p) => touched.has(p);
  return () => true;
}

/// An absolute path from a hook payload as a project-relative one, or null when it is
/// outside the project — which is common and not an error: agents read files in `$HOME`,
/// in a dependency, in a sibling checkout, and none of those belong in this list.
///
/// Case-insensitive on the prefix, because macOS and Windows both hand back paths whose
/// case does not match what the user typed, and a mismatch here silently drops every
/// mark rather than misplacing one.
export function relPath(abs: string, root: string): string | null {
  const a = abs.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!r) return null;
  if (a.toLowerCase() === r.toLowerCase()) return null;
  if (!a.toLowerCase().startsWith(r.toLowerCase() + "/")) return null;
  return a.slice(r.length + 1);
}

/// Which kind wins when a file has been touched by more than one session, or more than
/// one way. The same ladder the Context card climbs (read → edited → created) and for
/// the same reason: an agent re-reads what it just wrote constantly, so last-verb-wins
/// would demote half the created files seconds after they appeared.
const TOUCH_RANK: Record<TouchKind, number> = { read: 0, edited: 1, created: 2 };

/// Every file any session has touched inside this project, keyed by project-relative
/// path. Sessions are read, never mutated; a session in another folder contributes
/// nothing, which is what keeps a worktree's explorer about that worktree.
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

/// What ↵ will do, decided once and shown in the footer before the key is pressed.
///
/// The rule: **the app shows you changes, the OS shows you contents.** A file git has
/// something to say about opens its diff in the peek that already exists; anything else
/// is handed to the OS. That keeps the explorer read-only without it needing a viewer of
/// its own — the point where "not an IDE" would start to slide.
export type ExpAction = { kind: "enter"; path: string } | { kind: "diff"; path: string } | { kind: "open"; path: string };
export function rowAction(row: ExpRow | undefined, changed: ReadonlyMap<string, string>): ExpAction | null {
  if (!row) return null;
  if (row.dir) return { kind: "enter", path: row.path };
  return { kind: changed.has(row.path) ? "diff" : "open", path: row.path };
}
