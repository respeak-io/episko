// The settings window: a tab list, a declarative control table, and the one
// dispatcher that applies a change. Adding a setting means adding a descriptor to
// SET_TABS — not writing markup — which is the property worth preserving here.
//
// This is a control panel, so unlike every other extracted module it does not own
// what it changes: the theme, the sidebar sort, the launch engine, the terminal
// font and the token scan all live elsewhere and are reached through one host
// object of no-ops. Seven separate setters would have been noise; the shape is the
// same as the per-callee hooks used elsewhere (PLAN seam rule 2), just gathered.
//
// It owns its own tab state, its click handlers and the Usage panel's hover
// tooltip — that last one is parented to <body> rather than #setBody on purpose,
// so a renderSettings() rebuild never drops it mid-hover.

import { $, dropScrim, toast } from "./dom";
import { basename, esc, tilde } from "./format";
import type { Engine } from "./types";
import {
  availEngines, engineDef, setTermFontSize, SORT_META, SORT_MODES, sortMode,
  termEngine, termFontSize, wtGroup,
  type SortMode, type WtGroup,
} from "./state";
import {
  ALL_PROVIDERS, clearStopRule, explicitlyTrusted, PROVIDER_LABEL, saveTaskPrefs,
  stopRules, taskPrefs, untrustProject, type Provider, type TaskPrefs,
} from "./tasks";
import { usagePanelHtml } from "./usageview";
import { setUsageRange } from "./usage";
import { setTrailRange, setTrailSummaries, trailRange, trailSummaries } from "./trailui";

// What this dialog changes but does not own. Every entry is somebody else's
// setter; main.ts hands them over at startup and until then they do nothing.
export interface SettingsHost {
  setTheme: (t: "dark" | "light") => void;
  effectiveTheme: () => "dark" | "light";
  setSort: (m: SortMode, announce?: boolean) => void;
  setEngine: (id: Engine) => void;
  bumpFont: (d: number) => void;
  applyFontSize: () => void;
  refreshTokens: (force?: boolean) => void;
  // Must be the app-level setWtGroup (./actions), NOT state.ts's same-named setter:
  // that one assigns and nothing else, so picking a mode here would neither persist
  // nor regroup the sidebar. It arrives through the host because ./actions imports
  // this module (for renderSettings) and a direct import back would be a cycle.
  setWtGroup: (m: WtGroup) => void;
}
let host: SettingsHost = {
  setTheme: () => {}, effectiveTheme: () => "dark", setSort: () => {}, setEngine: () => {},
  bumpFont: () => {}, applyFontSize: () => {}, refreshTokens: () => {},
  setWtGroup: () => {},
};
export function setSettingsHost(h: SettingsHost) { host = h; }

// A sidebar-tab settings window built on the shared #scrim + `.show` overlay (same
// pattern as #wtDlg / #palette). Every control is a small declarative descriptor
// that writes its cc-* key through the SAME setter the rest of the app uses, so a
// change here is instantly live and persisted — there is no separate settings store.
type SetSeg = { value: string; label: string; sub?: string; glyph?: string };
// A control is a segmented picker (radio-style), the font stepper, or the worktree-
// grouping preview grid (segmented pick shown as live mini-sidebars instead of text).
type SetControl =
  | { kind: "seg"; set: string; label: string; hint?: string; active: () => string; segs: () => SetSeg[] }
  | { kind: "font"; label: string; hint?: string }
  | { kind: "wtpreview"; label: string; hint?: string; active: () => string }
  // A single on/off switch.
  | { kind: "toggle"; set: string; label: string; hint?: string; on: () => boolean }
  // Independently-toggled values — "which providers to scan" isn't a pick-one.
  | { kind: "multi"; set: string; label: string; hint?: string; on: () => string[]; segs: () => SetSeg[]; empty?: string };
// Most tabs are a list of declarative controls; a tab may instead supply `render`
// for a bespoke pane (the Usage analytics tab), which also widens the dialog.
interface SetTab { id: string; label: string; glyph: string; controls: () => SetControl[]; render?: () => string }

const SORT_SHORT: Record<SortMode, string> = { manual: "Manual", active: "Active", attention: "Attention" };
// One-line descriptions of each worktree-grouping mode (mirrors the WtGroup comment block).
const WT_GROUP_SEGS: SetSeg[] = [
  { value: "off",       label: "Off",       glyph: "≡", sub: "Flat rows; branch shown only as a fallback label" },
  { value: "subheader", label: "Subheader", glyph: "⑃", sub: "A branch header per worktree, sessions nested beneath" },
  { value: "toplevel",  label: "Top level", glyph: "⊞", sub: "Each worktree becomes its own top-level project group" },
  { value: "chip",      label: "Chip",      glyph: "◆", sub: "Flat rows; each worktree row carries a colour-coded chip" },
];

