// The project dashboard's rules — what one project's recent history *was*, and which
// of the dashboard's cards a given folder can even have.
//
// No DOM and no Tauri, so it unit-tests in isolation like ./trail and ./usage;
// ./dashview owns the markup and ./dashboard owns the pane, the IPC and the events —
// the same three-way split as ./palette + ./palui and ./graph + ./graphview.
//
// WHY THIS EXISTS SEPARATELY FROM ./trail. `trail.ts` assembles days across the whole
// fleet and is already tested; this scopes that to one project and adds the two
// questions a per-project view has to answer that a fleet-wide one never did: what can
// this folder actually show, and what did *this* project cost.

import type { HistEntry } from "./history";
import { histProject } from "./history";
import { dayKeyOf, trailDays, type TrailCommit, type TrailDay } from "./trail";
import type { DiffStat, WtHead } from "./types";
import type { UDay } from "./usage";

// ---------- what a folder can show ----------

/// What `project_facts` answers. Mirrors the Rust struct field-for-field.
export interface ProjectFacts {
  is_repo: boolean;
  root: string | null;
  origin: string | null;
  host: string | null;
  slug: string | null;
}

/**
 * Which cards this folder can have.
 *
 * **Three tiers, and they are not the same gate** — conflating them is the bug this
 * type exists to prevent:
 *   • `github` — issues, pull requests and claims, all of which are `gh`.
 *   • `git`    — the commit half of the timeline, the checkouts card, and *everything
 *                shared*: `.episko/` is only meaningful if it can be committed, so
 *                **sharing needs git, not GitHub**.
 *   • `none`   — sessions, spend, tasks and personal notes still work. None of those
 *                ever cared about git, and a plain folder is a real way to work.
 *
 * A card with nothing to say is absent, never empty: an "Issues" panel in a folder
 * that has no issues reads as breakage rather than as an honest blank.
 */
export type ProjectTier = "github" | "git" | "none";

export function projectTier(f: ProjectFacts | null | undefined): ProjectTier {
  if (!f?.is_repo) return "none";
  // A slug is minted only for github.com — an `~/.ssh/config` alias that resolves to
  // it included (see `parse_remote`) — so this cannot be fooled by a GitLab or
  // self-hosted remote, nor fooled *out* of GitHub by a two-account ssh setup.
  return f.slug ? "github" : "git";
}

/** Whether this project can carry a committed `.episko/` — digests, and later notes. */
export const canShare = (t: ProjectTier): boolean => t !== "none";

// ---------- one project's days ----------

/**
 * The last `window.length` days of THIS project, newest first.
 *
 * Everything is filtered to the project *before* `trailDays` assembles it, rather than
 * assembled and then filtered: a day that had work in three projects would otherwise
 * survive into this list carrying the other two's counts, and the pulse strip above it
 * would then be describing somebody else's afternoon.
 *
 * `costFor` is injected rather than read here so this module stays pure over its
 * arguments — ./dashboard supplies it from the `cc-usage-detail` rollup.
 */
export function dashDays(
  root: string,
  hist: HistEntry[],
  commits: TrailCommit[],
  window: UDay[],
  costFor: (dayKey: string) => number,
): TrailDay[] {
  // `histProject` is the sidebar's own grouping rule — the same one that decides a
  // worktree belongs to its repo. Re-deriving it here would let History and the
  // dashboard disagree about which project a session was in.
  const mine = hist.filter((h) => histProject(h).colorKey === root);
  const myCommits = commits.filter((c) => c.root === root);
  // Cost is re-stated per project (see below), so the fleet-wide figure on each UDay
  // must not survive into the result.
  const scoped = window.map((d) => ({ ...d, cost: costFor(d.key), tok: 0 }));
  return trailDays(mine, scoped, myCommits, []);
}

/**
 * One project's spend on one day, from the `cc-usage-detail` rollup.
 *
 * **Returns 0 when the day has no detail record, never the fleet total.** The plain
 * `cc-usage` rollup is a per-day figure across every project at once, so attributing it
 * to whichever dashboard happens to be open would invent a number. The detail split has
 * only been recorded going forward, so older days legitimately have none — and a blank
 * is the honest rendering of "we didn't keep this", where a borrowed total is a lie
 * that looks like data.
 *
 * Keyed by project *name* because that is what `addUsage` records; two unrelated repos
 * with the same folder name would share a bucket, which is the known limit of the
 * split rather than something this can fix.
 */
