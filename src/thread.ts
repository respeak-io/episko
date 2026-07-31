// The thread model — the point at which the overview surfaces stop being separate
// features and become one thing with several views. No DOM and no Tauri, so it
// unit-tests like ./trail and ./usage; ./threadsui owns the markup.
//
// THE IDEA. Episko already runs a state machine over one kind of object — a session,
// which is `idle → thinking → working → done → error` plus a flag for *needs you*.
// Generalise the **object**, keep the machine. An open issue is a thread that is idle.
// A note you jotted is a thread that is idle. A failed check is a thread in error. A
// live agent is a thread that is working. Then there is one visual grammar for all of
// them, two altitudes that are the same component at different filters, and exactly
// one verb: **dispatch**.
//
// THE RANKING IS NOT NEW. `urgencyRank` in ./grouping already encodes what wants the
// user first, and the sidebar's "attention" sort and the header reactor both read it.
// A second ranking here would be the drift bug that file's own comments warn about, so
// session-backed threads defer to it and only the sources it has never seen — a note,
// a branch behind its remote — get a rank of their own.

import { urgencyRank } from "./grouping";
import type { Note } from "./notes";
import { isAgent, type DiffStat, type Phase, type Sess } from "./types";

/// Where a thread came from. Deliberately open-ended: stage 3 adds `issue` and `pr`
/// and stage 4 adds `card`, and neither should need to touch the band logic.
export type ThreadSource = "session" | "task" | "note" | "branch" | "issue" | "pr";

/// A thread's phase is a session `Phase` plus one state no session can be in:
/// nobody has started it. That is the whole "unclaimed" band.
export type ThreadPhase = Phase | "unclaimed";

export interface Thread {
  /// Unique within a render. Prefixed by source so a note and a session can never
  /// collide, and so a row's identity survives a repaint.
  id: string;
  source: ThreadSource;
  title: string;
  project: string;
  /// The sidebar's grouping id — what "this project" means everywhere else.
  colorKey: string;
  /// Branch, worktree, or wherever this lives. Shown in the "where" column.
  where: string;
  /// One line of human-readable state: what it is doing, or why it wants you.
  state: string;
  phase: ThreadPhase;
  /// When it entered its current state — the tiebreak within a band, so the thing
  /// that has been waiting longest sorts first.
  since: number;
  cost: number | null;
  /// The live pane, when one exists. Present means "this is running right now", and
  /// is what lets a row show a real tool and a real context percentage.
  sess?: Sess;
  note?: Note;
  /// GitHub's number, when this came from there — what a claim writes against.
  number?: number;
  url?: string;
  /// Who already has it. `isMe` separates "I claimed this" from "a colleague did",
  /// which is the difference between a reminder and a collision.
  who?: { login: string; isMe: boolean };
  /// Short label for the row's chip: initials, not an avatar. Git and the API can
  /// tell us who *pushed* or *was assigned*, never who is present — a face would
  /// imply liveness we cannot see.
  whoShort?: string;
}

/// One issue or PR, exactly as `gh_threads` returns it.
export interface GhThread {
  number: number; kind: string; title: string; url: string;
  assignees: string[]; labels: string[];
  branch: string | null; author: string | null; draft: boolean;
  updated_at: string;
}

/// The four bands, most urgent first. These are the phases the app already ships,
/// grouped — not a new taxonomy.
export type Band = "needs" | "running" | "move" | "open";
export const BANDS: Band[] = ["needs", "running", "move", "open"];
export const BAND_META: Record<Band, { label: string; hint: string }> = {
  needs:   { label: "Needs you now", hint: "blocked, or broken" },
  running: { label: "Running",       hint: "agents mid-turn" },
  move:    { label: "Your move",     hint: "turn finished, waiting on you" },
  open:    { label: "Unclaimed",     hint: "nobody is on these yet" },
};

/// Rank for anything with no session behind it. Sits alongside `urgencyRank`'s idle
/// (4) rather than inventing a scale: an unclaimed thread is exactly as urgent as an
/// idle one — which is to say, not.
const UNCLAIMED_RANK = 4;

