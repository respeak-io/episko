// The project sidebar and its mini-rail: the two surfaces `renderAll()` repaints
// first on every telemetry event, plus the two pointer interactions that live on
// them — dragging project groups into a manual order, and dropping files onto the
// stage to paste their paths.
//
// What the sidebar *shows* and in what order is ./grouping's job, the rows themselves
// are ./sidebarview's, and the project glyph is ./icons's; this module owns the two
// elements they are painted into and the drag state that a mid-drag repaint must not
// stomp — which is the reason renderSidebar cannot be a pure ./sidebarview function.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { $, IS_MAC, toast } from "./dom";
import { dlog } from "./debug";
import { esc, tilde } from "./format";
import { iconFor, projGlyph } from "./icons";
import { groupedProjects, groupSummary, projectList, type ProjGroup } from "./grouping";
import {
  PEEK_IDLE, peekEnter, peekLeave, peekLeaveAll, peekNextDeadline, peekTick,
  type PeekState,
} from "./peek";
import { groupOf, setCollapsed, type GroupDef } from "./projgroups";
import { dormantRows, foldEmpty, foldHead, groupBody, peekBody } from "./sidebarview";
import {
  activeId, extMirrorId, FAVORITES, folderDirty, keyPrefs, peekPrefs, projGroups,
  saveProjGroups, saveProjOrder, sessions, setProjGroups, setProjOrder, sortMode,
  type SortMode,
} from "./state";
import { activeBind, comboText, type KeyAction } from "./keys";

// Two things a finished reorder needs that this module does not own: the sort mode
// is an app-level preference (validate → persist → announce) and the repaint is the
// whole app's. Per-callee setters, per PLAN's seam rule 2; main.ts wires both at
// startup and until then a drag reorders the DOM and saves the order silently.
let setSort: (m: SortMode, announce?: boolean) => void = () => {};
export function setSidebarSetSort(fn: typeof setSort) { setSort = fn; }
let renderAll: () => void = () => {};
export function setSidebarRenderAll(fn: typeof renderAll) { renderAll = fn; }

// While a project group is being dragged, renderSidebar() must not rebuild the
// #projects DOM — doing so would destroy the node the browser is dragging,
// killing the drop. Telemetry ticks call renderAll() constantly, so this guard
// is what makes reordering actually work during live sessions.
let draggingProjects = false;
// Set just after a pointer-driven reorder (see initProjectDnD): swallows the click a
// pointerup may synthesise, so a drag that ends on a project doesn't also select it.
export let reorderGuardUntil = 0;
// The click handler that consumes the guard is the global one in main.ts, so the
// reset needs a setter — state.ts's convention: assign and nothing else.
export function setReorderGuard(v: number) { reorderGuardUntil = v; }

// The sidebar's row builders now live in ./sidebarview; renderSidebar below owns
// the element they are painted into, and the drag state that must not be stomped.

// The markup last written to #projects, and the reason renderSidebar is guarded.
//
// This is the hot path in the whole app: renderAll() repaints it on EVERY telemetry
// event, and a fleet of agents produces those continuously. Building the string is
// cheap (0.13ms with six sessions) but *assigning* it is not — #projects is ~6.7KB
// of rows, and replacing it invalidates the sidebar's entire layout. Measured with
// layout forced, renderSidebar costs **7.0ms**, which is ~95% of renderAll's total.
// (Without forcing layout it measures 0.13ms and looks free — the browser defers
// the work to the next frame, which is exactly how this stayed invisible.)
//
// Most of those repaints change nothing. The rows show a phase glyph, a title and
// `Math.round(ctxPct)`, so a statusLine moving cost or context by a hair is usually
// invisible here. Over a realistic event stream, **84.5%** of repaints produced
// byte-identical markup with hooks mixed in, and **95%** for a session thinking
// quietly. So: build always, assign only on a change.
//
// Not render diffing (which PLAN puts out of scope) — no DOM is compared or
// patched. It is the same guard ./tray already uses before rebuilding the native
// menu, applied to the surface that turned out to cost the most.
let lastHtml: string | null = null;
// The pointer-driven reorder physically moves nodes inside #projects, so the cache
// must not be trusted across one. Cleared in the drag's cleanup below; the cost is
// one guaranteed repaint per drag, which is the correct trade.
function invalidateSidebarCache() { lastHtml = null; }

