// Panes: the four spawners (claude, shell, task, agent) and the life of a pane once it is
// on stage, plus the stage's own chrome (renderHeader, syncStageButtons) and the two
// "…here" context resolvers (activeProjectCtx, activeCwd). The xterm plumbing is ./terminal.

import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { $, takeStage, toast } from "./dom";
import { ask } from "./confirm";
import { playSound } from "./chime";
import { dlog } from "./debug";
import { basename, cleanTitle, esc, tilde } from "./format";
import {
  canShelve, CLAUDE_CLI, hasAgentCapability, hasSessionState, isAgent, isExited,
  providerCapabilities, providerSessionKey, resumeAgent,
  statusKey, taskStateText, type AgentCli, type DiffStat, type GitActionResult,
  type InstallFile, type LiveSess, type Restorable, type Runnable, type Sess,
  type WtHead,
} from "./types";
import { readList } from "./store";
import { setPhase } from "./phase";
import { driftUpdate, gitMutates } from "./gitwatch";
import {
  attachWebgl, claudeInput, clipboardKeys, detachWebgl, fitSession, MONO,
  refit, shellKeys, trimScrollback, winClaudePaste, wireLinks,
} from "./terminal";
import { gitBusy, setGitBusy } from "./inspectorview";
import { GCLASS } from "./sidebarview";
import { renderInspector } from "./inspector";
import { renderMini, renderSidebar, revealProjGroup } from "./sidebar";
import { renderAttn, renderFoot } from "./footer";
import { updateTray } from "./tray";
import { closeExternalView, flushRoster, queueRosterSave, refreshDirtyStates, rosterEntry } from "./mirror";
import { openWt, refreshWtDialog } from "./worktree";
import { adoptIdentity, nextAfterClose, nextInGroup, orphanAdoptions } from "./grouping";
import { probeIcon } from "./icons";
import { addIo, ioCreditBps, ioExcludedMb } from "./usage";
import { execCmd, exitWaiters, taskPrefs, type TaskLaunchOpts } from "./tasks";
import {
  accentFor, activeId, agentDef, agentDiscoveryReady, availAgents, backendLive, collapsedRuns, dashMirror, dirtyByFolder, dirtyStale, dormants,
  effectiveAgent, engineDef,
  externals, extMirrorId, FAVORITES, ioAll, pastMirrorId, permissionModeFor,
  sessions, setActiveId, setBackendLive, setDormants, setStageGroup, stageGroup, termEngine,
  termFontSize, termScrollback, worktreesByRepo, wtSig,
} from "./state";
import { providerPermissionMode } from "./providers";

// The app-wide repaint belongs to main.ts, which wires this at startup.
let renderAll: () => void = () => {};
export function setPanesRenderAll(fn: typeof renderAll) { renderAll = fn; }

function launchPermission(agent: AgentCli) {
  if (!agent.capabilities.includes("launch-permissions")) return { mode: null, def: null };
  const def = providerPermissionMode(agent.id, permissionModeFor(agent.id));
  return { mode: def && def.id !== "default" ? def.id : null, def };
}

// Shared by a fresh launch and reload adoption, so key wiring cannot drift between them.
function newClaudeTerm(id: string, pane: HTMLElement): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: true, scrollback: termScrollback,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // No WebGL here: setActive attaches a pooled context once the pane is on stage (attachWebgl).
  term.open(pane);
  wireLinks(id, term);
  term.onData(claudeInput(id)); // ^C interrupts; it never exits the session
  winClaudePaste(id, term, pane);
  return { term, fit };
}

// Agent TUIs own their chords, so clipboardKeys only, never shellKeys; shared by launch and adoption.
function newAgentTerm(id: string, pane: HTMLElement): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: true, scrollback: termScrollback,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit); term.open(pane);
  wireLinks(id, term);
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  term.attachCustomKeyEventHandler(clipboardKeys(term));
  return { term, fit };
}

