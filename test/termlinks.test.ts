import { describe, it, expect } from "vitest";
import { findLinks, linkBases, trimUrl, type PathHit, type UrlHit } from "../src/termlinks";

const paths = (line: string) => findLinks(line).filter((h): h is PathHit => h.kind === "path");
const urls = (line: string) => findLinks(line).filter((h): h is UrlHit => h.kind === "url");
// What the backend would be asked, in the order it would try them.
const cands = (line: string, n = 0) => paths(line)[n]?.cands.map((c) => c.text) ?? [];

describe("trimUrl", () => {
  it("drops the sentence's punctuation, not the address's", () => {
    expect(trimUrl("https://episko.dev/docs.")).toBe("https://episko.dev/docs");
    expect(trimUrl("https://episko.dev/a,")).toBe("https://episko.dev/a");
    expect(trimUrl("https://episko.dev/a?b=1")).toBe("https://episko.dev/a?b=1");
  });

  it("keeps a bracket the URL opened and drops one the prose did", () => {
    expect(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(trimUrl("https://episko.dev/a)")).toBe("https://episko.dev/a");
  });
});

describe("findLinks · URLs", () => {
  it("finds an address wherever it sits in a sentence", () => {
    expect(urls("see https://episko.dev/docs for more").map((u) => u.text)).toEqual(["https://episko.dev/docs"]);
    expect(urls("Local:   http://localhost:5173/").map((u) => u.text)).toEqual(["http://localhost:5173/"]);
  });

  it("reports the range the address actually occupies", () => {
    const [u] = urls("run at http://localhost:3000, then stop");
    expect(u.text).toBe("http://localhost:3000");
    expect("run at ".length).toBe(u.start);
    expect(u.end - u.start).toBe(u.text.length);
  });

  it("never also proposes the address as a path", () => {
    // `episko.dev/docs` reads like a relative path and would fight the URL for the same cells.
    expect(paths("see https://episko.dev/docs now")).toEqual([]);
  });
});

describe("findLinks · what looks like a path", () => {
  it("proposes the shapes an agent actually prints", () => {
    expect(cands("edited src/main.ts today")).toContain("src/main.ts");
    expect(cands("see /Users/tim/notes.md")).toContain("/Users/tim/notes.md");
    expect(cands("in ~/.claude/settings.json")).toContain("~/.claude/settings.json");
    expect(cands("run ./scripts/build.sh")).toContain("./scripts/build.sh");
    expect(cands("bumped package.json")).toContain("package.json");
  });

  it("offers the file alone as well as the editor's line reference", () => {
    // `src/main.ts:944` is the commonest way a path is printed and never a real file.
    expect(cands("failed at src/main.ts:944")).toEqual(
      expect.arrayContaining(["src/main.ts:944", "src/main.ts"]),
    );
  });

  it("sees through the punctuation a path is wrapped in", () => {
    expect(cands("wrote `docs/tour.md` and left")).toContain("docs/tour.md");
    expect(cands("(see docs/tour.md) for why")).toContain("docs/tour.md");
    expect(cands("**docs/tour.md** is the doc")).toContain("docs/tour.md");
    expect(cands("edited docs/tour.md, then stopped")).toContain("docs/tour.md");
  });

  it("stays off ordinary prose, flags and version numbers", () => {
    // German prose is full of capitalised words and colons, and none of them is a file.
    expect(paths("Fertig. Kurzfassung: der Termin steht schon im Kalender")).toEqual([]);
    expect(paths("passed --no-verify to the commit")).toEqual([]);
    expect(paths("upgraded to 2 and then 3")).toEqual([]);
  });
});

describe("findLinks · paths with spaces", () => {
  // The case this feature exists for: a space is every other token boundary, so this can
  // only be a proposal that disk confirms.
  const LINE = "Team-Material/I_Projekte/BA Reinickendorf/2_Kickoff_2026-09-03/deck.pdf";

  it("proposes the whole path before any prefix of it", () => {
    const c = cands(`Deck: ${LINE}`);
    expect(c[0]).toBe(LINE);
    // The bare first token is still offered, last: it wins when the following words were a sentence.
    expect(c).toContain("Team-Material/I_Projekte/BA");
    expect(c.indexOf(LINE)).toBeLessThan(c.indexOf("Team-Material/I_Projekte/BA"));
  });

  it("keeps offering shorter readings, so a sentence after a path still resolves", () => {
    const c = cands("edited src/foo.ts and then stopped");
    expect(c).toContain("src/foo.ts");
    expect(c.indexOf("src/foo.ts and then stopped")).toBeLessThan(c.indexOf("src/foo.ts"));
  });

  it("collapses the gap a line break left behind", () => {
    // A row's trailing blank cells arrive as a run of spaces when ./terminal joins the
    // rows either side of a break the agent made itself. The path on disk has one.
    const c = cands("I_Projekte/BA          Reinickendorf/deck.pdf");
    expect(c[0]).toBe("I_Projekte/BA Reinickendorf/deck.pdf");
  });

  it("never extends a bare filename across a space", () => {
    // Proposing `report.pdf final version` whole would underline half the output of any pane.
    expect(cands("wrote report.pdf final version")).toEqual(["report.pdf"]);
  });

  it("bounds the proposal list whatever the line does, and never at the bare token's cost", () => {
    const long = "a/b " + "word ".repeat(40);
    const c = cands(long);
    expect(c.length).toBeLessThanOrEqual(18);
    // Longest first, so the cap trims the far end of the list — not the usual winner.
    expect(c[c.length - 1]).toBe("a/b");
  });
});

describe("findLinks · escapes an agent printed rather than typed", () => {
  // `printf 'a src/main.ts\nline'` puts `src/main.ts\nline` in the output as one token, and the
  // backslash even makes it look like a Windows path. The path is the part before the escape.
  it("reads the path out of a literal \\n", () => {
    expect(cands("plain      src/main.ts\\nline ref   x")).toContain("src/main.ts");
  });

  it("strips the punctuation the escape was hiding behind", () => {
    // `\`CHANGELOG.md\`\nin` — the backtick only becomes trailing once the escape goes.
    expect(cands("backticked `CHANGELOG.md`\\nin parens")).toContain("CHANGELOG.md");
    expect(cands("in parens  (docs/tour.md)\\nmissing x")).toContain("docs/tour.md");
  });

  it("still reaches the file under an escape AND a line reference", () => {
    expect(cands("line ref   src/terminal.ts:42\\nbackticked x")).toEqual(
      expect.arrayContaining(["src/terminal.ts:42", "src/terminal.ts"]),
    );
  });

  it("never lets a box-drawing character into a candidate", () => {
    // An agent's TUI draws its frames with these, and a path never contains one.
    const c = cands("wrote src/a.ts \u2502 next column");
    expect(c).toContain("src/a.ts");
    expect(c.some((t) => /[\u2500-\u257f]/.test(t))).toBe(false);
  });

  it("keeps the bare file within the cap, however many readings a line generates", () => {
    // A cap that truncates looks like a path that does not exist. Cutting the escape out of
    // the longest raw puts the bare file near the front, so dedupe drops the later copies.
    const c = cands("see src/main.ts:12\\nand a b c d e f g h");
    expect(c).toContain("src/main.ts");
    expect(c.length).toBeLessThanOrEqual(24);
  });
});

describe("findLinks · one proposal per path-shaped token", () => {
  it("still proposes a second path the first one's longest candidate swallowed", () => {
    // `src/a.ts and docs/b.md` is a real candidate for the first start; stopping the scan at
    // its end would cost the second file its link. ./terminal drops the clash once disk answers.
    const line = "src/a.ts and docs/b.md both changed";
    const p = paths(line);
    expect(p.length).toBe(2);
    expect(p[0].start).toBe(0);
    expect(p[1].start).toBe(line.indexOf("docs/b.md"));
  });
});

describe("linkBases", () => {
  const DECK = "/Users/tim/Drive/Meine Ablage/Team-Material/A_Material/decks/kickoff.html";

  it("asks the directories the caller already knows, in the order given", () => {
    // Live cwd, then the drift dir, then the workdir: a shell that has `cd`ed is why the first exists.
    expect(linkBases(["/live", "/drifted", "/launched"], [])).toEqual(["/live", "/drifted", "/launched"]);
  });

  it("drops the ones that are not known yet, without losing the rest", () => {
    // A pane with no drift, or whose cwd probe has not answered, passes empty strings.
    expect(linkBases(["", "", "/launched"], [])).toEqual(["/launched"]);
    expect(linkBases(["/same", "/same"], [])).toEqual(["/same"]);
  });

  it("offers every directory the session has worked in, most specific first", () => {
    const b = linkBases(["/repo"], [DECK]);
    expect(b[0]).toBe("/repo");
    expect(b).toContain("/Users/tim/Drive/Meine Ablage/Team-Material/A_Material/decks");
    // The one that matters: the root a shortened path was written against.
    expect(b).toContain("/Users/tim/Drive/Meine Ablage");
    expect(b.indexOf("/Users/tim/Drive/Meine Ablage/Team-Material"))
      .toBeLessThan(b.indexOf("/Users/tim/Drive/Meine Ablage"));
  });

  it("stops short of the roots that would resolve anything", () => {
    // `/` and `/Users` make every relative token resolvable and tell you nothing.
    const b = linkBases([], [DECK]);
    expect(b).not.toContain("/");
    expect(b).not.toContain("/Users");
    expect(b).toContain("/Users/tim");
  });

  it("dedupes the shared prefixes of a whole file set and stays bounded", () => {
    const files = Array.from({ length: 60 }, (_, i) => `/a/b/c/d/e/f/g/h/i/j/file${i}.ts`);
    const b = linkBases(["/repo"], files);
    expect(b.length).toBeLessThanOrEqual(24);
    expect(new Set(b).size).toBe(b.length);
  });

  it("survives a pane it knows nothing about", () => {
    expect(linkBases([], [])).toEqual([]);
  });
});
