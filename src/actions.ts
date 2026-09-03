// The app-level verbs several surfaces trigger and none owns. One shape throughout:
// mutate the persisted preference, write it, then repaint. state.ts's setters only
// assign; the persistence and the repaint are this layer's.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { $, toast } from "./dom";
import { ask } from "./confirm";
import { basename } from "./format";
import { probeIcon } from "./icons";
import { applyScrollback, refit } from "./terminal";
import { activeCwd, closeSession, launch, launchShell, shelveSession } from "./panes";
import { closePeek, renderMini, renderSidebar } from "./sidebar";
import { renderSettings } from "./settings";
import { waitForExit } from "./tasks";
import { queueRosterSave } from "./mirror";
import {
  attnPrefs, dashMirror, FAVORITES, footPrefs, keyPrefs, markWorkdirStale,
  peekPrefs, permissionModes,
  projGroups,
  saveFavorites, saveProjGroups, sessions, termEngine,
  setAttnPrefs as setAttnPrefsState,
  setFavorites, setFootPrefs, setKeyPrefs as setKeyPrefsState,
  agentByProject, agentDef, defaultAgent, effectiveAgent,
  ghAccountByProject, setGhLogins, setProjectGhAccount as setProjectGhAccountState,
  setDefaultAgent as setDefaultAgentState, setProjectAgent as setProjectAgentState,
  setPeekPrefs as setPeekPrefsState, setProviderPermissionMode as setPermissionModeState,
  setProjGroups, setSortMode, SORT_META, SORT_MODES,
  soundPrefs, setSoundPrefs as setSoundPrefsState,
  revivePrefs, setRevivePrefs as setRevivePrefsState,
  vitalsPrefs, setVitalsPrefs as setVitalsPrefsState,
  termScrollback, setTermScrollback as setTermScrollbackState,
  sortMode, setWtGroup as setWtGroupState, wtGroup,
  cmpBase, setCmpBase as setCmpBaseState,
  motionPrefs, setMotionPrefs as setMotionPrefsState, winFocused, setWinFocused as setWinFocusedState,
  titlePrefs, setTitlePrefs as setTitlePrefsState,
  type SortMode, type WtGroup,
} from "./state";
import { footPrefsJson, toggleFootSeg, type FootSeg } from "./footprefs";
import type { GhAccount } from "./ghwork";
import { ALL_FX_CLASSES, motionPrefsJson, rootFxClasses, toggleFx, type VisualFx } from "./motion";
import { vitalsPrefsJson, type VitalsPrefs } from "./perf";
import {
  assignGroup, cleanGroupName, collapseAll, createGroup, deleteGroup, groupById,
  renameGroup, setCollapsed, type GroupStore,
} from "./projgroups";
import { isDefaultKeyPrefs, serializeKeyPrefs, type KeyPrefs } from "./keys";
import type { AttnPrefs } from "./attn";
import type { PeekPrefs } from "./peek";
import { cleanTitle, type TitlePrefs } from "./format";
import type { SoundPrefs } from "./sound";
import { canShelve, CLAUDE_CLI, midWork, phaseText } from "./types";
import { resolveProviderPermission } from "./providers/control";
import { removePermission } from "./permissions";
import { providerAdapter, providerPermissionMode } from "./providers";
import { reviveGap, reviveStep, type RevivePrefs } from "./revive";
import { playSound } from "./chime";
import { dlog } from "./debug";

let renderAll: () => void = () => {};
export function setActionsRenderAll(fn: typeof renderAll) { renderAll = fn; }

// Re-read a project's GitHub half if the dashboard is open on it. ./dashboard sits
// above this layer and owns the fetch, so it arrives as a hook rather than an import.
let ghReload: (root: string) => void = () => {};
export function setGhReload(fn: typeof ghReload) { ghReload = fn; }

export function openTerminalIn(project: string, dir: string) {
  if (termEngine !== "embedded") { invoke("open_terminal_here", { workdir: dir, engine: termEngine }).catch((e) => toast("terminal: " + e)); return; }
  void launchShell(project, dir, { colorKey: dir });
}
// Tauri's clipboard plugin, never navigator.clipboard: that raises an OS permission prompt.
export async function copyPath(dir: string) {
  try { await writeText(dir); toast("Path copied"); }
  catch { toast(dir); } // clipboard denied — at least show what it was
}

