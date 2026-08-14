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
// ./tasks — that module owns the switch and nothing here should copy it. Its
// neighbours read the attention preference out of ./state and its rules out of ./attn,
// on the same terms.)
//
// `syncAttn` is the one function here that WRITES to a session, and it writes exactly
// one derived field — see its own comment for why it is here and why it is called from
// a single place.
//
// See test/grouping.test.ts.

import { basename } from "./format";
import { checkoutDir } from "./gitwatch";
import { bgWaiting, type ExtSession, type LiveSess, type Phase, type Restorable, type Sess } from "./types";
import { attnCleared, attnOrder } from "./attn";
import { groupOf, type GroupDef } from "./projgroups";
import {
  accentFor, activeId, attnPrefs, backendLive, dormants, externals, FAVORITES, folderDirty,
  projGroups, projOrder, sessions, sortMode, wtGroup, worktreesByRepo,
} from "./state";
import { taskPrefs } from "./tasks";

// `dormants` are restorable-from-last-run rows. They hang off the project group
// rather than the worktree clusters: a dormant session has no live checkout state
// to cluster by, and pinning them below the live rows keeps the distinction between
// "running now" and "was running before" visually obvious.
/// `repoRoot` is set only on the groups `splitByWorktree` mints — a checkout is not a
/// project, it is one folder of one. Anything that wants "the project this row belongs
/// to" reads `repoRoot ?? path`; anything that wants the folder itself reads `path`.
export interface ProjGroup { name: string; path: string; accent: string; sessions: Sess[]; externals: ExtSession[]; dormants: Restorable[]; wtBranch?: string; repoRoot?: string }
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
/// `run.root` is the directory discovery ran in, which is exactly the checkout — but it
/// only rescues panes that *have* a run. The same subfolder reaches a **shell**: `❯
/// Terminal` opens one in `activeCwd()`, the raw workdir of whatever owns the stage, so
/// a shell opened while a finished task pane is on stage is born in that task's cwd and
/// carries no `run` to unwrap. It split off its own header, labelled with the branch it
/// had inherited — two identical branch names, one session each.
///
/// So the last word belongs to the worktree roster: any directory *inside* a known
/// checkout resolves to that checkout, whatever put the pane there. `checkoutDir` owns
/// that rule (./gitwatch already resolved paths this way for drift) including its
/// fail-closed half — an unplaceable folder stays its own key, exactly as before.
export function checkoutOf(s: Sess, fallback: string): string {
  const dir = (s.kind === "task" ? s.run?.root || s.workdir : s.workdir) || fallback;
  return checkoutDir(dir, worktreesByRepo.get(s.colorKey) ?? []);
}

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
  for (const s of p.sessions) bucket(checkoutOf(s, p.path), s.branch || s.worktree || "").sessions.push(s);
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
    // `repoRoot` is what the group was split OUT of. Splitting drops it otherwise, and
    // then nothing downstream can get back to the project — which is how a worktree
    // group's dashboard came to be keyed by its checkout dir and show no sessions at all.
    for (const c of wts) out.push({ name: p.name, path: c.key, accent: p.accent, sessions: c.sessions, externals: c.externals, dormants: [], wtBranch: c.branch, repoRoot: p.path });
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
// A session that's live right now must not be offered for restore: Claude doesn't
// lock the transcript, so a second --resume of the same id silently interleaves
// both conversations into one file. Three sources, because each sees sessions the
// others can't: the frontend map (our own panes), `backendLive` (a PTY the backend
// still holds while the map has no pane for it — every pane after a webview reload,
// #47; invisible as an external too, since `list_external_sessions` excludes owned
// pids), and the externals list (another terminal entirely).
export function dormantBusy(d: Restorable): boolean {
  for (const s of sessions.values()) if (s.resumeId === d.resumeId || s.id === d.id) return true;
  if (backendLive.has(d.id)) return true;
  return externals.some((e) => e.session_id === d.resumeId);
}
// Which backend PTYs need a pane rebuilt after a webview reload, and under what
// identity (#47 stage 2). Claude panes only: a shell is cheap to reopen and carries
// no conversation, and a task pane's `run` metadata — label, chain, how its exit is
// read — did not survive the reload, so a bare terminal claiming to be that task
// would lie about everything but the bytes. The roster supplies the identity the
// pane was launched under; an orphan the roster has no entry for still adopts with
// `meta: null` — a running conversation is worth more than a tidy label, and the
// caller derives one from `workdir`. Takes the roster as a parameter because it
// runs at startup, BEFORE `loadDormants` has filtered it into `dormants`.
export function orphanAdoptions(back: LiveSess[], roster: Restorable[]): { id: string; workdir: string; meta: Restorable | null }[] {
  return back
    .filter((b) => b.kind === "claude" && !sessions.has(b.id))
    .map((b) => ({ id: b.id, workdir: b.workdir, meta: roster.find((r) => r?.id === b.id) ?? null }));
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

/// Which group a project belongs to. The `repoRoot` fallback is what keeps toplevel mode
/// coherent: there the repo has exploded into one group per checkout, and the user
/// filed the *repo*, so every checkout of it has to answer with the repo's group or a
/// grouped repo would scatter across the rail the moment you opened a second worktree.
function foldIdOf(p: ProjGroup): string | null {
  return groupOf(projGroups, p.path) ?? (p.repoRoot ? groupOf(projGroups, p.repoRoot) : null);
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
      // `attnPending`, not `needsYou`: a fold that went on flagging a turn you have
      // already read would be the badge's own drift, one level down.
      if (!attnPending(s)) continue;
      if (!urgent || urgencyRank(s) < urgencyRank(urgent) || (urgencyRank(s) === urgencyRank(urgent) && s.phaseSince < urgent.phaseSince)) urgent = s;
    }
  }
  return { count, dirty, urgent };
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