/** How much this thread wants the user, lower first. Sessions defer to `urgencyRank`. */
export function threadRank(t: Thread): number {
  return t.sess ? urgencyRank(t.sess) : UNCLAIMED_RANK;
}

/// Which glyph/colour bucket a row falls into. `attention` is a *flag* on a session,
/// not a phase, and it outranks whatever phase it is blocking — the same rule
/// `statusKey` applies in ./types, restated here because a thread may have no session
/// behind it at all.
export function threadStatusKey(t: Thread): ThreadPhase | "attention" {
  return t.sess?.attention ? "attention" : t.phase;
}

/** Which band a thread belongs to. The only place rank becomes a group. */
export function threadBand(t: Thread): Band {
  const r = threadRank(t);
  if (r <= 1) return "needs";     // blocking permission, or an error
  if (r === 2) return "move";     // turn finished — your reply
  if (r === 3) return "running";
  return "open";
}

// ---------- adapters ----------

/// A live pane. Shell panes are excluded by the caller, not here — this only knows
/// how to describe one.
export function fromSession(s: Sess): Thread {
  const task = s.kind === "task";
  return {
    id: `session:${s.id}`,
    source: task ? "task" : "session",
    title: task ? (s.run?.label ?? s.title) : (s.title || "untitled session"),
    project: s.project,
    colorKey: s.colorKey,
    where: [s.worktree ? `⎇ ${s.worktree}` : s.branch ? `⎇ ${s.branch}` : "", task ? "task" : ""]
      .filter(Boolean).join(" · "),
    state: sessionState(s),
    phase: s.phase,
    // `phaseSince` rather than `lastActivity`: within a band the question is "how long
    // has it been like this", which is what makes the longest-blocked row sort first.
    since: s.phaseSince,
    cost: isAgent(s) ? s.cost : null,
    sess: s,
  };
}

/// The state line for a live pane — the most specific true thing about it.
function sessionState(s: Sess): string {
  if (s.attention) return `Asks: ${s.attention}`;
  if (s.phase === "error") return s.kind === "task" ? "Run failed" : "Errored";
  if (s.phase === "done") return "Turn finished — your move";
  if (s.phase === "ended") return "Ended";
  if (s.curTool) return `${s.curTool}${s.curArg ? ` ${s.curArg}` : ""}`;
  if (s.phase === "working" || s.phase === "thinking") return "Working…";
  return "Idle";
}

/// A note: a thread with no agent yet. `colorKey` may be empty — an unfiled note is
/// still a thread, it just cannot be dispatched until it has a project.
export function fromNote(n: Note, projectName: (colorKey: string) => string): Thread {
  return {
    id: `note:${n.id}`,
    source: "note",
    title: n.text,
    project: n.project ? projectName(n.project) : "",
    colorKey: n.project ?? "",
    where: "your note",
    state: n.project ? "Jotted, not started" : "Unfiled — pick a project to dispatch",
    phase: "unclaimed",
    since: n.created,
    cost: null,
    note: n,
  };
}

/// A checkout that has fallen behind its remote. Not a task anyone assigned, but it is
/// unstarted work that wants a decision, which is exactly what the unclaimed band is.
export function fromBranchBehind(colorKey: string, project: string, g: DiffStat): Thread {
  return {
    id: `branch:${colorKey}`,
    source: "branch",
    title: `${g.upstream ?? "upstream"} is ${g.behind} commit${g.behind === 1 ? "" : "s"} ahead`,
    project,
    colorKey,
    where: "⎇ " + (g.upstream ?? "origin"),
    // Honest about the risk, because "just pull" is only safe when it is.
    state: g.dirty > 0 || g.untracked > 0 ? "Local changes here — review before pulling" : "Nothing local to lose — safe to pull",
    phase: "unclaimed",
    since: 0,
    cost: null,
  };
}