export async function openProjectFolder(key: string) {
  try { await invoke("open_folder", { dir: key }); }
  catch (e) { toast(String(e)); }
}

// The Context card's rows. Both surface the backend's error: an agent's file set outlives
// the files in it (a removed worktree, a deleted temp file), and "no such file" is the truth.
export async function openTouchedFile(path: string) {
  try { await invoke("open_file", { path }); }
  catch (e) { toast(String(e)); }
}
export async function revealTouchedFile(path: string) {
  try { await invoke("reveal_file", { path }); }
  catch (e) { toast(String(e)); }
}

// ⌘⏎: the active selection's folder, keyed off activeCwd() so it lands where ⌘T would.
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
// Shelve one session, asking first if it is mid-turn. The sign-off sheet calls
// `shelveSession` directly, having already asked about the whole fleet.
export async function shelveSessionAsked(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  if (canShelve(s) && midWork(s)) {
    const ok = await ask(
      `${s.title || s.project} is still going — ${phaseText(s)}\n\nShelving stops it now. The conversation is kept and comes back from the sidebar, but the turn it is in the middle of will not finish.`,
      { title: "Shelve a working session?", kind: "warning", okLabel: "Shelve it", cancelLabel: "Leave it running" },
    );
    if (!ok) return;
  }
  if (shelveSession(id)) toast("Shelved · resume it from the sidebar");
}

export function resolvePermission(id: string, behavior: string) {
  const owner = [...sessions.values()].find((s) => s.pendingPermId === id
    || s.pendingPermissions.some((pending) => pending.id === id));
  if (owner) {
    // The card goes either way (an answer must never look stuck), so a refusal has no other
    // surface left: say it, or the agent sits at a prompt nobody knows is still open.
    resolveProviderPermission(owner, id, behavior).catch((e) => {
      dlog("warn", `permission ${behavior} failed: ${e}`);
      toast(`the ${behavior} didn't reach the agent: ${e}`);
    });
  } else {
    // An unrouted Claude hook may still be held open in the backend; release it directly.
    invoke("resolve_permission", { id, behavior }).catch((e) => dlog("warn", `resolve_permission: ${e}`));
  }
  if (owner) removePermission(owner, id);
  renderAll();
}

// Settings › Sessions owns this now (`data-set="wtgroup"`); the console stopgap that stood
// in for it before that window shipped is gone.
export function setWtGroup(m: WtGroup) {
  setWtGroupState(m);
  localStorage.setItem("cc-worktree-group", wtGroup);
  renderAll();
}

// No repaint: the only reader is the ⑃ dialog, which re-reads git itself afterwards.
export function setCmpBase(repoDir: string, ref: string) {
  setCmpBaseState(repoDir, ref);
  localStorage.setItem("cc-cmp-base", JSON.stringify(cmpBase));
}

// renderSidebar rather than renderAll: nothing outside the sidebar shows peek state.
export function setPeekPrefs(p: PeekPrefs) {
  setPeekPrefsState(p);
  localStorage.setItem("cc-peek", JSON.stringify(peekPrefs));
  // Drop what is expanded first, or a stale open path re-applies when peek comes back on.
  closePeek();
  renderSidebar();
  renderSettings(); // the live preview in the Worktrees tab reads these values
}

// `Sess.title` is the *cleaned* string, so re-derive it from `rawTitle` or an idle or
// ended pane keeps wearing the old rule, which reads as the switch not working.
export function setTitlePrefs(p: TitlePrefs, repaintSettings = true) {
  setTitlePrefsState(p);
  localStorage.setItem("cc-title", JSON.stringify(titlePrefs));
  for (const s of sessions.values()) {
    if (s.rawTitle === undefined) continue; // a shell or task pane never had an OSC
    s.title = cleanTitle(s.rawTitle, s, titlePrefs);
  }
  renderAll();
  // Off for the keystroke path only: a repaint under a live <input> takes the caret with it.
  if (repaintSettings) renderSettings();
}

