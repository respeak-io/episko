// Keep-awake: the top-bar split button that holds the machine awake while agents work.
// Armed (the user switched it on) is distinct from asserting (a power assertion is held now).
// reconcileCaf() is the single choke point: it runs on every renderAll and only invokes on a real change.

import { invoke } from "@tauri-apps/api/core";
import { $, IS_WIN, toast } from "./dom";
import { esc } from "./format";
import { dlog } from "./debug";

import { sessions } from "./state";
import { hasSessionState, isAgent } from "./types";

let host: { closeFootMenus: (keep?: string) => void; renderFoot: () => void; renderAll: () => void } =
  { closeFootMenus: () => {}, renderFoot: () => {}, renderAll: () => {} };
export function setCafHost(h: typeof host) { host = h; }

// Preset kinds: static (fixed flags until stopped), timer (auto-off), agents (asserts only
// while the fleet is busy). The flags are macOS `caffeinate` switches and stay the wire
// format on Windows, where `execution_state_for` maps them onto SetThreadExecutionState bits.
const CAF_HOST = IS_WIN ? "PC" : "Mac";
type CafKind = "static" | "timer" | "agents";
interface CafPreset { id: string; kind: CafKind; label: string; desc: string; glyph: string; flags?: string[] }
const ALL_CAF_PRESETS: CafPreset[] = [
  { id: "display", kind: "static", label: "Keep display awake", desc: "Screen + system stay on",     glyph: "☀", flags: ["-d"] },
  { id: "system",  kind: "static", label: "Keep system awake",  desc: "Runs on; screen may sleep",   glyph: "⏻", flags: ["-i"] },
  { id: "full",    kind: "static", label: "Fully caffeinated",  desc: "Display, disk & system",      glyph: "✺", flags: ["-dimsu"] },
  { id: "timer",   kind: "timer",  label: "Timed",              desc: "Stay awake, then auto-off",   glyph: "◷" },
  { id: "agents",  kind: "agents", label: "Until agents idle",  desc: "Awake only while agents work", glyph: "⟳" },
];
// Windows has no disk (`-m`) or user-active (`-u`) assertion, so "full" would duplicate
// "display" there; the validity check below rewrites a stored "full".
const CAF_PRESETS: CafPreset[] = IS_WIN ? ALL_CAF_PRESETS.filter((p) => p.id !== "full") : ALL_CAF_PRESETS;
// The popover's chip: the literal flags on macOS, the execution state they map to on Windows.
function cafChip(p: CafPreset): string {
  const flags = p.kind === "agents" ? ["-i"] : (p.flags ?? []);
  if (!flags.length) return "";
  if (!IS_WIN) return flags.join(" ");
  return flags.some((f) => f.includes("d")) ? "display" : "system";
}
const CAF_DURATIONS: { sec: number; label: string }[] = [
  { sec: 900, label: "15m" }, { sec: 3600, label: "1h" }, { sec: 7200, label: "2h" }, { sec: 14400, label: "4h" },
];
const cafPreset = (id: string): CafPreset => CAF_PRESETS.find((p) => p.id === id) || CAF_PRESETS[0];
let cafPresetId = localStorage.getItem("cc-caffeinate") || CAF_PRESETS[0].id;
if (!CAF_PRESETS.some((p) => p.id === cafPresetId)) cafPresetId = CAF_PRESETS[0].id;
let cafTimerSec = parseInt(localStorage.getItem("cc-caf-timer") || "", 10) || 3600;
if (!CAF_DURATIONS.some((d) => d.sec === cafTimerSec)) cafTimerSec = 3600;
// agents mode: also count "waiting on you" (permission prompt, your turn) as busy.
let cafAgentsAwait = localStorage.getItem("cc-caf-await") !== "0";
let cafArmed = false;         // the user turned it on
let cafAssertKey = "";        // flags currently handed to the backend ("" = off)
let cafTimerHandle: number | null = null;

function cafPersist() {
  localStorage.setItem("cc-caffeinate", cafPresetId);
  localStorage.setItem("cc-caf-timer", String(cafTimerSec));
  localStorage.setItem("cc-caf-await", cafAgentsAwait ? "1" : "0");
}
// Panes with no telemetry are skipped outright rather than left to fail the phase tests:
// their phase is `idle` for life, so they would start voting the moment anything wrote it.
function cafAgentsBusy(): boolean {
  for (const s of sessions.values()) {
    if (s.kind === "shell" || (isAgent(s) && !hasSessionState(s)) || s.phase === "ended") continue;
    if (s.phase === "working" || s.phase === "thinking") return true;
    if (cafAgentsAwait && (!!s.attention || s.phase === "done")) return true;
  }
  return false;
}
function cafDesiredFlags(): string[] | null {   // null = assert nothing
  if (!cafArmed) return null;
  const p = cafPreset(cafPresetId);
  if (p.kind === "agents") return cafAgentsBusy() ? ["-i"] : null;
  if (p.kind === "timer") return ["-di", "-t", String(cafTimerSec)];
  return p.flags ?? null;
}
function cafArmTimer() {
  if (cafTimerHandle !== null) { clearTimeout(cafTimerHandle); cafTimerHandle = null; }
  if (cafArmed && cafPreset(cafPresetId).kind === "timer") {
    cafTimerHandle = window.setTimeout(() => { cafArmed = false; reconcileCaf(); toast("Caffeinate ended"); }, cafTimerSec * 1000);
  }
}
// Called once at boot: a reload (⌘R) resets this module but not the Rust side, and
// reconcileCaf() would then see "" against "" and leave the assertion held forever.
export function initCaf() {
  invoke("set_caffeinate", { active: false, flags: [] }).catch(() => {});
}
export function reconcileCaf() {
  const flags = cafDesiredFlags();
  const key = flags ? flags.join(" ") : "";
  if (key !== cafAssertKey) {
    cafAssertKey = key;
    invoke("set_caffeinate", { active: !!flags, flags: flags ?? [] }).catch((e) => { cafAssertKey = ""; toast("caffeinate: " + e); });
  }
  renderCaf();
}
function renderCaf() {
  const p = cafPreset(cafPresetId);
  $("caf").classList.toggle("on", cafArmed);
  $("caf").classList.toggle("asserting", cafAssertKey !== "");
  $("cafMain").title = !cafArmed ? `Keep this ${CAF_HOST} awake · ${p.label}`
    : p.kind === "agents" ? (cafAssertKey ? "Awake · agents are working" : "Armed · sleeps until agents work")
    : p.kind === "timer" ? `Awake · ${cafDurLabel(cafTimerSec)} timer · click to stop`
    : `Awake · ${p.label} · click to stop`;
}
const cafDurLabel = (sec: number) => (CAF_DURATIONS.find((d) => d.sec === sec) || { label: sec + "s" }).label;

