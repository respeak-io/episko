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
 * Once per released version, on the machine that runs it. Three cases are silent:
 *
 * - **A version already read.** Including one read and then returned to — going back to
 *   0.13.1 after trying 0.14.0 must not re-announce it. That is why `seen` is a set and
 *   not a last-seen string.
 * - **A version with no section.** A local dev build; the screen would open on nothing.
 * - **`Unreleased`**, which describes something nobody is running.
 *
 * **There is deliberately no fresh-install exception, and that is a reversal.** 0.13.0
 * had one, keyed on the seen-record being absent — but the release that *introduces* a
 * seen-record is exactly the release where every existing install has none, so the one
 * version the guard silenced was the one that shipped the feature. Rescuing it needs a
 * guess at whether the rest of `localStorage` looks "used", and that guess was measured
 * wrong twice: `cc-icons`, `cc-icons-v` and `cc-restore` are all written during a first
 * boot, some of them before this module is even imported. It cannot be unit-tested
 * either — it depends on import order across the whole app graph — so it would rot
 * silently, in the direction of hiding the feature.
 *
 * The cost of dropping it is that a first-time user is shown the notes for the version
 * they just installed, once. For someone who has never seen the app that reads as an
 * introduction, and it is one Esc away.
 */
export function shouldAnnounce(current: string, seen: readonly string[], log: Release[]): boolean {
  if (!current || seen.includes(current)) return false;
  return log.some((r) => r.released && r.version === current);
}

// ---------- the seen record ----------
// Where it is *stored* is ./changelogui's business; what it MEANS is here, so the
// migration path is covered by a test rather than by opening the app on a machine that
// happens to hold the old key.

/**
 * Read the record, folding in 0.13.0's single-value key when the list is absent.
 *
 * The legacy fallback runs on the *value*, not on a version check — a machine that
 * skipped a release still has the old key and nothing else, and there is no other
 * evidence of what it has read.
 */
export function parseSeen(list: string | null, legacy: string | null): string[] {
  if (list) {
    try {
      const a: unknown = JSON.parse(list);
      // Anything hand-edited into the key is ignored rather than trusted: the cost of a
      // bad entry is a missed announcement, which is silent.
      if (Array.isArray(a)) return a.filter((x): x is string => typeof x === "string");
    } catch { /* truncated or hand-mangled — fall through to the legacy key */ }
  }
  return legacy ? [legacy] : [];
}

/// Add a version, newest last, deduped and bounded. Re-adding one already present moves
/// it to the end rather than duplicating it, so the cap can never evict a live version.
export function recordSeen(seen: readonly string[], version: string, cap = SEEN_CAP): string[] {
  if (!version) return [...seen];
  return [...seen.filter((v) => v !== version), version].slice(-cap);
}

/// Bounded so the key can't grow forever — one entry per release actually run here, so
/// the cap is decades away, and what falls off the front is versions nobody can reach.
const SEEN_CAP = 50;

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
