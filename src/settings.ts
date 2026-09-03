// The settings window: a tab list, a declarative control table (SET_TABS) and one
// dispatcher. Adding a setting means adding a descriptor, not markup. It owns nothing it
// changes: every setter arrives through the SettingsHost object main.ts hands over.

import { $, dropScrim, FILE_MANAGER, IS_MAC, toast } from "./dom";
import { basename, esc, escAttr, tilde } from "./format";
import { agentCapabilitySummary, type Engine } from "./types";
import { agentLogo } from "./providers/logos";
import {
  allAgents, attnPrefs, availEngines, defaultAgentDef, engineDef, footPrefs,
  motionPrefs,
  keyPrefs, missingAgents,
  peekPrefs, permissionModeFor, revivePrefs, termScrollback, vitalsPrefs,
  setTermFontSize, TERM_FONT_DEFAULT,
  SORT_META, SORT_MODES, sortMode, soundPrefs, termEngine, termFontSize, wtGroup,
  type SortMode, type WtGroup,
} from "./state";
import {
  ATTN_DEFAULTS, ATTN_HIGHLIGHT_RANGE, ATTN_HIGHLIGHT_STEP, ATTN_ORDERS,
  isDefaultAttnPrefs, type AttnOrder, type AttnPrefs,
} from "./attn";
import {
  isDefaultRevivePrefs, REVIVE_ATTEMPTS_RANGE, REVIVE_BASE_RANGE, REVIVE_DEFAULTS,
  REVIVE_FACTOR_RANGE, REVIVE_FACTOR_STEP, REVIVE_JITTER_RANGE, REVIVE_JITTER_STEP,
  REVIVE_KINDS, REVIVE_MAX_RANGE, reviveBaseStep, reviveGap, reviveMaxStep, revivePlan,
  reviveWindowMs, type ReviveKind, type RevivePrefs,
} from "./revive";
import { LIT_COLOR } from "./sidebarview";
import { FOOT_SEGS, footShown, type FootSeg } from "./footprefs";
import { fxOn, VISUAL_FX, type VisualFx } from "./motion";
import {
  driftVerdict, fmtPerHour, fmtSpanShort, leakSuspects, SCROLLBACK_OPTS, VITALS,
  VITALS_EVERY, type VitalsDrift, type VitalsPrefs,
} from "./perf";
import {
  bindKey, bindableCombo, comboKeys, comboOf, comboText, defaultKeyBinds, defaultKeyPrefs,
  isDefaultBind, isDefaultKeyPrefs, keyActionDef, KEY_GROUPS, resetKey, unbindKey,
  type KeyAction, type KeyPrefs,
} from "./keys";
import {
  isDefaultSoundPrefs, SOUND_EVENTS, soundDefaults, toneDef, TONES, VOLUME_RANGE,
  VOLUME_STEP, type SoundEvent, type SoundEventDef, type SoundPrefs, type SoundWhen,
  type ToneId,
} from "./sound";
import { previewEvent, previewTone } from "./chime";
import {
  PEEK_CLOSE_RANGE, PEEK_DEFAULTS, PEEK_IDLE, PEEK_OPEN_RANGE, peekEnter, peekLeave,
  peekLeaveAll, peekNextDeadline, peekStaysOpen, peekTick, type PeekPrefs, type PeekState,
} from "./peek";
import {
  ALL_PROVIDERS, clearStopRule, explicitlyTrusted, PROVIDER_LABEL, saveTaskPrefs,
  stopRules, taskPrefs, untrustProject, type Provider, type TaskPrefs,
} from "./tasks";
import { isDone, parseTourState, pickerChapters, TOUR_KEY } from "./tour";
import { costPopHtml, ioPopHtml, usagePanelHtml, usageRow } from "./usageview";
import { enginePopHtml, shortPopHtml } from "./footerview";
import type { Forecast } from "./rl";
import { setUsageRange } from "./usage";
import { providerAdapter, providerPermissionMode } from "./providers";

// What this dialog changes but does not own; main.ts fills it at startup, no-ops until then.
export interface SettingsHost {
  /** Replay a tour chapter; ./tourui owns the walking. */
  startTour: (chapterId: string) => void;
  setTheme: (t: "dark" | "light") => void;
  effectiveTheme: () => "dark" | "light";
  setSort: (m: SortMode, announce?: boolean) => void;
  setEngine: (id: Engine) => void;
  bumpFont: (d: number) => void;
  applyFontSize: () => void;
  refreshTokens: (force?: boolean) => void;
  // The setters below must be the app-level ones (./actions), which clamp, persist and
  // repaint; state.ts's same-named setters only assign. They come through the host
  // because ./actions imports this module and a direct import back would be a cycle.
  setWtGroup: (m: WtGroup) => void;
  setPermMode: (provider: string, mode: string) => void;
  setDefaultAgent: (id: string) => void;
  setPeekPrefs: (p: PeekPrefs) => void;
  setSoundPrefs: (p: SoundPrefs) => void;
  setKeyPrefs: (p: KeyPrefs) => void;
  setAttnPrefs: (p: AttnPrefs) => void;
  setFootSeg: (id: FootSeg) => void;
  setFx: (id: VisualFx) => void;
  setRevivePrefs: (p: RevivePrefs) => void;
  setVitalsPrefs: (p: VitalsPrefs) => void;
  setScrollback: (lines: number) => void;
  // Not settings, hence no cc- key: an inspector, a reload and a reading of ./debug's ring.
  openDevtools: () => void;
  reloadUi: () => void;
  vitalsDrift: () => VitalsDrift | null;
}
// Computed rather than fixed: with one agent installed, the useful half of the hint is
// that others exist and where to look for them.
function agentHint(): string {
  const missing = missingAgents().length;
  return "What a new session runs — ⌘N, the new-session dialog and a worktree launch all "
    + "follow this. Each row lists the integrations its provider exposes; providers without "
    + "a control-plane adapter still get a real terminal, worktree and project tools. "
    + "Per-project overrides live on a project's own menu"
    + (missing
      ? `, which also lists the ${missing} agents Episko supports that aren't on your PATH, and the binary it looked for.`
      : ".");
}

function permissionControl(): SetControl {
  const agent = defaultAgentDef();
  const provider = providerAdapter(agent.id);
  const modes = provider?.permissionModes ?? [];
  if (!agent.capabilities.includes("launch-permissions") || !modes.length) {
    return {
      kind: "note", label: `Permission mode · ${agent.label}`,
      hint: `${agent.label} does not expose an integrated launch-policy picker. Configure its permissions in the agent's own terminal or config.`,
    };
  }
  const active = providerPermissionMode(agent.id, permissionModeFor(agent.id)) ?? modes[0];
  return {
    kind: "seg", set: `permmode:${agent.id}`, label: `Permission mode · ${provider?.label ?? agent.label}`,
    hint: "The policy a new session starts with. It is stored separately for each integrated agent; changing agents above restores that agent's last choice.",
    active: () => active.id,
    segs: () => modes.map((mode) => ({ value: mode.id, label: mode.label, sub: mode.sub, glyph: mode.glyph })),
  };
}

let host: SettingsHost = {
  startTour: () => {},
  setTheme: () => {}, effectiveTheme: () => "dark", setSort: () => {}, setEngine: () => {},
  bumpFont: () => {}, applyFontSize: () => {}, refreshTokens: () => {},
  setWtGroup: () => {}, setPermMode: () => {}, setDefaultAgent: () => {}, setPeekPrefs: () => {}, setSoundPrefs: () => {},
  setKeyPrefs: () => {}, setAttnPrefs: () => {}, setFootSeg: () => {}, setFx: () => {}, setRevivePrefs: () => {},
  setVitalsPrefs: () => {}, setScrollback: () => {}, openDevtools: () => {}, reloadUi: () => {},
  vitalsDrift: () => null,
};
export function setSettingsHost(h: SettingsHost) { host = h; }

