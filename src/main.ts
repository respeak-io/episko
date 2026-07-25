import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { homeDir } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { parsePatch, type DiffFile } from "./diff";
import type {
  DiffStat, ExtSession, GitActionResult, Phase, Restorable, Runnable, Sess,
} from "./types";
import { isAgent, statusKey, type Engine } from "./types";
import { $, dropScrim, toast } from "./dom";
import {
  closeBranchPop, closeWt, openWt, removeWorktreeSession, setWtCloseSession,
  setWtHandToTerminal, setWtLaunch, setWtRenderAll, setWtSetActive,
} from "./worktree";
import {
  dbgLog, dbgSnapshot, dlog, flushDebug, renderDbgBadge, renderDbgPanel,
  setAppVersion, telem, toggleDbg,
} from "./debug";
import {
  basename, esc, fmtShort, fmtUntil, relTime, setHome, tilde,
} from "./format";
import { forecast5h, forecast7d, rl, setRlLogger, type Forecast } from "./rl";
import { setTokenScanning, tokenScanning, usageRow } from "./usageview";
import {
  closeSettings, openSettings, renderSettings, setSettingsHost, setTab, settingsOpen,
} from "./settings";
import {
  dwellText, gaugesHtml, gitBusy, hunkHtml, planHtml, resHtml, RISK_LABEL,
  setGitBusy, timelineHtml, verbFor, vitalHtml, wsetHtml,
} from "./inspectorview";
import {
  abbr, applyHook, applyStatusline, permCmd, riskLevel, setOnTurnEnd, setPhase,
} from "./phase";
import { bumpFrec, frecScore, parsePal, scoreItem, type PalItem } from "./palette";
import {
  accentFor, activeId, ALL_ENGINES, availEngines, colorOverrides, dirtyByFolder,
  dormants, engineDef, externals, setAvailEngines, setTermFontSize, SORT_META,
  termFontSize,
  extMirrorId, extMirrorPid, FAVORITES, folderDirty, isDirty, mirror, pastMirrorId,
  saveFavorites, saveProjOrder, sessions, setActiveId, setDormants, setExternals,
  setFavorites, setMirror, setProjOrder, setSortMode, setTermEngine,
  setWtGroup as setWtGroupState, sortMode, SORT_MODES, termEngine, wtGroup,
  type SortMode, type WtGroup,
} from "./state";
import {
  allProjects, nextAfterClose, orderedSessions, projectList, urgencyRank,
} from "./grouping";
import {
  dormantBusy, dormantRows, extWorking, GCLASS, GLYPH, groupBody, taskStateText,
} from "./sidebarview";
import {
  applyInputs, discoverTasks, execCmd, exitWaiters, hiddenIds, rescanTasks,
  lastRunnableById, launchWithDeps, pinnedIds, PROVIDER_LABEL, rememberedInput,
  rememberInput, RUNNERS, runnerFor, setTaskLauncher, setTaskLogger, setTaskRepaint,
  setTaskToast, stopRuleBlocked, stopRules, taskPrefs, taskRunner, toggleHidden,
  togglePin, toggleStopRule, trustProject,
  type Provider, type Runner, type TaskLaunchOpts,
} from "./tasks";
import {
  setTokenDays, todayKey, tokenDays, tokenScanAt, usage, type DayUsage,
} from "./usage";

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

function loadWebgl(term: Terminal) {
  try {
    const w = new WebglAddon();
    w.onContextLoss(() => w.dispose()); // fall back to the DOM renderer
    term.loadAddon(w);
  } catch { /* WebGL unavailable — DOM renderer is fine */ }
}
// Platform-aware shortcut hints. Display only: the key handlers already accept
// both modifiers (`e.metaKey || e.ctrlKey`), so only the glyphs differ per OS.
const IS_MAC = navigator.userAgent.includes("Mac");
const MOD = IS_MAC ? "⌘" : "Ctrl";
/** Inline chord text: "⌘K" on macOS, "Ctrl+K" elsewhere. */
const chord = (k: string) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);
// index.html hard-codes the mac glyphs; rewrite its static bits once on other
// platforms (everything rendered from TS goes through MOD/chord instead).
if (!IS_MAC) {
  document.querySelectorAll("kbd").forEach((k) => { if (k.textContent === "⌘") k.textContent = "Ctrl"; });
  document.querySelectorAll<HTMLElement>("[title]").forEach((el) => { if (el.title.includes("⌘")) el.title = el.title.replace(/⌘/g, "Ctrl+"); });
  const fk = document.querySelector(".fseg.fk");
  if (fk) fk.textContent = `${chord("K")} · ${chord("1")}–9 switch · ${chord("B")} sidebar · ${chord("I")} inspector · ${chord("±")} font`;
}
// macOS terminal key conventions for the embedded shell. xterm.js emits xterm's
// modified-arrow sequences (Option+Left = \e[1;3D etc.), which a plain login zsh
// doesn't bind by default — so word-nav keys self-insert garbage like ";3D".
// Terminal.app instead maps them to the Meta/emacs sequences zsh binds out of the
// box; we do the same here so the embedded shell navigates like a normal terminal.
// Only plain-shell PTYs get this (Claude's REPL handles its own key input).
function macShellKeys(id: string): (e: KeyboardEvent) => boolean {
  const send = (data: string, e: KeyboardEvent): boolean => { e.preventDefault(); invoke("write_pty", { sessionId: id, data }); return false; };
  return (e: KeyboardEvent) => {
    if (e.type !== "keydown") return true;
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "ArrowLeft") return send("\x1bb", e);      // backward-word
      if (e.key === "ArrowRight") return send("\x1bf", e);     // forward-word
      if (e.key === "Backspace") return send("\x1b\x7f", e);   // backward-kill-word
    }
    if (e.metaKey && !e.altKey && !e.ctrlKey) {
      if (e.key === "ArrowLeft") return send("\x01", e);       // beginning-of-line (^A)
      if (e.key === "ArrowRight") return send("\x05", e);      // end-of-line (^E)
    }
    return true;
  };
}
// termEngine itself lives in ./state (a persisted preference like the sort mode);
// this is only the validation against what this build actually offers.
if (!ALL_ENGINES.some((e) => e.id === termEngine)) setTermEngine("embedded");
function setEngine(id: Engine) {
  if (id === termEngine) return;
  setTermEngine(id);
  localStorage.setItem("cc-term-engine", termEngine);
  const d = engineDef(id);
  toast(id === "embedded" ? "New sessions open in the embedded terminal" : `New sessions open in ${d.label} (external)`);
  renderFoot();
}

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
setTaskLauncher(launchTask);
setTaskLogger(dlog);
setTaskToast(toast);
setTaskRepaint(renderAll);
// The settings window changes seven things it does not own; this is the whole of
// what it can reach back for.
setSettingsHost({ setTheme, effectiveTheme, setSort, setEngine, bumpFont, applyFontSize, refreshTokens });
// The new-session dialog decides *where* a session starts but cannot start one:
// panes, the stage and the repaint all belong to this file.
setWtLaunch(launch);
setWtCloseSession(closeSession);
setWtSetActive(setActive);
setWtRenderAll(renderAll);
setWtHandToTerminal(handToTerminal);
// The app-level action: set the state, persist it, repaint. state.ts owns the
// assignment (and its validation) under the same name, hence the import alias.
function setWtGroup(m: WtGroup) {
  setWtGroupState(m);
  localStorage.setItem("cc-worktree-group", wtGroup);
  renderAll();
}
// Dev affordance until the settings window ships: episkoWtGroup("chip") in the console.
(window as unknown as { episkoWtGroup: typeof setWtGroup }).episkoWtGroup = setWtGroup;
// While a project group is being dragged, renderSidebar() must not rebuild the
// #projects DOM — doing so would destroy the node the browser is dragging,
// killing the drop. Telemetry ticks call renderAll() constantly, so this guard
// is what makes reordering actually work during live sessions.
let draggingProjects = false;
// Set just after a pointer-driven reorder (see initProjectDnD): swallows the click a
// pointerup may synthesise, so a drag that ends on a project doesn't also select it.
let reorderGuardUntil = 0;
// Leads with the bundled Nerd Font (see @font-face in styles.css) so the terminal
// draws powerline / devicon glyphs on every OS; the rest stay as graceful fallbacks.
const MONO = '"JetBrainsMono Nerd Font", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

// ---------- model ----------
// The shapes live in ./types and the state itself in ./state (see the imports at
// the top of this file); this is the behaviour that hangs off them.

// The WebGL/canvas renderer bakes a glyph texture atlas on first paint. If the
// bundled Nerd Font (font-display:block) isn't ready yet, that atlas caches tofu
// boxes for the icon glyphs and never repaints them on its own. So force the font
// to load, then drop every open terminal's atlas once it's ready — the next frame
// re-rasterizes with real glyphs. Terminals opened after this point are already fine.
void (async () => {
  try {
    await Promise.all([
      document.fonts.load(`${termFontSize}px "JetBrainsMono Nerd Font"`),
      document.fonts.load(`bold ${termFontSize}px "JetBrainsMono Nerd Font"`),
    ]);
    await document.fonts.ready;
  } catch { /* Font Loading API unavailable — the browser still applies the @font-face */ }
  for (const s of sessions.values()) s.term?.clearTextureAtlas();
  // A session opened before the font arrived had its cell width measured against
  // the *fallback* metrics, so its column count (and the size we spawned Claude at)
  // is slightly off and stays off until the next resize. Re-fit now that the real
  // font's metrics are in, so the PTY width matches what we actually render.
  refit();
})();

// ---------- restorable sessions ----------
// `externals` and `dormants` are state, so they live in ./state alongside the
// session map; the roster logic below still owns filling them.

// The roster is "what was open when Episko last closed". Closing a session removes
// it — an explicit close means done, so only survivors come back. Shell panes are
// excluded: a login shell has no transcript and nothing to resume.
function rosterEntry(s: Sess): Restorable {
  return {
    id: s.id, resumeId: s.resumeId || s.id, project: s.project, workdir: s.workdir,
    colorKey: s.colorKey, worktree: s.worktree, branch: s.branch,
    title: s.title, lastActivity: s.lastActivity,
  };
}
function saveRoster() {
  const open = [...sessions.values()].filter((s) => isAgent(s) && s.workdir).map(rosterEntry);
  // Dormant rows the user hasn't dismissed stay on the roster, so a restart that
  // restores only some of them doesn't quietly discard the rest.
  const live = new Set(open.map((r) => r.id));
  const keep = dormants.filter((d) => !live.has(d.id));
  localStorage.setItem("cc-restore", JSON.stringify([...open, ...keep].slice(0, 60)));
}
// Debounced, but with a ceiling: a busy session emits telemetry continuously, and a
// pure trailing debounce would reset forever and never write at all. Force a save
// once the roster has been stale for MAX_STALE regardless of how noisy it is.
let rosterTimer: number | undefined;
let rosterSavedAt = Date.now();
const ROSTER_MAX_STALE = 20000;
function queueRosterSave() {
  if (Date.now() - rosterSavedAt > ROSTER_MAX_STALE) { flushRoster(); return; }
  clearTimeout(rosterTimer);
  rosterTimer = window.setTimeout(flushRoster, 1500);
}
function flushRoster() { clearTimeout(rosterTimer); rosterSavedAt = Date.now(); saveRoster(); }
// The stage pointer (mirror / extMirrorId / pastMirrorId) now lives in ./state
// beside activeId — the two are mutually exclusive, so they belong together.
let extTranscriptTimer: number | undefined;

// Uncommitted git state keyed by folder (a session's workdir or an external's cwd),
// polled by refreshDirtyStates. It's the single source of truth for the sidebar's
// "has changes" dot and the external inspector's diff card: s.git only stays fresh
// for the *active* session, so nothing else can rely on it across every project.


// Per-project icon (a favicon/logo scoured from the repo), keyed by project path.
// Value: data-URI = found, "" = probed & none (or user cleared). Presence of the
// key means "already probed" so we don't hit the backend twice.
const icons: Record<string, string> = JSON.parse(localStorage.getItem("cc-icons") || "{}");
function saveIcons() { localStorage.setItem("cc-icons", JSON.stringify(icons)); }
// find_project_icon's discovery has improved (it now reaches monorepo subdirs like
// `01_frontend/public/`). When it does, forget projects we'd cached as "no icon"
// (empty string) so they re-probe. Found data-URIs are kept as-is; a user who hid
// an icon will see it re-probed once (acceptable for this spike).
const ICON_CACHE_VERSION = "2";
if (localStorage.getItem("cc-icons-v") !== ICON_CACHE_VERSION) {
  for (const k of Object.keys(icons)) if (!icons[k]) delete icons[k];
  localStorage.setItem("cc-icons-v", ICON_CACHE_VERSION);
  saveIcons();
}
// A logo the user picked by hand. Kept in its own key — and consulted first — so
// that neither a re-probe nor an ICON_CACHE_VERSION bump can overwrite a
// deliberate choice with whatever discovery happens to find.
const customIcons: Record<string, string> = JSON.parse(localStorage.getItem("cc-custom-icons") || "{}");
function saveCustomIcons() { localStorage.setItem("cc-custom-icons", JSON.stringify(customIcons)); }
function iconFor(key: string): string | null { const v = customIcons[key] || icons[key]; return v ? v : null; }
async function probeIcon(key: string) {
  if (key in icons) return; // already probed
  icons[key] = ""; // mark in-flight so we don't double-probe
  try {
    const r = await invoke<{ data_uri: string } | null>("find_project_icon", { dir: key });
    icons[key] = r?.data_uri || "";
  } catch { icons[key] = ""; }
  saveIcons();
  renderSidebar(); renderMini();
}
// "Use the color dot instead" — drops the hand-picked logo *and* marks discovery
// as "probed, none", so the row falls back to its accent dot and stays there.
function clearIcon(key: string) {
  delete customIcons[key]; saveCustomIcons();
  icons[key] = ""; saveIcons();
  renderSidebar(); renderMini();
}
// Pick an image file to use as this project's glyph, in place of whatever the
// backend scoured out of the repo (or the color dot, when it found nothing).
async function pickCustomIcon(key: string) {
  const file = await open({
    multiple: false,
    title: `Logo for ${basename(key)}`,
    defaultPath: key,
    filters: [{ name: "Images", extensions: ["png", "svg", "ico", "jpg", "jpeg", "webp", "gif"] }],
  });
  if (!file || typeof file !== "string") return;
  try {
    const r = await invoke<{ data_uri: string }>("read_custom_icon", { path: file });
    customIcons[key] = r.data_uri;
    saveCustomIcons();
    renderSidebar(); renderMini();
    toast(`Logo set for ${basename(key)}`);
  } catch (e) { toast(String(e)); }
}
// Forget the hand-picked logo and let discovery have another go at the repo.
function resetCustomIcon(key: string) {
  delete customIcons[key]; saveCustomIcons();
  delete icons[key]; saveIcons();
  probeIcon(key); // re-probes, then renders
  renderSidebar(); renderMini();
}
async function openProjectFolder(key: string) {
  try { await invoke("open_folder", { dir: key }); }
  catch (e) { toast(String(e)); }
}
function projGlyph(key: string, accent: string): string {
  const ic = iconFor(key);
  return ic
    ? `<img class="picon" src="${ic}" alt="" title="${esc(basename(key))} — right-click for project actions" />`
    : `<span class="pdot" title="Click to recolor · right-click for project actions" style="background:${accent};color:${accent}"></span>`;
}
// Claude prepends an animated spinner to its OSC title: it cycles through braille
// dots (U+2800-U+28FF) and an eight-spoked asterisk (U+2733), e.g. a braille dot or
// a star before "Fixing the bug". Strip any leading run of those so the sidebar
// shows a steady summary; our own status stays in the row's colored .sglyph column.
// Missing the braille range is what left the title glyph flickering. (CC 2.x OSC.)
const TITLE_DECOR = /^(?:[\s•·∙⋅●○◦◆◇✦✧★☆✨✩-✷✺-✽∗＊*⏺⬤⭐⠀-⣿\uFE0F\u200D]|\u{1F31F})+/u;
// Claude Code sets the terminal title (OSC) to an auto-summary; keep it unless it's
// just the folder path/name (which we already show).
function cleanTitle(t: string, s: Sess): string {
  const x = (t || "").replace(TITLE_DECOR, "").trim();
  if (!x) return s.title;
  if (x === s.workdir || x === tilde(s.workdir) || x === s.project || x === basename(s.workdir)) return "";
  return x;
}

const PILL_TEXT: Record<Phase, string> = { idle: "idle", thinking: "thinking…", working: "working…", done: "your turn", error: "error", ended: "ended" };

