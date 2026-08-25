// The two kinds of session Episko can show but does not own: one running in someone
// else's terminal (external), and one from a previous run (dormant/restorable). Plus
// the roster that produces the second, and the folder-dirty poll both depend on.
//
// They are one module because they share one thing — the `mirror` stage pointer in
// ./state. `activeId` and `mirror` are mutually exclusive, and everything here either
// sets that pointer, repaints what it points at, or reconciles it when the thing it
// points at goes away. That is also why the four read-only `render*` functions live
// here rather than in ./inspector: each is welded to the open/load machinery beside
// it, and none of them is ever reached with a `Sess`.
//
// The roster is a convenience layer, not a system of record: provider history owns
// the durable conversation, while this remembers which ones were on screen.

import { invoke } from "@tauri-apps/api/core";
import { $, takeStage, toast } from "./dom";
import { dlog } from "./debug";
import { basename, esc, relTime, tilde } from "./format";
import { probeIcon } from "./icons";
import { renderFoot } from "./footer";
import { wpeekHtml } from "./inspectorview";
import { renderMini, renderSidebar } from "./sidebar";
import { extWorking } from "./sidebarview";
import {
  providerAdapter, readProviderHistory, reconcileProviderRestorables,
} from "./providers";
import { dormantBusy, orderedSessions } from "./grouping";
import {
  hasAgentCapability, isAgent, providerSessionKey,
  type DiffStat, type ExtSession, type LiveSess, type Restorable, type Sess,
} from "./types";
import {
  accentFor, dirtyByFolder, dirtyStale, dormants, externals, extMirrorId, extMirrorPid,
  isDirty, mirror, pastMirrorId, sessions, setActiveId, setBackendLive, setDormants,
  setExternals, setMirror,
} from "./state";

// Three callees this module does not own: putting an Episko pane on the stage when a
// mirror goes away, starting one to resume a dormant session, and the app-wide
// repaint. Per-callee setters, per PLAN's seam rule 2.
let setActive: (id: string) => void = () => {};
export function setMirrorSetActive(fn: typeof setActive) { setActive = fn; }
let launch: (project: string, workdir: string, opts: {
  colorKey?: string; worktree?: string | null; branch?: string; resume?: string; resumeProvider?: string;
}) => void = () => {};
export function setMirrorLaunch(fn: typeof launch) { launch = fn; }
let renderAll: () => void = () => {};
export function setMirrorRenderAll(fn: typeof renderAll) { renderAll = fn; }

