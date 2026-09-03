import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { hasSessionState, isAgent, isExited, type AgentCli } from "./types";
import { applyAgentEventToFleet, type ProviderEvent } from "./agents";
import { providerAdapter } from "./providers";
import { queuePermission } from "./permissions";
import { $, chord, IS_MAC, IS_TAURI, IS_WIN, toast } from "./dom";
import { ask } from "./confirm";
import { updateTray } from "./tray";
import {
  closeAttnPop, closeCostPop, closeEnginePop, closeFootMenus, closeIoPop, closeShortPop,
  closeUsagePop,
  refreshTokens, renderAttn, renderFoot, renderTelemetry, setEngine, setFooterCloseColorPop,
  setFooterSetActive,
} from "./footer";
import { closePalette, openPalette, setPaletteHost } from "./palui";
import {
  closeColorPop, closeCtxMenu, ctxMenuOpen, openColorPopover, setProjMenuHost,
} from "./projmenu";
import { jumpToPrompt, renderInspector, setCtxMode, tickDwell, toggleFileGroup, toggleOutlineAll, wireOutlineHover } from "./inspector";
import {
  callSheetOpen, closeCallSheet, copySelectedCall, openCallSheet, renderCallSheet, selectCall,
} from "./callsheet";
import { applyFontSize, bumpFont, markPrompt, refit, trimScrollback } from "./terminal";
import {
  addProject, addProjectPath, cycleSort, effectiveTheme, openProjectFolder,
  followSessionDrift, openTouchedFile, removeFavorite, resolvePermission, revealActiveFolder,
  revealTouchedFile,
  copyPath, openTerminalIn, setActionsRenderAll, setAttnPrefs, setDefaultAgent, setKeyPrefs,
  setPeekPrefs, setPermMode, setProjectAgent, setProjectGhAccount, setGhReload, refreshGhAccounts,
  setRevivePrefs, setTitlePrefs,
  setFootSeg, setFx, applyFx, setWindowFocused, setSort, setSoundPrefs, setTheme, setWtGroup,
  setCmpBase, shelveSessionAsked, tickRevive,
  setVitalsPrefs, setOutlinePrefs, setScrollback, openDevtools, reloadUi,
  toggleInsp, toggleProjGroup, toggleRail, toggleTheme,
} from "./actions";
import { playSound, setSoundLogger } from "./chime";
import { endBg, liveServers, taskServerUrl } from "./servers";
import {
  closeServersPop, pollServers, renderServers, setServersCloseMenus, setServersCloseSession,
  setServersRepaint, setServersSetActive,
} from "./serversui";
import { exitSound, hookSound, limitCrossed, soundSnap } from "./sound";
import {
  activeCwd, activeProjectCtx, closeRunGroup, closeSession, focusInGroup, handToTerminal,
  adoptOrphans, launch, launchShell, launchTask, launchWorktree, noteDrift,
  noteGitCommand, openPlainTerminal, openRunGroup, pollIo, refreshGitViews,
  refreshPaneCaps, refreshSessionStats, renderHeader, requestLaunch, runGit,
  scheduleDismiss, setActive, setPanesRenderAll, shelveSession,
  syncStageButtons, toggleRunGroup,
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
import "./update"; // side-effect import: it owns its footer chip, listeners and launch check
import { probeIcon, setIconRenderMini, setIconRenderSidebar } from "./icons";
import {
  closePeek, initFileDrop, initProjectDnD, initSidebarPeek, renderMini, renderSidebar,
  reorderGuardUntil, setReorderGuard, setSidebarRenderAll, setSidebarSetSort,
} from "./sidebar";
import {
  closeBranchPop, closeWt, openWt, setWtCloseSession, setWtHandToTerminal,
  openBranchPop, setWtLaunch, setWtOnBranchSwitched, setWtRefreshGit, setWtRenderAll,
  setWtSaveCmpBase, setWtSetActive,
} from "./worktree";
import {
  dbgLog, dbgSnapshot, dlog, flushDebug, renderDbgBadge, renderDbgPanel, telem,
  toggleDbg, currentDrift, tickVitals,
} from "./debug";
import { basename, setHome } from "./format";
import { rl, setRlLogger } from "./rl";
import { closeCafPop, initCaf, reconcileCaf, setCafHost } from "./caffeinate";
import { closeSignoffPop, setSignoffHost } from "./signoff";
import { closeDiff, diffOpen, openDiff, setDiffCloseFootMenus } from "./diffview";
import { closeExplorer, explorerOpen, openExplorer, setExplorerCloseFootMenus } from "./explorer";
import { closeGraph, graphEscape, graphOpen, openGraph as openGraphFor } from "./graphview";
import { changelogOpen, closeChangelog, initChangelog } from "./changelogui";
import { initTour, setTourHost, startChapter, tourTick } from "./tourui";
import {
  closeDashboard, dashBranchSwitched, dashEscape, dashLaunchHint, openDashboard,
  releaseClaimFor, reloadDashGh, renderDash, renderDashHeader, renderDashInspector, setDashHost,
  wireDashboard,
} from "./dashboard";
import {
  closeInputPrompt, closeRunPicker, closeTaskManager, mgrEdit, openRunPicker,
  renderMgr, runDefaultTask, setMgrEdit, setTaskUiHost,
} from "./taskui";
import {
  closeSettings, keyRecording, openSettings, openSettingsOn, renderSettings, setSettingsHost, setTab,
  settingsOpen,
} from "./settings";
import { closeHistory, histOpen, initHistoryEvents, openHistory } from "./historyui";
import {
  applyHook, applyStatusline, permCmd, riskLevel, setOnPrompt, setOnSessionTouched, setOnTurnEnd,
  setPhase,
} from "./phase";
import {
  activeId, ALL_ENGINES, availEngines, dashMirror, dormants, externals, extMirrorId,
  FAVORITES, keyPrefs, markWorkdirStale, mirror, pastMirrorId, sessions, setAvailAgents, setAvailEngines,
  setBgLogHealth, setTelemetryUp, setTermEngine, setTermFontSize, sortMode, stageGroup, TERM_FONT_DEFAULT, termEngine,
  vitalsPrefs, type BgLogHealthEvent,
} from "./state";
import { activeBind, comboMatches, digitOf, matchAction, type KeyAction } from "./keys";
import { orderedSessions, syncAttn } from "./grouping";
import { flushIo, flushUsageDetail } from "./usage";
import {
  exitWaiters, setTaskLauncher, setTaskLogger, setTaskRepaint, setTaskToast,
} from "./tasks";

// One-time import of the pre-rename (io.respeak.cclauncher) localStorage: macOS keys a
// WKWebView store to its bundle id, so the renamed app booted empty. Fill-absent only,
// so an install with its own data is never clobbered; a reload re-enters with it present.
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
    // Non-macOS or read failed: the flag stays unset so a later launch can retry.
  }
})();

