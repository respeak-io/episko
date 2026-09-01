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
import type { SoundPrefs } from "./sound";
import { canShelve, CLAUDE_CLI, midWork, phaseText } from "./types";
import { resolveProviderPermission } from "./providers/control";
import { removePermission } from "./permissions";
import { providerAdapter, providerPermissionMode } from "./providers";
import { reviveGap, reviveStep, type RevivePrefs } from "./revive";
import { playSound } from "./chime";
import { dlog } from "./debug";

// Every action here ends in a repaint of everything, which main.ts owns.
let renderAll: () => void = () => {};
export function setActionsRenderAll(fn: typeof renderAll) { renderAll = fn; }

/// Re-read one project's GitHub half, if the dashboard happens to be open on it.
///
/// ./dashboard sits above this layer and owns the fetch, so the one thing an account
/// change needs from it arrives as a settable hook rather than an import — the second
/// resolution in PLAN's order, and the same shape as `setActionsRenderAll` above. A
/// no-op default is the honest behaviour when no dashboard is on screen.
let ghReload: (root: string) => void = () => {};
export function setGhReload(fn: typeof ghReload) { ghReload = fn; }

// A plain shell in a project's folder — embedded gets an in-app pane, the external
// engines their own window. Here rather than in ./projmenu because the context menu,
// the project dashboard and (soon) the checkouts overlay all want it, which is this
// module's whole reason to exist.
export function openTerminalIn(project: string, dir: string) {
  if (termEngine !== "embedded") { invoke("open_terminal_here", { workdir: dir, engine: termEngine }).catch((e) => toast("terminal: " + e)); return; }
  void launchShell(project, dir, { colorKey: dir });
}
/// The one copy-a-path in the app: the project menu's row, the Context card and the
/// explorer's ⌥↵ all land here.
///
/// Through the Tauri plugin rather than `navigator.clipboard`, which is the same reason
/// the terminal panes use it: the web API raises an OS permission prompt in a webview,
/// and a prompt is a strange answer to "copy this path". Two back-ends for one verb is
/// also how the wording and the failure path drift apart.
export async function copyPath(dir: string) {
  try { await writeText(dir); toast("Path copied"); }
  catch { toast(dir); } // clipboard denied — at least show what it was
}

export async function openProjectFolder(key: string) {
  try { await invoke("open_folder", { dir: key }); }
  catch (e) { toast(String(e)); }
}

// The inspector's Context rows: click a file to open it, ⌂ to show it in the file
// manager. Both take the absolute path normalized as an event enters session state —
// which is exactly why both surface the backend's error rather than swallowing it. An agent's file set
// outlives the files in it: it reads a path in a worktree that is later removed, writes
// a temp file it then deletes, and the row for either is still sitting in the card. A
// silent no-op there reads as a broken button; "no such file" reads as the truth.
export async function openTouchedFile(path: string) {
  try { await invoke("open_file", { path }); }
  catch (e) { toast(String(e)); }
}
export async function revealTouchedFile(path: string) {
  try { await invoke("reveal_file", { path }); }
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
/// Shelve one session, asking first if it is in the middle of something.
///
/// The verb three surfaces trigger — the stage header's ⇩, the palette's row, and
/// nothing else owns it — which is what puts it here rather than in ./panes beside the
/// mechanism it calls. The confirmation is the whole difference from `shelveSession`:
/// the sign-off sheet calls that one directly, having already asked about the fleet.
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
    resolveProviderPermission(owner, id, behavior).catch(() => {});
  } else {
    // An unrouted Claude hook can still be held open in the backend. There is no
    // session object to dispatch through, so release that legacy transport directly.
    invoke("resolve_permission", { id, behavior }).catch(() => {});
  }
  if (owner) removePermission(owner, id);
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

// The trunk a project's branches are measured against. Same shape, minus the repaint:
// the only surface that reads it is the ⑃ dialog, which re-reads git itself after this
// (the numbers come from `git_branch_list`, so a repaint alone would show the old ones).
export function setCmpBase(repoDir: string, ref: string) {
  setCmpBaseState(repoDir, ref);
  localStorage.setItem("cc-cmp-base", JSON.stringify(cmpBase));
}

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