// ---------- launch ----------
// Returns the session id, or null when the spawn failed; the dashboard's dispatch depends on it.
export async function launch(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string; resume?: string; resumeProvider?: string; agent?: string } = {}): Promise<string | null> {
  await agentDiscoveryReady;
  const id = crypto.randomUUID();
  const colorKey = opts.colorKey ?? workdir;
  // The provider first: a resume carries its own, an explicit opts.agent overrides the
  // project preference, and only Claude uses the hook-backed spawner below.
  const agent = opts.resume
    ? resumeAgent(opts.resumeProvider, availAgents)
    : agentDef(opts.agent ?? "") ?? effectiveAgent(colorKey);
  // A restore row's provider is identity, not a preference: refuse before any pane,
  // session or roster mutation rather than open the conversation under Claude.
  if (!agent) {
    const provider = opts.resumeProvider || "unknown";
    dlog("warn", `resume refused for unsupported provider ${provider} · ${opts.resume}`);
    toast(`Can't resume: ${provider} isn't supported by this build`);
    return null;
  }
  if (agent.id !== CLAUDE_CLI.id) {
    return launchAgent(agent, project, workdir, { colorKey, worktree: opts.worktree, branch: opts.branch, resume: opts.resume });
  }
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
    phase: "idle", phaseSince: Date.now(), attnAt: 0, seenAt: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], agents: new Map(), fanout: null, queuedPrompt: false, apiErr: null, revive: null, drift: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [], rateLimitScope: null, git: null,
    lastEvent: "", activity: [],
    files: [], tally: {}, servers: [], kind: "agent", provider: "claude",
    capabilities: [...CLAUDE_CLI.capabilities], external, term, fit, pane,
  };
  sessions.set(id, s);
  term?.onTitleChange((t) => {
    const c = cleanTitle(t, s);
    // The tray reads the title too, and this path bypasses renderAll.
    if (c !== s.title) { s.title = c; renderSidebar(); updateTray(); if (activeId === id) renderHeader(s); }
  });
  setActive(id);
  queueRosterSave();
  // "default" is Claude's own ask-me mode, i.e. no flag, so it goes over the wire as null.
  // Read here rather than passed as an opt: it is a preference, like termEngine.
  const permission = launchPermission(agent);
  const mode = permission.mode;
  dlog("info", `${opts.resume ? "resume" : "launch"} ${project} · ${id.slice(0, 8)} · ${termEngine}${mode ? ` · ${permission.def?.label}` : ""}${opts.worktree ? " · worktree" : ""}${opts.resume ? ` · from ${opts.resume.slice(0, 8)}` : ""}`);

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
  // Only a spawn that worked: the failure already toasts, and a chirp under it reads as success.
  if (spawned) playSound("launched");
  // A restored session replaces its dormant row, or the sidebar lists the conversation
  // twice — after the spawn, or a resume that failed has thrown its restorable row away.
  if (spawned && opts.resume) setDormants(dormants.filter((d) => d.resumeId !== opts.resume));
  invoke<string | null>("git_branch", { workdir }).then((b) => {
    if (b && !s.branch) { s.branch = b; renderSidebar(); if (activeId === id) renderHeader(s); }
  });
  renderAll();
  return spawned ? id : null;
}

// Offer a worktree when launching into a repo that already has a session. Synchronous on
// purpose: nothing may be awaited before the dialog is up (a git_branch IPC queues behind
// the pollers and "+ Session" feels dead). A caller that knows better (the dashboard) passes `known`.
export function requestLaunch(project: string, path: string, known?: { branch: string } | null) {
  if (known) { openWt(project, path, known.branch); return; }
  // Externals live in their own array and count as "already running here" too.
  const sess = [...sessions.values()].find((s) => s.colorKey === path);
  const ext = externals.find((e) => (e.repo_root || e.cwd) === path);
  if (sess || ext) {
    const branch = sess?.branch || ext?.branch || "";
    // Only a repo gets the worktree dialog; otherwise a plain launch is the honest answer.
    if (branch || dirtyByFolder.get(path) != null) { openWt(project, path, branch); return; }
  }
  launch(project, path, { colorKey: path });
}

// The sidebar's per-worktree ＋: never opens the worktree dialog, since the cluster header
// is that dialog's answer. `root` is the repo root, the colorKey the project groups by.
export function launchWorktree(project: string, root: string, dir: string, branch: string) {
  launch(project, dir, { colorKey: root, worktree: dir === root ? null : branch, branch });
}

// ---------- adoption: panes for the PTYs a webview reload orphaned (#47) ----------
// One Sess per orphan, the backend's scrollback replayed into a fresh term; identity comes
// from the roster (a roster-less orphan adopts under its workdir's name). Runs once at
// startup, BEFORE loadDormants, so the roster reconcile skips the ids that are live again.
export async function adoptOrphans(): Promise<number> {
  let back: LiveSess[] = [];
  try { back = await invoke<LiveSess[]>("live_sessions"); } catch { return 0; }
  const roster = readList<Restorable>("cc-restore");
  const orphans = orphanAdoptions(back, roster);
  for (const o of orphans) await adoptSession(o);
  if (orphans.length) {
    dlog("warn", `adopted ${orphans.length} orphaned pane${orphans.length === 1 ? "" : "s"} after a webview reload`);
    toast(`Reattached ${orphans.length} running session${orphans.length === 1 ? "" : "s"} after a reload`);
    // Give the stage to the freshest orphan, unless the user has already picked something.
    if (!activeId && !pastMirrorId() && !extMirrorId() && !dashMirror()) {
      const front = [...sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity)[0];
      if (front) setActive(front.id);
    }
    renderAll();
  }
  return orphans.length;
}

