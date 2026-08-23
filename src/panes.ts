// Panes: the three things Episko can put on stage, and the life of one once it is
// there. `spawn_claude`, `spawn_shell` and `spawn_task` are three backend entry points
// but one frontend shape — a `Sess` in the map, a `.term-pane` in #terminals, and a
// PTY behind it — which is why they sit together rather than beside the surfaces that
// trigger them.
//
// What each spawner does *not* share is the point of having three: a claude session is
// instrumented (and may live in an external terminal, in which case its pane is a
// placard rather than a terminal), a shell gets Terminal.app's ⌥/⌘ key conventions and
// no telemetry, and a task run carries its exit code as its phase.
//
// Also here: the stage's own chrome (`renderHeader`, `syncStageButtons`), because both
// read only what pane is active, and the two context resolvers every "…here" action
// starts from — `activeProjectCtx` (the repo, for grouping) and `activeCwd` (the actual
// directory, which differs for a worktree session).
//
// The xterm plumbing all three share is ./terminal. The one thing this module cannot
// own is the app-wide repaint.

import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { $, takeStage, toast } from "./dom";
import { ask } from "./confirm";
import { playSound } from "./chime";
import { dlog } from "./debug";
import { basename, esc, tilde } from "./format";
import {
  isAgent, isExited, statusKey, taskStateText, type DiffStat, type GitActionResult,
  type InstallFile, type LiveSess, type Restorable, type Runnable, type Sess,
  type WtHead,
} from "./types";
import { driftUpdate, gitMutates } from "./gitwatch";
import {
  attachWebgl, claudeInput, cleanTitle, clipboardKeys, detachWebgl, fitSession, MONO,
  refit, shellKeys, trimScrollback, winClaudePaste,
} from "./terminal";
import { gitBusy, setGitBusy } from "./inspectorview";
import { GCLASS } from "./sidebarview";
import { renderInspector } from "./inspector";
import { renderMini, renderSidebar, revealProjGroup } from "./sidebar";
import { renderAttn, renderFoot } from "./footer";
import { updateTray } from "./tray";
import { closeExternalView, flushRoster, queueRosterSave, refreshDirtyStates } from "./mirror";
import { openWt, refreshWtDialog } from "./worktree";
import { nextAfterClose, nextInGroup, orphanAdoptions } from "./grouping";
import { probeIcon } from "./icons";
import { addIo, ioCreditBps, ioExcludedMb } from "./usage";
import { execCmd, exitWaiters, taskPrefs, type TaskLaunchOpts } from "./tasks";
import {
  accentFor, activeId, collapsedRuns, dashMirror, dirtyByFolder, dirtyStale, dormants, engineDef,
  externals, extMirrorId, FAVORITES, ioAll, pastMirrorId, permMode, permModeDef,
  sessions, setActiveId, setDormants, setStageGroup, stageGroup, termEngine,
  termFontSize, worktreesByRepo, wtSig,
} from "./state";

// The one thing a pane's lifecycle cannot own: `renderAll()` repaints every surface
// from scratch, and it is the file that orchestrates them that owns it.
let renderAll: () => void = () => {};
export function setPanesRenderAll(fn: typeof renderAll) { renderAll = fn; }

// The embedded terminal of a claude pane — shared by a fresh launch and by the
// adoption of a reload orphan, so the two cannot drift on options or key wiring.
function newClaudeTerm(id: string, pane: HTMLElement): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: true, scrollback: 8000,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // No WebGL here: setActive attaches a pooled context the moment the pane is on
  // stage — a context per pane for life is the 16-context cliff (see attachWebgl).
  term.open(pane);
  term.onData(claudeInput(id)); // ^C interrupts; it never exits the session
  winClaudePaste(id, term, pane);
  return { term, fit };
}