export function renderSidebar() {
  // Don't stomp the DOM the browser is mid-drag on — see draggingProjects.
  if (draggingProjects) return;
  const html = groupedProjects().map((slot) =>
    slot.kind === "project" ? projectHtml(slot.project) : foldHtml(slot.group, slot.projects)).join("");
  if (html === lastHtml) return; // nothing the sidebar shows has changed
  lastHtml = html;
  $("projects").innerHTML = html;
  // The DOM the expansion lives on was just replaced, so re-apply it. This is the
  // whole reason ./peek tracks a project *path* rather than an element.
  applyPeek();
}

// One user-defined group: its header, and its projects nested inside a body that
// animates open and shut.
//
// **The members are rendered whether or not the group is collapsed**, and that is what
// buys the height animation — `grid-template-rows: 0fr → 1fr` needs the content to be
// there to have a height to animate to. Unlike peek, the collapsed flag IS part of the
// markup string: hover changes many times a second and would shred `lastHtml`, but a
// collapse is a deliberate click, so it costs exactly one repaint and keeps the state
// in the one place a re-render can't lose it.
function foldHtml(g: GroupDef, projects: ProjGroup[]): string {
  const body = projects.length ? projects.map(projectHtml).join("") : foldEmpty();
  return `<div class="pfold${g.collapsed ? " collapsed" : ""}" data-fold="${esc(g.id)}">`
    + foldHead(g, groupSummary(projects), projects.length)
    + `<div class="pfbody"><div class="pfbody-in">${body}</div></div></div>`;
}

function projectHtml(p: ProjGroup): string {
  const rows = groupBody(p) + dormantRows(p);
  const total = p.sessions.length + p.externals.length;
  const isFav = FAVORITES.some((f) => f.path === p.path);
  // Any member folder (a session's workdir or an external's cwd) with uncommitted
  // changes lights the project's dot — so a dirty worktree marks its parent too.
  const dirty = p.sessions.some((s) => folderDirty(s.workdir)) || p.externals.some((e) => folderDirty(e.cwd));
  const dot = dirty ? `<span class="pdirty" title="Uncommitted changes in this project"></span>` : "";
  const wtSuffix = p.wtBranch ? `<span class="pwt">· ${esc(p.wtBranch)}</span>` : "";
  // **Every project header opens the dashboard, whatever put it in the list.** It used
  // to depend on which of the three shapes below a project happened to land in, so a
  // folder Episko only knew about from an external session, from a past one, or from a
  // worktree whose session had ended was simply not clickable — with no disabled state
  // to say so, because the attribute was absent rather than refused. "Has an Episko
  // session or is a favourite" is not a fact about a project worth having a view gated
  // on; the empty-but-real dashboard those folders get is the answer.
  //
  // Keyed to `repoRoot ?? path`: a checkout is not a project. `dashDays` filters
  // history by `histProject().colorKey`, which regrafts every row onto the repo root —
  // so a dashboard keyed by a worktree dir matches no sessions at all and renders a
  // timeline of commits with nobody having worked on them. The checkouts are a card
  // *inside* the project's dashboard, which is where a worktree belongs.
  const dashRoot = p.repoRoot ?? p.path;
  const opens = `data-dash="${esc(dashRoot)}" data-proj="${esc(p.name)}"`;
  let head: string;
  if (p.sessions.length) {
    head = `<div class="phead" ${opens} data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}${wtSuffix}</span>${dot}<span class="pcount">${total}</span><span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}">＋</span><span class="parm"></span></div>`;
  } else if (isFav) {
    const tail = p.externals.length ? `<span class="pcount ext">${p.externals.length} ext</span>` : `<span class="plaunch">open →</span>`;
    head = `<div class="phead empty-p" ${opens} data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span>${dot}${tail}<span class="premove" data-remove="${esc(p.path)}" title="Remove project">✕</span><span class="parm"></span></div>`;
  } else {
    // discovered via an external session or a restorable one only — not a saved project
    const tail = p.externals.length
      ? `<span class="pcount ext">${p.externals.length} ext</span>`
      : `<span class="pcount ext">${p.dormants.length} past</span>`;
    head = `<div class="phead ext-only" ${opens} data-key="${esc(p.path)}" title="${esc(tilde(p.path))}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}${wtSuffix}</span>${dot}${tail}<span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}" title="Launch an Episko session here">＋</span><span class="parm"></span></div>`;
  }
  return `<div class="pgroup" data-path="${esc(p.path)}">${head}${rows ? `<div class="psessions">${rows}</div>` : ""}${peekBody(p)}</div>`;
}

