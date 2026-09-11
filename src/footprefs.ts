// Which status-bar segments show (Settings › Status bar). The repo link, version and What's-new have
// no switch: the bar can never become an empty strip, and the version is how you learn of an update.

// Settings lists them in this order; the bar's own order is fixed in index.html.
export type FootSeg = "env" | "sessions" | "cost" | "limits" | "io" | "engine" | "shortcuts" | "debug";

export interface FootSegDef {
  id: FootSeg;
  el: string; // the element the footer hides
  label: string;
  hint: string;      // the one sentence on the page
  more?: string;     // the why, folded
  aliases?: string[];
}

export const FOOT_SEGS: readonly FootSegDef[] = [
  { id: "env", el: "fEnvSeg", label: "Environment", hint: "Which .env the checkout on stage is pointed at, with a picker to switch it.", more: "The stage header can carry the same chip; that half is in Settings › Environments.", aliases: ["env", "dotenv", "prod", "production", "preset"] },
  { id: "sessions", el: "fSessionsSeg", label: "Session count", hint: "How many panes are open." },
  { id: "cost", el: "fCostSeg", label: "Today's spend", hint: "What today has cost so far.", more: "Click it for the split by project and session.", aliases: ["money", "cost", "dollars"] },
  { id: "limits", el: "fUsageSeg", label: "Usage limits", hint: "The 5-hour and 7-day windows, each with a forecast and a countdown.", aliases: ["rate limit", "quota", "forecast", "window"] },
  { id: "io", el: "fIoSeg", label: "Disk I/O", hint: "What today's sessions have read and written.", more: "Click it for the live rates and every window on record.", aliases: ["disk", "read", "write"] },
  { id: "engine", el: "fEngineSeg", label: "Where new sessions open", hint: "The launch engine, with a picker to change it.", aliases: ["engine", "embedded"] },
  { id: "shortcuts", el: "fShortSeg", label: "Shortcuts", hint: "The keyboard cheat sheet.", aliases: ["cheat sheet", "keys"] },
  { id: "debug", el: "dbgBtn", label: "Debug console", hint: "The 🐞 button: the event log and live state.", aliases: ["bug", "log", "events"] },
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

// No re-filter: `hidden` only ever comes from `parseFootPrefs` (which drops what IDS lacks)
// or `toggleFootSeg` (whose `id` is a `FootSeg`).
export function footHiddenCount(p: FootPrefs): number { return p.hidden.length; }
