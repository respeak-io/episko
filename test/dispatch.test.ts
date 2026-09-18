import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

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

// A footer popover's quick open writes `data-fgo="<target>"`, and main.ts's `openFootTarget`
// resolves anything but "usage" as a Settings tab id. A misspelt id is silent: `renderSettings`
// falls back to `SET_TABS[0]`, so the link opens Appearance and looks like it worked.

const SETTINGS_SRC = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const FOOTERVIEW = readFileSync(new URL("../src/footerview.ts", import.meta.url), "utf8");
// Every module that composes a popGoHtml() row. The target is read off the call, like the
// dashboard's verbs below: in the helper the attribute is `data-fgo="${l.go}"` and carries
// no literal of its own.
const GO_FILES = ["footer.ts", "footerview.ts", "usageview.ts", "settings.ts"];

describe("the footer popovers' quick opens", () => {
  const tabs = [...SETTINGS_SRC.matchAll(/id: "(\w+)", label: "[^"]+"/g)].map((m) => m[1]);
  const targets = [...new Set(GO_FILES.flatMap((f) =>
    [...readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
      .matchAll(/\{ go: "([a-z]+)", label:/g)].map((m) => m[1])))];

  it("finds the tabs and the links to compare", () => {
    expect(tabs.length).toBeGreaterThan(5);
    expect(targets.length).toBeGreaterThan(1);
    // The one place the target becomes the attribute; if this moves, the scan above is blind.
    expect(FOOTERVIEW).toContain('data-fgo="${esc(l.go)}"');
  });

  it("opens a Settings tab that exists, or the one window of its own", () => {
    const bad = targets.filter((t) => t !== "usage" && !tabs.includes(t));
    expect(bad, `data-fgo target(s) naming no Settings tab: ${bad.join(", ")}`).toEqual([]);
  });

  it("no longer sends anyone to a Usage tab — that panel is its own dialog", () => {
    expect(tabs).not.toContain("usage");
    expect(SETTINGS_SRC).not.toContain("usagePanelHtml");
  });
});

// The same join one level down: `dashview.ts` writes `data-dashact="<verb>"` and
// `dashboard.ts`'s `dashAction` is an if-chain over the string; only the spelling joins them.

const DASHVIEW = readFileSync(new URL("../src/dashview.ts", import.meta.url), "utf8");
const DEPSVIEW = readFileSync(new URL("../src/depsview.ts", import.meta.url), "utf8");
const LANDEDVIEW = readFileSync(new URL("../src/landedview.ts", import.meta.url), "utf8");
const ISSUEVIEW = readFileSync(new URL("../src/issueview.ts", import.meta.url), "utf8");
const DASHBOARD = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
// The pane's markup outgrew one file; the attribute contract has to follow it rather than
// quietly stop covering whatever moved out. `EMITTERS` is held against the directory below.
const EMITTERS = ["dashview.ts", "depsview.ts", "landedview.ts", "issueview.ts"];

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
  const rows = verbs(DASHVIEW, "export function verbTiles(", "act");
  // The column's foot carries the two verbs that are not tiles: Change… and Copy path.
  const foot = verbs(DASHVIEW, "export function projectFoot(", "act");
  // Running here offers one verb, and only when it is empty: ＋ Start a session.
  const lhere = verbs(DASHVIEW, "export function liveHereCard(", "act");
  // The git card is dispatched by a different listener (`#dashPane`) into the same if-chain.
  const gcard = verbs(DASHVIEW, "export function checkoutCard(", "gb");
  // The GitHub picker writes its one fixed verb straight into the attribute; its
  // `ghacct:<login>` buttons are matched by prefix and invisible to both halves.
  const ghpick = [...new Set(
    [...body(DASHVIEW, "export function ghPicker(").matchAll(/data-dashact="([a-z]+)"/g)].map((m) => m[1]),
  )];
  // The Landed card writes its one verb straight into the attribute, as ghPicker does.
  const lcard = [...new Set([...LANDEDVIEW.matchAll(/data-dashact="([a-z]+)"/g)].map((m) => m[1]))];
  // The band's "Full trail" is a third literal: it reuses a tile's verb rather than minting one.
  const sband = [...new Set([...body(DASHVIEW, "const TRAIL =").matchAll(/data-dashact="([a-z]+)"/g)].map((m) => m[1]))];
  const offered = [...new Set([...rows, ...foot, ...lhere, ...gcard, ...ghpick, ...lcard, ...sband])];
  const handled = [...new Set(
    [...body(DASHBOARD, "function dashAction(act: string): void {")
      .matchAll(/act === "([a-z]+)"/g)].map((m) => m[1]),
  )];

  // Every surface is checked, or one that stopped matching would quietly shrink `offered`
  // and the two comparisons below would pass over a hole.
  it("finds all four surfaces and the if-chain to compare", () => {
    // Floors, not counts: they catch an extraction that has silently stopped matching. Five
    // tiles, one foot verb, and three on the checkout section (pull, push, cleanup — the
    // commit graph moved to the Landed card, which offers it as a literal).
    expect(rows.length).toBeGreaterThan(4);
    expect(foot.length).toBeGreaterThan(0);
    expect(lhere.length).toBeGreaterThan(0);
    expect(gcard.length).toBeGreaterThan(2);
    expect(ghpick.length).toBeGreaterThan(0);
    expect(lcard.length).toBeGreaterThan(0);
    expect(sband.length).toBeGreaterThan(0);
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
    const pane = DASHBOARD.slice(DASHBOARD.indexOf('$("dashPane").addEventListener("click"'));
    expect(pane.slice(0, pane.indexOf("\n  });"))).toContain('closest<HTMLElement>("[data-dashact]")');
  });

});