/// Expand the group a project is filed in, if it is collapsed. Called when a session
/// takes the stage (./panes' `setActive`), because ⌘1–9, `nextAfterClose` and the tray
/// can all land on a session inside a folded group — and a rail showing nothing
/// selected while a pane is plainly on screen reads as the selection having been lost.
///
/// Persists here rather than in ./actions for the reason the reorder below does: this
/// module is already the one that writes a sidebar preference straight after a gesture,
/// and ./panes cannot import ./actions (which imports ./panes).
export function revealProjGroup(path: string) {
  const gid = groupOf(projGroups, path);
  if (!gid) return;
  const next = setCollapsed(projGroups, gid, false);
  if (next === projGroups) return; // already open — no write, no repaint
  setProjGroups(next);
  saveProjGroups();
}

// ---------- peek: resting on a project reveals its idle checkouts ----------
// ./peek owns the rules and is pure; this is the driver. Three things it has to get
// right, and each of them is why the state does not live in the DOM:
//
//   1. **Hover must not be a render input.** renderSidebar skips its (7ms) DOM write
//      when the markup is unchanged; making the expansion part of the string would
//      bust that on every mouse move. So peekBody always renders the rows and this
//      only toggles a class.
//   2. **A repaint must not collapse an open group.** renderAll() fires on every
//      telemetry event, so #projects is rebuilt under the pointer constantly —
//      applyPeek() above re-applies the class to the new nodes.
//   3. **An idle sidebar must cost nothing.** One timeout scheduled to the next
//      deadline, not an interval.
let peek: PeekState = PEEK_IDLE;
let peekTimer: number | null = null;
/// Which group the pointer is in. mouseover fires for every descendant, so this is
/// what turns that stream into "entered a different group".
let peekHover: string | null = null;

function applyPeek() {
  for (const el of $("projects").querySelectorAll<HTMLElement>(".pgroup")) {
    el.classList.toggle("peek", el.dataset.path === peek.open);
    // The arming hairline. Without it the group expands out of nowhere a second after
    // you stopped moving, which reads as a glitch rather than as a deliberate delay —
    // you cannot tell the app is counting unless it shows you.
    const arming = !!peek.arming && el.dataset.path === peek.arming.path;
    if (arming) {
      // Re-run the fill, but from where the *timer* is rather than from zero. The class
      // alone won't restart it on a group that was armed, cancelled and re-entered — and
      // a plain restart is wrong the rest of the time, because this also runs after every
      // repaint that changed the markup. renderAll() fires on each telemetry event, and a
      // project with a live session repaints several times a second, so a bar that
      // restarted here would crawl back to empty under the pointer while the timeout it
      // depicts ran on to its original deadline: the one thing worse than no countdown is
      // one that lies about how much is left. A negative delay offsets into the animation
      // by however much has already elapsed.
      const elapsed = Math.max(0, peekPrefs.openMs - (peek.arming!.at - Date.now()));
      el.classList.remove("arming");
      void el.offsetWidth;
      el.style.setProperty("--peek-open", `${peekPrefs.openMs}ms`);
      el.style.setProperty("--peek-arm-delay", `${-elapsed}ms`);
    }
    el.classList.toggle("arming", arming);
  }
}
function peekSchedule() {
  if (peekTimer !== null) { clearTimeout(peekTimer); peekTimer = null; }
  const at = peekNextDeadline(peek);
  if (at === null) return;
  peekTimer = window.setTimeout(() => {
    peekTimer = null;
    peekAdvance(peekTick(peek, Date.now()));
  }, Math.max(0, at - Date.now()));
}
/// Commit a new state: repaint only when what's on screen actually changed, then
/// re-arm the timer.
///
/// **Both fields are on screen**, which is easy to forget: `open` is the expansion and
/// `arming` is the hairline counting down to it. Comparing only `open` meant entering a
/// group changed `arming` alone, no repaint happened, and the bar never appeared — the
/// panel then opened a second later out of nowhere.
function peekAdvance(next: PeekState) {
  const before = peek.open + "|" + (peek.arming?.path ?? "");
  peek = next;
  if (peek.open + "|" + (peek.arming?.path ?? "") !== before) applyPeek();
  peekSchedule();
}

