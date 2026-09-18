// One popover menu for the whole app: it owns the element, where it sits, the keyboard and how
// it goes away; a caller owns only what is in it. Separators are STRUCTURAL — a rule between two
// groups drawn by CSS — so a menu cannot put a line beside nothing, which a row list carrying its
// own `null` separators can and did. No Back row either: a popover is dismissed, not navigated
// out of, and the thing it belonged to is still on screen behind it.

import { $ } from "./dom";
import { esc, escAttr } from "./format";

export interface MenuItem {
  id: string;
  label: string;
  sub?: string;
  /** Leading slot: a tick for the chosen one, a glyph for anything else. */
  mark?: string;
  /** Inline SVG markup (./providers/logos), NOT a url and NOT escaped — a fixed table, never user text. */
  logo?: string;
  /** Shown, never picked — the reason a row is here is usually the point (`not on PATH`). */
  disabled?: boolean;
  danger?: boolean;
}

/** A group with no items is dropped, so a caller may build one unconditionally. */
export interface MenuGroup { label?: string; items: MenuItem[] }

export interface MenuSpec {
  title: string;
  sub?: string;
  /** The swatch beside the title; omit for a menu that is not about one project. */
  accent?: string;
  groups: MenuGroup[];
  onPick: (id: string) => void;
}

let spec: MenuSpec | null = null;
let live: MenuItem[] = [];   // pickable items only, in view order, for the arrow keys
let cursor = -1;

const el = () => $("menuPop");

export const menuOpen = () => !el().hidden;

export function closeMenu(): void {
  const m = el();
  if (m.hidden) return;
  m.hidden = true;
  m.innerHTML = "";
  spec = null;
  live = [];
  cursor = -1;
}

function itemHtml(i: MenuItem, idx: number): string {
  const mark = i.logo
    ? `<span class="mn-mk agent-logo" aria-hidden="true">${i.logo}</span>`
    : `<span class="mn-mk">${i.mark ? esc(i.mark) : ""}</span>`;
  const cls = `mn-i${i.disabled ? " dis" : ""}${i.danger ? " danger" : ""}`;
  return `<button class="${cls}" role="menuitem"${i.disabled ? " disabled" : ""}`
    + `${i.disabled ? "" : ` data-mi="${escAttr(i.id)}" data-idx="${idx}"`}>${mark}`
    + `<span class="mn-b"><span class="mn-l">${esc(i.label)}</span>`
    + (i.sub ? `<span class="mn-s2">${esc(i.sub)}</span>` : "") + `</span></button>`;
}

/** `at` is the control the menu belongs to; it opens under it and flips up when there is no room. */
export function openMenu(at: HTMLElement | DOMRect, s: MenuSpec): void {
  const groups = s.groups.filter((g) => g.items.length);
  if (!groups.length) return;
  spec = s;
  live = [];
  cursor = -1;
  const m = el();
  let idx = 0;
  const body = groups.map((g) =>
    `<div class="mn-g">${g.label ? `<span class="mn-gl">${esc(g.label)}</span>` : ""}`
    + g.items.map((i) => {
      if (i.disabled) return itemHtml(i, -1);
      live.push(i);
      return itemHtml(i, idx++);
    }).join("") + `</div>`).join("");
  m.innerHTML = `<div class="mn-head">`
    + (s.accent ? `<span class="mn-sw" style="background:${escAttr(s.accent)}"></span>` : "")
    + `<span class="mn-hb"><span class="mn-t">${esc(s.title)}</span>`
    + (s.sub ? `<span class="mn-s">${esc(s.sub)}</span>` : "") + `</span></div>${body}`;
  m.hidden = false;

  // Measured after it is visible, or every box is 0. Below the control by default; above when
  // that would run off the bottom; clamped so it can never leave the window on either side.
  const a = at instanceof HTMLElement ? at.getBoundingClientRect() : at;
  const r = m.getBoundingClientRect();
  const below = a.bottom + 6;
  m.style.top = `${below + r.height <= window.innerHeight - 8 ? below : Math.max(8, a.top - r.height - 6)}px`;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, a.left))}px`;
}

function move(d: number): void {
  if (!live.length) return;
  cursor = (cursor + d + live.length) % live.length;
  const rows = el().querySelectorAll<HTMLElement>(".mn-i[data-mi]");
  rows.forEach((r, i) => r.classList.toggle("on", i === cursor));
  rows[cursor]?.scrollIntoView({ block: "nearest" });
}

// Wired from main.ts, never at module scope: vitest's node environment has no `document`.
export function wireMenu(): void {
  el().addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".mn-i[data-mi]");
    if (!row) return;
    const pick = spec?.onPick;
    const id = row.dataset.mi!;
    closeMenu();          // before the callback: a pick may open the next menu
    pick?.(id);
  });
  // Capture, so Escape closes the menu rather than whatever dialog is behind it, and the arrow
  // keys never reach a pane. Only while one is open — otherwise this is inert.
  document.addEventListener("keydown", (e) => {
    if (!menuOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeMenu(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopImmediatePropagation(); move(e.key === "ArrowDown" ? 1 : -1); return;
    }
    if (e.key === "Enter" && cursor >= 0) {
      e.preventDefault(); e.stopImmediatePropagation();
      const pick = spec?.onPick, id = live[cursor]?.id;
      closeMenu();
      if (id) pick?.(id);
    }
  }, true);
  // A click anywhere else dismisses it. Pointerdown, not click, so a drag that starts outside
  // does not leave it open behind the thing being dragged.
  document.addEventListener("pointerdown", (e) => {
    if (menuOpen() && !(e.target as HTMLElement).closest("#menuPop")) closeMenu();
  });
  // A wheel over the page scrolls the anchor out from under the menu; a wheel over the MENU is
  // how you reach the rows below the fold. Only the first is a reason to close.
  window.addEventListener("wheel", (e) => {
    if (menuOpen() && !(e.target as HTMLElement).closest("#menuPop")) closeMenu();
  }, { passive: true });
  window.addEventListener("resize", () => closeMenu());
}
