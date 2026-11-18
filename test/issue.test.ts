import { describe, expect, it } from "vitest";
import { ago, mdHtml, stateWord, stepThread, threadLine, type GhIssueRead } from "../src/issue";
import { icon } from "../src/svgicons";

const NOW = new Date(2026, 6, 31, 14, 0, 0).getTime();
const back = (ms: number) => new Date(NOW - ms).toISOString();

const iss = (o: Partial<GhIssueRead> = {}): GhIssueRead => ({
  available: true, reason: null, number: 37, kind: "issue", title: "a thing",
  url: "https://github.com/o/r/issues/37", state: "OPEN", author: "tim",
  created_at: back(3 * 86_400_000), updated_at: back(3600_000), labels: [], assignees: [],
  body: "", comments: [], head_ref: null, base_ref: null, same_repo: true, ...o,
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

describe("mdHtml", () => {
  const rv = (src: string) => mdHtml(src, "data-rvurl");

  it("draws a table, which is why a PR's test report used to read as pipes", () => {
    const out = rv("| Check | Result |\n| --- | --- |\n| `pytest` | 3111 passed |");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>Check</th>");
    expect(out).toContain("<td><code>pytest</code></td>");
    expect(out).not.toContain("| ---");
  });

  it("keeps a soft line break, because people write issues in lines", () => {
    expect(rv("one\ntwo")).toBe("<p>one<br>two</p>");
  });

  it("leaves snake_case alone and draws emphasis as GitHub does", () => {
    expect(rv("read bg_log_roots first")).toBe("<p>read bg_log_roots first</p>");
    expect(rv("**hard** and *soft* and ~~gone~~"))
      .toBe("<p><strong>hard</strong> and <em>soft</em> and <del>gone</del></p>");
  });

  it("keeps code verbatim and escaped, whatever is inside it", () => {
    expect(rv("try `a **b** [c](https://d.io)` here")).toBe("<p>try <code>a **b** [c](https://d.io)</code> here</p>");
    const out = rv("before\n```rs\nlet x = a<b;\n```\nafter");
    expect(out).toContain("<pre><code>let x = a&lt;b;</code></pre>");
    expect(out).toContain("<p>before</p>");
    expect(out).toContain("<p>after</p>");
    expect(rv("```\nstill open")).toBe("<pre><code>still open</code></pre>");
  });

  it("draws nested lists and task lists", () => {
    const out = rv("- one\n  - inner\n- [ ] two\n- [x] three\n\n1. first\n2. second");
    expect(out).toMatch(/<li>one<ul>\s*<li>inner<\/li>/);
    expect(out).toContain(`${icon("square", "solo")}</span> two`);
    expect(out).toContain(`${icon("squareCheck", "solo")}</span> three`);
    expect(out).not.toContain("<input");
    expect(out).toMatch(/<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/);
  });

  it("draws headings at a thread's size, quotes and rules", () => {
    expect(rv("# Big")).toBe('<p class="md-h">Big</p>');
    expect(rv("#### Small")).toBe('<p class="md-h sm">Small</p>');
    expect(rv("> quoted")).toMatch(/^<blockquote>\s*<p>quoted<\/p>\s*<\/blockquote>$/);
    expect(rv("---")).toBe("<hr>");
  });

  it("renders an empty body as nothing rather than as a stray tag", () => {
    expect(rv("")).toBe("");
    expect(rv("\n\n")).toBe("");
  });

  it("hands a link to the pane it is drawn in, and never as an href", () => {
    // The review stage listens for data-rvurl alone: a dashboard attribute there is a dead click.
    expect(rv("[docs](https://x.io/?a=1&b=2)")).toContain('data-rvurl="https://x.io/?a=1&amp;b=2"');
    expect(mdHtml("[docs](https://x.io)", "data-dashurl")).toContain('data-dashurl="https://x.io"');
    expect(rv("see https://e.com/y.")).toContain('data-rvurl="https://e.com/y">https://e.com/y</a>.');
    expect(rv("[a](https://x.io) https://y.io")).not.toMatch(/href="(?!#")/);
  });

  it("links http(s) and nothing else", () => {
    expect(rv("[docs](javascript:alert(1))")).not.toContain("data-rvurl");
    expect(rv("[notes](docs/x.md) mail a@b.co")).toBe("<p>notes mail a@b.co</p>");
  });

  it("draws an image as a link rather than fetching it, markdown or HTML", () => {
    const md = rv("![a shot](https://example.com/s.png)");
    expect(md).toContain(`${icon("image")}a shot</a>`);
    const html = rv('<img width="300" src="https://github.com/user-attachments/assets/abc" alt="shot">');
    expect(html).toContain('data-rvurl="https://github.com/user-attachments/assets/abc"');
    for (const out of [md, html]) expect(out).not.toMatch(/<img|\ssrc=/);
  });

  it("puts a badge in one link, not an anchor inside an anchor", () => {
    const out = rv("[![ci](https://img.io/b.svg)](https://ci.io/run)");
    expect(out.match(/<a\b/g)).toHaveLength(1);
    expect(out).toContain('data-rvurl="https://ci.io/run"');
  });

  it("drops what a PR template left as a comment and keeps a fold around its code", () => {
    expect(rv("<!-- describe your change -->\nFixes it")).toBe("<p>Fixes it</p>");
    const out = rv("<details>\n<summary>Logs</summary>\n\n```\nlog\n```\n</details>");
    expect(out).toMatch(/^<details>\s*<summary>Logs<\/summary><pre><code>log<\/code><\/pre><\/details>$/);
  });

  it("closes an author's tag inside the body it opened in", () => {
    // Bodies are painted one after another, so an open <b> would embolden the next comment.
    expect(rv("Text <b>bold\n\nnext").endsWith("</b>")).toBe(true);
    expect(rv("</b></details> stray")).toBe("<p> stray</p>");
  });

  const nasty = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<iframe src=\"https://evil\"></iframe>",
    "<svg onload=alert(1)>",
    "<div style=\"background:url(javascript:x)\">x</div>",
    "[x](<javascript:alert(1)>)",
    "![x](javascript:alert(1))",
    "<details open ontoggle=alert(1)><summary>s</summary>b</details>",
    "<style>body{display:none}</style>",
    "| a |\n|---|\n| <img src=x onerror=alert(1)> |",
  ];
  for (const src of nasty) {
    it(`renders ${JSON.stringify(src).slice(0, 50)} inert`, () => {
      const out = rv(src).replaceAll(icon("image"), "");
      expect(out).not.toMatch(/<(script|iframe|svg|style|object|embed|form|input|img)\b/i);
      expect(out).not.toMatch(/\son\w+\s*=/i);
      expect(out).not.toMatch(/javascript:/i);
      expect(out).not.toMatch(/\s(style|src)\s*=/i);
    });
  }
});

describe("stepThread", () => {
  it("walks the list in its own order and stops at either end", () => {
    expect(stepThread([118, 117, 116], 117, 1)).toBe(116);
    expect(stepThread([118, 117, 116], 117, -1)).toBe(118);
    expect(stepThread([118, 117, 116], 116, 1)).toBeNull();
    expect(stepThread([118, 117, 116], 118, -1)).toBeNull();
  });
  it("enters the list from the end the key points into when the thread is not on it", () => {
    // A filter can drop the open thread from its rail; the arrows must still go somewhere.
    expect(stepThread([5, 4, 3], 99, 1)).toBe(5);
    expect(stepThread([5, 4, 3], 99, -1)).toBe(3);
    expect(stepThread([], 99, 1)).toBeNull();
  });
});
