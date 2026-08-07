// The app-level actions: the small verbs several surfaces trigger and none of them
// owns. A palette row, a context-menu row, a settings control and a header button can
// all pin a project, change the sort, flip the theme or answer a permission — so these
// live below all of them rather than in whichever one was extracted first.
//
// The shape is the same in every case, and it is why they are here rather than in
// ./state: mutate the persisted preference, write it, then repaint. `state.ts` owns
// the assignment and nothing else (its setters assign and return); the persistence and
// the repaint are this layer's, exactly as PLAN's `setX`-per-variable decision says.

import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { $, toast } from "./dom";
import { basename } from "./format";
import { probeIcon } from "./icons";
import { refit } from "./terminal";
import { activeCwd, closeSession, launch, launchShell } from "./panes";
import { closePeek, renderMini, renderSidebar } from "./sidebar";
import { renderSettings } from "./settings";
import { waitForExit } from "./tasks";
import { queueRosterSave } from "./mirror";
import {
  dashMirror, FAVORITES, IO_SCOPES, ioScope, markWorkdirStale, peekPrefs, permMode,
  permModeDef, projGroups,
  saveFavorites, saveProjGroups, sessions, termEngine,
  setFavorites, setIoScope, setPeekPrefs as setPeekPrefsState, setPermMode as setPermModeState,
  setProjGroups, setSortMode, SORT_META, SORT_MODES,
  soundPrefs, setSoundPrefs as setSoundPrefsState,
  sortMode, setWtGroup as setWtGroupState, wtGroup,
  type SortMode, type WtGroup,
} from "./state";
import {
  assignGroup, cleanGroupName, collapseAll, createGroup, deleteGroup, groupById,
  renameGroup, setCollapsed, type GroupStore,
} from "./projgroups";
import type { PeekPrefs } from "./peek";
import type { SoundPrefs } from "./sound";
import type { PermMode } from "./types";

// Every action here ends in a repaint of everything, which main.ts owns.
let renderAll: () => void = () => {};
export function setActionsRenderAll(fn: typeof renderAll) { renderAll = fn; }

// A plain shell in a project's folder — embedded gets an in-app pane, the external
// engines their own window. Here rather than in ./projmenu because the context menu,
// the project dashboard and (soon) the checkouts overlay all want it, which is this
// module's whole reason to exist.
export function openTerminalIn(project: string, dir: string) {
  if (termEngine !== "embedded") { invoke("open_terminal_here", { workdir: dir, engine: termEngine }).catch((e) => toast("terminal: " + e)); return; }
  void launchShell(project, dir, { colorKey: dir });
}
export async function copyPath(dir: string) {
  try { await navigator.clipboard.writeText(dir); toast("Path copied"); }
  catch { toast(dir); } // clipboard denied — at least show what it was
}

export async function openProjectFolder(key: string) {
  try { await invoke("open_folder", { dir: key }); }
  catch (e) { toast(String(e)); }
}

// The file-manager sibling of ⌘T (⌘⏎): show the current selection's folder. Keyed
// off activeCwd(), so it lands on the same directory a terminal would — a worktree
// session's own checkout rather than the repo it groups under, an external
// session's cwd, a dormant session's recorded workdir. A workdir that's since been
// deleted (a removed worktree) surfaces as the backend's error, not a silent no-op.
export function revealActiveFolder() {
  const wd = activeCwd();
  if (!wd) { toast("No active session"); return; }
  void openProjectFolder(wd);
}

