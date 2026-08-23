// What the measurements *mean* — the rules that turn `health.rs`'s facts into the chips
// on a changed file's row.
//
// The split is the same one ./dash has with `project_facts`: the backend answers numbers
// (712 code lines, cognitive 24, this block also lives in refunds.py) and this module
// decides which of them are worth saying. Thresholds are display policy, so they live
// where they can be changed without a rebuild — and where they can be tested, which is
// the half that matters, because every rule here fails quietly. A threshold set too low
// produces a chip on every file, which reads as noise and gets ignored; set too high it
// produces nothing, which reads as a clean change.
//
// Two of the seven rules never reach the backend at all. Silenced errors and "no test
// changed" are answered entirely from the patch, which the frontend has already parsed
// (./diff), so asking Rust for them would mean parsing the patch twice.
//
// **This is a signal, never a gate.** Nothing here blocks anything, and the moment a chip
// stops you merging something you wanted to merge it has become CI, which is where that
// belongs.

import type { DiffFile } from "./diff";
import type { FileHealth, HealthReport } from "./types";

/// How loud a chip is. Not a score: three levels, and the difference between them is
/// whether you would want to know before merging (`bad`), after (`warn`), or only as
/// context (`info`).
export type Sev = "bad" | "warn" | "info";

export interface Chip {
  /// Stable id, for the CSS class and for tests naming a rule.
  id: string;
  sev: Sev;
  /// What the chip says. Short enough for a rail row.
  text: string;
  /// The whole finding, on hover.
  title: string;
  /// The line to go to when it is clicked, or 0 when the finding is about the file as a
  /// whole and there is nowhere more specific to be.
  line: number;
}

// ---------- thresholds ----------

export interface HealthPrefs {
  /// Cognitive complexity at or above which a touched function is called out.
  cognitive: number;
  /// Nesting depth an added line has to reach.
  nesting: number;
  /// Code lines in a single function.
  longFn: number;
  /// How much code a change has to add before the file's *size* is worth mentioning.
  /// Size alone is a property of the file, not of your change; without this the biggest
  /// file in the project would carry a chip forever, including on the commit that made
  /// it smaller.
  sizeAdd: number;
}

/// The defaults, and where each comes from:
///
/// - `cognitive: 15` is SonarSource's own default for the metric, and the metric exists
///   because cyclomatic complexity measures testability rather than understandability.
/// - `nesting: 5` is the cheapest honest proxy for the same thing, and the one an
///   indentation walk gets right without a parser.
/// - `longFn: 60` is roughly one screen. Below that, length is a style argument; above
///   it, it reliably hides a second responsibility.
/// - `sizeAdd: 25` is a change big enough that "and the file is now among the largest in
///   the project" is a fact about what you just did.
export const DEFAULT_HEALTH: HealthPrefs = { cognitive: 15, nesting: 5, longFn: 60, sizeAdd: 25 };

/// Repair a stored or hand-written table. A threshold of 0 would fire on everything, so
/// anything non-positive falls back rather than being honoured — a `.episko/episko.toml`
/// somebody typed by hand must not be able to turn every file red.
export function clampHealth(raw: unknown): HealthPrefs {
  const o = (raw ?? {}) as Partial<Record<keyof HealthPrefs, unknown>>;
  const num = (v: unknown, d: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.round(n) : d;
  };
  return {
    cognitive: num(o.cognitive, DEFAULT_HEALTH.cognitive),
    nesting: num(o.nesting, DEFAULT_HEALTH.nesting),
    longFn: num(o.longFn, DEFAULT_HEALTH.longFn),
    sizeAdd: num(o.sizeAdd, DEFAULT_HEALTH.sizeAdd),
  };
}

// ---------- the two rules the patch answers on its own ----------

