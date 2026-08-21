import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The delegated click dispatcher's one failure mode, made impossible.
//
// main.ts routes every `[data-*]` click through ONE `closest()` call and then an
// if-chain over `el.dataset.*`. The two halves have to agree: a branch whose attribute
// is missing from the selector is **unreachable**, because `closest()` returns null and
// the handler returns before reaching it.
//
// Nothing else catches this. `tsc` is happy — `el.dataset.dash` is a valid string
// lookup. Every unit test is happy — the modules underneath work fine. The feature is
// simply dead, silently, and only clicking it in the running app finds out.
//
// That is exactly how the project dashboard shipped in 0.13.0 with its entry point
// disconnected: `data-dash` was on the sidebar header and in the if-chain, but not in
// the selector. This test is the reason that cannot happen twice.

const MAIN = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

/// `data-driftfollow` → `driftfollow`, matching how the DOM lowercases dataset keys.
const attrToKey = (attr: string) => attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** The one big `closest()` in the click handler, as a list of attribute names. */
function selectorAttrs(): string[] {
  const m = /const el = t\.closest<HTMLElement>\("([^"]+)"\)/.exec(MAIN);
  if (!m) throw new Error("could not find the click dispatcher's closest() call in main.ts");
  return m[1].split(",").map((s) => s.trim().replace(/^\[|\]$/g, ""));
}

/**
 * Every `el.dataset.X` the if-chain **branches on** — the condition position only.
 *
 * The distinction is the whole test. `el.dataset.permid`, `gitsid`, `difftitle`, `proj`,
 * `root` and `branch` are *payload*, read off an element that has already matched on a
 * different attribute; they must NOT be in the selector, and requiring them there would
 * make every one of them a click target in its own right.
 */
function branchKeys(): string[] {
  const start = MAIN.indexOf("const el = t.closest<HTMLElement>(");
  const end = MAIN.indexOf("});", start);
  const body = MAIN.slice(start, end);
  const keys = new Set<string>();
  for (const m of body.matchAll(/(?:^\s*|\belse\s+)if\s*\(\s*el\.dataset\.([A-Za-z0-9_]+)\s*\)/gm)) keys.add(m[1]);
  return [...keys];
}

describe("the delegated click dispatcher", () => {
  const attrs = selectorAttrs();
  const selectorKeys = new Set(attrs.map(attrToKey));
  const branches = branchKeys();

  it("finds a selector and an if-chain to compare", () => {
    expect(attrs.length).toBeGreaterThan(10);
    expect(branches.length).toBeGreaterThan(10);
  });

  it("has NO unreachable branch — every dataset key it tests for is in the selector", () => {
    // The failing case reads: `dash` is branched on but [data-dash] is not selected.
    const unreachable = branches.filter((k) => !selectorKeys.has(k));
    expect(unreachable, `unreachable branch(es): ${unreachable.map((k) => `el.dataset.${k} (add [data-${k}] to the selector)`).join(", ")}`).toEqual([]);
  });

  it("selects nothing it never dispatches — a dead entry swallows clicks", () => {
    // The mirror image, and it is not harmless: an attribute in the selector with no
    // branch makes `closest()` match that element and then fall through every branch,
    // so the click is consumed and whatever it was nested inside never fires.
    //
    // `data-proj`, `data-root` and `data-branch` are deliberately absent from the
    // selector for this reason — they are payload read off a matched element, never a
    // target themselves.
    const undispatched = [...selectorKeys].filter((k) => !branches.includes(k));
    expect(undispatched, `selected but never dispatched: ${undispatched.join(", ")}`).toEqual([]);
  });

  it("routes the project header to the dashboard", () => {
    // The specific regression: clicking a project must open its dashboard. Both the
    // attribute the sidebar writes and the branch that acts on it have to exist.
    const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    expect(sidebar).toContain('data-dash=');
    expect(selectorKeys.has("dash")).toBe(true);
    expect(branches).toContain("dash");
  });
});

