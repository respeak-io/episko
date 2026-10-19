// Keyboard shortcuts: the bindable actions, their chords and the one matcher the global
// keydown runs. Pure, so main.ts, the footer popover and Settings › Keys read one table.
// Matching is exact (every modifier must agree), so the table's order is never load-bearing.
// Never reads the platform: every caller passes `mac`, so vitest can exercise both.

export type KeyAction =
  | "palette" | "sessionSwitch" | "navBack" | "navForward" | "terminal" | "terminalOther" | "history" | "reveal" | "files"
  | "buildTask" | "testTask" | "runTask"
  | "sidebar" | "inspector" | "settings"
  | "fontUp" | "fontDown" | "fontReset";

// `mod` is ⌘ on macOS and Ctrl elsewhere: one flag, both accepted. `key` is a normalised
// `e.key` (never `e.code`, so ⌘B stays the B key on every layout), a NAMED key or DIGIT_KEY.
export interface Combo { mod: boolean; alt: boolean; shift: boolean; key: string }

// Pseudo-key for the switcher's nine digits. Only `sessionSwitch` may carry it, and `comboOf`
// only produces it when asked, or recording ⌘⌥3 elsewhere would claim all nine.
export const DIGIT_KEY = "digit";

/** Pressed alone these produce no chord; a recorder must keep waiting. */
const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Dead", "Unidentified", "OS", "Fn", "FnLock"]);

// Shift-only characters fold onto the unshifted key, so ⌘+ (Shift+=) matches the stepper's mod+=.
const SHIFT_ALIAS: Record<string, string> = { "+": "=", _: "-" };
// What those fold TO. Shift cannot be held on one of these: the press arrives as the other
// character, so a stored `mod+shift+=` would parse and then never match a real key event.
const UNSHIFTED = new Set(Object.values(SHIFT_ALIAS));
// The named keys a chord may end on; the rest (Escape, Tab, up/down, F-keys) stay refused.
const NAMED: Record<string, string> = { Enter: "enter", ArrowLeft: "left", ArrowRight: "right" };
const NAMED_KEYS = new Set(Object.values(NAMED));

export interface KeyActionDef {
  id: KeyAction;
  label: string;
  hint?: string;
  combo: string; // the shipped chord, canonical form
  pc?: string; // the shipped chord off macOS, where ⌘'s twin would be a terminal's own key
  rowLabel?: string; // consecutive actions sharing this collapse into one footer row
}

// In the footer popover's order. Escape is not here (it backs out of nine dialogs, not one
// action), nor is terminal copy/paste (xterm's own `clipboardKeys`, below this layer).
export const KEY_ACTIONS: KeyActionDef[] = [
  { id: "palette",       label: "Command palette",           combo: "mod+k" },
  { id: "sessionSwitch", label: "Switch to session 1–9",     combo: "mod+digit",   hint: "One binding over nine digits. A digit bound elsewhere is carved out; the rest keep working." },
  { id: "navBack",       label: "Back to the previous screen", combo: "mod+[", pc: "mod+alt+left", rowLabel: "Back · forward", hint: "Sessions, dashboards and mirrors you had on stage, like a browser's back. The mouse's back button does it too. Off macOS it ships on Ctrl+Alt+←/→, leaving Alt+←/→ to a terminal's word jump." },
  { id: "navForward",    label: "Forward again",             combo: "mod+]", pc: "mod+alt+right", rowLabel: "Back · forward" },
  { id: "terminal",      label: "Open a terminal here",      combo: "mod+t",       hint: "A plain shell, beside the session or in its own pane: Settings › Launching decides." },
  { id: "terminalOther", label: "Open a terminal, the other way", combo: "mod+alt+t", hint: "Its own pane when new terminals split; a split when they don't." },
  { id: "history",       label: "Session history",           combo: "mod+shift+h" },
  { id: "files",         label: "Find a file in this project", combo: "mod+p",      hint: "Empty, it browses the folder; typing finds across the project." },
  { id: "reveal",        label: "Reveal this folder",        combo: "mod+shift+enter" },
  { id: "buildTask",     label: "Run the default build task", combo: "mod+shift+b" },
  { id: "testTask",      label: "Run the default test task",  combo: "mod+shift+t" },
  { id: "runTask",       label: "Run a task…",                combo: "mod+shift+r", hint: "Inside the picker, the same chord re-scans." },
  { id: "sidebar",       label: "Toggle sidebar",            combo: "mod+b" },
  { id: "inspector",     label: "Toggle inspector",          combo: "mod+i" },
  { id: "settings",      label: "Settings",                  combo: "mod+," },
  { id: "fontUp",        label: "Larger terminal font",      combo: "mod+=", rowLabel: "Terminal font size" },
  { id: "fontDown",      label: "Smaller terminal font",     combo: "mod+-", rowLabel: "Terminal font size" },
  { id: "fontReset",     label: "Reset terminal font",       combo: "mod+0", rowLabel: "Terminal font size" },
];

