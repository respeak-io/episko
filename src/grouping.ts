// What the sidebar shows, and in what order. Every pane Episko knows about — owned
// sessions, external ones, dormant roster rows — is folded here into a list of
// project groups, split by worktree if that's the mode, and sorted by the mode the
// user picked. `nextAfterClose` is the same ordering read backwards: when the pane
// on stage goes away, this decides which one takes over.
//
// Pure over ./state: it reads the session map and the sidebar preferences and
// returns fresh arrays, touching no DOM and calling no renderer. The render layer in
// main.ts consumes ProjGroup/WtCluster; it does not build them. (The one exception to
// "pure over ./state" is `needsYou`, which also reads a task preference out of
// ./tasks — that module owns the switch and nothing here should copy it.)
//
// See test/grouping.test.ts.

import { basename } from "./format";
import type { ExtSession, Phase, Restorable, Sess } from "./types";
import {
  accentFor, dormants, externals, FAVORITES, projOrder, sessions, sortMode, wtGroup,
} from "./state";
import { taskPrefs } from "./tasks";

// `dormants` are restorable-from-last-run rows. They hang off the project group
// rather than the worktree clusters: a dormant session has no live checkout state
// to cluster by, and pinning them below the live rows keeps the distinction between
// "running now" and "was running before" visually obvious.
export interface ProjGroup { name: string; path: string; accent: string; sessions: Sess[]; externals: ExtSession[]; dormants: Restorable[]; wtBranch?: string }
// A worktree cluster = the sessions of one project that share a checkout dir. Order
// follows first appearance in the (already-sorted) session list, so the active/
// attention sort still decides which worktree floats up. The repo-root checkout
// (worktree === null) is the "main" cluster; its label is the live branch.
export interface WtCluster { key: string; branch: string; isMain: boolean; sessions: Sess[]; externals: ExtSession[] }
/// Which *checkout* a pane belongs to — the key worktree clustering groups by.
///
/// An agent's `workdir` IS its checkout, but a task's `workdir` is wherever the task
/// declared it runs: VS Code's `options.cwd` is routinely a subfolder (`01_frontend`,
/// `02_backend`), which is emphatically not a different worktree. Keying on it split
/// one chain's panes into a cluster each, every one of them labelled with the same
/// branch — and, because the run-group fold happens *within* a cluster, stopped the
/// members of a single launch from ever folding into one row.
///
/// `run.root` is the directory discovery ran in, which is exactly the checkout.
export function checkoutOf(s: Sess, fallback: string): string {
  return (s.kind === "task" ? s.run?.root || s.workdir : s.workdir) || fallback;
}

