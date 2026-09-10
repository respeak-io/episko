// Settings search: what a word may match, the @ words that narrow, and why a row appeared.
// Pure, so it is tested; ./settings builds the rows and paints the hits (docs/settings.md).

import { esc } from "./format";

// The palette's rule (every letter, in order), spelled again rather than imported: ./palette
// reads localStorage at module scope, and this module has to stay a leaf.
const letters = (text: string, w: string): boolean => {
  let i = 0; const t = text.toLowerCase();
  for (const ch of w) { i = t.indexOf(ch, i); if (i < 0) return false; i++; }
  return true;
};

export interface SearchRow {
  id: string;
  tab: string; tabLabel: string; group: string; groupLabel: string;
  label: string; hint: string; more?: string; value?: string;
  options?: string[]; lines?: string[]; aliases?: string[]; key?: string;
  changed: boolean; isNew: boolean; mac: boolean;
}
export interface SearchQuery {
  words: string[]; changed: boolean; isNew: boolean; mac: boolean;
  inTab: string | null; key: string | null; unknown: string[];
}
/** The chips under the search box, in this order. */
export const SEARCH_FILTERS = ["@changed", "@new", "@mac"] as const;

export function parseQuery(raw: string): SearchQuery {
  const q: SearchQuery = { words: [], changed: false, isNew: false, mac: false, inTab: null, key: null, unknown: [] };
  for (const t of raw.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (t[0] !== "@") { q.words.push(t); continue; }
    if (t === "@changed" || t === "@modified") q.changed = true;
    else if (t === "@new") q.isNew = true;
    else if (t === "@mac" || t === "@os:mac" || t === "@os:macos") q.mac = true;
    else if (t.startsWith("@in:") && t.length > 4) q.inTab = t.slice(4);
    else if (t.startsWith("@key:") && t.length > 5) q.key = t.slice(5);
    else q.unknown.push(t);
  }
  return q;
}
export const isSearching = (q: SearchQuery): boolean =>
  q.words.length > 0 || q.changed || q.isNew || q.mac || q.inTab !== null || q.key !== null;

export type HitField = "label" | "tab" | "value" | "option" | "alias" | "line" | "key" | "hint" | "more";
export interface SearchHit {
  score: number;
  fuzzy: boolean;                    // no whole-word hit anywhere; the label matched by letters
  why: { word: string; field: HitField; line?: string }[]; // hits the reader cannot see marked
  lines: number[];                   // indexes into `lines` that matched, so the panel opens on them
}

// Weight order is match order: the first field a word is found in is the one reported. A
// panel line sits ahead of the aliases at equal weight, so a hit inside a panel opens it.
const FIELDS: [HitField, (r: SearchRow) => string | string[] | undefined, number][] = [
  ["label", (r) => r.label, 10], ["tab", (r) => `${r.tabLabel} ${r.groupLabel}`, 6], ["value", (r) => r.value, 5],
  ["option", (r) => r.options, 5], ["line", (r) => r.lines, 4], ["alias", (r) => r.aliases, 4], ["key", (r) => r.key, 4],
  ["hint", (r) => r.hint, 3], ["more", (r) => r.more, 2],
];
const has = (text: string | string[] | undefined, w: string): boolean =>
  Array.isArray(text) ? text.some((t) => t.toLowerCase().includes(w)) : !!text && text.toLowerCase().includes(w);

/** Every word must match somewhere (each in any field); the filters must all hold. */
export function matchRow(r: SearchRow, q: SearchQuery): SearchHit | null {
  if (q.changed && !r.changed) return null;
  if (q.isNew && !r.isNew) return null;
  if (q.mac && !r.mac) return null;
  if (q.inTab !== null && ![r.tab, r.tabLabel, r.group, r.groupLabel].some((s) => s.toLowerCase().includes(q.inTab!))) return null;
  if (q.key !== null && !(r.key ?? "").includes(q.key)) return null;
  const hit: SearchHit = { score: 0, fuzzy: false, why: [], lines: [] };
  for (const w of q.words) {
    const f = FIELDS.find(([, get]) => has(get(r), w));
    if (!f) {
      if (!letters(r.label, w)) return null;
      hit.score += 1; hit.fuzzy = true; continue;
    }
    const [field, , weight] = f;
    hit.score += weight + (field === "label" && r.label.toLowerCase().startsWith(w) ? 4 : 0);
    if (field === "option" || field === "alias" || field === "key") hit.why.push({ word: w, field });
    if (field === "line") {
      (r.lines ?? []).forEach((l, i) => { if (l.toLowerCase().includes(w)) { hit.lines.push(i); hit.why.push({ word: w, field, line: l }); } });
    }
  }
  return hit;
}

/** Escapes, then marks every occurrence of every word in one pass, so a mark never nests. */
export function highlight(text: string, words: string[]): string {
  const safe = esc(text);
  const pats = words.filter(Boolean).map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!pats.length) return safe;
  return safe.replace(new RegExp(pats.join("|"), "gi"), (m) => `<mark class="set-hit">${m}</mark>`);
}
