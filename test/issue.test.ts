import { describe, expect, it } from "vitest";
import { ago, inlineIssue, mdHtml, stateWord, threadLine, type GhIssueRead } from "../src/issue";

const NOW = new Date(2026, 6, 31, 14, 0, 0).getTime();
const back = (ms: number) => new Date(NOW - ms).toISOString();

const iss = (o: Partial<GhIssueRead> = {}): GhIssueRead => ({
  available: true, reason: null, number: 37, kind: "issue", title: "a thing",
  url: "https://github.com/o/r/issues/37", state: "OPEN", author: "tim",
  created_at: back(3 * 86_400_000), updated_at: back(3600_000), labels: [], assignees: [],
  body: "", comments: [], ...o,
});

describe("ago", () => {
  it("says nothing at all for a date it cannot read", () => {
    // `Invalid Date` beside a comment somebody wrote is worse than no timestamp.
    expect(ago("", NOW)).toBe("");
    expect(ago("whenever", NOW)).toBe("");
  });

  it("never counts backwards from a clock that is ahead of ours", () => {
    expect(ago(new Date(NOW + 60_000).toISOString(), NOW)).toBe("");
  });

  it("climbs minutes to months", () => {
    expect(ago(back(30_000), NOW)).toBe("just now");
    expect(ago(back(20 * 60_000), NOW)).toBe("20m ago");
    expect(ago(back(5 * 3600_000), NOW)).toBe("5h ago");
    expect(ago(back(3 * 86_400_000), NOW)).toBe("3d ago");
    expect(ago(back(70 * 86_400_000), NOW)).toBe("2 months ago");
  });
});

describe("threadLine", () => {
  it("says where it stands, who opened it, who holds it and how much has been said", () => {
    const line = threadLine(iss({
      assignees: ["sam"], comments: [{ who: "sam", at: back(3600_000), body: "hi" }],
    }), NOW);
    expect(line).toBe("open · by tim · opened 3d ago · ◍ sam · 1 comment");
  });

  it("drops a clause it has no fact for rather than printing an empty one", () => {
    expect(threadLine(iss({ author: null, created_at: "" }), NOW)).toBe("open · no comments yet");
  });

  it("tells a merged pull request from a closed one", () => {
    expect(stateWord(iss({ state: "MERGED" }))).toBe("merged");
    expect(stateWord(iss({ state: "" }))).toBe("open");
  });
});

describe("inlineIssue", () => {
  it("escapes the markup in somebody else's prose", () => {
    expect(inlineIssue("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("leaves a code span alone, whatever is inside it", () => {
    // Taking code spans out first is the whole rule: every other order eats code.
    expect(inlineIssue("try `a **b** [c](d)` here"))
      .toBe("try <code>a **b** [c](d)</code> here");
  });

  it("links http(s) and nothing else", () => {
    expect(inlineIssue("[docs](https://example.com/x)"))
      .toContain('data-dashurl="https://example.com/x"');
    // Nested parens leave the tail as text; what matters is that no link comes out of it.
    expect(inlineIssue("[docs](javascript:alert(1))")).not.toContain("data-dashurl");
    expect(inlineIssue("see https://example.com/y")).toContain('data-dashurl="https://example.com/y"');
  });

  it("draws an image as a link rather than fetching it", () => {
    const out = inlineIssue("![a shot](https://example.com/s.png)");
    expect(out).toContain("▤ a shot");
    expect(out).not.toContain("<img");
  });

  it("leaves an underscore alone, because snake_case is commoner than _emphasis_", () => {
    expect(inlineIssue("read bg_log_roots first")).toBe("read bg_log_roots first");
    expect(inlineIssue("**hard** and *soft* and ~~gone~~"))
      .toBe("<b>hard</b> and <i>soft</i> and <s>gone</s>");
  });
});

describe("mdHtml", () => {
  it("keeps a fenced block verbatim and escaped", () => {
    const out = mdHtml("before\n```rs\nlet x = a<b;\n```\nafter");
    expect(out).toContain("<pre><code>let x = a&lt;b;</code></pre>");
    expect(out).toContain("<p>before</p>");
    expect(out).toContain("<p>after</p>");
  });

  it("does not leave an unclosed fence eating the rest of the thread", () => {
    expect(mdHtml("```\nstill open")).toBe("<pre><code>still open</code></pre>");
  });

  it("draws both kinds of list, a task list included", () => {
    const out = mdHtml("- one\n- [ ] two\n- [x] three\n\n1. first\n2. second");
    expect(out).toContain("<ul><li>one</li>");
    expect(out).toContain("☐</span> two");
    expect(out).toContain("☑</span> three");
    expect(out).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("keeps a soft line break, because people write issues in lines", () => {
    expect(mdHtml("one\ntwo")).toBe("<p>one<br>two</p>");
  });

  it("draws headings, quotes and rules", () => {
    expect(mdHtml("# Big")).toBe('<p class="md-h">Big</p>');
    expect(mdHtml("#### Small")).toBe('<p class="md-h sm">Small</p>');
    expect(mdHtml("> quoted")).toBe("<blockquote>quoted</blockquote>");
    expect(mdHtml("---")).toBe("<hr>");
  });

  it("renders an empty body as nothing rather than as a stray tag", () => {
    expect(mdHtml("")).toBe("");
    expect(mdHtml("\n\n")).toBe("");
  });

  it("closes every block it opened", () => {
    const out = mdHtml("- one\ntext");
    expect(out).toBe("<ul><li>one</li></ul><p>text</p>");
  });
});
