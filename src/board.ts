// The board's rules — where a card lands when you move it, and which card a live pane
// belongs to. No DOM and no Tauri, so it unit-tests like ./thread and ./trail;
// ./boardui owns the markup.
//
// WHY THIS IS EPISKO'S AND NOT A PLUGIN'S. Every other board shows a card that *claims*
// someone is working. This one owns the process, so a card in flight can show the tool
// running right now, the context used and the spend — because the pane is right there.
// That link is the feature, and it is also the thing that must never be committed: a
// session uuid means nothing to a teammate (RFC rule 3), so it lives in localStorage
// and is re-derived on load.

import type { Sess } from "./types";

export interface Card {
  id: string;
  title: string;
  status: string;
  labels: string[];
  assignee: string | null;
  branch: string | null;
  order: number;
  created: string | null;
  body: string;
  source_file: string;
}

export interface BoardColumn { id: string; label: string; wip: number }
export interface BoardData { columns: BoardColumn[]; cards: Card[]; exists: boolean }

/// Matches the backend's ORDER_GAP. Sparse on purpose: inserting between two
/// neighbours is a midpoint away, so a move rewrites ONE file and two people
/// reordering different columns never touch the same bytes.
export const ORDER_GAP = 1000;

/** A column's cards, in display order. Total, so a repaint never reshuffles. */
export function cardsIn(cards: Card[], status: string): Card[] {
  return cards
    .filter((c) => c.status === status)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The `order` a card should take when dropped into `status` at `index`.
 *
 * Midpoint between its new neighbours; one gap beyond the end when appended; half the
 * first card's order when placed at the head. The head case matters — `first - GAP`
 * would march negative and eventually collide, while halving always leaves room.
 *
 * `index` is a position in the column **with `movingId` already removed**. Counting a
 * card as its own neighbour is what makes "drag one slot down" a no-op, so the caller
 * passes the index it wants in the lifted column, not in the one on screen.
 */
export function orderFor(cards: Card[], status: string, index: number, movingId?: string): number {
  const col = cardsIn(cards, status).filter((c) => c.id !== movingId);
  const at = Math.max(0, Math.min(index, col.length));
  const before = col[at - 1];
  const after = col[at];
  if (!before && !after) return ORDER_GAP;
  if (!before) return Math.round(after.order / 2);
  if (!after) return before.order + ORDER_GAP;
  return Math.round((before.order + after.order) / 2);
}

/**
 * True when a column has closed up so tightly that the next insert has nowhere to go.
 *
 * The RFC's escape hatch: renumber a column only when a gap falls below 2, because
 * renumbering rewrites every file in it and is exactly the multi-file write the sparse
 * scheme exists to avoid.
 */
export function needsRenumber(cards: Card[], status: string): boolean {
  const col = cardsIn(cards, status);
  for (let i = 1; i < col.length; i++) {
    if (col[i].order - col[i - 1].order < 2) return true;
  }
  return false;
}

/** Fresh, evenly spaced orders for one column — used only when `needsRenumber`. */
export function renumber(cards: Card[], status: string): { id: string; order: number }[] {
  return cardsIn(cards, status).map((c, i) => ({ id: c.id, order: (i + 1) * ORDER_GAP }));
}

// ---------- the live link ----------
// Which pane is working which card. Machine-local by definition (RFC rule 3), so it is
// a localStorage map rather than a field on the card.

const LINK = "cc-board-links";
type LinkMap = Record<string, string>; // cardId -> sessionId

function readLinks(): LinkMap {
  try {
    const raw = JSON.parse(localStorage.getItem(LINK) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
export let cardLinks: LinkMap = readLinks();
function saveLinks() { localStorage.setItem(LINK, JSON.stringify(cardLinks)); }

export function linkCard(cardId: string, sessionId: string): void {
  cardLinks[cardId] = sessionId;
  saveLinks();
}
export function unlinkCard(cardId: string): void {
  delete cardLinks[cardId];
  saveLinks();
}
/** The card a session is working, if any — what an exit needs in order to move it on. */
export function cardForSession(sessionId: string): string | null {
  return Object.keys(cardLinks).find((c) => cardLinks[c] === sessionId) ?? null;
}

/**
 * The live pane for a card, if it is still running.
 *
 * Prunes as it reads: a link whose session has gone is dropped, so a card cannot show
 * a phantom "in flight" after a restart. That self-healing is why the link is derived
 * state and not a committed field.
 */
export function liveSession(cardId: string, sessions: Map<string, Sess>): Sess | null {
  const sid = cardLinks[cardId];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) { unlinkCard(cardId); return null; }
  return s;
}

/// Test seam, matching ./notes and ./claim.
export function reloadLinks(): void { cardLinks = readLinks(); }

// ---------- WIP ----------

/**
 * Is this column full?
 *
 * Counts the cards actually in it, and 0 means no limit. Deliberately a *hint the UI
 * shows*, not something the backend enforces — the board is a shared file, and a limit
 * one person's client refuses to exceed is not a limit at all.
 */
export function wipFull(cards: Card[], col: BoardColumn): boolean {
  return col.wip > 0 && cardsIn(cards, col.id).length >= col.wip;
}

/// The brief handed to an agent dispatched at a card: its title and its body. The
/// title alone is rarely enough, and the body is where the acceptance criteria live.
export function cardBrief(c: Card): string {
  const body = c.body.trim();
  return body ? `${c.title}\n\n${body}` : c.title;
}