// The header is the title bar (lib.rs's window block); CSS needs the platform class
// before first paint. Never stamped in a browser: in dev this HTML opens in a plain tab,
// where the Windows controls could only throw.
if (IS_TAURI) document.documentElement.classList.add(IS_MAC ? "mac" : IS_WIN ? "win" : "linux");
applyFx(); // before first paint, or every infinite animation starts and is then cancelled

// index.html hard-codes the mac glyphs; everything rendered from TS goes through MOD/chord.
if (!IS_MAC) {
  document.querySelectorAll("kbd").forEach((k) => { if (k.textContent === "⌘") k.textContent = "Ctrl"; });
  document.querySelectorAll<HTMLElement>("[title]").forEach((el) => { if (el.title.includes("⌘")) el.title = el.title.replace(/⌘/g, "Ctrl+"); });
  const fk = document.querySelector(".fseg.fk");
  if (fk) fk.textContent = `${chord("K")} · ${chord("1")}–9 switch · ${chord("B")} sidebar · ${chord("I")} inspector · ${chord("±")} font`;
}
if (!ALL_ENGINES.some((e) => e.id === termEngine)) setTermEngine("embedded");

// cc-theme: absent follows the OS; applied before first paint so the choice sticks.
{
  const savedTheme = localStorage.getItem("cc-theme");
  if (savedTheme === "dark" || savedTheme === "light") document.documentElement.setAttribute("data-theme", savedTheme);
}