// ---------- launch ----------
async function launch(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string; resume?: string } = {}) {
  const id = crypto.randomUUID();
  const colorKey = opts.colorKey ?? workdir;
  const accent = accentFor(colorKey);
  probeIcon(colorKey);
  const external = termEngine !== "embedded";
  const eng = engineDef(termEngine);
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);

  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  if (external) {
    pane.innerHTML = `<div class="ext-pane"><div class="ext-logo"></div><h2>Running in ${esc(eng.label)}</h2><p>${esc(project)}${opts.worktree ? " · " + esc(opts.worktree) : ""} — the terminal is in your ${esc(eng.label)} window.<br>Episko still tracks its status, cost &amp; context here.</p></div>`;
  } else {
    term = new Terminal({
      fontFamily: MONO, fontSize: termFontSize, cursorBlink: true, scrollback: 8000,
      theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    loadWebgl(term);
    term.open(pane);
    term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  }

  const s: Sess = {
    id, project, accent, workdir, colorKey, resumeId: opts.resume ?? id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "",
    phase: "idle", phaseSince: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
    lastEvent: "", activity: [], kind: "claude", external, term, fit, pane,
  };
  sessions.set(id, s);
  term?.onTitleChange((t) => {
    const c = cleanTitle(t, s);
    if (c !== s.title) { s.title = c; renderSidebar(); if (activeId === id) renderHeader(s); }
  });
  setActive(id);
  // A restored session takes over its roster entry: drop the dormant row so the
  // sidebar doesn't show the same conversation twice, live and dormant.
  if (opts.resume) setDormants(dormants.filter((d) => d.resumeId !== opts.resume));
  queueRosterSave();
  dlog("info", `${opts.resume ? "resume" : "launch"} ${project} · ${id.slice(0, 8)} · ${termEngine}${opts.worktree ? " · worktree" : ""}${opts.resume ? ` · from ${opts.resume.slice(0, 8)}` : ""}`);

  try {
    if (termEngine === "ghostty") await invoke("spawn_ghostty", { sessionId: id, workdir, accent, title: project, resume: opts.resume ?? null });
    else if (external) await invoke("spawn_external_terminal", { sessionId: id, workdir, engine: termEngine, title: project, resume: opts.resume ?? null });
    else await invoke("spawn_claude", { sessionId: id, workdir, rows: term!.rows || 24, cols: term!.cols || 80, resume: opts.resume ?? null });
  } catch (e) {
    dlog("error", `launch failed (${project} · ${id.slice(0, 8)}): ${e}`);
    toast("launch failed: " + e);
    if (term) term.writeln(`\r\n\x1b[31m[launch error] ${e}\x1b[0m`);
    else pane.innerHTML = `<div class="ext-pane"><h2>Couldn't launch ${esc(eng.label)}</h2><p>${esc(String(e))}</p></div>`;
  }
  invoke<string | null>("git_branch", { workdir }).then((b) => {
    if (b && !s.branch) { s.branch = b; renderSidebar(); if (activeId === id) renderHeader(s); }
  });
  renderAll();
}

// Offer a worktree when launching into a repo that already has a session.
// Deliberately synchronous: NOTHING may be awaited before the dialog is on screen.
// This used to `await git_branch` first, and because Tauri runs non-async commands on
// the main thread, that one call queued behind whatever git work was already in flight
// (the 3s/4s/5s pollers, or worse a `fetch`) — so "+ Session" felt dead for as long as
// that took. Everything needed to decide is already in memory:
//   • a live session in this repo carries `branch` (set at launch, refreshed every 4s)
//   • an external session carries the branch the registry reported
//   • dirtyByFolder holds a non-null diffstat for anything that IS a git repo
// so repo-ness and the branch label both come for free, with zero IPC.
function requestLaunch(project: string, path: string) {
  // "Is anything already running here?" must include EXTERNAL sessions: they live in
  // their own array, not in `sessions`, so checking only the map sent a click straight
  // to a bare launch in the repo root even when the dialog was the obvious answer.
  const sess = [...sessions.values()].find((s) => s.colorKey === path);
  const ext = externals.find((e) => (e.repo_root || e.cwd) === path);
  if (sess || ext) {
    const branch = sess?.branch || ext?.branch || "";
    // Only offer the worktree dialog for an actual repo — otherwise there is nothing
    // to branch and a plain launch is the honest answer, exactly as before.
    if (branch || dirtyByFolder.get(path) != null) { openWt(project, path, branch); return; }
  }
  launch(project, path, { colorKey: path });
}

async function addProject() {
  const dir = await open({ directory: true, multiple: false, title: "Add a project folder" });
  if (!dir || typeof dir !== "string") return;
  addProjectPath(dir);
}
// Pin a folder to the sidebar. Also reachable from the context menu of a folder
// Episko knows about but hasn't been asked to keep (an external session's cwd).
function addProjectPath(dir: string) {
  if (FAVORITES.some((f) => f.path === dir)) { toast("Already a project"); return; }
  FAVORITES.push({ name: basename(dir), path: dir });
  saveFavorites();
  renderAll();
  probeIcon(dir); // scour the repo for a favicon/logo to use as the project glyph
  toast(`Added ${basename(dir)}`);
}
function removeFavorite(path: string) {
  setFavorites(FAVORITES.filter((f) => f.path !== path));
  saveFavorites();
  renderAll();
}
function closeSession(id: string) {
  const s = sessions.get(id); if (!s) return;
  // Closing a pane mid-chain counts as a failure, not a hang.
  const waiter = exitWaiters.get(id);
  if (waiter) { exitWaiters.delete(id); waiter(-1); }
  const wasActive = activeId === id;
  // Resolve the successor while the closing session is still in the map, so its
  // sidebar position (same-project neighbour) is known.
  const next = wasActive ? nextAfterClose(s) : null;
  invoke("kill_session", { sessionId: id }).catch(() => {});
  try { s.term?.dispose(); } catch { /* */ }
  s.pane.remove();
  sessions.delete(id);
  flushRoster(); // an explicit close means done — it should not come back on restart
  if (wasActive) {
    setActiveId(null);
    if (next) { setActive(next.id); return; }
    document.documentElement.style.setProperty("--accent", "#a78bfa");
    ($("empty") as HTMLElement).style.display = "grid";
  }
  renderAll();
}
function resolvePermission(id: string, behavior: string) {
  invoke("resolve_permission", { id, behavior }).catch(() => {});
  for (const s of sessions.values()) if (s.pendingPermId === id) { s.pendingPermId = null; s.attention = null; s.pendingCmd = ""; }
  renderAll();
}

function setActive(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  closeExternalView();
  setActiveId(id);
  ($("empty") as HTMLElement).style.display = "none";
  for (const x of sessions.values()) x.pane.classList.toggle("active", x.id === id);
  document.documentElement.style.setProperty("--accent", accentFor(s.colorKey));
  if (s.term && s.fit) {
    fitSession(s);
    s.term.focus();
  }
  renderHeader(s); renderInspector(s); renderSidebar(); renderMini(); renderFoot();
  // Show the branch that's really checked out right now, immediately on activate.
  void refreshBranch(s).then((changed) => { if (changed) { renderSidebar(); if (activeId === id) renderHeader(s); } });
  void refreshSessionStats(s); // working-set diff + CPU/RAM for the inspector
}
// Poll the inspector's on-demand stats for the active session: the uncommitted
// working-set diff (git_diffstat) and the claude process's CPU/RAM
// (session_resources). Both are cheap and only fetched for the visible session.
async function refreshSessionStats(s: Sess) {
  if (!isAgent(s) || s.external) return;
  const [git, res] = await Promise.all([
    invoke<DiffStat | null>("git_diffstat", { workdir: s.workdir }).catch(() => null),
    invoke<{ cpu: number; mem_mb: number } | null>("session_resources", { sessionId: s.id }).catch(() => null),
  ]);
  // Only re-render when the *displayed* values change — CPU/RAM jitter every poll,
  // so comparing rounded values avoids a needless inspector rebuild (which would
  // restart the heartbeat animation) every 4s while a session sits idle.
  const sig = (g: DiffStat | null, r: { cpu: number; memMb: number } | null) =>
    (g ? `${g.added}/${g.removed}/${g.files}/${g.untracked}/${g.ahead}/${g.behind}/${g.upstream}` : "-") + "|" + (r ? `${Math.round(r.cpu)}/${Math.round(r.memMb)}` : "-");
  const before = sig(s.git, s.res);
  s.git = git ?? null;
  s.res = res ? { cpu: res.cpu, memMb: res.mem_mb } : null;
  if (sig(s.git, s.res) !== before && activeId === s.id && !extMirrorId()) renderInspector(s);
}

// Re-derive a session's branch label from its live git HEAD, so it reflects the
// branch actually checked out rather than the one the worktree/session was born
// with (a worktree shows whatever branch is checked out, and that can change).
// Returns true if the label changed. Detached HEAD shows "(detached @<sha>)".
async function refreshBranch(s: Sess): Promise<boolean> {
  if (!s.workdir) return false;
  const info = await invoke<{ branch: string | null; short: string } | null>("git_head", { workdir: s.workdir }).catch(() => null);
  if (!info) return false; // not a git repo (or gone) — leave the label as-is
  const label = info.branch ?? `(detached @${info.short})`;
  if (label === s.branch) return false;
  s.branch = label;
  return true;
}
async function refreshBranches() {
  const changed = await Promise.all([...sessions.values()].map(refreshBranch));
  if (changed.some(Boolean)) {
    renderSidebar();
    const a = activeId ? sessions.get(activeId) ?? null : null;
    if (a) renderHeader(a);
  }
}

// ---------- external sessions: discovery, jump, read-only transcript ----------
async function refreshExternals() {
  try {
    const list = await invoke<ExtSession[]>("list_external_sessions", { exclude: [...sessions.keys()] });
    setExternals(list);
    // Scour each external repo for its logo, keyed by the same repo_root the sidebar
    // groups by — otherwise ext-only projects would forever show the accent dot.
    // probeIcon dedupes by key, so this hits the backend at most once per repo.
    for (const e of externals) probeIcon(e.repo_root || e.cwd);
    if (extMirrorId()) {
      // Re-resolve the mirrored session. If its id rotated (/clear·/compact·/resume
      // rewrite ~/.claude/sessions/<pid>.json with a new session_id), re-bind by the
      // stable pid instead of dropping the selection — otherwise the sidebar silently
      // jumps to an unrelated session (and e.g. the ❯ Terminal button then targets it).
      const pid = extMirrorPid();
      const e = externals.find((x) => x.session_id === extMirrorId())
        ?? (pid != null ? externals.find((x) => x.pid === pid) : undefined);
      if (e) {
        setMirror({ kind: "ext", id: e.session_id, pid: e.pid });
        renderExtHeader(e); renderExtInspector(e);
      } else {
        // Truly gone — fall back to an Episko session or the empty state.
        closeExternalView();
        const next = orderedSessions()[0];
        if (next) setActive(next.id);
        else ($("empty") as HTMLElement).style.display = "grid";
      }
    }
    renderSidebar(); renderMini();
  } catch { /* backend not ready yet */ }
}
// Poll uncommitted git state for every folder in play (session workdirs + external
// cwds), so the sidebar dot and the external diff card are accurate for all projects
// at once — not just whichever session is active. git_diffstat is the same cheap
// call the inspector already makes; here it fans out across the distinct folders.
async function refreshDirtyStates() {
  const folders = new Set<string>();
  for (const s of sessions.values()) if (isAgent(s) && s.workdir) folders.add(s.workdir);
  for (const e of externals) if (e.cwd) folders.add(e.cwd);
  for (const f of [...dirtyByFolder.keys()]) if (!folders.has(f)) dirtyByFolder.delete(f); // prune gone folders
  const sig = (g?: DiffStat | null) => (g ? `${g.files}/${g.untracked}/${g.added}/${g.removed}` : "-");
  let changed = false;
  await Promise.all([...folders].map(async (f) => {
    const g = await invoke<DiffStat | null>("git_diffstat", { workdir: f }).catch(() => null);
    if (sig(dirtyByFolder.get(f)) !== sig(g)) changed = true;
    dirtyByFolder.set(f, g ?? null);
  }));
  if (!changed) return;
  renderSidebar();
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); if (e) renderExtInspector(e); }
}
function openExternal(sid: string) {
  const e = externals.find((x) => x.session_id === sid);
  if (!e) return;
  setMirror({ kind: "ext", id: sid, pid: e.pid });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  ($("empty") as HTMLElement).style.display = "none";
  ($("extPane") as HTMLElement).hidden = false;
  document.documentElement.style.setProperty("--accent", accentFor(e.cwd));
  renderExtHeader(e); renderExtInspector(e); renderSidebar(); renderMini(); renderFoot();
  $("extBody").innerHTML = `<div class="ext-empty">Loading transcript…</div>`;
  void refreshDirtyStates(); // fill the working-set card promptly, not on the next poll tick
  loadTranscript(e, true);
  clearInterval(extTranscriptTimer);
  extTranscriptTimer = window.setInterval(() => {
    const cur = externals.find((x) => x.session_id === extMirrorId());
    if (cur) loadTranscript(cur, false);
  }, 2500);
}
function closeExternalView() {
  if (mirror == null) return;
  setMirror(null);   // clears the ext pid with it — one pointer, one lifetime
  clearInterval(extTranscriptTimer);
  ($("extPane") as HTMLElement).hidden = true;
}
// ---------- dormant (restorable) sessions ----------
// Clicking a dormant row mirrors its transcript read-only — the same pane an
// external session uses — so the user can confirm *which* conversation this is
// before deciding to bring it back.
function openDormant(id: string) {
  const d = dormants.find((x) => x.id === id);
  if (!d) return;
  setMirror({ kind: "past", id });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  ($("empty") as HTMLElement).style.display = "none";
  ($("extPane") as HTMLElement).hidden = false;
  clearInterval(extTranscriptTimer); // a finished transcript doesn't grow — no polling
  document.documentElement.style.setProperty("--accent", accentFor(d.colorKey));
  renderPastHeader(d); renderPastInspector(d); renderSidebar(); renderMini(); renderFoot();
  $("extBody").innerHTML = `<div class="ext-empty">Loading transcript…</div>`;
  loadTranscriptInto(d.workdir, d.resumeId, true, () => pastMirrorId() === id);
}
function renderPastHeader(d: Restorable) {
  ($("btnClose") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = d.project;
  const hb = $("hBranch"); hb.textContent = "restorable"; hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = d.title || "";
  $("hPath").textContent = tilde(d.workdir);
}
function renderPastInspector(d: Restorable) {
  const busy = dormantBusy(d);
  const pill = $("iPill"); pill.className = "pill idle";
  $("iPillTxt").textContent = "not running";
  const action = busy
    ? `<div class="ext-note warn">This session is running right now — in Episko or another terminal. Resuming it a second time would interleave both conversations into one transcript, so it can't be restored until the other one exits.</div>`
    : `<button class="ext-jump-btn" data-resume="${esc(d.id)}">⟲ Resume this session</button>
       <div class="ext-note">Claude picks the conversation back up where it left off. It may offer to compact the context first — that's normal for a long session.</div>`;
  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">· From your last run</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(d.project)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="mono ell">${esc(tilde(d.workdir))}</span></div>
      ${d.branch ? `<div class="ext-meta"><span class="label">Branch</span><span>${esc(d.branch)}</span></div>` : ""}
      <div class="ext-meta"><span class="label">Last active</span><span>${esc(relTime(d.lastActivity))}</span></div>
      <div class="ext-meta"><span class="label">Session</span><span class="mono">${esc(d.resumeId.slice(0, 8))}</span></div>
      ${action}
      <button class="ext-forget-btn" data-forget="${esc(d.id)}">Remove from list</button>
      <div class="ext-note">Removing only clears this row from Episko. The conversation stays on disk — <span class="mono">/resume</span> inside any Claude session in this folder always lists them all.</div>
    </div>`;
}
function resumeDormant(id: string) {
  const d = dormants.find((x) => x.id === id);
  if (!d) return;
  if (dormantBusy(d)) { toast("That session is already running"); return; }
  closeExternalView();
  launch(d.project, d.workdir, { colorKey: d.colorKey, worktree: d.worktree, branch: d.branch, resume: d.resumeId });
}
function forgetDormant(id: string) {
  setDormants(dormants.filter((x) => x.id !== id));
  if (pastMirrorId() === id) {
    closeExternalView();
    const next = orderedSessions()[0];
    if (next) setActive(next.id);
    else ($("empty") as HTMLElement).style.display = "grid";
  }
  flushRoster();
  renderAll();
}
// On boot: reconcile the roster against what Claude actually has on disk. An entry
// with no transcript can't be resumed — a session launched but never prompted never
// writes one — so it's dropped rather than shown as a row that would fail on click.
// Titles are refreshed from disk too: `ai-title` beats our in-memory OSC title and,
// unlike it, exists for sessions launched into an external terminal.
async function loadDormants() {
  let roster: Restorable[] = [];
  try { roster = JSON.parse(localStorage.getItem("cc-restore") || "[]") || []; } catch { roster = []; }
  if (!Array.isArray(roster) || !roster.length) return;
  const live = new Set([...sessions.keys()]);
  const byDir = new Map<string, Restorable[]>();
  for (const r of roster) {
    if (!r || typeof r.id !== "string" || typeof r.workdir !== "string" || !r.workdir) continue;
    if (live.has(r.id)) continue;
    if (!r.resumeId) r.resumeId = r.id;
    const arr = byDir.get(r.workdir);
    if (arr) arr.push(r); else byDir.set(r.workdir, [r]);
  }
  const found: Restorable[] = [];
  await Promise.all([...byDir.entries()].map(async ([workdir, entries]) => {
    const past = await invoke<{ session_id: string; title: string; mtime: number }[]>("list_past_sessions", { workdir }).catch(() => []);
    const byId = new Map(past.map((p) => [p.session_id.toLowerCase(), p]));
    for (const r of entries) {
      const hit = byId.get(r.resumeId.toLowerCase());
      if (!hit) continue; // no transcript → nothing to resume
      found.push({ ...r, title: hit.title || r.title || "", lastActivity: hit.mtime ? hit.mtime * 1000 : r.lastActivity });
    }
  }));
  found.sort((a, b) => b.lastActivity - a.lastActivity);
  setDormants(found);
  if (dormants.length) dlog("info", `${dormants.length} restorable session${dormants.length === 1 ? "" : "s"} from a previous run`);
  flushRoster();
  renderAll();
}
function jumpExternal(pid: number) {
  invoke("focus_external_session", { pid }).catch((e) => toast("jump failed: " + e));
}
async function loadTranscript(e: ExtSession, initial: boolean) {
  await loadTranscriptInto(e.cwd, e.session_id, initial, () => extMirrorId() === e.session_id);
}
// `stillCurrent` is re-checked after the await: the user can click away mid-flight,
// and a late reply must not paint over whatever mirror is on the stage by then.
async function loadTranscriptInto(cwd: string, sessionId: string, initial: boolean, stillCurrent: () => boolean) {
  try {
    const msgs = await invoke<{ role: string; text: string }[]>("read_transcript", { cwd, sessionId, limit: 80 });
    if (!stillCurrent()) return;
    renderTranscript(msgs, initial);
  } catch (err) {
    if (stillCurrent()) $("extBody").innerHTML = `<div class="ext-empty">Couldn't read the transcript.<br><span class="mono">${esc(String(err))}</span></div>`;
  }
}
function renderTranscript(msgs: { role: string; text: string }[], initial: boolean) {
  const body = $("extBody");
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  body.innerHTML = msgs.length
    ? msgs.map((m) => {
        const user = m.role === "user";
        return `<div class="tvmsg ${m.role}"><span class="tvgutter" title="${user ? "You" : "Claude"}">${user ? "❯" : "⏺"}</span><div class="tvtext">${esc(m.text)}</div></div>`;
      }).join("")
    : `<div class="ext-empty">No messages in this session yet.</div>`;
  if (initial || nearBottom) body.scrollTop = body.scrollHeight;
}
function renderExtHeader(e: ExtSession) {
  ($("btnClose") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = basename(e.cwd);
  const hb = $("hBranch"); hb.textContent = "external"; hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = e.name || "";
  $("hPath").textContent = tilde(e.cwd);
}
// A read-only working-set peek for an external session's folder — the same card as a
// Episko session's, minus the fetch/pull/push row (we don't drive this checkout).
// Shown only when the folder actually has uncommitted changes.
function extPeekHtml(e: ExtSession, g: DiffStat): string {
  const tot = g.added + g.removed || 1;
  const aw = Math.round((g.added / tot) * 100);
  const newBadge = g.untracked ? ` · ${g.untracked} new` : "";
  return `<div class="wset ext-wset">
    <div class="lab" style="margin-bottom:2px">Working set · in this folder</div>
    <div class="wpeek" data-diff="${esc(e.cwd)}" data-difftitle="${esc(basename(e.cwd))}" title="Open the uncommitted diff">
      <div class="wtop"><span class="add">+${g.added}</span><span class="del">−${g.removed}</span><span class="files">${g.files} file${g.files === 1 ? "" : "s"}${newBadge}</span><span class="wpeek-cue">⤢</span></div>
      <div class="stackbar"><span class="sa" style="width:${aw}%"></span><span class="sd" style="width:${100 - aw}%"></span></div>
    </div></div>`;
}
function renderExtInspector(e: ExtSession) {
  const working = extWorking(e);
  const pill = $("iPill"); pill.className = "pill " + (working ? "working" : "idle");
  $("iPillTxt").textContent = e.status || "external";
  const started = e.started_at ? new Date(e.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
  const g = dirtyByFolder.get(e.cwd);
  const peek = isDirty(g) ? extPeekHtml(e, g!) : "";
  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">↗ Running outside Episko</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(basename(e.cwd))}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="mono ell">${esc(tilde(e.cwd))}</span></div>
      <div class="ext-meta"><span class="label">Status</span><span>${esc(e.status || "idle")}</span></div>
      <div class="ext-meta"><span class="label">Started</span><span>${esc(started)}</span></div>
      <div class="ext-meta"><span class="label">Claude</span><span>${e.version ? "v" + esc(e.version) : "–"}</span></div>
      <div class="ext-meta"><span class="label">PID</span><span class="mono">${e.pid}</span></div>
      <button class="ext-jump-btn" data-jump="${e.pid}">↗ Jump to its terminal</button>
      <div class="ext-note">Episko can't drive this session — it was launched in another terminal. The panel on the left is a live read-only mirror of its transcript.</div>
    </div>${peek}`;
}

// ---------- telemetry ----------
// applyHook / applyStatusline and their helpers now live in ./phase; main.ts
// only wires them to the listen() handlers at the bottom of this file.

// ---------- rendering ----------
// The project/worktree grouping and the sidebar ordering now live in ./grouping;
// what follows is only the painting of what it returns.

// The sidebar's row builders now live in ./sidebarview; renderSidebar below owns
// the element they are painted into, and the drag state that must not be stomped.
function renderSidebar() {
  // Don't stomp the DOM the browser is mid-drag on — see draggingProjects.
  if (draggingProjects) return;
  $("projects").innerHTML = projectList().map((p) => {
    const rows = groupBody(p) + dormantRows(p);
    const total = p.sessions.length + p.externals.length;
    const isFav = FAVORITES.some((f) => f.path === p.path);
    // Any member folder (a session's workdir or an external's cwd) with uncommitted
    // changes lights the project's dot — so a dirty worktree marks its parent too.
    const dirty = p.sessions.some((s) => folderDirty(s.workdir)) || p.externals.some((e) => folderDirty(e.cwd));
    const dot = dirty ? `<span class="pdirty" title="Uncommitted changes in this project"></span>` : "";
    const wtSuffix = p.wtBranch ? `<span class="pwt">· ${esc(p.wtBranch)}</span>` : "";
    let head: string;
    if (p.sessions.length) {
      head = `<div class="phead" data-sel="${p.sessions[0].id}" data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}${wtSuffix}</span>${dot}<span class="pcount">${total}</span><span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}">＋</span></div>`;
    } else if (isFav) {
      const tail = p.externals.length ? `<span class="pcount ext">${p.externals.length} ext</span>` : `<span class="plaunch">launch →</span>`;
      head = `<div class="phead empty-p" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}" data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span>${dot}${tail}<span class="premove" data-remove="${esc(p.path)}" title="Remove project">✕</span></div>`;
    } else {
      // discovered via an external session or a restorable one only — not a saved project
      const tail = p.externals.length
        ? `<span class="pcount ext">${p.externals.length} ext</span>`
        : `<span class="pcount ext">${p.dormants.length} past</span>`;
      head = `<div class="phead ext-only" data-key="${esc(p.path)}" title="${esc(tilde(p.path))}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span>${dot}${tail}<span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}" title="Launch an Episko session here">＋</span></div>`;
    }
    return `<div class="pgroup" data-path="${esc(p.path)}">${head}${rows ? `<div class="psessions">${rows}</div>` : ""}</div>`;
  }).join("");
}
// Reordering of project groups, on pointer events (not HTML5 drag). The window now
// sets dragDropEnabled:true so external file drops paste a path instead of navigating
// the webview (see initFileDrop) — but that native handler blocks HTML5 drag/drop, so
// the reorder can no longer ride dragstart/dragover/drop. Pointer events are also fully
// cross-platform (the old HTML5 path only worked with dragDropEnabled:false).
//
// Delegated on the persistent #projects container so it survives re-renders; a
// separator line (.dropmark) shows where the group will land; the dragged group is only
// physically moved on release, then the DOM order is read back and saved. A drag only
// begins once the pointer crosses DRAG_SLOP, so a plain click still selects the project.
function initProjectDnD() {
  const container = $("projects");
  const DRAG_SLOP = 5; // px before a press becomes a drag rather than a click
  const marker = document.createElement("div");
  marker.className = "dropmark";
  let dragEl: HTMLElement | null = null;      // the group actually being dragged
  let candidate: HTMLElement | null = null;   // pressed group, promoted to dragEl past the slop
  let startX = 0, startY = 0;

  const cleanup = () => {
    marker.remove();
    container.classList.remove("reordering");
    dragEl?.classList.remove("dragging");
    dragEl = candidate = null;
    draggingProjects = false;
  };

  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const t = e.target as HTMLElement;
    // Leave the interactive bits (launch +, remove ✕, colour dot) to their own clicks.
    if (t.closest(".padd, .plaunch, .premove, .pdot, .pdirty")) return;
    const g = t.closest<HTMLElement>(".pgroup");
    if (!g) return;
    candidate = g;
    startX = e.clientX; startY = e.clientY;
  });

  container.addEventListener("pointermove", (e) => {
    if (!candidate) return;
    if (!dragEl) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP) return;
      // Cross the slop → promote to a real drag.
      dragEl = candidate;
      draggingProjects = true;
      container.classList.add("reordering");
      dragEl.classList.add("dragging");
      try { container.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    e.preventDefault();
    // Place the marker relative to whichever group the pointer is over.
    const over = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const grp = over?.closest<HTMLElement>(".pgroup");
    if (!grp || grp === dragEl) return;
    const r = grp.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    container.insertBefore(marker, after ? grp.nextSibling : grp);
  });

  const finish = (e: PointerEvent) => {
    try { container.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (!dragEl) { candidate = null; return; } // never crossed the slop: it was a click
    if (marker.parentNode) container.insertBefore(dragEl, marker);
    cleanup();
    setProjOrder([...container.querySelectorAll<HTMLElement>(".pgroup")].map((el) => el.dataset.path!).filter(Boolean));
    saveProjOrder();
    // A manual drag captures the current visual order and reasserts manual mode
    // (in a sorted mode the drag would otherwise be immediately overridden).
    if (sortMode !== "manual") setSort("manual", false);
    // A pointerup *may* synthesise a click (if the browser still pairs it with the
    // pointerdown after the DOM moved); guard the click handler for a brief window so
    // the reorder doesn't also select. A plain timestamp self-heals if no click fires —
    // a lingering one-shot listener would otherwise eat the user's next real click.
    reorderGuardUntil = performance.now() + 250;
    renderAll();
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", (e) => { try { container.releasePointerCapture(e.pointerId); } catch { /* */ } cleanup(); });
}

// External file drops. With dragDropEnabled:true the webview no longer navigates to a
// dropped file's file:// URL (the old trap: a dropped PDF replaced the whole app with no
// way back). Tauri's native drag-drop event carries the real absolute paths, which HTML5
// drops never expose under WKWebView — so we paste them, shell-escaped, into the active
// embedded session's PTY, matching what dragging a file into a normal terminal does.
function initFileDrop() {
  const zone = $("terminals");
  getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") zone.classList.add("dropping");
    else zone.classList.remove("dropping");
    if (p.type !== "drop") return;
    const paths = p.paths || [];
    if (!paths.length) return;
    const s = activeId ? sessions.get(activeId) : null;
    if (!s || s.external || !s.term) { toast("Drop files onto an embedded session's console to paste their paths"); return; }
    const text = paths.map(shellEscapePath).join(" ") + " ";
    invoke("write_pty", { sessionId: s.id, data: text });
    s.term.focus();
    dlog("info", `dropped ${paths.length} path${paths.length === 1 ? "" : "s"} into ${s.id.slice(0, 8)}`);
  }).catch((err) => dlog("error", `onDragDropEvent wiring failed: ${err}`));
}

