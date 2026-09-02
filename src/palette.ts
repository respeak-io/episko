// The ⌘K palette's ranking: the prefix that scopes a query, the fuzzy match that scores
// a row, and the frecency that breaks ties. No DOM; ./palui builds and paints the groups.

import type { Sess } from "./types";
import { readObj } from "./store";
import { esc } from "./format";

export interface PalItem {
  kind: "session" | "launch" | "command" | "action" | "task" | "fallback";
  key: string;                 // stable key for frecency (commands/launches)
  label: string; labelHtml: string; sub?: string;
  sw?: string; icon?: string; glyph?: string;
  shortcut?: string[];         // right-aligned kbd hint, e.g. ["⌘","1"]
  session?: Sess;              // present on session rows → enables the ⌘K action panel
  score?: number;
  run: () => void;
}

// Frecency: recency × frequency with a ~30-day half-life, for stable command/launch keys.
export const frecency: Record<string, { n: number; t: number }> = readObj<{ n: number; t: number }>("cc-frecency");
export function frecScore(key: string): number { const f = frecency[key]; return f ? f.n * Math.pow(0.5, (Date.now() - f.t) / 2592000000) : 0; }
export function bumpFrec(key: string) { if (!key || key.startsWith("session:")) return; const f = frecency[key] || { n: 0, t: 0 }; f.n++; f.t = Date.now(); frecency[key] = f; localStorage.setItem("cc-frecency", JSON.stringify(frecency)); }
// A deletion rather than a hidden flag: using the thing again earns the row back.
export function forgetFrec(key: string) {
  if (!(key in frecency)) return;
  delete frecency[key];
  localStorage.setItem("cc-frecency", JSON.stringify(frecency));
}

// Subsequence match; null = no match, higher = better (contiguous runs and word starts score up).
export function fuzzy(text: string, q: string): { score: number; html: string } | null {
  if (!q) return { score: 0, html: esc(text) };
  const tl = text.toLowerCase(), ql = q.toLowerCase();
  const hit: number[] = []; let ti = 0, score = 0, run = 0;
  for (const c of ql) {
    let found = -1;
    for (let k = ti; k < tl.length; k++) if (tl[k] === c) { found = k; break; }
    if (found === -1) return null;
    // Backslash too: subtitles carry native paths, so on Windows no segment would be a word start.
    const boundary = found === 0 || /[\s/\\·._-]/.test(text[found - 1]);
    run = found === ti ? run + 1 : 1;
    score += 1 + run + (boundary ? 4 : 0) - found * 0.02;
    hit.push(found); ti = found + 1;
  }
  const set = new Set(hit); let html = "";
  for (let k = 0; k < text.length; k++) html += set.has(k) ? `<b class="hit">${esc(text[k])}</b>` : esc(text[k]);
  return { score, html };
}
// Match the label, falling back to the sub (unhighlighted) so a path/status still filters.
export function scoreItem(it: PalItem, term: string): PalItem | null {
  const m = fuzzy(it.label, term);
  if (m) return { ...it, labelHtml: m.html, score: m.score };
  if (term && it.sub) { const s = fuzzy(it.sub, term); if (s) return { ...it, labelHtml: esc(it.label), score: s.score - 2 }; }
  return null;
}
export function parsePal(raw: string): { mode: "all" | "cmd" | "sess" | "filter"; term: string } {
  const s = raw.replace(/^\s+/, "");
  if (s[0] === ">" || s[0] === "⟩") return { mode: "cmd", term: s.slice(1).trim() };
  if (s[0] === "@") return { mode: "sess", term: s.slice(1).trim() };
  if (s[0] === "/") return { mode: "filter", term: s.slice(1).trim() };
  return { mode: "all", term: s.trim() };
}
