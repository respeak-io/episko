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
import type { ExtSession, Restorable, Sess } from "./types";
import { groupOf, type GroupDef } from "./projgroups";
import {
  accentFor, dormants, externals, FAVORITES, folderDirty, projGroups, projOrder,
  sessions, sortMode, wtGroup, worktreesByRepo,
} from "./state";
import { taskPrefs } from "./tasks";

// `dormants` are restorable-from-last-run rows. They hang off the project group
// rather than the worktree clusters: a dormant session has no live checkout state
// to cluster by, and pinning them below the live rows keeps the distinction between
// "running now" and "was running before" visually obvious.
// `wtRoot` is set only on the per-worktree groups `splitByWorktree` mints in toplevel
// mode: their `path` is a checkout dir, so it is the only way back to the repo the
// user actually filed into a project group.
export interface ProjGroup { name: string; path: string; accent: string; sessions: Sess[]; externals: ExtSession[]; dormants: Restorable[]; wtBranch?: string; wtRoot?: string }
// A worktree cluster = the sessions of one project that share a checkout dir. Order
// follows first appearance in the (already-sorted) session list, so the active/
// attention sort still decides which worktree floats up. The repo-root checkout
// (worktree === null) is the "main" cluster; its label is the live branch.
export interface WtCluster { key: string; branch: string; isMain: boolean; sessions: Sess[]; externals: ExtSession[] }
// `withEmpty` folds in the roster's session-less checkouts, so a worktree an agent just
// created is visible before anything runs in it. Off by default because only the
// sidebar body wants them: `splitByWorktree` must not promote an empty checkout to a
// top-level project group, which would be a lot of chrome for a folder with nothing in
// it. Roster clusters land after the session-bearing ones (`order` is append-only),
// which keeps "running now" above "available".
export function clusterByWorktree(p: ProjGroup, withEmpty = false): WtCluster[] {
  const by = new Map<string, WtCluster>();
  const order: WtCluster[] = [];
  const bucket = (key: string, branch: string): WtCluster => {
    let c = by.get(key);
    if (!c) { c = { key, branch, isMain: key === p.path, sessions: [], externals: [] }; by.set(key, c); order.push(c); }
    else if (!c.branch && branch) c.branch = branch;
    return c;
  };
  for (const s of p.sessions) bucket(s.workdir || p.path, s.branch || s.worktree || "").sessions.push(s);
  for (const e of p.externals) bucket(e.cwd || p.path, e.branch || "").externals.push(e);
  if (withEmpty) {
    const roster = worktreesByRepo.get(p.path) ?? [];
    // Only fold the roster in when this group really is the repo — i.e. the repo's main
    // checkout IS p.path. A project pinned *at* a linked worktree resolves to the same
    // repo, and without this guard that group would suddenly sprout a row for the main
    // checkout and every sibling worktree, silently redefining what the group means.
    if (roster.some((w) => w.is_main && w.path === p.path)) {
      for (const w of roster) {
        // A registered-but-deleted checkout is git bookkeeping, not a place to work —
        // the ⑃ dialog is where you prune those, so the sidebar stays quiet about them.
        if (!w.exists) continue;
        const c = bucket(w.path, w.branch);
        // The roster read HEAD directly, so it wins over a session's cached label.
        c.branch = w.branch || c.branch;
      }
    }
  }
  // Label clusters that never carried a branch: the repo-root checkout is "main",
  // any other bare dir falls back to its folder name.
  for (const c of order) if (!c.branch) c.branch = c.isMain ? "main" : basename(c.key);
  return order;
}
// Does anything actually run in this checkout? The line the sidebar now draws: live
// clusters are rows, everything else is a peek row that only appears when you rest on
// the project (./peek, ./sidebarview). Externals count — a colleague's session in a
// checkout is still a reason for it to hold its place in the list.
export const clusterIsLive = (c: WtCluster): boolean => c.sessions.length + c.externals.length > 0;
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
    for (const c of wts) out.push({ name: p.name, path: c.key, accent: p.accent, sessions: c.sessions, externals: c.externals, dormants: [], wtBranch: c.branch, wtRoot: p.path });
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