// ---------- config ----------
homeDir().then((h) => { setHome(h.replace(/[/\\]+$/, "")); }).catch(() => {});
// Seam wiring: leaf modules reach this layer through setters that default to a no-op,
// so each stands alone in a test (the settable-hook rule in CLAUDE.md).
setRlLogger(dlog);
setOnTurnEnd((s) => { void maybeRunOnStop(s); });
// The outline's anchor has to be taken now: the marker records where the pane's buffer was
// when the question was asked, and a line number found later would have moved.
setOnPrompt((s, p) => markPrompt(s, p.id));
// Nothing watches the filesystem: a settled tool call is the only sign that a session
// changed its checkout, so it queues the working-set re-read and pokes the git views.
setOnSessionTouched((s, tool, data) => {
  markWorkdirStale(s, tool); noteGitCommand(data?.tool_input?.command); noteDrift(s, tool, data);
});
setTaskLauncher(launchTask);
setTaskLogger(dlog);
setTaskToast(toast);
setTaskRepaint(renderAll);
setIconRenderSidebar(renderSidebar);
setIconRenderMini(renderMini);
setSidebarSetSort(setSort);
setSidebarRenderAll(renderAll);
setFooterCloseColorPop(closeColorPop);
setFooterSetActive(setActive);
setServersCloseMenus(closeFootMenus);
setServersSetActive(setActive);
setServersRepaint(renderAll);
setServersCloseSession(closeSession);
// ⌘P: the explorer on whatever owns the stage, via activeCwd() so a worktree session
// explores its own checkout rather than the repo it groups under.
function openProjectFiles() {
  const wd = activeCwd();
  if (!wd) { toast("No project on screen"); return; }
  void openExplorer(wd, basename(wd));
}
setPaletteHost({
  setActive, resolvePermission, openPlainTerminal, closeSession, shelveSession: shelveSessionAsked, addProject,
  cycleSort, toggleInsp, toggleRail, toggleTheme, requestLaunch,
  revealActiveFolder, openProjectFolder, openProjectFiles,
});
setProjMenuHost({
  renderAll, requestLaunch, launchWorktree, launchShell, setProjectAgent, openProjectFolder,
  addProjectPath, removeFavorite, setGhAccount: setProjectGhAccount,
});
// ./signoff must not import ./panes: that would close a cycle through ./footer.
setSignoffHost({ closeFootMenus, renderAll, shelveSession, closeSession });
setTaskRunSetActive(setActive);
setTaskRunCloseSession(closeSession);
setTaskRunLaunchTask(launchTask);
setPanesRenderAll(renderAll);
setActionsRenderAll(renderAll);
setMirrorSetActive(setActive);
setMirrorLaunch(launch);
setMirrorRenderAll(renderAll);
setSettingsHost({
  setTheme, effectiveTheme, setSort, setEngine, bumpFont, applyFontSize, refreshTokens,
  setWtGroup, setPermMode, setDefaultAgent, setPeekPrefs, setTitlePrefs, setSoundPrefs, setKeyPrefs, setAttnPrefs,
  setRevivePrefs,
  startTour: startChapter,
  setFootSeg, setFx,
  setVitalsPrefs, setOutlinePrefs, setScrollback, openDevtools, reloadUi,
  vitalsDrift: currentDrift,
});
setTourHost({
  pasteToActive: (text) => {
    const s = activeId ? sessions.get(activeId) : null;
    if (!s) return;
    // No PTY of ours behind an external engine: say so rather than fail silently.
    if (s.external) { toast("This session runs in your terminal — type it there"); return; }
    void invoke("write_pty", { sessionId: s.id, data: text }).catch(() => {});
  },
  openSettingsAt: openSettingsOn,
  // Toggle rather than set the class, so the button state stays ./actions' problem.
  ensure: (need) => {
    const app = $("app");
    if (need === "rail" && app.classList.contains("rail-mini")) toggleRail();
    if (need === "inspector" && (app.classList.contains("insp-off") || app.classList.contains("insp-mini"))) toggleInsp();
  },
  renderAll,
});
setSoundLogger(dlog);
setDashHost({
  launch: (project, workdir, opts) => launch(project, workdir, opts),
  requestLaunch: (project, path, known) => { requestLaunch(project, path, known); },
  openTerminal: (dir) => { openTerminalIn(dashMirror()?.name ?? basename(dir), dir); },
  // armSwitch opens the ⑃ dialog onto the root's switch card; every guard lives there.
  switchBranch: (project, repoDir, branch) => {
    void openWt(project, repoDir, branch || null, { manage: true, armSwitch: true });
  },
  // colorKey is the repo root, so the shell nests under its project rather than becoming one.
  handToTerminal: (project, dir, cmd) => {
    void handToTerminal(project, dir, cmd, { colorKey: dashMirror()?.root ?? dir });
  },
  openRun: () => { void openRunPicker(); },
  openGraph: (root) => { void openGraphFor(root, dashMirror()?.name ?? basename(root)); },
  refreshGit: () => refreshGitViews(),
  pickTrunk: (anchor, items, current, onPick) => { openBranchPop(anchor, items, current, onPick); },
  saveTrunk: (repoDir, ref) => { setCmpBase(repoDir, ref); },
  setGhAccount: (root, login) => { setProjectGhAccount(root, login); },
  openHistory: () => { void openHistory(true); },
  openFolder: (dir) => { void openProjectFolder(dir); },
  copyPath: (dir) => { void copyPath(dir); },
  setActive,
  renderAll,
});
wireDashboard();
setGhReload(reloadDashGh);
void refreshGhAccounts(); // once at startup; no answer means no account picker
setCafHost({ closeFootMenus, renderFoot, renderAll });
setDiffCloseFootMenus(closeFootMenus);
setExplorerCloseFootMenus(closeFootMenus);
setTaskUiHost({
  launchTask, handToTerminal, activeProjectCtx, activeCwd,
  setActive, renderAll, closePalette,
});
setWtLaunch(launch);
setWtCloseSession(closeSession);
setWtSetActive(setActive);
setWtRenderAll(renderAll);
setWtHandToTerminal(handToTerminal);
setWtRefreshGit(refreshGitViews);
setWtSaveCmpBase(setCmpBase);
// A root HEAD move invalidates that project's dashboard outright; nothing re-reads it on a schedule.
setWtOnBranchSwitched(dashBranchSwitched);

