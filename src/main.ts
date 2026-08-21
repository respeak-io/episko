import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { isClaude, isExited, type AgentCli } from "./types";
import { $, chord, IS_MAC, IS_TAURI, IS_WIN, toast } from "./dom";
import { updateTray } from "./tray";
import {
  closeAttnPop, closeCostPop, closeEnginePop, closeFootMenus, closeIoPop, closeShortPop,
  closeUsagePop,
  refreshTokens, renderAttn, renderFoot, setEngine, setFooterCloseColorPop,
  setFooterSetActive,
} from "./footer";
import { closePalette, openPalette, setPaletteHost } from "./palui";
import {
  closeColorPop, closeCtxMenu, ctxMenuOpen, openColorPopover, setProjMenuHost,
} from "./projmenu";
import { renderInspector, setCtxMode, tickDwell, toggleFileGroup } from "./inspector";
import {
  callSheetOpen, closeCallSheet, copySelectedCall, openCallSheet, renderCallSheet, selectCall,
} from "./callsheet";
import { applyFontSize, bumpFont, refit, trimScrollback } from "./terminal";
import {
  addProject, addProjectPath, cycleSort, effectiveTheme, openProjectFolder,
  followSessionDrift, openTouchedFile, removeFavorite, resolvePermission, revealActiveFolder,
  revealTouchedFile,
  copyPath, openTerminalIn, setActionsRenderAll, setAttnPrefs, setDefaultAgent, setKeyPrefs,
  setPeekPrefs, setPermMode, setProjectAgent,
  setFootSeg, setSort, setSoundPrefs, setTheme, setWtGroup, setCmpBase, toggleInsp, toggleProjGroup,
  toggleRail, toggleTheme,
} from "./actions";
import { playSound, setSoundLogger } from "./chime";
import { exitSound, hookSound, limitCrossed, soundSnap } from "./sound";
import {
  activeCwd, activeProjectCtx, closeRunGroup, closeSession, focusInGroup, handToTerminal,
  adoptOrphans, launch, launchShell, launchTask, launchWorktree, noteDrift,
  noteGitCommand, openPlainTerminal, openRunGroup, pollIo, refreshGitViews,
  refreshPaneCaps, refreshSessionStats, renderHeader, requestLaunch, runGit,
  scheduleDismiss, setActive, setPanesRenderAll, syncStageButtons, toggleRunGroup,
} from "./panes";
import {
  maybeRunOnStop, setTaskRunCloseSession, setTaskRunLaunchTask, setTaskRunSetActive,
} from "./taskrun";
import {
  flushRoster, forgetDormant, jumpExternal, loadDormants, openDormant, openExternal,
  queueRosterSave, refreshDirtyStates, refreshExternals,
  renderExtHeader, renderExtInspector, renderPastHeader, renderPastInspector,
  resumeDormant, setMirrorLaunch, setMirrorRenderAll, setMirrorSetActive,
} from "./mirror";
// Self-update exports nothing this file needs: it owns its footer chip, its own
// listeners and the quiet check at launch, so importing it *is* wiring it.
import "./update";
import { probeIcon, setIconRenderMini, setIconRenderSidebar } from "./icons";
import {
  closePeek, initFileDrop, initProjectDnD, initSidebarPeek, renderMini, renderSidebar,
  reorderGuardUntil, setReorderGuard, setSidebarRenderAll, setSidebarSetSort,
} from "./sidebar";
import {
  closeBranchPop, closeWt, setWtCloseSession, setWtHandToTerminal,
  openBranchPop, setWtLaunch, setWtRefreshGit, setWtRenderAll,
  setWtSaveCmpBase, setWtSetActive,
} from "./worktree";
import {
  dbgLog, dbgSnapshot, dlog, flushDebug, renderDbgBadge, renderDbgPanel, telem,
  toggleDbg,
} from "./debug";
import { basename, setHome } from "./format";
import { rl, setRlLogger } from "./rl";
import { closeCafPop, reconcileCaf, setCafHost } from "./caffeinate";
import { closeDiff, diffOpen, openDiff, setDiffCloseFootMenus } from "./diffview";
import { closeExplorer, explorerOpen, openExplorer, setExplorerCloseFootMenus } from "./explorer";
// The commit-graph panel needs nothing from here — it is opened from the project
// context menu (./projmenu) and owns its own handlers; this file only has to close it
// with the shared scrim and Esc, like every other dialog.
import { closeGraph, graphEscape, graphOpen, openGraph as openGraphFor } from "./graphview";
import { changelogOpen, closeChangelog, initChangelog } from "./changelogui";
import {
  closeDashboard, dashEscape, dashLaunchHint, openDashboard, releaseClaimFor, renderDash,
  renderDashHeader, renderDashInspector, setDashHost, wireDashboard,
} from "./dashboard";
import {
  closeInputPrompt, closeRunPicker, closeTaskManager, mgrEdit, openRunPicker,
  renderMgr, runDefaultTask, setMgrEdit, setTaskUiHost,
} from "./taskui";
import {
  closeSettings, keyRecording, openSettings, renderSettings, setSettingsHost, setTab,
  settingsOpen,
} from "./settings";
import { closeHistory, histOpen, initHistoryEvents, openHistory } from "./historyui";
import {
  applyHook, applyStatusline, permCmd, riskLevel, setOnSessionTouched, setOnTurnEnd,
  setPhase,
} from "./phase";
import {
  activeId, ALL_ENGINES, availEngines, dashMirror, dormants, externals, extMirrorId,
  FAVORITES, keyPrefs, markWorkdirStale, mirror, pastMirrorId, sessions, setAvailAgents, setAvailEngines,
  setTermEngine, setTermFontSize, sortMode, stageGroup, termEngine,
} from "./state";
import { activeBind, comboMatches, digitOf, matchAction, type KeyAction } from "./keys";
import { orderedSessions, syncAttn } from "./grouping";
import { flushIo, flushUsageDetail } from "./usage";
import {
  exitWaiters, setTaskLauncher, setTaskLogger, setTaskRepaint, setTaskToast,
} from "./tasks";

// One-time recovery of localStorage stranded when the app was renamed
// Muster -> Episko: the bundle id changed (io.respeak.cclauncher ->
// io.respeak.episko) and macOS keys a WKWebView's localStorage to that id, so
// the renamed app opened a fresh, empty store. The backend reads the old store
// off disk (`read_legacy_localstorage`, macOS-only; returns {} elsewhere) and
// we import any `cc-*` key this store is MISSING — fill-absent only, so an
// install that already has its own data is never clobbered. Guarded by a flag
// so it runs at most once; a fresh upgrader (empty store) reloads once to boot
// with the restored data. Fire-and-forget: the module-scope reads below run on
// this first (empty) pass, then the reload re-enters with everything present.
void (async () => {
  const DONE = "cc-legacy-import-done";
  if (localStorage.getItem(DONE)) return;
  try {
    const legacy = await invoke<Record<string, string>>("read_legacy_localstorage");
    let imported = 0;
    for (const k in legacy) {
      if (k.startsWith("cc-") && localStorage.getItem(k) === null) {
        localStorage.setItem(k, legacy[k]);
        imported++;
      }
    }
    localStorage.setItem(DONE, new Date().toISOString());
    if (imported > 0) location.reload();
  } catch {
    // Command missing (non-macOS) or read failed: leave the flag unset so a
    // later launch can retry. Harmless — nothing was written.
  }
})();

