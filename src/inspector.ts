// The right-hand inspector: renderInspector dispatches on the kind of pane on stage. The
// cards' markup is ./inspectorview's; this owns the element, the status pill and the task
// card's per-button listeners. On renderAll's hot path.

import { invoke } from "@tauri-apps/api/core";
import { $, stageGen, toast } from "./dom";
import { esc, tilde } from "./format";
import { apiErrText, hasSessionState, isAgent, phaseText, runElapsed, statusKey, type Sess } from "./types";
import { lastRunnableById, pinnedIds, togglePin } from "./tasks";
import { activeId, outlinePrefs, revivePrefs, sessions } from "./state";
import { reviveStatus } from "./revive";
import { rerunTask, revealSource, sendOutputToSession } from "./taskrun";
import {
  contextHtml, type CtxMode, driftHtml, dwellText, fanoutHtml, outlineHtml,
  planHtml, RISK_LABEL, vitalHtml, wsetHtml,
} from "./inspectorview";
import { anchoredPrompts, scrollToPrompt } from "./terminal";

// ---- the Context card's view state ----
// Which Files groups are unfolded, and files vs tools. App-wide and ephemeral: it is how
// you want the card, not a fact about a conversation, so it survives switching panes.
const openGroups = new Set<string>();
let ctxMode: CtxMode = "files";
function repaintActive() {
  const s = activeId ? sessions.get(activeId) : null;
  if (s) renderInspector(s);
}
export function toggleFileGroup(g: string) {
  if (openGroups.has(g)) openGroups.delete(g); else openGroups.add(g);
  repaintActive();
}
export function setCtxMode(m: string) {
  ctxMode = m === "tools" ? "tools" : "files";
  repaintActive();
}
// ---- the outline's view state ----
// App-wide and ephemeral, like the Context card's fold above.
let outlineAll = false;
export function toggleOutlineAll() { outlineAll = !outlineAll; repaintActive(); }

// Click a question, land where you asked it. The row carries its own session id: markup
// outlives the `activeId` that produced it, as with the tool timeline.
export function jumpToPrompt(sid: string, promptId: string) {
  const s = sessions.get(sid);
  if (!s) return;
  if (!scrollToPrompt(s, promptId)) toast("That far back has scrolled out of this terminal");
}

// Hover-to-unfold, ./peek's idea in a single row. The class goes straight on the element and
// never through a repaint: replacing the node under the pointer is how a click gets dropped.
const OUTLINE_DWELL_MS = 450;
let olTimer: number | undefined;
let olOpen: HTMLElement | null = null;
function unfold(row: HTMLElement | null) {
  if (olOpen === row) return;
  olOpen?.classList.remove("open");
  olOpen = row;
  row?.classList.add("open");
}
export function wireOutlineHover() {
  const root = $("inspector");
  root.addEventListener("mouseover", (e) => {
    const row = outlinePrefs.hover ? (e.target as HTMLElement).closest<HTMLElement>(".ol-row") : null;
    clearTimeout(olTimer);
    if (!row) { unfold(null); return; }
    if (row !== olOpen) olTimer = window.setTimeout(() => unfold(row), OUTLINE_DWELL_MS);
  });
  root.addEventListener("mouseleave", () => { clearTimeout(olTimer); unfold(null); });
}

