// The debug console (🐞): an in-app event log plus a live state snapshot. `dlog` tees into
// the backend's rolling episko.log, which survives a crash; the JSON snapshot is state-of-now.
// Owns its DOM region, so it exports render functions rather than markup (docs/architecture.md).

import { invoke } from "@tauri-apps/api/core";
import { $ } from "./dom";
import { esc } from "./format";
import { rl } from "./rl";
import {
  activeId, bgLogHealth, dirtyByFolder, externals, extMirrorId, folderDirty, isDirty,
  pastMirrorId, revivePrefs, sessions, telemetryUp, termEngine, vitalsPrefs,
} from "./state";
import { liveCount, orphanAgents, type Sess } from "./types";
import { reviveDeadline } from "./revive";
import {
  driftVerdict, leakSuspects, pushVitals, vitalsDrift, vitalsLine,
  type Vitals, type VitalsDrift,
} from "./perf";

export type DbgLvl = "info" | "warn" | "error";
let appVersion = "";
export function setAppVersion(v: string) { appVersion = v; }
export const dbgLog: { t: number; lvl: DbgLvl; msg: string }[] = [];
let dbgOpen = false;
// `renders` counts actual paints; renders ≈ rx under load means the per-frame batching broke.
// `outages`: hook-server re-binds this run, which is what tells an idle pane from an unreachable app.
export const telem = { rx: 0, routed: 0, dropped: 0, renders: 0, outages: 0 };
export function dlog(lvl: DbgLvl, msg: string) {
  dbgLog.push({ t: Date.now(), lvl, msg });
  if (dbgLog.length > 400) dbgLog.splice(0, dbgLog.length - 400);
  renderDbgBadge();
  if (dbgOpen) renderDbgPanel();
  // Tee into the backend's rolling log (log_frontend); fire-and-forget, the ring is the panel's truth.
  invoke("log_frontend", { level: lvl, msg }).catch(() => {});
}

// ---------- performance vitals ----------
// The in-memory half of ./perf's series. The tee is `log_frontend`, never `dlog`, which would flood the ring.
export const vitalsRing: Vitals[] = [];
let lastSample = 0;

function sampleVitals(): Vitals {
  const list = [...sessions.values()];
  const sum = (f: (s: Sess) => number) => list.reduce((n, s) => n + f(s), 0);
  // WebKit has no `performance.memory`; a missing heap figure is reported as 0, never faked.
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    t: Date.now(),
    upMs: Math.round(performance.now()),
    dom: document.getElementsByTagName("*").length,
    heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : 0,
    canvases: document.getElementsByTagName("canvas").length,
    files: sum((s) => s.files.length),
    servers: sum((s) => s.servers.length),
    termLines: sum((s) => s.term?.buffer.normal.length ?? 0),
    panes: list.length,
    gl: list.filter((s) => s.gl).length,
    acts: sum((s) => s.activity.length),
    hist: sum((s) => s.ctxHist.length + s.costHist.length),
    paints: telem.renders,
    events: telem.rx,
  };
}

// Called on a fixed short tick; the cadence is checked here rather than by recreating a
// setInterval from the settings handler, since silently stopped recording looks like no leak.
export function tickVitals(prefsEnabled: boolean, everyMs: number) {
  if (!prefsEnabled) { lastSample = 0; return; }
  const now = Date.now();
  // The first sample lands the moment it is switched on.
  if (lastSample && now - lastSample < everyMs) return;
  lastSample = now;
  const v = sampleVitals();
  pushVitals(vitalsRing, v);
  invoke("log_frontend", { level: "info", msg: vitalsLine(v) }).catch(() => {});
}

export function currentDrift(): VitalsDrift | null { return vitalsDrift(vitalsRing); }

