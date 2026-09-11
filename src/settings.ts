// The settings window: a tab list, a declarative control table (SET_TABS) and one
// dispatcher. Adding a setting means adding a descriptor, not markup. It owns nothing it
// changes: every setter arrives through the SettingsHost object main.ts hands over.

import { $, dropScrim, FILE_MANAGER, IS_MAC, toast } from "./dom";
import {
  basename, cleanTitle, esc, escAttr, tccLabel, tilde, TITLE_DEFAULTS, titleExtra, TITLE_EXTRA_MAX,
  type TitlePrefs,
} from "./format";
import { agentCapabilitySummary, CLAUDE_CLI, type Engine } from "./types";
import {
  highlight, isSearching, matchRow, parseQuery, SEARCH_FILTERS, type SearchHit, type SearchRow,
} from "./setsearch";
import { agentLogo } from "./providers/logos";
import {
  allAgents, attnPrefs, autoFetchPrefs, availEngines, defaultAgentDef, engineDef, footPrefs,
  motionPrefs,
  keyPrefs, missingAgents,
  outlinePrefs, peekPrefs, permissionModeFor, revivePrefs, sessions, termScrollback, titlePrefs, vitalsPrefs,
  setTermFontSize, TERM_FONT_DEFAULT,
  SORT_META, SORT_MODES, sortMode, soundPrefs, termEngine, termFontSize, wtGroup,
  type SortMode, type WtGroup,
} from "./state";
import {
  ATTN_DEFAULTS, ATTN_HIGHLIGHT_RANGE, ATTN_HIGHLIGHT_STEP, ATTN_ORDERS,
  isDefaultAttnPrefs, type AttnOrder, type AttnPrefs,
} from "./attn";
import { AUTOFETCH_DEFAULTS, AUTOFETCH_EVERY, type AutoFetchPrefs } from "./autofetch";
import {
  isDefaultRevivePrefs, REVIVE_ATTEMPTS_RANGE, REVIVE_BASE_RANGE, REVIVE_DEFAULTS,
  REVIVE_FACTOR_RANGE, REVIVE_FACTOR_STEP, REVIVE_JITTER_RANGE, REVIVE_JITTER_STEP,
  REVIVE_KINDS, REVIVE_MAX_RANGE, reviveBaseStep, reviveGap, reviveMaxStep, revivePlan,
  reviveWindowMs, type ReviveKind, type RevivePrefs,
} from "./revive";
import { LIT_COLOR } from "./sidebarview";
import { DEFAULT_FOOT, FOOT_SEGS, footShown, type FootSeg } from "./footprefs";
import { DEFAULT_MOTION, fxOn, VISUAL_FX, type VisualFx } from "./motion";
import {
  driftVerdict, fmtPerHour, fmtSpanShort, leakSuspects, SCROLLBACK_DEFAULT, SCROLLBACK_OPTS, VITALS,
  VITALS_DEFAULTS, VITALS_EVERY, type VitalsDrift, type VitalsPrefs,
} from "./perf";
import { OUTLINE_DEFAULTS, OUTLINE_LINES, type OutlinePrefs } from "./outline";
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
  ALL_PROVIDERS, clearStopRule, DEFAULT_TASK_PREFS, explicitlyTrusted, PROVIDER_LABEL, saveTaskPrefs,
  stopRules, taskPrefs, untrustProject, type Provider, type TaskPrefs,
} from "./tasks";
import { isDone, parseTourState, pickerChapters, TOUR_KEY } from "./tour";
import { costPopHtml, ioPopHtml, usageRow } from "./usageview";
import { enginePopHtml, popGoHtml, shortPopHtml } from "./footerview";
import type { Forecast } from "./rl";
import { providerAdapter, providerPermissionMode } from "./providers";

// What this dialog changes but does not own; main.ts fills it at startup, no-ops until then.
export interface SettingsHost {
  /** Replay a tour chapter; ./tourui owns the walking. */
  startTour: (chapterId: string) => void;
  setSort: (m: SortMode, announce?: boolean) => void;
  setEngine: (id: Engine) => void;
  bumpFont: (d: number) => void;
  applyFontSize: () => void;
  // The setters below must be the app-level ones (./actions), which clamp, persist and
  // repaint; state.ts's same-named setters only assign. They come through the host
  // because ./actions imports this module and a direct import back would be a cycle.
  setWtGroup: (m: WtGroup) => void;
  setPermMode: (provider: string, mode: string) => void;
  setDefaultAgent: (id: string) => void;
  setPeekPrefs: (p: PeekPrefs) => void;
  // `repaintPanel` is for the DOM, not the data: the field commits on every keystroke, and
  // a repaint mid-word would replace the <input> being typed into, caret and all.
  setTitlePrefs: (p: TitlePrefs, repaintPanel?: boolean) => void;
  setSoundPrefs: (p: SoundPrefs) => void;
  setKeyPrefs: (p: KeyPrefs) => void;
  setAttnPrefs: (p: AttnPrefs) => void;
  setAutoFetchPrefs: (p: AutoFetchPrefs) => void;
  setFootSeg: (id: FootSeg) => void;
  setFx: (id: VisualFx) => void;
  setRevivePrefs: (p: RevivePrefs) => void;
  setVitalsPrefs: (p: VitalsPrefs) => void;
  setOutlinePrefs: (p: OutlinePrefs) => void;
  setScrollback: (lines: number) => void;
  // macOS permission dialogs. This module reaches no IPC, so the probe, the pane and the
  // log scan all arrive as promises; none of them grants anything (docs/macos-access.md).
  fullDiskAccess: () => Promise<boolean>;
  openPrivacyPane: (pane: string) => Promise<void>;
  resetAppDataPrompts: () => Promise<void>;
  privacyAsks: () => Promise<PrivacyAsk[]>;
  // The rail's doors, and the one fact `@new` needs: whether a version was read in What's new.
  openUsage: () => void;
  openWhatsNew: () => void;
  versionUnread: (version: string) => boolean;
  // Not settings, hence no cc- key: an inspector, a reload and a reading of ./debug's ring.
  openDevtools: () => void;
  reloadUi: () => void;
  vitalsDrift: () => VitalsDrift | null;
}
// Computed rather than fixed: with one agent installed, the useful half is that others
// exist and where to look for them.
function agentMore(): string {
  const missing = missingAgents().length;
  return "⌘N, the new-session dialog and a worktree launch all follow this; a project can pin a different agent from its own menu"
    + (missing ? `, which also lists the ${missing} agents Episko supports that are not on your PATH` : "")
    + ". Each row lists what its provider integrates, and one with no adapter still gets a real terminal, worktree and project tools.";
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
  const dflt = providerPermissionMode(agent.id, "default") ?? modes[0];
  return {
    kind: "seg", set: `permmode:${agent.id}`, key: "cc-perm-modes", label: `Permission mode · ${provider?.label ?? agent.label}`,
    hint: "How much a new session may do before it asks.",
    more: "Stored per agent, so switching agents brings back that agent's last choice. Each value maps to a fixed CLI flag; nothing typed here reaches a command line.",
    aliases: ["bypass", "plan", "accept edits", "dangerously", "auto", "approvals", "ask"],
    active: () => active.id, isDefault: () => active.id === dflt.id, reset: () => host.setPermMode(agent.id, dflt.id),
    segs: () => modes.map((mode) => ({ value: mode.id, label: mode.label, sub: mode.sub, glyph: mode.glyph })),
  };
}

let host: SettingsHost = {
  startTour: () => {},
  setSort: () => {}, setEngine: () => {},
  bumpFont: () => {}, applyFontSize: () => {},
  setWtGroup: () => {}, setPermMode: () => {}, setDefaultAgent: () => {}, setPeekPrefs: () => {}, setSoundPrefs: () => {},
  setTitlePrefs: () => {},
  setKeyPrefs: () => {}, setAttnPrefs: () => {}, setAutoFetchPrefs: () => {}, setFootSeg: () => {}, setFx: () => {}, setRevivePrefs: () => {},
  setVitalsPrefs: () => {}, setOutlinePrefs: () => {}, setScrollback: () => {}, openDevtools: () => {}, reloadUi: () => {},
  fullDiskAccess: () => Promise.resolve(false), openPrivacyPane: () => Promise.resolve(),
  resetAppDataPrompts: () => Promise.resolve(), privacyAsks: () => Promise.resolve([]),
  vitalsDrift: () => null,
  openUsage: () => {}, openWhatsNew: () => {}, versionUnread: () => false,
};
export function setSettingsHost(h: SettingsHost) { host = h; }