export function renderInspector(s: Sess | null) {
  if (s?.kind === "shell") { renderShellInspector(s); return; }
  if (s && isAgent(s) && !hasSessionState(s)) { renderAgentInspector(s); return; }
  if (s?.kind === "task") { renderTaskInspector(s); return; }
  const pill = $("iPill"); const k = s ? statusKey(s) : "idle";
  pill.className = "pill " + k;
  $("iPillTxt").textContent = s ? (s.attention ? s.attention : phaseText(s)) : "–";
  if (!s) { paintInspector(`<div class="insp-empty">No session selected.</div>`); return; }

  const html: string[] = [];
  // ACT — a pending permission is the only thing that should ever jump the queue.
  if (s.attention) {
    const risk = s.pendingPermId && s.pendRisk ? `<span class="risk ${s.pendRisk}">${RISK_LABEL[s.pendRisk]}</span>` : "";
    const queued = s.pendingPermissions.length > 1 ? ` · ${s.pendingPermissions.length - 1} more queued` : "";
    const permBtns = s.pendingPermId
      ? `<div class="attn-btns"><button class="allow" data-perm="allow" data-permid="${s.pendingPermId}">Allow</button><button data-perm="deny" data-permid="${s.pendingPermId}">Deny</button><button data-perm="terminal" data-permid="${s.pendingPermId}">In terminal</button></div>`
      : "";
    html.push(`<div class="attn"><div class="attn-h">🔔 ${esc(s.attention + queued)}${risk}</div>${s.pendingCmd ? `<code>${esc(s.pendingCmd)}</code>` : ""}${permBtns}</div>`);
  } else if (s.phase === "error" && s.apiErr) {
    // A turn the API killed: the glyph alone can't say "wait a minute" vs "your key is dead".
    const creds = s.apiErr.kind === "authentication_failed" || s.apiErr.kind === "billing_error" || s.apiErr.kind === "oauth_org_not_allowed";
    // The watchdog's status replaces the note: "retrying in 2m" and "send it again" contradict.
    const rev = reviveStatus(s, revivePrefs, Date.now());
    const note = rev ?? (creds
      ? "The agent can't reach its API with these credentials. Fix them in the terminal, then send the prompt again."
      : "The turn ended early, and the conversation is intact. Send the prompt again to pick it back up.");
    html.push(`<div class="attn err"><div class="attn-h">⚠ ${esc(apiErrText(s.apiErr))}</div>${s.apiErr.detail ? `<code>${esc(s.apiErr.detail)}</code>` : ""}<div class="attn-note${rev ? " revive" : ""}">${esc(note)}</div></div>`);
  }
  // Above everything that reads the launch folder, which is not where the work is going.
  if (s.drift) html.push(driftHtml(s));
  html.push(vitalHtml(s));
  html.push(fanoutHtml(s));
  // Above the plan and the Context card: what you asked and what the tree looks like are
  // both read far more often than the file set, which is the card you scroll to.
  if (s.git) html.push(wsetHtml(s));
  if (outlinePrefs.enabled) html.push(outlineHtml(s, outlinePrefs, anchoredPrompts(s), outlineAll));
  if (s.todos.length) html.push(planHtml(s));
  html.push(contextHtml(s, openGroups, ctxMode));
  paintInspector(html.join(""));
  // After the assignment, so a fresh #iDwell has its text before the frame paints.
  tickDwell(s);
}

// Assign #inspector only when the markup changed: replacing a node between mousedown and
// mouseup drops the click, and this surface holds a permission's Allow/Deny. The dwell
// clock stays out of the string (#iDwell is patched by textContent) or the guard never
// bites; stageGen is in the key because ./mirror and ./dashboard write the same element.
let lastInspHtml: string | null = null;
let lastInspGen = -1;
function paintInspector(html: string) {
  if (html === lastInspHtml && stageGen === lastInspGen) return;
  lastInspHtml = html;
  lastInspGen = stageGen;
  $("inspector").innerHTML = html;
}
// The one field the render path leaves blank; main.ts's one-second tick calls this too.
export function tickDwell(s: Sess) {
  const el = document.getElementById("iDwell");
  if (el) el.textContent = dwellText(s);
}

function renderShellInspector(s: Sess) {
  const ended = s.phase === "ended";
  const pill = $("iPill"); pill.className = "pill " + (ended ? "ended" : "idle");
  $("iPillTxt").textContent = ended ? "exited" : "shell";
  paintInspector(`
    <div class="ext-card">
      <div class="ext-hl">❯ Plain shell</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(s.project)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="ell" title="${esc(tilde(s.workdir))}">${esc(tilde(s.workdir))}</span></div>
      <div class="ext-note">A regular login shell running inside Episko, with no coding-agent telemetry. Handy for commands you don't want to run inside a session.</div>
    </div>`);
}

