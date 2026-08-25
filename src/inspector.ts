// The right-hand inspector: the one panel whose contents depend entirely on what kind
// of pane is on stage. renderInspector is the dispatcher — a shell gets a card saying
// what it is, a task run gets its command, exit code and actions, and an agent gets
// the full stack of cards ./inspectorview builds.
//
// That split is the *view.ts boundary at work: every card's markup is a pure function
// in ./inspectorview, and what stays here is the element they are painted into, the
// status pill beside them, and the task card's per-button listeners — which address
// one specific Sess and so were never part of the global [data-*] dispatcher.
//
// It is on renderAll()'s hot path (an agent's inspector repaints on every telemetry
// event for the session on stage), which is why it is a module of its own rather than
// something for the bootstrap trim to sweep up.

import { invoke } from "@tauri-apps/api/core";
import { $, stageGen } from "./dom";
import { esc, tilde } from "./format";
import { apiErrText, isAgent, phaseText, runElapsed, statusKey, type Sess } from "./types";
import { lastRunnableById, pinnedIds, togglePin } from "./tasks";
import { activeId, revivePrefs, sessions } from "./state";
import { reviveStatus } from "./revive";
// The task card's three actions. They took a host object while they lived in
// main.ts; now that they are ./taskrun this module simply imports them.
import { rerunTask, revealSource, sendOutputToSession } from "./taskrun";
import {
  contextHtml, type CtxMode, driftHtml, dwellText, fanoutHtml, gaugesHtml, planHtml,
  resHtml, RISK_LABEL, vitalHtml, wsetHtml,
} from "./inspectorview";

// ---- the Context card's view state ----
//
// Which of its groups are expanded, and whether it is showing files or the old tool
// timeline. Ephemeral and app-wide rather than per-session: it is how *you* want the
// card, not something about a conversation, so it survives switching panes and doesn't
// need persisting. Held here, next to the element it repaints, on the same pattern as
// ./panes' `collapsedRuns` — the module that owns the state calls the one renderer that
// reads it, rather than reaching for a global `renderAll`.
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

export function renderInspector(s: Sess | null) {
  if (s?.kind === "shell") { renderShellInspector(s); return; }
  if (s?.kind === "task") { renderTaskInspector(s); return; }
  const pill = $("iPill"); const k = s ? statusKey(s) : "idle";
  pill.className = "pill " + k;
  $("iPillTxt").textContent = s ? (s.attention ? s.attention : phaseText(s)) : "–";
  if (!s) { paintInspector(`<div class="insp-empty">No session selected.</div>`); return; }

  const html: string[] = [];
  // ACT — a pending permission is the only thing that should ever jump the queue.
  if (s.attention) {
    const risk = s.pendingPermId && s.pendRisk ? `<span class="risk ${s.pendRisk}">${RISK_LABEL[s.pendRisk]}</span>` : "";
    const permBtns = s.pendingPermId
      ? `<div class="attn-btns"><button class="allow" data-perm="allow" data-permid="${s.pendingPermId}">Allow</button><button data-perm="deny" data-permid="${s.pendingPermId}">Deny</button><button data-perm="terminal" data-permid="${s.pendingPermId}">In terminal</button></div>`
      : "";
    html.push(`<div class="attn"><div class="attn-h">🔔 ${esc(s.attention)}${risk}</div>${s.pendingCmd ? `<code>${esc(s.pendingCmd)}</code>` : ""}${permBtns}</div>`);
  } else if (s.phase === "error" && s.apiErr) {
    // Right behind it: a turn the API killed. Nothing is happening and nothing will,
    // and the glyph alone can't say whether that means "wait a minute" or "your key
    // is dead" — so the reason and what to do about it go on the card.
    const creds = s.apiErr.kind === "authentication_failed" || s.apiErr.kind === "billing_error" || s.apiErr.kind === "oauth_org_not_allowed";
    // What the watchdog is doing about it, when it is doing anything. It REPLACES the
    // note rather than sitting beside it: "send the prompt again to pick it back up" and
    // "retrying in 2m" are contradictory instructions, and the card would be telling you
    // to do the thing it is about to do for you.
    const rev = reviveStatus(s, revivePrefs, Date.now());
    const note = rev ?? (creds
      ? "Claude Code can't reach the API with these credentials. Fix them in the terminal, then send the prompt again."
      : "The turn ended early, and the conversation is intact. Send the prompt again to pick it back up.");
    html.push(`<div class="attn err"><div class="attn-h">⚠ ${esc(apiErrText(s.apiErr))}</div>${s.apiErr.detail ? `<code>${esc(s.apiErr.detail)}</code>` : ""}<div class="attn-note${rev ? " revive" : ""}">${esc(note)}</div></div>`);
  }
  // Above the vital, and above the working set it contradicts: everything below reads
  // the folder the session was launched in, which is not where the work is going.
  if (s.drift) html.push(driftHtml(s));
  html.push(vitalHtml(s));                                        // state, dwell, current tool
  html.push(fanoutHtml(s));                                       // the fleet it launched, if any
  html.push(gaugesHtml(s));                                       // TRACK — context + cost
  if (s.todos.length) html.push(planHtml(s));                     // the plan it's keeping
  // What's changed on disk, and how the branch sits against its upstream. Shown
  // for any repo session — a clean tree that's behind is exactly what you want to
  // see, and it's the only place the fetch/pull/push buttons live.
  if (s.git) html.push(wsetHtml(s));
  html.push(contextHtml(s, openGroups, ctxMode));                 // the files it's been into
  html.push(resHtml());       // REFERENCE — app-wide disk I/O, pinned to the bottom
  paintInspector(html.join(""));
  // The dwell is patched, never rendered — see `paintInspector`. Do this after the
  // assignment above, so a fresh #iDwell gets its text before the frame is painted.
  tickDwell(s);
}