// Every control writes through the same setter the rest of the app uses; there is no
// separate settings store.
type SetSeg = { value: string; label: string; sub?: string; glyph?: string; logo?: string };
// What every control carries besides its shape: the folded why, the words the search may
// match, and the three answers a row can give (a summary, whether it is at its default, how
// to put it back). `id` is the row's address for deep links and the fold state.
interface SetMeta {
  id?: string; label: string; hint?: string; more?: string; aliases?: string[];
  key?: string;                   // the cc- key behind it, for `@key:`
  since?: string;                 // the release it arrived in, for `@new`
  summary?: () => string;         // the folded panel's one line
  isDefault?: () => boolean;      // absent: never marked changed
  reset?: () => void;
  lines?: () => { label: string; value: string }[]; // inside a panel, for the search
  previewLabel?: string;          // the fold button of a toggle's preview
  dim?: () => boolean;            // a stored value that currently decides nothing; not disabled, so switching back restores it
}
type SetShape =
  | { kind: "seg"; set: string; active: () => string; segs: () => SetSeg[] }
  | { kind: "font" }
  | { kind: "wtpreview"; active: () => string }
  // peek, sound, attn, revive, keys and title are each one control with a panel under it:
  // they are one decision, and the panel folds behind its summary.
  | { kind: "peek" } | { kind: "sound" } | { kind: "keys" } | { kind: "attn" } | { kind: "revive" } | { kind: "title" }
  | { kind: "toggle"; set: string; on: () => boolean; preview?: () => string }
  // Prose with no control under it: a rule governing the group below.
  | { kind: "note"; hint: string }
  | { kind: "guide" }
  | { kind: "multi"; set: string; on: () => string[]; segs: () => SetSeg[]; empty?: string }
  // A verb rather than a stored choice, on the same data-set/data-val join; `danger` is the confirm dialog's red.
  | { kind: "action"; set: string; btn: string; danger?: boolean; preview?: () => string };
type SetControl = SetMeta & SetShape;
type SetGroupId = "look" | "work" | "app";
// `when`: a section about an OS the app is not running on is worse than none; `os` tags its rows for `@mac`.
interface SetTab {
  id: string; label: string; glyph: string; group: SetGroupId; sub: string;
  when?: () => boolean; os?: "mac"; controls: () => SetControl[];
}

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
    // The header is hand-drawn, like the foot below it — but its quick open is the real
    // renderer, so this preview cannot claim an icon the popover does not have.
    body: `<div class="up-h">Claude usage limits${
      popGoHtml({ go: "usage", label: "Usage & spend", sub: "the burn rate behind these, and every day so far" })
    }</div>`
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

const onOff = (b: boolean) => (b ? "on" : "off");
const fxDefault = (id: VisualFx) => fxOn(motionPrefs, id) === fxOn(DEFAULT_MOTION, id);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

