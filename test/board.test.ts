import { describe, it, expect, beforeEach } from "vitest";
import { store } from "./localstorage"; // must precede the subject import
import type { Sess } from "../src/types";
import {
  cardBrief, cardForSession, cardLinks, cardsIn, linkCard, liveSession, needsRenumber,
  orderFor, ORDER_GAP, reloadLinks, renumber, unlinkCard, wipFull, type Card,
} from "../src/board";

const card = (over: Partial<Card> & { id: string }): Card => ({
  title: "a card", status: "ready", labels: [], assignee: null, branch: null,
  order: 1000, created: null, body: "", source_file: ".episko/board/x.md", ...over,
});

beforeEach(() => {
  store.clear();
  reloadLinks();
  for (const k of Object.keys(cardLinks)) delete cardLinks[k];
});

describe("ordering is sparse so a move rewrites ONE file", () => {
  const col = [
    card({ id: "a", order: 1000 }),
    card({ id: "b", order: 2000 }),
    card({ id: "c", order: 3000 }),
  ];

  it("drops between two neighbours at their midpoint", () => {
    expect(orderFor(col, "ready", 1)).toBe(1500);
    expect(orderFor(col, "ready", 2)).toBe(2500);
  });

  it("appends one gap past the end", () => {
    expect(orderFor(col, "ready", 3)).toBe(3000 + ORDER_GAP);
    expect(orderFor([], "ready", 0)).toBe(ORDER_GAP);
  });

  it("halves at the head rather than marching negative", () => {
    // `first - GAP` would go 0, -1000, -2000… and eventually collide. Halving always
    // leaves room, which is the property the sparse scheme depends on.
    expect(orderFor(col, "ready", 0)).toBe(500);
    let cards = col;
    for (let i = 0; i < 5; i++) {
      const o = orderFor(cards, "ready", 0);
      expect(o).toBeGreaterThan(0);
      cards = [card({ id: `h${i}`, order: o }), ...cards];
    }
  });

  it("ignores the moving card's own position when computing its new one", () => {
    // `index` is a position in the column WITH the moving card removed — otherwise
    // dragging a card one slot down lands it back where it started, because its own
    // order is still counted as a neighbour. So with `a` lifted the column is [b, c],
    // and index 2 is the end of it.
    expect(orderFor(col, "ready", 2, "a")).toBe(3000 + ORDER_GAP);
    expect(orderFor(col, "ready", 1, "b")).toBe(2000); // between a and c
  });

  it("clamps an index past either end instead of producing NaN", () => {
    expect(orderFor(col, "ready", 99)).toBe(4000);
    expect(orderFor(col, "ready", -3)).toBe(500);
  });

  it("sorts a column totally, so two repaints agree", () => {
    const tied = [card({ id: "z", order: 1000 }), card({ id: "a", order: 1000 })];
    expect(cardsIn(tied, "ready").map((c) => c.id)).toEqual(["a", "z"]);
  });
});

describe("renumbering is the last resort, not the default", () => {
  it("stays quiet while there is room", () => {
    expect(needsRenumber([card({ id: "a", order: 1000 }), card({ id: "b", order: 2000 })], "ready")).toBe(false);
  });

  it("fires only once a gap closes below 2", () => {
    expect(needsRenumber([card({ id: "a", order: 1000 }), card({ id: "b", order: 1001 })], "ready")).toBe(true);
  });

  it("respaces evenly when it does", () => {
    const cards = [card({ id: "a", order: 1000 }), card({ id: "b", order: 1001 }), card({ id: "c", order: 1002 })];
    expect(renumber(cards, "ready")).toEqual([
      { id: "a", order: 1000 }, { id: "b", order: 2000 }, { id: "c", order: 3000 },
    ]);
  });
});

describe("the live link is machine-local and self-healing", () => {
  const sessions = new Map<string, Sess>([["s1", { id: "s1" } as Sess]]);

  it("finds the pane working a card", () => {
    linkCard("k3f9a2", "s1");
    expect(liveSession("k3f9a2", sessions)?.id).toBe("s1");
    expect(cardForSession("s1")).toBe("k3f9a2");
  });

  it("prunes a link whose session is gone, rather than showing a phantom in-flight", () => {
    // The reason this is derived state and not a committed field: after a restart
    // every link is stale, and the board must heal itself rather than lie.
    linkCard("k3f9a2", "dead");
    expect(liveSession("k3f9a2", sessions)).toBeNull();
    expect(cardLinks["k3f9a2"]).toBeUndefined();
  });

  it("persists, and never touches the card file", () => {
    linkCard("k3f9a2", "s1");
    expect(JSON.parse(store.get("cc-board-links")!)).toEqual({ k3f9a2: "s1" });
    unlinkCard("k3f9a2");
    expect(JSON.parse(store.get("cc-board-links")!)).toEqual({});
  });

  it("degrades on a corrupt store", () => {
    store.set("cc-board-links", "[not an object]");
    reloadLinks();
    expect(cardForSession("s1")).toBeNull();
  });
});

describe("WIP is a hint the UI shows, not a rule the file enforces", () => {
  const cards = [card({ id: "a", status: "doing" }), card({ id: "b", status: "doing" })];
  it("counts the column and honours 0 as no limit", () => {
    expect(wipFull(cards, { id: "doing", label: "In flight", wip: 2 })).toBe(true);
    expect(wipFull(cards, { id: "doing", label: "In flight", wip: 3 })).toBe(false);
    expect(wipFull(cards, { id: "doing", label: "In flight", wip: 0 })).toBe(false);
  });
});

describe("the brief handed to a dispatched agent", () => {
  it("is the title plus the body, where the acceptance criteria live", () => {
    expect(cardBrief(card({ id: "a", title: "Board MCP server", body: "## Goal\nExpose board_* tools." })))
      .toBe("Board MCP server\n\n## Goal\nExpose board_* tools.");
  });
  it("falls back to the title alone", () => {
    expect(cardBrief(card({ id: "a", title: "Just this", body: "  \n " }))).toBe("Just this");
  });
});