// The app header IS the title bar — there is no native one behind it (see the
// window block in lib.rs) — but which half of that the CSS has to draw is a
// platform fact it cannot read. Stamp it here, at module scope, so the first
// paint already has it: macOS leaves room for its real traffic lights, Windows
// shows the controls wired below, and an unported Linux keeps its native frame
// and needs neither. **Nothing is stamped in a browser** — this same HTML opens
// on vite's port in dev, where there is no window behind it, so an unqualified
// `IS_WIN` (a user-agent read) would hand a Chrome tab three buttons that can
// only throw.
if (IS_TAURI) document.documentElement.classList.add(IS_MAC ? "mac" : IS_WIN ? "win" : "linux");

// index.html hard-codes the mac glyphs; rewrite its static bits once on other
// platforms (everything rendered from TS goes through MOD/chord instead, which now
// live in ./dom beside `$` — the sidebar, the palette and the footer all label
// controls with a chord, so no one of them can own it).
if (!IS_MAC) {
  document.querySelectorAll("kbd").forEach((k) => { if (k.textContent === "⌘") k.textContent = "Ctrl"; });
  document.querySelectorAll<HTMLElement>("[title]").forEach((el) => { if (el.title.includes("⌘")) el.title = el.title.replace(/⌘/g, "Ctrl+"); });
  const fk = document.querySelector(".fseg.fk");
  if (fk) fk.textContent = `${chord("K")} · ${chord("1")}–9 switch · ${chord("B")} sidebar · ${chord("I")} inspector · ${chord("±")} font`;
}
// termEngine itself lives in ./state (a persisted preference like the sort mode);
// this is only the validation against what this build actually offers.
if (!ALL_ENGINES.some((e) => e.id === termEngine)) setTermEngine("embedded");

// Persisted theme override (cc-theme). Absent → follow the OS via the CSS
// `color-scheme` default; an explicit value pins light/dark across restarts.
// Applied here at module start (before first paint) so the settings choice sticks.
{
  const savedTheme = localStorage.getItem("cc-theme");
  if (savedTheme === "dark" || savedTheme === "light") document.documentElement.setAttribute("data-theme", savedTheme);
}

// ---------- config ----------
// Home dir resolves at runtime (for `~` path abbreviation — see format.ts, which
// owns it). Favorites start empty and are added by the user — persisted to
// localStorage.
homeDir().then((h) => { setHome(h.replace(/[/\\]+$/, "")); }).catch(() => {});
// The leaf modules that need something only this layer can give them (PLAN's seam
// rule 2): rl.ts narrates a window close to the debug console, phase.ts hands the
// end of a turn to the run-on-stop rule, which owns panes and discovery, and
// tasks.ts needs all three of a pane to launch into, that console and the toast.
// All default to a no-op, so the modules stand alone in a test.
setRlLogger(dlog);
setOnTurnEnd((s) => { void maybeRunOnStop(s); });
// A settled tool call (or a finished turn) is the app's only warning that a session
// changed its checkout — nothing watches the filesystem. Two consequences, both cheap:
// the folder is queued for a working-set re-read, and a git command that could have
// moved HEAD or added a worktree pokes the git views straight away.
setOnSessionTouched((s, tool, data) => {
  markWorkdirStale(s, tool); noteGitCommand(data?.tool_input?.command); noteDrift(s, tool, data);
});
setTaskLauncher(launchTask);
setTaskLogger(dlog);
setTaskToast(toast);
setTaskRepaint(renderAll);
// Setting, clearing or re-probing a project's icon changes exactly the two surfaces
// that draw it.
setIconRenderSidebar(renderSidebar);
setIconRenderMini(renderMini);
// A finished project reorder reasserts manual sort mode and repaints everything.
setSidebarSetSort(setSort);
setSidebarRenderAll(renderAll);
// The exclusive-popover rule reaches the colour popover, which belongs to the project
// rows here, and the reactor badge puts a pane on the stage.
setFooterCloseColorPop(closeColorPop);
setFooterSetActive(setActive);
// A palette row can do almost anything the app can do, so the ⌘K UI takes one host
// rather than a dozen setters — the settings.ts deviation, for the same reason.
/// ⌘P — the explorer, on whatever owns the stage. Keyed by folder like the peek, and
/// resolved through `activeCwd()` so a worktree session explores its own checkout
/// rather than the repo it groups under — the same answer `❯ Terminal` gives.
function openProjectFiles() {
  const wd = activeCwd();
  if (!wd) { toast("No project on screen"); return; }
  void openExplorer(wd, basename(wd));
}
setPaletteHost({
  setActive, resolvePermission, openPlainTerminal, closeSession, addProject,
  cycleSort, toggleInsp, toggleRail, toggleTheme, requestLaunch,
  revealActiveFolder, openProjectFolder, openProjectFiles,
});
// Same reasoning, eight callees: a context-menu row starts panes and edits the project
// list, none of which the menu owns.
setProjMenuHost({
  renderAll, requestLaunch, launchWorktree, launchShell, setProjectAgent, openProjectFolder,
  addProjectPath, removeFavorite,
});
// Run-on-stop and the task inspector's actions reach back for three pane operations.
setTaskRunSetActive(setActive);
setTaskRunCloseSession(closeSession);
setTaskRunLaunchTask(launchTask);
// A pane's whole lifecycle ends in a repaint of everything, which this file owns.
setPanesRenderAll(renderAll);
// The small app-level verbs several surfaces trigger — pin a project, change the sort,
// flip the theme, answer a permission — all end in the same repaint.
setActionsRenderAll(renderAll);
// The read-only mirrors reconcile the stage when what they point at goes away, and a
// dormant row resumes into a real pane — neither of which they own.
setMirrorSetActive(setActive);
setMirrorLaunch(launch);
setMirrorRenderAll(renderAll);
// The settings window changes fourteen things it does not own; this is the whole of
// what it can reach back for.
setSettingsHost({
  setTheme, effectiveTheme, setSort, setEngine, bumpFont, applyFontSize, refreshTokens,
  setWtGroup, setPermMode, setDefaultAgent, setPeekPrefs, setSoundPrefs, setKeyPrefs, setAttnPrefs,
  setFootSeg,
});
// "Why was there no noise?" is otherwise unanswerable from outside the player.
setSoundLogger(dlog);
// The task panels run tasks, hand commands to terminals and put panes on stage —
// none of which they own.
// The dashboard acts on a project through verbs it does not own — the launcher, the
// worktree dialog, the task picker, the graph and History all live elsewhere.
setDashHost({
  launch: (project, workdir, opts) => launch(project, workdir, opts),
  requestLaunch: (project, path, known) => { requestLaunch(project, path, known); },
  openTerminal: (dir) => { openTerminalIn(dashMirror()?.name ?? basename(dir), dir); },
  // Keyed to the repo root, not to `dir`, so a shell opened for a refused git command
  // nests under the project rather than becoming a top-level group of its own.
  handToTerminal: (project, dir, cmd) => {
    void handToTerminal(project, dir, cmd, { colorKey: dashMirror()?.root ?? dir });
  },
  openRun: () => { void openRunPicker(); },
  openGraph: (root) => { void openGraphFor(root, dashMirror()?.name ?? basename(root)); },
  // The Branches view's other three seams: the roster re-read after a cleanup, and the
  // trunk chip's popover + its persisted choice. (Its refused `-D` goes to the same
  // `handToTerminal` above as ⇣ Pull's refusals.)
  refreshGit: () => refreshGitViews(),
  pickTrunk: (anchor, items, current, onPick) => { openBranchPop(anchor, items, current, onPick); },
  saveTrunk: (repoDir, ref) => { setCmpBase(repoDir, ref); },
  openHistory: () => { void openHistory(true); },
  openFolder: (dir) => { void openProjectFolder(dir); },
  copyPath: (dir) => { void copyPath(dir); },
  setActive,
  renderAll,
});
wireDashboard();
setCafHost({ closeFootMenus, renderFoot, renderAll });
setDiffCloseFootMenus(closeFootMenus);
setExplorerCloseFootMenus(closeFootMenus);
setTaskUiHost({
  launchTask, handToTerminal, activeProjectCtx, activeCwd,
  setActive, renderAll, closePalette,
});
// The new-session dialog decides *where* a session starts but cannot start one:
// panes, the stage and the repaint all belong to this file.
setWtLaunch(launch);
setWtCloseSession(closeSession);
setWtSetActive(setActive);
setWtRenderAll(renderAll);
setWtHandToTerminal(handToTerminal);
// …and removing one changes what checkouts exist, which only a git re-read notices.
setWtRefreshGit(refreshGitViews);
// The trunk a project's branches are measured against: a persisted preference, so the
// write is actions.ts's — reached as a hook because the direct import would close a cycle.
setWtSaveCmpBase(setCmpBase);
// The drag guard and the reorder click guard moved with the sidebar into ./sidebar.

