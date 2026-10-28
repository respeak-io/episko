//! The advisory sweep (docs/maintenance.md § Advisory sweep): one advisory asked of every project's
//! lockfiles, on a click. Rust resolves the query and reads what is installed; maint.ts decides.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::lockfile::{Pkg, LOCKFILES};
use crate::maint::{found_paths, Cost, Exec, Severity, SysExec};
use crate::maint_sec::{osv_call, osv_id, record_severity, strs, summary_of, text, LOCK_BYTES, OSV_API};

// ---------- the query ----------

#[derive(Debug, PartialEq)]
pub(crate) enum Query {
    Id(String),
    Range { ecosystems: Vec<&'static str>, name: String, range: String },
}

/// The id schemes OSV.dev serves; a bare word outside them is a package name, never a lookup.
const ID_PREFIXES: &[&str] = &[
    "CVE", "GHSA", "RUSTSEC", "PYSEC", "GO", "OSV", "MAL", "GSD", "DSA", "DLA", "DTSA", "USN", "UBUNTU", "RHSA", "ALSA",
    "ALBA", "ALEA", "BIT", "CURL", "PSF", "ELA", "DEBIAN", "HSEC", "JLSEC", "SUSE", "OESA", "PHSA", "RLSA", "MGASA", "BELL",
];

/// OSV's ecosystem names and what a person may type for each.
const ECOSYSTEMS: &[(&str, &[&str])] = &[
    ("npm", &["npm", "node", "js"]),
    ("crates.io", &["crates.io", "crates", "cargo", "rust"]),
    ("PyPI", &["pypi", "pip", "python"]),
    ("Go", &["go", "golang"]),
    ("RubyGems", &["rubygems", "gem", "ruby"]),
    ("Packagist", &["packagist", "composer", "php"]),
    ("Maven", &["maven", "java"]),
    ("NuGet", &["nuget", "dotnet"]),
];

/// What `lockfile.rs` reads, so a range typed with no ecosystem is asked of each of them.
const READ_ECOSYSTEMS: &[&str] = &["npm", "crates.io"];

fn eco_of(word: &str) -> Option<&'static str> {
    let w = word.trim().to_ascii_lowercase();
    ECOSYSTEMS.iter().find(|(_, names)| names.contains(&w.as_str())).map(|(e, _)| *e)
}

/// GitHub's ids are lower-case after the prefix; every other scheme's tail is digits.
fn as_id(s: &str) -> Option<String> {
    let (pre, rest) = s.split_once('-')?;
    let pre = pre.to_ascii_uppercase();
    if !ID_PREFIXES.contains(&pre.as_str()) || !rest.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let id = if pre == "GHSA" { format!("{pre}-{}", rest.to_ascii_lowercase()) } else { format!("{pre}-{rest}") };
    osv_id(&id).then_some(id)
}

/// An advisory page's address: the last path segment that is an id (`.html` and `.json` dropped).
fn id_in_url(u: &str) -> Option<String> {
    let path = u.split(['?', '#']).next().unwrap_or(u);
    path.rsplit('/').filter(|s| !s.is_empty())
        .find_map(|s| as_id(s.trim_end_matches(".html").trim_end_matches(".json")))
}

fn name_ok(n: &str) -> bool {
    let body = n.strip_prefix('@').unwrap_or(n);
    !body.is_empty() && n.len() <= 214 && !body.contains('@')
        && body.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))
}

fn range_ok(r: &str) -> bool {
    r.len() <= 200 && r.chars().any(|c| c.is_ascii_digit() || c == '*')
        && r.chars().all(|c| c.is_ascii_alphanumeric() || " .<>=^~*|,+-".contains(c))
}

