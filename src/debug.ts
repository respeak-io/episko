// The debug console: an in-app event log plus a live state snapshot, behind the 🐞
// button. Two tiers, and the distinction matters when something goes wrong —
// `dlog` also tees every line into the backend's rolling episko.log, which survives
// a crash, while the JSON snapshot below is state-of-now and is overwritten each
// flush. Use the snapshot for "what is it doing", the log for "why did it die".
//
// The signal worth the whole module is *unrouted telemetry*: an event arriving for
// a session id the UI doesn't know. That is the routing-drift bug class the
// X-CC-Session header exists to prevent, and the `dropped` counter is how you see
// it happening.
//
// Unlike the *view.ts modules this one owns its DOM region (the panel, the badge,
// the path line) and its own state, so it exports the render functions rather than
// markup. main.ts keeps the listeners on the buttons and the flush interval.

import { invoke } from "@tauri-apps/api/core";
import { $ } from "./dom";
import { esc } from "./format";
import { rl } from "./rl";
import {
  activeId, dirtyByFolder, externals, extMirrorId, folderDirty, isDirty,
  pastMirrorId, revivePrefs, sessions, telemetryUp, termEngine, vitalsPrefs,
} from "./state";
import { liveCount, orphanAgents, type Sess } from "./types";
import { reviveDeadline } from "./revive";
import {
  driftVerdict, leakSuspects, pushVitals, vitalsDrift, vitalsLine,
  type Vitals, type VitalsDrift,
} from "./perf";

// A lightweight in-app event log + live state snapshot, surfaced via the 🐞 button
// (in the footer) and mirrored to a fixed file (episko-debug.json) so an external
// tool — or an LLM agent debugging the running app — can read what it's doing.
// The most useful signal here is "unrouted telemetry": telemetry arriving for a
// session id the UI doesn't know (the class of bug that made panes look ended).
export type DbgLvl = "info" | "warn" | "error";
let appVersion = "";
export function setAppVersion(v: string) { appVersion = v; }
export const dbgLog: { t: number; lvl: DbgLvl; msg: string }[] = [];
let dbgOpen = false;
// `renders` counts actual renderAll *paints*, which since the per-frame coalescing is
// deliberately smaller than `rx` under load — renders ≈ rx means the batching broke.
// `outages` counts how many times the hook server has had to be re-bound this run.
// Cheap, and the one number that separates "this pane is genuinely idle" from "nothing
// has been able to reach us for a while" — the question the 🐞 console could not answer
// the day the server died silently and stayed dead for fourteen hours.
export const telem = { rx: 0, routed: 0, dropped: 0, renders: 0, outages: 0 };
export function dlog(lvl: DbgLvl, msg: string) {
  dbgLog.push({ t: Date.now(), lvl, msg });
  if (dbgLog.length > 400) dbgLog.splice(0, dbgLog.length - 400);
  renderDbgBadge();
  if (dbgOpen) renderDbgPanel();
  // Tee into the backend rolling log so the UI event stream survives a crash and
  // lands in one durable timeline with the backend's own lines (see log_frontend).
  // Fire-and-forget: the in-memory ring above is the source of truth for the panel.
  invoke("log_frontend", { level: lvl, msg }).catch(() => {});
}

// ---------- performance vitals ----------
//
// The in-memory half of the series ./perf models. Sampling lives here because it is the
// one thing in the feature that reads live state — `document`, `performance.memory` and
// every open pane's terminal buffer — and this module already owns both the snapshot and
// the tee into the durable log.
//
// **The tee is deliberately `log_frontend` rather than `dlog`.** A vitals line is not an
// event: it says nothing happened, three hundred times a day. Through `dlog` it would
// push real events out of the 400-entry ring the debug panel exists to show, and bury
// the unrouted-telemetry warnings that are the whole reason that ring is worth reading.
// It still lands in `episko.log` beside them, in the same timeline, which is the only
// place any of this had to be.
export const vitalsRing: Vitals[] = [];
let lastSample = 0;

