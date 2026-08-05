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
import { dlog } from "./debug";
import { esc, fmtUntil } from "./format";
import { abbr } from "./phase";
import { forecast5h, forecast7d, rl, type Forecast } from "./rl";
import { phaseText, statusKey, type Engine, type Sess } from "./types";
import { costPopHtml, setTokenScanning, tokenScanning, usageRow } from "./usageview";
import { closeCafPop } from "./caffeinate";
import { renderSettings, setTab, settingsOpen } from "./settings";
import { needsYouSessions, reactorLabel, reactorState } from "./grouping";
import { GCLASS, GLYPH } from "./sidebarview";
import {
  availEngines, engineDef, sessions, setTermEngine, termEngine,
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
  $("fEngine").textContent = engineDef(termEngine).label;
  if ($("usagePop").classList.contains("show")) renderUsagePop();
  // Same rule as the usage popup: repaint only while it is actually on screen, so the
  // day's spend ticks up under the pointer instead of going stale the moment it opens.
  if ($("costPop").classList.contains("show")) renderCostPop();
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
function renderUsagePop() {
  const noData = rl.h5 == null && rl.d7 == null;
  $("usagePop").innerHTML = `<div class="up-h">Claude usage limits</div>
    ${usageRow("Session", "5-hour window", forecast5h())}
    ${usageRow("Weekly", "7-day window", forecast7d())}
    <div class="up-foot"><span>today <b>$${(usage[todayKey()] || 0).toFixed(2)}</b></span><span>${sessions.size} live · account-wide</span></div>
    ${noData ? `<div class="up-note">Appears once a running session reports a statusLine.</div>` : ""}`;
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
  $("costPop").innerHTML = costPopHtml(daySpend(usageDetail, todayKey(), usage[todayKey()] || 0), live);
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
    ["costPop", closeCostPop],
  ];
  for (const [id, close] of menus) if (id !== keep) close();
}
// Keyboard shortcuts, listed in the footer's ⌘ Shortcuts popover. Keep in sync with
// the global keydown handler (the sole source of truth for what these actually do) —
// bar the last row, which belongs to a terminal pane and lives in `clipboardKeys`.
// That one is spelled per-platform because it genuinely differs: ⌘C/⌘V reach the
// WebView's native copy/paste on macOS, while everywhere else Ctrl+C is the interrupt
// and Ctrl+V a dead key, so only the shifted pair is left.
const SHORTCUTS: { label: string; chords: string[][] }[] = [
  { label: "Command palette", chords: [["⌘", "K"]] },
  { label: "Switch to session 1–9", chords: [["⌘", "1–9"]] },
  { label: "Open a terminal here", chords: [["⌘", "T"]] },
  { label: "Run the default build task", chords: [["⌘", "⇧", "B"]] },
  { label: "Run the default test task", chords: [["⌘", "⇧", "T"]] },
  { label: "Run a task…", chords: [["⌘", "⇧", "R"]] },
  { label: "Session history", chords: [["⌘", "⇧", "H"]] },
  { label: `Reveal this folder in ${FILE_MANAGER}`, chords: [["⌘", "⏎"]] },
  { label: "Toggle sidebar", chords: [["⌘", "B"]] },
  { label: "Toggle inspector", chords: [["⌘", "I"]] },
  { label: "Settings", chords: [["⌘", ","]] },
  { label: "Terminal font size", chords: [["⌘", "+"], ["⌘", "−"], ["⌘", "0"]] },
  {
    label: "Copy / paste in a terminal",
    chords: IS_MAC ? [["⌘", "C"], ["⌘", "V"]] : [["Ctrl", "⇧", "C"], ["Ctrl", "⇧", "V"]],
  },
];
function renderShortPop() {
  const rows = SHORTCUTS.map((s) => {
    const keys = s.chords
      .map((c) => `<span class="sc-chord">${c.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</span>`)
      .join(`<span class="sc-or">/</span>`);
    return `<div class="sc-row"><span class="sc-desc">${esc(s.label)}</span><span class="sc-keys">${keys}</span></div>`;
  }).join("");
  $("shortPop").innerHTML = `<div class="sc-h">Keyboard shortcuts</div>${rows}`;
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
  pop.innerHTML = list.map((s) => {
    const k = statusKey(s);
    const reason = s.attention || phaseText(s);
    return `<button class="ap-item" data-sel="${s.id}"><span class="ap-dot ${GCLASS[k]}">${GLYPH[k]}</span><span class="ap-main"><span class="ap-proj">${esc(s.project)}</span><span class="ap-ttl">${esc(badgeLabel(s))}</span></span><span class="ap-reason ${GCLASS[k]}">${esc(abbr(reason, 42))}</span></button>`;
  }).join("");
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
  pop.innerHTML = availEngines.map((id) => {
    const d = engineDef(id);
    return `<button class="mp-item ${id === termEngine ? "on" : ""}" data-engine="${id}"><span class="mp-ic">${id === "embedded" ? "▤" : "⧉"}</span><span class="mp-main"><span class="mp-l">${esc(d.label)}</span><span class="mp-s">${esc(d.sub)}</span></span><span class="mp-check">✓</span></button>`;
  }).join("");
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
$("fShortSeg").addEventListener("click", (e) => { e.stopPropagation(); $("shortPop").classList.contains("show") ? closeShortPop() : openShortPop(); });
