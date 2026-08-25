// Which segments the status bar shows — the model behind Settings › Footer.
//
// The bar had grown to six segments plus the debug button, and the disk-I/O figures
// moving down from the inspector made it seven. Not everyone wants all of them: a
// machine that never approaches a usage limit has no use for the limits readout, and
// somebody who only ever launches embedded sessions is reading "new in embedded"
// forever. So they are individually switchable.
//
// **Three are not, and that is what makes the rest safe to switch off**: the repo link,
// the version number and the What's-new button always stay. Between them the bar can
// never become an empty strip you cannot get back — and the version is how you find out
// there is an update, which is not a thing to let someone hide by accident.
//
// Pure logic, no DOM and no Tauri: the store, its repair, and every mutation of it,
// on the same pattern as ./projgroups.

/// A switchable segment. The order here is the order Settings lists them in; the *bar's*
/// order is fixed in index.html, because these are markup, not data.
export type FootSeg = "sessions" | "cost" | "limits" | "io" | "engine" | "shortcuts" | "debug";

export interface FootSegDef {
  id: FootSeg;
  /// The element the footer hides, so there is exactly one place the two are joined.
  el: string;
  label: string;
  hint: string;
}

export const FOOT_SEGS: readonly FootSegDef[] = [
  { id: "sessions", el: "fSessionsSeg", label: "Session count", hint: "How many panes are open." },
  { id: "cost", el: "fCostSeg", label: "Today's spend", hint: "What today has cost so far; opens the split by project and session." },
  { id: "limits", el: "fUsageSeg", label: "Usage limits", hint: "The 5-hour and 7-day windows, with a forecast and a countdown to each reset." },
  { id: "io", el: "fIoSeg", label: "Disk I/O", hint: "What today's embedded sessions have read and written; opens the live rates and every window recorded." },
  { id: "engine", el: "fEngineSeg", label: "Where new sessions open", hint: "The launch engine, and the picker for it." },
  { id: "shortcuts", el: "fShortSeg", label: "Shortcuts", hint: "The keyboard cheat sheet." },
  { id: "debug", el: "dbgBtn", label: "Debug console", hint: "The 🐞 button: the in-app event log and live state." },
];

const IDS = new Set<string>(FOOT_SEGS.map((s) => s.id));

/// What is switched **off**, rather than what is on.
///
/// Storing the hidden ones is what makes a segment added later appear by default: it
/// cannot be in a list written before it existed, so it is shown, which is the right
/// answer for a new feature nobody has opted out of yet. A record of booleans would
/// instead give every existing user `undefined` for it and force a `?? true` at each
/// read — one that is easy to leave out at exactly one of them.
export interface FootPrefs { hidden: FootSeg[] }

export const DEFAULT_FOOT: FootPrefs = { hidden: [] };

/// Read the stored value, keeping only ids this build knows.
///
/// An unknown id is dropped rather than kept: it would otherwise ride along forever,
/// and — worse — a segment that is *renamed* would come back switched off for everyone
/// who had hidden its predecessor. Anything unparseable falls back to showing
/// everything, which is the state you can see and fix.
export function parseFootPrefs(raw: string | null): FootPrefs {
  if (!raw) return { hidden: [] };
  try {
    const v = JSON.parse(raw);
    const list: unknown[] = Array.isArray(v) ? v : Array.isArray(v?.hidden) ? v.hidden : [];
    const hidden = list.filter((x): x is FootSeg => typeof x === "string" && IDS.has(x));
    return { hidden: [...new Set(hidden)] };
  } catch { return { hidden: [] }; }
}

export function footPrefsJson(p: FootPrefs): string { return JSON.stringify({ hidden: p.hidden }); }

export function footShown(p: FootPrefs, id: FootSeg): boolean { return !p.hidden.includes(id); }

/// Flip one segment. Returns a new object rather than mutating, so a caller cannot
/// half-apply a change it then fails to persist.
export function toggleFootSeg(p: FootPrefs, id: FootSeg): FootPrefs {
  return footShown(p, id)
    ? { hidden: [...p.hidden, id] }
    : { hidden: p.hidden.filter((x) => x !== id) };
}

/// How many segments are switched off, for the Settings tab's own summary line.
export function footHiddenCount(p: FootPrefs): number { return p.hidden.filter((id) => IDS.has(id)).length; }
