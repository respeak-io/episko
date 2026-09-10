// Which visual effects may cost a GPU frame (Settings › Appearance): the table, the store,
// and the classes <html> carries; ./actions' applyFx applies them. Separate switches
// because animation is information, blur is decoration, and the pause costs nothing.

export type VisualFx = "motion" | "blur" | "idle";

export interface VisualFxDef {
  id: VisualFx;
  cls: string; // put on <html> by applyFx when the effect is OFF
  label: string;
  hint: string;   // the one sentence on the page
  more: string;   // the why, folded
  aliases: string[];
}

export const VISUAL_FX: readonly VisualFxDef[] = [
  {
    id: "motion", cls: "fx-still", label: "Animations",
    hint: "The pulsing glyphs, the heartbeat, the shimmers and the fades.",
    more: "Off does what the OS's reduce-motion setting does, and Episko follows that too, so a system-wide choice has already answered this row. The four animations that carry a state switch to a still form; nothing goes missing.",
    aliases: ["motion", "reduce motion", "transitions", "pulse", "gpu"],
  },
  {
    id: "blur", cls: "fx-flat", label: "Background blur",
    hint: "The frosted glass behind dialogs, popovers and the palette.",
    more: "Decoration only. Off, the same panels get a solid background, cheaper to draw and identical to read.",
    aliases: ["frosted", "glass", "backdrop", "gpu"],
  },
  {
    id: "idle", cls: "fx-idle", label: "Keep animating in the background",
    hint: "Keep the rail moving while another app is in front.",
    more: "Off, everything pauses the moment the window loses focus and resumes when you come back; an animation you cannot see tells you nothing. On is for a window kept visible beside your other work.",
    aliases: ["pause", "unfocused", "battery", "background"],
  },
];

const IDS = new Set<string>(VISUAL_FX.map((f) => f.id));

// Stores what is OFF, so an effect added later arrives switched on (as ./footprefs'
// `hidden` does). `idle` is worded so that present means off means cheap for all three.
export interface MotionPrefs { off: VisualFx[] }

export const DEFAULT_MOTION: MotionPrefs = { off: ["idle"] };

// A first run (null) takes the defaults; an explicit `{ off: [] }` on disk must not be re-defaulted.
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

export function fxOn(p: MotionPrefs, id: VisualFx): boolean {
  return !p.off.includes(id);
}

export function toggleFx(p: MotionPrefs, id: VisualFx): MotionPrefs {
  if (!IDS.has(id)) return p;
  return fxOn(p, id) ? { off: [...p.off, id] } : { off: p.off.filter((x) => x !== id) };
}

// `fx-idle` stays separate from `fx-still`: the stylesheet pauses for one and cancels for the other.
export function rootFxClasses(p: MotionPrefs, focused: boolean): string[] {
  const out: string[] = [];
  if (!fxOn(p, "motion")) out.push("fx-still");
  if (!fxOn(p, "blur")) out.push("fx-flat");
  if (!fxOn(p, "idle") && !focused) out.push("fx-idle");
  return out;
}

// Everything this module can put on the root, so applyFx can clear what it isn't setting.
export const ALL_FX_CLASSES: readonly string[] = [...VISUAL_FX.map((f) => f.cls)];
