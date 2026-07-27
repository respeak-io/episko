// Keep-awake: the top-bar split button that holds the machine awake while agents
// work. The icon toggles the last-used preset; the caret opens the picker.
//
// The distinction the whole module turns on is **armed vs asserting**. "Armed" is
// the user having switched it on; "asserting" is a power assertion actually being
// held right now. For the agents preset those genuinely differ — armed but idle
// shows the cup lit without steam, and it re-asserts by itself when the fleet gets
// busy again. reconcileCaf() is the single choke point: it diffs desired flags
// against what is running and only pokes the backend on a real change, the same
// guarded-invoke pattern updateTray uses.
//
// The flags are macOS `caffeinate` switches and stay the wire format on both
// platforms — the Windows backend maps them onto SetThreadExecutionState bits
// (see `execution_state_for`) rather than making the UI speak two dialects.

import { invoke } from "@tauri-apps/api/core";
import { $, toast } from "./dom";
import { esc } from "./format";
import { dlog } from "./debug";

import { sessions } from "./state";

// Three things it needs from the layer that owns the footer and the repaint.
let host: { closeFootMenus: (keep?: string) => void; renderFoot: () => void; renderAll: () => void } =
  { closeFootMenus: () => {}, renderFoot: () => {}, renderAll: () => {} };
export function setCafHost(h: typeof host) { host = h; }

// The top-bar split button drives a macOS `caffeinate` power assertion. The icon
// toggles the last-used preset (one click); the caret opens the picker. Three
// kinds of preset:
//   • static  — fixed flags, on until you stop it (display / system / full)
//   • timer   — a chosen duration (15m/1h/2h/4h), auto-off when it elapses
//   • agents  — dynamic: hold the Mac awake ONLY while sessions are busy, and
//               release when the fleet goes dormant; re-arms when work resumes
// "Armed" (the user turned it on) is distinct from "asserting" (a caffeinate
// child is actually running right now). For the agent mode those differ: armed
// but idle shows the cup lit without steam; asserting adds the steam + glow.
// reconcileCaf() is the single choke point — called on every host.renderAll(), it
// diffs the desired flags against what's running and only pokes the backend on a
// real change (same guarded-invoke pattern as updateTray).
// The flags below are macOS `caffeinate` switches, and they stay the wire format
// on both platforms: the Windows backend maps them onto `SetThreadExecutionState`
// bits (see `execution_state_for`) rather than making the UI speak two dialects.
const IS_WINDOWS = navigator.userAgent.includes("Windows");
const CAF_HOST = IS_WINDOWS ? "PC" : "Mac";
type CafKind = "static" | "timer" | "agents";
interface CafPreset { id: string; kind: CafKind; label: string; desc: string; glyph: string; flags?: string[] }
const ALL_CAF_PRESETS: CafPreset[] = [
  { id: "display", kind: "static", label: "Keep display awake", desc: "Screen + system stay on",     glyph: "☀", flags: ["-d"] },
  { id: "system",  kind: "static", label: "Keep system awake",  desc: "Runs on; screen may sleep",   glyph: "⏻", flags: ["-i"] },
  { id: "full",    kind: "static", label: "Fully caffeinated",  desc: "Display, disk & system",      glyph: "✺", flags: ["-dimsu"] },
  { id: "timer",   kind: "timer",  label: "Timed",              desc: "Stay awake, then auto-off",   glyph: "◷" },
  { id: "agents",  kind: "agents", label: "Until agents idle",  desc: "Awake only while agents work", glyph: "⟳" },
];
// Windows has no disk (`-m`) or user-active (`-u`) assertion, so "Fully
// caffeinated" would be a second, identical "Keep display awake" row there.
// Drop it — the validity check below rewrites a stored "full" to the first preset.
const CAF_PRESETS: CafPreset[] = IS_WINDOWS ? ALL_CAF_PRESETS.filter((p) => p.id !== "full") : ALL_CAF_PRESETS;
// The popover's right-hand chip: the literal flags on macOS, the execution state
// they translate to on Windows, where the raw flags would be meaningless jargon.
function cafChip(p: CafPreset): string {
  const flags = p.kind === "agents" ? ["-i"] : (p.flags ?? []);
  if (!flags.length) return "";
  if (!IS_WINDOWS) return flags.join(" ");
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
// agents mode: also count "waiting on you" (permission prompt / your turn) as
// busy, so an unattended run's prompt keeps the screen up. User-toggled switch.
let cafAgentsAwait = localStorage.getItem("cc-caf-await") !== "0";
let cafArmed = false;         // the user turned it on
let cafAssertKey = "";        // flags currently handed to the backend ("" = off)
let cafTimerHandle: number | null = null;

function cafPersist() {
  localStorage.setItem("cc-caffeinate", cafPresetId);
  localStorage.setItem("cc-caf-timer", String(cafTimerSec));
  localStorage.setItem("cc-caf-await", cafAgentsAwait ? "1" : "0");
}
// Is any real (non-shell) session doing work worth staying awake for?
function cafAgentsBusy(): boolean {
  for (const s of sessions.values()) {
    if (s.kind === "shell" || s.phase === "ended") continue;
    if (s.phase === "working" || s.phase === "thinking") return true;
    if (cafAgentsAwait && (!!s.attention || s.phase === "done")) return true;
  }
  return false;
}
// The flags we WANT running now, or null for "assert nothing".
function cafDesiredFlags(): string[] | null {
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
    : p.kind === "agents" ? (cafAssertKey ? "Awake — agents are working" : "Armed — sleeps until agents work")
    : p.kind === "timer" ? `Awake · ${cafDurLabel(cafTimerSec)} timer — click to stop`
    : `Awake · ${p.label} — click to stop`;
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
  // Sub-controls rebuild the popover (fillCafPop), which detaches the clicked
  // node — so stop the event before it reaches the document outside-click
  // handler, which would then see a detached target and close the popover.
  const dur = t.closest<HTMLElement>("[data-cafdur]");
  if (dur) { e.stopPropagation(); cafSetDuration(+dur.dataset.cafdur!); return; } // keep open — sub-control
  if (t.closest("[data-cafawait]")) { e.stopPropagation(); cafSetAwait(!cafAgentsAwait); return; } // keep open — sub-control
  const b = t.closest<HTMLElement>("[data-caf]");
  if (!b) return;
  const id = b.dataset.caf!;
  if (id === "off") cafStop(); else cafPick(id);
  closeCafPop();
});
