// Parsing and alignment for the working-set diff viewer: git_diff's combined patch into
// per-file records, then what a reader needs from a hunk. No DOM; tested in test/diff.test.ts.

export interface DiffLine { kind: "ctx" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null; }
export interface DiffHunk { header: string; lines: DiffLine[]; }
export type DiffMode = "unified" | "split"; // ./state persists it and must not import a view
export interface DiffFile { path: string; oldPath: string | null; status: "modified" | "added" | "deleted" | "renamed"; binary: boolean; added: number; removed: number; hunks: DiffHunk[]; }

// Paths come from the ---/+++ headers (tab-terminated by git, so spaces survive), with the
// `diff --git`/rename lines as fallback; /dev/null sides and "Binary files" are handled.
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
// A hunk's runs of deletions and additions are paired once (alignRuns, by similarity) for
// both renderings: rows for side-by-side, and which -/+ lines to word-mark for unified.

export interface Span { text: string; changed: boolean } // changed:false is text both versions share
export interface DiffCell { line: DiffLine; spans: Span[] | null } // spans null unless worth marking
// One side-by-side row: a pure insertion has no `left`, a pure deletion no `right`.
export interface DiffRow { left: DiffCell | null; right: DiffCell | null }
export interface AlignedHunk { rows: DiffRow[]; unified: DiffCell[] }

// Word-diff units: identifiers and numbers whole, whitespace runs as one, every other
// character alone, so `f(a)` → `f(a, b)` marks only `, b`.
const TOK = /[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g;
export function tokenize(s: string): string[] { return s.match(TOK) ?? []; }

// Past this many tokens a side the line is minified or generated; both sides fall back to
// "the middle changed", which the affix trim has already found.
const WD_CAP = 160;
// Share of the longer line that must be common text before marks are drawn; below it the
// two are different lines that happen to sit together (a rewritten comment, typically).
const WD_FLOOR = 0.34;
// Unchanged runs this short between two changed ones are absorbed, or an edit reads as confetti.
const WD_BRIDGE = 4;

// Changed-token mask from the LCS table, walked forwards so the earliest common token
// wins a tie: an edit at the end of a line stays at the end.
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

// Absorb short unchanged runs between two changed ones; leading and trailing common text stays.
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

function toSpans(toks: string[], changed: boolean[]): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < toks.length; i++) {
    const last = out[out.length - 1];
    if (last && last.changed === changed[i]) last.text += toks[i];
    else out.push({ text: toks[i], changed: changed[i] });
  }
  return out;
}

// `null` when marking would be noise: identical text (a move), almost nothing in common, or an empty side.
export function wordDiff(a: string, b: string): { a: Span[]; b: Span[] } | null {
  if (a === b || !a || !b) return null;
  const x = tokenize(a), y = tokenize(b);
  // Trim the common head and tail first: cheap, and it shrinks what the table has to look at.
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
  // Bridge before the floor, so a confettied line's changed share is measured as one region.
  bridge(x, cx);
  bridge(y, cy);
  // In characters, not tokens: one shared 30-char literal is common ground, thirty brackets are not.
  let common = 0;
  for (let i = 0; i < x.length; i++) if (!cx[i]) common += x[i].length;
  if (common / Math.max(a.length, b.length) < WD_FLOOR) return null;
  return { a: toSpans(x, cx), b: toSpans(y, cy) };
}

const LINE_SIM = 0.35; // below this, two lines are a deletion beside an unrelated insertion
const RUN_CAP = 60; // lines a side; past it a replacement is a rewritten block and pairs off positionally

// Shared head + tail, not the token LCS: this runs n·m times per replacement, and an
// edited line almost always keeps its indent and its opening.
function lineSim(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const n = Math.min(a.length, b.length);
  let head = 0;
  while (head < n && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < n - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return (2 * (head + tail)) / (a.length + b.length);
}

// Which deletion became which addition: order-preserving alignment by similarity, with a
// gap where nothing matches. Never positional; CLAUDE.md's diff-overlay rule says why.
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

// `unified` keeps git's order (deletions, then additions) with word marks added; `rows` is
// the same pairing side by side, alignRuns' gaps becoming one-sided rows.
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
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    // One cell per line, shared by both renderings, so a pair's marks are computed once.
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
