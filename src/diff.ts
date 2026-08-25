// Parsing for the working-set diff viewer. The backend (git_diff) hands us one
// combined unified-diff patch; we turn it into per-file records here rather than
// in Rust, keeping that side thin. Kept in its own module (no DOM/Tauri imports)
// so it can be unit-tested in isolation — see test/diff.test.ts.

export interface DiffLine { kind: "ctx" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null; }
export interface DiffHunk { header: string; lines: DiffLine[]; }
/// Which line layout the viewer draws. Here rather than with the markup because the
/// choice is persisted, so ./state has to name it too, and ./state must not import a
/// view module.
export type DiffMode = "unified" | "split";
export interface DiffFile { path: string; oldPath: string | null; status: "modified" | "added" | "deleted" | "renamed"; binary: boolean; added: number; removed: number; hunks: DiffHunk[]; }

// Parse a combined unified diff into per-file records. Robust to spaces in paths
// (we read the +++/--- headers, which git terminates with a tab, and fall back to
// the `diff --git`/rename lines), /dev/null sides for adds & deletes, and the
// "Binary files … differ" marker.
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0, newNo = 0;
  const strip = (p: string) => p.replace(/\t.*$/, "").replace(/^[ab]\//, "");
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: "", oldPath: null, status: "modified", binary: false, added: 0, removed: 0, hunks: [] };
      hunk = null;
      files.push(cur);
      // Provisional name from the header; refined by the ---/+++ or rename lines.
      const m = line.slice(11).match(/^a\/(.*) b\/(.*)$/);
      if (m) cur.path = m[2];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) { cur.status = "added"; continue; }
    if (line.startsWith("deleted file mode")) { cur.status = "deleted"; continue; }
    if (line.startsWith("rename from ")) { cur.oldPath = line.slice(12); cur.status = "renamed"; continue; }
    if (line.startsWith("rename to ")) { cur.path = line.slice(10); cur.status = "renamed"; continue; }
    if (line.startsWith("Binary files")) { cur.binary = true; continue; }
    if (line.startsWith("--- ")) { const p = line.slice(4); if (p !== "/dev/null") cur.oldPath = strip(p); continue; }
    if (line.startsWith("+++ ")) { const p = line.slice(4); if (p !== "/dev/null") cur.path = strip(p); continue; }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldNo = m ? +m[1] : 0;
      newNo = m ? +m[2] : 0;
      hunk = { header: m ? m[3].trim() : "", lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // index/mode/similarity headers between `diff --git` and the first @@
    const c = line[0];
    if (c === "+") { hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ }); cur.added++; }
    else if (c === "-") { hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null }); cur.removed++; }
    else if (c === " ") { hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }); }
    // "\ No newline at end of file" and trailing blank lines fall through, ignored.
  }
  return files;
}

// ---------- aligning a hunk, and the word diff inside a changed line ----------
//
// Everything below turns a parsed hunk into what a *reader* needs, and it lives here
// rather than in the view for the same reason `parsePatch` does: it is arithmetic over
// strings, it has all the edge cases, and it is the half worth testing.
//
// Two jobs, one pass, because they are the same question asked twice. A hunk's lines
// arrive as git wrote them — a run of deletions, then the run of additions that
// replaced it — and both renderings need those two runs *paired*: side-by-side needs
// the pairs as rows, and unified needs to know which `-`/`+` lines are two versions of
// one line so it can mark the words that actually moved. Pairing is positional within
// a run (git gives no better join), and a pair whose halves have nothing in common is
// left unmarked — see `wordDiff`'s similarity floor.

/// A run of a line, and whether it is part of what changed. `changed:false` spans are
/// the text both versions share.
export interface Span { text: string; changed: boolean }
/// One line as rendered: the line itself, plus the intra-line spans when it was paired
/// with its other version and the two were close enough to be worth marking.
export interface DiffCell { line: DiffLine; spans: Span[] | null }
/// One row of the side-by-side view. A pure insertion has no `left`, a pure deletion no
/// `right`, and a context line has the same line on both sides.
export interface DiffRow { left: DiffCell | null; right: DiffCell | null }
export interface AlignedHunk { rows: DiffRow[]; unified: DiffCell[] }

