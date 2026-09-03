// CHANGELOG.md parsing, and when to put it on screen. The file is bundled (`?raw`), never
// fetched: a build can only ever describe itself. No DOM; ./changelogui owns the dialog.

export type Mark = "new" | "changed" | "fixed";

export interface Entry { mark: Mark; text: string }

export interface Release {
  version: string; // `0.12.0`, or `Unreleased`
  date: string;    // as written, "" for Unreleased
  lede: string;    // the first paragraph
  entries: Entry[];
  released: boolean;
}

const MARKS: Record<string, Mark> = { "+": "new", "~": "changed", "!": "fixed" };

// Forgiving: a section that does not match the shape degrades to a lede rather than
// vanishing. A heading is a release only if it looks like `## 1.2.3` or `## Unreleased`.
export function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  let cur: Release | null = null;
  let lede: string[] = [];
  const flushLede = () => {
    if (cur && !cur.lede) cur.lede = lede.join(" ").trim();
    lede = [];
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^##\s+(.+?)\s*$/.exec(line);
    if (head) {
      flushLede();
      const [version, date] = splitHeading(head[1]);
      if (!version) { cur = null; continue; }   // prose heading — not a release
      cur = { version, date, lede: "", entries: [], released: version.toLowerCase() !== "unreleased" };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const item = /^([+~!])\s+(.+)$/.exec(line);
    if (item) {
      flushLede();
      cur.entries.push({ mark: MARKS[item[1]], text: item[2].trim() });
      continue;
    }
    // A wrapped entry's second line must not become a lede or be dropped.
    if (line && cur.entries.length && !lede.length) {
      cur.entries[cur.entries.length - 1].text += " " + line;
      continue;
    }
    if (line) lede.push(line);
  }
  flushLede();
  // Every released build ships an empty `## Unreleased`; listed, it reads as a broken row.
  return out.filter((r) => r.entries.length > 0 || r.lede !== "");
}

// ---------- the little markup an entry may carry ----------

// `**bold**`, `*italic*` and `` `code` `` only, escaped first. Code spans are lifted out before the
// emphasis passes; bold runs first and non-greedy, italic needs a run with no `*` so `2 * 3` stays.
export function inlineMd(s: string): string {
  const spans: string[] = [];
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    // A NUL sentinel cannot be written into a changelog by accident.
    .replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${spans.push(`<code>${c}</code>`) - 1}\u0000`)
    .replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/\u0000(\d+)\u0000/g, (m, i: string) => spans[+i] ?? m);
}

function splitHeading(h: string): [string, string] {
  const m = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*(?:[—–-]\s*(.*))?$/.exec(h);
  if (m) return [m[1], (m[2] || "").trim()];
  if (/^unreleased$/i.test(h)) return ["Unreleased", ""];
  return ["", ""];
}

// ---------- when to show it ----------

// Once per released version on this machine. `seen` is a set, not a last-seen string, so an older
// build does not re-announce. No fresh-install exception, and never again one: docs/releases.md.
export function shouldAnnounce(current: string, seen: readonly string[], log: Release[]): boolean {
  if (!current || seen.includes(current)) return false;
  return log.some((r) => r.released && r.version === current);
}

// ---------- the seen record ----------

// 0.13.0's single-value key is folded in on the value, not a version check: a machine that
// skipped a release has only the old key.
export function parseSeen(list: string | null, legacy: string | null): string[] {
  if (list) {
    try {
      const a: unknown = JSON.parse(list);
      if (Array.isArray(a)) return a.filter((x): x is string => typeof x === "string");
    } catch { /* truncated or hand-mangled — fall through to the legacy key */ }
  }
  return legacy ? [legacy] : [];
}

// Re-adding moves a version to the end rather than duplicating it, so the cap never evicts a live one.
export function recordSeen(seen: readonly string[], version: string, cap = SEEN_CAP): string[] {
  if (!version) return [...seen];
  return [...seen.filter((v) => v !== version), version].slice(-cap);
}

const SEEN_CAP = 50; // one entry per release actually run here; decades away

export function releaseFor(current: string, log: Release[]): Release | null {
  if (!log.length) return null;
  return log.find((r) => r.version === current) ?? log.find((r) => r.released) ?? log[0];
}

export const MARK_ORDER: Mark[] = ["new", "changed", "fixed"];
export const MARK_LABEL: Record<Mark, string> = { new: "New", changed: "Changed", fixed: "Fixed" };
export const MARK_GLYPH: Record<Mark, string> = { new: "+", changed: "~", fixed: "!" };

export function grouped(r: Release): { mark: Mark; entries: Entry[] }[] {
  return MARK_ORDER
    .map((mark) => ({ mark, entries: r.entries.filter((e) => e.mark === mark) }))
    .filter((g) => g.entries.length);
}