// ---------- model ----------
// The shapes live in ./types and the state itself in ./state (see the imports at
// the top of this file); this is the behaviour that hangs off them. The xterm side of
// a pane — the font stack, attachWebgl/detachWebgl, fitSession/refit, the font-atlas reload and the
// OSC-title clean-up — is ./terminal, shared by all three spawners below.


// Panes — the three spawners (claude / shell / task), the session lifecycle around
// them, the stage's own chrome (renderHeader, syncStageButtons) and the two context
// resolvers every "…here" action starts from — moved to ./panes. What stays here is
// what reacts to a pane rather than owning one: the listen() handlers and renderAll().

// ---------- restorable sessions ----------
// `externals` and `dormants` are state, so they live in ./state alongside the
// session map. Everything that fills them — the roster, external discovery, the
// read-only transcript mirrors and their four render* functions — moved to ./mirror,
// which is the half of the app the `mirror` stage pointer refers to.

// The stage pointer (mirror / extMirrorId / pastMirrorId) now lives in ./state
// beside activeId — the two are mutually exclusive, so they belong together.

// Uncommitted git state keyed by folder (a session's workdir or an external's cwd),
// polled by refreshDirtyStates. It's the single source of truth for the sidebar's
// "has changes" dot and the external inspector's diff card: s.git only stays fresh
// for the *active* session, so nothing else can rely on it across every project.

// The per-project icon store (discovered, hand-picked, and the projGlyph that reads
// them) moved to ./icons — the sidebar, the mini-rail, the palette and the colour
// popover all read it, so it belongs below all four rather than inside one.






// External and dormant (restorable) sessions moved to ./mirror. What stays here is
// the stage's own half: renderHeader above, and the pointer arbitration in renderAll.

// ---------- telemetry ----------
// applyHook / applyStatusline and their helpers now live in ./phase; main.ts
// only wires them to the listen() handlers at the bottom of this file.

// ---------- rendering ----------
// The project/worktree grouping and the sidebar ordering now live in ./grouping;
// what follows is only the painting of what it returns. The sidebar and mini-rail
// themselves — with the project reorder and the file drop that ride them — moved to
// ./sidebar; what stays here is the stage: the header and the inspector.

// The task preference state — prefs, trust, pins, hidden ids, run-on-stop rules —
// moved to ./tasks, beside the runner override and remembered inputs it already had.

// ---------- runnables (tasks & scripts) ----------
// Discovery lives in Rust (src-tauri/src/tasks.rs) and only ever *parses* files — it
// never executes the project to find out what it can do. Of the frontend half, the
// decisions are in ./tasks, the two surfaces in ./taskui, and run-on-stop plus the
// task inspector's actions in ./taskrun. What stays here is launchTask: it opens a
// pane, which is this file's job.


// The package-runner override and the remembered ${input:…} values now live in
// ./tasks, beside the substitution that consumes them.




// "a, b and c" — the quit guard lists up to three kinds of running thing.
function listPhrase(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}



// The dependsOn chain — resolveDeps / launchWithDeps / waitForExit — now lives in
// ./tasks, which reaches launchTask below through setTaskLauncher.


// Discovery (discoverTasks / rescanTasks) moved to ./tasks — every input they read
// now lives there.

// The ${input:…} prompt moved into ./taskui, beside the picker and the panel that
// both reach it — so it stopped being a hook in two host objects and became a plain
// import (seam rule 1).


// The inspector moved to ./inspector: the dispatcher plus the shell and task cards,
// painted from the pure builders in ./inspectorview.

// The working-set diff viewer moved to ./diffview.
// Two more renderAll() surfaces moved out: the status bar and its popovers (with the
// header's reactor badge, which shares their exclusive-menu rule) to ./footer, and the
// menu-bar mirror to ./tray — a native surface, so its repaint is an IPC call rather
// than an innerHTML assignment, but it hangs off renderAll() like the rest.