// ---------- launch ----------
// Returns the new session id, or null if the spawn failed. Most callers ignore it —
// but the dashboard's dispatch paths need it to type the prompt in and to write the
// claim, and "did this start?" is a question only this function can answer. It used to
// return nothing at all while `DashHost.launch` was typed `Promise<unknown>`, so every
// `typeof sid !== "string"` guard downstream was permanently true: the pane appeared,
// the toast said it hadn't, and neither the prompt nor the claim was ever sent.
export async function launch(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string; resume?: string } = {}): Promise<string | null> {
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
    pane.innerHTML = `<div class="ext-pane"><div class="ext-logo"></div><h2>Running in ${esc(eng.label)}</h2><p>${esc(project)}${opts.worktree ? " · " + esc(opts.worktree) : ""}. The terminal is in your ${esc(eng.label)} window.<br>Episko still tracks its status, cost &amp; context here.</p></div>`;
  } else {
    ({ term, fit } = newClaudeTerm(id, pane));
  }

  const s: Sess = {
    id, project, accent, workdir, colorKey, resumeId: opts.resume ?? id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "",
    phase: "idle", phaseSince: Date.now(), attnAt: 0, seenAt: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0, fanout: null, apiErr: null, drift: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null,
    lastEvent: "", activity: [],
    files: [], tally: {}, servers: [], kind: "claude", external, term, fit, pane,
  };
  sessions.set(id, s);
  term?.onTitleChange((t) => {
    const c = cleanTitle(t, s);
    // The tray row reads the title too, and this path bypasses renderAll — without
    // the nudge the menu shows the old summary until the next telemetry tick.
    if (c !== s.title) { s.title = c; renderSidebar(); updateTray(); if (activeId === id) renderHeader(s); }
  });
  setActive(id);
  // A restored session takes over its roster entry: drop the dormant row so the
  // sidebar doesn't show the same conversation twice, live and dormant.
  if (opts.resume) setDormants(dormants.filter((d) => d.resumeId !== opts.resume));
  queueRosterSave();
  // The permission mode a launch starts in (Settings › Sessions). "default" is
  // Claude's own ask-me behaviour, which is what passing NO flag means — so it goes
  // over the wire as null rather than as a spelling of the standard mode. Read here
  // rather than taken as an opt, exactly like termEngine: it is a preference, and a
  // restore is as much a new launch as anything else.
  const mode = permMode === "default" ? null : permMode;
  dlog("info", `${opts.resume ? "resume" : "launch"} ${project} · ${id.slice(0, 8)} · ${termEngine}${mode ? ` · ${permModeDef(permMode).label}` : ""}${opts.worktree ? " · worktree" : ""}${opts.resume ? ` · from ${opts.resume.slice(0, 8)}` : ""}`);

  let spawned = true;
  try {
    if (termEngine === "ghostty") await invoke("spawn_ghostty", { sessionId: id, workdir, accent, title: project, resume: opts.resume ?? null, mode });
    else if (external) await invoke("spawn_external_terminal", { sessionId: id, workdir, engine: termEngine, title: project, resume: opts.resume ?? null, mode });
    else await invoke("spawn_claude", { sessionId: id, workdir, rows: term!.rows || 24, cols: term!.cols || 80, resume: opts.resume ?? null, mode });
  } catch (e) {
    spawned = false;
    dlog("error", `launch failed (${project} · ${id.slice(0, 8)}): ${e}`);
    toast("launch failed: " + e);
    if (term) term.writeln(`\r\n\x1b[31m[launch error] ${e}\x1b[0m`);
    else pane.innerHTML = `<div class="ext-pane"><h2>Couldn't launch ${esc(eng.label)}</h2><p>${esc(String(e))}</p></div>`;
  }
  // Off by default — you were standing right here — but it is the one confirmation an
  // EXTERNAL engine gives that the window really opened somewhere else. Only a spawn
  // that worked: the failure above already toasts, and a chirp under it reads as success.
  if (spawned) playSound("launched");
  invoke<string | null>("git_branch", { workdir }).then((b) => {
    if (b && !s.branch) { s.branch = b; renderSidebar(); if (activeId === id) renderHeader(s); }
  });
  renderAll();
  return spawned ? id : null;
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
//
// All three of those only cover a folder something is *running* in, which is exactly
// what a project dashboard is not — so a caller that already knows better passes
// `known`. It is still not an await: the dashboard bought that answer when it opened.
export function requestLaunch(project: string, path: string, known?: { branch: string } | null) {
  if (known) { openWt(project, path, known.branch); return; }
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

// The sidebar's per-worktree ＋ (subheader grouping). Unlike requestLaunch this never
// opens the worktree dialog: the cluster header the button sits on *is* the answer
// that dialog asks for, so offering it again would only re-ask what was just clicked.
// `root` is the repo root — the colorKey every session in the project groups by, which
// a worktree's own path is not (get that wrong and the new session splits off into a
// project group of its own).
export function launchWorktree(project: string, root: string, dir: string, branch: string) {
  launch(project, dir, { colorKey: root, worktree: dir === root ? null : branch, branch });
}

// ---------- adoption: panes for the PTYs a webview reload orphaned (#47) ----------
// A reload empties this module's world while every backend PTY runs on. Stage 1 of
// the fix makes such an orphan read busy; this puts it back on screen: one Sess per
// claude orphan, the backend's scrollback ring replayed into a fresh term, and the
// existing pty-output listener picks the stream back up with no new plumbing.
// Identity comes from the roster, which knew this pane before the reload; a
// roster-less orphan adopts under its workdir's name — a running conversation is
// worth more than a tidy label. Telemetry re-routes by itself: hooks tag the launch
// uuid via X-CC-Session, and that uuid is exactly what the map is keyed by again.
//
// Called once at startup, BEFORE loadDormants — an adopted id is live again, so the
// roster reconcile then skips it instead of also offering it as a dormant row.
export async function adoptOrphans(): Promise<number> {
  let back: LiveSess[] = [];
  try { back = await invoke<LiveSess[]>("live_sessions"); } catch { return 0; }
  let roster: Restorable[] = [];
  try { roster = JSON.parse(localStorage.getItem("cc-restore") || "[]") || []; } catch { roster = []; }
  if (!Array.isArray(roster)) roster = [];
  const orphans = orphanAdoptions(back, roster);
  for (const o of orphans) await adoptSession(o);
  if (orphans.length) {
    dlog("warn", `adopted ${orphans.length} orphaned pane${orphans.length === 1 ? "" : "s"} after a webview reload`);
    toast(`Reattached ${orphans.length} running session${orphans.length === 1 ? "" : "s"} after a reload`);
    // The reload took the stage's pane away; give it back to the freshest orphan —
    // unless the user beat this to it, which their click already answered.
    if (!activeId && !pastMirrorId() && !extMirrorId() && !dashMirror()) {
      const front = [...sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity)[0];
      if (front) setActive(front.id);
    }
    renderAll();
  }
  return orphans.length;
}

async function adoptSession(o: { id: string; workdir: string; meta: Restorable | null }) {
  const m = o.meta;
  const project = m?.project || basename(o.workdir) || "session";
  const colorKey = m?.colorKey ?? o.workdir;
  probeIcon(colorKey);
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const { term, fit } = newClaudeTerm(o.id, pane);
  const s: Sess = {
    id: o.id, project, accent: accentFor(colorKey), workdir: o.workdir, colorKey,
    resumeId: m?.resumeId ?? o.id, branch: m?.branch ?? "", worktree: m?.worktree ?? null,
    title: m?.title ?? "",
    phase: "idle", phaseSince: Date.now(), attnAt: 0, seenAt: Date.now(), lastActivity: m?.lastActivity ?? Date.now(),
    attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0, fanout: null,
    apiErr: null, drift: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null,
    lastEvent: "", activity: [],
    files: [], tally: {}, servers: [], kind: "claude", external: false, term, fit, pane,
    adopt: { pending: [] },
  };
  // From this line the pty-output listener queues this session's chunks into
  // `s.adopt` — the snapshot below decides which of them it already contains.
  sessions.set(o.id, s);
  term.onTitleChange((t) => {
    const c = cleanTitle(t, s);
    if (c !== s.title) { s.title = c; renderSidebar(); updateTray(); if (activeId === o.id) renderHeader(s); }
  });
  try {
    const snap = await invoke<{ data: string; seq: number }>("read_scrollback", { sessionId: o.id });
    term.write(Uint8Array.from(atob(snap.data), (c) => c.charCodeAt(0)));
    for (const c of s.adopt!.pending) if (c.seq > snap.seq) term.write(c.bytes);
  } catch (e) {
    // Snapshot refused — most likely the process exited in the window between the
    // listing and this call, in which case the reaper has already dropped it from
    // the backend map and no pty-exit can reach a pane that did not exist yet.
    const gone = String(e).includes("no such session");
    if (gone) {
      s.phase = "ended";
      term.writeln("\x1b[90m[this session ended while the pane was being reattached]\x1b[0m");
    } else {
      // Degraded: no history, but the live stream still flows from here on.
      for (const c of s.adopt!.pending) term.write(c.bytes);
      dlog("warn", `scrollback replay failed for ${o.id.slice(0, 8)}: ${e}`);
    }
  }
  s.adopt = null;
  dlog("info", `adopted ${project} · ${o.id.slice(0, 8)}${m ? "" : " · no roster entry"}`);
  invoke<string | null>("git_branch", { workdir: o.workdir }).then((b) => {
    if (b && !s.branch) { s.branch = b; renderSidebar(); if (activeId === o.id) renderHeader(s); }
  });
  queueRosterSave();
}

// A plain login shell in an embedded xterm pane — no Claude, no telemetry.
// Returns the new session id so a caller can write into the shell (see handToTerminal).
export async function launchShell(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}): Promise<string> {
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
  term.open(pane);
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  // One handler, both rules: Terminal.app-style ⌥/⌘ nav and Ctrl+Shift+C/V.
  term.attachCustomKeyEventHandler(shellKeys(id, term));
  const s: Sess = {
    // resumeId is inert for a shell — it has no transcript and saveRoster skips it.
    id, project, accent: accentFor(colorKey), workdir, colorKey, resumeId: id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "shell",
    phase: "idle", phaseSince: Date.now(), attnAt: 0, seenAt: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0, fanout: null, apiErr: null, drift: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null,
    lastEvent: "", activity: [],
    files: [], tally: {}, servers: [],
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

// Start one run of a Runnable in its own pane. Mirrors launchShell — same PTY,
// same xterm setup — because a task genuinely is just another pane.
export async function launchTask(r: Runnable, project: string, opts: TaskLaunchOpts = {}): Promise<string | null> {
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
  // A caption naming this step, CSS-hidden until the stage tiles a run group — a
  // tiled chain is unreadable without one, and a single pane already has the header.
  // Created here rather than at tile time because `term.open(pane)` appends, so the
  // caption has to exist before it to end up above it.
  const cap = document.createElement("div");
  cap.className = "pane-cap";
  // The ✕ carries `data-close`, which the delegated dispatcher in main.ts already
  // routes to closeSession — a tiled pane needs no dispatch of its own.
  cap.innerHTML = `<span class="pc-name"></span><span class="pc-state"></span>`
    + `<span class="pc-x" data-close="${id}" title="Close this pane">✕</span>`;
  pane.appendChild(cap);
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: false, scrollback: 8000,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  // Tasks are interactive: a prompt, a y/N, a dev server's "r" to reload all work.
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  // …and a run's output is the thing you most want out of a pane, so it copies too.
  term.attachCustomKeyEventHandler(clipboardKeys(term));

  const cmd = execCmd(r);
  const s: Sess = {
    id, project, accent: accentFor(colorKey), workdir: cwd, colorKey,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: r.label,
    phase: "working", phaseSince: Date.now(), attnAt: 0, seenAt: Date.now(), lastActivity: Date.now(), attention: null,
    pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0, fanout: null, apiErr: null, drift: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], git: null,
    lastEvent: "", activity: [],
    files: [], tally: {}, servers: [],
    resumeId: id, kind: "task", external: false, term, fit, pane,
    run: { id: r.id, label: r.label, source: r.source, sourceFile: r.sourceFile, cmd, background: r.background, startedAt: Date.now(), exitCode: null, tail: [], root: opts.discoveredIn ?? colorKey, forSession: opts.forSession, groupId: opts.groupId, groupLabel: opts.groupLabel },
  };
  sessions.set(id, s);
  // An unfocused pane can't be measured, so it starts at xterm's default 24×80 and
  // gets a real size the moment you activate it (setActive/openRunGroup refit and
  // resize the PTY). Only run-on-stop takes that path.
  //
  // A pane that belongs to a chain puts its **group** on the stage, not itself. One
  // chord starts a whole stack, so the stack is what you meant to look at; activating
  // each member as it spawned left the stage on whichever step happened to start last,
  // and (since a plain activation leaves the tiled view) untiled the group on the way.
  if (opts.focus !== false) {
    const gid = opts.groupId;
    if (!gid) {
      setActive(id);
    } else {
      // Re-tile as later steps appear, but only while the stage is still on this
      // group. A sequential chain can start step 3 minutes in, and it must not yank
      // you back from wherever you navigated in the meantime.
      const first = ![...sessions.values()].some((x) => x.id !== id && x.run?.groupId === gid);
      if (first || stageGroup === gid) openRunGroup(gid);
    }
  }
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
    s.run!.endedAt = Date.now();
  }
  renderAll();
  return id;
}