async function adoptSession(o: { id: string; workdir: string; provider: string; meta: Restorable | null }) {
  const m = o.meta;
  const provider = o.provider || m?.provider || "claude";
  const providerDef = provider === "claude" ? CLAUDE_CLI : agentDef(provider);
  const capabilities = providerDef?.capabilities ?? providerCapabilities(provider);
  // Roster-less only: lets a worktree pane adopt under its repo, not its branch folder (adoptIdentity).
  const heads = m ? [] : await invoke<WtHead[]>("worktree_heads", { dir: o.workdir }).catch(() => [] as WtHead[]);
  const { project, colorKey, worktree, branch } = adoptIdentity(o.workdir, m, heads);
  probeIcon(colorKey);
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const { term, fit } = provider === "claude" ? newClaudeTerm(o.id, pane) : newAgentTerm(o.id, pane);
  const s: Sess = {
    id: o.id, project, accent: accentFor(colorKey), workdir: o.workdir, colorKey,
    resumeId: m?.resumeId ?? o.id, branch, worktree,
    title: m?.title ?? providerDef?.label ?? provider,
    phase: "idle", phaseSince: Date.now(), attnAt: 0, seenAt: Date.now(), lastActivity: m?.lastActivity ?? Date.now(),
    attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], agents: new Map(), fanout: null,
    queuedPrompt: false, apiErr: null, revive: null, drift: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [], rateLimitScope: null, git: null,
    lastEvent: "", activity: [],
    files: [], tally: {}, servers: [], kind: "agent", provider,
    capabilities: [...capabilities], external: false, term, fit, pane,
    adopt: { pending: [] },
  };
  // From here the pty-output listener queues chunks into s.adopt until the snapshot lands.
  sessions.set(o.id, s);
  // The backend observer survived the reload; ask it to replay once the Sess can receive events.
  if (capabilities.includes("session-state") && provider !== "claude") {
    invoke("refresh_agent_state", { sessionId: o.id }).catch((e) => {
      dlog("warn", `provider state refresh failed for ${o.id.slice(0, 8)}: ${e}`);
    });
  }
  term.onTitleChange((t) => {
    const c = cleanTitle(t, s);
    if (c !== s.title) { s.title = c; renderSidebar(); updateTray(); if (activeId === o.id) renderHeader(s); }
  });
  try {
    const snap = await invoke<{ data: string; seq: number }>("read_scrollback", { sessionId: o.id });
    term.write(Uint8Array.from(atob(snap.data), (c) => c.charCodeAt(0)));
    for (const c of s.adopt!.pending) if (c.seq > snap.seq) term.write(c.bytes);
  } catch (e) {
    // Most likely the process exited since the listing; no pty-exit reaches a pane that did not exist yet.
    const gone = String(e).includes("no such session");
    if (gone) {
      setPhase(s, "ended");   // never bare: `phaseSince` is what every "for how long" reads
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

// A plain login shell; returns the id so a caller can write into it (handToTerminal).
export async function launchShell(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  // Key on the repo root so a shell opened in a worktree nests under its repo.
  const colorKey = opts.colorKey ?? workdir;
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: true, scrollback: termScrollback,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  wireLinks(id, term);
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  // One handler, both rules: Terminal.app-style ⌥/⌘ nav and Ctrl+Shift+C/V.
  term.attachCustomKeyEventHandler(shellKeys(id, term));
  const s: Sess = {
    // resumeId is inert for a shell — it has no transcript and saveRoster skips it.
    id, project, accent: accentFor(colorKey), workdir, colorKey, resumeId: id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "shell",
    phase: "idle", phaseSince: Date.now(), attnAt: 0, seenAt: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], agents: new Map(), fanout: null, queuedPrompt: false, apiErr: null, revive: null, drift: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [], rateLimitScope: null, git: null,
    lastEvent: "", activity: [],
    files: [], tally: {}, servers: [],
    kind: "shell", provider: null, capabilities: [], external: false, term, fit, pane,
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

// Any non-Claude agent; the AgentCli capability set serves integrated and terminal-only providers alike.
export async function launchAgent(agent: AgentCli, project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string; resume?: string } = {}): Promise<string | null> {
  const id = crypto.randomUUID();
  const colorKey = opts.colorKey ?? workdir;
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const { term, fit } = newAgentTerm(id, pane);
  const s: Sess = {
    id, project, accent: accentFor(colorKey), workdir, colorKey, resumeId: opts.resume ?? id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: agent.label,
    phase: "idle", phaseSince: Date.now(), attnAt: 0, seenAt: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], agents: new Map(), fanout: null, queuedPrompt: false, apiErr: null, revive: null, drift: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [], rateLimitScope: null, git: null,
    lastEvent: "", activity: [],
    files: [], tally: {}, servers: [],
    kind: "agent", provider: agent.id, capabilities: [...agent.capabilities], external: false, term, fit, pane,
  };
  sessions.set(id, s);
  setActive(id);
  const permission = launchPermission(agent);
  dlog("info", `${opts.resume ? "resume" : "agent"} ${agent.id} · ${project} · ${id.slice(0, 8)}${permission.mode ? ` · ${permission.def?.label}` : ""}`);
  let spawned = true;
  try {
    await invoke("spawn_agent", { sessionId: id, workdir, agent: agent.id, rows: term.rows || 24, cols: term.cols || 80, resume: opts.resume ?? null, mode: permission.mode });
    if (opts.resume) setDormants(dormants.filter((d) => d.provider !== agent.id || d.resumeId !== opts.resume));
  } catch (e) {
    spawned = false;
    dlog("error", `${agent.id} launch failed: ${e}`);
    toast(`${agent.label} failed: ${e}`);
    term.writeln(`\r\n\x1b[31m[${agent.id} error] ${e}\x1b[0m`);
  }
  renderAll();
  return spawned ? id : null;
}

// One run of a Runnable in its own pane; same PTY and xterm setup as launchShell.
export async function launchTask(r: Runnable, project: string, opts: TaskLaunchOpts = {}): Promise<string | null> {
  if (r.blocked) { toast(`${r.label}: ${r.blocked}`); return null; }
  const id = crypto.randomUUID();
  const colorKey = opts.colorKey ?? r.cwd;
  // Settings › Tasks: "root" redirects to the repo root, "session" keeps the discovering
  // folder. A task that declared its own cwd (tasks.toml, VS Code options.cwd) keeps it.
  const declaredOwnCwd = !!opts.discoveredIn && r.cwd !== opts.discoveredIn;
  const cwd = taskPrefs.cwd === "root" && !declaredOwnCwd ? colorKey : r.cwd;
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  // The caption a tiled run group shows (CSS-hidden otherwise). Created before
  // term.open(pane), which appends, so it ends up above the terminal.
  const cap = document.createElement("div");
  cap.className = "pane-cap";
  // data-close is routed to closeSession by main.ts's dispatcher.
  cap.innerHTML = `<span class="pc-name"></span><span class="pc-state"></span>`
    + `<span class="pc-x" data-close="${id}" title="Close this pane">✕</span>`;
  pane.appendChild(cap);
  const term = new Terminal({
    fontFamily: MONO, fontSize: termFontSize, cursorBlink: false, scrollback: termScrollback,
    theme: { background: "#0c0b11", foreground: "#dcd8e6", cursor: "#c3b6f0", selectionBackground: "#3a3350" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  wireLinks(id, term);
  // Tasks are interactive: a prompt, a y/N, a dev server's "r" to reload all work.
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  term.attachCustomKeyEventHandler(clipboardKeys(term));

  const cmd = execCmd(r);
  const s: Sess = {
    id, project, accent: accentFor(colorKey), workdir: cwd, colorKey,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: r.label,
    phase: "working", phaseSince: Date.now(), attnAt: 0, seenAt: Date.now(), lastActivity: Date.now(), attention: null,
    pendingCmd: "", pendingPermId: null, pendRisk: null, pendingPermissions: [], agents: new Map(), fanout: null, queuedPrompt: false, apiErr: null, revive: null, drift: null,
    model: "", ctxPct: null, ctxTokens: null, cost: null, durMs: null,
    curTool: "", curArg: "", todos: [], ctxHist: [], costHist: [], tokenUsage: null, rateLimits: [], rateLimitScope: null, git: null,
    lastEvent: "", activity: [],
    files: [], tally: {}, servers: [],
    resumeId: id, kind: "task", provider: null, capabilities: [], external: false, term, fit, pane,
    run: { id: r.id, label: r.label, source: r.source, sourceFile: r.sourceFile, cmd, background: r.background, startedAt: Date.now(), exitCode: null, tail: [], root: opts.discoveredIn ?? colorKey, forSession: opts.forSession, groupId: opts.groupId, groupLabel: opts.groupLabel },
  };
  sessions.set(id, s);
  // A chain member puts its GROUP on stage, not itself: activating each member as it
  // spawned left the stage on the last step to start and untiled the group on the way.
  // An unfocused pane starts at xterm's 24×80 and gets a real size when activated.
  if (opts.focus !== false) {
    const gid = opts.groupId;
    if (!gid) {
      setActive(id);
    } else {
      // Re-tile for later steps only while the stage is still on this group; never yank you back.
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
  // Resolve the successor while the closing session is still in the map.
  const next = wasActive ? nextAfterClose(s) : null;
  // Closing one tile stays in the mosaic; `nextAfterClose` alone would hand the stage to a sidebar neighbour.
  const gid = s.run?.groupId;
  const groupNext = wasActive && gid && stageGroup === gid
    ? nextInGroup(groupMembers(gid), id)
    : null;
  invoke("kill_session", { sessionId: id }).catch(() => {});
  // term.dispose() alone does not return the pooled GL slot (terminal.ts).
  detachWebgl(s);
  try { s.term?.dispose(); } catch { /* */ }
  s.pane.remove();
  sessions.delete(id);
  flushRoster(); // an explicit close means done — it should not come back on restart
  // Drop an emptied group's pointer BEFORE the successor is activated, so setActive
  // paints a single-pane stage rather than a grid of empty cells.
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
  // The grid reflowed but #terminals did not resize, so the ResizeObserver never fires.
  if (stageGroup) refit();
  renderAll();
}

// Shelve: stop the process, keep the row. A shelved session becomes the same restorable
// row a quit writes (rosterEntry → dormants), never a second kind. The dormant entry goes
// on the list BEFORE closeSession, whose flushRoster keeps only dormants that are not live;
// backendLive is pruned by hand because its 3s poll would paint the fresh row busy.
export function shelveSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (!canShelve(s)) {
    toast(s.external ? "That session runs in your terminal — Episko can't stop it"
      : isAgent(s) ? `${s.provider ?? "This agent"} can't resume a conversation, so shelving it would lose it`
        : "Only agent sessions can be shelved");
    return false;
  }
  setDormants([rosterEntry(s), ...dormants.filter((d) => d.id !== s.id)]);
  const key = providerSessionKey(s.provider, s.id);
  if (backendLive.has(key)) setBackendLive(new Set([...backendLive].filter((k) => k !== key)));
  dlog("info", `shelve ${s.project} · ${s.id.slice(0, 8)} · ${s.provider ?? "agent"}`);
  closeSession(id);
  return true;
}

// The ✕ on a run group's sidebar header. Asks first if anything still runs (killing a
// stack is not undoable); a finished chain closes at once. Snapshot the ids first:
// closeSession mutates the map and can re-enter setActive.
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

// Presentational only, so it repaints the sidebar and nothing else.
export function toggleRunGroup(gid: string) {
  if (collapsedRuns.has(gid)) collapsedRuns.delete(gid);
  else collapsedRuns.add(gid);
  renderSidebar();
}


// Launch order is mosaic order, so "the next tile" means the next one on screen.
function groupMembers(gid: string): Sess[] {
  return [...sessions.values()]
    .filter((x) => x.run?.groupId === gid)
    .sort((a, b) => (a.run?.startedAt ?? 0) - (b.run?.startedAt ?? 0));
}

// Called from renderAll: panes sit outside the render-everything sweep, and a caption shows live state.
export function refreshPaneCaps() {
  if (!stageGroup) return;
  for (const s of sessions.values()) if (s.run?.groupId === stageGroup) paintPaneCap(s);
}

// Only visible in the tiled view, so cheap enough to keep current unconditionally.
function paintPaneCap(s: Sess) {
  const cap = s.pane.querySelector<HTMLElement>(".pane-cap");
  if (!cap) return;
  const name = cap.querySelector<HTMLElement>(".pc-name");
  const state = cap.querySelector<HTMLElement>(".pc-state");
  if (name) name.textContent = s.run?.label ?? s.title ?? "pane";
  // A finished run's ✕ stays on screen (dismissing it is what comes next); a running one's is hover-only.
  cap.classList.toggle("done", s.run?.exitCode != null);
  if (state) {
    state.textContent = s.kind === "task" ? taskStateText(s) : "";
    state.className = "pc-state " + (GCLASS[statusKey(s)] || "");
  }
}

// Tile a run group, focused on the failure if there is one, else the last step to start.
// Called from the header click and from launchTask per member, so it re-derives the
// member list every time and is safe with the group half-populated.
export function openRunGroup(gid: string) {
  const members = groupMembers(gid);
  if (!members.length) return;
  const focus = members.find((m) => m.phase === "error")
    ?? members.reduce((a, b) => (b.run!.startedAt > a.run!.startedAt ? b : a));
  setStageGroup(gid);
  // keepGroup is required: setActive clears stageGroup by default, and the stage would never tile.
  setActive(focus.id, true);
}

// Clicking a tile: keeps the mosaic (stageGroup) and moves activeId, where setActive would untile.
export function focusInGroup(id: string) {
  const s = sessions.get(id);
  if (!s || !stageGroup || s.run?.groupId !== stageGroup || id === activeId) return;
  setActiveId(id);
  s.seenAt = Date.now();   // reading a tile counts as looking at it, same as setActive
  for (const x of sessions.values()) x.pane.classList.toggle("focused", x.id === id);
  document.documentElement.style.setProperty("--accent", accentFor(s.colorKey));
  renderAll();
}

// Put one pane on the stage. keepGroup is for openRunGroup alone.
export function setActive(id: string, keepGroup = false) {
  const s = sessions.get(id);
  if (!s) return;
  // closeExternalView drops the stage to the empty card; takeStage below replaces it with the pane.
  closeExternalView();
  setActiveId(id);
  // The seenAt stamp takes a finished session out of the badge (./attn); focusInGroup stamps it too.
  // Stamped for every kind of pane so the field never needs a kind test.
  s.seenAt = Date.now();
  // A sidebar row always shows one pane; the group header tiles them, and a tile click is focusInGroup.
  if (stageGroup && !keepGroup) setStageGroup(null);
  const gid = stageGroup;
  takeStage("session");
  $("terminals").classList.toggle("tiled", !!gid);
  for (const x of sessions.values()) {
    const on = gid ? x.run?.groupId === gid : x.id === id;
    x.pane.classList.toggle("active", on);
    x.pane.classList.toggle("focused", !!gid && x.id === id);
    // Attach after the class flip (the addon needs a measurable pane). A live pane leaving
    // the stage keeps its context (the LRU pool bounds them; docs/architecture.md); an
    // exited one frees it now, and an ended claude pane gives up its scrollback too.
    if (on) { paintPaneCap(x); attachWebgl(x); }
    else if (isExited(x)) {
      detachWebgl(x);
      if (hasSessionState(x) && x.phase === "ended") trimScrollback(x);
    }
  }
  document.documentElement.style.setProperty("--accent", accentFor(s.colorKey));
  if (gid) {
    // Every tile needs a real size, not just the focused one.
    for (const x of sessions.values()) if (x.pane.classList.contains("active")) fitSession(x);
    s.term?.focus();
  } else if (s.term && s.fit) {
    fitSession(s);
    s.term.focus();
  }
  // ⌘1–9, nextAfterClose and the tray can land inside a collapsed project group; unfold it.
  revealProjGroup(s.colorKey);
  // renderAttn and updateTray too: the seenAt stamp above moved the needs-you set (./attn).
  renderHeader(s); renderInspector(s); renderSidebar(); renderMini(); renderFoot();
  renderAttn(); updateTray();
  void refreshBranch(s).then((changed) => { if (changed) { renderSidebar(); if (activeId === id) renderHeader(s); } });
  void refreshSessionStats(s); // working-set diff + disk I/O
}

// One reading of the app-wide disk-I/O counters, banked. Kept apart from
// refreshSessionStats so it spawns nothing: a disk meter must not add git churn to what
// it measures. Persisting is floored inside addIo. App-wide by design (ioAll in state.ts).
export async function pollIo(): Promise<void> {
  const res = await invoke<
    { read_bps: number; write_bps: number; read_mb: number; written_mb: number; primed: boolean;
      install: InstallFile[] } | null
  >("all_sessions_resources").catch(() => null);
  if (!res) return;
  // Banked first, off the same sample the bars use: addIo decides how much of this
  // reading was a claude self-update, which every figure below is net of.
  const bank = addIo({ r: res.read_mb, w: res.written_mb }, res.install);
  // Mutated in place, not reassigned: `ioAll` is a live binding every reader imports.
  ioAll.readBps = res.read_bps; ioAll.writeBps = Math.max(0, res.write_bps - ioCreditBps(bank));
  ioAll.readMb = res.read_mb; ioAll.writtenMb = Math.max(0, res.written_mb - ioExcludedMb());
  ioAll.primed = res.primed;
}

export async function refreshSessionStats(s: Sess) {
  if (!hasSessionState(s) || s.external) return;
  // Repaint the inspector only when the displayed values change (a rebuild restarts the
  // heartbeat animation); renderFoot writes textContent only, so it runs unconditionally.
  const sig = (g: DiffStat | null) =>
    (g ? `${g.added}/${g.removed}/${g.files}/${g.untracked}/${g.dirty}/${g.ahead}/${g.behind}/${g.upstream}` : "-");
  const before = sig(s.git);
  await pollIo();
  renderFoot();
  // Read from the dirty poll's map rather than spawning a git status every 4s.
  s.git = dirtyByFolder.get(s.workdir) ?? null;
  if (sig(s.git) !== before && activeId === s.id && !extMirrorId()) renderInspector(s);
}

// Re-read the label from live HEAD (a checkout's branch can change). True if it changed.
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
  // Exited panes leave the poll, or a day's dead panes out-poll the live fleet; setActive still re-reads one.
  const changed = await Promise.all([...sessions.values()].filter((s) => !isExited(s)).map(refreshBranch));
  return changed.some(Boolean);
}

// Re-read the checkouts of every repo with something running on each tick; a favourite
// with nothing running only every IDLE_WT_SWEEP_MS, since it changes on human timescales
// and reading every favourite every 4s is ~20 IPC calls to learn nothing.
const IDLE_WT_SWEEP_MS = 20_000;
let idleWtSweptAt = 0;

async function refreshWorktrees(): Promise<boolean> {
  const live = new Set<string>();
  for (const s of sessions.values()) if (isAgent(s) && s.colorKey) live.add(s.colorKey);
  for (const e of externals) if (e.repo_root) live.add(e.repo_root);
  // A favourite with nothing running needs a roster too, or the sidebar's peek rows
  // (clusterByWorktree reads worktreesByRepo) become a feature of busy projects only.
  const sweep = Date.now() - idleWtSweptAt >= IDLE_WT_SWEEP_MS;
  const roots = new Set(live);
  for (const f of FAVORITES) {
    if (live.has(f.path)) continue;
    // Never read yet: seed it now rather than up to a sweep later.
    if (sweep || !worktreesByRepo.has(f.path)) roots.add(f.path);
  }
  if (sweep) idleWtSweptAt = Date.now();
  // Keep favourites' rosters too, or the tick that stops reading one would drop it.
  const keep = new Set([...live, ...FAVORITES.map((f) => f.path)]);
  for (const k of [...worktreesByRepo.keys()]) if (!keep.has(k)) worktreesByRepo.delete(k);
  let changed = false;
  await Promise.all([...roots].map(async (root) => {
    const list = await invoke<WtHead[]>("worktree_heads", { dir: root }).catch(() => null);
    if (!list) return;                                  // not a repo, or it vanished
    const prev = worktreesByRepo.get(root);
    if (prev && wtSig(prev) === wtSig(list)) return;    // the common case: nothing moved
    // Announce only against a roster we already had; the first read is all "new".
    if (prev) announceWtDelta(root, prev, list);
    worktreesByRepo.set(root, list);
    changed = true;
  }));
  return changed;
}

// A checkout appearing or vanishing underneath you is news a terminal would have shown.
function announceWtDelta(root: string, prev: WtHead[], next: WtHead[]) {
  const was = new Set(prev.filter((w) => w.exists).map((w) => w.path));
  const now = new Set(next.filter((w) => w.exists).map((w) => w.path));
  const added = next.filter((w) => w.exists && !was.has(w.path));
  const gone = prev.filter((w) => w.exists && !now.has(w.path));
  // One toast: it shows a single message at a time, so a burst would hide all but the last.
  const parts: string[] = [];
  if (added.length === 1) parts.push(`⑃ ${added[0].branch} added`);
  else if (added.length > 1) parts.push(`⑃ ${added.length} worktrees added`);
  if (gone.length === 1) parts.push(`⑃ ${gone[0].branch} removed`);
  else if (gone.length > 1) parts.push(`⑃ ${gone.length} worktrees removed`);
  if (parts.length) toast(`${parts.join(" · ")} · ${basename(root)}`);
}

// The single place git-derived labels are re-read, so the sidebar, header chip and ⑃ dialog agree.
export async function refreshGitViews() {
  const [branchMoved, wtMoved] = await Promise.all([refreshBranches(), refreshWorktrees()]);
  if (!branchMoved && !wtMoved) return;
  renderAll();                     // sidebar, header, mini-rail, inspector, tray
  if (wtMoved) void refreshWtDialog();   // …and the ⑃ dialog, if it happens to be open
}

// An agent's Bash call is the earliest warning that HEAD moved. Coalesced: `git worktree
// add` followed by a checkout inside it is two hooks describing one change.
const GIT_POKE_MS = 250;
let gitPokeT: number | undefined;
export function noteGitCommand(cmd: unknown) {
  if (!gitMutates(cmd)) return;
  clearTimeout(gitPokeT);
  gitPokeT = window.setTimeout(() => { void refreshGitViews(); }, GIT_POKE_MS);
}

// A write says WHERE the agent works, which a HEAD re-read in the session's own folder can
// never discover. driftUpdate owns the rule; this owns the repaint (docs/worktrees.md).
export function noteDrift(s: Sess, tool: string, data: any) {
  if (!hasAgentCapability(s, "activity") || !s.workdir) return;
  const roster = worktreesByRepo.get(s.colorKey);
  if (!roster?.length) return;   // no roster yet — the 4s poll seeds it, then this works
  const next = driftUpdate(s.drift, s.workdir, tool, data?.tool_input, data?.cwd, roster);
  // All three fields: the branch of a drifted-into checkout can be switched underneath us.
  if (next?.dir === s.drift?.dir && next?.via === s.drift?.via && next?.branch === s.drift?.branch) return;
  s.drift = next;
  dlog("info", next ? `drift ${s.id.slice(0, 8)} → ${next.branch} (via ${next.via})` : `drift cleared ${s.id.slice(0, 8)}`);
  renderAll();
}

// Auto-close a green run: tasks are many and short-lived, and the rail would fill with ticks.
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
  // canShelve is the one place that decides, so the header, palette and sign-off sheet agree.
  ($("btnShelve") as HTMLButtonElement).hidden = !s || !canShelve(s);
  // Reset the shared chip: the drift arm sets `title` and the other arms would not clear it.
  const hb = $("hBranch"); hb.classList.remove("ext-chip", "drifted"); hb.title = "";
  if (!s) { $("hProj").textContent = "no session"; hb.hidden = true; $("hTitle").textContent = ""; $("hPath").textContent = ""; return; }
  $("hProj").textContent = s.project;
  if (!hasSessionState(s)) {
    hb.textContent = s.kind === "shell" ? "shell" : s.kind === "task" ? "task" : (s.title || s.provider || "agent");
    hb.hidden = false; hb.classList.add("ext-chip");
  }
  // A drifted session shows BOTH branches: the new one alone would lie about where --resume goes.
  else if (s.drift) {
    hb.textContent = `${s.branch || basename(s.workdir)} ⤳ ⑃ ${s.drift.branch}`;
    hb.title = `Launched in ${s.workdir}\nWriting to ${s.drift.dir}`;
    hb.hidden = false; hb.classList.add("drifted");
  }
  else if (s.branch) { hb.textContent = s.worktree ? "⑃ " + s.branch : s.branch; hb.hidden = false; } else hb.hidden = true;
  $("hTitle").textContent = hasSessionState(s) ? (s.title || "") : (s.kind === "task" ? s.run?.label ?? "" : "");
  $("hPath").textContent = tilde(s.drift?.dir ?? s.workdir);
}

// The active project: a session, an external, or the project a dashboard is about, so
// ＋ Session, ❯ Terminal, ▶ Run and ◷ History act on it rather than greying out.
export function activeProjectCtx(): { project: string; path: string } | null {
  // Checked first: the three mirror kinds share one pointer, and a dashboard's root is the repo key.
  const dm = dashMirror();
  if (dm) return { project: dm.name, path: dm.root };
  // An external's repo root, not its worktree cwd, so a launch from it groups under the repo.
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); if (e) { const root = e.repo_root || e.cwd; return { project: basename(root), path: root }; } }
  if (pastMirrorId()) { const d = dormants.find((x) => x.id === pastMirrorId()); if (d) return { project: d.project, path: d.colorKey }; }
  const s = activeId ? sessions.get(activeId) : null;
  return s ? { project: s.project, path: s.colorKey } : null;
}
// The actual cwd (a worktree's dir, not the grouping key), for opening a terminal there.
export function activeCwd(): string | null {
  const dm = dashMirror();
  if (dm) return dm.root;
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); return e ? e.cwd : null; }
  if (pastMirrorId()) { const d = dormants.find((x) => x.id === pastMirrorId()); return d ? d.workdir : null; }
  const s = activeId ? sessions.get(activeId) : null;
  return s ? s.workdir : null;
}
// A plain terminal at the active cwd: an in-app shell pane when embedded, else the external app.
export function openPlainTerminal() {
  const wd = activeCwd();
  if (!wd) { toast("No active session"); return; }
  if (termEngine !== "embedded") { invoke("open_terminal_here", { workdir: wd, engine: termEngine }).catch((e) => toast("terminal: " + e)); return; }
  // Inherit the stage's repo grouping so a shell opened in a worktree nests under its repo.
  const s = activeId ? sessions.get(activeId) : null;
  const e = extMirrorId() ? externals.find((x) => x.session_id === extMirrorId()) : undefined;
  const d = pastMirrorId() ? dormants.find((x) => x.id === pastMirrorId()) : undefined;
  const dm = dashMirror();
  const colorKey = s ? s.colorKey : e ? (e.repo_root || e.cwd) : d ? d.colorKey : wd;
  const worktree = s ? s.worktree : e ? (e.repo_root && e.cwd !== e.repo_root ? (e.branch || basename(e.cwd)) : null) : d ? d.worktree : null;
  const branch = s ? s.branch : (e?.branch || d?.branch || "");
  launchShell(s ? s.project : (d?.project ?? dm?.name ?? basename(colorKey)), wd, { colorKey, worktree, branch });
}

