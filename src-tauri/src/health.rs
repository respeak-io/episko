//! What a change did to the shape of the code — the half that has to touch disk.
//!
//! This module answers *facts*, never verdicts. It says a file is 712 code lines, that
//! the worst function the change touched scores 24, that six lines of it already exist
//! in `refunds.py`. Whether any of that is worth a chip is `health.ts`'s decision, the
//! same split `project_facts` and ./dash use: thresholds are display policy and belong
//! where they can be changed without a rebuild.
//!
//! **Why Episko measures this at all**, given the project already has linters: the
//! measured regression in AI-written code is duplication, not length — copy/paste
//! overtook refactoring in 2024 and duplicated blocks are at a record high — and
//! cross-file duplication is precisely what ruff, ESLint and clippy do not look for.
//! Complexity and size rules they *do* have, but off by default. So this measures the
//! handful of things nobody's configured linter is reporting, and leaves the rest alone.
//!
//! Three deliberate limits, because the way this feature fails is by becoming a linter:
//!
//! - **No parsers.** Braces and indentation, plus a comment table. That is enough to
//!   find a function, its nesting and an approximate cognitive complexity in every
//!   language written here, and it degrades to "no opinion" rather than to a wrong one:
//!   a file whose family is unknown reports code lines and nothing else. If this ever
//!   needs to be exact, that is tree-sitter and a separate decision.
//! - **Nothing is watched and nothing is cached.** One pass over the project index per
//!   call, bounded by [`MAX_INDEX_FILES`] and [`MAX_FILE_BYTES`]. The command is `async`
//!   and the overlay paints its diff before the answer arrives, so the cost is invisible
//!   rather than absent. A cache needs invalidation, invalidation wants a watcher, and
//!   the app deliberately has none (docs/worktrees.md).
//! - **Facts are per file, thresholds are per project.** The one number computed across
//!   the project is `p90_code_lines`, because "big" only means anything relative to the
//!   code around it — a fixed 500 would flag half of Episko's frontend and nothing at
//!   all in a Go service.

use std::collections::HashMap;

/// Files read for the duplicate index and the size distribution. A mis-aimed open (a
/// monorepo, a home directory) must cost a bounded number of reads, not all of them.
const MAX_INDEX_FILES: usize = 6_000;
/// Files above this are generated, vendored or data. Reading them would dominate the
/// pass and their "duplication" is noise.
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Consecutive significant lines that make a block worth calling a duplicate. PMD's CPD
/// and jscpd both settle near this; shorter and every `if err != nil` is a clone.
const DUP_WINDOW: usize = 6;
/// Duplicate hits reported per file. The seventh copy of a block tells you nothing the
/// third did not.
const MAX_DUP_HITS: usize = 8;

// ---------------------------------------------------------------------------
// languages
// ---------------------------------------------------------------------------

/// How a file's structure is read. Not "which language" — the three that matter are how
/// blocks are delimited and what a comment looks like, and a dozen languages share each.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Family {
    /// `{`/`}` blocks, `//` and `/* */` comments. TS, JS, Rust, Go, Java, C, C#, Swift…
    Brace,
    /// Indentation blocks, `#` comments. Python, and close enough for Ruby.
    Indent,
    /// Everything else. Code lines only — no functions, no complexity, still indexed for
    /// duplicates, because a copy-pasted block is a copy-pasted block in any syntax.
    Plain,
}

pub(crate) fn family_of(path: &str) -> Family {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "rs" | "go" | "java" | "c" | "h"
        | "cc" | "cpp" | "hpp" | "cs" | "swift" | "kt" | "kts" | "scala" | "php" | "dart"
        | "css" | "scss" => Family::Brace,
        "py" | "pyi" | "rb" | "sh" | "bash" | "zsh" | "toml" | "yml" | "yaml" => Family::Indent,
        _ => Family::Plain,
    }
}

/// Whether a line carries code, once comments and blanks are taken out.
///
/// Counting raw lines is the metric everyone reaches for first and it is the wrong one
/// here: this codebase's house style is long explanatory comments, so a raw count would
/// light up on the best-documented files and stay dark on a tidy module that quietly
/// holds the same block four times.
fn is_code(line: &str, fam: Family, in_block: &mut bool) -> bool {
    let t = line.trim();
    if *in_block {
        // A block comment's closing line can carry trailing code, but that is rare
        // enough that treating the whole line as comment is the better trade.
        if t.contains("*/") {
            *in_block = false;
        }
        return false;
    }
    if t.is_empty() {
        return false;
    }
    match fam {
        Family::Brace => {
            if t.starts_with("/*") {
                *in_block = !t.contains("*/");
                return false;
            }
            !(t.starts_with("//") || t.starts_with('*'))
        }
        Family::Indent => !t.starts_with('#'),
        // Nothing reliable to strip, so only blank lines are discounted. An unknown
        // family reporting a slightly generous count is better than one guessing at a
        // comment syntax it does not know.
        Family::Plain => true,
    }
}

