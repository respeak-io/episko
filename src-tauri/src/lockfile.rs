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

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Parsed {
    pub(crate) pkgs: Vec<Pkg>,
    pub(crate) gaps: Vec<String>,
    /// From git, a tarball, a path or another registry: `version` is where it came from, never a version.
    pub(crate) unpinned: Vec<Pkg>,
    /// A path or a link: the project's own package, or a vendored or patched copy of someone else's.
    pub(crate) local: Vec<Pkg>,
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
        if src.contains("crates.io-index") || src.contains("index.crates.io") {
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
    Ok(out)
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
    Ok(out)
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
    for line in text.lines() {
        if !line.starts_with(' ') && !line.trim().is_empty() {
            inside = line.trim_end() == "packages:";
            continue;
        }
        let Some(key) = line.strip_prefix("  ").filter(|k| !k.starts_with(' ')).and_then(|k| k.trim_end().strip_suffix(':')) else { continue };
        if !inside {
            continue;
        }
        let key = key.trim_matches(['\'', '"']);
        let key = key.strip_prefix('/').unwrap_or(key);
        let key = key.split('(').next().unwrap_or(key);
        // The `@` after the name, never a scope's leading one.
        if let Some((name, version)) = key.rsplit_once('@').filter(|(n, _)| !n.is_empty()) {
            if version.starts_with(|c: char| c.is_ascii_digit()) {
                out.pkgs.push(pkg("npm", name, version));
            } else if version.starts_with("link:") {
                out.local.push(pkg("npm", name, version)); // usually the project's own folder
            } else {
                other += 1;
                out.unpinned.push(pkg("npm", name, version));
            }
        }
    }
    unchecked(&mut out, file, other);
    Ok(out)
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
                  /local@file:../x:\n    dev: false\n\n  /mine@link:../mine:\n    dev: false\n";
        let p = parse("pnpm-lock.yaml", v6).unwrap();
        assert_eq!(names(&p), [("npm", "@scope/peer", "1.0.0"), ("npm", "lodash", "4.17.20")]);
        assert_eq!(p.gaps, ["pnpm-lock.yaml: 1 from git, a tarball or a path not checked"], "file: is a gap, link: the project");
        assert_eq!(p.unpinned, [pkg("npm", "local", "file:../x")]);
        assert_eq!(p.local, [pkg("npm", "mine", "link:../mine")]);
        let old = parse("pnpm-lock.yaml", "lockfileVersion: 5.4\npackages:\n  /a/1.0.0:\n    dev: false\n").unwrap();
        assert_eq!((old.pkgs.len(), old.gaps), (0, vec!["pnpm-lock.yaml: lockfileVersion 5.4 not read".to_string()]));
        assert!(parse("pnpm-lock.yaml", "packages:\n").is_err(), "no version line is not a lockfile");
    }
}