// Coalesced: a mutation calls renderAll(), renderAll() only marks the pass due, and
// one flush per animation frame paints whatever state every event in that frame left
// behind. Telemetry arrives in bursts — N busy agents each fire a hook per lifecycle
// event plus a statusLine — and each full pass below is itself O(sessions), so paying
// one pass *per event* scaled roughly quadratically with the fleet and burned the main
// thread repainting states nobody could have seen. Every call site keeps its contract
// ("every mutation ends by calling renderAll()"); only the paint is batched.
//
// The timeout is not a belt-and-braces double: rAF does not fire while the window is
// hidden, and the tray menu — repainted by this same pass — is exactly the surface
// being read while the window is hidden. A backgrounded WebView throttles timers to
// ~1s, which is still fresh enough for a menu. Whichever fires first wins and cancels
// nothing it doesn't have to: a late rAF/timeout meeting `renderPending === false`
// simply returns.
//
// Exported for measurement only — the debug console and a devtools session can reach
// it, but no module may import main.ts (it is the top of the graph).
let renderPending = false;
let renderFallback = 0;
export function renderAll() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(flushRender);
  renderFallback = window.setTimeout(flushRender, 250);
}
function flushRender() {
  if (!renderPending) return;
  renderPending = false;
  clearTimeout(renderFallback);
  renderAllNow();
}
function renderAllNow() {
  telem.renders++; // the coalescing is invisible unless the 🐞 console can count it
  // BEFORE anything paints. Five different things can put a session into (or out of)
  // the needs-you set, one of which is a fan-out's grace window expiring with no event
  // at all — so the stamp every attention surface below reads is refreshed here, once,
  // rather than at each of them. See syncAttn in ./grouping.
  syncAttn();
  renderSidebar(); renderMini(); renderFoot(); renderAttn(); syncStageButtons();
  // A tiled pane's caption carries live state (elapsed, exit code, the ✕ a finished run
  // keeps), and panes are outside the render-everything sweep — so it has to be asked
  // for. No-ops unless a group is actually tiled.
  refreshPaneCaps();
  // When mirroring an external session, activeId is null but the stage/inspector
  // belong to that external — render it, NOT the null "no session" state. Skipping
  // this is what let a background Episko session's telemetry tick blank the
  // external header/inspector ~1s after clicking it.
  if (dashMirror()) {
    renderDashHeader(); renderDashInspector(); renderDash();
  } else if (pastMirrorId()) {
    const d = dormants.find((x) => x.id === pastMirrorId());
    if (d) { renderPastHeader(d); renderPastInspector(d); }
  } else if (extMirrorId()) {
    const e = externals.find((x) => x.session_id === extMirrorId());
    if (e) { renderExtHeader(e); renderExtInspector(e); }
  } else {
    const s = activeId ? sessions.get(activeId) ?? null : null;
    renderInspector(s); renderHeader(s);
  }
  // Live while it is open: a call landing on the session it is showing has to reach it.
  // No-op when it is closed, and internally guarded so the block you are selecting text
  // in is not reassigned under the pointer (see renderCallSheet).
  renderCallSheet();
  updateTray();
  reconcileCaf(); // agent-aware mode follows the fleet's phases; no-op otherwise
}

// The debug console moved to ./debug — it owns its panel, its ring buffer and
// the telemetry counters. The button listeners and the flush interval stay here.

// The ⌘K palette moved to ./palui, beside the ./palette that already held its
// decisions — its own key handling went with it, and the global ⌘K below only
// toggles it. It reaches everything a palette row can do through one host object.

// ---------- settings ----------
// The window main.ts has wanted for a while: it finally gives the worktree-grouping
// mode a control (it was reachable only as episkoWtGroup() in the console), and it
// owns the task settings that would otherwise be hardcoded bets.

// ---------- panels / theme ----------
// The app-level verbs — pin/unpin a project, the sort mode, the rail and inspector
// toggles, the theme, the worktree grouping, answering a permission — moved to
// ./actions. Several surfaces trigger each of them and none owns it.


// The new-session/worktree dialog and the branch chooser moved to ./worktree —
// state, markup, git calls and its own click/key handlers, all of it. main.ts
// only opens it (openWt) and closes it with the shared scrim.

// The settings window moved to ./settings — tabs, controls, dispatcher and its
// own handlers. It reaches back for the things it changes but does not own
// (theme, sort, engine, font, token scan) through setSettingsHost below.

// ---------- events ----------
listen<{ sessionId: string; data: string; seq: number }>("pty-output", (e) => {
  const s = sessions.get(e.payload.sessionId); if (!s?.term) return;
  const bytes = Uint8Array.from(atob(e.payload.data), (c) => c.charCodeAt(0));
  // A pane mid-adoption queues instead of writing: its scrollback snapshot must
  // land first, and whether this chunk is already inside that snapshot is decided
  // by seq when adoptSession flushes the queue (#47).
  if (s.adopt) { s.adopt.pending.push({ seq: e.payload.seq, bytes }); return; }
  s.term.write(bytes);
  // A task keeps a small tail of its own output so a failure can be handed to a
  // Claude session without re-reading the pane. Bounded hard — this is a hint for
  // the agent, not a transcript.
  if (s.run) {
    const text = new TextDecoder().decode(bytes).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) s.run.tail.push(line.trimEnd());
    }
    if (s.run.tail.length > 40) s.run.tail.splice(0, s.run.tail.length - 40);
  }
});
listen<{ sessionId: string; code: number }>("pty-exit", (e) => {
  dlog("info", `pty-exit ${e.payload.sessionId.slice(0, 8)} · code ${e.payload.code}`);
  // Release anything waiting on this pane before the early return below, so a
  // dependency chain can never deadlock on a session that vanished.
  const waiter = exitWaiters.get(e.payload.sessionId);
  if (waiter) { exitWaiters.delete(e.payload.sessionId); waiter(e.payload.code); }
  // Hand a claimed issue back. Before the early return for the same reason as the
  // waiter above: a colleague looking at a claim for an agent that stopped hours ago
  // is exactly the "graveyard of dead claims" the feature is built to avoid.
  releaseClaimFor(e.payload.sessionId);
  const s = sessions.get(e.payload.sessionId); if (!s) return;
  const code = e.payload.code;
  s.attention = null;
  if (s.kind === "task") {
    // The exit code *is* the phase — that's what buys tasks the sidebar glyphs,
    // the attention badge and the tray without a line of new plumbing.
    s.run!.exitCode = code;
    // Freeze the duration here. Every repaint used to recompute it against
    // `Date.now()`, so a step that finished in 400ms kept climbing and a whole tiled
    // chain read the same ever-growing elapsed time.
    s.run!.endedAt = Date.now();
    setPhase(s, code === 0 ? "done" : "error");
    s.term?.writeln(code === 0
      ? `\r\n\x1b[32m✓ ${s.run!.label} · exit 0\x1b[0m`
      : `\r\n\x1b[31m✕ ${s.run!.label} · exit ${code}\x1b[0m`);
    if (code === 0) scheduleDismiss(s);
    // Nobody clicked this one and its pane isn't on screen, so the badge alone
    // would be the only sign it went red.
    else if (s.run!.forSession) toast(`${s.run!.label} failed after that turn · exit ${code}`);
    dlog(code === 0 ? "info" : "warn", `task ${s.run!.id} exit ${code}`);
  } else {
    s.phase = "ended";
    // Name what actually exited. "claude exited" under a `codex` pane is a small lie
    // that costs a real minute when the pane is one of six on the stage.
    const what = s.kind === "shell" ? "shell" : s.kind === "agent" ? (s.agent ?? "agent") : "claude";
    s.term?.writeln(`\r\n\x1b[90m[${what} exited: code ${code}]\x1b[0m`);
    // Reclaim an ended claude pane's scrollback the moment nobody is looking at it;
    // the pane you watched end keeps its buffer until it leaves the stage (setActive
    // trims on the way off). See trimScrollback for why claude panes only.
    if (isClaude(s) && activeId !== s.id) trimScrollback(s);
  }
  // A task's exit code is its verdict; anything else just stopped. After the branches
  // above so a task has its `exitCode` before this reads the kind, and in one place
  // rather than three so the two outcomes can never diverge.
  playSound(exitSound(s.kind, code));
  renderAll();
});