/**
 * Assign `#inspector` only when the markup changed — the same guard ./sidebar and
 * ./dashboard use, on the surface that most needed it.
 *
 * **This one is a correctness fix, not a saving.** The inspector rides `renderAll`, so
 * on a busy fleet it was rebuilt several times a second, and it holds the app's most
 * consequential buttons: a pending permission's *Allow / Deny / In terminal*. Replacing
 * a node between mousedown and mouseup means the `click` fires on the container rather
 * than the button, `closest("[data-perm]")` finds nothing, and **the decision is
 * silently dropped** — on a session that is blocked waiting for exactly that answer.
 *
 * The guard only bites because the dwell clock is kept *out* of the compared string.
 * `dwellText` is `m:ss`, so leaving it in made the markup differ every second by
 * construction and no repaint would ever have been skipped. main.ts already patches
 * `#iDwell` by `textContent` once a second for the neighbouring reason (an innerHTML
 * assignment restarts the heartbeat's CSS animation); this makes that the *only* way it
 * is ever written, rather than a second mechanism racing the render.
 */
/// Keyed by `stageGen` as well as the markup: ./mirror and ./dashboard write this same
/// element, and every route to them goes through `takeStage`. Without it, leaving a
/// session for the dashboard and coming back would match a string that is no longer on
/// screen and skip the repaint that puts it there.
let lastInspHtml: string | null = null;
let lastInspGen = -1;
function paintInspector(html: string) {
  if (html === lastInspHtml && stageGen === lastInspGen) return;
  lastInspHtml = html;
  lastInspGen = stageGen;
  $("inspector").innerHTML = html;
}
/// The one field the render path deliberately leaves blank, filled here and by main.ts's
/// one-second tick. Exported so the tick has a single implementation to call.
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
      <div class="ext-note">A regular login shell running inside Episko, with no Claude and no telemetry. Handy for commands you don't want to run inside a session.</div>
    </div>`);
}

function renderTaskInspector(s: Sess) {
  const r = s.run!;
  const failed = r.exitCode != null && r.exitCode !== 0;
  const running = r.exitCode == null;
  const pill = $("iPill");
  pill.className = "pill " + (running ? "working" : failed ? "error" : "done");
  $("iPillTxt").textContent = running ? (r.background ? "running · background" : "running") : failed ? `exit ${r.exitCode}` : "passed";

  // Offer the failure to a live agent in the same project — the one thing a plain
  // terminal can't do. Only agents, and only when the run actually failed.
  // Embedded panes only: a session running in Ghostty/iTerm has no PTY we can type
  // into, so offering the handoff there would fail at the click.
  const candidates = failed ? [...sessions.values()].filter((x) => isAgent(x) && !x.external && x.colorKey === s.colorKey && x.phase !== "ended") : [];
  // A run-on-stop failure goes back to the session whose turn it was checking — and
  // *only* that session. If it's gone (ended) or unreachable (external, no PTY to
  // type into), offer nothing rather than misdirecting the output to an unrelated
  // agent that happens to sort first. A hand-run task (no forSession) still offers
  // the first live agent, which is the useful default there.
  const target = r.forSession ? candidates.find((x) => x.id === r.forSession) : candidates[0];
  const handoff = target
    ? `<button class="tact hero" data-send="${target.id}">↩ Send output to “${esc(target.title || target.branch || "session")}”</button>`
    : "";

  // NOT through `paintInspector`: this card wires per-element listeners below, so a
  // skipped repaint would bind a second set to the same nodes and fire every action
  // twice. It carries a live "Running 0:12" anyway, so there is nothing to skip — but
  // the cache must be told, or the next agent repaint could match a string this
  // assignment has already replaced.
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