// Every control writes through the same setter the rest of the app uses; there is no
// separate settings store.
type SetSeg = { value: string; label: string; sub?: string; glyph?: string; logo?: string };
type SetControl =
  // `dim`: a stored value that currently decides nothing. Not `disabled`, so switching back restores it.
  | { kind: "seg"; set: string; label: string; hint?: string; dim?: () => boolean; active: () => string; segs: () => SetSeg[] }
  | { kind: "font"; label: string; hint?: string }
  | { kind: "wtpreview"; label: string; hint?: string; active: () => string }
  // peek, sound, attn, revive and guide are each one control with a preview under it rather
  // than a `render` tab: they are one decision, and a `render` tab widens the dialog.
  | { kind: "peek"; label: string; hint?: string }
  | { kind: "sound"; label: string; hint?: string }
  | { kind: "keys"; label: string; hint?: string }
  | { kind: "attn"; label: string; hint?: string }
  | { kind: "revive"; label: string; hint?: string }
  | { kind: "toggle"; set: string; label: string; hint?: string; on: () => boolean; preview?: () => string }
  // Prose with no control under it: a rule governing the group below.
  | { kind: "note"; label: string; hint: string }
  | { kind: "guide"; label: string; hint?: string }
  | { kind: "multi"; set: string; label: string; hint?: string; on: () => string[]; segs: () => SetSeg[]; empty?: string }
  // A verb rather than a stored choice, on the same data-set/data-val join; `danger` is the confirm
  // dialog's red.
  | { kind: "action"; set: string; label: string; hint?: string; btn: string; danger?: boolean };
// `render` replaces the control list with a bespoke pane (the Usage tab) and widens the dialog.
interface SetTab { id: string; label: string; glyph: string; controls: () => SetControl[]; render?: () => string }

const SORT_SHORT: Record<SortMode, string> = { manual: "Manual", active: "Active", attention: "Attention" };
const WT_GROUP_SEGS: SetSeg[] = [
  { value: "off",       label: "Off",       glyph: "≡", sub: "Flat rows; branch shown only as a fallback label" },
  { value: "subheader", label: "Subheader", glyph: "⑃", sub: "A branch header per worktree, sessions nested beneath" },
  { value: "toplevel",  label: "Top level", glyph: "⊞", sub: "Each worktree becomes its own top-level project group" },
  { value: "chip",      label: "Chip",      glyph: "◆", sub: "Flat rows; each worktree row carries a colour-coded chip" },
];

// ---- Settings > Footer: what each switch controls, drawn ----
// Each row shows its segment closed and open. The closed half is the footer's real markup
// (index.html, the `.fpv-bar` selectors in styles.css), so it cannot drift; the open half is
// a sketch. The figures are sample data on purpose: on a fresh install the live ones are blank.
const FPV_CLOSED: Record<FootSeg, string> = {
  sessions: `<span class="fseg">3 sessions</span>`,
  cost: `<span class="fseg fclick">today <b>$4.61</b><span class="fcaret">▴</span></span>`,
  limits: `<span class="fseg fclick"><span class="flabel">limits</span><b class="s-ok">12%</b><span class="fsub">5h</span>`
    + `<span class="freset">↻ 28m</span><span class="fmid">·</span><b class="s-ok">4%</b><span class="fsub">7d</span>`
    + `<span class="freset">↻ 4d 7h</span><span class="fcaret">▴</span></span>`,
  io: `<span class="fseg fclick"><span class="flabel">disk</span><b>1.2 GiB</b><span class="fsub">read</span>`
    + `<span class="fmid">·</span><b>348 MiB</b><span class="fsub">write</span><span class="fcaret">▴</span></span>`,
  engine: `<span class="fseg fclick">new in <b>embedded</b> <span class="fcaret">▴</span></span>`,
  shortcuts: `<span class="fseg fclick"><kbd class="fkbd">⌘</kbd><span class="flabel">Shortcuts</span><span class="fcaret">▴</span></span>`,
  debug: `<span class="fpv-dbg">🐞</span>`,
};

const fpvRow = (l: string, r: string) => `<div class="fpv-r">${esc(l)}${r}</div>`;

// Sample forecast. `resetTs` is relative to now, so "in 28m" never drifts to "in -3h".
const fpvFc = (used: number, proj: number, secLeft: number): Forecast => ({
  status: "ok", used, proj, etaSec: null, secLeft,
  resetTs: Math.floor(Date.now() / 1000) + secLeft, runsOut: false, hasRate: true, rate: null,
});

// The open half, per segment: the popover's own renderer and classes, so neither can drift.
// `sessions` has no open half (clicking it does nothing); `debug` opens a panel, not a
// popover, so it is the one hand-drawn entry.
const FPV_OPEN: Partial<Record<FootSeg, { cls: string; body: string }>> = {
  cost: {
    cls: "costpop",
    body: costPopHtml({
      total: 4.61,
      projects: [
        { key: "episko", label: "episko", sub: "", usd: 2.84 },
        { key: "site", label: "site", sub: "", usd: 1.35 },
        { key: "", label: "unattributed", sub: "", usd: 0.42 },
      ],
      sessions: [
        { key: "s1", label: "Footer previews", sub: "episko", usd: 1.9 },
        { key: "s2", label: "Call sheet", sub: "episko", usd: 0.94 },
      ],
      split: 4.19,
    }, new Set(["s1"])),
  },
  limits: {
    cls: "usagepop",
    body: `<div class="up-h">Claude usage limits</div>`
      + usageRow("Session", "5-hour window", fpvFc(12, 13, 28 * 60))
      + usageRow("Weekly", "7-day window", fpvFc(4, 10, 4 * 86400 + 7 * 3600))
      + `<div class="up-foot"><span>today <b>$110.19</b></span><span>8 live · account-wide</span></div>`,
  },
  io: {
    cls: "iopop",
    body: ioPopHtml({
      readBps: 280 * 1024, writeBps: 45 * 1024, primed: true, running: 3, note: null,
      windows: [
        { label: "today", tip: "", text: "1.2 GiB read · 348 MiB written" },
        { label: "this run", tip: "", text: "412 MiB read · 96 MiB written" },
        { label: "recorded", tip: "", text: "8.1 GiB read · 2.1 GiB written" },
      ],
    }),
  },
  engine: { cls: "", body: enginePopHtml(["embedded", "ghostty", "terminal"], "embedded") },
  shortcuts: {
    cls: "shortpop",
    body: shortPopHtml([
      { label: "Command palette", chords: [["⌘", "K"]] },
      { label: "Toggle sidebar", chords: [["⌘", "B"]] },
      { label: "Run a task…", chords: [["⌘", "⇧", "R"]] },
    ], false),
  },
  debug: {
    cls: "",
    body: `<div class="fpv-h">Debug console</div>`
      + fpvRow("telemetry", `<b>1 284</b>`) + fpvRow("paints", `<b>206</b>`) + fpvRow("errors", `<b>0</b>`),
  },
};

