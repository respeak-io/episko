// What the sidebar shows and in what order; pure over ./state, no DOM. `syncAttn` is the one
// function here that writes to a session. See test/grouping.test.ts.

import { basename } from "./format";
import { checkoutDir, sameDir } from "./gitwatch";
import {
  bgWaiting, hasSessionState, isAgent, providerSessionKey,
  type ExtSession, type LiveSess, type Phase, type Restorable, type Sess, type WtHead,
} from "./types";
import { attnCleared, attnOrder } from "./attn";
import { groupOf, type GroupDef } from "./projgroups";
import {
  accentFor, activeId, attnPrefs, backendLive, dormants, externals, FAVORITES, folderDirty,
  projGroups, projOrder, sessions, sortMode, wtGroup, worktreesByRepo,
} from "./state";
import { taskPrefs } from "./tasks";

// Dormants hang off the group, not a cluster: no live checkout to cluster by. `repoRoot` is set
// only on the groups `splitByWorktree` mints; the project is `repoRoot ?? path`, the folder `path`.
export interface ProjGroup { name: string; path: string; accent: string; sessions: Sess[]; externals: ExtSession[]; dormants: Restorable[]; wtBranch?: string; repoRoot?: string }
// One project's sessions sharing a checkout dir, in first-appearance order of the sorted list.
export interface WtCluster { key: string; branch: string; isMain: boolean; sessions: Sess[]; externals: ExtSession[] }
// The checkout a pane belongs to. A task's `workdir` is often a subfolder and a shell inherits the stage's
// cwd, so any dir inside a known checkout resolves to it; an unplaceable folder stays its own key.
export function checkoutOf(s: Sess, fallback: string): string {
  const dir = (s.kind === "task" ? s.run?.root || s.workdir : s.workdir) || fallback;
  return checkoutDir(dir, worktreesByRepo.get(s.colorKey) ?? []);
}

// `withEmpty` adds the roster's session-less checkouts, after the session-bearing ones. Sidebar
// body only: `splitByWorktree` must not promote an empty checkout to a project group.
export function clusterByWorktree(p: ProjGroup, withEmpty = false): WtCluster[] {
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
  if (withEmpty) {
    const roster = worktreesByRepo.get(p.path) ?? [];
    // Main checkout only: a project pinned at a linked worktree must not sprout its siblings' rows.
    if (roster.some((w) => w.is_main && w.path === p.path)) {
      for (const w of roster) {
        if (!w.exists) continue; // deleted checkouts are the ⑃ dialog's business
        const c = bucket(w.path, w.branch);
        c.branch = w.branch || c.branch; // the roster read HEAD; it beats a session's cached label
      }
    }
  }
  for (const c of order) if (!c.branch) c.branch = c.isMain ? "main" : basename(c.key);
  return order;
}
export const clusterIsLive = (c: WtCluster): boolean => c.sessions.length + c.externals.length > 0;
// toplevel mode: one group per worktree; the root checkout keeps the project's identity.
export function splitByWorktree(list: ProjGroup[]): ProjGroup[] {
  const out: ProjGroup[] = [];
  for (const p of list) {
    const cl = clusterByWorktree(p);
    const wts = cl.filter((c) => !c.isMain);
    if (!wts.length) { out.push(p); continue; }
    const root = cl.find((c) => c.isMain);
    // Keep the root group only when it carries rows or is a favourite (a launch target).
    if (root || FAVORITES.some((f) => f.path === p.path)) out.push({ ...p, sessions: root?.sessions ?? [], externals: root?.externals ?? [] });
    // `repoRoot` is what the group was split out of; without it nothing downstream reaches the project.
    for (const c of wts) out.push({ name: p.name, path: c.key, accent: p.accent, sessions: c.sessions, externals: c.externals, dormants: [], wtBranch: c.branch, repoRoot: p.path });
  }
  return out;
}
// Every project known, unsorted and unsplit; the sidebar and the launch palette must both use it.
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
    const key = e.repo_root || e.cwd; // main worktree first, so all of a repo's worktrees land under it
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
// A live session must not be offered for restore: a second resume interleaves into its transcript.
// Three sources: our panes, `backendLive` (PTYs the backend held across a webview reload, #47,
// invisible as externals), and the externals.
export function dormantBusy(d: Restorable): boolean {
  for (const s of sessions.values()) {
    if (s.provider === d.provider && (s.resumeId === d.resumeId || s.id === d.id)) return true;
  }
  if (backendLive.has(providerSessionKey(d.provider, d.id))) return true;
  return d.provider === "claude" && externals.some((e) => e.session_id === d.resumeId);
}
// Backend PTYs to rebuild a pane for after a webview reload (#47). Agent panes only: a task's `run`
// did not survive and a shell is cheap to reopen. Runs before `loadDormants`, hence takes the roster.
export function orphanAdoptions(back: LiveSess[], roster: Restorable[]): { id: string; workdir: string; provider: string; meta: Restorable | null }[] {
  return back
    .filter((b) => b.kind === "agent" && !!b.provider && !sessions.has(b.id))
    .map((b) => ({ id: b.id, workdir: b.workdir, provider: b.provider!, meta: roster.find((r) => r?.id === b.id) ?? null }));
}
// The roster entry is the identity the pane was launched under and wins outright. Without one,
// `heads` places a worktree under its repo; a folder no repo claims stays its own project (fail closed).
export function adoptIdentity(workdir: string, meta: Restorable | null, heads: readonly WtHead[]): {
  project: string; colorKey: string; worktree: string | null; branch: string;
} {
  if (meta?.colorKey) {
    return {
      project: meta.project || basename(meta.colorKey) || "session",
      colorKey: meta.colorKey, worktree: meta.worktree, branch: meta.branch || "",
    };
  }
  // The pane's checkout, not its raw workdir; an unplaceable folder comes back untouched.
  const checkout = checkoutDir(workdir, heads);
  const root = heads.find((w) => w.is_main)?.path ?? checkout;
  const own = heads.find((w) => sameDir(w.path, checkout));
  return {
    project: basename(root) || "session",
    colorKey: root,
    // As `launchWorktree` (./panes) records it: null for the repo's own checkout, else the branch.
    worktree: sameDir(root, checkout) ? null : own?.branch || basename(checkout),
    branch: own?.branch || "",
  };
}
export function projectList(): ProjGroup[] {
  const list = allProjects();
  // Sort sessions first so each split group inherits the order, then order the groups.
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
    const rank = (path: string) => { const i = projOrder.indexOf(path); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    groups.sort((a, b) => rank(a.path) - rank(b.path));
  }
  return groups;
}

