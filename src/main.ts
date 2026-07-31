import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { isAgent } from "./types";
import { $, chord, IS_MAC, toast } from "./dom";
import { updateTray } from "./tray";
import {
  closeAttnPop, closeEnginePop, closeFootMenus, closeShortPop, closeUsagePop,
  refreshTokens, renderAttn, renderFoot, setEngine, setFooterCloseColorPop,
  setFooterSetActive,
} from "./footer";
import { closePalette, openPalette, setPaletteHost } from "./palui";
import {
  closeColorPop, closeCtxMenu, ctxMenuOpen, openColorPopover, setProjMenuHost,
} from "./projmenu";
import { renderInspector } from "./inspector";
import { applyFontSize, bumpFont, refit } from "./terminal";
import {
  addProject, addProjectPath, cycleSort, effectiveTheme, openProjectFolder,
  removeFavorite, resolvePermission, revealActiveFolder, setActionsRenderAll,
  setSort, setTheme, setWtGroup, toggleInsp, toggleRail, toggleTheme,
} from "./actions";
import {
  activeCwd, activeProjectCtx, closeSession, handToTerminal, launch, launchShell,
  launchTask, noteGitCommand, openPlainTerminal, refreshGitViews, refreshSessionStats, renderHeader,
  requestLaunch, runGit, scheduleDismiss, setActive, setPanesRenderAll,
  syncStageButtons,
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
  initFileDrop, initProjectDnD, renderMini, renderSidebar, reorderGuardUntil,
  setReorderGuard, setSidebarRenderAll, setSidebarSetSort,
} from "./sidebar";
import {
  closeBranchPop, closeWt, setWtCloseSession,
  setWtHandToTerminal, setWtLaunch, setWtRenderAll, setWtSetActive,
} from "./worktree";
import {
  dbgLog, dbgSnapshot, dlog, flushDebug, renderDbgBadge, renderDbgPanel, telem,
  toggleDbg,
} from "./debug";
import { basename, setHome } from "./format";
import { setRlLogger } from "./rl";
import { closeCafPop, reconcileCaf, setCafHost } from "./caffeinate";
import { closeDiff, diffOpen, openDiff, setDiffCloseFootMenus } from "./diffview";
import {
  closeInputPrompt, closeRunPicker, closeTaskManager, mgrEdit, openRunPicker,
  renderMgr, setMgrEdit, setTaskUiHost,
} from "./taskui";
import {
  closeSettings, openSettings, renderSettings, setSettingsHost, setTab, settingsOpen,
} from "./settings";
import { dwellText } from "./inspectorview";
import { closeHistory, histOpen, initHistoryEvents, openHistory } from "./historyui";
import {
  applyHook, applyStatusline, permCmd, riskLevel, setOnSessionTouched, setOnTurnEnd,
  setPhase,
} from "./phase";
import {
  activeId, ALL_ENGINES, availEngines, dormants, externals, extMirrorId, FAVORITES,
  markWorkdirStale, mirror, pastMirrorId, sessions, setAvailEngines, setTermEngine,
  setTermFontSize, sortMode, termEngine, threadsOpen, trailOpen, boardOpen, orbitOpen,
} from "./state";
import { closeTrail, openTrail, renderTrailHeader, renderTrailInspector, wireTrail } from "./trailui";
import {
  closeThreads, openThreads, releaseClaimFor, renderThreads, renderThreadsHeader,
  renderThreadsInspector, wireThreads,
} from "./threadsui";
import {
  boardSessionEnded, closeBoard, openBoard, renderBoard, renderBoardHeader,
  renderBoardInspector, wireBoard,
} from "./boardui";
import {
  closeOrbit, openOrbit, renderOrbit, renderOrbitHeader, renderOrbitInspector, wireOrbit,
} from "./orbitui";
import { orderedSessions } from "./grouping";
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
setOnSessionTouched((s, tool, cmd) => { markWorkdirStale(s, tool); noteGitCommand(cmd); });
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
setPaletteHost({
  setActive, resolvePermission, openPlainTerminal, closeSession, addProject,
  cycleSort, toggleInsp, toggleRail, toggleTheme, requestLaunch,
  revealActiveFolder, openProjectFolder,
});
// Same reasoning, six callees: a context-menu row starts panes and edits the project
// list, none of which the menu owns.
setProjMenuHost({
  renderAll, requestLaunch, launchShell, openProjectFolder, addProjectPath,
  removeFavorite,
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
// The settings window changes eight things it does not own; this is the whole of
// what it can reach back for.
setSettingsHost({
  setTheme, effectiveTheme, setSort, setEngine, bumpFont, applyFontSize, refreshTokens,
  setWtGroup,
});
// The task panels run tasks, hand commands to terminals and put panes on stage —
// none of which they own.
setCafHost({ closeFootMenus, renderFoot, renderAll });
setDiffCloseFootMenus(closeFootMenus);
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
// The drag guard and the reorder click guard moved with the sidebar into ./sidebar.

// ---------- model ----------
// The shapes live in ./types and the state itself in ./state (see the imports at
// the top of this file); this is the behaviour that hangs off them. The xterm side of
// a pane — the font stack, loadWebgl, fitSession/refit, the font-atlas reload and the
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

function renderAll() {
  renderSidebar(); renderMini(); renderFoot(); renderAttn(); syncStageButtons();
  // When mirroring an external session, activeId is null but the stage/inspector
  // belong to that external — render it, NOT the null "no session" state. Skipping
  // this is what let a background Episko session's telemetry tick blank the
  // external header/inspector ~1s after clicking it.
  if (orbitOpen()) {
    renderOrbitHeader(); renderOrbit(); renderOrbitInspector();
  } else if (boardOpen()) {
    renderBoardHeader(); renderBoardInspector(); renderBoard();
  } else if (threadsOpen()) {
    // Unlike the Trail this IS derived from live state, so it repaints with the fleet
    // — that is the point of it, and renderAll is already the app's one repaint.
    renderThreadsHeader(); renderThreadsInspector(); renderThreads();
  } else if (trailOpen()) {
    // Derived from history, not from the fleet's live state — so unlike the two
    // transcript mirrors this one never needs re-fetching on a telemetry tick, and
    // repainting its chrome is enough.
    renderTrailHeader(); renderTrailInspector();
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
listen<{ sessionId: string; data: string }>("pty-output", (e) => {
  const s = sessions.get(e.payload.sessionId); if (!s?.term) return;
  const bytes = Uint8Array.from(atob(e.payload.data), (c) => c.charCodeAt(0));
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
  const s = sessions.get(e.payload.sessionId); if (!s) return;
  const code = e.payload.code;
  s.attention = null;
  if (s.kind === "task") {
    // The exit code *is* the phase — that's what buys tasks the sidebar glyphs,
    // the attention badge and the tray without a line of new plumbing.
    s.run!.exitCode = code;
    setPhase(s, code === 0 ? "done" : "error");
    s.term?.writeln(code === 0
      ? `\r\n\x1b[32m✓ ${s.run!.label} — exit 0\x1b[0m`
      : `\r\n\x1b[31m✕ ${s.run!.label} — exit ${code}\x1b[0m`);
    if (code === 0) scheduleDismiss(s);
    // Nobody clicked this one and its pane isn't on screen, so the badge alone
    // would be the only sign it went red.
    else if (s.run!.forSession) toast(`${s.run!.label} failed after that turn — exit ${code}`);
    dlog(code === 0 ? "info" : "warn", `task ${s.run!.id} exit ${code}`);
  } else {
    s.phase = "ended";
    s.term?.writeln(`\r\n\x1b[90m[${s.kind === "shell" ? "shell" : "claude"} exited: code ${code}]\x1b[0m`);
    // An agent that ended without pushing must give its claim back, or the issue
    // stays assigned to someone who is no longer working on it — a dead claim is
    // worse than none, because it tells a colleague the work is taken. Only when the
    // branch has nothing on it: once there are commits, the branch itself is the
    // signal and the claim has become true.
    if (isAgent(s)) {
      const behindPush = !s.git || (s.git.ahead === 0 && s.git.files === 0 && s.git.untracked === 0);
      if (behindPush) void releaseClaimFor(s.id);
    }
    // The exit code is the verdict for a card too — green to review, red to the
    // blocked column. The cheap half of RFC #24's P3 loop, out of parts already here.
    void boardSessionEnded(s.id, code);
  }
  renderAll();
});

listen<{ kind: string; data: any }>("telemetry", (e) => {
  const { kind, data } = e.payload; if (!data) return;
  telem.rx++;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { telem.dropped++; dlog("warn", `${kind} telemetry for unrouted session ${sid ? sid.slice(0, 8) : "?"} — dropped`); return; }
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
  if (kind === "statusline") applyStatusline(s, data); else { dlog("info", `hook ${data.hook_event_name ?? "?"} · ${sid!.slice(0, 8)}`); applyHook(s, data); }
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
  if (!s) { dlog("warn", `permission for unrouted session ${sid ? sid.slice(0, 8) : "?"} — auto-deferred to terminal`); invoke("resolve_permission", { id, behavior: "terminal" }).catch(() => {}); return; }
  s.attention = `permission: ${data.tool_name || ""}`;
  s.pendingCmd = permCmd(data);
  s.pendingPermId = id;
  s.pendRisk = riskLevel(data.tool_name, data.tool_input);
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
  if (!t.closest("#attnPop, #attnBadge")) closeAttnPop();
  if (!t.closest("#shortPop, #fShortSeg")) closeShortPop();
  if (!t.closest("#bPop, [data-wtpick]")) closeBranchPop(false);
  const dot = t.closest<HTMLElement>(".pdot, .rm-dot");
  if (dot) { const owner = dot.closest<HTMLElement>("[data-key]"); if (owner?.dataset.key) { openColorPopover(owner.dataset.key, e.clientX, e.clientY + 6); return; } }
  // data-forget and data-resume sit INSIDE a data-past row, so they must be matched
  // (and dispatched) ahead of it or the row's own click would swallow them.
  const el = t.closest<HTMLElement>("[data-perm],[data-git],[data-diff],[data-close],[data-remove],[data-add],[data-jump],[data-resume],[data-forget],[data-ext],[data-past],[data-sel],[data-launch],[data-wtlaunch],[data-pal],[data-rail],[data-toast]");
  if (!el) return;
  if (el.dataset.perm) resolvePermission(el.dataset.permid || "", el.dataset.perm);
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
  else if (el.dataset.sel) { setActive(el.dataset.sel); closeAttnPop(); }
  else if (el.dataset.launch) requestLaunch(el.dataset.proj || basename(el.dataset.launch), el.dataset.launch);
  // A session-less worktree row. Unlike data-launch this keeps colorKey pinned to the
  // repo root, so the new session joins the project it belongs to rather than becoming
  // a project of its own — the same contract the ⑃ dialog's worktree rows use.
  else if (el.dataset.wtlaunch) {
    const branch = el.dataset.wtbranch || "";
    launch(el.dataset.proj || basename(el.dataset.wtlaunch), el.dataset.wtlaunch,
      { colorKey: el.dataset.key || el.dataset.wtlaunch, worktree: branch, branch });
  }
  else if (el.dataset.pal) openPalette();
  else if (el.dataset.rail) toggleRail();
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
$("railCollapse").addEventListener("click", toggleRail);
$("railSort").addEventListener("click", cycleSort);
$("inspBtn").addEventListener("click", toggleInsp);
// The project tasks panel and the ▶ Run picker moved to ./taskui — both are UI
// over what ./tasks discovers, and both own their own dialog state and handlers.


// "+ Session" starts a session in the current project (offering a worktree if it
// already has one). With no active session there's no project context → palette.
$("btnNew").addEventListener("click", () => {
  const c = activeProjectCtx();
  if (c) requestLaunch(c.project, c.path); else openPalette();
});
$("btnTerm").addEventListener("click", openPlainTerminal);
// Two doors into History: the stage-header button opens it scoped to the project on
// screen (like ❯ Terminal and ▶ Run beside it), the top-bar icon opens every project.
$("btnHist").addEventListener("click", () => { void openHistory(true); });
$("histBtn").addEventListener("click", () => { void openHistory(false); });
initHistoryEvents();
$("btnRun").addEventListener("click", () => { void openRunPicker(); });
wireTrail();
wireThreads();
wireBoard();
wireOrbit();
$("setClose").addEventListener("click", closeSettings);
$("fRepo").addEventListener("click", (e) => { e.preventDefault(); openUrl("https://github.com/respeak-io/episko").catch(() => {}); });
$("btnClose").addEventListener("click", () => { if (activeId) closeSession(activeId); });

$("scrim").addEventListener("click", () => { closePalette(); closeWt(); closeDiff(); closeSettings(); closeRunPicker(); closeInputPrompt(); closeTaskManager(); closeHistory(); });
// ⌘⌥ + a letter is the OVERVIEW LAYER: Trail, Threads, Board, Orbit. One chord for
// "step back and look at everything", distinct from the plain-⌘ verbs that act on
// whatever is on screen.
//
// Matched on `e.code`, never `e.key`, and that is load-bearing on macOS: Option is a
// character-composing modifier there, so ⌥F arrives as `key: "ƒ"`, ⌥T as "†", ⌥B as
// "∫". A `key.toLowerCase() === "f"` test simply never fires — which is exactly why
// the first ⌘⌥F binding for the Orbit did nothing. `code` is the physical key and is
// unaffected by modifiers.
const isCode = (e: KeyboardEvent, letter: string) => e.code === `Key${letter.toUpperCase()}`;
// A plain-⌘ verb must not fire when Option is down, or it would swallow the overview
// chord that shares its letter (⌘T terminal vs ⌘⌥T Trail, ⌘B sidebar vs ⌘⌥B Board).
window.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const alt = e.altKey;
  if (meta && alt && isCode(e, "t")) { e.preventDefault(); trailOpen() ? closeTrail() : openTrail(); renderAll(); }
  else if (meta && alt && isCode(e, "o")) { e.preventDefault(); threadsOpen() ? closeThreads() : openThreads(null); renderAll(); }
  else if (meta && alt && isCode(e, "b")) { e.preventDefault(); const c = activeProjectCtx(); if (boardOpen()) closeBoard(); else if (c) openBoard(c.path); else toast("Open a project first — the board lives in its repo"); renderAll(); }
  else if (meta && alt && isCode(e, "f")) { e.preventDefault(); orbitOpen() ? closeOrbit() : openOrbit(); renderAll(); }
  else if (meta && !alt && e.key.toLowerCase() === "k") { e.preventDefault(); $("palette").classList.contains("show") ? closePalette() : openPalette(); }
  else if (meta && !alt && e.key.toLowerCase() === "b") { e.preventDefault(); toggleRail(); }
  else if (meta && !alt && e.key.toLowerCase() === "i") { e.preventDefault(); toggleInsp(); }
  else if (meta && !alt && e.key.toLowerCase() === "t") { e.preventDefault(); openPlainTerminal(); }
  else if (meta && e.key >= "1" && e.key <= "9") { e.preventDefault(); const list = orderedSessions(); const s = list[+e.key - 1]; if (s) setActive(s.id); }
  else if (meta && (e.key === "=" || e.key === "+")) { e.preventDefault(); bumpFont(0.5); }
  else if (meta && e.key === "-") { e.preventDefault(); bumpFont(-0.5); }
  else if (meta && e.key === "0") { e.preventDefault(); setTermFontSize(12.5); applyFontSize(); toast("Terminal font 12.5px"); }
  else if (meta && e.key === ",") { e.preventDefault(); settingsOpen() ? closeSettings() : openSettings(); }
  else if (meta && e.shiftKey && e.key.toLowerCase() === "r") { e.preventDefault(); void openRunPicker(); }
  else if (meta && e.shiftKey && e.key.toLowerCase() === "h") { e.preventDefault(); histOpen() ? closeHistory() : void openHistory(true); }
  else if (e.key === "Escape" && histOpen()) { e.preventDefault(); closeHistory(); }
  else if (e.key === "Escape" && trailOpen()) { e.preventDefault(); closeTrail(); renderAll(); }
  else if (e.key === "Escape" && threadsOpen()) { e.preventDefault(); closeThreads(); renderAll(); }
  else if (e.key === "Escape" && boardOpen()) { e.preventDefault(); closeBoard(); renderAll(); }
  else if (e.key === "Escape" && orbitOpen()) { e.preventDefault(); closeOrbit(); renderAll(); }
  else if (e.key === "Escape" && ctxMenuOpen()) { e.preventDefault(); closeColorPop(); closeCtxMenu(); }
  else if (e.key === "Escape" && diffOpen) { e.preventDefault(); closeDiff(); }
  else if (e.key === "Escape" && settingsOpen()) { e.preventDefault(); closeSettings(); }
  else if (e.key === "Escape" && $("mgrDlg").classList.contains("show")) { e.preventDefault(); if (mgrEdit) { setMgrEdit(null); renderMgr(); } else closeTaskManager(); }
});
// ⌘⏎ — reveal the current selection's folder. Deliberately a *second* listener, in the
// CAPTURE phase, rather than another branch in the handler above: ⏎ is the one key
// every dialog already owns, and the palette's Enter runs the selected item and closes
// itself, dropping the scrim *before* a bubble-phase listener would run — so "is a
// dialog up?" has to be asked ahead of their handlers, not after. It stands down
// rather than consuming the key, which leaves ⌘⏎ free for the run picker's pin.
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
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
  const live = [...sessions.values()].filter((s) => s.phase !== "ended");
  const agents = live.filter((s) => isAgent(s)).length;
  const terms = live.filter((s) => s.kind === "shell").length;
  const runs = live.filter((s) => s.kind === "task").length;
  const total = agents + terms + runs;
  if (total === 0) { await invoke("confirm_quit"); return; }
  const parts: string[] = [];
  if (agents) parts.push(`${agents} running ${agents === 1 ? "session" : "sessions"}`);
  if (terms) parts.push(`${terms} ${terms === 1 ? "terminal" : "terminals"}`);
  if (runs) parts.push(`${runs} ${runs === 1 ? "task" : "tasks"}`);
  const ok = await ask(`${listPhrase(parts)} still running — quitting ends ${total === 1 ? "it" : "them"}.`, {
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
$("dbgClear").addEventListener("click", () => { dbgLog.length = 0; telem.rx = telem.routed = telem.dropped = 0; renderDbgBadge(); renderDbgPanel(); });
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
  if (!s || !isAgent(s)) return;
  const el = document.getElementById("iDwell");
  if (el) el.textContent = dwellText(s);
}, 1000);

// Refresh the active session's working-set diff + CPU/RAM on a slow cadence.
setInterval(() => {
  if (mirror) return;
  const s = activeId ? sessions.get(activeId) ?? null : null;
  if (s) void refreshSessionStats(s);
}, 4000);

// discover Claude Code sessions running outside Episko and keep them fresh.
refreshExternals();
setInterval(refreshExternals, 3000);

// surface the sessions that were open when Episko last closed, so they can be
// resumed instead of lost. Read-only until the user actually clicks Resume.
void loadDormants();
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
initFileDrop();
// caffeinate always starts off — the assertion is bound to the last run's process
// (`-w <pid>` on macOS, the parked thread on Windows) and died with it; renderAll's
// reconcileCaf() paints the button. Note this is the ONE place agent-mode could
// auto-assert on launch — but cafArmed is false at boot, so it stays dormant.
renderAll();