// Terminal-only provider fallback: says why a provider without an adapter gets no phase or usage.
function renderAgentInspector(s: Sess) {
  const ended = s.phase === "ended";
  const label = s.title || s.provider || "agent";
  const pill = $("iPill"); pill.className = "pill " + (ended ? "ended" : "idle");
  $("iPillTxt").textContent = ended ? "exited" : "running";
  paintInspector(`
    <div class="ext-card">
      <div class="ext-hl">» ${esc(label)}</div>
      <div class="ext-meta"><span class="label">Project</span><span>${esc(s.project)}</span></div>
      ${s.branch ? `<div class="ext-meta"><span class="label">Branch</span><span class="ell">${esc(s.branch)}</span></div>` : ""}
      <div class="ext-meta"><span class="label">Path</span><span class="ell" title="${esc(tilde(s.workdir))}">${esc(tilde(s.workdir))}</span></div>
      <div class="ext-note">${esc(label)} is running in an Episko pane in this checkout. This provider currently uses the terminal-only adapter, so Episko cannot show its phase, usage or context.</div>
    </div>`);
}

function renderTaskInspector(s: Sess) {
  const r = s.run!;
  const failed = r.exitCode != null && r.exitCode !== 0;
  const running = r.exitCode == null;
  const pill = $("iPill");
  pill.className = "pill " + (running ? "working" : failed ? "error" : "done");
  $("iPillTxt").textContent = running ? (r.background ? "running · background" : "running") : failed ? `exit ${r.exitCode}` : "passed";

  // Offer the failure to a live agent in the same project; embedded panes only, since an
  // external session has no PTY to type into.
  const candidates = failed ? [...sessions.values()].filter((x) => hasSessionState(x) && !x.external && x.colorKey === s.colorKey && x.phase !== "ended") : [];
  // A run-on-stop failure goes back to the session it was checking and only that one; if it
  // is gone, offer nothing rather than misdirect. A hand-run task takes the first live agent.
  const target = r.forSession ? candidates.find((x) => x.id === r.forSession) : candidates[0];
  const handoff = target
    ? `<button class="tact hero" data-send="${target.id}">↩ Send output to “${esc(target.title || target.branch || "session")}”</button>`
    : "";

  // Not through paintInspector: this card binds per-element listeners, so a skipped repaint
  // would bind them twice. Clear the cache so the next agent repaint can't match stale markup.
  lastInspHtml = null;
  $("inspector").innerHTML = `
    <div class="ext-card">
      <div class="ext-hl">▶ ${esc(r.label)}</div>
      <div class="ext-meta"><span class="label">Command</span><span class="mono ell" title="${esc(r.cmd)}">${esc(r.cmd)}</span></div>
      <div class="ext-meta"><span class="label">Source</span><span>${esc(r.source)} · ${esc(r.sourceFile)}</span></div>
      <div class="ext-meta"><span class="label">Path</span><span class="ell" title="${esc(tilde(s.workdir))}">${esc(tilde(s.workdir))}</span></div>
      <div class="ext-meta"><span class="label">${running ? "Running" : "Took"}</span><span class="mono">${esc(runElapsed(r))}</span></div>
      ${r.exitCode != null ? `<div class="ext-meta"><span class="label">Exit</span><span class="mono ${failed ? "bad" : "ok"}">${r.exitCode}</span></div>` : ""}
    </div>
    <div class="tacts">
      ${handoff}
      <button class="tact" data-rerun="1">⟳ Re-run</button>
      ${lastRunnableById.get(r.id)?.inputs.length ? `<button class="tact" data-reparams="1" title="Re-run, changing what it runs with">⋯ Parameters</button>` : ""}
      <button class="tact" data-pin="1">${pinnedIds(s.colorKey).includes(r.id) ? "★ Unpin" : "☆ Pin"}</button>
      <button class="tact" data-reveal="1">↗ Reveal source</button>
      ${running ? `<button class="tact" data-kill="1">■ Stop</button>` : ""}
    </div>`;

  const insp = $("inspector");
  insp.querySelector("[data-rerun]")?.addEventListener("click", () => rerunTask(s));
  insp.querySelector("[data-reparams]")?.addEventListener("click", () => rerunTask(s, true));
  insp.querySelector("[data-pin]")?.addEventListener("click", () => togglePin(s.colorKey, r.id));
  insp.querySelector("[data-reveal]")?.addEventListener("click", () => revealSource(r.root, r.sourceFile));
  insp.querySelector("[data-kill]")?.addEventListener("click", () => invoke("kill_session", { sessionId: s.id }).catch(() => {}));
  insp.querySelector("[data-send]")?.addEventListener("click", (e) => {
    sendOutputToSession(s, (e.currentTarget as HTMLElement).dataset.send!);
  });
}
