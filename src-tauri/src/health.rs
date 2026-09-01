//! What a change did to the shape of the code: code lines, function spans, nesting,
//! approximate cognitive complexity and cross-file duplicates. Facts only; thresholds are
//! `health.ts`'s. No parsers, no cache and no watcher (docs/worktrees.md), by design.

use std::collections::HashMap;

const MAX_INDEX_FILES: usize = 6_000; // a mis-aimed open (a monorepo, a home dir) must stay bounded
const MAX_FILE_BYTES: u64 = 512 * 1024; // above this is generated, vendored or data
const DUP_WINDOW: usize = 6; // where PMD's CPD and jscpd settle; shorter and `if err != nil` is a clone
const MAX_DUP_HITS: usize = 8; // per file

// ---------------------------------------------------------------------------
// languages
// ---------------------------------------------------------------------------

/// How a file's structure is read: how blocks are delimited and what a comment looks like.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Family {
    Brace, // `{}` blocks, `//` and `/* */` comments: TS, JS, Rust, Go, Java, C…
    Indent, // indentation blocks, `#` comments: Python, Ruby
    Plain, // code lines only, still indexed for duplicates
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

/// Whether `'` opens a literal or names a lifetime. Not derivable from `Family`: Rust and
/// TS are both `Brace`, and reading `&'a str` as an opening quote blanks the rest of the
/// line and leaves `depth` skewed for the whole file after it.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Ticks {
    Quote, // `'` opens a string (JS/TS)
    Lifetime, // `'` is a lifetime unless it forms a character literal (Rust)
}

pub(crate) fn ticks_of(path: &str) -> Ticks {
    if path.rsplit('.').next() == Some("rs") { Ticks::Lifetime } else { Ticks::Quote }
}

/// Whether a path is code rather than docs, config or data; only this set feeds the size
/// distribution. `isSourcePath` in `./health` keeps the same list; keep them in step.
fn is_code_file(path: &str) -> bool {
    matches!(
        path.rsplit('.').next().unwrap_or(""),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "rs" | "go" | "py" | "rb" | "java"
            | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "swift" | "kt" | "kts" | "scala"
            | "php" | "dart" | "sh" | "bash" | "css" | "scss"
    )
}

