// The guided tour's driver: the veil, the card, the picker and the tick that advances a
// step. ./tour owns the rules (tested); this owns the pixels. It sits above every dialog
// on its own z-index tier, never joins SCRIM_DLGS, and never takes Escape (docs/tour.md).

import { $, IS_MAC } from "./dom";
import { dlog } from "./debug";
import { needsYouSessions } from "./grouping";
import { activeId, FAVORITES, permissionModeFor, sessions } from "./state";
import { hasSessionState } from "./types";
import { providerPermissionMode } from "./providers";
import {
  type Chapter, CHAPTERS, chapterKey, isDone, parseTourState, pickerChapters, planFor,
  recordDone, shouldOfferPicker, shouldOfferRelease, stepApplies, stepBlocked, stepSatisfied,
  TOUR_KEY, type TourActId, type TourNeed, type TourState, type TourStep, type TourWorld,
} from "./tour";

/** Things the tour triggers but does not own. Set from main.ts; see setTourHost. */
export interface TourHost {
  pasteToActive: (text: string) => void;  // type a prompt into the active pane
  openSettingsAt: (tab: string) => void;
  ensure: (need: TourNeed) => void;       // open a collapsed panel before a step lights something in it
  renderAll: () => void;
}
let host: TourHost = {
  pasteToActive: () => {}, openSettingsAt: () => {}, ensure: () => {}, renderAll: () => {},
};
export function setTourHost(h: TourHost) { host = h; }

const STUCK_MS = 20_000;       // a waiting step offers "Skip this step" after this
const PAD = 6;                 // px around a lit element
const CARD_W = 300;
const CARD_W_WIDE = 366;
const GAP = 14;

// ---------- live position in the tour ----------
let plan: Chapter[] = [];      // the chapters this run will walk, in order
let ci = -1;                   // index into `plan`; -1 means nothing is running
// Indexes the chapter's FULL step list, not the `when`-filtered one: a predicate flipping
// would silently renumber the filtered list. The filtered list is for the dots and the count.
let si = 0;
let waitingSince = 0;          // when the current step started waiting; 0 = not waiting
// Has this step been blocked since we arrived? A waiting step advances only on the falling
// edge, so a step already satisfied on arrival shows with Next enabled instead of flashing past.
let armed = false;
let picked = new Set<string>();
let sawPermAnswered = false;   // latched by tourTick; see TourWorld
let hadPerm = false;

// ---------- the store ----------
const read = (): TourState => parseTourState(localStorage.getItem(TOUR_KEY));
function write(st: TourState) {
  try { localStorage.setItem(TOUR_KEY, JSON.stringify(st)); } catch { /* quota; the tour is not worth a toast */ }
}
// Writing anything at all ends the first run; see shouldOfferPicker.
const seed = () => { if (localStorage.getItem(TOUR_KEY) === null) write(read()); };

// ---------- the world a predicate sees ----------
// Read from the DOM where it is the honest source: "is the launcher open" is a class on #wtDlg.
const shown = (id: string) => $(id).classList.contains("show");

function world(): TourWorld {
  const live = [...sessions.values()];
  const act = activeId ? sessions.get(activeId) : null;
  const perm = live.some((s) => !!s.pendingPermId);
  const open: string[] = [];
  if (shown("wtDlg")) open.push("wt");
  if (shown("setDlg")) open.push("settings");
  if (shown("palette")) open.push("palette");
  if (shown("graphDlg")) open.push("graph");
  if ($("ctxMenu").classList.contains("show")) open.push("ctx");
  if ($("runPop").classList.contains("show")) open.push("run");
  if ($("costPop").classList.contains("show")) open.push("cost");
  if ($("usagePop").classList.contains("show")) open.push("usage");

  const stage = !($("dashPane") as HTMLElement).hidden ? "dash"
    : !($("extPane") as HTMLElement).hidden ? "ext"
      : activeId ? "session" : "none";
  const provider = stage === "session" && act?.kind === "agent" ? act.provider ?? "" : "";
  const permission = provider
    ? providerPermissionMode(provider, permissionModeFor(provider))
    : null;

  return {
    projects: FAVORITES.length,
    sessions: live.length,
    phase: act?.phase ?? "",
    // A shell or task pane is a session too, but has none of the inspector's cards.
    agentOnStage: stage === "session" && !!act && hasSessionState(act),
    provider,
    permissionCanAsk: permission?.asks ?? false,
    permPending: perm,
    permAnswered: sawPermAnswered,
    permMode: permission?.id ?? "default", // what new sessions launch with; a Sess carries no mode
    attnCount: needsYouSessions().length,  // the same question #attnBadge renders off
    open,
    settingsTab: shown("setDlg")
      ? document.querySelector<HTMLElement>("#setTabs .set-tab.on")?.dataset.settab ?? ""
      : "",
    stage,
    toolsTab: !!document.querySelector('[data-fmode="tools"].on'),
    caffeinated: $("caf").classList.contains("on"),
  };
}

