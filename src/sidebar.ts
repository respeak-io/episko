// The project sidebar and its mini-rail, plus the two pointer gestures on them: dragging
// groups into a manual order and dropping files onto the stage. ./grouping decides what
// shows and ./sidebarview draws the rows; this module owns the elements and the drag state.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { $, IS_MAC, toast } from "./dom";
import { dlog } from "./debug";
import { esc, tilde } from "./format";
import { statusKey } from "./types";
import { attnFlash, attnFlashDeadline } from "./attn";
import { iconFor, projGlyph } from "./icons";
import { icon } from "./svgicons";
import { dashHeads, groupedProjects, groupReviews, groupSummary, projectList, railRanks, type ProjGroup, type SidebarSlot } from "./grouping";
import {
  PEEK_IDLE, peekEnter, peekLeave, peekLeaveAll, peekNextDeadline, peekTick,
  type PeekState,
} from "./peek";
import { expandTo, groupOf, groupToken, MAX_DEPTH } from "./projgroups";
import { dormantRows, foldEmpty, foldHead, groupBody, LIT_COLOR, peekBody } from "./sidebarview";
import { incomingByProject, rowText, type HandoffRec } from "./handoff";
import { incomingRowHtml, incomingStripHtml } from "./handoffview";
import { deviceLabel, pathsOfId } from "./synclink";
import {
  activeId, attnPrefs, dashMirror, extMirrorId, FAVORITES, folderDirty, handoffs, keyPrefs, openReviews, peekPrefs,
  projGroups, railHold,
  saveProjGroups, saveProjOrder, sessions, setProjGroups, setProjOrder, setRailHold, sortMode,
  type SortMode,
} from "./state";
import { activeBind, comboText, type KeyAction } from "./keys";

// Hooks, not imports: the sort mode and the repaint belong to the app (seam rule 2); main.ts wires them.
let setSort: (m: SortMode, announce?: boolean) => void = () => {};
export function setSidebarSetSort(fn: typeof setSort) { setSort = fn; }
let renderAll: () => void = () => {};
export function setSidebarRenderAll(fn: typeof renderAll) { renderAll = fn; }

let draggingProjects = false; // a repaint mid-drag would destroy the node the browser is dragging
export let reorderGuardUntil = 0; // swallows the click a pointerup may synthesise after a reorder
export function setReorderGuard(v: number) { reorderGuardUntil = v; }

// The innerHTML guard on the app's hottest surface: assigning #projects costs ~7ms of
// layout, and most repaints produce identical markup (docs/architecture.md).
let lastHtml: string | null = null;
// A drag moves real nodes in #projects, so the cache cannot be trusted across one.
function invalidateSidebarCache() { lastHtml = null; }

// Sessions handed to this machine, by the checkout their project lives in (null: not cloned here).
let incoming = new Map<string | null, HandoffRec[]>();
let onScreen: ProjGroup[] = []; // this pass's groups: in toplevel mode a review's row goes to its worktree's own
const incomingRows = (recs: HandoffRec[] | undefined) =>
  (recs ?? []).map((r) => { const t = rowText(r, Date.now(), deviceLabel); return incomingRowHtml(r, t.tag, t.title); }).join("");

// An open review keeps its project on the rail, as an offer handed to this machine does.
const railList = () =>
  projectList([...[...incoming.keys()].filter((k): k is string => !!k), ...openReviews.map((r) => r.root)]);

export function renderSidebar() {
  if (draggingProjects) return;
  incoming = incomingByProject(handoffs, pathsOfId);
  const list = railList();
  onScreen = list;
  // ./grouping's rule: one repo can be several rows that all open the same dashboard.
  const dash = dashHeads(list, dashMirror()?.root ?? null);
  const loose = incoming.get(null) ?? [];
  const html = incomingStripHtml(incomingRows(loose), loose.length) + groupedProjects(list).map((slot) => slotHtml(slot, dash)).join("");
  if (html !== lastHtml) {
    lastHtml = html;
    $("projects").innerHTML = html;
    applyPeek(); // the expansion lives on the DOM just replaced
  }
  // Outside the guard: a highlight is a clock and must advance on passes that changed no markup.
  applyFlash();
}