// Escape a path for a shell/REPL the way a terminal does on file drop: backslash before
// anything outside the always-safe set, so spaces and metacharacters survive as one arg.
function shellEscapePath(p: string): string {
  return p.replace(/[^A-Za-z0-9_@%+=:,./-]/g, "\\$&");
}
function renderMini() {
  const activeProj = activeId ? sessions.get(activeId)?.project : null;
  $("railmini").innerHTML =
    `<button class="rm-btn" data-rail="1" title="Expand sidebar (${chord("B")})">»</button>` +
    projectList().map((p) => {
      const first = p.sessions[0];
      const firstExt = p.externals[0];
      const attn = p.sessions.some((s) => s.attention || s.phase === "error");
      const sel = first ? `data-sel="${first.id}"`
        : firstExt ? `data-ext="${firstExt.session_id}"`
        : `data-launch="${esc(p.path)}" data-proj="${esc(p.name)}"`;
      const ic = iconFor(p.path);
      const glyph = ic ? `<img class="rm-icon" src="${ic}" alt="" />` : `<span class="rm-dot"></span>`;
      const onCls = p.name === activeProj || (extMirrorId() && p.externals.some((e) => e.session_id === extMirrorId())) ? "on" : "";
      const extOnly = !first && firstExt ? "ext" : "";
      return `<button class="rm-proj ${onCls} ${extOnly}" style="--rc:${p.accent}" title="${esc(p.name)}${extOnly ? " (external)" : ""}" data-key="${esc(p.path)}" ${sel}>${glyph}${attn ? '<span class="rm-badge"></span>' : ""}</button>`;
    }).join("") +
    `<button class="rm-btn rm-add" data-pal="1" title="New session (${chord("K")})">＋</button>`;
}
function renderHeader(s: Sess | null) {
  ($("btnClose") as HTMLButtonElement).hidden = !s;
  const hb = $("hBranch"); hb.classList.remove("ext-chip");
  if (!s) { $("hProj").textContent = "no session"; hb.hidden = true; $("hTitle").textContent = ""; $("hPath").textContent = ""; return; }
  $("hProj").textContent = s.project;
  if (s.kind !== "claude") { hb.textContent = s.kind === "shell" ? "shell" : "task"; hb.hidden = false; hb.classList.add("ext-chip"); }
  else if (s.branch) { hb.textContent = s.worktree ? "⑃ " + s.branch : s.branch; hb.hidden = false; } else hb.hidden = true;
  $("hTitle").textContent = s.kind === "claude" ? (s.title || "") : (s.kind === "task" ? s.run?.label ?? "" : "");
  $("hPath").textContent = tilde(s.workdir);
}
function renderShellInspector(s: Sess) {
  const ended = s.phase === "ended";
  const pill = $("iPill"); pill.className = "pill " + (ended ? "ended" : "idle");
  $("iPillTxt").textContent = ended ? "exited" : "shell";
  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">❯ Plain shell</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(s.project)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="ell" title="${esc(tilde(s.workdir))}">${esc(tilde(s.workdir))}</span></div>
      <div class="ext-note">A regular login shell running inside Episko — no Claude, no telemetry. Handy for commands you don't want to run inside a session.</div>
    </div>`;
}
// The task preference state — prefs, trust, pins, hidden ids, run-on-stop rules —
// moved to ./tasks, beside the runner override and remembered inputs it already had.

// ---------- runnables (tasks & scripts) ----------
// Discovery lives in Rust (src-tauri/src/tasks.rs) and only ever *parses* files —
// it never executes the project to find out what it can do. This half is choosing
// and observing.


// The package-runner override and the remembered ${input:…} values now live in
// ./tasks, beside the substitution that consumes them.
function setRunner(key: string, r: Runner) {
  if (r === "auto") delete taskRunner[key]; else taskRunner[key] = r;
  localStorage.setItem("cc-task-runner", JSON.stringify(taskRunner));
  renderAll();
}

// ↗ Reveal source — where a task came from, selected in the OS file manager. `root`
// is the directory discovery ran in, so the repo-relative `sourceFile` resolves; a
// blocked/synthetic row has no real file and shows nothing to reveal.
function revealSource(root: string, sourceFile: string) {
  invoke("reveal_path", { dir: root, rel: sourceFile }).catch((e) => toast("reveal failed: " + e));
}


// A Stop fires at the end of *every* turn — that's the point — but two can land in
// quick succession, and a slow suite must never race a second copy of itself in
// the same worktree. The floor is deliberately short: it exists to swallow a
// double-fire, not to ration runs.
const stopRunAt = new Map<string, number>();
const STOP_RUN_FLOOR = 5000;
// A run-on-stop launch is only visible as a pane *after* its dependency chain has
// run — so a rule with `dependsOn` has no `run.id === rule.id` pane during the whole
// dep phase, and the 5s floor alone can't stop a turn that lands mid-build from
// racing a second chain. This marks "a chain for this project is starting", claimed
// synchronously before the first await and cleared once the launch settles; by then
// the rule pane exists and the in-flight scan below takes over.
const stopInFlight = new Set<string>();

async function maybeRunOnStop(s: Sess) {
  const rule = stopRules[s.colorKey];
  if (!rule || !isAgent(s)) return;
  // Claimed before the first await: discovery is async, so two Stops in the same
  // tick would otherwise both get past this.
  if (Date.now() - (stopRunAt.get(s.colorKey) ?? 0) < STOP_RUN_FLOOR) return;
  // A chain still starting (deps running, rule pane not created yet) wins — the pane
  // scan below can't see it, so this covers the window the floor can't.
  if (stopInFlight.has(s.colorKey)) {
    dlog("info", `run-on-stop ${rule.id} skipped — a chain is already starting`);
    return;
  }
  // A run of this rule still in flight wins. Restarting the suite from the top
  // mid-flight tells you nothing and doubles the load on the machine.
  if ([...sessions.values()].some((x) => x.kind === "task" && x.colorKey === s.colorKey && x.run?.id === rule.id && x.run.exitCode == null)) {
    dlog("info", `run-on-stop ${rule.id} skipped — still running`);
    return;
  }
  stopRunAt.set(s.colorKey, Date.now());
  stopInFlight.add(s.colorKey);
  try {
    // Discover in the *session's* workdir, so with several worktrees of one repo
    // open the run verifies the checkout the agent actually just edited. Hidden
    // tasks count — hiding is about the picker, not about what may run.
    const spec = (await discoverTasks(s.workdir, s.colorKey, true)).find((r) => r.id === rule.id);
    if (!spec) {
      dlog("warn", `run-on-stop ${rule.id} gone from ${s.project}`);
      toast(`Run after a turn: “${rule.label}” isn’t in ${s.project} any more`);
      return;
    }
    const why = stopRuleBlocked(spec);
    if (why) { dlog("warn", `run-on-stop ${rule.id} skipped: ${why}`); return; }
    dlog("info", `run-on-stop ${rule.id} · ${s.project} · ${s.id.slice(0, 8)} finished a turn`);
    await launchWithDeps(spec, s.project, {
      colorKey: s.colorKey, worktree: s.worktree, branch: s.branch,
      discoveredIn: spec.cwd, forSession: s.id, focus: false,
    });
  } finally {
    stopInFlight.delete(s.colorKey);
  }
}

// "a, b and c" — the quit guard lists up to three kinds of running thing.
function listPhrase(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
function renderTaskInspector(s: Sess) {
  const r = s.run!;
  const failed = r.exitCode != null && r.exitCode !== 0;
  const running = r.exitCode == null;
  const pill = $("iPill");
  pill.className = "pill " + (running ? "working" : failed ? "error" : "done");
  $("iPillTxt").textContent = running ? (r.background ? "running · background" : "running") : failed ? `exit ${r.exitCode}` : "passed";

  // Offer the failure to a live agent in the same project — the one thing a plain
  // terminal can't do. Only agents, and only when the run actually failed.
  // Embedded panes only: a session running in Ghostty/iTerm has no PTY we can type
  // into, so offering the handoff there would fail at the click.
  const candidates = failed ? [...sessions.values()].filter((x) => isAgent(x) && !x.external && x.colorKey === s.colorKey && x.phase !== "ended") : [];
  // A run-on-stop failure goes back to the session whose turn it was checking — and
  // *only* that session. If it's gone (ended) or unreachable (external, no PTY to
  // type into), offer nothing rather than misdirecting the output to an unrelated
  // agent that happens to sort first. A hand-run task (no forSession) still offers
  // the first live agent, which is the useful default there.
  const target = r.forSession ? candidates.find((x) => x.id === r.forSession) : candidates[0];
  const handoff = target
    ? `<button class="tact hero" data-send="${target.id}">↩ Send output to “${esc(target.title || target.branch || "session")}”</button>`
    : "";

  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">▶ ${esc(r.label)}</div>
      <div class="ext-meta"><span class="label">Command</span><span class="mono ell" title="${esc(r.cmd)}">${esc(r.cmd)}</span></div>
      <div class="ext-meta"><span class="label">Source</span><span>${esc(r.source)} · ${esc(r.sourceFile)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="ell" title="${esc(tilde(s.workdir))}">${esc(tilde(s.workdir))}</span></div>
      <div class="ext-meta"><span class="label">${running ? "Running" : "Took"}</span><span class="mono">${esc(fmtShort(Date.now() - r.startedAt))}</span></div>
      ${r.exitCode != null ? `<div class="ext-meta"><span class="label">Exit</span><span class="mono ${failed ? "bad" : "ok"}">${r.exitCode}</span></div>` : ""}
    </div>
    <div class="tacts">
      ${handoff}
      <button class="tact" data-rerun="1">⟳ Re-run</button>
      <button class="tact" data-pin="1">${pinnedIds(s.colorKey).includes(r.id) ? "★ Unpin" : "☆ Pin"}</button>
      <button class="tact" data-reveal="1">↗ Reveal source</button>
      ${running ? `<button class="tact" data-kill="1">■ Stop</button>` : ""}
    </div>`;

  const insp = $("inspector");
  insp.querySelector("[data-rerun]")?.addEventListener("click", () => rerunTask(s));
  insp.querySelector("[data-pin]")?.addEventListener("click", () => togglePin(s.colorKey, r.id));
  insp.querySelector("[data-reveal]")?.addEventListener("click", () => revealSource(r.root, r.sourceFile));
  insp.querySelector("[data-kill]")?.addEventListener("click", () => invoke("kill_session", { sessionId: s.id }).catch(() => {}));
  insp.querySelector("[data-send]")?.addEventListener("click", (e) => {
    sendOutputToSession(s, (e.currentTarget as HTMLElement).dataset.send!);
  });
}

// Type the failure into a Claude session's stdin — deliberately *without* a
// trailing newline, so you read what's about to be sent and press Enter yourself.
// Same contract as handToTerminal: Episko prefills, the human commits.
function sendOutputToSession(task: Sess, targetId: string) {
  const t = sessions.get(targetId);
  if (!t?.term) { toast("That session is gone"); return; }
  const r = task.run!;
  const tail = r.tail.join("\n").trim();
  const msg = `\`${r.cmd}\` failed with exit ${r.exitCode}:\n\n${tail}\n\nPlease fix it.`;
  setActive(targetId);
  invoke("write_pty", { sessionId: targetId, data: msg.replace(/\n/g, "\r") })
    .then(() => toast("Pasted into the session — press Enter to send"))
    .catch((e) => toast("send failed: " + e));
}

// Start one run of a Runnable in its own pane. Mirrors launchShell — same PTY,
// same xterm setup — because a task genuinely is just another pane.
async function launchTask(r: Runnable, project: string, opts: TaskLaunchOpts = {}): Promise<string | null> {
  if (r.blocked) { toast(`${r.label}: ${r.blocked}`); return null; }
  const id = crypto.randomUUID();
  const colorKey = opts.colorKey ?? r.cwd;
  // Which directory the run inherits (Settings › Tasks). "session" keeps the
  // folder it was discovered in — the active session's, so with several worktrees
  // open "run tests" means *this* worktree. "root" redirects to the repo root.
  // Either way a task that declared its own cwd (tasks.toml `cwd`, VS Code
  // `options.cwd`) keeps it: an explicit directory is never second-guessed.
  const declaredOwnCwd = !!opts.discoveredIn && r.cwd !== opts.discoveredIn;
  const cwd = taskPrefs.cwd === "root" && !declaredOwnCwd ? colorKey : r.cwd;
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: false, scrollback: 8000,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  loadWebgl(term);
  term.open(pane);
  // Tasks are interactive: a prompt, a y/N, a dev server's "r" to reload all work.
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));

  const cmd = execCmd(r);
  const s: Sess = {
    id, project, accent: accentFor(colorKey), workdir: cwd, colorKey,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: r.label,
    phase: "working", phaseSince: Date.now(), lastActivity: Date.now(), attention: null,
    pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
    lastEvent: "", activity: [],
    resumeId: id, kind: "task", external: false, term, fit, pane,
    run: { id: r.id, label: r.label, source: r.source, sourceFile: r.sourceFile, cmd, background: r.background, startedAt: Date.now(), exitCode: null, tail: [], root: opts.discoveredIn ?? colorKey, forSession: opts.forSession },
  };
  sessions.set(id, s);
  // An unfocused pane can't be measured, so it starts at xterm's default 24×80 and
  // gets a real size the moment you activate it (setActive refits and resizes the
  // PTY). Only run-on-stop takes that path.
  if (opts.focus !== false) setActive(id);
  dlog("info", `task ${r.id} · ${project} · ${cmd}`);
  term.writeln(`\x1b[90m$ ${cmd}\x1b[0m\r\n`);
  try {
    await invoke("spawn_task", {
      sessionId: id,
      spec: { exec: r.exec, cwd, env: r.env },
      rows: term.rows || 24, cols: term.cols || 80,
    });
  } catch (e) {
    dlog("error", `task ${r.id} failed to start: ${e}`);
    toast("task failed: " + e);
    term.writeln(`\r\n\x1b[31m[task error] ${e}\x1b[0m`);
    s.phase = "error";
    s.run!.exitCode = -1;
  }
  renderAll();
  return id;
}