const SET_GROUPS: { id: SetGroupId; label: string }[] = [
  { id: "look", label: "Look" }, { id: "work", label: "Work" }, { id: "app", label: "App" },
];
// A section is named for the surface or the question, never for the feature that shipped it.
// `hint` is the one sentence on the page; `more` is the why, folded (docs/settings.md).
const SET_TABS: SetTab[] = [
  {
    id: "appearance", label: "Appearance", glyph: "◐", group: "look", sub: "Type size, effects",
    controls: () => [
      { kind: "font", id: "font", key: "cc-term-font", label: "Terminal font size", hint: "Text size in the embedded terminals.",
        more: "⌘+, ⌘− and ⌘0 do the same from any pane.", aliases: ["zoom", "text size", "bigger", "smaller"],
        isDefault: () => termFontSize === TERM_FONT_DEFAULT, reset: () => setFontFromSettings("reset") },
      ...VISUAL_FX.map((fx): SetControl => ({
        kind: "toggle", set: `fx:${fx.id}`, key: "cc-motion", label: fx.label, hint: fx.hint, more: fx.more, aliases: fx.aliases,
        on: () => fxOn(motionPrefs, fx.id), isDefault: () => fxDefault(fx.id), reset: () => host.setFx(fx.id),
      })),
    ],
  },
  {
    id: "sidebar", label: "Sidebar", glyph: "▤", group: "look", sub: "Order, worktrees, hover",
    controls: () => [
      { kind: "seg", set: "sort", key: "cc-sort", label: "Sort", hint: "What order projects and sessions are listed in.",
        more: "Manual is drag to arrange. The other two re-sort as things happen.", aliases: ["order", "arrange", "drag", "urgency", "recent"],
        active: () => sortMode, isDefault: () => sortMode === "manual", reset: () => host.setSort("manual"),
        segs: () => SORT_MODES.map((m) => ({ value: m, label: SORT_SHORT[m], sub: SORT_META[m].label, glyph: SORT_META[m].glyph })) },
      { kind: "wtpreview", id: "wtgroup", key: "cc-worktree-group", label: "Worktree grouping", hint: "How a repo's other checkouts sit inside its project group.",
        more: "Four layouts, each previewed on the same demo roster.", aliases: ["checkout", "branch", "worktree", "nested", "layout"],
        active: () => wtGroup, summary: () => WT_GROUP_SEGS.find((s) => s.value === wtGroup)?.label ?? wtGroup,
        lines: () => WT_GROUP_SEGS.map((s) => ({ label: s.label, value: s.sub ?? "" })),
        isDefault: () => wtGroup === "subheader", reset: () => host.setWtGroup("subheader") },
      { kind: "peek", id: "peek", key: "cc-peek", label: "Reveal idle checkouts on hover", hint: "Idle checkouts stay hidden until you rest on the project.",
        more: "Off lists them all the time. The preview runs the real timings, so what you set is what you will feel.",
        aliases: ["hover", "idle", "peek", "slide", "collapse", "delay"],
        summary: () => `${onOff(peekPrefs.enabled)} · opens ${peekPrefs.openMs} ms · closes ${peekPrefs.closeMs} ms`,
        lines: () => [
          { label: "Opens after", value: `${peekPrefs.openMs} ms` }, { label: "Closes after", value: `${peekPrefs.closeMs} ms` },
          { label: "Keep them listed in projects with a session", value: onOff(peekPrefs.pinLive) },
        ],
        isDefault: () => peekPrefs.enabled === PEEK_DEFAULTS.enabled && peekPrefs.pinLive === PEEK_DEFAULTS.pinLive
          && peekPrefs.openMs === PEEK_DEFAULTS.openMs && peekPrefs.closeMs === PEEK_DEFAULTS.closeMs,
        reset: () => { host.setPeekPrefs({ ...PEEK_DEFAULTS }); peekDemoReset(); } },
      { kind: "title", id: "title", key: "cc-title", label: "Clean up session names", hint: "Strips the spinner Claude Code puts in front of a session's title.",
        more: "When a new spinner character turns up in the sidebar, add it below. Ranges like a-b work, and the field only ever adds to the built-in list.",
        aliases: ["spinner", "title", "rename", "strip", "braille"],
        summary: () => { const n = titleExtra(titlePrefs.extra).length; return `${onOff(titlePrefs.scrub)}${n ? ` · ${n} extra` : ""}`; },
        lines: () => [{ label: "Extra characters to strip", value: titlePrefs.extra || "none" }],
        isDefault: () => titlePrefs.scrub === TITLE_DEFAULTS.scrub && titlePrefs.extra === TITLE_DEFAULTS.extra,
        reset: () => host.setTitlePrefs({ ...TITLE_DEFAULTS }) },
    ],
  },
  {
    id: "inspector", label: "Inspector", glyph: "▯", group: "look", sub: "Your questions",
    controls: () => [
      { kind: "toggle", set: "outline:on", key: "cc-outline", label: "List your questions", hint: "Your prompts, newest first; click one to jump back to it.",
        more: "A prompt that has scrolled out of the buffer stays in the list, greyed. On the fullscreen renderer the pane is asked to page there instead.",
        aliases: ["prompts", "outline", "questions", "conversation", "jump"],
        on: () => outlinePrefs.enabled, isDefault: () => outlinePrefs.enabled === OUTLINE_DEFAULTS.enabled,
        reset: () => host.setOutlinePrefs({ ...outlinePrefs, enabled: OUTLINE_DEFAULTS.enabled }) },
      { kind: "seg", set: "outline:lines", key: "cc-outline", label: "Lines per question", hint: "How many lines of a long prompt a row shows.",
        aliases: ["truncate", "clamp"], dim: () => !outlinePrefs.enabled,
        active: () => String(outlinePrefs.lines), isDefault: () => outlinePrefs.lines === OUTLINE_DEFAULTS.lines,
        reset: () => host.setOutlinePrefs({ ...outlinePrefs, lines: OUTLINE_DEFAULTS.lines }),
        segs: () => OUTLINE_LINES.map((n) => ({ value: String(n), label: n === 1 ? "One line" : `${n} lines`, glyph: "≡" })) },
      { kind: "toggle", set: "outline:hover", key: "cc-outline", label: "Expand a question on hover", hint: "Rest on a row and it unfolds to the whole prompt.",
        more: "Off, the whole prompt is in the tooltip.", aliases: ["unfold", "tooltip"], dim: () => !outlinePrefs.enabled,
        on: () => outlinePrefs.hover, isDefault: () => outlinePrefs.hover === OUTLINE_DEFAULTS.hover,
        reset: () => host.setOutlinePrefs({ ...outlinePrefs, hover: OUTLINE_DEFAULTS.hover }) },
    ],
  },
  {
    id: "statusbar", label: "Status bar", glyph: "▁", group: "look", sub: "Which segments show",
    // One switch per ./footprefs segment. What that table omits cannot be switched off, hence the note.
    controls: () => [
      { kind: "note", label: "What the status bar shows",
        hint: "The repo link, the version and What's new always stay, so the bar is never empty and an update can't be hidden by accident." },
      ...FOOT_SEGS.map((seg): SetControl => ({
        kind: "toggle", set: `foot:${seg.id}`, key: "cc-foot", label: seg.label, hint: seg.hint, more: seg.more,
        aliases: ["footer", "status bar", ...(seg.aliases ?? [])],
        on: () => footShown(footPrefs, seg.id), preview: () => footPreview(seg.id),
        isDefault: () => footShown(footPrefs, seg.id) === footShown(DEFAULT_FOOT, seg.id), reset: () => host.setFootSeg(seg.id),
      })),
    ],
  },
  {
    id: "launching", label: "Launching", glyph: "▷", group: "work", sub: "What runs, where, how it starts",
    controls: () => [
      // Outermost first: what runs, then where its terminal opens, then how it starts.
      { kind: "seg", set: "agent", key: "cc-agent", label: "Agent", hint: "What a new session runs.", more: agentMore(),
        aliases: ["provider", "default agent", ...allAgents().map((a) => a.label)],
        // What a launch resolves, not a stale persisted id for an uninstalled agent.
        active: () => defaultAgentDef().id, isDefault: () => defaultAgentDef().id === CLAUDE_CLI.id, reset: () => host.setDefaultAgent(CLAUDE_CLI.id),
        segs: () => allAgents().map((a) => ({ value: a.id, label: a.label, logo: agentLogo(a.id), sub: agentCapabilitySummary(a) })) },
      { kind: "seg", set: "engine", key: "cc-term-engine", label: "Launch engine", hint: "Where a new session's terminal opens.",
        more: "An agent with no external-terminal support stays embedded whatever is picked. A session in an external tab is mirrored into its pane.",
        aliases: ["ghostty", "terminal.app", "iterm", "external", "embedded", "mirror", "tab"],
        dim: () => !defaultAgentDef().capabilities.includes("external-terminal"),
        active: () => termEngine, isDefault: () => termEngine === "embedded", reset: () => host.setEngine("embedded"),
        segs: () => availEngines.map((id) => { const d = engineDef(id); return { value: id, label: d.label, sub: d.sub, glyph: id === "embedded" ? "▤" : "⧉" }; }) },
      permissionControl(),
    ],
  },
  {
    id: "attention", label: "Attention", glyph: "◆", group: "work", sub: "Highlight, badge, sounds",
    controls: () => [
      { kind: "attn", id: "attn", key: "cc-attn", label: "When a session wants you", hint: "How a session tells you it needs you.",
        more: "A finished turn, a killed one, a permission, a failed run: the row lights for a few seconds and the ⌂ badge queues them. Opening a session clears it, except a permission, which stays until you answer.",
        aliases: ["badge", "highlight", "needs you", "notify", "notification", "tray", "your turn"],
        summary: () => `${onOff(attnPrefs.highlight)} · ${attnOrderLabel().toLowerCase()} · ${attnPrefs.clearOnOpen ? "clears on open" : "stays"}`,
        lines: () => [
          { label: "Fades over", value: `${(attnPrefs.highlightMs / 1000).toFixed(1)}s` }, { label: "Queue order", value: attnOrderLabel() },
          { label: "Clear it when you open the session", value: onOff(attnPrefs.clearOnOpen) },
        ],
        isDefault: () => isDefaultAttnPrefs(attnPrefs), reset: () => host.setAttnPrefs(ATTN_DEFAULTS) },
      { kind: "sound", id: "sound", key: "cc-sound", label: "Sounds", hint: "Which moments are worth hearing.",
        more: "Every other signal Episko has needs the window in front of you; a sound doesn't. Click a sound's name to change it, and every button here plays what it does. One sound per moment, and the more urgent one wins.",
        aliases: ["chime", "bell", "mute", "volume", "audio", "alert", "beep", "quiet", "silence", "tone"],
        summary: () => soundPrefs.enabled
          ? `${SOUND_EVENTS.filter((d) => soundPrefs.events[d.id].on).length} of ${SOUND_EVENTS.length} events · ${soundPrefs.volume}%` : "off",
        lines: () => [
          ...SOUND_EVENTS.map((d) => ({ label: d.label, value: soundPrefs.events[d.id].on ? toneDef(soundPrefs.events[d.id].tone).label : "off" })),
          { label: "Volume", value: `${soundPrefs.volume}%` }, { label: "Play", value: WHEN_SEGS.find((w) => w.value === soundPrefs.when)?.label ?? "" },
        ],
        isDefault: () => isDefaultSoundPrefs(soundPrefs), reset: () => { soundPick = null; host.setSoundPrefs(soundDefaults()); } },
      { kind: "toggle", set: "taskattn", key: "cc-task-prefs", label: "Raise attention when a run fails", hint: "A failed run gets the same badge and tray notice as a blocked session.",
        aliases: ["task", "failed run", "badge"],
        on: () => taskPrefs.attention, isDefault: () => taskPrefs.attention === DEFAULT_TASK_PREFS.attention,
        reset: () => applySetting("taskattn", DEFAULT_TASK_PREFS.attention ? "1" : "0") },
    ],
  },
  {
    id: "auto", label: "On its own", glyph: "↻", group: "work", sub: "What Episko does without asking",
    controls: () => [
      { kind: "revive", id: "revive", key: "cc-revive", label: "Carry on after an API error", hint: "When an API error ends a turn, Episko waits and types a carry-on for you.",
        more: "A 529 at midnight otherwise costs eight hours. It never types into a session that is asking you something, never retries what waiting can't fix (bad credentials, billing, a malformed request), and holds its attempts while the machine has no network. It is off until you switch it on.",
        aliases: ["retry", "529", "overloaded", "backoff", "resume", "unattended", "overnight", "revive", "network"],
        summary: () => revivePrefs.enabled ? `on · rides out ~${reviveGap(reviveWindowMs(revivePrefs))}` : "off",
        lines: () => [
          { label: "First wait", value: reviveGap(revivePrefs.baseMs) }, { label: "Then ×", value: String(revivePrefs.factor) },
          { label: "Never longer than", value: reviveGap(revivePrefs.maxMs) }, { label: "Give up after", value: `${revivePrefs.attempts} tries` },
          { label: "Scatter by", value: `${revivePrefs.jitterPct}%` },
          { label: "Failures worth retrying", value: REVIVE_KINDS.filter((k) => revivePrefs.kinds.includes(k.id)).map((k) => k.label).join(", ") },
        ],
        isDefault: () => revivePrefs.enabled === REVIVE_DEFAULTS.enabled && isDefaultRevivePrefs(revivePrefs),
        reset: () => host.setRevivePrefs({ ...REVIVE_DEFAULTS }) },
      { kind: "toggle", set: "fetch:on", key: "cc-autofetch", label: "Fetch for the session on screen", hint: "Fetches the checkout you are looking at, so its ahead/behind count is current.",
        more: "Only that one; a repo nobody is reading isn't worth a round trip, and the checkouts of one repo share a fetch. An unreachable remote is backed off, and the git card's tooltip says so.",
        aliases: ["auto-fetch", "behind", "ahead", "remote", "pull", "sync", "git", "origin"], since: "0.28.0",
        on: () => autoFetchPrefs.enabled, isDefault: () => autoFetchPrefs.enabled === AUTOFETCH_DEFAULTS.enabled,
        reset: () => host.setAutoFetchPrefs({ ...autoFetchPrefs, enabled: AUTOFETCH_DEFAULTS.enabled }) },
      { kind: "seg", set: "fetch:every", key: "cc-autofetch", label: "At most every", hint: "How old a count may get before arriving at the pane fetches again.",
        more: "Nothing is fetched while you are elsewhere; arriving is what triggers it.", aliases: ["interval", "git", "fetch"], since: "0.28.0",
        dim: () => !autoFetchPrefs.enabled, active: () => String(autoFetchPrefs.everyMs),
        isDefault: () => autoFetchPrefs.everyMs === AUTOFETCH_DEFAULTS.everyMs,
        reset: () => host.setAutoFetchPrefs({ ...autoFetchPrefs, everyMs: AUTOFETCH_DEFAULTS.everyMs }),
        segs: () => AUTOFETCH_EVERY.map((ms) => ({
          value: String(ms),
          label: `${ms / 60_000} min`,
          glyph: ms <= 60_000 ? "◕" : ms <= 300_000 ? "◑" : "◔",
          sub: ms <= 60_000 ? "Freshest; a fetch most times you switch"
            : ms <= 300_000 ? "Fresh enough for a colleague's push"
            : ms <= 900_000 ? "Quiet; a handful of fetches an hour" : "Quietest",
        })) },
      // Set from the project's task panel; reviewed and revoked here.
      { kind: "multi", set: "unstop", key: "cc-task-onstop", label: "Run after a session stops", hint: "Projects where a task runs each time an agent finishes a turn.",
        more: "It runs unfocused and never takes the stage; a failure keeps its pane and offers the output back to the session. Set with ⟲ in a project's task panel, removed with a click here.",
        aliases: ["run on stop", "hook", "after turn", "test on stop", "task"],
        summary: () => { const n = Object.keys(stopRules).length; return n ? `${n} rule${n === 1 ? "" : "s"}` : "none"; },
        lines: () => Object.entries(stopRules).map(([path, r]) => ({ label: `${basename(path)} · ${r.label}`, value: tilde(path) })),
        on: () => Object.keys(stopRules),
        segs: () => Object.entries(stopRules).map(([path, r]) => ({ value: path, label: `${basename(path)} · ${r.label}`, sub: tilde(path) })),
        empty: "No rules yet. Set one with ⟲ in a project's task panel (⌘K → Manage this project's tasks)." },
      { kind: "seg", set: "dismiss", key: "cc-task-prefs", label: "Dismiss successful runs", hint: "When a passed run's pane closes on its own.",
        more: "A failed run stays until you close it.", aliases: ["auto close", "finished runs", "task", "green"],
        active: () => String(taskPrefs.dismissMs), isDefault: () => taskPrefs.dismissMs === DEFAULT_TASK_PREFS.dismissMs,
        reset: () => applySetting("dismiss", String(DEFAULT_TASK_PREFS.dismissMs)),
        segs: () => [
          { value: "0", label: "Never", glyph: "◉", sub: "Keep every finished run" },
          { value: "20000", label: "After 20s", glyph: "◔", sub: "Unless you're looking at it" },
          { value: "1", label: "At once", glyph: "○", sub: "Close as soon as it passes" },
        ] },
    ],
  },
  {
    id: "tasks", label: "Tasks", glyph: "▶", group: "work", sub: "Discovery, trust, where they run",
    controls: () => [
      { kind: "multi", set: "prov", key: "cc-task-prefs", label: "Scan for task files", hint: "Which task files the Run picker looks for.",
        aliases: ["justfile", "taskfile", "mise", "npm", "package.json", "makefile", "cargo", "tasks.json", "launch.json"],
        summary: () => `${taskPrefs.providers.length} of ${ALL_PROVIDERS.length}`,
        lines: () => ALL_PROVIDERS.map((p) => ({ label: PROVIDER_LABEL[p], value: onOff(taskPrefs.providers.includes(p)) })),
        on: () => taskPrefs.providers, segs: () => ALL_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] })),
        isDefault: () => sameSet(taskPrefs.providers, DEFAULT_TASK_PREFS.providers),
        reset: () => { taskPrefs.providers = [...DEFAULT_TASK_PREFS.providers]; saveTaskPrefs(); renderSettings(); } },
      { kind: "toggle", set: "introspect", key: "cc-task-prefs", label: "Let trusted projects introspect themselves", hint: "Lets a trusted project's own tool list its tasks.",
        more: "Listing justfile, Taskfile or mise tasks means running that tool, and it can execute code from the folder. Off, those tasks stay undiscovered.",
        aliases: ["trust", "security", "execute", "evaluate", "safe"],
        on: () => taskPrefs.introspect, isDefault: () => taskPrefs.introspect === DEFAULT_TASK_PREFS.introspect,
        reset: () => applySetting("introspect", DEFAULT_TASK_PREFS.introspect ? "1" : "0") },
      { kind: "multi", set: "untrust", key: "cc-trusted", label: "Trusted projects", hint: "Folders you have trusted by hand; click one to revoke.",
        more: "Your project folders are trusted because you added them. Anything else asks once.", aliases: ["revoke", "trust", "folder"],
        summary: () => { const n = explicitlyTrusted().length; return n ? `${n} by hand` : "none by hand"; },
        lines: () => explicitlyTrusted().map((p) => ({ label: basename(p), value: tilde(p) })),
        on: () => explicitlyTrusted(),
        segs: () => explicitlyTrusted().map((p) => ({ value: p, label: basename(p), sub: tilde(p) })),
        empty: "Nothing trusted by hand yet. Your project folders already are." },
      { kind: "seg", set: "taskcwd", key: "cc-task-prefs", label: "Working directory", hint: "Where a task runs when several worktrees are open.",
        more: "A task that declares its own directory keeps it.", aliases: ["cwd", "worktree", "repo root", "directory"],
        active: () => taskPrefs.cwd, isDefault: () => taskPrefs.cwd === DEFAULT_TASK_PREFS.cwd, reset: () => applySetting("taskcwd", DEFAULT_TASK_PREFS.cwd),
        segs: () => [
          { value: "session", label: "Active session", glyph: "▤", sub: "The worktree you're looking at" },
          { value: "root", label: "Repo root", glyph: "⌂", sub: "Always the main checkout" },
        ] },
    ],
  },
  {
    id: "keys", label: "Keys", glyph: "⌨", group: "work", sub: "Every chord, rebindable",
    controls: () => [
      { kind: "keys", id: "keys", key: "cc-keys", label: "Keyboard shortcuts", hint: "Click a chord and press the one you want.",
        more: "⊘ turns one off, ⟲ puts it back, the switch turns off the lot. Nothing is lost either way: switching back on brings the chords you kept, and a row you cleared stays cleared. Escape and a terminal's own copy and paste sit below this and never change.",
        aliases: ["keybinding", "hotkey", "chord", "⌘", "rebind", "shortcut", "cmd", "keyboard"],
        summary: () => {
          if (!keyPrefs.enabled) return "off";
          const all = KEY_GROUPS.flatMap((g) => g.actions);
          const touched = all.filter((id) => !isDefaultBind(keyPrefs.binds, id)).length;
          return `${all.length} bindings${touched ? ` · ${touched} changed` : ""}`;
        },
        lines: () => KEY_GROUPS.flatMap((g) => g.actions).map((id) => ({ label: keyActionDef(id).label, value: comboKeys(keyPrefs.binds[id], IS_MAC).join("") || "off" })),
        isDefault: () => isDefaultKeyPrefs(keyPrefs), reset: () => applyKeySetting("resetall") },
    ],
  },
  {
    // macOS only, and hidden rather than dimmed elsewhere: nothing on it has a meaning on an OS with no TCC (docs/macos-access.md).
    id: "privacy", label: "Privacy", glyph: "◫", group: "app", sub: "macOS permissions", when: () => IS_MAC, os: "mac",
    controls: () => [
      { kind: "note", label: "macOS permissions",
        hint: "macOS blames whichever app is responsible for a process, and every agent, task and shell here is a child of Episko. So a prompt naming Episko is usually a session reading something outside its project. Episko needs none of these permissions itself and can't grant any; the rows below open the panes macOS keeps them in." },
      { kind: "action", set: "priv:fda", label: "Full disk access", btn: "Open System Settings…", hint: "The one grant that ends the prompts, and every agent inherits it.",
        more: "macOS has no pane for the app-data prompts, so this is the only grant that can be made in advance. Episko itself needs nothing here. If it isn't in the list yet, add it with + from Applications.",
        aliases: ["tcc", "permission", "access data from other apps", "library", "would like to access", "grant"], since: "0.28.0",
        preview: () => fdaPreview() },
      { kind: "action", set: "priv:reset", label: "Denied prompts", btn: "Reset", hint: "Takes back a Don't Allow, which macOS otherwise keeps for good.",
        more: "There is no pane for this. Reset clears Episko's answers, and the next session that reaches raises the dialog again.",
        aliases: ["don't allow", "tccutil", "undo", "permission"], since: "0.28.0" },
      { kind: "action", set: "priv:scan", label: "Recent permission checks", btn: "Scan the last day", hint: "Lists the last day's permission checks and which binary made each.",
        more: "Read from the system log, about three seconds. A prompt you saw is one of these; most are answered from the system's cache without asking.",
        aliases: ["log show", "which agent", "binary", "audit"], since: "0.28.0",
        preview: () => asksPreview() },
    ],
  },
  {
    id: "diag", label: "Diagnostics", glyph: "◔", group: "app", sub: "Weight, scrollback, reload",
    // Recording first: it is the only row that has to be switched on before the day it is needed.
    controls: () => [
      { kind: "toggle", set: "perf:vitals", key: "cc-vitals", label: "Record performance vitals", hint: "Logs what the interface is holding, one line every few minutes.",
        more: "DOM nodes, heap, terminal buffers, the per-session structures, written to the rolling log where they survive a crash and a reload. After a day with a fleet the interface can get heavier until it feels sluggish, and the reload that fixes it destroys the evidence, so this has to be on before the day it is needed.",
        aliases: ["leak", "memory", "sluggish", "slow", "heap", "log", "dom nodes", "growth"],
        on: () => vitalsPrefs.enabled, preview: () => vitalsPreview(), previewLabel: "readings",
        isDefault: () => vitalsPrefs.enabled === VITALS_DEFAULTS.enabled,
        reset: () => host.setVitalsPrefs({ ...vitalsPrefs, enabled: VITALS_DEFAULTS.enabled }) },
      { kind: "seg", set: "perf:every", key: "cc-vitals", label: "Sample every", hint: "How often a reading is taken.",
        more: "Under a minute is noise from whatever turn is running; over a quarter of an hour a slow slide has too few points to show where it began.",
        aliases: ["interval", "sampling"], dim: () => !vitalsPrefs.enabled, active: () => String(vitalsPrefs.everyMs),
        isDefault: () => vitalsPrefs.everyMs === VITALS_DEFAULTS.everyMs,
        reset: () => host.setVitalsPrefs({ ...vitalsPrefs, everyMs: VITALS_DEFAULTS.everyMs }),
        segs: () => VITALS_EVERY.map((ms) => ({
          value: String(ms),
          label: ms < 3_600_000 ? `${ms / 60_000} min` : `${ms / 3_600_000} h`,
          glyph: ms === 60_000 ? "◕" : ms === 300_000 ? "◑" : "◔",
          sub: ms === 60_000 ? "Finest; four hours in memory" : ms === 300_000 ? "A full day in memory" : "Coarsest; lightest log",
        })) },
      { kind: "seg", set: "perf:scroll", key: "cc-scrollback", label: "Terminal scrollback", hint: "Lines of history each pane keeps.",
        more: "Across a fleet this is the biggest thing Episko holds, and a pane only gives it back when its session ends. Lowering it applies to open panes at once.",
        aliases: ["history", "lines", "buffer", "memory", "xterm"],
        active: () => String(termScrollback), isDefault: () => termScrollback === SCROLLBACK_DEFAULT, reset: () => host.setScrollback(SCROLLBACK_DEFAULT),
        segs: () => SCROLLBACK_OPTS.map((n) => ({
          value: String(n),
          label: `${n.toLocaleString()} lines`,
          glyph: n === 1000 ? "▁" : n === 4000 ? "▄" : "█",
          sub: n === 1000 ? "Lightest; roughly a screen of recent history" : n === 4000 ? "Half the default" : "The default",
        })) },
      { kind: "action", set: "perf:reload", label: "Reload the interface", btn: "Reload", hint: "Rebuilds the window; no session is lost.",
        more: "Episko itself holds the terminals, so every pane comes back with its scrollback. This is the fix once it has gone sluggish.",
        aliases: ["restart", "refresh", "sluggish", "reset ui"] },
      { kind: "action", set: "perf:devtools", label: "Web inspector", btn: "Open", hint: "The webview's own developer tools.",
        more: "A heap snapshot compared against one from just after a reload is what turns “something is growing” into a name.",
        aliases: ["devtools", "console", "heap snapshot", "profile", "inspect"] },
    ],
  },
  {
    id: "guide", label: "Guide", glyph: "◇", group: "app", sub: "The tour, chapter by chapter",
    controls: () => [
      { kind: "guide", id: "tour", key: "cc-tour", label: "Guided tour", hint: "Replay any chapter, any time.",
        more: "Nothing here opens by itself after the first run. When a release adds something worth showing, What's new offers the chapter and you can say no.",
        aliases: ["onboarding", "help", "walkthrough", "tutorial", "what's new", "intro"],
        summary: () => { const st = parseTourState(localStorage.getItem(TOUR_KEY)); const ch = pickerChapters(); return `${ch.filter((c) => isDone(st, c)).length} of ${ch.length} walked`; },
        lines: () => { const st = parseTourState(localStorage.getItem(TOUR_KEY)); return pickerChapters().map((c) => ({ label: c.name, value: isDone(st, c) ? "walked" : "" })); } },
    ],
  },
];
const attnOrderLabel = () => ATTN_ORDERS.find((o) => o.id === attnPrefs.order)?.label ?? attnPrefs.order;