export function initSidebarPeek() {
  const container = $("projects");
  // mouseover/mouseout rather than mouseenter/mouseleave: these bubble, so one pair
  // of delegated listeners survives every re-render. Per-group listeners would have
  // to be re-attached on each repaint, which is the bug this shape avoids.
  container.addEventListener("mouseover", (e) => {
    const g = (e.target as HTMLElement).closest<HTMLElement>(".pgroup");
    const path = g?.dataset.path;
    if (!path || path === peekHover) return;
    peekHover = path;
    // A group whose checkouts are already listed takes no part in this. It has nothing
    // to reveal, so arming it would draw the countdown hairline for a second and then
    // do nothing visible — an animation promising something that already happened — and
    // opening it would hand it the "already inside an expanded rail" shortcut (peekEnter),
    // which would then expand the NEXT group you pass over instantly. The rail is only
    // expanded there because a setting says so, not because you asked for it.
    if (g!.querySelector(".pgpeek.open")) return;
    peekAdvance(peekEnter(peek, path, Date.now(), peekPrefs));
  });
  container.addEventListener("mouseout", (e) => {
    const g = (e.target as HTMLElement).closest<HTMLElement>(".pgroup");
    const path = g?.dataset.path;
    if (!path) return;
    // mouseout also fires when crossing between children of the same group; only a
    // pointer that has genuinely left the group's subtree counts as leaving it.
    const to = e.relatedTarget as Node | null;
    if (to && g!.contains(to)) return;
    if (peekHover === path) peekHover = null;
    peekAdvance(peekLeave(peek, path, Date.now(), peekPrefs));
  });
  // Leaving the rail through a gap between groups fires no group mouseout, so the
  // container gets its own (non-bubbling, but bound directly) leave.
  container.addEventListener("mouseleave", () => {
    peekHover = null;
    peekAdvance(peekLeaveAll(peek, Date.now(), peekPrefs));
  });
}

