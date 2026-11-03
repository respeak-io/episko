//! What a lockfile says is installed, for `osv` and the advisory sweep (docs/maintenance.md): read,
//! never resolved. A format version these parsers do not know is a gap, never an empty lockfile.

use serde_json::Value;

/// One installed package, in OSV's ecosystem names.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Pkg {
    pub(crate) ecosystem: &'static str,
    pub(crate) name: String,
    pub(crate) version: String,
}

/// A dependency a project, workspace folder or member crate declares itself, as the lockfile resolved it.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Direct {
    pub(crate) ecosystem: &'static str,
    pub(crate) importer: String, // "." or a workspace folder; a member crate's own name
    pub(crate) name: String,     // the package's own name, an npm alias resolved
    pub(crate) version: Option<String>, // the default registry's copy; None: from elsewhere, or not resolved
    pub(crate) from: Option<String>,    // where a copy came from when that is not the default registry
    pub(crate) dev: Option<bool>,       // declared for development only; None: the lockfile does not say
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Parsed {
    pub(crate) pkgs: Vec<Pkg>,
    pub(crate) gaps: Vec<String>,
    /// From git, a tarball, a path or another registry: `version` is where it came from, never a version.
    pub(crate) unpinned: Vec<Pkg>,
    /// A path or a link: the project's own package, or a vendored or patched copy of someone else's.
    pub(crate) local: Vec<Pkg>,
    /// What each importer declares itself; a link or path to the project's own package is left out.
    pub(crate) direct: Vec<Direct>,
}

/// The lockfiles a parser exists for, as detection's entries.
pub(crate) const LOCKFILES: &[&str] = &["Cargo.lock", "package-lock.json", "pnpm-lock.yaml"];

/// `file` is the path as found; its name picks the parser.
pub(crate) fn parse(file: &str, text: &str) -> Result<Parsed, String> {
    let mut p = match file.rsplit('/').next().unwrap_or(file) {
        "Cargo.lock" => cargo_lock(text, file),
        "package-lock.json" => package_lock(text, file),
        "pnpm-lock.yaml" => pnpm_lock(text, file),
        _ => Err(format!("{file} is not a lockfile Episko reads")),
    }?;
    p.pkgs.sort();
    p.pkgs.dedup();
    for v in [&mut p.unpinned, &mut p.local] {
        v.sort();
        v.dedup();
    }
    p.direct.sort();
    p.direct.dedup();
    Ok(p)
}

fn pkg(ecosystem: &'static str, name: &str, version: &str) -> Pkg {
    Pkg { ecosystem, name: name.to_string(), version: version.to_string() }
}

/// crates.io packages only: a workspace member has no source, and OSV knows neither a git
/// checkout nor another registry under these names.
fn cargo_lock(text: &str, file: &str) -> Result<Parsed, String> {
    let doc: toml::Table = text.parse().map_err(|_| format!("{file} is not TOML"))?;
    let v = doc.get("version").and_then(|v| v.as_integer()).unwrap_or(1);
    if v > 4 {
        return Ok(Parsed { gaps: vec![format!("{file}: lockfile version {v} not read")], ..Parsed::default() });
    }
    let (mut out, mut other) = (Parsed::default(), 0);
    for p in doc.get("package").and_then(|v| v.as_array()).into_iter().flatten() {
        let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("");
        let src = s("source");
        if on_crates_io(src) {
            out.pkgs.push(pkg("crates.io", s("name"), s("version")));
        } else if !src.is_empty() {
            other += 1;
            out.unpinned.push(pkg("crates.io", s("name"), src));
        } else if !s("name").is_empty() {
            out.local.push(pkg("crates.io", s("name"), &format!("a local path at {}", s("version"))));
        }
    }
    if other > 0 {
        out.gaps.push(format!("{file}: {other} from git or another registry not checked"));
    }
    out.pkgs.retain(|p| !p.name.is_empty() && !p.version.is_empty());
    out.direct = cargo_direct(doc.get("package").and_then(|v| v.as_array()).map_or(&[][..], |a| a.as_slice()));
    Ok(out)
}