// ---------- the user's named groups, folded into that list ----------
// `projectList()` above answers "which projects, in what order"; this layers the user's
// own headings over the result without touching either question. ./projgroups owns the
// store and its rules; this is the one place that turns it into what the rail draws.

/// What the sidebar iterates: either a project on its own, or a named group with the
/// projects that belong to it. Never nested further — a group holds projects, and a
/// project is not a group.
export type SidebarSlot =
  | { kind: "project"; project: ProjGroup }
  | { kind: "group"; group: GroupDef; projects: ProjGroup[] };

/// Which group a project belongs to. The `wtRoot` fallback is what keeps toplevel mode
/// coherent: there the repo has exploded into one group per checkout, and the user
/// filed the *repo*, so every checkout of it has to answer with the repo's group or a
/// grouped repo would scatter across the rail the moment you opened a second worktree.
function foldIdOf(p: ProjGroup): string | null {
  return groupOf(projGroups, p.path) ?? (p.wtRoot ? groupOf(projGroups, p.wtRoot) : null);
}

/**
 * The sidebar's rows, with groups folded in.
 *
 * **A group sits where its first member does**, under whichever sort is active — so it
 * floats up in `active` when one of its projects is busiest, and in `attention` when
 * one of them needs you, exactly as that project would have on its own. This is why
 * there is no group order to persist, and why dragging a project drags its group's
 * position with it: derived, so the two cannot disagree.
 *
 * An **empty** group has no member to be ranked by, so it lands after everything else
 * rather than vanishing. Keeping it is deliberate: it is a heading the user named and
 * the drop target that refills it, and a group that disappeared the moment you took the
 * last project out would read as Episko having deleted it.
 */
export function groupedProjects(list: ProjGroup[] = projectList()): SidebarSlot[] {
  const store = projGroups;
  if (!store.groups.length) return list.map((project) => ({ kind: "project" as const, project }));
  const slots: SidebarSlot[] = [];
  const open = new Map<string, ProjGroup[]>();
  for (const project of list) {
    const gid = foldIdOf(project);
    const group = gid ? store.groups.find((g) => g.id === gid) : undefined;
    if (!group) { slots.push({ kind: "project", project }); continue; }
    let projects = open.get(group.id);
    if (!projects) { projects = []; open.set(group.id, projects); slots.push({ kind: "group", group, projects }); }
    projects.push(project);
  }
  for (const group of store.groups) if (!open.has(group.id)) slots.push({ kind: "group", group, projects: [] });
  return slots;
}

/// What a group's header has to say for the projects it hides. Only `count` is shown
/// while the group is open; `dirty` and `urgent` exist for the collapsed state, where
/// the rule is that folding a group away must never fold away the fact that something
/// in it is waiting on you.
export interface GroupSummary { count: number; dirty: boolean; urgent: Sess | null }
export function groupSummary(projects: ProjGroup[]): GroupSummary {
  let count = 0, dirty = false, urgent: Sess | null = null;
  for (const p of projects) {
    count += p.sessions.length + p.externals.length;
    if (!dirty) dirty = p.sessions.some((s) => folderDirty(s.workdir)) || p.externals.some((e) => folderDirty(e.cwd));
    for (const s of p.sessions) {
      if (!needsYou(s)) continue;
      if (!urgent || urgencyRank(s) < urgencyRank(urgent) || (urgencyRank(s) === urgencyRank(urgent) && s.phaseSince < urgent.phaseSince)) urgent = s;
    }
  }
  return { count, dirty, urgent };
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
// The sidebar read as one flat list — ⌘1–9 and `nextAfterClose`'s fallback. It goes
// through `groupedProjects`, not `projectList`, because a group physically moves its
// members: read from the ungrouped list, ⌘4 would land on the fourth session in an
// order nothing on screen is in. A collapsed group's sessions stay in it (they are
// still running, and `setActive` unfolds the group it lands in).
export function orderedSessions(): Sess[] {
  return groupedProjects().flatMap((s) => (s.kind === "project" ? s.project.sessions : s.projects.flatMap((p) => p.sessions)));
}
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