// Reports with a window of their own (0.26.0): not settings, so outside the count, but the
// search still answers "usage" and the rail still shows the door.
const ELSEWHERE: { open: "usage" | "whatsnew"; name: string; hint: string; more: string; aliases: string[] }[] = [
  { open: "usage", name: "Usage & spend", hint: "A report, so it has a window of its own.",
    more: "Today's spend by project and session, both limit windows with a forecast, every day so far, every model by name.",
    aliases: ["usage", "spend", "cost", "money", "limits", "tokens", "model", "forecast", "burn rate", "dollars", "budget", "quota", "5-hour", "7-day", "report", "chart"] },
  { open: "whatsnew", name: "What's new", hint: "The changelog, release by release.",
    more: "With the chapter a release offers to walk you through, when there is one.",
    aliases: ["changelog", "release", "version", "update", "notes", "release notes"] },
];

export let setTab = "appearance";
let query = "";                         // the search box, mirrored so a repaint can read it
const openPanels = new Set<string>();  // folded panels opened by hand; a search hit opens one without touching this
const openWhy = new Set<string>();
let spyHold = 0;                        // the spy stands down until then: a rail click is scrolling

export function settingsOpen() { return $("setDlg").classList.contains("show"); }
export function openSettings() {
  $("scrim").classList.add("show"); $("setDlg").classList.add("show"); refreshAccess(); renderSettings();
  $("setQ").focus(); // typing filters at once
}
// `setTab` is a module `let` and an ESM import of it is read-only, so this is the seam.
// A row lands lit, the way a session row lights when it wants you: this arrives from
// somewhere else (a popover's quick open, the ⑃ dialog, the tour), and landing at the top
// of a section reads as a broken link. A section id names its own row when one shares it
// (`keys`), so a quick open at a one-row section lights the row.
export function openSettingsOn(tab: string, row?: string) {
  setQuery("");
  setTab = tab;
  openSettings();
  const body = $("setBody");
  const hit = body.querySelector<HTMLElement>(`[data-setrow="${CSS.escape(row ?? tab)}"]`);
  const target = hit ?? body.querySelector<HTMLElement>(`.set-sec[data-sec="${CSS.escape(tab)}"]`);
  if (!target) return;
  scrollBodyTo(target, hit ? 120 : 0);
  if (hit) { hit.classList.remove("set-lit"); void hit.offsetWidth; hit.classList.add("set-lit"); }
  markTab(tab);
}
export function closeSettings() {
  // Disarm first: the recorder listens on `window` and would go on swallowing every chord.
  stopKeyRec();
  $("setDlg").classList.remove("show");
  dropScrim();
}
function setQuery(v: string) {
  query = v;
  const q = $("setQ") as HTMLInputElement;
  if (q.value !== v) q.value = v;
}

