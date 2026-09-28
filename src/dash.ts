// The project dashboard's rules (docs/dashboard.md); ./dashview owns the markup, ./dashboard the pane.

import { nfcKeys, nfcPath, uUsd2 } from "./format";
import type { HistEntry } from "./history";
import { histProject } from "./history";
import { readObj } from "./store";
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
// `keys`: the project's id and its name, since a day recorded before ids is keyed by name.
export function projectCost(
  detail: Record<string, { projects?: Record<string, number> } | undefined>,
  dayKey: string,
  keys: string | (string | undefined)[],
): number {
  let sum = 0;
  for (const k of new Set(typeof keys === "string" ? [keys] : keys)) {
    const v = k ? detail[dayKey]?.projects?.[k] : undefined;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) sum += v;
  }
  return sum;
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

/** One bar of the band's ribbon. `when` is that day's local midnight, as `TrailDay.when` is;
 *  `key` is `trailDays`' own key, so a clicked bar joins back by string and not by arithmetic. */
export interface RibbonDay { n: number; when: number; key: string }

// `trailDays` drops empty days (right for a list); the ribbon must keep them or it reads as
// always busy. Each bar carries its own day, so the strip can say which day it is showing.
export function densePerDay(days: TrailDay[], span: number, now: number): RibbonDay[] {
  const byKey = new Map(days.map((d) => [d.key, d.commits.length]));
  const out: RibbonDay[] = [];
  const day = 86_400_000;
  for (let i = span - 1; i >= 0; i--) {
    const at = now - i * day, key = dayKeyOf(at);
    out.push({ n: byKey.get(key) ?? 0, when: new Date(at).setHours(0, 0, 0, 0), key });
  }
  return out;
}

// ---------- one day of the ribbon ----------

export const DAY_ROWS = 8;   // commits listed before the tail is counted instead of printed

export interface DayRow { id: string; label: string; sub?: string; mark?: string; disabled?: boolean }
export interface DayGroup { label?: string; items: DayRow[] }
/** Structurally ./menu's spec minus the title and the pick, so ./dashboard hands it straight on. */
export interface DayCard { tally: string; groups: DayGroup[] }

// What a clicked bar says. The bar counts commits, so the card leads with them and the rest is
// context; a session has nowhere to go from here yet, so its row is shown and not pickable.
// Every figure is `dashDays`' own answer read again — a click on a chart must not reach disk.
export function dayCard(d: TrailDay | undefined): DayCard {
  const cs = d?.commits ?? [], ss = d?.sessions ?? [], cost = d?.cost ?? 0;
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const shown = cs.slice(0, DAY_ROWS);
  const rest = cs.length - shown.length;
  return {
    tally: [plural(cs.length, "commit"), ...(ss.length ? [plural(ss.length, "session")] : []),
      ...(cost > 0 ? [uUsd2(cost)] : [])].join(" · "),
    groups: [
      { label: "Commits", items: [
        // The id carries every character `git_log_days` kept (9); the row shows 7, which is
        // all the rail has room for and not enough to hand to `git show`.
        ...shown.map((c) => ({ id: `sha:${c.sha}`, mark: "●",
          label: c.subject || c.sha.slice(0, 7), sub: `${c.sha.slice(0, 7)} · ${c.author}` })),
        ...(rest > 0 ? [{ id: "more", label: `+${rest} more`, disabled: true }] : []),
      ] },
      { label: "Sessions", items: ss.map((x) => ({
        id: `sess:${x.id}`, mark: "◷", label: x.title, sub: x.branch || x.project, disabled: true })) },
      { items: [{ id: "graph", mark: "⤢", label: "Open the commit graph" }] },
    ],
  };
}

// ---------- when you were last here ----------

export const DASH_SEEN_KEY = "cc-dash-seen";
export const SEEN_MAX = 200;

// Every stamp is narrowed on its own: a hand-edited or truncated key must cost only itself.
// The NFC repair is not optional — a project path is compared by exact string.
export function readSeen(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(nfcKeys(readObj<number>(DASH_SEEN_KEY)))) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

// 0 for a project never opened, which the band reads as "first look", never as "since 1970".
export const seenAt = (seen: Record<string, number>, root: string): number => seen[nfcPath(root)] ?? 0;

