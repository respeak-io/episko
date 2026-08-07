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
import type { Engine, PermMode } from "./types";
import {
  ALL_PERM_MODES, availEngines, engineDef, peekPrefs, permMode, setTermFontSize,
  SORT_META, SORT_MODES, sortMode, soundPrefs, termEngine, termFontSize, wtGroup,
  type SortMode, type WtGroup,
} from "./state";
import {
  isDefaultSoundPrefs, SOUND_EVENTS, soundDefaults, toneDef, TONES, VOLUME_RANGE,
  VOLUME_STEP, type SoundEvent, type SoundEventDef, type SoundPrefs, type SoundWhen,
  type ToneId,
} from "./sound";
import { previewEvent, previewTone } from "./chime";
import {
  PEEK_CLOSE_RANGE, PEEK_DEFAULTS, PEEK_IDLE, PEEK_OPEN_RANGE, peekEnter, peekLeave,
  peekLeaveAll, peekNextDeadline, peekTick, type PeekPrefs, type PeekState,
} from "./peek";
import {
  ALL_PROVIDERS, clearStopRule, explicitlyTrusted, PROVIDER_LABEL, saveTaskPrefs,
  stopRules, taskPrefs, untrustProject, type Provider, type TaskPrefs,
} from "./tasks";
import { usagePanelHtml } from "./usageview";
import { setUsageRange } from "./usage";

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
  // Same reason as setWtGroup: the app-level one (./actions), which persists and
  // announces — state.ts's same-named setter only assigns.
  setPermMode: (m: PermMode) => void;
  // Ditto. ./actions clamps through ./peek, persists and repaints the sidebar.
  setPeekPrefs: (p: PeekPrefs) => void;
  // Ditto again — ./actions clamps through ./sound, persists and repaints this window.
  setSoundPrefs: (p: SoundPrefs) => void;
}
let host: SettingsHost = {
  setTheme: () => {}, effectiveTheme: () => "dark", setSort: () => {}, setEngine: () => {},
  bumpFont: () => {}, applyFontSize: () => {}, refreshTokens: () => {},
  setWtGroup: () => {}, setPermMode: () => {}, setPeekPrefs: () => {}, setSoundPrefs: () => {},
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
  // The sidebar's peek: one switch, two millisecond steppers, and a mini-sidebar you
  // can actually hover to feel the numbers. A stepper alone is a guess — "is 1000ms
  // right?" has no answer until you have rested a pointer on something for 1000ms.
  | { kind: "peek"; label: string; hint?: string }
  // Sound alerts: the master switch, the volume, the focus rule and a row per event.
  // One control rather than a `render` tab for the same reason `peek` is one — they
  // are one decision, and a `render` tab also widens the dialog (see renderSettings).
  | { kind: "sound"; label: string; hint?: string }
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
      { kind: "seg", set: "permmode", label: "Permission mode",
        hint: "The mode a new session starts in. ⇧⇥ inside a session still switches mode from there — this only decides where it begins. The last three stop Claude asking at all, which also means no permission cards here.",
        active: () => permMode,
        segs: () => ALL_PERM_MODES.map((m) => ({ value: m.id, label: m.label, sub: m.sub, glyph: m.glyph })) },
      { kind: "seg", set: "sort", label: "Sidebar sort", hint: "How projects and sessions are ordered in the sidebar.",
        active: () => sortMode,
        segs: () => SORT_MODES.map((m) => ({ value: m, label: SORT_SHORT[m], sub: SORT_META[m].label, glyph: SORT_META[m].glyph })) },
    ],
  },
  {
    id: "sounds", label: "Sounds", glyph: "♪",
    controls: () => [
      { kind: "sound", label: "Sound alerts",
        hint: "Episko is built for a fleet you are deliberately not watching, and every other signal it has — the glyph, the badge, the tray — needs the window in front of you. Click a row's sound name to change it; every button here plays what it does." },
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
      { kind: "peek", label: "Reveal idle checkouts on hover",
        hint: "Checkouts with nothing running in them stay out of the list until you rest on the project, then slide open. Off keeps them listed all the time. Hover the preview to feel the timings." },
    ],
  },
  {
    id: "usage", label: "Usage", glyph: "▦",
    controls: () => [],
    render: () => usagePanelHtml(),
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
// ---------- the peek control: two steppers and something to hover ----------
// The preview is built from the REAL `.pgroup` / `.pgpeek` / `.pkrow` classes and
// driven by the REAL ./peek reducer, so it cannot drift from the sidebar it is
// previewing — a mock of a timing is worth nothing, because the timing is the thing
// being judged. The only thing that is fake is the sessions.
const PEEK_DEMO = [
  { path: "demo:episko", name: "episko", hue: "#818cf8", rows: [
      { title: "Fix telemetry routing", st: "work" as const, ctx: 12 },
      { title: "Review PR #49", st: "done" as const, ctx: 61 },
    ], idle: [{ g: "⌂", b: "dev" }, { g: "⑃", b: "exp/overview" }, { g: "⑃", b: "feat/board" }] },
  { path: "demo:redactor", name: "pii-redactor", hue: "#2dd4bf", rows: [
      { title: "Regex fallback pass", st: "done" as const, ctx: 18 },
    ], idle: [{ g: "⌂", b: "main" }, { g: "⑃", b: "spike/onnx" }] },
];
function peekDemoHtml(): string {
  const groups = PEEK_DEMO.map((p) =>
    `<div class="pgroup" data-peekdemo="${esc(p.path)}">`
    + `<div class="p-phead"><span class="p-pdot" style="background:${p.hue}"></span>`
    + `<span class="p-pname">${esc(p.name)}</span><span class="p-pcount">${p.rows.length}</span>`
    // The same `.parm` the sidebar uses, wearing the same rules — the arming hairline is
    // a *timing*, so it is exactly the kind of thing this preview exists to let you feel.
    + `<span class="parm"></span></div>`
    + `<div class="p-rows">${p.rows.map((r) =>
        `<div class="p-row"><span class="p-dot p-${r.st}"></span><span class="p-lbl">${esc(r.title)}</span>`
        + `<span class="p-ctx">${r.ctx}%</span></div>`).join("")}</div>`
    + `<div class="pgpeek"><div class="pgpeek-in">${p.idle.map((w) =>
        `<div class="pkrow"><span class="pkglyph" style="color:${p.hue}">${w.g}</span>`
        + `<span class="pkname">${esc(w.b)}</span><span class="pkgo">＋</span></div>`).join("")}</div></div>`
    + `</div>`).join("");
  return `<div class="p-mini peekdemo" id="peekDemo">${groups}</div>`;
}
function stepper(which: "open" | "close", value: number, step: number, range: { min: number; max: number }): string {
  return `<div class="set-font peekstep">
    <span class="peekstep-l">${which === "open" ? "Opens after" : "Closes after"}</span>
    <button class="set-fbtn" data-setpeek="${which}:${-step}" ${value <= range.min ? "disabled" : ""} aria-label="Shorter">−</button>
    <span class="set-fval mono">${value}ms</span>
    <button class="set-fbtn" data-setpeek="${which}:${step}" ${value >= range.max ? "disabled" : ""} aria-label="Longer">+</button>
  </div>`;
}
function renderPeekControl(): string {
  const on = peekPrefs.enabled;
  const dflt = peekPrefs.openMs === PEEK_DEFAULTS.openMs && peekPrefs.closeMs === PEEK_DEFAULTS.closeMs;
  return `<div class="peekbox${on ? "" : " off"}">
    <div class="peekrow">
      ${stepper("open", peekPrefs.openMs, 100, PEEK_OPEN_RANGE)}
      ${stepper("close", peekPrefs.closeMs, 250, PEEK_CLOSE_RANGE)}
      <button class="set-freset" data-setpeek="reset" ${dflt ? "disabled" : ""}>Reset</button>
    </div>
    ${peekDemoHtml()}
    <div class="peekhint">${on
      ? "Rest on a project above. Moving straight to the other one opens it at once — the delay is there to ignore a pointer passing over, and you are already inside."
      : "Peek is off, so idle checkouts stay listed all the time. The preview shows them open."}</div>
  </div>`;
}

// ---------- the sound control: a volume, a focus rule, and a row per event ----------
// Every button in here PLAYS what it changes, and that is the design rather than a
// flourish: a list of ten names ("Chime", "Drop", "Buzz") is unusable — nobody knows
// what a "Drop" is until they have heard one, and a settings pane you cannot audition
// is a pane you set once at random and never touch again. So changing a tone plays it,
// switching an event on plays it, and nudging the volume plays at the new volume.
//
// Which row's tone strip is open. Module state like `setTab`, and deliberately not
// persisted — it is where you are looking, not something you chose.
let soundPick: SoundEvent | null = null;

function volStepper(v: number): string {
  return `<div class="set-font peekstep">
    <span class="peekstep-l">Volume</span>
    <button class="set-fbtn" data-setsound="vol:${-VOLUME_STEP}" ${v <= VOLUME_RANGE.min ? "disabled" : ""} aria-label="Quieter">−</button>
    <span class="set-fval mono">${v}%</span>
    <button class="set-fbtn" data-setsound="vol:${VOLUME_STEP}" ${v >= VOLUME_RANGE.max ? "disabled" : ""} aria-label="Louder">+</button>
  </div>`;
}
// One event. The switch is the same `.sw` the rest of the window uses; the tone name is
// a disclosure button, so ten tones × ten events stay out of sight until asked for.
function soundRow(d: SoundEventDef): string {
  const cfg = soundPrefs.events[d.id];
  const open = soundPick === d.id;
  const tone = toneDef(cfg.tone);
  const strip = open
    ? `<div class="chips sndtones">${TONES.map((t) =>
        `<button class="chip-opt ${t.id === cfg.tone ? "on" : ""}" data-setsound="tone:${d.id}:${t.id}" title="${esc(t.hint)}">${esc(t.label)}</button>`).join("")}</div>`
    : "";
  return `<div class="sndev${cfg.on ? "" : " off"}">
    <div class="sndev-h">
      <span class="sndev-g">${d.glyph}</span>
      <div class="sndev-t"><div class="sndev-l">${esc(d.label)}</div><div class="sndev-s">${esc(d.hint)}</div></div>
      <button class="sndtone${open ? " on" : ""}" data-setsound="pick:${d.id}" aria-expanded="${open}">${esc(tone.label)}<span class="sndtone-c">▾</span></button>
      <button class="sndplay" data-setsound="play:${d.id}" title="Play it" aria-label="Play ${esc(d.label)}">▶</button>
      <button class="sw${cfg.on ? " on" : ""}" data-setsound="ev:${d.id}" role="switch" aria-checked="${cfg.on}"></button>
    </div>${strip}
  </div>`;
}
const WHEN_SEGS: { value: SoundWhen; label: string }[] = [
  { value: "always", label: "Always" },
  { value: "away", label: "Only when Episko is in the background" },
];
function renderSoundControl(): string {
  const p = soundPrefs;
  return `<div class="sndbox${p.enabled ? "" : " off"}">
    <div class="peekrow">
      ${volStepper(p.volume)}
      <button class="set-freset" data-setsound="reset" ${isDefaultSoundPrefs(p) ? "disabled" : ""}>Reset</button>
    </div>
    <div class="sndwhen">
      <div class="peekstep-l">Play</div>
      <div class="chips">${WHEN_SEGS.map((w) =>
        `<button class="chip-opt ${p.when === w.value ? "on" : ""}" data-setsound="when:${w.value}">${esc(w.label)}</button>`).join("")}</div>
    </div>
    <div class="sndlist">${SOUND_EVENTS.map(soundRow).join("")}</div>
    <div class="peekhint">${p.enabled
      ? "The last three start switched off: they fire on routine activity, or on something you did yourself. Turning everything on is exactly how a set of alerts becomes background noise you stop hearing — which costs you the permission chime too."
      : "Sounds are off, so nothing below fires by itself. The rows keep what you picked, and ▶ still plays — auditioning is how you decide whether to switch them back on."}</div>
  </div>`;
}

function renderSetControl(c: SetControl): string {
  const head = `<div class="set-glabel">${esc(c.label)}</div>${c.hint ? `<div class="set-hint">${esc(c.hint)}</div>` : ""}`;
  if (c.kind === "wtpreview") {
    return `<div class="set-group">${head}${renderWtPreview(c.active())}</div>`;
  }
  if (c.kind === "peek") {
    // The switch sits on the label row (set-inline), the steppers and the preview
    // below it — one group, because they are one decision.
    return `<div class="set-group"><div class="set-inline"><div class="set-itxt">${head}</div>`
      + `<button class="sw${peekPrefs.enabled ? " on" : ""}" data-setpeek="toggle" role="switch"`
      + ` aria-checked="${peekPrefs.enabled}"></button></div>${renderPeekControl()}</div>`;
  }
  if (c.kind === "sound") {
    // Same shape as `peek` above: the master switch rides the label row, the panel it
    // governs sits under it, because they are one decision.
    return `<div class="set-group"><div class="set-inline"><div class="set-itxt">${head}</div>`
      + `<button class="sw${soundPrefs.enabled ? " on" : ""}" data-setsound="toggle" role="switch"`
      + ` aria-checked="${soundPrefs.enabled}"></button></div>${renderSoundControl()}</div>`;
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
  else if (set === "permmode") host.setPermMode(val as PermMode);
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
  renderSettings();
}
// A stepper press, the switch, or Reset. Everything routes through the host's
// clamping setter, so a value that would break the feature can't be reached by
// holding − : the button disables at the bound and the clamp catches the rest.
function applyPeekSetting(cmd: string) {
  if (cmd === "reset") { host.setPeekPrefs({ ...peekPrefs, ...PEEK_DEFAULTS, enabled: peekPrefs.enabled }); return; }
  if (cmd === "toggle") {
    const enabled = !peekPrefs.enabled;
    host.setPeekPrefs({ ...peekPrefs, enabled });
    // Off means the preview shows the rows open, so a demo mid-hover would fight it.
    peekDemoReset();
    return;
  }
  const [which, delta] = cmd.split(":");
  if (which === "open") host.setPeekPrefs({ ...peekPrefs, openMs: peekPrefs.openMs + +delta });
  else if (which === "close") host.setPeekPrefs({ ...peekPrefs, closeMs: peekPrefs.closeMs + +delta });
}

/**
 * A press in the sound panel. Everything routes through `host.setSoundPrefs`, which
 * clamps, persists and re-renders this window — so the markup above is always painted
 * from the stored value rather than from what a handler thought it had set.
 *
 * The previews are the other half. Note which ones deliberately do NOT play: switching
 * an event *off*, and Reset — a burst of ten tones is not a useful answer to "make it
 * quieter", and hearing a sound as you switch it off says the wrong thing entirely.
 */
function applySoundSetting(cmd: string) {
  const p = soundPrefs;
  const set = (next: SoundPrefs) => host.setSoundPrefs(next);
  const withEvent = (id: SoundEvent, patch: Partial<SoundPrefs["events"][SoundEvent]>) =>
    set({ ...p, events: { ...p.events, [id]: { ...p.events[id], ...patch } } });

  if (cmd === "reset") { soundPick = null; set(soundDefaults()); return; }
  if (cmd === "toggle") {
    const enabled = !p.enabled;
    set({ ...p, enabled });
    // Say so out loud when switching on — the panel is otherwise a list of promises,
    // and this is the moment the browser's autoplay gate is known to be open (a click
    // just landed), so a silent one here is worth knowing about.
    if (enabled) previewEvent("done");
    return;
  }
  const [verb, a, b] = cmd.split(":");
  if (verb === "vol") {
    // Clamping is `clampSoundPrefs`' job; the buttons disable at the bounds and this
    // catches the rest, exactly as the peek steppers do.
    set({ ...p, volume: p.volume + Number(a) });
    previewTone(soundPrefs.events.done.tone); // the NEW volume — soundPrefs is live
    return;
  }
  if (verb === "when") { set({ ...p, when: a === "away" ? "away" : "always" }); return; }
  if (verb === "ev") {
    const id = a as SoundEvent;
    const on = !p.events[id].on;
    withEvent(id, { on });
    if (on) previewEvent(id);
    return;
  }
  // The disclosure. Only one strip is open at a time — ten open strips is the list you
  // were trying not to show.
  if (verb === "pick") { soundPick = soundPick === a ? null : (a as SoundEvent); renderSettings(); return; }
  if (verb === "tone") {
    const id = a as SoundEvent;
    withEvent(id, { tone: b as ToneId });
    previewTone(b as ToneId);
    return;
  }
  if (verb === "play") previewEvent(a as SoundEvent);
}

// ---------- the preview's own peek driver ----------
// Same reducer as the sidebar's, its own state. It reads `peekPrefs` at event time
// rather than capturing it, so a stepper press is felt on the very next hover with
// no re-wiring. renderSettings() rebuilds #setBody under it, hence the reset.
let demoPeek: PeekState = PEEK_IDLE;
let demoTimer: number | null = null;
let demoHover: string | null = null;

/// Mirrors ./sidebar's `applyPeek` deliberately, hairline included — a preview that
/// showed the expansion but not the countdown would be previewing the wrong half of
/// the setting the steppers change.
function demoApply() {
  for (const el of document.querySelectorAll<HTMLElement>("#peekDemo .pgroup")) {
    el.classList.toggle("peek", el.dataset.peekdemo === demoPeek.open);
    const arming = !!demoPeek.arming && el.dataset.peekdemo === demoPeek.arming.path;
    if (arming) {
      const elapsed = Math.max(0, peekPrefs.openMs - (demoPeek.arming!.at - Date.now()));
      el.classList.remove("arming");
      void el.offsetWidth;
      el.style.setProperty("--peek-open", `${peekPrefs.openMs}ms`);
      el.style.setProperty("--peek-arm-delay", `${-elapsed}ms`);
    }
    el.classList.toggle("arming", arming);
  }
}
/// Both fields are on screen here too, so both decide whether to repaint. Comparing
/// `open` alone is the bug ./sidebar's `peekAdvance` documents: entering a group changes
/// `arming` only, nothing repaints, and the bar never appears.
function demoAdvance(next: PeekState) {
  const was = demoPeek.open + "|" + (demoPeek.arming?.path ?? "");
  demoPeek = next;
  if (demoPeek.open + "|" + (demoPeek.arming?.path ?? "") !== was) demoApply();
  if (demoTimer !== null) { clearTimeout(demoTimer); demoTimer = null; }
  const at = peekNextDeadline(demoPeek);
  if (at === null) return;
  demoTimer = window.setTimeout(() => {
    demoTimer = null;
    demoAdvance(peekTick(demoPeek, Date.now()));
  }, Math.max(0, at - Date.now()));
}
function peekDemoReset() { demoHover = null; demoAdvance(PEEK_IDLE); }

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
  const pk = (e.target as HTMLElement).closest<HTMLElement>("[data-setpeek]");
  if (pk) { applyPeekSetting(pk.dataset.setpeek!); return; }
  const sd = (e.target as HTMLElement).closest<HTMLElement>("[data-setsound]");
  if (sd) { applySoundSetting(sd.dataset.setsound!); return; }
  const r = (e.target as HTMLElement).closest<HTMLElement>("[data-urange]");
  if (r) { setUsageRange(+r.dataset.urange!); renderSettings(); return; }
  const o = (e.target as HTMLElement).closest<HTMLElement>("[data-set]");
  if (o) applySetting(o.dataset.set!, o.dataset.val!);
});
// The preview's hover, delegated on the persistent #setBody for the same reason the
// sidebar's is delegated on #projects: renderSettings() replaces the demo's DOM on
// every stepper press, and per-element listeners would go with it.
$("setBody").addEventListener("mouseover", (e) => {
  const g = (e.target as HTMLElement).closest<HTMLElement>("#peekDemo .pgroup");
  const path = g?.dataset.peekdemo;
  if (!path || path === demoHover) return;
  demoHover = path;
  demoAdvance(peekEnter(demoPeek, path, Date.now(), peekPrefs));
});
$("setBody").addEventListener("mouseout", (e) => {
  const g = (e.target as HTMLElement).closest<HTMLElement>("#peekDemo .pgroup");
  const path = g?.dataset.peekdemo;
  if (!path) return;
  const to = e.relatedTarget as Node | null;
  if (to && g!.contains(to)) return;
  if (demoHover === path) demoHover = null;
  demoAdvance(peekLeave(demoPeek, path, Date.now(), peekPrefs));
});
// Leaving the preview entirely — the pointer can exit through the gap between the
// two demo groups, where no group mouseout fires.
$("setBody").addEventListener("mouseout", (e) => {
  const demo = (e.target as HTMLElement).closest<HTMLElement>("#peekDemo");
  if (!demo) return;
  const to = e.relatedTarget as Node | null;
  if (to && demo.contains(to)) return;
  demoHover = null;
  demoAdvance(peekLeaveAll(demoPeek, Date.now(), peekPrefs));
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
