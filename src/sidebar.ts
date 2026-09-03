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
import { dashHeads, groupedProjects, groupSummary, projectList, type ProjGroup } from "./grouping";
import {
  PEEK_IDLE, peekEnter, peekLeave, peekLeaveAll, peekNextDeadline, peekTick,
  type PeekState,
} from "./peek";
import { groupOf, setCollapsed, type GroupDef } from "./projgroups";
import { dormantRows, foldEmpty, foldHead, groupBody, LIT_COLOR, peekBody } from "./sidebarview";
import {
  activeId, attnPrefs, dashMirror, extMirrorId, FAVORITES, folderDirty, keyPrefs, peekPrefs,
  projGroups,
  saveProjGroups, saveProjOrder, sessions, setProjGroups, setProjOrder, sortMode,
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

export function renderSidebar() {
  if (draggingProjects) return;
  const list = projectList();
  // ./grouping's rule: one repo can be several rows that all open the same dashboard.
  const dash = dashHeads(list, dashMirror()?.root ?? null);
  const html = groupedProjects(list).map((slot) =>
    slot.kind === "project" ? projectHtml(slot.project, dash) : foldHtml(slot.group, slot.projects, dash)).join("");
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
function foldHtml(g: GroupDef, projects: ProjGroup[], dash: Set<string>): string {
  // Not `projects.map(projectHtml)`: map's index argument would be taken for `dash`.
  const body = projects.length ? projects.map((p) => projectHtml(p, dash)).join("") : foldEmpty();
  return `<div class="pfold${g.collapsed ? " collapsed" : ""}" data-fold="${esc(g.id)}">`
    + foldHead(g, groupSummary(projects), projects.length)
    + `<div class="pfbody"><div class="pfbody-in">${body}</div></div></div>`;
}

function projectHtml(p: ProjGroup, dash: Set<string>): string {
  const rows = groupBody(p) + dormantRows(p);
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
    head = `<div class="phead${on}" ${opens} data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}${wtSuffix}</span>${dot}<span class="pcount">${total}</span><span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}">＋</span><span class="parm"></span></div>`;
  } else if (isFav) {
    const tail = p.externals.length ? `<span class="pcount ext">${p.externals.length} ext</span>` : `<span class="plaunch">open →</span>`;
    head = `<div class="phead empty-p${on}" ${opens} data-key="${esc(p.path)}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}</span>${dot}${tail}<span class="premove" data-remove="${esc(p.path)}" title="Remove project">✕</span><span class="parm"></span></div>`;
  } else {
    // discovered via an external session or a shelved one only — not a saved project
    const tail = p.externals.length
      ? `<span class="pcount ext">${p.externals.length} ext</span>`
      : `<span class="pcount ext">${p.dormants.length} shelved</span>`;
    head = `<div class="phead ext-only${on}" ${opens} data-key="${esc(p.path)}" title="${esc(tilde(p.path))}">${projGlyph(p.path, p.accent)}<span class="pname">${esc(p.name)}${wtSuffix}</span>${dot}${tail}<span class="padd" data-launch="${esc(p.path)}" data-proj="${esc(p.name)}" title="Launch an Episko session here">＋</span><span class="parm"></span></div>`;
  }
  return `<div class="pgroup" data-path="${esc(p.path)}">${head}${rows ? `<div class="psessions">${rows}</div>` : ""}${peekBody(p)}</div>`;
}

// Expand the group a project is filed in: ⌘1–9, `nextAfterClose` and the tray can land on
// a session inside a folded group. Persists here because ./panes cannot import ./actions.
export function revealProjGroup(path: string) {
  const gid = groupOf(projGroups, path);
  if (!gid) return;
  const next = setCollapsed(projGroups, gid, false);
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
// Group reordering on pointer events: `dragDropEnabled:true` (for initFileDrop) blocks
// HTML5 drag/drop. Delegated on #projects; a drag starts past DRAG_SLOP so a click still
// selects. The marker goes into the drop target's parent (a `.pgroup` may sit in a
// `.pfold`), and membership is read back off the DOM with the order, so they cannot disagree.
export function initProjectDnD() {
  const container = $("projects");
  const DRAG_SLOP = 5; // px before a press becomes a drag rather than a click
  const marker = document.createElement("div");
  marker.className = "dropmark";
  let dragEl: HTMLElement | null = null;      // the group actually being dragged
  let candidate: HTMLElement | null = null;   // pressed group, promoted to dragEl past the slop
  let startX = 0, startY = 0;

  // A collapsed fold has no visible body to drop into, so its header lights up instead.
  const clearFoldTarget = () => container.querySelector(".pfold.droptarget")?.classList.remove("droptarget");

  const cleanup = () => {
    marker.remove();
    clearFoldTarget();
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
    // A fold header drags the whole group; anything else drags its project (`closest` picks the nearer).
    const g = t.closest<HTMLElement>(".pgroup, .pfold");
    if (!g) return;
    candidate = g;
    startX = e.clientX; startY = e.clientY;
  });

  container.addEventListener("pointermove", (e) => {
    if (!candidate) return;
    if (!dragEl) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP) return;
      dragEl = candidate;
      draggingProjects = true;
      container.classList.add("reordering");
      dragEl.classList.add("dragging");
      try { container.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    e.preventDefault();
    const over = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    let grp = over?.closest<HTMLElement>(".pgroup, .pfold") ?? null;
    const draggingFold = dragEl.classList.contains("pfold");
    // Groups don't nest: a dragged fold aims at the fold under the pointer, never a project in it.
    if (grp && draggingFold) grp = grp.closest<HTMLElement>(".pfold") ?? grp;
    if (!grp || grp === dragEl || dragEl.contains(grp)) return; // a fold over its own members
    clearFoldTarget();
    // Resolving to a fold means its header or an empty body: dropping a project there files
    // it, and is the only way into a group with nothing in it yet.
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
    if (sortMode !== "manual") setSort("manual", false); // a sorted mode would override the drag at once
    // A pointerup may synthesise a click; a timestamp guard self-heals if none fires.
    reorderGuardUntil = performance.now() + 250;
    renderAll();
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", (e) => { try { container.releasePointerCapture(e.pointerId); } catch { /* */ } cleanup(); });
}

// Order and membership are read back from the DOM in one pass, so they cannot drift.
// Projects not on screen (toplevel mode renders a repo as its worktrees) keep their filing.
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
    `<button class="rm-btn" data-rail="1" title="Expand sidebar${hint("sidebar")}">»</button>` +
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
    `<button class="rm-btn rm-add" data-pal="1" title="New session${hint("palette")}">＋</button>`;
  if (html === lastMiniHtml) return;
  lastMiniHtml = html;
  $("railmini").innerHTML = html;
}