// Which rows the open dashboard (`root`) belongs to. In toplevel mode several rows open the same
// dashboard: the root row alone wears the mark, all checkouts only when no root row exists.
export function dashHeads(list: ProjGroup[], root: string | null): Set<string> {
  if (!root) return new Set();
  const own = list.filter((p) => (p.repoRoot ?? p.path) === root);
  const rootRow = own.find((p) => !p.repoRoot);
  return new Set((rootRow ? [rootRow] : own).map((p) => p.path));
}

// ---------- the user's named groups, folded into that list ----------
// ./projgroups owns the store and its rules; this is the one place that turns it into rows.

export type SidebarSlot =
  | { kind: "project"; project: ProjGroup }
  | { kind: "group"; group: GroupDef; projects: ProjGroup[] };

// `repoRoot` fallback: the user filed the repo, so every checkout of it answers with its group.
function foldIdOf(p: ProjGroup): string | null {
  return groupOf(projGroups, p.path) ?? (p.repoRoot ? groupOf(projGroups, p.repoRoot) : null);
}

// A group sits where its first member does under the active sort; no group order is persisted.
// An empty group stays, after everything else: it is the drop target that refills it.
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

// `dirty`/`urgent` are for the collapsed state: folding a group must not hide that something waits.
export interface GroupSummary { count: number; dirty: boolean; urgent: Sess | null }
export function groupSummary(projects: ProjGroup[]): GroupSummary {
  let count = 0, dirty = false, urgent: Sess | null = null;
  for (const p of projects) {
    count += p.sessions.length + p.externals.length;
    if (!dirty) dirty = p.sessions.some((s) => folderDirty(s.workdir)) || p.externals.some((e) => folderDirty(e.cwd));
    for (const s of p.sessions) {
      // `attnPending`, not `needsYou`: a fold must not go on flagging a turn you already read.
      if (!attnPending(s)) continue;
      if (!urgent || urgencyRank(s) < urgencyRank(urgent) || (urgencyRank(s) === urgencyRank(urgent) && s.phaseSince < urgent.phaseSince)) urgent = s;
    }
  }
  return { count, dirty, urgent };
}
// ---------- run groups ----------
// A `dependsOn` chain is one pane per step; folding them is presentational only.

export type RunItem =
  | { kind: "one"; s: Sess }
  | { kind: "group"; id: string; label: string; members: Sess[]; phase: Phase };

// In place: a group takes its first member's position, so `projectList`'s sort still decides.
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