// "a, b and c", for the quit guard.
function listPhrase(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ---------- rendering ----------
// Coalesced: renderAll() only marks a pass due; one flush per frame paints whatever
// every event in that frame left behind. The 250ms timeout is not a backup: rAF never
// fires while the window is hidden, and the tray this pass repaints is read exactly then.
let renderPending = false;
let renderFallback = 0;
export function renderAll() { // exported for measurement only; nothing may import main.ts
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
  syncAttn(); // first, before anything paints: the one place attnAt is stamped
  renderSidebar(); renderMini(); renderFoot(); renderAttn(); renderTelemetry(); renderServers(); syncStageButtons();
  refreshPaneCaps(); // panes sit outside the sweep; no-op unless a group is tiled
  // A mirror owns the stage while activeId is null: paint it, not the "no session" state.
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
  renderCallSheet(); // no-op when closed; guarded inside against reassigning a selection
  updateTray();
  reconcileCaf(); // agent-aware mode follows the fleet's phases; no-op otherwise
  tourTick(); // last: it re-measures the anchor the renderers above just replaced
}

// ---------- events ----------
listen<{ sessionId: string; data: string; seq: number }>("pty-output", (e) => {
  const s = sessions.get(e.payload.sessionId); if (!s?.term) return;
  const bytes = Uint8Array.from(atob(e.payload.data), (c) => c.charCodeAt(0));
  // Mid-adoption, queue: the scrollback snapshot must land first, and seq decides
  // whether this chunk is already inside it when adoptSession flushes (#47).
  if (s.adopt) { s.adopt.pending.push({ seq: e.payload.seq, bytes }); return; }
  s.term.write(bytes);
  // A task keeps a bounded tail so a failure can be handed to an agent: a hint, not a transcript.
  if (s.run) {
    const text = new TextDecoder().decode(bytes).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      s.run.tail.push(line.trimEnd());
      // Latched here as it streams: the 40-line tail forgets a server's banner within seconds.
      s.run.url = taskServerUrl(s.run.url, line);
    }
    if (s.run.tail.length > 40) s.run.tail.splice(0, s.run.tail.length - 40);
  }
});
listen<{ sessionId: string; code: number }>("pty-exit", (e) => {
  dlog("info", `pty-exit ${e.payload.sessionId.slice(0, 8)} · code ${e.payload.code}`);
  // Before the early return: a dependency chain must never deadlock on a vanished session.
  const waiter = exitWaiters.get(e.payload.sessionId);
  if (waiter) { exitWaiters.delete(e.payload.sessionId); waiter(e.payload.code); }
  releaseClaimFor(e.payload.sessionId); // also before the early return: no dead claims linger
  const s = sessions.get(e.payload.sessionId); if (!s) return;
  const code = e.payload.code;
  s.attention = null;
  if (s.kind === "task") {
    // The exit code is the phase: that is what gives tasks glyphs, badge and tray for free.
    s.run!.exitCode = code;
    s.run!.endedAt = Date.now(); // frozen here, or every repaint keeps the elapsed time climbing
    setPhase(s, code === 0 ? "done" : "error");
    s.term?.writeln(code === 0
      ? `\r\n\x1b[32m✓ ${s.run!.label} · exit 0\x1b[0m`
      : `\r\n\x1b[31m✕ ${s.run!.label} · exit ${code}\x1b[0m`);
    if (code === 0) scheduleDismiss(s);
    // A run-on-stop task has no pane on screen; the badge alone would be the only sign.
    else if (s.run!.forSession) toast(`${s.run!.label} failed after that turn · exit ${code}`);
    dlog(code === 0 ? "info" : "warn", `task ${s.run!.id} exit ${code}`);
  } else {
    s.phase = "ended";
    const what = s.kind === "shell" ? "shell" : isAgent(s) ? (s.provider ?? "agent") : "task";
    s.term?.writeln(`\r\n\x1b[90m[${what} exited: code ${code}]\x1b[0m`);
    // The process is gone, so end every shell it backgrounded here (few write the exit
    // sentinel). Ended with exit: null, never cleared, so rows that already failed keep their pill.
    for (const b of liveServers(s.servers)) endBg(b, Date.now(), "session", null);
    // Reclaim scrollback unless on stage (setActive trims on the way off); see trimScrollback.
    if (hasSessionState(s) && activeId !== s.id) trimScrollback(s);
  }
  playSound(exitSound(s.kind, code)); // after the branches: a task needs its exitCode first
  renderAll();
});

// The hook server died or came back (serve_telemetry). The badge goes up at once; the
// toast waits 3s, since a re-bind usually lands within a second and a blip nobody saw
// is not worth two interruptions.
let telemDownAt = 0;
let telemToast: number | undefined;
listen<{ up: boolean; port: number; moved?: boolean }>("telemetry-health", (e) => {
  const { up, port, moved } = e.payload;
  setTelemetryUp(up);
  clearTimeout(telemToast);
  if (!up) {
    telemDownAt = Date.now();
    telem.outages++;
    dlog("error", `telemetry server on :${port} died — every session is blind until it re-binds`);
    telemToast = window.setTimeout(() => {
      toast("Telemetry server down — session readings are frozen");
    }, 3000);
  } else {
    const downMs = telemDownAt ? Date.now() - telemDownAt : 0;
    dlog(moved ? "error" : "info",
      moved
        ? `telemetry server could not reclaim its port and is now on :${port} — sessions launched earlier stay silent until relaunched`
        : `telemetry server back on :${port} after ${Math.round(downMs / 1000)}s`);
    // A moved port recovers nothing already running: always announced.
    if (moved) toast("Telemetry moved port — relaunch running sessions to restore their readings");
    else if (downMs >= 3000) toast(`Telemetry server back after ${Math.round(downMs / 1000)}s`);
  }
  renderAll();
});

// Where the backend finds an agent's background-shell logs, on transition only. `moved`
// means the probe fell through to a later candidate: the feature still works, so the
// app warns before the fallback stops matching too. No toast (the telemetry-health
// precedent); dlog tees into episko.log, so the line itself names the directory.
listen<BgLogHealthEvent>("bglog-health", (e) => {
  const h = e.payload;
  setBgLogHealth(h);
  dlog(h.state === "blind" ? "error" : h.state === "moved" ? "warn" : "info",
    h.state === "blind"
      ? `bg-log: blind — no background-shell log root under any of ${h.tried.length} candidate(s): ${h.tried.join(", ")}`
      : `bg-log: ${h.state} — logs under ${h.root} (${h.discovered ? "found by scanning" : `candidate ${h.rank}`})`);
  renderAll();
});