// The dependsOn chain — resolveDeps / launchWithDeps / waitForExit — now lives in
// ./tasks, which reaches launchTask below through setTaskLauncher.

// Re-running reuses nothing — it opens a fresh pane and closes the old one, so the
// sidebar doesn't accumulate a row per attempt while the scrollback stays honest
// about which attempt you're reading.
async function rerunTask(s: Sess) {
  const r = s.run; if (!r) return;
  const spec = lastRunnableById.get(r.id);
  if (!spec) { toast("Task definition is gone — rescan"); return; }
  if (spec.inputs.length) { openInputPrompt(spec, s.project, { colorKey: s.colorKey, worktree: s.worktree, branch: s.branch, discoveredIn: spec.cwd }); return; }
  const project = s.project, colorKey = s.colorKey, worktree = s.worktree, branch = s.branch;
  closeSession(s.id);
  await launchTask(spec, project, { colorKey, worktree, branch });
}

// Discovery (discoverTasks / rescanTasks) moved to ./tasks — every input they read
// now lives there.

// ---------- the inputs prompt ----------
// A task declaring ${input:…} collects its values before anything runs. Discovery
// deliberately leaves the placeholders intact, because only this side knows the
// answers — so this is where they get filled in.
let inputCtx: { r: Runnable; project: string; opts: TaskLaunchOpts } | null = null;