export const KEY_ACTION_IDS: KeyAction[] = KEY_ACTIONS.map((d) => d.id);
export function keyActionDef(id: KeyAction): KeyActionDef {
  return KEY_ACTIONS.find((d) => d.id === id) || KEY_ACTIONS[0];
}
// Ctrl+[ is Escape to a terminal, so off macOS back/forward ship on the browser's Alt+arrows.
export function shippedCombo(d: KeyActionDef, mac: boolean): string {
  return !mac && d.pc ? d.pc : d.combo;
}

// The Settings picker's sections; the test suite checks they cover KEY_ACTIONS exactly once.
export const KEY_GROUPS: { label: string; actions: KeyAction[] }[] = [
  { label: "Sessions", actions: ["palette", "sessionSwitch", "navBack", "navForward", "terminal", "terminalOther", "history", "reveal", "files"] },
  { label: "Tasks", actions: ["buildTask", "testTask", "runTask"] },
  { label: "The window", actions: ["sidebar", "inspector", "settings", "fontUp", "fontDown", "fontReset"] },
];

/** Every action's current chord; `null` means the user cleared it. */
export type KeyBinds = Record<KeyAction, Combo | null>;

// Two levels of off, stored separately: a cleared row (`binds[id] === null`) and the master switch.
export interface KeyPrefs { enabled: boolean; binds: KeyBinds }

// null while the switch is off. Every matcher and display site reads through here, never `binds`.
export function activeBind(p: KeyPrefs, id: KeyAction): Combo | null {
  return p.enabled ? p.binds[id] : null;
}

// ---------- chords as text ----------

/** Canonical form: modifiers in a fixed order, then the key. `"mod+shift+b"`. */
export function formatCombo(c: Combo): string {
  return `${c.mod ? "mod+" : ""}${c.alt ? "alt+" : ""}${c.shift ? "shift+" : ""}${c.key}`;
}

// Tolerant of order and case for a hand-edited `cc-keys`; anything it cannot read is null, not junk.
export function parseCombo(s: unknown): Combo | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const parts = s.toLowerCase().split("+").map((p) => p.trim());
  const c: Combo = { mod: false, alt: false, shift: false, key: "" };
  for (const p of parts) {
    if (p === "mod" || p === "cmd" || p === "ctrl" || p === "meta" || p === "control") c.mod = true;
    else if (p === "alt" || p === "opt" || p === "option") c.alt = true;
    else if (p === "shift") c.shift = true;
    // An empty part is the "+" key written literally ("mod++" splits to ["mod","",""]).
    else if (p === "") { if (!c.key) { c.key = "="; c.shift = false; } }
    else if (!c.key) c.key = p;
    else return null; // two keys in one chord
  }
  if (!c.key) return null;
  if (!NAMED_KEYS.has(c.key) && c.key !== DIGIT_KEY && c.key.length !== 1) return null;
  const alias = SHIFT_ALIAS[c.key];
  if (alias) c.key = alias;
  if (UNSHIFTED.has(c.key)) c.shift = false;
  return c;
}

/** What a KeyboardEvent gives us. A duck type, so tests need no DOM. */
export interface KeyLike { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }

// With ⌥ held a Mac reports the option-layer character (⌥T is †, ⌥E a dead key), so an alt chord
// reads the physical key instead. Letters and digits only; `code` names positions, not characters.
function physicalKey(code: string | undefined): string | null {
  const m = code ? /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code) : null;
  return m ? (m[1] ?? m[2]).toLowerCase() : null;
}

// On a Mac, Ctrl+[ / Ctrl+] are a terminal's ESC and ^], never ⌘'s twin; and on layouts that
// need ⌥ to type a bracket (German, French, Nordic), that ⌥ is part of the character, not the chord.
function macBracket(ev: KeyLike): { mod: boolean; alt: boolean } | null {
  if (ev.key !== "[" && ev.key !== "]") return null;
  const typedWithOpt = !!ev.altKey && ev.code !== "BracketLeft" && ev.code !== "BracketRight";
  return { mod: !!ev.metaKey, alt: !!ev.altKey && !typedWithOpt };
}

