import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHAPTERS, chapterKey, isDone, parseTourState, pickerChapters, planFor, RAIL_LEGEND,
  recordDone, releaseChapter, shouldOfferPicker, shouldOfferRelease, stepBlocked,
  stepSatisfied, tourDefaults, type TourWorld, visibleSteps,
} from "../src/tour";

// The third test in this repo that reads source instead of calling it, and for the same
// reason as dispatch.test.ts and ipc.test.ts: a tour step's `anchor` is a join between
// two files that nothing else checks. `tsc` sees a string. Every unit test passes,
// because the rules underneath are fine. The step simply lights nothing — and only
// running the tour on a real first launch would ever find out.
//
// So: every static anchor must exist in index.html, and every anchor flagged `dynamic`
// must NOT — the flag has to be a decision about an element built at runtime, not a
// stale escape hatch left on something that has since become static.

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const SIDEBARVIEW = readFileSync(new URL("../src/sidebarview.ts", import.meta.url), "utf8");

/** Does this (deliberately small) selector grammar match anything in index.html? */
function inHtml(sel: string): boolean {
  let m: RegExpExecArray | null;
  if ((m = /^#([A-Za-z0-9_-]+)$/.exec(sel))) return HTML.includes(`id="${m[1]}"`);
  if ((m = /^\[([a-z-]+)(?:="[^"]*")?\]$/.exec(sel))) return HTML.includes(m[1]);
  if ((m = /^\.([A-Za-z0-9_-]+)$/.exec(sel))) return new RegExp(`class="[^"]*\\b${m[1]}\\b`).test(HTML);
  throw new Error(`tour anchor "${sel}" uses a selector shape this test cannot check — `
    + `keep anchors to #id, [data-x], [data-x="v"] or .class, or teach inHtml() the new shape`);
}

const allSteps = () => CHAPTERS.flatMap((c) => c.steps.map((s) => ({ c, s })));

/** A world where nothing has happened yet. Spread over it to state only what matters. */
const W0: TourWorld = {
  projects: 0, sessions: 0, phase: "", permPending: false, permAnswered: false,
  open: [], stage: "none", files: 0, toolsTab: false, caffeinated: false,
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
    // The other direction. An anchor that has since been added to index.html should
    // lose the flag, so the static check above starts covering it.
    const stale = allSteps()
      .filter(({ s }) => s.anchor && s.dynamic && inHtml(s.anchor))
      .map(({ c, s }) => `${c.id}: "${s.title}" -> ${s.anchor} is in index.html; drop dynamic`);
    expect(stale).toEqual([]);
  });
});

describe("the rail legend the tour teaches", () => {
  // Duplicated from ./sidebarview rather than imported — a logic module may not import a
  // view — so this is what keeps the two tables honest in both directions.
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
    // `thinking` and `working` share a glyph and a class, so the legend is keyed by the
    // pair rather than by state name — what a user has to tell apart is what they see.
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
    // The whole point: writing anything ends the first run. A guard that asked "does
    // this look used" is how 0.13.0 shipped silent (docs/releases.md).
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
    // The reason `done` holds id@rev: rewriting a chapter can deliberately re-offer it.
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

  it("counts out a step whose `when` fails", () => {
    const c = { ...CHAPTERS[0], steps: [
      { title: "a", body: "" },
      { title: "b", body: "", when: () => false },
      { title: "c", body: "" },
    ] };
    expect(visibleSteps(c, W0).map((s) => s.title)).toEqual(["a", "c"]);
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

  it("waits for the launcher, then for a session that outlives it", () => {
    expect(at("Start a session").done!({ ...W0, open: ["wt"] })).toBe(true);
    const pick = at("Pick where it runs");
    expect(pick.done!({ ...W0, sessions: 1, open: ["wt"] })).toBe(false); // still open
    expect(pick.done!({ ...W0, sessions: 1 })).toBe(true);
  });

  it("accepts either a working turn or a permission as 'the prompt went in'", () => {
    const s = at("Give it a first job");
    expect(s.done!(W0)).toBe(false);
    expect(s.done!({ ...W0, phase: "working" })).toBe(true);
    // A fast Bash can raise the permission before any phase moves; that still counts.
    expect(s.done!({ ...W0, permPending: true })).toBe(true);
  });

  it("does not call the permission answered before one was ever raised", () => {
    // The trap this predicate exists to avoid: `!permPending` is also true on a fresh
    // session, which would skip the most important step in the chapter instantly.
    const s = at("It stopped");
    expect(s.done!(W0)).toBe(false);
    expect(s.done!({ ...W0, permPending: true })).toBe(false);
    expect(s.done!({ ...W0, permAnswered: true })).toBe(true);
  });
});