// The same shape once more for the finish highlight and the "your turn" queue. This
// one takes the full `renderAll`: the badge's contents, the tray title, a collapsed
// group's warning glyph and the rail's highlights are all downstream of these four
// values, and switching the highlight off has to take a lit row's class back off rather
// than leaving it glowing until its timer happens to fire.
export function setAttnPrefs(p: AttnPrefs) {
  setAttnPrefsState(p);
  localStorage.setItem("cc-attn", JSON.stringify(attnPrefs));
  renderAll();
  renderSettings(); // the preview row in Settings › Sessions replays at the new timing
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

// And for the revive watchdog. `renderAll` rather than `renderSettings` alone, because
// switching it off has to take the "retrying in 2m" line back off the inspector's error
// card immediately — a session that is no longer being retried must not go on saying it
// is. Turning it off never cancels a schedule explicitly: `reviveStep` returns `off`
// before it looks at anything, so every existing `Sess.revive` becomes inert on the
// spot and is cleared by the next turn that ends cleanly.
export function setRevivePrefs(p: RevivePrefs) {
  setRevivePrefsState(p);
  localStorage.setItem("cc-revive", JSON.stringify(revivePrefs));
  renderAll();
  renderSettings(); // the ladder preview redraws at the new timings
}

// And for the vitals recorder. `renderSettings` alone, like the sounds above: the series
// has exactly one surface, the tab the switch is on. ./debug reads `vitalsPrefs` live on
// its tick, so nothing has to be pushed to it and no interval is rebuilt — see the note
// on `tickVitals` for why that matters more here than it looks.
export function setVitalsPrefs(p: VitalsPrefs) {
  setVitalsPrefsState(p);
  localStorage.setItem("cc-vitals", vitalsPrefsJson(vitalsPrefs));
  renderSettings();
}

// The scrollback limit, pushed onto every pane already open as well as stored for the
// next one. `renderSettings` alone: xterm redraws its own viewport when the buffer
// changes and nothing else in the app displays a line count — the Diagnostics readout
// picks the new total up on its next sample rather than being repainted at it.
export function setScrollback(lines: number) {
  setTermScrollbackState(lines);
  localStorage.setItem("cc-scrollback", String(termScrollback));
  applyScrollback(sessions.values(), termScrollback);
  renderSettings();
}

// The webview's inspector. Nothing to persist and nothing to repaint — the window it
// opens is the browser's, not ours.
export function openDevtools() {
  void invoke("open_devtools").catch((e) => { dlog("warn", `devtools open failed: ${e}`); toast("Could not open the inspector"); });
}

/// Reload the interface, keeping every session.
///
/// This is the documented workaround for the renderer going sluggish after a long day,
/// and it is a button rather than folklore for one reason: it *looks* like it should
/// kill your fleet, so without something in the app saying otherwise nobody reaches for
/// it. Nothing is lost — the backend owns the PTYs, and `adoptOrphans` re-adopts every
/// pane from `live_sessions` on the way back up, replaying each one's scrollback from the
/// backend's own ring.
///
/// Asked rather than done, because "every pane rebuilds itself" is a visible few seconds
/// and a keystroke mid-prompt would be lost in it.
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
// The timer half of ./revive: every rule lives there and is tested, so this only asks
// what to do and does it. Driven by a fixed interval from main.ts rather than a timeout
// scheduled to `reviveDeadline`, for a reason specific to what this waits for — the
// machine's network coming back is not an event anything fires, so there is nothing to
// schedule against, and a poll is the only thing that notices.

/// Whether the machine currently thinks it has a network. Weak on purpose and exactly
/// strong enough: `navigator.onLine` only knows whether an interface is up, which is a
/// terrible test for "is the API reachable" and a very good one for "did the Wi-Fi nap",
/// and the second is the failure this feature was written for. A false positive costs
/// one attempt; a false negative costs nothing at all, because being offline does not
/// consume one (see `reviveStep`).
const online = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

/// Skip reasons worth a line in the debug console. The other six fire on every tick for
/// every healthy session in the fleet and would bury the log within a minute; these two
/// are the ones somebody is actually asking about at 08:00 — "it was waiting for the
/// network" and "it had already given up".
const LOUD_SKIPS = new Set(["offline", "exhausted"]);
/// What each session's last skip was, so a repeated reason is logged once rather than
/// six times a minute. Keyed by session id and cleaned as sessions go.
const lastSkip = new Map<string, string>();

/**
 * One pass over the fleet: schedule, send, or give up on each failed session.
 *
 * Everything that could be wrong to do is decided by `reviveStep`; the only judgement
 * here is about output — what gets logged, what makes a noise, and when to repaint.
 */
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
      // The one moment this feature is allowed to make a noise. Every failure in between
      // was silent by design (see `soundSnap` in ./sound) — Episko was handling those,
      // and a buzz per retry is six alarms for one outage. This is the one that means
      // something changed for the human: nobody is coming, the session is yours.
      dlog("warn", `revive ${s.id.slice(0, 8)} · gave up after ${act.state.attempts} tries`);
      playSound("error");
      continue;
    }
    // `do === "send"`. Two writes, exactly as the dashboard's dispatch does it: the text,
    // then the Enter. This is the ONE place in the app that presses Enter for you —
    // ./taskrun's `sendOutputToSession` deliberately stops at the prefill so a human
    // commits it — and the departure is the whole point, since the entire premise here is
    // that there is no human awake to press it.
    dlog("info", `revive ${s.id.slice(0, 8)} · sending continue ${act.state.attempts}/${revivePrefs.attempts}`);
    const sid = s.id;
    void invoke("write_pty", { sessionId: sid, data: act.prompt })
      .then(() => invoke("write_pty", { sessionId: sid, data: "\r" }))
      .catch((e) => dlog("error", `revive ${sid.slice(0, 8)} · write failed: ${e}`));
  }
  // Closed panes leave their last skip reason behind, and this runs forever. Tiny, but a
  // map keyed by session id that nothing ever removes from is how a long-running app
  // grows a leak nobody looks for.
  if (lastSkip.size > sessions.size) for (const id of lastSkip.keys()) if (!sessions.has(id)) lastSkip.delete(id);
  if (changed) renderAll();
}

