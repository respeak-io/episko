import { tilde } from "./format";
import { icon } from "./svgicons";

// Static ids from index.html only: a miss is a typo and should throw here.
export const $ = (id: string) => document.getElementById(id)!;

let toastT: number | undefined; // one element: a second toast replaces the first rather than stacking
export function toast(m: string) { const el = $("toast"); el.textContent = m; el.classList.add("show"); clearTimeout(toastT); toastT = window.setTimeout(() => el.classList.remove("show"), 1900); }

export interface ToastAction { label: string; run: () => void; danger?: boolean }

// A toast you can act on: longer-lived, paused while the pointer is on it, and built with
// textContent so a process name can never become markup. One at a time, like `toast`.
let actT: number | undefined;
export function actToast(m: string, actions: ToastAction[] = [], ms = 9000) {
  const el = $("actToast");
  const hide = () => { clearTimeout(actT); el.classList.remove("show"); };
  const arm = () => { clearTimeout(actT); actT = window.setTimeout(hide, ms); };
  const msg = document.createElement("span");
  msg.className = "at-msg";
  msg.textContent = m;
  const btns = actions.map((a) => {
    const b = document.createElement("button");
    b.className = a.danger ? "at-btn danger" : "at-btn";
    b.textContent = a.label;
    b.onclick = () => { hide(); a.run(); };
    return b;
  });
  const x = document.createElement("button");
  x.className = "at-x";
  x.title = "Dismiss";
  x.setAttribute("aria-label", "Dismiss");
  x.innerHTML = icon("x", "solo");
  x.onclick = hide;
  el.replaceChildren(msg, ...btns, x);
  el.onmouseenter = () => clearTimeout(actT);
  el.onmouseleave = arm;
  el.classList.add("show");
  arm();
}

// Overlays sharing #scrim; the last one to close clears it. ./confirm has its own
// backdrop and must stay off this list.
const SCRIM_DLGS = ["palette", "wtDlg", "diffDlg", "expDlg", "graphDlg", "setDlg", "usageDlg", "projDlg", "histDlg", "callDlg", "qDlg", "mdDlg", "handoffDlg"];
export function dropScrim() {
  if (!SCRIM_DLGS.some((id) => $(id).classList.contains("show"))) $("scrim").classList.remove("show");
}

export type Stage = "session" | "ext" | "dash" | "fleet" | "review" | "home"; // ext: the read-only mirror, external or dormant
export let stageGen = 0; // bumped per handover; an #inspector paint cache is valid within one tenancy
// `home` is the all-projects dashboard: with no session and no mirror the stage shows every
// project rather than a card saying nothing is running. main.ts wires it, since dom.ts must
// import nothing — and "nothing on the stage" is therefore not a state this app can reach.
let home: () => void = () => {};
export function setStageHome(fn: () => void) { home = fn; }
// Every handover schedules a full paint, which is where ./nav's history records it (main.ts).
let moved: () => void = () => {};
export function setStageMoved(fn: () => void) { moved = fn; }
// A flow that closes a pane, awaits, then stages its replacement holds history across the
// await, so the neighbour the close fell to is never recorded. Release is idempotent.
let navHold = 0;
export const navHeld = () => navHold > 0;
export function holdNav(): () => void {
  navHold++;
  let done = false;
  return () => { if (!done) { done = true; navHold--; moved(); } };
}
// The only code that may touch #extPane/#dashPane/#fleetPane/#reviewPane (the stage has one owner).
export function takeStage(show: Stage) {
  stageGen++;
  moved();
  if (show === "home") { home(); return; }
  ($("extPane") as HTMLElement).hidden = show !== "ext";
  ($("dashPane") as HTMLElement).hidden = show !== "dash";
  ($("fleetPane") as HTMLElement).hidden = show !== "fleet";
  ($("reviewPane") as HTMLElement).hidden = show !== "review";
  // These stages own the whole width: the inspector column collapses to 0 rather than to a rail.
  $("app").classList.toggle("stage-dash", show === "dash");
  $("app").classList.toggle("stage-fleet", show === "fleet");
  $("app").classList.toggle("stage-review", show === "review");
}