/// `CVE-…`, `GHSA-…`, an advisory's URL, `name@range` or `ecosystem:name range`; anything else is refused.
pub(crate) fn parse_query(q: &str) -> Result<Query, String> {
    let q = q.trim();
    let refuse = || format!("{q:?} is not an advisory id, nor a package and its range (lodash@<4.17.21, npm:next >=15.0.0 <15.5.6)");
    if q.is_empty() || q.len() > 400 {
        return Err(refuse());
    }
    if q.starts_with("https://") || q.starts_with("http://") {
        return id_in_url(q).map(Query::Id).ok_or_else(|| format!("{q} names no advisory id"));
    }
    if !q.contains(char::is_whitespace) && !q.contains('@') {
        if let Some(id) = as_id(q) {
            return Ok(Query::Id(id));
        }
    }
    let (ecosystems, rest) = match q.split_once(':') {
        Some((e, r)) => (vec![eco_of(e).ok_or_else(|| format!("{e:?} is not an ecosystem Episko knows"))?], r.trim()),
        None => (READ_ECOSYSTEMS.to_vec(), q),
    };
    // The `@` after a name, never a scope's leading one; else the first space.
    let at = rest.char_indices().skip(1).find(|(_, c)| *c == '@').map(|(i, _)| (i, 1))
        .or_else(|| rest.find(char::is_whitespace).map(|i| (i, 0)));
    let Some((i, skip)) = at else {
        return Err(if name_ok(rest) { format!("name a version range too: {rest}@<1.2.3, or {rest}@* for every version") } else { refuse() });
    };
    let (name, range) = (rest[..i].trim(), rest[i + skip..].trim());
    if !name_ok(name) || !range_ok(range) {
        return Err(refuse());
    }
    Ok(Query::Range { ecosystems, name: name.to_string(), range: range.to_string() })
}

// ---------- the advisory ----------

/// One run of an OSV range: `introduced` opens it, `fixed` or `last_affected` closes it.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Span {
    kind: String, // SEMVER, ECOSYSTEM or GIT, as the record says; a GIT run places no version
    introduced: Option<String>,
    fixed: Option<String>,
    last_affected: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Affected {
    ecosystem: String,
    name: String,
    spans: Vec<Span>,
    versions: Vec<String>,  // the record's own list of affected versions
    versions_cut: bool,     // that list was longer than VERSIONS: a version missing from it proves nothing
    range: Option<String>,  // typed by hand: a range maint.ts reads as written
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepAdvisory {
    id: Option<String>, // None: a package and range typed by hand
    aliases: Vec<String>,
    summary: String,
    severity: Severity,
    raw_severity: String,
    url: Option<String>,
    packages: Vec<Affected>,
    asked: Vec<String>, // every id sent to OSV.dev, and nothing else was
    gaps: Vec<String>,
}

const VERSIONS: usize = 2000;
const FOLLOW: usize = 2; // aliases looked up for a record that names no package

fn spans_of(range: &Value) -> Vec<Span> {
    let kind = text(range, "/type").to_string();
    let (mut out, mut open): (Vec<Span>, Option<Span>) = (vec![], None);
    for e in range.get("events").and_then(Value::as_array).into_iter().flatten() {
        let word = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_string);
        if let Some(i) = word("introduced") {
            out.extend(open.take());
            open = Some(Span { kind: kind.clone(), introduced: Some(i), ..Span::default() });
        } else if let Some(f) = word("fixed") {
            out.push(Span { fixed: Some(f), ..open.take().unwrap_or(Span { kind: kind.clone(), ..Span::default() }) });
        } else if let Some(l) = word("last_affected") {
            out.push(Span { last_affected: Some(l), ..open.take().unwrap_or(Span { kind: kind.clone(), ..Span::default() }) });
        }
    }
    out.extend(open); // introduced and never closed: every later version
    out
}

/// Every package the record names with its ranges; a CVE converted from NVD often names none.
pub(crate) fn affected_of(rec: &Value) -> Vec<Affected> {
    rec.get("affected").and_then(Value::as_array).into_iter().flatten().filter_map(|a| {
        let (name, eco) = (text(a, "/package/name"), text(a, "/package/ecosystem"));
        if name.is_empty() || eco.is_empty() {
            return None;
        }
        let mut versions = strs(a.get("versions"));
        let versions_cut = versions.len() > VERSIONS;
        versions.truncate(VERSIONS);
        let spans = a.get("ranges").and_then(Value::as_array).into_iter().flatten().flat_map(spans_of).collect();
        Some(Affected { ecosystem: eco.to_string(), name: name.to_string(), spans, versions, versions_cut, range: None })
    }).collect()
}

fn lookup(ex: &dyn Exec, id: &str) -> Result<Value, String> {
    let v = osv_call(ex, format!("{OSV_API}/vulns/{id}"), None)
        .map_err(|e| if e.contains("HTTP 404") { format!("OSV.dev has no record of {id}") } else { e })?;
    if text(&v, "/id").is_empty() {
        return Err(format!("OSV.dev has no record of {id}"));
    }
    Ok(v)
}

