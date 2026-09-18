// The thread reader's rules: an issue or pull request pulled INTO Episko, so the queue's ⤢
// answers "what is this actually about?" without a browser and without losing the pane. Data
// in, string out — ./issueview draws it, ./dashboard fetches it. See docs/dashboard.md.

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

// ---------- markdown, enough for a thread and no more ----------
// Fenced code, headings, lists (task lists included), quotes, rules and paragraphs. GitHub's
// flavour is far larger; what this does not know renders as the paragraph it looks like,
// which is honest where half-parsing it would quietly drop somebody's words.

const escHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const HTTP = /^https?:\/\/[^\s<>"']+$/i;

// A link opens in the OS browser through the pane's own `data-dashurl`, never by navigating
// the webview — and anything that is not http(s) stays text, because a body is somebody
// else's markup and `javascript:` is a URL too.
function link(url: string, text: string): string {
  const raw = url.replace(/&amp;/g, "&");
  if (!HTTP.test(raw)) return text;
  return `<a class="md-a" href="#" data-dashurl="${escHtml(raw).replace(/"/g, "&quot;")}">${text}</a>`;
}

/// Inline markup for one line. Code spans come out FIRST: a star or a bracket inside one is
/// text, and every other order is how a renderer starts eating code. Underscores are left
/// alone on purpose — `snake_case` is commoner than `_emphasis_` in a thread about code.
export function inlineIssue(s: string): string {
  const code: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_m, c: string) =>
    `\u0000${code.push(`<code>${escHtml(c)}</code>`) - 1}\u0000`);
  t = escHtml(t);
  // An image is drawn as a link and never fetched: rendering one would reach the network for
  // whatever a stranger put in an issue.
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) =>
    link(url, `▤ ${alt || "image"}`));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, text: string, url: string) => link(url, text));
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g, (_m, pre: string, url: string) => pre + link(url, url));
  t = t.replace(/~~([\s\S]+?)~~/g, "<s>$1</s>")
    .replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  return t.replace(/\u0000(\d+)\u0000/g, (m, i: string) => code[+i] ?? m);
}

/// A whole body or comment. A soft line break is a break, as GitHub renders one in a thread:
/// people write issues in lines, and reflowing them loses the shape they typed.
export function mdHtml(src: string): string {
  const lines = (src || "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let quote: string[] = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closePara = () => {
    if (para.length) out.push(`<p>${para.map(inlineIssue).join("<br>")}</p>`);
    para = [];
  };
  const closeQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map(inlineIssue).join("<br>")}</blockquote>`);
    quote = [];
  };
  const closeAll = () => { closePara(); closeQuote(); closeList(); };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*```/.test(ln)) {
      closeAll();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${escHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!ln.trim()) { closeAll(); continue; }
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(ln);
    if (h) {
      closeAll();
      out.push(`<p class="md-h${h[1].length > 2 ? " sm" : ""}">${inlineIssue(h[2].trim())}</p>`);
      continue;
    }
    if (/^\s{0,3}([-*_])\s*\1\s*\1[-*_\s]*$/.test(ln)) { closeAll(); out.push("<hr>"); continue; }
    const q = /^\s{0,3}>\s?(.*)$/.exec(ln);
    if (q) { closePara(); closeList(); quote.push(q[1]); continue; }
    closeQuote();
    const li = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(ln);
    if (li) {
      closePara();
      const want = li[2] ? "ol" : "ul";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(li[3]);
      const text = task
        ? `<span class="md-tk">${task[1] === " " ? "☐" : "☑"}</span> ${inlineIssue(task[2])}`
        : inlineIssue(li[3]);
      out.push(`<li${li[1].length >= 2 ? ` class="in"` : ""}>${text}</li>`);
      continue;
    }
    closeList();
    para.push(ln.trim());
  }
  closeAll();
  return out.join("");
}