/// Whether a line carries code. Raw line counts would light up on the best-documented
/// files and stay dark on a tidy module holding the same block four times.
fn is_code(line: &str, fam: Family, in_block: &mut bool) -> bool {
    let t = line.trim();
    if *in_block {
        if t.contains("*/") { // trailing code after `*/` is rare enough to ignore
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
        Family::Plain => true, // no comment syntax known; only blanks are discounted
    }
}

/// Blank string and character literals so a `{` inside one is not counted. Single-line
/// only: a multi-line template literal skews depth for as long as it runs.
fn blank_literals(line: &str, ticks: Ticks) -> String {
    let ch: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < ch.len() {
        let c = ch[i];
        let opens = c == '"' || c == '`'
            || (c == '\'' && (ticks == Ticks::Quote || is_char_literal(&ch, i)));
        if !opens {
            out.push(c);
            i += 1;
            continue;
        }
        out.push(' ');
        i += 1;
        let mut esc = false;
        while i < ch.len() {
            let d = ch[i];
            out.push(' ');
            i += 1;
            if esc {
                esc = false;
            } else if d == '\\' {
                esc = true;
            } else if d == c {
                break;
            }
        }
    }
    out
}

/// A Rust `'` that opens a character literal (`'a'`, `'\n'`, `'\u{41}'`) rather than a
/// lifetime. Must hold both ways: `'{'` read as a lifetime counts its brace, and `&'a`
/// read as a literal blanks the rest of the line.
fn is_char_literal(ch: &[char], i: usize) -> bool {
    match ch.get(i + 1) {
        Some('\\') => ch[i + 2..].contains(&'\''), // an escape runs to the next tick
        Some(_) => ch.get(i + 2) == Some(&'\''),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// one file, measured
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct FnSpan {
    pub name: String, // best effort; a callback carries the callee's name
    pub start: u32, // 1-based, inclusive
    pub end: u32,
    pub code_lines: u32,
    /// Approximates SonarSource's Cognitive Complexity without an AST: +1 per flow break,
    /// plus its nesting depth, plus one per line chaining boolean operators.
    pub cognitive: u32,
    /// Declared, as opposed to a callback handed to a call (`describe("…", () => {`). Only
    /// a declaration may win `longest_fn`; complexity still counts a fat callback.
    #[serde(skip)]
    pub decl: bool,
}

#[derive(Debug, Default)]
pub(crate) struct FileMetrics {
    pub code_lines: u32,
    pub fns: Vec<FnSpan>,
    pub depth: Vec<u32>, // nesting per line, 1-based to match the file
    pub code: Vec<bool>, // whether each line carries code, same indexing
}

/// Flow breaks. `else` is scored flat, as Cognitive Complexity does.
const FLOW: &[&str] = &["if", "for", "while", "switch", "match", "case", "catch", "except", "elif"];

/// The first word of a line; stricter than `contains`, which would score the `if` in `notify(`.
fn first_word(t: &str) -> &str {
    let t = t.trim_start_matches(|c: char| c == '}' || c == ')' || c.is_whitespace());
    let end = t.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(t.len());
    &t[..end]
}

/// Walk a file once and answer everything the caller can need from its shape.
pub(crate) fn measure(src: &str, fam: Family, ticks: Ticks) -> FileMetrics {
    let mut m = FileMetrics::default();
    m.depth.push(0); // index 0 unused, so depth[n] is line n
    m.code.push(false);

    let mut in_block = false;
    let mut depth: i32 = 0;
    // Open functions as (index into m.fns, body depth). A stack, or a closure inside a
    // method would hand its complexity to whatever came after it.
    let mut open: Vec<(usize, i32)> = Vec::new();
    let unit = if fam == Family::Indent { indent_unit(src) } else { 4 }; // the file's own step

    for (i, raw) in src.lines().enumerate() {
        let n = (i + 1) as u32;
        let code = is_code(raw, fam, &mut in_block);
        m.code.push(code);
        let t = raw.trim();

        let here = match fam {
            Family::Brace => depth.max(0) as u32,
            Family::Indent => leading_cols(raw) / unit,
            Family::Plain => 0,
        };
        // Depth is relative to the enclosing function in both families, so one threshold
        // means one thing: level 1 is a statement in the function body wherever you are.
        m.depth.push(match open.last() {
            Some(&(_, base)) => (here as i32 - base + 1).max(1) as u32,
            None => here,
        });
        if code {
            m.code_lines += 1;
        }

        if fam == Family::Plain || !code {
            if fam == Family::Brace {
                depth += brace_delta(raw, ticks);
            }
            continue;
        }

        // --- scoring the line against whatever functions are open ---
        let add = flow_score(t, fam, ticks);
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
                let delta = brace_delta(raw, ticks);
                if let Some(name) = fn_name(t, ticks) {
                    m.fns.push(FnSpan { name, start: n, end: n, code_lines: 0, cognitive: 0, decl: is_decl(t, ticks) });
                    open.push((m.fns.len() - 1, depth.max(0) as u32 as i32 + 1)); // the body is one level in
                }
                depth += delta;
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
                    // `def` is always a declaration; there is no callback form here.
                    m.fns.push(FnSpan { name, start: n, end: n, code_lines: 0, cognitive: 0, decl: true });
                    open.push((m.fns.len() - 1, here as i32 + 1));
                }
            }
            Family::Plain => {}
        }
    }
    let last = src.lines().count() as u32;
    for (fi, _) in open {
        m.fns[fi].end = last;
    }
    m
}

fn leading_cols(raw: &str) -> u32 {
    let mut cols = 0u32;
    for c in raw.chars() {
        match c {
            ' ' => cols += 1,
            '\t' => cols += 4,
            _ => break,
        }
    }
    cols
}

/// The file's own indentation step: the commonest positive jump between consecutive
/// non-blank lines, else 4. Clamped to 2..=8: a 1-column "step" is a continuation line.
fn indent_unit(src: &str) -> u32 {
    let mut hist = [0u32; 9];
    let mut prev = 0u32;
    let mut started = false;
    for l in src.lines() {
        if l.trim().is_empty() {
            continue;
        }
        let w = leading_cols(l);
        if started && w > prev {
            hist[((w - prev).min(8)) as usize] += 1;
        }
        prev = w;
        started = true;
    }
    // A tie falls to the smallest step: over-reporting depth is visible, under-reporting
    // is not. `min_by_key` keeps the FIRST minimum; `max_by_key` would keep the LAST (8).
    let best = (2..=8).min_by_key(|&d| (std::cmp::Reverse(hist[d as usize]), d)).unwrap_or(4);
    if hist[best as usize] == 0 { 4 } else { best }
}