/// A pattern worth flagging on an added line, and whether it lives in a comment.
///
/// The list is short on purpose, and what is *missing* from it is the design. `.unwrap()`
/// was the obvious candidate and is out: it appears 156 times in `git.rs` alone, nearly
/// all of it in tests where it is correct, so including it would put a chip on almost
/// every Rust change and teach you to ignore the row. A rule that fires on ordinary code
/// is worse than no rule, because it also hides the ones that mean something.
const SILENCED: { re: RegExp; what: string; inComment: boolean }[] = [
  { re: /\bexcept\s*:/, what: "a bare `except:`", inComment: false },
  { re: /\bexcept\s+(Base)?Exception\s*:/, what: "`except Exception`", inComment: false },
  { re: /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/, what: "an empty `catch`", inComment: false },
  { re: /\bas\s+any\b/, what: "`as any`", inComment: false },
  { re: /\bcatch\s*\([^)]*\)\s*\{\s*\/\/\s*ignore/i, what: "a deliberately ignored `catch`", inComment: false },
  { re: /@ts-(ignore|nocheck|expect-error)/, what: "`@ts-ignore`", inComment: true },
  { re: /#\s*type:\s*ignore/, what: "`# type: ignore`", inComment: true },
  { re: /eslint-disable/, what: "`eslint-disable`", inComment: true },
  { re: /#\s*noqa/, what: "`# noqa`", inComment: true },
];

/// A line that is nothing but a comment, for the patterns that are not themselves ones.
/// Deliberately crude — the exact rule is per language and lives in `health.rs`; here it
/// only has to stop a prose line mentioning `as any` from being read as code doing it.
const COMMENTISH = /^\s*(\/\/|\*|\/\*)/;

/// The silencings this change introduced, in the order they appear.
///
/// Added lines only. A file that already had a bare `except:` before you opened it is not
/// something this change did, and reporting it would make the chip a property of the file
/// rather than of the diff.
export function silencedIn(f: DiffFile): { line: number; what: string }[] {
  const out: { line: number; what: string }[] = [];
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.kind !== "add") continue;
      const comment = COMMENTISH.test(l.text);
      for (const s of SILENCED) {
        if ((s.inComment || !comment) && s.re.test(l.text)) {
          out.push({ line: l.newNo ?? 0, what: s.what });
          break; // one finding a line; the first match is the one that describes it
        }
      }
    }
  }
  return out;
}

/// Whether a path is somewhere tests live. Covers the shapes the five languages here
/// actually use rather than trying to be complete: a miss costs one informational chip.
export function isTestPath(p: string): boolean {
  const l = p.toLowerCase();
  return /(^|\/)(tests?|__tests__|spec|specs)\//.test(l)
    || /\.(test|spec)\.[a-z]+$/.test(l)
    || /(^|\/)test_[^/]+\.py$/.test(l)
    || /_test\.(go|py|rs|ts|js)$/.test(l);
}

/// Whether a path is code at all. Config, docs and lockfiles change constantly and
/// legitimately without tests, and a "no test changed" chip on `CHANGELOG.md` is noise
/// that makes the same chip on a source file easier to skip past.
export function isSourcePath(p: string): boolean {
  const ext = p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "";
  const CODE = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "py", "rb", "java",
    "c", "h", "cc", "cpp", "hpp", "cs", "swift", "kt", "scala", "php", "dart", "sh"];
  return CODE.includes(ext);
}

/// Did this working set change any source without changing any test?
///
/// A whole-diff question, not a per-file one, and it is rendered once beside the totals
/// rather than on every source row — the same finding repeated five times reads as five
/// findings. Returns false when nothing source-like changed at all, since a documentation
/// change needing no test is not worth a line of UI.
export function noTestChanged(files: DiffFile[]): boolean {
  const source = files.filter((f) => isSourcePath(f.path) && !isTestPath(f.path));
  if (!source.length) return false;
  return !files.some((f) => isTestPath(f.path));
}

