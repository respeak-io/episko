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
  pastMirrorId, sessions, termEngine,
} from "./state";

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
export const telem = { rx: 0, routed: 0, dropped: 0 };
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
function dbgIssues() { return dbgLog.reduce((n, e) => n + (e.lvl === "info" ? 0 : 1), 0); }
export function renderDbgBadge() {
  const n = dbgIssues();
  const b = $("dbgBadge");
  b.textContent = String(n);
  (b as HTMLElement).hidden = n === 0;
  $("dbgBtn").classList.toggle("has-issues", n > 0);
}
export function dbgSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    version: appVersion, activeId, activeExtId: extMirrorId(), activePastId: pastMirrorId(), termEngine, rateLimits: rl, telemetry: telem,
    sessions: [...sessions.values()].map((s) => ({
      id: s.id, project: s.project, phase: s.phase, attention: s.attention, model: s.model,
      ctxPct: s.ctxPct, cost: s.cost, durMs: s.durMs, subagents: s.subagents,
      lastEvent: s.lastEvent, kind: s.kind, external: s.external, branch: s.branch, workdir: s.workdir,
      // Where the agent's writes are actually landing, when that isn't `workdir`. In
      // the snapshot because the two disagreeing is precisely the state that needs
      // explaining from outside the app — the case this was written for looked, from
      // every log line, like a session sitting quietly in the checkout it had left.
      drift: s.drift ? `${s.drift.branch} @ ${s.drift.dir}` : null,
    })),
    externals: externals.map((e) => ({ pid: e.pid, session_id: e.session_id, cwd: e.cwd, status: e.status, dirty: folderDirty(e.cwd) })),
    dirtyFolders: [...dirtyByFolder.entries()].map(([f, g]) => ({ folder: f, added: g?.added ?? 0, removed: g?.removed ?? 0, files: g?.files ?? 0, untracked: g?.untracked ?? 0, dirty: isDirty(g) })),
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
    `<div class="dbg-stats">telemetry: rx ${telem.rx} · routed ${telem.routed} · <span class="${telem.dropped ? "warn" : ""}">dropped ${telem.dropped}</span> · 5h ${rl.h5 != null ? Math.round(rl.h5) + "%" : "–"}</div>
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