function openInputPrompt(r: Runnable, project: string, opts: TaskLaunchOpts) {
  inputCtx = { r, project, opts };
  $("inSub").textContent = `${r.label} · ${r.inputs.length} input${r.inputs.length === 1 ? "" : "s"}`;
  $("inBody").innerHTML = r.inputs.map((i, n) => {
    // What you typed last for this exact input wins over the file's default — but a
    // password is never remembered, so it always starts empty.
    const remembered = i.password ? undefined : rememberedInput(project, r.id, i.id);
    const val = remembered ?? i.default ?? "";
    const field = i.kind === "pickString"
      ? `<select class="in-ctl" data-n="${n}">${i.options.map((o) => `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`
      : `<input class="in-ctl" data-n="${n}" type="${i.password ? "password" : "text"}" value="${esc(val)}" placeholder="${esc(i.default ?? "")}" spellcheck="false" autocomplete="off" />`;
    return `<div class="in-field">
      <label class="in-lbl">${esc(i.description)}<span class="in-id">${esc(i.id)}</span></label>
      ${field}
    </div>`;
  }).join("");
  $("inDlg").classList.add("show");
  $("scrim").classList.add("show");
  setTimeout(() => ($("inBody").querySelector(".in-ctl") as HTMLElement | null)?.focus(), 30);
}
function closeInputPrompt() {
  $("inDlg").classList.remove("show");
  if (!$("palette").classList.contains("show") && !$("runPop").classList.contains("show")) $("scrim").classList.remove("show");
  inputCtx = null;
}
function submitInputPrompt() {
  if (!inputCtx) return;
  const { r, project, opts } = inputCtx;
  const vals: Record<string, string> = {};
  $("inBody").querySelectorAll<HTMLInputElement | HTMLSelectElement>(".in-ctl").forEach((el) => {
    const input = r.inputs[+el.dataset.n!];
    vals[input.id] = el.value;
    // Remember for next time — but never a password.
    if (!input.password) rememberInput(project, r.id, input.id, el.value);
  });
  closeInputPrompt();
  void launchWithDeps(applyInputs(r, vals), project, opts);
}

// The inspector's HTML builders now live in ./inspectorview; renderInspector
// below stays here, because painting them into the page is its whole job.

// ---------- working-set diff viewer ----------
// Clicking the +N −M card opens a read-only peek at the uncommitted diff. The
// backend (git_diff) hands us one combined unified-diff patch; parsePatch turns it
// into files/hunks (in ./diff, unit-tested there). Rendering stays here, in the DOM.
const DSTAT: Record<DiffFile["status"], [string, string]> = {
  modified: ["M", "s-mod"], added: ["A", "s-add"], deleted: ["D", "s-del"], renamed: ["R", "s-ren"],
};
let diffOpen = false;
// Keyed by folder (workdir/cwd), not session id, so the same viewer serves Episko's
// own sessions and read-only external ones alike — both are just a git working tree.
async function openDiff(workdir: string, title: string) {
  if (!workdir) return;
  diffOpen = true;
  $("scrim").classList.add("show");
  $("diffDlg").classList.add("show");
  $("diffTitle").textContent = title || basename(workdir);
  $("diffSub").textContent = "reading working tree…";
  $("diffBody").innerHTML = `<div class="diff-empty">Reading the working tree…</div>`;
  try {
    const res = await invoke<{ patch: string; truncated: boolean } | null>("git_diff", { workdir });
    if (!diffOpen) return; // closed while the diff was loading
    renderDiffBody(res ? parsePatch(res.patch) : [], !!res?.truncated);
  } catch (e) {
    if (!diffOpen) return;
    $("diffSub").textContent = "";
    $("diffBody").innerHTML = `<div class="diff-empty">Couldn't read the diff.<br><span class="mono">${esc(String(e))}</span></div>`;
  }
}
// Several dialogs share the one #scrim, so closing any of them must only drop it
// once none of the others are still up.
function closeDiff() {
  diffOpen = false;
  $("diffDlg").classList.remove("show");
  dropScrim();
}
function renderDiffBody(files: DiffFile[], truncated: boolean) {
  const tot = files.reduce((a, f) => ({ add: a.add + f.added, rem: a.rem + f.removed }), { add: 0, rem: 0 });
  $("diffSub").innerHTML = files.length
    ? `<span class="add">+${tot.add}</span> <span class="del">−${tot.rem}</span> · ${files.length} file${files.length === 1 ? "" : "s"}`
    : "";
  if (!files.length) { $("diffBody").innerHTML = `<div class="diff-empty">No uncommitted changes to show.</div>`; return; }
  const sections = files.map((f, i) => {
    const [glyph, cls] = DSTAT[f.status];
    const name = f.status === "renamed" && f.oldPath
      ? `<span class="d-old">${esc(f.oldPath)}</span><span class="d-arr">→</span>${esc(f.path)}`
      : esc(f.path);
    const counts = f.binary ? `<span class="d-bin">binary</span>`
      : `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`;
    const body = f.binary
      ? `<div class="d-binbody">Binary file — no textual diff.</div>`
      : f.hunks.map(hunkHtml).join("") || `<div class="d-binbody">No line changes (mode or metadata only).</div>`;
    return `<div class="dfile" data-fi="${i}">
      <div class="dfhead" data-dtoggle="${i}"><span class="dchev">▾</span><span class="dstat ${cls}">${glyph}</span><span class="dpath">${name}</span><span class="dcount">${counts}</span></div>
      <div class="dfbody">${body}</div></div>`;
  }).join("");
  const note = truncated ? `<div class="diff-trunc">Diff truncated — too large to show in full. Open a terminal for the complete diff.</div>` : "";
  $("diffBody").innerHTML = sections + note;
}
function renderInspector(s: Sess | null) {
  if (s?.kind === "shell") { renderShellInspector(s); return; }
  if (s?.kind === "task") { renderTaskInspector(s); return; }
  const pill = $("iPill"); const k = s ? statusKey(s) : "idle";
  pill.className = "pill " + k;
  $("iPillTxt").textContent = s ? (s.attention ? s.attention : PILL_TEXT[s.phase]) : "–";
  if (!s) { $("inspector").innerHTML = `<div class="insp-empty">No session selected.</div>`; return; }

  const html: string[] = [];
  // ACT — a pending permission is the only thing that should ever jump the queue.
  if (s.attention) {
    const risk = s.pendingPermId && s.pendRisk ? `<span class="risk ${s.pendRisk}">${RISK_LABEL[s.pendRisk]}</span>` : "";
    const permBtns = s.pendingPermId
      ? `<div class="attn-btns"><button class="allow" data-perm="allow" data-permid="${s.pendingPermId}">Allow</button><button data-perm="deny" data-permid="${s.pendingPermId}">Deny</button><button data-perm="terminal" data-permid="${s.pendingPermId}">In terminal</button></div>`
      : "";
    html.push(`<div class="attn"><div class="attn-h">🔔 ${esc(s.attention)}${risk}</div>${s.pendingCmd ? `<code>${esc(s.pendingCmd)}</code>` : ""}${permBtns}</div>`);
  }
  html.push(vitalHtml(s));                                        // state, dwell, current tool
  html.push(gaugesHtml(s));                                       // TRACK — context + cost
  if (s.todos.length) html.push(planHtml(s));                     // the plan it's keeping
  // What's changed on disk, and how the branch sits against its upstream. Shown
  // for any repo session — a clean tree that's behind is exactly what you want to
  // see, and it's the only place the fetch/pull/push buttons live.
  if (s.git) html.push(wsetHtml(s));
  html.push(timelineHtml(s));                                     // activity, by tool
  if (s.res) html.push(resHtml(s));                              // REFERENCE — cpu/mem, pinned to the bottom
  $("inspector").innerHTML = html.join("");
}
function renderFoot() {
  const total = usage[todayKey()] || 0;
  $("fSessions").textContent = String(sessions.size);
  $("fCost").textContent = "$" + total.toFixed(2);
  paintFootRl("fRl", "fRlReset", forecast5h());
  paintFootRl("fRl7", "fRl7Reset", forecast7d());
  $("fEngine").textContent = engineDef(termEngine).label;
  if ($("usagePop").classList.contains("show")) renderUsagePop();
}
// Colour the footer % by its forecast (not its raw level), and show a muted
// countdown to that window's reset beside it — see the forecast section above.
function paintFootRl(pctId: string, resetId: string, f: Forecast) {
  const pctEl = $(pctId), resetEl = $(resetId);
  pctEl.textContent = f.used != null ? Math.round(f.used) + "%" : "–";
  pctEl.className = f.used == null ? "" : "s-" + f.status; // neutral until we have a reading
  resetEl.textContent = f.resetTs != null ? "↻ " + fmtUntil(f.resetTs) : "";
}
// The forecast presentation (foreText / verdictChip / usageRow) and the whole
// Usage analytics panel now live in ./usageview. What stays here is what talks to
// the DOM or the backend: the popup below, and refreshTokens.
function renderUsagePop() {
  const noData = rl.h5 == null && rl.d7 == null;
  $("usagePop").innerHTML = `<div class="up-h">Claude usage limits</div>
    ${usageRow("Session", "5-hour window", forecast5h())}
    ${usageRow("Weekly", "7-day window", forecast7d())}
    <div class="up-foot"><span>today <b>$${(usage[todayKey()] || 0).toFixed(2)}</b></span><span>${sessions.size} live · account-wide</span></div>
    ${noData ? `<div class="up-note">Appears once a running session reports a statusLine.</div>` : ""}`;
}
function openUsagePop() {
  const r = $("fUsageSeg").getBoundingClientRect();
  const pop = $("usagePop");
  renderUsagePop();
  closeFootMenus("usagePop");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
function closeUsagePop() { $("usagePop").classList.remove("show"); }


// Scan the transcripts for token totals, at most once per 10 min (a full read of
// the recent corpus). Async + cached, so the tab paints instantly from localStorage
// and re-paints when fresh numbers land. `force` bypasses the throttle.
async function refreshTokens(force = false) {
  if (tokenScanning) return;
  if (!force && tokenDays.length && Date.now() - tokenScanAt < 6e5) return;
  setTokenScanning(true);
  if (settingsOpen() && setTab === "usage") renderSettings(); // surface the "scanning…" hint
  try {
    setTokenDays(await invoke<DayUsage[]>("token_usage_by_day", { days: 400 }));
  } catch (e) { dlog("warn", "token scan failed: " + e); }
  finally { setTokenScanning(false); if (settingsOpen() && setTab === "usage") renderSettings(); }
}

// Only one floating footer/overlay menu may be open at a time: every open* closes
// the rest first. (The footer triggers stopPropagation, so the document-level
// outside-click close never fires for them — this is what keeps them exclusive.)
function closeFootMenus(keep?: string) {
  const menus: [string, () => void][] = [
    ["colorPop", closeColorPop], ["enginePop", closeEnginePop], ["cafPop", closeCafPop],
    ["usagePop", closeUsagePop], ["attnPop", closeAttnPop], ["shortPop", closeShortPop],
  ];
  for (const [id, close] of menus) if (id !== keep) close();
}
// Keyboard shortcuts, listed in the footer's ⌘ Shortcuts popover. Keep in sync with
// the global keydown handler (the sole source of truth for what these actually do).
const SHORTCUTS: { label: string; chords: string[][] }[] = [
  { label: "Command palette", chords: [["⌘", "K"]] },
  { label: "Switch to session 1–9", chords: [["⌘", "1–9"]] },
  { label: "Open a terminal here", chords: [["⌘", "T"]] },
  { label: "Toggle sidebar", chords: [["⌘", "B"]] },
  { label: "Toggle inspector", chords: [["⌘", "I"]] },
  { label: "Settings", chords: [["⌘", ","]] },
  { label: "Terminal font size", chords: [["⌘", "+"], ["⌘", "−"], ["⌘", "0"]] },
];
function renderShortPop() {
  const rows = SHORTCUTS.map((s) => {
    const keys = s.chords
      .map((c) => `<span class="sc-chord">${c.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</span>`)
      .join(`<span class="sc-or">/</span>`);
    return `<div class="sc-row"><span class="sc-desc">${esc(s.label)}</span><span class="sc-keys">${keys}</span></div>`;
  }).join("");
  $("shortPop").innerHTML = `<div class="sc-h">Keyboard shortcuts</div>${rows}`;
}
function openShortPop() {
  const r = $("fShortSeg").getBoundingClientRect();
  const pop = $("shortPop");
  renderShortPop();
  closeFootMenus("shortPop");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
function closeShortPop() { $("shortPop").classList.remove("show"); }
// The fleet's "needs you" set — sessions with a blocking permission, an error, or
// finished and awaiting your reply — most urgent first (waiting wins), longest in
// that state first. Independent of the sidebar sort so the reactor is stable.
// A failed run counts: the whole point of running tasks in Episko is that a red
// build reaches you the same way a blocked session does. A *successful* run does
// not — it settles quietly and auto-dismisses.
function needsYou(s: Sess): boolean {
  if (s.kind === "shell") return false;
  if (s.kind === "task") return taskPrefs.attention && s.phase === "error";
  return !!s.attention || s.phase === "done" || s.phase === "error";
}
function needsYouSessions(): Sess[] {
  return [...sessions.values()].filter(needsYou).sort((a, b) => urgencyRank(a) - urgencyRank(b) || a.phaseSince - b.phaseSince);
}
function reactorState(s: Sess): "attention" | "error" | "done" { return s.attention ? "attention" : s.phase === "error" ? "error" : "done"; }
function reactorLabel(dom: "attention" | "error" | "done", n: number): string {
  if (dom === "attention") return `${n} need${n === 1 ? "s" : ""} you`;
  if (dom === "error") return `${n} error${n === 1 ? "" : "s"}`;
  return `${n} your turn`;
}
// Header "reactor": one rollup of the fleet's most-urgent state. Clicking it jumps
// straight to the longest-waiting session in that state (a picker if several).
function renderAttn() {
  const list = needsYouSessions();
  const b = $("attnBadge");
  if (!list.length) { b.className = "attn-badge"; closeAttnPop(); return; }
  const dom = reactorState(list[0]);
  const n = list.filter((s) => reactorState(s) === dom).length;
  b.className = `attn-badge show react-${dom}${list.length > 1 ? " multi" : ""}`;
  $("attnBadgeTxt").textContent = reactorLabel(dom, n);
  if ($("attnPop").classList.contains("show")) { if (list.length > 1) openAttnPop(list); else closeAttnPop(); }
}
// Click the reactor → jump to the session; if several need you, a dropdown lists
// project + title + reason so you can pick which to jump to.
function badgeLabel(s: Sess) { return s.title || (s.worktree ? `⑃ ${s.branch}` : (s.branch || "session")); }
function openAttnPop(list: Sess[]) {
  const r = $("attnBadge").getBoundingClientRect();
  const pop = $("attnPop");
  closeFootMenus("attnPop");
  pop.innerHTML = list.map((s) => {
    const k = statusKey(s);
    const reason = s.attention || PILL_TEXT[s.phase];
    return `<button class="ap-item" data-sel="${s.id}"><span class="ap-dot ${GCLASS[k]}">${GLYPH[k]}</span><span class="ap-main"><span class="ap-proj">${esc(s.project)}</span><span class="ap-ttl">${esc(badgeLabel(s))}</span></span><span class="ap-reason ${GCLASS[k]}">${esc(abbr(reason, 42))}</span></button>`;
  }).join("");
  pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  pop.style.left = "auto";
  pop.style.top = (r.bottom + 6) + "px";
  pop.classList.add("show");
}
function closeAttnPop() { $("attnPop").classList.remove("show"); }
// ---------- macOS menu-bar (tray) mirror of the sidebar ----------
let lastTraySig = "";
function updateTray() {
  const list = orderedSessions();
  const items = list.map((s) => {
    const k = statusKey(s);
    const branch = s.worktree ? `⑃ ${s.branch}` : (s.branch || "session");
    const status = s.attention ? s.attention : PILL_TEXT[s.phase];
    return { id: s.id, label: `${GLYPH[k]}  ${s.project} · ${branch}  —  ${status}` };
  });
  const needy = needsYouSessions();
  const n = list.length;
  let title = "", tooltip = "Episko — no active sessions";
  if (n > 0) {
    if (needy.length) {
      const dom = reactorState(needy[0]);
      const c = needy.filter((s) => reactorState(s) === dom).length;
      title = `${GLYPH[dom]} ${c}`;
      tooltip = `Episko — ${n} session${n === 1 ? "" : "s"}, ${reactorLabel(dom, c)}`;
    } else {
      title = `● ${n}`;
      tooltip = `Episko — ${n} session${n === 1 ? "" : "s"}`;
    }
  }
  const sig = title + "|" + tooltip + "|" + items.map((i) => i.label).join("§");
  if (sig === lastTraySig) return; // avoid rebuilding the native menu on every telemetry tick
  lastTraySig = sig;
  invoke("update_tray", { title, tooltip, items }).catch(() => {});
}
// ▶ Run and ❯ Terminal both act on the active project's directory, so with no
// session, shell or mirrored external there is nothing for them to act on. Greying
// them says so up front; a live button whose only response is an error toast reads
// as if the click failed. The guards in openRunPicker/openPlainTerminal stay, since
// ⌘⇧R and ⌘T bypass the button entirely.
function syncStageButtons() {
  const wd = activeCwd();
  const set = (id: string, enabled: string) => {
    const b = $(id) as HTMLButtonElement;
    b.disabled = !wd;
    b.title = wd ? enabled : "Start a session first — this runs in the active project";
  };
  set("btnRun", "Run a task or script from this project");
  set("btnTerm", "Open a plain (non-Claude) terminal at the project root");
}
function renderAll() {
  renderSidebar(); renderMini(); renderFoot(); renderAttn(); syncStageButtons();
  // When mirroring an external session, activeId is null but the stage/inspector
  // belong to that external — render it, NOT the null "no session" state. Skipping
  // this is what let a background Episko session's telemetry tick blank the
  // external header/inspector ~1s after clicking it.
  if (pastMirrorId()) {
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

// ---------- palette (⌘K) ----------
// A fused switcher + command runner. Prefixes scope the search (⟩ commands,
// @ sessions/projects, / by state); results are grouped with the "Needs you" set
// pinned on top, fuzzy-matched with highlight, and frecency-ranked. ⌘K on a session
// opens an action panel (jump, terminal, worktree, kill, answer permission) without
// leaving the box — a page stack you back out of with Backspace/Esc.
interface PalGroup { name: string; count?: number; items: PalItem[] }
let palGroups: PalGroup[] = [];
let palFlat: PalItem[] = [];   // the selectable rows, in display order
let palSel = 0;
let palPage: "root" | "actions" = "root";
let palActionSess: Sess | null = null;

// The ⌘K-within action list for one session.
function sessionActions(s: Sess): PalItem[] {
  const mk = (label: string, glyph: string, run: () => void): PalItem => ({ kind: "action", key: "", label, labelHtml: esc(label), glyph, run });
  const a: PalItem[] = [mk("Jump to session", "→", () => setActive(s.id))];
  if (s.pendingPermId) {
    a.push(mk("Allow the pending permission", "✓", () => resolvePermission(s.pendingPermId!, "allow")));
    a.push(mk("Deny the pending permission", "✕", () => resolvePermission(s.pendingPermId!, "deny")));
    a.push(mk("Answer it in the terminal", "❯", () => resolvePermission(s.pendingPermId!, "terminal")));
  }
  if (isAgent(s)) {
    // Only offered for repo sessions — s.git is null when the workdir isn't one.
    if (s.git) {
      const b = s.git.behind, ah = s.git.ahead;
      a.push(mk("Fetch from the remote", "↻", () => runGit(s.id, "fetch")));
      a.push(mk(b ? `Pull ${b} commit${b === 1 ? "" : "s"}` : "Pull (fast-forward only)", "↓", () => runGit(s.id, "pull")));
      a.push(mk(ah ? `Push ${ah} commit${ah === 1 ? "" : "s"}` : "Push", "↑", () => runGit(s.id, "push")));
    }
    a.push(mk("Open a terminal here", "❯", () => { setActive(s.id); openPlainTerminal(); }));
    a.push(mk("New session here…", "⑃", () => openWt(s.project, s.colorKey)));
    // Only when this session lives in a worktree (not the repo's main checkout):
    // clean up its worktree (and merged branch) without dropping to a shell.
    if (s.worktree) a.push(mk("Remove this worktree…", "⌫", () => removeWorktreeSession(s)));
  }
  a.push(mk("Close session", "✕", () => closeSession(s.id)));
  return a;
}
const PAL_CMDS: { key: string; label: string; glyph: string; run: () => void; sc?: string[] }[] = [
  { key: "cmd:add", label: "Add a project folder…", glyph: "＋", run: addProject },
  { key: "cmd:term", label: "Open a terminal in the current project", glyph: "❯", run: openPlainTerminal, sc: [MOD, "T"] },
  { key: "cmd:run", label: "Run a task in the current project…", glyph: "▶", run: () => { void openRunPicker(); }, sc: [MOD, "⇧", "R"] },
  { key: "cmd:tasks", label: "Manage this project's tasks…", glyph: "✎", run: () => { void openTaskManager(); } },
  { key: "cmd:sort", label: "Change the sidebar sort order", glyph: "≡", run: cycleSort },
  { key: "cmd:insp", label: "Toggle the inspector", glyph: "◨", run: toggleInsp, sc: [MOD, "I"] },
  { key: "cmd:rail", label: "Toggle the sidebar", glyph: "◧", run: toggleRail, sc: [MOD, "B"] },
  { key: "cmd:theme", label: "Toggle the theme", glyph: "◐", run: toggleTheme },
];
function buildPalGroups(raw: string): PalGroup[] {
  // action panel page — one group of the target session's actions, fuzzy-filtered
  if (palPage === "actions" && palActionSess) {
    const t = raw.trim();
    const items = sessionActions(palActionSess).map((it) => scoreItem(it, t)).filter(Boolean) as PalItem[];
    items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const label = palActionSess.title || palActionSess.branch || "session";
    return [{ name: `↩ ${palActionSess.project} · ${label}`, items }];
  }
  const { mode, term } = parsePal(raw);
  const searchTerm = mode === "filter" ? "" : term;   // in /filter mode the term is a state, not a name
  const emptyTerm = !searchTerm;
  const order = new Map(orderedSessions().map((s, i) => [s.id, i]));
  const stateOf = (s: Sess) => (s.attention ? "waiting" : s.phase);
  const matchesState = mode === "filter" && term ? (s: Sess) => stateOf(s).startsWith(term.toLowerCase()) : () => true;

  const sessCands: PalItem[] = [...sessions.values()].filter(matchesState).map((s) => {
    const i = order.get(s.id);
    const label = `${s.project} · ${s.kind === "task" ? "▶ " + (s.run?.label ?? "task") : s.title || s.branch || (s.kind === "shell" ? "shell" : "session")}`;
    const sub = s.kind === "shell" ? "shell"
      : s.kind === "task" ? `task · ${taskStateText(s)}`
      : `${verbFor(s).toLowerCase()}${s.ctxPct != null ? ` · ${Math.round(s.ctxPct)}% ctx` : ""}${s.cost != null ? ` · $${s.cost.toFixed(2)}` : ""}`;
    return { kind: "session", key: "session:" + s.id, label, labelHtml: esc(label), sub, sw: accentFor(s.colorKey), icon: iconFor(s.colorKey) || undefined, shortcut: i != null && i < 9 ? [MOD, String(i + 1)] : undefined, session: s, run: () => setActive(s.id) };
  });
  // Tasks for the active project. Discovery is async, so this reads a cache the
  // palette warms on open — an empty first frame is corrected in place.
  const taskCands: PalItem[] = palTasks.map((r) => ({
    kind: "task", key: "task:" + r.id, label: `Run ${r.label}`, labelHtml: esc(`Run ${r.label}`),
    sub: `${r.source} · ${execCmd(r)}`, glyph: r.blocked ? "⃠" : "▶",
    run: () => {
      const c = runTargetCtx(); if (!c) return;
      const o = { colorKey: c.colorKey, worktree: c.worktree, branch: c.branch, discoveredIn: c.workdir };
      if (r.id === "just:__untrusted") { void askTrust(c.colorKey, c.project); return; }
      if (r.inputs.length) { openInputPrompt(r, c.project, o); return; }
      void launchWithDeps(r, c.project, o);
    },
  }));
  // Same source as the sidebar (see allProjects) — a project detected from an external
  // session is just as launchable as a favourite, and hiding it here made "+ Session"
  // with nothing selected look like it was picking projects at random.
  const launchCands: PalItem[] = allProjects().map((p) => ({ kind: "launch", key: "launch:" + p.path, label: `Launch ${p.name}`, labelHtml: esc(`Launch ${p.name}`), sub: tilde(p.path), sw: accentFor(p.path), icon: iconFor(p.path) || undefined, run: () => requestLaunch(p.name, p.path) }));
  const cmdCands: PalItem[] = PAL_CMDS.map((c) => ({ kind: "command", key: c.key, label: c.label, labelHtml: esc(c.label), sub: "command", glyph: c.glyph, shortcut: c.sc, run: c.run }));
  for (const id of availEngines) { const d = engineDef(id); cmdCands.push({ kind: "command", key: "engine:" + id, label: `New sessions in ${d.label}${id === termEngine ? " ✓" : ""}`, labelHtml: esc(`New sessions in ${d.label}${id === termEngine ? " ✓" : ""}`), sub: d.sub, glyph: id === "embedded" ? "▤" : "⧉", run: () => setEngine(id) }); }

  const score = (arr: PalItem[]) => arr.map((it) => scoreItem(it, searchTerm)).filter(Boolean) as PalItem[];
  const byScore = (a: PalItem, b: PalItem) => (b.score ?? 0) - (a.score ?? 0);
  const byFrec = (a: PalItem, b: PalItem) => frecScore(b.key) - frecScore(a.key);
  const sessNatural = (a: PalItem, b: PalItem) => urgencyRank(a.session!) - urgencyRank(b.session!) || b.session!.lastActivity - a.session!.lastActivity;

  const sess = score(sessCands), launch = score(launchCands), cmds = score(cmdCands), tsk = score(taskCands);
  const needy = sess.filter((i) => needsYou(i.session!)).sort(emptyTerm ? sessNatural : byScore);
  const rest = sess.filter((i) => !needsYou(i.session!)).sort(emptyTerm ? sessNatural : byScore);

  const groups: PalGroup[] = [];
  const recentKeys = new Set<string>();
  if (mode !== "cmd" && needy.length) groups.push({ name: "Needs you", count: needy.length, items: needy });
  if (emptyTerm && mode === "all") {
    const recent = [...cmds, ...launch, ...tsk].filter((i) => frecScore(i.key) > 0).sort(byFrec).slice(0, 3);
    recent.forEach((i) => recentKeys.add(i.key));
    if (recent.length) groups.push({ name: "Recent", items: recent });
  }
  if (mode !== "cmd" && rest.length) groups.push({ name: "Sessions", count: rest.length, items: rest });
  if (mode === "all" || mode === "sess") { const l = launch.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (l.length) groups.push({ name: "Launch", items: l }); }
  if (mode === "all" || mode === "sess") { const t = tsk.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (t.length) groups.push({ name: "Tasks", count: t.length, items: t }); }
  if (mode === "all" || mode === "cmd") { const c = cmds.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (c.length) groups.push({ name: "Commands", items: c }); }
  if (!groups.length) groups.push({ name: "No matches", items: [{ kind: "fallback", key: "", label: "Add a project folder…", labelHtml: esc("Add a project folder…"), glyph: "＋", run: addProject }] });
  return groups;
}
function runPalItem(it: PalItem | undefined) { if (!it) return; bumpFrec(it.key); closePalette(); it.run(); }
function openPalActions(s: Sess) { palPage = "actions"; palActionSess = s; const inp = $("palInput") as HTMLInputElement; inp.value = ""; palSel = 0; refreshPal(); inp.focus(); }
function popPalPage() { palPage = "root"; palActionSess = null; const inp = $("palInput") as HTMLInputElement; inp.value = ""; palSel = 0; refreshPal(); inp.focus(); }
function renderPal() {
  let idx = 0;
  const html = palGroups.map((g) => {
    const rows = g.items.map((it) => {
      const i = idx++;
      const ic = it.icon ? `<img class="pal-icimg" src="${it.icon}" alt="" />` : it.sw ? `<span class="sw" style="background:${it.sw}"></span>` : (it.glyph || "›");
      const sh = it.shortcut ? `<span class="pal-sh">${it.shortcut.map((k) => `<span class="k">${esc(k)}</span>`).join("")}</span>`
        : it.session ? `<span class="pal-sh actions"><span class="k">${chord("K")}</span></span>` : "";
      return `<div class="pal-item ${i === palSel ? "on" : ""}" data-i="${i}"><span class="pal-ic">${ic}</span><span class="pal-main"><span class="pm">${it.labelHtml}</span>${it.sub ? `<span class="ps">${esc(it.sub)}</span>` : ""}</span>${sh}</div>`;
    }).join("");
    return `<div class="pal-gh">${esc(g.name)}${g.count ? `<span class="gc">${g.count}</span>` : ""}</div>${rows}`;
  }).join("");
  $("palList").innerHTML = html || `<div class="pal-item"><span class="pal-main"><span class="pm" style="color:var(--muted)">No matches</span></span></div>`;
  $("palList").querySelectorAll<HTMLElement>(".pal-item[data-i]").forEach((el) => el.addEventListener("click", () => runPalItem(palFlat[+el.dataset.i!])));
  const foot = $("palFoot");
  foot.innerHTML = palPage === "actions"
    ? `<span>↵ run</span><span>⌫ back</span><span class="sp"></span><span>esc close</span>`
    : `<span class="pf-mode">⟩ command</span><span>@ project</span><span>/ state</span><span class="sp"></span><span>${chord("K")} actions · esc</span>`;
  $("palList").querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
}
function refreshPal() { palGroups = buildPalGroups(($("palInput") as HTMLInputElement).value); palFlat = palGroups.flatMap((g) => g.items); palSel = 0; renderPal(); }
let palTasks: Runnable[] = [];
function openPalette() {
  palPage = "root"; palActionSess = null; palSel = 0;
  const c = runTargetCtx();
  palTasks = [];
  if (c) void discoverTasks(c.workdir, c.colorKey).then((l) => { palTasks = l; if ($("palette").classList.contains("show")) refreshPal(); });
  $("scrim").classList.add("show");
  $("palette").classList.add("show");
  ($("palInput") as HTMLInputElement).value = "";
  refreshPal();
  setTimeout(() => ($("palInput") as HTMLInputElement).focus(), 30);
}
function closePalette() { $("scrim").classList.remove("show"); $("palette").classList.remove("show"); palPage = "root"; palActionSess = null; }

// ---------- settings ----------
// The window main.ts has wanted for a while: it finally gives the worktree-grouping
// mode a control (it was reachable only as episkoWtGroup() in the console), and it
// owns the task settings that would otherwise be hardcoded bets.

// ---------- panels / theme ----------
function setSort(m: SortMode, announce = true) {
  setSortMode(m);
  localStorage.setItem("cc-sort", m);
  const b = $("railSort");
  b.textContent = SORT_META[m].glyph;
  b.title = `Sort: ${SORT_META[m].label} · click to change`;
  b.classList.toggle("on", m !== "manual");
  if (announce) toast(SORT_META[m].label);
  renderSidebar(); renderMini();
}
function cycleSort() { setSort(SORT_MODES[(SORT_MODES.indexOf(sortMode) + 1) % SORT_MODES.length]); }
function toggleRail() { $("app").classList.toggle("rail-mini"); }
function toggleInsp() { $("app").classList.toggle("insp-off"); $("inspBtn").classList.toggle("on", !$("app").classList.contains("insp-off")); refit(); }
// The effective theme = an explicit data-theme override, else the OS preference.
function effectiveTheme(): "dark" | "light" {
  const a = document.documentElement.getAttribute("data-theme");
  if (a === "dark" || a === "light") return a;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function setTheme(t: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("cc-theme", t);
  renderSettings(); // keep the settings picker in sync if it's open
}
function toggleTheme() { setTheme(effectiveTheme() === "dark" ? "light" : "dark"); }
// Fit one terminal to its pane, push the new size to its PTY, and force a full
// repaint. The repaint is not cosmetic: on a resize the WebGL renderer only redraws
// cells its damage tracker flagged, so a cell that went glyph→blank can keep a stale
// glyph in the GL framebuffer (the "floating chars" past a shrunk table). refresh()
// re-rasterizes every visible row straight from the buffer, clearing those ghosts.
// Only ever call this on the *active* pane — an inactive one is display:none, so
// fit() would measure a zero-size box and resize the PTY to garbage.
function fitSession(s: Sess) {
  if (!s.term || !s.fit) return;
  try {
    s.fit.fit();
    invoke("resize_pty", { sessionId: s.id, rows: s.term.rows, cols: s.term.cols });
    s.term.refresh(0, s.term.rows - 1);
  } catch { /* pane not measurable yet */ }
}
function refit() { if (!activeId) return; const s = sessions.get(activeId); if (s) fitSession(s); }
function applyFontSize() { for (const s of sessions.values()) if (s.term) s.term.options.fontSize = termFontSize; refit(); localStorage.setItem("cc-term-font", String(termFontSize)); }
function bumpFont(d: number) { setTermFontSize(Math.max(8, Math.min(28, termFontSize + d))); applyFontSize(); toast(`Terminal font ${termFontSize}px`); }


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
  }
  renderAll();
});

// A green run shouldn't linger — tasks are far more numerous and shorter-lived
// than sessions, and without this the rail silently fills with ticks. A pane you
// are actually looking at is never yanked away, and a failure never auto-closes.
function scheduleDismiss(s: Sess) {
  if (s.run?.background || !taskPrefs.dismissMs) return;
  window.setTimeout(() => {
    const cur = sessions.get(s.id);
    if (!cur || cur.run?.exitCode !== 0) return;   // re-run or still failing → leave it
    if (activeId === cur.id) return;               // you're reading it
    closeSession(cur.id);
  }, taskPrefs.dismissMs);
}
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
  if (performance.now() < reorderGuardUntil) { reorderGuardUntil = 0; return; }
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
  const el = t.closest<HTMLElement>("[data-perm],[data-git],[data-diff],[data-close],[data-remove],[data-add],[data-jump],[data-resume],[data-forget],[data-ext],[data-past],[data-sel],[data-launch],[data-pal],[data-rail],[data-toast]");
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
  else if (el.dataset.pal) openPalette();
  else if (el.dataset.rail) toggleRail();
  else if (el.dataset.toast) toast(el.dataset.toast);
});

// recolor a project — click its color dot, or right-click the project
// 12 perceptually distinct hues around the wheel
const SWATCHES = ["#f2555a", "#fb923c", "#facc15", "#a3e635", "#34d399", "#2dd4bf", "#22d3ee", "#38bdf8", "#818cf8", "#a78bfa", "#d084f5", "#f472b6"];
let popKey: string | null = null;
function normalizeHex(v: string): string | null {
  let x = v.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(x)) x = x.split("").map((c) => c + c).join("");
  return /^[0-9a-fA-F]{6}$/.test(x) ? "#" + x.toLowerCase() : null;
}
// Show a floating panel, then clamp it inside the viewport against its *measured*
// size — these panels change height with their optional rows, so a hard-coded
// estimate would hang them off-screen.
function placePop(el: HTMLElement, x: number, y: number) {
  el.classList.add("show");
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)) + "px";
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)) + "px";
}
// The appearance panel: colour swatches + logo. Opens standalone at the cursor
// (clicking a colour dot) or as the context menu's submenu — `flipFrom` is the
// parent menu's rect, so a panel that won't fit to its right lands on its left
// instead of being shoved back over the menu it belongs to.
function openColorPopover(key: string, x: number, y: number, flipFrom?: DOMRect) {
  popKey = key;
  closeFootMenus("colorPop");
  const cur = accentFor(key).toLowerCase();
  const pop = $("colorPop");
  pop.innerHTML =
    SWATCHES.map((c) => `<button class="sw-btn ${c === cur ? "on" : ""}" style="background:${c}" data-c="${c}"></button>`).join("") +
    `<div class="sw-row"><input class="sw-hex" type="text" spellcheck="false" placeholder="#hex" value="${cur}" maxlength="7" /><button class="sw-apply">Set</button></div>` +
    `<button class="sw-auto" data-c="auto">Auto color</button>` +
    `<button class="sw-auto" data-c="seticon">Set custom logo…</button>` +
    (customIcons[key] ? `<button class="sw-auto" data-c="reseticon">Restore repo logo</button>` : "") +
    (iconFor(key) ? `<button class="sw-auto" data-c="delicon">Use color dot (hide icon)</button>` : "");
  pop.classList.add("show"); // shown before measuring, or offsetWidth reads 0
  if (flipFrom && x + pop.offsetWidth > window.innerWidth - 8) x = flipFrom.left - pop.offsetWidth - 6;
  placePop(pop, x, y);
}
function closeColorPop() {
  $("colorPop").classList.remove("show");
  popKey = null;
  $("ctxMenu").querySelector(".sub-open")?.classList.remove("sub-open");
}
function applyColor(key: string) {
  renderAll();
  const s = activeId ? sessions.get(activeId) : null;
  if (s && s.colorKey === key) document.documentElement.style.setProperty("--accent", accentFor(s.colorKey));
}
function setColor(key: string, hex: string | null) {
  if (hex === null) delete colorOverrides[key]; else colorOverrides[key] = hex;
  localStorage.setItem("cc-colors", JSON.stringify(colorOverrides));
  closeColorPop();
  applyColor(key);
}
function commitHex(v: string) {
  if (!popKey) return;
  const h = normalizeHex(v);
  if (!h) { toast("Enter a valid hex, e.g. #7c5cff"); return; }
  setColor(popKey, h);
}
$("colorPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sw-apply")) { const inp = $("colorPop").querySelector<HTMLInputElement>(".sw-hex"); if (inp) commitHex(inp.value); return; }
  const b = t.closest<HTMLElement>("[data-c]");
  if (!b || !popKey) return;
  // Every button here commits something, so the whole stack (submenu + the menu
  // that opened it) closes with it.
  const key = popKey;
  closeCtxMenu();
  if (b.dataset.c === "delicon") { clearIcon(key); closeColorPop(); return; }
  if (b.dataset.c === "seticon") { closeColorPop(); pickCustomIcon(key); return; }
  if (b.dataset.c === "reseticon") { resetCustomIcon(key); closeColorPop(); return; }
  setColor(key, b.dataset.c === "auto" ? null : b.dataset.c!);
});
$("colorPop").addEventListener("keydown", (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sw-hex") && e.key === "Enter") { e.preventDefault(); commitHex((t as HTMLInputElement).value); }
});
// ---------- project context menu ----------
// Right-clicking anything that carries a project folder (`data-key` — a project
// head, an external row, a rail button) opens a real menu: one verb per row, with
// colour and logo tucked into an Appearance submenu (the swatch panel above,
// reused verbatim) so the everyday actions stay one click deep.
let ctxKey: string | null = null;
const projName = (key: string) => FAVORITES.find((f) => f.path === key)?.name || basename(key);
// Where "Open project folder" actually lands, so the row can name it.
const FILE_MANAGER = navigator.userAgent.includes("Windows") ? "Explorer" : navigator.userAgent.includes("Mac") ? "Finder" : "file manager";

