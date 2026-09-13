// One selection rule for every table in the app that has tick boxes: Branches, Checkouts,
// Advisories and Out of date. Pure — no DOM, no Tauri. ./dashview draws the controls,
// ./dashboard holds one `Pick` per table. See docs/dependencies.md.

/// The four tables that tick rows. A bare string here would let a view and the pane drift
/// apart silently, and the kind is the ONLY thing routing a click back to the right table.
export type PickKind = "branches" | "checkouts" | "advisories" | "stale";

/// What is ticked, and which row a shift-click measures from. The anchor lives beside the
/// set rather than in a module variable, so two tables on screen cannot share one by accident.
export interface Pick { picked: Set<string>; anchor: string }

export const emptyPick = (): Pick => ({ picked: new Set(), anchor: "" });

/** Everything between two keys in the order on screen, inclusive of both. */
export function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from), b = order.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [to];   // the anchor has scrolled out of the filter; take the row clicked
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export interface PickCtx {
  order: readonly string[];         // the rows as they are on screen, which is what a range means
  pickable: ReadonlySet<string>;    // an off row is shown for its reason and never ticked
  range?: boolean;                  // shift was held
}

/**
 * One click on one row. Plain: toggle. Shift: take the range from the anchor and **add**
 * rather than toggle — a range that flipped each row would undo half of itself. Either way
 * the anchor moves to the row clicked, so a second shift-click measures from here.
 */
export function applyPick(cur: Pick, key: string, o: PickCtx): Pick {
  if (!o.pickable.has(key)) return cur;
  const picked = new Set(cur.picked);
  if (o.range && cur.anchor && cur.anchor !== key) {
    for (const n of rangeBetween(o.order, cur.anchor, key)) {
      if (o.pickable.has(n)) picked.add(n);
    }
  } else if (picked.has(key)) picked.delete(key);
  else picked.add(key);
  return { picked, anchor: key };
}

/// How a shift-range landed. Most branches are not deletable, so a range over ten rows
/// routinely ticks two — and saying nothing there reads exactly like the range having failed.
export function rangeOutcome(o: PickCtx, from: string, to: string): { took: number; refused: number } {
  const span = rangeBetween(o.order, from, to);
  const refused = span.filter((k) => !o.pickable.has(k)).length;
  return { took: span.length - refused, refused };
}

export type PickState = "none" | "some" | "all";

/// What the header tick shows. "all" means every *pickable row on screen* is ticked, so a
/// filter that hides a ticked row cannot make the box read as less than full.
export function pickState(o: PickCtx, picked: ReadonlySet<string>): PickState {
  const shown = [...o.pickable].filter((k) => o.order.includes(k));
  if (!shown.length) return "none";
  const on = shown.filter((k) => picked.has(k)).length;
  return on === 0 ? "none" : on === shown.length ? "all" : "some";
}

/** The header tick and the `All` button: tick every pickable row the filter is showing. */
export function pickAll(cur: Pick, o: PickCtx): Pick {
  const picked = new Set(cur.picked);
  for (const k of o.order) if (o.pickable.has(k)) picked.add(k);
  return { picked, anchor: cur.anchor };
}

/// `None` clears the anchor too: it is a fresh start, and a range measured from a row you
/// have just unticked reads as a bug rather than as a feature.
export const pickNone = (): Pick => emptyPick();

/** The header tick is one control: full means clear what is shown, anything else means take it. */
export function togglePickAll(cur: Pick, o: PickCtx): Pick {
  if (pickState(o, cur.picked) !== "all") return pickAll(cur, o);
  const picked = new Set(cur.picked);
  for (const k of o.order) picked.delete(k);
  return { picked, anchor: "" };
}