// Full renderAll: the badge, the tray title, group glyphs and rail highlights all read these.
export function setAttnPrefs(p: AttnPrefs) {
  setAttnPrefsState(p);
  localStorage.setItem("cc-attn", JSON.stringify(attnPrefs));
  renderAll();
  renderSettings(); // the preview row in Settings › Sessions replays at the new timing
}

// renderSettings only: nothing outside the Sounds tab shows this; ./chime reads soundPrefs live.
export function setSoundPrefs(p: SoundPrefs) {
  setSoundPrefsState(p);
  localStorage.setItem("cc-sound", JSON.stringify(soundPrefs));
  renderSettings();
}

// renderAll: switching it off must take "retrying in 2m" off the inspector at once. No
// schedule is cancelled explicitly; `reviveStep` returns `off` and each `Sess.revive` goes inert.
export function setRevivePrefs(p: RevivePrefs) {
  setRevivePrefsState(p);
  localStorage.setItem("cc-revive", JSON.stringify(revivePrefs));
  renderAll();
  renderSettings(); // the ladder preview redraws at the new timings
}

// renderSettings only: ./debug reads vitalsPrefs live on its tick, so no interval is rebuilt.
export function setVitalsPrefs(p: VitalsPrefs) {
  setVitalsPrefsState(p);
  localStorage.setItem("cc-vitals", vitalsPrefsJson(vitalsPrefs));
  renderSettings();
}

// Pushed onto every open pane as well as stored; xterm redraws itself, so renderSettings only.
export function setScrollback(lines: number) {
  setTermScrollbackState(lines);
  localStorage.setItem("cc-scrollback", String(termScrollback));
  applyScrollback(sessions.values(), termScrollback);
  renderSettings();
}

export function openDevtools() {
  void invoke("open_devtools").catch((e) => { dlog("warn", `devtools open failed: ${e}`); toast("Could not open the inspector"); });
}

