// The Trail's rules: what a day of work was, derived from Claude's transcripts, the usage
// rollup and git. The retrospective half is read-only by design; nothing here is ever
// written down by hand. ./trailui owns the markup.

import { histLabel, histProject, type HistEntry } from "./history";
import { uDkey, type UDay } from "./usage";

/** One commit as `git_log_days` returns it; `when` is UNIX seconds, like `HistEntry.last_active`. */
export interface TrailCommit {
  sha: string; author: string; when: number; subject: string; root: string;
}

/** A past session with its project already resolved through `histProject`. */
export interface TrailSession {
  id: string; title: string; project: string; colorKey: string;
  branch: string; cwd: string; when: number; exists: boolean;
}

/** One issue or PR event; `at` is ISO-8601 from gh and is bucketed into a day here. */
export interface TrailEvent {
  number: number; kind: string; event: "opened" | "closed" | "merged";
  title: string; url: string; at: string;
}

// One local calendar day. `key` is `uDkey`'s format so the Trail and the Usage tab can
// never disagree about where midnight falls.
export interface TrailDay {
  key: string;
  when: number;          // ms at local midnight — for formatting only
  cost: number;
  tokens: number;
  sessions: TrailSession[];
  commits: TrailCommit[];
  events: TrailEvent[];
}

/** A day's work split by project, so a mixed day stays legible. */
export interface DayProject {
  colorKey: string;
  project: string;
  sessions: TrailSession[];
  commits: TrailCommit[];
  events: TrailEvent[];
}

const ms = (secs: number) => secs * 1000; // both backend timestamps are seconds

export function trailSession(h: HistEntry): TrailSession {
  const p = histProject(h);
  return {
    id: h.session_id,
    title: histLabel(h),
    project: p.project,
    colorKey: p.colorKey,
    branch: p.worktree || h.branch || "",
    cwd: h.cwd,
    when: ms(h.last_active),
    exists: h.exists,
  };
}

/** The local day a ms timestamp falls in; every grouper here uses this one. */
export const dayKeyOf = (msWhen: number) => uDkey(new Date(msWhen));

// The last `days.length` days, newest first, each joined to its sessions, commits and
// cost. A day with nothing in it is dropped rather than rendered empty.
export function trailDays(
  hist: HistEntry[],
  days: UDay[],
  commits: TrailCommit[],
  events: TrailEvent[] = [],
): TrailDay[] {
  const byKey = new Map<string, TrailDay>();
  for (const d of days) {
    const [y, m, dd] = d.key.split("-").map(Number);
    byKey.set(d.key, {
      key: d.key,
      when: new Date(y, m - 1, dd).getTime(),
      cost: d.cost,
      tokens: d.tok,
      sessions: [],
      commits: [],
      events: [],
    });
  }
  for (const h of hist) {
    const day = byKey.get(dayKeyOf(ms(h.last_active)));
    if (day) day.sessions.push(trailSession(h));
  }
  for (const c of commits) {
    const day = byKey.get(dayKeyOf(ms(c.when)));
    if (day) day.commits.push(c);
  }
  for (const ev of events) {
    const t = Date.parse(ev.at);
    if (!Number.isFinite(t)) continue; // malformed: drop rather than bucket to 1970
    const day = byKey.get(dayKeyOf(t));
    if (day) day.events.push(ev);
  }

  const out = [...byKey.values()].filter((d) => d.sessions.length || d.commits.length || d.events.length || d.cost > 0);
  for (const d of out) {
    d.sessions.sort((a, b) => b.when - a.when);
    d.commits.sort((a, b) => b.when - a.when);
    d.events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }
  return out.sort((a, b) => b.when - a.when);
}

// A day split by project, busiest first. Events are keyed by the repo root
// `gh_day_activity` was asked about, which is the same colorKey.
export function dayByProject(d: TrailDay, nameOf: (colorKey: string) => string): DayProject[] {
  const groups = new Map<string, DayProject>();
  const at = (colorKey: string): DayProject => {
    let g = groups.get(colorKey);
    if (!g) {
      g = { colorKey, project: nameOf(colorKey), sessions: [], commits: [], events: [] };
      groups.set(colorKey, g);
    }
    return g;
  };
  for (const s of d.sessions) at(s.colorKey).sessions.push(s);
  for (const c of d.commits) at(c.root).commits.push(c);
  for (const e of (d.events ?? [])) at(eventRoot(e)).events.push(e);
  // Busiest first, ties broken by name so a repaint never reorders an unchanged day.
  return [...groups.values()].sort((a, b) => {
    const wa = a.sessions.length + a.commits.length + a.events.length;
    const wb = b.sessions.length + b.commits.length + b.events.length;
    return wb - wa || a.project.localeCompare(b.project);
  });
}

export type DayItem =
  | { kind: "session"; when: number; session: TrailSession }
  | { kind: "commit"; when: number; commit: TrailCommit };