export function closeSession(id: string) {
  const s = sessions.get(id); if (!s) return;
  // Closing a pane mid-chain counts as a failure, not a hang.
  const waiter = exitWaiters.get(id);
  if (waiter) { exitWaiters.delete(id); waiter(-1); }
  const wasActive = activeId === id;
  // Resolve the successor while the closing session is still in the map, so its
  // sidebar position (same-project neighbour) is known.
  const next = wasActive ? nextAfterClose(s) : null;
  // Closing one tile of a mosaic stays in the mosaic. `nextAfterClose` answers the
  // sidebar's question over the whole project, so on its own it handed the stage to
  // whichever Claude session sat next to the group — and untiled it on the way.
  const gid = s.run?.groupId;
  const groupNext = wasActive && gid && stageGroup === gid
    ? nextInGroup(groupMembers(gid), id)
    : null;
  invoke("kill_session", { sessionId: id }).catch(() => {});
  // Release the GL context explicitly — term.dispose() disposes the addon, but only
  // detachWebgl gives the context slot back to the page's budget (see terminal.ts).
  detachWebgl(s);
  try { s.term?.dispose(); } catch { /* */ }
  s.pane.remove();
  sessions.delete(id);
  flushRoster(); // an explicit close means done — it should not come back on restart
  // A tiled group that just lost its last-but-one member is no longer a group, and a
  // tiled stage with nothing left in it would keep #terminals in grid mode showing
  // empty cells. Drop the pointer *before* the successor is activated, so setActive
  // paints a normal single-pane stage.
  if (stageGroup && ![...sessions.values()].some((x) => x.run?.groupId === stageGroup)) {
    setStageGroup(null);
    $("terminals").classList.remove("tiled");
  }
  if (wasActive) {
    setActiveId(null);
    // A surviving group sibling wins over the sidebar neighbour, and keeps the tiling.
    if (groupNext) { setActive(groupNext.id, true); return; }
    if (next) { setActive(next.id); return; }
    setStageGroup(null);
    $("terminals").classList.remove("tiled");
    document.documentElement.style.setProperty("--accent", "#a78bfa");
    takeStage("none");
  }
  // Closing a tile that wasn't the focused one still reflows the grid — every
  // surviving cell changed size. #terminals itself did not, so the ResizeObserver
  // never fires and nothing would re-measure the terminals inside.
  if (stageGroup) refit();
  renderAll();
}

