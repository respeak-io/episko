// The markup half of the working-set diff viewer: `DiffFile[]` in, HTML strings out; ./diffview
// keeps the DOM, listeners and scroll spy. Shaped like a pull request: a visible index, sticky headers.

import { alignHunk, type DiffCell, type DiffFile, type DiffHunk, type DiffLine, type DiffMode, type Span } from "./diff";
import { esc, escAttr } from "./format";
import type { Chip } from "./health";
import { stashElsewhere } from "./gitops";
import type { RailLayout, TreeRow } from "./review";
import { icon } from "./svgicons";
import type { StashEntry, StatusFile } from "./types";

// One letter, one colour, wherever a changed file is named: these headers, the index rail,
// the ⑃ dialog's working-tree fact and the dashboard's Working set card. Two keys and one
// table, because a patch says "modified" where `git status` says M; `?` borrows added's green.
export const FCLASS: Record<string, string> = {
  M: "s-mod", A: "s-add", "?": "s-add", D: "s-del", R: "s-ren", C: "s-ren", U: "s-del",
};
export const DSTAT: Record<DiffFile["status"], string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R",
};
const fcls = (code: string) => FCLASS[code] ?? "s-mod";

// Folder and name are drawn at different weights, so a list of `src/…` rows is not a wall.
function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
}
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

// A repo-relative path, folder dimmed. Not the ⑃ dialog's `wtPathHtml`, which answers the
// same question about an OS path (backslashes, no repo root) and must keep its own splitter.
function pathHtml(p: string): string {
  const [dir, name] = splitPath(p);
  return `${dir ? `<span class="dim">${esc(dir)}</span>` : ""}<span class="em">${esc(name)}</span>`;
}

// One dirty file as `git status` names it, for the hosts that list a working set without
// drawing it. `attrs` is how a host makes the row a door; ./patchview knows no paths.
export function statusRowHtml(f: StatusFile, attrs = ""): string {
  const name = f.from ? `<span class="from">${esc(f.from)}</span> → ${pathHtml(f.path)}` : pathHtml(f.path);
  const n = f.added || f.removed
    ? `<span class="n"><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span>`
    : "";
  return `<li${attrs}><span class="dstat ${fcls(f.code)}">${esc(f.code)}</span><span class="p">${name}</span>${n}</li>`;
}

/** The files behind a working set, capped by the host. `total` is `dirty` rather than
 *  `entries.length`, since the backend caps the list and not the count: "…and N more" has
 *  to speak for the entries nobody sent as well as the ones this host chose not to draw. */
export function fileSetHtml(
  entries: StatusFile[], cap: number, total: number, attrs: (f: StatusFile) => string = () => "",
): string {
  const shown = entries.slice(0, cap);
  const rest = total - shown.length;
  return (shown.length ? `<ul class="fslist">${shown.map((f) => statusRowHtml(f, attrs(f))).join("")}</ul>` : "")
    + (rest > 0 ? `<div class="fsmore">…and ${rest} more</div>` : "");
}

function cellText(c: DiffCell): string {
  if (!c.spans) return esc(c.line.text);
  return c.spans.map((s: Span) => s.changed ? `<mark class="wch">${esc(s.text)}</mark>` : esc(s.text)).join("");
}

// `act` is the hunk's own button, from ./diffview; a stash or a new file's hunk has none.
function hunkHead(h: DiffHunk, act: string): string {
  return `<div class="dhh"><span class="dhh-at">${icon("ellipsis", "solo")}</span>${h.header ? `<span class="dhh-ctx">${esc(h.header)}</span>` : ""}${act}</div>`;
}

/** What a review hangs on a line: a control in its gutter, and blocks (threads) after its row. */
export interface LineHooks { gutter: (l: DiffLine) => string; after: (l: DiffLine) => string }
const NO_HOOKS: LineHooks = { gutter: () => "", after: () => "" };

/** One hunk, unified: git's own order, one line per row, two number columns. */
export function hunkHtml(h: DiffHunk, act = "", hooks: LineHooks = NO_HOOKS): string {
  const rows = alignHunk(h).unified.map((c) => {
    const sign = c.line.kind === "add" ? "+" : c.line.kind === "del" ? "−" : "";
    // `data-ln` is what a health chip scrolls to; only a line that still exists carries one.
    const anchor = c.line.newNo ? ` data-ln="${c.line.newNo}"` : "";
    return `<div class="dline ${c.line.kind}"${anchor}>${hooks.gutter(c.line)}<span class="ln">${c.line.oldNo ?? ""}</span><span class="ln">${c.line.newNo ?? ""}</span><span class="dsign">${sign}</span><span class="lc">${cellText(c)}</span></div>`
      + hooks.after(c.line);
  }).join("");
  return `<div class="dhunk">${hunkHead(h, act)}${rows}</div>`;
}