/// Initials from a GitHub login: the first two letters, uppercased.
///
/// Deliberately the dumbest rule that works — `FAbrahamDev` → FA, `tr-evo` → TR,
/// `octocat` → OC. Splitting on separators looks smarter and is worse: it turns
/// `tr-evo` into "TE", because it assumes the segments are given-name/surname when
/// they are usually nothing of the kind. A chip you can predict beats a chip that is
/// occasionally cleverer.
export function initials(login: string): string {
  return login.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
}

/// An issue or PR. Unclaimed by definition — GitHub knows nothing about whether an
/// *agent* is on it, only whether a human has been assigned, and those are different
/// questions. An assignee becomes `who`, which the row shows and dispatch warns about.
export function fromGh(g: GhThread, colorKey: string, project: string, viewer: string | null): Thread {
  const owner = g.assignees[0] ?? null;
  const isMe = !!owner && !!viewer && owner === viewer;
  const when = Date.parse(g.updated_at);
  const isPr = g.kind === "pr";
  return {
    id: `${g.kind}:${colorKey}:${g.number}`,
    source: isPr ? "pr" : "issue",
    title: g.title,
    project,
    colorKey,
    where: isPr && g.branch ? `⎇ ${g.branch}` : g.labels.slice(0, 2).join(" · ") || `#${g.number}`,
    state: ghState(g, owner, isMe),
    phase: "unclaimed",
    // `updated_at`, because for an unstarted thread the useful age is "how long has
    // this been sitting", and NaN from a malformed date must not poison the sort.
    since: Number.isFinite(when) ? when : 0,
    cost: null,
    number: g.number,
    url: g.url,
    who: owner ? { login: owner, isMe } : undefined,
    whoShort: owner ? initials(owner) : undefined,
  };
}

function ghState(g: GhThread, owner: string | null, isMe: boolean): string {
  if (g.kind === "pr") {
    if (g.draft) return "Draft";
    return owner && !isMe ? `${owner} has this — review requested` : "Open PR — wants a review";
  }
  if (isMe) return "Assigned to you";
  if (owner) return `${owner} is already on it`;
  return "Nobody is on this yet";
}

// ---------- assembly ----------

export interface ThreadInputs {
  sessions: Iterable<Sess>;
  notes: Note[];
  /// Working-set state per project root, as ./state's `dirtyByFolder` holds it.
  dirty: Map<string, DiffStat | null>;
  /// colorKey → display name, so this module needn't know about FAVORITES.
  projectName: (colorKey: string) => string;
  /// Issues and PRs per project root, and who `gh` says you are. Absent simply means
  /// no GitHub layer — the board is complete without it.
  gh?: Map<string, { threads: GhThread[]; viewer: string | null }>;
}

/**
 * Every thread, ranked.
 *
 * Sorted by band, then by how long it has been waiting — oldest first *within* the
 * bands where waiting is the problem, newest first among unclaimed work (a note you
 * just wrote is the one you meant). Sorting is total and stable: two repaints of
 * unchanged state must never reorder rows under the cursor.
 */
export function buildThreads(inp: ThreadInputs): Thread[] {
  const out: Thread[] = [];

  for (const s of inp.sessions) {
    // A plain shell is not work anyone is tracking — it is a terminal the user opened.
    // `urgencyRank` already parks it at 6; excluding it keeps the unclaimed band
    // meaning "unstarted work" rather than "windows you have open".
    if (s.kind === "shell") continue;
    out.push(fromSession(s));
  }

  for (const n of inp.notes) out.push(fromNote(n, inp.projectName));

  for (const [root, g] of inp.dirty) {
    if (!g || g.behind <= 0) continue;
    // A repo with a live session in it is already represented by that session's row;
    // a second row for the same folder would double-count the same piece of work.
    if (out.some((t) => t.sess && t.colorKey === root)) continue;
    out.push(fromBranchBehind(root, inp.projectName(root), g));
  }

  for (const [root, g] of inp.gh ?? []) {
    for (const t of g.threads) {
      // A PR whose head branch is checked out in a live session is that session's
      // work — showing both would be two rows for one piece of work, and the pane
      // is the more truthful of the two.
      if (t.kind === "pr" && t.branch &&
          out.some((x) => x.sess && x.colorKey === root && (x.sess.branch === t.branch || x.sess.worktree === t.branch))) {
        continue;
      }
      out.push(fromGh(t, root, inp.projectName(root), g.viewer));
    }
  }

  return sortThreads(out);
}

