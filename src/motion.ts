// Which visual effects may cost a GPU frame (Settings › Appearance): the table, the store,
// and the classes <html> carries; ./actions' applyFx applies them. Separate switches
// because animation is information, blur is decoration, and the pause costs nothing.

export type VisualFx = "motion" | "blur" | "idle";

export interface VisualFxDef {
  id: VisualFx;
  cls: string; // put on <html> by applyFx when the effect is OFF
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