// Members render even when collapsed: the height animation needs content to animate to.
// The collapsed flag is in the markup (one repaint per click), unlike hover.
function slotHtml(slot: SidebarSlot, dash: Set<string>): string {
  if (slot.kind === "project") return projectHtml(slot.project, dash);
  const g = slot.group;
  const body = slot.slots.length ? slot.slots.map((s) => slotHtml(s, dash)).join("") : foldEmpty();
  return `<div class="pfold${g.collapsed ? " collapsed" : ""}" data-fold="${esc(g.id)}">`
    + foldHead(g, groupSummary(slot.projects), slot.projects.length)
    + `<div class="pfbody"><div class="pfbody-in">${body}</div></div></div>`;
}

function projectHtml(p: ProjGroup, dash: Set<string>): string {
  const inbox = incoming.get(p.path);
  const revs = groupReviews(p, onScreen);
  const rows = groupBody(p, revs) + incomingRows(inbox) + dormantRows(p);
  const total = p.sessions.length + p.externals.length;
  const isFav = FAVORITES.some((f) => f.path === p.path);
  // A dirty worktree lights its parent project's dot too.
  const dirty = p.sessions.some((s) => folderDirty(s.workdir)) || p.externals.some((e) => folderDirty(e.cwd));
  const dot = dirty ? `<span class="pdirty" title="Uncommitted changes in this project"></span>` : "";
  const wtSuffix = p.wtBranch ? `<span class="pwt">· ${esc(p.wtBranch)}</span>` : "";
  // Every project header opens the dashboard, whatever put it in the list. Keyed to
  // `repoRoot ?? path`: `dashDays` filters by the repo root, so a worktree-keyed dashboard
  // would match no sessions at all.
  const dashRoot = p.repoRoot ?? p.path;
  const opens = `data-dash="${esc(dashRoot)}" data-proj="${esc(p.name)}"`;
  const on = dash.has(p.path) ? " active" : ""; // a dashboard owns the stage the way a session does
  let head: string;
  if (p.sessions.length) {
    head = `<div class="phead${on}" ${opens} data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}${wtSuffix}</span>${dot}<span class="pcount">${total}</span><span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}">${icon("plus", "solo")}</span><span class="parm"></span></div>`;
  } else if (isFav) {
    const tail = p.externals.length ? `<span class="pcount ext">${p.externals.length} ext</span>` : `<span class="plaunch">open →</span>`;
    head = `<div class="phead empty-p${on}" ${opens} data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span>${dot}${tail}<span class="premove" data-remove="${esc(p.path)}" title="Remove project">${icon("x", "solo")}</span><span class="parm"></span></div>`;
  } else {
    // discovered via an external session or a shelved one only — not a saved project
    const tail = p.externals.length
      ? `<span class="pcount ext">${p.externals.length} ext</span>`
      : `<span class="pcount ext">${p.dormants.length ? `${p.dormants.length} shelved` : inbox?.length ? `${inbox.length} incoming`
        : revs.length ? `${revs.length} review${revs.length === 1 ? "" : "s"}` : "handed"}</span>`;
    head = `<div class="phead ext-only${on}" ${opens} data-key="${esc(p.path)}" title="${esc(tilde(p.path))}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}${wtSuffix}</span>${dot}${tail}<span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}" title="Launch an Episko session here">${icon("plus", "solo")}</span><span class="parm"></span></div>`;
  }
  return `<div class="pgroup" data-path="${esc(p.path)}">${head}${rows ? `<div class="psessions">${rows}</div>` : ""}${peekBody(p, revs)}</div>`;
}

// Expand the group a project is filed in, and every group above it: ⌘1–9, `nextAfterClose` and the tray can land on
// a session inside a folded group. Persists here because ./panes cannot import ./actions.
export function revealProjGroup(path: string) {
  const gid = groupOf(projGroups, path);
  if (!gid) return;
  const next = expandTo(projGroups, gid);
  if (next === projGroups) return; // already open — no write, no repaint
  setProjGroups(next);
  saveProjGroups();
}

// ---------- peek: resting on a project reveals its idle checkouts ----------
// ./peek owns the rules; this is the driver. Hover is not a render input (it would bust
// `lastHtml` on every mouse move, so peekBody always renders the rows and this toggles a
// class), applyPeek re-applies it after each repaint, and an idle sidebar costs nothing.
let peek: PeekState = PEEK_IDLE;
let peekTimer: number | null = null; // one timeout to the next deadline, never an interval
let peekHover: string | null = null; // mouseover fires per descendant; this makes it "entered a group"