export function clusterByWorktree(p: ProjGroup): WtCluster[] {
  const by = new Map<string, WtCluster>();
  const order: WtCluster[] = [];
  const bucket = (key: string, branch: string): WtCluster => {
    let c = by.get(key);
    if (!c) { c = { key, branch, isMain: key === p.path, sessions: [], externals: [] }; by.set(key, c); order.push(c); }
    else if (!c.branch && branch) c.branch = branch;
    return c;
  };
  for (const s of p.sessions) bucket(checkoutOf(s, p.path), s.branch || s.worktree || "").sessions.push(s);
  for (const e of p.externals) bucket(e.cwd || p.path, e.branch || "").externals.push(e);
  // Label clusters that never carried a branch: the repo-root checkout is "main",
  // any other bare dir falls back to its folder name.
  for (const c of order) if (!c.branch) c.branch = c.isMain ? "main" : basename(c.key);
  return order;
}
// toplevel mode: explode any project whose sessions span >1 worktree into one group
// per worktree. The root checkout keeps the project's identity (path/favourite/
// externals); each worktree gets its own group keyed by its checkout dir, carrying
// the branch in wtBranch. Single-checkout projects pass through untouched.
export function splitByWorktree(list: ProjGroup[]): ProjGroup[] {
  const out: ProjGroup[] = [];
  for (const p of list) {
    const cl = clusterByWorktree(p);
    const wts = cl.filter((c) => !c.isMain);
    if (!wts.length) { out.push(p); continue; }
    const root = cl.find((c) => c.isMain);
    // Keep the root group only when it carries something — root-checkout rows or a
    // favourite (a launch target). Drops the phantom empty root of a worktree-only repo.
    if (root || FAVORITES.some((f) => f.path === p.path)) out.push({ ...p, sessions: root?.sessions ?? [], externals: root?.externals ?? [] });
    for (const c of wts) out.push({ name: p.name, path: c.key, accent: p.accent, sessions: c.sessions, externals: c.externals, dormants: [], wtBranch: c.branch });
  }
  return out;
}
// Every project Episko knows about: the favourites, plus any repo discovered from a
// live session, an external (non-Episko) session, or a dormant one. Unsorted and never
// worktree-split — callers that need order or splitting layer it on.
//
// The sidebar and the launch palette MUST agree on this set. Building the palette from
// FAVORITES alone silently hid every externally-detected project, so pressing
// "+ Session" with nothing selected offered an arbitrary-looking subset of what the
// sidebar was showing.
export function allProjects(): ProjGroup[] {
  const list: ProjGroup[] = FAVORITES.map((f) => ({ name: f.name, path: f.path, accent: accentFor(f.path), sessions: [], externals: [], dormants: [] }));
  const byName = new Map(list.map((p) => [p.name, p]));
  const byPath = new Map(list.map((p) => [p.path, p]));
  for (const s of sessions.values()) {
    let p = byName.get(s.project) || byPath.get(s.colorKey);
    if (!p) { p = { name: s.project, path: s.colorKey, accent: accentFor(s.colorKey), sessions: [], externals: [], dormants: [] }; list.push(p); byName.set(s.project, p); byPath.set(s.colorKey, p); }
    p.sessions.push(s);
  }
  for (const e of externals) {
    // Group by the repo's main worktree, not the raw cwd, so every worktree of one
    // repo lands under it (and merges into that repo's favourite when paths match).
    const key = e.repo_root || e.cwd;
    let p = byPath.get(key);
    if (!p) { p = { name: basename(key), path: key, accent: accentFor(key), sessions: [], externals: [], dormants: [] }; list.push(p); byPath.set(key, p); byName.set(p.name, p); }
    p.externals.push(e);
  }
  for (const d of dormants) {
    let p = byName.get(d.project) || byPath.get(d.colorKey);
    if (!p) { p = { name: d.project, path: d.colorKey, accent: accentFor(d.colorKey), sessions: [], externals: [], dormants: [] }; list.push(p); byName.set(d.project, p); byPath.set(d.colorKey, p); }
    p.dormants.push(d);
  }
  return list;
}
export function projectList(): ProjGroup[] {
  const list = allProjects();
  // Sort sessions within each project first, then (in toplevel mode) split by
  // worktree so each split group inherits the sorted order, then order the groups.
  const sessCmp = sortMode === "active" ? (a: Sess, b: Sess) => b.lastActivity - a.lastActivity
    : sortMode === "attention" ? (a: Sess, b: Sess) => urgencyRank(a) - urgencyRank(b) || a.phaseSince - b.phaseSince
    : null;
  if (sessCmp) for (const p of list) p.sessions.sort(sessCmp);
  const groups = wtGroup === "toplevel" ? splitByWorktree(list) : list;
  if (sortMode === "active") {
    groups.sort((a, b) => projActivity(b) - projActivity(a));
  } else if (sortMode === "attention") {
    groups.sort((a, b) => projUrgency(a) - projUrgency(b) || projWaitSince(a) - projWaitSince(b));
  } else {
    // manual: the user's drag-drop order; unlisted projects keep their natural
    // order after listed ones (stable sort preserves ties).
    const rank = (path: string) => { const i = projOrder.indexOf(path); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    groups.sort((a, b) => rank(a.path) - rank(b.path));
  }
  return groups;
}
// ---------- run groups ----------
// A `dependsOn` chain launches one pane per step, which is correct (a run's exit
// code is its phase, and you cannot get four exit codes out of one PTY) and reads
// badly: "build → lint → test" arrives as three loose rows interleaved with your
// agents. Folding is presentational only — the panes, the PTYs and the phase
// machine are untouched.

/// One sidebar slot: a lone session, or a whole launch's worth of them.
export type RunItem =
  | { kind: "one"; s: Sess }
  | { kind: "group"; id: string; label: string; members: Sess[]; phase: Phase };

/// Collapse the members of each `run.groupId` into a single item, in place.
///
/// "In place" is the point: a group takes the position of its *first* member, so
/// whatever `projectList` already sorted by — activity, urgency, manual order —
/// still decides where the group sits. Re-sorting here would silently overrule it.
///
/// A group of one renders as a plain row. A chain whose dependencies all resolved to
/// nothing is not a chain, and a header wrapping a single step is pure overhead.
export function foldRunGroups(list: Sess[]): RunItem[] {
  const out: RunItem[] = [];
  const at = new Map<string, number>();   // groupId → index in `out`
  for (const s of list) {
    const gid = s.kind === "task" ? s.run?.groupId : undefined;
    if (!gid) { out.push({ kind: "one", s }); continue; }
    const i = at.get(gid);
    if (i === undefined) {
      at.set(gid, out.length);
      out.push({ kind: "group", id: gid, label: s.run?.groupLabel || s.run?.label || "run", members: [s], phase: "idle" });
    } else {
      (out[i] as { members: Sess[] }).members.push(s);
    }
  }
  return out.map((it) => {
    if (it.kind !== "group") return it;
    if (it.members.length === 1) return { kind: "one" as const, s: it.members[0] };
    return { ...it, phase: groupPhase(it.members) };
  });
}

/// The phase a group shows: the worst of its members.
///
/// Worst-of, not last-of, because the whole value of one row is that it answers "did
/// my chain pass?" without expanding it — and a failed build followed by a skipped
/// test must not read as `done` just because nothing ran after it. `working` beats
/// `done` for the same reason in the other direction: a chain with a step still
/// running has not passed yet.
export function groupPhase(members: Sess[]): Phase {
  const has = (p: Phase) => members.some((m) => m.phase === p);
  if (has("error")) return "error";
  if (has("working") || has("thinking")) return "working";
  if (has("idle")) return "working";      // queued behind a sequential dependency
  if (members.every((m) => m.phase === "ended")) return "ended";
  return "done";
}

// How much a session wants the user's attention (lower = more urgent). Shared by
// the sidebar's "attention" sort and the header reactor.
export function urgencyRank(s: Sess): number {
  if (s.kind === "shell") return 6;
  if (s.kind === "task") return s.phase === "error" ? 1 : 6;
  if (s.attention) return 0;         // blocking permission — Claude is waiting on you
  if (s.phase === "error") return 1;
  if (s.phase === "done") return 2;  // your turn
  if (s.phase === "working" || s.phase === "thinking") return 3;
  if (s.phase === "idle") return 4;
  return 5;                          // ended
}
function projActivity(p: ProjGroup): number { return p.sessions.reduce((m, s) => Math.max(m, s.lastActivity), 0); }
function projUrgency(p: ProjGroup): number { return p.sessions.reduce((m, s) => Math.min(m, urgencyRank(s)), 99); }
function projWaitSince(p: ProjGroup): number { return p.sessions.reduce((m, s) => Math.min(m, s.phaseSince), Number.MAX_SAFE_INTEGER); }
export function orderedSessions(): Sess[] { return projectList().flatMap((p) => p.sessions); }
// When the active session is closed, decide which one takes over. Prefer staying in
// the same project — the sibling directly above (as shown in the sidebar), else the
// one below — and only leave the project (nearest session in sidebar order) once it
// has no sessions left. Must be called BEFORE the session is removed from the map.
export function nextAfterClose(s: Sess): Sess | null {
  const g = projectList().find((p) => p.sessions.includes(s));
  if (g) {
    const gi = g.sessions.indexOf(s);
    const sib = g.sessions[gi - 1] || g.sessions[gi + 1];
    if (sib) return sib;
  }
  const flat = orderedSessions();
  const fi = flat.indexOf(s);
  return flat[fi + 1] || flat[fi - 1] || null;
}

// ---------- the "needs you" set ----------
// The other reading of the same fleet: not "what order does the sidebar show these
// in" but "which of them is waiting on the human". Two surfaces render it — the
// header reactor badge and the macOS tray title — so it sits here beside the sort it
// shares urgencyRank with, rather than in whichever of the two was extracted first.

// The fleet's "needs you" set — sessions with a blocking permission, an error, or
// finished and awaiting your reply — most urgent first (waiting wins), longest in
// that state first. Independent of the sidebar sort so the reactor is stable.
// A failed run counts: the whole point of running tasks in Episko is that a red
// build reaches you the same way a blocked session does. A *successful* run does
// not — it settles quietly and auto-dismisses.
export function needsYou(s: Sess): boolean {
  if (s.kind === "shell") return false;
  if (s.kind === "task") return taskPrefs.attention && s.phase === "error";
  return !!s.attention || s.phase === "done" || s.phase === "error";
}
export function needsYouSessions(): Sess[] {
  return [...sessions.values()].filter(needsYou).sort((a, b) => urgencyRank(a) - urgencyRank(b) || a.phaseSince - b.phaseSince);
}
export function reactorState(s: Sess): "attention" | "error" | "done" { return s.attention ? "attention" : s.phase === "error" ? "error" : "done"; }
export function reactorLabel(dom: "attention" | "error" | "done", n: number): string {
  if (dom === "attention") return `${n} need${n === 1 ? "s" : ""} you`;
  if (dom === "error") return `${n} error${n === 1 ? "" : "s"}`;
  return `${n} your turn`;
}
