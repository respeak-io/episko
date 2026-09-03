import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// main.ts routes every `[data-*]` click through one `closest()` selector and an if-chain
// over `el.dataset.*`. A branch whose attribute is not in the selector is unreachable, and
// nothing but this test catches it: `tsc` and every unit test stay green (CLAUDE.md's `[data-*]` rule).

const MAIN = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

// `data-driftfollow` → `driftfollow`, as the DOM derives dataset keys.
const attrToKey = (attr: string) => attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function selectorAttrs(): string[] {
  const m = /const el = t\.closest<HTMLElement>\("([^"]+)"\)/.exec(MAIN);
  if (!m) throw new Error("could not find the click dispatcher's closest() call in main.ts");
  return m[1].split(",").map((s) => s.trim().replace(/^\[|\]$/g, ""));
}

// Only the condition position counts: `el.dataset.permid` and friends are payload read off
// an element that already matched, and must NOT be in the selector.
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
    const unreachable = branches.filter((k) => !selectorKeys.has(k));
    expect(unreachable, `unreachable branch(es): ${unreachable.map((k) => `el.dataset.${k} (add [data-${k}] to the selector)`).join(", ")}`).toEqual([]);
  });

  it("selects nothing it never dispatches — a dead entry swallows clicks", () => {
    const undispatched = [...selectorKeys].filter((k) => !branches.includes(k));
    expect(undispatched, `selected but never dispatched: ${undispatched.join(", ")}`).toEqual([]);
  });

  it("routes the project header to the dashboard", () => {
    const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    expect(sidebar).toContain('data-dash=');
    expect(selectorKeys.has("dash")).toBe(true);
    expect(branches).toContain("dash");
  });
});

// The same join one level down: `dashview.ts` writes `data-dashact="<verb>"` and
// `dashboard.ts`'s `dashAction` is an if-chain over the string; only the spelling joins them.

const DASHVIEW = readFileSync(new URL("../src/dashview.ts", import.meta.url), "utf8");
const DASHBOARD = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

function body(src: string, decl: string): string {
  const start = src.indexOf(decl);
  if (start < 0) throw new Error(`could not find ${decl}`);
  const end = src.indexOf("\n}", start);
  if (end < 0) throw new Error(`could not find the end of ${decl}`);
  return src.slice(start, end);
}

// The verb is read off the helper call, not the attribute: in the helper it is
// `data-dashact="${a}"` and carries no literal.
const verbs = (src: string, decl: string, helper: string): string[] => {
  const re = new RegExp(`\\b${helper}\\("([a-z]+)"`, "g");
  return [...new Set([...body(src, decl).matchAll(re)].map((m) => m[1]))];
};

describe("the project dashboard's verbs", () => {
  const rows = verbs(DASHVIEW, "export function dashInspector(", "act");
  const rail = verbs(DASHVIEW, "export function dashStrip(", "b");
  // The git card is dispatched by a different listener (`#dashPane`) into the same if-chain.
  const gcard = verbs(DASHVIEW, "export function repoCard(", "gb");
  // The GitHub picker writes its one fixed verb straight into the attribute; its
  // `ghacct:<login>` buttons are matched by prefix and invisible to both halves.
  const ghpick = [...new Set(
    [...body(DASHVIEW, "export function ghPicker(").matchAll(/data-dashact="([a-z]+)"/g)].map((m) => m[1]),
  )];
  const offered = [...new Set([...rows, ...rail, ...gcard, ...ghpick])];
  const handled = [...new Set(
    [...body(DASHBOARD, "function dashAction(act: string): void {")
      .matchAll(/act === "([a-z]+)"/g)].map((m) => m[1]),
  )];

  // Every surface is checked, or one that stopped matching would quietly shrink `offered`
  // and the two comparisons below would pass over a hole.
  it("finds all four surfaces and the if-chain to compare", () => {
    expect(rows.length).toBeGreaterThan(5);
    expect(rail.length).toBeGreaterThan(4);
    expect(gcard.length).toBeGreaterThan(3);
    expect(ghpick.length).toBeGreaterThan(0);
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
    const pane = DASHBOARD.slice(DASHBOARD.indexOf('$("dashPane").addEventListener'));
    expect(pane.slice(0, pane.indexOf("\n  });"))).toContain('closest<HTMLElement>("[data-dashact]")');
  });

  it("keeps the rail inside the panel's verb set", () => {
    // The rail may carry fewer verbs than the expanded panel, never one the panel lacks:
    // a button reachable only while collapsed is a button nobody finds.
    const railOnly = rail.filter((v) => !rows.includes(v));
    expect(railOnly, `on the rail but not in the panel: ${railOnly.join(", ")}`).toEqual([]);
  });
});

// The same join in the one popover that does not route through main.ts: `serversui.ts` owns its
// own `#svrPop` listener, a chain of `closest()` probes. `.sv-head` is the row's whole background,
// so `closest("[data-svtoggle]")` matches a click on ANY control there; it must stay probed last.

const SV = readFileSync(new URL("../src/serversui.ts", import.meta.url), "utf8");

describe("the servers popover's own dispatcher", () => {
  // Payload read off an element that already matched (the ✕ carries both `data-svstop`
  // and `data-svsid`), never a probe target of its own.
  const PAYLOAD = new Set(["sid"]);
  const emitted = [...SV.matchAll(/data-sv([a-z]+)="/g)].map((m) => m[1]);
  const probed = [...SV.matchAll(/closest<HTMLElement>\("\[data-sv([a-z]+)\]"\)/g)].map((m) => m[1]);

  it("finds both halves", () => {
    // A regex that has stopped matching would pass every assertion below vacuously.
    expect(emitted.length).toBeGreaterThan(5);
    expect(probed.length).toBeGreaterThan(5);
  });

  it("emits no attribute it never probes for — that is a button that does nothing", () => {
    const dead = [...new Set(emitted.filter((k) => !probed.includes(k) && !PAYLOAD.has(k)))];
    expect(dead, `emitted but never probed: ${dead.map((k) => `data-sv${k}`).join(", ")}`).toEqual([]);
  });

  it("probes for nothing it never emits — a stale probe swallows the click below it", () => {
    const orphan = probed.filter((k) => !emitted.includes(k));
    expect(orphan, `probed but never emitted: ${orphan.map((k) => `data-sv${k}`).join(", ")}`).toEqual([]);
  });

  it("probes the row expander LAST, because it is the row's whole background", () => {
    expect(probed).toContain("toggle");
    expect(
      probed.indexOf("toggle"),
      `[data-svtoggle] is probed at position ${probed.indexOf("toggle")} of ${probed.length}; everything after it (${probed.slice(probed.indexOf("toggle") + 1).join(", ")}) is unreachable`,
    ).toBe(probed.length - 1);
  });
});