/// Close every pane of one run group — the ✕ on its sidebar header.
///
/// **Asks first if anything is still running.** One ✕ standing for a dev server, a
/// database container and four finished installs is a lot of destruction behind a
/// 12-pixel target, and killing a stack you meant to keep is not undoable — whereas
/// closing a chain that has already finished is just tidying, so that stays instant.
///
/// Snapshot the ids first: `closeSession` mutates the map and can re-enter `setActive`,
/// so iterating the live values would skip members.
export async function closeRunGroup(gid: string) {
  const members = groupMembers(gid);
  if (!members.length) return;
  const live = members.filter((m) => m.run?.exitCode == null);
  if (live.length) {
    const names = live.slice(0, 6).map((m) => `• ${m.run?.label ?? "task"}`).join("\n");
    const more = live.length > 6 ? `\n• …and ${live.length - 6} more` : "";
    const ok = await ask(
      `${live.length} of ${members.length} ${live.length === 1 ? "task is" : "tasks are"} still running:\n\n${names}${more}\n\nClosing the group stops them.`,
      { title: `Stop ${members[0].run?.groupLabel ?? "this run"}?`, kind: "warning", okLabel: `Stop ${live.length === 1 ? "it" : "them"}`, cancelLabel: "Keep running" },
    );
    if (!ok) return;
  }
  for (const id of members.map((x) => x.id)) closeSession(id);
}

/// Collapse/expand a run group's step list in the sidebar. Purely presentational, so
/// it repaints the sidebar and nothing else.
export function toggleRunGroup(gid: string) {
  if (collapsedRuns.has(gid)) collapsedRuns.delete(gid);
  else collapsedRuns.add(gid);
  renderSidebar();
}


/// One run group's live panes, **in launch order** — which is the order they were
/// appended to `#terminals`, and therefore the order the mosaic lays them out in. The
/// map's own insertion order already matches, but sorting says so out loud: "the next
/// tile" has to mean the next tile on screen.
function groupMembers(gid: string): Sess[] {
  return [...sessions.values()]
    .filter((x) => x.run?.groupId === gid)
    .sort((a, b) => (a.run?.startedAt ?? 0) - (b.run?.startedAt ?? 0));
}

/// Repaint the captions of a tiled group. Called from `renderAll` because panes sit
/// outside the render-everything sweep, and a caption shows live state.
export function refreshPaneCaps() {
  if (!stageGroup) return;
  for (const s of sessions.values()) if (s.run?.groupId === stageGroup) paintPaneCap(s);
}

/// Fill in a pane's caption. Only visible in the tiled view (see the CSS), so this
/// is cheap to keep current rather than tracking whether anyone can see it.
function paintPaneCap(s: Sess) {
  const cap = s.pane.querySelector<HTMLElement>(".pane-cap");
  if (!cap) return;
  const name = cap.querySelector<HTMLElement>(".pc-name");
  const state = cap.querySelector<HTMLElement>(".pc-state");
  if (name) name.textContent = s.run?.label ?? s.title ?? "pane";
  // A finished run keeps its ✕ on screen: it is done, so dismissing it is the next
  // thing you want, and hunting for a hover target in a grid of six is not. A running
  // one still has one, just on hover — closing it means killing it.
  cap.classList.toggle("done", s.run?.exitCode != null);
  if (state) {
    state.textContent = s.kind === "task" ? taskStateText(s) : "";
    state.className = "pc-state " + (GCLASS[statusKey(s)] || "");
  }
}