fn brace_delta(raw: &str, ticks: Ticks) -> i32 {
    let clean = blank_literals(raw, ticks);
    let code = clean.split("//").next().unwrap_or("");
    code.chars().filter(|&c| c == '{').count() as i32 - code.chars().filter(|&c| c == '}').count() as i32
}

/// `(flow, flat)`: what this line adds to complexity, split by whether nesting multiplies it.
fn flow_score(t: &str, fam: Family, ticks: Ticks) -> (u32, u32) {
    let w = first_word(t);
    let mut flow = 0;
    let mut flat = 0;
    if FLOW.contains(&w) {
        flow += 1;
    }
    if w == "else" {
        flat += 1; // `else if` is one branch, not two
    }
    if fam == Family::Brace && t.contains("=>") && t.contains('?') && t.contains(':') {
        flat += 1; // a ternary in an arrow body, near enough
    }
    let clean = blank_literals(t, ticks);
    if clean.contains("&&") {
        flat += 1;
    }
    if clean.contains("||") {
        flat += 1;
    }
    (flow, flat)
}

/// Drop a leading visibility modifier. `pub(crate)` carries its own parentheses, so left
/// in place every function is named `pub` and `pub(crate) struct` passes as a function.
fn strip_vis(code: &str) -> &str {
    let Some(rest) = code.strip_prefix("pub") else { return code };
    // `pub(crate)`, `pub(super)`, `pub(in crate::a)` — take the balanced group, if any.
    let rest = match rest.strip_prefix('(') {
        Some(inner) => match inner.find(')') {
            Some(i) => &inner[i + 1..],
            None => return code, // unbalanced; leave the line alone rather than guess
        },
        None => rest,
    };
    // `pubwhatever` is an identifier that merely starts with the keyword.
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return code;
    }
    rest.trim_start()
}

/// The function a brace-family line declares, or None. Loose by design (`function f(`,
/// `const f = (`, `func (r *T) f(`, a bare method `f(`); control flow has the same
/// shape and is rejected by keyword.
fn fn_name(t: &str, ticks: Ticks) -> Option<String> {
    let clean = blank_literals(t, ticks);
    let code = strip_vis(clean.split("//").next().unwrap_or("").trim());
    if !code.ends_with('{') || !code.contains('(') {
        return None;
    }
    let w = first_word(code);
    const NOT_FN: &[&str] = &[
        "if", "for", "while", "switch", "match", "catch", "else", "do", "try", "with",
        "struct", "enum", "impl", "class", "interface", "namespace", "union", "return",
        "trait", "extern", "unsafe", "mod",
    ];
    if NOT_FN.contains(&w) {
        return None;
    }
    let open = code.find('(')?;
    let head = &code[..open];
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
        let n2 = n2.split('<').next().unwrap_or(n2); // `fn f<'a>` and `function f<T>` are both `f`
        if n2.is_empty() || !n2.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_') {
            return None;
        }
        return Some(n2.to_string());
    }
    // A call with a trailing block keeps the callee's name; its body is still worth scoring.
    Some(name)
}

/// Whether the block belongs to a function somebody declared. A line ending `=> {` hands
/// its block to a lambda named for the callee, unless the arrow is itself being named.
fn is_decl(t: &str, ticks: Ticks) -> bool {
    let clean = blank_literals(t, ticks);
    let code = strip_vis(clean.split("//").next().unwrap_or("").trim()).trim_end();
    if !code.ends_with("=> {") {
        return true;
    }
    code.split('(').next().unwrap_or("").contains('=') // `const f = (a) => {` names it
}

fn def_name(t: &str) -> Option<String> {
    let rest = t.strip_prefix("def ").or_else(|| t.strip_prefix("async def "))?;
    let end = rest.find(|c: char| !(c.is_alphanumeric() || c == '_'))?;
    Some(rest[..end].to_string())
}

