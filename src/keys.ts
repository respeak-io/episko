// Keyboard shortcuts: what can be bound, what each one is bound to, and the one
// matcher the global keydown handler runs. Pure — data in, answer out — so the
// dispatcher in main.ts, the footer's ⌘ Shortcuts popover and the Settings › Keys
// picker all read the SAME table instead of three hand-kept copies. (They were
// three: the handler, `SHORTCUTS` in ./footer, and index.html's hard-coded glyphs.)
//
// **Matching is exact, and that is the point.** The old if-chain tested `meta &&
// key === "b"` without `!e.shiftKey`, so ⌘⇧B only reached the build task because its
// branch happened to sit above ⌘B's — a new shifted binding written below its
// unshifted twin silently never fired, and the handler carried a comment warning
// about it. Here a combo matches only when every modifier agrees, so order in the
// table is not load-bearing and that trap cannot be re-armed.
//
// A binding may be `null` (unbound). That is not just tidiness: it is what lets a
// recorded chord be *taken* from whoever held it — the displaced row reads "Off"
// on screen, which is honest — rather than the picker refusing the press and leaving
// the user with no way to swap two shortcuts.

/** Everything the global keydown handler can be asked to do. */
export type KeyAction =
  | "palette" | "sessionSwitch" | "terminal" | "history" | "reveal" | "files"
  | "buildTask" | "testTask" | "runTask"
  | "sidebar" | "inspector" | "settings"
  | "fontUp" | "fontDown" | "fontReset";

/**
 * A chord. `mod` is ⌘ on macOS and Ctrl everywhere else — one flag, not two,
 * because every handler in the app has always accepted `e.metaKey || e.ctrlKey`
 * and only the *glyph* differs per platform.
 *
 * `key` is normalised from `KeyboardEvent.key`: a lowercased single character,
 * `"enter"`, or the pseudo-key `"digit"` (see below). Deliberately NOT `e.code`:
 * `e.key` is what the shipped handler has always compared, so ⌘B stays the B key
 * on every layout rather than becoming a physical position.
 */
export interface Combo { mod: boolean; alt: boolean; shift: boolean; key: string }

/**
 * The switcher is one binding over nine keys, so it stores a pseudo-key rather
 * than nine entries the picker would list nine times. Only `sessionSwitch` may
 * carry it, and `comboOf` only produces it when asked (`digits: true`) — otherwise
 * recording ⌘⌥3 for something else would silently claim all nine digits.
 */
export const DIGIT_KEY = "digit";

/** Pressed alone these produce no chord; a recorder must keep waiting. */
const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Dead", "Unidentified", "OS", "Fn", "FnLock"]);

/**
 * Characters that only exist *because* Shift is down, folded onto the unshifted
 * key with the flag cleared. Without this, ⌘+ (which is Shift+= on a US layout)
 * would record as `mod+shift+=` and then never match the `mod+=` the font stepper
 * has always used — the shipped handler tested `e.key === "=" || e.key === "+"`
 * for exactly this reason.
 */
const SHIFT_ALIAS: Record<string, string> = { "+": "=", _: "-" };

export interface KeyActionDef {
  id: KeyAction;
  label: string;
  hint?: string;
  /** The chord this ships with, as a canonical string. */
  combo: string;
  /**
   * Consecutive actions sharing this collapse into ONE row in the footer's
   * shortcuts popover — "Terminal font size ⌘+ / ⌘− / ⌘0" reads better than three
   * rows saying the same word. The Settings picker always lists them separately,
   * because there each is a thing you can rebind.
   */
  rowLabel?: string;
}

/**
 * The bindable actions, in the order the footer popover lists them.
 *
 * Escape is not here and must not be: it does not do one thing, it backs out of
 * whichever dialog, overlay or edit form is open, and a user who rebound "Escape"
 * would be rebinding all nine of those at once. Terminal copy/paste is not here
 * either — that lives in xterm's own key handler (`clipboardKeys`), below this
 * layer entirely.
 */
