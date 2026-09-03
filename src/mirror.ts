// The sessions Episko shows but does not own: external (someone else's terminal) and
// dormant (a previous run), plus the roster behind the second. All of it hangs off the
// `mirror` stage pointer in ./state, which is mutually exclusive with `activeId`.

import { invoke } from "@tauri-apps/api/core";
import { $, takeStage, toast } from "./dom";
import { readList } from "./store";
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

let setActive: (id: string) => void = () => {};
export function setMirrorSetActive(fn: typeof setActive) { setActive = fn; }
let launch: (project: string, workdir: string, opts: {
  colorKey?: string; worktree?: string | null; branch?: string; resume?: string; resumeProvider?: string;
}) => void = () => {};
export function setMirrorLaunch(fn: typeof launch) { launch = fn; }
let renderAll: () => void = () => {};
export function setMirrorRenderAll(fn: typeof renderAll) { renderAll = fn; }

// A roster row: what was open when Episko last closed; shell panes have nothing to resume.
// Exported for shelving (./panes), which must build the same row rather than a second
// kind (docs/sessions.md).
export function rosterEntry(s: Sess): Restorable {
  return {
    id: s.id, resumeId: s.resumeId || s.id, project: s.project, workdir: s.workdir,
    colorKey: s.colorKey, worktree: s.worktree, branch: s.branch,
    title: s.title, lastActivity: s.lastActivity, provider: s.provider || "claude",
  };
}
// The roster must not be written before this run has read it: `sessions` and `dormants`
// are empty until adoptOrphans and loadDormants finish, and a save before then (a
// reload's beforeunload) writes [] over the identities every live pane is rebuilt from.
let rosterReady = false;
function saveRoster() {
  if (!rosterReady) return;
  const open = [...sessions.values()].filter((s) => hasAgentCapability(s, "resume") && s.workdir).map(rosterEntry);
  // Undismissed dormant rows stay, so a partial restore does not quietly discard the rest.
  const live = new Set(open.map((r) => r.id));
  const keep = dormants.filter((d) => !live.has(d.id));
  localStorage.setItem("cc-restore", JSON.stringify([...open, ...keep].slice(0, 60)));
}
// Debounced with a ceiling: a busy session's telemetry would otherwise reset a trailing
// debounce forever and never write.
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
    // The backend's PTY roster rides the same poll: it is how a reload orphan is seen (#47).
    const [list, live] = await Promise.all([
      invoke<ExtSession[]>("list_external_sessions", { exclude: [...sessions.keys()] }),
      invoke<LiveSess[]>("live_sessions"),
    ]);
    setExternals(list);
    setBackendLive(new Set(live.map((l) => providerSessionKey(l.provider, l.id))));
    // Keyed by the repo_root the sidebar groups by, or an ext-only project never gets its logo.
    for (const e of externals) probeIcon(e.repo_root || e.cwd);
    if (extMirrorId()) {
      // The id rotates on /clear, /compact and /resume; re-bind by the stable pid rather
      // than let the selection jump to an unrelated session.
      const pid = extMirrorPid();
      const e = externals.find((x) => x.session_id === extMirrorId())
        ?? (pid != null ? externals.find((x) => x.pid === pid) : undefined);
      if (e) {
        setMirror({ kind: "ext", id: e.session_id, pid: e.pid });
        renderExtHeader(e); renderExtInspector(e);
      } else {
        // Truly gone: fall back to an Episko session, or the empty card.
        closeExternalView();
        const next = orderedSessions()[0];
        if (next) setActive(next.id);
      }
    }
    renderSidebar(); renderMini();
  } catch { /* backend not ready yet */ }
}
// The backstop sweep; agent edits arrive through markWorkdirStale on the very next tick.
const DIRTY_SWEEP_MS = 15_000;
let dirtySweptAt = 0;
// Uncommitted state for every folder in play, so the dot and the external diff card hold
// for all projects at once. Only folders the hook stream marked stale are re-read between
// sweeps, so an idle fleet costs nothing.
export async function refreshDirtyStates(force = false) {
  const folders = new Set<string>();
  // An agent pane counts, a shell does not: each folder here costs a git_diffstat per sweep.
  for (const s of sessions.values()) if (isAgent(s) && s.workdir) folders.add(s.workdir);
  for (const e of externals) if (e.cwd) folders.add(e.cwd);
  for (const f of [...dirtyByFolder.keys()]) if (!folders.has(f)) dirtyByFolder.delete(f);
  const sweep = force || Date.now() - dirtySweptAt >= DIRTY_SWEEP_MS;
  if (sweep) dirtySweptAt = Date.now();
  // A folder never read is read now, or a new session shows no dot until the next sweep.
  const targets = [...folders].filter((f) => sweep || dirtyStale.has(f) || !dirtyByFolder.has(f));
  dirtyStale.clear();
  if (!targets.length) return;
  // Every field the card prints, `dirty` included, or a change only it sees never repaints.
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
  void refreshDirtyStates(true); // forced: this folder is probably cached and would be skipped
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
  // The dashboard rides the same pointer, so it goes with it. `none` rather than
  // `session`: every caller either activates a session next or wants the empty card.
  takeStage("none");
}
// ---------- dormant (restorable) sessions ----------
// Mirrors the transcript read-only, so you can see which conversation it is before resuming.
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
  ($("btnShelve") as HTMLButtonElement).hidden = true;
  $("extViewTxt").textContent = "Read-only mirror · shelved, not running · ⟲ Resume to carry on";
  $("hProj").textContent = d.project;
  const hb = $("hBranch"); hb.textContent = "shelved"; hb.hidden = false; hb.classList.add("ext-chip");
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
      <div class="ext-hl">· ${esc(d.provider || "claude")} · shelved</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(d.project)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="mono ell">${esc(tilde(d.workdir))}</span></div>
      ${d.branch ? `<div class="ext-meta"><span class="label">Branch</span><span>${esc(d.branch)}</span></div>` : ""}
      <div class="ext-meta"><span class="label">Last active</span><span>${esc(relTime(d.lastActivity))}</span></div>
      <div class="ext-meta"><span class="label">Session</span><span class="mono">${esc(d.resumeId.slice(0, 8))}</span></div>
      ${action}
      <button class="ext-forget-btn" data-forget="${esc(d.id)}">Take off the shelf</button>
      <div class="ext-note">This only clears the row. The provider's conversation stays in its own history, and ◷ History can still reopen it.</div>
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
    // closeExternalView leaves the empty card; only the fall-back case needs saying.
    closeExternalView();
    const next = orderedSessions()[0];
    if (next) setActive(next.id);
  }
  flushRoster();
  renderAll();
}
// Each provider reconciles roster rows against its durable history. Titles and "last
// active" are refreshed from disk: the latter from the newest record, not the file's
// mtime, which a shutdown stamps on every open session at once.
export async function loadDormants() {
  try {
    let roster: Restorable[] = [];
    roster = readList<Restorable>("cc-restore");
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
  } finally {
    // In a finally: this flag is the single gate on persistence, and never saving again
    // is worse than saving too early. The flush rebuilds a roster an earlier boot emptied.
    rosterReady = true;
    flushRoster();
    renderAll();
  }
}
export function jumpExternal(pid: number) {
  invoke("focus_external_session", { pid }).catch((e) => toast("jump failed: " + e));
}
async function loadTranscript(e: ExtSession, initial: boolean) {
  await loadTranscriptInto(e.cwd, e.session_id, initial, () => extMirrorId() === e.session_id);
}
// stillCurrent is re-checked after the await: a late reply must not paint over another mirror.
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
  ($("btnShelve") as HTMLButtonElement).hidden = true;
  $("extViewTxt").textContent = "Read-only mirror · this session runs in another terminal";
  $("hProj").textContent = basename(e.cwd);
  const hb = $("hBranch"); hb.textContent = "external"; hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = e.name || "";
  $("hPath").textContent = tilde(e.cwd);
}
// The working-set peek minus the fetch/pull/push row: we do not drive this checkout.
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
