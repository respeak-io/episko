// The dashboard's lite commit graph: the newest rows of ./graph's page, bot runs folded.
// Data in, string out. None of ./graphview's paging, prefetch or measured column is repeated
// here on purpose — this section's enlargement IS that dialog (data-dashact="graph").

import { esc, escAttr, initials, nameHue } from "./format";
import {
  graphWidth, laneColor, lineTip, refChips, refChipsHtml, rowSvgAt, shortRel,
  type GraphFold, type LiteRow,
} from "./graph";

/** What the section draws. `hidden` is the commit count the folds stand for, 0 when nothing
 *  folded; `span` is the widest row SHOWN, so no row keeps a track none of them reaches. */
export interface LandedView {
  rows: LiteRow[];
  span: number;
  head: string; // the HEAD sha; the one row drawn with the ring
  hidden: number;
  loading: boolean;
  known: boolean; // this folder is a repo; a folder that is not never loads a graph
}

// Every row's graph cell is one width, set once on the list: each row is its own flex box, so
// two widths stagger the subjects. A static number, never ./graphview's measured --gleft-w —
// this repaints on renderAll's path, where a layout read is not free.
const leftWidth = (span: number) => `--lgleft:${graphWidth(span)}px`;

const sk = (w: string, h = 9) => `<i class="db-sk" style="width:${w};height:${h}px"></i>`;

// Three rows in the real geometry and only three: the page size is ./dashboard's, so a longer
// skeleton would promise a length this cannot know (./dashview's spineSkeleton, same rule).
function landedSkeleton(): string {
  const row = (w: string) => `<div class="lgrow"><span class="lgleft">${sk("14px", 13)}</span>`
    + `<span class="lgsubj">${sk(w, 9)}</span><span class="lgwho"></span>`
    + `<span class="lgwhen">${sk("24px", 8)}</span></div>`;
  return `<div class="asec lg sk"><div class="asec-h lgh">${sk("52px", 8)}</div>`
    + `<div class="lgrows" style="--lgleft:36px">`
    + ["82%", "64%", "74%"].map(row).join("") + `</div></div>`;
}

// A fold stands in for commits nobody is going to read one by one, so it says how many and
// whose; without both it would be a row that hides work and admits to neither.
function foldText(f: GraphFold): string {
  const n = f.commits.length;
  return `${n} commit${n === 1 ? "" : "s"}${f.authors.length ? ` from ${f.authors.join(", ")}` : ""}`;
}

// A name collapsed to two letters: at eight rows the column is a glance at who, and the full
// name is the title. A fold takes none — `foldText` already names them, and one face of
// several bots would stand for the rest.
function whoHtml(r: LiteRow): string {
  if (r.kind === "fold") return `<span class="lgwho"></span>`;
  const who = r.row.c.author;
  const ini = initials(who);
  if (!ini) return `<span class="lgwho"></span>`;
  return `<span class="lgwho" style="--who:${nameHue(who)}" title="${escAttr(who)}">${esc(ini)}</span>`;
}

// `span` is the page's widest row for every row, so the lanes line up down the list; rowSvgAt
// clamps it up rather than clipping a row that reaches further. `--lane` is this row's line
// colour: it is what the ref chip wears now that no legend names the lanes.
export function landedRowHtml(r: LiteRow, span: number, head: string): string {
  const row = r.kind === "commit" ? r.row : r.fold.row;
  const text = r.kind === "fold" ? foldText(r.fold) : row.c.subject;
  const tip = r.kind === "fold" ? `${text} · show every commit` : text;
  return `<div class="lgrow${r.kind === "fold" ? " fold" : ""}" data-dashsha="${escAttr(row.c.sha)}"`
    + (r.kind === "fold" ? ` data-dashfold="1"` : "")
    + ` style="--lane:${laneColor(row.line)}">`
    + `<span class="lgleft" title="${escAttr(lineTip(row))}">`
    + `${rowSvgAt(row, span, { head: row.c.sha === head })}</span>`
    + `<span class="lgsubj" title="${escAttr(tip)}">${refChipsHtml(refChips(row.c.refs, 2))}`
    + `<span class="lgtext">${esc(text) || "<em>no subject</em>"}</span></span>`
    + whoHtml(r)
    + `<span class="lgwhen" title="${escAttr(row.c.rel)}">${esc(shortRel(row.c.rel))}</span></div>`;
}

// Three states kept apart. An empty page is a freshly-inited repo, and an absent section says
// that better than an empty one, which reads as breakage (the aside's rule, ./dashview).
export function landedCard(v: LandedView): string {
  if (!v.known) return "";
  if (v.loading) return landedSkeleton();
  if (!v.rows.length) return "";
  const folded = v.hidden > 0;
  const chipTip = folded
    ? "Runs of bot commits are folded into one row; show every commit"
    : "Fold runs of bot commits into one row";
  return `<div class="asec lg"><div class="asec-h lgh"><span class="label">Landed</span>`
    + `<span class="tag" title="Every branch, not just this checkout">all refs</span>`
    + `<button class="tag${folded ? " acc" : ""}" data-dashfold="1"`
    + ` title="${escAttr(chipTip)}">⊘ bots${folded ? ` ${v.hidden}` : ""}</button>`
    + `<button class="aslink" data-dashact="graph" title="Every commit, paged, with its message">Commit graph ⤢</button></div>`
    + `<div class="lgrows" style="${leftWidth(v.span)}">`
    + `${v.rows.map((r) => landedRowHtml(r, v.span, v.head)).join("")}</div>`
    + `<button class="lgmore" data-dashact="graph">`
    + `<span class="c">⌄</span>`
    + `<span class="t">More history opens the graph panel — this page never pages</span></button></div>`;
}