function applyPeek() {
  for (const el of $("projects").querySelectorAll<HTMLElement>(".pgroup")) {
    el.classList.toggle("peek", el.dataset.path === peek.open);
    // The arming hairline: without it the group opens out of nowhere a second later.
    const arming = !!peek.arming && el.dataset.path === peek.arming.path;
    if (arming) {
      // Restart the fill from where the timer is, not from zero: this also runs after every
      // repaint, and a bar restarting under the pointer would lie about how much is left.
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
// Both `open` and `arming` are on screen; comparing only `open` lost the hairline.
function peekAdvance(next: PeekState) {
  const before = peek.open + "|" + (peek.arming?.path ?? "");
  peek = next;
  if (peek.open + "|" + (peek.arming?.path ?? "") !== before) applyPeek();
  peekSchedule();
}

export function initSidebarPeek() {
  const container = $("projects");
  // mouseover/mouseout bubble, so one delegated pair survives every re-render.
  container.addEventListener("mouseover", (e) => {
    const g = (e.target as HTMLElement).closest<HTMLElement>(".pgroup");
    const path = g?.dataset.path;
    if (!path || path === peekHover) return;
    peekHover = path;
    // A group already showing its checkouts has nothing to reveal, and opening it would hand
    // peekEnter the "already expanded" shortcut that opens the next group instantly.
    if (g!.querySelector(".pgpeek.open")) return;
    peekAdvance(peekEnter(peek, path, Date.now(), peekPrefs));
  });
  container.addEventListener("mouseout", (e) => {
    const g = (e.target as HTMLElement).closest<HTMLElement>(".pgroup");
    const path = g?.dataset.path;
    if (!path) return;
    // mouseout also fires between children of the same group.
    const to = e.relatedTarget as Node | null;
    if (to && g!.contains(to)) return;
    if (peekHover === path) peekHover = null;
    peekAdvance(peekLeave(peek, path, Date.now(), peekPrefs));
  });
  // Leaving through a gap between groups fires no group mouseout.
  container.addEventListener("mouseleave", () => {
    peekHover = null;
    peekAdvance(peekLeaveAll(peek, Date.now(), peekPrefs));
  });
}

// ---------- the hold: nothing on the rail re-sorts under the pointer ----------
// ./grouping applies it; this arms it on the first move over the rail (not on enter, so it
// re-arms after a blur released it) and drops it on leaving, which is when the re-sort paints.
function armRailHold() { setRailHold(null); setRailHold(railRanks(railList())); }
// A reorder the user asked for (the sort button, a drag) must land while they are still there.
export function rearmRailHold() { if (railHold) armRailHold(); }
export function releaseRailHold() {
  if (!railHold) return;
  setRailHold(null);
  renderAll();
}
export function initRailHold() {
  const rail = $("projects").closest<HTMLElement>(".rail")!; // the list, its header and the mini-rail
  rail.addEventListener("pointermove", () => { if (!railHold) armRailHold(); });
  rail.addEventListener("pointerleave", releaseRailHold);
}

// ---------- the finish highlight ----------
// ./attn owns the rules; this is the driver, shaped like peek's. The lit state is not in
// the markup (it would change on every repaint while lit), a repaint must not restart the
// fade (a negative animation-delay resumes it), and the class must come off at the end.
let flashTimer: number | null = null;
let lastLit = ""; // ids lit last pass: "nothing lit and nothing was" is one string compare

function applyFlash() {
  const now = Date.now();
  const lit = new Map<string, number>();
  for (const s of sessions.values()) {
    const age = attnFlash(s, attnPrefs, s.id === activeId, now);
    if (age !== null) lit.set(s.id, age);
  }
  const sig = [...lit.keys()].join(",");
  if (sig || lastLit) {
    lastLit = sig;
    for (const el of $("projects").querySelectorAll<HTMLElement>(".srow[data-sel]")) {
      const s = sessions.get(el.dataset.sel!);
      const age = lit.get(el.dataset.sel!);
      el.classList.remove("lit");
      if (age === undefined || !s) continue;
      // Resume the fade from the clock; the forced reflow makes the removal take effect first.
      void el.offsetWidth;
      el.style.setProperty("--lit-ms", `${attnPrefs.highlightMs}ms`);
      el.style.setProperty("--lit-delay", `${-age}ms`);
      el.style.setProperty("--lit-c", LIT_COLOR[statusKey(s)] ?? LIT_COLOR.done);
      el.classList.add("lit");
    }
  }
  if (flashTimer !== null) { clearTimeout(flashTimer); flashTimer = null; }
  const at = attnFlashDeadline(sessions.values(), attnPrefs, activeId, now);
  if (at === null) return;
  flashTimer = window.setTimeout(() => { flashTimer = null; applyFlash(); }, Math.max(0, at - Date.now()));
}

// Called when peek is switched off and after a launch, so the rail does not stay open over a new pane.
export function closePeek() {
  peekHover = null;
  peekAdvance(PEEK_IDLE);
}
// Reordering and filing on pointer events: `dragDropEnabled:true` (for initFileDrop) blocks
// HTML5 drag/drop. Delegated on #projects; a drag starts past DRAG_SLOP so a click still
// selects. Nodes move in the DOM and order, membership and nesting are all read back off it
// in one pass, so they cannot disagree (docs/worktrees.md).
export function initProjectDnD() {
  const container = $("projects");
  const scroller = container.closest<HTMLElement>(".rail-scroll") ?? container;
  const DRAG_SLOP = 5; // px before a press becomes a drag rather than a click
  const EDGE = 0.3;    // of a group header: its top and (folded) bottom drop beside it, not into it
  const OPEN_AFTER_MS = 650; // resting on a folded group unfolds it, so a drop can reach inside
  const marker = document.createElement("div");
  marker.className = "dropmark";
  let dragEl: HTMLElement | null = null;      // the project or group actually being dragged
  let candidate: HTMLElement | null = null;   // pressed row, promoted to dragEl past the slop
  let dragHeight = 0;                         // levels of groups the dragged node brings with it
  let startX = 0, startY = 0, pointerId = -1;
  let into: HTMLElement | null = null;        // the group a drop would file into, lit on its header
  let openFor: HTMLElement | null = null, openTimer = 0;
  const opened = new Set<HTMLElement>();      // unfolded by this drag; only the one dropped into stays open

  // Groups from `el` up to the container, `el` included: 0 at the top level.
  const depth = (el: Element | null) => { let n = 0; for (let f = el?.closest(".pfold"); f && container.contains(f); f = f.parentElement?.closest(".pfold")) n++; return n; };
  const fits = (fold: Element | null) => depth(fold) + dragHeight <= MAX_DEPTH;
  const setInto = (f: HTMLElement | null) => {
    if (into === f) return;
    into?.classList.remove("droptarget");
    into = f;
    f?.classList.add("droptarget");
  };
  const armOpen = (f: HTMLElement | null) => {
    if (openFor === f) return;
    clearTimeout(openTimer);
    openFor = f;
    if (f?.classList.contains("collapsed")) openTimer = window.setTimeout(() => { f.classList.remove("collapsed"); opened.add(f); }, OPEN_AFTER_MS);
  };
  const beside = (el: HTMLElement, after: boolean) => {
    setInto(null);
    armOpen(null);
    el.parentElement?.insertBefore(marker, after ? el.nextSibling : el);
  };
  const intoFold = (f: HTMLElement, atStart: boolean) => {
    const body = f.querySelector<HTMLElement>(":scope > .pfbody > .pfbody-in");
    if (!body) return;
    body.insertBefore(marker, atStart ? body.firstChild : null);
    setInto(f);
    armOpen(f);
  };
  // Above or below everything: the top level's ends, which no row's half can reach once a group is first or last.
  const atEnd = (top: boolean) => {
    setInto(null);
    armOpen(null);
    const first = container.querySelector<HTMLElement>(":scope > .pgroup, :scope > .pfold");
    if (top && first) container.insertBefore(marker, first); else container.appendChild(marker);
  };

  const cleanup = () => {
    marker.remove();
    setInto(null);
    armOpen(null);
    opened.clear();
    container.classList.remove("reordering");
    dragEl?.classList.remove("dragging");
    dragEl = candidate = null;
    draggingProjects = false;
    invalidateSidebarCache();
  };

  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const t = e.target as HTMLElement;
    // Leave the interactive bits to their own clicks.
    if (t.closest(".padd, .wtadd, .plaunch, .premove, .pdot, .pdirty")) return;
    // A group header drags the whole group; anything else drags its project (`closest` picks the nearer).
    const g = t.closest<HTMLElement>(".pgroup, .pfold");
    if (!g) return;
    candidate = g;
    startX = e.clientX; startY = e.clientY; pointerId = e.pointerId;
  });

  container.addEventListener("pointermove", (e) => {
    if (!candidate) return;
    if (!dragEl) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP) return;
      dragEl = candidate;
      const base = depth(dragEl);
      dragHeight = dragEl.classList.contains("pfold")
        ? 1 + Math.max(0, ...[...dragEl.querySelectorAll(".pfold")].map((f) => depth(f) - base))
        : 0;
      draggingProjects = true;
      container.classList.add("reordering");
      dragEl.classList.add("dragging");
      try { container.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    e.preventDefault();
    const over = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    if (!over || !scroller.contains(over)) return; // off the rail: keep the last answer
    const target = over.closest<HTMLElement>(".pgroup, .pfold");
    if (!target || !container.contains(target)) {
      const r = container.getBoundingClientRect();
      if (e.clientY < r.top + 4) atEnd(true);
      else if (over === container || e.clientY > (container.lastElementChild?.getBoundingClientRect().bottom ?? r.top)) atEnd(false);
      return;
    }
    if (target === dragEl || dragEl.contains(target)) return; // over itself
    const parent = target.parentElement?.closest(".pfold") ?? null;
    const head = target.classList.contains("pfold") ? over.closest<HTMLElement>(".pfhead") : null;
    if (head && head.parentElement === target) {
      const r = head.getBoundingClientRect();
      const rel = (e.clientY - r.top) / r.height;
      const folded = target.classList.contains("collapsed");
      if (rel < EDGE && fits(parent)) beside(target, false);
      else if (rel > 1 - EDGE && folded && fits(parent)) beside(target, true);
      else if (fits(target)) intoFold(target, true);
      else if (fits(parent)) beside(target, rel > 0.5);
      return;
    }
    if (target.classList.contains("pfold")) { if (fits(target)) intoFold(target, false); return; } // its empty body
    if (!fits(parent)) return;
    const r = target.getBoundingClientRect();
    beside(target, e.clientY > r.top + r.height / 2);
  });

  const finish = (e: PointerEvent) => {
    try { container.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (!dragEl) { candidate = null; return; } // never crossed the slop: it was a click
    const el = dragEl;
    if (marker.parentNode) marker.parentNode.insertBefore(el, marker);
    // Into a group still folded: the row vanished, so say where it went.
    const hidden = into?.classList.contains("collapsed") ? into.querySelector(":scope > .pfhead .pfname")?.textContent : null;
    const keepOpen = [...opened].filter((f) => f.contains(el)).map((f) => f.dataset.fold ?? "");
    cleanup();
    saveSidebarArrangement(container, keepOpen);
    rearmRailHold();
    if (sortMode !== "manual") setSort("manual", false); // a sorted mode would override the drag at once
    // A pointerup may synthesise a click; a timestamp guard self-heals if none fires.
    reorderGuardUntil = performance.now() + 250;
    renderAll();
    if (hidden) toast(`Moved into ${hidden}`);
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", (e) => { try { container.releasePointerCapture(e.pointerId); } catch { /* */ } cleanup(); renderAll(); });
  // Esc abandons the drag: nothing has moved yet but the marker, and the repaint refolds what it opened.
  document.addEventListener("keydown", (e) => {
    if (!dragEl || e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try { container.releasePointerCapture(pointerId); } catch { /* */ }
    cleanup();
    reorderGuardUntil = performance.now() + 250;
    renderAll();
  }, true);
}

// Order, membership and nesting are read back from the DOM in one pass, so they cannot drift.
// Projects not on screen (toplevel mode renders a repo as its worktrees) keep their filing.
function saveSidebarArrangement(container: HTMLElement, keepOpen: string[]) {
  const order: string[] = [];
  const of = { ...projGroups.of };
  const parentOf = new Map<string, string | null>();
  // Document order puts a group's token before its members, which is where the rail draws it.
  for (const el of container.querySelectorAll<HTMLElement>(".pgroup, .pfold")) {
    const fold = el.classList.contains("pfold") ? el.dataset.fold : undefined;
    if (fold) {
      order.push(groupToken(fold));
      parentOf.set(fold, el.parentElement?.closest<HTMLElement>(".pfold")?.dataset.fold ?? null);
      continue;
    }
    const path = el.dataset.path;
    if (!path) continue;
    order.push(path);
    const gid = el.closest<HTMLElement>(".pfold")?.dataset.fold;
    if (gid) of[path] = gid; else delete of[path];
  }
  const groups = projGroups.groups.map((g) => ({
    ...g,
    parent: parentOf.has(g.id) ? parentOf.get(g.id)! : g.parent,
    collapsed: keepOpen.includes(g.id) ? false : g.collapsed,
  }));
  setProjOrder(order);
  saveProjOrder();
  setProjGroups({ groups, of });
  saveProjGroups();
}

// External file drops. `dragDropEnabled:true` stops a dropped file navigating the webview to
// its file:// URL, and Tauri's native event carries real absolute paths (HTML5 drops never
// do under WKWebView); they are pasted shell-escaped into the active embedded session.
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
    invoke("write_pty", { sessionId: s.id, data: text }).catch((e) => dlog("warn", `file drop write failed: ${e}`));
    s.term.focus();
    dlog("info", `dropped ${paths.length} path${paths.length === 1 ? "" : "s"} into ${s.id.slice(0, 8)}`);
  }).catch((err) => dlog("error", `onDragDropEvent wiring failed: ${err}`));
}

// Backslash before anything outside the safe set, as a terminal does on file drop.
function shellEscapePath(p: string): string {
  return p.replace(/[^A-Za-z0-9_@%+=:,./-]/g, "\\$&");
}
// A button's chord as a title suffix; empty when unbound or the master switch is off.
function hint(id: KeyAction): string {
  const t = comboText(activeBind(keyPrefs, id), IS_MAC);
  return t ? ` (${t})` : "";
}
// The 44px rail: flat (`projectList()`, not grouped), since it is already the most
// compressed view. Guarded like renderSidebar: it is nothing but buttons, and a rebuild
// between mousedown and mouseup drops the click.
let lastMiniHtml: string | null = null;
export function renderMini() {
  const activeProj = activeId ? sessions.get(activeId)?.project : null;
  const list = projectList();
  // The collapsed rail is the only project surface on screen, so a dashboard marks its button here too.
  const dash = dashHeads(list, dashMirror()?.root ?? null);
  const html =
    `<button class="rm-btn" data-rail="1" title="Expand sidebar${hint("sidebar")}">${icon("panelLeft", "solo")}</button>` +
    list.map((p) => {
      const first = p.sessions[0];
      const firstExt = p.externals[0];
      const attn = p.sessions.some((s) => s.attention || s.phase === "error");
      const sel = first ? `data-sel="${first.id}"`
        : firstExt ? `data-ext="${firstExt.session_id}"`
        : `data-launch="${esc(p.path)}" data-proj="${esc(p.name)}"`;
      const ic = iconFor(p.path);
      const glyph = ic ? `<img class="rm-icon" src="${ic}" alt="" />` : `<span class="rm-dot"></span>`;
      const onCls = p.name === activeProj || dash.has(p.path)
        || (extMirrorId() && p.externals.some((e) => e.session_id === extMirrorId())) ? "on" : "";
      const extOnly = !first && firstExt ? "ext" : "";
      return `<button class="rm-proj ${onCls} ${extOnly}" style="--rc:${p.accent}" title="${esc(p.name)}${extOnly ? " (external)" : ""}" data-key="${esc(p.path)}" ${sel}>${glyph}${attn ? '<span class="rm-badge"></span>' : ""}</button>`;
    }).join("") +
    `<button class="rm-btn rm-add" data-pal="1" title="New session${hint("palette")}">${icon("plus", "solo")}</button>`;
  if (html === lastMiniHtml) return;
  lastMiniHtml = html;
  $("railmini").innerHTML = html;
}