// And once more for the keyboard shortcuts. This one DOES take the full `renderAll`,
// unlike the two above: a chord is written into the sidebar's and mini-rail's button
// titles as well as the footer's popover and the palette's hints, so every surface
// that spells one has to be repainted or half the app would go on advertising the
// chord you just replaced. Rebinding is a rare, deliberate press, and renderAll is
// coalesced to one frame anyway.
//
// Only the *overrides* are persisted, so a default improved in a later release still
// reaches an install that never touched that row — and a picker reset back to the
// shipped chords drops the key rather than freezing today's defaults into it.
export function setKeyPrefs(p: KeyPrefs) {
  setKeyPrefsState(p);
  // Nothing stored while everything is standard AND switched on, so a fresh install
  // and one that has been reset back are the same install.
  if (isDefaultKeyPrefs(keyPrefs)) localStorage.removeItem("cc-keys");
  else localStorage.setItem("cc-keys", JSON.stringify(serializeKeyPrefs(keyPrefs)));
  renderAll();
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
  toast(`Ungrouped ${g.name}. The projects stay`);
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
// Which agent a new session runs (Settings › Sessions). Persisting lives here rather
// than in state.ts for the usual reason — a `setX` there assigns and nothing else — and
// the toast is doing real work: this is the one preference that can turn the cockpit
// off, so the moment you change it is the moment to say what you have just lost.
export function setDefaultAgent(id: string) {
  setDefaultAgentState(id);
  localStorage.setItem("cc-agent", defaultAgent);
  const a = agentDef(defaultAgent);
  toast(a
    ? `New sessions run ${a.label}${a.capabilities.includes("session-state") ? " — inspector connected" : " — terminal only"}`
    : "New sessions use the available default agent");
  renderSettings();
}
// The per-project override, set from a project's own menu. `null` clears it, which is
// the row that says "follow the global setting" rather than a third state.
export function setProjectAgent(colorKey: string, id: string | null) {
  setProjectAgentState(colorKey, id);
  localStorage.setItem("cc-agent-by-project", JSON.stringify(agentByProject));
  const a = effectiveAgent(colorKey);
  toast(id ? `${basename(colorKey)} runs ${a.label}` : `${basename(colorKey)} follows the default (${a.label})`);
  renderAll();
}

/// Which of your GitHub accounts this project's `gh` calls run as. `null` clears the
/// pin, which is the row that says "follow gh's active account" rather than a third
/// state — the same shape as the agent override above it.
///
/// The pin is read per call (`ghAccountFor`) and passed to the backend as an argument,
/// so this stores one thing in one place. What it must also do is **forget what the
/// previous identity answered**: `gh_threads`, the day's activity and the merged-PR
/// evidence are all cached per repo for a minute, and every one of those answers was
/// given by the account we have just stopped using.
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

/// Re-read which accounts `gh` is logged in to.
///
/// Fired at startup and whenever a surface that offers the choice is about to be built,
/// because `gh auth login` in a terminal must show up without restarting Episko. It is
/// cheap to ask often: the backend holds the answer for the same 60s a board read is
/// cached for, so this is usually a round trip to a lock.
export async function refreshGhAccounts(): Promise<GhAccount[]> {
  const a = await invoke<GhAccount[]>("gh_accounts").catch(() => [] as GhAccount[]);
  setGhLogins(a);
  return a;
}

export function setPermMode(provider: string, requested: string) {
  const mode = providerPermissionMode(provider, requested);
  if (!mode) return;
  setPermissionModeState(provider, mode.id);
  localStorage.setItem("cc-perm-modes", JSON.stringify(permissionModes));
  // Keep the old Claude key for a downgrade and for existing local tooling that reads
  // it. New code never uses it as another provider's preference.
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
/// Which window the inspector's read/written total covers. Persisted, because it is a
/// preference — somebody who wants "this run" wants it on the next pane too, and having
/// to re-pick it per session is what makes a cycling control annoying rather than handy.
/// Show or hide one status-bar segment.
///
/// Here rather than in ./state because a setter there assigns and nothing else: the
/// persist and the repaint belong to the call site, and this is it. (A settings picker
/// that called the state setter directly is how a preference shipped once that never
/// survived a restart.)
export function setFootSeg(id: FootSeg) {
  setFootPrefs(toggleFootSeg(footPrefs, id));
  localStorage.setItem("cc-foot", footPrefsJson(footPrefs));
  renderAll();
}

/// Switch one visual effect on or off.
///
/// Here rather than in ./state for the usual reason: a setter there assigns and nothing
/// else, so the persist and — in this case — the class that actually makes the change
/// visible belong to the call site, and this is it.
export function setFx(id: VisualFx) {
  setMotionPrefsState(toggleFx(motionPrefs, id));
  localStorage.setItem("cc-motion", motionPrefsJson(motionPrefs));
  applyFx();
}

/// Put the current effect state on `<html>`, where the stylesheet reads it.
///
/// Every class ./motion can produce is removed before the current set is added, rather
/// than each site toggling its own: the two inputs (the prefs and the window's focus)
/// change independently and at unrelated moments, so a per-class toggle would need every
/// caller to know about every class. Called on startup, on a pref change, and on each
/// focus change.
export function applyFx() {
  const root = document.documentElement;
  root.classList.remove(...ALL_FX_CLASSES);
  root.classList.add(...rootFxClasses(motionPrefs, winFocused));
}

/// The window gained or lost focus. Cheap enough to call on every event — `applyFx` is
/// three class operations and the browser no-ops a class list that did not change.
export function setWindowFocused(v: boolean) {
  if (v === winFocused) return;
  setWinFocusedState(v);
  applyFx();
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
