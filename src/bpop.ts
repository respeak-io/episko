// The branch chooser: one picker for the worktree base, a checkout's switch target and the
// Branches view's trunk chip, in the .menupop idiom. At body level (#bPop) because .wtdlg is
// overflow:hidden; typing filters, since a repo can hold BRANCH_LIST_CAP refs.

// Its own module rather than the ⑃ dialog's: three surfaces open it, and the inspector
// reaching into worktree.ts for it would point an import the wrong way.

import { invoke } from "@tauri-apps/api/core";
import { $ } from "./dom";
import { esc } from "./format";
import { readObj } from "./store";
import { glyphIcon, icon } from "./svgicons";
import {
  clampPickLists, pickSel, rememberPicks, switchOptions, withCurrent,
  type BranchInfo, type BranchPick,
} from "./branches";
import type { WtHead } from "./types";

const LISTS_KEY = "cc-branch-lists";

let bPopItems: BranchPick[] = [];
let bPopSel = 0;
let bPopOn: ((name: string, row: BranchPick) => void) | null = null;
let bPopAnchor: HTMLElement | null = null;
// Where focus goes when the popover closes, when the opener had somewhere to send it.
let bPopBack: (() => void) | null = null;
// The trigger as it stood at the click. A repaint can replace that node while a list is read,
// and a detached node measures all zeroes: the window's top-left corner.
let bPopRect: DOMRect | null = null;
let bPopWaiting = false;
// Bumped by every open and close, so a list that lands late is nobody's.
let bPopGen = 0;
let bPopHtml = "";

export function bPopOpen() { return $("bPop").classList.contains("show"); }

/** Opens on the call, always. A list that must still be read comes as a promise and lands in
 *  the open popover, keeping whatever was typed meanwhile; `kept` stands in until it does. */
export function openBranchPop(
  anchor: HTMLElement, items: BranchPick[] | Promise<BranchPick[]>, current: string,
  onPick: (name: string, row: BranchPick) => void, refocus?: () => void, kept?: BranchPick[],
) {
  const gen = ++bPopGen;
  bPopOn = onPick; bPopAnchor = anchor; bPopBack = refocus ?? null;
  bPopRect = anchor.getBoundingClientRect();
  const pop = $("bPop");
  pop.innerHTML = `<div class="bp-q"><span>${icon("search", "solo")}</span><input id="bPopQ" spellcheck="false" autocomplete="off" placeholder="Filter branches…" aria-label="Filter branches" /><span class="u-spin" title="Reading the branches again"></span></div><div class="bp-list" id="bPopList" role="listbox"></div>`;
  bPopHtml = "";
  pop.classList.add("show");
  anchor.classList.add("open");
  setTimeout(() => ($("bPopQ") as HTMLInputElement)?.focus(), 20);
  const waiting = !Array.isArray(items);
  bPopItems = waiting ? kept ?? [] : items;
  bPopWaiting = waiting;
  bPopSel = pickSel(bPopItems, "", current);
  renderBranchPop();
  placeBranchPop();
  if (waiting) void items.catch(() => [] as BranchPick[]).then((list) => { if (gen === bPopGen) landBranchPop(list, current); });
}

/** The switch list of the checkout at `dir`, read again on every open. What it held last stands
 *  in meanwhile, and a pick off that is safe: `switch_branch` re-checks the target itself. */
export function openCheckoutPop(
  anchor: HTMLElement, dir: string, base: string | null, current: string,
  onPick: (row: BranchPick) => void, alive: () => boolean,
) {
  const kept = clampPickLists(readObj(LISTS_KEY))[dir]?.rows;
  const fresh = Promise.all([
    invoke<BranchInfo[]>("git_branch_list", { repoDir: dir, base }),
    invoke<WtHead[]>("worktree_heads", { dir }),
  ]).then(([branches, worktrees]) => {
    const rows = switchOptions(branches, worktrees, dir);
    if (rows.length) keepList(dir, rows);
    return rows;
  });
  openBranchPop(anchor, fresh, current, (_, row) => { if (alive()) onPick(row); }, undefined, kept && withCurrent(kept, current));
  // Only this open's own popover: by now the same element may be showing another project's.
  const gen = bPopGen;
  const settled = () => { if (gen === bPopGen && !alive()) closeBranchPop(false); };
  void fresh.then(settled, settled);
}

