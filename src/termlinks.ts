// What in a terminal's output is worth making clickable, and what exactly to try
// opening. Pure string work: the buffer walk, the IPC and the OS handoff are
// ./terminal's, so this half can be tested and that half cannot.
//
// Two kinds of thing earn a click, and they are not symmetrical.
//
//   · A **URL** is self-describing. `https://…` up to the next space is the whole
//     answer, and the only judgement left is where the address ends and the
//     sentence's punctuation begins.
//   · A **path** is a guess, three times over. It is relative more often than not;
//     the directory it is relative to is frequently *not* the pane's cwd (an agent
//     prints the path a human would recognise, not one `cd` would accept); and in
//     any tree a person organised rather than a compiler, it contains spaces —
//     which is the exact character every other token boundary in a terminal is
//     made of.
//
// So a path is never *matched*, it is **proposed**: one start position yields an
// ordered list of candidates, longest first, and the backend answers which of them
// exists on disk (`resolve_link_path`). Nothing is underlined until disk says yes.
//
// That check is what makes the rest of this file allowed to be greedy. Over-reaching
// a candidate by one word, joining across a line break Claude put there itself,
// swallowing a trailing bracket — each is free, because a wrong guess does not
// resolve and so never appears. The rule health.ts states one level up applies here
// too: a rule that fires on ordinary prose is worse than no rule, and the only thing
// keeping this one off ordinary German prose is that `Kurzfassung:` is not a file.

/// A web address, matched exactly — no proposal needed.
export interface UrlHit { kind: "url"; text: string; start: number; end: number }
/// One thing to try opening, and where the underline would end if it wins.
export interface PathCand { text: string; end: number }
/// A path-shaped start and everything it might turn out to be, longest first.
export interface PathHit { kind: "path"; start: number; cands: PathCand[] }
export type LinkHit = UrlHit | PathHit;

/// How many words past the first token a path may reach. Five covers
/// `BA Reinickendorf/2_Kickoff_2026-09-03/…` and every folder name a person types;
/// beyond that a candidate is swallowing a sentence, and the cost is real (each word
/// multiplies the probe list the backend walks).
const MAX_WORDS = 5;
/// The ceiling on one start's proposal list. Bounds the backend's probe budget, which
/// must stay wide enough to reach the LAST entry — the bare token is the shortest
/// reading and the one that usually wins, so a cap that truncates the tail is the same
/// bug as no proposal at all.
const MAX_CANDS = 24;
/// A gap wider than this is a table column, not a wrapped path.
const MAX_GAP = 60;