/// crates.io's own index in the two spellings Cargo writes; a URL that only looks like it is another registry.
fn on_crates_io(src: &str) -> bool {
    src == "registry+https://github.com/rust-lang/crates.io-index" || src.trim_end_matches('/') == "sparse+https://index.crates.io"
}

/// A sourceless package's `dependencies`, each `name`, `name version` or `name version (source)`,
/// resolved to its entry; a path dependency or another member is the project's own.
fn cargo_direct(all: &[toml::Value]) -> Vec<Direct> {
    let s = |p: &toml::Value, k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut out = vec![];
    for m in all.iter().filter(|p| s(p, "source").is_empty() && !s(p, "name").is_empty()) {
        for dep in m.get("dependencies").and_then(|v| v.as_array()).into_iter().flatten().filter_map(|v| v.as_str()) {
            let mut w = dep.splitn(3, ' ');
            let (name, ver, src) = (w.next().unwrap_or(""), w.next(), w.next().map(|x| x.trim_matches(['(', ')'])));
            let hit = all.iter().find(|p| s(p, "name") == name
                && ver.is_none_or(|v| s(p, "version") == v) && src.is_none_or(|x| s(p, "source") == x));
            let (version, from) = match hit.map(|p| (s(p, "version"), s(p, "source"))) {
                Some((_, src)) if src.is_empty() => continue,
                Some((v, src)) if on_crates_io(&src) => (Some(v), None),
                Some((_, src)) => (None, Some(src)),
                None => (None, None),
            };
            out.push(Direct { ecosystem: "crates.io", importer: s(m, "name"), name: name.to_string(), version, from, dev: None });
        }
    }
    out
}

/// What OSV cannot be asked about is said, so a lockfile of them never reads as clean.
fn unchecked(out: &mut Parsed, file: &str, n: usize) {
    if n > 0 {
        out.gaps.push(format!("{file}: {n} from git, a tarball or a path not checked"));
    }
}

/// v2 and v3 list every installed copy under `packages`, keyed by its `node_modules` path; v1
/// nests them under `dependencies` instead, and is a gap.
fn package_lock(text: &str, file: &str) -> Result<Parsed, String> {
    let doc: Value = serde_json::from_str(text).map_err(|_| format!("{file} is not JSON"))?;
    let v = doc.get("lockfileVersion").and_then(Value::as_u64).unwrap_or(0);
    if !(2..=3).contains(&v) {
        return Ok(Parsed { gaps: vec![format!("{file}: lockfileVersion {v} not read")], ..Parsed::default() });
    }
    let (mut out, mut other) = (Parsed::default(), 0);
    for (path, e) in doc.get("packages").and_then(Value::as_object).into_iter().flatten() {
        // The root, a workspace's own folder and a link to one are the project, not a dependency.
        let Some((_, tail)) = path.rsplit_once("node_modules/") else { continue };
        let name = e.get("name").and_then(Value::as_str).unwrap_or(tail);
        if e.get("link").and_then(Value::as_bool) == Some(true) {
            out.local.push(pkg("npm", name, &format!("link:{}", e.get("resolved").and_then(Value::as_str).unwrap_or(""))));
            continue;
        }
        let version = e.get("version").and_then(Value::as_str).unwrap_or("");
        // npm 7+ keeps a git copy's own version and says where it came from in `resolved`.
        let resolved = e.get("resolved").and_then(Value::as_str).unwrap_or("");
        let from = if version.contains(':') { version } else if resolved.starts_with("git") || resolved.starts_with("file:") { resolved } else { "" };
        if !from.is_empty() {
            other += 1;
            out.unpinned.push(pkg("npm", name, from));
        } else if !version.is_empty() {
            out.pkgs.push(pkg("npm", name, version));
        }
    }
    unchecked(&mut out, file, other);
    if let Some(all) = doc.get("packages").and_then(Value::as_object) {
        out.direct = package_direct(all);
    }
    Ok(out)
}

/// A `resolved` that is npm's public registry, the only one a registry read may ask about.
fn on_npm(resolved: &str) -> bool {
    let rest = resolved.strip_prefix("https://").or_else(|| resolved.strip_prefix("http://"));
    rest.is_some_and(|r| r.split('/').next().is_some_and(|h| h.eq_ignore_ascii_case("registry.npmjs.org")))
}