/// An id is looked up on OSV.dev, and a record naming no package follows its aliases, GitHub's
/// first; a hand-typed range sends nothing.
pub(crate) fn resolve(q: &str, ex: &dyn Exec) -> Result<SweepAdvisory, String> {
    let id = match parse_query(q)? {
        Query::Range { ecosystems, name, range } => {
            let packages = ecosystems.iter()
                .map(|e| Affected {
                    ecosystem: e.to_string(), name: name.clone(), spans: vec![], versions: vec![], versions_cut: false, range: Some(range.clone()),
                })
                .collect();
            return Ok(SweepAdvisory {
                id: None, aliases: vec![], summary: format!("{name} {range}"), severity: Severity::Unknown, raw_severity: String::new(),
                url: None, packages, asked: vec![], gaps: vec![],
            });
        }
        Query::Id(id) => id,
    };
    let rec = lookup(ex, &id)?;
    let (mut severity, mut raw_severity) = record_severity(&rec);
    let mut summary = summary_of([text(&rec, "/summary"), text(&rec, "/details")].into_iter().find(|s| !s.trim().is_empty()).unwrap_or(""));
    let mut aliases: Vec<String> = strs(rec.get("aliases")).into_iter().filter(|a| *a != id).collect();
    let (mut packages, mut asked, mut gaps) = (affected_of(&rec), vec![id.clone()], vec![]);
    if packages.is_empty() {
        let mut follow: Vec<String> = aliases.iter().filter(|a| osv_id(a)).cloned().collect();
        follow.sort_by_key(|a| !a.starts_with("GHSA-"));
        for a in follow.into_iter().take(FOLLOW) {
            asked.push(a.clone());
            match lookup(ex, &a) {
                Ok(r) => {
                    packages = affected_of(&r);
                    if severity == Severity::Unknown || !text(&r, "/database_specific/severity").is_empty() {
                        (severity, raw_severity) = record_severity(&r);
                    }
                    if summary.is_empty() || !text(&r, "/summary").is_empty() {
                        summary = summary_of(text(&r, "/summary"));
                    }
                    for x in strs(r.get("aliases")) {
                        if x != id && !aliases.contains(&x) {
                            aliases.push(x);
                        }
                    }
                    if !packages.is_empty() {
                        break;
                    }
                }
                Err(e) => gaps.push(e),
            }
        }
        if packages.is_empty() {
            gaps.push(format!("{id} names no package and version range to match"));
        }
    }
    Ok(SweepAdvisory {
        url: Some(format!("https://osv.dev/vulnerability/{id}")), id: Some(id), aliases, summary, severity, raw_severity,
        packages, asked, gaps,
    })
}

// ---------- the lockfiles ----------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepAsk {
    ecosystem: String,
    name: String,
}

