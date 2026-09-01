// Which status-bar segments show (Settings › Footer). The repo link, version and What's-new have
// no switch: the bar can never become an empty strip, and the version is how you learn of an update.

// Settings lists them in this order; the bar's own order is fixed in index.html.
export type FootSeg = "sessions" | "cost" | "limits" | "io" | "engine" | "shortcuts" | "debug";

export interface FootSegDef {
  id: FootSeg;
  el: string; // the element the footer hides
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

// Stores the hidden set, so a segment added later shows by default for existing users.
export interface FootPrefs { hidden: FootSeg[] }

export const DEFAULT_FOOT: FootPrefs = { hidden: [] };

// Unknown ids are dropped: a renamed segment must not come back hidden for whoever hid its predecessor.
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

// Returns a new object so a caller cannot half-apply a change it then fails to persist.
export function toggleFootSeg(p: FootPrefs, id: FootSeg): FootPrefs {
  return footShown(p, id)
    ? { hidden: [...p.hidden, id] }
    : { hidden: p.hidden.filter((x) => x !== id) };
}

export function footHiddenCount(p: FootPrefs): number { return p.hidden.filter((id) => IDS.has(id)).length; }