listen<{ kind: string; data: any }>("telemetry", (e) => {
  const { kind, data } = e.payload; if (!data) return;
  telem.rx++;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { telem.dropped++; dlog("warn", `${kind} telemetry for unrouted session ${sid ? sid.slice(0, 8) : "?"}: dropped`); return; }
  telem.routed++;
  // Claude's own id, preserved by the telemetry server before it forced ours on.
  // It rotates on /clear, /compact and /resume — and each rotation opens a fresh
  // transcript — so this, not s.id, is what a later --resume has to target.
  const rt: string | undefined = data.claude_session_id?.toLowerCase?.();
  if (rt && rt !== s.resumeId) {
    dlog("info", `session ${s.id.slice(0, 8)} rotated id → ${rt.slice(0, 8)} (restore now targets it)`);
    s.resumeId = rt;
    flushRoster(); // rare and load-bearing — never let a debounce lose this one
  }
  // Sound alerts read the state machine's verdict rather than the raw payload: what a
  // hook MEANS is ./phase's decision (done vs. error, a permission vs. any other
  // notification), and a second reading of the payload here would be a second copy of
  // that decision — the copy that drifts. So snapshot, apply, compare. Both snapshots
  // are three fields; this costs nothing per event.
  const before = soundSnap(s);
  const rlBefore = { h5: rl.h5, d7: rl.d7 };
  if (kind === "statusline") applyStatusline(s, data); else { dlog("info", `hook ${data.hook_event_name ?? "?"} · ${sid!.slice(0, 8)}`); applyHook(s, data); }
  const ev = hookSound(before, soundSnap(s));
  if (ev) playSound(ev);
  // Rate limits are account-wide, so this is deliberately outside the per-session
  // branch above: one crossing, one chime, however many sessions report it.
  if (limitCrossed(rlBefore.h5, rl.h5) !== null || limitCrossed(rlBefore.d7, rl.d7) !== null) playSound("limit");
  queueRosterSave();
  renderAll();
});
// menu-bar (tray) menu → jump to the clicked session
listen<string>("tray-select", (e) => { const id = e.payload; if (sessions.has(id)) setActive(id); });
// blocking permission request — Claude is waiting for our decision
listen<{ id: string; data: any }>("permission", (e) => {
  const { id, data } = e.payload; if (!data) return;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { dlog("warn", `permission for unrouted session ${sid ? sid.slice(0, 8) : "?"}: auto-deferred to terminal`); invoke("resolve_permission", { id, behavior: "terminal" }).catch(() => {}); return; }
  s.attention = `permission: ${data.tool_name || ""}`;
  s.pendingCmd = permCmd(data);
  s.pendingPermId = id;
  s.pendRisk = riskLevel(data.tool_name, data.tool_input);
  // The one alert the whole feature is for: Claude is stopped until this is answered,
  // and nothing else in the app can reach you from another window. The matching
  // `PermissionRequest` hook usually rings a beat earlier or later — `SOUND_REPEAT_MS`
  // is what makes the pair one sound rather than two.
  playSound("permission");
  renderAll();
});

// delegated clicks (sidebar / mini / inspector buttons)
document.addEventListener("click", (e) => {
  // A reorder just ended: eat the click a pointerup may have synthesised (see initProjectDnD).
  if (performance.now() < reorderGuardUntil) { setReorderGuard(0); return; }
  const t = e.target as HTMLElement;
  if (!t.closest("#colorPop, #ctxMenu, .pdot, .rm-dot")) closeColorPop();
  if (!t.closest("#ctxMenu, #colorPop")) closeCtxMenu();
  if (!t.closest("#enginePop, #fEngineSeg")) closeEnginePop();
  if (!t.closest("#cafPop, #caf")) closeCafPop();
  if (!t.closest("#usagePop, #fUsageSeg")) closeUsagePop();
  if (!t.closest("#costPop, #fCostSeg")) closeCostPop();
  if (!t.closest("#ioPop, #fIoSeg")) closeIoPop();
  if (!t.closest("#attnPop, #attnBadge")) closeAttnPop();
  if (!t.closest("#shortPop, #fShortSeg")) closeShortPop();
  // Every anchor that OPENS this popover must be spared here, or the same click that
  // opened it closes it again and the control reads as dead. `[data-dashbrtrunk]` is the
  // Branches view's trunk chip; it shipped missing from this list and did nothing at all.
  if (!t.closest("#bPop, [data-wtpick], [data-dashbrtrunk]")) closeBranchPop(false);
  const dot = t.closest<HTMLElement>(".pdot, .rm-dot");
  if (dot) { const owner = dot.closest<HTMLElement>("[data-key]"); if (owner?.dataset.key) { openColorPopover(owner.dataset.key, e.clientX, e.clientY + 6); return; } }
  // data-forget and data-resume sit INSIDE a data-past row, so they must be matched
  // (and dispatched) ahead of it or the row's own click would swallow them.
  // `closest` returns the NEAREST matching ancestor, so a nested target beats its row
  // for free — but only if its attribute is in this list. A data- attribute the
  // selector doesn't name resolves to the enclosing row instead, silently doing the
  // wrong thing: that is what makes this list load-bearing rather than bookkeeping.
  const el = t.closest<HTMLElement>("[data-perm],[data-driftfollow],[data-git],[data-diff],[data-close],[data-remove],[data-add],[data-jump],[data-resume],[data-forget],[data-ext],[data-past],[data-rgtoggle],[data-gtoggle],[data-closerun],[data-rungroup],[data-sel],[data-wtadd],[data-launch],[data-dash],[data-pal],[data-rail],[data-toast],[data-freveal],[data-fopen],[data-fgroup],[data-fmode],[data-tlrow],[data-callsel],[data-callcopy]");
  if (!el) return;
  if (el.dataset.perm) resolvePermission(el.dataset.permid || "", el.dataset.perm);
  else if (el.dataset.driftfollow) void followSessionDrift(el.dataset.driftfollow);
  else if (el.dataset.git) runGit(el.dataset.gitsid || "", el.dataset.git);
  else if (el.dataset.diff) openDiff(el.dataset.diff, el.dataset.difftitle || "");
  else if (el.dataset.close) closeSession(el.dataset.close);
  else if (el.dataset.remove) removeFavorite(el.dataset.remove);
  else if (el.dataset.add) addProject();
  else if (el.dataset.jump) jumpExternal(+el.dataset.jump);
  else if (el.dataset.resume) resumeDormant(el.dataset.resume);
  else if (el.dataset.forget) forgetDormant(el.dataset.forget);
  else if (el.dataset.ext) openExternal(el.dataset.ext);
  else if (el.dataset.past) openDormant(el.dataset.past);
  // The twisty must be tested BEFORE the row it sits inside, or expanding a run
  // group's step list would also tile it on the stage — two different intents, and
  // the inner target has to win.
  else if (el.dataset.rgtoggle) toggleRunGroup(el.dataset.rgtoggle);
  else if (el.dataset.closerun) void closeRunGroup(el.dataset.closerun);
  else if (el.dataset.rungroup) { openRunGroup(el.dataset.rungroup); closeAttnPop(); }
  // Two popovers emit data-sel rows — the reactor's picker and the spend split — and
  // both are answered by putting that session on the stage, so both close behind it.
  else if (el.dataset.sel) { setActive(el.dataset.sel); closeAttnPop(); closeCostPop(); }
  // The header of a user-defined project group: the whole bar folds it, the way its
  // chevron says it does. Right-click is the group's own menu (./projmenu).
  else if (el.dataset.gtoggle) toggleProjGroup(el.dataset.gtoggle);
  // A project header. This used to select whichever session sorted first, so one
  // click meant two different things depending on state; it now opens the project
  // dashboard, and the sessions are the rows directly beneath it.
  else if (el.dataset.dash) { openDashboard(el.dataset.proj || basename(el.dataset.dash), el.dataset.dash); closeAttnPop(); }
  // A launch into one specific checkout. Unlike data-launch this keeps colorKey pinned
  // to the repo root (data-root), so the new session joins the project it belongs to
  // rather than becoming a project of its own — the same contract the ⑃ dialog uses.
  // closePeek first: the row just clicked is about to reappear as a session row in the
  // list above it, and leaving the rail expanded over a pane you started reads as the
  // click not having landed.
  else if (el.dataset.wtadd) { closePeek(); launchWorktree(el.dataset.proj || basename(el.dataset.wtadd), el.dataset.root || el.dataset.wtadd, el.dataset.wtadd, el.dataset.branch || ""); }
  else if (el.dataset.launch) requestLaunch(el.dataset.proj || basename(el.dataset.launch), el.dataset.launch);
  else if (el.dataset.pal) openPalette();
  else if (el.dataset.rail) toggleRail();
  // The inspector's read/written row states which window it covers, and clicking it
  // cycles: today → this run → everything recorded. A cycle rather than a popover
  // because there are three values and no sub-choices — a menu would be one more click
  // to reach a number that is already on screen.
  // The inspector's Context card. `freveal` is tested BEFORE `fopen` for the same
  // reason `rgtoggle` is tested before `rungroup`: the ⌂ button sits *inside* the file
  // row, so `closest()` hands back the button and the inner target has to win — put
  // `fopen` first and the ⌂ would open the file instead of showing it.
  else if (el.dataset.freveal) void revealTouchedFile(el.dataset.freveal);
  else if (el.dataset.fopen) void openTouchedFile(el.dataset.fopen);
  else if (el.dataset.fgroup) toggleFileGroup(el.dataset.fgroup);
  else if (el.dataset.fmode) setCtxMode(el.dataset.fmode);
  // The Tools tab and the call sheet it opens. `tlsid` rather than `activeId`: the row
  // carries the session it was rendered for, and markup outlives the state that produced
  // it by however long it takes somebody to move the pointer. `callcopy` carries which
  // block to copy (`inp` / `out` / `both`) — the sheet knows which call is selected, so
  // the attribute never has to name one.
  else if (el.dataset.tlrow) openCallSheet(el.dataset.tlsid || activeId || "", el.dataset.tlrow);
  else if (el.dataset.callsel) selectCall(el.dataset.callsel);
  else if (el.dataset.callcopy) copySelectedCall(el.dataset.callcopy);
  else if (el.dataset.toast) toast(el.dataset.toast);
});