/// Put a run group's panes on the stage side by side, focused on its most
/// interesting member.
///
/// "Most interesting" is the failure if there is one — a chain is opened to find out
/// what broke — else the last one to start, which is the step still running or the
/// one that finished the chain.
///
/// Called both from clicking the group's header and, as a chain fans out, from
/// `launchTask` for each member — so it must be idempotent and safe to call with the
/// group half-populated. It is: it re-derives the member list every time.
export function openRunGroup(gid: string) {
  const members = groupMembers(gid);
  if (!members.length) return;
  const focus = members.find((m) => m.phase === "error")
    ?? members.reduce((a, b) => (b.run!.startedAt > a.run!.startedAt ? b : a));
  setStageGroup(gid);
  // `keepGroup` is not optional here: `setActive` clears `stageGroup` by default (a
  // sidebar row means "show me that one"), so without it this would set the group and
  // then immediately drop it, and the stage would never tile at all.
  setActive(focus.id, true);
}

/// Move the focus *within* a tiled group — what clicking one of the tiles means.
///
/// The counterpart to `setActive` untiling: clicking a tile is "I'm reading this one",
/// not "drop the mosaic". Keeps `stageGroup`, so the layout survives; moves `activeId`,
/// so the header, inspector and footer follow what you're looking at.
export function focusInGroup(id: string) {
  const s = sessions.get(id);
  if (!s || !stageGroup || s.run?.groupId !== stageGroup || id === activeId) return;
  setActiveId(id);
  s.seenAt = Date.now();   // reading a tile counts as looking at it, same as setActive
  for (const x of sessions.values()) x.pane.classList.toggle("focused", x.id === id);
  document.documentElement.style.setProperty("--accent", accentFor(s.colorKey));
  renderAll();
}

/// Put one pane on the stage. `keepGroup` is for `openRunGroup` alone — see below.
export function setActive(id: string, keepGroup = false) {
  const s = sessions.get(id);
  if (!s) return;
  // The pointer and the transcript timer, then the panes: `closeExternalView` owns the
  // first pair, `takeStage` the second. It is called after, not instead — that one drops
  // the stage to the empty card, which this immediately replaces with the pane.
  closeExternalView();
  setActiveId(id);
  // You have now looked at this one. The only write of `seenAt`, and the whole of what
  // takes a finished session back out of the reactor badge and stops its row flashing
  // (./attn). Stamped for every pane, agent or not, so the field never has to be read
  // together with a kind test.
  s.seenAt = Date.now();
  // Picking a row in the sidebar always means "show me that one", group member or not.
  // It used to keep the tiled view when the row was inside the tiled group and only
  // move the focus ring — which read as the click doing nothing at all. The split is
  // now the obvious one: the group *header* shows all of them, a *row* shows one, and
  // the header takes you back. Clicking a tile is `focusInGroup`, not this.
  if (stageGroup && !keepGroup) setStageGroup(null);
  const gid = stageGroup;
  takeStage("session");
  $("terminals").classList.toggle("tiled", !!gid);
  for (const x of sessions.values()) {
    const on = gid ? x.run?.groupId === gid : x.id === id;
    x.pane.classList.toggle("active", on);
    x.pane.classList.toggle("focused", !!gid && x.id === id);
    // WebGL: attach after the class flip (the addon activates against a measurable
    // pane). A live pane leaving the stage KEEPS its addon — the LRU pool in
    // terminal.ts bounds the total, and evicting on every deactivation churns a
    // context per switch, which WebKit punishes once its GC falls behind. An exited
    // pane won't be revisited soon, so it frees its slot at once — and an ended
    // claude pane gives up its scrollback too, the deferred half of the pty-exit trim
    // for the pane you watched end.
    if (on) { paintPaneCap(x); attachWebgl(x); }
    else if (isExited(x)) {
      detachWebgl(x);
      if (isAgent(x) && x.phase === "ended") trimScrollback(x);
    }
  }
  document.documentElement.style.setProperty("--accent", accentFor(s.colorKey));
  if (gid) {
    // Every visible pane needs a real size, not just the focused one — an unfitted
    // pane sits at xterm's default 24×80 inside its grid cell.
    for (const x of sessions.values()) if (x.pane.classList.contains("active")) fitSession(x);
    s.term?.focus();
  } else if (s.term && s.fit) {
    fitSession(s);
    s.term.focus();
  }
  // ⌘1–9, `nextAfterClose` and the tray can all land on a session filed inside a
  // collapsed project group — and a rail with nothing selected while a pane is plainly
  // on screen reads as the selection having been lost. Unfold it before painting.
  revealProjGroup(s.colorKey);
  // `renderAttn` and `updateTray` join the targeted list because the stamp above moved
  // the needs-you set: opening a session takes it out of the badge and the tray title
  // (./attn), and a count that only caught up on the next telemetry event would leave
  // the badge advertising a session you are looking at.
  renderHeader(s); renderInspector(s); renderSidebar(); renderMini(); renderFoot();
  renderAttn(); updateTray();
  // Show the branch that's really checked out right now, immediately on activate.
  void refreshBranch(s).then((changed) => { if (changed) { renderSidebar(); if (activeId === id) renderHeader(s); } });
  void refreshSessionStats(s); // working-set diff + CPU/RAM for the inspector
}