listen<{ kind: string; data: any }>("telemetry", (e) => {
  const { kind, data } = e.payload; if (!data) return;
  telem.rx++;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { telem.dropped++; dlog("warn", `${kind} telemetry for unrouted session ${sid ? sid.slice(0, 8) : "?"}: dropped`); return; }
  telem.routed++;
  // Claude's own id (preserved by the server before ours was forced on) rotates on
  // /clear, /compact and /resume; it, not s.id, is what a later --resume targets.
  const rt: string | undefined = data.claude_session_id?.toLowerCase?.();
  if (rt && rt !== s.resumeId) {
    dlog("info", `session ${s.id.slice(0, 8)} rotated id → ${rt.slice(0, 8)} (restore now targets it)`);
    s.resumeId = rt;
    flushRoster(); // rare and load-bearing — never let a debounce lose this one
  }
  // Sounds read ./phase's verdict, not the payload: snapshot, apply, compare, so there
  // is no second copy of the done/error decision here to drift.
  const before = soundSnap(s);
  const rlBefore = { h5: rl.h5, d7: rl.d7 };
  if (kind === "statusline") applyStatusline(s, data); else { dlog("info", `hook ${data.hook_event_name ?? "?"} · ${sid!.slice(0, 8)}`); applyHook(s, data); }
  const ev = hookSound(before, soundSnap(s));
  if (ev) playSound(ev);
  // Account-wide, so outside the per-session branch: one crossing, one chime.
  if (limitCrossed(rlBefore.h5, rl.h5) !== null || limitCrossed(rlBefore.d7, rl.d7) !== null) playSound("limit");
  queueRosterSave();
  renderAll();
});
// Integrated providers: one raw transport event through the adapter, then the shared model.
listen<ProviderEvent>("agent-event", (e) => {
  const raw = e.payload;
  const s = sessions.get(raw.sessionId);
  if (!s || s.provider !== raw.provider) {
    telem.dropped++;
    dlog("warn", `${raw.provider} event for unrouted session ${raw.sessionId?.slice(0, 8) || "?"}: dropped`);
    return;
  }
  const adapter = providerAdapter(raw.provider)?.events;
  if (!adapter) { dlog("warn", `no event adapter for provider ${raw.provider}`); return; }
  const events = adapter(raw);
  // Logs whether an item was mapped or ignored, never its command, path or payload.
  if (raw.method === "item/started" || raw.method === "item/completed") {
    const item = raw.params?.item;
    const itemType = typeof item?.type === "string" ? item.type : "unknown";
    const mapped = events.map((event) => event.type).join(", ");
    dlog(events.length ? "info" : "warn", `${raw.provider} ${raw.method} · ${itemType}${mapped ? ` → ${mapped}` : " ignored"}`);
  }
  if (!events.length) return;
  telem.rx++; telem.routed++;
  const before = soundSnap(s);
  const limitsBefore = s.rateLimits.map((x) => ({ ...x }));
  const resumeBefore = s.resumeId;
  for (const event of events) applyAgentEventToFleet(s, event, sessions.values());
  if (s.resumeId !== resumeBefore) {
    dlog("info", `${s.provider} session ${s.id.slice(0, 8)} thread → ${s.resumeId.slice(0, 8)}`);
    flushRoster();
  } else queueRosterSave();
  const sound = hookSound(before, soundSnap(s));
  if (sound) playSound(sound);
  if (s.rateLimits.some((w) => limitCrossed(
    limitsBefore.find((b) => b.windowMins === w.windowMins)?.usedPercent ?? null,
    w.usedPercent,
  ) !== null)) playSound("limit");
  renderAll();
});
listen<string>("tray-select", (e) => { const id = e.payload; if (sessions.has(id)) setActive(id); });
// Blocking permission request: Claude waits until resolve_permission answers.
listen<{ id: string; data: any }>("permission", (e) => {
  const { id, data } = e.payload; if (!data) return;
  const sid: string | undefined = data.session_id?.toLowerCase?.();
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { dlog("warn", `permission for unrouted session ${sid ? sid.slice(0, 8) : "?"}: auto-deferred to terminal`); invoke("resolve_permission", { id, behavior: "terminal" }).catch(() => {}); return; }
  queuePermission(s, {
    id, tool: data.tool_name || "", command: permCmd(data),
    risk: riskLevel(data.tool_name, data.tool_input),
  });
  playSound("permission"); // the PermissionRequest hook rings too; SOUND_REPEAT_MS pairs them
  renderAll();
});

