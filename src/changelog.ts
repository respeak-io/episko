// The changelog: parsing CHANGELOG.md, and deciding when to put it on screen.
//
// WHY THE APP SHIPS ITS OWN. `CHANGELOG.md` is bundled at build time (a `?raw` import),
// not fetched from GitHub at runtime. Two reasons, and the second is the real one:
// it works with no network, and **a build can only ever describe itself**. Fetching the
// releases API would let a newer entry describe a version the user is not running, which
// is worse than showing nothing.
//
// No DOM and no Tauri, so it unit-tests in isolation; ./changelogui owns the dialog.
// See test/changelog.test.ts.

/// One line of a release. The marker is the whole taxonomy: Keep-a-Changelog's six
/// headings force a judgement call per line and leave sections with one bullet in them.
export type Mark = "new" | "changed" | "fixed";

export interface Entry { mark: Mark; text: string }

export interface Release {
  /// `0.12.0`, or `Unreleased` for the section that has not shipped.
  version: string;
  /// As written — `2026-07-31`, or "" for Unreleased.
  date: string;
  /// The first paragraph: what the release was *about*, in one sentence.
  lede: string;
  entries: Entry[];
  released: boolean;
}

const MARKS: Record<string, Mark> = { "+": "new", "~": "changed", "!": "fixed" };

/**
 * Parse the file. Forgiving by design: a hand-written section that doesn't match the
 * shape degrades to a lede rather than vanishing, because a changelog nobody can
 * hand-edit is a changelog that stops being written.
 *
 * A heading is only a release if it looks like one — `## 1.2.3` or `## Unreleased`.
 * Anything else is prose somebody added and must not become a version.
 */
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
    // A continuation of the previous entry: entries wrap, and a wrapped second line
    // must not become a lede or be dropped.
    if (line && cur.entries.length && !lede.length) {
      cur.entries[cur.entries.length - 1].text += " " + line;
      continue;
    }
    if (line) lede.push(line);
  }
  flushLede();
  return out;
}

/// `1.2.3 — 2026-07-31` → `["1.2.3", "2026-07-31"]`. Returns no version for a heading
/// that isn't one, which is how prose headings are rejected.
function splitHeading(h: string): [string, string] {
  const m = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*(?:[—–-]\s*(.*))?$/.exec(h);
  if (m) return [m[1], (m[2] || "").trim()];
  if (/^unreleased$/i.test(h)) return ["Unreleased", ""];
  return ["", ""];
}

// ---------- when to show it ----------

/**
 * Should *What's new* open by itself?
 *
 * Only when the running version differs from the last one this machine acknowledged —
 * i.e. you just updated. Three cases are deliberately silent:
 *
 * - **A fresh install** (`seen` is null). There is nothing new to someone who has never
 *   run it; opening a changelog over an empty app is noise before it is information.
 * - **A version with no section.** The screen would open on nothing.
 * - **A downgrade or a dev build.** Only a version we can find in the file counts, so
 *   running a local build with an unpublished version stays quiet.
 */
export function shouldAnnounce(current: string, seen: string | null, log: Release[]): boolean {
  if (!current || !seen || seen === current) return false;
  return log.some((r) => r.released && r.version === current);
}

/// The release to open on: the running version if the file knows it, else the newest
/// released one, else whatever is first (an Unreleased-only file on a dev build).
export function releaseFor(current: string, log: Release[]): Release | null {
  if (!log.length) return null;
  return log.find((r) => r.version === current) ?? log.find((r) => r.released) ?? log[0];
}

/// Entries grouped for display, in a fixed order so two releases never disagree about
/// where "fixed" goes. Empty groups are dropped rather than rendered as a bare heading.
export const MARK_ORDER: Mark[] = ["new", "changed", "fixed"];
export const MARK_LABEL: Record<Mark, string> = { new: "New", changed: "Changed", fixed: "Fixed" };
export const MARK_GLYPH: Record<Mark, string> = { new: "+", changed: "~", fixed: "!" };

export function grouped(r: Release): { mark: Mark; entries: Entry[] }[] {
  return MARK_ORDER
    .map((mark) => ({ mark, entries: r.entries.filter((e) => e.mark === mark) }))
    .filter((g) => g.entries.length);
}