type CtxRow = { act: string; ic: string; label: string; sub?: string; cls?: string; chev?: boolean };
const ctxRowHtml = (r: CtxRow) =>
  `<button class="mp-item ${r.cls || ""}" data-ctx="${r.act}"><span class="mp-ic">${r.ic}</span>`
  + `<span class="mp-main"><span class="mp-l">${esc(r.label)}</span>${r.sub ? `<span class="mp-s">${esc(r.sub)}</span>` : ""}</span>`
  + (r.chev ? `<span class="mp-chev">›</span>` : "") + `</button>`;

function openCtxMenu(key: string, x: number, y: number) {
  closeColorPop();
  ctxKey = key;
  const fav = FAVORITES.some((f) => f.path === key);
  const live = [...sessions.values()].filter((s) => s.colorKey === key && isAgent(s)).length;
  const ic = iconFor(key);
  const rows: (CtxRow | null)[] = [
    { act: "launch", ic: "＋", label: "New session", sub: live ? `${live} already running here` : "start Claude Code in this folder" },
    { act: "worktree", ic: "⑃", label: "New worktree session…", sub: "on a branch of its own" },
    { act: "terminal", ic: "❯", label: "Open terminal here", sub: termEngine === "embedded" ? "shell pane inside Episko" : engineDef(termEngine).label },
    null,
    { act: "folder", ic: "⌂", label: "Open project folder", sub: FILE_MANAGER },
    { act: "copypath", ic: "⧉", label: "Copy path" },
    null,
    { act: "appearance", ic: "◐", label: "Appearance", sub: "color, logo", chev: true },
    null,
    // Not every group in the sidebar is pinned: a folder also shows up while it has
    // a live or external session, then vanishes with it. So the row is about
    // *permanence*, not presence — say so, or "add" reads as a lie about a project
    // that's plainly already listed.
    fav
      ? { act: "removeproj", ic: "✕", label: "Remove project", sub: "unpins it — sessions keep running", cls: "mp-danger" }
      : { act: "addproj", ic: "☆", label: "Pin to sidebar", sub: "keeps it listed with no session running" },
  ];
  const menu = $("ctxMenu");
  menu.innerHTML =
    `<div class="mp-head">`
    + (ic ? `<img class="mp-hico" src="${ic}" alt="" />` : `<span class="mp-hsw" style="background:${accentFor(key)}"></span>`)
    + `<span class="mp-hmain"><span class="mp-hname">${esc(projName(key))}</span><span class="mp-hpath">${esc(tilde(key))}</span></span></div>`
    + rows.map((r) => (r ? ctxRowHtml(r) : `<div class="mp-sep"></div>`)).join("");
  placePop(menu, x, y);
  // A worktree only means something in a git repo. Ask *after* opening — the menu
  // must feel instant — then either name the branch it would fork from or drop the
  // row entirely. (A detached HEAD also answers None and loses the row; forking a
  // worktree from one is a corner case not worth a second probe.)
  invoke<string | null>("git_branch", { workdir: key }).then((b) => {
    if (ctxKey !== key) return; // menu closed or moved to another project meanwhile
    const row = menu.querySelector<HTMLElement>('[data-ctx="worktree"]');
    if (!row) return;
    if (!b) { row.remove(); placePop(menu, x, y); return; }
    const sub = row.querySelector(".mp-s");
    if (sub) sub.textContent = `branch off ${b}`;
  }).catch(() => {});
}
function closeCtxMenu() { $("ctxMenu").classList.remove("show"); ctxKey = null; }
const ctxMenuOpen = () => $("ctxMenu").classList.contains("show");

// A plain shell in this project's folder — embedded gets an in-app pane, the
// external engines their own window (the same split as openPlainTerminal).
function openTerminalIn(project: string, dir: string) {
  if (termEngine !== "embedded") { invoke("open_terminal_here", { workdir: dir, engine: termEngine }).catch((e) => toast("terminal: " + e)); return; }
  void launchShell(project, dir, { colorKey: dir });
}
async function copyPath(dir: string) {
  try { await navigator.clipboard.writeText(dir); toast("Path copied"); }
  catch { toast(dir); } // clipboard denied — at least show what it was
}

// Appearance is the one row that opens rather than commits: the menu stays put and
// the swatch panel hangs off its edge. Re-entrant — `mouseover` fires again for
// every child span the pointer crosses, and re-rendering the panel under the
// cursor would wipe a half-typed hex.
function openAppearanceSub(row: HTMLElement) {
  if (!ctxKey || row.classList.contains("sub-open")) return;
  row.classList.add("sub-open");
  const m = $("ctxMenu").getBoundingClientRect(), r = row.getBoundingClientRect();
  openColorPopover(ctxKey, m.right + 6, r.top - 6, m);
}
// Hover opens the submenu, the way a menu should. Moving onto any *other* row
// folds it away again; moving right, into the panel itself, leaves the menu
// entirely, so nothing here fires and it stays put.
$("ctxMenu").addEventListener("mouseover", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!row) return;
  if (row.dataset.ctx === "appearance") openAppearanceSub(row);
  else closeColorPop();
});
$("ctxMenu").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!b || !ctxKey) return;
  const key = ctxKey, name = projName(key);
  // Clicking it is the keyboard/touch path to the same thing hover already did.
  if (b.dataset.ctx === "appearance") { openAppearanceSub(b); return; }
  closeCtxMenu(); closeColorPop();
  switch (b.dataset.ctx) {
    case "launch": requestLaunch(name, key); break;
    case "worktree": openWt(name, key); break;
    case "terminal": openTerminalIn(name, key); break;
    case "folder": openProjectFolder(key); break;
    case "copypath": copyPath(key); break;
    case "addproj": addProjectPath(key); break;
    case "removeproj": removeFavorite(key); toast(`Removed ${name}`); break;
  }
});
document.addEventListener("contextmenu", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
  if (!el || !el.dataset.key) return;
  e.preventDefault();
  openCtxMenu(el.dataset.key, e.clientX, e.clientY);
});

// ---------- terminal-engine popover (footer "new in …") ----------
function openEnginePopover() {
  const seg = $("fEngineSeg");
  const r = seg.getBoundingClientRect();
  const pop = $("enginePop");
  closeFootMenus("enginePop");
  pop.innerHTML = availEngines.map((id) => {
    const d = engineDef(id);
    return `<button class="mp-item ${id === termEngine ? "on" : ""}" data-engine="${id}"><span class="mp-ic">${id === "embedded" ? "▤" : "⧉"}</span><span class="mp-main"><span class="mp-l">${esc(d.label)}</span><span class="mp-s">${esc(d.sub)}</span></span><span class="mp-check">✓</span></button>`;
  }).join("");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 228)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
function closeEnginePop() { $("enginePop").classList.remove("show"); }
$("enginePop").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-engine]");
  if (!b) return;
  setEngine(b.dataset.engine as Engine);
  closeEnginePop();
});

// ---------- caffeinate (keep-awake) ----------
// The top-bar split button drives a macOS `caffeinate` power assertion. The icon
// toggles the last-used preset (one click); the caret opens the picker. Three
// kinds of preset:
//   • static  — fixed flags, on until you stop it (display / system / full)
//   • timer   — a chosen duration (15m/1h/2h/4h), auto-off when it elapses
//   • agents  — dynamic: hold the Mac awake ONLY while sessions are busy, and
//               release when the fleet goes dormant; re-arms when work resumes
// "Armed" (the user turned it on) is distinct from "asserting" (a caffeinate
// child is actually running right now). For the agent mode those differ: armed
// but idle shows the cup lit without steam; asserting adds the steam + glow.
// reconcileCaf() is the single choke point — called on every renderAll(), it
// diffs the desired flags against what's running and only pokes the backend on a
// real change (same guarded-invoke pattern as updateTray).
// The flags below are macOS `caffeinate` switches, and they stay the wire format
// on both platforms: the Windows backend maps them onto `SetThreadExecutionState`
// bits (see `execution_state_for`) rather than making the UI speak two dialects.
const IS_WINDOWS = navigator.userAgent.includes("Windows");
const CAF_HOST = IS_WINDOWS ? "PC" : "Mac";
type CafKind = "static" | "timer" | "agents";
interface CafPreset { id: string; kind: CafKind; label: string; desc: string; glyph: string; flags?: string[] }
const ALL_CAF_PRESETS: CafPreset[] = [
  { id: "display", kind: "static", label: "Keep display awake", desc: "Screen + system stay on",     glyph: "☀", flags: ["-d"] },
  { id: "system",  kind: "static", label: "Keep system awake",  desc: "Runs on; screen may sleep",   glyph: "⏻", flags: ["-i"] },
  { id: "full",    kind: "static", label: "Fully caffeinated",  desc: "Display, disk & system",      glyph: "✺", flags: ["-dimsu"] },
  { id: "timer",   kind: "timer",  label: "Timed",              desc: "Stay awake, then auto-off",   glyph: "◷" },
  { id: "agents",  kind: "agents", label: "Until agents idle",  desc: "Awake only while agents work", glyph: "⟳" },
];
// Windows has no disk (`-m`) or user-active (`-u`) assertion, so "Fully
// caffeinated" would be a second, identical "Keep display awake" row there.
// Drop it — the validity check below rewrites a stored "full" to the first preset.
const CAF_PRESETS: CafPreset[] = IS_WINDOWS ? ALL_CAF_PRESETS.filter((p) => p.id !== "full") : ALL_CAF_PRESETS;
// The popover's right-hand chip: the literal flags on macOS, the execution state
// they translate to on Windows, where the raw flags would be meaningless jargon.
function cafChip(p: CafPreset): string {
  const flags = p.kind === "agents" ? ["-i"] : (p.flags ?? []);
  if (!flags.length) return "";
  if (!IS_WINDOWS) return flags.join(" ");
  return flags.some((f) => f.includes("d")) ? "display" : "system";
}
const CAF_DURATIONS: { sec: number; label: string }[] = [
  { sec: 900, label: "15m" }, { sec: 3600, label: "1h" }, { sec: 7200, label: "2h" }, { sec: 14400, label: "4h" },
];
const cafPreset = (id: string): CafPreset => CAF_PRESETS.find((p) => p.id === id) || CAF_PRESETS[0];
let cafPresetId = localStorage.getItem("cc-caffeinate") || CAF_PRESETS[0].id;
if (!CAF_PRESETS.some((p) => p.id === cafPresetId)) cafPresetId = CAF_PRESETS[0].id;
let cafTimerSec = parseInt(localStorage.getItem("cc-caf-timer") || "", 10) || 3600;
if (!CAF_DURATIONS.some((d) => d.sec === cafTimerSec)) cafTimerSec = 3600;
// agents mode: also count "waiting on you" (permission prompt / your turn) as
// busy, so an unattended run's prompt keeps the screen up. User-toggled switch.
let cafAgentsAwait = localStorage.getItem("cc-caf-await") !== "0";
let cafArmed = false;         // the user turned it on
let cafAssertKey = "";        // flags currently handed to the backend ("" = off)
let cafTimerHandle: number | null = null;

function cafPersist() {
  localStorage.setItem("cc-caffeinate", cafPresetId);
  localStorage.setItem("cc-caf-timer", String(cafTimerSec));
  localStorage.setItem("cc-caf-await", cafAgentsAwait ? "1" : "0");
}
// Is any real (non-shell) session doing work worth staying awake for?
function cafAgentsBusy(): boolean {
  for (const s of sessions.values()) {
    if (s.kind === "shell" || s.phase === "ended") continue;
    if (s.phase === "working" || s.phase === "thinking") return true;
    if (cafAgentsAwait && (!!s.attention || s.phase === "done")) return true;
  }
  return false;
}
// The flags we WANT running now, or null for "assert nothing".
function cafDesiredFlags(): string[] | null {
  if (!cafArmed) return null;
  const p = cafPreset(cafPresetId);
  if (p.kind === "agents") return cafAgentsBusy() ? ["-i"] : null;
  if (p.kind === "timer") return ["-di", "-t", String(cafTimerSec)];
  return p.flags ?? null;
}
function cafArmTimer() {
  if (cafTimerHandle !== null) { clearTimeout(cafTimerHandle); cafTimerHandle = null; }
  if (cafArmed && cafPreset(cafPresetId).kind === "timer") {
    cafTimerHandle = window.setTimeout(() => { cafArmed = false; reconcileCaf(); toast("Caffeinate ended"); }, cafTimerSec * 1000);
  }
}
function reconcileCaf() {
  const flags = cafDesiredFlags();
  const key = flags ? flags.join(" ") : "";
  if (key !== cafAssertKey) {
    cafAssertKey = key;
    invoke("set_caffeinate", { active: !!flags, flags: flags ?? [] }).catch((e) => { cafAssertKey = ""; toast("caffeinate: " + e); });
  }
  renderCaf();
}
function renderCaf() {
  const p = cafPreset(cafPresetId);
  $("caf").classList.toggle("on", cafArmed);
  $("caf").classList.toggle("asserting", cafAssertKey !== "");
  $("cafMain").title = !cafArmed ? `Keep this ${CAF_HOST} awake · ${p.label}`
    : p.kind === "agents" ? (cafAssertKey ? "Awake — agents are working" : "Armed — sleeps until agents work")
    : p.kind === "timer" ? `Awake · ${cafDurLabel(cafTimerSec)} timer — click to stop`
    : `Awake · ${p.label} — click to stop`;
}
const cafDurLabel = (sec: number) => (CAF_DURATIONS.find((d) => d.sec === sec) || { label: sec + "s" }).label;

// user actions -------------------------------------------------------------
function cafToggle() { cafArmed = !cafArmed; cafPersist(); cafArmTimer(); reconcileCaf(); dlog("info", `caffeinate ${cafArmed ? "on · " + cafPresetId : "off"}`); }
function cafPick(id: string) { cafPresetId = id; cafArmed = true; cafPersist(); cafArmTimer(); reconcileCaf(); dlog("info", `caffeinate on · ${id}`); }
function cafStop() { cafArmed = false; cafPersist(); cafArmTimer(); reconcileCaf(); }
function cafSetDuration(sec: number) { cafTimerSec = sec; cafPresetId = "timer"; cafArmed = true; cafPersist(); cafArmTimer(); reconcileCaf(); fillCafPop(); }
function cafSetAwait(v: boolean) { cafAgentsAwait = v; cafPersist(); reconcileCaf(); fillCafPop(); }

function fillCafPop() {
  const rows = CAF_PRESETS.map((p) => {
    const active = cafArmed && p.id === cafPresetId;
    const last = !cafArmed && p.id === cafPresetId; // what a plain click would use
    const chip = p.kind === "timer" ? "" : cafChip(p);
    const right = chip ? `<span class="mp-flags">${esc(chip)}</span>` : "";
    const item = `<button class="mp-item ${active ? "on" : last ? "cur" : ""}" data-caf="${p.id}">`
      + `<span class="mp-ic">${p.glyph}</span>`
      + `<span class="mp-main"><span class="mp-l">${esc(p.label)}</span><span class="mp-s">${esc(p.desc)}</span></span>`
      + right + `</button>`;
    let sub = "";
    if (p.kind === "timer") {
      sub = `<div class="caf-sub caf-durs">` + CAF_DURATIONS.map((d) =>
        `<button class="caf-dur ${d.sec === cafTimerSec ? "on" : ""}" data-cafdur="${d.sec}">${d.label}</button>`).join("") + `</div>`;
    } else if (p.kind === "agents") {
      sub = `<div class="caf-sub caf-switch-row">`
        + `<span class="caf-sw-lbl">Stay awake while agents await you</span>`
        + `<button class="caf-switch ${cafAgentsAwait ? "on" : ""}" role="switch" aria-checked="${cafAgentsAwait}" data-cafawait="1"><span class="caf-knob"></span></button></div>`;
    }
    return `<div class="caf-opt">${item}${sub}</div>`;
  }).join("");
  const off = cafArmed
    ? `<div class="mp-sep"></div><button class="mp-item mp-off" data-caf="off"><span class="mp-ic">⏹</span><span class="mp-main"><span class="mp-l">Stop caffeinate</span></span></button>`
    : "";
  $("cafPop").innerHTML = rows + off;
}
function openCafPop() {
  const r = $("caf").getBoundingClientRect();
  const pop = $("cafPop");
  fillCafPop();
  closeFootMenus("cafPop");
  const w = 260;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
  pop.style.bottom = "auto";
  pop.classList.add("show");
}
function closeCafPop() { $("cafPop").classList.remove("show"); }
$("cafMain").addEventListener("click", (e) => { e.stopPropagation(); closeCafPop(); cafToggle(); });
$("cafCaret").addEventListener("click", (e) => { e.stopPropagation(); $("cafPop").classList.contains("show") ? closeCafPop() : openCafPop(); });
$("cafPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  // Sub-controls rebuild the popover (fillCafPop), which detaches the clicked
  // node — so stop the event before it reaches the document outside-click
  // handler, which would then see a detached target and close the popover.
  const dur = t.closest<HTMLElement>("[data-cafdur]");
  if (dur) { e.stopPropagation(); cafSetDuration(+dur.dataset.cafdur!); return; } // keep open — sub-control
  if (t.closest("[data-cafawait]")) { e.stopPropagation(); cafSetAwait(!cafAgentsAwait); return; } // keep open — sub-control
  const b = t.closest<HTMLElement>("[data-caf]");
  if (!b) return;
  const id = b.dataset.caf!;
  if (id === "off") cafStop(); else cafPick(id);
  closeCafPop();
});

// Reactor click → jump straight to the longest-waiting session, or open a picker
// if several need you.
$("attnBadge").addEventListener("click", () => {
  const list = needsYouSessions();
  if (list.length === 0) return;
  if (list.length === 1) { setActive(list[0].id); closeAttnPop(); return; }
  $("attnPop").classList.contains("show") ? closeAttnPop() : openAttnPop(list);
});

