// The markup half of the working-set diff viewer: `DiffFile[]` in, HTML strings out.
//
// A `*view.ts` on the house rule — no `$()`, no `innerHTML`, no renderer call — split
// out of ./diffview when that module stopped being "paint a list of hunks" and became a
// review surface with an index, two line layouts and a scroll spy. ./diffview keeps the
// DOM: the dialog, its listeners, the spy and which mode is current. This file only
// knows how a file, a hunk and a line are drawn.
//
// The shape is deliberately the one a pull request has, because that is the shape the
// reading is: **an index you can see all of, and a stream whose file headers stick.**
// Before this, seven files opened as seven unlabelled walls of code — scroll into the
// middle of one and nothing on screen said which file you were in, so the only way to
// answer "where does the next file start" was to scroll back up until a header appeared.
// The index answers it without scrolling and the sticky header answers it in place.
//
// `hunkHtml` moved here from ./inspectorview, where it had been the odd one out: the
// inspector never called it, ./diffview was its only consumer, and it now sits beside
// the side-by-side twin it shares a row model with.

import { alignHunk, type DiffCell, type DiffFile, type DiffHunk, type DiffMode, type Span } from "./diff";
import { esc, escAttr } from "./format";
import type { Chip } from "./health";

/// The letter and colour class for each status, shared with the working-set peek's own
/// file list (`.dstat` is defined once, with the viewer) so one file cannot be called
/// two things by two surfaces.
export const DSTAT: Record<DiffFile["status"], [string, string]> = {
  modified: ["M", "s-mod"], added: ["A", "s-add"], deleted: ["D", "s-del"], renamed: ["R", "s-ren"],
};

/// A path as two pieces: the folder, which is context, and the name, which is the answer.
/// Rendering them at one weight is what makes a list of `src/…` rows read as a wall —
/// every row starts with the same four characters and the eye has to walk past them.
function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
}
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/// The text of a line, with the words that actually changed marked — or plain when the
/// pair was too dissimilar to mark (./diff decides that, not this).
function cellText(c: DiffCell): string {
  if (!c.spans) return esc(c.line.text);
  return c.spans.map((s: Span) => s.changed ? `<mark class="wch">${esc(s.text)}</mark>` : esc(s.text)).join("");
}

/// The band above a hunk. It carries the enclosing function git found, which is the one
/// piece of "where am I" a hunk can answer on its own.
function hunkHead(h: DiffHunk): string {
  return `<div class="dhh"><span class="dhh-at">⋯</span>${h.header ? `<span class="dhh-ctx">${esc(h.header)}</span>` : ""}</div>`;
}

/// One hunk, unified: git's own order, one line per row, two number columns.
export function hunkHtml(h: DiffHunk): string {
  const rows = alignHunk(h).unified.map((c) => {
    const sign = c.line.kind === "add" ? "+" : c.line.kind === "del" ? "−" : "";
    // `data-ln` is the new-file line number, and it is what a health chip scrolls to.
    // Only a line that still exists carries one — a deletion has nowhere to go.
    const anchor = c.line.newNo ? ` data-ln="${c.line.newNo}"` : "";
    return `<div class="dline ${c.line.kind}"${anchor}><span class="ln">${c.line.oldNo ?? ""}</span><span class="ln">${c.line.newNo ?? ""}</span><span class="dsign">${sign}</span><span class="lc">${cellText(c)}</span></div>`;
  }).join("");
  return `<div class="dhunk">${hunkHead(h)}${rows}</div>`;
}

/// One hunk, side by side. The cells are grid children rather than rows-of-cells, so
/// the two code columns share one track sizing and a long line on the left cannot push
/// the right-hand column out of alignment with it.
export function splitHunkHtml(h: DiffHunk): string {
  // `lft` marks the left code column: the divider between the two halves is drawn as
  // its right border, and `nth-child` cannot pick it out (the hunk band above makes
  // every cell's index odd).
  const cell = (c: DiffCell | null, side: "del" | "add") => {
    const l = side === "del" ? " lft" : "";
    return c
      ? `<span class="sn ${c.line.kind}"${side === "add" && c.line.newNo ? ` data-ln="${c.line.newNo}"` : ""}>${(side === "del" ? c.line.oldNo : c.line.newNo) ?? ""}</span>`
        + `<span class="sc${l} ${c.line.kind}">${cellText(c)}</span>`
      : `<span class="sn nil"></span><span class="sc${l} nil"></span>`;
  };
  const rows = alignHunk(h).rows
    .map((r) => cell(r.left, "del") + cell(r.right, "add"))
    .join("");
  return `<div class="dhunk split">${hunkHead(h)}${rows}</div>`;
}