export async function addProject() {
  const dir = await open({ directory: true, multiple: false, title: "Add a project folder" });
  if (!dir || typeof dir !== "string") return;
  addProjectPath(dir);
}
// Pin a folder to the sidebar. Also reachable from the context menu of a folder
// Episko knows about but hasn't been asked to keep (an external session's cwd).
export function addProjectPath(dir: string) {
  if (FAVORITES.some((f) => f.path === dir)) { toast("Already a project"); return; }
  FAVORITES.push({ name: basename(dir), path: dir });
  saveFavorites();
  renderAll();
  probeIcon(dir); // scour the repo for a favicon/logo to use as the project glyph
  toast(`Added ${basename(dir)}`);
}
export function removeFavorite(path: string) {
  setFavorites(FAVORITES.filter((f) => f.path !== path));
  saveFavorites();
  renderAll();
}
export function resolvePermission(id: string, behavior: string) {
  invoke("resolve_permission", { id, behavior }).catch(() => {});
  for (const s of sessions.values()) if (s.pendingPermId === id) { s.pendingPermId = null; s.attention = null; s.pendingCmd = ""; }
  renderAll();
}

// The app-level action: set the state, persist it, repaint. state.ts owns the
// assignment (and its validation) under the same name, hence the import alias.
export function setWtGroup(m: WtGroup) {
  setWtGroupState(m);
  localStorage.setItem("cc-worktree-group", wtGroup);
  renderAll();
}
// Dev affordance until the settings window ships: episkoWtGroup("chip") in the console.
(window as unknown as { episkoWtGroup: typeof setWtGroup }).episkoWtGroup = setWtGroup;

// The same shape again for the sidebar's peek timings. `renderSidebar` rather than
// `renderAll`: switching peek off has to drop the collapsed rows *and* clear whatever
// is currently expanded, and neither the tray nor the inspector shows any of this.
export function setPeekPrefs(p: PeekPrefs) {
  setPeekPrefsState(p);
  localStorage.setItem("cc-peek", JSON.stringify(peekPrefs));
  // Drop whatever is expanded before repainting. Without this, switching peek off
  // leaves a stale open path behind that would re-apply itself the moment it is
  // switched back on, expanding a group the pointer is nowhere near.
  closePeek();
  renderSidebar();
  renderSettings(); // the live preview in the Worktrees tab reads these values
}

// And again for the sound alerts. `renderSettings` alone, not `renderAll`: nothing
// outside the Sounds tab shows any of this — a sound is not a surface — so a repaint
// of the sidebar, the tray and the inspector would be work for no pixels. (./chime
// reads `soundPrefs` live at play time, so nothing has to be pushed to it.)
export function setSoundPrefs(p: SoundPrefs) {
  setSoundPrefsState(p);
  localStorage.setItem("cc-sound", JSON.stringify(soundPrefs));
  renderSettings();
}

// ---------- the user's named groups of projects ----------
// The same shape as everything else here (./projgroups computes, this persists and
// repaints), with one addition worth keeping: every mutator in ./projgroups returns the
// store it was handed when there is nothing to do, so a no-op costs neither a write nor
// a 7ms sidebar repaint. `renderSidebar` rather than `renderAll` — nothing else in the
// app shows a group, deliberately (see `renderMini`).
function commitProjGroups(next: GroupStore) {
  if (next === projGroups) return;
  setProjGroups(next);
  saveProjGroups();
  renderSidebar();
}
export function setProjectGroup(path: string, gid: string | null) {
  const to = gid ? groupById(projGroups, gid) : null;
  commitProjGroups(assignGroup(projGroups, path, gid));
  toast(to ? `Moved to ${to.name}` : "Removed from group");
}
export function newProjectGroup(name: string, path: string) {
  const clean = cleanGroupName(name);
  if (!clean) { toast("Give the group a name first"); return; }
  commitProjGroups(createGroup(projGroups, clean, [path]));
  toast(`Grouped under ${clean}`);
}
export function renameProjectGroup(gid: string, name: string) {
  const clean = cleanGroupName(name);
  if (!clean) { toast("A group needs a name"); return; }
  commitProjGroups(renameGroup(projGroups, gid, clean));
}
/// The projects come back to the top level — only the heading goes. Said out loud,
/// because "delete" next to a list of your repos deserves to be unambiguous.
export function deleteProjectGroup(gid: string) {
  const g = groupById(projGroups, gid);
  if (!g) return;
  commitProjGroups(deleteGroup(projGroups, gid));
  toast(`Ungrouped ${g.name} — the projects stay`);
}
export function toggleProjGroup(gid: string) {
  const g = groupById(projGroups, gid);
  if (g) commitProjGroups(setCollapsed(projGroups, gid, !g.collapsed));
}
export function collapseAllProjGroups(collapsed: boolean) { commitProjGroups(collapseAll(projGroups, collapsed)); }