// ⌘I on the dashboard folds the third column instead of an inspector it does not have.
export function foldDashNext(): boolean { return $("dashPane").classList.toggle("fold-next"); }
// Its Maintenance tab hides that column, so there ⌘I has nothing to fold. ./dashboard sets the class.
export const dashOnMaint = (): boolean => $("dashPane").classList.contains("tab-maint");

// The stage header's path: shown `~`-shortened and copied in full, so every stage taker
// hands over the absolute one and the click never re-derives it from the label. The
// attribute is the affordance too — styles.css hangs the cursor and hover off it.
export function setHeadPath(abs: string) {
  const el = $("hPath");
  el.textContent = tilde(abs);
  el.title = abs ? `${abs}\nClick to copy` : "";
  if (abs) el.dataset.abs = abs; else delete el.dataset.abs;
}

// One tooltip for the whole app, anchored to the control rather than the cursor: a button's
// tip should sit still while you read it. ./usagedlg keeps its own cursor-following one, which
// is a different job — it labels a point on a heatmap, not a control.
const TIP_MS = 320;
const WARM_MS = 500; // the next tip within this opens at once, as a toolbar's do
let tipEl: HTMLElement | null = null;
let tipTimer: ReturnType<typeof setTimeout> | undefined;
let tipFor: Element | null = null; // the control under the pointer, its tip shown or waiting
let tipText = "";
let warmUntil = 0;
let px = 0, py = 0;
let quietAt: [number, number] | null = null; // a click, key or wheel put it away: not back until the pointer moves on

// The browser picks a `title` to draw after the mouse event that reached it is dispatched, so
// lifting it into `data-tip` here, ancestors too, is in time: every title is this tip instead.
function claimTitles(from: Element | null) {
  for (let n = from?.closest("[title]") ?? null; n; n = n.parentElement?.closest("[title]") ?? null) {
    const t = n.getAttribute("title")!;
    n.removeAttribute("title");
    n.setAttribute("data-tip", t);
    // An icon's title was its only name; a screen reader keeps it.
    if (t && !n.hasAttribute("aria-label") && !n.textContent?.trim()) n.setAttribute("aria-label", t.split("\n")[0]);
  }
}

const tipShown = () => !!tipEl && !tipEl.hidden;

function hideTip(warm: boolean) {
  clearTimeout(tipTimer);
  tipTimer = undefined;
  if (!tipShown()) return;
  tipEl!.hidden = true;
  if (warm) warmUntil = performance.now() + WARM_MS;
}

function placeTip() {
  const b = tipFor!.getBoundingClientRect();
  if (!b.width && !b.height) { hideTip(false); return; }
  tipEl!.textContent = tipText;
  tipEl!.hidden = false;
  const t = tipEl!.getBoundingClientRect();
  // Above by default, below when there is no room, clamped to the window. A row or a card is too
  // tall to sit beside, so its tip goes by the pointer.
  const tall = b.height > 48, top = tall ? py - 12 : b.top, bottom = tall ? py + 20 : b.bottom;
  const mid = tall ? px : b.left + b.width / 2;
  const y = top - t.height - 8 >= 4 ? top - t.height - 8 : Math.min(bottom + 8, innerHeight - t.height - 4);
  tipEl!.style.top = `${Math.max(4, y)}px`;
  tipEl!.style.left = `${Math.max(6, Math.min(innerWidth - t.width - 6, mid - t.width / 2))}px`;
}

