// The markup half of the working-set diff viewer: `DiffFile[]` in, HTML strings out; ./diffview
// keeps the DOM, listeners and scroll spy. Shaped like a pull request: a visible index, sticky headers.

import { alignHunk, type DiffCell, type DiffFile, type DiffHunk, type DiffMode, type Span } from "./diff";
import { esc, escAttr } from "./format";
import type { Chip } from "./health";

// Shared with the working-set peek's file list, so one file cannot be called two things.
export const DSTAT: Record<DiffFile["status"], [string, string]> = {
  modified: ["M", "s-mod"], added: ["A", "s-add"], deleted: ["D", "s-del"], renamed: ["R", "s-ren"],
};

// Folder and name are drawn at different weights, so a list of `src/…` rows is not a wall.
function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
}
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function cellText(c: DiffCell): string {
  if (!c.spans) return esc(c.line.text);
  return c.spans.map((s: Span) => s.changed ? `<mark class="wch">${esc(s.text)}</mark>` : esc(s.text)).join("");
}

function hunkHead(h: DiffHunk): string {
  return `<div class="dhh"><span class="dhh-at">⋯</span>${h.header ? `<span class="dhh-ctx">${esc(h.header)}</span>` : ""}</div>`;
}

/** One hunk, unified: git's own order, one line per row, two number columns. */
export function hunkHtml(h: DiffHunk): string {
  const rows = alignHunk(h).unified.map((c) => {
    const sign = c.line.kind === "add" ? "+" : c.line.kind === "del" ? "−" : "";
    // `data-ln` is what a health chip scrolls to; only a line that still exists carries one.
    const anchor = c.line.newNo ? ` data-ln="${c.line.newNo}"` : "";
    return `<div class="dline ${c.line.kind}"${anchor}><span class="ln">${c.line.oldNo ?? ""}</span><span class="ln">${c.line.newNo ?? ""}</span><span class="dsign">${sign}</span><span class="lc">${cellText(c)}</span></div>`;
  }).join("");
  return `<div class="dhunk">${hunkHead(h)}${rows}</div>`;
}

// Side by side. Cells are grid children, not rows, so a long left line cannot misalign the right.
export function splitHunkHtml(h: DiffHunk): string {
  // `lft` marks the left column for the divider border; `nth-child` cannot (the band makes every index odd).
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

// `data-hline` is the line a click goes to; 0 means the finding is about the file as a whole.
export function chipsHtml(chips: Chip[], fi: number): string {
  if (!chips.length) return "";
  const one = (c: Chip) =>
    `<button class="hchip ${c.sev}${c.places.length ? "" : " nowhere"}" data-hline="${c.places[0] ?? 0}" data-hfi="${fi}" data-hid="${c.id}" title="${escAttr(c.title)}">${esc(c.text)}</button>`;
  return `<div class="dhealth">${chips.map(one).join("")}</div>`;
}

// One pip per finding, worst first: a rail row fits the count and the severity, not the text.
export function pipsHtml(chips: Chip[]): string {
  if (!chips.length) return "";
  const order = { bad: 0, warn: 1, info: 2 } as const;
  const pips = chips.slice().sort((a, b) => order[a.sev] - order[b.sev]).slice(0, 4)
    .map((c) => `<i class="pip ${c.sev}"></i>`).join("");
  return `<span class="dr-h">${pips}</span>`;
}

// `btns` comes from ./diffview, the only place that knows the absolute path the buttons need.
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
  // Head and chips share one sticky box: a chip walks between marks far apart and must stay reachable.
  return `<section class="dfile ${cls}${open ? "" : " collapsed"}" data-fi="${i}">
      <div class="dftop">
        <div class="dfhead" data-dtoggle="${i}"><span class="dchev">▾</span><span class="dstat ${cls}">${glyph}</span><span class="dpath">${label}</span><span class="dcount">${counts}</span>${btns}</div>
        ${chipsHtml(chips, i)}
      </div>
      <div class="dfbody">${body}</div></section>`;
}

// The index rail, grouped under folders (free: files arrive sorted by path).
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
