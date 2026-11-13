// The thread reader's rules: an issue or pull request pulled INTO Episko, so the queue's ⤢
// answers "what is this actually about?" without a browser and without losing the pane. Data
// in, string out — ./issueview draws it, ./dashboard fetches it. See docs/dashboard.md.

import { Marked, type Tokens } from "marked";
import { esc, escAttr } from "./format";
import { closeAuthorTags, htmlOut } from "./markdown";
import { icon } from "./svgicons";

/// One comment, as the backend's `GhComment` sends it.
export interface GhComment { who: string; at: string; body: string }

/// Mirrors `GhIssueRead`. `available: false` carries the reason and keeps `number`/`kind`,
/// because a reader that cannot say which thread it failed on is a panel about nothing.
export interface GhIssueRead {
  available: boolean;
  reason: string | null;
  number: number;
  kind: string; // "issue" | "pr", as the row that opened it asked
  title: string;
  url: string;
  state: string; // OPEN | CLOSED | MERGED, as gh spells it
  author: string | null;
  created_at: string;
  updated_at: string;
  labels: string[];
  assignees: string[];
  body: string;
  comments: GhComment[];
  head_ref: string | null; // a pull request's branches; null on an issue
  base_ref: string | null;
  same_repo: boolean;      // false: the head lives in a fork
}

const at = (iso: string): number => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
};

/// "3d ago", and nothing at all for a date that does not parse: a thread whose clock we
/// cannot read must not print `Invalid Date` beside a comment somebody wrote.
export function ago(iso: string, now: number): string {
  const t = at(iso);
  if (!t || now < t) return "";
  // Floored, never rounded: an age that rounds UP reads as older than the thing is, and
  // half a minute becoming "1m ago" is the same lie at the only scale anybody checks.
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 31) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}

/// One word for where the thread stands. A merged PR is not a closed one, and the tone the
/// panel wears reads off this rather than off `state` raw.
export const stateWord = (i: GhIssueRead): string => (i.state || "open").toLowerCase();

/// The line under the title: where it stands, who opened it and when, who holds it, and how
/// much has been said since — the facts the queue row had no width for.
export function threadLine(i: GhIssueRead, now: number): string {
  const n = i.comments.length;
  const opened = ago(i.created_at, now);
  return [
    stateWord(i),
    i.author ? `by ${i.author}` : "",
    opened ? `opened ${opened}` : "",
    i.assignees.length ? `◍ ${i.assignees.join(", ")}` : "",
    n ? `${n} comment${n === 1 ? "" : "s"}` : "no comments yet",
  ].filter(Boolean).join(" · ");
}

// ---------- markdown, as GitHub draws a thread ----------
// `marked` (GFM) behind ./markdown's guard on author HTML: tables, task lists and `<details>`
// come through, an attribute never does. A soft break is a break, as it is on github.com.

/// Where a link's URL goes: the attribute the host pane's own click listener probes.
export type LinkAttr = "data-dashurl" | "data-rvurl";

const HTTP = /^https?:\/\/[^\s<>"]+$/i;

// Opened by the pane's listener, never by navigating the webview; anything but http(s) stays
// text, because a body is somebody else's markup and `javascript:` is a URL too.
const link = (url: string, inner: string, attr: LinkAttr): string =>
  HTTP.test(url) ? `<a class="md-a" href="#" ${attr}="${escAttr(url)}">${inner}</a>` : inner;

// Drawn as a link and never fetched: an image would reach the network for whatever a stranger
// put in an issue.
const image = (url: string, alt: string, attr: LinkAttr): string =>
  link(url, `${icon("image")}${esc(alt || "image")}`, attr);

function engine(attr: LinkAttr): Marked {
  const md = new Marked({ gfm: true, breaks: true, async: false });
  md.use({
    renderer: {
      html: ({ text }: Tokens.HTML | Tokens.Tag) => htmlOut(text, (src, alt) => (src ? image(src, alt, attr) : "")),
      heading({ tokens, depth }: Tokens.Heading) {
        return `<p class="md-h${depth > 2 ? " sm" : ""}">${this.parser.parseInline(tokens)}</p>`;
      },
      // A badge is an image inside a link, and an anchor inside an anchor splits the line.
      link({ href, tokens }: Tokens.Link) {
        return link(href, this.parser.parseInline(tokens).replace(/<a\b[^>]*>|<\/a>/g, ""), attr);
      },
      image: ({ href, text }: Tokens.Image) => image(href, text, attr),
      code: ({ text }: Tokens.Code) => `<pre><code>${esc(text).replace(/>/g, "&gt;")}</code></pre>`,
      checkbox: ({ checked }: Tokens.Checkbox) =>
        `<span class="md-tk">${icon(checked ? "squareCheck" : "square", "solo")}</span> `,
    },
  });
  return md;
}

const engines: Partial<Record<LinkAttr, Marked>> = {};
const cache = new Map<string, string>();

/// A body or a comment. Cached by text, since ./dashboard rebuilds the reader on every renderAll.
export function mdHtml(src: string, attr: LinkAttr): string {
  const key = `${attr}\u0000${src}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (cache.size >= 200) cache.clear();
  const html = closeAuthorTags((engines[attr] ??= engine(attr)).parse(src || "") as string).trim();
  cache.set(key, html);
  return html;
}

// ↑/↓ in the reader walks the rail it was opened from. A thread the list no longer holds (a
// filter dropped it, or it closed) steps to the list's own end rather than going nowhere.
export function stepThread(list: readonly number[], at: number, dir: 1 | -1): number | null {
  if (!list.length) return null;
  const i = list.indexOf(at);
  if (i < 0) return dir > 0 ? list[0] : list[list.length - 1];
  const next = list[i + dir];
  return next === undefined ? null : next;
}
