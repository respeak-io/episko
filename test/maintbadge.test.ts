import { describe, expect, it } from "vitest";
import {
  DETECT, fleetChip, pct, popLines, progressText, projectChip, readingNow, readingSub, scanProgress, worstProjects,
  type ProjectChipIn, type ScanState,
} from "../src/maintbadge";
import type { Cell, Finding } from "../src/maint";

const st = (root: string, o: Partial<ScanState> = {}): ScanState =>
  ({ root, detecting: false, total: 0, out: 0, live: new Set(), ...o });

describe("how far a scan has got", () => {
  it("weighs each project the same, so one with many sources never stalls the bar", () => {
    const p = scanProgress([st("/a", { total: 40, out: 40 }), st("/b", { total: 2, out: 0 })]);
    expect(p.done).toBe(1);
    expect(p.reads).toBe(42);
    expect(p.readsDone).toBe(2);
    // /a has its detection done (1 of 41 steps), /b is whole: about half, not 2 of 42.
    expect(p.frac).toBeCloseTo((1 / 41 + 1) / 2);
  });

  it("counts a project still being detected as looking, with no reads known yet", () => {
    const p = scanProgress([st("/a", { detecting: true, live: new Set([DETECT]) }), st("/b", { total: 3, out: 1 })]);
    expect(p).toMatchObject({ projects: 2, done: 0, looking: 1, reads: 3, readsDone: 2 });
    expect(p.live).toEqual([{ root: "/a", source: DETECT }]);
  });

  it("counts a project with no source as done once detected, and a failed detection too", () => {
    expect(scanProgress([st("/a"), st("/b")]).frac).toBe(1);
    expect(scanProgress([st("/a")]).done).toBe(1);
  });

  it("treats a project asked for but no longer held as not started", () => {
    const p = scanProgress([st("/a")], 2);
    expect(p).toMatchObject({ projects: 2, done: 1, looking: 1 });
    expect(p.frac).toBe(0.5);
  });

  it("says a sweep in projects and one project in sources, with a + while totals still grow", () => {
    const sweep = scanProgress([st("/a", { total: 4, out: 1 }), st("/b", { detecting: true })]);
    expect(progressText(sweep, false)).toBe("0 of 2 projects done · 3 of 4+ sources read");
    expect(progressText(scanProgress([st("/a", { total: 9, out: 5 })]), true)).toBe("Reading 4 of 9 sources");
    expect(progressText(scanProgress([st("/a", { detecting: true })]), true)).toBe("Looking at the project");
    expect(pct(sweep)).toBe(Math.round(sweep.frac * 100));
  });

  it("names what holds a slot, deduplicated, at most two and how many more", () => {
    const p = scanProgress([
      st("/a", { total: 3, out: 3, live: new Set(["github-actions", "osv", "git-local"]) }),
      st("/b", { detecting: true, live: new Set([DETECT]) }),
    ]);
    const names = (r: string) => r === "/a" ? "alpha" : "beta";
    expect(readingNow(p, names)).toBe("GitHub Actions · alpha, OSV.dev · alpha +2");
    expect(readingNow(p, names, 9)).toContain("looking at it · beta");
    expect(readingNow(scanProgress([st("/a")]))).toBe("");
  });

  it("gives a card's sub how far it is and as of when its earlier answer is", () => {
    expect(readingSub(scanProgress([st("/a", { total: 5, out: 2 })]), "3h ago")).toBe("reading 3 of 5 · as of 3h ago");
    expect(readingSub(scanProgress([st("/a", { detecting: true })]), null)).toBe("looking at the project…");
  });
});

const cell = (facet: Cell["facet"], level: Cell["level"]): Cell =>
  ({ facet, state: level === "unread" ? "unread" : "read", level, text: "", tip: [], fix: null, asOf: null });
const find = (level: Finding["level"], text: string): Finding =>
  ({ root: "/a", facet: "ci", key: `ci:${text}`, level, text, detail: "", verb: "fix", source: "github-actions", ref: null });
const proj = (o: Partial<ProjectChipIn> = {}): ProjectChipIn => ({
  name: "alpha", cells: [cell("ci", "ok"), cell("security", "ok")], findings: [], band: "quiet",
  past: false, when: "checked 4m ago", progress: null, ...o,
});