// ---------- opening ----------

// Called once at boot. Wiring is here rather than at module scope so importing this file
// touches no DOM (`$` throws on a missing element).
export function initTour(): boolean {
  wire();
  if (!shouldOfferPicker(localStorage.getItem(TOUR_KEY))) return false;
  dlog("info", "tour: first run \u2014 offering the picker");
  openWelcome();
  return true;
}

/** The *What's new* hand-off: does this version ship a chapter worth offering? */
export const tourForVersion = (v: string) => shouldOfferRelease(v, read());

/** Play one chapter on its own — Settings › Guide's Replay, and the release intro. */
export function startChapter(id: string) {
  const c = CHAPTERS.find((x) => x.id === id);
  if (!c) return;
  plan = [c]; ci = 0; beginChapterState(); si = firstIndex();
  // Resume where a previous run of this chapter left off (`at`, written by endTour).
  const at = read().at;
  if (at?.ch === c.id) {
    si = Math.min(Math.max(0, at.step), c.steps.length - 1);
    const w0 = world();
    if (!stepApplies(c.steps[si], w0)) { const n = neighbour(si, 1, w0); si = n >= 0 ? n : firstIndex(); }
  }
  seed();
  enter();
}

export function openWelcome() {
  picked = new Set(pickerChapters().filter((c) => c.required).map((c) => c.id));
  ci = -1;
  show();
  renderWelcome();
}

function beginPlan() {
  plan = planFor([...picked]);
  if (!plan.length) { endTour(); return; }
  const st = read();
  write({ ...st, queue: plan.map((c) => c.id) });
  ci = 0; beginChapterState(); si = firstIndex();
  enter();
}

// ---------- walking ----------

function chapter(): Chapter | null { return plan[ci] ?? null; }

// Per-chapter state, cleared wherever a chapter begins. Both latches would otherwise carry
// into the next chapter: a stale `sawPermAnswered` makes its permission step arrive satisfied.
function beginChapterState() {
  seenCh = chapter()?.id ?? "";
  seenIdx.clear();
  sawPermAnswered = false;
  hadPerm = false;
}
function allSteps(): TourStep[] { return chapter()?.steps ?? []; }
// What the dots and the "5 / 8" count: every step that applies now, plus any that applied
// earlier in this chapter, so a live `when` only ever grows the total. The id check covers
// `back()` walking into a chapter that never began.
let seenCh = "";
const seenIdx = new Set<number>();
function counted(w: TourWorld = world()): TourStep[] {
  const c = chapter();
  if (!c) return [];
  if (seenCh !== c.id) { seenCh = c.id; seenIdx.clear(); }
  const out: TourStep[] = [];
  c.steps.forEach((s, i) => { if (stepApplies(s, w)) seenIdx.add(i); if (seenIdx.has(i)) out.push(s); });
  return out;
}
function step(): TourStep | null { return allSteps()[si] ?? null; }
// The next / previous step that applies, or -1. Navigation skips a failed `when`; `si`
// itself never moves under the step on screen.
function neighbour(from: number, dir: 1 | -1, w: TourWorld = world()): number {
  const list = allSteps();
  for (let i = from + dir; i >= 0 && i < list.length; i += dir) if (stepApplies(list[i], w)) return i;
  return -1;
}

function enter() {
  waitingSince = 0;
  show();
  const s = step();
  if (!s) { nextChapter(); return; }
  // Arm from the state we arrive in, not from a later tick that sees the step blocked:
  // that tick may never come.
  armed = stepBlocked(s, world());
  // A collapsed panel is not a missing anchor; open it before anything is measured.
  for (const n of s.needs ?? []) host.ensure(n);
  // A missing or boxless anchor is skipped, deferred a frame because arriving may be what
  // creates the element. Never for a waiting step: its anchor is routinely absent when it
  // opens (the permission step lights buttons Claude has not raised yet); paint() dims
  // centred meanwhile and the STUCK_MS skip is the way out.
  requestAnimationFrame(() => {
    if (ci < 0) return;
    const cur = step();
    if (cur && cur.anchor && !cur.wait && !resolve(cur.anchor)) {
      dlog("warn", `tour: no anchor for "${cur.title}" (${cur.anchor}) — skipping`);
      advance();
      return;
    }
    paint();
  });
  renderStep();
}