/// One installed copy of an asked package: `pkg` indexes the asks, `version` is where an unpinned one came from.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepCopy {
    pkg: usize,
    version: String,
    file: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepUnread {
    file: String,
    ecosystem: String,
    reason: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepFacts {
    root: String,
    locks: Vec<String>, // the lockfiles read
    found: Vec<SweepCopy>,
    unpinned: Vec<SweepCopy>, // from git, a tarball or a path: no version to place
    unread: Vec<SweepUnread>, // what might hold a copy and was not read
}

const ASKS: usize = 50;
const ROOTS: usize = 500;
const FILES: usize = 200; // lockfiles and manifests per project; past it, what was left is said

/// Every file that says what a project installs: its name, the ecosystem it answers for, and
/// whether it is a lockfile. Only `LOCKFILES` are read; any other is said, never passed over.
const NAMED: &[(&str, &str, bool)] = &[
    ("Cargo.lock", "crates.io", true), ("Cargo.toml", "crates.io", false),
    ("package-lock.json", "npm", true), ("pnpm-lock.yaml", "npm", true), ("yarn.lock", "npm", true),
    ("bun.lock", "npm", true), ("bun.lockb", "npm", true), ("package.json", "npm", false),
    ("poetry.lock", "PyPI", true), ("uv.lock", "PyPI", true), ("Pipfile.lock", "PyPI", true), ("requirements.txt", "PyPI", true),
    ("pyproject.toml", "PyPI", false), ("setup.py", "PyPI", false), ("setup.cfg", "PyPI", false), ("Pipfile", "PyPI", false),
    ("go.sum", "Go", true), ("go.mod", "Go", false),
    ("Gemfile.lock", "RubyGems", true), ("Gemfile", "RubyGems", false),
    ("composer.lock", "Packagist", true), ("composer.json", "Packagist", false),
    ("gradle.lockfile", "Maven", true), ("pom.xml", "Maven", false), ("build.gradle", "Maven", false), ("build.gradle.kts", "Maven", false),
    ("packages.lock.json", "NuGet", true), ("packages.config", "NuGet", false), ("Directory.Packages.props", "NuGet", false),
];
const SUFFIXES: &[(&str, &str)] = &[(".csproj", "NuGet"), (".fsproj", "NuGet"), (".vbproj", "NuGet"), (".gemspec", "RubyGems")];

/// What a file at this path answers for: (ecosystem, is a lockfile).
fn kind_of(file: &str) -> Option<(&'static str, bool)> {
    let base = file.rsplit('/').next().unwrap_or(file);
    if let Some((_, e, lock)) = NAMED.iter().find(|(n, _, _)| *n == base) {
        return Some((e, *lock));
    }
    if base.starts_with("requirements") && base.ends_with(".txt") {
        return Some(("PyPI", true));
    }
    SUFFIXES.iter().find(|(x, _)| base.ends_with(x)).map(|(_, e)| (*e, false))
}

/// npm names are exact; crates.io and PyPI fold case and treat `-` and `_` alike.
fn same_name(eco: &str, a: &str, b: &str) -> bool {
    let fold = |s: &str| s.to_ascii_lowercase().replace('_', "-");
    if eco == "npm" { a == b } else { fold(a) == fold(b) }
}

fn copies(asks: &[SweepAsk], pkgs: &[Pkg], file: &str) -> Vec<SweepCopy> {
    asks.iter().enumerate().flat_map(|(i, a)| {
        pkgs.iter().filter(move |p| p.ecosystem == a.ecosystem && same_name(p.ecosystem, &p.name, &a.name))
            .map(move |p| SweepCopy { pkg: i, version: p.version.clone(), file: file.to_string() })
    }).collect()
}

fn dir_of(file: &str) -> &str {
    file.rsplit_once('/').map_or("", |(d, _)| d)
}

/// A manifest is answered by a lockfile of its ecosystem in its own folder or any above it (a workspace's).
fn covered(locks: &[(&str, &str)], eco: &str, manifest: &str) -> bool {
    let mut dir = dir_of(manifest);
    loop {
        if locks.iter().any(|(e, d)| *e == eco && *d == dir) {
            return true;
        }
        if dir.is_empty() {
            return false;
        }
        dir = dir_of(dir);
    }
}

/// Every lockfile here, read and never run, and each copy of the asked packages in them. The
/// files come from the project's index at any depth, plus an ignored one at the top.
pub(crate) fn match_project(root: &str, asks: &[SweepAsk]) -> SweepFacts {
    let (index, cut, _) = crate::files::index_of(root);
    let names: Vec<&str> = NAMED.iter().map(|(n, _, _)| *n).collect();
    let mut files: Vec<String> = index.into_iter().filter(|f| kind_of(f).is_some()).chain(found_paths(root, &names)).collect();
    files.sort();
    files.dedup();
    let mut f = SweepFacts { root: root.to_string(), locks: vec![], found: vec![], unpinned: vec![], unread: vec![] };
    let unread = |file: &str, eco: &str, reason: String| SweepUnread { file: file.to_string(), ecosystem: eco.to_string(), reason };
    if cut || files.len() > FILES {
        let why = format!("only the first {FILES} manifests and lockfiles of a long file list were looked at");
        let mut ecos: Vec<&str> = asks.iter().map(|a| a.ecosystem.as_str()).collect();
        ecos.sort_unstable();
        ecos.dedup();
        f.unread.extend(ecos.into_iter().map(|e| unread(".", e, why.clone())));
        files.truncate(FILES);
    }
    let kinds: Vec<(&str, &str, bool)> = files.iter().filter_map(|x| kind_of(x).map(|(e, l)| (x.as_str(), e, l))).collect();
    let lock_dirs: Vec<(&str, &str)> = kinds.iter().filter(|k| k.2).map(|(x, e, _)| (*e, dir_of(x))).collect();
    for &(file, eco, lock) in &kinds {
        if !lock {
            if !covered(&lock_dirs, eco, file) {
                f.unread.push(unread(file, eco, "no lockfile says what it installs".into()));
            }
            continue;
        }
        let path = Path::new(root).join(file);
        if !LOCKFILES.contains(&file.rsplit('/').next().unwrap_or(file)) {
            f.unread.push(unread(file, eco, "a lockfile Episko does not read".into()));
        } else if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOCK_BYTES) {
            f.unread.push(unread(file, eco, "too large to read".into()));
        } else {
            match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| crate::lockfile::parse(file, &t)) {
                Err(e) => f.unread.push(unread(file, eco, e)),
                // A version no parser knows read nothing, however cleanly.
                Ok(p) if p.pkgs.is_empty() && p.unpinned.is_empty() && !p.gaps.is_empty() => f.unread.push(unread(file, eco, p.gaps.join("; "))),
                Ok(p) => {
                    f.found.extend(copies(asks, &p.pkgs, file));
                    f.unpinned.extend(copies(asks, &p.unpinned, file));
                    f.unpinned.extend(copies(asks, &p.local, file));
                    f.locks.push(file.to_string());
                }
            }
        }
    }
    f
}