// What may sit immediately before a path and not be part of it. `(` and the quotes
// are prose; `*` and the backtick are how an agent emphasises a filename; `=` and `,`
// are how a flag or a list carries one.
const OPENER = /[\s([{<"'`*=,|]/;
// Sentence punctuation a path never actually ends in. Stripped as a *variant* rather
// than unconditionally, because a directory really can end in `)` and disk decides.
const TRAIL = /[.,;:!?)\]}>"'`*»]+$/;
// `src/main.ts:944` — the editor convention, and the commonest thing an agent prints.
const LINE_SUFFIX = /:\d+(:\d+)?$/;
// An escape an agent printed rather than typed: `printf 'src/main.ts\nline ref'` puts
// `src/main.ts\nline` in the output as ONE whitespace-delimited token, and the same
// shape arrives from a JSON string, a stack trace and any quoted shell snippet. The
// path is the part before it.
const ESCAPE = /\\[nrt]/;
// A bare filename with an extension: `package.json`, `CLAUDE.md`, `kickoff.pdf`.
// Never extended across spaces — a filename with no directory and a space in it is
// indistinguishable from two words, and would put a proposal on half the output.
const BARE_FILE = /^[\w][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
// A scheme, so a URL already handled above is not re-proposed as a relative path.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`*|\\^{}]+/g;

const count = (s: string, ch: string) => s.split(ch).length - 1;

/// Where a URL stops. Trailing sentence punctuation is never part of it, and a
/// closing bracket is only part of it if the URL opened one — `(see https://x.dev/a)`
/// and `https://x.dev/a_(b)` are both ordinary and want opposite answers.
export function trimUrl(u: string): string {
  let s = u.replace(/[.,;:!?'"«»_]+$/, "");
  while (s.endsWith(")") && count(s, "(") < count(s, ")")) s = s.slice(0, -1);
  while (s.endsWith("]") && count(s, "[") < count(s, "]")) s = s.slice(0, -1);
  return s;
}

/// Could this token be a path? Asked of the token with its sentence punctuation
/// already stripped, so `(src/foo.ts)` arrives here as `src/foo.ts`.
function pathish(t: string): boolean {
  if (t.length < 2 || t.startsWith("-") || SCHEME.test(t)) return false;
  if (/^(~|\.{1,2})?\//.test(t)) return true;        // /abs, ~/, ./, ../
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;        // C:\ or C:/
  if (/^[^\s/\\]+[/\\][^\s]/.test(t)) return true;   // a/b — a relative path
  return BARE_FILE.test(t);
}

/// The proposals for one start: the bare token, then the token plus each following
/// word, and for each of those the variants with trailing punctuation and an
/// editor's `:line:col` removed. Ordered longest first, which is what makes
/// "first hit wins" on the backend mean "the most specific thing that exists".
function candidates(line: string, start: number, tok: string): PathCand[] {
  const raws: PathCand[] = [];
  let end = start + tok.length;
  // The words are joined with a SINGLE space whatever the gap was, because the gap
  // is often a row's trailing padding: a path Claude broke across two of its own
  // lines arrives here as `…/BA` + many spaces + `Reinickendorf/…`, and the path on
  // disk has one.
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
  // Every reading of one raw candidate, each a PREFIX of it — which is what lets the
  // underline's end be recovered by arithmetic rather than another search.
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
  return out.slice(0, MAX_CANDS);
}

/// Everything worth proposing on one (already joined) line of terminal output. URLs
/// first, then one proposal per path-shaped token.
///
/// Proposals here **may overlap**, and that is deliberate. `src/a.ts and docs/b.md`
/// yields a proposal at each filename, and the first one's longest candidate covers
/// the second — but which of its candidates wins is disk's answer, not this function's,
/// so resolving the overlap here would mean deleting the second link on the strength of
/// a guess that usually loses. ./terminal drops what actually clashes, once it knows.
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
    // A path may FOLLOW an opener but never START with one: `\`docs/tour.md\`` is a
    // path an agent put in backticks, and beginning the proposal at the backtick
    // makes every candidate carry it and nothing resolve.
    if ((i === 0 || OPENER.test(line[i - 1])) && !OPENER.test(line[i]) && !inUrl(i)) {
      const tok = /^\S+/.exec(line.slice(i))?.[0] ?? "";
      if (tok && pathish(tok.replace(TRAIL, ""))) {
        const cands = candidates(line, i, tok);
        if (cands.length) {
          hits.push({ kind: "path", start: i, cands });
          // Past the TOKEN, not past the longest candidate — see above.
          i += tok.length;
          continue;
        }
      }
    }
    i++;
  }
  return hits;
}

/// The directories a printed relative path might be relative to, best first.
///
/// `dirs` is what the caller already knows about the pane, most authoritative first —
/// where its process is *now*, the checkout its work has drifted to, where it was
/// launched. None of those is reliably the right one on its own: an agent writes the
/// path a *reader* would recognise (`Team-Material/I_Projekte/…`), which is relative to
/// a root the session never had as its cwd and nothing on disk announces.
///
/// But the session has already said where it works. Every absolute path in its file set
/// (the Context card's) names a directory it actually touched, and one of that path's
/// ancestors is the root the shortened form was written against. So the ancestors come
/// after the known directories, **most specific first** — a deeper base that resolves is
/// a more precise answer than a shallower one that also would.
///
/// The chain stops two components below the filesystem root: `/` and `/Users` would make
/// every relative token resolvable and tell you nothing.
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