function dbgIssues() { return dbgLog.reduce((n, e) => n + (e.lvl === "info" ? 0 : 1), 0); }
export function renderDbgBadge() {
  const n = dbgIssues();
  const b = $("dbgBadge");
  b.textContent = String(n);
  (b as HTMLElement).hidden = n === 0;
  $("dbgBtn").classList.toggle("has-issues", n > 0);
}
// Inherited agents are invisible in done/started and show only as a total that won't close.
function dbgFanout(s: Sess): string | null {
  if (!s.fanout) return null;
  const orph = orphanAgents(s);
  const tail = orph.length ? `, ${orph.length} inherited (${orph.map((a) => a.type || "?").join("/")})` : "";
  return `${s.fanout.name || "unnamed"} ${s.fanout.done}/${s.fanout.started} done, ${liveCount(s)} up${tail}`;
}
export function dbgSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    version: appVersion, activeId, activeExtId: extMirrorId(), activePastId: pastMirrorId(), termEngine, rateLimits: rl,
    telemetry: { ...telem, up: telemetryUp }, // an idle fleet means two different things depending on `up`
    // Where the backend last found background-shell logs: rows stuck at "starting…" may be a wrong path.
    bgRoot: bgLogHealth,
    sessions: [...sessions.values()].map((s) => ({
      id: s.id, project: s.project, phase: s.phase, attention: s.attention, model: s.model,
      ctxPct: s.ctxPct, cost: s.cost, durMs: s.durMs, subagents: liveCount(s),
      lastEvent: s.lastEvent, kind: s.kind, external: s.external, branch: s.branch, workdir: s.workdir,
      fanout: dbgFanout(s),
      // Where writes actually land when that isn't `workdir`; the disagreement is what needs explaining.
      drift: s.drift ? `${s.drift.branch} @ ${s.drift.dir}` : null,
      // Read after the fact: the log has each revive attempt, this has the standing state.
      revive: s.revive
        ? `${s.revive.attempts} tried, ${s.revive.gaveUp ? "gave up" : `next at ${new Date(s.revive.dueAt).toISOString()}`}`
        : null,
    })),
    externals: externals.map((e) => ({ pid: e.pid, session_id: e.session_id, cwd: e.cwd, status: e.status, dirty: folderDirty(e.cwd) })),
    dirtyFolders: [...dirtyByFolder.entries()].map(([f, g]) => ({ folder: f, added: g?.added ?? 0, removed: g?.removed ?? 0, files: g?.files ?? 0, untracked: g?.untracked ?? 0, dirty: isDirty(g) })),
    // Top-level, not per-session: "will it act, and when" is one question about the app.
    nextRevive: (() => { const at = reviveDeadline(sessions.values(), revivePrefs, Date.now()); return at ? new Date(at).toISOString() : null; })(),
    // The standing answer only; the counters are in episko.log. No live figure here, or
    // flushDebug's unchanged-body guard would never fire.
    vitals: (() => {
      const d = currentDrift();
      return {
        recording: vitalsPrefs.enabled, everyMs: vitalsPrefs.everyMs, samples: vitalsRing.length,
        verdict: driftVerdict(vitalsPrefs, d),
        growing: leakSuspects(d).map((r) => `${r.id} +${Math.round(r.perHour)}/h (${r.first} → ${r.last})`),
      };
    })(),
    log: dbgLog.slice(-250),
  };
}
function dbgTime(t: number) { const d = new Date(t); return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0"); }
export function renderDbgPanel() {
  const snap = dbgSnapshot();
  const srows = snap.sessions.length
    ? snap.sessions.map((s) => `<tr><td>${esc(s.project)}</td><td class="mono">${s.id.slice(0, 8)}</td><td class="ph-${s.phase}">${s.phase}${s.attention ? " ⚠" : ""}</td><td>${s.ctxPct != null ? Math.round(s.ctxPct) + "%" : "–"}</td><td>${s.cost != null ? "$" + s.cost.toFixed(2) : "–"}</td><td class="mono">${esc(s.lastEvent || "–")}</td></tr>`).join("")
    : `<tr><td colspan="6" class="dbg-dim">no Episko sessions</td></tr>`;
  const logRows = dbgLog.slice().reverse().slice(0, 250)
    .map((e) => `<div class="dl ${e.lvl}"><span class="dl-t">${dbgTime(e.t)}</span><span class="dl-l">${e.lvl}</span><span class="dl-m">${esc(e.msg)}</span></div>`).join("")
    || `<div class="dbg-dim" style="padding:8px">no events yet</div>`;
  $("dbgBody").innerHTML =
    `<div class="dbg-stats">telemetry: rx ${telem.rx} · routed ${telem.routed} · <span class="${telem.dropped ? "warn" : ""}">dropped ${telem.dropped}</span> · paints ${telem.renders}${telemetryUp ? "" : ` · <span class="warn">SERVER DOWN</span>`}${telem.outages ? ` · outages ${telem.outages}` : ""} · 5h ${rl.h5 != null ? Math.round(rl.h5) + "%" : "–"}</div>
     <table class="dbg-tbl"><thead><tr><th>project</th><th>id</th><th>phase</th><th>ctx</th><th>cost</th><th>last event</th></tr></thead><tbody>${srows}</tbody></table>
     <div class="dbg-log">${logRows}</div>`;
}
export function toggleDbg(open?: boolean) {
  dbgOpen = open ?? !dbgOpen;
  ($("dbgPanel") as HTMLElement).hidden = !dbgOpen;
  if (dbgOpen) { renderDbgPanel(); flushDebug(); }
}
// The 4s flush is unconditional and never cleared: the snapshot exists to be read with the
// panel closed. Compact JSON (every consumer is a program), and an unchanged body is skipped,
// except once per HEARTBEAT_MS so a frozen app can still be told from a live one.
const HEARTBEAT_MS = 60_000;
let lastBody = "";
let lastWrite = 0;
export async function flushDebug() {
  const snap = dbgSnapshot();
  const { generatedAt: _ts, ...rest } = snap; // a fresh stamp would make every body differ
  const body = JSON.stringify(rest);
  if (body === lastBody && Date.now() - lastWrite < HEARTBEAT_MS) return;
  try {
    const path = await invoke<string>("write_debug_file", { contents: JSON.stringify(snap) });
    // Stamped only on the way out: set before the await, a write that failed would still
    // count as this body's, and the next attempt would be a heartbeat away.
    lastBody = body;
    lastWrite = Date.now();
    $("dbgPath").textContent = path;
  } catch { /* backend not ready */ }
}
