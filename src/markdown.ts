// The markdown reader's rules: which paths it takes, how a document becomes markup, and where
// each of its links leads. Data in, string out; ./mdreader owns the dialog and the reads.
// The webview runs with IPC and no CSP, so NO author markup reaches it: see docs/markdown.md.

import { Marked, type Tokens } from "marked";
import { esc, escAttr } from "./format";

export type MdWidth = "narrow" | "wide" | "full";
export type MdSize = "s" | "m" | "l";
export interface MdPrefs {
  enabled: boolean;  // off: a markdown file opens in the OS's own app, as every other file does
  width: MdWidth;
  size: MdSize;
  outline: boolean;  // the headings rail beside the text
  images: boolean;   // images that live on disk beside the document
  remote: boolean;   // images on the web, which a render would fetch
}

export const MD_DEFAULTS: MdPrefs = { enabled: true, width: "narrow", size: "m", outline: true, images: true, remote: false };
export const MD_WIDTHS: MdWidth[] = ["narrow", "wide", "full"];
export const MD_SIZES: MdSize[] = ["s", "m", "l"];

export function clampMdPrefs(p: Partial<MdPrefs> | null | undefined): MdPrefs {
  const o = p && typeof p === "object" ? p : {};
  return {
    enabled: o.enabled !== false,
    width: MD_WIDTHS.includes(o.width as MdWidth) ? o.width as MdWidth : MD_DEFAULTS.width,
    size: MD_SIZES.includes(o.size as MdSize) ? o.size as MdSize : MD_DEFAULTS.size,
    outline: o.outline !== false,
    images: o.images !== false,
    remote: o.remote === true,
  };
}

