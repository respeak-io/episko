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
// The roster is a convenience layer, not a system of record: `/resume` inside Claude
// always lists every session for a folder, so nothing dropped here is ever lost.

import { invoke } from "@tauri-apps/api/core";
import { $, takeStage, toast } from "./dom";
import { dlog } from "./debug";
import { basename, esc, relTime, tilde } from "./format";
import { probeIcon } from "./icons";
import { renderFoot } from "./footer";
import { renderMini, renderSidebar } from "./sidebar";
import { extWorking } from "./sidebarview";
import { dormantBusy, orderedSessions } from "./grouping";
import { isAgent, type DiffStat, type ExtSession, type LiveSess, type Restorable, type Sess } from "./types";
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
  colorKey?: string; worktree?: string | null; branch?: string; resume?: string;
}) => void = () => {};
export function setMirrorLaunch(fn: typeof launch) { launch = fn; }
let renderAll: () => void = () => {};
export function setMirrorRenderAll(fn: typeof renderAll) { renderAll = fn; }

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
    setBackendLive(new Set(live.map((l) => l.id.toLowerCase())));
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
  const sig = (g?: DiffStat | null) => (g ? `${g.files}/${g.untracked}/${g.added}/${g.removed}` : "-");
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
  loadTranscriptInto(d.workdir, d.resumeId, true, () => pastMirrorId() === id);
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
    ? `<div class="ext-note warn">This session is running right now, in Episko or another terminal. Resuming it a second time would interleave both conversations into one transcript, so it can't be restored until the other one exits.</div>`
    : `<button class="ext-jump-btn" data-resume="${esc(d.id)}">⟲ Resume this session</button>
       <div class="ext-note">Claude picks the conversation back up where it left off. It may offer to compact the context first, which is normal for a long session.</div>`;
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
      <div class="ext-note">Removing only clears this row from Episko. The conversation stays on disk: <span class="mono">/resume</span> inside any Claude session in this folder always lists them all.</div>
    </div>`;
}
export function resumeDormant(id: string) {
  const d = dormants.find((x) => x.id === id);
  if (!d) return;
  if (dormantBusy(d)) { toast("That session is already running"); return; }
  closeExternalView();
  launch(d.project, d.workdir, { colorKey: d.colorKey, worktree: d.worktree, branch: d.branch, resume: d.resumeId });
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
// On boot: reconcile the roster against what Claude actually has on disk. An entry
// with no transcript can't be resumed — a session launched but never prompted never
// writes one — so it's dropped rather than shown as a row that would fail on click.
// Titles are refreshed from disk too: `ai-title` beats our in-memory OSC title and,
// unlike it, exists for sessions launched into an external terminal.
export async function loadDormants() {
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