// delegated clicks (sidebar / mini / inspector buttons)
document.addEventListener("click", (e) => {
  // A reorder just ended: eat the click a pointerup may have synthesised (see initProjectDnD).
  if (performance.now() < reorderGuardUntil) { setReorderGuard(0); return; }
  const t = e.target as HTMLElement;
  if (t.closest("#tourCard")) return; // the tour card is not an outside-click for the closers below
  if (!t.closest("#colorPop, #ctxMenu, .pdot, .rm-dot")) closeColorPop();
  if (!t.closest("#ctxMenu, #colorPop")) closeCtxMenu();
  if (!t.closest("#enginePop, #fEngineSeg")) closeEnginePop();
  if (!t.closest("#cafPop, #caf")) closeCafPop();
  if (!t.closest("#soPop, #signoffBtn")) closeSignoffPop();
  if (!t.closest("#usagePop, #fUsageSeg")) closeUsagePop();
  if (!t.closest("#costPop, #fCostSeg")) closeCostPop();
  if (!t.closest("#ioPop, #fIoSeg")) closeIoPop();
  if (!t.closest("#attnPop, #attnBadge")) closeAttnPop();
  if (!t.closest("#svrPop, #svrBadge")) closeServersPop();
  if (!t.closest("#shortPop, #fShortSeg")) closeShortPop();
  // Every anchor that opens this popover must be listed, or its own click closes it again.
  if (!t.closest("#bPop, [data-wtpick], [data-dashbrtrunk]")) closeBranchPop(false);
  const dot = t.closest<HTMLElement>(".pdot, .rm-dot");
  if (dot) { const owner = dot.closest<HTMLElement>("[data-key]"); if (owner?.dataset.key) { openColorPopover(owner.dataset.key, e.clientX, e.clientY + 6); return; } }
  // One selector decides what `el` is: an inner target beats its row only if its attribute
  // is listed here (data-forget inside data-past). test/dispatch.test.ts checks the join.
  const el = t.closest<HTMLElement>("[data-perm],[data-driftfollow],[data-git],[data-diff],[data-close],[data-remove],[data-add],[data-jump],[data-resume],[data-forget],[data-ext],[data-past],[data-rgtoggle],[data-gtoggle],[data-closerun],[data-rungroup],[data-sel],[data-wtadd],[data-launch],[data-dash],[data-pal],[data-rail],[data-toast],[data-freveal],[data-fopen],[data-fgroup],[data-fmode],[data-tlrow],[data-callsel],[data-callcopy],[data-oljump],[data-olmore]");
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
  // The twisty sits inside the row, so it must be tested before data-rungroup.
  else if (el.dataset.rgtoggle) toggleRunGroup(el.dataset.rgtoggle);
  else if (el.dataset.closerun) void closeRunGroup(el.dataset.closerun);
  else if (el.dataset.rungroup) { openRunGroup(el.dataset.rungroup); closeAttnPop(); }
  // Two popovers emit data-sel rows; both close behind the stage change.
  else if (el.dataset.sel) { setActive(el.dataset.sel); closeAttnPop(); closeCostPop(); }
  else if (el.dataset.gtoggle) toggleProjGroup(el.dataset.gtoggle);
  else if (el.dataset.dash) { openDashboard(el.dataset.proj || basename(el.dataset.dash), el.dataset.dash); closeAttnPop(); }
  // colorKey stays the repo root (data-root), so the new session joins its project.
  // closePeek first: the row clicked is about to reappear as a session row above it.
  else if (el.dataset.wtadd) { closePeek(); launchWorktree(el.dataset.proj || basename(el.dataset.wtadd), el.dataset.root || el.dataset.wtadd, el.dataset.wtadd, el.dataset.branch || ""); }
  else if (el.dataset.launch) requestLaunch(el.dataset.proj || basename(el.dataset.launch), el.dataset.launch);
  else if (el.dataset.pal) openPalette();
  else if (el.dataset.rail) toggleRail();
  // freveal before fopen: the ⌂ button sits inside the file row, so the inner target must win.
  else if (el.dataset.freveal) void revealTouchedFile(el.dataset.freveal);
  else if (el.dataset.fopen) void openTouchedFile(el.dataset.fopen);
  else if (el.dataset.fgroup) toggleFileGroup(el.dataset.fgroup);
  else if (el.dataset.fmode) setCtxMode(el.dataset.fmode);
  // tlsid rather than activeId: markup outlives the state that produced it.
  else if (el.dataset.tlrow) openCallSheet(el.dataset.tlsid || activeId || "", el.dataset.tlrow);
  // olsid rather than activeId, for the same reason as tlsid above.
  else if (el.dataset.oljump) jumpToPrompt(el.dataset.olsid || activeId || "", el.dataset.oljump);
  else if (el.dataset.olmore) toggleOutlineAll();
  else if (el.dataset.callsel) selectCall(el.dataset.callsel);
  else if (el.dataset.callcopy) copySelectedCall(el.dataset.callcopy);
  else if (el.dataset.toast) toast(el.dataset.toast);
});

$("kbar").addEventListener("click", openPalette);
$("themeBtn").addEventListener("click", toggleTheme);

// Window controls (Windows only; macOS's traffic lights are real). Close goes through
// the OS close request so it lands in the quit-requested confirm below. Maximize is
// only asked for: onResized answers it, and also catches a snap or macOS fullscreen.
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

// Focus pauses every infinite animation (./motion). Tauri's onFocusChanged, because the
// DOM's focus/blur also fire for the webview's internal moves; the DOM pair is only the
// browser fallback. visibilitychange is a third source: minimised can still be "focused".
if (IS_TAURI) {
  void getCurrentWindow().onFocusChanged(({ payload }) => setWindowFocused(payload));
} else {
  window.addEventListener("focus", () => setWindowFocused(true));
  window.addEventListener("blur", () => setWindowFocused(false));
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setWindowFocused(false); // only ever loses focus: visible is not focused
});
$("railCollapse").addEventListener("click", toggleRail);
$("railSort").addEventListener("click", cycleSort);
$("inspBtn").addEventListener("click", toggleInsp);