function advance() {
  const i = neighbour(si, 1);
  if (i >= 0) { si = i; enter(); return; }
  finishChapter();
}

function back() {
  const i = neighbour(si, -1);
  if (i >= 0) { si = i; enter(); return; }
  if (ci > 0) { ci--; si = lastIndex(); enter(); return; }
  openWelcome();
}

// The first / last step that applies: where entering a chapter lands.
function firstIndex(): number {
  const w = world();
  const i = allSteps().findIndex((s) => stepApplies(s, w));
  return i < 0 ? 0 : i;
}
function lastIndex(): number {
  const list = allSteps(); const w = world();
  for (let i = list.length - 1; i >= 0; i--) if (stepApplies(list[i], w)) return i;
  return 0;
}

function finishChapter() {
  const c = chapter();
  if (c) { write(recordDone(read(), c)); dlog("info", `tour: finished ${chapterKey(c)}`); }
  nextChapter();
}

function nextChapter() {
  if (ci + 1 < plan.length) { ci++; beginChapterState(); si = firstIndex(); enter(); return; }
  ci = -1;
  renderDone();
}

function skipChapter() { finishChapter(); } // still counts as taken; see recordDone

export function endTour() {
  const c = chapter();
  // Leaving mid-chapter remembers where, so Settings › Guide can resume it.
  if (c) write({ ...read(), at: { ch: c.id, step: si } });
  else seed();
  ci = -1;
  hide();
}

// ---------- the tick ----------

// Tick after a gesture the app does not repaint for: opening a dialog, a popover or a
// Settings tab only adds a class, and four steps wait on exactly those. Not a clock: at
// most once a frame, and never while the tour is idle.
let tickQueued = false;
function pokeTick() {
  if (ci < 0 || tickQueued) return;
  tickQueued = true;
  requestAnimationFrame(() => { tickQueued = false; if (ci >= 0) tourTick(); });
}

// Called from `renderAllNow` (like `syncAttn`) and from pokeTick; it needs no clock of its own.
export function tourTick() {
  if (ci < 0) return;

  // Latch "a permission was answered" on the falling edge (`!permPending` is also true before
  // any prompt was raised) and fold it into THIS pass's world: a pass only happens when
  // something changes, so "next tick" may never come.
  const snap = world();
  if (snap.permPending) hadPerm = true;
  else if (hadPerm) { hadPerm = false; sawPermAnswered = true; }
  const w: TourWorld = { ...snap, permAnswered: sawPermAnswered };

  const s = step();
  if (!s) { nextChapter(); return; }

  // Falling edge only: a step already satisfied on arrival shows with Next enabled rather
  // than advancing out from under the card. `armed` tells the two apart.
  if (s.wait) {
    if (stepBlocked(s, w)) { armed = true; if (!waitingSince) waitingSince = Date.now(); }
    else if (armed && stepSatisfied(s, w)) { advance(); return; }
  }
  // Re-render, not just re-measure: the node the hole was measured against is routinely
  // rebuilt, and the card's own content is live.
  renderStep(w);
}

// ---------- painting ----------

function show() { $("tourVeil").classList.add("show"); $("tourCard").classList.add("show"); }
function hide() { $("tourVeil").classList.remove("show"); $("tourCard").classList.remove("show"); }

function resolve(sel: string): HTMLElement | null {
  let el: HTMLElement | null = null;
  try { el = document.querySelector<HTMLElement>(sel); } catch { return null; }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // A hidden pane's children have a zero box; treat that as absent.
  return r.width > 0 && r.height > 0 ? el : null;
}

/** Put the hole on the anchor and the card beside it. Idempotent; called every pass. */
function paint() {
  const s = step();
  const card = $("tourCard");
  const hole = $("tourHole");
  if (!s) { centreHole(hole); return; }

  const el = s.anchor ? resolve(s.anchor) : null;

  if (!el) { centreHole(hole); centreCard(card); return; }
  const r = el.getBoundingClientRect();
  const x = r.left - PAD, y = r.top - PAD, w = r.width + PAD * 2, h = r.height + PAD * 2;
  hole.classList.remove("centre");
  hole.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;

  const cw = card.classList.contains("wide") ? CARD_W_WIDE : CARD_W;
  const chh = card.offsetHeight || 190;
  const vw = window.innerWidth, vh = window.innerHeight;
  let cx: number, cy: number;
  if (x + w + GAP + cw <= vw - 10) { cx = x + w + GAP; cy = y + h / 2 - chh / 2; }
  else if (x - GAP - cw >= 10) { cx = x - GAP - cw; cy = y + h / 2 - chh / 2; }
  // Neither side fits: below, above, or inside near the top. Never clamp to the bottom
  // edge, which covers the terminal's input line.
  else {
    cx = x + w / 2 - cw / 2;
    cy = y + h + GAP + chh <= vh - 10 ? y + h + GAP
      : y - GAP - chh >= 10 ? y - GAP - chh
        : y + GAP;
  }
  card.style.left = Math.round(Math.min(Math.max(10, cx), vw - cw - 10)) + "px";
  card.style.top = Math.round(Math.min(Math.max(10, cy), vh - chh - 10)) + "px";
}