const SET_TABS: SetTab[] = [
  {
    id: "appearance", label: "Appearance", glyph: "◐",
    controls: () => [
      { kind: "seg", set: "theme", label: "Theme", hint: "Light or dark surfaces across the whole app.",
        active: () => host.effectiveTheme(),
        segs: () => [
          { value: "light", label: "Light", glyph: "☀", sub: "Bright surfaces" },
          { value: "dark",  label: "Dark",  glyph: "☾", sub: "Dim surfaces" },
        ] },
      { kind: "font", label: "Terminal font size", hint: "Text size in embedded terminals (also ⌘+ / ⌘− / ⌘0)." },
    ],
  },
  {
    id: "sessions", label: "Sessions", glyph: "▤",
    controls: () => [
      { kind: "seg", set: "engine", label: "Launch engine", hint: "Where a new session's terminal opens.",
        active: () => termEngine,
        segs: () => availEngines.map((id) => { const d = engineDef(id); return { value: id, label: d.label, sub: d.sub, glyph: id === "embedded" ? "▤" : "⧉" }; }) },
      { kind: "seg", set: "sort", label: "Sidebar sort", hint: "How projects and sessions are ordered in the sidebar.",
        active: () => sortMode,
        segs: () => SORT_MODES.map((m) => ({ value: m, label: SORT_SHORT[m], sub: SORT_META[m].label, glyph: SORT_META[m].glyph })) },
    ],
  },
  {
    id: "tasks", label: "Tasks", glyph: "▶",
    controls: () => [
      { kind: "multi", set: "prov", label: "Scan for task files",
        hint: "Which formats Episko looks for when you open the Run picker.",
        on: () => taskPrefs.providers,
        segs: () => ALL_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] })) },
      { kind: "toggle", set: "introspect", label: "Let trusted projects introspect themselves",
        hint: "Listing justfile, Taskfile or mise tasks means running that tool, which evaluates the file and can execute code from the folder. Off means those tasks stay undiscovered.",
        on: () => taskPrefs.introspect },
      { kind: "multi", set: "untrust", label: "Trusted projects",
        hint: "Click to revoke. Your project folders are trusted because you added them; anything else asks once.",
        on: () => explicitlyTrusted(),
        segs: () => explicitlyTrusted().map((p) => ({ value: p, label: basename(p), sub: tilde(p) })),
        empty: "Nothing trusted by hand yet — your project folders already are." },
      { kind: "seg", set: "taskcwd", label: "Working directory",
        hint: "With several worktrees open, “run tests” is otherwise ambiguous. A task that declares its own directory always keeps it.",
        active: () => taskPrefs.cwd,
        segs: () => [
          { value: "session", label: "Active session", glyph: "▤", sub: "The worktree you're looking at" },
          { value: "root", label: "Repo root", glyph: "⌂", sub: "Always the main checkout" },
        ] },
      { kind: "seg", set: "dismiss", label: "Dismiss successful runs",
        hint: "Failures always stay until you close them.",
        active: () => String(taskPrefs.dismissMs),
        segs: () => [
          { value: "0", label: "Never", glyph: "◉", sub: "Keep every finished run" },
          { value: "20000", label: "After 20s", glyph: "◔", sub: "Unless you're looking at it" },
          { value: "1", label: "At once", glyph: "○", sub: "Close as soon as it passes" },
        ] },
      { kind: "toggle", set: "taskattn", label: "Raise attention when a run fails",
        hint: "Uses the same badge and tray notification as a blocked session.",
        on: () => taskPrefs.attention },
      // Set where the tasks are (the project's task panel); reviewed and revoked
      // here, the same shape as the trust list above.
      { kind: "multi", set: "unstop", label: "Run after a session stops",
        hint: "When an agent finishes a turn in one of these projects, its task runs — unfocused, so it never takes the stage. A failure keeps its pane and offers the output back to that session. Click to remove.",
        on: () => Object.keys(stopRules),
        segs: () => Object.entries(stopRules).map(([path, r]) => ({ value: path, label: `${basename(path)} · ${r.label}`, sub: tilde(path) })),
        empty: "No rules yet — set one with ⟲ in a project's task panel (⌘K → Manage this project's tasks)." },
    ],
  },
  {
    id: "worktrees", label: "Worktrees", glyph: "⑃",
    controls: () => [
      { kind: "wtpreview", label: "Worktree grouping",
        hint: "How several checkouts of one repo are shown within its project group. Pick the look that reads best for you.",
        active: () => wtGroup },
    ],
  },
  {
    id: "usage", label: "Usage", glyph: "▦",
    controls: () => [],
    render: () => usagePanelHtml(),
  },
  {
    id: "trail", label: "Trail", glyph: "◷",
    controls: () => [
      { kind: "seg", set: "trailrange", label: "How far back",
        hint: "How many days the Trail assembles. Everything on its left is derived from your transcripts, git and the usage rollup — nothing there is typed by hand.",
        active: () => String(trailRange),
        segs: () => [7, 14, 30, 90].map((d) => ({ value: String(d), label: `${d} days` })) },
      // The only control in Episko that turns on *spending money*, so the hint says
      // that plainly rather than describing the feature.
      { kind: "toggle", set: "trailsum", label: "Write a one-line summary for each day",
        hint: "Asks Claude (Haiku) to label each day from its own session titles and commit subjects — never transcript contents. One short call per day, cached: a day that is over is never re-asked. Off, every day still shows a counted headline.",
        on: () => trailSummaries },
    ],
  },
];

