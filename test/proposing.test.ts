import { describe, expect, it } from "vitest";
import { addStep, liveHtml, relTo, startProposing, stepOf, stepText, tallyText } from "../src/proposing";

describe("proposing — a headless read as it runs", () => {
  it("names a path inside the project relative to it, on either separator", () => {
    expect(relTo("/w/app/justfile", "/w/app")).toBe("justfile");
    expect(relTo("/w/app/", "/w/app")).toBe("");
    expect(relTo("C:\\w\\app\\deploy\\ci.sh", "C:\\w\\app")).toBe("deploy/ci.sh");
    // A sibling that shares the prefix is not inside it.
    expect(relTo("/w/application/x", "/w/app")).toBe("/w/application/x");
  });

  it("turns the three tools it is given into steps, and nothing else", () => {
    expect(stepOf("Read", { file_path: "/w/app/justfile" }, "/w/app")).toEqual({ verb: "read", what: "justfile", where: "" });
    expect(stepOf("Glob", { pattern: "**/compose*.yml", path: "/w/app/deploy" }, "/w/app")).toEqual({ verb: "find", what: "**/compose*.yml", where: "deploy" });
    expect(stepOf("Grep", { pattern: "ssh", glob: "*.sh" }, "/w/app")).toEqual({ verb: "search", what: "ssh", where: "*.sh" });
    expect(stepOf("Bash", { command: "ls" }, "/w/app")).toBeNull();
    expect(stepOf("Read", null, "/w/app")).toBeNull();
    expect(stepOf("Grep", { pattern: 7 }, "/w/app")).toBeNull();
  });

  it("counts reads apart from searches and keeps only the last three steps", () => {
    let p = startProposing("deploy", 0);
    expect(tallyText(p)).toBe("");
    for (const f of ["a", "b", "c"]) p = addStep(p, { verb: "read", what: f, where: "" });
    p = addStep(p, { verb: "search", what: "ssh", where: "deploy" });
    expect(tallyText(p)).toBe("3 files read · 1 search");
    expect(p.trail.map(stepText)).toEqual(["Read b", "Read c", "Search “ssh” in deploy"]);
  });

  it("draws the host's Stop, says it is starting before the first step, and escapes what the agent asked for", () => {
    const p = startProposing("maint", 0);
    const fresh = liveHtml(p, `data-ps="proposestop"`, true);
    expect(fresh).toContain(`data-ps="proposestop"`);
    expect(fresh).toContain("starting Claude…");
    const html = liveHtml(addStep(p, { verb: "search", what: "<img src=x>", where: "" }), `data-x="stop"`);
    expect(html).not.toContain("<img");
    expect(html).toContain('<ol class="pp-trail">');
  });
});
