// The status bar along the bottom, the popovers it opens, and the header's reactor badge
// (here because `closeFootMenus` is the one-open-menu rule and the badge's dropdown is one
// of them). `renderFoot` is on renderAll's hot path; a popover paints on open.

import { invoke } from "@tauri-apps/api/core";
import { $, FILE_MANAGER, IS_MAC, toast } from "./dom";
import { closeServersPop } from "./serversui";
import { dlog, toggleDbg } from "./debug";
import { esc, fmtMb, fmtUntil } from "./format";
import { abbr } from "./phase";
import { forecastWin, type Forecast } from "./rl";
import { hasAgentCapability, isAgent, phaseText, statusKey, type AgentRateLimit, type Engine, type Sess } from "./types";
import { costPopHtml, ioFigures, ioPopHtml, liveIo, setTokenScanning, tokenScanning, usageRow } from "./usageview";
import { closeCafPop } from "./caffeinate";
import { closeSignoffPop } from "./signoff";
import { renderSettings, setTab, settingsOpen } from "./settings";
import { needsYouSessions, reactorLabel, reactorState } from "./grouping";
import { GCLASS, GLYPH } from "./sidebarview";
import { keyActionDef, shortcutRows } from "./keys";
import { enginePopHtml, shortPopHtml, type ShortcutRow } from "./footerview";
import { FOOT_SEGS, footShown } from "./footprefs";
import {
  activeId, availEngines, engineDef, footPrefs, keyPrefs, sessions, setTermEngine, telemetryUp, termEngine,
} from "./state";
import { providerAdapter } from "./providers";
import {
  daySpend, setTokenDays, todayKey, tokenDays, tokenScanAt, usage, usageDetail,
  type DayUsage,
} from "./usage";

// Owned by main.ts: the colour popover (project rows) and putting a pane on the stage.
let closeColorPop: () => void = () => {};
export function setFooterCloseColorPop(fn: typeof closeColorPop) { closeColorPop = fn; }
let setActive: (id: string) => void = () => {};
export function setFooterSetActive(fn: typeof setActive) { setActive = fn; }

export function renderFoot() {
  const total = usage[todayKey()] || 0;
  $("fSessions").textContent = String(sessions.size);
  $("fCost").textContent = "$" + total.toFixed(2);
  const limits = selectedLimits();
  const one = limits?.windows[0]; const two = limits?.windows[1];
  $("fLimitOwner").textContent = limits ? `${limits.label} limits` : "limits";
  $("fRlLabel").textContent = limitShort(one?.windowMins ?? 300);
  $("fRl7Label").textContent = limitShort(two?.windowMins ?? 10080);
  $("fUsageSeg").title = limits
    ? `${limits.label} usage limits${limits.forecast ? " & forecast" : ""} · click for detail`
    : "No integrated usage limits for the selected pane";
  paintFootRl("fRl", "fRlReset", one?.forecast ?? emptyForecast());
  paintFootRl("fRl7", "fRl7Reset", two?.forecast ?? emptyForecast());
  paintFootIo();
  $("fEngine").textContent = engineDef(termEngine).label;
  applyFootPrefs();
  if ($("usagePop").classList.contains("show")) renderUsagePop();
  if ($("costPop").classList.contains("show")) renderCostPop(); // only while on screen, like the usage one
  if ($("ioPop").classList.contains("show")) renderIoPop();
}

interface LimitWindowView extends AgentRateLimit { forecast: Forecast }
interface SelectedLimits { label: string; forecast: boolean; reported: boolean; windows: LimitWindowView[] }

const emptyForecast = (): Forecast => forecastWin(null, null, null);
const limitShort = (mins: number | null): string => mins === 300 ? "5h"
  : mins === 10080 ? "7d" : mins != null && mins % 1440 === 0 ? `${mins / 1440}d`
    : mins != null && mins % 60 === 0 ? `${mins / 60}h` : mins != null ? `${mins}m` : "limit";
const limitName = (mins: number | null): [string, string] => mins === 300
  ? ["Session", "5-hour window"] : mins === 10080 ? ["Weekly", "7-day window"]
    : [limitShort(mins), "usage window"];

function selectedLimits(): SelectedLimits | null {
  const s = activeId ? sessions.get(activeId) : null;
  if (!s || !isAgent(s) || !hasAgentCapability(s, "usage")) return null;
  const adapter = providerAdapter(s.provider ?? "");
  const specialized = adapter?.rateLimitForecasts?.();
  const source = specialized?.length
    ? specialized.map((window) => ({
        usedPercent: window.forecast.used ?? 0, resetsAt: window.forecast.resetTs,
        windowMins: window.windowMins, forecast: window.forecast,
      }))
    : [...s.rateLimits]
        .sort((a, b) => (a.windowMins ?? Number.MAX_SAFE_INTEGER) - (b.windowMins ?? Number.MAX_SAFE_INTEGER))
        .map((window) => ({
          ...window,
          forecast: forecastWin(window.usedPercent, window.resetsAt, null, window.windowMins == null ? undefined : window.windowMins * 60),
        }));
  const windows = source.slice(0, 2);
  return {
    label: adapter?.label ?? s.provider ?? "Agent",
    forecast: !!specialized?.length,
    reported: windows.some((window) => window.forecast.used != null),
    windows,
  };
}