/// Collapse whatever is expanded — called when peek is switched off in Settings, and
/// after a launch, so the rail doesn't stay open over a pane you just started.
export function closePeek() {
  peekHover = null;
  peekAdvance(PEEK_IDLE);
}
// Reordering of project groups, on pointer events (not HTML5 drag). The window now
// sets dragDropEnabled:true so external file drops paste a path instead of navigating
// the webview (see initFileDrop) — but that native handler blocks HTML5 drag/drop, so
// the reorder can no longer ride dragstart/dragover/drop. Pointer events are also fully
// cross-platform (the old HTML5 path only worked with dragDropEnabled:false).
//
// Delegated on the persistent #projects container so it survives re-renders; a
// separator line (.dropmark) shows where the group will land; the dragged group is only
// physically moved on release, then the DOM order is read back and saved. A drag only
// begins once the pointer crosses DRAG_SLOP, so a plain click still selects the project.
//
// GROUPS MADE THIS NESTED, AND THE READ-BACK IS WHY IT STILL WORKS. A `.pgroup` may now
// live inside a `.pfold`, so the marker can no longer be inserted into `#projects` (that
// throws outright once the reference node is a fold's child) — it goes into whatever
// parent the drop target has, which is also what makes dragging a project INTO a group
// the same gesture as reordering it. Membership is then read back off the DOM exactly
// as the order always has been, so the two can never come out of a drag disagreeing.
export function initProjectDnD() {
  const container = $("projects");
  const DRAG_SLOP = 5; // px before a press becomes a drag rather than a click
  const marker = document.createElement("div");
  marker.className = "dropmark";
  let dragEl: HTMLElement | null = null;      // the group actually being dragged
  let candidate: HTMLElement | null = null;   // pressed group, promoted to dragEl past the slop
  let startX = 0, startY = 0;

  // A collapsed fold has no visible body to drop into, so the header lights up instead
  // — the marker is in there, it just has nowhere to be seen.
  const clearFoldTarget = () => container.querySelector(".pfold.droptarget")?.classList.remove("droptarget");

  const cleanup = () => {
    marker.remove();
    clearFoldTarget();
    container.classList.remove("reordering");
    dragEl?.classList.remove("dragging");
    dragEl = candidate = null;
    draggingProjects = false;
    // A drag moved real nodes in #projects, so what is on screen no longer
    // necessarily matches the cached markup — force the next render to paint.
    invalidateSidebarCache();
  };

  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const t = e.target as HTMLElement;
    // Leave the interactive bits (launch +, per-worktree +, remove ✕, colour dot) to
    // their own clicks.
    if (t.closest(".padd, .wtadd, .plaunch, .premove, .pdot, .pdirty")) return;
    // A fold header drags the whole group; anything else drags the project it is in.
    // `closest` returns the nearer of the two, which is exactly that rule.
    const g = t.closest<HTMLElement>(".pgroup, .pfold");
    if (!g) return;
    candidate = g;
    startX = e.clientX; startY = e.clientY;
  });

  container.addEventListener("pointermove", (e) => {
    if (!candidate) return;
    if (!dragEl) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP) return;
      // Cross the slop → promote to a real drag.
      dragEl = candidate;
      draggingProjects = true;
      container.classList.add("reordering");
      dragEl.classList.add("dragging");
      try { container.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    e.preventDefault();
    // Place the marker relative to whichever group the pointer is over.
    const over = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    let grp = over?.closest<HTMLElement>(".pgroup, .pfold") ?? null;
    const draggingFold = dragEl.classList.contains("pfold");
    // Groups don't nest. Dragging one aims at whatever fold the pointer is inside,
    // never at a project within it.
    if (grp && draggingFold) grp = grp.closest<HTMLElement>(".pfold") ?? grp;
    // `dragEl.contains(grp)` — a fold being dragged over its own members.
    if (!grp || grp === dragEl || dragEl.contains(grp)) return;
    clearFoldTarget();
    // The pointer resolved to a fold rather than to a project in it, which means it is
    // over the header or an empty body: both mean "this group". Dropping a project
    // there files it, which is the whole gesture — and the only way in for a group with
    // nothing in it yet. (Out again is the fold's own body → a top-level project, or
    // the context menu's "Remove from group".)
    if (!draggingFold && grp.classList.contains("pfold")) {
      const body = grp.querySelector<HTMLElement>(".pfbody-in");
      if (body) { body.appendChild(marker); if (grp.classList.contains("collapsed")) grp.classList.add("droptarget"); return; }
    }
    const r = grp.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    grp.parentElement?.insertBefore(marker, after ? grp.nextSibling : grp);
  });

  const finish = (e: PointerEvent) => {
    try { container.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (!dragEl) { candidate = null; return; } // never crossed the slop: it was a click
    if (marker.parentNode) marker.parentNode.insertBefore(dragEl, marker);
    cleanup();
    saveSidebarArrangement(container);
    // A manual drag captures the current visual order and reasserts manual mode
    // (in a sorted mode the drag would otherwise be immediately overridden).
    if (sortMode !== "manual") setSort("manual", false);
    // A pointerup *may* synthesise a click (if the browser still pairs it with the
    // pointerdown after the DOM moved); guard the click handler for a brief window so
    // the reorder doesn't also select. A plain timestamp self-heals if no click fires —
    // a lingering one-shot listener would otherwise eat the user's next real click.
    reorderGuardUntil = performance.now() + 250;
    renderAll();
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", (e) => { try { container.releasePointerCapture(e.pointerId); } catch { /* */ } cleanup(); });
}

/// What the drag actually left on screen: the flat project order, and which fold each
/// project ended up inside. One pass, because they are one arrangement — persisting the
/// order from the DOM and the membership from anywhere else is how the two would drift.
///
/// **Memberships for projects that are not on screen are carried over untouched.** In
/// toplevel mode a repo can be rendered only as its worktrees (`splitByWorktree` drops
/// an empty root group), so rebuilding `of` from scratch here would quietly unfile every
/// such repo on the next drag.
function saveSidebarArrangement(container: HTMLElement) {
  const order: string[] = [];
  const of = { ...projGroups.of };
  for (const el of container.querySelectorAll<HTMLElement>(".pgroup")) {
    const path = el.dataset.path;
    if (!path) continue;
    order.push(path);
    const gid = el.closest<HTMLElement>(".pfold")?.dataset.fold;
    if (gid) of[path] = gid; else delete of[path];
  }
  setProjOrder(order);
  saveProjOrder();
  setProjGroups({ groups: projGroups.groups, of });
  saveProjGroups();
}

// External file drops. With dragDropEnabled:true the webview no longer navigates to a
// dropped file's file:// URL (the old trap: a dropped PDF replaced the whole app with no
// way back). Tauri's native drag-drop event carries the real absolute paths, which HTML5
// drops never expose under WKWebView — so we paste them, shell-escaped, into the active
// embedded session's PTY, matching what dragging a file into a normal terminal does.
export function initFileDrop() {
  const zone = $("terminals");
  getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") zone.classList.add("dropping");
    else zone.classList.remove("dropping");
    if (p.type !== "drop") return;
    const paths = p.paths || [];
    if (!paths.length) return;
    const s = activeId ? sessions.get(activeId) : null;
    if (!s || s.external || !s.term) { toast("Drop files onto an embedded session's console to paste their paths"); return; }
    const text = paths.map(shellEscapePath).join(" ") + " ";
    invoke("write_pty", { sessionId: s.id, data: text });
    s.term.focus();
    dlog("info", `dropped ${paths.length} path${paths.length === 1 ? "" : "s"} into ${s.id.slice(0, 8)}`);
  }).catch((err) => dlog("error", `onDragDropEvent wiring failed: ${err}`));
}