$("kbar").addEventListener("click", openPalette);
$("themeBtn").addEventListener("click", toggleTheme);
$("railCollapse").addEventListener("click", toggleRail);
$("railSort").addEventListener("click", cycleSort);
$("inspBtn").addEventListener("click", toggleInsp);
// The active project context is either an Episko session or an external one.
function activeProjectCtx(): { project: string; path: string } | null {
  // For an external session use its repo root, not the worktree cwd, so launching a
  // session / opening a worktree from it operates on the repo (and groups under it).
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); if (e) { const root = e.repo_root || e.cwd; return { project: basename(root), path: root }; } }
  // A dormant session already stores colorKey (the repo key), so it needs no such resolution.
  if (pastMirrorId()) { const d = dormants.find((x) => x.id === pastMirrorId()); if (d) return { project: d.project, path: d.colorKey }; }
  const s = activeId ? sessions.get(activeId) : null;
  return s ? { project: s.project, path: s.colorKey } : null;
}
// The active session's *actual* cwd (the worktree dir for worktree sessions, not
// the color-grouping repo key) — used when opening a plain terminal there.
function activeCwd(): string | null {
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); return e ? e.cwd : null; }
  if (pastMirrorId()) { const d = dormants.find((x) => x.id === pastMirrorId()); return d ? d.workdir : null; }
  const s = activeId ? sessions.get(activeId) : null;
  return s ? s.workdir : null;
}
// Open a plain (non-Claude) terminal at the active project's cwd for running shell
// commands alongside a session. When the launch engine is "embedded" it opens an
// in-app shell pane (like a session); otherwise it opens the external terminal app.
function openPlainTerminal() {
  const wd = activeCwd();
  if (!wd) { toast("No active session"); return; }
  if (termEngine !== "embedded") { invoke("open_terminal_here", { workdir: wd, engine: termEngine }).catch((e) => toast("terminal: " + e)); return; }
  // Inherit the active session's repo grouping so a shell opened in a worktree nests
  // under its repo (as a worktree cluster) rather than appearing as its own project.
  // The active session/external always shares the shell's cwd, so it labels the cluster.
  const s = activeId ? sessions.get(activeId) : null;
  const e = extMirrorId() ? externals.find((x) => x.session_id === extMirrorId()) : undefined;
  // A dormant session can also own the stage; it already stores the repo key.
  const d = pastMirrorId() ? dormants.find((x) => x.id === pastMirrorId()) : undefined;
  const colorKey = s ? s.colorKey : e ? (e.repo_root || e.cwd) : d ? d.colorKey : wd;
  const worktree = s ? s.worktree : e ? (e.repo_root && e.cwd !== e.repo_root ? (e.branch || basename(e.cwd)) : null) : d ? d.worktree : null;
  const branch = s ? s.branch : (e?.branch || d?.branch || "");
  launchShell(s ? s.project : (d?.project ?? basename(colorKey)), wd, { colorKey, worktree, branch });
}
// ---------- the project tasks panel ----------
// Manage what the picker shows. Two kinds of change live here and they persist to
// different places on purpose: hiding a task is *yours* (localStorage), while a
// task's command is the *project's* (.episko/tasks.toml, committable). Only

let mgrCtx: { project: string; colorKey: string; workdir: string } | null = null;
let mgrList: Runnable[] = [];
// The discovered ids the project overrides — a discovered task edited into a
// committable `[override.*]` rather than a mutation of the file it came from.
let mgrOverrides: string[] = [];
// `kind` decides where a save lands: "own" writes a `[[task]]`, "override" writes an
// `[override."<id>"]` keyed by the discovered task's id.
let mgrEdit: { id: string | null; kind: "own" | "override"; label: string; run: string; group: string; background: boolean; cwd: string } | null = null;

async function openTaskManager() {
  const c = runTargetCtx();
  if (!c) { toast("No active project"); return; }
  mgrCtx = { project: c.project, colorKey: c.colorKey, workdir: c.workdir };
  mgrEdit = null;
  await refreshMgr();
  $("mgrDlg").classList.add("show");
  $("scrim").classList.add("show");
}
async function refreshMgr() {
  if (!mgrCtx) return;
  // Show hidden tasks too — this is the panel where you un-hide them.
  mgrList = await discoverTasks(mgrCtx.workdir, mgrCtx.colorKey, true);
  mgrOverrides = await invoke<string[]>("list_task_overrides", { workdir: mgrCtx.workdir }).catch(() => []);
  renderMgr();
}
function closeTaskManager() {
  $("mgrDlg").classList.remove("show");
  if (!$("palette").classList.contains("show") && !$("runPop").classList.contains("show")) $("scrim").classList.remove("show");
  mgrCtx = null; mgrEdit = null;
}

function renderMgr() {
  if (!mgrCtx) return;
  const { colorKey, project } = mgrCtx;
  $("mgrSub").textContent = project;

  const editing = !!mgrEdit;
  ($("mgrBack") as HTMLButtonElement).hidden = !editing;
  ($("mgrSave") as HTMLButtonElement).hidden = !editing;
  ($("mgrNew") as HTMLButtonElement).hidden = editing;
  ($("mgrOpen") as HTMLButtonElement).hidden = editing;
  ($("mgrRescan") as HTMLButtonElement).hidden = editing;
  if (mgrEdit) { renderMgrForm(); return; }

  const pins = pinnedIds(colorKey), hid = hiddenIds(colorKey);
  const rule = stopRules[colorKey];
  // A committable command edit lands in .episko/tasks.toml either way: our own
  // task in place, a discovered one as an [override.*] that never touches its file.
  const rowsHtml = mgrList.map((r) => {
        const own = r.source === "episko";
        const overridden = mgrOverrides.includes(r.id);
        const dangling = r.id.startsWith("override:");   // an override whose target vanished
        const editable = !r.blocked;
        // At most one task per project runs after a turn, so the glyph is a radio
        // in disguise: clicking another moves the rule, clicking this one clears it.
        const onStop = rule?.id === r.id;
        const noStop = stopRuleBlocked(r);
        const tags = `${r.background ? " · bg" : ""}${overridden ? " · overridden" : ""}${r.blocked ? " · " + esc(r.blocked) : ""}${onStop ? " · runs after each turn" : ""}`;
        const editBtn = own
          ? `<button class="mgr-b" data-edit="${esc(r.id)}" title="Edit in .episko/tasks.toml">✎</button>
             <button class="mgr-b danger" data-del="${esc(r.id)}" title="Delete from .episko/tasks.toml">✕</button>`
          : `<button class="mgr-b" data-edit="${esc(r.id)}" title="Edit — writes an override into .episko/tasks.toml, never ${esc(r.sourceFile)}">✎</button>`;
        const revertBtn = (overridden || dangling)
          ? `<button class="mgr-b" data-revert="${esc(dangling ? r.id.slice("override:".length) : r.id)}" title="Revert to what ${esc(r.sourceFile)} declares">↺</button>`
          : "";
        return `<div class="mgr-row${hid.includes(r.id) ? " off" : ""}">
          <span class="txt"><b>${esc(r.label)}</b><small>${esc(r.sourceFile)}${tags}</small></span>
          <span class="mgr-acts">
            <button class="mgr-b${pins.includes(r.id) ? " on" : ""}" data-pin="${esc(r.id)}" title="${pins.includes(r.id) ? "Unpin" : "Pin to the top of the picker"}">${pins.includes(r.id) ? "★" : "☆"}</button>
            <button class="mgr-b" data-hide="${esc(r.id)}" title="${hid.includes(r.id) ? "Show in the picker" : "Hide from the picker"}">${hid.includes(r.id) ? "◌" : "◎"}</button>
            <button class="mgr-b${onStop ? " on" : ""}${noStop ? " quiet" : ""}" ${noStop ? "disabled" : ""} data-onstop="${esc(r.id)}"
              title="${noStop ? esc(`Can't run after a turn — ${noStop}`) : onStop ? "Stop running this after a turn" : "Run this whenever a session in this project finishes a turn"}">⟲</button>
            ${revertBtn}${editable ? editBtn : ""}
          </span>
        </div>`;
      }).join("");
  // A per-project runner override — only meaningful when the project actually has
  // npm scripts. Absent everywhere else, so it doesn't imply a knob that does nothing.
  const runnerStrip = mgrList.some((r) => r.source === "npm")
    ? `<div class="mgr-row mgr-runner">
         <span class="txt"><b>Package runner</b><small>the lockfile picks this — override a repo that ships the wrong one</small></span>
         <span class="s-ctl">${RUNNERS.map((rn) =>
           `<button class="opt${runnerFor(colorKey) === rn ? " on" : ""}" data-runner="${rn}">${rn}</button>`).join("")}</span>
       </div>`
    : "";
  $("mgrBody").innerHTML = mgrList.length ? runnerStrip + rowsHtml : `<div class="run-empty">No tasks found in this project.</div>`;

  $("mgrBody").querySelectorAll<HTMLElement>("[data-pin]").forEach((el) =>
    el.addEventListener("click", () => { togglePin(colorKey, el.dataset.pin!); renderMgr(); }));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-hide]").forEach((el) =>
    el.addEventListener("click", () => { toggleHidden(colorKey, el.dataset.hide!); renderMgr(); }));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-onstop]").forEach((el) =>
    el.addEventListener("click", () => {
      const r = mgrList.find((x) => x.id === el.dataset.onstop!);
      if (!r) return;
      toggleStopRule(colorKey, r);
      toast(stopRules[colorKey]?.id === r.id
        ? `${r.label} will run when a session here finishes a turn`
        : `${r.label} no longer runs after a turn`);
      renderMgr();
    }));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-runner]").forEach((el) =>
    el.addEventListener("click", () => { setRunner(colorKey, el.dataset.runner as Runner); void refreshMgr(); }));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-edit]").forEach((el) =>
    el.addEventListener("click", () => startMgrEdit(el.dataset.edit!)));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-revert]").forEach((el) =>
    el.addEventListener("click", () => void revertMgrOverride(el.dataset.revert!)));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-del]").forEach((el) =>
    el.addEventListener("click", () => void deleteMgrTask(el.dataset.del!)));
}

function startMgrEdit(id: string | null) {
  const r = id ? mgrList.find((x) => x.id === id) : null;
  // Editing a discovered task doesn't rewrite its file — it captures the effective
  // command as an override. Our own tasks edit in place.
  const kind: "own" | "override" = r && r.source !== "episko" ? "override" : "own";
  mgrEdit = r
    ? { id: r.id, kind, label: r.label, run: r.exec.mode === "shell" ? r.exec.line : execCmd(r), group: r.group ?? "", background: r.background, cwd: "" }
    : { id: null, kind: "own", label: "", run: "", group: "", background: false, cwd: "" };
  renderMgr();
}

async function revertMgrOverride(id: string) {
  if (!mgrCtx) return;
  try {
    await invoke("remove_task_override", { workdir: mgrCtx.workdir, id });
    toast(`Reverted “${id}” to its own definition`);
    await refreshMgr();
  } catch (err) { toast("revert failed: " + err); }
}

function renderMgrForm() {
  const e = mgrEdit!;
  // Editing a task another tool owns is an override, not a rewrite — say so, because
  // it's the surprising-but-deliberate half of "Episko never touches a file it didn't create".
  const note = e.kind === "override"
    ? `<div class="mgr-note">Saving writes an <b>override</b> into <code>.episko/tasks.toml</code>. The original stays as its tool declared it; ↺ Revert removes the override.</div>`
    : "";
  $("mgrBody").innerHTML = note + `
    <div class="in-field"><label class="in-lbl">Label</label>
      <input class="in-ctl" id="mgrLabel" value="${esc(e.label)}" placeholder="Dev server" spellcheck="false" /></div>
    <div class="in-field"><label class="in-lbl">Command<span class="in-id">runs in a login shell</span></label>
      <input class="in-ctl" id="mgrRun" value="${esc(e.run)}" placeholder="pnpm tauri dev" spellcheck="false" /></div>
    <div class="in-field"><label class="in-lbl">Working directory<span class="in-id">optional · relative</span></label>
      <input class="in-ctl" id="mgrCwd" value="${esc(e.cwd)}" placeholder="src-tauri" spellcheck="false" /></div>
    <div class="in-field"><label class="in-lbl">Group</label>
      <span class="s-ctl">${["", "build", "test", "run", "check", "clean"].map((g) =>
        `<button class="opt${g === e.group ? " on" : ""}" data-group="${g}">${g || "none"}</button>`).join("")}</span></div>
    <div class="in-field"><label class="in-lbl">Long-running<span class="in-id">a server or watcher, never “done”</span></label>
      <span class="s-ctl"><button class="opt${e.background ? " on" : ""}" data-bg="1">background</button></span></div>`;

  $("mgrBody").querySelectorAll<HTMLElement>("[data-group]").forEach((el) =>
    el.addEventListener("click", () => { mgrEdit!.group = el.dataset.group!; syncMgrForm(); renderMgr(); }));
  $("mgrBody").querySelector("[data-bg]")?.addEventListener("click", () => {
    mgrEdit!.background = !mgrEdit!.background; syncMgrForm(); renderMgr();
  });
  ($("mgrLabel") as HTMLInputElement).focus();
}
// Keep typed text when a click re-renders the form.
function syncMgrForm() {
  if (!mgrEdit) return;
  mgrEdit.label = ($("mgrLabel") as HTMLInputElement).value;
  mgrEdit.run = ($("mgrRun") as HTMLInputElement).value;
  mgrEdit.cwd = ($("mgrCwd") as HTMLInputElement).value;
}

async function saveMgrTask() {
  if (!mgrCtx || !mgrEdit) return;
  syncMgrForm();
  const e = mgrEdit;
  if (!e.label.trim() || !e.run.trim()) { toast("A task needs a label and a command"); return; }

  // Creating .episko/tasks.toml puts a new committable file in someone's repo —
  // that's a side effect worth asking about once, not something to do silently.
  const [path, exists] = await invoke<[string, boolean]>("episko_tasks_file", { workdir: mgrCtx.workdir });
  if (!exists) {
    const ok = await ask(
      `Episko will create ${tilde(path)}.\n\nIt's a normal file in your repo — commit it and your team gets these tasks too, in any editor.`,
      { title: "Create .episko/tasks.toml?", kind: "info", okLabel: "Create", cancelLabel: "Cancel" });
    if (!ok) return;
  }
  const task = { label: e.label.trim(), run: e.run.trim(), group: e.group || null, background: e.background, cwd: e.cwd.trim() || null };
  try {
    if (e.kind === "override") {
      // The override is keyed by the discovered id verbatim ("vscode:test").
      await invoke("save_task_override", { workdir: mgrCtx.workdir, id: e.id, task });
      toast(`Overrode ${e.label}`);
    } else {
      // Discovery ids are namespaced ("episko:dev"); the file addresses the bare slug.
      await invoke("save_episko_task", { workdir: mgrCtx.workdir, id: e.id ? e.id.replace(/^episko:/, "") : null, task });
      toast(e.id ? `Updated ${e.label}` : `Added ${e.label}`);
    }
    mgrEdit = null;
    await refreshMgr();
  } catch (err) {
    toast("save failed: " + err);
    dlog("error", `save task: ${err}`);
  }
}

async function deleteMgrTask(id: string) {
  if (!mgrCtx) return;
  const r = mgrList.find((x) => x.id === id);
  const ok = await ask(`Delete “${r?.label ?? id}” from .episko/tasks.toml?`, {
    title: "Delete task?", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel",
  });
  if (!ok) return;
  try {
    await invoke("delete_episko_task", { workdir: mgrCtx.workdir, id: id.replace(/^episko:/, "") });
    await refreshMgr();
  } catch (err) { toast("delete failed: " + err); }
}

// ---------- the ▶ Run picker ----------
// A popover over the stage, grouped by source so it's obvious where each task came
// from. Blocked runnables stay visible but greyed: hiding them reads as "Episko
// didn't find my task", which is the more expensive confusion.
let runCtx: { project: string; colorKey: string; worktree: string | null; branch: string; workdir: string } | null = null;
let runList: Runnable[] = [];
let runSel = 0;
let runSource: string | null = null;   // jump-bar filter; null = every source

function runTargetCtx() {
  const wd = activeCwd();
  if (!wd) return null;
  const s = activeId ? sessions.get(activeId) : null;
  const e = extMirrorId() ? externals.find((x) => x.session_id === extMirrorId()) : undefined;
  return {
    workdir: wd,
    project: s ? s.project : e ? basename(e.repo_root || e.cwd) : basename(wd),
    colorKey: s ? s.colorKey : e ? (e.repo_root || e.cwd) : wd,
    worktree: s ? s.worktree : null,
    branch: s ? s.branch : (e?.branch || ""),
  };
}

async function openRunPicker() {
  const c = runTargetCtx();
  if (!c) { toast("No active project"); return; }
  runCtx = { project: c.project, colorKey: c.colorKey, worktree: c.worktree, branch: c.branch, workdir: c.workdir };
  runList = await discoverTasks(c.workdir, c.colorKey);
  runSel = 0;
  runSource = null;
  $("runSub").textContent = `${c.project}${c.worktree ? " · ⑃ " + c.branch : ""} · ${tilde(c.workdir)}`;
  const pop = $("runPop");
  pop.classList.add("show");
  $("scrim").classList.add("show");
  renderRunPicker("");
  const inp = $("runInput") as HTMLInputElement;
  inp.value = "";
  setTimeout(() => inp.focus(), 20);
}
function closeRunPicker() {
  $("runPop").classList.remove("show");
  if (!$("palette").classList.contains("show")) $("scrim").classList.remove("show");
  runCtx = null;
}

// Pinned first (they're the ones you run fifty times a day), then by source.
// Short chip labels for the jump bar. Group headers use the Runnable's own
// sourceFile instead, which is authoritative — it's the file discovery actually
// found, so ".vscode/tasks.json" and ".vscode/launch.json" name themselves, and a
// repo with `Justfile` doesn't get told it has a `justfile`.
const sourceShort = (r: Runnable) => PROVIDER_LABEL[r.source as Provider] || r.source;

function runMatches(term: string): Runnable[] {
  const t = term.trim().toLowerCase();
  const match = (r: Runnable) => !t || r.label.toLowerCase().includes(t) || execCmd(r).toLowerCase().includes(t) || (r.group || "").includes(t);
  return runList.filter(match);
}

/// The jump bar: every source present under the current search, with its count.
/// Built from the search results rather than the whole list, so a chip never
/// promises rows the current term has filtered away.
function runSources(term: string): { src: string; short: string; count: number }[] {
  const out: { src: string; short: string; count: number }[] = [];
  for (const r of runMatches(term)) {
    const hit = out.find((o) => o.src === r.source);
    if (hit) hit.count++;
    else out.push({ src: r.source, short: sourceShort(r), count: 1 });
  }
  return out;
}

// How many tasks the "recent" group floats to the top. Small on purpose — it's a
// shortcut to the two or three you keep re-running, not a second copy of the list.
const RUN_RECENT_MAX = 5;

function runGroups(term: string): { name: string; sub?: string; items: Runnable[] }[] {
  const list = runMatches(term).filter((r) => !runSource || r.source === runSource);
  const pins = runCtx ? pinnedIds(runCtx.colorKey) : [];
  const groups: { name: string; sub?: string; items: Runnable[] }[] = [];
  // A row shown in a float-to-top group (pinned, recent) is pulled out of its source
  // group below, so nothing appears twice.
  const lifted = new Set<string>();
  // Pinned float to the top, but only in the unfiltered view — inside a single
  // source, splitting two of its own rows into a separate block just hides them.
  const pinned = runSource ? [] : list.filter((r) => pins.includes(r.id));
  if (pinned.length) { groups.push({ name: "pinned", items: pinned }); pinned.forEach((r) => lifted.add(r.id)); }
  // Recent: the tasks you actually reach for, ranked by the same frecency the palette
  // uses (every launch bumps `task:<id>`). Only in the unfiltered "all" view — typing
  // or picking a source is already a narrower intent, and a Recent block there would
  // just be another thing to scan. Pinned are already up top, so they don't repeat.
  if (!runSource && !term.trim()) {
    const recent = list
      .filter((r) => !lifted.has(r.id) && !r.blocked && frecScore("task:" + r.id) > 0)
      .sort((a, b) => frecScore("task:" + b.id) - frecScore("task:" + a.id))
      .slice(0, RUN_RECENT_MAX);
    if (recent.length) { groups.push({ name: "recent", items: recent }); recent.forEach((r) => lifted.add(r.id)); }
  }
  const bySource = new Map<string, Runnable[]>();
  for (const r of list) {
    if (lifted.has(r.id)) continue;
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r);
  }
  for (const [, items] of bySource) {
    groups.push({ name: items[0].sourceFile || sourceShort(items[0]), sub: String(items.length), items });
  }
  return groups;
}

