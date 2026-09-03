// Sign off: shelve the whole fleet at once (docs/sessions.md). A sheet rather than an
// `ask()`, because two answers must be changeable first: working sessions default to KEPT
// (a killed turn is redone work), shells/tasks/externals to CLOSED. Neither is remembered.

import { $, toast } from "./dom";
import { esc } from "./format";
import { dlog } from "./debug";
import { sessions } from "./state";
import { canShelve, midWork, phaseText, taskStateText, type Sess } from "./types";

// One host object rather than four setters. The two verbs cannot be imported: ./panes
// imports ./footer, which closes this popover, so a direct import would be a cycle.
let host: {
  closeFootMenus: (keep?: string) => void;
  renderAll: () => void;
  shelveSession: (id: string) => boolean;
  closeSession: (id: string) => void;
} = { closeFootMenus: () => {}, renderAll: () => {}, shelveSession: () => false, closeSession: () => {} };
export function setSignoffHost(h: typeof host) { host = h; }

// Reset every time the sheet opens.
let keepWorking = true;
let closeRest = true;

// Split here rather than in the markup, so the label, the action and the list cannot disagree.
interface SignoffPlan {
  idle: Sess[]; // shelvable; shelved whatever the switches say
  working: Sess[]; // shelvable but mid-turn or in a fan-out; in only when keepWorking is off
  rest: Sess[]; // shells, tasks, externals; closed only when closeRest is on
}
function plan(): SignoffPlan {
  const p: SignoffPlan = { idle: [], working: [], rest: [] };
  for (const s of sessions.values()) {
    if (!canShelve(s)) p.rest.push(s);
    else if (midWork(s)) p.working.push(s);
    else p.idle.push(s);
  }
  return p;
}
const toShelve = (p: SignoffPlan) => (keepWorking ? p.idle : [...p.idle, ...p.working]);
const toClose = (p: SignoffPlan) => (closeRest ? p.rest : []);

// Project first: at sign-off you read down everything open, and the project tells rows apart.
function rowLabel(s: Sess): string {
  const what = s.kind === "task" ? (s.run?.label ?? "task")
    : s.kind === "shell" ? "shell"
      : s.title || s.branch || (s.provider ?? "session");
  return `${s.project} · ${what}`;
}
function stateLabel(s: Sess): string {
  if (s.kind === "task") return taskStateText(s);
  if (s.kind === "shell") return s.phase === "ended" ? "exited" : "running";
  if (s.external) return "your terminal";
  return phaseText(s);
}
function listHtml(list: Sess[], cls: string): string {
  // Capped, with the overflow counted: a list that stops silently reads as "that is all".
  const shown = list.slice(0, 6);
  const more = list.length - shown.length;
  return `<div class="so-list ${cls}">`
    + shown.map((s) => `<div class="so-row"><span class="so-nm">${esc(rowLabel(s))}</span>`
      + `<span class="so-st">${esc(stateLabel(s))}</span></div>`).join("")
    + (more > 0 ? `<div class="so-row so-more">…and ${more} more</div>` : "")
    + `</div>`;
}
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
// Named by what is in it: "2 shells and tasks" with no task is a lie beside a count that closes things.
function restLabel(rest: Sess[]): string {
  const n = { shell: 0, task: 0, other: 0 };
  for (const s of rest) n[s.kind === "shell" ? "shell" : s.kind === "task" ? "task" : "other"]++;
  const parts = [
    n.shell ? plural(n.shell, "shell") : "",
    n.task ? plural(n.task, "task") : "",
    n.other ? plural(n.other, "other pane") : "",
  ].filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
}