// The project context menu and the appearance/colour panel it shares with the
// sidebar's dots moved to ./projmenu — one module, because the panel is also the
// menu's Appearance submenu. main.ts still opens the panel from a dot click and
// closes both from the document handlers below.

// Keep-awake moved to ./caffeinate — it owns its presets, its timer and its
// popover; reconcileCaf is still called from renderAll below. The terminal-engine
// popover and the reactor badge's click went to ./footer with the rest of the status
// bar; the document-level outside-click closes below still reach their close functions.

$("kbar").addEventListener("click", openPalette);
$("themeBtn").addEventListener("click", toggleTheme);

// Window controls — the other half of "the header is the title bar". Windows
// only: macOS's traffic lights are the real ones, and its green button zooms or
// goes fullscreen depending on how you hold it, which no <button> reproduces.
// Close goes through the OS close request, so it lands in the same
// `quit-requested` confirm below as Ctrl+Q rather than stepping around it.
// Maximize is only *asked* for here — the answer comes back through onResized,
// which is also how Win+↑, a snap and the drag region's own double-click get the
// glyph right; on macOS the same listener catches entering fullscreen, where the
// OS reclaims the traffic lights and the room the header leaves for them.
if (IS_TAURI && (IS_MAC || IS_WIN)) {
  const win = getCurrentWindow();
  const syncWin = async () => {
    if (IS_WIN) $("winCtl").classList.toggle("maxed", await win.isMaximized());
    else document.documentElement.classList.toggle("fs", await win.isFullscreen());
  };
  if (IS_WIN) {
    $("winMin").addEventListener("click", () => { void win.minimize(); });
    $("winMax").addEventListener("click", () => { void win.toggleMaximize(); });
    $("winClose").addEventListener("click", () => { void win.close(); });
  }
  void win.onResized(() => { void syncWin(); });
  void syncWin();
}
$("railCollapse").addEventListener("click", toggleRail);
$("railSort").addEventListener("click", cycleSort);
$("inspBtn").addEventListener("click", toggleInsp);
// The project tasks panel and the ▶ Run picker moved to ./taskui — both are UI
// over what ./tasks discovers, and both own their own dialog state and handlers.


// "+ Session" starts a session in the current project (offering a worktree if it
// already has one). With nothing on stage there's no project context → palette.
// A dashboard IS a project context — and the one place the question "which repo?"
// is already answered on screen — so it gets the same dialog a session would, with
// the repo-ness the dashboard has already read rather than the palette it used to
// open, which asked again for something it had just been told.
$("btnNew").addEventListener("click", () => {
  const c = activeProjectCtx();
  if (c) requestLaunch(c.project, c.path, dashLaunchHint()); else openPalette();
});
$("btnTerm").addEventListener("click", openPlainTerminal);
// Two doors into History: the stage-header button opens it scoped to the project on
// screen (like ❯ Terminal and ▶ Run beside it), the top-bar icon opens every project.
$("btnHist").addEventListener("click", () => { void openHistory(true); });
$("histBtn").addEventListener("click", () => { void openHistory(false); });
initHistoryEvents();
$("btnRun").addEventListener("click", () => { void openRunPicker(); });
$("setClose").addEventListener("click", closeSettings);
$("fRepo").addEventListener("click", (e) => { e.preventDefault(); openUrl("https://github.com/respeak-io/episko").catch(() => {}); });
// ✕ closes whatever is on the stage. On the dashboard that is the dashboard — it
// does not touch the project.
$("btnClose").addEventListener("click", () => {
  if (dashMirror()) { closeDashboard(); renderAll(); return; }
  if (activeId) closeSession(activeId);
});

