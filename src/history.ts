// The rules behind History: what a past session is, where it belongs, whether it can come
// back. No DOM (./historyui owns the dialog). Joins each provider's durable history, since
// the restore roster forgets a closed session and never knew ones started elsewhere.

import { basename } from "./format";
import { backendLive, dormants, externals, FAVORITES, handoffs, sessions } from "./state";
import { handoffBusy } from "./handoff";
import { providerSessionKey } from "./types";

export interface HistEntry {
  provider: string;
  session_id: string; cwd: string; project: string; branch: string;
  title: string; last_prompt: string; bytes: number; exists: boolean;
  last_active: number;        // epoch seconds, from the transcript's newest record, not its mtime
  repo_root: string | null;   // the repo's main worktree — see histProject
}

export const histLabel = (h: HistEntry) => h.title || h.last_prompt || "untitled session";

// The colorKey the row would have if it were open: what ◧ filters on and a resume launches
// with. `repo_root` is needed because a worktree usually lives beside its repo, not inside.
export function histProject(h: HistEntry): { project: string; colorKey: string; worktree: string | null } {
  const known = knownAt(h.cwd);
  if (known) return { project: known.project, colorKey: known.colorKey, worktree: known.worktree };
  const root = h.repo_root || h.cwd;
  const fav = favFor(root);
  const colorKey = fav ? fav.path : root;
  return {
    project: fav ? fav.name : basename(root),
    colorKey,
    worktree: h.cwd === colorKey ? null : (h.branch || basename(h.cwd)),
  };
}
// Both separators: a cwd carries whichever the recording platform used.
const under = (p: string, root: string) => p === root || p.startsWith(root + "/") || p.startsWith(root + "\\");
const knownAt = (cwd: string) =>
  [...sessions.values()].find((s) => s.workdir === cwd) || dormants.find((d) => d.workdir === cwd);
// The innermost favourite at or above `path`.
const favFor = (path: string) => FAVORITES.find((f) => f.path === path)
  || FAVORITES.filter((f) => under(path, f.path)).sort((a, b) => b.path.length - a.path.length)[0];

// Claude takes no lock on a transcript, so an id live anywhere must not be resumed twice.
// `backendLive` covers a reload orphan (#47); its rotated id is known only to the roster.
export function histBusy(h: HistEntry): boolean {
  const id = h.session_id.toLowerCase();
  for (const s of sessions.values()) {
    if (s.provider === h.provider && (s.resumeId.toLowerCase() === id || s.id.toLowerCase() === id)) return true;
  }
  if (backendLive.has(providerSessionKey(h.provider, id))) return true;
  for (const d of dormants) {
    if (d.provider === h.provider
      && backendLive.has(providerSessionKey(d.provider, d.id))
      && d.resumeId.toLowerCase() === id) return true;
  }
  if (h.provider === "claude" && handoffBusy(handoffs, id)) return true;
  return h.provider === "claude" && externals.some((e) => e.session_id.toLowerCase() === id);
}

// On the resolved colorKey so every worktree counts. The path test is the fallback, except that
// a repo, pane or favourite nested inside `root` owns its rows, or a parent folder lists them all.
export function histInProject(h: HistEntry, root: string): boolean {
  if (histProject(h).colorKey === root) return true;
  if (!under(h.cwd, root)) return false;
  const owners = [h.repo_root, knownAt(h.cwd)?.colorKey, favFor(h.cwd)?.path];
  return !owners.some((o) => o && o !== root && under(o, root));
}

// Every provider's latest batch as one list, newest first and capped.
export function histMerge(batches: Iterable<HistEntry[]>, limit: number): HistEntry[] {
  return [...batches].flat().sort((a, b) => b.last_active - a.last_active).slice(0, limit);
}

// Where the selected session sits after a refresh reordered the list; the top if it left.
export function histIndexOf(rows: HistEntry[], key: string | null): number {
  const i = key ? rows.findIndex((h) => providerSessionKey(h.provider, h.session_id) === key) : -1;
  return Math.max(0, i);
}

export function histMatches(h: HistEntry, term: string): boolean {
  if (!term) return true;
  return `${h.title} ${h.last_prompt} ${h.project} ${h.branch} ${h.cwd}`.toLowerCase().includes(term.toLowerCase());
}

export function histBucket(ms: number, now = Date.now()): string {
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(new Date(ms))) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  if (days < 31) return "This month";
  if (days < 366) return "This year";
  return "Older";
}
