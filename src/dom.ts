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
let tipEl: HTMLElement | null = null;
let tipTimer: ReturnType<typeof setTimeout> | null = null;

function hideTip() {
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
  if (tipEl) tipEl.hidden = true;
}

function showTip(host: HTMLElement) {
  if (!tipEl) {
    tipEl = Object.assign(document.createElement("div"), { className: "tip", hidden: true });
    document.body.appendChild(tipEl);
  }
  const text = host.dataset.tip ?? "";
  if (!text) return;
  tipEl.textContent = text;
  tipEl.hidden = false;
  const r = host.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  // Above by default, below when there is no room; clamped so a tip on a first-column button
  // cannot run off the left edge.
  const above = r.top - t.height - 8 >= 4;
  tipEl.style.top = `${above ? r.top - t.height - 8 : r.bottom + 8}px`;
  tipEl.style.left = `${Math.max(6, Math.min(window.innerWidth - t.width - 6, r.left + r.width / 2 - t.width / 2))}px`;
}

// Wired from main.ts, never at module scope: vitest runs in the node environment and any module
// a test can reach must not touch `document` on import (CLAUDE.md's rule; dom.ts is reached by
// nearly everything).
export function wireTips() {
  document.addEventListener("pointerover", (e) => {
    const host = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (!host) return;
    hideTip();
    tipTimer = setTimeout(() => showTip(host), TIP_MS);
  });
  document.addEventListener("pointerout", (e) => {
    if ((e.target as HTMLElement).closest("[data-tip]")) hideTip();
  });
  // Any of these moves the control out from under the tip, so it must not outlive them.
  for (const ev of ["pointerdown", "wheel", "keydown"]) document.addEventListener(ev, hideTip, true);
}

const FOCUSABLE = "button, a[href], [tabindex]";
const mtKey = (el: HTMLElement) => JSON.stringify(Object.entries(el.dataset).filter(([k]) => k.startsWith("mt")).sort());
/** Write a Maintenance surface, whose `innerHTML` rebuilds every control and every scroller. The keyboard
 *  goes to the same control's successor, or, for a button that became *checking…*, to whatever stands where
 *  it stood (only if it got there by keyboard: a mouse has no use for a neighbour). A wide table keeps its place. */
export function holdMaintPlace(el: HTMLElement, html: string): void {
  const a = document.activeElement, on = a instanceof HTMLElement && a !== el && el.contains(a) && !(a instanceof HTMLInputElement) ? a : null;
  const key = on && mtKey(on), at = on ? [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].indexOf(on) : -1, typed = !!on?.matches(":focus-visible");
  const boardOf = (s: Element) => s.closest("[id^='mtb-']")?.id ?? "";
  const wide = [...el.querySelectorAll(".mt-scroll")].filter((s) => s.scrollLeft).map((s) => [boardOf(s), s.scrollLeft] as const);
  el.innerHTML = html;
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
