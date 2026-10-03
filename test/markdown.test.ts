import { describe, expect, it } from "vitest";
import {
  clampMdPrefs, dirOf, isMarkdownPath, joinPath, MD_DEFAULTS, renderMarkdown, resolveHref, slugify,
} from "../src/markdown";

const DOC = "/repo/docs/guide.md";
const WIN = "C:\\repo\\docs\\guide.md";
const r = (src: string, o: Partial<Parameters<typeof renderMarkdown>[1]> = {}) =>
  renderMarkdown(src, { docPath: DOC, images: true, remote: false, ...o });

describe("a stored preference is narrowed, never trusted", () => {
  it("falls back to the defaults for junk", () => {
    expect(clampMdPrefs(null)).toEqual(MD_DEFAULTS);
    expect(clampMdPrefs("x" as any)).toEqual(MD_DEFAULTS);
    expect(clampMdPrefs({ width: "huge", size: 3 } as any)).toEqual(MD_DEFAULTS);
  });
  it("keeps what is valid", () => {
    expect(clampMdPrefs({ enabled: false, width: "full", size: "l", outline: false, images: false, remote: true }))
      .toEqual({ enabled: false, width: "full", size: "l", outline: false, images: false, remote: true });
  });
  it("loads web images only when asked in so many words", () => {
    expect(clampMdPrefs({ remote: "yes" } as any).remote).toBe(false);
  });
});

describe("which paths the reader takes", () => {
  it("knows the markdown extensions, in any case", () => {
    for (const p of ["README.md", "a/b.MD", "x.markdown", "n.mdx", "C:\\r\\CHANGELOG.md"]) expect(isMarkdownPath(p)).toBe(true);
  });
  it("leaves every other file to the OS", () => {
    for (const p of ["a.rs", "md", "readme.md.bak", "x.mdl", "dir.md/file.ts"]) expect(isMarkdownPath(p)).toBe(false);
  });
});

describe("paths", () => {
  it("folds . and .. and keeps the document's separator", () => {
    expect(joinPath("/repo/docs", "../README.md")).toBe("/repo/README.md");
    expect(joinPath("/repo/docs", "./a/./b.md")).toBe("/repo/docs/a/b.md");
    expect(joinPath("C:\\repo\\docs", "../src/x.ts")).toBe("C:\\repo\\src\\x.ts");
    expect(joinPath("C:\\repo\\docs", "img/a.png")).toBe("C:\\repo\\docs\\img\\a.png");
  });
  it("never climbs above the root", () => {
    expect(joinPath("/repo", "../../../etc/x.md")).toBe("/etc/x.md");
    expect(joinPath("C:\\repo", "..\\..\\x.md")).toBe("C:\\x.md");
  });
  it("takes an absolute link as it stands", () => {
    expect(joinPath("/repo", "/other/a.md")).toBe("/other/a.md");
  });
  it("names a file's folder", () => {
    expect(dirOf("/repo/docs/a.md")).toBe("/repo/docs");
    expect(dirOf(WIN)).toBe("C:\\repo\\docs");
    expect(dirOf("/a.md")).toBe("/");
  });
});

describe("where a link leads", () => {
  it("keeps http(s) and mailto as urls", () => {
    expect(resolveHref("https://x.io/a", DOC)).toEqual({ kind: "url", url: "https://x.io/a" });
    expect(resolveHref("mailto:a@b.c", DOC).kind).toBe("url");
  });
  it("leads any other scheme nowhere", () => {
    for (const h of ["javascript:alert(1)", "JAVASCRIPT:x", "data:text/html,x", "file:///etc/passwd", "vbscript:x"]) {
      expect(resolveHref(h, DOC)).toEqual({ kind: "none" });
    }
  });
  it("reads an anchor as a heading slug", () => {
    expect(resolveHref("#Getting-Started", DOC)).toEqual({ kind: "anchor", slug: "getting-started" });
  });
  it("resolves a relative file against the document, keeping its fragment", () => {
    expect(resolveHref("../README.md#Install", DOC)).toEqual({ kind: "file", path: "/repo/README.md", slug: "install" });
    expect(resolveHref("my%20notes.md", DOC)).toEqual({ kind: "file", path: "/repo/docs/my notes.md", slug: "" });
  });
  it("reads a leading slash from the repository when there is one", () => {
    expect(resolveHref("/docs/x.md", DOC, "/repo")).toEqual({ kind: "file", path: "/repo/docs/x.md", slug: "" });
    expect(resolveHref("/docs/x.md", DOC)).toEqual({ kind: "file", path: "/docs/x.md", slug: "" });
  });
  it("takes a Windows drive path as a file, not a scheme", () => {
    expect(resolveHref("C:/repo/a.md", WIN).kind).toBe("file");
  });
});

