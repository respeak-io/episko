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
import { activeCwd, closeSession, launch } from "./panes";
import { renderMini, renderSidebar } from "./sidebar";
import { renderSettings } from "./settings";
import { queueRosterSave } from "./mirror";
import {
  FAVORITES, markWorkdirStale, saveFavorites, sessions, setFavorites, setSortMode,
  SORT_META, SORT_MODES, sortMode, setWtGroup as setWtGroupState, wtGroup,
  type SortMode, type WtGroup,
} from "./state";

// Every action here ends in a repaint of everything, which main.ts owns.
let renderAll: () => void = () => {};
export function setActionsRenderAll(fn: typeof renderAll) { renderAll = fn; }

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
export function toggleRail() { $("app").classList.toggle("rail-mini"); }
export function toggleInsp() { $("app").classList.toggle("insp-off"); $("inspBtn").classList.toggle("on", !$("app").classList.contains("insp-off")); refit(); }
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
// *no sequence of commands a user could type* does this. Kill, move, relaunch: the await
// on the kill is what makes it a move of a dead session (a live one holds the file open,
// which Windows refuses to rename outright). A failed move still relaunches, in the
// original folder, so the cost is a restarted pane and nothing else.
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
  await invoke("kill_session", { sessionId: id }).catch(() => {});
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