// ---------- the agent's answer ----------

/// A read-only agent's verdict on one project, shown beside the row and never applied.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepCheck {
    verdict: String, // affected, not-affected or unsure
    evidence: Vec<String>,
}

const VERDICTS: &[&str] = &["affected", "not-affected", "unsure"];

/// The answer's fenced `toml` block (`deploy::fenced`); a block with no known verdict is a failure.
pub(crate) fn parse_check(out: &str) -> Result<SweepCheck, String> {
    let (block, why) = crate::deploy::fenced(out).map_err(|_| "the agent answered without a verdict block".to_string())?;
    let t: toml::Table = block.parse().map_err(|e| format!("the agent's verdict is not valid TOML: {e}"))?;
    let verdict = t.get("verdict").and_then(|v| v.as_str()).map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| VERDICTS.contains(&v.as_str()))
        .ok_or("the agent named no verdict (affected, not-affected or unsure)")?;
    let listed: Vec<String> = match t.get("evidence") {
        Some(toml::Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).map(String::from).collect(),
        Some(v) => v.as_str().map(String::from).into_iter().collect(),
        None => vec![],
    };
    let evidence = listed.into_iter().chain(why).map(|s| s.trim().chars().take(300).collect::<String>())
        .filter(|s| !s.is_empty()).take(8).collect();
    Ok(SweepCheck { verdict, evidence })
}

// ---------- commands ----------