/// The root's and each workspace folder's dependency maps, each name resolved as Node would: the
/// folder's own `node_modules` first, then the hoisted copy. A link is a workspace package.
fn package_direct(all: &serde_json::Map<String, Value>) -> Vec<Direct> {
    let mut out = vec![];
    for (path, e) in all.iter().filter(|(p, _)| !p.contains("node_modules/")) {
        let importer = if path.is_empty() { "." } else { path.as_str() };
        let mut seen = std::collections::BTreeSet::new();
        // A package in both dependencies and devDependencies ships.
        for (key, dev) in [("dependencies", false), ("optionalDependencies", false), ("devDependencies", true)] {
            for name in e.get(key).and_then(Value::as_object).into_iter().flat_map(|m| m.keys()) {
                if !seen.insert(name.clone()) {
                    continue;
                }
                let nested = (!path.is_empty()).then(|| all.get(&format!("{path}/node_modules/{name}"))).flatten();
                let Some(c) = nested.or_else(|| all.get(&format!("node_modules/{name}"))) else {
                    out.push(Direct { ecosystem: "npm", importer: importer.into(), name: name.clone(), version: None, from: None, dev: Some(dev) });
                    continue;
                };
                if c.get("link").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("");
                let (version, resolved) = (s("version"), s("resolved"));
                // Git, a path, a tarball or another registry's host: only npm's own copy is asked about.
                let from = if version.contains(':') { Some(version) }
                    else if !resolved.is_empty() && !on_npm(resolved) { Some(resolved) }
                    else { None };
                let version = (from.is_none() && !version.is_empty()).then(|| version.to_string());
                let real = c.get("name").and_then(Value::as_str).unwrap_or(name);
                out.push(Direct { ecosystem: "npm", importer: importer.into(), name: real.into(), version, from: from.map(str::to_string), dev: Some(dev) });
            }
        }
    }
    out
}

/// pnpm 8's `6.x` and pnpm 9's `9.0`, line by line: a `packages:` key is `name@version`, after a
/// `/` in 6.x and before any `(peer@x)` suffix. Any other version is a gap.
fn pnpm_lock(text: &str, file: &str) -> Result<Parsed, String> {
    let ver = text.lines().find_map(|l| l.strip_prefix("lockfileVersion:"))
        .map(|v| v.trim().trim_matches(['\'', '"']).to_string())
        .ok_or_else(|| format!("{file} names no lockfileVersion"))?;
    if !matches!(ver.split('.').next(), Some("6" | "9")) {
        return Ok(Parsed { gaps: vec![format!("{file}: lockfileVersion {ver} not read")], ..Parsed::default() });
    }
    let (mut out, mut other) = (Parsed::default(), 0);
    let mut inside = false;
    // 6.x keys a git, path or tarball copy by where it came from; its name is a line inside.
    let mut bare: Option<String> = None;
    for line in text.lines() {
        if !line.starts_with(' ') && !line.trim().is_empty() {
            inside = line.trim_end() == "packages:";
            other += usize::from(bare.take().is_some());
            continue;
        }
        if let (Some(from), Some(n)) = (&bare, line.strip_prefix("    name:")) {
            out.unpinned.push(pkg("npm", n.trim().trim_matches(['\'', '"']), from));
            (other, bare) = (other + 1, None);
            continue;
        }
        let Some(key) = line.strip_prefix("  ").filter(|k| !k.starts_with(' ')).and_then(|k| k.trim_end().strip_suffix(':')) else { continue };
        if !inside {
            continue;
        }
        other += usize::from(bare.take().is_some());
        let key = key.trim_matches(['\'', '"']);
        let key = key.strip_prefix('/').unwrap_or(key);
        let key = key.split('(').next().unwrap_or(key);
        let Some((name, version)) = pnpm_key(key) else {
            bare = Some(key.to_string());
            continue;
        };
        if version.starts_with(|c: char| c.is_ascii_digit()) {
            out.pkgs.push(pkg("npm", name, version));
        } else if version.starts_with("link:") {
            out.local.push(pkg("npm", name, version)); // usually the project's own folder
        } else {
            other += 1;
            out.unpinned.push(pkg("npm", name, version));
        }
    }
    other += usize::from(bare.is_some());
    unchecked(&mut out, file, other);
    out.direct = pnpm_direct(text);
    Ok(out)
}