// One level wider than the verbs above: `data-dashact` is only one of thirty attributes
// `dashview.ts` writes, and the pane's listener probes for each of the others by name. An
// attribute nobody probes for is a row that looks clickable and is not — which is exactly
// how `data-dashwt` sat there, styled `cursor: pointer`, dispatching nothing.

describe("the project dashboard's own dispatcher", () => {
  // Row identity, read by nothing: these key a row for CSS and for reading the DOM, and
  // are deliberately not verbs. Adding one here should be a decision, not an oversight.
  const KEYS = new Set(["note", "sha"]);
  const emitted = [...new Set([...(DASHVIEW + DEPSVIEW + LANDEDVIEW + ISSUEVIEW).matchAll(/data-dash([a-z-]+)/g)].map((m) => m[1]))];
  const probed = [...DASHBOARD.matchAll(/closest(?:<HTMLElement>)?\("\[data-dash([a-z-]+)\]"\)/g)]
    .map((m) => m[1]);
  // The ordering rules below are about ONE if-chain, so they read only the click listener:
  // the pane also has a `contextmenu` one, whose own probes say nothing about that order.
  const CLICK = DASHBOARD.slice(DASHBOARD.indexOf('$("dashPane").addEventListener("click"'));
  const clickProbed = [...CLICK.matchAll(/closest(?:<HTMLElement>)?\("\[data-dash([a-z-]+)\]"\)/g)]
    .map((m) => m[1]);

  it("finds both halves", () => {
    // A regex that has stopped matching would pass every assertion below vacuously.
    expect(emitted.length).toBeGreaterThan(20);
    expect(probed.length).toBeGreaterThan(15);
  });

  it("reads EVERY view file that emits a data-dash attribute", () => {
    // A third view file would otherwise emit rows nothing here compares, which is the same
    // silence this whole join exists to end, one file further out.
    const missed = readdirSync(new URL("../src/", import.meta.url))
      .filter((f) => f.endsWith("view.ts") && !EMITTERS.includes(f))
      .filter((f) => /data-dash/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")));
    expect(missed, `emits data-dash* but is outside the contract: ${missed.join(", ")}`).toEqual([]);
  });

  it("emits no attribute it never probes for — that is a row that does nothing", () => {
    const dead = emitted.filter((k) => !probed.includes(k) && !KEYS.has(k));
    expect(dead, `emitted but never probed: ${dead.map((k) => `data-dash${k}`).join(", ")}`).toEqual([]);
  });

  it("probes for nothing it never emits — a stale probe swallows the click below it", () => {
    const orphan = probed.filter((k) => !emitted.includes(k));
    expect(orphan, `probed but never emitted: ${orphan.map((k) => `data-dash${k}`).join(", ")}`).toEqual([]);
  });

  it("probes a branch row's own controls BEFORE the row that contains them", () => {
    // ⇄ sits inside the row, and the row is the tick target, so a row-level probe placed
    // first would tick a branch instead of switching to it.
    expect(clickProbed).toContain("br");
    for (const inner of ["brsw", "brmenu"]) {
      expect(clickProbed.indexOf(inner), `data-dash${inner} must be probed before data-dashbr`)
        .toBeLessThan(clickProbed.indexOf("br"));
    }
  });

  it("probes an advisory's link BEFORE the row that contains it", () => {
    // The row is the tick target and the link sits inside it, so a row-level probe placed
    // first would select the advisory instead of opening it on GitHub.
    expect(clickProbed).toContain("dep");
    expect(clickProbed.indexOf("depopen"), "data-dashdepopen must be probed before data-dashdep")
      .toBeLessThan(clickProbed.indexOf("dep"));
  });

  it("probes a checkout's two buttons BEFORE the row that contains them", () => {
    // ＋ and ❯ are nested inside the row, so a row-level probe placed first would open the
    // diff instead of launching a session — and `return` does not stop the propagation.
    expect(clickProbed).toContain("wt");
    for (const inner of ["wtadd", "wtterm"]) {
      expect(clickProbed.indexOf(inner), `data-dash${inner} must be probed before data-dashwt`)
        .toBeLessThan(clickProbed.indexOf("wt"));
      // The Checkouts tab's row is the same shape: both buttons are nested inside it.
      expect(clickProbed.indexOf(inner), `data-dash${inner} must be probed before data-dashco`)
        .toBeLessThan(clickProbed.indexOf("co"));
    }
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

// The same join again for the fleet dashboard: `fleetview.ts` writes the markup and `fleetui.ts`
// owns its own `#fleetPane` listener. It stays on the `data-fl*` prefix deliberately — a
// `data-dash*` here would put a second pane's rows inside the dashboard's contract above.

const FLEETVIEW = readFileSync(new URL("../src/fleetview.ts", import.meta.url), "utf8");
const FLEETUI = readFileSync(new URL("../src/fleetui.ts", import.meta.url), "utf8");

describe("the fleet dashboard's own dispatcher", () => {
  // Payload read off an element that already matched: a project row carries both its path and
  // its name, and a session glyph its id, none of which is a probe target.
  const PAYLOAD = new Set(["name", "sid"]);
  const emitted = [...FLEETVIEW.matchAll(/data-fl([a-z]+)="/g)].map((m) => m[1]);
  const probed = [...FLEETUI.matchAll(/closest<HTMLElement>\("\[data-fl([a-z]+)\]"\)/g)].map((m) => m[1]);

  it("finds both halves", () => {
    expect(emitted.length).toBeGreaterThan(3);
    expect(probed.length).toBeGreaterThan(3);
  });

  it("keeps data-dash* out of the fleet's markup", () => {
    // fleetview.ts ends in `view.ts`, so the EMITTERS sweep above would fail it the moment it
    // emitted one — and adding it there would compare it against the wrong dispatcher.
    expect(FLEETVIEW).not.toContain("data-dash");
  });

  it("emits no attribute it never probes for — that is a row that does nothing", () => {
    const dead = [...new Set(emitted.filter((k) => !probed.includes(k) && !PAYLOAD.has(k)))];
    expect(dead, `emitted but never probed: ${dead.map((k) => `data-fl${k}`).join(", ")}`).toEqual([]);
  });

  it("probes for nothing it never emits — a stale probe swallows the click below it", () => {
    const orphan = probed.filter((k) => !emitted.includes(k));
    expect(orphan, `probed but never emitted: ${orphan.map((k) => `data-fl${k}`).join(", ")}`).toEqual([]);
  });

  it("probes a session row's ✕ BEFORE the row that contains it", () => {
    // The ✕ is a child of the row that carries data-flsel, so a row-first probe ships a close
    // button that selects the session instead of closing it.
    expect(probed).toContain("sel");
    expect(probed.indexOf("close"), "data-flclose must be probed before data-flsel")
      .toBeLessThan(probed.indexOf("sel"));
  });

  it("probes the project card LAST, because it is the card's whole background", () => {
    expect(probed).toContain("proj");
    expect(
      probed.indexOf("proj"),
      `[data-flproj] is probed at position ${probed.indexOf("proj")} of ${probed.length}; everything after it (${probed.slice(probed.indexOf("proj") + 1).join(", ")}) is unreachable`,
    ).toBe(probed.length - 1);
  });
});