// Reload the webview, keeping every session: the backend owns the PTYs and `adoptOrphans`
// re-adopts each pane with its scrollback. Asked first because a keystroke mid-prompt
// would be lost while the panes rebuild.
export async function reloadUi() {
  const ok = await ask(
    "Reload the interface?\n\nEvery session keeps running — the terminals are held by Episko itself and each pane is re-adopted with its scrollback.\n\nThis clears whatever the interface has accumulated, which is what makes it responsive again.",
    { title: "Reload interface", kind: "info", okLabel: "Reload", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  dlog("info", "reloading the webview by request (Settings › Diagnostics)");
  location.reload();
}

// ---------- the revive watchdog ----------
// The timer half of ./revive, which holds every rule. Polled on a fixed interval rather
// than scheduled to a deadline: the network coming back is not an event anything fires.

// `navigator.onLine` only says an interface is up, which is the right test for "did the
// Wi-Fi nap": a false positive costs one attempt, a false negative none (see `reviveStep`).
const online = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

// The two skip reasons worth a debug line; the rest fire every tick for every healthy session.
const LOUD_SKIPS = new Set(["offline", "exhausted"]);
const lastSkip = new Map<string, string>(); // last skip per session, so a repeat is logged once

/** One pass over the fleet. `reviveStep` decides everything; this only logs, sounds and repaints. */
export function tickRevive() {
  const now = Date.now(), net = online();
  let changed = false;
  for (const s of sessions.values()) {
    const act = reviveStep(s, revivePrefs, now, net);
    if (act.do === "none") {
      if (LOUD_SKIPS.has(act.why) && lastSkip.get(s.id) !== act.why) {
        lastSkip.set(s.id, act.why);
        dlog("info", `revive ${s.id.slice(0, 8)} · ${act.why === "offline" ? "network is down — holding the attempt" : "gave up; waiting for you"}`);
      }
      continue;
    }
    lastSkip.delete(s.id);
    s.revive = act.state;
    changed = true;
    if (act.do === "schedule") {
      dlog("info", `revive ${s.id.slice(0, 8)} · ${s.apiErr?.kind ?? "?"} · try ${act.state.attempts + 1}/${revivePrefs.attempts} in ${reviveGap(act.state.dueAt - now)}`);
      continue;
    }
    if (act.do === "giveup") {
      // The one moment this feature may make a noise: every retry before it was Episko's to handle.
      dlog("warn", `revive ${s.id.slice(0, 8)} · gave up after ${act.state.attempts} tries`);
      playSound("error");
      continue;
    }
    // The ONE place in the app that presses Enter for you (CLAUDE.md): the premise here
    // is that no human is awake to press it.
    dlog("info", `revive ${s.id.slice(0, 8)} · sending continue ${act.state.attempts}/${revivePrefs.attempts}`);
    const sid = s.id;
    void invoke("write_pty", { sessionId: sid, data: act.prompt })
      .then(() => invoke("write_pty", { sessionId: sid, data: "\r" }))
      .catch((e) => dlog("error", `revive ${sid.slice(0, 8)} · write failed: ${e}`));
  }
  // Closed panes leave a key behind and this runs forever; keep the map from growing.
  if (lastSkip.size > sessions.size) for (const id of lastSkip.keys()) if (!sessions.has(id)) lastSkip.delete(id);
  if (changed) renderAll();
}

// Full renderAll: sidebar titles, the footer popover and the palette hints all spell chords.
// Only the overrides persist, so a default improved later still reaches every install.
export function setKeyPrefs(p: KeyPrefs) {
  setKeyPrefsState(p);
  // Nothing stored while everything is standard, so a reset install equals a fresh one.
  if (isDefaultKeyPrefs(keyPrefs)) localStorage.removeItem("cc-keys");
  else localStorage.setItem("cc-keys", JSON.stringify(serializeKeyPrefs(keyPrefs)));
  renderAll();
  renderSettings();
}

// ---------- the user's named groups of projects ----------
// ./projgroups computes, this persists and repaints. A mutator returns the store it was
// handed when there is nothing to do, so a no-op costs no write and no sidebar repaint.
// renderSidebar rather than renderAll: nothing else in the app shows a group.
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
export function deleteProjectGroup(gid: string) {
  const g = groupById(projGroups, gid);
  if (!g) return;
  commitProjGroups(deleteGroup(projGroups, gid));
  toast(`Ungrouped ${g.name}. The projects stay`);
}
export function toggleProjGroup(gid: string) {
  const g = groupById(projGroups, gid);
  if (g) commitProjGroups(setCollapsed(projGroups, gid, !g.collapsed));
}
export function collapseAllProjGroups(collapsed: boolean) { commitProjGroups(collapseAll(projGroups, collapsed)); }

// The toast does real work: this is the one preference that can turn the cockpit off.
export function setDefaultAgent(id: string) {
  setDefaultAgentState(id);
  localStorage.setItem("cc-agent", defaultAgent);
  const a = agentDef(defaultAgent);
  toast(a
    ? `New sessions run ${a.label}${a.capabilities.includes("session-state") ? " — inspector connected" : " — terminal only"}`
    : "New sessions use the available default agent");
  renderSettings();
}
// `null` clears the override ("follow the global setting") rather than being a third state.
export function setProjectAgent(colorKey: string, id: string | null) {
  setProjectAgentState(colorKey, id);
  localStorage.setItem("cc-agent-by-project", JSON.stringify(agentByProject));
  const a = effectiveAgent(colorKey);
  toast(id ? `${basename(colorKey)} runs ${a.label}` : `${basename(colorKey)} follows the default (${a.label})`);
  renderAll();
}

// Which account this project's `gh` calls run as; `null` follows gh's active account. It
// must also forget what the previous identity answered: `gh_threads`, the day's activity
// and the merged-PR evidence are cached per repo, hence `gh_invalidate`.
export function setProjectGhAccount(colorKey: string, login: string | null) {
  setProjectGhAccountState(colorKey, login);
  localStorage.setItem("cc-gh-account", JSON.stringify(ghAccountByProject));
  void invoke("gh_invalidate", { root: colorKey }).catch(() => {});
  toast(login
    ? `${basename(colorKey)} reads GitHub as ${login}`
    : `${basename(colorKey)} follows gh's active account`);
  ghReload(colorKey);
  renderAll();
}

// Asked at startup and before any account picker is built, so `gh auth login` shows up
// without a restart. Cheap: the backend caches the answer for 60s.
export async function refreshGhAccounts(): Promise<GhAccount[]> {
  const a = await invoke<GhAccount[]>("gh_accounts").catch(() => [] as GhAccount[]);
  setGhLogins(a);
  return a;
}

// Announced because a pane started in Bypass never raises a permission card, so there is
// no later moment the choice becomes visible. Only new launches move.
export function setPermMode(provider: string, requested: string) {
  const mode = providerPermissionMode(provider, requested);
  if (!mode) return;
  setPermissionModeState(provider, mode.id);
  localStorage.setItem("cc-perm-modes", JSON.stringify(permissionModes));
  // The old Claude key stays for a downgrade and local tooling; nothing new reads it for another provider.
  if (provider === CLAUDE_CLI.id) localStorage.setItem("cc-perm-mode", mode.id);
  const label = providerAdapter(provider)?.label || provider;
  toast(mode.id === "default"
    ? `New ${label} sessions follow ${mode.label}`
    : `New ${label} sessions start in ${mode.label} mode`);
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
export function setFootSeg(id: FootSeg) {
  setFootPrefs(toggleFootSeg(footPrefs, id));
  localStorage.setItem("cc-foot", footPrefsJson(footPrefs));
  renderAll();
}

export function setFx(id: VisualFx) {
  setMotionPrefsState(toggleFx(motionPrefs, id));
  localStorage.setItem("cc-motion", motionPrefsJson(motionPrefs));
  applyFx();
}

// Remove every ./motion class before adding the current set: the prefs and the window
// focus change independently, so no caller could toggle a single class correctly.
export function applyFx() {
  const root = document.documentElement;
  root.classList.remove(...ALL_FX_CLASSES);
  root.classList.add(...rootFxClasses(motionPrefs, winFocused));
}

export function setWindowFocused(v: boolean) {
  if (v === winFocused) return;
  setWinFocusedState(v);
  applyFx();
}
export function toggleRail() { $("app").classList.toggle("rail-mini"); }
// ⌘I / ◨. On a session this hides the inspector; on the dashboard it collapses to an icon
// rail instead, since the worktree dialog, the graph and the folder are reachable only there.
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
// Two repairs (docs/worktrees.md). via "cwd": Claude already runs there, so adopt the
// folder in place. via "write": only the writes moved, and `claude --resume` finds a
// transcript only under its cwd, so kill, wait for `pty-exit`, move, relaunch, in that order.
const KILL_WAIT_MS = 5000; // a wedged process must not strand the pane; past this the move is tried anyway

export async function followSessionDrift(id: string) {
  const s = sessions.get(id);
  if (!s?.drift) return;
  const { dir, branch, via } = s.drift;

  if (via === "cwd") {
    // No confirm: nothing is destroyed or written; Episko only catches up with the session.
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

  // Captured before the close: the fallback relaunch rebuilds the session as it was.
  const { project, colorKey, workdir, resumeId, worktree: wasWt, branch: wasBranch } = s;
  // Wait for `pty-exit`, not for `kill_session` (which only sends the signal): renaming the
  // transcript while it is open fails on Windows and corrupts on POSIX. Waiter before the
  // kill, or a fast exit resolves nothing; close after, since `closeSession` settles waiters.
  const dead = waitForExit(id);
  await invoke("kill_session", { sessionId: id }).catch(() => {});
  await Promise.race([dead, new Promise((r) => setTimeout(r, KILL_WAIT_MS))]);
  closeSession(id);

  let moved = true;
  try {
    await invoke("move_session_transcript", { sessionId: resumeId, fromWorkdir: workdir, toWorkdir: dir });
  } catch (e) {
    // Nothing was moved: relaunch where it was, not in a folder its conversation is not in.
    moved = false;
    toast("Couldn't move the session: " + e);
  }
  await launch(project, moved ? dir : workdir, {
    colorKey,
    // Drifting into the repo's main checkout is not a worktree; `colorKey` is the repo root.
    worktree: moved ? (dir === colorKey ? null : branch) : wasWt,
    branch: moved ? branch : wasBranch,
    resume: resumeId,
  });
  if (moved) toast(`Session moved to ${branch}`);
}