// Poll the inspector's on-demand stats: Episko's disk I/O across *every* owned claude
// session (all_sessions_resources), plus a pick-up of the visible session's working-set
// diff from `dirtyByFolder` — the map the stale-driven dirty poll keeps fresh for every
// agent folder at once. The scopes differ on purpose: a working set belongs to one
// checkout, while the I/O bars answer "how hard is Episko working the disk", which is
// not a per-pane question. See `ioAll` in state.ts.
/// Take ONE reading of the app-wide disk-I/O counters and bank it.
///
/// Split out of `refreshSessionStats` so the rollup can be kept sampled without paying
/// for the `git_diffstat` that used to travel beside it — that one spawns a `git`
/// process per call, which is precisely the kind of churn a disk meter must not add to
/// the thing it is measuring. This half spawns nothing: the backend answers it from one
/// `sysinfo` refresh over the pids we already own, which is a syscall per pid and no
/// disk traffic at all. Persisting stays floored inside `addIo`, so a caller polling
/// this more often does not write more often.
export async function pollIo(): Promise<void> {
  const res = await invoke<
    { read_bps: number; write_bps: number; read_mb: number; written_mb: number; primed: boolean;
      install: InstallFile[] } | null
  >("all_sessions_resources").catch(() => null);
  if (!res) return;
  // Bank the increment off the SAME sample the bars are drawn from, so the rollup and
  // the live figure can never describe different readings — and banked FIRST, because it
  // is what decides how much of this reading was a claude self-update rather than session
  // churn (`addIo`), which every figure below then has to be net of.
  const bank = addIo({ r: res.read_mb, w: res.written_mb }, res.install);
  // Mutated in place, not reassigned: `ioAll` is a live binding every reader imports.
  ioAll.readBps = res.read_bps; ioAll.writeBps = Math.max(0, res.write_bps - ioCreditBps(bank));
  ioAll.readMb = res.read_mb; ioAll.writtenMb = Math.max(0, res.written_mb - ioExcludedMb());
  ioAll.primed = res.primed;
}