/// Blank the contents of string and character literals so the brace counting below
/// cannot be thrown by a `{` inside a string.
///
/// Single-line only, and knowingly so: a multi-line template literal or raw string will
/// confuse the depth for as long as it runs. The failure is a wrong nesting number on
/// one file, which is a chip that should not have fired — not a crash, and not silence.
fn blank_literals(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut quote: Option<char> = None;
    let mut esc = false;
    for c in line.chars() {
        match quote {
            Some(q) => {
                out.push(' ');
                if esc {
                    esc = false;
                } else if c == '\\' {
                    esc = true;
                } else if c == q {
                    quote = None;
                }
            }
            None => {
                if c == '"' || c == '\'' || c == '`' {
                    quote = Some(c);
                    out.push(' ');
                } else {
                    out.push(c);
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// one file, measured
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct FnSpan {
    /// The identifier before the parameter list. Best effort — an anonymous callback
    /// reports the name it was assigned to, or `?` when there is nothing to read.
    pub name: String,
    /// 1-based, inclusive.
    pub start: u32,
    pub end: u32,
    /// Lines of actual code in the body.
    pub code_lines: u32,
    /// An approximation of SonarSource's Cognitive Complexity: +1 for each construct
    /// that breaks the linear flow, plus the nesting depth it sits at, plus one per
    /// line that chains boolean operators. It is not their algorithm — there is no AST
    /// here — and it is used only to answer "is this function much harder than the ones
    /// around it", which it does well enough for a warning.
    pub cognitive: u32,
}

#[derive(Debug, Default)]
pub(crate) struct FileMetrics {
    pub code_lines: u32,
    pub fns: Vec<FnSpan>,
    /// Nesting depth per line, 1-based index matching the file. Lets the caller ask how
    /// deep the *added* lines went without re-walking the file.
    pub depth: Vec<u32>,
    /// Whether each line carries code, same indexing. Used to count what a change added.
    pub code: Vec<bool>,
}

/// Keywords that break linear flow. `else` is scored without its nesting level, exactly
/// as Cognitive Complexity does — an `else` is not harder for sitting inside the `if` it
/// belongs to.
const FLOW: &[&str] = &["if", "for", "while", "switch", "match", "case", "catch", "except", "elif"];

/// The first word of a line, for keyword tests. Cheaper and stricter than `contains`,
/// which would score the `if` inside `notify(`.
fn first_word(t: &str) -> &str {
    let t = t.trim_start_matches(|c: char| c == '}' || c == ')' || c.is_whitespace());
    let end = t.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(t.len());
    &t[..end]
}

/// Walk a file once and answer everything the caller can need from its shape.
pub(crate) fn measure(src: &str, fam: Family) -> FileMetrics {
    let mut m = FileMetrics::default();
    // Index 0 is unused so `depth[n]` is line n, matching every line number in a patch.
    m.depth.push(0);
    m.code.push(false);

    let mut in_block = false;
    let mut depth: i32 = 0;
    // For the brace family: functions currently open, as (index into m.fns, the brace
    // depth the body started at). A stack, because a closure inside a method is a real
    // and common shape and flattening it would attribute the closure's complexity to
    // whatever came after it.
    let mut open: Vec<(usize, i32)> = Vec::new();

    for (i, raw) in src.lines().enumerate() {
        let n = (i + 1) as u32;
        let code = is_code(raw, fam, &mut in_block);
        m.code.push(code);
        let t = raw.trim();

        let here = match fam {
            Family::Brace => depth.max(0) as u32,
            // Four columns to a level is the convention everywhere it matters; a tab is
            // one level by definition.
            Family::Indent => indent_level(raw),
            Family::Plain => 0,
        };
        m.depth.push(here);
        if code {
            m.code_lines += 1;
        }

        if fam == Family::Plain || !code {
            if fam == Family::Brace {
                depth += brace_delta(raw);
            }
            continue;
        }

        // --- scoring the line against whatever functions are open ---
        let add = flow_score(t, fam);
        if add.0 > 0 || add.1 > 0 {
            if let Some(&(fi, base)) = open.last() {
                let nest = (here as i32 - base).max(0) as u32;
                m.fns[fi].cognitive += add.0 * (1 + nest) + add.1;
            }
        }
        for &(fi, _) in &open {
            if code {
                m.fns[fi].code_lines += 1;
            }
        }

        match fam {
            Family::Brace => {
                let delta = brace_delta(raw);
                if let Some(name) = fn_name(t) {
                    // The body starts one level in from where the signature sits.
                    m.fns.push(FnSpan { name, start: n, end: n, code_lines: 0, cognitive: 0 });
                    open.push((m.fns.len() - 1, depth.max(0) as u32 as i32 + 1));
                }
                depth += delta;
                // Close every function whose body depth we have fallen back out of.
                while let Some(&(fi, base)) = open.last() {
                    if depth < base {
                        m.fns[fi].end = n;
                        open.pop();
                    } else {
                        break;
                    }
                }
            }
            Family::Indent => {
                while let Some(&(fi, base)) = open.last() {
                    if (here as i32) < base {
                        m.fns[fi].end = n - 1;
                        open.pop();
                    } else {
                        break;
                    }
                }
                if let Some(name) = def_name(t) {
                    m.fns.push(FnSpan { name, start: n, end: n, code_lines: 0, cognitive: 0 });
                    open.push((m.fns.len() - 1, here as i32 + 1));
                }
            }
            Family::Plain => {}
        }
    }
    // Anything still open runs to the end of the file.
    let last = src.lines().count() as u32;
    for (fi, _) in open {
        m.fns[fi].end = last;
    }
    m
}

fn indent_level(raw: &str) -> u32 {
    let mut cols = 0u32;
    for c in raw.chars() {
        match c {
            ' ' => cols += 1,
            '\t' => cols += 4,
            _ => break,
        }
    }
    cols / 4
}

fn brace_delta(raw: &str) -> i32 {
    let clean = blank_literals(raw);
    let code = clean.split("//").next().unwrap_or("");
    code.chars().filter(|&c| c == '{').count() as i32 - code.chars().filter(|&c| c == '}').count() as i32
}

/// `(flow, flat)` — how much this line adds to complexity, split by whether nesting
/// multiplies it.
fn flow_score(t: &str, fam: Family) -> (u32, u32) {
    let w = first_word(t);
    let mut flow = 0;
    let mut flat = 0;
    if FLOW.contains(&w) {
        flow += 1;
    }
    if w == "else" {
        // `else if` is one branch, not two: the `if` is scored by the `else`.
        flat += 1;
    }
    if fam == Family::Brace && t.contains("=>") && t.contains('?') && t.contains(':') {
        // a ternary inside an arrow body — close enough, and cheap
        flat += 1;
    }
    let clean = blank_literals(t);
    if clean.contains("&&") {
        flat += 1;
    }
    if clean.contains("||") {
        flat += 1;
    }
    (flow, flat)
}

/// The name of the function a brace-family line declares, or None.
///
/// Loose by design: it has to catch `function f(`, `const f = (` , `pub async fn f(`,
/// `func (r *T) f(`, `public void f(`, and a bare method `f(` inside a class. What it
/// must NOT catch is control flow — `if (x) {` has exactly the same shape — which is
/// what the keyword rejection below is for.
fn fn_name(t: &str) -> Option<String> {
    let clean = blank_literals(t);
    let code = clean.split("//").next().unwrap_or("").trim();
    if !code.ends_with('{') || !code.contains('(') {
        return None;
    }
    let w = first_word(code);
    // Control flow, a declaration of something that is not a function, and the two
    // shapes that open a block without being one.
    const NOT_FN: &[&str] = &[
        "if", "for", "while", "switch", "match", "catch", "else", "do", "try", "with",
        "struct", "enum", "impl", "class", "interface", "namespace", "union", "return",
    ];
    if NOT_FN.contains(&w) {
        return None;
    }
    let open = code.find('(')?;
    let head = &code[..open];
    // The identifier immediately before the parameter list — `pub fn build_line_items`
    // gives `build_line_items`, `const esc = ` gives `esc`.
    let name: String = head
        .trim_end()
        .rsplit(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
        .next()
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        // `const f = (a) => {` puts the name before the `=`, not before the `(`.
        let before_eq = head.split('=').next().unwrap_or("").trim();
        let n2 = before_eq.rsplit(char::is_whitespace).next().unwrap_or("");
        if n2.is_empty() || !n2.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_') {
            return None;
        }
        return Some(n2.to_string());
    }
    // A call with a trailing block (`items.forEach(x => {`) is not a declaration we can
    // name usefully, but it *is* a body worth scoring, so it keeps the callee's name.
    Some(name)
}

fn def_name(t: &str) -> Option<String> {
    let rest = t.strip_prefix("def ").or_else(|| t.strip_prefix("async def "))?;
    let end = rest.find(|c: char| !(c.is_alphanumeric() || c == '_'))?;
    Some(rest[..end].to_string())
}

// ---------------------------------------------------------------------------
// duplication
// ---------------------------------------------------------------------------

/// A line reduced to what a copy of it would share: no comment, no indentation, inner
/// whitespace collapsed. Lines that survive as nothing but punctuation are dropped
/// entirely, so a run of six closing braces is never a "duplicate block".
/// Writes into `buf` and answers whether the line counts. Filling a caller-owned buffer
/// rather than returning a `String` is not a micro-optimisation for its own sake: this
/// runs once per line of every file in the project, so the allocation it removes is one
/// per line of the whole codebase on every call.
fn significant_into(line: &str, fam: Family, in_block: &mut bool, buf: &mut String) -> bool {
    buf.clear();
    if !is_code(line, fam, in_block) {
        return false;
    }
    let t = line.split("//").next().unwrap_or(line).trim();
    if t.len() < 4 {
        return false;
    }
    let mut space = false;
    let mut alnum = false;
    for c in t.chars() {
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !buf.is_empty() {
            buf.push(' ');
        }
        space = false;
        alnum |= c.is_alphanumeric();
        buf.push(c);
    }
    alnum
}

fn hash(s: &str) -> u64 {
    // FNV-1a: no allocation, no dependency, and good enough for a lookup table where a
    // collision costs one wrong chip rather than anything structural.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// The significant lines of a file, each with the line number it came from.
fn sig_lines(src: &str, fam: Family) -> Vec<(u32, u64)> {
    let mut in_block = false;
    let mut buf = String::with_capacity(160);
    let mut out = Vec::new();
    for (i, l) in src.lines().enumerate() {
        if significant_into(l, fam, &mut in_block, &mut buf) {
            out.push(((i + 1) as u32, hash(&buf)));
        }
    }
    out
}

/// Every `DUP_WINDOW`-line block in a file, as (hash of the block, first line number).
fn windows_of(sig: &[(u32, u64)]) -> Vec<(u64, u32)> {
    if sig.len() < DUP_WINDOW {
        return Vec::new();
    }
    (0..=sig.len() - DUP_WINDOW)
        .map(|i| {
            let mut h: u64 = 0xcbf2_9ce4_8422_2325;
            for (_, lh) in &sig[i..i + DUP_WINDOW] {
                h ^= lh;
                h = h.wrapping_mul(0x1000_0000_01b3);
            }
            (h, sig[i].0)
        })
        .collect()
}

/// Where a block has been seen. Two slots rather than one, and that is load-bearing:
/// the index is built from the whole project *including* the file being reviewed, so
/// the first sighting of a copied block is very often the changed file itself — and a
/// one-slot index then reports "this block is a copy of itself" and drops the real
/// partner. Two slots are always enough, because one window occupies one position in
/// one file, so at most one of the two can be the lookup's own.
#[derive(Clone, Copy, Debug)]
struct Sight {
    a: (u32, u32),
    b: Option<(u32, u32)>,
}
impl Sight {
    fn saw(&mut self, at: (u32, u32)) {
        if self.b.is_none() && at != self.a {
            self.b = Some(at);
        }
    }
    /// The first sighting that is not the caller's own window.
    fn other_than(&self, me: (u32, u32)) -> Option<(u32, u32)> {
        [Some(self.a), self.b].into_iter().flatten().find(|&s| s != me)
    }
}

/// Where a block already lives.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct DupHit {
    /// First line of the block in the changed file.
    pub line: u32,
    pub other_path: String,
    pub other_line: u32,
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/// What the frontend knows about one changed file, and this module does not.
///
/// `added` is the *new-file* line numbers of the added lines — not their text, which
/// would mean sending the patch back to Rust and parsing it a second time. The file on
/// disk is the text; ./diff already owns the parsing and stays the only parser.
#[derive(serde::Deserialize)]
pub(crate) struct ChangedFile {
    pub path: String,
    pub added: Vec<u32>,
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct FileHealth {
    pub path: String,
    /// Code lines in the file as it now stands, comments and blanks excluded.
    pub code_lines: u32,
    /// How many of this change's added lines were code rather than comment or blank.
    pub code_added: u32,
    /// The deepest nesting any added line sits at.
    pub max_nesting: u32,
    /// The line that reached it, so a chip can go there.
    pub nesting_line: u32,
    /// The worst function this change touched, by cognitive complexity, and the longest
    /// one by code lines. Often the same function; both are reported because "hard" and
    /// "long" are different complaints with different fixes.
    pub worst_fn: Option<FnSpan>,
    pub longest_fn: Option<FnSpan>,
    pub dups: Vec<DupHit>,
    /// False when the file could not be read or was over the size cap — the frontend
    /// then shows nothing rather than a row of confident zeroes.
    pub measured: bool,
}

/// Thresholds a project sets for itself, in the file it already has:
///
/// ```toml
/// [health]
/// cognitive = 20    # a touched function's complexity before it is called out
/// nesting   = 6     # how deep an added line may sit
/// long_fn   = 90    # code lines in one function
/// size_add  = 40    # code added before the file's size is worth mentioning
/// ```
///
/// **Every field is `Option`, and absent means "use the default"** — the same rule
/// `[claim]` follows next door, for the same reason: a partial table must not be read as
/// a total one. A `Default`-ed `u32` would be 0, and a threshold of 0 fires on every
/// file, so one forgotten key would turn the whole diff red. The frontend clamps again on
/// receipt (`clampHealth`), so a hand-written 0 or a negative is refused rather than
/// honoured at either end.
#[derive(serde::Serialize, serde::Deserialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthPolicy {
    pub cognitive: Option<u32>,
    pub nesting: Option<u32>,
    /// `long_fn`/`size_add` in the file, `longFn`/`sizeAdd` on the wire: TOML is written
    /// by hand and snake_case is what the rest of `.episko/` uses, while the frontend
    /// table is TypeScript. The alias carries the first, `rename_all` the second.
    #[serde(alias = "long_fn")]
    pub long_fn: Option<u32>,
    #[serde(alias = "size_add")]
    pub size_add: Option<u32>,
}

#[derive(serde::Deserialize, Default)]
struct RawHealthFile {
    health: Option<HealthPolicy>,
}

/// A project's `[health]` table, or the empty policy. Forgiving on read, like every
/// other reader of this file: a `.episko/episko.toml` broken by a merge conflict must
/// not take the chips away silently *and* wrongly — no table is the same answer as no
/// file, which is "use the defaults".
pub(crate) fn parse_health_policy(toml_text: &str) -> HealthPolicy {
    toml::from_str::<RawHealthFile>(toml_text)
        .ok()
        .and_then(|f| f.health)
        .unwrap_or_default()
}

#[derive(serde::Serialize, Debug)]
pub(crate) struct HealthReport {
    pub files: Vec<FileHealth>,
    /// The project's own 90th percentile of code lines per file. "Big" is relative or it
    /// is nothing.
    pub p90_code_lines: u32,
    /// How many project files the duplicate index covers, and whether the caps cut it
    /// short. The UI says so rather than letting a partial sweep read as a clean one.
    pub indexed: u32,
    pub truncated: bool,
    /// The project's own thresholds, carried on the report rather than fetched by a
    /// second command: they are read from a file this call already has the root of, and
    /// a separate round trip could only ever arrive at a different time than the numbers
    /// it applies to.
    pub prefs: HealthPolicy,
}

/// Measure a change against the project it lands in.
///
/// One pass over the project index does both project-level jobs at once — it has to read
/// every file to hash its blocks, so counting its code lines for the percentile is free.
#[tauri::command(async)]
pub(crate) fn project_health(workdir: String, changed: Vec<ChangedFile>) -> HealthReport {
    let root = std::path::Path::new(&workdir);
    let (paths, mut truncated, _) = crate::files::index_of(&workdir);
    if paths.len() > MAX_INDEX_FILES {
        truncated = true;
    }

    // Block hash -> the first two places it was seen.
    let mut index: HashMap<u64, Sight> = HashMap::new();
    let mut sizes: Vec<u32> = Vec::new();
    let mut indexed = 0u32;
    let kept: Vec<String> = paths.into_iter().take(MAX_INDEX_FILES).collect();

    for (fi, rel) in kept.iter().enumerate() {
        let full = root.join(rel);
        match std::fs::metadata(&full) {
            Ok(md) if md.len() <= MAX_FILE_BYTES => {}
            _ => continue,
        }
        let Ok(src) = std::fs::read_to_string(&full) else { continue };
        let fam = family_of(rel);
        indexed += 1;
        let mut in_block = false;
        sizes.push(src.lines().filter(|l| is_code(l, fam, &mut in_block)).count() as u32);
        for (h, line) in windows_of(&sig_lines(&src, fam)) {
            index
                .entry(h)
                .and_modify(|s| s.saw((fi as u32, line)))
                .or_insert(Sight { a: (fi as u32, line), b: None });
        }
    }
    sizes.sort_unstable();
    let p90_code_lines = if sizes.is_empty() {
        0
    } else {
        sizes[(sizes.len() * 9 / 10).min(sizes.len() - 1)]
    };

    let files = changed
        .into_iter()
        .map(|c| measure_change(root, &c, &index, &kept))
        .collect();

    let prefs = std::fs::read_to_string(root.join(".episko").join("episko.toml"))
        .map(|t| parse_health_policy(&t))
        .unwrap_or_default();

    HealthReport { files, p90_code_lines, indexed, truncated, prefs }
}

fn measure_change(
    root: &std::path::Path,
    c: &ChangedFile,
    index: &HashMap<u64, Sight>,
    kept: &[String],
) -> FileHealth {
    let mut out = FileHealth {
        path: c.path.clone(),
        code_lines: 0,
        code_added: 0,
        max_nesting: 0,
        nesting_line: 0,
        worst_fn: None,
        longest_fn: None,
        dups: Vec::new(),
        measured: false,
    };
    let full = root.join(&c.path);
    match std::fs::metadata(&full) {
        Ok(md) if md.len() <= MAX_FILE_BYTES => {}
        // A deleted file, or one too big to say anything honest about.
        _ => return out,
    }
    let Ok(src) = std::fs::read_to_string(&full) else { return out };

    let fam = family_of(&c.path);
    let m = measure(&src, fam);
    out.measured = true;
    out.code_lines = m.code_lines;

    for &n in &c.added {
        let i = n as usize;
        if i < m.code.len() && m.code[i] {
            out.code_added += 1;
        }
        if i < m.depth.len() && m.depth[i] > out.max_nesting {
            out.max_nesting = m.depth[i];
            out.nesting_line = n;
        }
    }

    // Only functions this change actually went into. A file's worst function is the
    // project view's business; here the question is what *this* change made harder.
    let touched: Vec<&FnSpan> = m
        .fns
        .iter()
        .filter(|f| c.added.iter().any(|&n| n >= f.start && n <= f.end))
        .collect();
    out.worst_fn = touched.iter().max_by_key(|f| f.cognitive).map(|f| (*f).clone());
    out.longest_fn = touched.iter().max_by_key(|f| f.code_lines).map(|f| (*f).clone());

    // Duplicates: only blocks that *start* on an added line, so an untouched copy that
    // has been sitting in the file for a year is not reported as something you just did.
    let added: std::collections::HashSet<u32> = c.added.iter().copied().collect();
    // `u32::MAX` for a path the sweep never saw (over the size cap, or past the file
    // cap) never equals a real index, so every sighting counts as "somewhere else".
    let self_i = kept.iter().position(|p| p == &c.path).map_or(u32::MAX, |i| i as u32);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (h, line) in windows_of(&sig_lines(&src, fam)) {
        if out.dups.len() >= MAX_DUP_HITS {
            break;
        }
        if !added.contains(&line) {
            continue;
        }
        let Some(sight) = index.get(&h) else { continue };
        let Some((fi, other_line)) = sight.other_than((self_i, line)) else { continue };
        let Some(other_path) = kept.get(fi as usize).cloned() else { continue };
        // One hit per partner file: a copied 40-line function otherwise reports 35
        // overlapping windows against the same neighbour.
        if !seen.insert(other_path.clone()) {
            continue;
        }
        out.dups.push(DupHit { line, other_path, other_line });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brace(src: &str) -> FileMetrics {
        measure(src, Family::Brace)
    }

    #[test]
    fn code_lines_exclude_comments_and_blanks() {
        let src = "// a comment\n\nlet x = 1;\n/* block\n   still block */\nlet y = 2;\n";
        assert_eq!(brace(src).code_lines, 2);
    }

    #[test]
    fn a_python_comment_is_hash_and_a_brace_comment_is_not() {
        let py = "# note\nx = 1\n";
        assert_eq!(measure(py, Family::Indent).code_lines, 1);
        // The same text read as a brace family keeps the `#` line — a `#` is a
        // preprocessor directive in C, not a comment.
        assert_eq!(measure(py, Family::Brace).code_lines, 2);
    }

    #[test]
    fn an_unknown_family_counts_every_non_blank_line() {
        // No comment syntax is assumed, which is the honest answer for a file whose
        // language we do not know.
        assert_eq!(measure("# x\n\ny\n", Family::Plain).code_lines, 2);
    }

    #[test]
    fn a_brace_inside_a_string_does_not_open_a_block() {
        let src = "function f() {\n  const s = \"a { b\";\n  return s;\n}\nlet after = 1;\n";
        let m = brace(src);
        assert_eq!(m.fns.len(), 1);
        assert_eq!(m.fns[0].name, "f");
        // Without literal blanking the function would still be open here and swallow
        // the rest of the file.
        assert_eq!(m.fns[0].end, 4, "the closing brace ends it: {:?}", m.fns);
    }

    #[test]
    fn control_flow_is_not_mistaken_for_a_function() {
        let src = "function real(a) {\n  if (a) {\n    while (a) {\n      a--;\n    }\n  }\n}\n";
        let m = brace(src);
        assert_eq!(m.fns.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["real"]);
    }

    #[test]
    fn nesting_multiplies_complexity_the_way_cognitive_complexity_does() {
        let flat = brace("function f() {\n  if (a) { x(); }\n  if (b) { y(); }\n}\n");
        let deep = brace("function f() {\n  if (a) {\n    if (b) {\n      if (c) { y(); }\n    }\n  }\n}\n");
        // Two branches at the same level cost less than three that contain each other,
        // which is the whole point of the metric over cyclomatic complexity (both of
        // these have the same number of branches per path).
        assert!(deep.fns[0].cognitive > flat.fns[0].cognitive,
            "flat {} vs deep {}", flat.fns[0].cognitive, deep.fns[0].cognitive);
    }

    #[test]
    fn an_else_costs_one_regardless_of_where_it_sits() {
        let m = brace("function f() {\n  if (a) {\n    if (b) {\n      x();\n    } else {\n      y();\n    }\n  }\n}\n");
        // The nested `if` is scored with its nesting; the `else` beside it is not.
        assert!(m.fns[0].cognitive >= 3, "got {}", m.fns[0].cognitive);
    }

    #[test]
    fn a_closure_keeps_its_own_score_instead_of_giving_it_to_the_method() {
        let src = "function outer() {\n  items.forEach((i) => {\n    if (i) { go(); }\n  });\n}\n";
        let m = brace(src);
        assert_eq!(m.fns.len(), 2, "outer and the callback: {:?}", m.fns);
        assert!(m.fns[1].cognitive > 0, "the callback carries the branch");
    }

    #[test]
    fn python_functions_end_where_the_indentation_does() {
        let src = "def a():\n    x = 1\n    if x:\n        y()\n\ndef b():\n    pass\n";
        let m = measure(src, Family::Indent);
        assert_eq!(m.fns.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!((m.fns[0].start, m.fns[0].end), (1, 5));
        assert!(m.fns[0].cognitive > 0, "the `if` is scored");
    }

    #[test]
    fn depth_is_reported_per_line_so_an_added_line_can_be_asked_how_deep_it_is() {
        let m = brace("function f() {\n  if (a) {\n    deep();\n  }\n}\n");
        assert_eq!(m.depth[1], 0);
        assert_eq!(m.depth[3], 2, "inside if inside function: {:?}", m.depth);
    }

    #[test]
    fn a_run_of_punctuation_is_never_a_duplicate_block() {
        // Six closing braces are six identical lines and must not index as a block.
        let src = "}\n}\n}\n}\n}\n}\n";
        assert!(windows_of(&sig_lines(src, Family::Brace)).is_empty());
    }

    #[test]
    fn the_same_block_hashes_the_same_through_reindentation_and_comments() {
        let a = "let a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;\nlet e = 5;\nlet f = 6;\n";
        let b = "    let  a = 1;   // note\n    let b  = 2;\n    let c = 3;\n\n    let d = 4;\n    let e = 5;\n    let f = 6;\n";
        let wa = windows_of(&sig_lines(a, Family::Brace));
        let wb = windows_of(&sig_lines(b, Family::Brace));
        assert_eq!(wa[0].0, wb[0].0, "whitespace and a comment must not change the block");
        assert_eq!(wb[0].1, 1, "the block still starts at the line it starts at");
    }

    #[test]
    fn a_block_shorter_than_the_window_is_not_indexed() {
        assert!(windows_of(&sig_lines("let a = 1;\nlet b = 2;\n", Family::Brace)).is_empty());
    }

    /// The end-to-end path, against real files: a project with one file copied into
    /// another must report the copy, and must not report a file against itself.
    #[test]
    fn project_health_finds_a_block_copied_into_another_file() {
        let dir = crate::testutil::scratch_dir();
        let body = "let a = compute(1);\nlet b = compute(2);\nlet c = a + b;\nlet d = c * 2;\nlet e = d - 1;\nlet f = e / 3;\n";
        std::fs::write(dir.join("orig.ts"), format!("function orig() {{\n{body}}}\n")).unwrap();
        std::fs::write(dir.join("copy.ts"), format!("function copy() {{\n{body}}}\n")).unwrap();
        crate::testutil::git(&dir, &["init", "-q", "-b", "main"]);
        crate::testutil::git(&dir, &["add", "-A"]);

        // Every line of copy.ts is "added", as it would be for a new file.
        let changed = vec![ChangedFile { path: "copy.ts".into(), added: (1..=8).collect() }];
        let rep = project_health(dir.to_string_lossy().to_string(), changed);
        let f = &rep.files[0];
        assert!(f.measured);
        assert_eq!(f.dups.len(), 1, "one partner file, not one hit per window: {:?}", f.dups);
        assert_eq!(f.dups[0].other_path, "orig.ts");
        assert!(rep.indexed >= 2, "both files indexed, got {}", rep.indexed);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_health_reports_only_the_functions_the_change_touched() {
        let dir = crate::testutil::scratch_dir();
        let src = "function untouched() {\n  if (a) { if (b) { if (c) { x(); } } }\n}\nfunction touched() {\n  y();\n}\n";
        std::fs::write(dir.join("a.ts"), src).unwrap();
        crate::testutil::git(&dir, &["init", "-q", "-b", "main"]);
        crate::testutil::git(&dir, &["add", "-A"]);

        let changed = vec![ChangedFile { path: "a.ts".into(), added: vec![5] }];
        let rep = project_health(dir.to_string_lossy().to_string(), changed);
        let w = rep.files[0].worst_fn.as_ref().expect("a touched function");
        assert_eq!(w.name, "touched", "the nasty one was not part of this change");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_is_gone_reports_nothing_rather_than_zeroes() {
        let dir = crate::testutil::scratch_dir();
        crate::testutil::git(&dir, &["init", "-q", "-b", "main"]);
        let changed = vec![ChangedFile { path: "deleted.ts".into(), added: vec![] }];
        let rep = project_health(dir.to_string_lossy().to_string(), changed);
        assert!(!rep.files[0].measured);
        assert_eq!(rep.files[0].code_lines, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_project_can_set_its_own_thresholds_in_the_file_it_already_has() {
        let p = parse_health_policy("[health]\ncognitive = 20\nlong_fn = 90\n");
        assert_eq!(p.cognitive, Some(20));
        assert_eq!(p.long_fn, Some(90));
        // Absent is absent, never zero: a `Default`-ed u32 would be 0, and a threshold of
        // 0 fires on everything, so one forgotten key would turn the whole diff red.
        assert_eq!(p.nesting, None);
        assert_eq!(p.size_add, None);
    }

    #[test]
    fn a_health_policy_reads_either_spelling_of_a_two_word_key() {
        assert_eq!(parse_health_policy("[health]\nlong_fn = 90\n").long_fn, Some(90));
        assert_eq!(parse_health_policy("[health]\nlongFn = 90\n").long_fn, Some(90));
    }

    #[test]
    fn a_broken_or_unrelated_file_leaves_the_defaults_alone() {
        // Same forgiving-on-read stance as `[claim]` next door: a file broken by a merge
        // conflict must not silently take the chips away.
        assert_eq!(parse_health_policy("[health]\ncognitive = "), HealthPolicy::default());
        assert_eq!(parse_health_policy("[claim]\nassign = false\n"), HealthPolicy::default());
        assert_eq!(parse_health_policy(""), HealthPolicy::default());
    }

    #[test]
    fn the_policy_rides_on_the_report_rather_than_a_second_command() {
        let dir = crate::testutil::scratch_dir();
        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        std::fs::write(dir.join(".episko/episko.toml"), "[health]\nnesting = 8\n").unwrap();
        std::fs::write(dir.join("a.ts"), "let x = 1;\n").unwrap();
        crate::testutil::git(&dir, &["init", "-q", "-b", "main"]);
        crate::testutil::git(&dir, &["add", "-A"]);
        let rep = project_health(dir.to_string_lossy().to_string(), vec![]);
        assert_eq!(rep.prefs.nesting, Some(8));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_percentile_is_the_projects_own_and_not_a_constant() {
        let dir = crate::testutil::scratch_dir();
        for i in 0..10 {
            let lines = "x();\n".repeat(i * 10 + 1);
            std::fs::write(dir.join(format!("f{i}.ts")), lines).unwrap();
        }
        crate::testutil::git(&dir, &["init", "-q", "-b", "main"]);
        crate::testutil::git(&dir, &["add", "-A"]);
        let rep = project_health(dir.to_string_lossy().to_string(), vec![]);
        // Sizes are 1, 11, 21 … 91; the 90th percentile lands at the top of that run.
        assert!(rep.p90_code_lines >= 81, "got {}", rep.p90_code_lines);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
