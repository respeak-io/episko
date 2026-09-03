// What in a pane's output is worth a click, and what to try opening. Pure string work; the
// buffer walk and the OS handoff are ./terminal's. A path is proposed, never matched: disk decides.

export interface UrlHit { kind: "url"; text: string; start: number; end: number }
export interface PathCand { text: string; end: number } // end: where the underline stops if it wins
export interface PathHit { kind: "path"; start: number; cands: PathCand[] } // longest first
export type LinkHit = UrlHit | PathHit;

const MAX_WORDS = 5; // words a path may reach past its first token; more swallows a sentence
const MAX_CANDS = 24; // must still reach the last entry: the bare token, the usual winner
const MAX_GAP = 60; // a wider gap is a table column, not a wrapped path

const OPENER = /[\s([{<"'`*=,|]/; // may sit right before a path without being part of it
// Sentence punctuation; stripped as a variant, not unconditionally, since a directory can end in `)`.
const TRAIL = /[.,;:!?)\]}>"'`*»]+$/;
const LINE_SUFFIX = /:\d+(:\d+)?$/;
// A printed `\n` (printf, JSON, a stack trace) sits inside one token; the path is the part before it.
const ESCAPE = /\\[nrt]/;
// Never extended across spaces: a spaced filename with no directory reads as two words.
const BARE_FILE = /^[\w][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`*|\\^{}]+/g;

const count = (s: string, ch: string) => s.split(ch).length - 1;

// Trailing punctuation is never part of a URL; a closing bracket only is if the URL opened one.
export function trimUrl(u: string): string {
  let s = u.replace(/[.,;:!?'"«»_]+$/, "");
  while (s.endsWith(")") && count(s, "(") < count(s, ")")) s = s.slice(0, -1);
  while (s.endsWith("]") && count(s, "[") < count(s, "]")) s = s.slice(0, -1);
  return s;
}

function pathish(t: string): boolean {
  if (t.length < 2 || t.startsWith("-") || SCHEME.test(t)) return false;
  if (/^(~|\.{1,2})?\//.test(t)) return true;        // /abs, ~/, ./, ../
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;        // C:\ or C:/
  if (/^[^\s/\\]+[/\\][^\s]/.test(t)) return true;   // a/b — a relative path
  return BARE_FILE.test(t);
}

// One start's proposals, longest first: the backend's first hit is then the most specific thing that exists.
function candidates(line: string, start: number, tok: string): PathCand[] {
  const raws: PathCand[] = [];
  let end = start + tok.length;
  // One space whatever the gap: a path wrapped across rows arrives with the row's padding.
  const parts = [tok];
  raws.push({ text: tok, end });
  if (/[/\\]/.test(tok.replace(TRAIL, ""))) {
    for (let n = 0; n < MAX_WORDS; n++) {
      const m = /^(\s+)([^\s<>|"`*?\u2500-\u257f]+)/.exec(line.slice(end));
      if (!m || m[1].length > MAX_GAP) break;
      parts.push(m[2]);
      end += m[0].length;
      raws.push({ text: parts.join(" "), end });
    }
  }
  const out: PathCand[] = [];
  const seen = new Set<string>();
  const add = (text: string, end: number) => {
    if (!text || seen.has(text) || !/[A-Za-z0-9]/.test(text)) return;
    seen.add(text);
    out.push({ text, end });
  };
  // Every reading is a PREFIX of the raw text, so the underline's end is recovered by arithmetic.
  const readings = (t: string): string[] => {
    const seq = [t];
    const push = (v: string) => { if (v !== seq[seq.length - 1]) seq.push(v); };
    push(t.replace(TRAIL, ""));
    push(seq[seq.length - 1].split(ESCAPE)[0]);
    push(seq[seq.length - 1].replace(TRAIL, ""));   // the escape may expose new punctuation
    push(seq[seq.length - 1].replace(LINE_SUFFIX, ""));
    return seq;
  };
  for (let i = raws.length - 1; i >= 0; i--) {
    const r = raws[i];
    for (const v of readings(r.text)) add(v, r.end - (r.text.length - v.length));
  }
  // Trimmed from the FRONT: `out` is longest-first, so slicing the tail would drop the bare
  // token — the usual winner — on a line with enough readings to reach the cap.
  return out.length > MAX_CANDS ? out.slice(out.length - MAX_CANDS) : out;
}

// URLs first, then one proposal per path-shaped token. Proposals may overlap; which candidate
// wins is disk's answer, so ./terminal drops the clash once it knows rather than this guessing.
export function findLinks(line: string): LinkHit[] {
  const hits: LinkHit[] = [];
  const spans: [number, number][] = [];
  for (const m of line.matchAll(URL_RE)) {
    const text = trimUrl(m[0]);
    if (!text) continue;
    const start = m.index;
    hits.push({ kind: "url", text, start, end: start + text.length });
    spans.push([start, start + text.length]);
  }
  const inUrl = (i: number) => spans.some(([a, b]) => i >= a && i < b);
  let i = 0;
  while (i < line.length) {
    // A path may follow an opener but never start with one, or a backticked path carries the backtick.
    if ((i === 0 || OPENER.test(line[i - 1])) && !OPENER.test(line[i]) && !inUrl(i)) {
      const tok = /^\S+/.exec(line.slice(i))?.[0] ?? "";
      if (tok && pathish(tok.replace(TRAIL, ""))) {
        const cands = candidates(line, i, tok);
        if (cands.length) {
          hits.push({ kind: "path", start: i, cands });
          i += tok.length; // past the token, not the longest candidate
          continue;
        }
      }
    }
    i++;
  }
  return hits;
}

// Bases for a relative path, best first: `dirs` (most authoritative first), then the ancestors
// of every touched path, deepest first, since an agent prints a path against a root it never ran
// in. Stops two components below `/`: `/` and `/Users` would resolve everything and say nothing.
export function linkBases(dirs: string[], touched: string[], max = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (d: string) => {
    if (!d || seen.has(d)) return;
    seen.add(d);
    out.push(d);
  };
  for (const d of dirs) add(d);
  const anc = new Set<string>();
  for (const p of touched) {
    const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
    for (let n = parts.length - 1; n >= 3; n--) anc.add(parts.slice(0, n).join("/"));
  }
  for (const d of [...anc].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    if (out.length >= max) break;
    add(d);
  }
  return out.slice(0, max);
}