export async function refreshSessionStats(s: Sess) {
  if (!isAgent(s) || s.external) return;
  // Only re-render when the *displayed* values change — comparing the rendered strings
  // avoids a needless inspector rebuild (which would restart the heartbeat animation)
  // every 4s while a session sits idle.
  //
  // The I/O half of this signature went with the card: those figures are a footer
  // segment now, and `renderFoot` only writes `textContent`, which destroys no node and
  // restarts no animation — so it is called unconditionally below rather than guarded.
  // The rates jitter every poll, which is exactly why the *inspector* could not be.
  const sig = (g: DiffStat | null) =>
    (g ? `${g.added}/${g.removed}/${g.files}/${g.untracked}/${g.dirty}/${g.ahead}/${g.behind}/${g.upstream}` : "-");
  const before = sig(s.git);
  await pollIo();
  renderFoot();
  // The working set is read from the dirty poll's map, not fetched here — this tick
  // used to spawn a `git status` every 4s for whatever was on stage, the only
  // recurring subprocess in the app, to re-learn what `refreshDirtyStates` already
  // keeps fresh for every agent folder (hook-driven, 15s sweep for editor changes).
  // The cost is one dirty-poll tick of extra latency before the numbers move.
  s.git = dirtyByFolder.get(s.workdir) ?? null;
  if (sig(s.git) !== before && activeId === s.id && !extMirrorId()) renderInspector(s);
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
async function refreshBranches(): Promise<boolean> {
  // Exited panes leave the poll: nothing behind them can move HEAD any more, and a
  // day's dead panes would otherwise out-poll the live fleet (one git_head IPC each,
  // every 4s, forever). Activating one still re-reads once — setActive calls
  // refreshBranch directly — which covers a branch switched under it externally.
  const changed = await Promise.all([...sessions.values()].filter((s) => !isExited(s)).map(refreshBranch));
  return changed.some(Boolean);
}

// Re-read the set of checkouts for every repo that currently has something running in
// it. Returns true if any repo's roster moved. Repos with nothing live are pruned: the
// sidebar is a view of what is in play, and listing the worktrees of a project you
// aren't working in would be noise rather than information.
/// How often a project with *nothing running* has its checkouts re-read. Same
/// stale-driven shape as `refreshDirtyStates`: the live set rides the 4s tick because a
/// worktree an agent just created must appear at once, while a repo nobody is working in
/// changes on human timescales. Reading every favourite every 4s would be ~20 IPC calls
/// a tick to learn nothing.
const IDLE_WT_SWEEP_MS = 20_000;
let idleWtSweptAt = 0;

async function refreshWorktrees(): Promise<boolean> {
  const live = new Set<string>();
  for (const s of sessions.values()) if (isAgent(s) && s.colorKey) live.add(s.colorKey);
  for (const e of externals) if (e.repo_root) live.add(e.repo_root);
  // **A favourite with nothing running needs a roster too.** This set used to be
  // sessions and externals alone, which quietly made the sidebar's peek rows a feature
  // of *busy* projects only: `clusterByWorktree(p, true)` folds in
  // `worktreesByRepo.get(p.path)`, so a project you had not started anything in offered
  // no checkouts to hover for — and closing the last session in one took its rows away
  // again, since the entry was then deleted below. The rule was invisible and read as
  // "the bar sometimes doesn't come".
  const sweep = Date.now() - idleWtSweptAt >= IDLE_WT_SWEEP_MS;
  const roots = new Set(live);
  for (const f of FAVORITES) {
    if (live.has(f.path)) continue;
    // Never read: seed it now, so the rows are there the first time you hover rather
    // than up to a sweep later. Otherwise wait for the slow tick.
    if (sweep || !worktreesByRepo.has(f.path)) roots.add(f.path);
  }
  if (sweep) idleWtSweptAt = Date.now();
  // Keep what is live OR a favourite — dropping an idle favourite's roster on the tick
  // that stops reading it would undo the whole point.
  const keep = new Set([...live, ...FAVORITES.map((f) => f.path)]);
  for (const k of [...worktreesByRepo.keys()]) if (!keep.has(k)) worktreesByRepo.delete(k);
  let changed = false;
  await Promise.all([...roots].map(async (root) => {
    const list = await invoke<WtHead[]>("worktree_heads", { dir: root }).catch(() => null);
    if (!list) return;                                  // not a repo, or it vanished
    const prev = worktreesByRepo.get(root);
    if (prev && wtSig(prev) === wtSig(list)) return;    // the common case: nothing moved
    // Announce only against a roster we already had. The first read of a repo is
    // entirely "new", and toasting every checkout at launch would be pure noise.
    if (prev) announceWtDelta(root, prev, list);
    worktreesByRepo.set(root, list);
    changed = true;
  }));
  return changed;
}

// Tell the user when a checkout appears or disappears underneath them — the event a
// terminal would have shown in its scrollback and the sidebar used to swallow.
function announceWtDelta(root: string, prev: WtHead[], next: WtHead[]) {
  const was = new Set(prev.filter((w) => w.exists).map((w) => w.path));
  const now = new Set(next.filter((w) => w.exists).map((w) => w.path));
  const added = next.filter((w) => w.exists && !was.has(w.path));
  const gone = prev.filter((w) => w.exists && !now.has(w.path));
  // One toast, not one per checkout: `git worktree add` in a loop would otherwise fire
  // a burst where only the last is readable (toast shows a single message at a time),
  // and an add paired with a removal would hide the add entirely.
  const parts: string[] = [];
  if (added.length === 1) parts.push(`⑃ ${added[0].branch} added`);
  else if (added.length > 1) parts.push(`⑃ ${added.length} worktrees added`);
  if (gone.length === 1) parts.push(`⑃ ${gone[0].branch} removed`);
  else if (gone.length > 1) parts.push(`⑃ ${gone.length} worktrees removed`);
  if (parts.length) toast(`${parts.join(" · ")} · ${basename(root)}`);
}

// The single place every git-derived label is re-read and repainted. Both the poll and
// the hook-driven poke land here, so the sidebar, the header's branch chip and the ⑃
// dialog can never disagree about what is checked out where.
export async function refreshGitViews() {
  const [branchMoved, wtMoved] = await Promise.all([refreshBranches(), refreshWorktrees()]);
  if (!branchMoved && !wtMoved) return;
  renderAll();                     // sidebar, header, mini-rail, inspector, tray
  if (wtMoved) void refreshWtDialog();   // …and the ⑃ dialog, if it happens to be open
}

// A Bash call an agent just made is the earliest warning that HEAD moved or a checkout
// appeared. `gitMutates` decides only whether it is worth looking; the re-read decides
// what actually changed. Coalesced, because `git worktree add` immediately followed by
// a checkout inside it is two hooks describing one change.
const GIT_POKE_MS = 250;
let gitPokeT: number | undefined;
export function noteGitCommand(cmd: unknown) {
  if (!gitMutates(cmd)) return;
  clearTimeout(gitPokeT);
  gitPokeT = window.setTimeout(() => { void refreshGitViews(); }, GIT_POKE_MS);
}

// The other half of the same hook: a write tells us *where* the agent is working, which
// is the one thing a branch re-read can never discover — `refreshBranch` reads HEAD in
// the session's own folder, so a session whose agent moved to a sibling checkout goes on
// reporting the branch it left, forever and correctly.
//
// `driftUpdate` owns the rule (including which signal outranks which); this owns only
// the repaint. Everything it reads comes off the same payload — `cwd` catches the moves
// Claude Code makes itself, `tool_input` the ones it doesn't know about (a write's
// `file_path`, or the `cd` a Bash-first agent wrote under).
export function noteDrift(s: Sess, tool: string, data: any) {
  if (!isAgent(s) || !s.workdir) return;
  const roster = worktreesByRepo.get(s.colorKey);
  if (!roster?.length) return;   // no roster yet — the 4s poll seeds it, then this works
  const next = driftUpdate(s.drift, s.workdir, tool, data?.tool_input, data?.cwd, roster);
  // All three fields, not just the identity of the checkout: the branch on a drifted-into
  // checkout can be switched underneath us, and it is what every drift surface spells out.
  if (next?.dir === s.drift?.dir && next?.via === s.drift?.via && next?.branch === s.drift?.branch) return;
  s.drift = next;
  dlog("info", next ? `drift ${s.id.slice(0, 8)} → ${next.branch} (via ${next.via})` : `drift cleared ${s.id.slice(0, 8)}`);
  renderAll();
}

// A green run shouldn't linger — tasks are far more numerous and shorter-lived
// than sessions, and without this the rail silently fills with ticks. A pane you
// are actually looking at is never yanked away, and a failure never auto-closes.
export function scheduleDismiss(s: Sess) {
  if (s.run?.background || !taskPrefs.dismissMs) return;
  window.setTimeout(() => {
    const cur = sessions.get(s.id);
    if (!cur || cur.run?.exitCode !== 0) return;   // re-run or still failing → leave it
    if (activeId === cur.id) return;               // you're reading it
    closeSession(cur.id);
  }, taskPrefs.dismissMs);
}

export function renderHeader(s: Sess | null) {
  ($("btnClose") as HTMLButtonElement).hidden = !s;
  // Reset every attribute a previous session may have left on the shared chip — the
  // drift branch below sets `title`, and only one of the arms after it would clear it.
  const hb = $("hBranch"); hb.classList.remove("ext-chip", "drifted"); hb.title = "";
  if (!s) { $("hProj").textContent = "no session"; hb.hidden = true; $("hTitle").textContent = ""; $("hPath").textContent = ""; return; }
  $("hProj").textContent = s.project;
  if (s.kind !== "claude") { hb.textContent = s.kind === "shell" ? "shell" : "task"; hb.hidden = false; hb.classList.add("ext-chip"); }
  // A drifted session gets BOTH branches, in the order they happened: the chip is the
  // only thing on screen that says which checkout the work is landing in, and showing
  // just the new one would trade a stale label for a lie about where `--resume` goes.
  else if (s.drift) {
    hb.textContent = `${s.branch || basename(s.workdir)} ⤳ ⑃ ${s.drift.branch}`;
    hb.title = `Launched in ${s.workdir}\nWriting to ${s.drift.dir}`;
    hb.hidden = false; hb.classList.add("drifted");
  }
  else if (s.branch) { hb.textContent = s.worktree ? "⑃ " + s.branch : s.branch; hb.hidden = false; } else hb.hidden = true;
  $("hTitle").textContent = s.kind === "claude" ? (s.title || "") : (s.kind === "task" ? s.run?.label ?? "" : "");
  // The path follows the work for the same reason — it is the answer to "where am I?".
  $("hPath").textContent = tilde(s.drift?.dir ?? s.workdir);
}

// The active project context is an Episko session, an external one, or — when the
// dashboard is on stage — the project the dashboard is *about*. That last case is the
// whole reason these two resolvers are shared: a dashboard names its project more
// plainly than any session does, so ＋ Session, ❯ Terminal, ▶ Run and ◷ History should
// act on it exactly as they act on a session's project rather than greying out (or,
// in ＋ Session's case, falling back to ⌘K and asking a question already answered).
export function activeProjectCtx(): { project: string; path: string } | null {
  // The dashboard's root *is* the repo key — the sidebar groups by it — so it needs no
  // resolution, and it is checked first because all three mirror kinds share one pointer.
  const dm = dashMirror();
  if (dm) return { project: dm.name, path: dm.root };
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
export function activeCwd(): string | null {
  // A dashboard is about a repo, not a checkout, so its root is both answers at once.
  const dm = dashMirror();
  if (dm) return dm.root;
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); return e ? e.cwd : null; }
  if (pastMirrorId()) { const d = dormants.find((x) => x.id === pastMirrorId()); return d ? d.workdir : null; }
  const s = activeId ? sessions.get(activeId) : null;
  return s ? s.workdir : null;
}
// Open a plain (non-Claude) terminal at the active project's cwd for running shell
// commands alongside a session. When the launch engine is "embedded" it opens an
// in-app shell pane (like a session); otherwise it opens the external terminal app.
export function openPlainTerminal() {
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
  // …and so can a dashboard, whose root is the repo key and whose name is the label
  // the sidebar already uses — better than basename(), which is what the fallback gives.
  const dm = dashMirror();
  const colorKey = s ? s.colorKey : e ? (e.repo_root || e.cwd) : d ? d.colorKey : wd;
  const worktree = s ? s.worktree : e ? (e.repo_root && e.cwd !== e.repo_root ? (e.branch || basename(e.cwd)) : null) : d ? d.worktree : null;
  const branch = s ? s.branch : (e?.branch || d?.branch || "");
  launchShell(s ? s.project : (d?.project ?? dm?.name ?? basename(colorKey)), wd, { colorKey, worktree, branch });
}