const tabsShown = () => SET_TABS.filter((t) => t.when?.() ?? true);
const rowId = (c: SetControl) => c.id ?? ("set" in c ? c.set : c.kind);
const groupLabel = (id: SetGroupId) => SET_GROUPS.find((g) => g.id === id)?.label ?? id;
const isChanged = (c: SetControl) => (c.isDefault ? !c.isDefault() : false);
const isNew = (c: SetControl) => !!c.since && host.versionUnread(c.since);
const activeLabel = (c: SetControl) => ("active" in c && "segs" in c ? c.segs().find((s) => s.value === c.active())?.label : undefined);

function searchRow(t: SetTab, c: SetControl): SearchRow {
  return {
    id: rowId(c), tab: t.id, tabLabel: t.label, group: t.group, groupLabel: groupLabel(t.group),
    label: c.label, hint: c.hint ?? "", more: c.more, value: c.summary?.() ?? activeLabel(c),
    options: "segs" in c ? c.segs().map((s) => s.label) : undefined,
    lines: c.lines?.().map((l) => `${l.label} ${l.value}`),
    aliases: c.aliases, key: c.key, changed: isChanged(c), isNew: isNew(c), mac: t.os === "mac",
  };
}
const doorRow = (d: (typeof ELSEWHERE)[number]): SearchRow => ({
  id: d.open, tab: "elsewhere", tabLabel: "Elsewhere", group: "else", groupLabel: "Elsewhere",
  label: d.name, hint: d.hint, more: d.more, aliases: d.aliases, changed: false, isNew: false, mac: false,
});

/** Every setting, for ⌘K: the label, where it lives, and how to land on it. */
export function settingsIndex(): { label: string; tab: string; row: string; sub: string }[] {
  return tabsShown().flatMap((t) => t.controls().filter((c) => c.kind !== "note")
    .map((c) => ({ label: c.label, tab: t.id, row: rowId(c), sub: `Setting · ${t.label}` })));
}