/// Which member a tiled run group should focus when `closingId` goes away: the next
/// one in the given order, else the previous, else `null` when it was the last.
///
/// Separate from `nextAfterClose`, which answers the *sidebar's* question ("which
/// session takes the stage") over the whole project — and therefore happily hands the
/// stage to a Claude session sitting next to the group. Closing one tile of a mosaic
/// means "show me the rest of this run", not "leave it".
///
/// Next-then-previous because the grid reflows into the gap: closing the top-left tile
/// promotes the one that follows it, so that is the one to look at.
export function nextInGroup(members: Sess[], closingId: string): Sess | null {
  const i = members.findIndex((m) => m.id === closingId);
  if (i < 0) return null;
  return members[i + 1] ?? members[i - 1] ?? null;
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
  // A fleet still running ranks with the work it is: the turn ended, but nothing is
  // expected of you until its agents report back. Ahead of `done` it would push a
  // session that wants nothing to the top of the attention sort.
  if (bgWaiting(s)) return 3;
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
  if (s.attention) return true;
  // A background fan-out ends the turn without ending the work, so `done` alone stopped
  // being enough: a workflow's twenty minutes used to sit in the reactor badge and the
  // tray title as one more session waiting on a human who had nothing to answer.
  if (bgWaiting(s)) return false;
  return s.phase === "done" || s.phase === "error";
}
/**
 * When each pane entered the set above — `Sess.attnAt`, the anchor the finish
 * highlight fades from and the reactor's queue is ordered by (./attn).
 *
 * ONE CALL SITE, AT THE TOP OF `renderAllNow`, and that is the point. Four different
 * events can put a session in this set (a turn ending, a `StopFailure`, a permission
 * arriving on its own channel, a task's exit code) and a fifth non-event can too — a
 * background fan-out's grace window expiring, which no hook announces. Stamping at each
 * of them would be five places to forget; every one of them already ends in
 * `renderAll()` by the app's oldest rule, so asking the question once per paint is both
 * complete and self-healing. Being up to one frame late does not show on a highlight
 * measured in seconds.
 *
 * `was` is read back off the stamp rather than tracked separately, which is what keeps
 * this idempotent: running it twice in a row changes nothing.
 */
export function syncAttn(now = Date.now()) {
  for (const s of sessions.values()) {
    const needy = needsYou(s);
    if (needy && !s.attnAt) s.attnAt = now;
    else if (!needy && s.attnAt) s.attnAt = 0;
  }
}
/**
 * The needs-you set MINUS whatever you have already been to — what every surface that
 * *counts* sessions at you reads (the reactor badge and its picker, the tray title, the
 * palette's "Needs you" group, a collapsed group's warning glyph).
 *
 * Deliberately not folded into `needsYou` itself, which has to stay the raw fact: it is
 * what `syncAttn` above asks, and a predicate that answered "no, you've seen it" would
 * clear the very stamp that decides whether you have — the two would then flip each
 * other on alternate paints forever.
 */
export function attnPending(s: Sess): boolean {
  return needsYou(s) && !attnCleared(s, attnPrefs, s.id === activeId);
}
/// The reactor's queue: most urgent first, then whichever end of the wait the user
/// picked (./attn's `attnOrder`). The urgency tier stays the primary key whatever that
/// setting says — the badge takes its colour and its wording from `list[0]`, so a
/// permission sorting below a finished turn would have it announce "1 your turn" while
/// Claude sat blocked.
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