/// One reading of the frontend's weight. Everything here is O(panes) or a single DOM
/// count, which is why the cadence can be measured in minutes without anybody noticing.
function sampleVitals(): Vitals {
  const list = [...sessions.values()];
  const sum = (f: (s: Sess) => number) => list.reduce((n, s) => n + f(s), 0);
  // Chromium exposes `performance.memory`; WebKit does not, and a missing heap figure is
  // reported as 0 rather than faked — a flat zero column reads as "not available here",
  // where an invented number would put a clean verdict on the one counter that matters
  // most. See `heapMB`'s row in ./perf's table.
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

/// Called on a fixed short tick from main.ts; this decides whether a sample is due.
///
/// The cadence is checked here rather than by rebuilding a `setInterval` whenever the
/// picker changes, for the reason every interval in this app is module-scope and
/// permanent: an interval that is cleared and recreated from a settings handler is one
/// stray early return away from a feature that silently stops recording, and *silently
/// stopped recording* is indistinguishable from *nothing is leaking*.
export function tickVitals(prefsEnabled: boolean, everyMs: number) {
  if (!prefsEnabled) { lastSample = 0; return; }
  const now = Date.now();
  // A first sample the moment it is switched on, so the readout has something to say
  // before the first interval elapses.
  if (lastSample && now - lastSample < everyMs) return;
  lastSample = now;
  const v = sampleVitals();
  pushVitals(vitalsRing, v);
  invoke("log_frontend", { level: "info", msg: vitalsLine(v) }).catch(() => {});
}

/// What Settings › Diagnostics draws, handed over through the settings host rather than
/// imported, so the control panel keeps taking its readings from somebody else's module.
export function currentDrift(): VitalsDrift | null { return vitalsDrift(vitalsRing); }

function dbgIssues() { return dbgLog.reduce((n, e) => n + (e.lvl === "info" ? 0 : 1), 0); }
export function renderDbgBadge() {
  const n = dbgIssues();
  const b = $("dbgBadge");
  b.textContent = String(n);
  (b as HTMLElement).hidden = n === 0;
  $("dbgBtn").classList.toggle("has-issues", n > 0);
}
// The inherited half of a fan-out, spelled out. A leftover a newer run absorbed is
// invisible in `done/started` and shows up only as a total that won't close — which is
// exactly the state that has to be readable from outside the app.
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
    // `telemetryUp` beside the counters: a snapshot full of idle sessions means two
    // completely different things depending on it.
    telemetry: { ...telem, up: telemetryUp },
    sessions: [...sessions.values()].map((s) => ({
      id: s.id, project: s.project, phase: s.phase, attention: s.attention, model: s.model,
      ctxPct: s.ctxPct, cost: s.cost, durMs: s.durMs, subagents: liveCount(s),
      lastEvent: s.lastEvent, kind: s.kind, external: s.external, branch: s.branch, workdir: s.workdir,
      // The background fleet, if one is up. Both counts, not just the live one: "3
      // running" and "3 running, 47 done" are the same session at very different points,
      // and a fan-out that has stopped moving is only visible as the gap between them.
      fanout: dbgFanout(s),
      // Where the agent's writes are actually landing, when that isn't `workdir`. In
      // the snapshot because the two disagreeing is precisely the state that needs
      // explaining from outside the app — the case this was written for looked, from
      // every log line, like a session sitting quietly in the checkout it had left.
      drift: s.drift ? `${s.drift.branch} @ ${s.drift.dir}` : null,
      // What the revive watchdog has done about a turn the API killed. This is the one
      // field here that is read *after the fact* rather than live: the question at 08:00
      // is "did it try, how many times, and when did it stop", and the rolling
      // `episko.log` has the individual attempts while this has the standing state.
      revive: s.revive
        ? `${s.revive.attempts} tried, ${s.revive.gaveUp ? "gave up" : `next at ${new Date(s.revive.dueAt).toISOString()}`}`
        : null,
    })),
    externals: externals.map((e) => ({ pid: e.pid, session_id: e.session_id, cwd: e.cwd, status: e.status, dirty: folderDirty(e.cwd) })),
    dirtyFolders: [...dirtyByFolder.entries()].map(([f, g]) => ({ folder: f, added: g?.added ?? 0, removed: g?.removed ?? 0, files: g?.files ?? 0, untracked: g?.untracked ?? 0, dirty: isDirty(g) })),
    // When the revive watchdog next acts on anything, or null when it is idle. A
    // top-level field rather than per-session because "is this thing going to do
    // something, and when" is one question about the app, and an external tool reading
    // the snapshot should not have to scan the fleet to answer it.
    nextRevive: (() => { const at = reviveDeadline(sessions.values(), revivePrefs, Date.now()); return at ? new Date(at).toISOString() : null; })(),
    // The growth series in summary — the counters themselves are in `episko.log`, one
    // line per sample, which is the form that survives the reload this bug is fixed by.
    // What belongs here is the standing answer: is it recording, over how long, and is
    // anything climbing. Kept small on purpose, because `flushDebug` skips a write when
    // the body is unchanged and a live figure in here would defeat that guard on every
    // four-second pass.
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
// The 4s flush is unconditional and never cleared, and that stays true on purpose:
// CLAUDE.md's whole reason for the snapshot is that an external tool — or an agent
// debugging the running app — can read live state *with the panel closed*, so
// "only flush when visible" would break what it is for. What it must not do is cost
// the same when nothing has happened.
//
// Measured on a six-session fleet with the 400-entry ring full:
//   - pretty-printing cost 39,771 bytes against 29,866 compact (−24.9%), handed
//     across the IPC boundary and written to disk every four seconds, forever. It
//     buys nothing: every consumer of this file is a program.
//   - the snapshot is *unchanged* between most flushes, and an unchanged snapshot
//     is a write nobody needed.
//
// `generatedAt` is excluded from the comparison — it is a fresh timestamp on every
// call, so including it would make every snapshot differ by construction and the
// guard would never fire. But a file whose timestamp never moves also can't be told
// from a frozen app, so an unchanged snapshot is still written every HEARTBEAT_MS.
// That keeps "is it alive?" answerable while skipping the rest.
const HEARTBEAT_MS = 60_000;
let lastBody = "";
let lastWrite = 0;
export async function flushDebug() {
  const snap = dbgSnapshot();
  const { generatedAt: _ts, ...rest } = snap;
  const body = JSON.stringify(rest);
  if (body === lastBody && Date.now() - lastWrite < HEARTBEAT_MS) return;
  lastBody = body;
  try {
    const path = await invoke<string>("write_debug_file", { contents: JSON.stringify(snap) });
    lastWrite = Date.now();
    $("dbgPath").textContent = path;
  } catch { /* backend not ready */ }
}