// Mirrors `MD_EXTS` in platform.rs, which refuses to read anything else.
const MD_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;
export const isMarkdownPath = (p: string): boolean => MD_EXT.test(p.replace(/[#?].*$/, ""));

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
export const isImagePath = (p: string): boolean => IMG_EXT.test(p);

// ---------- paths ----------

const isAbs = (p: string): boolean => p.startsWith("/") || p.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(p);
const sepOf = (p: string): string => (p.includes("\\") && !p.includes("/") ? "\\" : "/");

export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p.slice(0, i + 1) : p.slice(0, i);
}

/// `rel` against the directory `dir`, spelled in `dir`'s separator; `.` and `..` are folded so
/// the reader's back stack and its title never show `docs/../README.md`.
export function joinPath(dir: string, rel: string): string {
  const sep = sepOf(dir);
  const whole = isAbs(rel) ? rel : `${dir.replace(/[\\/]+$/, "")}/${rel}`;
  const lead = /^([A-Za-z]:|\\\\[^\\/]+|)[\\/]?/.exec(whole)?.[0] ?? "";
  const out: string[] = [];
  for (const part of whole.slice(lead.length).split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const head = lead.replace(/[\\/]$/, "") + (lead ? sep : "");
  return head + out.join(sep);
}

// ---------- links ----------

export type MdTarget =
  | { kind: "url"; url: string }
  | { kind: "anchor"; slug: string }
  | { kind: "file"; path: string; slug: string }
  | { kind: "none" };

const safeDecode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

/// Where a link in `docPath` leads. `root` answers a `/docs/x.md` link the way GitHub does:
/// from the repository, not the disk. Any scheme but http(s) and mailto leads nowhere.
export function resolveHref(href: string, docPath: string, root = ""): MdTarget {
  const h = (href || "").trim();
  if (!h) return { kind: "none" };
  if (h.startsWith("#")) return { kind: "anchor", slug: safeDecode(h.slice(1)).toLowerCase() };
  if (/^(https?:|mailto:)/i.test(h)) return { kind: "url", url: h };
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) && !/^[A-Za-z]:[\\/]/.test(h)) return { kind: "none" };
  const hash = h.indexOf("#");
  const raw = safeDecode((hash < 0 ? h : h.slice(0, hash)).replace(/\?.*$/, ""));
  const slug = hash < 0 ? "" : safeDecode(h.slice(hash + 1)).toLowerCase();
  if (!raw) return slug ? { kind: "anchor", slug } : { kind: "none" };
  const base = raw.startsWith("/") && root ? root : dirOf(docPath);
  const rel = raw.startsWith("/") && root ? raw.slice(1) : raw;
  return { kind: "file", path: joinPath(base, rel), slug };
}

// ---------- headings ----------

/// GitHub's anchor for a heading: lower-cased, punctuation dropped, spaces to hyphens, and a
/// repeat numbered, so a README's own `#installation` link lands where it does on github.com.
export function slugify(text: string, seen: Map<string, number>): string {
  const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

// ---------- author HTML ----------
// Only a tag name ever survives, never an attribute: `<kbd>` is kept, `<a onclick>` is not.
// An `<img>` becomes one of our images, so a centred README logo still shows.

const KEEP_TAGS = new Set(["kbd", "sub", "sup", "b", "i", "em", "strong", "s", "del", "ins", "u", "mark",
  "details", "summary", "br", "code", "small"]);
const VOID = new Set(["br"]);

const attrOf = (tag: string, name: string): string =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((x) => x != null) ?? "";

function htmlOut(raw: string, img: (src: string, alt: string) => string): string {
  const src = raw.replace(/<!--[\s\S]*?(-->|$)/g, "");
  let out = "";
  let last = 0;
  for (const m of src.matchAll(/<(\/?)([A-Za-z][\w-]*)\b[^>]*>/g)) {
    out += esc(src.slice(last, m.index)).replace(/>/g, "&gt;");
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (name === "img" && !m[1]) out += img(attrOf(m[0], "src"), attrOf(m[0], "alt"));
    else if (KEEP_TAGS.has(name) && !(m[1] && VOID.has(name))) out += `<${m[1]}${name}>`;
  }
  return out + esc(src.slice(last)).replace(/>/g, "&gt;");
}

// ---------- render ----------

export interface MdHeading { depth: number; text: string; slug: string }
export interface MdDoc {
  html: string;
  headings: MdHeading[];
  images: string[]; // absolute paths the dialog must read in, in document order
}
export interface MdOpts { docPath: string; root?: string; images: boolean; remote: boolean }

const plain = (s: string): string => s.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/// Links carry a data attribute and `href="#"`, never the URL: nothing in the reader navigates
/// the webview, and the click decides what a target means (./mdreader).
export function linkAttrs(t: MdTarget): string {
  if (t.kind === "url") return ` data-mdurl="${escAttr(t.url)}"`;
  if (t.kind === "anchor") return ` data-mdanchor="${escAttr(t.slug)}"`;
  if (t.kind === "file") return ` data-mdfile="${escAttr(t.path)}"${t.slug ? ` data-mdslug="${escAttr(t.slug)}"` : ""}`;
  return "";
}

export function renderMarkdown(src: string, o: MdOpts): MdDoc {
  const headings: MdHeading[] = [];
  const images: string[] = [];
  const seen = new Map<string, number>();
  const image = (href: string, alt: string, title = ""): string => {
    const t = resolveHref(href, o.docPath, o.root);
    const tip = title ? ` title="${escAttr(title)}"` : "";
    if (t.kind === "url" && /^https?:/i.test(t.url) && o.remote) {
      return `<img class="mdr-img" src="${escAttr(t.url)}" alt="${escAttr(alt)}"${tip} loading="lazy" referrerpolicy="no-referrer">`;
    }
    if (t.kind === "file" && isImagePath(t.path) && o.images) {
      images.push(t.path);
      return `<img class="mdr-img" data-mdimg="${escAttr(t.path)}" alt="${escAttr(alt)}"${tip}>`;
    }
    // Not shown, still reachable: the reason is the tooltip, the file one click away.
    const why = t.kind === "url" ? "A web image; Settings › Reader can load these" : "An image beside the document";
    return `<a class="mdr-a mdr-imgref" href="#"${linkAttrs(t)} title="${escAttr(why)}">▤ ${esc(alt || "image")}</a>`;
  };
  const md = new Marked({ gfm: true, breaks: false, async: false });
  md.use({
    renderer: {
      html: ({ text, block }: Tokens.HTML | Tokens.Tag) => {
        const body = htmlOut(text, (s, a) => (s ? image(s, a) : ""));
        if (!block) return body;
        return body.trim() ? `<div class="mdr-html">${body}</div>` : "";
      },
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const text = plain(inner);
        const slug = slugify(text, seen);
        headings.push({ depth, text, slug });
        return `<h${depth} class="mdr-h" data-mdh="${escAttr(slug)}">${inner}</h${depth}>`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const t = resolveHref(href, o.docPath, o.root);
        const inner = this.parser.parseInline(tokens);
        if (t.kind === "none") return inner;
        const tip = title || (t.kind === "file" ? t.path : t.kind === "url" ? t.url : "");
        return `<a class="mdr-a" href="#"${linkAttrs(t)}${tip ? ` title="${escAttr(tip)}"` : ""}>${inner}</a>`;
      },
      image: ({ href, title, text }: Tokens.Image) => image(href, text, title ?? ""),
      code: ({ text, lang }: Tokens.Code) =>
        `<pre class="mdr-pre"${lang ? ` data-lang="${escAttr(lang.split(/\s/)[0])}"` : ""}><code>${esc(text).replace(/>/g, "&gt;")}</code></pre>`,
      checkbox: ({ checked }: Tokens.Checkbox) => `<span class="mdr-tk">${checked ? "☑" : "☐"}</span> `,
    },
  });
  const html = md.parse(src || "") as string;
  return { html, headings, images };
}