function footPreview(id: FootSeg): string {
  const open = FPV_OPEN[id];
  const col = (cap: string, body: string) =>
    `<div class="fpv-col"><span class="fpv-cap">${cap}</span>${body}</div>`;
  return `<div class="fpv${footShown(footPrefs, id) ? "" : " off"}">`
    + col("on the bar", `<div class="fpv-bar">${FPV_CLOSED[id]}</div>`)
    + (open ? col("when clicked", `<div class="fpv-pop menupop ${open.cls}">${open.body}</div>`) : "")
    + `</div>`;
}

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
      // The note carries the reason once; the rows come straight off ./motion's table.
      {
        kind: "note", label: "Visual effects",
        hint: "Episko sits open all day, so anything that animates or blurs is a GPU frame spent whether or not you are looking. These cost the most on a high-refresh Windows display, where the compositor redraws 144 times a second rather than 60. Nothing here changes what the app tells you — only how it draws it.",
      },
      ...VISUAL_FX.map((fx): SetControl => ({
        kind: "toggle", set: `fx:${fx.id}`, label: fx.label, hint: fx.hint,
        on: () => fxOn(motionPrefs, fx.id),
      })),
    ],
  },
  {
    id: "footer", label: "Footer", glyph: "▁",
    // One switch per ./footprefs segment. What that table omits cannot be switched off,
    // hence a note rather than disabled rows.
    controls: () => [
      {
        kind: "note", label: "What the status bar shows",
        hint: "The repo link, the version and What's new always stay, so the bar can never end up empty — and an update is not something to hide by accident.",
      },
      ...FOOT_SEGS.map((seg): SetControl => ({
        kind: "toggle", set: `foot:${seg.id}`, label: seg.label, hint: seg.hint,
        on: () => footShown(footPrefs, seg.id),
        preview: () => footPreview(seg.id),
      })),
    ],
  },
  {
    id: "sessions", label: "Sessions", glyph: "▤",
    controls: () => [
      // Outermost first: what runs, then where its terminal opens, then how it starts.
      { kind: "seg", set: "agent", label: "Agent",
        hint: agentHint(),
        // What a launch resolves, not a stale persisted id for an uninstalled agent.
        active: () => defaultAgentDef().id,
        segs: () => allAgents().map((a) => ({
          value: a.id, label: a.label, logo: agentLogo(a.id),
          sub: agentCapabilitySummary(a),
        })) },
      { kind: "seg", set: "engine", label: "Launch engine", hint: "Where a new session's terminal opens. Providers without external-terminal support stay embedded.",
        dim: () => !defaultAgentDef().capabilities.includes("external-terminal"),
        active: () => termEngine,
        segs: () => availEngines.map((id) => { const d = engineDef(id); return { value: id, label: d.label, sub: d.sub, glyph: id === "embedded" ? "▤" : "⧉" }; }) },
      permissionControl(),
      { kind: "seg", set: "sort", label: "Sidebar sort", hint: "How projects and sessions are ordered in the sidebar.",
        active: () => sortMode,
        segs: () => SORT_MODES.map((m) => ({ value: m, label: SORT_SHORT[m], sub: SORT_META[m].label, glyph: SORT_META[m].glyph })) },
      { kind: "attn", label: "When a session wants you",
        hint: "A turn finishing, a turn the API killed, a permission, a failed run. The row lights up in the rail for a few seconds, and the ⌂ badge in the header queues them all up. Hover the preview to see the light." },
      { kind: "revive", label: "Carry on after an API error",
        hint: "A 529 or a dropped Wi-Fi ends the turn, and the session then waits at its prompt — for eight hours, if it happened at midnight. Switched on, Episko waits and types a carry-on for you. It never types into a session that is asking you something, and it never retries a failure that can't be fixed by waiting (bad credentials, billing, a malformed request)." },
    ],
  },
  {
    id: "keys", label: "Keys", glyph: "⌨",
    controls: () => [
      // Names the two glyphs only; the modifier rule is the toast's, at the moment it applies.
      { kind: "keys", label: "Keyboard shortcuts",
        hint: "Click a chord and press the one you want. ⊘ turns one off, ⟲ puts it back. The switch turns off the lot." },
    ],
  },
  {
    id: "sounds", label: "Sounds", glyph: "♪",
    controls: () => [
      { kind: "sound", label: "Sound alerts",
        hint: "Episko is built for a fleet you are deliberately not watching, and every other signal it has (the glyph, the badge, the tray) needs the window in front of you. Click a row's sound name to change it; every button here plays what it does." },
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
        empty: "Nothing trusted by hand yet. Your project folders already are." },
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
      // Set from the project's task panel; reviewed and revoked here.
      { kind: "multi", set: "unstop", label: "Run after a session stops",
        hint: "When an agent finishes a turn in one of these projects, its task runs unfocused, so it never takes the stage. A failure keeps its pane and offers the output back to that session. Click to remove.",
        on: () => Object.keys(stopRules),
        segs: () => Object.entries(stopRules).map(([path, r]) => ({ value: path, label: `${basename(path)} · ${r.label}`, sub: tilde(path) })),
        empty: "No rules yet. Set one with ⟲ in a project's task panel (⌘K → Manage this project's tasks)." },
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
    id: "guide", label: "Guide", glyph: "◇",
    controls: () => [
      { kind: "guide", label: "Guided tour",
        hint: "Replay any chapter, any time. Nothing here opens by itself after the first run — when a release adds something worth showing, What's new offers it and you can say no." },
    ],
  },
  {
    id: "diag", label: "Diagnostics", glyph: "◔",
    // Recording first: it is the only row that has to be switched on before the day it is needed.
    controls: () => [
      {
        kind: "note", label: "Why this tab exists",
        hint: "Left running for a day with a fleet of panes, the interface can slowly get heavier until it feels sluggish — and a reload fixes it, which also destroys the evidence. Recording leaves a trail in the log file so the next time it happens there is something to read.",
      },
      {
        kind: "toggle", set: "perf:vitals", label: "Record performance vitals",
        hint: "Samples what the interface is holding — DOM nodes, heap, terminal buffers, the per-session structures — and writes one line per sample into Episko's rolling log, where it survives a crash and a reload. Costs a fraction of a millisecond each time.",
        on: () => vitalsPrefs.enabled,
        preview: () => vitalsPreview(),
      },
      {
        kind: "seg", set: "perf:every", label: "Sample every",
        hint: "How often a reading is taken. Below a minute is mostly noise from whatever turn happens to be running; above a quarter of an hour a fifteen-hour slide lands in too few points to see where it started.",
        dim: () => !vitalsPrefs.enabled,
        active: () => String(vitalsPrefs.everyMs),
        segs: () => VITALS_EVERY.map((ms) => ({
          value: String(ms),
          label: ms < 3_600_000 ? `${ms / 60_000} min` : `${ms / 3_600_000} h`,
          glyph: ms === 60_000 ? "◕" : ms === 300_000 ? "◑" : "◔",
          sub: ms === 60_000 ? "Finest; four hours in memory" : ms === 300_000 ? "A full day in memory" : "Coarsest; lightest log",
        })) },
      {
        kind: "note", label: "Two things that change the weight",
        hint: "Everything above only watches. These two act — the first on what the app holds from now on, the second on what it is holding right now.",
      },
      {
        kind: "seg", set: "perf:scroll", label: "Terminal scrollback",
        hint: "Lines of history each pane keeps. Across a fleet this is the largest single thing a long-running Episko holds, and a pane only gives it back when its session ends. Lowering it applies to the panes already open and drops their oldest lines at once.",
        active: () => String(termScrollback),
        segs: () => SCROLLBACK_OPTS.map((n) => ({
          value: String(n),
          label: `${n.toLocaleString()} lines`,
          glyph: n === 1000 ? "▁" : n === 4000 ? "▄" : "█",
          sub: n === 1000 ? "Lightest; roughly a screen of recent history" : n === 4000 ? "Half the default" : "The default",
        })) },
      {
        kind: "action", set: "perf:reload", label: "Reload the interface", btn: "Reload",
        hint: "Rebuilds the window from scratch and gives back whatever it had accumulated. No session is lost: Episko itself holds the terminals, and every pane is re-adopted with its scrollback. This is the fix when it has already gone sluggish.",
      },
      {
        kind: "action", set: "perf:devtools", label: "Web inspector", btn: "Open",
        hint: "The webview's own developer tools. Memory takes a heap snapshot you can compare against one from just after a reload; Performance records a profile. This is what turns “something is growing” into a name.",
      },
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
// `setTab` is a module `let` and an ESM import of it is read-only, so this is the seam.
export function openSettingsOn(tab: string) { setTab = tab; openSettings(); }
export function closeSettings() {
  // Disarm first: the recorder listens on `window` and would go on swallowing every chord.
  stopKeyRec();
  $("setDlg").classList.remove("show");
  dropScrim();
}
export function renderSettings() {
  if (!settingsOpen()) return;
  $("setTabs").innerHTML = SET_TABS.map((t) =>
    `<button class="set-tab ${t.id === setTab ? "on" : ""}" data-settab="${t.id}"><span class="set-tglyph">${t.glyph}</span>${esc(t.label)}</button>`
  ).join("");
  const tab = SET_TABS.find((t) => t.id === setTab) || SET_TABS[0];
  $("setDlg").classList.toggle("wide", !!tab.render);
  // Preserve scroll across the rebuild; the Worktrees grid scrolls.
  const body = $("setBody");
  const sc = body.scrollTop;
  body.innerHTML = tab.render ? tab.render() : tab.controls().map(renderSetControl).join("");
  body.scrollTop = sc;
  if (tab.id === "usage") host.refreshTokens(); // kick the (throttled, cached) token scan
}
// Demo roster for the grouping previews: static, and self-contained so the real sidebar
// renderers stay out of a settings pane.
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
// Mirrors groupBody()'s shape per mode, so the card previews what the real sidebar does.
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
// Cards carry the same data-set/data-val as the seg picker, so #setBody's handler needs no new wiring.
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
// The real `.pgroup`/`.pgpeek`/`.pkrow` classes driven by the real ./peek reducer; only
// the sessions are fake. The third project has no sessions on purpose: it is the exemption
// switch's whole preview, and keeps the steppers demonstrable with that switch on.
const PEEK_DEMO = [
  { path: "demo:episko", name: "episko", hue: "#818cf8", rows: [
      { title: "Fix telemetry routing", st: "work" as const, ctx: 12 },
      { title: "Review PR #49", st: "done" as const, ctx: 61 },
    ], idle: [{ g: "⌂", b: "dev" }, { g: "⑃", b: "exp/overview" }, { g: "⑃", b: "feat/board" }] },
  { path: "demo:redactor", name: "pii-redactor", hue: "#2dd4bf", rows: [
      { title: "Regex fallback pass", st: "done" as const, ctx: 18 },
    ], idle: [{ g: "⌂", b: "main" }, { g: "⑃", b: "spike/onnx" }] },
  { path: "demo:site", name: "docs-site", hue: "#f472b6", rows: [],
    idle: [{ g: "⌂", b: "main" }, { g: "⑃", b: "chore/deps" }] },
];
function peekDemoHtml(): string {
  const groups = PEEK_DEMO.map((p) => {
    // The same question ./sidebarview asks of the same function, so the two cannot disagree.
    const open = peekStaysOpen(peekPrefs, p.rows.length > 0);
    // "idle" rather than 0: the pill is why this group still collapses.
    const count = p.rows.length ? String(p.rows.length) : "idle";
    return `<div class="pgroup" data-peekdemo="${esc(p.path)}">`
      + `<div class="p-phead"><span class="p-pdot" style="background:${p.hue}"></span>`
      + `<span class="p-pname">${esc(p.name)}</span><span class="p-pcount">${count}</span>`
      + `<span class="parm"></span></div>`
      + (p.rows.length ? `<div class="p-rows">${p.rows.map((r) =>
          `<div class="p-row"><span class="p-dot p-${r.st}"></span><span class="p-lbl">${esc(r.title)}</span>`
          + `<span class="p-ctx">${r.ctx}%</span></div>`).join("")}</div>` : "")
      + `<div class="pgpeek${open ? " open" : ""}"><div class="pgpeek-in">${p.idle.map((w) =>
          `<div class="pkrow"><span class="pkglyph" style="color:${p.hue}">${w.g}</span>`
          + `<span class="pkname">${esc(w.b)}</span><span class="pkgo">＋</span></div>`).join("")}</div></div>`
      + `</div>`;
  }).join("");
  // `pinned` only sizes the box; a preview that resized as you hovered would distract.
  return `<div class="p-mini peekdemo${peekPrefs.enabled && peekPrefs.pinLive ? " pinned" : ""}" id="peekDemo">${groups}</div>`;
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
  // Named from the demo: the sentence sits over the preview and must match it.
  const busy = PEEK_DEMO.filter((p) => p.rows.length).map((p) => p.name);
  const quiet = PEEK_DEMO.find((p) => !p.rows.length)?.name ?? "the idle project";
  const pin = peekPrefs.pinLive;
  const pinHint = on
    ? "A project you have a session open in keeps its other checkouts on screen, which is the moment the sibling worktree is the next thing you start something in. Projects with nothing running still collapse."
    : "Nothing to exempt while peek is off: every checkout is listed already.";
  return `<div class="peekbox${on ? "" : " off"}">
    <div class="peekrow">
      ${stepper("open", peekPrefs.openMs, 100, PEEK_OPEN_RANGE)}
      ${stepper("close", peekPrefs.closeMs, 250, PEEK_CLOSE_RANGE)}
      <button class="set-freset" data-setpeek="reset" ${dflt ? "disabled" : ""}>Reset</button>
    </div>
    <div class="peeksub set-inline">
      <div class="set-itxt">
        <div class="set-glabel">Keep them listed in projects with a session</div>
        <div class="set-hint">${esc(pinHint)}</div>
      </div>
      <button class="sw${pin ? " on" : ""}" data-setpeek="live" role="switch"
        aria-checked="${pin}" ${on ? "" : "disabled"}></button>
    </div>
    ${peekDemoHtml()}
    <div class="peekhint">${esc(!on
      ? "Peek is off, so idle checkouts stay listed all the time. The preview shows them open."
      : pin
        ? `${busy.join(" and ")} have a session, so their checkouts stay listed. ${quiet} has none, so rest on it to feel the delay.`
        : "Rest on a project above. Moving straight to the other one opens it at once, since the delay is there to ignore a pointer passing over and you are already inside.")}</div>
  </div>`;
}

// ---------- the attention control: a light you can see, and a queue order ----------
// Three real sidebar rows (`.psessions > .srow.lit` is the rail's exact CSS path); only
// the contents are invented. It replays on hover and on every repaint, so a stepper
// press plays the new duration at once.
const ATTN_DEMO: { title: string; k: string; glyph: string; cls: string; ctx: string }[] = [
  { title: "Fix telemetry routing", k: "done",      glyph: "✓", cls: "g-done",  ctx: "12%" },
  { title: "Review PR #49",         k: "attention", glyph: "◆", cls: "g-attn",  ctx: "61%" },
  { title: "fe-check",              k: "error",     glyph: "✕", cls: "g-error", ctx: "exit 1" },
];
function attnDemoHtml(): string {
  // Unlit while the switch is off: the honest preview of what the rail will then do.
  const on = attnPrefs.highlight ? " lit" : "";
  const rows = ATTN_DEMO.map((d) =>
    `<div class="srow${on}" style="--lit-ms:${attnPrefs.highlightMs}ms;--lit-c:${LIT_COLOR[d.k] ?? LIT_COLOR.done}">`
    + `<span class="sglyph ${d.cls}">${d.glyph}</span>`
    + `<span class="sbranch">${esc(d.title)}</span>`
    + `<span class="sctx">${esc(d.ctx)}</span></div>`).join("");
  return `<div class="p-mini attndemo" id="attnDemo"><div class="psessions">${rows}</div></div>`;
}
function attnStepper(v: number): string {
  return `<div class="set-font peekstep">
    <span class="peekstep-l">Fades over</span>
    <button class="set-fbtn" data-setattn="hl:${-ATTN_HIGHLIGHT_STEP}" ${v <= ATTN_HIGHLIGHT_RANGE.min ? "disabled" : ""} aria-label="Shorter">−</button>
    <span class="set-fval mono">${(v / 1000).toFixed(1)}s</span>
    <button class="set-fbtn" data-setattn="hl:${ATTN_HIGHLIGHT_STEP}" ${v >= ATTN_HIGHLIGHT_RANGE.max ? "disabled" : ""} aria-label="Longer">+</button>
  </div>`;
}
function renderAttnControl(): string {
  const p = attnPrefs;
  return `<div class="attnbox${p.highlight ? "" : " off"}">
    <div class="peekrow">
      ${attnStepper(p.highlightMs)}
      <button class="set-freset" data-setattn="reset" ${isDefaultAttnPrefs(p) ? "disabled" : ""}>Reset</button>
    </div>
    ${attnDemoHtml()}
    <div class="sndwhen">
      <div class="peekstep-l">Queue order</div>
      <div class="chips">${ATTN_ORDERS.map((o) =>
        `<button class="chip-opt ${p.order === o.id ? "on" : ""}" data-setattn="order:${o.id}" title="${esc(o.sub)}">`
        + `<span class="seg-glyph">${o.glyph}</span>${esc(o.label)}</button>`).join("")}</div>
    </div>
    <div class="peeksub set-inline">
      <div class="set-itxt">
        <div class="set-glabel">Clear it when you open the session</div>
        <div class="set-hint">Going to a session takes it out of the badge, the tray and the palette's “Needs you”. A blocking permission stays until you actually answer it — looking at one doesn't unblock the agent. Off means the badge only empties when the sessions in it move on by themselves.</div>
      </div>
      <button class="sw${p.clearOnOpen ? " on" : ""}" data-setattn="clear" role="switch" aria-checked="${p.clearOnOpen}"></button>
    </div>
    <div class="peekhint">${esc(p.highlight
      ? "The rail is where you catch this: a session finishing three projects down is otherwise one glyph quietly changing colour among twenty. The light stops the moment you open the pane — it is there to point, not to nag."
      : "The highlight is off, so a finished session is announced by its glyph and the badge alone. The queue order and the clearing rule above still apply.")}</div>
  </div>`;
}
// ---------- the revive watchdog ----------
// Five numbers nobody can evaluate individually; the ladder preview (`reviveWindowMs`)
// is the sentence that says what they add up to.

// One stepper row; `cmd` is the data-setrevive verb.
function rvStepper(label: string, cmd: string, shown: string, atMin: boolean, atMax: boolean): string {
  return `<div class="set-font peekstep">
    <span class="peekstep-l">${esc(label)}</span>
    <button class="set-fbtn" data-setrevive="${cmd}:-1" ${atMin ? "disabled" : ""} aria-label="Less">−</button>
    <span class="set-fval mono">${esc(shown)}</span>
    <button class="set-fbtn" data-setrevive="${cmd}:1" ${atMax ? "disabled" : ""} aria-label="More">+</button>
  </div>`;
}

// A rung sitting on the cap is marked: past it, raising `attempts` buys repetition, not reach.
function reviveLadderHtml(p: RevivePrefs): string {
  const plan = revivePlan(p);
  const chips = plan.map((ms, i) =>
    `<span class="rv-rung${ms >= p.maxMs && p.factor > 1 ? " capped" : ""}" title="Attempt ${i + 1}">${esc(reviveGap(ms))}</span>`).join("");
  return `<div class="rv-ladder">
    <div class="rv-rungs">${chips}</div>
    <div class="rv-total">Rides out an outage of about <b>${esc(reviveGap(reviveWindowMs(p)))}</b>, then leaves the session for you.</div>
  </div>`;
}

function renderReviveControl(): string {
  const p = revivePrefs;
  const none = p.kinds.length === 0;
  return `<div class="rvbox${p.enabled ? "" : " off"}">
    <div class="peekrow rv-steps">
      ${rvStepper("First wait", "base", reviveGap(p.baseMs), p.baseMs <= REVIVE_BASE_RANGE.min, p.baseMs >= REVIVE_BASE_RANGE.max)}
      ${rvStepper("Then × ", "factor", p.factor.toFixed(2).replace(/\.?0+$/, ""), p.factor <= REVIVE_FACTOR_RANGE.min, p.factor >= REVIVE_FACTOR_RANGE.max)}
      ${rvStepper("Never longer than", "max", reviveGap(p.maxMs), p.maxMs <= REVIVE_MAX_RANGE.min, p.maxMs >= REVIVE_MAX_RANGE.max)}
    </div>
    <div class="peekrow rv-steps">
      ${rvStepper("Give up after", "att", `${p.attempts} ${p.attempts === 1 ? "try" : "tries"}`, p.attempts <= REVIVE_ATTEMPTS_RANGE.min, p.attempts >= REVIVE_ATTEMPTS_RANGE.max)}
      ${rvStepper("Scatter by", "jit", `${p.jitterPct}%`, p.jitterPct <= REVIVE_JITTER_RANGE.min, p.jitterPct >= REVIVE_JITTER_RANGE.max)}
      <button class="set-freset" data-setrevive="reset" ${isDefaultRevivePrefs(p) ? "disabled" : ""}>Reset</button>
    </div>
    ${reviveLadderHtml(p)}
    <div class="sndwhen">
      <div class="peekstep-l">Failures worth retrying</div>
      <div class="chips">${REVIVE_KINDS.map((k) =>
        `<button class="chip-opt ${p.kinds.includes(k.id) ? "on" : ""}" data-setrevive="kind:${k.id}" title="${escAttr(k.hint)}">`
        + `<span class="seg-glyph">${k.glyph}</span>${esc(k.label)}</button>`).join("")}</div>
    </div>
    <div class="peekhint">${esc(!p.enabled
      ? "Off: a turn the API kills stays killed, and the session waits at its prompt until you send it something. That is what every version of Episko before this one did."
      : none
        ? "Nothing is ticked, so nothing will ever be retried — the switch above is on but this panel has no work. Tick at least one kind of failure."
        : "Scatter keeps a fleet from retrying in lockstep: six sessions killed by the same 529 would otherwise all come back in the same second and be the overload. While the machine has no network at all, waiting costs no attempts — the ladder resumes the moment it is back.")}</div>
  </div>`;
}

// All through host.setRevivePrefs (clamps, persists, repaints), so the markup is always
// drawn from the stored value.
function applyReviveSetting(cmd: string) {
  const p = revivePrefs;
  if (cmd === "reset") { host.setRevivePrefs({ ...REVIVE_DEFAULTS, enabled: p.enabled }); return; }
  if (cmd === "toggle") { host.setRevivePrefs({ ...p, enabled: !p.enabled }); return; }
  const [verb, a] = cmd.split(":");
  const dir = Number(a);
  // The ms knobs step in proportion to their value; clamping is clampRevivePrefs' job.
  if (verb === "base") host.setRevivePrefs({ ...p, baseMs: p.baseMs + dir * reviveBaseStep(p.baseMs) });
  else if (verb === "max") host.setRevivePrefs({ ...p, maxMs: p.maxMs + dir * reviveMaxStep(p.maxMs) });
  else if (verb === "factor") host.setRevivePrefs({ ...p, factor: p.factor + dir * REVIVE_FACTOR_STEP });
  else if (verb === "att") host.setRevivePrefs({ ...p, attempts: p.attempts + dir });
  else if (verb === "jit") host.setRevivePrefs({ ...p, jitterPct: p.jitterPct + dir * REVIVE_JITTER_STEP });
  else if (verb === "kind") {
    const k = a as ReviveKind;
    // Unlike the provider picker, an empty list is a coherent choice; the hint says so.
    host.setRevivePrefs({ ...p, kinds: p.kinds.includes(k) ? p.kinds.filter((x) => x !== k) : [...p.kinds, k] });
  }
}

// All through host.setAttnPrefs (clamps, persists, repaints), so the preview replays at
// the new timing for free.
function applyAttnSetting(cmd: string) {
  const p = attnPrefs;
  if (cmd === "reset") { host.setAttnPrefs(ATTN_DEFAULTS); return; }
  if (cmd === "highlight") { host.setAttnPrefs({ ...p, highlight: !p.highlight }); return; }
  if (cmd === "clear") { host.setAttnPrefs({ ...p, clearOnOpen: !p.clearOnOpen }); return; }
  const [verb, a] = cmd.split(":");
  if (verb === "hl") host.setAttnPrefs({ ...p, highlightMs: p.highlightMs + Number(a) });
  else if (verb === "order") host.setAttnPrefs({ ...p, order: a as AttnOrder });
}
let attnHover: HTMLElement | null = null; // the preview row under the pointer; not persisted
// Restarting a CSS animation needs the class off, a forced layout, then on again (as applyFlash does).
function attnDemoReplay(el: HTMLElement) {
  el.classList.remove("lit");
  if (!attnPrefs.highlight) return;
  void el.offsetWidth;
  el.classList.add("lit");
}

// ---------- the sound control: a volume, a focus rule, and a row per event ----------
// Every button plays what it changes: nobody knows what a "Drop" is until they have heard one.
let soundPick: SoundEvent | null = null; // which row's tone strip is open; not persisted

function volStepper(v: number): string {
  return `<div class="set-font peekstep">
    <span class="peekstep-l">Volume</span>
    <button class="set-fbtn" data-setsound="vol:${-VOLUME_STEP}" ${v <= VOLUME_RANGE.min ? "disabled" : ""} aria-label="Quieter">−</button>
    <span class="set-fval mono">${v}%</span>
    <button class="set-fbtn" data-setsound="vol:${VOLUME_STEP}" ${v >= VOLUME_RANGE.max ? "disabled" : ""} aria-label="Louder">+</button>
  </div>`;
}
// The tone name is a disclosure button, so ten tones × ten events stay out of sight until asked.
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
      ? "The last three start switched off: they fire on routine activity, or on something you did yourself. Turning everything on is exactly how a set of alerts becomes background noise you stop hearing, which costs you the permission chime too."
      : "Sounds are off, so nothing below fires by itself. The rows keep what you picked, and ▶ still plays, since auditioning is how you decide whether to switch them back on."}</div>
  </div>`;
}

// ---------- the shortcut picker: a row per action, recording a real keypress ----------
// The recorder takes the chord itself through ./keys' `comboOf`, the same normalisation
// the global handler matches with, so what you press and what fires cannot disagree.
let keyRec: KeyAction | null = null; // the armed row; not persisted
// Both of main.ts's global keydown handlers stand down while armed: the `reveal` capture
// listener was registered earlier and so runs before ours; the bubbling dispatcher would
// still see a press this recorder lets through (a bare modifier, an unbindable key).
export function keyRecording() { return keyRec !== null; }

// Reads `keyPrefs.binds` directly, the one allowed exception to `activeBind`: this window
// edits the stored chords, so with the master switch off it must still show them.
function keyChordHtml(id: KeyAction): string {
  const keys = comboKeys(keyPrefs.binds[id], IS_MAC);
  if (!keys.length) return `<span class="kb-none">Off</span>`;
  return keys.map((k) => `<kbd>${esc(k)}</kbd>`).join("");
}
function keyRow(id: KeyAction): string {
  const d = keyActionDef(id);
  const rec = keyRec === id;
  const dflt = isDefaultBind(keyPrefs.binds, id);
  const bound = !!keyPrefs.binds[id];
  // ./keys is pure and cannot read the platform; the footer's popover completes it the same way.
  const label = id === "reveal" ? `${d.label} in ${FILE_MANAGER}` : d.label;
  // ⊘ and "turn off", not ✕ and "clear": a state rather than a deletion, and ⟲ puts it back.
  return `<div class="kbrow${rec ? " rec" : ""}${bound ? "" : " off"}">
    <div class="kb-t"><div class="kb-l">${esc(label)}</div>${d.hint ? `<div class="kb-s">${esc(d.hint)}</div>` : ""}</div>
    <button class="kb-chord${rec ? " rec" : ""}" data-setkey="rec:${id}" aria-label="Change the shortcut for ${esc(d.label)}">${
      rec ? `<span class="kb-rec">Press a chord<i>esc</i></span>` : keyChordHtml(id)}</button>
    <button class="kb-x" data-setkey="clear:${id}" title="Turn this one shortcut off; ⟲ puts it back"
      aria-label="Turn off ${esc(d.label)}" ${bound ? "" : "disabled"}>⊘</button>
    <button class="kb-x" data-setkey="reset:${id}" title="Back to ${esc(comboText(defaultKeyBinds()[id], IS_MAC))}"
      aria-label="Reset ${esc(d.label)}" ${dflt ? "disabled" : ""}>⟲</button>
  </div>`;
}
function renderKeysControl(): string {
  const groups = KEY_GROUPS.map((g) =>
    `<div class="kbgroup"><div class="kb-gh">${esc(g.label)}</div>${g.actions.map(keyRow).join("")}</div>`
  ).join("");
  // Named rather than counted, and switched-off rows kept apart from rebound ones: which
  // shortcuts will not fire is the one state worth confirming at a glance.
  const touched = KEY_GROUPS.flatMap((g) => g.actions).filter((id) => !isDefaultBind(keyPrefs.binds, id));
  const names = (l: KeyAction[]) => l.map((id) => keyActionDef(id).label).join(", ");
  const offRows = touched.filter((id) => !keyPrefs.binds[id]);
  const rebound = touched.filter((id) => keyPrefs.binds[id]);
  const on = keyPrefs.enabled;
  // With the switch off, the only thing worth saying is that the chords are kept.
  const summary = !on
    ? "Switched off. Nothing below fires, and your chords are kept."
    : [offRows.length ? `Off: ${names(offRows)}` : "", rebound.length ? `Changed: ${names(rebound)}` : ""]
        .filter(Boolean).join(" · ") || "Every shortcut is at its default";
  return `<div class="kbbox${on ? "" : " off"}">
    <div class="peekrow kb-top">
      <span class="peekstep-l">${esc(summary)}</span>
      <button class="set-freset" data-setkey="resetall" ${isDefaultKeyPrefs(keyPrefs) ? "disabled" : ""}>Reset all</button>
    </div>
    ${groups}
    <div class="peekhint">${on
      ? "Esc and a terminal's copy/paste aren't listed; they belong to whatever is open."
      : "Esc and a terminal's copy/paste still work. Rows can still be set; they just won't fire."}</div>
  </div>`;
}

/** A press in the shortcut picker. Recording is armed here and captured below. */
function applyKeySetting(cmd: string) {
  if (cmd === "resetall") { stopKeyRec(); host.setKeyPrefs(defaultKeyPrefs()); return; }
  if (cmd === "toggle") {
    // Disarm first: a row still recording would bind into a layer no longer listening.
    stopKeyRec();
    const enabled = !keyPrefs.enabled;
    host.setKeyPrefs({ ...keyPrefs, enabled });
    toast(enabled ? "Shortcuts on" : "Shortcuts off. Your chords are kept");
    return;
  }
  const [verb, id] = cmd.split(":") as [string, KeyAction];
  if (verb === "rec") {
    // Clicking the armed row again disarms it, so the recorder is never a trap.
    if (keyRec === id) { stopKeyRec(); renderSettings(); return; }
    keyRec = id;
    window.addEventListener("keydown", recordKey, true);
    renderSettings();
    return;
  }
  stopKeyRec();
  if (verb === "clear") host.setKeyPrefs({ ...keyPrefs, binds: unbindKey(keyPrefs.binds, id) });
  else if (verb === "reset") host.setKeyPrefs({ ...keyPrefs, binds: resetKey(keyPrefs.binds, id) });
}
function stopKeyRec() {
  if (keyRec === null) return;
  keyRec = null;
  window.removeEventListener("keydown", recordKey, true);
}
// Swallows every press while armed (a chord that also reached the app would fire the
// shortcut it is replacing), except a bare modifier: the chord is still being assembled.
function recordKey(e: KeyboardEvent) {
  const id = keyRec;
  if (id === null) return;
  // Esc before normalisation: ./keys refuses to bind a named key, so `comboOf` returns
  // null for it and the only way out of a recording would stay armed forever.
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopKeyRec(); renderSettings(); return; }
  const c = comboOf(e, { digits: id === "sessionSwitch" });
  if (!c) return; // a lone ⌘/⇧/⌥ held down, or a key this layer won't bind: keep waiting
  e.preventDefault();
  e.stopPropagation();
  if (!bindableCombo(c)) {
    // Refused rather than stored: a bare letter bound app-wide also breaks typing it (see bindableCombo).
    toast(`${comboText(c, IS_MAC)} needs ${IS_MAC ? "⌘ or ⌥" : "Ctrl or Alt"}`);
    return;
  }
  stopKeyRec();
  const { binds, took } = bindKey(keyPrefs.binds, id, c);
  host.setKeyPrefs({ ...keyPrefs, binds });
  // Say who lost it: nobody watches a row they weren't looking at.
  if (took.length) toast(`${comboText(c, IS_MAC)} taken from ${took.map((t) => keyActionDef(t).label).join(", ")}`);
  else toast(`${keyActionDef(id).label} → ${comboText(c, IS_MAC)}`);
}

function renderSetControl(c: SetControl): string {
  const head = `<div class="set-glabel">${esc(c.label)}</div>${c.hint ? `<div class="set-hint">${esc(c.hint)}</div>` : ""}`;
  if (c.kind === "note") return `<div class="set-group set-note">${head}</div>`;
  if (c.kind === "wtpreview") {
    return `<div class="set-group">${head}${renderWtPreview(c.active())}</div>`;
  }
  if (c.kind === "peek") {
    // The governing switch rides the label row and the panel sits under it; attn, revive,
    // sound and keys share the shape.
    return `<div class="set-group"><div class="set-inline"><div class="set-itxt">${head}</div>`
      + `<button class="sw${peekPrefs.enabled ? " on" : ""}" data-setpeek="toggle" role="switch"`
      + ` aria-checked="${peekPrefs.enabled}"></button></div>${renderPeekControl()}</div>`;
  }
  if (c.kind === "attn") {
    // The switch is the highlight's, not the whole control's: queue order and clearing are choices.
    return `<div class="set-group"><div class="set-inline"><div class="set-itxt">${head}</div>`
      + `<button class="sw${attnPrefs.highlight ? " on" : ""}" data-setattn="highlight" role="switch"`
      + ` aria-checked="${attnPrefs.highlight}"></button></div>${renderAttnControl()}</div>`;
  }
  if (c.kind === "guide") {
    return `<div class="set-group">${head}${renderGuideControl()}</div>`;
  }
  if (c.kind === "revive") {
    // Here the switch governs the whole control, so renderReviveControl dims itself and says so.
    return `<div class="set-group"><div class="set-inline"><div class="set-itxt">${head}</div>`
      + `<button class="sw${revivePrefs.enabled ? " on" : ""}" data-setrevive="toggle" role="switch"`
      + ` aria-checked="${revivePrefs.enabled}"></button></div>${renderReviveControl()}</div>`;
  }
  if (c.kind === "sound") {
    return `<div class="set-group"><div class="set-inline"><div class="set-itxt">${head}</div>`
      + `<button class="sw${soundPrefs.enabled ? " on" : ""}" data-setsound="toggle" role="switch"`
      + ` aria-checked="${soundPrefs.enabled}"></button></div>${renderSoundControl()}</div>`;
  }
  if (c.kind === "keys") {
    return `<div class="set-group"><div class="set-inline"><div class="set-itxt">${head}</div>`
      + `<button class="sw${keyPrefs.enabled ? " on" : ""}" data-setkey="toggle" role="switch"`
      + ` aria-checked="${keyPrefs.enabled}"></button></div>${renderKeysControl()}</div>`;
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
    // Label and hint must be one block, or the row lays them out as two flex siblings of the switch.
    const inner = `<div class="set-itxt">${head}</div>`
      + `<button class="sw${on ? " on" : ""}" data-set="${c.set}" data-val="${on ? "0" : "1"}" role="switch" aria-checked="${on}"></button>`;
    // With a preview the row becomes a child and the preview sits under it.
    return c.preview
      ? `<div class="set-group"><div class="set-inline">${inner}</div>${c.preview()}</div>`
      : `<div class="set-group set-inline">${inner}</div>`;
  }
  if (c.kind === "action") {
    // A toggle's row shape with a button where the switch would be.
    return `<div class="set-group set-inline"><div class="set-itxt">${head}</div>`
      + `<button class="set-abtn${c.danger ? " danger" : ""}" data-set="${c.set}" data-val="1">${esc(c.btn)}</button></div>`;
  }
  if (c.kind === "multi") {
    const on = c.on();
    const segs = c.segs();
    if (!segs.length) return `<div class="set-group">${head}<div class="set-empty">${esc(c.empty || "Nothing here yet.")}</div></div>`;
    const opts = segs.map((s) =>
      `<button class="chip-opt ${on.includes(s.value) ? "on" : ""}" data-set="${c.set}" data-val="${esc(s.value)}" title="${esc(s.sub || s.label)}">` +
        `${s.logo ? `<span class="seg-glyph agent-logo" aria-hidden="true">${s.logo}</span>` : s.glyph ? `<span class="seg-glyph">${s.glyph}</span>` : ""}${esc(s.label)}</button>`).join("");
    return `<div class="set-group">${head}<div class="chips">${opts}</div></div>`;
  }
  const active = c.active();
  const dim = c.dim?.() ? " set-dim" : "";
  const opts = c.segs().map((s) =>
    `<button class="seg-opt ${s.value === active ? "on" : ""}" data-set="${c.set}" data-val="${esc(s.value)}">` +
      `<span class="seg-top">${s.logo ? `<span class="seg-glyph agent-logo" aria-hidden="true">${s.logo}</span>` : s.glyph ? `<span class="seg-glyph${[...s.glyph].length === 2 ? " seg-mono" : ""}">${s.glyph}</span>` : ""}<span class="seg-l">${esc(s.label)}</span><span class="seg-check">✓</span></span>` +
      `${s.sub ? `<span class="seg-s">${esc(s.sub)}</span>` : ""}</button>`
  ).join("");
  return `<div class="set-group${dim}">${head}<div class="seg">${opts}</div></div>`;
}
// ---- Settings > Diagnostics: the growth series, drawn ----
// The verdict is always shown, the table only when it has rows. Each row spells its kind:
// a `level` reading high is information, a `growth` reading high is a suspect. Only the
// flagged rows are coloured, so the one that misbehaves stays easy to find.
function vitalsPreview(): string {
  const d = host.vitalsDrift();
  const verdict = driftVerdict(vitalsPrefs, d);
  const bad = new Set(leakSuspects(d).map((r) => r.id));
  const cls = bad.size ? "sv-warn" : "";
  const head = `<div class="set-vitals"><div class="sv-verdict ${cls}">${esc(verdict)}</div>`;
  if (!d) return `${head}</div>`;
  const rows = d.rows.map((r) => {
    const def = VITALS.find((v) => v.id === r.id);
    // A rate is a running total: only the per-hour column says anything, so the other two are blanked.
    const rate = r.kind === "rate";
    const sign = r.delta > 0 ? "+" : "";
    return `<tr class="${bad.has(r.id) ? "sv-bad" : ""}" title="${escAttr(def?.hint ?? "")}">`
      + `<td>${esc(r.label)}<span class="sv-kind">${r.kind}</span></td>`
      + `<td class="mono">${rate ? "–" : r.last.toLocaleString()}</td>`
      + `<td class="mono">${rate ? "–" : `${sign}${r.delta.toLocaleString()}`}</td>`
      + `<td class="mono">${sign}${fmtPerHour(r.perHour)}</td></tr>`;
  }).join("");
  return `${head}<table class="sv-tbl"><thead><tr><th>Counter</th><th>Now</th><th>Change</th><th>Per hour</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`
    + `<div class="sv-foot">${d.samples} samples over ${esc(fmtSpanShort(d.spanMs))} · the full series is in episko.log, one line per sample behind <span class="mono">vitals</span></div></div>`;
}

function applySetting(set: string, val: string) {
  if (set === "theme") host.setTheme(val as "dark" | "light");
  else if (set === "engine") host.setEngine(val as Engine);
  else if (set === "sort") host.setSort(val as SortMode);
  else if (set.startsWith("permmode:")) host.setPermMode(set.slice("permmode:".length), val);
  else if (set === "agent") host.setDefaultAgent(val);
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
  // `foot:`, `fx:` and `perf:` prefixes: the ids belong to ./footprefs, ./motion and ./perf,
  // so adding one there means no edit here.
  else if (set.startsWith("foot:")) host.setFootSeg(set.slice(5) as FootSeg);
  else if (set.startsWith("fx:")) host.setFx(set.slice(3) as VisualFx);
  else if (set === "perf:vitals") host.setVitalsPrefs({ ...vitalsPrefs, enabled: val === "1" });
  else if (set === "perf:every") host.setVitalsPrefs({ ...vitalsPrefs, everyMs: +val });
  else if (set === "perf:scroll") host.setScrollback(+val);
  else if (set === "perf:reload") { void host.reloadUi(); return; }
  else if (set === "perf:devtools") { host.openDevtools(); return; }
  else if (set === "untrust") untrustProject(val);
  else if (set === "unstop") clearStopRule(val);
  renderSettings();
}
// Everything routes through the host's clamping setter; the buttons disable at the bounds.
function applyPeekSetting(cmd: string) {
  // Reset restores the two timings only: it sits in the stepper row and must not flip the
  // exemption switch (spreading PEEK_DEFAULTS did exactly that).
  if (cmd === "reset") {
    host.setPeekPrefs({ ...peekPrefs, openMs: PEEK_DEFAULTS.openMs, closeMs: PEEK_DEFAULTS.closeMs });
    return;
  }
  if (cmd === "toggle") {
    const enabled = !peekPrefs.enabled;
    host.setPeekPrefs({ ...peekPrefs, enabled });
    // Off means the preview shows the rows open, so a demo mid-hover would fight it.
    peekDemoReset();
    return;
  }
  // Same as the switch: the demo groups change, so a running hover has nothing to open.
  if (cmd === "live") { host.setPeekPrefs({ ...peekPrefs, pinLive: !peekPrefs.pinLive }); peekDemoReset(); return; }
  const [which, delta] = cmd.split(":");
  if (which === "open") host.setPeekPrefs({ ...peekPrefs, openMs: peekPrefs.openMs + +delta });
  else if (which === "close") host.setPeekPrefs({ ...peekPrefs, closeMs: peekPrefs.closeMs + +delta });
}

// All through host.setSoundPrefs (clamps, persists, repaints). Switching an event off and
// Reset do not play on purpose: a burst of ten tones is the wrong answer to "quieter".
function applySoundSetting(cmd: string) {
  const p = soundPrefs;
  const set = (next: SoundPrefs) => host.setSoundPrefs(next);
  const withEvent = (id: SoundEvent, patch: Partial<SoundPrefs["events"][SoundEvent]>) =>
    set({ ...p, events: { ...p.events, [id]: { ...p.events[id], ...patch } } });

  if (cmd === "reset") { soundPick = null; set(soundDefaults()); return; }
  if (cmd === "toggle") {
    const enabled = !p.enabled;
    set({ ...p, enabled });
    // Play on switching on: a click just landed, so the autoplay gate is known to be open.
    if (enabled) previewEvent("done");
    return;
  }
  const [verb, a, b] = cmd.split(":");
  if (verb === "vol") {
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
// Same reducer as the sidebar's, own state; reads `peekPrefs` at event time so a stepper
// press is felt on the next hover. renderSettings() rebuilds #setBody under it, hence the reset.
let demoPeek: PeekState = PEEK_IDLE;
let demoTimer: number | null = null;
let demoHover: string | null = null;

// Mirrors ./sidebar's applyPeek, hairline included: the countdown is half the setting.
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
// Both fields decide the repaint: entering a group changes `arming` alone (see ./sidebar's peekAdvance).
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

// Read fresh each render: a chapter finished while this window is open must not still offer to start.
function renderGuideControl(): string {
  const st = parseTourState(localStorage.getItem(TOUR_KEY));
  return `<div class="set-stack">` + pickerChapters().map((c) => {
    const done = isDone(st, c);
    // Walked out of halfway is neither done nor untouched; ./tourui resumes it, so the button says so.
    const held = st.at?.ch === c.id && !done;
    return `<div class="gd-row">
      <span class="gd-main"><span class="gd-nm">${esc(c.name)}${done ? `<span class="tp-done">done</span>` : ""}</span>
        <span class="gd-sb">${esc(c.blurb)}</span></span>
      <span class="gd-mn">${esc(c.mins)}</span>
      <button class="tact" data-setguide="${esc(c.id)}">${held ? "Resume" : done ? "Replay" : "Start"}</button></div>`;
  }).join("") + `</div>`;
}

function setFontFromSettings(cmd: string) {
  if (cmd === "reset") { setTermFontSize(TERM_FONT_DEFAULT); host.applyFontSize(); toast(`Terminal font ${TERM_FONT_DEFAULT}px`); }
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
  const at = (e.target as HTMLElement).closest<HTMLElement>("[data-setattn]");
  if (at) { applyAttnSetting(at.dataset.setattn!); return; }
  // Starting a chapter closes this window: every anchor the tour lights is behind it.
  const gd = (e.target as HTMLElement).closest<HTMLElement>("[data-setguide]");
  if (gd) { closeSettings(); host.startTour(gd.dataset.setguide!); return; }
  // Clicking a preview row is the third way to replay it; it changes no setting.
  const ad = (e.target as HTMLElement).closest<HTMLElement>("#attnDemo .srow");
  if (ad) { attnDemoReplay(ad); return; }
  const rv = (e.target as HTMLElement).closest<HTMLElement>("[data-setrevive]");
  if (rv) { applyReviveSetting(rv.dataset.setrevive!); return; }
  const sd = (e.target as HTMLElement).closest<HTMLElement>("[data-setsound]");
  if (sd) { applySoundSetting(sd.dataset.setsound!); return; }
  const kb = (e.target as HTMLElement).closest<HTMLElement>("[data-setkey]");
  if (kb) { applyKeySetting(kb.dataset.setkey!); return; }
  const r = (e.target as HTMLElement).closest<HTMLElement>("[data-urange]");
  if (r) { setUsageRange(+r.dataset.urange!); renderSettings(); return; }
  const o = (e.target as HTMLElement).closest<HTMLElement>("[data-set]");
  if (o) applySetting(o.dataset.set!, o.dataset.val!);
});
// Delegated on the persistent #setBody: renderSettings() replaces the demo DOM on every press.
$("setBody").addEventListener("mouseover", (e) => {
  // The attention preview replays under the pointer. `attnHover` is the guard ./sidebar's
  // peek needs too: mouseover fires for every child crossed, and each replay restarts the fade.
  const row = (e.target as HTMLElement).closest<HTMLElement>("#attnDemo .srow");
  if (row !== attnHover) { attnHover = row; if (row) attnDemoReplay(row); }
  if (row) return;
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
// The pointer can leave through the gap between demo groups, where no group mouseout fires.
$("setBody").addEventListener("mouseout", (e) => {
  const demo = (e.target as HTMLElement).closest<HTMLElement>("#peekDemo");
  if (!demo) return;
  const to = e.relatedTarget as Node | null;
  if (to && demo.contains(to)) return;
  demoHover = null;
  demoAdvance(peekLeaveAll(demoPeek, Date.now(), peekPrefs));
});

// The Usage panel's tooltip, on <body> rather than #setBody so a renderSettings() rebuild never drops it.
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
$("setBody").addEventListener("mouseleave", () => {
  uTip.hidden = true;
  // No mouseover fires on leaving, so forget the row or a return to it would not replay.
  attnHover = null;
});