export function projectCost(
  detail: Record<string, { projects?: Record<string, number> } | undefined>,
  dayKey: string,
  projectName: string,
): number {
  const v = detail[dayKey]?.projects?.[projectName];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

// ---------- the pulse strip ----------

/// The five numbers above the timeline. Summary before detail: the window has to
/// answer itself before anyone reads a single row.
export interface Pulse {
  commits: number;
  sessions: number;
  spend: number;
  /// Everyone who committed in the window, busiest first — "did anyone else touch
  /// this?" is the question a shared project asks first.
  authors: string[];
  /// Commits per day, OLDEST first, for the sparkline. Oldest-first because a chart
  /// reads left-to-right in time while `days` is newest-first for the list.
  perDay: number[];
}

export function dashPulse(days: TrailDay[]): Pulse {
  const byAuthor = new Map<string, number>();
  let commits = 0, sessions = 0, spend = 0;
  for (const d of days) {
    commits += d.commits.length;
    sessions += d.sessions.length;
    spend += d.cost;
    for (const c of d.commits) byAuthor.set(c.author, (byAuthor.get(c.author) || 0) + 1);
  }
  return {
    commits,
    sessions,
    spend,
    // Ties broken by name so a repaint of unchanged state never reorders the list.
    authors: [...byAuthor.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n),
    perDay: [...days].reverse().map((d) => d.commits.length),
  };
}

/**
 * The window as a dense oldest-first series, including days nothing happened on.
 *
 * `trailDays` drops empty days on purpose — a column of blank rows reads as a broken
 * view rather than as a quiet weekend — but a sparkline must NOT drop them, or a
 * fortnight with two busy days renders as two adjacent bars and reads as "constantly
 * busy". The list and the chart want opposite things from the same data.
 */
export function densePerDay(days: TrailDay[], span: number, now: number): number[] {
  const byKey = new Map(days.map((d) => [d.key, d.commits.length]));
  const out: number[] = [];
  const day = 86_400_000;
  for (let i = span - 1; i >= 0; i--) out.push(byKey.get(dayKeyOf(now - i * day)) ?? 0);
  return out;
}

// ---------- pulling, pushing, switching ----------

/**
 * Which checkout the dashboard's git verbs act on: **the repo's main worktree**, never
 * whichever folder happens to be highlighted. ⇣ Pull, ⇡ Push and ⇄ Switch branch all
 * read it, and all three mean the same folder by it.
 *
 * A dashboard is keyed by the repo root (`repoRoot ?? path`), so in the ordinary case
 * this is the root itself and the lookup changes nothing. It exists for the case where
 * it doesn't: `worktree_heads` reads each checkout's path out of git's own `gitdir`
 * file, which is the only spelling guaranteed to be the one git will accept, and a repo
 * whose main worktree has been moved or renamed under git's nose reports a path the
 * root no longer matches. Falling back to `root` keeps the button live for a folder the
 * heads probe never answered for (it runs after, and can fail) — `git_action` then
 * refuses on its own terms rather than the button being mysteriously absent.
 *
 * A vanished checkout is skipped for the obvious reason: git cannot pull into a folder
 * that is not there, and the root is at least a place to try.
 */
export function mainCheckout(heads: WtHead[], root: string): string {
  return heads.find((h) => h.is_main && h.exists)?.path || root;
}

/// Which of the two remote verbs is meant. The switch is not one of them: it changes
/// what HEAD points at rather than trading commits with a remote, and it is the ⑃
/// dialog's card that runs it.
export type SyncOp = "pull" | "push";

/**
 * Where the main checkout stands against its upstream, **as of the last fetch** — which
 * on a dashboard may be very old indeed, and that is the whole reason this is a state
 * rather than a boolean. One reading, read by both ⇣ Pull and ⇡ Push.
 *
 * Nothing on a dashboard runs git on a schedule (that is the pane's one invariant), so
 * `behind: 0` here does not mean "up to date", it means "nothing has looked recently".
 * So `level` is **not** a reason to grey a button out, unlike the session inspector's
 * pull, which sits beside a fetch button and a working set that the dirty poll keeps
 * fresh. The dashboard's verbs fetch first for the same reason.
 *
 * `no-upstream` and `diverged` are likewise states to *say*, not to disable on: those
 * are exactly the cases `git_action` refuses with the command that would work, and the
 * refusal hands over a prefilled terminal. Disabling them would amputate the useful half.
 *
 * **`ahead` is its own state rather than a flavour of `level`**, because the two verbs
 * read this one number in opposite directions: unpushed commits with nothing incoming
 * are the quiet case for ⇣ Pull and the entire point of ⇡ Push, and a single word
 * covering both would have to be wrong for one of them. It stayed folded into `level`
 * for exactly as long as pulling was the only thing this pane could do.
 */
export type SyncState = "unknown" | "no-upstream" | "diverged" | "behind" | "ahead" | "level";

export function syncState(g: DiffStat | null | undefined): SyncState {
  if (!g) return "unknown";
  if (!g.upstream) return "no-upstream";
  if (g.ahead > 0 && g.behind > 0) return "diverged";
  if (g.behind > 0) return "behind";
  return g.ahead > 0 ? "ahead" : "level";
}

/// How many days back the dashboard looks. A preference, because "how far back is
/// useful" is genuinely per-person, and the same list the Trail offered.
export const DASH_RANGES = [7, 14, 30] as const;
export const DASH_RANGE_DEFAULT = 7;
export function clampRange(n: number): number {
  return (DASH_RANGES as readonly number[]).includes(n) ? n : DASH_RANGE_DEFAULT;
}