// One page: every section in order, each under a sticky header, and the rail a table of
// contents. Typing filters the rows in place; the sections that keep none disappear and the
// rail shows a count per section instead of its dot.
export function renderSettings() {
  if (!settingsOpen()) return;
  const q = parseQuery(query);
  const searching = isSearching(q);
  const tabs = tabsShown();
  const controls = new Map(tabs.map((t) => [t.id, t.controls()]));
  const counts = new Map<string, number>();
  let shown = 0, secs = 0, fuzzyAny = false, html = "";
  for (const t of tabs) {
    const kept: [SetControl, SearchHit | null][] = [];
    for (const c of controls.get(t.id)!) {
      if (!searching) { kept.push([c, null]); continue; }
      if (c.kind === "note") continue;
      const h = matchRow(searchRow(t, c), q);
      if (h) { kept.push([c, h]); fuzzyAny ||= h.fuzzy; }
    }
    const n = kept.filter(([c]) => c.kind !== "note").length;
    counts.set(t.id, n);
    if (searching && !n) continue;
    shown += n; secs++;
    html += `<section class="set-sec" data-sec="${t.id}"><div class="set-sech"><h3>${esc(t.label)}</h3>`
      + `<span class="set-secsub">${esc(t.sub)}</span>${t.os ? `<span class="set-tag">macOS only</span>` : ""}`
      + `<span class="set-secgrp">${esc(groupLabel(t.group))}</span></div>`
      + kept.map(([c, h]) => renderSetControl(c, h, q.words)).join("") + `</section>`;
  }
  const doors = searching ? ELSEWHERE.filter((d) => matchRow(doorRow(d), q)) : [];
  if (doors.length) {
    html += `<section class="set-sec" data-sec="elsewhere"><div class="set-sech"><h3>Elsewhere</h3>`
      + `<span class="set-secsub">Reports with a window of their own</span></div>` + doors.map((d) => doorHtml(d, q.words)).join("") + `</section>`;
  }
  const body = $("setBody");
  const sc = body.scrollTop; // preserved across the rebuild; a stepper press must not jump the page
  body.innerHTML = html || `<div class="set-none">Nothing matches <b>${esc(query.trim())}</b>.<p>Fewer words, or ${
    SEARCH_FILTERS.map((f) => `<button class="set-chip" data-setq="${f}">${f}</button>`).join(" ")}.</p></div>`;
  body.scrollTop = sc;
  // The rail: a count per section while searching, a dot where something is changed.
  const tabHtml = (t: SetTab) => {
    const n = counts.get(t.id) ?? 0;
    const chg = !searching && controls.get(t.id)!.some(isChanged);
    return `<button class="set-tab${t.id === setTab ? " on" : ""}${searching && !n ? " zero" : ""}" data-settab="${t.id}">`
      + `<span class="set-tglyph">${t.glyph}</span>${esc(t.label)}`
      + (searching ? `<span class="set-tn">${n}</span>` : chg ? `<span class="set-tdot" title="Something here is changed"></span>` : "") + `</button>`;
  };
  $("setTabs").innerHTML = SET_GROUPS.map((g) => `<div class="set-grp">${esc(g.label)}</div>${tabs.filter((t) => t.group === g.id).map(tabHtml).join("")}`).join("")
    + `<div class="set-grp">Elsewhere</div>` + ELSEWHERE.map((d) =>
      `<button class="set-tab set-door" data-setgo="${d.open}" title="Opens in its own window"><span class="set-tglyph">↗</span>${esc(d.name)}</button>`).join("");
  const all = [...controls.values()].flat().filter((c) => c.kind !== "note");
  const n = { "@changed": all.filter(isChanged).length, "@new": all.filter(isNew).length,
    "@mac": tabs.filter((t) => t.os === "mac").flatMap((t) => controls.get(t.id)!.filter((c) => c.kind !== "note")).length };
  $("setChips").innerHTML = SEARCH_FILTERS.filter((f) => f !== "@mac" || IS_MAC).map((f) =>
    `<button class="set-chip${query.includes(f) ? " on" : ""}" data-setq="${f}">${f} <b>${n[f]}</b></button>`).join("");
  $("setCount").textContent = searching ? "" : String(all.length);
  $("setStatus").innerHTML = !searching ? "" : `<b>${shown}</b> setting${shown === 1 ? "" : "s"} in <b>${secs}</b> section${secs === 1 ? "" : "s"}`
    + (doors.length ? ` · <b>${doors.length}</b> elsewhere` : "")
    + (fuzzyAny ? ` · <span class="set-fz">no whole-word match; closest by letters</span>` : "")
    + (q.unknown.length ? ` · <span class="set-fz">unknown ${esc(q.unknown.join(", "))}</span>` : "");
  $("setDlg").classList.toggle("searching", searching);
  $("setSearch").classList.toggle("has", query.length > 0);
  spy();
}
function doorHtml(d: (typeof ELSEWHERE)[number], words: string[]): string {
  return `<div class="set-row" data-setrow="${d.open}"><div class="set-inline"><div class="set-itxt">`
    + `<div class="set-glabel">${highlight(d.name, words)}<span class="set-tag">own window</span></div>`
    + `<div class="set-hint">${highlight(d.hint, words)}</div><div class="set-more set-more-on">${highlight(d.more, words)}</div>`
    + `</div><div class="set-ctl"><button class="set-abtn" data-setgo="${d.open}">Open ↗</button></div></div></div>`;
}
// The rail follows the scroll: the last header at or above the top edge, with one header's
// height of slack, as the diff overlay's index rail does.
function spy() {
  if (Date.now() < spyHold) return;
  const body = $("setBody");
  const top = body.getBoundingClientRect().top;
  let cur: string | null = null;
  for (const sec of body.querySelectorAll<HTMLElement>(".set-sec")) {
    if (sec.getBoundingClientRect().top - top <= 44) cur = sec.dataset.sec!;
  }
  if (cur && cur !== "elsewhere") markTab(cur);
}
function markTab(id: string) {
  setTab = id;
  for (const b of $("setTabs").querySelectorAll<HTMLElement>("[data-settab]")) b.classList.toggle("on", b.dataset.settab === id);
}
function scrollBodyTo(el: HTMLElement, offset: number) {
  const body = $("setBody");
  spyHold = Date.now() + 700;
  body.scrollTo({ top: el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - offset, behavior: "smooth" });
}
function goToTab(id: string) {
  const sec = $("setBody").querySelector<HTMLElement>(`.set-sec[data-sec="${CSS.escape(id)}"]`);
  if (sec) scrollBodyTo(sec, 0);
  markTab(id);
}
function openDoor(which: string) {
  closeSettings();
  if (which === "usage") host.openUsage(); else host.openWhatsNew();
}
function findControl(id: string): SetControl | undefined {
  for (const t of tabsShown()) for (const c of t.controls()) if (rowId(c) === id) return c;
  return undefined;
}
// ↓/↑ walk the visible rows from the search box; ↵ hands focus to the row's control.
function moveCursor(dir: 1 | -1) {
  const rows = [...$("setBody").querySelectorAll<HTMLElement>(".set-row")];
  if (!rows.length) return;
  const at = rows.findIndex((r) => r.classList.contains("cur"));
  const next = rows[at < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + dir))];
  rows.forEach((r) => r.classList.toggle("cur", r === next));
  next.scrollIntoView({ block: "nearest" });
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

// ---- Settings > Appearance: the OSC title scrub ---------------------------------
// ./format parses the field and owns every rule; everything here is readout — what it
// understood, and the rule run on a title you can recognise.

type TitleSample = { raw: string; ctx: { title: string; workdir: string; project: string } };

// What the preview runs the rule against, latched while the panel is up: which session
// the rule "currently changes" depends on what you have typed, so re-picking per keystroke
// would swap the example out mid-word. The canned fallback is deliberately not latched —
// its job is to carry the character you just typed.
let heldSample: TitleSample | null = null;
function titleSample(prefs: TitlePrefs): TitleSample {
  if (heldSample) return heldSample;
  let any: TitleSample | null = null;
  for (const sess of sessions.values()) {
    if (!sess.rawTitle) continue;
    const one = { raw: sess.rawTitle, ctx: sess };
    // The pane worth showing is one the rule currently *changes*. `.trim()` is the
    // do-nothing baseline: cleanTitle trims either way, so comparing against the raw
    // string would call every title with a leading space "changed".
    if (cleanTitle(sess.rawTitle, sess, prefs) !== sess.rawTitle.trim()) return (heldSample = one);
    any ||= one;
  }
  if (any) return (heldSample = any);
  const first = titleExtra(prefs.extra)[0];
  return {
    raw: `${first ? String.fromCodePoint(first[0]) : "✳"} Fixing the parser`,
    ctx: { title: "", workdir: "/w/app", project: "app" },
  };
}

// One chip per parsed token. The codepoint count on a range is the honest part —
// `⠀-⣿` is three characters to type and 256 to strip.
function titleChips(extra: string): string {
  const toks = titleExtra(extra);
  if (!toks.length) {
    return `<div class="tnone">${esc(extra.trim()
      ? "Nothing usable in there yet."
      : "Nothing added — the built-in table only.")}</div>`;
  }
  return `<div class="chips">${toks.map(([a, b]) => {
    const ch = (c: number) => `<span class="mono">${esc(String.fromCodePoint(c))}</span>`;
    return a === b
      ? `<span class="tchip">${ch(a)}</span>`
      : `<span class="tchip">${ch(a)}–${ch(b)}<span class="tchip-n">${b - a + 1}</span></span>`;
  }).join("")}</div>`;
}