/// An explicit click, so OSV.dev may be asked without the per-machine opt-in: only the id is sent.
#[tauri::command]
pub(crate) async fn sweep_advisory(query: String) -> Result<SweepAdvisory, String> {
    tauri::async_runtime::spawn_blocking(move || resolve(&query, &SysExec { cost: Cost::Public }))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn sweep_match(roots: Vec<String>, packages: Vec<SweepAsk>) -> Result<Vec<SweepFacts>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let asks = &packages[..packages.len().min(ASKS)];
        roots.iter().take(ROOTS).map(|r| match_project(r, asks)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// `deploy::propose_toml`'s agent in one project: Read, Glob and Grep, nothing else.
#[tauri::command]
pub(crate) async fn sweep_check(dir: String, prompt: String) -> Result<SweepCheck, String> {
    tauri::async_runtime::spawn_blocking(move || parse_check(&crate::deploy::propose_toml(&dir, &prompt)?))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maint::exec::FakeExec;
    use crate::testutil::scratch_dir;

    fn id(q: &str) -> String {
        match parse_query(q) {
            Ok(Query::Id(i)) => i,
            other => panic!("{q}: {other:?}"),
        }
    }

    fn range(q: &str) -> (Vec<&'static str>, String, String) {
        match parse_query(q) {
            Ok(Query::Range { ecosystems, name, range }) => (ecosystems, name, range),
            other => panic!("{q}: {other:?}"),
        }
    }

    #[test]
    fn a_query_is_an_id_or_a_package_and_its_range() {
        assert_eq!(id("cve-2021-23337"), "CVE-2021-23337");
        assert_eq!(id(" GHSA-35JH-R3H4-6JHM "), "GHSA-35jh-r3h4-6jhm", "GitHub's tail is lower-case");
        assert_eq!(id("RUSTSEC-2021-0003"), "RUSTSEC-2021-0003");
        assert_eq!(id("https://github.com/advisories/GHSA-35jh-r3h4-6jhm"), "GHSA-35jh-r3h4-6jhm");
        assert_eq!(id("https://rustsec.org/advisories/RUSTSEC-2021-0003.html"), "RUSTSEC-2021-0003");
        assert_eq!(range("lodash@<4.17.21"), (vec!["npm", "crates.io"], "lodash".into(), "<4.17.21".into()), "no ecosystem: every one a lockfile is read for");
        assert_eq!(range("@scope/pkg@^1.2"), (vec!["npm", "crates.io"], "@scope/pkg".into(), "^1.2".into()));
        assert_eq!(range("npm:next >=15.0.0 <15.5.6"), (vec!["npm"], "next".into(), ">=15.0.0 <15.5.6".into()));
        assert_eq!(range("cargo:smallvec@<1.6.1"), (vec!["crates.io"], "smallvec".into(), "<1.6.1".into()));
        assert_eq!(range("next@>=15.0.0 <15.5.6 || <14.2.33").2, ">=15.0.0 <15.5.6 || <14.2.33");
        assert_eq!(range("left-pad@*").2, "*", "every version: who uses it");
    }

    #[test]
    fn junk_is_refused_and_says_what_would_do() {
        for q in ["", "hello world", "npm:", "bogus:x <1", "x@", "x@<1; rm -rf /", "x@<1 $(id)", "https://example.com/blog/post", "a b@c"] {
            assert!(parse_query(q).is_err(), "{q:?}");
        }
        assert!(parse_query("lodash").unwrap_err().contains("lodash@<1.2.3"), "a bare name asks for its range");
        assert!(parse_query("left-pad").is_err(), "a name that looks like an id is not looked up");
        assert!(parse_query(&"x".repeat(500)).is_err());
    }

    #[test]
    fn a_records_packages_and_ranges_are_read_as_written() {
        let rec: Value = serde_json::from_str(&FakeExec::testdata("sweep-GHSA-35jh-r3h4-6jhm.json")).unwrap();
        let a = affected_of(&rec);
        let names: Vec<_> = a.iter().map(|x| (x.ecosystem.as_str(), x.name.as_str())).collect();
        assert_eq!(names[..2], [("npm", "lodash"), ("npm", "lodash-es")]);
        assert_eq!(a[0].spans, [Span { kind: "SEMVER".into(), introduced: Some("0".into()), fixed: Some("4.17.21".into()), last_affected: None }]);
        assert_eq!(a[2].spans[0].last_affected.as_deref(), Some("4.5.0"), "a closed range with no fix");
        assert_eq!(a.last().unwrap().ecosystem, "RubyGems");
        let rust: Value = serde_json::from_str(&FakeExec::testdata("osv-RUSTSEC-2021-0003.json")).unwrap();
        let smallvec = affected_of(&rust);
        let s: Vec<_> = smallvec[0].spans.iter().map(|s| (s.introduced.as_deref(), s.fixed.as_deref())).collect();
        assert_eq!(s, [(Some("0.6.3"), Some("0.6.14")), (Some("1.0.0"), Some("1.6.1"))], "two runs in one range");
        let open = serde_json::json!({ "type": "ECOSYSTEM", "events": [{ "introduced": "2.0.0" }] });
        assert_eq!(spans_of(&open), [Span { kind: "ECOSYSTEM".into(), introduced: Some("2.0.0".into()), ..Span::default() }], "never closed: every later version");
        let cve: Value = serde_json::from_str(&FakeExec::testdata("sweep-CVE-2021-23337.json")).unwrap();
        assert!(affected_of(&cve).is_empty(), "a commit range with no package names nothing to match");
    }

    fn osv_records() -> FakeExec {
        FakeExec::answering(Ok(r#"{"code":5,"message":"Vulnerability not found"}"#))
            .on(&["curl", "https://api.osv.dev/v1/vulns/CVE-2021-23337"], Ok(&FakeExec::testdata("sweep-CVE-2021-23337.json")))
            .on(&["curl", "https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm"], Ok(&FakeExec::testdata("sweep-GHSA-35jh-r3h4-6jhm.json")))
    }

    #[test]
    fn an_id_sends_only_ids_and_a_cve_follows_its_github_alias() {
        let ex = osv_records();
        let a = resolve("CVE-2021-23337", &ex).unwrap();
        assert_eq!(a.asked, ["CVE-2021-23337", "GHSA-35jh-r3h4-6jhm"]);
        assert_eq!(ex.calls().iter().map(|c| c.len()).collect::<Vec<_>>(), [2, 2], "two GETs, no body");
        assert_eq!((a.id.as_deref(), a.severity, a.raw_severity.as_str()), (Some("CVE-2021-23337"), Severity::High, "HIGH"));
        assert_eq!(a.packages[0].name, "lodash");
        assert_eq!(a.summary, "Command Injection in lodash");
        assert!(a.gaps.is_empty());

        let typed = FakeExec::answering(Err("nothing may be asked"));
        let r = resolve("npm:lodash <4.17.21", &typed).unwrap();
        assert!(typed.calls().is_empty(), "a package and range sends nothing");
        assert_eq!((r.id, r.packages[0].range.as_deref(), r.asked.len()), (None, Some("<4.17.21"), 0));

        let missing = resolve("GHSA-0000-0000-0000", &osv_records()).unwrap_err();
        assert_eq!(missing, "OSV.dev has no record of GHSA-0000-0000-0000");
        assert!(resolve("hello world", &osv_records()).is_err());
    }

    fn project(files: &[(&str, &str)]) -> String {
        let root = scratch_dir();
        for (p, body) in files {
            let path = root.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        root.to_string_lossy().to_string()
    }

    fn ask(eco: &str, name: &str) -> SweepAsk {
        SweepAsk { ecosystem: eco.into(), name: name.into() }
    }

    #[test]
    fn lockfiles_are_matched_across_npm_pnpm_and_cargo() {
        let asks = [ask("npm", "lodash"), ask("crates.io", "smallvec"), ask("npm", "minimist")];
        let root = project(&[
            ("package-lock.json", &FakeExec::testdata("lock-npm-v3.json")),
            ("web/pnpm-lock.yaml", &FakeExec::testdata("lock-pnpm-v9.yaml")),
            ("Cargo.lock", &FakeExec::testdata("lock-cargo.lock")),
        ]);
        let f = match_project(&root, &asks);
        let got: Vec<_> = f.found.iter().map(|c| (c.pkg, c.version.as_str(), c.file.as_str())).collect();
        assert_eq!(got.len(), 5, "{got:?}");
        for want in [(0, "4.17.20", "package-lock.json"), (0, "4.17.20", "web/pnpm-lock.yaml"), (1, "1.6.0", "Cargo.lock"), (2, "1.2.5", "package-lock.json")] {
            assert!(got.contains(&want), "{want:?} in {got:?}");
        }
        assert_eq!(got.iter().filter(|g| g.2 == "Cargo.lock").count(), 1, "an npm ask never matches a crate");
        assert_eq!(f.locks.len(), 3);
        assert!(f.unread.is_empty());
    }

    #[test]
    fn a_project_without_it_with_an_unreadable_lockfile_or_a_git_copy_says_so() {
        let asks = [ask("npm", "lodash")];
        let none = match_project(&project(&[("package-lock.json", r#"{"lockfileVersion": 3, "packages": {"node_modules/a": {"version": "1.0.0"}}}"#)]), &asks);
        assert_eq!((none.found.len(), none.locks.len(), none.unread.len()), (0, 1, 0), "read, and no copy");

        let broken = match_project(&project(&[("package-lock.json", "<html>"), ("yarn.lock", "")]), &asks);
        let why: Vec<_> = broken.unread.iter().map(|u| (u.file.as_str(), u.ecosystem.as_str())).collect();
        assert_eq!(why, [("package-lock.json", "npm"), ("yarn.lock", "npm")]);
        assert!(broken.locks.is_empty());
        let old = match_project(&project(&[("package-lock.json", r#"{"lockfileVersion": 1}"#)]), &asks);
        assert!(old.unread[0].reason.contains("lockfileVersion 1"), "a version no parser knows is unread, not empty");

        let git = r#"{"lockfileVersion": 3, "packages": {"node_modules/lodash": {"version": "4.17.20", "resolved": "git+ssh://git@example.com/me/lodash.git#abc"}}}"#;
        let g = match_project(&project(&[("package-lock.json", git)]), &asks);
        assert_eq!((g.found.len(), g.unpinned[0].version.as_str()), (0, "git+ssh://git@example.com/me/lodash.git#abc"));

        let bare = match_project(&project(&[("package.json", "{}"), ("Cargo.toml", "")]), &asks);
        assert_eq!(bare.unread.iter().map(|u| u.file.as_str()).collect::<Vec<_>>(), ["Cargo.toml", "package.json"], "a manifest with no lockfile may install anything");
        let ws = match_project(&project(&[("pnpm-lock.yaml", "lockfileVersion: '9.0'
"), ("package.json", "{}"), ("packages/a/package.json", "{}")]), &asks);
        assert!(ws.unread.is_empty(), "a workspace's lockfile answers for every manifest below it: {:?}", ws.unread);
        let empty = match_project(&project(&[]), &asks);
        assert!(empty.locks.is_empty() && empty.found.is_empty() && empty.unread.is_empty(), "no lockfile and no manifest: nothing installed");
    }

    #[test]
    fn what_cannot_be_read_is_named_whatever_its_ecosystem_or_depth() {
        let unread = |f: &SweepFacts| f.unread.iter().map(|u| (u.file.clone(), u.ecosystem.clone())).collect::<Vec<_>>();
        let pip = match_project(&project(&[("pyproject.toml", "")]), &[ask("PyPI", "jinja2")]);
        assert_eq!(unread(&pip), [("pyproject.toml".into(), "PyPI".into())], "a manifest Episko does not read is never 'not using'");
        let java = match_project(&project(&[("svc/pom.xml", ""), ("app/App.csproj", "")]), &[ask("Maven", "org.apache.logging.log4j:log4j-core")]);
        assert_eq!(unread(&java), [("app/App.csproj".into(), "NuGet".into()), ("svc/pom.xml".into(), "Maven".into())]);

        let deep = match_project(&project(&[("apps/web/package-lock.json", &FakeExec::testdata("lock-npm-v3.json"))]), &[ask("npm", "lodash")]);
        assert_eq!((deep.locks.as_slice(), deep.found.len()), (["apps/web/package-lock.json".to_string()].as_slice(), 1), "two levels down is read too");

        let vendored = "version = 3
[[package]]
name = \"smallvec\"
version = \"1.6.0\"
";
        let v = match_project(&project(&[("Cargo.lock", vendored)]), &[ask("crates.io", "smallvec")]);
        assert_eq!((v.found.len(), v.unpinned[0].version.as_str()), (0, "a local path at 1.6.0"), "a path copy is reported, not dropped");
    }

    #[test]
    fn a_cut_version_list_says_so() {
        let many: Vec<String> = (0..=VERSIONS).map(|i| format!("1.0.{i}")).collect();
        let rec = serde_json::json!({ "affected": [{ "package": { "ecosystem": "npm", "name": "x" }, "versions": many }] });
        let a = affected_of(&rec);
        assert_eq!((a[0].versions.len(), a[0].versions_cut), (VERSIONS, true));
    }

    /// maint.ts narrows exactly this, so a serde change that keeps the field names still fails here.
    #[test]
    fn the_sweep_wire_matches_its_fixture() {
        let adv = resolve("CVE-2021-23337", &osv_records()).unwrap();
        let typed = resolve("npm:lodash <4.17.21", &FakeExec::answering(Err("nothing may be asked"))).unwrap();
        let git = r#"{"lockfileVersion": 3, "packages": {"node_modules/lodash": {"version": "4.17.20"},
          "node_modules/a/node_modules/lodash": {"version": "4.17.20", "resolved": "git+ssh://git@example.com/me/lodash.git#abc"}}}"#;
        let mut facts = match_project(&project(&[("package-lock.json", git), ("yarn.lock", "")]), &[ask("npm", "lodash")]);
        facts.root = "/projects/web".into();
        let check = parse_check("```toml
verdict = \"unsure\"
evidence = [\"package.json: lodash is vendored\"]
```").unwrap();
        let got = serde_json::json!({ "advisory": adv, "typed": typed, "facts": [facts], "check": check });
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/sweep-wire.json");
        if std::env::var_os("MAINT_WIRE_WRITE").is_some() {
            std::fs::write(&path, serde_json::to_string_pretty(&got).unwrap() + "
").unwrap();
            return;
        }
        let text = std::fs::read_to_string(&path).expect("test/fixtures/sweep-wire.json: regenerate with MAINT_WIRE_WRITE=1 cargo test");
        let want: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(got, want, "the sweep wire changed: MAINT_WIRE_WRITE=1 cargo test, then teach src/maint.ts");
    }

    #[test]
    fn the_agents_verdict_is_its_fenced_block() {
        let out = "I read it.\n```toml\nverdict = \"Not-Affected\"\nevidence = [\"package.json: next is github:me/next#fix\", \"\"]\n```\nWHY\n- the fork carries the patch\n";
        assert_eq!(parse_check(out).unwrap(), SweepCheck {
            verdict: "not-affected".into(),
            evidence: vec!["package.json: next is github:me/next#fix".into(), "the fork carries the patch".into()],
        });
        assert_eq!(parse_check("```toml\nverdict = \"unsure\"\nevidence = \"one line\"\n```").unwrap().evidence, ["one line"]);
        assert!(parse_check("affected, probably").unwrap_err().contains("without a verdict block"));
        assert!(parse_check("```toml\nverdict = \"maybe\"\n```").unwrap_err().contains("no verdict"));
        assert!(parse_check("```toml\nverdict = \n```").unwrap_err().contains("not valid TOML"));
        let long = format!("```toml\nverdict = \"affected\"\nevidence = [{}]\n```", vec!["\"x\""; 20].join(","));
        assert_eq!(parse_check(&long).unwrap().evidence.len(), 8, "capped");
    }
}