function showTip() {
  tipTimer = undefined;
  if (!tipFor?.isConnected || !tipText) return;
  if (!tipEl) {
    tipEl = Object.assign(document.createElement("div"), { className: "tip", hidden: true });
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  placeTip();
}

function trackTip(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  claimTitles(el);
  const host = el?.closest("[data-tip]") ?? null, text = host?.getAttribute("data-tip") ?? "";
  if (host === tipFor && text === tipText) return;
  const still = !!quietAt && Math.abs(px - quietAt[0]) + Math.abs(py - quietAt[1]) < 6;
  if (!still) quietAt = null;
  // The same control with new words, or its twin after a repaint: no blink and no second wait.
  if (host && tipFor && (host === tipFor || text === tipText)) {
    tipFor = host;
    tipText = text;
    if (tipShown()) { if (text) placeTip(); else hideTip(false); }
    else if (text && !tipTimer && !still) tipTimer = setTimeout(showTip, TIP_MS);
    return;
  }
  const warm = tipShown() || performance.now() < warmUntil;
  tipFor = host;
  tipText = text;
  if (still || !host || !text) { hideTip(true); return; }
  if (tipShown()) { placeTip(); return; } // straight from one tip to the next, with no fade between
  clearTimeout(tipTimer);
  if (warm) showTip(); else tipTimer = setTimeout(showTip, TIP_MS);
}

// Wired from main.ts, never at module scope: vitest runs in the node environment and any module
// a test can reach must not touch `document` on import (CLAUDE.md's rule; dom.ts is reached by
// nearly everything).
export function wireTips() {
  const at = (e: MouseEvent) => { px = e.clientX; py = e.clientY; };
  document.addEventListener("mouseover", (e) => { at(e); trackTip(e.target); }, true);
  // A repaint may set a title again under a pointer that is still: take it before the next move draws it.
  document.addEventListener("mousemove", (e) => {
    at(e);
    if (e.target instanceof Element && e.target.closest("[title]")) trackTip(e.target);
  }, true);
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) { hideTip(false); tipFor = null; tipText = ""; } }, true);
  // Any of these moves the control out from under the tip, so it must not outlive them.
  const quiet = () => { hideTip(false); quietAt = [px, py]; };
  for (const ev of ["pointerdown", "wheel", "keydown"]) document.addEventListener(ev, quiet, { capture: true, passive: true });
  window.addEventListener("blur", () => hideTip(false));
}

const FOCUSABLE = "button, a[href], [tabindex]";
const mtKey = (el: HTMLElement) => JSON.stringify(Object.entries(el.dataset).filter(([k]) => k.startsWith("mt")).sort());
const barKey = (b: HTMLElement) => b.closest<HTMLElement>("[data-mtroot]")?.dataset.mtroot ?? "";
// A board, or a place a view marks: what a repaint keeps where it was on screen.
const PLACES = "[id^='mtb-'], [data-place]";
const placeKey = (p: Element) => p.id || (p as HTMLElement).dataset.place || "";
function scrollerOf(n: Element): HTMLElement | null {
  for (let x = n.parentElement; x; x = x.parentElement) {
    const o = getComputedStyle(x).overflowY;
    if ((o === "auto" || o === "scroll") && x.scrollHeight > x.clientHeight) return x;
  }
  return null;
}
// What the person is looking at: the place around the control they used while it is in view, else the
// first place that starts in view, else the one the view's top falls inside.
function lookedAt(el: HTMLElement, used: Element | null): { key: string; top: number } | null {
  const all = [...el.querySelectorAll(PLACES)], s = all.length ? scrollerOf(all[0]) : null;
  if (!s) return null;
  const v = s.getBoundingClientRect();
  const seen = (p: Element) => { const r = p.getBoundingClientRect(); return r.bottom > v.top && r.top < v.bottom; };
  const mine = used?.closest(PLACES);
  const p = mine && el.contains(mine) && seen(mine) ? mine : all.find((x) => seen(x) && x.getBoundingClientRect().top >= v.top) ?? all.find(seen);
  return p ? { key: placeKey(p), top: p.getBoundingClientRect().top } : null;
}

const MOVING = ".u-spin, .u-skel, .u-skelbar, .db-sk";
/** `el.innerHTML = html` without restarting what moves in it: a scan's bar glides on from the width it had,
 *  and a spinner or shimmer runs on the document's clock, so its replacement turns on from the same angle. */