export function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => {
    const ra = threadRank(a), rb = threadRank(b);
    if (ra !== rb) return ra - rb;
    const open = threadBand(a) === "open";
    // Unclaimed: newest first — the note you just wrote is the one you meant. Everything
    // else: oldest first, because there the wait *is* the problem.
    if (a.since !== b.since) return open ? b.since - a.since : a.since - b.since;
    // Total order, so an unchanged fleet always renders in the same sequence.
    return a.id.localeCompare(b.id);
  });
}

// ---------- grouping ----------
// Two ways to read the same list, because they answer different questions. Urgency
// asks "what should I do next"; recency asks "what has been going on". Which one is
// useful depends on whether you are working or catching up, so it is a preference
// rather than a decision made for the user.
export type GroupMode = "urgency" | "recency";

export interface RecencyBucket { id: string; label: string; maxAgeMs: number }
/// Deliberately coarse and human: "today", "this week" — not a date per row. The exact
/// timestamp is one hover away, and a column of dates is not something anyone scans.
export const RECENCY: RecencyBucket[] = [
  { id: "today", label: "Today", maxAgeMs: 24 * 3600e3 },
  { id: "3d", label: "Last 3 days", maxAgeMs: 3 * 24 * 3600e3 },
  { id: "week", label: "Last week", maxAgeMs: 7 * 24 * 3600e3 },
  { id: "older", label: "Earlier", maxAgeMs: Infinity },
];

export function recencyOf(t: Thread, now = Date.now()): RecencyBucket {
  // No known age sorts with the oldest rather than pretending to be new — a row with
  // no timestamp is exactly the one you have not looked at.
  const age = t.since > 0 ? now - t.since : Infinity;
  return RECENCY.find((b) => age <= b.maxAgeMs) ?? RECENCY[RECENCY.length - 1];
}

/** One group of rows, however they were grouped. */
export interface ThreadGroup { id: string; label: string; hint: string; threads: Thread[] }

/// Group by recency, newest bucket first, empties dropped.
export function recencyGroups(threads: Thread[], now = Date.now()): ThreadGroup[] {
  return RECENCY
    .map((b) => ({
      id: b.id,
      label: b.label,
      hint: "",
      threads: threads.filter((t) => recencyOf(t, now).id === b.id)
        .sort((a, b2) => (b2.since || 0) - (a.since || 0)),
    }))
    .filter((g) => g.threads.length > 0);
}

/// Group by urgency band — the default, and what `urgencyRank` already encodes.
export function urgencyGroups(threads: Thread[]): ThreadGroup[] {
  return bandsOf(threads).map((g) => ({
    id: g.band, label: BAND_META[g.band].label, hint: BAND_META[g.band].hint, threads: g.threads,
  }));
}

export function groupThreads(threads: Thread[], mode: GroupMode, now = Date.now()): ThreadGroup[] {
  return mode === "recency" ? recencyGroups(threads, now) : urgencyGroups(threads);
}

/** Group into bands, dropping empty ones. */
export function bandsOf(threads: Thread[]): { band: Band; threads: Thread[] }[] {
  return BANDS
    .map((band) => ({ band, threads: threads.filter((t) => threadBand(t) === band) }))
    .filter((g) => g.threads.length > 0);
}

/// The altitude filter: meta shows everything, a project shows its own threads. The
/// *same* list, one predicate — which is what makes the two altitudes one component
/// rather than two screens that drift.
export function inProject(t: Thread, colorKey: string | null): boolean {
  return !colorKey || t.colorKey === colorKey;
}

/// Can an agent be started on this? A live session is already running; an unfiled note
/// has nowhere to run. Everything else is dispatchable.
export function dispatchable(t: Thread): boolean {
  if (t.sess) return false;
  return !!t.colorKey;
}
