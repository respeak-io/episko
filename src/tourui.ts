// The guided tour's driver: the veil, the card, the picker, and the one tick that
// advances a step. ./tour owns every rule and is tested; this owns the pixels, and is
// untested by design like every other DOM-owning module here.
//
// THREE THINGS THIS HAS TO GET RIGHT.
//
// 1. **The hole is real.** The veil is `pointer-events: none` and the dark is a single
//    `box-shadow: 0 0 0 9999px` spreading out of one small rounded div, so the lit
//    control is the *live* control — the user genuinely presses `＋ Session` and
//    genuinely answers the permission. Nothing is simulated, which is the whole reason
//    the interactive half teaches anything.
//
// 2. **It is not on the shared #scrim.** The tour lights things *inside* the
//    new-session dialog, the project context menu and Settings, so it has to sit above
//    all three and coexist with them. It gets its own z-index tier and never joins
//    SCRIM_DLGS, so `dropScrim()` stays a question only dialogs answer.
//
// 3. **Nothing can strand the user.** A step whose anchor is missing (or is present but
//    has no box, which is what a hidden pane looks like) is stepped over and logged
//    rather than lighting a hole over nothing — this feature's version of the dead
//    `[data-*]` branch. And a waiting step grows a quiet "Skip this step" after
//    STUCK_MS, because a predicate can always be unsatisfiable on somebody's machine.
//
// It never binds a chord and never takes Escape: Escape backs out of whichever dialog
// is open — nine bindings, not one action — and those dialogs are *under* the tour.

import { $, IS_MAC } from "./dom";
import { dlog } from "./debug";
import { needsYouSessions } from "./grouping";
import { activeId, FAVORITES, permMode, sessions } from "./state";
import { isAgent } from "./types";
import {
  type Chapter, CHAPTERS, chapterKey, isDone, parseTourState, pickerChapters, planFor,
  recordDone, shouldOfferPicker, shouldOfferRelease, stepApplies, stepBlocked, stepSatisfied,
  TOUR_KEY, type TourActId, type TourNeed, type TourState, type TourStep, type TourWorld,
} from "./tour";

/** Things the tour triggers but does not own. Set from main.ts; see setTourHost. */
export interface TourHost {
  /** Type a prompt into the active pane, as though the user had. */
  pasteToActive: (text: string) => void;
  /** Open the settings window on a given tab (the Guide tab's Replay lands back here). */
  openSettingsAt: (tab: string) => void;
  /**
   * Make sure a collapsed panel is open before a step lights something inside it.
   *
   * The tour lights *real* controls, so a control the user has collapsed away is not a
   * missing anchor to step over — the permission buttons and every Context card live in
   * the inspector (⌘I), the project rows and their ＋ live in the rail (⌘B). Opening the
   * panel is what a user would do; skipping the step would teach nothing.
   */
  ensure: (need: TourNeed) => void;
  renderAll: () => void;
}
let host: TourHost = {
  pasteToActive: () => {}, openSettingsAt: () => {}, ensure: () => {}, renderAll: () => {},
};
export function setTourHost(h: TourHost) { host = h; }

/** How long a waiting step goes unsatisfied before it offers a way past itself. */
const STUCK_MS = 20_000;
/** Breathing room around a lit element, in px. */
const PAD = 6;
const CARD_W = 300;
const CARD_W_WIDE = 366;
const GAP = 14;

// ---------- live position in the tour ----------
let plan: Chapter[] = [];      // the chapters this run will walk, in order
let ci = -1;                   // index into `plan`; -1 means nothing is running
// Index into the chapter's FULL step list, not its visible one. A `when` predicate is
// evaluated live on every pass (that is the only way "only while the badge is on
// screen" can work), and an index into the filtered list would silently renumber every
// step after one that flipped — advancing past a step, or replaying one, with nothing
// on screen to explain it. The filtered list is for the dots and the count.
let si = 0;
let waitingSince = 0;          // when the current step started waiting; 0 = not waiting
/**
 * Has this step been blocked at any point since we arrived at it?
 *
 * A waiting step only advances on the **falling edge**, exactly like the permission
 * latch below. Arriving at a step whose condition is already true (every replay from
 * Settings › Guide, and the badge step when the permission is still up) used to
 * auto-advance on the first tick: the card flashed and the lesson went past unread.
 * Now an already-satisfied step simply shows with Next enabled.
 */
