// The Trail's rules — what a day of work *was*. No DOM and no Tauri, so it unit-tests
// in isolation like ./usage and ./rl; ./trailui owns the markup, the same split as
// ./history + ./historyui and ./palette + ./palui.
//
// WHY THIS EXISTS. "What have I been working on" is a question Episko can already
// answer from evidence it keeps anyway — Claude's transcripts, the usage rollup and
// git — so nobody should ever have to write it down. That is the whole design
// constraint: **the retrospective half is derived and read-only**. If you never open
// it, it is still correct. A board dies the moment someone stops updating it; a log
// that writes itself cannot.
//
// Everything here is arithmetic over three inputs that already exist:
//   • `list_session_history` → HistEntry[] (./history), which carries Claude's own
//     `ai-title` per session — the labels that make a day readable;
//   • `usageWindow` → UDay[] (./usage), the per-day cost/token join, already tested;
//   • `git_log_days` → TrailCommit[], the one genuinely new backend call.
//
// The only part that is *not* derived is the day summary sentence, and that is
// deliberately generated elsewhere (./trailui asks the backend) — see `dayFacts`.

import { histLabel, histProject, type HistEntry } from "./history";
import { uDkey, type UDay } from "./usage";

/// One commit, as `git_log_days` returns it. `when` is UNIX **seconds**, matching
/// `HistEntry.mtime` — the backend speaks seconds for both, and every consumer here
/// converts once, at the boundary, rather than each caller remembering to.
export interface TrailCommit {
  sha: string; author: string; when: number; subject: string; root: string;
}

/// A past session, reduced to what a day row shows. Distinct from HistEntry because
/// the project attribution has already been resolved through `histProject` — the
/// sidebar's own grouping rule — so the view never re-derives it per render.
export interface TrailSession {
  id: string; title: string; project: string; colorKey: string;
  branch: string; cwd: string; when: number; exists: boolean;
}

/// One calendar day, local. `key` is deliberately `uDkey`'s format so a day here and
/// a day in the Usage tab are the *same* key — if these two ever disagreed about
/// where a midnight falls, the Trail's costs would silently stop matching the
/// analytics the user already trusts.
/// One issue or PR that opened, closed or merged. `at` is ISO-8601 from gh; the day
/// bucketing happens here so the Trail and the Usage tab can never disagree about
/// where midnight falls.
export interface TrailEvent {
  number: number; kind: string; event: "opened" | "closed" | "merged";
  title: string; url: string; at: string;
}

export interface TrailDay {
  key: string;
  when: number;          // ms at local midnight — for formatting only
  cost: number;
  tokens: number;
  sessions: TrailSession[];
  commits: TrailCommit[];
  events: TrailEvent[];
}

/// A day's work, split by the project it belonged to.
///
/// A day is almost never about one thing, and a flat list of everything that happened
/// reads as noise the moment two projects are in play — you cannot tell which commits
/// belong to which sessions. Grouping is the smallest change that makes a mixed day
/// legible.
export interface DayProject {
  colorKey: string;
  project: string;
  sessions: TrailSession[];
  commits: TrailCommit[];
  events: TrailEvent[];
}

/// Seconds → ms, once, at the boundary. Both backend timestamps are seconds.
const ms = (secs: number) => secs * 1000;

/** A history row reduced to a trail row, with project attribution already resolved. */
export function trailSession(h: HistEntry): TrailSession {
  const p = histProject(h);
  return {
    id: h.session_id,
    title: histLabel(h),
    project: p.project,
    colorKey: p.colorKey,
    branch: p.worktree || h.branch || "",
    cwd: h.cwd,
    when: ms(h.mtime),
    exists: h.exists,
  };
}

/// The local calendar day a timestamp falls in. Shared by both groupers so a session
/// and a commit an hour apart can never land on different days.
export const dayKeyOf = (msWhen: number) => uDkey(new Date(msWhen));