// Escape a path for a shell/REPL the way a terminal does on file drop: backslash before
// anything outside the always-safe set, so spaces and metacharacters survive as one arg.
function shellEscapePath(p: string): string {
  return p.replace(/[^A-Za-z0-9_@%+=:,./-]/g, "\\$&");
}
// The 44px rail. Flat — `projectList()`, not `groupedProjects()`: it is already the
// most compressed view of the fleet there is, and a heading you cannot read plus a
// fold you cannot see the contents of would cost rows to say nothing. Grouping is an
// answer to a long sidebar, and this is the short one.
// Guarded like `renderSidebar` above, and for the sharper of its two reasons: the rail
// is nothing BUT buttons, and it rides `renderAll` — so on a busy fleet every one of
// them was destroyed and rebuilt several times a second. That loses `:hover` under a
// stationary pointer, and loses a click outright when the node is replaced between
// mousedown and mouseup. What the rail shows (a glyph, an accent, an attention dot)
// changes far more rarely than the events that repaint it.
/// A button's chord as a title suffix — empty when the action is unbound or the
/// master switch is off, so the tooltip reads "New session" rather than trailing an
/// empty pair of brackets around a shortcut that no longer exists.
function hint(id: KeyAction): string {
  const t = comboText(activeBind(keyPrefs, id), IS_MAC);
  return t ? ` (${t})` : "";
}
let lastMiniHtml: string | null = null;
export function renderMini() {
  const activeProj = activeId ? sessions.get(activeId)?.project : null;
  const html =
    `<button class="rm-btn" data-rail="1" title="Expand sidebar${hint("sidebar")}">»</button>` +
    projectList().map((p) => {
      const first = p.sessions[0];
      const firstExt = p.externals[0];
      const attn = p.sessions.some((s) => s.attention || s.phase === "error");
      const sel = first ? `data-sel="${first.id}"`
        : firstExt ? `data-ext="${firstExt.session_id}"`
        : `data-launch="${esc(p.path)}" data-proj="${esc(p.name)}"`;
      const ic = iconFor(p.path);
      const glyph = ic ? `<img class="rm-icon" src="${ic}" alt="" />` : `<span class="rm-dot"></span>`;
      const onCls = p.name === activeProj || (extMirrorId() && p.externals.some((e) => e.session_id === extMirrorId())) ? "on" : "";
      const extOnly = !first && firstExt ? "ext" : "";
      return `<button class="rm-proj ${onCls} ${extOnly}" style="--rc:${p.accent}" title="${esc(p.name)}${extOnly ? " (external)" : ""}" data-key="${esc(p.path)}" ${sel}>${glyph}${attn ? '<span class="rm-badge"></span>' : ""}</button>`;
    }).join("") +
    `<button class="rm-btn rm-add" data-pal="1" title="New session${hint("palette")}">＋</button>`;
  if (html === lastMiniHtml) return;
  lastMiniHtml = html;
  $("railmini").innerHTML = html;
}