// Unlike `nextAfterClose`, this stays inside the run; next before previous because the grid reflows
// into the gap, so the tile that follows is the one to look at.
export function nextInGroup(members: Sess[], closingId: string): Sess | null {
  const i = members.findIndex((m) => m.id === closingId);
  if (i < 0) return null;
  return members[i + 1] ?? members[i - 1] ?? null;
}

// Worst-of, so one row answers "did my chain pass?" without expanding it.
export function groupPhase(members: Sess[]): Phase {
  const has = (p: Phase) => members.some((m) => m.phase === p);
  if (has("error")) return "error";
  if (has("working") || has("thinking")) return "working";
  if (has("idle")) return "working";      // queued behind a sequential dependency
  if (members.every((m) => m.phase === "ended")) return "ended";
  return "done";
}

// How much a session wants the user (lower = more urgent); shared by the attention sort and the reactor.
export function urgencyRank(s: Sess): number {
  // Neither reports a phase, so neither can be more urgent than "it is open".
  if (s.kind === "shell" || (isAgent(s) && !hasSessionState(s))) return 6;
  if (s.kind === "task") return s.phase === "error" ? 1 : 6;
  if (s.attention) return 0;         // blocking permission — Claude is waiting on you
  if (s.phase === "error") return 1;
  // A live fleet ranks with working: nothing is expected of you until its agents report back.
  if (bgWaiting(s)) return 3;
  if (s.phase === "done") return 2;  // your turn
  if (s.phase === "working" || s.phase === "thinking") return 3;
  if (s.phase === "idle") return 4;
  return 5;                          // ended
}
function projActivity(p: ProjGroup): number { return p.sessions.reduce((m, s) => Math.max(m, s.lastActivity), 0); }
function projUrgency(p: ProjGroup): number { return p.sessions.reduce((m, s) => Math.min(m, urgencyRank(s)), 99); }
function projWaitSince(p: ProjGroup): number { return p.sessions.reduce((m, s) => Math.min(m, s.phaseSince), Number.MAX_SAFE_INTEGER); }
// Flat sidebar order (⌘1–9): through `groupedProjects`, since a group moves its members.
export function orderedSessions(): Sess[] {
  return groupedProjects().flatMap((s) => (s.kind === "project" ? s.project.sessions : s.projects.flatMap((p) => p.sessions)));
}
// Sibling above, else below, else nearest in sidebar order. Call BEFORE `s` leaves the map.
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

// A failed task counts (a red build reaches you like a blocked session); a successful one does not.
export function needsYou(s: Sess): boolean {
  // With no hooks behind it nothing can say it is waiting; a guessed badge could never be cleared.
  if (s.kind === "shell" || (isAgent(s) && !hasSessionState(s))) return false;
  if (s.kind === "task") return taskPrefs.attention && s.phase === "error";
  if (s.attention) return true;
  // A background fan-out ends the turn, not the work: nothing is asked of you yet.
  if (bgWaiting(s)) return false;
  return s.phase === "done" || s.phase === "error";
}
// Stamps `Sess.attnAt` (./attn). ONE call site, at the top of `renderAllNow`: every event that
// can change the set already ends in `renderAll()`, so once per paint is complete. Idempotent.
export function syncAttn(now = Date.now()) {
  for (const s of sessions.values()) {
    const needy = needsYou(s);
    if (needy && !s.attnAt) s.attnAt = now;
    else if (!needy && s.attnAt) s.attnAt = 0;
  }
}
// The needs-you set minus what you have already been to. Must stay separate from `needsYou`,
// the raw fact `syncAttn` asks: folded in, the two would flip each other's stamp every paint.
export function attnPending(s: Sess): boolean {
  return needsYou(s) && !attnCleared(s, attnPrefs, s.id === activeId);
}
// Urgency stays the primary key over ./attn's order: the badge takes its wording from `list[0]`.
export function needsYouSessions(): Sess[] {
  const wait = attnOrder(attnPrefs);
  return [...sessions.values()].filter(attnPending).sort((a, b) => urgencyRank(a) - urgencyRank(b) || wait(a, b));
}
export function reactorState(s: Sess): "attention" | "error" | "done" { return s.attention ? "attention" : s.phase === "error" ? "error" : "done"; }
export function reactorLabel(dom: "attention" | "error" | "done", n: number): string {
  if (dom === "attention") return `${n} need${n === 1 ? "s" : ""} you`;
  if (dom === "error") return `${n} error${n === 1 ? "" : "s"}`;
  return `${n} your turn`;
}