function renderTitleControl(): string {
  const p = titlePrefs;
  heldSample = null; // a fresh paint re-picks
  const { raw, ctx } = titleSample(p);
  const out = cleanTitle(raw, ctx, p);
  return `<div class="titlebox${p.scrub ? "" : " off"}">
    <label class="tlabel" for="titleExtra">Extra characters to strip</label>
    <input id="titleExtra" class="tfield mono" type="text" spellcheck="false" autocomplete="off"
      maxlength="${TITLE_EXTRA_MAX}" data-titleextra
      placeholder="◐-◗ ◴-◷ ✦✧"
      value="${escAttr(p.extra)}"
      aria-describedby="titleParsed">
    <div class="thint">Single characters, or <span class="mono">a-b</span> for a range. Only ever
      <em>added</em> to the built-in table, never taken from it.</div>
    <div id="titleParsed" class="tparsed">${titleChips(p.extra)}</div>
    ${titlePreviewHtml(raw, out)}
    <div class="trow-end"><button class="set-freset" data-settitle="reset"
      ${p.extra ? "" : "disabled"}>Clear</button></div>
  </div>`;
}

// Split out because the keystroke handler repaints only this row — rebuilding the
// whole control would take the <input> with it.
function titlePreviewHtml(raw: string, out: string): string {
  return `<div class="tprev" id="titlePrev">
    <div class="tprev-r"><span class="tprev-k">Sent</span><span class="tprev-v mono">${esc(raw)}</span></div>
    <div class="tprev-r"><span class="tprev-k">Shown</span><span class="tprev-v mono${out ? "" : " tprev-empty"}">${
      esc(out) || "— the folder name, so the row shows nothing extra"}</span></div>
  </div>`;
}