// Side by side. Cells are grid children, not rows, so a long left line cannot misalign the right.
export function splitHunkHtml(h: DiffHunk, act = "", hooks: LineHooks = NO_HOOKS): string {
  // `lft` marks the left column for the divider border; `nth-child` cannot (the band makes every index odd).
  const cell = (c: DiffCell | null, side: "del" | "add") => {
    const l = side === "del" ? " lft" : "";
    return c
      ? `<span class="sn ${c.line.kind}"${side === "add" && c.line.newNo ? ` data-ln="${c.line.newNo}"` : ""}>${hooks.gutter(c.line)}${(side === "del" ? c.line.oldNo : c.line.newNo) ?? ""}</span>`
        + `<span class="sc${l} ${c.line.kind}">${cellText(c)}</span>`
      : `<span class="sn nil"></span><span class="sc${l} nil"></span>`;
  };
  // A context row is one line drawn on both sides: what hangs off it is drawn once.
  const rows = alignHunk(h).rows
    .map((r) => cell(r.left, "del") + cell(r.right, "add")
      + (r.left && r.left.line !== r.right?.line ? hooks.after(r.left.line) : "")
      + (r.right ? hooks.after(r.right.line) : ""))
    .join("");
  return `<div class="dhunk split">${hunkHead(h, act)}${rows}</div>`;
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

/** The tick a file wears in its header and its rail row; null draws none (a stash is read-only). */
export function tickHtml(i: number, on: boolean | null): string {
  if (on === null) return "";
  return `<span class="dtick${on ? " on" : ""}" data-dpick="${i}" role="checkbox" aria-checked="${on}" title="Include in commit, stash and discard"></span>`;
}

/** What a host adds to a file: its buttons, its tick, a hunk's button by index, and (a review)
 *  per-line hooks, blocks under the header and a control after the last hunk. */
export interface FileActs {
  btns: string; tick: boolean | null; hunk: (hi: number) => string;
  lines?: LineHooks; top?: string; tail?: string; cls?: string;
}

// `acts` comes from ./diffview, the only place that knows the absolute path the buttons need.
export function fileHtml(f: DiffFile, i: number, mode: DiffMode, open: boolean, acts: FileActs, chips: Chip[] = []): string {
  const glyph = DSTAT[f.status], cls = fcls(glyph);
  const [dir, name] = splitPath(f.path);
  const label = f.status === "renamed" && f.oldPath
    ? `<span class="d-old">${esc(f.oldPath)}</span><span class="d-arr">→</span><span class="dp-dir">${esc(dir)}</span>${esc(name)}`
    : `<span class="dp-dir">${esc(dir)}</span>${esc(name)}`;
  const counts = f.binary ? `<span class="d-bin">binary</span>`
    : `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`;
  const draw = mode === "split" ? splitHunkHtml : hunkHtml;
  const body = f.binary
    ? `<div class="d-binbody">Binary file, no textual diff.</div>`
    : f.large !== null ? `<div class="d-binbody">Too large to show here: over 250 KB of diff for this one file.</div>`
    : f.hunks.map((h, hi) => draw(h, acts.hunk(hi), acts.lines)).join("") || `<div class="d-binbody">No line changes (mode or metadata only).</div>`;
  // Head and chips share one sticky box: a chip walks between marks far apart and must stay reachable.
  return `<section class="dfile ${cls}${open ? "" : " collapsed"}${acts.cls ?? ""}" data-fi="${i}">
      <div class="dftop">
        <div class="dfhead" data-dtoggle="${i}">${tickHtml(i, acts.tick)}<span class="dchev">${icon("chevronDown", "solo")}</span><span class="dstat ${cls}">${glyph}</span><span class="dpath">${label}</span><span class="dcount">${counts}</span>${acts.btns}</div>
        ${chipsHtml(chips, i)}
      </div>
      <div class="dfbody">${acts.top ?? ""}${body}${acts.tail ?? ""}</div></section>`;
}

/** The rail's own head: what it lists, and the switch between a folder tree and a flat list. */
export function railHeadHtml(layout: RailLayout, n: number): string {
  const b = (v: RailLayout, label: string, tip: string) =>
    `<button class="gseg-b${layout === v ? " on" : ""}" data-drlayout="${v}" title="${tip}">${label}</button>`;
  return `<div class="dr-head"><span class="dr-ht">${n} file${n === 1 ? "" : "s"}</span><div class="gseg">`
    + b("tree", `${icon("tree")}tree`, "Nest the files in their folders") + b("flat", `${icon("list")}list`, "One list, each folder named once") + `</div></div>`;
}

// One file's row in either layout. `mark` is the host's extra (a review's viewed tick and thread count).
function railRow(f: DiffFile, i: number, active: number, chips: Chip[], tick: boolean | null, mark: string, depth = -1): string {
  const glyph = DSTAT[f.status], cls = fcls(glyph);
  const [, name] = splitPath(f.path);
  const n = f.binary ? `<i class="d-bin">bin</i>`
    : `<i class="add">+${f.added}</i><i class="del">−${f.removed}</i>`;
  const indent = depth >= 0 ? ` style="--d:${depth}"` : "";
  return `<button class="dr-row${depth >= 0 ? " tree" : ""}${i === active ? " on" : ""}" data-drow="${i}" title="${escAttr(f.path)}"${indent}>`
    + `${tickHtml(i, tick)}<span class="dstat ${cls}">${glyph}</span><span class="dr-name">${esc(name)}</span>${mark}${pipsHtml(chips)}<span class="dr-n">${n}</span></button>`;
}

// The index rail, grouped under folders (free: files arrive sorted by path).
export function railHtml(
  files: DiffFile[], active: number, chips: Chip[][] = [], tick: (i: number) => boolean | null = () => null,
  mark: (i: number) => string = () => "",
): string {
  let dir: string | null = null;
  return files.map((f, i) => {
    const d = dirOf(f.path);
    const head = d === dir ? "" : `<div class="dr-dir" title="${escAttr(d || "the project root")}">${esc(d || "/")}</div>`;
    dir = d;
    return head + railRow(f, i, active, chips[i] ?? [], tick(i), mark(i));
  }).join("");
}

/** The same rail as a tree: `rows` from ./review's `treeRows` over these files, in their order. */
export function treeRailHtml(
  files: DiffFile[], rows: TreeRow[], folded: ReadonlySet<string>, active: number, chips: Chip[][] = [],
  tick: (i: number) => boolean | null = () => null, mark: (i: number) => string = () => "",
): string {
  return rows.map((r) => r.kind === "dir"
    ? `<button class="dr-fold${folded.has(r.path) ? " shut" : ""}" data-drdir="${escAttr(r.path)}" style="--d:${r.depth}" title="${escAttr(r.path)}"><span class="dchev">${icon("chevronDown", "solo")}</span>${esc(r.name)}</button>`
    : railRow(files[r.index], r.index, active, chips[r.index] ?? [], tick(r.index), mark(r.index), r.depth)).join("");
}

// The repo's stash, newest first. Every worktree shares it, so a stash made on another
// branch is drawn dimmer and says where it came from rather than being hidden.
export function stashListHtml(list: StashEntry[], branch: string): string {
  if (!list.length) return `<div class="diff-empty">No stashes. <b>Stash</b> under the changes sets work aside without committing it.</div>`;
  const row = (e: StashEntry) => {
    const away = stashElsewhere(e, branch);
    const sha = escAttr(e.sha);
    const btn = (op: string, label: string, tip: string, cls = "diff-fold") =>
      `<button class="${cls}" data-dstash="${op}" data-dsha="${sha}" title="${escAttr(tip)}">${label}</button>`;
    return `<div class="dstash${away ? " away" : ""}" data-dsha="${sha}">`
      + `<button class="dstash-main" data-dstash="view" data-dsha="${sha}" title="Show what this stash holds">`
      + `<span class="dstash-msg">${esc(e.message || "(no message)")}</span>`
      + `<span class="dstash-meta">${e.branch ? `on <span class="mono">${esc(e.branch)}</span> · ` : ""}${esc(e.rel)}${away ? " · another branch" : ""}</span></button>`
      + btn("apply", "apply", "Apply it to this folder and keep the stash")
      + btn("pop", "pop", "Apply it to this folder, then drop it")
      + btn("drop", "drop", "Delete this stash", "diff-fold danger")
      + `</div>`;
  };
  return `<div class="dstashes">${list.map(row).join("")}</div>`;
}

/** The strip over one stash's diff: back to the list, and the same three verbs. */
export function stashBarHtml(e: StashEntry): string {
  const sha = escAttr(e.sha);
  return `<div class="dstash-bar"><button class="diff-fold" data-dstash="list">${icon("arrowLeft")}stashes</button>`
    + `<span class="dstash-msg">${esc(e.message || "(no message)")}</span>`
    + `<span class="dstash-meta">${e.branch ? `on <span class="mono">${esc(e.branch)}</span> · ` : ""}${esc(e.rel)}</span>`
    + `<button class="diff-fold" data-dstash="apply" data-dsha="${sha}">apply</button>`
    + `<button class="diff-fold" data-dstash="pop" data-dsha="${sha}">pop</button>`
    + `<button class="diff-fold danger" data-dstash="drop" data-dsha="${sha}">drop</button></div>`;
}