// A project's day as one time-ordered list, newest first: a session and the commit it
// produced belong together. `TrailCommit.when` is seconds and is converted here, or
// every commit would sort as 1970 and sink below everything.
export function dayItems(g: DayProject): DayItem[] {
  const items: DayItem[] = [
    ...g.sessions.map((session) => ({ kind: "session" as const, when: session.when, session })),
    ...g.commits.map((commit) => ({ kind: "commit" as const, when: ms(commit.when), commit })),
  ];
  // Ties broken by kind then id, so a repaint of unchanged state never reorders.
  return items.sort((a, b) =>
    b.when - a.when ||
    a.kind.localeCompare(b.kind) ||
    (a.kind === "session" ? a.session.id : a.commit.sha).localeCompare(
      b.kind === "session" ? b.session.id : b.commit.sha));
}

const eventRoot = (e: TrailEvent & { root?: string }) => e.root ?? ""; // stamped by ./trailui at fetch time

// The project a day was mostly about, by session count, or null when it was spread.
export function dominantProject(d: TrailDay): string | null {
  const n = new Map<string, number>();
  for (const s of d.sessions) n.set(s.project, (n.get(s.project) || 0) + 1);
  if (!n.size) return null;
  const ranked = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = [...n.values()].reduce((s, v) => s + v, 0);
  // "Mostly X" has to actually mean mostly, or the headline lies on a mixed day.
  return ranked[0][1] / total > 0.6 ? ranked[0][0] : null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// The headline shown before (or instead of) a generated one: always computed, never
// awaited, because the generated summary is asynchronous, optional and can fail.
export function deterministicHeadline(d: TrailDay): string {
  const parts: string[] = [];
  const dom = dominantProject(d);
  const projects = new Set(d.sessions.map((s) => s.project));
  if (d.sessions.length) {
    parts.push(dom
      ? `Mostly ${dom} · ${plural(d.sessions.length, "session")}`
      : `${plural(d.sessions.length, "session")} across ${plural(projects.size, "project")}`);
  }
  if (d.commits.length) parts.push(plural(d.commits.length, "commit"));
  const merged = (d.events ?? []).filter((e) => e.event === "merged").length;
  const closed = (d.events ?? []).filter((e) => e.event === "closed").length;
  const opened = (d.events ?? []).filter((e) => e.event === "opened").length;
  if (merged) parts.push(`${merged} merged`);
  if (closed) parts.push(`${closed} closed`);
  if (opened && !merged && !closed) parts.push(`${opened} opened`);
  if (!parts.length) return d.cost > 0 ? "Agent time, nothing committed." : "Quiet day.";
  return parts.join(" · ") + ".";
}

// What the summariser is handed: titles and subjects only, never transcript bodies, so
// no conversation content reaches a model that did not already have it. Bounded.
export function dayFacts(d: TrailDay, limit = 12): string {
  const lines: string[] = [];
  if (d.cost > 0) lines.push(`spend: $${d.cost.toFixed(2)}`);
  for (const s of d.sessions.slice(0, limit)) {
    lines.push(`session: ${s.title}${s.project ? ` [${s.project}${s.branch ? `/${s.branch}` : ""}]` : ""}`);
  }
  if (d.sessions.length > limit) lines.push(`… and ${d.sessions.length - limit} more sessions`);
  for (const c of d.commits.slice(0, limit)) lines.push(`commit: ${c.subject}`);
  if (d.commits.length > limit) lines.push(`… and ${d.commits.length - limit} more commits`);
  for (const e of (d.events ?? []).slice(0, limit)) {
    lines.push(`${e.event} ${e.kind} #${e.number}: ${e.title}`);
  }
  return lines.join("\n");
}

/** Only today can still change; every earlier day is final and cached forever. */
export const dayIsClosed = (d: TrailDay, now = Date.now()) => d.key !== uDkey(new Date(now));

// ---------- the project's own day, as opposed to yours ----------
// `dayFacts` reads this machine's sessions and spend, which nobody else can reproduce, so
// the committed sentence is built from commits and pull requests only.

/** GitHub's `[bot]` login suffix is the only marker `%an` carries. */
export const isBotAuthor = (name: string) => /\[bot\]$/i.test(name.trim());

/** Human committers that day, busiest first; ties by name so a repaint never reorders. */
export function humanAuthors(d: TrailDay): string[] {
  const n = new Map<string, number>();
  for (const c of d.commits) {
    if (isBotAuthor(c.author)) continue;
    n.set(c.author, (n.get(c.author) || 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([x]) => x);
}

// Whether the project's line is worth showing beside your own: more than one human
// author. It cannot ask "did somebody else commit", since matching `%an` against
// `git config user.name` breaks on a second machine, a respelling or a co-authored commit.
export const sharedDay = (d: TrailDay): boolean => humanAuthors(d).length > 1;

// The project's record for the summariser: commits and pull requests only, since sessions
// and spend differ per machine and this sentence gets committed. Bounded like `dayFacts`.
export function projectDayFacts(d: TrailDay, limit = 16): string {
  const lines: string[] = [];
  const who = humanAuthors(d);
  if (who.length) lines.push(`contributors: ${who.join(", ")}`);
  for (const c of d.commits.slice(0, limit)) lines.push(`commit: ${c.subject}`);
  if (d.commits.length > limit) lines.push(`… and ${d.commits.length - limit} more commits`);
  for (const e of (d.events ?? []).slice(0, limit)) {
    lines.push(`${e.event} ${e.kind} #${e.number}: ${e.title}`);
  }
  return lines.join("\n");
}