// Today rather than this run. `–` until the `cc-io` rollup has a first entry of the day:
// a zero would claim the sessions had done nothing.
function paintFootIo() {
  const f = ioFigures("today");
  $("fIoR").textContent = f.known ? fmtMb(f.r) : "–";
  $("fIoW").textContent = f.known ? fmtMb(f.w) : "–";
}

// A divider is named after the segment it sits before (`data-fdiv="io"`), so hiding one
// takes its rule with it; the first visible segment drops its rule too, whichever ends up
// leftmost. The permanent three have no divider and no FOOT_SEGS entry (./footprefs).
// Guarded on the switch state: this runs every renderAll pass and only Settings changes it.
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
// Coloured by the forecast's status rather than the raw level, with the reset countdown beside it.
function paintFootRl(pctId: string, resetId: string, f: Forecast) {
  const pctEl = $(pctId), resetEl = $(resetId);
  pctEl.textContent = f.used != null ? Math.round(f.used) + "%" : "–";
  pctEl.className = f.used == null ? "" : "s-" + f.status; // neutral until we have a reading
  resetEl.textContent = f.resetTs != null ? "↻ " + fmtUntil(f.resetTs) : "";
}
// Guarded: an open popover repaints on every telemetry event, and an innerHTML assignment
// between mousedown and mouseup drops the click on its buttons (docs/architecture.md).
let lastUsagePop = "", lastCostPop = "", lastAttnPop = "";

function renderUsagePop() {
  const limits = selectedLimits();
  const rows = limits?.windows.map((window) => {
    const [title, sub] = limitName(window.windowMins);
    return usageRow(title, sub, window.forecast);
  }).join("") ?? "";
  const html = `<div class="up-h">${esc(limits ? `${limits.label} usage limits` : "Usage limits")}</div>
    ${rows}
    <div class="up-foot"><span>today <b>$${(usage[todayKey()] || 0).toFixed(2)}</b></span><span>${sessions.size} live${limits ? ` · ${esc(limits.label)} account` : ""}</span></div>
    ${!limits ? `<div class="up-note">Select an integrated agent session to see its account limits.</div>`
      : !limits.reported ? `<div class="up-note">Waiting for ${esc(limits.label)} to report account limits.</div>` : ""}`;
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


// A full read of the recent corpus, so at most once per 10 min unless forced; the tab
// paints from localStorage first and repaints when fresh numbers land.
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

// Only one floating menu may be open at a time: every open* closes the rest first (the
// footer triggers stopPropagation, so the document-level outside-click close skips them).
export function closeFootMenus(keep?: string) {
  const menus: [string, () => void][] = [
    ["colorPop", closeColorPop], ["enginePop", closeEnginePop], ["cafPop", closeCafPop],
    ["usagePop", closeUsagePop], ["attnPop", closeAttnPop], ["shortPop", closeShortPop],
    ["costPop", closeCostPop], ["ioPop", closeIoPop], ["svrPop", closeServersPop],
    ["soPop", closeSignoffPop],
  ];
  for (const [id, close] of menus) if (id !== keep) close();
}
// The ⌘ Shortcuts popover. Every row but this one is read off the same `keyPrefs` the keydown
// handler dispatches on, never a second table. This one lives in `clipboardKeys`, below that layer
// and not rebindable; per platform since ⌘C/⌘V are native on macOS and Ctrl+C interrupts elsewhere.
const CLIPBOARD_ROW: ShortcutRow = {
  label: "Copy / paste in a terminal",
  chords: IS_MAC ? [["⌘", "C"], ["⌘", "V"]] : [["Ctrl", "⇧", "C"], ["Ctrl", "⇧", "V"]],
};
function shortcutList(): ShortcutRow[] {
  return [
    // ./keys is pure and cannot read which file manager this OS has.
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
// A whole-app badge rather than a per-row mark: while the hook server is down every Claude
// pane is equally blind. Shown only while it is down; a re-bind clears it.
export function renderTelemetry() {
  const b = $("telBadge");
  b.className = telemetryUp ? "tel-badge" : "tel-badge show";
  b.title = telemetryUp ? "" :
    "Telemetry server is down — session status, context, files and tools are frozen "
    + "until it re-binds. Panes keep running; nothing is lost.";
}

// Header "reactor": one rollup of the fleet's most-urgent state.
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

// The outage is written down in the 🐞 console, so the badge opens that rather than a popover of its own.
$("telBadge").addEventListener("click", () => { closeFootMenus(); toggleDbg(true); });

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