function fillSoPop() {
  const p = plan();
  const shelve = toShelve(p);
  const close = toClose(p);
  if (!p.idle.length && !p.working.length && !p.rest.length) {
    $("soPop").innerHTML = `<div class="so-empty">Nothing is open.<br>Sign off shelves your agent sessions so they keep their place in the sidebar.</div>`;
    return;
  }
  // The headline counts what the switches left selected, so it and the button cannot disagree.
  const head = shelve.length
    ? `<div class="so-head"><b>Shelve ${plural(shelve.length, "session")}</b>`
      + `<span>They stop, and stay in the sidebar under their project. ⟲ picks each one back up where it left off.</span></div>`
    : `<div class="so-head"><b>Nothing to shelve</b>`
      + `<span>${p.working.length ? "Every session here is still working, and the switch below is keeping them."
        : "No session here can be resumed later, so none can be shelved."}</span></div>`;
  const idle = p.idle.length ? listHtml(p.idle, "so-ok") : "";
  const working = p.working.length
    ? `<div class="so-grp so-warn"><div class="so-sw-row">`
      + `<span class="so-sw-lbl">Keep ${plural(p.working.length, "session")} still working</span>`
      + `<button class="caf-switch ${keepWorking ? "on" : ""}" role="switch" aria-checked="${keepWorking}" data-sokeep="1"><span class="caf-knob"></span></button></div>`
      + listHtml(p.working, keepWorking ? "so-kept" : "so-ok") + `</div>`
    : "";
  const rest = p.rest.length
    ? `<div class="so-grp"><div class="so-sw-row">`
      + `<span class="so-sw-lbl">Also close ${esc(restLabel(p.rest))}</span>`
      + `<button class="caf-switch ${closeRest ? "on" : ""}" role="switch" aria-checked="${closeRest}" data-soclose="1"><span class="caf-knob"></span></button></div>`
      + `<div class="so-note">${closeRest ? "These have no conversation to resume, so closing is the only thing that stops them." : "These keep running after you sign off."}</div>`
      + listHtml(p.rest, closeRest ? "so-cut" : "so-kept") + `</div>`
    : "";
  // The button says the whole outcome, not "Sign off" alone.
  const parts = [shelve.length ? `shelve ${shelve.length}` : "", close.length ? `close ${close.length}` : ""].filter(Boolean);
  const go = parts.length
    ? `<button class="so-go" data-sogo="1">Sign off · ${esc(parts.join(", "))}</button>`
    : `<button class="so-go" disabled>Nothing selected</button>`;
  $("soPop").innerHTML = head + idle + working + rest + go;
}
export function openSignoffPop() {
  keepWorking = true;
  closeRest = true;
  const r = $("signoffBtn").getBoundingClientRect();
  const pop = $("soPop");
  fillSoPop();
  host.closeFootMenus("soPop");
  const w = 320;
  pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
  pop.classList.add("show");
}
export function closeSignoffPop() { $("soPop").classList.remove("show"); }

// Shelve first, then close: closing re-enters `setActive`, and an interleaved pass would
// hand the stage to a shell about to be closed. Ids are snapshotted: both loops mutate the map.
function runSignoff() {
  const p = plan();
  const shelveIds = toShelve(p).map((s) => s.id);
  const closeIds = toClose(p).map((s) => s.id);
  closeSignoffPop();
  // Each pane in its own try: closing re-enters the render layer, and one pane that paints
  // badly must not throw out of the loop. Done means "is the pane gone?", never "did the call
  // return": the throw lands after the map entry is removed, so counting returns invents failures.
  let shelved = 0, closed = 0;
  const gone = (id: string, run: () => void) => {
    try { run(); } catch (e) { dlog("error", `sign off: ${id.slice(0, 8)} threw on the way out: ${e}`); }
    return !sessions.has(id);
  };
  for (const id of shelveIds) if (gone(id, () => host.shelveSession(id))) shelved++;
  for (const id of closeIds) if (gone(id, () => host.closeSession(id))) closed++;
  const missed = shelveIds.length + closeIds.length - shelved - closed;
  dlog(missed ? "warn" : "info", `sign off · shelved ${shelved}, closed ${closed}${missed ? `, ${missed} left open` : ""}`);
  const said = [shelved ? `Shelved ${shelved}` : "", closed ? `closed ${closed}` : ""].filter(Boolean).join(" · ");
  toast(!said ? "Nothing to sign off"
    : missed ? `${said} · ${missed} still open (see 🐞)`
      : `${said} · resume from the sidebar`);
  host.renderAll();
}

$("signoffBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("soPop").classList.contains("show") ? closeSignoffPop() : openSignoffPop();
});
$("soPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  // The switches rebuild the sheet and detach the clicked node, so stop here or the document's
  // outside-click handler sees a detached target and closes the sheet (./caffeinate too).
  if (t.closest("[data-sokeep]")) { e.stopPropagation(); keepWorking = !keepWorking; fillSoPop(); return; }
  if (t.closest("[data-soclose]")) { e.stopPropagation(); closeRest = !closeRest; fillSoPop(); return; }
  if (t.closest("[data-sogo]")) { e.stopPropagation(); runSignoff(); }
});