// "+ Session": launch into the project on stage (a dashboard counts), else the palette.
$("btnNew").addEventListener("click", () => {
  const c = activeProjectCtx();
  if (c) requestLaunch(c.project, c.path, dashLaunchHint()); else openPalette();
});
$("btnTerm").addEventListener("click", openPlainTerminal);
// btnHist scopes History to the project on screen; histBtn opens every project.
$("btnHist").addEventListener("click", () => { void openHistory(true); });
$("histBtn").addEventListener("click", () => { void openHistory(false); });
initHistoryEvents();
wireOutlineHover();
$("btnRun").addEventListener("click", () => { void openRunPicker(); });
$("setClose").addEventListener("click", closeSettings);
$("fRepo").addEventListener("click", (e) => { e.preventDefault(); openUrl("https://github.com/respeak-io/episko").catch(() => {}); });
// ✕ closes what is on the stage (a dashboard, not its project); ⇩ shelves the session.
$("btnShelve").addEventListener("click", () => { if (activeId) void shelveSessionAsked(activeId); });
$("btnClose").addEventListener("click", () => {
  if (dashMirror()) { closeDashboard(); renderAll(); return; }
  if (activeId) closeSession(activeId);
});

$("scrim").addEventListener("click", () => { closePalette(); closeWt(); closeDiff(); closeExplorer(); closeGraph(); closeSettings(); closeRunPicker(); closeInputPrompt(); closeTaskManager(); closeHistory(); closeChangelog(); closeCallSheet(); });
// The verb behind each bindable action; the chords live in keyPrefs (./keys). One entry
// per KeyAction, so an action without a body is a compile error, not a dead shortcut.
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
  fontReset: () => { setTermFontSize(TERM_FONT_DEFAULT); applyFontSize(); toast(`Terminal font ${TERM_FONT_DEFAULT}px`); },
};
window.addEventListener("keydown", (e) => {
  // A Settings › Keys row is armed: what the capture-phase recorder let through must not fire.
  if (keyRecording()) return;
  // reveal has its own capture-phase listener below, ahead of every dialog's Enter.
  const act = matchAction(keyPrefs, e);
  if (act && act !== "reveal") { e.preventDefault(); KEY_ACTIONS_RUN[act](e); return; }
  if (e.key === "Escape" && histOpen()) { e.preventDefault(); closeHistory(); }
  else if (e.key === "Escape" && ctxMenuOpen()) { e.preventDefault(); closeColorPop(); closeCtxMenu(); }
  else if (e.key === "Escape" && explorerOpen) { e.preventDefault(); closeExplorer(); }
  else if (e.key === "Escape" && diffOpen) { e.preventDefault(); closeDiff(); }
  else if (e.key === "Escape" && callSheetOpen()) { e.preventDefault(); closeCallSheet(); }
  // graphEscape, not closeGraph: Esc first steps out of a commit open over the panel.
  else if (e.key === "Escape" && graphOpen) { e.preventDefault(); graphEscape(); }
  else if (e.key === "Escape" && settingsOpen()) { e.preventDefault(); closeSettings(); }
  else if (e.key === "Escape" && changelogOpen()) { e.preventDefault(); closeChangelog(); }
  // dashEscape, not closeDashboard: an enlarge overlay may be up, as with graphEscape.
  else if (e.key === "Escape" && dashMirror()) { e.preventDefault(); dashEscape(); }
  else if (e.key === "Escape" && $("mgrDlg").classList.contains("show")) { e.preventDefault(); if (mgrEdit) { setMgrEdit(null); renderMgr(); } else closeTaskManager(); }
});
// ⌘⇧⏎ reveal: a capture-phase listener, because the palette's Enter drops the scrim
// before a bubble listener runs, so "is a dialog up?" must be asked ahead of them. It
// stands down rather than consuming, leaving plain ⌘⏎ to the run picker's pin.
window.addEventListener("keydown", (e) => {
  if (keyRecording()) return;
  if (!comboMatches(activeBind(keyPrefs, "reveal"), e)) return;
  if ($("scrim").classList.contains("show")) return;
  // The colour popover's hex box has no scrim, so also stand down in a real text field;
  // xterm's hidden textarea is not one.
  const t = e.target;
  if (t instanceof HTMLElement && t.matches("input, textarea") && !t.classList.contains("xterm-helper-textarea")) return;
  e.preventDefault();
  revealActiveFolder();
}, true);
// Debounced: every resize tick pushes a width to the PTY, and Claude's Ink renderer
// erases its last frame by line count at the old width, leaving orphaned cells.
// Only the observer is debounced; direct refit() callers stay immediate.
let refitTimer: number | undefined;
new ResizeObserver(() => {
  clearTimeout(refitTimer);
  refitTimer = window.setTimeout(refit, 120);
}).observe($("terminals"));

// Clicking a tile in a tiled run group focuses it. Delegated, so no bookkeeping as panes
// come and go; capture phase, so xterm's own mousedown does not matter.
$("terminals").addEventListener("mousedown", (e) => {
  if (!stageGroup) return;
  const t = e.target as HTMLElement;
  if (t.closest(".pc-x")) return; // the caption's ✕ is a close, not a focus
  for (const s of sessions.values()) {
    if (s.pane.contains(t)) { focusInGroup(s.id); return; }
  }
}, true);