$("scrim").addEventListener("click", () => { closePalette(); closeWt(); closeDiff(); closeExplorer(); closeGraph(); closeSettings(); closeRunPicker(); closeInputPrompt(); closeTaskManager(); closeHistory(); closeChangelog(); closeCallSheet(); });
// What each bindable action does. The chords themselves are NOT here — they live in
// `keyPrefs` (./state, from ./keys) so the user can change or switch them off in
// Settings › Keys — and this map is only the verb each one runs. One entry per
// KeyAction; `tsc` checks the two halves agree, so an action added to the table
// without a body here is a compile error rather than a shortcut that silently does
// nothing.
//
// The whole if-chain this replaced carried a warning that ⌘⇧B had to be written above
// ⌘B or it would never fire (the unshifted branches didn't test `!e.shiftKey`).
// `matchAction` is exact, so that trap is gone with the chain.
const KEY_ACTIONS_RUN: Record<KeyAction, (e: KeyboardEvent) => void> = {
  palette: () => { $("palette").classList.contains("show") ? closePalette() : openPalette(); },
  sessionSwitch: (e) => { const s = orderedSessions()[digitOf(e) - 1]; if (s) setActive(s.id); },
  terminal: openPlainTerminal,
  history: () => { histOpen() ? closeHistory() : void openHistory(true); },
  files: () => { explorerOpen ? closeExplorer() : openProjectFiles(); },
  reveal: revealActiveFolder,
  buildTask: () => { void runDefaultTask("build"); },
  testTask: () => { void runDefaultTask("test"); },
  runTask: () => { void openRunPicker(); },
  sidebar: toggleRail,
  inspector: toggleInsp,
  settings: () => { settingsOpen() ? closeSettings() : openSettings(); },
  fontUp: () => bumpFont(0.5),
  fontDown: () => bumpFont(-0.5),
  fontReset: () => { setTermFontSize(12.5); applyFontSize(); toast("Terminal font 12.5px"); },
};
window.addEventListener("keydown", (e) => {
  // A row in Settings › Keys is waiting for a chord. The recorder is a `window`
  // *capture* listener, so it already ran and swallowed anything it could bind — but
  // it deliberately lets some presses through (a bare modifier, a key this layer
  // refuses to bind), and those must not fire a shortcut either while a row is armed.
  if (keyRecording()) return;
  // `reveal` is deliberately absent from this dispatch: it needs to be asked ahead of
  // every dialog's own Enter, so it keeps its own capture-phase listener below.
  const act = matchAction(keyPrefs, e);
  if (act && act !== "reveal") { e.preventDefault(); KEY_ACTIONS_RUN[act](e); return; }
  if (e.key === "Escape" && histOpen()) { e.preventDefault(); closeHistory(); }
  else if (e.key === "Escape" && ctxMenuOpen()) { e.preventDefault(); closeColorPop(); closeCtxMenu(); }
  else if (e.key === "Escape" && explorerOpen) { e.preventDefault(); closeExplorer(); }
  else if (e.key === "Escape" && diffOpen) { e.preventDefault(); closeDiff(); }
  else if (e.key === "Escape" && callSheetOpen()) { e.preventDefault(); closeCallSheet(); }
  // graphEscape, not closeGraph: the panel can have a commit open over it, and Esc has to
  // step out of that first.
  else if (e.key === "Escape" && graphOpen) { e.preventDefault(); graphEscape(); }
  else if (e.key === "Escape" && settingsOpen()) { e.preventDefault(); closeSettings(); }
  else if (e.key === "Escape" && changelogOpen()) { e.preventDefault(); closeChangelog(); }
  // dashEscape, not closeDashboard: an enlarge overlay can be up over the pane and
  // Esc has to take that first. Same rule as graphEscape above.
  else if (e.key === "Escape" && dashMirror()) { e.preventDefault(); dashEscape(); }
  else if (e.key === "Escape" && $("mgrDlg").classList.contains("show")) { e.preventDefault(); if (mgrEdit) { setMgrEdit(null); renderMgr(); } else closeTaskManager(); }
});
// ⌘⇧⏎ — reveal the current selection's folder. Deliberately a *second* listener, in
// the CAPTURE phase, rather than another branch in the handler above: ⏎ is the one key
// every dialog already owns, and the palette's Enter runs the selected item and closes
// itself, dropping the scrim *before* a bubble-phase listener would run — so "is a
// dialog up?" has to be asked ahead of their handlers, not after. It stands down
// rather than consuming the key, which leaves plain ⌘⏎ free for the run picker's pin.
//
// The chord is `activeBind(keyPrefs, "reveal")`, not a literal: it is rebindable — and
// switchable off — like every other shortcut, and the `reveal` case is skipped by the
// dispatcher above so exactly one of the two listeners can ever answer for it.
window.addEventListener("keydown", (e) => {
  if (keyRecording()) return;
  if (!comboMatches(activeBind(keyPrefs, "reveal"), e)) return;
  if ($("scrim").classList.contains("show")) return;
  // Not every Enter-bound field sits behind the scrim — the colour popover's hex box
  // doesn't — so also stand down while a real text field has focus. xterm's own
  // hidden textarea is not one of those: a focused terminal is the normal case here.
  const t = e.target;
  if (t instanceof HTMLElement && t.matches("input, textarea") && !t.classList.contains("xterm-helper-textarea")) return;
  e.preventDefault();
  revealActiveFolder();
}, true);
// Debounce container resizes. A window drag or a sidebar/inspector toggle fires this
// many times per second; without a settle delay each tick pushes a new width to the
// PTY, and Claude's Ink renderer — which erases its previous frame by line count at
// the *old* width — can't keep up, leaving orphaned cells. One resize at the settled
// size lets Ink do a single clean relayout. Direct refit() callers (font/panel
// toggles) stay immediate; this only tames the observer's storm.
let refitTimer: number | undefined;
new ResizeObserver(() => {
  clearTimeout(refitTimer);
  refitTimer = window.setTimeout(refit, 120);
}).observe($("terminals"));

// Clicking a tile in a tiled run group moves the focus to it. One delegated listener
// rather than a per-pane one, so no bookkeeping when panes come and go; the capture
// phase, so xterm's own mousedown (which takes DOM focus for typing) doesn't matter to
// us either way. No-ops when nothing is tiled.
$("terminals").addEventListener("mousedown", (e) => {
  if (!stageGroup) return;
  const t = e.target as HTMLElement;
  if (t.closest(".pc-x")) return; // the caption's ✕ is a close, not a focus
  for (const s of sessions.values()) {
    if (s.pane.contains(t)) { focusInGroup(s.id); return; }
  }
}, true);

// The footer version label and app self-update moved to ./update — it needs nothing
// from here, so it is imported for its side effects and never called.