// ---------- the chips ----------

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/// Every chip one changed file has earned, worst first.
///
/// `h` is absent while the measurement is still in flight, or when the backend could not
/// read the file (deleted, binary, over the size cap). Both cases render the same way:
/// the patch-only rules still apply and the rest is simply not claimed. A missing
/// measurement must never look like a clean one, which is why nothing here substitutes a
/// zero for an unknown.
export function fileChips(
  f: DiffFile,
  h: FileHealth | undefined,
  rep: HealthReport | null,
  prefs: HealthPrefs = DEFAULT_HEALTH,
): Chip[] {
  const out: Chip[] = [];

  const silenced = silencedIn(f);
  if (silenced.length) {
    out.push({
      id: "silenced",
      sev: "bad",
      text: silenced.length === 1 ? "silenced error" : `silenced ×${silenced.length}`,
      title: `This change adds ${silenced.length === 1 ? "" : `${silenced.length} places where an error is swallowed:\n`}`
        + silenced.map((s) => `line ${s.line}: ${s.what}`).join("\n"),
      line: silenced[0].line,
    });
  }

  if (!h?.measured) return out;

  if (h.dups.length) {
    const where = h.dups.map((d) => `${d.other_path}:${d.other_line}`);
    out.push({
      id: "dup",
      sev: "bad",
      text: h.dups.length === 1 ? "duplicate block" : `dup ×${h.dups.length}`,
      title: `Six or more lines added here already exist in:\n${where.join("\n")}`,
      line: h.dups[0].line,
    });
  }

  // Size is only ever relative — a fixed number would flag half of one project and
  // nothing at all in another — and it is only worth saying when this change is what
  // made the file bigger.
  const p90 = rep?.p90_code_lines ?? 0;
  if (p90 > 0 && h.code_lines > p90 && h.code_added >= prefs.sizeAdd) {
    out.push({
      id: "grew",
      sev: "warn",
      text: `${h.code_lines} code lines`,
      title: `${h.code_lines} lines of code, comments and blanks excluded — above this project's 90th percentile of ${p90}.\n`
        + `This change added ${plural(h.code_added, "code line")}.`,
      line: 0,
    });
  }

  const w = h.worst_fn;
  if (w && w.cognitive >= prefs.cognitive) {
    out.push({
      id: "cognitive",
      sev: "warn",
      text: `cognitive ${w.cognitive}`,
      title: `\`${w.name}\` scores ${w.cognitive} — at or above the threshold of ${prefs.cognitive}.\n`
        + `An approximation of Cognitive Complexity: branches cost more the deeper they nest.`,
      line: w.start,
    });
  }

  const g = h.longest_fn;
  // Suppressed when the complexity chip already names the same function: two chips
  // pointing at one line is the same finding twice.
  if (g && g.code_lines >= prefs.longFn && !(w && w.cognitive >= prefs.cognitive && w.start === g.start)) {
    out.push({
      id: "longfn",
      sev: "warn",
      text: `${g.code_lines}-line fn`,
      title: `\`${g.name}\` is ${plural(g.code_lines, "code line")} long — about ${Math.round(g.code_lines / 30)} screens.`,
      line: g.start,
    });
  }

  if (h.max_nesting >= prefs.nesting) {
    out.push({
      id: "nesting",
      sev: "warn",
      text: `nesting ${h.max_nesting}`,
      title: `An added line sits ${h.max_nesting} levels deep, at line ${h.nesting_line}.`,
      line: h.nesting_line,
    });
  }

  return out;
}

/// The worst severity in a set, for the rail's pips and for sorting. `null` when a file
/// has earned nothing — which is the common case and should stay visually silent.
export function worstSev(chips: Chip[]): Sev | null {
  if (chips.some((c) => c.sev === "bad")) return "bad";
  if (chips.some((c) => c.sev === "warn")) return "warn";
  if (chips.some((c) => c.sev === "info")) return "info";
  return null;
}

/// The health of a whole working set, as one line beside the totals — the findings that
/// are about the change rather than about any one file in it.
export function setChips(files: DiffFile[], rep: HealthReport | null): Chip[] {
  const out: Chip[] = [];
  if (noTestChanged(files)) {
    out.push({
      id: "notest",
      sev: "info",
      text: "no test changed",
      title: "Source changed in this working set and nothing matching a test path did.\n"
        + "Informational — plenty of good changes need no test.",
      line: 0,
    });
  }
  if (rep?.truncated) {
    out.push({
      id: "partial",
      sev: "info",
      text: "partial sweep",
      title: `Only ${rep.indexed} files were read, so duplicate blocks may be missed.\n`
        + "The project is larger than the cap this measurement bounds itself to.",
      line: 0,
    });
  }
  return out;
}
