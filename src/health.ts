// Which of `health.rs`'s measurements earn a chip on a changed file. Thresholds are display
// policy: they live here, changeable without a rebuild and testable. Two rules (silenced
// errors, no test changed) are answered from the patch alone. A signal, never a gate.

import type { DiffFile } from "./diff";
import type { FileHealth, HealthReport } from "./types";

/** bad: worth knowing before merging; warn: after; info: context only. */
export type Sev = "bad" | "warn" | "info";

export interface Chip {
  id: string; // stable: the CSS class, and what tests name
  sev: Sev;
  text: string; // short enough for a rail row
  title: string; // the whole finding, on hover
  places: number[]; // where a repeat click walks; empty for a whole-file finding
  lines: number[]; // every line to mark; not `places` (one place can mark a whole span)
}

// ---------- thresholds ----------

export interface HealthPrefs {
  cognitive: number; // cognitive complexity at which a touched function is called out
  nesting: number; // nesting depth an added line has to reach
  longFn: number; // code lines in a single function
  sizeAdd: number; // added code before size is mentioned: size alone is the file's, not the change's
}

// cognitive 15 is SonarSource's default; nesting 5 is the cheapest proxy an indentation walk
// gets right; longFn 60 is about one screen; sizeAdd 25 makes the file's size a fact about
// what the change did.
export const DEFAULT_HEALTH: HealthPrefs = { cognitive: 15, nesting: 5, longFn: 60, sizeAdd: 25 };

// Non-positive falls back to the default: a threshold of 0 fires on every file.
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

// Patterns flagged on an added line. `.unwrap()` is left out on purpose: it is everywhere in
// ordinary Rust, and a rule that fires on ordinary code hides the ones that matter.
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

// Crude comment-line tests; the exact rule is per language and lives in health.rs. A switch
// per path rather than a union: in C a line-start `#` is a preprocessor directive, and
// uniting the two would silence real findings there.
const COMMENTISH = /^\s*(\/\/|\*|\/\*)/;
const HASH_COMMENTISH = /^\s*#/;
// The `#`-comment half of `isSourcePath`'s list, plus the configs the diff also shows.
const HASH_EXTS = new Set(["py", "pyi", "rb", "sh", "bash", "zsh", "yml", "yaml", "toml"]);
function commentishFor(path: string): RegExp {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return HASH_EXTS.has(ext) ? HASH_COMMENTISH : COMMENTISH;
}

// Blank string literals so a line that documents a pattern is not read as one that does it.
// Mirrors `blank_literals` in health.rs: single-line, and an unmatched quote blanks the rest,
// losing a finding rather than inventing one. Comment lines are never blanked.
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

// Added lines only: a bare `except:` the file already had is not something this change did.
export function silencedIn(f: DiffFile): { line: number; what: string }[] {
  const out: { line: number; what: string }[] = [];
  const commentish = commentishFor(f.path);
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.kind !== "add") continue;
      const comment = commentish.test(l.text);
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

// The test-path shapes the five languages here use, not a complete list; a miss costs one info chip.
export function isTestPath(p: string): boolean {
  const l = p.toLowerCase();
  return /(^|\/)(tests?|__tests__|spec|specs)\//.test(l)
    || /\.(test|spec)\.[a-z]+$/.test(l)
    || /(^|\/)test_[^/]+\.py$/.test(l)
    || /_test\.(go|py|rs|ts|js)$/.test(l);
}

// Config, docs and lockfiles change without tests; a chip on CHANGELOG.md would be noise.
export function isSourcePath(p: string): boolean {
  const ext = p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "";
  // Must match `is_code_file` in health.rs (test/health.test.ts checks): a file only one side
  // calls source is measured and then never spoken about.
  const CODE = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "py", "rb", "java",
    "c", "h", "cc", "cpp", "hpp", "cs", "swift", "kt", "kts", "scala", "php", "dart",
    "sh", "bash", "css", "scss"];
  return CODE.includes(ext);
}

// A whole-diff question, rendered once beside the totals rather than on every source row.
// False when nothing source-like changed: a docs change needing no test is not news.
export function noTestChanged(files: DiffFile[]): boolean {
  const source = files.filter((f) => isSourcePath(f.path) && !isTestPath(f.path));
  if (!source.length) return false;
  return !files.some((f) => isTestPath(f.path));
}

// ---------- the chips ----------

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// The one finding that applies to any file, code or not.
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

// The lines this change added inside a span. Chips point at one of these rather than the
// declaration, which for a change deep in a long function is nowhere near a hunk.
function addedIn(f: DiffFile, start: number, end: number): number[] {
  const out: number[] = [];
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add" && l.newNo && l.newNo >= start && l.newNo <= end) out.push(l.newNo);
    }
  }
  return out;
}

// Every chip one changed file has earned, worst first. `h` is absent while measurement is in
// flight or when the backend could not read the file; a missing measurement must never look
// clean, so nothing here substitutes a zero for an unknown.
export function fileChips(
  f: DiffFile,
  h: FileHealth | undefined,
  rep: HealthReport | null,
  prefs: HealthPrefs = DEFAULT_HEALTH,
): Chip[] {
  const out: Chip[] = [];

  // Not code, so only the duplicate rule applies.
  if (!isSourcePath(f.path)) {
    return h?.measured && h.dups.length ? [dupChip(h)] : [];
  }

  const silenced = silencedIn(f);
  if (silenced.length) {
    out.push({
      id: "silenced",
      sev: "bad",
      text: silenced.length === 1 ? "silenced error" : `silenced ×${silenced.length}`,
      title: `This change adds ${silenced.length === 1 ? "an error that is swallowed at " : `${silenced.length} places where an error is swallowed:\n`}`
        + silenced.map((s) => `line ${s.line}: ${s.what}`).join("\n"),
      places: silenced.map((s) => s.line),
      lines: silenced.map((s) => s.line),
    });
  }

  if (!h?.measured) return out;

  if (h.dups.length) out.push(dupChip(h));

  // Size is relative (the project's p90) and only said when this change made the file bigger.
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
  // Suppressed when the complexity chip already names this function: one finding, not two.
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

// The findings as text for an agent to act on. Prose rather than JSON: a path with a line
// number is the most actionable thing you can hand a model.
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
      // flattened to one line so a bullet stays a bullet
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

// null when a file earned nothing, the common case, which stays visually silent.
export function worstSev(chips: Chip[]): Sev | null {
  if (chips.some((c) => c.sev === "bad")) return "bad";
  if (chips.some((c) => c.sev === "warn")) return "warn";
  if (chips.some((c) => c.sev === "info")) return "info";
  return null;
}

// Findings about the change as a whole, one line beside the totals.
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
  // Both cuts must say so: a measurement that covered less than the change reads as a cleaner
  // change, and the viewer's own "diff truncated" note only says the listing is short.
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