// Quit guard. On macOS, Cmd+Q is bound to our own menu item in the backend (macOS
// doesn't reliably surface the OS quit as a Tauri event — see tauri#9198); on
// Windows the backend intercepts CloseRequested (closing the window is the quit
// gesture there — it has no app menu). Both arrive here as `quit-requested`
// rather than tearing the app down. We only nag
// when something would actually be lost — an idle Episko quits immediately, keeping
// the Cmd+Q muscle memory intact.
listen("quit-requested", async () => {
  // Both floored writes land here: there is no later poll or delta after a quit. The
  // day's *money* (`cc-usage`) is written eagerly and needs no flush — see ./usage.
  flushIo();
  flushUsageDetail();
  // isExited, not `phase !== "ended"`: a finished task's phase is done/error, so the
  // old test counted every failed run as "1 task still running" in the quit dialog.
  const live = [...sessions.values()].filter((s) => !isExited(s));
  const agents = live.filter((s) => isClaude(s)).length;
  const terms = live.filter((s) => s.kind === "shell").length;
  const runs = live.filter((s) => s.kind === "task").length;
  // Counted apart from `agents`, which means instrumented claude sessions: quitting ends
  // a codex pane just as dead, and a dialog that left it out of the tally would be
  // understating what the button does.
  const clis = live.filter((s) => s.kind === "agent").length;
  const total = agents + terms + runs + clis;
  if (total === 0) { await invoke("confirm_quit"); return; }
  const parts: string[] = [];
  if (agents) parts.push(`${agents} running ${agents === 1 ? "session" : "sessions"}`);
  if (terms) parts.push(`${terms} ${terms === 1 ? "terminal" : "terminals"}`);
  if (runs) parts.push(`${runs} ${runs === 1 ? "task" : "tasks"}`);
  if (clis) parts.push(`${clis} ${clis === 1 ? "agent" : "agents"}`);
  const ok = await ask(`${listPhrase(parts)} still running. Quitting ends ${total === 1 ? "it" : "them"}.`, {
    title: "Quit Episko?",
    kind: "warning",
    okLabel: "Quit",
    cancelLabel: "Cancel",
  });
  if (ok) await invoke("confirm_quit");
});

// ---------- debug console wiring ----------
$("dbgBtn").addEventListener("click", () => toggleDbg());
$("dbgClose").addEventListener("click", () => toggleDbg(false));
$("dbgClear").addEventListener("click", () => { dbgLog.length = 0; telem.rx = telem.routed = telem.dropped = telem.renders = 0; renderDbgBadge(); renderDbgPanel(); });
$("dbgCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(dbgSnapshot(), null, 2)); toast("Debug snapshot copied"); } catch { toast("copy failed"); }
});
// surface uncaught JS errors in the console so they're visible (and land in the file)
window.addEventListener("error", (e) => dlog("error", `js error: ${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => dlog("error", `unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`));
dlog("info", "app started");
flushDebug();
setInterval(flushDebug, 4000);

// scour each known project for a favicon/logo once, so the sidebar shows real icons
FAVORITES.forEach((f) => probeIcon(f.path));

// discover which external terminals are installed, so the footer/palette only
// offers ones that actually work (embedded is always available).
// ...and the coding-agent catalogue, each entry saying whether it is on this machine.
// The whole list, not just the hits: a picker that can only show what you already have
// cannot answer "why is Codex not here?". One probe per run — the answer changes when
// you install something, which is not a thing to poll for.
invoke<AgentCli[]>("list_agents").then((list) => {
  setAvailAgents(list);
  const on = list.filter((a) => a.path !== null).map((a) => a.id);
  dlog("info", `agents on PATH: ${on.length ? on.join(", ") : "none"} (of ${list.length} known)`);
}).catch(() => {});

invoke<string[]>("available_terminals").then((ids) => {
  setAvailEngines(ALL_ENGINES.map((e) => e.id).filter((id) => id === "embedded" || ids.includes(id)));
  if (!availEngines.includes(termEngine)) { setTermEngine("embedded"); localStorage.setItem("cc-term-engine", termEngine); }
  renderFoot();
}).catch(() => {});

// keep rate-limit reset countdowns fresh (and flip a maxed meter back to 0 once
// its window resets) even when no new telemetry is arriving.
setInterval(() => {
  if (settingsOpen() && setTab === "usage") renderSettings(); // keep the forecast countdowns/colours current
  if (mirror) return; // a read-only mirror owns the stage — don't paint over it
  const s = activeId ? sessions.get(activeId) ?? null : null;
  renderInspector(s);
  renderFoot();
}, 30000);

// Tick the inspector's dwell / wait clocks every second WITHOUT a full re-render —
// a targeted textContent update on #iDwell, so the heartbeat animation isn't reset
// each second (innerHTML replacement restarts CSS animations). This is the one
// place we deviate from the render-everything pattern, and it's why the pulse is
// smooth while "waiting 3:40" counts up live.
setInterval(() => {
  if (mirror) return;
  const s = activeId ? sessions.get(activeId) ?? null : null;
  if (!s || !isClaude(s)) return;
  tickDwell(s);
}, 1000);

// Refresh the active session's inspector stats on a slow cadence: the live I/O
// figures, plus picking up whatever working-set diff the dirty poll has read since.
// This tick spawns nothing — the diffstat it used to run itself now rides
// `refreshDirtyStates`' stale-driven map, same as the sidebar dot.
setInterval(() => {
  if (mirror) return;
  const s = activeId ? sessions.get(activeId) ?? null : null;
  if (s) void refreshSessionStats(s);
}, 4000);

// Keep the disk-I/O rollup sampled when the poll above cannot run — a mirror or the
// dashboard owns the stage, nothing is selected, or the window is in the background and
// the WebView is throttling its timers. The counters are cumulative, so a gap loses no
// bytes; what it loses is the ability to say WHICH DAY they belong to, and a gap over a
// night booked a whole evening's churn to the next morning. `splitIo` makes a long
// window honest; this keeps the window short.
//
// One minute, matching `IO_SAVE_FLOOR_MS` exactly, so this cannot raise the write rate
// above what an on-stage session already produces: `addIo` returns before touching
// anything when the disk was idle, and flushes at most once per floor when it wasn't.
// It carries no `git_diffstat` — see `pollIo`.
setInterval(() => { void pollIo(); }, 60_000);

// discover Claude Code sessions running outside Episko and keep them fresh.
refreshExternals();
setInterval(refreshExternals, 3000);

// Re-adopt any pane a webview reload orphaned — the backend still holds its PTY —
// and only THEN reconcile the roster: an adopted id is live again, so it must not
// also come back as a dormant row (#47). A normal start finds no orphans and the
// await is one empty IPC round-trip.
void adoptOrphans().finally(() => void loadDormants());
// Nothing else persists the roster on the way out: closeSession and the telemetry
// tick both save, but a quit with live, quiet sessions would otherwise write nothing.
window.addEventListener("beforeunload", flushRoster);

// keep the sidebar's "uncommitted changes" dot (and the external diff card) honest
// for every project at once — s.git alone only covers the active session. The tick
// stays at 5s, but the work behind it is now driven by which folders an agent actually
// touched (see setOnSessionTouched below); the sweep inside is the backstop.
refreshDirtyStates(true);
setInterval(refreshDirtyStates, 5000);

// Keep every git-derived label honest: each session's real HEAD, plus the set of
// checkouts each repo has. The hook stream pokes the same function the moment an agent
// runs a git command, so this interval is the backstop that catches changes made
// outside Claude — your own terminal, an editor, an MCP tool.
setInterval(refreshGitViews, 4000);
void refreshGitViews(); // seed the roster so the first paint isn't a checkout short

setSort(sortMode, false); // paint the sort button's glyph/title for the persisted mode
initProjectDnD();
initSidebarPeek();
initChangelog();
initFileDrop();
// caffeinate always starts off — the assertion is bound to the last run's process
// (`-w <pid>` on macOS, the parked thread on Windows) and died with it; renderAll's
// reconcileCaf() paints the button. Note this is the ONE place agent-mode could
// auto-assert on launch — but cafArmed is false at boot, so it stays dormant.
renderAll();