// One row shape for every kind: text left (the label, one sentence, the folded why), the
// control right, and under it whatever the control folds (a panel, a preview, the cards).
function renderSetControl(c: SetControl, hit: SearchHit | null, words: string[]): string {
  if (c.kind === "note") {
    return `<div class="set-note"><div class="set-glabel">${highlight(c.label, words)}</div><div class="set-hint">${highlight(c.hint, words)}</div></div>`;
  }
  const id = rowId(c);
  const open = openPanels.has(id) || (hit?.lines.length ?? 0) > 0;
  const fold = (label: string) =>
    `<button class="set-fold${open ? " on" : ""}" data-setfold="${id}" aria-expanded="${open}">${esc(label)}<span class="set-foldc">▾</span></button>`;
  const sw = (on: boolean, attr: string) => `<button class="sw${on ? " on" : ""}" ${attr} role="switch" aria-checked="${on}"></button>`;
  let ctl = "", panel = "", always = false;
  switch (c.kind) {
    case "peek": ctl = sw(peekPrefs.enabled, `data-setpeek="toggle"`) + fold(c.summary!()); panel = renderPeekControl(); break;
    case "attn": ctl = sw(attnPrefs.highlight, `data-setattn="highlight"`) + fold(c.summary!()); panel = renderAttnControl(); break;
    case "title": ctl = sw(titlePrefs.scrub, `data-settitle="toggle"`) + fold(c.summary!()); panel = renderTitleControl(); break;
    case "revive": ctl = sw(revivePrefs.enabled, `data-setrevive="toggle"`) + fold(c.summary!()); panel = renderReviveControl(); break;
    case "sound": ctl = sw(soundPrefs.enabled, `data-setsound="toggle"`) + fold(c.summary!()); panel = renderSoundControl(); break;
    case "keys": ctl = sw(keyPrefs.enabled, `data-setkey="toggle"`) + fold(c.summary!()); panel = renderKeysControl(); break;
    case "guide": ctl = fold(c.summary!()); panel = renderGuideControl(); break;
    case "wtpreview": ctl = fold(c.summary!()); panel = renderWtPreview(c.active()); break;
    case "font":
      ctl = `<div class="set-font">
        <button class="set-fbtn" data-setfont="-0.5" title="Smaller" aria-label="Smaller">−</button>
        <span class="set-fval mono">${termFontSize}px</span>
        <button class="set-fbtn" data-setfont="0.5" title="Larger" aria-label="Larger">+</button></div>`;
      break;
    case "toggle": {
      const on = c.on();
      ctl = (c.preview ? fold(c.previewLabel ?? "preview") : "")
        + `<button class="sw${on ? " on" : ""}" data-set="${c.set}" data-val="${on ? "0" : "1"}" role="switch" aria-checked="${on}"></button>`;
      if (c.preview && open) panel = c.preview();
      break;
    }
    case "action":
      // An action's preview is its answer (the grant held, the checks found): never folded.
      ctl = `<button class="set-abtn${c.danger ? " danger" : ""}" data-set="${c.set}" data-val="1">${esc(c.btn)}</button>`;
      if (c.preview) { panel = c.preview(); always = true; }
      break;
    case "multi": {
      const on = c.on();
      const segs = c.segs();
      ctl = fold(c.summary?.() ?? String(on.length));
      panel = segs.length
        ? `<div class="chips">${segs.map((s) =>
            `<button class="chip-opt ${on.includes(s.value) ? "on" : ""}" data-set="${c.set}" data-val="${escAttr(s.value)}" title="${escAttr(s.sub || s.label)}">`
            + `${s.glyph ? `<span class="seg-glyph">${s.glyph}</span>` : ""}${esc(s.label)}</button>`).join("")}</div>`
        : `<div class="set-empty">${esc(c.empty || "Nothing here yet.")}</div>`;
      break;
    }
    case "seg": {
      const active = c.active();
      const segs = c.segs();
      // A picker with a logo keeps its cards (the agent); everything else is one row of buttons.
      if (segs.some((s) => s.logo)) { ctl = fold(segs.find((s) => s.value === active)?.label ?? active); panel = segCards(c.set, segs, active); }
      else ctl = segInline(c, segs, active);
      break;
    }
  }
  const chg = isChanged(c);
  const reset = chg && c.reset ? `<button class="set-reset" data-setreset="${id}" title="Back to the default" aria-label="Reset ${escAttr(c.label)}">⟲</button>` : "";
  const why = c.more ? `<button class="set-why" data-setwhy="${id}" aria-expanded="${openWhy.has(id)}">why</button>` : "";
  const cur = c.kind === "seg" ? c.segs().find((s) => s.value === c.active())?.sub : undefined;
  const seen = new Set<string>();
  const matched = hit?.why.filter((w) => { const k = w.word + (w.line ?? w.field); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3) ?? [];
  const showPanel = !!panel && (always || open);
  return `<div class="set-row${chg ? " set-chg" : ""}${c.dim?.() ? " set-dim" : ""}${open ? " set-open" : ""}${openWhy.has(id) ? " set-why-open" : ""}" data-setrow="${id}">
    <div class="set-inline"><div class="set-itxt">
      <div class="set-glabel">${highlight(c.label, words)}${isNew(c) ? `<span class="set-tag set-tag-new">new</span>` : ""}</div>
      ${c.hint ? `<div class="set-hint">${highlight(c.hint, words)}${why}</div>` : ""}
      ${cur ? `<div class="set-cur">${esc(cur)}</div>` : ""}
      ${c.more ? `<div class="set-more">${highlight(c.more, words)}</div>` : ""}
      ${matched.length ? `<div class="set-matched">matched ${matched.map((w) => `“<b>${esc(w.word)}</b>” · ${esc(w.line ?? w.field)}`).join(" · ")}</div>` : ""}
    </div><div class="set-ctl">${reset}${ctl}</div></div>
    ${showPanel ? `<div class="set-panel">${panel}</div>` : ""}</div>`;
}
function segInline(c: SetControl & { kind: "seg" }, segs: SetSeg[], active: string): string {
  return `<div class="set-seg" role="radiogroup" aria-label="${escAttr(c.label)}">${segs.map((s) =>
    `<button class="set-segb${s.value === active ? " on" : ""}" data-set="${c.set}" data-val="${escAttr(s.value)}" title="${escAttr(s.sub ?? s.label)}" aria-pressed="${s.value === active}">${esc(s.label)}</button>`).join("")}</div>`;
}
function segCards(set: string, segs: SetSeg[], active: string): string {
  return `<div class="seg">${segs.map((s) =>
    `<button class="seg-opt ${s.value === active ? "on" : ""}" data-set="${set}" data-val="${escAttr(s.value)}">`
    + `<span class="seg-top">${s.logo ? `<span class="seg-glyph agent-logo" aria-hidden="true">${s.logo}</span>` : s.glyph ? `<span class="seg-glyph${[...s.glyph].length === 2 ? " seg-mono" : ""}">${s.glyph}</span>` : ""}<span class="seg-l">${esc(s.label)}</span><span class="seg-check">✓</span></span>`
    + `${s.sub ? `<span class="seg-s">${esc(s.sub)}</span>` : ""}</button>`).join("")}</div>`;
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

// ---- Settings > Privacy: what macOS was asked, and by what ----
// `by` is the binary that actually reached, the one fact the dialog itself never shows.
export interface PrivacyAsk { at: string; service: string; by: string }

// `null` is "not looked yet", which is not "no". Both readings arrive from the host and
// repaint; neither is stored, since either can be false by the time you read it again.
let fdaHeld: boolean | null = null;
let asks: PrivacyAsk[] | null = null;
let scanning = false;

/** Re-probe on open: a grant given in System Settings lands while this window is shut. */
export function refreshAccess() {
  if (!IS_MAC) return;
  void host.fullDiskAccess().then((ok) => { fdaHeld = ok; renderSettings(); });
}

function fdaPreview(): string {
  const txt = fdaHeld === null
    ? "Checking\u2026"
    : fdaHeld
      ? "Episko holds full disk access, so these dialogs stay quiet \u2014 for it and for everything it launches."
      : "Episko does not hold full disk access. Nothing is broken: a session denied one of these gets a refusal on a folder it had no business in.";
  return `<div class="set-vitals"><div class="sv-verdict">${esc(txt)}</div></div>`;
}

function asksPreview(): string {
  const head = `<div class="set-vitals"><div class="sv-verdict">`;
  if (scanning) return `${head}Reading the log\u2026</div></div>`;
  if (!asks) return `${head}Nothing read yet. The scan covers the last 24 hours and takes a few seconds.</div></div>`;
  if (!asks.length) return `${head}Nothing asked in Episko's name in the last 24 hours.</div></div>`;
  const rows = asks.slice(0, 12).map((a) =>
    `<tr><td class="mono">${esc(a.at.slice(5, 16))}</td><td>${esc(tccLabel(a.service))}</td>`
    + `<td class="mono" title="${escAttr(a.by)}">${esc(basename(a.by))}</td></tr>`).join("");
  const more = asks.length > 12 ? ` \u00b7 ${asks.length - 12} older not shown` : "";
  return `${head}${asks.length} check${asks.length === 1 ? "" : "s"} in the last 24 hours${more}</div>`
    + `<table class="sv-tbl"><thead><tr><th>When</th><th>Checked</th><th>By</th></tr></thead><tbody>${rows}</tbody></table>`
    + `<div class="sv-foot">The <b>By</b> column is the binary that actually reached \u2014 an agent, something it ran, or Episko itself.</div></div>`;
}

function resetPrompts() {
  host.resetAppDataPrompts()
    .then(() => toast("macOS will ask again the next time a session reaches"))
    .catch((e) => toast(String(e)));
}

function scanAsks() {
  if (scanning) return;
  scanning = true;
  renderSettings();
  host.privacyAsks()
    .then((rows) => { asks = rows; })
    .catch((e) => { asks = []; toast(String(e)); })
    .finally(() => { scanning = false; renderSettings(); });
}

function applySetting(set: string, val: string) {
  if (set === "engine") host.setEngine(val as Engine);
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
  else if (set === "outline:on") host.setOutlinePrefs({ ...outlinePrefs, enabled: val === "1" });
  else if (set === "outline:lines") host.setOutlinePrefs({ ...outlinePrefs, lines: +val });
  else if (set === "outline:hover") host.setOutlinePrefs({ ...outlinePrefs, hover: val === "1" });
  else if (set === "fetch:on") host.setAutoFetchPrefs({ ...autoFetchPrefs, enabled: val === "1" });
  else if (set === "fetch:every") host.setAutoFetchPrefs({ ...autoFetchPrefs, everyMs: +val });
  else if (set === "perf:vitals") host.setVitalsPrefs({ ...vitalsPrefs, enabled: val === "1" });
  else if (set === "perf:every") host.setVitalsPrefs({ ...vitalsPrefs, everyMs: +val });
  else if (set === "perf:scroll") host.setScrollback(+val);
  else if (set === "priv:fda") { void host.openPrivacyPane("fulldisk").catch((e) => toast(String(e))); return; }
  else if (set === "priv:reset") { resetPrompts(); return; }
  else if (set === "priv:scan") { scanAsks(); return; }
  else if (set === "perf:reload") { void host.reloadUi(); return; }
  else if (set === "perf:devtools") { host.openDevtools(); return; }
  else if (set === "untrust") untrustProject(val);
  else if (set === "unstop") clearStopRule(val);
  renderSettings();
}
// The switch and Clear. Both repaint: neither owns a live node.
function applyTitleSetting(cmd: string) {
  if (cmd === "toggle") { host.setTitlePrefs({ ...titlePrefs, scrub: !titlePrefs.scrub }); return; }
  // Names the field it clears rather than spreading TITLE_DEFAULTS, like peek's Reset
  // below: it says Clear next to the text field and must not also flip the switch.
  if (cmd === "reset") host.setTitlePrefs({ ...titlePrefs, extra: "" });
}

// A keystroke in the extra-characters field. Commits live, but patches only the readout:
// `renderSettings()` here would replace the <input> mid-word.
function applyTitleExtra(el: HTMLInputElement) {
  const next = { ...titlePrefs, extra: el.value };
  host.setTitlePrefs(next, false);
  const box = el.closest(".titlebox");
  const parsed = box?.querySelector("#titleParsed");
  if (parsed) parsed.innerHTML = titleChips(titlePrefs.extra);
  const prev = box?.querySelector("#titlePrev");
  if (prev) {
    const { raw, ctx } = titleSample(titlePrefs);
    prev.outerHTML = titlePreviewHtml(raw, cleanTitle(raw, ctx, titlePrefs));
  }
  // Clear is the one control whose enabled state depends on the field.
  const clear = box?.querySelector<HTMLButtonElement>("[data-settitle='reset']");
  if (clear) clear.disabled = !titlePrefs.extra;
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
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-settab],[data-setgo]");
  if (!b) return;
  if (b.dataset.settab) goToTab(b.dataset.settab); else openDoor(b.dataset.setgo!);
});
// The chips toggle their @ word in and out of the query; the box keeps focus so typing goes on.
function toggleFilter(f: string) {
  const words = query.split(/\s+/).filter(Boolean);
  setQuery(words.includes(f) ? words.filter((w) => w !== f).join(" ") : [...words, f].join(" "));
  renderSettings();
  $("setQ").focus();
}
$("setChips").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-setq]");
  if (b) toggleFilter(b.dataset.setq!);
});
$("setQ").addEventListener("input", (e) => { query = (e.target as HTMLInputElement).value; renderSettings(); });
$("setQ").addEventListener("keydown", (e) => {
  // Esc clears first and closes on the second press; stopped here, or main.ts closes at once.
  if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); renderSettings(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveCursor(e.key === "ArrowDown" ? 1 : -1); }
  else if (e.key === "Enter") {
    const ctl = $("setBody").querySelector<HTMLElement>(".set-row.cur .set-ctl button");
    if (ctl) { e.preventDefault(); ctl.focus(); }
  }
});
$("setQClear").addEventListener("click", () => { setQuery(""); renderSettings(); $("setQ").focus(); });
$("setBody").addEventListener("scroll", spy, { passive: true });
$("setBody").addEventListener("click", (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>("[data-setfont]");
  if (f) { setFontFromSettings(f.dataset.setfont!); return; }
  const ti = (e.target as HTMLElement).closest<HTMLElement>("[data-settitle]");
  if (ti) { applyTitleSetting(ti.dataset.settitle!); return; }
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
  const wy = (e.target as HTMLElement).closest<HTMLElement>("[data-setwhy]");
  if (wy) { const id = wy.dataset.setwhy!; openWhy.has(id) ? openWhy.delete(id) : openWhy.add(id); renderSettings(); return; }
  const fo = (e.target as HTMLElement).closest<HTMLElement>("[data-setfold]");
  if (fo) { const id = fo.dataset.setfold!; openPanels.has(id) ? openPanels.delete(id) : openPanels.add(id); renderSettings(); return; }
  const rs = (e.target as HTMLElement).closest<HTMLElement>("[data-setreset]");
  if (rs) { findControl(rs.dataset.setreset!)?.reset?.(); renderSettings(); return; }
  const go = (e.target as HTMLElement).closest<HTMLElement>("[data-setgo]");
  if (go) { openDoor(go.dataset.setgo!); return; }
  const qc = (e.target as HTMLElement).closest<HTMLElement>("[data-setq]");
  if (qc) { toggleFilter(qc.dataset.setq!); return; }
  const o = (e.target as HTMLElement).closest<HTMLElement>("[data-set]");
  if (o) applySetting(o.dataset.set!, o.dataset.val!);
});
// The one text field in this window, delegated on #setBody like every handler here so it
// survives a tab change's renderSettings().
$("setBody").addEventListener("input", (e) => {
  const f = (e.target as HTMLElement).closest<HTMLInputElement>("[data-titleextra]");
  if (f) applyTitleExtra(f);
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

$("setBody").addEventListener("mouseleave", () => {
  // No mouseover fires on leaving, so forget the row or a return to it would not replay.
  attnHover = null;
});