// Quit guard. macOS binds Cmd+Q to our own menu item (tauri#9198), Windows intercepts
// CloseRequested; both arrive as quit-requested. An idle Episko quits without asking.
listen("quit-requested", async () => {
  // The two floored writes; cc-usage is eager and needs no flush (./usage).
  flushIo();
  flushUsageDetail();
  // isExited, not phase !== "ended": a finished task's phase is done/error.
  const live = [...sessions.values()].filter((s) => !isExited(s));
  const agents = live.filter(hasSessionState).length;
  const terms = live.filter((s) => s.kind === "shell").length;
  const runs = live.filter((s) => s.kind === "task").length;
  // Terminal-only agent panes, counted apart from agents: quitting ends those too.
  const clis = live.filter((s) => isAgent(s) && !hasSessionState(s)).length;
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
  try { await writeText(JSON.stringify(dbgSnapshot(), null, 2)); toast("Debug snapshot copied"); } catch { toast("copy failed"); }
});
window.addEventListener("error", (e) => dlog("error", `js error: ${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => dlog("error", `unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`));
dlog("info", "app started");
flushDebug();
setInterval(flushDebug, 4000);
// Vitals: a fixed tick asking ./debug whether a sample is due, never an interval rebuilt
// on a cadence change (see tickVitals).
setInterval(() => tickVitals(vitalsPrefs.enabled, vitalsPrefs.everyMs), 20_000);

FAVORITES.forEach((f) => probeIcon(f.path));

// Which terminals and agents this machine has, probed once per run. The whole agent
// list, not just the hits: a picker that hides Codex cannot say why it is missing.
const agentDiscovery = invoke<AgentCli[]>("list_agents").then((list) => {
  setAvailAgents(list);
  const on = list.filter((a) => a.path !== null).map((a) => a.id);
  dlog("info", `agents on PATH: ${on.length ? on.join(", ") : "none"} (of ${list.length} known)`);
}).catch((e) => {
  setAvailAgents([]); // release launch/adoption even when the probe itself failed
  dlog("warn", `agent discovery failed: ${e}`);
});

invoke<string[]>("available_terminals").then((ids) => {
  setAvailEngines(ALL_ENGINES.map((e) => e.id).filter((id) => id === "embedded" || ids.includes(id)));
  if (!availEngines.includes(termEngine)) { setTermEngine("embedded"); localStorage.setItem("cc-term-engine", termEngine); }
  renderFoot();
}).catch(() => {});

// Keep rate-limit countdowns fresh (and a maxed meter flipping back) without new telemetry.
setInterval(() => {
  if (settingsOpen() && setTab === "usage") renderSettings(); // keep the forecast countdowns/colours current
  if (mirror) return; // a read-only mirror owns the stage — don't paint over it
  const s = activeId ? sessions.get(activeId) ?? null : null;
  renderInspector(s);
  renderFoot();
}, 30000);

// Tick the dwell/wait clock each second with a targeted textContent write, not a full
// re-render: an innerHTML replacement would restart the heartbeat animation.
setInterval(() => {
  if (mirror) return;
  const s = activeId ? sessions.get(activeId) ?? null : null;
  if (!s || !hasSessionState(s)) return;
  tickDwell(s);
}, 1000);

// The active session's inspector stats. Spawns nothing: the diffstat rides refreshDirtyStates.
setInterval(() => {
  if (mirror) return;
  const s = activeId ? sessions.get(activeId) ?? null : null;
  if (s) void refreshSessionStats(s);
}, 4000);

// Keep the disk-I/O rollup sampled when the 4s poll cannot run (a mirror on stage,
// nothing selected, a throttled background window): a gap loses no bytes, only which
// day they belong to. One minute matches IO_SAVE_FLOOR_MS, so the write rate cannot rise.
setInterval(() => { void pollIo(); }, 60_000);

// Re-read every running server's background log. 4s rather than the telemetry cadence:
// a file read per server, and both things it watches for can arrive a beat late.
setInterval(() => { void pollServers(); }, 4000);

// The revive watchdog (rules in ./revive, the pass in ./actions' tickRevive). A poll, not
// a timeout: the network coming back is not an event anything fires on, and ten seconds
// is only how soon after it returns an overdue rung is noticed.
setInterval(tickRevive, 10_000);

refreshExternals();
setInterval(refreshExternals, 3000);

// Re-adopt any pane a reload orphaned (the backend still holds its PTY), and only then
// reconcile the roster: an adopted id must not also come back as a dormant row (#47).
void agentDiscovery.then(() => adoptOrphans()).finally(() => void loadDormants());
// A quit with live, quiet sessions would otherwise write no roster.
window.addEventListener("beforeunload", flushRoster);

// The uncommitted-changes dot for every project; s.git alone only covers the active session.
refreshDirtyStates(true);
setInterval(refreshDirtyStates, 5000);

// Git-derived labels. The hook stream pokes the same function on a git command; this
// interval is the backstop for changes made outside Claude (an editor, your terminal).
setInterval(refreshGitViews, 4000);
void refreshGitViews(); // seed the roster so the first paint isn't a checkout short

setSort(sortMode, false); // paint the sort button's glyph/title for the persisted mode
initProjectDnD();
initSidebarPeek();
// The tour goes first: on a first run it takes the screen, and the release notes stay quiet.
initChangelog(initTour());
initFileDrop();
// caffeinate starts off: the last run's assertion died with its process, and cafArmed is
// false at boot. initCaf covers a webview reload that left the backend still asserting.
initCaf();
renderAll();
