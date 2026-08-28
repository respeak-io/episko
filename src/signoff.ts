// Sign off: shelve the whole fleet at the end of a session of work.
//
// The bulk half of shelving (./panes `shelveSession`). One button in the top bar,
// beside caffeinate — which is the other control about the machine rather than about
// any one pane, and the one you turned on when the fleet started.
//
// **It opens a sheet rather than doing it.** This is the single most destructive
// button in the app by count: it stops every agent you have running. So the sheet is
// the confirmation, and it is a sheet rather than an `ask()` because the answer is not
// yes/no — two of the three things it is about are exceptions the user has to be able
// to change before pressing it:
//
//   • Sessions still working. Shelving one kills the turn it is in the middle of, and
//     "sign off, but let those two finish" is a thing people actually mean at the end
//     of a day. The switch defaults to KEEPING them, because the cost of leaving a
//     session up is what this feature exists to reduce, while the cost of stopping a
//     turn mid-flight is work you have to redo.
//   • Shells, tasks and external panes. None can be shelved — nothing to resume — but
//     a dev server and three login shells are exactly the processes still eating the
//     machine after every agent has gone. So they are listed by name and offered for
//     CLOSING, which is the only thing that can honestly be done to them, with the
//     switch on: signing off with a `pnpm dev` still up is usually an oversight.
//
// Neither switch is remembered. Both are answers about tonight's fleet — which
// sessions happen to be mid-turn, which servers happen to be up — and a remembered
// "yes, close my shells" would silently kill a dev server three weeks later.

import { $, toast } from "./dom";
import { esc } from "./format";
import { dlog } from "./debug";
import { sessions } from "./state";
import { canShelve, midWork, phaseText, taskStateText, type Sess } from "./types";

// What it needs from layers it does not own: the top bar's one-menu-at-a-time rule,
// the repaint, and the two verbs it is made of. One host object rather than four
// setters, as ./settings and ./palui do at this many callees.
//
// The two verbs are here **because a direct import would be a cycle**: ./footer has to
// close this popover (it owns `closeFootMenus`), ./panes imports ./footer to repaint,
// and importing ./panes here would close the ring footer → signoff → panes → footer.
// ./serversui reaches `closeSession` the same way, for the same reason.
let host: {
  closeFootMenus: (keep?: string) => void;
  renderAll: () => void;
  shelveSession: (id: string) => boolean;
  closeSession: (id: string) => void;
} = { closeFootMenus: () => {}, renderAll: () => {}, shelveSession: () => false, closeSession: () => {} };
export function setSignoffHost(h: typeof host) { host = h; }

// The switches, reset every time the sheet opens (see the module note above).
let keepWorking = true;
let closeRest = true;

/// What sign-off is about, in the three groups the sheet shows. Split here rather than
/// inside the markup so the button label, the action and the list can never disagree
/// about which sessions are in — the bug shape where a dialog says "shelve 6" and
/// shelves 4.
interface SignoffPlan {
  /// Shelvable and idle: shelved whatever the switches say.
  idle: Sess[];
  /// Shelvable but mid-turn or running a fan-out — in only when `keepWorking` is off.
  working: Sess[];
  /// Shells, tasks and external panes: closed only when `closeRest` is on.
  rest: Sess[];
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

/// How a pane is named in the sheet's lists. The project first, because at sign-off
/// you are reading down a list of everything you have open and the project is what
/// tells them apart; the title is what tells two panes of one project apart.
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
  // Capped, and the overflow is counted rather than dropped: a fleet of twenty would
  // push the button off the bottom of the screen, and a list that silently stops at
  // six reads as "that is all of them".
  const shown = list.slice(0, 6);
  const more = list.length - shown.length;
  return `<div class="so-list ${cls}">`
    + shown.map((s) => `<div class="so-row"><span class="so-nm">${esc(rowLabel(s))}</span>`
      + `<span class="so-st">${esc(stateLabel(s))}</span></div>`).join("")
    + (more > 0 ? `<div class="so-row so-more">…and ${more} more</div>` : "")
    + `</div>`;
}
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
/// Name the un-shelvable group by what is actually in it. "2 shells and tasks" when
/// there is no task in the list is the kind of small lie that makes a reader stop
/// trusting the counts beside it — and this is the group whose switch closes things
/// for good, so it is the last one that can afford to be approximate.
function restLabel(rest: Sess[]): string {
  const n = { shell: 0, task: 0, other: 0 };
  for (const s of rest) n[s.kind === "shell" ? "shell" : s.kind === "task" ? "task" : "other"]++;
  const parts = [
    n.shell ? plural(n.shell, "shell") : "",
    n.task ? plural(n.task, "task") : "",
    // Everything else that cannot be shelved: an external pane, a terminal-only agent.
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
  // The headline counts what the switches have actually left selected, so it and the
  // button below can never disagree — the shape where a dialog says "shelve 6" and
  // shelves 4 because a switch above it said otherwise.
  const head = shelve.length
    ? `<div class="so-head"><b>Shelve ${plural(shelve.length, "session")}</b>`
      + `<span>They stop, and stay in the sidebar under their project. ⟲ picks each one back up where it left off.</span></div>`
    : `<div class="so-head"><b>Nothing to shelve</b>`
      + `<span>${p.working.length ? "Every session here is still working, and the switch below is keeping them."
        : "No session here can be resumed later, so none can be shelved."}</span></div>`;
  const idle = p.idle.length ? listHtml(p.idle, "so-ok") : "";
  // The working group leads with its switch, because that switch is the decision the
  // group exists to put in front of you.
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
  // The button says the whole outcome. "Sign off" alone would be the one control in
  // the app whose effect you have to reconstruct from two switches above it.
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

/// Do it. Shelve first, then close: shelving re-enters `setActive` through
/// `closeSession` (the stage hands over to a surviving neighbour on every removal), so
/// running the two groups in one interleaved pass would hand the stage to a shell that
/// is about to be closed anyway. Ids are snapshotted for the same reason the run-group
/// close snapshots them — both loops mutate the map they would otherwise iterate.
function runSignoff() {
  const p = plan();
  const shelveIds = toShelve(p).map((s) => s.id);
  const closeIds = toClose(p).map((s) => s.id);
  closeSignoffPop();
  // Each pane is closed inside its own try, and this is the one loop in the app where
  // that earns its keep. Closing re-enters the render layer (the stage hands over to a
  // neighbour, which repaints the header and the inspector for it), so a single pane
  // whose state paints badly throws *out of the loop* — and the visible result is a
  // sign-off that silently did half the fleet and said it did all of it. The counts
  // below are what actually happened rather than what was asked for, so a partial run
  // reads as one.
  //
  // What counts as done is **"is this pane still open?"**, never "did the call return
  // normally". The throw lands after the pane has already been removed (the map is
  // emptied first, and the stage hands over after), so counting returns reported a
  // failure for a session that had in fact gone — a toast that invents a problem is
  // worse than one that misses it.
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
  // The two switches rebuild the sheet, which detaches the node that was clicked — so
  // the event has to stop here or the document's outside-click handler sees a target
  // that is no longer in the tree and closes the sheet under the switch you just flipped.
  // (./caffeinate's sub-controls carry the same note, and the same bug.)
  if (t.closest("[data-sokeep]")) { e.stopPropagation(); keepWorking = !keepWorking; fillSoPop(); return; }
  if (t.closest("[data-soclose]")) { e.stopPropagation(); closeRest = !closeRest; fillSoPop(); return; }
  if (t.closest("[data-sogo]")) { e.stopPropagation(); runSignoff(); }
});