// The roster is "what was open when Episko last closed". Closing a session removes
// it — an explicit close means done, so only survivors come back. Shell panes are
// excluded: a login shell has no provider conversation to resume.
function rosterEntry(s: Sess): Restorable {
  return {
    id: s.id, resumeId: s.resumeId || s.id, project: s.project, workdir: s.workdir,
    colorKey: s.colorKey, worktree: s.worktree, branch: s.branch,
    title: s.title, lastActivity: s.lastActivity, provider: s.provider || "claude",
  };
}
function saveRoster() {
  const open = [...sessions.values()].filter((s) => hasAgentCapability(s, "resume") && s.workdir).map(rosterEntry);
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
export function queueRosterSave() {
  if (Date.now() - rosterSavedAt > ROSTER_MAX_STALE) { flushRoster(); return; }
  clearTimeout(rosterTimer);
  rosterTimer = window.setTimeout(flushRoster, 1500);
}
export function flushRoster() { clearTimeout(rosterTimer); rosterSavedAt = Date.now(); saveRoster(); }

let extTranscriptTimer: number | undefined;

// ---------- external sessions: discovery, jump, read-only transcript ----------
export async function refreshExternals() {
  try {
    // The backend's own PTY roster rides the same poll: it is what lets a busy
    // check see a reload orphan — a PTY the backend holds while the frontend map
    // has no pane for it and `list_external_sessions` excludes its pid (#47).
    const [list, live] = await Promise.all([
      invoke<ExtSession[]>("list_external_sessions", { exclude: [...sessions.keys()] }),
      invoke<LiveSess[]>("live_sessions"),
    ]);
    setExternals(list);
    setBackendLive(new Set(live.map((l) => providerSessionKey(l.provider, l.id))));
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
        // Truly gone — fall back to an Episko session, or to the empty card, which
        // `closeExternalView` has already dropped the stage to.
        closeExternalView();
        const next = orderedSessions()[0];
        if (next) setActive(next.id);
      }
    }
    renderSidebar(); renderMini();
  } catch { /* backend not ready yet */ }
}
// The backstop sweep. Agent-driven edits arrive via `markWorkdirStale` and are picked
// up on the very next tick; this interval exists only for the changes no hook can see —
// you editing in your own editor, a build writing artefacts, an external session.
const DIRTY_SWEEP_MS = 15_000;
let dirtySweptAt = 0;
// Uncommitted git state for every folder in play (session workdirs + external cwds), so
// the sidebar dot and the external diff card are accurate for all projects at once —
// not just whichever session is active.
//
// This used to re-read every folder every 5s, which on an idle fleet was pure waste: a
// `git status` walk per open worktree, forever, to learn nothing. Now the hook stream
// says which folders actually moved (a Write/Edit/Bash names its session, and the
// session names its workdir), and everything else rides the slower sweep. An idle fleet
// costs nothing; a busy one is *more* responsive than before, because a folder is
// re-read on the tick after the edit rather than up to 5s later.
export async function refreshDirtyStates(force = false) {
  const folders = new Set<string>();
  // An agent pane counts as much as a claude one: the dot means "this checkout has
  // uncommitted work", and `codex` writing files is exactly that. A *shell* still does
  // not — one is as often opened to look at a folder as to change it, and each folder
  // in this set costs a `git_diffstat` every sweep.
  for (const s of sessions.values()) if (isAgent(s) && s.workdir) folders.add(s.workdir);
  for (const e of externals) if (e.cwd) folders.add(e.cwd);
  for (const f of [...dirtyByFolder.keys()]) if (!folders.has(f)) dirtyByFolder.delete(f); // prune gone folders
  const sweep = force || Date.now() - dirtySweptAt >= DIRTY_SWEEP_MS;
  if (sweep) dirtySweptAt = Date.now();
  // A folder never read is always read now — otherwise a newly launched session would
  // show no dot until the first sweep happened to come round.
  const targets = [...folders].filter((f) => sweep || dirtyStale.has(f) || !dirtyByFolder.has(f));
  dirtyStale.clear();
  if (!targets.length) return;
  // Every field the card *prints* belongs here, `dirty` included: it is the file count
  // the working-set row shows, so a change only it sees still has to reach the paint.
  const sig = (g?: DiffStat | null) => (g ? `${g.files}/${g.untracked}/${g.dirty}/${g.added}/${g.removed}` : "-");
  let changed = false;
  await Promise.all(targets.map(async (f) => {
    const g = await invoke<DiffStat | null>("git_diffstat", { workdir: f }).catch(() => null);
    if (sig(dirtyByFolder.get(f)) !== sig(g)) changed = true;
    dirtyByFolder.set(f, g ?? null);
  }));
  if (!changed) return;
  renderSidebar();
  if (extMirrorId()) { const e = externals.find((x) => x.session_id === extMirrorId()); if (e) renderExtInspector(e); }
}
export function openExternal(sid: string) {
  const e = externals.find((x) => x.session_id === sid);
  if (!e) return;
  setMirror({ kind: "ext", id: sid, pid: e.pid });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  takeStage("ext");
  document.documentElement.style.setProperty("--accent", accentFor(e.cwd));
  renderExtHeader(e); renderExtInspector(e); renderSidebar(); renderMini(); renderFoot();
  $("extBody").innerHTML = `<div class="ext-empty">Loading transcript…</div>`;
  // Fill the working-set card promptly, not on the next poll tick. Forced, because
  // this folder is very likely already cached and would otherwise be skipped — the
  // point is a fresh read for the card the user just opened.
  void refreshDirtyStates(true);
  loadTranscript(e, true);
  clearInterval(extTranscriptTimer);
  extTranscriptTimer = window.setInterval(() => {
    const cur = externals.find((x) => x.session_id === extMirrorId());
    if (cur) loadTranscript(cur, false);
  }, 2500);
}
export function closeExternalView() {
  if (mirror == null) return;
  setMirror(null);   // clears the ext pid with it — one pointer, one lifetime
  clearInterval(extTranscriptTimer);
  // The dashboard rides the same pointer, so it has the same lifetime: whatever took
  // the stage just replaced it. `takeStage` is what keeps this module free of a
  // ./dashboard dependency — it lives in ./dom, which everything may import.
  //
  // `none` rather than `session`: every caller either activates a session immediately
  // after (which re-takes the stage) or wants the empty card, and this one cannot tell
  // which without importing state it has no other use for.
  takeStage("none");
}
// ---------- dormant (restorable) sessions ----------
// Clicking a dormant row mirrors its transcript read-only — the same pane an
// external session uses — so the user can confirm *which* conversation this is
// before deciding to bring it back.
export function openDormant(id: string) {
  const d = dormants.find((x) => x.id === id);
  if (!d) return;
  setMirror({ kind: "past", id });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  takeStage("ext");
  clearInterval(extTranscriptTimer); // a finished transcript doesn't grow — no polling
  document.documentElement.style.setProperty("--accent", accentFor(d.colorKey));
  renderPastHeader(d); renderPastInspector(d); renderSidebar(); renderMini(); renderFoot();
  $("extBody").innerHTML = `<div class="ext-empty">Loading transcript…</div>`;
  void loadProviderTranscriptInto(d.provider, d.workdir, d.resumeId, () => pastMirrorId() === id);
}
export function renderPastHeader(d: Restorable) {
  ($("btnClose") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = d.project;
  const hb = $("hBranch"); hb.textContent = "restorable"; hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = d.title || "";
  $("hPath").textContent = tilde(d.workdir);
}
export function renderPastInspector(d: Restorable) {
  const busy = dormantBusy(d);
  const pill = $("iPill"); pill.className = "pill idle";
  $("iPillTxt").textContent = "not running";
  const action = busy
    ? `<div class="ext-note warn">This session is running right now. Resuming the same provider thread twice can interleave or corrupt its state, so it can't be restored until the other one exits.</div>`
    : `<button class="ext-jump-btn" data-resume="${esc(d.id)}">⟲ Resume this session</button>
       <div class="ext-note">${esc(d.provider || "claude")} picks the conversation back up where it left off. A long session may compact its context first.</div>`;
  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">· ${esc(d.provider || "claude")} · from your last run</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(d.project)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="mono ell">${esc(tilde(d.workdir))}</span></div>
      ${d.branch ? `<div class="ext-meta"><span class="label">Branch</span><span>${esc(d.branch)}</span></div>` : ""}
      <div class="ext-meta"><span class="label">Last active</span><span>${esc(relTime(d.lastActivity))}</span></div>
      <div class="ext-meta"><span class="label">Session</span><span class="mono">${esc(d.resumeId.slice(0, 8))}</span></div>
      ${action}
      <button class="ext-forget-btn" data-forget="${esc(d.id)}">Remove from list</button>
      <div class="ext-note">Removing only clears this row from Episko. The provider's conversation remains in its own history.</div>
    </div>`;
}
export function resumeDormant(id: string) {
  const d = dormants.find((x) => x.id === id);
  if (!d) return;
  if (dormantBusy(d)) { toast("That session is already running"); return; }
  closeExternalView();
  launch(d.project, d.workdir, { colorKey: d.colorKey, worktree: d.worktree, branch: d.branch, resume: d.resumeId, resumeProvider: d.provider || "claude" });
}
export function forgetDormant(id: string) {
  setDormants(dormants.filter((x) => x.id !== id));
  if (pastMirrorId() === id) {
    // The empty card is where `closeExternalView` leaves the stage, so only the
    // "there is a session to fall back to" case needs saying.
    closeExternalView();
    const next = orderedSessions()[0];
    if (next) setActive(next.id);
  }
  flushRoster();
  renderAll();
}
// On boot, let each provider reconcile roster entries against its durable history.
// Titles are refreshed from disk too: `ai-title` beats our in-memory OSC title and,
// unlike it, exists for sessions launched into an external terminal. So is "last
// active", and that one is the transcript's newest *record*, not its mtime — a
// machine that shuts down with six sessions open touches all six files at once, and
// believing the file stamped every one of those rows with the reboot.
export async function loadDormants() {
  let roster: Restorable[] = [];
  try { roster = JSON.parse(localStorage.getItem("cc-restore") || "[]") || []; } catch { roster = []; }
  if (!Array.isArray(roster) || !roster.length) return;
  const live = new Set([...sessions.keys()]);
  const candidates: Restorable[] = [];
  for (const r of roster) {
    if (!r || typeof r.id !== "string" || typeof r.workdir !== "string" || !r.workdir) continue;
    if (live.has(r.id)) continue;
    if (!r.resumeId) r.resumeId = r.id;
    if (!r.provider) r.provider = "claude"; // roster written before provider support
    candidates.push(r);
  }
  const found = await reconcileProviderRestorables(candidates);
  found.sort((a, b) => b.lastActivity - a.lastActivity);
  setDormants(found);
  if (dormants.length) dlog("info", `${dormants.length} restorable session${dormants.length === 1 ? "" : "s"} from a previous run`);
  flushRoster();
  renderAll();
}
export function jumpExternal(pid: number) {
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

async function loadProviderTranscriptInto(
  provider: string, cwd: string, sessionId: string, stillCurrent: () => boolean,
) {
  const label = providerAdapter(provider)?.label ?? provider;
  try {
    const msgs = await readProviderHistory(provider, sessionId, cwd, 80);
    if (!stillCurrent()) return;
    renderTranscript(msgs, true, label);
  } catch (err) {
    if (stillCurrent()) $("extBody").innerHTML = `<div class="ext-empty">Could not read this ${esc(label)} conversation.<br><span class="mono">${esc(String(err))}</span></div>`;
  }
}
function renderTranscript(msgs: { role: string; text: string }[], initial: boolean, agent = "Claude") {
  const body = $("extBody");
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  body.innerHTML = msgs.length
    ? msgs.map((m) => {
        const user = m.role === "user";
        return `<div class="tvmsg ${m.role}"><span class="tvgutter" title="${user ? "You" : agent}">${user ? "❯" : "⏺"}</span><div class="tvtext">${esc(m.text)}</div></div>`;
      }).join("")
    : `<div class="ext-empty">No messages in this session yet.</div>`;
  if (initial || nearBottom) body.scrollTop = body.scrollHeight;
}
export function renderExtHeader(e: ExtSession) {
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
  return `<div class="wset ext-wset">
    <div class="lab" style="margin-bottom:2px">Working set · in this folder</div>
    ${wpeekHtml(e.cwd, basename(e.cwd), g)}</div>`;
}
export function renderExtInspector(e: ExtSession) {
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
      <div class="ext-note">Episko can't drive this session, because it was launched in another terminal. The panel on the left is a live read-only mirror of its transcript.</div>
    </div>${peek}`;
}
