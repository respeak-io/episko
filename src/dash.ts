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

/// How many days back the dashboard looks. A preference, because "how far back is
/// useful" is genuinely per-person, and the same list the Trail offered.
export const DASH_RANGES = [7, 14, 30] as const;
export const DASH_RANGE_DEFAULT = 7;
export function clampRange(n: number): number {
  return (DASH_RANGES as readonly number[]).includes(n) ? n : DASH_RANGE_DEFAULT;
}