// The same failure class, one level down: the project dashboard's own dispatcher.
//
// `dashview.ts` writes `data-dashact="<verb>"` from two helpers (the inspector's rows
// and the 44px rail ⌘I collapses to), and `dashboard.ts`'s `dashAction` is an if-chain
// over the string. Nothing joins the two but the spelling. A row whose verb has no
// branch is a button that does nothing when clicked, and a branch nobody emits is code
// that cannot run — both invisible to `tsc`, to every other suite, and to a reader of
// either file alone, which is precisely the shape that took the dashboard's own entry
// point down for two releases.

const DASHVIEW = readFileSync(new URL("../src/dashview.ts", import.meta.url), "utf8");
const DASHBOARD = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

/** The body of a top-level function, from its signature to the next unindented `}`. */
function body(src: string, decl: string): string {
  const start = src.indexOf(decl);
  if (start < 0) throw new Error(`could not find ${decl}`);
  const end = src.indexOf("\n}", start);
  if (end < 0) throw new Error(`could not find the end of ${decl}`);
  return src.slice(start, end);
}

/// Both surfaces build their markup through a one-line local helper whose FIRST argument
/// is the verb, so the verb is read from the call rather than from the attribute: the
/// attribute itself is `data-dashact="${a}"` in the helper and carries no literal.
const verbs = (src: string, decl: string, helper: string): string[] => {
  const re = new RegExp(`\\b${helper}\\("([a-z]+)"`, "g");
  return [...new Set([...body(src, decl).matchAll(re)].map((m) => m[1]))];
};

describe("the project dashboard's verbs", () => {
  const rows = verbs(DASHVIEW, "export function dashInspector(", "act");
  const rail = verbs(DASHVIEW, "export function dashStrip(", "b");
  // The third surface, and the reason this is worth a test rather than a convention:
  // the git verbs live in a card in the overview column, dispatched by a *different*
  // listener from the two above (`#dashPane`, not `#inspector`/`#dashStrip`) into the
  // same if-chain. Three emitters, two listeners, one vocabulary.
  const gcard = verbs(DASHVIEW, "export function repoCard(", "gb");
  const offered = [...new Set([...rows, ...rail, ...gcard])];
  const handled = [...new Set(
    [...body(DASHBOARD, "function dashAction(act: string): void {")
      .matchAll(/act === "([a-z]+)"/g)].map((m) => m[1]),
  )];

  it("finds all three surfaces and the if-chain to compare", () => {
    expect(rows.length).toBeGreaterThan(5);
    expect(rail.length).toBeGreaterThan(4);
    expect(gcard.length).toBeGreaterThan(3);
    expect(handled.length).toBeGreaterThan(5);
  });

  it("has no dead button — every verb any surface offers is dispatched", () => {
    const dead = offered.filter((v) => !handled.includes(v));
    expect(dead, `offered but never dispatched: ${dead.join(", ")}`).toEqual([]);
  });

  it("has no unreachable branch — every verb dispatched is offered somewhere", () => {
    const orphan = handled.filter((v) => !offered.includes(v));
    expect(orphan, `dispatched but on no surface: ${orphan.join(", ")}`).toEqual([]);
  });

  it("routes the card's clicks, which are not the inspector's listener", () => {
    // `#inspector` and `#dashStrip` share one handler; the card is in `#dashPane`, whose
    // handler is a different function in a different place. A card verb with no
    // [data-dashact] branch there is five dead buttons that read as a broken git card.
    const pane = DASHBOARD.slice(DASHBOARD.indexOf('$("dashPane").addEventListener'));
    expect(pane.slice(0, pane.indexOf("\n  });"))).toContain('closest<HTMLElement>("[data-dashact]")');
  });

  it("keeps the rail inside the panel's verb set", () => {
    // ⌘I collapses the dashboard's inspector to the rail rather than hiding it, because
    // these verbs live nowhere else. So the rail may carry FEWER (it has room for a
    // glyph and a tooltip, nothing more), never a verb the expanded panel lacks: a
    // button reachable only while collapsed is a button nobody finds.
    const railOnly = rail.filter((v) => !rows.includes(v));
    expect(railOnly, `on the rail but not in the panel: ${railOnly.join(", ")}`).toEqual([]);
  });
});
