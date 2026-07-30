// The rules behind History — what a past session *is*, where it belongs, and whether
// it can come back. No DOM: ./historyui owns the dialog, this owns the decisions, the
// same split as ./palette and ./palui. That is what lets the load-bearing parts —
// regrafting a row onto a project, and refusing to resume a live one — be tested.
//
// "Reopen a session I closed" is a question the restore roster in ./mirror cannot
// answer, by design: `closeSession` drops an entry (an explicit close means done) and
// the roster only ever knew the sessions Episko launched. So History reads the store
// that forgets nothing — Claude's own transcripts, via `list_session_history` — which
// makes its list a *superset* of the sidebar's dormant rows, sessions started in a
// plain terminal or an IDE included.

import { basename } from "./format";
import { dormants, externals, FAVORITES, sessions } from "./state";

/// One row as `list_session_history` returns it.
export interface HistEntry {
  session_id: string; cwd: string; project: string; branch: string;
  title: string; last_prompt: string; mtime: number; bytes: number; exists: boolean;
  repo_root: string | null;   // the repo's main worktree — see histProject
}

/** What a row calls itself: Claude's own title, else the last thing asked of it. */
export const histLabel = (h: HistEntry) => h.title || h.last_prompt || "untitled session";

// Put a history row back into the sidebar's own grouping — the colorKey it would have
// had if it were still open. This is what the ◧ scope filter matches on, and what a
// resume hands to `launch`, so getting it right is what makes "this project" mean the
// repo rather than one folder of it.
//
// `repo_root` (resolved in the backend, one git call per unique cwd) is the
// load-bearing part: a worktree usually lives BESIDE its repo, not inside it, so no
// path-prefix test can find it. A session Episko already knows still wins — it carries
// the user's own naming and colour.
export function histProject(h: HistEntry): { project: string; colorKey: string; worktree: string | null } {
  const known = [...sessions.values()].find((s) => s.workdir === h.cwd) || dormants.find((d) => d.workdir === h.cwd);
  if (known) return { project: known.project, colorKey: known.colorKey, worktree: known.worktree };
  const root = h.repo_root || h.cwd;
  const fav = FAVORITES.find((f) => f.path === root)
    || FAVORITES.filter((f) => under(root, f.path)).sort((a, b) => b.path.length - a.path.length)[0];
  const colorKey = fav ? fav.path : root;
  return {
    project: fav ? fav.name : basename(root),
    colorKey,
    worktree: h.cwd === colorKey ? null : (h.branch || basename(h.cwd)),
  };
}
/** `p` is `root` or sits inside it. Both separators, because a cwd carries whichever
 *  the recording platform used. */
const under = (p: string, root: string) => p === root || p.startsWith(root + "/") || p.startsWith(root + "\\");

// Same rule as sidebarview's `dormantBusy`, matched against the transcript id rather
// than a roster entry: an id live in Episko or in another terminal must not be
// resumed — Claude takes no lock on a transcript, so a second `--resume` would
// interleave both conversations into one file.
export function histBusy(h: HistEntry): boolean {
  const id = h.session_id.toLowerCase();
  for (const s of sessions.values()) if (s.resumeId.toLowerCase() === id || s.id.toLowerCase() === id) return true;
  return externals.some((e) => e.session_id.toLowerCase() === id);
}

/** Does this row belong to the project rooted at `root`? Matches on the resolved
 *  colorKey — how the sidebar itself decides — so every worktree of the repo counts.
 *  The path tests are the fallback for a row whose repo couldn't be resolved: no git
 *  on PATH, or a folder that has since been deleted. */
export function histInProject(h: HistEntry, root: string): boolean {
  return histProject(h).colorKey === root || under(h.cwd, root);
}

/** Free-text match across everything a row shows, plus the path it doesn't. */
export function histMatches(h: HistEntry, term: string): boolean {
  if (!term) return true;
  return `${h.title} ${h.last_prompt} ${h.project} ${h.branch} ${h.cwd}`.toLowerCase().includes(term.toLowerCase());
}

// Coarse day buckets rather than a date per row: history is scanned by "roughly when",
// and an exact timestamp is one row-selection away in the detail pane. `now` is a
// parameter so the boundaries can be tested without freezing the clock.
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