export const KEY_ACTIONS: KeyActionDef[] = [
  { id: "palette",       label: "Command palette",           combo: "mod+k" },
  { id: "sessionSwitch", label: "Switch to session 1–9",     combo: "mod+digit",   hint: "One binding over nine digits. A digit bound elsewhere is carved out; the rest keep working." },
  { id: "terminal",      label: "Open a terminal here",      combo: "mod+t",       hint: "A plain shell, no Claude." },
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

/**
 * The Settings picker's sections. A separate list from KEY_ACTIONS because the
 * footer's reading order and the picker's grouping are different questions — and
 * `key_groups_cover_every_action_exactly_once` in the test suite is what stops a
 * new action being added to the table and never appearing in the picker.
 */
export const KEY_GROUPS: { label: string; actions: KeyAction[] }[] = [
  { label: "Sessions", actions: ["palette", "sessionSwitch", "terminal", "history", "reveal", "files"] },
  { label: "Tasks", actions: ["buildTask", "testTask", "runTask"] },
  { label: "The window", actions: ["sidebar", "inspector", "settings", "fontUp", "fontDown", "fontReset"] },
];

/** Every action's current chord; `null` means the user cleared it. */
export type KeyBinds = Record<KeyAction, Combo | null>;

/**
 * The shortcuts as a whole: the master switch and the chords under it.
 *
 * Two levels of "off", and they answer different questions. Clearing one row
 * (`binds[id] = null`) says *this chord is in my way*; the master switch says *give
 * the keyboard back to the terminal* — the case where you are driving an agent that
 * wants ⌘K, ⌘B and ⌘T for itself and turning off fourteen rows one at a time is not
 * a setting, it is a chore. Off is not destructive: every chord is remembered and
 * comes back exactly as it was.
 *
 * Off does NOT reach Escape (it backs out of whichever dialog is open — never
 * bindable here in the first place) or a terminal pane's own copy/paste, which lives
 * in xterm's handler below this layer. Both keep working, which is what makes this
 * safe to switch off: nothing you need to *undo* it is behind a shortcut.
 */
export interface KeyPrefs { enabled: boolean; binds: KeyBinds }

/**
 * The chord an action answers to *right now* — `null` while the master switch is off.
 *
 * Everything that matches or displays a chord goes through this rather than reading
 * `binds` directly, so "switched off" is expressed once. Reading `binds` at a display
 * site is the bug this prevents: the app would stop responding to ⌘B while the footer
 * sheet, the palette and the sidebar's tooltips all went on advertising it.
 */
export function activeBind(p: KeyPrefs, id: KeyAction): Combo | null {
  return p.enabled ? p.binds[id] : null;
}

// ---------- chords as text ----------

/** Canonical form: modifiers in a fixed order, then the key. `"mod+shift+b"`. */
export function formatCombo(c: Combo): string {
  return `${c.mod ? "mod+" : ""}${c.alt ? "alt+" : ""}${c.shift ? "shift+" : ""}${c.key}`;
}

/**
 * Parse a canonical chord back. Tolerant of order and case so a hand-edited
 * `cc-keys` is usable, strict about the result — anything it cannot make sense of
 * is `null`, and the caller falls back to the default rather than binding junk.
 */
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
  if (c.key !== "enter" && c.key !== DIGIT_KEY && c.key.length !== 1) return null;
  const alias = SHIFT_ALIAS[c.key];
  if (alias) { c.key = alias; c.shift = false; }
  return c;
}

/** What a KeyboardEvent gives us. A duck type, so tests need no DOM. */
export interface KeyLike { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }

/**
 * The chord a keypress represents, or `null` if it isn't one — a bare modifier, or
 * a named key (Escape, Tab, an arrow, an F-key) this layer deliberately refuses to
 * bind. Every path goes through here: recording a chord in Settings and matching
 * one at runtime are the same normalisation, which is what makes the round trip
 * hold even for the awkward keys.
 */
export function comboOf(ev: KeyLike, opts: { digits?: boolean } = {}): Combo | null {
  const raw = ev.key;
  if (!raw || MODIFIER_KEYS.has(raw)) return null;
  let key: string;
  let shift = !!ev.shiftKey;
  if (raw === "Enter") key = "enter";
  else if (raw.length === 1) {
    const alias = SHIFT_ALIAS[raw];
    if (alias) { key = alias; shift = false; } else key = raw.toLowerCase();
  } else return null;
  if (opts.digits && key >= "1" && key <= "9") key = DIGIT_KEY;
  return { mod: !!(ev.metaKey || ev.ctrlKey), alt: !!ev.altKey, shift, key };
}

/** Two normalised chords, field for field. */
export function sameCombo(a: Combo, b: Combo): boolean {
  return a.mod === b.mod && a.alt === b.alt && a.shift === b.shift && a.key === b.key;
}