// Which permission mode the NEXT session launches in — the same shape as the sort and
// the grouping above (state assigns, this persists and announces). Announced rather
// than silent because it changes what a session may do before you get a chance to see
// it: a pane started in Bypass or Don't ask never raises a permission card at all, so
// there is no later moment where the choice becomes visible. Only new launches move;
// a running session keeps whatever mode it is in (Claude's ⇧⇥ owns that).
export function setPermMode(m: PermMode) {
  setPermModeState(m);
  localStorage.setItem("cc-perm-mode", permMode);
  toast(permMode === "default"
    ? "New sessions ask before acting"
    : `New sessions start in ${permModeDef(permMode).label} mode`);
  renderSettings(); // keep the settings picker in sync if it's open
}

export function setSort(m: SortMode, announce = true) {
  setSortMode(m);
  localStorage.setItem("cc-sort", m);
  const b = $("railSort");
  b.textContent = SORT_META[m].glyph;
  b.title = `Sort: ${SORT_META[m].label} · click to change`;
  b.classList.toggle("on", m !== "manual");
  if (announce) toast(SORT_META[m].label);
  renderSidebar(); renderMini();
}
export function cycleSort() { setSort(SORT_MODES[(SORT_MODES.indexOf(sortMode) + 1) % SORT_MODES.length]); }
/// Which window the inspector's read/written total covers. Persisted, because it is a
/// preference — somebody who wants "this run" wants it on the next pane too, and having
/// to re-pick it per session is what makes a cycling control annoying rather than handy.
export function cycleIoScope() {
  setIoScope(IO_SCOPES[(IO_SCOPES.indexOf(ioScope) + 1) % IO_SCOPES.length]);
  localStorage.setItem("cc-io-scope", ioScope);
  renderAll();
}
export function toggleRail() { $("app").classList.toggle("rail-mini"); }
// ⌘I / ◨. On a session this hides the inspector outright — nothing in it is
// unreachable from that header. **On the dashboard it collapses to a 44px icon rail
// instead**: History, Terminal and Run are in the header there too now, but the
// worktree dialog, the commit graph, the folder and the live-session strip are not,
// so hiding the panel would still hide real verbs.
export function toggleInsp() {
  const app = $("app");
  if (dashMirror()) {
    const mini = app.classList.toggle("insp-mini");
    $("inspBtn").classList.toggle("on", !mini);
  } else {
    app.classList.remove("insp-mini");
    app.classList.toggle("insp-off");
    $("inspBtn").classList.toggle("on", !app.classList.contains("insp-off"));
  }
  refit();
}
// The effective theme = an explicit data-theme override, else the OS preference.
export function effectiveTheme(): "dark" | "light" {
  const a = document.documentElement.getAttribute("data-theme");
  if (a === "dark" || a === "light") return a;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
export function setTheme(t: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("cc-theme", t);
  renderSettings(); // keep the settings picker in sync if it's open
}
export function toggleTheme() { setTheme(effectiveTheme() === "dark" ? "light" : "dark"); }

// ---------- following a session to the checkout its agent moved to ----------
//
// Two drifts, two repairs, and conflating them was the bug this file already shipped
// once in miniature: what has to happen depends entirely on whether Claude Code moved
// the session itself or only its writes moved.
//
// **via "cwd"** — Claude Code did it (its `EnterWorktree` tool, or a `cd` that stayed
// inside the project dir). The process is *already* running in the new checkout and
// Claude has already re-homed the transcript under it. Nothing needs killing, moving or
// relaunching; Episko is simply behind, and adopting the directory in place is both the
// complete fix and the one with no cost — the session on screen never even blinks.
//
// **via "write"** — the session is still running where it was launched and only its
// writes moved. Following it therefore means relocating the conversation, and
// `claude --resume` finds one only under `<enc(cwd)>/<id>.jsonl` and takes no path — so
// *no sequence of commands a user could type* does this. Kill, wait, move, relaunch.
//
// The **wait** is load-bearing and is not the `invoke` returning: `kill_session` sends a
// signal (SIGHUP / TerminateProcess) and returns immediately, so awaiting it proves only
// that the signal was sent. The process is reaped on a backend thread, which emits
// `pty-exit` *after* `child.wait()` returns — that event, and only that event, means the
// transcript handle is closed. Renaming before it lands is the bug the ordering exists
// to prevent: Windows refuses to rename an open file, and POSIX cheerfully succeeds and
// leaves the dying session appending into the moved file. Bounded, because a wedged
// process must not strand the pane forever; past the bound we proceed and the move
// either works or reports why. A failed move still relaunches, in the original folder,
// so the cost is a restarted pane and nothing else.
// How long to give a killed session to actually die before moving its transcript
// anyway. Generous, because the alternative to waiting is the corruption above, and
// cheap, because it is only ever reached by a process that ignored its signal.
const KILL_WAIT_MS = 5000;

export async function followSessionDrift(id: string) {
  const s = sessions.get(id);
  if (!s?.drift) return;
  const { dir, branch, via } = s.drift;

  if (via === "cwd") {
    // No confirm: nothing is destroyed, interrupted or written. This only makes
    // Episko's idea of the folder agree with the one the session is already in.
    s.workdir = dir;
    s.branch = branch;
    s.worktree = dir === s.colorKey ? null : branch;
    s.drift = null;
    s.git = null;                  // the old checkout's working set is not this one's
    markWorkdirStale(s, "Write");  // re-read the new folder on the next sweep
    queueRosterSave();             // restore must target the folder the transcript is in
    renderAll();
    toast(`Now following ${branch}`);
    return;
  }

  const ok = await ask(
    `Move this session to ${branch}?\n\n`
    + `Episko will end the session, move its conversation to ${dir}, and resume it there.\n\n`
    + `The conversation is kept. Anything the agent is doing right now is interrupted.`,
    { title: "Move session", kind: "warning", okLabel: "Move & resume", cancelLabel: "Cancel" },
  );
  if (!ok) return;

  // Captured before the close, because the fallback path has to be able to rebuild the
  // session exactly as it was — same labels, not the drift's.
  const { project, colorKey, workdir, resumeId, worktree: wasWt, branch: wasBranch } = s;
  // Register the waiter *before* the kill, or a fast exit resolves into nothing. Note
  // `closeSession` also settles pending waiters (with -1, so a dependency chain can't
  // deadlock), which is exactly why this awaits first and closes second.
  const dead = waitForExit(id);
  await invoke("kill_session", { sessionId: id }).catch(() => {});
  await Promise.race([dead, new Promise((r) => setTimeout(r, KILL_WAIT_MS))]);
  closeSession(id);

  let moved = true;
  try {
    await invoke("move_session_transcript", { sessionId: resumeId, fromWorkdir: workdir, toWorkdir: dir });
  } catch (e) {
    // Nothing was moved — say so and put the session back exactly where it was, rather
    // than relaunching it in a folder its conversation isn't in.
    moved = false;
    toast("Couldn't move the session: " + e);
  }
  await launch(project, moved ? dir : workdir, {
    colorKey,
    // An agent can drift into the repo's *main* checkout as easily as into a sibling
    // worktree, and that one is not a worktree — labelling it as one would put a ⑃ on
    // the repo itself. `colorKey` is the repo root, so the comparison is free.
    worktree: moved ? (dir === colorKey ? null : branch) : wasWt,
    branch: moved ? branch : wasBranch,
    resume: resumeId,
  });
  if (moved) toast(`Session moved to ${branch}`);
}
