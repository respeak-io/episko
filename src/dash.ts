// The project dashboard's rules (docs/dashboard.md); ./dashview owns the markup, ./dashboard the pane.

import type { HistEntry } from "./history";
import { histProject } from "./history";
import { dayKeyOf, trailDays, type TrailCommit, type TrailDay } from "./trail";
import type { DiffStat, WtHead } from "./types";
import type { UDay } from "./usage";

// ---------- what a folder can show ----------

export interface ProjectFacts { // what `project_facts` answers; mirrors the Rust struct
  is_repo: boolean;
  root: string | null;
  origin: string | null;
  host: string | null;
  slug: string | null;
}

// Three tiers: `github` adds the gh cards; `git` the commit timeline, checkouts and everything
// shared (`.episko/` needs git, not GitHub); `none` still has sessions, spend, tasks and notes.
export type ProjectTier = "github" | "git" | "none";

export function projectTier(f: ProjectFacts | null | undefined): ProjectTier {
  if (!f?.is_repo) return "none";
  return f.slug ? "github" : "git"; // a slug is minted only for github.com (see `parse_remote`)
}

export const canShare = (t: ProjectTier): boolean => t !== "none";

// ---------- one project's days ----------

// Filter to the project BEFORE `trailDays` assembles days, or a day with work in three
// projects survives carrying the other two's counts. `costFor` is injected to stay pure.
export function dashDays(
  root: string,
  hist: HistEntry[],
  commits: TrailCommit[],
  window: UDay[],
  costFor: (dayKey: string) => number,
): TrailDay[] {
  const mine = hist.filter((h) => histProject(h).colorKey === root); // the sidebar's own grouping rule
  const myCommits = commits.filter((c) => c.root === root);
  const scoped = window.map((d) => ({ ...d, cost: costFor(d.key), tok: 0 }));
  return trailDays(mine, scoped, myCommits, []);
}

// 0 when the day has no detail record, never the fleet total: a borrowed `cc-usage` figure is
// a lie that looks like data. Keyed by project name, as `addUsage` records it.
export function projectCost(
  detail: Record<string, { projects?: Record<string, number> } | undefined>,
  dayKey: string,
  projectName: string,
): number {
  const v = detail[dayKey]?.projects?.[projectName];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

// ---------- the pulse strip ----------

export interface Pulse {
  commits: number;
  sessions: number;
  spend: number;
  authors: string[]; // busiest first
  perDay: number[];  // oldest first, for the sparkline; `days` is newest-first
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
    // Ties by name, so a repaint of unchanged state never reorders the list.
    authors: [...byAuthor.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n),
    perDay: [...days].reverse().map((d) => d.commits.length),
  };
}

// `trailDays` drops empty days (right for a list); a sparkline must keep them or it reads as always busy.
export function densePerDay(days: TrailDay[], span: number, now: number): number[] {
  const byKey = new Map(days.map((d) => [d.key, d.commits.length]));
  const out: number[] = [];
  const day = 86_400_000;
  for (let i = span - 1; i >= 0; i--) out.push(byKey.get(dayKeyOf(now - i * day)) ?? 0);
  return out;
}

// ---------- pulling, pushing, switching ----------

// The repo's main worktree, never the highlighted folder. `worktree_heads` reads the path
// git itself accepts; falling back to `root` keeps the button live when the probe never answered.
export function mainCheckout(heads: WtHead[], root: string): string {
  return heads.find((h) => h.is_main && h.exists)?.path || root;
}

export type SyncOp = "pull" | "push";

// As of the last fetch, maybe very old: `level` is "nothing has looked", not "up to date", so no
// state greys a button out (`git_action` refuses instead). Pull and Push read `ahead` oppositely.
export type SyncState = "unknown" | "no-upstream" | "diverged" | "behind" | "ahead" | "level";

export function syncState(g: DiffStat | null | undefined): SyncState {
  if (!g) return "unknown";
  if (!g.upstream) return "no-upstream";
  if (g.ahead > 0 && g.behind > 0) return "diverged";
  if (g.behind > 0) return "behind";
  return g.ahead > 0 ? "ahead" : "level";
}

export const DASH_RANGES = [7, 14, 30] as const;
export const DASH_RANGE_DEFAULT = 7;
export function clampRange(n: number): number {
  return (DASH_RANGES as readonly number[]).includes(n) ? n : DASH_RANGE_DEFAULT;
}