/// `dependencies` and `optionalDependencies` ship; `devDependencies` do not; any other key is no list.
fn dep_section(key: &str) -> Option<bool> {
    match key {
        "dependencies" | "optionalDependencies" => Some(false),
        "devDependencies" => Some(true),
        _ => None,
    }
}

/// An importer's `version:`: `1.2.3(peer@x)`, an alias's `real@1.2.3` (`/real@1.2.3` in 6.x), a
/// `link:` (the project's own, so None), or where a copy came from.
fn pnpm_version(name: &str, v: &str) -> Option<(String, Option<String>, Option<String>)> {
    let v = v.trim().trim_matches(['\'', '"']);
    let v = v.split('(').next().unwrap_or(v);
    let v = v.strip_prefix('/').unwrap_or(v);
    let (name, v) = pnpm_key(v).unwrap_or((name, v));
    if v.starts_with("link:") {
        return None;
    }
    let at = v.starts_with(|c: char| c.is_ascii_digit());
    Some((name.to_string(), at.then(|| v.to_string()), (!at).then(|| v.to_string())))
}

/// `packages:` entries whose `resolution` names a tarball or registry off npm, as `name@version`: an
/// importer's bare version cannot tell such a copy from npm's.
fn pnpm_elsewhere(text: &str) -> std::collections::BTreeMap<String, String> {
    let (mut out, mut inside, mut key) = (std::collections::BTreeMap::new(), false, None::<String>);
    for line in text.lines() {
        if !line.starts_with(' ') && !line.trim().is_empty() {
            inside = line.trim_end() == "packages:";
        } else if !inside {
            continue;
        } else if let Some(k) = line.strip_prefix("  ").filter(|k| !k.starts_with(' ')).and_then(|k| k.trim_end().strip_suffix(':')) {
            let k = k.trim_matches(['\'', '"']);
            let k = k.strip_prefix('/').unwrap_or(k);
            key = Some(k.split('(').next().unwrap_or(k).to_string());
        } else if let (Some(k), Some(r)) = (&key, line.trim().strip_prefix("resolution:")) {
            let urls = ["tarball:", "registry:"].into_iter().filter_map(|f| r.split(f).nth(1));
            let url = urls.map(|u| u.split([',', '}']).next().unwrap_or("").trim().trim_matches(['\'', '"'])).find(|u| !on_npm(u));
            if let Some(url) = url {
                out.insert(k.clone(), url.to_string());
            }
        }
    }
    out
}

/// 9.x and a 6.x workspace list each importer (indent 2), its sections (4), names (6) and their
/// `version:` (8); a 6.x single project has the sections at the top, a level shallower.
fn pnpm_direct(text: &str) -> Vec<Direct> {
    let elsewhere = pnpm_elsewhere(text);
    let (mut out, mut importers, mut importer, mut dev, mut name) = (vec![], false, String::from("."), None, None::<String>);
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start_matches(' ').len();
        let key = t.strip_suffix(':').map(|k| k.trim_matches(['\'', '"']));
        // A section's names sit two deeper than it, and their fields two deeper again.
        let base = if importers { 4 } else { 0 };
        match (indent, key) {
            (0, k) => {
                importers = k == Some("importers");
                (importer, dev, name) = (".".into(), k.and_then(dep_section), None);
            }
            (2, Some(k)) if importers => (importer, dev, name) = (k.to_string(), None, None),
            (4, Some(k)) if importers => (dev, name) = (dep_section(k), None),
            (i, Some(k)) if i == base + 2 && dev.is_some() => name = Some(k.to_string()),
            (i, None) if i == base + 4 => {
                let (Some(n), Some(v)) = (&name, t.strip_prefix("version:")) else { continue };
                if let Some((real, version, from)) = pnpm_version(n, v) {
                    let far = version.as_ref().and_then(|v| elsewhere.get(&format!("{real}@{v}"))).cloned();
                    let (version, from) = if far.is_some() { (None, far) } else { (version, from) };
                    out.push(Direct { ecosystem: "npm", importer: importer.clone(), name: real, version, from, dev });
                }
            }
            _ => {}
        }
    }
    out
}