/// A row of health chips, above the first hunk. Clicking one goes to the line that
/// earned it, which is what makes a finding actionable rather than decorative:
/// `data-hline` carries that line, and 0 means the finding is about the file as a whole
/// and there is nowhere better to be.
export function chipsHtml(chips: Chip[], fi: number): string {
  if (!chips.length) return "";
  const one = (c: Chip) =>
    `<button class="hchip ${c.sev}${c.line ? "" : " nowhere"}" data-hline="${c.line}" data-hfi="${fi}" title="${escAttr(c.title)}">${esc(c.text)}</button>`;
  return `<div class="dhealth">${chips.map(one).join("")}</div>`;
}

/// The rail's summary of a file's chips: one pip per finding, worst first.
///
/// A rail row is ~230px and a chip's text does not fit in it — but the count and the
/// severity do, and that is the half you need to decide which file to open first.
export function pipsHtml(chips: Chip[]): string {
  if (!chips.length) return "";
  const order = { bad: 0, warn: 1, info: 2 } as const;
  const pips = chips.slice().sort((a, b) => order[a.sev] - order[b.sev]).slice(0, 4)
    .map((c) => `<i class="pip ${c.sev}"></i>`).join("");
  return `<span class="dr-h">${pips}</span>`;
}

/// One file's section. `btns` is passed in rather than built here because the two
/// buttons need the absolute path, which only ./diffview knows — the view stays pure.
export function fileHtml(f: DiffFile, i: number, mode: DiffMode, open: boolean, btns: string, chips: Chip[] = []): string {
  const [glyph, cls] = DSTAT[f.status];
  const [dir, name] = splitPath(f.path);
  const label = f.status === "renamed" && f.oldPath
    ? `<span class="d-old">${esc(f.oldPath)}</span><span class="d-arr">→</span><span class="dp-dir">${esc(dir)}</span>${esc(name)}`
    : `<span class="dp-dir">${esc(dir)}</span>${esc(name)}`;
  const counts = f.binary ? `<span class="d-bin">binary</span>`
    : `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`;
  const draw = mode === "split" ? splitHunkHtml : hunkHtml;
  const body = f.binary
    ? `<div class="d-binbody">Binary file, no textual diff.</div>`
    : f.hunks.map(draw).join("") || `<div class="d-binbody">No line changes (mode or metadata only).</div>`;
  return `<section class="dfile ${cls}${open ? "" : " collapsed"}" data-fi="${i}">
      <div class="dfhead" data-dtoggle="${i}"><span class="dchev">▾</span><span class="dstat ${cls}">${glyph}</span><span class="dpath">${label}</span><span class="dcount">${counts}</span>${btns}</div>
      <div class="dfbody">${chipsHtml(chips, i)}${body}</div></section>`;
}

/// The index down the left. One row a file, grouped under the folder it is in — which is
/// free here (the files arrive sorted by path) and turns a flat list of twenty paths
/// into the handful of areas the change actually touched.
export function railHtml(files: DiffFile[], active: number, chips: Chip[][] = []): string {
  let dir: string | null = null;
  const rows = files.map((f, i) => {
    const d = dirOf(f.path);
    const head = d === dir ? "" : `<div class="dr-dir" title="${escAttr(d || "the project root")}">${esc(d || "/")}</div>`;
    dir = d;
    const [glyph, cls] = DSTAT[f.status];
    const [, name] = splitPath(f.path);
    const n = f.binary ? `<i class="d-bin">bin</i>`
      : `<i class="add">+${f.added}</i><i class="del">−${f.removed}</i>`;
    return `${head}<button class="dr-row${i === active ? " on" : ""}" data-drow="${i}" title="${escAttr(f.path)}">`
      + `<span class="dstat ${cls}">${glyph}</span><span class="dr-name">${esc(name)}</span>${pipsHtml(chips[i] ?? [])}<span class="dr-n">${n}</span></button>`;
  }).join("");
  return rows;
}