/**
 * The Trail proper: the last `days.length` calendar days, **newest first**, each
 * joined to its sessions, commits and cost.
 *
 * Days with nothing in them are dropped rather than rendered empty. A window is a
 * request for "the last 30 days", not a promise that all 30 had work in them, and a
 * column of blank rows reads as a broken view rather than as a quiet weekend.
 */
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
  // Sessions and commits outside the window are simply not in `byKey` — no day is
  // invented for them, which is what keeps the window honest.
  for (const h of hist) {
    const day = byKey.get(dayKeyOf(ms(h.mtime)));
    if (day) day.sessions.push(trailSession(h));
  }
  for (const c of commits) {
    const day = byKey.get(dayKeyOf(ms(c.when)));
    if (day) day.commits.push(c);
  }
  for (const ev of events) {
    const t = Date.parse(ev.at);
    // A malformed timestamp is dropped rather than bucketed to 1970, where it would
    // silently vanish from every window anyway.
    if (!Number.isFinite(t)) continue;
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

/**
 * A day split by project, most active first.
 *
 * Commits carry the root they came from and sessions carry a colorKey, so both already
 * know their project — this only has to agree on one key per group. Events are keyed by
 * the repo root `gh_day_activity` was asked about, which is that same colorKey.
 *
 * A project with only an event (a PR merged on a day you touched nothing else) still
 * gets a group: that IS what happened that day.
 */
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

/// One line in a project's day, whatever kind of thing it is.
export type DayItem =
  | { kind: "session"; when: number; session: TrailSession }
  | { kind: "commit"; when: number; commit: TrailCommit };

/**
 * A project's day as ONE time-ordered list, newest first.
 *
 * Not sessions-then-commits. A session at 09:00 and the commit it produced at 09:05
 * are a cause and its effect; listing all the causes and then all the effects breaks
 * the only ordering that explains the day. The kind stays visible on each row, so
 * nothing is lost by mixing them.
 *
 * The two sources speak different units — `TrailSession.when` is already ms, while
 * `TrailCommit.when` is UNIX **seconds**, straight from git. Converting here is the
 * whole reason this is one function rather than a spread at the call site: sorted
 * together unconverted, every commit sorts as 1970 and sinks below everything.
 */
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

/// Events are tagged with their repo root when fetched; ./trailui stamps it on so this
/// module needn't know how the fetch was keyed.
const eventRoot = (e: TrailEvent & { root?: string }) => e.root ?? "";

/// Which project a day was mostly about, by session count then commit count, or null
/// when the day was genuinely spread across several. Ties break alphabetically so a
/// re-render can never reorder a day that hasn't changed.
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

/**
 * The headline shown before (or instead of) a generated one.
 *
 * Always computed, never awaited: a generated summary is asynchronous, can be turned
 * off, and can fail, so every day must already read correctly without one. When the
 * model's sentence arrives it replaces this; until then this is what's on screen.
 */
export function deterministicHeadline(d: TrailDay): string {
  const parts: string[] = [];
  const dom = dominantProject(d);
  const projects = new Set(d.sessions.map((s) => s.project));
  if (d.sessions.length) {
    parts.push(dom
      ? `Mostly ${dom} — ${plural(d.sessions.length, "session")}`
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

/**
 * The compact, factual description handed to the summariser.
 *
 * Deliberately just the day's own evidence — titles and subjects, no transcript
 * bodies. The summary is a one-line label over work the user already did, so it needs
 * no conversation content, and keeping it out means the Trail never ships prose from
 * inside a session to a model that didn't already have it.
 *
 * Bounded, because a heavy day would otherwise grow the prompt without bound.
 */
export function dayFacts(d: TrailDay, limit = 12): string {
  const lines: string[] = [];
  if (d.cost > 0) lines.push(`spend: $${d.cost.toFixed(2)}`);
  for (const s of d.sessions.slice(0, limit)) {
    lines.push(`session: ${s.title}${s.project ? ` [${s.project}${s.branch ? `/${s.branch}` : ""}]` : ""}`);
  }
  if (d.sessions.length > limit) lines.push(`… and ${d.sessions.length - limit} more sessions`);
  for (const c of d.commits.slice(0, limit)) lines.push(`commit: ${c.subject}`);
  if (d.commits.length > limit) lines.push(`… and ${d.commits.length - limit} more commits`);
  // What landed, not just what ran — a day is remembered by what it finished.
  for (const e of (d.events ?? []).slice(0, limit)) {
    lines.push(`${e.event} ${e.kind} #${e.number}: ${e.title}`);
  }
  return lines.join("\n");
}

/// A day is only worth summarising once it can't change again. Today is still being
/// written, so it re-summarises; every earlier day is final and is cached forever.
export const dayIsClosed = (d: TrailDay, now = Date.now()) => d.key !== uDkey(new Date(now));