// ---------------------------------------------------------------------------
// duplication
// ---------------------------------------------------------------------------

/// A line reduced to what a copy would share: no comment, no indentation, inner
/// whitespace collapsed; pure punctuation does not count. Fills `buf` because this runs
/// once per line of the whole project and the allocation it saves is one per line.
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
    let mut h: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a: no allocation, no dependency
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// (line number, hash) for each significant line of a file.
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

/// Where a block has been seen. Two slots, because the index includes the file under
/// review, so the first sighting is often the lookup's own window.
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
    fn other_than(&self, me: (u32, u32)) -> Option<(u32, u32)> {
        [Some(self.a), self.b].into_iter().flatten().find(|&s| s != me)
    }
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct DupHit {
    pub line: u32, // first line of the block in the changed file
    pub other_path: String,
    pub other_line: u32,
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/// One changed file as the frontend sees it. `added` is new-file line numbers, not text:
/// the file on disk is the text, and ./diff stays the only parser.
#[derive(serde::Deserialize)]
pub(crate) struct ChangedFile {
    pub path: String,
    pub added: Vec<u32>,
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct FileHealth {
    pub path: String,
    pub code_lines: u32, // comments and blanks excluded
    pub code_added: u32, // added lines that were code
    pub max_nesting: u32, // the deepest any added line sits
    pub nesting_line: u32, // the line that reached it
    /// The worst touched function by complexity and the longest by code lines; often the
    /// same one, but "hard" and "long" have different fixes.
    pub worst_fn: Option<FnSpan>,
    pub longest_fn: Option<FnSpan>,
    pub dups: Vec<DupHit>,
    pub measured: bool, // false: unreadable or over the cap, and every other field is meaningless
}

/// The `[health]` table of `.episko/episko.toml`: `cognitive` (a touched function's complexity
/// before it is called out), `nesting` (how deep an added line may sit), `long_fn` (code lines
/// in one function), `size_add` (code added before the file's size is worth mentioning). Absent
/// means the default: a `Default`-ed 0 would fire on every file, and `clampHealth` clamps again.
#[derive(serde::Serialize, serde::Deserialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthPolicy {
    pub cognitive: Option<u32>,
    pub nesting: Option<u32>,
    /// `long_fn` in hand-written TOML, `longFn` on the wire: the alias vs. `rename_all`.
    #[serde(alias = "long_fn")]
    pub long_fn: Option<u32>,
    #[serde(alias = "size_add")]
    pub size_add: Option<u32>,
}

#[derive(serde::Deserialize, Default)]
struct RawHealthFile {
    health: Option<HealthPolicy>,
}

/// A project's `[health]` table, or the empty policy. Forgiving on read like `[claim]`:
/// a broken `.episko/episko.toml` means "use the defaults", never "no chips".
pub(crate) fn parse_health_policy(toml_text: &str) -> HealthPolicy {
    toml::from_str::<RawHealthFile>(toml_text)
        .ok()
        .and_then(|f| f.health)
        .unwrap_or_default()
}

#[derive(serde::Serialize, Debug)]
pub(crate) struct HealthReport {
    pub files: Vec<FileHealth>,
    pub p90_code_lines: u32, // the project's own percentile: "big" is relative or it is nothing
    pub indexed: u32, // files the duplicate index covers
    pub truncated: bool, // the caps cut the sweep short; the UI says so
    pub prefs: HealthPolicy, // carried here so thresholds and numbers arrive together
}

/// Measure a change against the project it lands in. One pass over the index builds the
/// duplicate table and the size percentile together.
#[tauri::command(async)]
pub(crate) fn project_health(workdir: String, changed: Vec<ChangedFile>) -> HealthReport {
    let root = std::path::Path::new(&workdir);
    let (paths, mut truncated, _) = crate::files::index_of(&workdir);
    if paths.len() > MAX_INDEX_FILES {
        truncated = true;
    }

    let mut index: HashMap<u64, Sight> = HashMap::new(); // block hash -> first two sightings
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
        // The percentile is over code files only: markdown and JSON in it move the
        // threshold for reasons that have nothing to do with code. Everything is indexed.
        if is_code_file(rel) {
            let mut in_block = false;
            sizes.push(src.lines().filter(|l| is_code(l, fam, &mut in_block)).count() as u32);
        }
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
        _ => return out, // deleted, or too big to say anything honest about
    }
    let Ok(src) = std::fs::read_to_string(&full) else { return out };

    let fam = family_of(&c.path);
    let m = measure(&src, fam, ticks_of(&c.path));
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

    // Only functions this change went into; the file's worst is the project view's business.
    let touched: Vec<&FnSpan> = m
        .fns
        .iter()
        .filter(|f| c.added.iter().any(|&n| n >= f.start && n <= f.end))
        .collect();
    out.worst_fn = touched.iter().max_by_key(|f| f.cognitive).map(|f| (*f).clone());
    // Declarations only, or the longest block on every vitest file is the `describe`.
    out.longest_fn = touched.iter().filter(|f| f.decl).max_by_key(|f| f.code_lines).map(|f| (*f).clone());

    // Only blocks that start on an added line; an old copy is not something you just did.
    let added: std::collections::HashSet<u32> = c.added.iter().copied().collect();
    // `u32::MAX` for a path the sweep never saw can never equal a real index.
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
        // Only between files of the same kind: docs quoting the code they document are not debt.
        if is_code_file(&c.path) != is_code_file(&other_path) {
            continue;
        }
        // One hit per partner file, not one per overlapping window.
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
        measure(src, Family::Brace, Ticks::Quote)
    }

    fn rust(src: &str) -> FileMetrics {
        measure(src, Family::Brace, Ticks::Lifetime)
    }

    /// An odd number of ticks on one line is the sharp case: the brace never counted and
    /// depth stayed skewed for every line after it.
    #[test]
    fn a_lifetime_is_not_a_string() {
        // Three ticks: the odd one out used to swallow the brace.
        let m = rust("fn f<'a>(x: &'a str, y: &'a str) {\n    g();\n}\nfn after() {\n    h();\n}\n");
        assert_eq!(m.fns.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["f", "after"]);
        assert_eq!(m.depth[2], 1, "the body of `f` is one level in");
        assert_eq!(m.depth[5], 1, "a later function must not inherit a skewed depth");

        // Two ticks: everything between them vanished, the name and the `(` included.
        let im = rust("impl<'a> Thing<'a> {\n    fn make<'b>(v: &'b str) -> Self {\n        Self\n    }\n}\n");
        assert_eq!(im.fns.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["make"]);
        // 1, not 2: an `impl` wrapper is not a level (a_module_or_impl_wrapper_does_not_add_a_level).
        assert_eq!(im.depth[3], 1, "the fn body, with the impl not counting: {:?}", im.depth);
    }

    /// The other direction: a character literal is still a literal, and this file is full of `'{'`.
    #[test]
    fn a_rust_character_literal_is_still_blanked() {
        assert_eq!(brace_delta("if c == '{' {", Ticks::Lifetime), 1, "only the real brace counts");
        assert_eq!(brace_delta("if c == '}' {", Ticks::Lifetime), 1);
        assert_eq!(brace_delta("let esc = '\\\\'; foo() {", Ticks::Lifetime), 1, "an escaped tick closes");
        assert_eq!(brace_delta("const s = 'a string with { in it';", Ticks::Quote), 0);
    }

    #[test]
    fn code_lines_exclude_comments_and_blanks() {
        let src = "// a comment\n\nlet x = 1;\n/* block\n   still block */\nlet y = 2;\n";
        assert_eq!(brace(src).code_lines, 2);
    }

    #[test]
    fn a_python_comment_is_hash_and_a_brace_comment_is_not() {
        let py = "# note\nx = 1\n";
        assert_eq!(measure(py, Family::Indent, Ticks::Quote).code_lines, 1);
        // In a brace family `#` is a C preprocessor directive, not a comment.
        assert_eq!(measure(py, Family::Brace, Ticks::Quote).code_lines, 2);
    }

    #[test]
    fn an_unknown_family_counts_every_non_blank_line() {
        assert_eq!(measure("# x\n\ny\n", Family::Plain, Ticks::Quote).code_lines, 2);
    }

    #[test]
    fn a_brace_inside_a_string_does_not_open_a_block() {
        let src = "function f() {\n  const s = \"a { b\";\n  return s;\n}\nlet after = 1;\n";
        let m = brace(src);
        assert_eq!(m.fns.len(), 1);
        assert_eq!(m.fns[0].name, "f");
        assert_eq!(m.fns[0].end, 4, "the closing brace ends it: {:?}", m.fns);
    }

    #[test]
    fn a_visibility_modifier_does_not_become_the_function_name() {
        let m = brace("pub(crate) fn measure(src: &str) -> FileMetrics {\n  x();\n}\n");
        assert_eq!(m.fns.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["measure"]);
        for src in ["pub fn plain(a: u32) {\n}\n", "pub(super) fn up() {\n}\n", "pub(in crate::a) fn deep() {\n}\n"] {
            let m = brace(src);
            assert_eq!(m.fns.len(), 1, "{src:?}");
            assert_ne!(m.fns[0].name, "pub", "{src:?}");
        }
    }

    /// `NOT_FN` tests the first word, which for `pub(crate) struct Foo {` was `pub`.
    #[test]
    fn a_public_type_declaration_is_not_a_function() {
        for src in [
            "pub(crate) struct Foo {\n  a: u32,\n}\n",
            "pub enum Bar {\n  A,\n}\n",
            "pub(crate) trait Baz {\n  fn go(&self);\n}\n",
        ] {
            let m = brace(src);
            assert!(m.fns.iter().all(|f| f.name != "pub"), "{src:?} -> {:?}", m.fns);
        }
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
        // Same branch count per path; cyclomatic complexity would score these equal.
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
        let m = measure(src, Family::Indent, Ticks::Quote);
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
    fn a_describe_block_cannot_win_the_longest_function() {
        let src = "describe(\"a suite\", () => {\n  if (a) { x(); }\n  const helper = (n) => {\n    y();\n  };\n});\n";
        let m = brace(src);
        let by = |n: &str| m.fns.iter().find(|f| f.name == n).unwrap_or_else(|| panic!("{n} missing in {:?}", m.fns));
        assert!(!by("describe").decl, "a callback handed to a call is not a declaration");
        assert!(by("helper").decl, "an arrow that is being named is");
        assert!(by("describe").cognitive > 0, "it still carries the complexity inside it");
    }

    #[test]
    fn a_method_and_a_keyword_form_are_both_declarations() {
        for src in ["fn go(a: u32) {\n}\n", "function go(a) {\n}\n", "  render(props) {\n  }\n"] {
            let m = brace(src);
            assert_eq!(m.fns.len(), 1, "{src:?} -> {:?}", m.fns);
            assert!(m.fns[0].decl, "{src:?}");
        }
    }

    #[test]
    fn indentation_is_read_in_the_files_own_step() {
        assert_eq!(indent_unit("def a():\n  if x:\n    y()\n"), 2);
        assert_eq!(indent_unit("def a():\n    if x:\n        y()\n"), 4);
        assert_eq!(indent_unit("\t\tdeep()\n"), 4, "a file with no step falls back");
        assert_eq!(indent_unit(""), 4);

        // One 2-column jump and one 4-column jump: a tie.
        assert_eq!(
            indent_unit("a\n  b\nc\n    d\n"), 2,
            "a tie must fall to the SMALLEST step: over-reporting depth is visible, under-reporting is not"
        );

        let two = measure("def a():\n  if x:\n    if y:\n      z()\n", Family::Indent, Ticks::Quote);
        let four = measure("def a():\n    if x:\n        if y:\n            z()\n", Family::Indent, Ticks::Quote);
        assert_eq!(two.depth[4], four.depth[4], "2-space and 4-space must agree");
        assert_eq!(two.depth[4], 3, "body, if, if -> three levels inside the function");
    }

    #[test]
    fn depth_is_measured_from_the_enclosing_function_in_both_families() {
        let br = brace("function f() {\n  if (a) {\n    deep();\n  }\n}\n");
        let py = measure("def f():\n    if a:\n        deep()\n", Family::Indent, Ticks::Quote);
        assert_eq!(br.depth[3], 2, "brace: body, if");
        assert_eq!(py.depth[3], 2, "indent: body, if — the same shape, the same number");

        // A method sits one brace deeper than a free function and must not report deeper.
        let meth = brace("class C {\n  m() {\n    if (a) {\n      deep();\n    }\n  }\n}\n");
        assert_eq!(meth.depth[4], 2, "a method's body is still level 1: {:?}", meth.depth);
    }

    /// Every Rust test here lives in `mod tests` and every method in an `impl`; if the
    /// wrapper counted, test code would sit one level deeper by construction.
    #[test]
    fn a_module_or_impl_wrapper_does_not_add_a_level() {
        let bare = brace("fn t() {\n  if a {\n    go();\n  }\n}\n");
        let wrapped = brace("mod tests {\n  fn t() {\n    if a {\n      go();\n    }\n  }\n}\n");
        let in_impl = brace("impl Foo {\n  fn t(&self) {\n    if a {\n      go();\n    }\n  }\n}\n");
        assert_eq!(bare.depth[3], 2, "body, if");
        assert_eq!(wrapped.depth[4], 2, "the mod is not a level: {:?}", wrapped.depth);
        assert_eq!(in_impl.depth[4], 2, "nor is the impl: {:?}", in_impl.depth);
    }

    #[test]
    fn the_percentile_ignores_documentation_and_config() {
        let dir = crate::testutil::scratch_dir();
        // One small code file, and a pile of long markdown that would drag p90 up.
        std::fs::write(dir.join("a.ts"), "x();\n".repeat(10)).unwrap();
        for i in 0..9 {
            std::fs::write(dir.join(format!("doc{i}.md")), "prose\n".repeat(500)).unwrap();
        }
        crate::testutil::git(&dir, &["init", "-q", "-b", "main"]);
        crate::testutil::git(&dir, &["add", "-A"]);
        let rep = project_health(dir.to_string_lossy().to_string(), vec![]);
        assert_eq!(rep.p90_code_lines, 10, "only a.ts counts toward the distribution");
        assert!(rep.indexed >= 10, "…but everything is still indexed for duplicates");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_of_punctuation_is_never_a_duplicate_block() {
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

    /// An agent rarely pastes verbatim: it renames the declaration, so the window has to
    /// slide past that line and match on the body.
    #[test]
    fn a_copy_whose_declaration_was_renamed_is_still_a_copy() {
        let dir = crate::testutil::scratch_dir();
        let body = "let a = compute(1);\nlet b = compute(2);\nlet c = a + b;\nlet d = c * 2;\nlet e = d - 1;\nlet f = e / 3;\nreturn f;\n";
        std::fs::write(dir.join("orig.ts"), format!("function elidePath() {{\n{body}}}\n")).unwrap();
        std::fs::write(dir.join("copy.ts"), format!("function shortenPath() {{\n{body}}}\n")).unwrap();
        crate::testutil::git(&dir, &["init", "-q", "-b", "main"]);
        crate::testutil::git(&dir, &["add", "-A"]);

        let changed = vec![ChangedFile { path: "copy.ts".into(), added: (1..=9).collect() }];
        let rep = project_health(dir.to_string_lossy().to_string(), changed);
        let f = &rep.files[0];
        assert_eq!(f.dups.len(), 1, "the renamed copy must still be found: {:?}", f.dups);
        assert_eq!(f.dups[0].other_path, "orig.ts");
        assert!(f.dups[0].line >= 2, "the match starts past the renamed line, got {}", f.dups[0].line);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prose_is_never_reported_as_a_duplicate_of_code() {
        let dir = crate::testutil::scratch_dir();
        let body = "let a = compute(1);\nlet b = compute(2);\nlet c = a + b;\nlet d = c * 2;\nlet e = d - 1;\nlet f = e / 3;\n";
        std::fs::write(dir.join("README.md"), format!("Here is how it works:\n\n```ts\n{body}```\n")).unwrap();
        std::fs::write(dir.join("a.ts"), format!("function go() {{\n{body}}}\n")).unwrap();
        crate::testutil::git(&dir, &["init", "-q", "-b", "main"]);
        crate::testutil::git(&dir, &["add", "-A"]);

        let changed = vec![ChangedFile { path: "a.ts".into(), added: (1..=8).collect() }];
        let rep = project_health(dir.to_string_lossy().to_string(), changed);
        assert!(rep.files[0].dups.is_empty(), "the README is not a partner: {:?}", rep.files[0].dups);
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
        // Absent is absent, never zero: a threshold of 0 fires on everything.
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
