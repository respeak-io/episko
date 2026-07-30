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
import { $, toast } from "./dom";
import { dlog } from "./debug";
import { basename, esc, tilde } from "./format";
import {
  isAgent, type DiffStat, type GitActionResult, type Runnable, type Sess,
} from "./types";
import { claudeInput, cleanTitle, fitSession, loadWebgl, macShellKeys, MONO, winClaudePaste } from "./terminal";
import { gitBusy, setGitBusy } from "./inspectorview";
import { renderInspector } from "./inspector";
import { renderMini, renderSidebar } from "./sidebar";
import { renderFoot } from "./footer";
import { closeExternalView, flushRoster, queueRosterSave } from "./mirror";
import { openWt } from "./worktree";
import { nextAfterClose } from "./grouping";
import { probeIcon } from "./icons";
import { execCmd, exitWaiters, taskPrefs, type TaskLaunchOpts } from "./tasks";
import {
  accentFor, activeId, dirtyByFolder, dormants, engineDef, externals, extMirrorId,
  pastMirrorId, sessions, setActiveId, setDormants, termEngine, termFontSize,
} from "./state";

// The one thing a pane's lifecycle cannot own: `renderAll()` repaints every surface
// from scratch, and it is the file that orchestrates them that owns it.
let renderAll: () => void = () => {};
export function setPanesRenderAll(fn: typeof renderAll) { renderAll = fn; }

// ---------- launch ----------
export async function launch(project: string, workdir: string, opts: { colorKey?: string; worktree?: string | null; branch?: string; resume?: string } = {}) {
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
    term.onData(claudeInput(id)); // ^C interrupts; it never exits the session
    winClaudePaste(id, term, pane);
  }

  const s: Sess = {
    id, project, accent, workdir, colorKey, resumeId: opts.resume ?? id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "",
    phase: "idle", phaseSince: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0, apiErr: null,
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
export function requestLaunch(project: string, path: string) {
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
  loadWebgl(term);
  term.open(pane);
  term.onData((d) => invoke("write_pty", { sessionId: id, data: d }));
  term.attachCustomKeyEventHandler(macShellKeys(id)); // Terminal.app-style ⌥/⌘ nav for the shell
  const s: Sess = {
    // resumeId is inert for a shell — it has no transcript and saveRoster skips it.
    id, project, accent: accentFor(colorKey), workdir, colorKey, resumeId: id,
    branch: opts.branch ?? "", worktree: opts.worktree ?? null, title: "shell",
    phase: "idle", phaseSince: Date.now(), lastActivity: Date.now(), attention: null, pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0, apiErr: null,
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
    pendingCmd: "", pendingPermId: null, pendRisk: null, subagents: 0, apiErr: null,
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

export function closeSession(id: string) {
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


export function setActive(id: string) {
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
export async function refreshSessionStats(s: Sess) {
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
export async function refreshBranches() {
  const changed = await Promise.all([...sessions.values()].map(refreshBranch));
  if (changed.some(Boolean)) {
    renderSidebar();
    const a = activeId ? sessions.get(activeId) ?? null : null;
    if (a) renderHeader(a);
  }
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
  const hb = $("hBranch"); hb.classList.remove("ext-chip");
  if (!s) { $("hProj").textContent = "no session"; hb.hidden = true; $("hTitle").textContent = ""; $("hPath").textContent = ""; return; }
  $("hProj").textContent = s.project;
  if (s.kind !== "claude") { hb.textContent = s.kind === "shell" ? "shell" : "task"; hb.hidden = false; hb.classList.add("ext-chip"); }
  else if (s.branch) { hb.textContent = s.worktree ? "⑃ " + s.branch : s.branch; hb.hidden = false; } else hb.hidden = true;
  $("hTitle").textContent = s.kind === "claude" ? (s.title || "") : (s.kind === "task" ? s.run?.label ?? "" : "");
  $("hPath").textContent = tilde(s.workdir);
}

// The active project context is either an Episko session or an external one.
export function activeProjectCtx(): { project: string; path: string } | null {
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
  const colorKey = s ? s.colorKey : e ? (e.repo_root || e.cwd) : d ? d.colorKey : wd;
  const worktree = s ? s.worktree : e ? (e.repo_root && e.cwd !== e.repo_root ? (e.branch || basename(e.cwd)) : null) : d ? d.worktree : null;
  const branch = s ? s.branch : (e?.branch || d?.branch || "");
  launchShell(s ? s.project : (d?.project ?? basename(colorKey)), wd, { colorKey, worktree, branch });
}

// terminal and put the command on the clipboard — honest about the extra paste.
export async function handToTerminal(project: string, workdir: string, cmd: string, opts: { colorKey?: string; worktree?: string | null; branch?: string } = {}) {
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

// ▶ Run and ❯ Terminal both act on the active project's directory, so with no
// session, shell or mirrored external there is nothing for them to act on. Greying
// them says so up front; a live button whose only response is an error toast reads
// as if the click failed. The guards in openRunPicker/openPlainTerminal stay, since
// ⌘⇧R and ⌘T bypass the button entirely.
export function syncStageButtons() {
  const wd = activeCwd();
  const set = (id: string, enabled: string, disabled = "Start a session first — this runs in the active project") => {
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
  set("btnHist", "Reopen a past session in this project — including ones you closed (⌘⇧H)",
      "No project selected — the ◷ button up top opens history for every project");
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
    void refreshSessionStats(s);   // ahead/behind moved — re-read it
    void refreshBranch(s).then((changed) => { if (changed) renderAll(); });
    repaint();
  }
}