/** Does this keypress *exactly* match this chord? Every modifier has to agree. */
export function comboMatches(c: Combo | null, ev: KeyLike): boolean {
  if (!c) return false;
  const got = comboOf(ev, { digits: c.key === DIGIT_KEY });
  return !!got && sameCombo(got, c);
}

/**
 * Two chords collide — i.e. binding one has to take the other away.
 *
 * Exact equality, and note what that deliberately does NOT include: `mod+digit` and
 * `mod+3` do not collide. Treating them as a collision was the obvious reading and
 * it is the wrong one — binding ⌘3 to Settings would cost you the other eight
 * switches as well, to carve out one. Instead the literal simply wins for its own
 * digit (`matchAction`'s second pass) and the range keeps the rest.
 */
export function comboClash(a: Combo | null, b: Combo | null): boolean {
  return !!a && !!b && sameCombo(a, b);
}

// ---------- chords on screen ----------

/**
 * A chord as the tokens a `<kbd>` each — `["⌘","⇧","B"]`. The glyphs are the only
 * thing that differs per platform (the matcher accepts both modifiers either way),
 * which is why this takes `isMac` rather than reading `navigator`: it keeps this
 * module importable from vitest's node environment.
 */
export function comboKeys(c: Combo | null, isMac: boolean): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.mod) out.push(isMac ? "⌘" : "Ctrl");
  if (c.alt) out.push(isMac ? "⌥" : "Alt");
  if (c.shift) out.push("⇧");
  out.push(keyGlyph(c.key));
  return out;
}
/** The key half of a chord, as it should read on screen. */
export function keyGlyph(key: string): string {
  if (key === "enter") return "⏎";
  if (key === DIGIT_KEY) return "1–9";
  if (key === "=") return "+";       // it is Shift+= on the keyboard, but "+" is what it does
  if (key === "-") return "−";       // U+2212, so it can't be mistaken for a hyphen in the label
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}
/** One-line form for a title attribute or a toast: `"⌘⇧B"` / `"Ctrl+Shift+B"`. */
export function comboText(c: Combo | null, isMac: boolean): string {
  if (!c) return "";
  const keys = comboKeys(c, isMac);
  return isMac ? keys.join("") : keys.join("+");
}

// ---------- the stored value ----------

export function defaultKeyBinds(): KeyBinds {
  const out = {} as KeyBinds;
  for (const d of KEY_ACTIONS) out[d.id] = parseCombo(d.combo);
  return out;
}

/**
 * Turn whatever `cc-keys` held into a usable map. Same contract as
 * `clampPeekPrefs`/`clampSoundPrefs`: a corrupt, stale or hand-edited value must
 * produce a working app, never an exception and never a shortcut that fires two
 * things at once.
 *
 * Only *overrides* are stored, so an action missing from the blob keeps whatever
 * the default is today — which is how a default can be improved in a later release
 * without every existing install being pinned to the old one. An explicit `""`
 * means the user cleared it.
 *
 * Collisions are resolved in KEY_ACTIONS order, first come first served, and the
 * loser is left unbound rather than silently sharing the chord.
 */
export function clampKeyBinds(raw: unknown): KeyBinds {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as KeyBinds;
  const taken: (Combo | null)[] = [];
  for (const d of KEY_ACTIONS) {
    let combo: Combo | null;
    if (d.id in src) {
      const v = src[d.id];
      // An explicit empty string is "the user cleared this"; anything unparseable
      // is corruption, and falling back to the default beats losing the shortcut.
      combo = v === "" || v === null ? null : parseCombo(v) ?? parseCombo(d.combo);
    } else combo = parseCombo(d.combo);
    // The pseudo-key belongs to the switcher alone (see DIGIT_KEY).
    if (combo && combo.key === DIGIT_KEY && d.id !== "sessionSwitch") combo = parseCombo(d.combo);
    if (combo && !bindableCombo(combo)) combo = parseCombo(d.combo);
    if (combo && taken.some((t) => comboClash(t, combo))) combo = null;
    out[d.id] = combo;
    taken.push(combo);
  }
  return out;
}

/**
 * Is this chord safe to bind app-wide? It needs a modifier — a bare letter would
 * be swallowed from every terminal pane in the app, and the user could not undo it
 * because they could no longer type into Settings either.
 */