// Prefill a command into a shell pane, or open the external terminal with it on the clipboard.
export async function handToTerminal(project: string, workdir: string, cmd: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}) {
  if (termEngine === "embedded") {
    const id = await launchShell(project, workdir, opts);
    // The login shell needs a moment before its prompt will accept input.
    setTimeout(() => { void invoke("write_pty", { sessionId: id, data: cmd }).catch(() => {}); }, 600);
    toast("Prefilled in a shell. Press Enter to run");
    return;
  }
  try { await writeText(cmd); } catch { /* clipboard denied — the toast still names the command */ }
  invoke("open_terminal_here", { workdir, engine: termEngine })
    .then(() => toast("Terminal opened, command copied: " + cmd))
    .catch((e) => toast("terminal: " + e));
}

// Greyed with no active project: a live button whose only answer is an error toast reads as a failed click.
export function syncStageButtons() {
  const wd = activeCwd();
  const set = (id: string, enabled: string, disabled = "Start a session first; this runs in the active project") => {
    const b = $(id) as HTMLButtonElement;
    b.disabled = !wd;
    b.title = wd ? enabled : disabled;
  };
  set("btnRun", "Run a task or script from this project");
  set("btnTerm", "Open a plain (non-Claude) terminal at the project root");
  // ◷ History's disabled reason differs: the whole-machine view is one click away up top.
  set("btnHist", "Reopen a past session in this project, including ones you closed (⌘⇧H)",
      "No project selected. The ◷ button up top opens history for every project");
}

// fetch/pull/push. A refusal is not an error: the backend names the command that would
// work, and that is handed to a terminal.
export async function runGit(sessionId: string, op: string) {
  const s = sessions.get(sessionId);
  if (!s || gitBusy) return;
  setGitBusy(sessionId);
  // The palette can fire this at a background session, and a handoff switches the stage mid-run.
  const repaint = () => { if (activeId === s.id && !extMirrorId()) renderInspector(s); };
  repaint();
  try {
    const r = await invoke<GitActionResult>("git_action", { workdir: s.workdir, op });
    dlog(r.ok ? "info" : "warn", `git ${op} · ${s.project} · ${r.summary}`);
    if (r.ok) {
      toast(`${op}: ${r.summary}`);
    } else if (r.suggest) {
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
    // ahead/behind moved: force the dirty poll to re-read this folder now.
    dirtyStale.add(s.workdir);
    void refreshDirtyStates().then(() => refreshSessionStats(s));
    void refreshBranch(s).then((changed) => { if (changed) renderAll(); });
    repaint();
  }
}