// Recording and matching both normalise here. Named keys outside NAMED are refused. `mac`
// defaults to the PC reading; every matcher passes it, so only a test may leave it out.
export function comboOf(ev: KeyLike, opts: { digits?: boolean; mac?: boolean } = {}): Combo | null {
  const raw = ev.key;
  if (!raw) return null;
  const br = opts.mac ? macBracket(ev) : null;
  if (br) return { mod: br.mod, alt: br.alt, shift: !!ev.shiftKey, key: raw };
  const phys = ev.altKey ? physicalKey(ev.code) : null;
  let key: string;
  let shift = !!ev.shiftKey;
  if (phys) key = phys;
  else if (MODIFIER_KEYS.has(raw)) return null;
  else if (NAMED[raw]) key = NAMED[raw];
  else if (raw.length === 1) {
    const alias = SHIFT_ALIAS[raw];
    if (alias) { key = alias; shift = false; } else key = raw.toLowerCase();
  } else return null;
  if (opts.digits && key >= "1" && key <= "9") key = DIGIT_KEY;
  return { mod: !!(ev.metaKey || ev.ctrlKey), alt: !!ev.altKey, shift, key };
}

export function sameCombo(a: Combo, b: Combo): boolean {
  return a.mod === b.mod && a.alt === b.alt && a.shift === b.shift && a.key === b.key;
}

export function comboMatches(c: Combo | null, ev: KeyLike, mac: boolean): boolean {
  if (!c) return false;
  const got = comboOf(ev, { digits: c.key === DIGIT_KEY, mac });
  return !!got && sameCombo(got, c);
}

// Exact equality only: `mod+digit` and `mod+3` do not clash. The literal wins its own digit
// in matchAction's second pass and the range keeps the other eight.
export function comboClash(a: Combo | null, b: Combo | null): boolean {
  return !!a && !!b && sameCombo(a, b);
}

// ---------- chords on screen ----------

// Takes `isMac` rather than reading `navigator`, like everything in this module.
export function comboKeys(c: Combo | null, isMac: boolean): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.mod) out.push(isMac ? "⌘" : "Ctrl");
  if (c.alt) out.push(isMac ? "⌥" : "Alt");
  if (c.shift) out.push("⇧");
  out.push(keyGlyph(c.key));
  return out;
}
export function keyGlyph(key: string): string {
  if (key === "enter") return "⏎";
  if (key === "left") return "←";
  if (key === "right") return "→";
  if (key === DIGIT_KEY) return "1–9";
  if (key === "=") return "+";       // it is Shift+= on the keyboard, but "+" is what it does
  if (key === "-") return "−";       // U+2212, so it can't be mistaken for a hyphen in the label
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}
export function comboText(c: Combo | null, isMac: boolean): string {
  if (!c) return "";
  const keys = comboKeys(c, isMac);
  return isMac ? keys.join("") : keys.join("+");
}

// ---------- the stored value ----------

export function defaultKeyBinds(mac: boolean): KeyBinds {
  const out = {} as KeyBinds;
  for (const d of KEY_ACTIONS) out[d.id] = parseCombo(shippedCombo(d, mac));
  return out;
}

// Whatever `cc-keys` held becomes a working map. Only overrides are stored, so a missing
// action keeps today's default and an explicit "" is a cleared row. The user's own chords
// settle first, then the defaults: a default a release adds never takes a chord you chose.
// Within a pass collisions resolve in KEY_ACTIONS order; the loser is unbound, not shared.
export function clampKeyBinds(raw: unknown, mac: boolean): KeyBinds {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as KeyBinds;
  const taken: Combo[] = [];
  const claim = (id: KeyAction, c: Combo | null) => {
    const won = c && !taken.some((t) => comboClash(t, c)) ? c : null;
    out[id] = won;
    if (won) taken.push(won);
  };
  const late: KeyActionDef[] = [];
  for (const d of KEY_ACTIONS) {
    const c = storedBind(src, d);
    if (c === undefined) late.push(d); else claim(d.id, c);
  }
  for (const d of late) claim(d.id, parseCombo(shippedCombo(d, mac)));
  return out;
}
// undefined: nothing usable stored, so the default applies (unparseable is corruption, and
// losing the shortcut to it would be worse). null: the row was cleared on purpose.
function storedBind(src: Record<string, unknown>, d: KeyActionDef): Combo | null | undefined {
  if (!(d.id in src)) return undefined;
  const v = src[d.id];
  if (v === "" || v === null) return null;
  const c = parseCombo(v);
  if (!c || (c.key === DIGIT_KEY && d.id !== "sessionSwitch") || !bindableCombo(c)) return undefined;
  return c;
}

// Needs a modifier: a bare letter would be swallowed from every terminal pane, Settings included.
export function bindableCombo(c: Combo | null): boolean {
  return !!c && (c.mod || c.alt) && !!c.key;
}

export function keyOverrides(binds: KeyBinds, mac: boolean): Record<string, string> {
  const dflt = defaultKeyBinds(mac);
  const out: Record<string, string> = {};
  for (const d of KEY_ACTIONS) {
    const cur = binds[d.id];
    const def = dflt[d.id];
    if (cur && def && formatCombo(cur) === formatCombo(def)) continue;
    if (!cur && !def) continue;
    out[d.id] = cur ? formatCombo(cur) : "";
  }
  return out;
}
export function isDefaultKeyBinds(binds: KeyBinds, mac: boolean): boolean {
  return Object.keys(keyOverrides(binds, mac)).length === 0;
}