// user actions -------------------------------------------------------------
function cafToggle() { cafArmed = !cafArmed; cafPersist(); cafArmTimer(); reconcileCaf(); dlog("info", `caffeinate ${cafArmed ? "on · " + cafPresetId : "off"}`); }
function cafPick(id: string) { cafPresetId = id; cafArmed = true; cafPersist(); cafArmTimer(); reconcileCaf(); dlog("info", `caffeinate on · ${id}`); }
function cafStop() { cafArmed = false; cafPersist(); cafArmTimer(); reconcileCaf(); }
function cafSetDuration(sec: number) { cafTimerSec = sec; cafPresetId = "timer"; cafArmed = true; cafPersist(); cafArmTimer(); reconcileCaf(); fillCafPop(); }
function cafSetAwait(v: boolean) { cafAgentsAwait = v; cafPersist(); reconcileCaf(); fillCafPop(); }

function fillCafPop() {
  const rows = CAF_PRESETS.map((p) => {
    const active = cafArmed && p.id === cafPresetId;
    const last = !cafArmed && p.id === cafPresetId; // what a plain click would use
    const chip = p.kind === "timer" ? "" : cafChip(p);
    const right = chip ? `<span class="mp-flags">${esc(chip)}</span>` : "";
    const item = `<button class="mp-item ${active ? "on" : last ? "cur" : ""}" data-caf="${p.id}">`
      + `<span class="mp-ic">${p.glyph}</span>`
      + `<span class="mp-main"><span class="mp-l">${esc(p.label)}</span><span class="mp-s">${esc(p.desc)}</span></span>`
      + right + `</button>`;
    let sub = "";
    if (p.kind === "timer") {
      sub = `<div class="caf-sub caf-durs">` + CAF_DURATIONS.map((d) =>
        `<button class="caf-dur ${d.sec === cafTimerSec ? "on" : ""}" data-cafdur="${d.sec}">${d.label}</button>`).join("") + `</div>`;
    } else if (p.kind === "agents") {
      sub = `<div class="caf-sub caf-switch-row">`
        + `<span class="caf-sw-lbl">Stay awake while agents await you</span>`
        + `<button class="caf-switch ${cafAgentsAwait ? "on" : ""}" role="switch" aria-checked="${cafAgentsAwait}" data-cafawait="1"><span class="caf-knob"></span></button></div>`;
    }
    return `<div class="caf-opt">${item}${sub}</div>`;
  }).join("");
  const off = cafArmed
    ? `<div class="mp-sep"></div><button class="mp-item mp-off" data-caf="off"><span class="mp-ic">⏹</span><span class="mp-main"><span class="mp-l">Stop caffeinate</span></span></button>`
    : "";
  $("cafPop").innerHTML = rows + off;
}
function openCafPop() {
  const r = $("caf").getBoundingClientRect();
  const pop = $("cafPop");
  fillCafPop();
  host.closeFootMenus("cafPop");
  const w = 260;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
  pop.style.bottom = "auto";
  pop.classList.add("show");
}
export function closeCafPop() { $("cafPop").classList.remove("show"); }
$("cafMain").addEventListener("click", (e) => { e.stopPropagation(); closeCafPop(); cafToggle(); });
$("cafCaret").addEventListener("click", (e) => { e.stopPropagation(); $("cafPop").classList.contains("show") ? closeCafPop() : openCafPop(); });
$("cafPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  // Sub-controls rebuild the popover, detaching the clicked node; stop the event or the
  // document's outside-click handler sees a detached target and closes it.
  const dur = t.closest<HTMLElement>("[data-cafdur]");
  if (dur) { e.stopPropagation(); cafSetDuration(+dur.dataset.cafdur!); return; } // keep open — sub-control
  // keep open — sub-control
  if (t.closest("[data-cafawait]")) { e.stopPropagation(); cafSetAwait(!cafAgentsAwait); return; }
  const b = t.closest<HTMLElement>("[data-caf]");
  if (!b) return;
  const id = b.dataset.caf!;
  if (id === "off") cafStop(); else cafPick(id);
  closeCafPop();
});