describe("the header chip for the project on the stage", () => {
  it("draws its facets as dots and counts only what needs you", () => {
    const c = projectChip(proj({
      cells: [cell("ci", "bad"), cell("security", "warn"), cell("deps", "unread")], band: "needs",
      findings: [find("bad", "CI failing 3d"), find("warn", "2 advisories"), find("info", "5 behind")],
    }));
    expect(c).toMatchObject({ tone: "bad", dots: ["bad", "warn", "unread"], count: 2, busy: null });
    expect(c.tip[1]).toBe("2 things need you: CI failing 3d; 2 advisories");
  });

  it("is quiet without a number when nothing needs you", () => {
    expect(projectChip(proj())).toMatchObject({ tone: "ok", count: null });
    expect(projectChip(proj()).tip).toContain("nothing needs you");
  });

  it("never colours what only the last boot's snapshot says", () => {
    expect(projectChip(proj({ band: "needs", past: true, when: "as of 2d ago" })).tone).toBe("muted");
  });

  it("says a project nobody checked is not checked, rather than fine", () => {
    const c = projectChip(proj({ band: "unread", when: null, cells: [cell("ci", "unread")] }));
    expect(c).toMatchObject({ tone: "muted", count: null });
    expect(c.tip).toContain("not checked yet");
  });

  it("shows how far its scan is while one is out", () => {
    const c = projectChip(proj({ progress: scanProgress([st("/a", { total: 9, out: 5 })]) }));
    expect(c.busy).toBe("4/9");
    expect(c.tip).toContain("Reading 4 of 9 sources");
  });
});

describe("the header chip with no project on the stage", () => {
  it("counts the projects that need you, else the ones drifting", () => {
    expect(fleetChip({ projects: 9, tally: { needs: 2, drifting: 3, quiet: 4, unread: 0 }, when: null, progress: null }))
      .toMatchObject({ tone: "bad", count: 2, dots: null });
    expect(fleetChip({ projects: 9, tally: { needs: 0, drifting: 3, quiet: 6, unread: 0 }, when: null, progress: null }))
      .toMatchObject({ tone: "warn", count: 3 });
  });

  it("never reads as clear while a project is unread, nor before anything was checked", () => {
    expect(fleetChip({ projects: 3, tally: { needs: 0, drifting: 0, quiet: 2, unread: 1 }, when: null, progress: null }).tone).toBe("muted");
    const none = fleetChip({ projects: 3, tally: null, when: null, progress: null });
    expect(none).toMatchObject({ tone: "muted", count: null });
    expect(none.tip).toContain("not checked this session");
    expect(fleetChip({ projects: 3, tally: { needs: 0, drifting: 0, quiet: 3, unread: 0 }, when: "checked 1m ago", progress: null }).tone).toBe("ok");
  });

  it("shows the sweep in projects while it runs", () => {
    const c = fleetChip({ projects: 2, tally: null, when: null, progress: scanProgress([st("/a"), st("/b", { detecting: true })]) });
    expect(c.busy).toBe("1/2");
  });
});

describe("the popover's lists", () => {
  it("names what needs you, then what drifts, worst first, and nothing quiet or unread", () => {
    const rows = [
      { root: "/q", name: "quiet", band: "quiet" as const, findings: [] },
      { root: "/d", name: "drift", band: "drifting" as const, findings: [find("warn", "fetch 9d old")] },
      { root: "/n", name: "needs", band: "needs" as const, findings: [find("bad", "CI failing"), find("warn", "x"), find("info", "y")] },
      { root: "/u", name: "unread", band: "unread" as const, findings: [] },
    ];
    expect(worstProjects(rows, 4)).toEqual([
      { root: "/n", name: "needs", band: "needs", line: "CI failing", more: 1 },
      { root: "/d", name: "drift", band: "drifting", line: "fetch 9d old", more: 0 },
    ]);
    expect(worstProjects(rows, 1)).toHaveLength(1);
  });

  it("caps a project's lines and says how many more", () => {
    expect(popLines([1, 2, 3, 4, 5, 6, 7], 5)).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 });
    expect(popLines([1], 5)).toEqual({ shown: [1], more: 0 });
  });
});