function keepList(dir: string, rows: BranchPick[]) {
  const next = rememberPicks(clampPickLists(readObj(LISTS_KEY)), dir, rows, Date.now());
  try { localStorage.setItem(LISTS_KEY, JSON.stringify(next)); } catch { /* a full store costs the next open its head start, nothing more */ }
}

function landBranchPop(list: BranchPick[], current: string) {
  const had = bPopItems.length > 0, under = bPopShown()[bPopSel]?.name ?? "";
  const box = $("bPopList"), top = box.scrollTop;
  // `git_branch_list` answers a failure with no rows, so none never takes away what is shown.
  if (list.length) bPopItems = list;
  bPopWaiting = false;
  // Something typed while the list was read still decides: the first match, as `input` picks.
  const typed = (($("bPopQ") as HTMLInputElement)?.value || "").trim();
  bPopSel = pickSel(bPopShown(), under, typed ? "" : current);
  renderBranchPop(!had);
  if (had) box.scrollTop = top;
  placeBranchPop();
}

// Anchor below the trigger, flipping above when that would run off the bottom.
function placeBranchPop() {
  const pop = $("bPop"), r = bPopRect, h = pop.offsetHeight;
  if (!r) return;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
}

function renderBranchPop(reveal = true) {
  const shown = bPopShown();
  if (bPopSel >= shown.length) bPopSel = Math.max(0, shown.length - 1);
  const list = $("bPopList");
  $("bPop").classList.toggle("reading", bPopWaiting);
  list.classList.toggle("wait", bPopWaiting && !bPopItems.length);
  list.setAttribute("aria-busy", String(bPopWaiting));
  const none = bPopWaiting ? "Reading branches…" : bPopItems.length ? "No branch matches that." : "No branches found.";
  const html = shown.length
    ? shown.map((i, n) => `<button class="mp-item${n === bPopSel ? " on" : ""}${i.disabled ? " dis" : ""}" type="button" role="option"`
        + ` aria-selected="${n === bPopSel}" aria-disabled="${!!i.disabled}"${i.disabled ? " disabled" : ""} data-bpick="${esc(i.name)}">`
        + `<span class="mp-ic">${glyphIcon(i.disabled ? "⊘" : i.ic || "⌥")}</span><span class="mp-main"><span class="mp-l">${esc(i.name)}</span>`
        + (i.note ? `<span class="mp-s">${esc(i.note)}</span>` : "")
        + `</span><span class="mp-check">${icon("check", "solo")}</span></button>`).join("")
    : `<div class="bp-none">${none}</div>`;
  // A re-read nearly always brings the same rows, and an assignment would eat a click landing on one.
  if (html !== bPopHtml) { list.innerHTML = html; bPopHtml = html; }
  if (reveal) list.querySelector(".mp-item.on")?.scrollIntoView({ block: "nearest" });
}

function bPopShown(): BranchPick[] {
  const q = (($("bPopQ") as HTMLInputElement)?.value || "").trim().toLowerCase();
  return bPopItems.filter((i) => !q || i.name.toLowerCase().includes(q));
}

/** Next choosable row in `dir`, or stay put: arrows step over the disabled entries. */
function bPopStep(shown: BranchPick[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (!shown[i].disabled) return i;
  return from;
}

export function closeBranchPop(refocus = true) {
  if (!bPopOpen()) return;
  bPopGen++;
  $("bPop").classList.remove("show");
  bPopAnchor?.classList.remove("open");
  bPopAnchor = null; bPopOn = null;
  const back = bPopBack; bPopBack = null;
  if (refocus) back?.();
}

function bPopPick(name: string) {
  const cb = bPopOn, row = bPopItems.find((i) => i.name === name)!;
  closeBranchPop();
  cb?.(name, row);
}

$("bPop").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bpick]");
  if (b) bPopPick(b.dataset.bpick!);
});
$("bPop").addEventListener("input", () => { bPopSel = pickSel(bPopShown(), "", ""); renderBranchPop(); });
$("bPop").addEventListener("keydown", (e) => {
  const shown = bPopShown();
  if (e.key === "ArrowDown") { e.preventDefault(); bPopSel = bPopStep(shown, bPopSel, 1); renderBranchPop(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); bPopSel = bPopStep(shown, bPopSel, -1); renderBranchPop(); }
  else if (e.key === "Enter") { e.preventDefault(); const p = shown[bPopSel]; if (p && !p.disabled) bPopPick(p.name); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBranchPop(); }
});