export function defaultKeyPrefs(mac: boolean): KeyPrefs {
  return { enabled: true, binds: defaultKeyBinds(mac) };
}

// One blob, like `cc-peek` and `cc-sound`: the switch and the chords are only ever read
// together, and a flag that outlived its map would be undiagnosable.
export function serializeKeyPrefs(p: KeyPrefs, mac: boolean): { enabled: boolean; binds: Record<string, string> } {
  return { enabled: p.enabled, binds: keyOverrides(p.binds, mac) };
}
export function isDefaultKeyPrefs(p: KeyPrefs, mac: boolean): boolean {
  return p.enabled && isDefaultKeyBinds(p.binds, mac);
}

// `enabled` is true on anything but an explicit false (a blob written before the switch existed
// comes back on); a raw object with no `binds` key is that older shape, the overrides map alone.
export function clampKeyPrefs(raw: unknown, mac: boolean): KeyPrefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const nested = o.binds && typeof o.binds === "object" ? o.binds : null;
  const flat = "binds" in o || "enabled" in o ? {} : o;
  return { enabled: o.enabled !== false, binds: clampKeyBinds(nested ?? flat, mac) };
}
export function isDefaultBind(binds: KeyBinds, id: KeyAction, mac: boolean): boolean {
  const cur = binds[id];
  const def = defaultKeyBinds(mac)[id];
  if (!cur || !def) return !cur && !def;
  return formatCombo(cur) === formatCombo(def);
}

// ---------- mutations (pure: new map in, new map out) ----------

// Takes the chord from whoever held it; the displaced action is left unbound (reads "Off")
// rather than the press refused, which is what lets two shortcuts be swapped.
export function bindKey(binds: KeyBinds, id: KeyAction, combo: Combo): { binds: KeyBinds; took: KeyAction[] } {
  const next: KeyBinds = { ...binds };
  const took: KeyAction[] = [];
  for (const other of KEY_ACTION_IDS) {
    if (other === id) continue;
    if (comboClash(next[other], combo)) { next[other] = null; took.push(other); }
  }
  next[id] = combo;
  return { binds: next, took };
}
export function unbindKey(binds: KeyBinds, id: KeyAction): KeyBinds {
  return { ...binds, [id]: null };
}
export function resetKey(binds: KeyBinds, id: KeyAction, mac: boolean): KeyBinds {
  const def = defaultKeyBinds(mac)[id];
  return def ? bindKey(binds, id, def).binds : unbindKey(binds, id);
}

// ---------- what the handler asks ----------

// Runs on every keydown in the app, so it bails at the first thing that rules a chord out; the
// master switch is checked here, the one door in, so no caller can forget it. Two passes only
// for the pseudo-key: a literal `mod+3` bound elsewhere must beat the switcher's `mod+digit`.
export function matchAction(p: KeyPrefs, ev: KeyLike, mac: boolean): KeyAction | null {
  if (!p.enabled) return null;
  const plain = comboOf(ev, { mac });
  if (!plain || (!plain.mod && !plain.alt)) return null;
  for (const id of KEY_ACTION_IDS) {
    const c = p.binds[id];
    if (c && c.key !== DIGIT_KEY && sameCombo(c, plain)) return id;
  }
  if (plain.key >= "1" && plain.key <= "9") {
    const dig: Combo = { ...plain, key: DIGIT_KEY };
    for (const id of KEY_ACTION_IDS) {
      const c = p.binds[id];
      if (c && c.key === DIGIT_KEY && sameCombo(c, dig)) return id;
    }
  }
  return null;
}

export function digitOf(ev: KeyLike): number {
  const n = Number(ev.key);
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n : 0;
}

// Unbound actions are dropped (a chord-less row is a cheat sheet lying; with the switch off
// that is every row), and consecutive `rowLabel` siblings collapse into one row.
export function shortcutRows(p: KeyPrefs, isMac: boolean): { label: string; chords: string[][] }[] {
  const rows: { label: string; chords: string[][]; row?: string }[] = [];
  for (const d of KEY_ACTIONS) {
    const c = activeBind(p, d.id);
    if (!c) continue;
    const keys = comboKeys(c, isMac);
    const last = rows[rows.length - 1];
    if (d.rowLabel && last && last.row === d.rowLabel) { last.chords.push(keys); continue; }
    rows.push({ label: d.rowLabel || d.label, chords: [keys], row: d.rowLabel });
  }
  return rows.map(({ label, chords }) => ({ label, chords }));
}