// Pure, and capped: the key must not grow with every folder ever opened, so the oldest go first.
export function stampSeen(seen: Record<string, number>, root: string, at: number): Record<string, number> {
  const next = { ...seen, [nfcPath(root)]: at };
  const keys = Object.keys(next);
  if (keys.length <= SEEN_MAX) return next;
  return Object.fromEntries(keys.sort((a, b) => next[b] - next[a]).slice(0, SEEN_MAX).map((k) => [k, next[k]]));
}

// The one write, kept out of `stampSeen` so the rule stays testable without the store.
export function saveSeen(seen: Record<string, number>): void {
  localStorage.setItem(DASH_SEEN_KEY, JSON.stringify(seen));
}

export const SINCE_LINES = 3;

export interface SinceFacts {
  first: boolean;    // no stamp at all, so the figures are the window's rather than yours
  since: number;
  capped: boolean;   // `since` predates the window: "in the last N days", never "since your last visit"
  days: number;
  keys: string[];    // in-range day keys, newest first; the caller picks which already-paid-for sentences to print
  commits: number;
  sessions: number;
  spend: number;
  authors: string[]; // humans only, busiest first
  quiet: boolean;    // nothing moved in the gap, whatever the figures below are counted over
  window: boolean;   // those figures are the last N days, NOT your gap — the wording must say so
}

// The window is cut at the instant you left: a commit and a session each carry their own
// timestamp. The whole-day rule this replaced re-counted the day you were in, so "Mark read"
// on a busy afternoon moved no figure at all. Spend has no such resolution (`cc-usage` is one
// figure a day), so a day's cost counts only once the whole day is in — under-reporting the
// day you left rather than charging the gap with it. `isBot` keeps ./trail out of here.
export function sinceFacts(
  days: TrailDay[],
  since: number,
  now: number,
  isBot: (author: string) => boolean,
): SinceFacts {
  const first = since <= 0;
  const oldest = days.length ? Math.min(...days.map((d) => d.when)) : 0;
  const byAuthor = new Map<string, number>();
  const keys: string[] = [];
  let commits = 0, sessions = 0, spend = 0;
  for (const d of days) {
    const cs = d.commits.filter((c) => c.when * 1000 > since); // `TrailCommit.when` is seconds
    const ss = d.sessions.filter((x) => x.when > since);
    const cost = d.when >= since ? d.cost : 0;
    if (!cs.length && !ss.length && cost <= 0) continue;
    keys.push(d.key);
    commits += cs.length;
    sessions += ss.length;
    spend += cost;
    for (const c of cs) if (!isBot(c.author)) byAuthor.set(c.author, (byAuthor.get(c.author) || 0) + 1);
  }
  return {
    first,
    since,
    capped: !first && days.length > 0 && since < oldest,
    days: first ? 0 : Math.max(0, Math.floor((now - since) / 86_400_000)),
    keys,
    commits,
    sessions,
    spend,
    authors: [...byAuthor.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n),
    quiet: commits === 0 && sessions === 0 && spend <= 0,
    // `first` and `capped` already measure from before anything we hold, so their figures
    // ARE the window's; the caught-up fallback below is the third way to get there.
    window: first || (!first && days.length > 0 && since < oldest),
  };
}

// The band never shows nothing. With an empty gap it falls back to the whole window rather
// than emptying: the ribbon and the last few days' sentences are worth the space whether or
// not anything moved while you were away, and a card that blanks itself reads as breakage.
// `since` and `quiet` are carried over from the gap, because they are what the wording says.
export function bandFacts(
  days: TrailDay[],
  since: number,
  now: number,
  isBot: (author: string) => boolean,
): SinceFacts {
  const gap = sinceFacts(days, since, now, isBot);
  if (!gap.quiet || gap.window) return gap;
  return { ...sinceFacts(days, 0, now, isBot), first: false, since, days: gap.days, quiet: true, window: true };
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
export const DASH_RANGE_DEFAULT = 30;
export function clampRange(n: number): number {
  return (DASH_RANGES as readonly number[]).includes(n) ? n : DASH_RANGE_DEFAULT;
}