export function rewriteMoving(el: HTMLElement, html: string): void {
  const bars = new Map([...el.querySelectorAll<HTMLElement>(".mt-pbar > i")].map((b) => [barKey(b), b.style.width]));
  el.innerHTML = html;
  for (const b of el.querySelectorAll<HTMLElement>(".mt-pbar > i")) {
    const from = bars.get(barKey(b)), to = b.style.width;
    if (!from || from === to) continue;
    b.style.width = from;
    void b.offsetWidth;
    b.style.width = to;
  }
  // Only a running one: setting a paused one's start would play it, past fx-idle's pause.
  for (const n of el.querySelectorAll(MOVING)) for (const a of n.getAnimations()) if (a.playState === "running") a.startTime = 0;
}

/** Write a Maintenance surface, whose `innerHTML` rebuilds every control and every scroller. The keyboard
 *  goes to the same control's successor, or, for a button that became *checking…*, to whatever stands where
 *  it stood (only if it got there by keyboard: a mouse has no use for a neighbour). A wide table keeps its place,
 *  and so does what is on screen when something lands above it; `keep` false is a new tab, read from its top. */
export function holdMaintPlace(el: HTMLElement, html: string, keep = true): void {
  const a = document.activeElement, on = a instanceof HTMLElement && a !== el && el.contains(a) && !(a instanceof HTMLInputElement) ? a : null;
  const key = on && mtKey(on), at = on ? [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].indexOf(on) : -1, typed = !!on?.matches(":focus-visible");
  const boardOf = (s: Element) => s.closest("[id^='mtb-']")?.id ?? "";
  const wide = [...el.querySelectorAll(".mt-scroll")].filter((s) => s.scrollLeft).map((s) => [boardOf(s), s.scrollLeft] as const);
  // The fleet's scroller is inside what is rewritten, so its offset goes back first and the place corrects it.
  const top = keep ? el.querySelector(".mt-body")?.scrollTop ?? 0 : 0;
  const was = keep ? lookedAt(el, a instanceof Element && el.contains(a) ? a : null) : null;
  rewriteMoving(el, html);
  const body = top ? el.querySelector(".mt-body") : null;
  if (body) body.scrollTop = top;
  const now = was && [...el.querySelectorAll(PLACES)].find((p) => placeKey(p) === was.key), s = now && scrollerOf(now);
  if (now && s) s.scrollTop += now.getBoundingClientRect().top - was.top;
  for (const [id, left] of wide) for (const s of el.querySelectorAll(".mt-scroll")) if (boardOf(s) === id) s.scrollLeft = left;
  if (!on) return;
  const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const next = (key !== "[]" ? all.find((x) => mtKey(x) === key) : undefined) ?? (typed ? all[Math.min(at, all.length - 1)] : undefined);
  next?.focus({ preventScroll: true });
}

// The avatar and the chip line belong to the project dashboard; every other stage taker clears
// them, or the header keeps the last project's face over somebody else's session.
export function clearStageBadges() {
  const av = $("hAvatar");
  av.innerHTML = "";
  av.style.background = "";
  $("hChips").innerHTML = "";
}

// MOD and chord are display only; handlers accept both modifiers.
const UA = typeof navigator === "undefined" ? "" : navigator.userAgent; // vitest's node env has no navigator
export const IS_MAC = UA.includes("Mac");
export const IS_WIN = UA.includes("Windows");
// A dev build also opens in a plain browser tab, where native-window verbs only throw.
export const IS_TAURI = typeof window !== "undefined" && "isTauri" in window; // set before any page script

export const MOD = IS_MAC ? "⌘" : "Ctrl";
export const FILE_MANAGER = IS_WIN ? "Explorer" : IS_MAC ? "Finder" : "file manager";
// The OS emoji picker, where there is one to name: Linux has no single answer (the chord is
// the desktop's or the input method's), so the caller drops the sentence rather than guess.
export const EMOJI_PICKER_KEY = IS_WIN ? "Win + ." : IS_MAC ? "⌃⌘Space" : "";
export const chord = (k: string) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);