export let setTab = "appearance";
export function settingsOpen() { return $("setDlg").classList.contains("show"); }
export function openSettings() { $("scrim").classList.add("show"); $("setDlg").classList.add("show"); renderSettings(); }
export function closeSettings() {
  $("setDlg").classList.remove("show");
  dropScrim();
}
export function renderSettings() {
  if (!settingsOpen()) return;
  $("setTabs").innerHTML = SET_TABS.map((t) =>
    `<button class="set-tab ${t.id === setTab ? "on" : ""}" data-settab="${t.id}"><span class="set-tglyph">${t.glyph}</span>${esc(t.label)}</button>`
  ).join("");
  const tab = SET_TABS.find((t) => t.id === setTab) || SET_TABS[0];
  // The Usage tab is a wide, bespoke pane; every other tab is the narrow control list.
  $("setDlg").classList.toggle("wide", !!tab.render);
  // Preserve scroll across the full-body rebuild so picking a card lower in the
  // (scrollable) Worktrees grid doesn't jump the view back to the top.
  const body = $("setBody");
  const sc = body.scrollTop;
  body.innerHTML = tab.render ? tab.render() : tab.controls().map(renderSetControl).join("");
  body.scrollTop = sc;
  if (tab.id === "usage") host.refreshTokens(); // kick the (throttled, cached) token scan
}
// Demo roster for the worktree-grouping previews: one repo, a main checkout plus two
// worktrees, so each grouping mode visibly differs. Static on purpose — the preview
// is about layout, not live state — and self-contained so it never drags the real
// sidebar renderers (status glyphs, close buttons, telemetry) into a settings pane.
const WT_DEMO_HUE: Record<string, string> = { dev: "#818cf8", "agent-1": "#2dd4bf", "agent-2": "#f472b6" };
const WT_DEMO_ORDER = ["dev", "agent-1", "agent-2"];
const WT_DEMO: { title: string; st: "work" | "done"; ctx: number; branch: string }[] = [
  { title: "Fix telemetry routing", st: "work", ctx: 12, branch: "dev" },
  { title: "Bump CI actions",       st: "done", ctx: 61, branch: "dev" },
  { title: "Worktree cleanup",      st: "work", ctx: 34, branch: "agent-1" },
  { title: "Settings previews",     st: "done", ctx: 8,  branch: "agent-2" },
];
function wtDemoClusters() {
  return WT_DEMO_ORDER.map((b) => ({ branch: b, hue: WT_DEMO_HUE[b], isMain: b === "dev", sessions: WT_DEMO.filter((s) => s.branch === b) }));
}
function wtDemoRow(s: (typeof WT_DEMO)[number], chip = false): string {
  const chipHtml = chip ? `<span class="p-chip" style="--h:${WT_DEMO_HUE[s.branch]}">⑃ ${esc(s.branch)}</span>` : "";
  return `<div class="p-row"><span class="p-dot p-${s.st}"></span><span class="p-lbl">${esc(s.title)}</span>${chipHtml}<span class="p-ctx">${s.ctx}%</span></div>`;
}
function wtDemoHead(name: string, count: number, wt?: string): string {
  const suffix = wt ? `<span class="p-pwt">· ${esc(wt)}</span>` : "";
  return `<div class="p-phead"><span class="p-pdot"></span><span class="p-pname">${esc(name)}${suffix}</span><span class="p-pcount">${count}</span></div>`;
}
// One mini-sidebar per grouping mode — mirrors groupBody()'s shape (off/toplevel flat,
// subheader nested clusters, chip flat-with-branch-chips) so the card previews what the
// real sidebar does.
function wtPreviewBody(mode: WtGroup): string {
  if (mode === "subheader") {
    return wtDemoHead("episko", WT_DEMO.length) + wtDemoClusters().map((c) =>
      `<div class="p-wthead"><span class="p-fork" style="color:${c.hue}">⑃</span>`
      + `<span class="p-wtname" style="color:${c.hue}">${esc(c.branch)}</span>`
      + `<span class="p-wtcount">${c.sessions.length}</span></div>`
      + `<div class="p-wts" style="--h:${c.hue}">${c.sessions.map((s) => wtDemoRow(s)).join("")}</div>`
    ).join("");
  }
  if (mode === "toplevel") {
    const cs = wtDemoClusters();
    const main = cs.find((c) => c.isMain)!;
    let h = wtDemoHead("episko", main.sessions.length) + `<div class="p-rows">${main.sessions.map((s) => wtDemoRow(s)).join("")}</div>`;
    for (const c of cs.filter((c) => !c.isMain)) h += wtDemoHead("episko", c.sessions.length, c.branch) + `<div class="p-rows">${c.sessions.map((s) => wtDemoRow(s)).join("")}</div>`;
    return h;
  }
  const chip = mode === "chip";
  return wtDemoHead("episko", WT_DEMO.length) + `<div class="p-rows">${WT_DEMO.map((s) => wtDemoRow(s, chip)).join("")}</div>`;
}
// The worktree-grouping picker as a grid of selectable, live-preview cards. Each card
// carries the same data-set/data-val the seg picker uses, so the existing #setBody
// click handler routes it through applySetting → host.setWtGroup with no new wiring.
function renderWtPreview(active: string): string {
  const cards = WT_GROUP_SEGS.map((m) => {
    const on = m.value === active;
    return `<button class="wtcard${on ? " on" : ""}" data-set="wtgroup" data-val="${esc(m.value)}" aria-pressed="${on}">`
      + `<div class="wtcard-h"><span class="wtcard-glyph">${m.glyph || ""}</span><span class="wtcard-name">${esc(m.label)}</span><span class="wtcard-check">✓</span></div>`
      + `<div class="p-mini">${wtPreviewBody(m.value as WtGroup)}</div>`
      + `<div class="wtcard-desc">${esc(m.sub || "")}</div></button>`;
  }).join("");
  return `<div class="wt-grid has-sel">${cards}</div>`;
}
function renderSetControl(c: SetControl): string {
  const head = `<div class="set-glabel">${esc(c.label)}</div>${c.hint ? `<div class="set-hint">${esc(c.hint)}</div>` : ""}`;
  if (c.kind === "wtpreview") {
    return `<div class="set-group">${head}${renderWtPreview(c.active())}</div>`;
  }
  if (c.kind === "font") {
    return `<div class="set-group">${head}<div class="set-font">
      <button class="set-fbtn" data-setfont="-0.5" title="Smaller" aria-label="Smaller">−</button>
      <span class="set-fval mono">${termFontSize}px</span>
      <button class="set-fbtn" data-setfont="0.5" title="Larger" aria-label="Larger">+</button>
      <button class="set-freset" data-setfont="reset">Reset</button>
    </div></div>`;
  }
  if (c.kind === "toggle") {
    const on = c.on();
    // The label and hint have to be one block, or the row lays them out as two
    // flex siblings of the switch and the whole group centres itself.
    return `<div class="set-group set-inline"><div class="set-itxt">${head}</div>` +
      `<button class="sw${on ? " on" : ""}" data-set="${c.set}" data-val="${on ? "0" : "1"}" role="switch" aria-checked="${on}"></button></div>`;
  }
  if (c.kind === "multi") {
    const on = c.on();
    const segs = c.segs();
    if (!segs.length) return `<div class="set-group">${head}<div class="set-empty">${esc(c.empty || "Nothing here yet.")}</div></div>`;
    const opts = segs.map((s) =>
      `<button class="chip-opt ${on.includes(s.value) ? "on" : ""}" data-set="${c.set}" data-val="${esc(s.value)}" title="${esc(s.sub || s.label)}">` +
        `${s.glyph ? `<span class="seg-glyph">${s.glyph}</span>` : ""}${esc(s.label)}</button>`).join("");
    return `<div class="set-group">${head}<div class="chips">${opts}</div></div>`;
  }
  const active = c.active();
  const opts = c.segs().map((s) =>
    `<button class="seg-opt ${s.value === active ? "on" : ""}" data-set="${c.set}" data-val="${esc(s.value)}">` +
      `<span class="seg-top">${s.glyph ? `<span class="seg-glyph">${s.glyph}</span>` : ""}<span class="seg-l">${esc(s.label)}</span><span class="seg-check">✓</span></span>` +
      `${s.sub ? `<span class="seg-s">${esc(s.sub)}</span>` : ""}</button>`
  ).join("");
  return `<div class="set-group">${head}<div class="seg">${opts}</div></div>`;
}
// Dispatch a segmented pick to the existing setter, then repaint the picker.
function applySetting(set: string, val: string) {
  if (set === "theme") host.setTheme(val as "dark" | "light");
  else if (set === "engine") host.setEngine(val as Engine);
  else if (set === "sort") host.setSort(val as SortMode);
  else if (set === "wtgroup") host.setWtGroup(val as WtGroup);
  else if (set === "prov") {
    const p = val as Provider;
    const on = taskPrefs.providers.includes(p);
    // Never let every provider be switched off — an empty picker looks broken.
    if (on && taskPrefs.providers.length === 1) { toast("At least one provider has to stay on"); return; }
    taskPrefs.providers = on ? taskPrefs.providers.filter((x) => x !== p) : [...taskPrefs.providers, p];
    saveTaskPrefs();
  }
  else if (set === "introspect") { taskPrefs.introspect = val === "1"; saveTaskPrefs(); }
  else if (set === "taskcwd") { taskPrefs.cwd = val as TaskPrefs["cwd"]; saveTaskPrefs(); }
  else if (set === "dismiss") { taskPrefs.dismissMs = +val; saveTaskPrefs(); }
  else if (set === "taskattn") { taskPrefs.attention = val === "1"; saveTaskPrefs(); }
  else if (set === "untrust") untrustProject(val);
  else if (set === "unstop") clearStopRule(val);
  // `data-val` carries the DESIRED state, not the current one (see renderSetControl),
  // so "1" means turn it on. Both setters refresh the Trail themselves when it is on
  // screen, so a change here is visible at once rather than at the next open.
  else if (set === "trailrange") setTrailRange(+val);
  else if (set === "trailsum") setTrailSummaries(val === "1");
  renderSettings();
}
function setFontFromSettings(cmd: string) {
  if (cmd === "reset") { setTermFontSize(12.5); host.applyFontSize(); toast("Terminal font 12.5px"); }
  else host.bumpFont(parseFloat(cmd));
  renderSettings();
}

