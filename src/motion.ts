// Which visual effects the app is allowed to spend a GPU on — the model behind
// Settings › Appearance › Visual effects.
//
// Episko is a fleet watcher: the window sits open all day, often behind an editor,
// often with nothing happening in it. Three things in the chrome cost a GPU frame
// whether or not anything moved, and on Windows they cost noticeably more than on the
// Mac this was designed on — WebView2 composites through DComp/D3D11 at the monitor's
// refresh rate, and a Windows desktop is routinely 144Hz or better where a MacBook is
// 60. The same stylesheet is therefore two-and-a-half times the work per second on the
// machines that have complained about it.
//
// What is switchable, and why each is a separate switch rather than one "performance
// mode": they fail differently. Animation is *information* here (a pulsing glyph is how
// a busy session is told from a finished one at a glance in the rail), so somebody may
// want to keep it and lose the blur. Blur is decoration only, so it is the first thing
// most people will turn off and it costs nothing to lose. And the background pause is
// neither — it is a straight win nobody trades anything for, which is why it defaults on
// and is listed last.
//
// Pure logic, no DOM and no Tauri: the table, the store, its repair, and the class list
// the root element wants. The applying is ./actions' (`applyFx`), on the same split as
// ./footprefs and ./projgroups.

/// A switchable effect. The order here is the order Settings lists them in.
export type VisualFx = "motion" | "blur" | "idle";

export interface VisualFxDef {
  id: VisualFx;
  /// The class `applyFx` puts on `<html>` when this effect is switched **off**. One
  /// place joins the id to the stylesheet, so a rename cannot half-land.
  cls: string;
  label: string;
  hint: string;
}

export const VISUAL_FX: readonly VisualFxDef[] = [
  {
    id: "motion", cls: "fx-still", label: "Animations",
    hint: "The pulsing rail glyphs, the inspector's heartbeat, the loading shimmers and the panel fades. Switching this off is what the OS's own reduce-motion setting already does — Episko follows that too, so if you have set it system-wide this row is already answered.",
  },
  {
    id: "blur", cls: "fx-flat", label: "Background blur",
    hint: "The frosted glass behind dialogs, popovers and the command palette. Decoration only: with it off the same panels get a solid background, which is cheaper to composite and identical to read.",
  },
  {
    id: "idle", cls: "fx-idle", label: "Keep animating in the background",
    hint: "Off, Episko stops animating the moment the window loses focus and picks up again when you come back — nothing is lost, since an animation you cannot see is telling you nothing. Leave it off unless you keep the window visible beside something else and want the rail moving while you work there.",
  },
];

const IDS = new Set<string>(VISUAL_FX.map((f) => f.id));

/// What is switched **off**, rather than what is on.
///
/// Same reasoning as ./footprefs' `hidden`: an effect added in a later version cannot
/// appear in a list written before it existed, so it arrives switched on, which is the
/// right answer for a new thing nobody has opted out of yet. A record of booleans would
/// hand every existing user `undefined` for it and force a `?? true` at each read — one
/// that is easy to leave out at exactly one of them.
///
/// `idle` is the one whose *plain English* runs the other way ("keep animating in the
/// background" is the expensive answer), and it is worded that way deliberately so the
/// store stays uniform: in this list, present means off means cheap, for all three.
export interface MotionPrefs { off: VisualFx[] }

export const DEFAULT_MOTION: MotionPrefs = { off: ["idle"] };

/// Read the stored value, keeping only ids this build knows.
///
/// An unknown id is dropped rather than carried: it would otherwise ride along forever,
/// and an effect that is *renamed* would come back switched off for everyone who had
/// turned its predecessor off. Anything unparseable falls back to the defaults, which is
/// a state you can see and fix rather than a blank one you cannot.
///
/// A **first run** (`raw === null`) is not the same as an empty stored list: it takes
/// `DEFAULT_MOTION`, which pauses in the background. Someone who has explicitly switched
/// that on has `{ off: [] }` on disk, and must not be quietly re-defaulted at every start.
export function parseMotionPrefs(raw: string | null): MotionPrefs {
  if (raw === null) return { off: [...DEFAULT_MOTION.off] };
  try {
    const v = JSON.parse(raw) as { off?: unknown };
    if (!Array.isArray(v.off)) return { off: [...DEFAULT_MOTION.off] };
    const off = v.off.filter((x): x is VisualFx => typeof x === "string" && IDS.has(x));
    return { off: [...new Set(off)] };
  } catch {
    return { off: [...DEFAULT_MOTION.off] };
  }
}

export function motionPrefsJson(p: MotionPrefs): string {
  return JSON.stringify({ off: p.off });
}

/// Is this effect on? The one predicate every reader goes through.
export function fxOn(p: MotionPrefs, id: VisualFx): boolean {
  return !p.off.includes(id);
}

/// Flip one effect, returning a new value — the store is replaced, never mutated, so a
/// caller cannot accidentally skip the persist by having already changed what it holds.
export function toggleFx(p: MotionPrefs, id: VisualFx): MotionPrefs {
  if (!IDS.has(id)) return p;
  return fxOn(p, id) ? { off: [...p.off, id] } : { off: p.off.filter((x) => x !== id) };
}

/// The classes `<html>` should carry, given the prefs and whether the window has focus.
///
/// Returned as a list rather than applied here because this module owns no DOM — and
/// because returning it is what lets a test state the whole truth table in one place.
///
/// `fx-idle` is the one that is not a straight read of the store: it means "animation is
/// suppressed *right now* because you are looking at something else", so it depends on
/// focus as well as the pref. It is deliberately independent of `fx-still` rather than
/// folded into it — the two answer different questions ("never animate" vs. "not while
/// you are away"), and the stylesheet pauses for one and cancels for the other, because
/// a paused animation resumes mid-cycle where a cancelled one restarts.
export function rootFxClasses(p: MotionPrefs, focused: boolean): string[] {
  const out: string[] = [];
  if (!fxOn(p, "motion")) out.push("fx-still");
  if (!fxOn(p, "blur")) out.push("fx-flat");
  if (!fxOn(p, "idle") && !focused) out.push("fx-idle");
  return out;
}

/// Every class this module can ever put on the root, so `applyFx` can clear the ones it
/// is not setting without knowing which those are. Deriving it from the same table the
/// setter reads is what keeps "add an effect" a one-line change.
export const ALL_FX_CLASSES: readonly string[] = [...VISUAL_FX.map((f) => f.cls)];