/// Split at the first `@` after a scope's leading one, since a git source has `@` in it too; a
/// name that is not an npm name (`github.com/x/y`, `file:a`) means the key is no `name@version`.
fn pnpm_key(key: &str) -> Option<(&str, &str)> {
    let at = key.char_indices().skip(1).find(|&(_, c)| c == '@')?.0;
    let name = &key[..at];
    let slashes = name.matches('/').count();
    let ok = !name.contains(':') && slashes == usize::from(name.starts_with('@'));
    ok.then(|| (name, &key[at + 1..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maint::exec::FakeExec;

    fn names(p: &Parsed) -> Vec<(&str, &str, &str)> {
        p.pkgs.iter().map(|x| (x.ecosystem, x.name.as_str(), x.version.as_str())).collect()
    }

    const NPM: [(&str, &str, &str); 3] = [("npm", "@types/minimist", "1.2.5"), ("npm", "lodash", "4.17.20"), ("npm", "minimist", "1.2.5")];

    #[test]
    fn cargo_lock_lists_crates_io_packages_and_says_what_it_skipped() {
        let p = parse("Cargo.lock", &FakeExec::testdata("lock-cargo.lock")).unwrap();
        assert_eq!(names(&p), [("crates.io", "itoa", "1.0.18"), ("crates.io", "smallvec", "1.6.0")], "the workspace crate is the project");
        assert!(p.gaps.is_empty());
        assert_eq!(p.local.len(), 1, "but still named, as a path copy would be");
        let vendored = "version = 3
[[package]]
name = \"smallvec\"
version = \"1.6.0\"
";
        assert_eq!(parse("Cargo.lock", vendored).unwrap().local, [pkg("crates.io", "smallvec", "a local path at 1.6.0")], "a [patch] path copy is not dropped");
        let git = "version = 3\n[[package]]\nname = \"x\"\nversion = \"0.1.0\"\nsource = \"git+https://example.com/x#abc\"\n";
        let g = parse("sub/Cargo.lock", git).unwrap();
        assert_eq!(g.gaps, ["sub/Cargo.lock: 1 from git or another registry not checked"]);
        assert_eq!(g.unpinned, [pkg("crates.io", "x", "git+https://example.com/x#abc")], "named, so a sweep can say it cannot place it");
        assert_eq!(parse("Cargo.lock", "version = 9\n").unwrap().gaps, ["Cargo.lock: lockfile version 9 not read"]);
        assert!(parse("Cargo.lock", "[[package\n").is_err());
    }

    #[test]
    fn package_lock_v2_and_v3_read_alike_and_v1_is_a_gap() {
        for f in ["lock-npm-v2.json", "lock-npm-v3.json"] {
            let p = parse("package-lock.json", &FakeExec::testdata(f)).unwrap();
            assert_eq!((names(&p), p.gaps.len()), (NPM.to_vec(), 0), "{f}");
        }
        let nested = r#"{"lockfileVersion": 3, "packages": {"": {"version": "1.0.0"}, "packages/app": {"version": "1.0.0"},
          "node_modules/app": {"link": true, "resolved": "packages/app"},
          "node_modules/a/node_modules/b": {"version": "2.0.0"}, "node_modules/c": {"version": "git+ssh://x"}}}"#;
        let p = parse("package-lock.json", nested).unwrap();
        assert_eq!(names(&p), [("npm", "b", "2.0.0")], "a nested copy is installed too");
        assert_eq!(p.gaps, ["package-lock.json: 1 from git, a tarball or a path not checked"], "the link is the project, the git one a gap");
        assert_eq!(p.unpinned, [pkg("npm", "c", "git+ssh://x")]);
        assert_eq!(p.local, [pkg("npm", "app", "link:packages/app")]);
        let resolved = r#"{"lockfileVersion": 3, "packages": {"node_modules/next": {"version": "15.0.0", "resolved": "git+ssh://git@example.com/me/next.git#abc"}}}"#;
        let r = parse("package-lock.json", resolved).unwrap();
        assert_eq!((r.pkgs.len(), r.unpinned.len()), (0, 1), "a git copy's own version says nothing about the advisory's range");
        let v1 = parse("package-lock.json", r#"{"lockfileVersion": 1, "dependencies": {"a": {"version": "1.0.0"}}}"#).unwrap();
        assert_eq!((v1.pkgs.len(), v1.gaps), (0, vec!["package-lock.json: lockfileVersion 1 not read".to_string()]));
        assert!(parse("package-lock.json", "<html>").is_err());
    }

    #[test]
    fn pnpm_lock_reads_both_key_spellings_and_says_which_versions_it_cannot() {
        let p = parse("pnpm-lock.yaml", &FakeExec::testdata("lock-pnpm-v9.yaml")).unwrap();
        assert_eq!((names(&p), p.gaps.len()), (NPM.to_vec(), 0), "importers and snapshots are not packages");
        let v6 = "lockfileVersion: '6.0'\n\ndependencies:\n  lodash:\n    specifier: 4.17.20\n    version: 4.17.20\n\npackages:\n\n  \
                  /lodash@4.17.20:\n    resolution: {integrity: x}\n\n  /@scope/peer@1.0.0(react@18.2.0):\n    dev: false\n\n  \
                  file:packages/foo:\n    resolution: {directory: packages/foo, type: directory}\n    name: foo\n    dev: false\n\n  \
                  github.com/acme/is-positive/97edff6f:\n    resolution: {tarball: x}\n    name: is-positive\n    version: 3.1.0\n\n  \
                  registry.example.com/nameless/-/nameless-1.0.0.tgz:\n    dev: false\n\n  /mine@link:../mine:\n    dev: false\n";
        let p = parse("pnpm-lock.yaml", v6).unwrap();
        assert_eq!(names(&p), [("npm", "@scope/peer", "1.0.0"), ("npm", "lodash", "4.17.20")]);
        assert_eq!(p.gaps, ["pnpm-lock.yaml: 3 from git, a tarball or a path not checked"], "file:, git and a tarball are gaps, link: the project");
        let from_git = pkg("npm", "is-positive", "github.com/acme/is-positive/97edff6f");
        assert_eq!(p.unpinned, [pkg("npm", "foo", "file:packages/foo"), from_git], "6.x keys these by source, named inside");
        assert_eq!(p.local, [pkg("npm", "mine", "link:../mine")]);
        let v9 = "lockfileVersion: '9.0'\n\npackages:\n\n  foo@git+ssh://git@gitlab.com/acme/foo.git#abc:\n    resolution: {type: git}\n\n  \
                  '@s/bar@file:../bar':\n    resolution: {directory: ../bar}\n\nsnapshots:\n\n  foo@git+ssh://git@gitlab.com/acme/foo.git#abc: {}\n";
        let p = parse("pnpm-lock.yaml", v9).unwrap();
        let ssh = pkg("npm", "foo", "git+ssh://git@gitlab.com/acme/foo.git#abc");
        assert_eq!(p.unpinned, [pkg("npm", "@s/bar", "file:../bar"), ssh], "split at the name's @, not the source's");
        assert_eq!(p.gaps, ["pnpm-lock.yaml: 2 from git, a tarball or a path not checked"]);
        let old = parse("pnpm-lock.yaml", "lockfileVersion: 5.4\npackages:\n  /a/1.0.0:\n    dev: false\n").unwrap();
        assert_eq!((old.pkgs.len(), old.gaps), (0, vec!["pnpm-lock.yaml: lockfileVersion 5.4 not read".to_string()]));
        let unknown = "lockfileVersion: '10.0'\nimporters:\n  .:\n    dependencies:\n      a:\n        specifier: ^1\n        version: 1.0.0\n";
        let unknown = parse("pnpm-lock.yaml", unknown).unwrap();
        assert!(unknown.direct.is_empty(), "a version not read declares nothing, however readable its importers look");
        assert_eq!(unknown.gaps, ["pnpm-lock.yaml: lockfileVersion 10.0 not read"]);
        assert!(parse("pnpm-lock.yaml", "packages:\n").is_err(), "no version line is not a lockfile");
    }

    type Row<'a> = (&'a str, &'a str, Option<&'a str>, Option<&'a str>, Option<bool>);

    fn direct(p: &Parsed) -> Vec<Row<'_>> {
        p.direct.iter().map(|d| (d.importer.as_str(), d.name.as_str(), d.version.as_deref(), d.from.as_deref(), d.dev)).collect()
    }

    #[test]
    fn every_recorded_lockfile_names_what_its_project_declares() {
        let want = [(".", "@types/minimist", Some("1.2.5"), None, Some(false)), (".", "lodash", Some("4.17.20"), None, Some(false)),
            (".", "minimist", Some("1.2.5"), None, Some(false))];
        for (name, f) in [("pnpm-lock.yaml", "lock-pnpm-v9.yaml"), ("package-lock.json", "lock-npm-v3.json"), ("package-lock.json", "lock-npm-v2.json")] {
            assert_eq!(direct(&parse(name, &FakeExec::testdata(f)).unwrap()), want, "{f}");
        }
        let c = parse("Cargo.lock", &FakeExec::testdata("lock-cargo.lock")).unwrap();
        assert_eq!(direct(&c), [("rec", "itoa", Some("1.0.18"), None, None), ("rec", "smallvec", Some("1.6.0"), None, None)], "Cargo.lock says nothing of dev");
    }

    #[test]
    fn pnpm_reads_a_single_project_and_a_workspace_alike() {
        let v6 = "lockfileVersion: '6.0'\n\ndependencies:\n  react:\n    specifier: ^18\n    version: 18.2.0\n  \
                  '@scope/ui':\n    specifier: ^1\n    version: 1.0.0(react@18.2.0)\n\ndevDependencies:\n  vitest:\n    specifier: ^1\n    \
                  version: 1.6.0(@types/node@20.0.0)\n\npackages:\n\n  /react@18.2.0:\n    dev: false\n";
        assert_eq!(direct(&parse("pnpm-lock.yaml", v6).unwrap()), [(".", "@scope/ui", Some("1.0.0"), None, Some(false)),
            (".", "react", Some("18.2.0"), None, Some(false)), (".", "vitest", Some("1.6.0"), None, Some(true))], "a peer suffix is no version");
        let ws = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      typescript:\n        specifier: ^5\n        \
                  version: 5.4.0\n\n  packages/app:\n    dependencies:\n      lib:\n        specifier: workspace:*\n        version: link:../lib\n      \
                  str:\n        specifier: npm:string-width@^4\n        version: string-width@4.2.3\n      gone:\n        specifier: github:a/b\n        \
                  version: github.com/a/b/abc123\n    dependenciesMeta:\n      lib:\n        injected: true\n\npackages:\n\n  typescript@5.4.0: {}\n";
        assert_eq!(direct(&parse("pnpm-lock.yaml", ws).unwrap()), [(".", "typescript", Some("5.4.0"), None, Some(true)),
            ("packages/app", "gone", None, Some("github.com/a/b/abc123"), Some(false)),
            ("packages/app", "string-width", Some("4.2.3"), None, Some(false))], "a link is the project's own and an alias its real name");
    }

    #[test]
    fn pnpm_names_a_copy_its_packages_section_places_off_npm() {
        let lock = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@acme/ui':\n        specifier: ^1\n        version: 1.0.0(react@18.2.0)\n      \
                    lodash:\n        specifier: ^4\n        version: 4.17.20\n      left:\n        specifier: ^1\n        version: 1.0.0\n      odd:\n        specifier: ^1\n        \
                    version: 2.0.0\n\npackages:\n\n  '@acme/ui@1.0.0':\n    resolution: {integrity: sha512-a, tarball: https://npm.pkg.github.com/download/@acme/ui/1.0.0/abc}\n\n  \
                    lodash@4.17.20:\n    resolution: {integrity: sha512-b}\n\n  left@1.0.0:\n    resolution: {integrity: sha512-c, tarball: https://registry.npmjs.org/left/-/left-1.0.0.tgz}\n\n  \
                    odd@2.0.0:\n    resolution: {integrity: sha512-d, registry: https://npm.acme.example/}\n";
        assert_eq!(direct(&parse("pnpm-lock.yaml", lock).unwrap()), [
            (".", "@acme/ui", None, Some("https://npm.pkg.github.com/download/@acme/ui/1.0.0/abc"), Some(false)),
            (".", "left", Some("1.0.0"), None, Some(false)), (".", "lodash", Some("4.17.20"), None, Some(false)),
            (".", "odd", None, Some("https://npm.acme.example/"), Some(false))]);
    }

    #[test]
    fn package_lock_resolves_a_workspace_folders_own_copy_before_the_hoisted_one() {
        let ws = r#"{"lockfileVersion": 3, "packages": {
          "": {"workspaces": ["packages/*"], "devDependencies": {"x": "^1"}},
          "packages/app": {"name": "app", "dependencies": {"x": "^2", "y": "^1", "lib": "*", "al": "npm:real@^3"}, "devDependencies": {"y": "^1"}},
          "node_modules/x": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz"},
          "packages/app/node_modules/x": {"version": "2.1.0", "resolved": "https://registry.npmjs.org/x/-/x-2.1.0.tgz"},
          "node_modules/y": {"version": "1.0.0", "resolved": "https://npm.acme.example/y/-/y-1.0.0.tgz"},
          "node_modules/lib": {"link": true, "resolved": "packages/lib"},
          "node_modules/al": {"name": "real", "version": "3.0.0", "resolved": "https://registry.npmjs.org/real/-/real-3.0.0.tgz"}}}"#;
        assert_eq!(direct(&parse("package-lock.json", ws).unwrap()), [(".", "x", Some("1.0.0"), None, Some(true)),
            ("packages/app", "real", Some("3.0.0"), None, Some(false)), ("packages/app", "x", Some("2.1.0"), None, Some(false)),
            ("packages/app", "y", None, Some("https://npm.acme.example/y/-/y-1.0.0.tgz"), Some(false))]);
    }

    #[test]
    fn cargo_lock_tells_two_versions_apart_and_names_a_git_source() {
        let lock = "version = 4\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\ndependencies = [\n \"base64 0.22.1\",\n \"forked\",\n \"util\",\n]\n\
                    [[package]]\nname = \"base64\"\nversion = \"0.21.7\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\
                    [[package]]\nname = \"base64\"\nversion = \"0.22.1\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\
                    [[package]]\nname = \"forked\"\nversion = \"0.3.0\"\nsource = \"git+https://example.com/forked#abc\"\n\
                    [[package]]\nname = \"util\"\nversion = \"0.1.0\"\n";
        assert_eq!(direct(&parse("Cargo.lock", lock).unwrap()), [("app", "base64", Some("0.22.1"), None, None),
            ("app", "forked", None, Some("git+https://example.com/forked#abc"), None)], "a path crate is the project's own");
    }

    #[test]
    fn only_crates_io_itself_is_crates_io() {
        let entry = |name: &str, source: &str| format!("[[package]]\nname = \"{name}\"\nversion = \"1.0.0\"\nsource = \"{source}\"\n");
        let lock = format!("version = 4\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\ndependencies = [\n \"a\",\n \"b\",\n \"c\",\n \"d\",\n]\n{}{}{}{}",
            entry("a", "registry+https://github.com/rust-lang/crates.io-index"), entry("b", "sparse+https://index.crates.io/"),
            entry("c", "registry+https://gitlab.acme.example/mirrors/crates.io-index"), entry("d", "git+https://github.com/acme/crates.io-index-tools#abc"));
        let p = parse("Cargo.lock", &lock).unwrap();
        assert_eq!(direct(&p), [("app", "a", Some("1.0.0"), None, None), ("app", "b", Some("1.0.0"), None, None),
            ("app", "c", None, Some("registry+https://gitlab.acme.example/mirrors/crates.io-index"), None),
            ("app", "d", None, Some("git+https://github.com/acme/crates.io-index-tools#abc"), None)], "a look-alike is never sent as a crates.io name");
        assert_eq!(p.pkgs.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["a", "b"], "nor asked of OSV under that ecosystem");
    }
}
