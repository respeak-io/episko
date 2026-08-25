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
  /// Where the finding *is*, in the order a repeat click walks them. Empty when it is
  /// about the file as a whole and there is nowhere more specific to be.
  places: number[];
  /// **Every** line to mark, which is not the same list. A `dup ×3` has three places and
  /// marks three lines; a complex function has one place and marks the whole span the
  /// change added inside it. Conflating them made a chip claim "200 places".
  lines: number[];
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

/// Blank the contents of string literals, so a line that *documents* a pattern is not
/// read as a line that *does* it.
///
/// This module's own pattern table earned six chips on itself and its tests earned ten,
/// all of them the literal patterns sitting inside quotes. Mirrors `blank_literals` in
/// `health.rs`, and has the same single-line limitation and the same failure mode: an
/// unmatched quote (an apostrophe) blanks the rest of the line, which loses a finding
/// rather than inventing one. Comment lines are never blanked — prose is full of
/// apostrophes, and the patterns that legitimately live in a comment are matched raw.
function blankLiterals(line: string): string {
  let out = "";
  let quote: string | null = null;
  let esc = false;
  for (const c of line) {
    if (quote) {
      out += " ";
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += " ";
    } else {
      out += c;
    }
  }
  return out;
}

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
      const probe = comment ? l.text : blankLiterals(l.text);
      for (const s of SILENCED) {
        if ((s.inComment || !comment) && s.re.test(probe)) {
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

/// The one finding that applies to any file, whatever it is written in — which is why it
/// is lifted out: a copy-pasted block is a copy-pasted block in prose and in config too.
function dupChip(h: FileHealth): Chip {
  const where = h.dups.map((d) => `${d.other_path}:${d.other_line}`);
  return {
    id: "dup",
    sev: "bad",
    text: h.dups.length === 1 ? "duplicate block" : `dup ×${h.dups.length}`,
    title: `Six or more lines added here already exist in:\n${where.join("\n")}`,
    places: h.dups.map((d) => d.line),
    lines: h.dups.map((d) => d.line),
  };
}

/// Every chip one changed file has earned, worst first.
///
/// `h` is absent while the measurement is still in flight, or when the backend could not
/// read the file (deleted, binary, over the size cap). Both cases render the same way:
/// the patch-only rules still apply and the rest is simply not claimed. A missing
/// measurement must never look like a clean one, which is why nothing here substitutes a
/// zero for an unknown.
/// The first line this change *added* inside a span, or 0.
///
/// What the complexity and length chips point at. Their finding is about a function, and
/// the obvious target is its declaration — but for a change deep inside a long function
/// that line is nowhere near a hunk, so it is not rendered, and the click scrolls to
/// nothing and flashes nothing: indistinguishable from a dead control. A line the change
/// added is always on screen, and is a better answer anyway — it is the part of the
/// function you are actually being asked about.
function addedIn(f: DiffFile, start: number, end: number): number[] {
  const out: number[] = [];
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add" && l.newNo && l.newNo >= start && l.newNo <= end) out.push(l.newNo);
    }
  }
  return out;
}

export function fileChips(
  f: DiffFile,
  h: FileHealth | undefined,
  rep: HealthReport | null,
  prefs: HealthPrefs = DEFAULT_HEALTH,
): Chip[] {
  const out: Chip[] = [];

  // Documentation, config and lockfiles get one rule and no more. They are not code, so
  // the code-shaped findings do not apply to them — and `silenced` in particular read the
  // CHANGELOG entry *announcing* the rule as a swallowed error, which is exactly the kind
  // of false positive that teaches you to stop reading the row.
  if (!isSourcePath(f.path)) {
    return h?.measured && h.dups.length ? [dupChip(h)] : [];
  }

  const silenced = silencedIn(f);
  if (silenced.length) {
    out.push({
      id: "silenced",
      sev: "bad",
      text: silenced.length === 1 ? "silenced error" : `silenced ×${silenced.length}`,
      title: `This change adds ${silenced.length === 1 ? "" : `${silenced.length} places where an error is swallowed:\n`}`
        + silenced.map((s) => `line ${s.line}: ${s.what}`).join("\n"),
      places: silenced.map((s) => s.line),
      lines: silenced.map((s) => s.line),
    });
  }

  if (!h?.measured) return out;

  if (h.dups.length) out.push(dupChip(h));

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
      places: [],
      lines: [],
    });
  }

  const w = h.worst_fn;
  if (w && w.cognitive >= prefs.cognitive) {
    out.push({
      id: "cognitive",
      sev: "warn",
      text: `cognitive ${w.cognitive}`,
      title: `\`${w.name}\` (from line ${w.start}) scores ${w.cognitive} — at or above the threshold of ${prefs.cognitive}.\n`
        + `An approximation of Cognitive Complexity: branches cost more the deeper they nest.`,
      places: [addedIn(f, w.start, w.end)[0] ?? w.start],
      lines: addedIn(f, w.start, w.end),
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
      title: `\`${g.name}\` (from line ${g.start}) is ${plural(g.code_lines, "code line")} long — about ${Math.round(g.code_lines / 30)} screens.`,
      places: [addedIn(f, g.start, g.end)[0] ?? g.start],
      lines: addedIn(f, g.start, g.end),
    });
  }

  if (h.max_nesting >= prefs.nesting) {
    out.push({
      id: "nesting",
      sev: "warn",
      text: `nesting ${h.max_nesting}`,
      title: `An added line sits ${h.max_nesting} levels deep, at line ${h.nesting_line}.`,
      places: [h.nesting_line],
      lines: [h.nesting_line],
    });
  }

  return out;
}

