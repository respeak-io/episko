// The status bar along the bottom of the window, the four popovers it opens, and the
// header's reactor badge.
//
// The badge is not in the footer, but it belongs here anyway: `closeFootMenus` is the
// rule that only one floating menu may be open at a time, and the badge's dropdown is
// one of them. Splitting the two would mean each importing the other's close function.
//
// `renderFoot` is on `renderAll`'s hot path, so it repaints the meters on every
// telemetry event; every popover here instead paints on open (and `renderFoot`
// refreshes the usage one only while it is actually shown).

import { invoke } from "@tauri-apps/api/core";
import { $, FILE_MANAGER, IS_MAC, toast } from "./dom";
import { closeServersPop } from "./serversui";
import { dlog } from "./debug";
import { esc, fmtMb, fmtUntil } from "./format";
import { abbr } from "./phase";
import { forecast5h, forecast7d, rl, type Forecast } from "./rl";
import { phaseText, statusKey, type Engine, type Sess } from "./types";
import { costPopHtml, ioFigures, ioPopHtml, liveIo, setTokenScanning, tokenScanning, usageRow } from "./usageview";
import { closeCafPop } from "./caffeinate";
import { renderSettings, setTab, settingsOpen } from "./settings";
import { needsYouSessions, reactorLabel, reactorState } from "./grouping";
import { GCLASS, GLYPH } from "./sidebarview";
import { keyActionDef, shortcutRows } from "./keys";
import { enginePopHtml, shortPopHtml, type ShortcutRow } from "./footerview";
import { FOOT_SEGS, footShown } from "./footprefs";
import {
  availEngines, engineDef, footPrefs, keyPrefs, sessions, setTermEngine, termEngine,
} from "./state";
import {
  daySpend, setTokenDays, todayKey, tokenDays, tokenScanAt, usage, usageDetail,
  type DayUsage,
} from "./usage";

// Two things the exclusive-menu rule and the reactor need that this module does not
// own: the colour popover belongs to the project rows in main.ts, and putting a pane
// on the stage is main.ts's job. Per-callee setters, per PLAN's seam rule 2.
let closeColorPop: () => void = () => {};
export function setFooterCloseColorPop(fn: typeof closeColorPop) { closeColorPop = fn; }
let setActive: (id: string) => void = () => {};
export function setFooterSetActive(fn: typeof setActive) { setActive = fn; }

export function renderFoot() {
  const total = usage[todayKey()] || 0;
  $("fSessions").textContent = String(sessions.size);
  $("fCost").textContent = "$" + total.toFixed(2);
  paintFootRl("fRl", "fRlReset", forecast5h());
  paintFootRl("fRl7", "fRl7Reset", forecast7d());
  paintFootIo();
  $("fEngine").textContent = engineDef(termEngine).label;
  applyFootPrefs();
  if ($("usagePop").classList.contains("show")) renderUsagePop();
  // Same rule as the usage popup: repaint only while it is actually on screen, so the
  // day's spend ticks up under the pointer instead of going stale the moment it opens.
  if ($("costPop").classList.contains("show")) renderCostPop();
  if ($("ioPop").classList.contains("show")) renderIoPop();
}

/// Today's totals on the bar; every other window is in the popover.
///
/// Today rather than this run, because the bar is glanced at rather than studied and
/// "what have my agents done to this disk today" is the question people actually have.
/// It reads `–` until the `cc-io` rollup has written its first entry of the day — the
/// same "no reading yet" the limits segment shows, and honest: a zero would claim the
/// sessions had done nothing.
function paintFootIo() {
  const f = ioFigures("today");
  $("fIoR").textContent = f.known ? fmtMb(f.r) : "–";
  $("fIoW").textContent = f.known ? fmtMb(f.w) : "–";
}