let armed = false;
let picked = new Set<string>();
/** Set the first time a permission is answered while the tour runs; see TourWorld. */
let sawPermAnswered = false;
let hadPerm = false;

export const tourRunning = () => ci >= 0 || $("tourCard").classList.contains("show");

// ---------- the store ----------
const read = (): TourState => parseTourState(localStorage.getItem(TOUR_KEY));
function write(st: TourState) {
  try { localStorage.setItem(TOUR_KEY, JSON.stringify(st)); } catch { /* quota; the tour is not worth a toast */ }
}
/** Writing anything at all is what makes this no longer a first run — see shouldOfferPicker. */
const seed = () => { if (localStorage.getItem(TOUR_KEY) === null) write(read()); };

// ---------- the world a predicate sees ----------
// Read from the DOM rather than from module state wherever the DOM is the honest
// source: "is the launcher open" is a class on #wtDlg, and asking the element cannot
// drift from what the user is looking at.
const shown = (id: string) => $(id).classList.contains("show");

function world(): TourWorld {
  const live = [...sessions.values()];
  const act = activeId ? sessions.get(activeId) : null;
  const perm = live.some((s) => !!s.pendingPermId);
  // Latch the answer: `permPending` going false is not evidence on its own — it is also
  // false before the first prompt ever appears, which would let the step advance the
  // instant it opened. See the `hadPerm` transition in tick().
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

  return {
    projects: FAVORITES.length,
    sessions: live.length,
    phase: act?.phase ?? "",
    // A shell pane and a task pane are sessions too, and neither has any of the cards
    // the inspector chapter is about — so this is `isAgent` and a stage check, not
    // "is there a session".
    agentOnStage: stage === "session" && !!act && isAgent(act),
    permPending: perm,
    permAnswered: sawPermAnswered,
    // The preference new sessions launch with, which is the one the session this
    // chapter just started is running under. A `Sess` does not carry its own mode, and
    // this is the honest answer for the only session the tour is ever about.
    permMode,
    // Straight from the function the badge itself renders off, rather than a second
    // opinion about what "needs you" means: a step that lights `#attnBadge` has to ask
    // the same question the element does or it lights a `display:none` box.
    attnCount: needsYouSessions().length,
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

/**
 * Called once at boot: wires the card, then offers the picker on a genuine first run.
 *
 * The wiring lives here rather than at module scope so importing this file touches no
 * DOM — `$` throws on a missing element by design, and an import-time listener would
 * make the module's order in main.ts load-bearing.
 */
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
  plan = [c]; ci = 0; si = firstIndex();
  // Left mid-chapter last time? Pick it back up where it stopped. That is the whole
  // point of `at`, which until now was written on every exit and read by nothing — the
  // Guide row says "Resume" on the strength of it.
  const at = read().at;
  if (at?.ch === c.id) {
    si = Math.min(Math.max(0, at.step), c.steps.length - 1);
    if (!stepApplies(c.steps[si], world())) { const n = neighbour(si, 1); si = n >= 0 ? n : firstIndex(); }
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
  ci = 0; si = firstIndex();
  enter();
}

// ---------- walking ----------

function chapter(): Chapter | null { return plan[ci] ?? null; }
/** Every step in the chapter, `when` or no `when` — what `si` indexes. */
function allSteps(): TourStep[] { return chapter()?.steps ?? []; }
/**
 * What the dots and the "5 / 8" are drawn from: everything that applies now, **plus
 * anything that applied earlier in this chapter**.
 *
 * A live `when` otherwise moves the denominator both ways — the reactor step appears
 * when the permission lands and leaves again when it is answered, so the counter read
 * "5 / 8" and then "6 / 7", which looks like the tour losing its place rather than a
 * step ending. Remembering what has applied makes the total only ever grow.
 */
let seenCh = "";
const seenIdx = new Set<number>();
function counted(): TourStep[] {
  const c = chapter();
  if (!c) return [];
  if (seenCh !== c.id) { seenCh = c.id; seenIdx.clear(); }
  const w = world();
  const out: TourStep[] = [];
  c.steps.forEach((s, i) => { if (stepApplies(s, w)) seenIdx.add(i); if (seenIdx.has(i)) out.push(s); });
  return out;
}
function step(): TourStep | null { return allSteps()[si] ?? null; }
/**
 * The next / previous step that applies, or -1.
 *
 * Navigation is what skips a `when` that fails, rather than the index doing it: `si`
 * points into the full list, so a predicate flipping while a step is on screen changes
 * what comes next and never what you are looking at.
 */
function neighbour(from: number, dir: 1 | -1): number {
  const list = allSteps(); const w = world();
  for (let i = from + dir; i >= 0 && i < list.length; i += dir) if (stepApplies(list[i], w)) return i;
  return -1;
}

/** Enter the current step: reset the wait clock, open what it needs, paint. */
function enter() {
  waitingSince = 0;
  show();
  const s = step();
  if (!s) { nextChapter(); return; }
  // Arm HERE, from the state we are arriving in, and not from the first tick that sees
  // the step blocked — because that tick may never come. A step is usually entered from
  // inside `tourTick` (the change that satisfied the step before it), and nothing else
  // then happens until the change that satisfies THIS one, which arrives already
  // satisfied and would look exactly like "it was satisfied when I got here". Same
  // no-clock trap as the permission latch below, one level up.
  armed = stepBlocked(s, world());
  // Before anything is measured: a panel the user has collapsed is not a missing
  // anchor, it is a panel to open (⌘I takes the whole inspector, and with it the
  // permission buttons; ⌘B takes the rail, and with it every project row).
  for (const n of s.needs ?? []) host.ensure(n);
  // A missing (or boxless) anchor never freezes the tour. Deferred a frame because
  // arriving at the step may itself be what causes the element to exist.
  //
  // **Only for a step that is not waiting on anything.** A waiting step's anchor is
  // routinely absent the moment it opens — that is the whole point of it: the
  // permission step lights `.attn-btns`, which Claude has not raised yet. Skipping it
  // for "no anchor" would step straight over the single most important card in the
  // tour, exactly when it is doing its job. (It did, before this condition existed.)
  // While it waits, `paint()` falls back to a centred dim, and the 20s "Skip this
  // step" affordance is the way out if the element never appears at all.
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

/** The first / last step of a chapter that applies at all — where entering it lands. */
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

/** Mark the chapter done and move to the next one the user picked. */
function finishChapter() {
  const c = chapter();
  if (c) { write(recordDone(read(), c)); dlog("info", `tour: finished ${chapterKey(c)}`); }
  nextChapter();
}

function nextChapter() {
  if (ci + 1 < plan.length) { ci++; si = firstIndex(); enter(); return; }
  ci = -1;
  renderDone();
}

/** Skip the rest of this chapter — it still counts as taken; see recordDone. */
function skipChapter() { finishChapter(); }

export function endTour() {
  const c = chapter();
  // Leaving mid-chapter is not the same as finishing it: remember where, so the next
  // launch from Settings › Guide can resume rather than restart.
  if (c) write({ ...read(), at: { ch: c.id, step: si } });
  else seed();
  ci = -1;
  hide();
}

// ---------- the tick ----------

/**
 * Tick after a user gesture the app does not repaint for.
 *
 * `tourTick` hangs off `renderAllNow` because *most* of what the tour reacts to ends in
 * a `renderAll()` — a session, a phase, a permission, a stage change. **A dialog does
 * not**: `openWt`, `openCostPop`, `openCtxMenu` and the Settings tab switch all just add
 * a class, and four steps wait on exactly those. They sat on a satisfied condition until
 * some unrelated poller happened to repaint, which reads as a click doing nothing.
 *
 * Still not a clock: it fires on the gestures the user is making anyway, at most once a
 * frame, and not at all while the tour is idle.
 */
let tickQueued = false;
function pokeTick() {
  if (ci < 0 || tickQueued) return;
  tickQueued = true;
  requestAnimationFrame(() => { tickQueued = false; if (ci >= 0) tourTick(); });
}

/**
 * Called from `renderAllNow`, exactly like `syncAttn()` — and from `pokeTick` above for
 * the gestures that repaint nothing. Either way it needs no clock of its own: a
 * telemetry burst from ten sessions still costs one evaluation, and nothing leaks.
 */
export function tourTick() {
  if (ci < 0) return;

  // Latch "a permission was answered" on the falling edge, so the step that waits for
  // it cannot be satisfied by the state that existed before one was ever raised.
  //
  // The latch is folded into the snapshot rather than left to the next pass, and that
  // ordering is the whole of it: `permAnswered` is a field OF the world, so flipping it
  // after `world()` had already read it would leave this tick's predicate looking at the
  // previous value. There is no clock here — a pass only happens when something changes
  // — so "it will be right next tick" can mean a tick that never comes, and the most
  // important step in the tour would sit on a satisfied condition doing nothing. It did.
  const snap = world();
  if (snap.permPending) hadPerm = true;
  else if (hadPerm) { hadPerm = false; sawPermAnswered = true; }
  const w: TourWorld = { ...snap, permAnswered: sawPermAnswered };

  const s = step();
  if (!s) { nextChapter(); return; }

  // The falling edge, and only the falling edge. A step that is already satisfied when
  // you arrive at it (a replay from Settings › Guide, the badge step while the
  // permission it is about is still up) must not advance out from under the card that
  // has just appeared — it shows with Next enabled instead, and the user leaves it when
  // they have read it. `armed` is what tells the two apart.
  if (s.wait) {
    if (stepBlocked(s, w)) { armed = true; if (!waitingSince) waitingSince = Date.now(); }
    else if (armed && stepSatisfied(s, w)) { advance(); return; }
  }
  // Re-render every pass, not just re-measure: the sidebar, the inspector and the
  // footer are all rebuilt from scratch under us (so the node the hole was measured
  // against is routinely gone), and the card's own content is live too — a satisfied
  // wait drops its chip, and the stuck affordance appears on a clock.
  renderStep();
}

// ---------- painting ----------

function show() { $("tourVeil").classList.add("show"); $("tourCard").classList.add("show"); }
function hide() { $("tourVeil").classList.remove("show"); $("tourCard").classList.remove("show"); }

function resolve(sel: string): HTMLElement | null {
  let el: HTMLElement | null = null;
  try { el = document.querySelector<HTMLElement>(sel); } catch { return null; }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // A hidden pane's children are in the DOM with a zero box. Treat that as absent:
  // a 0×0 hole is a hole over nothing, which is the failure this guards.
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
  // Neither side fits. Below it, above it, or — when the hole is a whole pane and
  // there is no outside left — *inside* it, near the top. Clamping to the bottom edge
  // (which is what this did) put the card over the terminal's input line: the one row
  // the step was asking the user to type into.
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

// The manifest is a logic module and cannot read `navigator`, so the chords in it are
// written macOS-style and rewritten here. Display only — every handler already
// accepts both modifiers.
// `{tray}` is the same trick for a word rather than a glyph: the thing it names is a
// menu bar on one OS and a system tray on the other.
const KEYS: [RegExp, string][] = [
  [/\{tray\}/g, IS_MAC ? "menu-bar" : "system-tray"],
  ...(IS_MAC ? [] : ([[/⌘/g, "Ctrl"], [/⇧/g, "Shift"]] as [RegExp, string][])),
];
const keys = (t: string) => KEYS.reduce((a, [re, to]) => a.replace(re, to), t);
const shell = (cls: string, eyebrow: string, count: string, inner: string) => {
  const card = $("tourCard");
  card.className = `tour-card show ${cls}`;
  card.innerHTML = `<div class="tc-top"><span class="tc-ch">${eyebrow}</span>`
    + (count ? `<span class="tc-count">${count}</span>` : "")
    + `<button class="tc-x" data-tour="end" title="End the tour" aria-label="End the tour">✕</button></div>${inner}`;
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

function renderStep() {
  const c = chapter(); const s = step();
  if (!c || !s) return;
  const w = world();
  const blocked = stepBlocked(s, w);
  const stuck = blocked && waitingSince > 0 && Date.now() - waitingSince > STUCK_MS;
  // The dots count the steps that apply, and `si` indexes all of them — so the position
  // is a lookup, not the index. A step standing on a `when` that has just gone false is
  // not in the list at all; it keeps the first dot rather than losing the row.
  const list = counted();
  const pos = Math.max(0, list.indexOf(s));
  const dots = list.map((_, i) => `<i class="${i === pos ? "on" : i < pos ? "past" : ""}"></i>`).join("");
  const lastStep = neighbour(si, 1) < 0;
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
// One delegated handler on the card, mirroring main.ts's own dispatcher: every branch
// below is reachable only because its `data-tour` value is written above, and the two
// halves are short enough to read side by side.
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
  // Capture phase, and on the document, so a gesture that opens something is seen
  // however the target handles it — and `contextmenu` is here because the project menu
  // (a whole chapter's first step) opens on a right-click, which fires no click at all.
  for (const ev of ["click", "contextmenu", "keydown"]) {
    document.addEventListener(ev, pokeTick, true);
  }
  // A window resize is the one thing that moves an anchor without any state changing,
  // so it is the one case `renderAll` cannot catch for us.
  window.addEventListener("resize", () => { if (ci >= 0) paint(); });
}