export function bindableCombo(c: Combo | null): boolean {
  return !!c && (c.mod || c.alt) && !!c.key;
}

/** Only what differs from the defaults, which is all that is worth persisting. */
export function keyOverrides(binds: KeyBinds): Record<string, string> {
  const dflt = defaultKeyBinds();
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
export function isDefaultKeyBinds(binds: KeyBinds): boolean {
  return Object.keys(keyOverrides(binds)).length === 0;
}

export function defaultKeyPrefs(): KeyPrefs {
  return { enabled: true, binds: defaultKeyBinds() };
}

/**
 * What goes into `cc-keys`: the switch, plus only the rows that differ from their
 * shipped chord. One blob rather than a key each for the same reason `cc-peek` and
 * `cc-sound` are one — the switch and the chords are only ever read together, and a
 * flag that outlived its map is a corruption nobody could diagnose.
 */
export function serializeKeyPrefs(p: KeyPrefs): { enabled: boolean; binds: Record<string, string> } {
  return { enabled: p.enabled, binds: keyOverrides(p.binds) };
}
export function isDefaultKeyPrefs(p: KeyPrefs): boolean {
  return p.enabled && isDefaultKeyBinds(p.binds);
}

/**
 * Read `cc-keys` back. Same contract as `clampPeekPrefs`/`clampSoundPrefs`: whatever
 * is in there, the app comes up with working shortcuts.
 *
 * `enabled` defaults to true on anything but an explicit `false`, so a blob written
 * before the switch existed — or one hand-edited down to just the chords — comes back
 * switched on rather than leaving the user with a dead keyboard and no clue why. The
 * `binds`-less shape is that same blob: the overrides map used to *be* the whole
 * value, so a raw object with no `binds` key is read as one.
 */
export function clampKeyPrefs(raw: unknown): KeyPrefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const nested = o.binds && typeof o.binds === "object" ? o.binds : null;
  const flat = "binds" in o || "enabled" in o ? {} : o;
  return { enabled: o.enabled !== false, binds: clampKeyBinds(nested ?? flat) };
}
/** Whether one row is still on its shipped chord — what greys out its Reset. */
export function isDefaultBind(binds: KeyBinds, id: KeyAction): boolean {
  const cur = binds[id];
  const def = defaultKeyBinds()[id];
  if (!cur || !def) return !cur && !def;
  return formatCombo(cur) === formatCombo(def);
}

// ---------- mutations (pure: new map in, new map out) ----------

/**
 * Bind `id` to `combo`, taking the chord from whoever held it. The displaced
 * action is left unbound rather than swapped or refused — see the module header.
 * Returns the new map plus who lost the chord, so the caller can say so out loud.
 */
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
/** One row back to its shipped chord — which may itself have to take it back. */
export function resetKey(binds: KeyBinds, id: KeyAction): KeyBinds {
  const def = defaultKeyBinds()[id];
  return def ? bindKey(binds, id, def).binds : unbindKey(binds, id);
}

// ---------- what the handler asks ----------

/**
 * Which action this keypress fires, if any.
 *
 * Two passes, and only for the pseudo-key: a literal `mod+3` bound to something
 * else must win over the switcher's `mod+digit`, or the explicit binding would be
 * shadowed by the range one. Everything else is exact, so within a pass the order
 * of the table cannot matter.
 *
 * This runs on **every keydown in the app**, including every character typed into
 * a terminal pane, so it normalises the event once and bails on the first thing
 * that rules a chord out — an unmodified keypress can never be a binding, because
 * `bindableCombo` refuses one.
 */
export function matchAction(p: KeyPrefs, ev: KeyLike): KeyAction | null {
  // The master switch is checked here rather than at the call site so a handler
  // cannot forget it — this is the only door into the shortcut layer.
  if (!p.enabled) return null;
  const plain = comboOf(ev);
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

/** Which digit 1–9 a `sessionSwitch` press names, or 0 if it wasn't one. */
export function digitOf(ev: KeyLike): number {
  const n = Number(ev.key);
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n : 0;
}

/**
 * The footer's shortcuts popover, as data. Unbound actions are dropped — a row
 * reading "Toggle sidebar ‹nothing›" is a cheat sheet lying to you, and with the
 * master switch off that is every row, so it comes back empty — and consecutive
 * actions sharing a `rowLabel` collapse into one row of alternatives.
 */
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