/// Show or hide each switchable segment, and the divider that belongs to it.
///
/// A divider is named after the segment it sits *before* (`data-fdiv="io"`), so hiding a
/// segment takes its leading rule with it and the bar never shows two rules in a row or
/// opens with one. The permanent three carry no divider and no entry in `FOOT_SEGS`,
/// which is what keeps them permanent — see ./footprefs.
///
/// The **first visible** segment drops its rule too, and that is not the same statement.
/// `sessions` is the leftmost switchable segment and has no divider of its own in the
/// markup, so hiding it used to promote `cost`'s rule up against the version block —
/// a rule where the bar has never had one. Deciding it here rather than adding a
/// `data-fdiv="sessions"` keeps the default appearance exactly as it is and survives
/// whatever ends up leftmost next.
///
/// `hidden` rather than a class, because these are inline elements in a flex row and
/// `hidden` is the one thing that removes them from the layout without a second rule to
/// keep in sync.
///
/// Guarded on the switch state, because this runs from `renderFoot` on every `renderAll`
/// pass and nothing but a Settings toggle can change the answer: without the guard it is
/// fourteen DOM lookups a frame, forever, to rewrite a value that is already correct.
let footPrefsKey = "";
function applyFootPrefs() {
  const key = FOOT_SEGS.map((s) => (footShown(footPrefs, s.id) ? "1" : "0")).join("");
  if (key === footPrefsKey) return;
  footPrefsKey = key;
  let leading = true;
  for (const seg of FOOT_SEGS) {
    const on = footShown(footPrefs, seg.id);
    const el = document.getElementById(seg.el);
    if (el) (el as HTMLElement).hidden = !on;
    const div = document.querySelector<HTMLElement>(`[data-fdiv="${seg.id}"]`);
    if (div) div.hidden = !on || leading;
    if (on) leading = false;
  }
}
// Colour the footer % by its forecast (not its raw level), and show a muted
// countdown to that window's reset beside it — see the forecast section above.
function paintFootRl(pctId: string, resetId: string, f: Forecast) {
  const pctEl = $(pctId), resetEl = $(resetId);
  pctEl.textContent = f.used != null ? Math.round(f.used) + "%" : "–";
  pctEl.className = f.used == null ? "" : "s-" + f.status; // neutral until we have a reading
  resetEl.textContent = f.resetTs != null ? "↻ " + fmtUntil(f.resetTs) : "";
}
// The forecast presentation (foreText / verdictChip / usageRow) and the whole
// Usage analytics panel now live in ./usageview. What stays here is what talks to
// the DOM or the backend: the popup below, and refreshTokens.

// While a popover is open, renderFoot/renderAttn repaint it on every telemetry
// event — and an innerHTML assignment between mousedown and mouseup drops the
// click on its data-sel buttons. Same guard as renderSidebar: assign only when
// the markup actually changed (docs/architecture.md).
let lastUsagePop = "", lastCostPop = "", lastAttnPop = "";