function centreHole(hole: HTMLElement) {
  hole.classList.add("centre");
  hole.style.cssText = `left:${window.innerWidth / 2}px;top:${window.innerHeight / 2}px;width:0;height:0;`;
}
function centreCard(card: HTMLElement) {
  const cw = card.classList.contains("wide") ? CARD_W_WIDE : CARD_W;
  card.style.left = Math.round(window.innerWidth / 2 - cw / 2) + "px";
  card.style.top = Math.round(Math.max(16, window.innerHeight / 2 - (card.offsetHeight || 190) / 2)) + "px";
}

// The manifest cannot read `navigator`, so its chords are written macOS-style and
// rewritten here for display; `{tray}` is the same trick for a word.
const KEYS: [RegExp, string][] = [
  [/\{tray\}/g, IS_MAC ? "menu-bar" : "system-tray"],
  ...(IS_MAC ? [] : ([[/⌘/g, "Ctrl"], [/⇧/g, "Shift"]] as [RegExp, string][])),
];
const keys = (t: string) => KEYS.reduce((a, [re, to]) => a.replace(re, to), t);
// Guarded like every innerHTML surface on renderAll's path: an assignment drops the
// click under the pointer (docs/architecture.md).
let cardHtml = "";
const shell = (cls: string, eyebrow: string, count: string, inner: string) => {
  const card = $("tourCard");
  card.className = `tour-card show ${cls}`;
  const html = `<div class="tc-top"><span class="tc-ch">${eyebrow}</span>`
    + (count ? `<span class="tc-count">${count}</span>` : "")
    + `<button class="tc-x" data-tour="end" title="End the tour" aria-label="End the tour">✕</button></div>${inner}`;
  if (html === cardHtml) return;
  cardHtml = html;
  card.innerHTML = html;
};

function renderWelcome() {
  shell("wide", "Episko", "", `
    <div class="tc-t">Episko, in about three minutes</div>
    <div class="tc-b">Episko launches Claude Code sessions — as many as you like — and watches every one of them for you.
      <br>You will launch a real one. You need a folder with some code in it; <b>a git repo shows the most</b>.</div>
    <div class="tc-foot"><span class="tc-sp"></span>
      <button class="tour-btn" data-tour="end">Not now</button>
      <button class="tour-btn go" data-tour="picker">Choose chapters</button></div>`);
  centreCard($("tourCard"));
  centreHole($("tourHole"));
}

function renderPicker() {
  const st = read();
  const rows = pickerChapters().map((c) => {
    const on = picked.has(c.id);
    const done = isDone(st, c);
    return `<div class="tp-row${c.required ? " req" : on ? " on" : ""}" data-tourpick="${c.id}"
        role="checkbox" tabindex="0" aria-checked="${on || !!c.required}">
      <span class="tp-box">${on || c.required ? "✓" : ""}</span>
      <span class="tp-main"><span class="tp-nm">${c.name}${c.required ? `<span class="tp-req">always</span>` : ""}${done ? `<span class="tp-done">done</span>` : ""}</span>
        <span class="tp-sb">${c.blurb}</span></span>
      <span class="tp-mn">${c.mins}</span></div>`;
  }).join("");
  shell("wide", "Choose your chapters", "", `
    <div class="tc-b">Take one now and the rest whenever. Everything here stays available in <b>Settings › Guide</b>.</div>
    <div class="tp-list">${rows}</div>
    <div class="tc-foot"><span class="tc-sp"></span>
      <button class="tour-btn" data-tour="welcome">Back</button>
      <button class="tour-btn go" data-tour="begin">Start ▸</button></div>`);
  centreCard($("tourCard"));
  centreHole($("tourHole"));
}

