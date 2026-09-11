// The emoji picker's rules: what a query matches and in what order, and the rows the
// virtualised grid paints. ./projmenu owns the panel; nothing here touches the DOM.

import { EMOJI_ALL, EMOJI_GROUPS } from "./emojidata";
import { normEmoji } from "./format";

export type EmCell = { ch: string; name: string };
export type EmRow = { kind: "head"; label: string } | { kind: "grid"; cells: EmCell[] };

export const EM_COLS = 8;
// The two row heights. ./projmenu writes them as inline styles, so CSS cannot drift from them.
export const EM_ROW_H = 32;
export const EM_HEAD_H = 22;

// A starting point, not a catalogue: the everyday project glyphs, ahead of the full set.
const SUGGESTED = [
  "🎙️", "🎧", "🎵", "🎬", "📷", "🎨", "✏️", "📝",
  "🚀", "⚡", "🔥", "✨", "💡", "🧠", "🤖", "👾",
  "🐛", "🔧", "🔨", "⚙️", "🧪", "🔬", "🔭", "🧭",
  "📦", "🗂️", "📚", "📊", "📈", "🧮", "🗄️", "🔐",
  "🌐", "🛰️", "📡", "☁️", "🖥️", "💾", "🕹️", "🧩",
  "🌱", "🌳", "🍀", "🌊", "🏔️", "🌙", "⭐", "🌈",
  "🐙", "🐧", "🐳", "🦀", "🦊", "🐝", "🦉", "🐢",
  "🎯", "🏁", "🏆", "🔔", "⏱️", "📌", "🧵", "🪄",
];

const cellAt = (i: number): EmCell => {
  const s = EMOJI_ALL[i], sp = s.indexOf(" ");
  return { ch: s.slice(0, sp), name: s.slice(sp + 1) };
};
const byChar = new Map(EMOJI_ALL.map((s, i) => [s.slice(0, s.indexOf(" ")), i]));

// Where the Flags group starts, so a font with no regional-indicator glyphs (every Windows
// build so far, where they come out as letter pairs) can be given the list without them.
const flagsAt = EMOJI_GROUPS.find((g) => g[0] === "Flags")?.[1] ?? EMOJI_ALL.length;

function chunk(cells: EmCell[], cols: number): EmRow[] {
  const out: EmRow[] = [];
  for (let i = 0; i < cells.length; i += cols) out.push({ kind: "grid", cells: cells.slice(i, i + cols) });
  return out;
}

// Lower is better: a whole-name hit, then a name that starts with the query, then one whose
// word does, then anywhere. Ties go to the shorter name, then to Unicode's own order.
function score(name: string, q: string): number {
  const at = name.indexOf(q);
  if (at < 0) return -1;
  if (name === q) return 0;
  if (at === 0) return 1;
  return name[at - 1] === " " ? 2 : 3;
}

export function emojiRows(query: string, opts: { cols?: number; flags?: boolean } = {}): EmRow[] {
  const cols = opts.cols ?? EM_COLS;
  const last = opts.flags === false ? flagsAt : EMOJI_ALL.length;
  const q = query.trim().toLowerCase();
  const lit = normEmoji(query);
  // A pasted emoji is the answer, not a search for its name — including one the list omits
  // (a skin tone, a family) and, when nothing else matched, a typed `:)`.
  if (lit && /[^\x20-\x7e]/.test(lit)) return [{ kind: "grid", cells: [{ ch: lit, name: lit }] }];

  if (!q) {
    const rows: EmRow[] = [{ kind: "head", label: "Suggested" }];
    rows.push(...chunk(SUGGESTED.map((ch) => cellAt(byChar.get(ch)!)), cols));
    for (const [label, start] of EMOJI_GROUPS) {
      if (start >= last) break;
      const end = EMOJI_GROUPS.find((g) => g[1] > start)?.[1] ?? last;
      rows.push({ kind: "head", label });
      rows.push(...chunk(Array.from({ length: Math.min(end, last) - start }, (_, k) => cellAt(start + k)), cols));
    }
    return rows;
  }

  const hits: { i: number; s: number; len: number }[] = [];
  for (let i = 0; i < last; i++) {
    const s = score(EMOJI_ALL[i].slice(EMOJI_ALL[i].indexOf(" ") + 1), q);
    if (s >= 0) hits.push({ i, s, len: EMOJI_ALL[i].length });
  }
  hits.sort((a, b) => a.s - b.s || a.len - b.len || a.i - b.i);
  if (!hits.length) return lit ? [{ kind: "grid", cells: [{ ch: lit, name: lit }] }] : [];
  return chunk(hits.map((h) => cellAt(h.i)), cols);
}

// Which rows the scroller has to paint, and the spacer either side of them — padding rather
// than a positioned window, so an empty list is still just a box with a line in it.
// `over` keeps a row either side mounted, so a wheel notch lands on markup that already exists.
export function rowWindow(rows: readonly EmRow[], scrollTop: number, viewH: number, over = 2) {
  const h = (r: EmRow) => (r.kind === "head" ? EM_HEAD_H : EM_ROW_H);
  const tops: number[] = [];
  let y = 0;
  for (const r of rows) { tops.push(y); y += h(r); }
  let first = 0;
  while (first < rows.length && tops[first] + h(rows[first]) <= scrollTop) first++;
  const start = Math.max(0, first - over);
  let i = start, bottom = tops[start] ?? y;
  while (i < rows.length && bottom < scrollTop + viewH) { bottom += h(rows[i]); i++; }
  const end = Math.min(rows.length, i + over);
  const padTop = tops[start] ?? y;
  const painted = end > start ? tops[end - 1] + h(rows[end - 1]) - padTop : 0;
  return { start, end, padTop, padBottom: y - padTop - painted, total: y };
}