// ---------- the dialog's own event wiring ----------
$("setBtn").addEventListener("click", () => settingsOpen() ? closeSettings() : openSettings());
$("setClose").addEventListener("click", closeSettings);
$("setTabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-settab]");
  if (b) { setTab = b.dataset.settab!; renderSettings(); }
});
$("setBody").addEventListener("click", (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>("[data-setfont]");
  if (f) { setFontFromSettings(f.dataset.setfont!); return; }
  const r = (e.target as HTMLElement).closest<HTMLElement>("[data-urange]");
  if (r) { setUsageRange(+r.dataset.urange!); renderSettings(); return; }
  const o = (e.target as HTMLElement).closest<HTMLElement>("[data-set]");
  if (o) applySetting(o.dataset.set!, o.dataset.val!);
});
// Shared hover tooltip for the Usage panel's heatmap cells and cost bars. One
// element on <body> (not #setBody), so a renderSettings() rebuild never drops it.
const uTip = Object.assign(document.createElement("div"), { className: "u-tip", hidden: true });
document.body.appendChild(uTip);
$("setBody").addEventListener("mousemove", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
  if (!t) { uTip.hidden = true; return; }
  // dataset.tip is HTML-decoded on read; re-escape each line before re-inserting.
  uTip.innerHTML = t.dataset.tip!.split("||").map(esc).join("<br>");
  uTip.hidden = false;
  uTip.style.left = e.clientX + "px";
  uTip.style.top = (e.clientY - 14) + "px";
});
$("setBody").addEventListener("mouseleave", () => { uTip.hidden = true; });
