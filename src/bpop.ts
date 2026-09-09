// The branch chooser: one picker for the worktree base, a checkout's switch target and the
// Branches view's trunk chip, in the .menupop idiom. At body level (#bPop) because .wtdlg is
// overflow:hidden; typing filters, since a repo can hold BRANCH_LIST_CAP refs.

// Its own module rather than the ⑃ dialog's: three surfaces open it, and the inspector
// reaching into worktree.ts for it would point an import the wrong way.

import { $ } from "./dom";
import { esc } from "./format";
import type { BranchPick } from "./branches";

let bPopItems: BranchPick[] = [];
let bPopSel = 0;
let bPopOn: ((name: string) => void) | null = null;
let bPopAnchor: HTMLElement | null = null;
// Where focus goes when the popover closes, when the opener had somewhere to send it.
let bPopBack: (() => void) | null = null;

export function bPopOpen() { return $("bPop").classList.contains("show"); }

export function openBranchPop(
  anchor: HTMLElement, items: BranchPick[], current: string,
  onPick: (name: string) => void, refocus?: () => void,
) {
  bPopItems = items; bPopOn = onPick; bPopAnchor = anchor; bPopBack = refocus ?? null;
  const at = items.findIndex((i) => i.name === current);
  bPopSel = at >= 0 && !items[at].disabled ? at : bPopFirst(items);
  const pop = $("bPop");
  pop.innerHTML = `<div class="bp-q"><span>❯</span><input id="bPopQ" spellcheck="false" autocomplete="off" placeholder="Filter branches…" aria-label="Filter branches" /></div><div class="bp-list" id="bPopList" role="listbox"></div>`;
  pop.classList.add("show");
  anchor.classList.add("open");
  renderBranchPop();
  // Anchor below the trigger, flipping above when that would run off the bottom.
  const r = anchor.getBoundingClientRect(), h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  setTimeout(() => ($("bPopQ") as HTMLInputElement)?.focus(), 20);
}

function renderBranchPop() {
  const q = (($("bPopQ") as HTMLInputElement)?.value || "").trim().toLowerCase();
  const shown = bPopItems.filter((i) => !q || i.name.toLowerCase().includes(q));
  if (bPopSel >= shown.length) bPopSel = Math.max(0, shown.length - 1);
  $("bPopList").innerHTML = shown.length
    ? shown.map((i, n) => `<button class="mp-item${n === bPopSel ? " on" : ""}${i.disabled ? " dis" : ""}" type="button" role="option"`
        + ` aria-selected="${n === bPopSel}" aria-disabled="${!!i.disabled}"${i.disabled ? " disabled" : ""} data-bpick="${esc(i.name)}">`
        + `<span class="mp-ic">${i.disabled ? "⊘" : i.ic || "⌥"}</span><span class="mp-main"><span class="mp-l">${esc(i.name)}</span>`
        + (i.note ? `<span class="mp-s">${esc(i.note)}</span>` : "")
        + `</span><span class="mp-check">✓</span></button>`).join("")
    : `<div class="bp-none">No branch matches that.</div>`;
  $("bPopList").querySelector(".mp-item.on")?.scrollIntoView({ block: "nearest" });
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

const bPopFirst = (shown: BranchPick[]) => { const i = shown.findIndex((x) => !x.disabled); return i < 0 ? 0 : i; };

export function closeBranchPop(refocus = true) {
  if (!bPopOpen()) return;
  $("bPop").classList.remove("show");
  bPopAnchor?.classList.remove("open");
  bPopAnchor = null; bPopOn = null;
  const back = bPopBack; bPopBack = null;
  if (refocus) back?.();
}

function bPopPick(name: string) { const cb = bPopOn; closeBranchPop(); cb?.(name); }

$("bPop").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bpick]");
  if (b) bPopPick(b.dataset.bpick!);
});
$("bPop").addEventListener("input", () => { bPopSel = bPopFirst(bPopShown()); renderBranchPop(); });
$("bPop").addEventListener("keydown", (e) => {
  const shown = bPopShown();
  if (e.key === "ArrowDown") { e.preventDefault(); bPopSel = bPopStep(shown, bPopSel, 1); renderBranchPop(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); bPopSel = bPopStep(shown, bPopSel, -1); renderBranchPop(); }
  else if (e.key === "Enter") { e.preventDefault(); const p = shown[bPopSel]; if (p && !p.disabled) bPopPick(p.name); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBranchPop(); }
});
