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
import { open } from "@tauri-apps/plugin-dialog";
import { $, toast } from "./dom";
import { basename } from "./format";
import { probeIcon } from "./icons";
import { refit } from "./terminal";
import { activeCwd } from "./panes";
import { renderMini, renderSidebar } from "./sidebar";
import { renderSettings } from "./settings";
import {
  FAVORITES, saveFavorites, sessions, setFavorites, setSortMode, SORT_META,
  SORT_MODES, sortMode, setWtGroup as setWtGroupState, wtGroup,
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