// terminal and put the command on the clipboard — honest about the extra paste.
export async function handToTerminal(project: string, workdir: string, cmd: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}) {
  if (termEngine === "embedded") {
    const id = await launchShell(project, workdir, opts);
    // The login shell needs a moment before its prompt will accept input.
    setTimeout(() => { void invoke("write_pty", { sessionId: id, data: cmd }).catch(() => {}); }, 600);
    toast("Prefilled in a shell. Press Enter to run");
    return;
  }
  try { await navigator.clipboard.writeText(cmd); } catch { /* clipboard denied — the toast still names the command */ }
  invoke("open_terminal_here", { workdir, engine: termEngine })
    .then(() => toast("Terminal opened, command copied: " + cmd))
    .catch((e) => toast("terminal: " + e));
}

// ▶ Run and ❯ Terminal both act on the active project's directory, so with no
// session, shell or mirrored external there is nothing for them to act on. Greying
// them says so up front; a live button whose only response is an error toast reads
// as if the click failed. The guards in openRunPicker/openPlainTerminal stay, since
// ⌘⇧R and ⌘T bypass the button entirely.
export function syncStageButtons() {
  const wd = activeCwd();
  const set = (id: string, enabled: string, disabled = "Start a session first; this runs in the active project") => {
    const b = $(id) as HTMLButtonElement;
    b.disabled = !wd;
    b.title = wd ? enabled : disabled;
  };
  set("btnRun", "Run a task or script from this project");
  set("btnTerm", "Open a plain (non-Claude) terminal at the project root");
  // ◷ History belongs to the same set — it opens scoped to the project on screen.
  // Its disabled reason is different in kind, though: the whole-machine view is
  // always one click away in the top bar, so say where it went rather than
  // "start a session".
  set("btnHist", "Reopen a past session in this project, including ones you closed (⌘⇧H)",
      "No project selected. The ◷ button up top opens history for every project");
}

// Which session (if any) has a git action in flight — the buttons grey out while
// it runs, since fetch/pull/push can take seconds against a slow remote.
// Run fetch/pull/push for a session's workdir. A refusal is not an error: the
// backend declines the cases it can't finish safely and names the command that
// would work, which we offer as a terminal handoff rather than a dead end.
export async function runGit(sessionId: string, op: string) {
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
    // ahead/behind moved — force the dirty poll to re-read this folder now (the
    // working set rides its map), then pick the fresh value up into the inspector.
    dirtyStale.add(s.workdir);
    void refreshDirtyStates().then(() => refreshSessionStats(s));
    void refreshBranch(s).then((changed) => { if (changed) renderAll(); });
    repaint();
  }
}