describe("heading slugs", () => {
  it("match GitHub's", () => {
    const seen = new Map<string, number>();
    expect(slugify("Getting Started!", seen)).toBe("getting-started");
    expect(slugify("What's new in 0.3.0?", seen)).toBe("whats-new-in-030");
    expect(slugify("Getting Started!", seen)).toBe("getting-started-1");
    expect(slugify("Über uns", seen)).toBe("über-uns");
  });
});

describe("rendering", () => {
  it("lists the headings with their slugs and marks them for the outline", () => {
    const d = r("# Title\n\n## Install `pnpm`\n\ntext\n\n## Install `pnpm`");
    expect(d.headings.map((h) => [h.depth, h.text, h.slug])).toEqual([
      [1, "Title", "title"], [2, "Install pnpm", "install-pnpm"], [2, "Install pnpm", "install-pnpm-1"],
    ]);
    expect(d.html).toContain('data-mdh="install-pnpm-1"');
  });
  it("draws gfm: tables, task lists, strikethrough", () => {
    const d = r("| a | b |\n|---|:-:|\n| 1 | 2 |\n\n- [ ] todo\n- [x] done\n\n~~gone~~");
    expect(d.html).toContain("<table>");
    expect(d.html).toContain("☐");
    expect(d.html).toContain("☑");
    expect(d.html).toContain("<del>gone</del>");
    expect(d.html).not.toContain("<input");
  });
  it("links carry a data attribute and never the url as an href", () => {
    const d = r("[a](https://x.io) [b](../README.md#x) [c](#top) https://auto.io");
    expect(d.html).toContain('data-mdurl="https://x.io"');
    expect(d.html).toContain('data-mdfile="/repo/README.md" data-mdslug="x"');
    expect(d.html).toContain('data-mdanchor="top"');
    expect(d.html).toContain('data-mdurl="https://auto.io"');
    expect(d.html).not.toMatch(/href="(?!#")/);
  });
  it("collects a local image to read in, and leaves a web image unfetched by default", () => {
    const d = r("![logo](img/logo.png) ![web](https://e.com/a.png)");
    expect(d.images).toEqual(["/repo/docs/img/logo.png"]);
    expect(d.html).toContain('data-mdimg="/repo/docs/img/logo.png"');
    expect(d.html).not.toContain("src=\"https://e.com");
    expect(d.html).toContain('data-mdurl="https://e.com/a.png"');
  });
  it("loads a web image only when the setting says so, without a referrer", () => {
    const d = r("![web](https://e.com/a.png)", { remote: true });
    expect(d.html).toContain('src="https://e.com/a.png"');
    expect(d.html).toContain('referrerpolicy="no-referrer"');
  });
  it("draws no local image when those are off", () => {
    const d = r("![logo](logo.png)", { images: false });
    expect(d.images).toEqual([]);
    expect(d.html).toContain("mdr-imgref");
  });
  it("escapes code", () => {
    expect(r("```ts\nconst a = \"<b>\";\n```").html).toContain("&lt;b&gt;");
    expect(r("`<i>`").html).toContain("&lt;i&gt;");
  });
});

describe("author HTML never reaches the webview", () => {
  const nasty = [
    "<script>alert(1)</script>",
    "text <script>alert(1)</script> more",
    "<img src=x onerror=alert(1)>",
    "<p align=center><img src=\"x.png\" onerror=\"alert(1)\"></p>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<iframe src=\"https://evil\"></iframe>",
    "<svg onload=alert(1)>",
    "<div style=\"background:url(javascript:x)\">x</div>",
    "[x](javascript:alert(1))",
    "![x](javascript:alert(1))",
    "[x](<javascript:alert(1)>)",
    "<details open ontoggle=alert(1)><summary>s</summary>b</details>",
    "<style>body{display:none}</style>",
    "<!-- <script>alert(1)</script> -->",
    "<b onmouseover=alert(1)>bold</b>",
    "| a |\n|---|\n| <img src=x onerror=alert(1)> |",
  ];
  for (const src of nasty) {
    it(`renders ${JSON.stringify(src).slice(0, 50)} inert`, () => {
      const { html } = r(src);
      expect(html).not.toMatch(/<(script|iframe|svg|style|object|embed|form|input)\b/i);
      expect(html).not.toMatch(/\son\w+\s*=/i);
      expect(html).not.toMatch(/javascript:/i);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      // The only src an image may carry is one we wrote: http(s), and only with web images on.
      expect(html).not.toMatch(/\ssrc=/i);
    });
  }
  it("keeps harmless tags by name alone", () => {
    const { html } = r("Press <kbd class=x>Ctrl</kbd> and <sup>2</sup>");
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<sup>2</sup>");
  });
  it("turns a README's centred logo into one of our images", () => {
    const d = r("<p align=\"center\">\n  <img src=\"docs/logo.png\" alt=\"Logo\" width=\"120\">\n</p>");
    expect(d.images).toEqual(["/repo/docs/docs/logo.png"]);
    expect(d.html).toContain('alt="Logo"');
    expect(d.html).not.toContain("width");
  });
});