/// Split a line into the units a word diff compares: identifiers and numbers as whole
/// tokens, runs of whitespace as one, and every other character alone. Keeping
/// punctuation separate is what lets `f(a)` → `f(a, b)` mark only `, b`.
const TOK = /[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g;
export function tokenize(s: string): string[] { return s.match(TOK) ?? []; }

/// Above this many tokens a side, the O(n·m) table below stops being free — and a line
/// that long is minified or generated, where a word diff tells you nothing anyway. Both
/// sides then fall back to "the middle changed", which the affix trim has already found.
const WD_CAP = 160;
/// How much of the longer line must survive as *common* text before the marks are worth
/// drawing. Under it the two lines are different lines that happen to sit next to each
/// other, and highlighting a few incidental brackets in them is noise on top of the
/// green/red the row already carries. A rewritten comment is the case this exists for:
/// two prose lines share `the`, `is` and a couple of articles, and marking those lit
/// nine fragments of one line while saying nothing about what it now says.
const WD_FLOOR = 0.34;
/// Unchanged runs this short between two changed ones are absorbed into the change.
/// Without it an edit reads as confetti: `a.foo(x)` → `a.bar(y)` marks `foo` and `x` and
/// leaves the `(` between them lit differently for no reason a reader can use. Merging
/// first also makes the floor above decisive, since a confettied line's changed share is
/// then measured as the one region it really is.
const WD_BRIDGE = 4;

/// The changed-token mask for two token runs, from the classic LCS table. Walks the
/// table forwards so the *earliest* common token wins a tie, which reads better than
/// the backwards walk: an edit at the end of a line stays at the end of the line.
function lcsMask(x: string[], y: string[]): [boolean[], boolean[]] {
  const n = x.length, m = y.length, w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = x[i] === y[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const cx = new Array<boolean>(n).fill(true), cy = new Array<boolean>(m).fill(true);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { cx[i] = false; cy[j] = false; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return [cx, cy];
}

/// Absorb short unchanged runs that sit *between* two changed ones. Leading and
/// trailing common text is never touched — that is the part the reader is using to line
/// the two versions up.
function bridge(toks: string[], changed: boolean[]) {
  let last = -1;
  for (let i = 0; i < toks.length; i++) {
    if (!changed[i]) continue;
    if (last >= 0) {
      let gap = 0;
      for (let k = last + 1; k < i; k++) gap += toks[k].length;
      if (gap <= WD_BRIDGE) for (let k = last + 1; k < i; k++) changed[k] = true;
    }
    last = i;
  }
}

/// Fold a token list and its mask into the fewest spans that describe it.
function toSpans(toks: string[], changed: boolean[]): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < toks.length; i++) {
    const last = out[out.length - 1];
    if (last && last.changed === changed[i]) last.text += toks[i];
    else out.push({ text: toks[i], changed: changed[i] });
  }
  return out;
}

/// What changed *inside* a pair of lines, or `null` when marking it would be noise.
///
/// `null` covers three cases that all render better plain: identical text (the pair is
/// a move, not an edit), a pair with almost nothing in common (two unrelated lines that
/// happened to line up), and an empty side. The caller draws the line unmarked, and the
/// row's own +/− colour is left to say what happened.
export function wordDiff(a: string, b: string): { a: Span[]; b: Span[] } | null {
  if (a === b || !a || !b) return null;
  const x = tokenize(a), y = tokenize(b);
  // Trim the common head and tail first. It is the cheap half of the answer (most code
  // edits are a change in the middle of a line), and it shrinks what the table below
  // has to look at — often to nothing.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head
    && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const mx = x.slice(head, x.length - tail), my = y.slice(head, y.length - tail);
  const [cmx, cmy] = mx.length > WD_CAP || my.length > WD_CAP
    ? [new Array<boolean>(mx.length).fill(true), new Array<boolean>(my.length).fill(true)]
    : lcsMask(mx, my);
  const mask = (toks: string[], mid: boolean[]) =>
    toks.map((_, i) => i >= head && i < toks.length - tail ? mid[i - head] : false);
  const cx = mask(x, cmx), cy = mask(y, cmy);
  bridge(x, cx);
  bridge(y, cy);
  // The floor is measured in characters, not tokens: one shared 30-character string
  // literal is real common ground, thirty shared brackets are not.
  let common = 0;
  for (let i = 0; i < x.length; i++) if (!cx[i]) common += x[i].length;
  if (common / Math.max(a.length, b.length) < WD_FLOOR) return null;
  return { a: toSpans(x, cx), b: toSpans(y, cy) };
}

/// How close two lines must be before they are called two versions of one line rather
/// than a deletion next to an unrelated insertion.
const LINE_SIM = 0.35;
/// Beyond this many lines a side, a replacement is a rewritten block and the O(n·m)
/// alignment below buys nothing a reader can use, so the runs pair off positionally.
const RUN_CAP = 60;

/// A cheap similarity for two lines: how much of them is shared head and shared tail.
///
/// Deliberately not the token LCS `wordDiff` runs — this is asked n·m times per
/// replacement, where that would be n·m token tables. Affixes are the right cheap
/// answer for code: an edited line almost always keeps its indent and its opening, and
/// two lines that share neither are not two versions of anything.
function lineSim(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const n = Math.min(a.length, b.length);
  let head = 0;
  while (head < n && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < n - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return (2 * (head + tail)) / (a.length + b.length);
}

/// Which deletion became which addition, in order.
///
/// Positional pairing — the obvious rule, and the one this replaced — is wrong in the
/// single most common shape an agent's edit has: three explanatory lines added *above*
/// one changed line. That pairs the changed line with the first new comment, so the
/// side-by-side rows are offset for the rest of the run and the one pair worth marking
/// never meets. This is the same order-preserving alignment as a diff itself, one level
/// down: match where the two lines are close enough, otherwise leave a gap.
function alignRuns(dels: DiffLine[], adds: DiffLine[]): [DiffLine | null, DiffLine | null][] {
  const n = dels.length, m = adds.length;
  const out: [DiffLine | null, DiffLine | null][] = [];
  if (!n || !m || n > RUN_CAP || m > RUN_CAP) {
    for (let k = 0; k < Math.max(n, m); k++) out.push([dels[k] ?? null, adds[k] ?? null]);
    return out;
  }
  const sim = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const v = lineSim(dels[i].text, adds[j].text);
      sim[i * m + j] = v >= LINE_SIM ? v : 0;
    }
  }
  const w = m + 1;
  const dp = new Float64Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = sim[i * m + j] ? sim[i * m + j] + dp[(i + 1) * w + j + 1] : -1;
      dp[i * w + j] = Math.max(pair, dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    const pair = sim[i * m + j] ? sim[i * m + j] + dp[(i + 1) * w + j + 1] : -1;
    if (pair >= dp[(i + 1) * w + j] && pair >= dp[i * w + j + 1]) { out.push([dels[i++], adds[j++]]); }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push([dels[i++], null]);
    else out.push([null, adds[j++]]);
  }
  while (i < n) out.push([dels[i++], null]);
  while (j < m) out.push([null, adds[j++]]);
  return out;
}