/// The findings as text, for handing to an agent.
///
/// The point of the whole feature is that you are reviewing work you did not type, so the
/// fix is going to be typed by an agent too — and a chip you can only *look* at makes you
/// the courier. This is the same information as the chips, written so it can be pasted
/// into a session and acted on: every finding names a file, a line and what is wrong, and
/// the lead-in says what to do with them.
///
/// Deliberately not a machine format. The consumer is a model reading a prompt, and a
/// path with a line number is the most actionable thing you can hand one — it can open
/// exactly that line. JSON would only add ceremony for a reader that does not need it.
export function findingsText(title: string, files: DiffFile[], chips: Chip[][], set: Chip[]): string {
  const out: string[] = [];
  const found = files.map((f, i) => [f, chips[i] ?? []] as const).filter(([, c]) => c.length);
  if (!found.length && !set.length) {
    return `No code-health findings in ${title}.`;
  }
  out.push(`# Code health — ${title}`);
  out.push("");
  out.push("Each finding below names a file and a line. Read the line before changing it —");
  out.push("these are measurements, not verdicts, and some of them will be fine as they are.");
  out.push("");
  for (const [f, cs] of found) {
    out.push(`## ${f.path}`);
    for (const c of cs) {
      const where = c.places.length
        ? ` (line ${c.places[0]}${c.places.length > 1 ? `, ${c.places.length} places` : ""})`
        : "";
      // The title is the whole finding and is already written for a reader; flattened to
      // one line so a bullet stays a bullet.
      out.push(`- **${c.text}**${where} — ${c.title.replace(/\s*\n\s*/g, " ")}`);
    }
    out.push("");
  }
  if (set.length) {
    out.push("## About the change as a whole");
    for (const c of set) out.push(`- **${c.text}** — ${c.title.replace(/\s*\n\s*/g, " ")}`);
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
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
export function setChips(files: DiffFile[], rep: HealthReport | null, diffCut = false): Chip[] {
  const out: Chip[] = [];
  if (noTestChanged(files)) {
    out.push({
      id: "notest",
      sev: "info",
      text: "no test changed",
      title: "Source changed in this working set and nothing matching a test path did.\n"
        + "Informational — plenty of good changes need no test.",
      places: [],
      lines: [],
    });
  }
  // Two different cuts, and both have to say so, because a measurement that covered less
  // than the change did reads as a *cleaner* change rather than a partial one. The
  // viewer's own "diff truncated" note is not enough on its own: it says the diff is
  // short, which a reader takes to mean the listing is short — not that the findings are.
  if (diffCut) {
    out.push({
      id: "partial",
      sev: "info",
      text: "findings incomplete",
      title: "The diff was too large to read in full, so the files it left out were never\n"
        + "measured either. A wholesale copy-pasted new file is exactly what falls off\n"
        + "the end of that list, and it is the duplication rule's best case.",
      places: [],
      lines: [],
    });
  } else if (rep?.truncated) {
    out.push({
      id: "partial",
      sev: "info",
      text: "partial sweep",
      title: `Only ${rep.indexed} files were read, so duplicate blocks may be missed.\n`
        + "The project is larger than the cap this measurement bounds itself to.",
      places: [],
      lines: [],
    });
  }
  return out;
}
