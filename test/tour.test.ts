import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ASKING_MODES, CHAPTERS, chapterKey, isDone, parseTourState, permAsks, pickerChapters,
  planFor, RAIL_LEGEND, recordDone, releaseChapter, shouldOfferPicker, shouldOfferRelease,
  stepApplies, stepBlocked, stepSatisfied, tourDefaults, type TourWorld,
} from "../src/tour";

// A source-parsing contract test (like dispatch/ipc): a tour step's `anchor` is a join
// with index.html that nothing else checks. Every static anchor must exist there, and
// every `dynamic` one must not, or the flag is a stale escape hatch.

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const SIDEBARVIEW = readFileSync(new URL("../src/sidebarview.ts", import.meta.url), "utf8");
const SETTINGS = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const PROVIDERS = readFileSync(new URL("../src/providers/index.ts", import.meta.url), "utf8");
const CHANGELOGUI = readFileSync(new URL("../src/changelogui.ts", import.meta.url), "utf8");
/** Every Settings tab, as `id -> label` — the other join a card's copy can get wrong. */
const SET_TABS: Record<string, string> = Object.fromEntries(
  [...SETTINGS.matchAll(/id: "(\w+)", label: "([^"]+)"/g)].map((m) => [m[1], m[2]]),
);

/** Does this selector match anything in index.html? The throw below lists the shapes understood. */
function inHtml(sel: string): boolean {
  let m: RegExpExecArray | null;
  if ((m = /^#([A-Za-z0-9_-]+)$/.exec(sel))) return HTML.includes(`id="${m[1]}"`);
  // The name as a whole attribute (a substring lets `[data-add]` be satisfied by `data-addr`),
  // and the value too when the selector names one.
  if ((m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel))) {
    return m[2] === undefined
      ? new RegExp(`\\s${m[1]}(?=[\\s=>])`).test(HTML)
      : HTML.includes(`${m[1]}="${m[2]}"`);
  }
  if ((m = /^\.([A-Za-z0-9_-]+)$/.exec(sel))) return new RegExp(`class="[^"]*\\b${m[1]}\\b`).test(HTML);
  throw new Error(`tour anchor "${sel}" uses a selector shape this test cannot check — `
    + `keep anchors to #id, [data-x], [data-x="v"] or .class, or teach inHtml() the new shape`);
}

const allSteps = () => CHAPTERS.flatMap((c) => c.steps.map((s) => ({ c, s })));

/** A world where nothing has happened yet. Spread over it to state only what matters. */
const W0: TourWorld = {
  projects: 0, sessions: 0, phase: "", agentOnStage: false, permPending: false,
  provider: "", permissionCanAsk: true, permAnswered: false, permMode: "default", attnCount: 0, open: [], settingsTab: "",
  stage: "none", toolsTab: false, caffeinated: false,
};

describe("tour anchors are joined to index.html", () => {
  it("has anchors to check", () => {
    expect(allSteps().filter(({ s }) => s.anchor).length).toBeGreaterThan(10);
  });

  it("resolves every STATIC anchor in index.html", () => {
    const dead = allSteps()
      .filter(({ s }) => s.anchor && !s.dynamic && !inHtml(s.anchor))
      .map(({ c, s }) => `${c.id}: "${s.title}" -> ${s.anchor}`);
    expect(dead).toEqual([]);
  });

  it("keeps every DYNAMIC anchor genuinely dynamic", () => {
    const stale = allSteps()
      .filter(({ s }) => s.anchor && s.dynamic && inHtml(s.anchor))
      .map(({ c, s }) => `${c.id}: "${s.title}" -> ${s.anchor} is in index.html; drop dynamic`);
    expect(stale).toEqual([]);
  });
});

describe("the rail legend the tour teaches", () => {
  // Read out of sidebarview.ts: ./tour may not import a view, so its legend is a copy.
  const table = (name: string): Record<string, string> => {
    const m = new RegExp(`export const ${name}: Record<string, string> = \\{([^}]*)\\}`).exec(SIDEBARVIEW);
    if (!m) throw new Error(`could not find ${name} in sidebarview.ts`);
    const out: Record<string, string> = {};
    for (const e of m[1].matchAll(/(\w+):\s*"([^"]*)"/g)) out[e[1]] = e[2];
    return out;
  };
  const GLYPH = table("GLYPH");
  const GCLASS = table("GCLASS");

  it("found both tables", () => {
    expect(Object.keys(GLYPH).length).toBeGreaterThan(5);
    expect(Object.keys(GCLASS).length).toBe(Object.keys(GLYPH).length);
  });

  it("teaches a glyph and class the sidebar actually uses", () => {
    for (const l of RAIL_LEGEND) {
      expect(Object.values(GLYPH), `${l.label}: glyph ${l.glyph}`).toContain(l.glyph);
      expect(Object.values(GCLASS), `${l.label}: class ${l.cls}`).toContain(l.cls);
    }
  });

  it("teaches every state the sidebar can show", () => {
    // `thinking` and `working` share a glyph and a class, so the legend is keyed by the pair.
    const shown = new Set(Object.keys(GLYPH).map((k) => `${GLYPH[k]}|${GCLASS[k]}`));
    const taught = new Set(RAIL_LEGEND.map((l) => `${l.glyph}|${l.cls}`));
    expect([...shown].filter((k) => !taught.has(k))).toEqual([]);
  });
});

describe("the manifest is well formed", () => {
  it("has exactly one required chapter, and it is first", () => {
    const req = CHAPTERS.filter((c) => c.required);
    expect(req).toHaveLength(1);
    expect(CHAPTERS[0].required).toBe(true);
  });

  it("has unique ids and unique keys", () => {
    const ids = CHAPTERS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = CHAPTERS.map(chapterKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never waits on something it cannot detect", () => {
    // A `wait` with no `done` disables Next forever: the user's only way out is the ✕.
    const stuck = allSteps().filter(({ s }) => s.wait && !s.done).map(({ s }) => s.title);
    expect(stuck).toEqual([]);
  });

  it("never promises to detect something it does not wait for", () => {
    const idle = allSteps().filter(({ s }) => s.done && !s.wait).map(({ s }) => s.title);
    expect(idle).toEqual([]);
  });

  it("moves the hole between steps", () => {
    // Two steps in a row on one anchor leave the hole where it was: a Next that did not land.
    const same: string[] = [];
    for (const c of CHAPTERS) {
      for (let i = 1; i < c.steps.length; i++) {
        const a = c.steps[i - 1].anchor, b = c.steps[i].anchor;
        if (a && b && a === b) same.push(`${c.id}: "${c.steps[i].title}" repeats ${a}`);
      }
    }
    expect(same).toEqual([]);
  });

  it("declares the panel every anchor lives in", () => {
    // ⌘I removes the inspector and ⌘B collapses the rail, so a step anchored inside either
    // must list it in `needs`, or it lights nothing for anyone who works with it collapsed.
    const PANEL: Record<string, "rail" | "inspector"> = {
      "[data-add]": "rail", ".padd": "rail", ".phead": "rail", "#projects": "rail",
      "#inspector": "inspector", ".attn-btns": "inspector", ".wset": "inspector",
      '[data-fmode="tools"]': "inspector",
    };
    const missing = allSteps()
      .filter(({ s }) => s.anchor && PANEL[s.anchor] && !s.needs?.includes(PANEL[s.anchor]))
      .map(({ c, s }) => `${c.id}: "${s.title}" -> ${s.anchor} needs the ${PANEL[s.anchor!]}`);
    expect(missing).toEqual([]);
  });

  it("only sends you to a Settings tab that exists", () => {
    // "Settings › Sounds" is a join with settings.ts's tabs, the same shape as an anchor.
    const labels = Object.values(SET_TABS);
    expect(labels.length).toBeGreaterThan(4);
    const bad: string[] = [];
    for (const { c, s } of allSteps()) {
      for (const m of s.body.matchAll(/Settings › ([A-Za-z]+)/g)) {
        if (!labels.includes(m[1])) bad.push(`${c.id}: "${s.title}" -> Settings › ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("gives every chapter a name, a blurb and a length", () => {
    for (const c of CHAPTERS) {
      expect(c.name.length, c.id).toBeGreaterThan(2);
      expect(c.blurb.length, c.id).toBeGreaterThan(10);
      expect(c.mins.length, c.id).toBeGreaterThan(1);
      expect(c.steps.length, c.id).toBeGreaterThan(0);
    }
  });
});

describe("parseTourState", () => {
  it("treats a missing key as a first run", () => {
    expect(parseTourState(null)).toEqual(tourDefaults());
    expect(shouldOfferPicker(null)).toBe(true);
  });

  it("does NOT treat a present-but-empty record as a first run", () => {
    // Writing anything ends the first run; never guard on "does this look used" (docs/releases.md).
    expect(shouldOfferPicker(JSON.stringify(tourDefaults()))).toBe(false);
  });

  it("survives anything hand-edited into the key, and stays quiet", () => {
    for (const junk of ["", "{", "null", "[]", '{"done":"nope"}', '{"v":9}']) {
      const st = parseTourState(junk);
      expect(st.done).toEqual([]);
      expect(st.queue).toEqual([]);
      expect(st.at).toBeNull();
    }
  });

  it("keeps only string entries and known chapters", () => {
    const st = parseTourState(JSON.stringify({
      v: 1, done: ["quickstart@1", 7, null], queue: ["cost", "no-such-chapter"], at: { ch: "cost", step: 2 },
    }));
    expect(st.done).toEqual(["quickstart@1"]);
    expect(st.queue).toEqual(["cost"]);
    expect(st.at).toEqual({ ch: "cost", step: 2 });
  });

  it("drops a resume point for a chapter that no longer exists", () => {
    const st = parseTourState(JSON.stringify({ v: 1, at: { ch: "gone", step: 3 } }));
    expect(st.at).toBeNull();
  });
});

describe("recording a chapter", () => {
  const cost = CHAPTERS.find((c) => c.id === "cost")!;

  it("marks it done, clears it from the queue, and is idempotent", () => {
    let st = { ...tourDefaults(), queue: ["cost", "project"] };
    st = recordDone(st, cost);
    expect(isDone(st, cost)).toBe(true);
    expect(st.queue).toEqual(["project"]);
    const again = recordDone(st, cost);
    expect(again.done).toEqual(st.done);
  });

  it("clears a resume point that belonged to it, and leaves another alone", () => {
    expect(recordDone({ ...tourDefaults(), at: { ch: "cost", step: 1 } }, cost).at).toBeNull();
    expect(recordDone({ ...tourDefaults(), at: { ch: "project", step: 1 } }, cost).at)
      .toEqual({ ch: "project", step: 1 });
  });

  it("re-offers a chapter whose rev has been bumped", () => {
    // `done` holds id@rev so a rewritten chapter can be re-offered.
    const st = recordDone(tourDefaults(), cost);
    expect(isDone(st, { ...cost, rev: cost.rev + 1 })).toBe(false);
  });
});

describe("release intros", () => {
  it("finds nothing for a version that ships no chapter", () => {
    expect(releaseChapter("0.20.0")).toBeNull();
    expect(shouldOfferRelease("0.20.0", tourDefaults())).toBeNull();
  });

  it("offers a shipped chapter until it has been taken", () => {
    const intro = { ...CHAPTERS[0], id: "demo-intro", required: false, since: "9.9.9" };
    CHAPTERS.push(intro);
    try {
      expect(releaseChapter("9.9.9")?.id).toBe("demo-intro");
      expect(shouldOfferRelease("9.9.9", tourDefaults())?.id).toBe("demo-intro");
      expect(shouldOfferRelease("9.9.9", recordDone(tourDefaults(), intro))).toBeNull();
      // ...and it is never part of a first run's picker.
      expect(pickerChapters().map((c) => c.id)).not.toContain("demo-intro");
      expect(planFor(["demo-intro", "cost"]).map((c) => c.id)).toEqual(["cost"]);
    } finally {
      CHAPTERS.pop();
    }
  });
});

describe("walking a chapter", () => {
  it("orders a plan by the manifest, not by the order boxes were ticked", () => {
    expect(planFor(["cost", "quickstart"]).map((c) => c.id)).toEqual(["quickstart", "cost"]);
  });

  it("drops an unknown id rather than stranding the plan", () => {
    expect(planFor(["quickstart", "nope"]).map((c) => c.id)).toEqual(["quickstart"]);
  });

  it("counts out a step whose `when` fails, and keeps one with no `when`", () => {
    expect(stepApplies({ title: "a", body: "" }, W0)).toBe(true);
    expect(stepApplies({ title: "b", body: "", when: () => false }, W0)).toBe(false);
    expect(stepApplies({ title: "c", body: "", when: (w) => w.sessions > 0 }, { ...W0, sessions: 1 })).toBe(true);
  });

  it("blocks Next only while a waiting step is unmet", () => {
    const s = { title: "x", body: "", wait: "do it", done: (w: TourWorld) => w.projects > 0 };
    expect(stepBlocked(s, W0)).toBe(true);
    expect(stepSatisfied(s, W0)).toBe(false);
    expect(stepBlocked(s, { ...W0, projects: 1 })).toBe(false);
    expect(stepSatisfied(s, { ...W0, projects: 1 })).toBe(true);
  });

  it("never blocks a step that does not wait", () => {
    expect(stepBlocked({ title: "x", body: "" }, W0)).toBe(false);
    expect(stepSatisfied({ title: "x", body: "" }, W0)).toBe(false);
  });
});

describe("the Quick start predicates", () => {
  const qs = CHAPTERS[0];
  const at = (title: string) => qs.steps.find((s) => s.title.startsWith(title))!;

  it("waits for a project before leaving the first step", () => {
    const s = at("Add a project");
    expect(s.done!(W0)).toBe(false);
    expect(s.done!({ ...W0, projects: 1 })).toBe(true);
  });

  it("opens the project page before it asks for a session", () => {
    // `＋ Session` acts on whatever is on the stage, and with nothing there it opens ⌘K, so
    // the step must wait for the project page: that is what gives the button a project.
    const open = at("Open the project");
    expect(open.done!({ ...W0, projects: 1 })).toBe(false);
    expect(open.done!({ ...W0, projects: 1, stage: "dash" })).toBe(true);
  });

  it("accepts both launch shapes: the dialog, or a session straight away", () => {
    const s = at("Start a session");
    expect(s.done!({ ...W0, stage: "dash" })).toBe(false);
    expect(s.done!({ ...W0, stage: "dash", open: ["wt"] })).toBe(true);   // a git repo asks where
    expect(s.done!({ ...W0, stage: "dash", sessions: 1 })).toBe(true);    // anything else just goes
    // ...and the step about the dialog is counted out entirely when there wasn't one.
    const pick = at("Pick where it runs");
    expect(pick.when!({ ...W0, sessions: 1 })).toBe(false);
    expect(pick.when!({ ...W0, open: ["wt"] })).toBe(true);
    expect(pick.done!({ ...W0, sessions: 1, open: ["wt"] })).toBe(false);
    expect(pick.done!({ ...W0, sessions: 1 })).toBe(true);
  });

  it("holds the prompt step until Claude asks — or until the turn ends without asking", () => {
    const s = at("Give it a first job");
    expect(s.done!(W0)).toBe(false);
    // Working is not enough: the next step lights the badge, which needs a pending permission.
    expect(s.done!({ ...W0, phase: "working" })).toBe(false);
    expect(s.done!({ ...W0, permPending: true })).toBe(true);
    // ...and a bypass-mode turn that finishes without ever asking releases it too.
    expect(s.done!({ ...W0, phase: "done" })).toBe(true);
  });

  it("only offers the reactor step while the badge is actually on screen", () => {
    // ./attn does not count the pane you are looking at, so on a first run the badge exists
    // for exactly as long as the permission does; a step after the answer skips itself.
    const s = at("It wants you");
    expect(s.when!(W0)).toBe(false);
    expect(s.when!({ ...W0, permPending: true })).toBe(true);
    expect(s.when!({ ...W0, attnCount: 1 })).toBe(true);
  });

  it("does not call the permission answered before one was ever raised", () => {
    // `!permPending` is also true on a fresh session, which would skip the step instantly.
    const s = at("Blocked on you");
    expect(s.done!(W0)).toBe(false);
    expect(s.done!({ ...W0, permPending: true })).toBe(false);
    expect(s.done!({ ...W0, permAnswered: true })).toBe(true);
    // A turn that ended without ever asking releases it too; the step then reads as an explanation.
    expect(s.done!({ ...W0, phase: "done" })).toBe(true);
    expect(s.done!({ ...W0, phase: "done", permPending: true })).toBe(false);
  });
});

describe("the What's new hand-off", () => {
  it("asks whether the chapter is still worth offering, not just whether it exists", () => {
    // `releaseChapter` only asks whether the version ships one; `tourForVersion` also asks
    // whether it has been taken, or "Show me →" sits on the entry forever.
    expect(CHANGELOGUI).toMatch(/tourForVersion\(/);
    expect(CHANGELOGUI).not.toMatch(/\breleaseChapter\(/);
  });
});

describe("the permission modes it plans around", () => {
  /** Every provider-owned mode id ships at the adapter boundary. */
  const shipped = [...PROVIDERS.matchAll(/\{ id: "([\w-]+)", *label: "([^"]+)"/g)].map((m) => m[1]);

  it("found the table", () => {
    expect(shipped.length).toBeGreaterThan(4);
    expect(shipped).toContain("default");
  });

  it("only names modes the app actually ships", () => {
    // Nothing reads ASKING_MODES at runtime, so a mode renamed out from under it would leave
    // the list quietly describing an app that no longer exists.
    expect(shipped).toEqual(expect.arrayContaining([...ASKING_MODES]));
  });

  // The configured mode is passed in every case and read in none: the answer is what the
  // provider did (`permissionCanAsk`), never what the setting said it might do.
  it("knows which modes still raise a card", () => {
    expect(permAsks({ ...W0, permMode: "default", permissionCanAsk: true })).toBe(true);
    expect(permAsks({ ...W0, permMode: "acceptEdits", permissionCanAsk: true })).toBe(true);
    for (const m of ["auto", "dontAsk", "bypassPermissions", "plan"]) {
      expect(permAsks({ ...W0, permMode: m, permissionCanAsk: false }), m).toBe(false);
    }
    expect(permAsks({ ...W0, provider: "codex", permMode: "on-request", permissionCanAsk: true })).toBe(true);
  });
});

describe("Quick start under a mode that answers for you", () => {
  const qs = CHAPTERS[0];
  const at = (title: string) => qs.steps.find((s) => s.title.startsWith(title))!;
  const auto = { ...W0, permMode: "auto", permissionCanAsk: false, stage: "session", sessions: 1 };

  it("does not hold the prompt step waiting for an ask that is not coming", () => {
    // Under `auto` no card is coming, so the turn starting is the whole of it; the 20s
    // "Skip this step" is a backstop for a wrong predicate, not a design.
    const s = at("Give it a first job");
    expect(s.done!({ ...auto, phase: "working" })).toBe(true);
    // ...while an asking mode still holds, because the step after it needs the badge lit.
    expect(s.done!({ ...W0, phase: "working" })).toBe(false);
  });

  it("swaps the permission card step for the one that explains it", () => {
    const card = at("Blocked on you");
    const instead = at("What you are not being asked");
    expect(card.when!(auto)).toBe(false);
    expect(instead.when!(auto)).toBe(true);
    // Exactly one of the pair, in every state: never both, never neither.
    for (const w of [W0, auto, { ...auto, permPending: true }, { ...W0, permAnswered: true }]) {
      expect([card.when!(w), instead.when!(w)].filter(Boolean)).toHaveLength(1);
    }
  });

  it("uses what happened, not whether the configured mode could have asked", () => {
    const card = at("Blocked on you");
    const instead = at("What you are not being asked");
    expect(card.when!({ ...W0, permMode: "acceptEdits" })).toBe(false);
    expect(instead.when!({ ...W0, permMode: "acceptEdits" })).toBe(true);
    expect(card.when!({ ...auto, permPending: true })).toBe(true);
    expect(instead.when!({ ...auto, permPending: true })).toBe(false);
  });
});

describe("the Leave it running predicates", () => {
  const ch = CHAPTERS.find((c) => c.id === "unattended")!;

  it("waits for the Sounds tab by an id settings.ts actually ships", () => {
    // Two gestures, two steps: the hole has to move onto the tab, or the user is asked to
    // click something the veil has just darkened.
    const open = ch.steps.find((st) => st.title.startsWith("Everything else is in here"))!;
    const tab = ch.steps.find((st) => st.title.startsWith("Tune what you hear"))!;
    expect(open.done!(W0)).toBe(false);
    expect(open.done!({ ...W0, open: ["settings"] })).toBe(true);
    expect(tab.done!({ ...W0, open: ["settings"], settingsTab: "appearance" })).toBe(false);
    expect(tab.done!({ ...W0, open: ["settings"], settingsTab: "sounds" })).toBe(true);
    expect(tab.anchor).toBe('[data-settab="sounds"]');
    expect(SET_TABS.sounds).toBe("Sounds");
  });
});