/// Pair a hunk's deletions with the additions that replaced them, for both renderings.
///
/// `unified` keeps git's own order — every deletion, then every addition — so the
/// familiar reading is unchanged and only the word marks are new; `rows` is the same
/// pairing laid out as side-by-side rows, where the gaps `alignRuns` left become the
/// blank half of a one-sided row.
export function alignHunk(h: DiffHunk): AlignedHunk {
  const rows: DiffRow[] = [], unified: DiffCell[] = [];
  const lines = h.lines;
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === "ctx") {
      const cell: DiffCell = { line: lines[i], spans: null };
      rows.push({ left: cell, right: cell });
      unified.push(cell);
      i++;
      continue;
    }
    // One replacement: the deletions here, then the additions that follow them.
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    // One cell per line, held by line so both renderings show the same object and a
    // pair's marks cannot be computed twice or disagree between the two layouts.
    const cells = new Map<DiffLine, DiffCell>();
    const cell = (l: DiffLine) => {
      let c = cells.get(l);
      if (!c) cells.set(l, c = { line: l, spans: null });
      return c;
    };
    for (const [d, a] of alignRuns(dels, adds)) {
      const lc = d ? cell(d) : null, rc = a ? cell(a) : null;
      if (lc && rc) {
        const wd = wordDiff(lc.line.text, rc.line.text);
        if (wd) { lc.spans = wd.a; rc.spans = wd.b; }
      }
      rows.push({ left: lc, right: rc });
    }
    unified.push(...dels.map(cell), ...adds.map(cell));
  }
  return { rows, unified };
}