function renderRunTabs(term: string) {
  const srcs = runSources(term);
  const bar = $("runTabs");
  // One source is not a choice — the bar would just be a label taking up a row.
  bar.hidden = srcs.length < 2;
  if (bar.hidden) return;
  const total = srcs.reduce((n, s2) => n + s2.count, 0);
  bar.innerHTML =
    `<button class="run-tab${runSource === null ? " on" : ""}" data-src="">All<span class="n">${total}</span></button>` +
    srcs.map((s2) =>
      `<button class="run-tab${runSource === s2.src ? " on" : ""}" data-src="${esc(s2.src)}">${esc(s2.short)}<span class="n">${s2.count}</span></button>`).join("");
  bar.querySelectorAll<HTMLElement>("[data-src]").forEach((el) =>
    el.addEventListener("click", () => setRunSource(el.dataset.src || null)));
}

function setRunSource(src: string | null) {
  runSource = src;
  runSel = 0;
  renderRunPicker(($("runInput") as HTMLInputElement).value);
  ($("runInput") as HTMLInputElement).focus();
}

/// Tab / ⇧Tab step through the jump bar — the keyboard equivalent of clicking a
/// chip, so the whole picker stays reachable without the mouse.
function cycleRunSource(dir: 1 | -1) {
  const srcs = runSources(($("runInput") as HTMLInputElement).value);
  if (srcs.length < 2) return;
  const order: (string | null)[] = [null, ...srcs.map((s2) => s2.src)];
  const i = order.indexOf(runSource);
  setRunSource(order[(i + dir + order.length) % order.length]);
}

function renderRunPicker(term: string) {
  renderRunTabs(term);
  const groups = runGroups(term);
  const flat = groups.flatMap((g) => g.items);
  if (runSel >= flat.length) runSel = Math.max(0, flat.length - 1);
  const body = $("runList");
  if (!flat.length) {
    body.innerHTML = runList.length
      ? `<div class="run-empty">Nothing matches${term ? ` “${esc(term)}”` : ""}${runSource ? ` in ${esc(PROVIDER_LABEL[runSource as Provider] || runSource)}` : ""}.</div>`
      : `<div class="run-empty">No tasks found in this project.<br><span class="dim">Episko reads <code>package.json</code> scripts and <code>.episko/tasks.toml</code>.</span></div>`;
    return;
  }
  let i = 0;
  body.innerHTML = groups.map((g) => {
    const rows = g.items.map((r) => {
      const on = i === runSel ? " on" : "";
      const idx = i++;
      const pinned = runCtx && pinnedIds(runCtx.colorKey).includes(r.id);
      return `<div class="run-row${on}${r.blocked ? " blocked" : ""}" data-i="${idx}" title="${esc(r.blocked || execCmd(r))}">
        <span class="ic">${r.blocked ? "⃠" : "▸"}</span>
        <span class="txt"><b>${esc(r.label)}</b><small>${esc(r.detail || execCmd(r))}</small></span>
        <span class="end">${r.blocked ? esc(r.blocked) : r.background ? "bg" : pinned ? "★" : ""}</span>
      </div>`;
    }).join("");
    return `<div class="run-grp">${esc(g.name)}${g.sub ? `<span class="n">${esc(g.sub)}</span>` : ""}</div>${rows}`;
  }).join("");
  body.querySelectorAll<HTMLElement>(".run-row").forEach((el) => {
    el.addEventListener("click", () => { runSel = +el.dataset.i!; pickRun(false); });
  });
  body.querySelector(".run-row.on")?.scrollIntoView({ block: "nearest" });
}

function pickRun(pin: boolean) {
  const flat = runGroups(($("runInput") as HTMLInputElement).value).flatMap((g) => g.items);
  const r = flat[runSel];
  if (!r || !runCtx) return;
  if (pin) { togglePin(runCtx.colorKey, r.id); renderRunPicker(($("runInput") as HTMLInputElement).value); return; }
  // The trust gate is the one blocked row you can act on: choosing it asks for
  // permission rather than shrugging.
  if (r.id === "just:__untrusted") { void askTrust(runCtx.colorKey, runCtx.project); return; }
  if (r.blocked) { toast(`${r.label}: ${r.blocked}`); return; }
  const ctx = runCtx;
  closeRunPicker();
  bumpFrec("task:" + r.id);
  const o = { colorKey: ctx.colorKey, worktree: ctx.worktree, branch: ctx.branch, discoveredIn: ctx.workdir };
  if (r.inputs.length) { openInputPrompt(r, ctx.project, o); return; }
  void launchWithDeps(r, ctx.project, o);
}

// Trusting a folder means Episko may execute code from it to enumerate tasks, so
// it is asked for plainly and once, never inferred from mere use.
async function askTrust(path: string, project: string) {
  const ok = await ask(
    `Episko will run \`just --dump\` inside ${project} to list its recipes.\n\n`
    + `That evaluates the justfile, which can execute code from this folder. Only do this for projects you trust.`,
    { title: `Trust ${project}?`, kind: "warning", okLabel: "Trust and rescan", cancelLabel: "Cancel" });
  if (!ok) return;
  trustProject(path);
  dlog("info", `trusted ${path}`);
  await openRunPicker();
}

// Hand a command over to a terminal at `workdir` instead of running it ourselves.
// The embedded engine can genuinely prefill: it opens a shell pane and types the
// command *without* a newline, so the user reads it and presses Enter. External
// terminal apps take a directory but no pending input, so there we open the
// terminal and put the command on the clipboard — honest about the extra paste.
async function handToTerminal(project: string, workdir: string, cmd: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}) {
  if (termEngine === "embedded") {
    const id = await launchShell(project, workdir, opts);
    // The login shell needs a moment before its prompt will accept input.
    setTimeout(() => { void invoke("write_pty", { sessionId: id, data: cmd }).catch(() => {}); }, 600);
    toast("Prefilled in a shell — press Enter to run");
    return;
  }
  try { await navigator.clipboard.writeText(cmd); } catch { /* clipboard denied — the toast still names the command */ }
  invoke("open_terminal_here", { workdir, engine: termEngine })
    .then(() => toast("Terminal opened — command copied: " + cmd))
    .catch((e) => toast("terminal: " + e));
}

// Which session (if any) has a git action in flight — the buttons grey out while
// it runs, since fetch/pull/push can take seconds against a slow remote.
// Run fetch/pull/push for a session's workdir. A refusal is not an error: the
// backend declines the cases it can't finish safely and names the command that
// would work, which we offer as a terminal handoff rather than a dead end.
async function runGit(sessionId: string, op: string) {
  const s = sessions.get(sessionId);
  if (!s || gitBusy) return;
  setGitBusy(sessionId);
  // Only ever paint the inspector when this session still owns it: the palette can
  // fire a git action at a background session, and a terminal handoff switches the
  // active session to the new shell mid-run.
  const repaint = () => { if (activeId === s.id && !extMirrorId()) renderInspector(s); };
  repaint();
  try {
    const r = await invoke<GitActionResult>("git_action", { workdir: s.workdir, op });
    dlog(r.ok ? "info" : "warn", `git ${op} · ${s.project} · ${r.summary}`);
    if (r.ok) {
      toast(`${op}: ${r.summary}`);
    } else if (r.suggest) {
      // Keep the toast clickable-adjacent: say what blocked it, then hand it over.
      toast(`${op}: ${r.summary} → opening a terminal`);
      await handToTerminal(s.project, s.workdir, r.suggest, { colorKey: s.colorKey, worktree: s.worktree, branch: s.branch });
    } else {
      toast(`${op}: ${r.summary}`);
    }
  } catch (e) {
    dlog("error", `git ${op} failed: ${e}`);
    toast(`git ${op}: ${e}`);
  } finally {
    setGitBusy(null);
    void refreshSessionStats(s);   // ahead/behind moved — re-read it
    void refreshBranch(s).then((changed) => { if (changed) renderAll(); });
    repaint();
  }
}

// A plain login shell in an embedded xterm pane — no Claude, no telemetry.
// Returns the new session id so a caller can write into the shell (see handToTerminal).
async function launchShell(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  // Group by the repo root (opts.colorKey), not the raw cwd, so a shell opened in a
  // worktree nests under its repo instead of becoming a standalone top-level project.
  const colorKey = opts.colorKey ?? workdir;
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: true, scrollback: 8000,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  loadWebgl(term);
  term.open(pane);
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  term.attachCustomKeyEventHandler(macShellKeys(id)); // Terminal.app-style ⌥/⌘ nav for the shell
  const s: Sess = {
    // resumeId is inert for a shell — it has no transcript and saveRoster skips it.
    id, project, accent: accentFor(colorKey), workdir, colorKey, resumeId: id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "shell",
    phase: "idle", phaseSince: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null, res: null,
    lastEvent: "", activity: [],
    kind: "shell", external: false, term, fit, pane,
  };
  sessions.set(id, s);
  setActive(id);
  dlog("info", `shell ${project} · ${id.slice(0, 8)}`);
  try {
    await invoke("spawn_shell", { sessionId: id, workdir, rows: term.rows || 24, cols: term.cols || 80 });
  } catch (e) {
    dlog("error", `shell launch failed: ${e}`);
    toast("shell failed: " + e);
    term.writeln(`\r\n\x1b[31m[shell error] ${e}\x1b[0m`);
  }
  renderAll();
  return id;
}
// "+ Session" starts a session in the current project (offering a worktree if it
// already has one). With no active session there's no project context → palette.
$("btnNew").addEventListener("click", () => {
  const c = activeProjectCtx();
  if (c) requestLaunch(c.project, c.path); else openPalette();
});
$("btnTerm").addEventListener("click", openPlainTerminal);
$("btnRun").addEventListener("click", () => { void openRunPicker(); });
$("inCancel").addEventListener("click", closeInputPrompt);
$("inGo").addEventListener("click", submitInputPrompt);
$("inBody").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); submitInputPrompt(); }
  else if (e.key === "Escape") { e.preventDefault(); closeInputPrompt(); }
});
$("setClose").addEventListener("click", closeSettings);
$("mgrClose").addEventListener("click", closeTaskManager);
$("mgrNew").addEventListener("click", () => startMgrEdit(null));
$("mgrSave").addEventListener("click", () => { void saveMgrTask(); });
$("mgrBack").addEventListener("click", () => { mgrEdit = null; renderMgr(); });
$("mgrOpen").addEventListener("click", () => {
  if (mgrCtx) void invoke<[string, boolean]>("episko_tasks_file", { workdir: mgrCtx.workdir })
    .then(([path]) => openUrl("file://" + path))
    .catch((e) => toast("open failed: " + e));
});
$("mgrRescan").addEventListener("click", () => { if (mgrCtx) void rescanTasks(mgrCtx.workdir).then(() => refreshMgr()).then(() => toast("Rescanned")); });
$("runInput").addEventListener("input", () => { runSel = 0; renderRunPicker(($("runInput") as HTMLInputElement).value); });
$("runInput").addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const flat = runGroups(($("runInput") as HTMLInputElement).value).flatMap((g) => g.items);
  if (e.key === "ArrowDown") { e.preventDefault(); runSel = Math.min(runSel + 1, flat.length - 1); renderRunPicker(($("runInput") as HTMLInputElement).value); }
  else if (e.key === "ArrowUp") { e.preventDefault(); runSel = Math.max(runSel - 1, 0); renderRunPicker(($("runInput") as HTMLInputElement).value); }
  else if (e.key === "Enter") { e.preventDefault(); pickRun(meta); }
  // ⌘⇧R inside the picker is a *real* rescan: drop the cache, then re-discover.
  else if (meta && e.shiftKey && e.key.toLowerCase() === "r") { e.preventDefault(); if (runCtx) void rescanTasks(runCtx.workdir).then(() => openRunPicker()); }
  else if (e.key === "Tab") { e.preventDefault(); cycleRunSource(e.shiftKey ? -1 : 1); }
  else if (e.key === "Escape") { e.preventDefault(); closeRunPicker(); }
});
$("fRepo").addEventListener("click", (e) => { e.preventDefault(); openUrl("https://github.com/respeak-io/episko").catch(() => {}); });
$("fEngineSeg").addEventListener("click", (e) => { e.stopPropagation(); $("enginePop").classList.contains("show") ? closeEnginePop() : openEnginePopover(); });
$("fUsageSeg").addEventListener("click", (e) => { e.stopPropagation(); $("usagePop").classList.contains("show") ? closeUsagePop() : openUsagePop(); });
$("fShortSeg").addEventListener("click", (e) => { e.stopPropagation(); $("shortPop").classList.contains("show") ? closeShortPop() : openShortPop(); });
$("btnClose").addEventListener("click", () => { if (activeId) closeSession(activeId); });

$("scrim").addEventListener("click", () => { closePalette(); closeWt(); closeDiff(); closeSettings(); closeRunPicker(); closeInputPrompt(); closeTaskManager(); });
$("diffClose").addEventListener("click", closeDiff);
// Collapse / expand a file section by clicking its header.
$("diffBody").addEventListener("click", (e) => {
  const h = (e.target as HTMLElement).closest<HTMLElement>("[data-dtoggle]");
  if (h) h.parentElement!.classList.toggle("collapsed");
});
$("palInput").addEventListener("input", refreshPal);
$("palInput").addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const val = ($("palInput") as HTMLInputElement).value;
  if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palFlat.length - 1); renderPal(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPal(); }
  else if (e.key === "Enter") { e.preventDefault(); runPalItem(palFlat[palSel]); }
  else if (meta && e.key.toLowerCase() === "k") {
    // ⌘K on a session opens its action panel; otherwise swallow it so the global
    // handler doesn't close the palette out from under an open action list.
    e.preventDefault(); e.stopPropagation();
    const it = palFlat[palSel];
    if (palPage === "root" && it?.session) openPalActions(it.session);
  }
  else if (e.key === "Backspace" && !val && palPage === "actions") { e.preventDefault(); popPalPage(); }
  else if (e.key === "Escape") { if (palPage === "actions") { e.preventDefault(); popPalPage(); } else closePalette(); }
});
window.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "k") { e.preventDefault(); $("palette").classList.contains("show") ? closePalette() : openPalette(); }
  else if (meta && e.key.toLowerCase() === "b") { e.preventDefault(); toggleRail(); }
  else if (meta && e.key.toLowerCase() === "i") { e.preventDefault(); toggleInsp(); }
  else if (meta && e.key.toLowerCase() === "t") { e.preventDefault(); openPlainTerminal(); }
  else if (meta && e.key >= "1" && e.key <= "9") { e.preventDefault(); const list = orderedSessions(); const s = list[+e.key - 1]; if (s) setActive(s.id); }
  else if (meta && (e.key === "=" || e.key === "+")) { e.preventDefault(); bumpFont(0.5); }
  else if (meta && e.key === "-") { e.preventDefault(); bumpFont(-0.5); }
  else if (meta && e.key === "0") { e.preventDefault(); setTermFontSize(12.5); applyFontSize(); toast("Terminal font 12.5px"); }
  else if (meta && e.key === ",") { e.preventDefault(); settingsOpen() ? closeSettings() : openSettings(); }
  else if (meta && e.shiftKey && e.key.toLowerCase() === "r") { e.preventDefault(); void openRunPicker(); }
  else if (e.key === "Escape" && ctxMenuOpen()) { e.preventDefault(); closeColorPop(); closeCtxMenu(); }
  else if (e.key === "Escape" && diffOpen) { e.preventDefault(); closeDiff(); }
  else if (e.key === "Escape" && settingsOpen()) { e.preventDefault(); closeSettings(); }
  else if (e.key === "Escape" && $("mgrDlg").classList.contains("show")) { e.preventDefault(); if (mgrEdit) { mgrEdit = null; renderMgr(); } else closeTaskManager(); }
});
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

// show the running app's version (from tauri.conf.json) in the footer, so it's
// clear which build is installed after an update.
getVersion().then((v) => { setAppVersion(v); $("fVer").textContent = "v" + v; }).catch(() => {});

// ---------- app self-update (Tauri updater plugin) ----------
// Checks the latest GitHub release (respeak-io/episko) for a newer Episko.
// Installing an update RESTARTS the app, which kills every live PTY/Claude
// session — so we never auto-install: the update surfaces as a footer chip and
// a one-time toast, and only downloads + relaunches after an explicit,
// session-count-aware confirmation. Clicking the version label re-checks.
let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null;
let updateBusy = false;

async function checkForUpdates(manual: boolean) {
  if (updateBusy) return;
  try {
    const upd = await check();
    pendingUpdate = upd;
    const chip = $("fUpdate");
    if (upd) {
      chip.textContent = `⇧ update to v${upd.version}`;
      chip.hidden = false;
      dlog("info", `update available: v${upd.version}`);
      if (manual) toast(`Episko v${upd.version} is available`);
    } else {
      chip.hidden = true;
      if (manual) toast("You're on the latest version");
    }
  } catch (e) {
    const msg = String(e);
    // The update manifest (latest.json) may not list this platform yet — e.g. no
    // Windows release has been published. The updater reports that as "None of the
    // fallback platforms [...] were found in the response platforms object". That's
    // "no update for this platform", not a failure — surface it quietly.
    if (msg.includes("were found in the response")) {
      $("fUpdate").hidden = true;
      dlog("info", "no update published for this platform yet");
      if (manual) toast("No update published for this platform yet");
      return;
    }
    dlog("error", `update check failed: ${msg}`);
    if (manual) toast("Update check failed — see debug console");
  }
}

async function runUpdate() {
  if (!pendingUpdate || updateBusy) return;
  const live = [...sessions.values()].filter((s) => !s.external).length;
  const warn = live
    ? `Episko will download v${pendingUpdate.version}, close ${live} running session${live === 1 ? "" : "s"}, and restart.`
    : `Episko will download v${pendingUpdate.version} and restart.`;
  const ok = await ask(`${warn}\n\nContinue?`, {
    title: "Update Episko",
    kind: "warning",
    okLabel: "Update & restart",
    cancelLabel: "Not now",
  });
  if (!ok) return;
  updateBusy = true;
  try {
    toast(`Downloading v${pendingUpdate.version}…`);
    await pendingUpdate.downloadAndInstall((ev) => {
      if (ev.event === "Finished") toast("Installing update…");
    });
    await relaunch();
  } catch (e) {
    updateBusy = false;
    dlog("error", `update install failed: ${String(e)}`);
    toast("Update failed — see debug console");
  }
}

$("fUpdate").addEventListener("click", runUpdate);
$("fVer").addEventListener("click", () => checkForUpdates(true));
// quiet check on launch, once the app has settled.
setTimeout(() => checkForUpdates(false), 3000);
// "Check for Updates…" in the menu-bar menu. Without this the only checks are the
// one at launch and the easily-missed click on the version label, so a long-running
// Episko never learns about a release until it's restarted. Manual → it reports
// either way ("you're on the latest version"), so the menu item always answers.
listen("tray-check-updates", () => { void checkForUpdates(true); });

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
// for every project at once — s.git alone only covers the active session.
refreshDirtyStates();
setInterval(refreshDirtyStates, 5000);

// keep each session's branch label honest — re-read the real HEAD so switching
// branches inside a session (or a worktree) is reflected instead of the stale
// creation-time name.
setInterval(refreshBranches, 4000);

setSort(sortMode, false); // paint the sort button's glyph/title for the persisted mode
initProjectDnD();
initFileDrop();
// caffeinate always starts off — the assertion is bound to the last run's process
// (`-w <pid>` on macOS, the parked thread on Windows) and died with it; renderAll's
// reconcileCaf() paints the button. Note this is the ONE place agent-mode could
// auto-assert on launch — but cafArmed is false at boot, so it stays dormant.
renderAll();