function renderUsagePop() {
  const noData = rl.h5 == null && rl.d7 == null;
  const html = `<div class="up-h">Claude usage limits</div>
    ${usageRow("Session", "5-hour window", forecast5h())}
    ${usageRow("Weekly", "7-day window", forecast7d())}
    <div class="up-foot"><span>today <b>$${(usage[todayKey()] || 0).toFixed(2)}</b></span><span>${sessions.size} live · account-wide</span></div>
    ${noData ? `<div class="up-note">Appears once a running session reports a statusLine.</div>` : ""}`;
  if (html === lastUsagePop) return;
  lastUsagePop = html;
  $("usagePop").innerHTML = html;
}
function openUsagePop() {
  const r = $("fUsageSeg").getBoundingClientRect();
  const pop = $("usagePop");
  renderUsagePop();
  closeFootMenus("usagePop");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
export function closeUsagePop() { $("usagePop").classList.remove("show"); }

// ---------- today's spend, split (footer "today $x.xx") ----------
// The limits segment beside it has opened a detail popover since it shipped, and the
// spend — the one number on the bar people actually chase — was inert. It has the same
// question behind it ("where is that going?") and the answer is already stored:
// `cc-usage-detail` carries the per-project split, and per-session since this shipped.
function renderCostPop() {
  const live = new Set([...sessions.values()].map((s) => s.id));
  const html = costPopHtml(daySpend(usageDetail, todayKey(), usage[todayKey()] || 0), live);
  if (html === lastCostPop) return;
  lastCostPop = html;
  $("costPop").innerHTML = html;
}
function openCostPop() {
  const r = $("fCostSeg").getBoundingClientRect();
  const pop = $("costPop");
  renderCostPop();
  closeFootMenus("costPop");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 268)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
export function closeCostPop() { $("costPop").classList.remove("show"); }

// ---------- disk I/O (footer "disk") ----------
// The card this replaces lived at the bottom of the inspector and cost ~120px of a
// 296px column to show a figure that is app-wide, not per-session — see ./usageview's
// `ioPopHtml` for the whole reasoning and the markup.
let lastIoPop = "";
function renderIoPop() {
  const html = ioPopHtml(liveIo());
  if (html === lastIoPop) return;
  lastIoPop = html;
  $("ioPop").innerHTML = html;
}
function openIoPop() {
  const r = $("fIoSeg").getBoundingClientRect();
  const pop = $("ioPop");
  renderIoPop();
  closeFootMenus("ioPop");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 320)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
export function closeIoPop() { $("ioPop").classList.remove("show"); }


// Scan the transcripts for token totals, at most once per 10 min (a full read of
// the recent corpus). Async + cached, so the tab paints instantly from localStorage
// and re-paints when fresh numbers land. `force` bypasses the throttle.
export async function refreshTokens(force = false) {
  if (tokenScanning) return;
  if (!force && tokenDays.length && Date.now() - tokenScanAt < 6e5) return;
  setTokenScanning(true);
  if (settingsOpen() && setTab === "usage") renderSettings(); // surface the "scanning…" hint
  try {
    setTokenDays(await invoke<DayUsage[]>("token_usage_by_day", { days: 400 }));
  } catch (e) { dlog("warn", "token scan failed: " + e); }
  finally { setTokenScanning(false); if (settingsOpen() && setTab === "usage") renderSettings(); }
}

// Only one floating footer/overlay menu may be open at a time: every open* closes
// the rest first. (The footer triggers stopPropagation, so the document-level
// outside-click close never fires for them — this is what keeps them exclusive.)
export function closeFootMenus(keep?: string) {
  const menus: [string, () => void][] = [
    ["colorPop", closeColorPop], ["enginePop", closeEnginePop], ["cafPop", closeCafPop],
    ["usagePop", closeUsagePop], ["attnPop", closeAttnPop], ["shortPop", closeShortPop],
    ["costPop", closeCostPop], ["ioPop", closeIoPop], ["svrPop", closeServersPop],
  ];
  for (const [id, close] of menus) if (id !== keep) close();
}
// Keyboard shortcuts, listed in the footer's ⌘ Shortcuts popover. Every row bar the
// last is derived from the SAME `keyPrefs` the global keydown handler dispatches on
// (`shortcutRows` in ./keys), so a rebind in Settings › Keys is reflected here with
// no second table to keep in sync — this popover used to be that second table, and a
// cheat sheet that has drifted is worse than no cheat sheet.
//
// The last row belongs to a terminal pane and lives in `clipboardKeys`, below this
// layer and not rebindable, so it stays spelled out. It is per-platform because it
// genuinely differs: ⌘C/⌘V reach the WebView's native copy/paste on macOS, while
// everywhere else Ctrl+C is the interrupt and Ctrl+V a dead key, so only the shifted
// pair is left.
const CLIPBOARD_ROW: ShortcutRow = {
  label: "Copy / paste in a terminal",
  chords: IS_MAC ? [["⌘", "C"], ["⌘", "V"]] : [["Ctrl", "⇧", "C"], ["Ctrl", "⇧", "V"]],
};
function shortcutList(): ShortcutRow[] {
  return [
    // `Reveal this folder` is the one label worth completing here: ./keys is a pure
    // module and cannot read which file manager this OS has.
    ...shortcutRows(keyPrefs, IS_MAC).map((r) =>
      r.label === keyActionDef("reveal").label ? { ...r, label: `${r.label} in ${FILE_MANAGER}` } : r),
    CLIPBOARD_ROW,
  ];
}
function renderShortPop() {
  $("shortPop").innerHTML = shortPopHtml(shortcutList(), !keyPrefs.enabled);
}
function openShortPop() {
  const r = $("fShortSeg").getBoundingClientRect();
  const pop = $("shortPop");
  renderShortPop();
  closeFootMenus("shortPop");
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
export function closeShortPop() { $("shortPop").classList.remove("show"); }
// Header "reactor": one rollup of the fleet's most-urgent state. Clicking it jumps
// straight to the longest-waiting session in that state (a picker if several).
export function renderAttn() {
  const list = needsYouSessions();
  const b = $("attnBadge");
  if (!list.length) { b.className = "attn-badge"; closeAttnPop(); return; }
  const dom = reactorState(list[0]);
  const n = list.filter((s) => reactorState(s) === dom).length;
  b.className = `attn-badge show react-${dom}${list.length > 1 ? " multi" : ""}`;
  $("attnBadgeTxt").textContent = reactorLabel(dom, n);
  if ($("attnPop").classList.contains("show")) { if (list.length > 1) openAttnPop(list); else closeAttnPop(); }
}
// Click the reactor → jump to the session; if several need you, a dropdown lists
// project + title + reason so you can pick which to jump to.
function badgeLabel(s: Sess) { return s.title || (s.worktree ? `⑃ ${s.branch}` : (s.branch || "session")); }
function openAttnPop(list: Sess[]) {
  const r = $("attnBadge").getBoundingClientRect();
  const pop = $("attnPop");
  closeFootMenus("attnPop");
  const html = list.map((s) => {
    const k = statusKey(s);
    const reason = s.attention || phaseText(s);
    return `<button class="ap-item" data-sel="${s.id}"><span class="ap-dot ${GCLASS[k]}">${GLYPH[k]}</span><span class="ap-main"><span class="ap-proj">${esc(s.project)}</span><span class="ap-ttl">${esc(badgeLabel(s))}</span></span><span class="ap-reason ${GCLASS[k]}">${esc(abbr(reason, 42))}</span></button>`;
  }).join("");
  if (html !== lastAttnPop) { lastAttnPop = html; pop.innerHTML = html; }
  pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  pop.style.left = "auto";
  pop.style.top = (r.bottom + 6) + "px";
  pop.classList.add("show");
}
export function closeAttnPop() { $("attnPop").classList.remove("show"); }

export function setEngine(id: Engine) {
  if (id === termEngine) return;
  setTermEngine(id);
  localStorage.setItem("cc-term-engine", termEngine);
  const d = engineDef(id);
  toast(id === "embedded" ? "New sessions open in the embedded terminal" : `New sessions open in ${d.label} (external)`);
  renderFoot();
}

// ---------- terminal-engine popover (footer "new in …") ----------
function openEnginePopover() {
  const seg = $("fEngineSeg");
  const r = seg.getBoundingClientRect();
  const pop = $("enginePop");
  closeFootMenus("enginePop");
  pop.innerHTML = enginePopHtml(availEngines, termEngine);
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 228)) + "px";
  pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
  pop.style.top = "auto";
  pop.classList.add("show");
}
export function closeEnginePop() { $("enginePop").classList.remove("show"); }
$("enginePop").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-engine]");
  if (!b) return;
  setEngine(b.dataset.engine as Engine);
  closeEnginePop();
});

// Reactor click → jump straight to the longest-waiting session, or open a picker
// if several need you.
$("attnBadge").addEventListener("click", () => {
  const list = needsYouSessions();
  if (list.length === 0) return;
  if (list.length === 1) { setActive(list[0].id); closeAttnPop(); return; }
  $("attnPop").classList.contains("show") ? closeAttnPop() : openAttnPop(list);
});

$("fEngineSeg").addEventListener("click", (e) => { e.stopPropagation(); $("enginePop").classList.contains("show") ? closeEnginePop() : openEnginePopover(); });
$("fUsageSeg").addEventListener("click", (e) => { e.stopPropagation(); $("usagePop").classList.contains("show") ? closeUsagePop() : openUsagePop(); });
$("fCostSeg").addEventListener("click", (e) => { e.stopPropagation(); $("costPop").classList.contains("show") ? closeCostPop() : openCostPop(); });
$("fIoSeg").addEventListener("click", (e) => { e.stopPropagation(); $("ioPop").classList.contains("show") ? closeIoPop() : openIoPop(); });
$("fShortSeg").addEventListener("click", (e) => { e.stopPropagation(); $("shortPop").classList.contains("show") ? closeShortPop() : openShortPop(); });