function renderDone() {
  const st = read();
  const left = pickerChapters().filter((c) => !isDone(st, c));
  shell("wide", "Episko", "", `
    <div class="tc-t">That's it</div>
    <div class="tc-b">${left.length
      ? `<b>${left.length} chapter${left.length > 1 ? "s" : ""}</b> still waiting whenever you want ${left.length > 1 ? "them" : "it"} — <b>Settings › Guide</b>.<br>`
      : ""}Nothing here opens by itself again. When a release adds something worth showing, <em>What's new</em> will offer a
      short chapter — and you can always say no.</div>
    <div class="tc-foot"><span class="tc-sp"></span>
      <button class="tour-btn" data-tour="guide">Open Settings › Guide</button>
      <button class="tour-btn go" data-tour="end">Done</button></div>`);
  centreCard($("tourCard"));
  centreHole($("tourHole"));
}

// Takes the pass's world: a `world()` built here would not carry the permAnswered latch
// tourTick folded into its snapshot.
function renderStep(w: TourWorld = world()) {
  const c = chapter(); const s = step();
  if (!c || !s) return;
  const blocked = stepBlocked(s, w);
  const stuck = blocked && waitingSince > 0 && Date.now() - waitingSince > STUCK_MS;
  // Position is a lookup, not `si`: the dots count only steps that apply. A step whose
  // `when` has just gone false keeps the first dot.
  const list = counted(w);
  const pos = Math.max(0, list.indexOf(s));
  const dots = list.map((_, i) => `<i class="${i === pos ? "on" : i < pos ? "past" : ""}"></i>`).join("");
  const lastStep = neighbour(si, 1, w) < 0;
  const lastCh = ci === plan.length - 1;
  const nextLabel = !lastStep ? "Next" : lastCh ? "Finish" : "Next chapter ▸";

  shell("", c.name, `${pos + 1} / ${list.length}`, `
    <div class="tc-t">${s.title}</div>
    <div class="tc-b">${keys(s.body)}</div>
    ${blocked ? `<div class="tc-wait"><span class="tc-dot"></span>${s.wait}</div>` : ""}
    ${s.act && blocked ? `<button class="tour-btn go tc-act" data-tour="act">${s.act.label}</button>` : ""}
    <div class="tc-foot"><span class="tc-dots">${dots}</span>
      ${stuck ? `<button class="tour-btn ghost" data-tour="next" title="This step is waiting on something that has not happened">Skip this step</button>` : ""}
      ${s.skip ? `<button class="tour-btn ghost" data-tour="skipch">${s.skip}</button>` : ""}
      <button class="tour-btn" data-tour="back">Back</button>
      <button class="tour-btn go" data-tour="next"${blocked ? " disabled" : ""}>${nextLabel}</button></div>`);
  paint();
}

// ---------- acts ----------
const FIRST_PROMPT = "Run git status and tell me what's uncommitted.";
function runAct(id: TourActId) {
  if (id === "paste-first-prompt") host.pasteToActive(FIRST_PROMPT);
}

// ---------- wiring ----------
// One delegated handler, like main.ts's dispatcher: a branch is reachable only because
// its `data-tour` value is written above.
function wire() {
  $("tourCard").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tour], [data-tourpick]");
    if (!b) return;
    if (b.dataset.tourpick) {
      const c = pickerChapters().find((x) => x.id === b.dataset.tourpick);
      if (!c || c.required) return;                     // the required one is not a choice
      if (picked.has(c.id)) picked.delete(c.id); else picked.add(c.id);
      renderPicker();
      return;
    }
    switch (b.dataset.tour) {
      case "end":     endTour(); break;
      case "welcome": openWelcome(); break;
      case "picker":  renderPicker(); break;
      case "begin":   beginPlan(); break;
      case "next":    advance(); break;
      case "back":    back(); break;
      case "skipch":  skipChapter(); break;
      case "act":     { const s = step(); if (s?.act) runAct(s.act.id); break; }
      case "guide":   endTour(); host.openSettingsAt("guide"); break;
    }
    host.renderAll();
  });
  // Space/Enter on a picker row, so the checkbox role is not a lie.
  $("tourCard").addEventListener("keydown", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>("[data-tourpick]");
    if (!r || (e.key !== " " && e.key !== "Enter")) return;
    e.preventDefault();
    r.click();
  });
  // Capture phase on the document, so a gesture that opens something is seen however the
  // target handles it; `contextmenu` because the project menu opens on a right-click.
  for (const ev of ["click", "contextmenu", "keydown"]) {
    document.addEventListener(ev, pokeTick, true);
  }
  // A resize moves anchors with no state change, so renderAll cannot catch it.
  window.addEventListener("resize", () => { if (ci >= 0) paint(); });
}
