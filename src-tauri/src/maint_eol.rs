//! `runtime-eol` (docs/maintenance.md § Adapters): the runtimes a project declares, read and never
//! run, then each one's release cycles from endoflife.date. Only a product's name leaves the machine.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::maint::exec::HttpReq;
use crate::maint::{found_paths, Coverage, Ctx, Eol, Exec, Facts, Read, Runtime};

/// Every file a runtime is declared in: detection's entries (the manifest's, held by a test) and `declared`'s.
pub(crate) const DECLS: &[&str] = &[
    ".nvmrc", ".node-version", "package.json#engines", ".python-version", "pyproject.toml", "rust-toolchain",
    "rust-toolchain.toml", "go.mod", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml",
    "compose.yaml", ".tool-versions",
];

/// endoflife.date's id, the name a project calls it by, and the names an image or `.tool-versions` uses.
const PRODUCTS: &[(&str, &str, &[&str])] = &[
    ("nodejs", "node", &["node", "nodejs"]),
    ("python", "python", &["python"]),
    ("rust", "rust", &["rust"]),
    ("go", "go", &["go", "golang"]),
    ("postgresql", "postgres", &["postgres", "postgresql"]),
    ("redis", "redis", &["redis"]),
    ("mysql", "mysql", &["mysql"]),
];

const API: &str = "https://endoflife.date/api";
const SECS: u64 = 20;
const KEEP: Duration = Duration::from_secs(24 * 3600);
const FILE_BYTES: u64 = 1024 * 1024;
const CAP: usize = 40;

#[derive(Clone, Debug, PartialEq)]
struct Decl {
    product: &'static str,
    version: String,
    file: String,
}

fn product(id: &str) -> Option<&'static (&'static str, &'static str, &'static [&'static str])> {
    PRODUCTS.iter().find(|p| p.0 == id)
}

fn by_alias(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    PRODUCTS.iter().find(|p| p.2.contains(&n.as_str())).map(|p| p.0)
}

/// One version, `v` allowed in front: `18`, `3.11.4`. A word, a range or a wildcard is not one.
fn bare(s: &str) -> Option<String> {
    let v = s.trim().trim_start_matches('v');
    let parts: Vec<&str> = v.split('.').collect();
    (parts.len() <= 4 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))).then(|| v.to_string())
}

/// npm's spelling of one major: `18`, `^18.17`, `~18.1`, `18.x`. Node's cycles are majors, so each pins one.
fn node_spec(s: &str) -> Option<String> {
    let v = s.trim().trim_start_matches(['^', '~', '=']);
    let v = v.trim_end_matches(".x").trim_end_matches(".*").trim_end_matches(".x").trim_end_matches(".*");
    bare(v)
}

/// PEP 440's one cycle: `==3.11`, `==3.11.*`, `===3.11.4`. `>=3.9` admits every later one, so it is no answer.
fn python_spec(s: &str) -> Option<String> {
    let v = s.trim().strip_prefix("===").or_else(|| s.trim().strip_prefix("=="))?;
    bare(v.trim().trim_end_matches(".*"))
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#'))
}

/// An image reference: an official image only (`node`, `library/node`, `docker.io/library/node`), its tag's
/// leading version (`18-alpine` is 18). `Ok(None)` for an image nobody here reads.
fn image(reference: &str) -> Result<Option<(&'static str, String)>, String> {
    let r = reference.split('@').next().unwrap_or("");
    let (repo, tag) = match r.rsplit_once(':') {
        Some((repo, tag)) if !tag.contains('/') => (repo, Some(tag)),
        _ => (r, None),
    };
    let path = repo.strip_prefix("docker.io/").unwrap_or(repo);
    let name = path.strip_prefix("library/").unwrap_or(path);
    let Some(p) = by_alias(name).filter(|_| !name.contains('/')) else { return Ok(None) };
    // A digest pins bytes, not a version anyone can look up; no tag is whichever was newest.
    let lead = tag.and_then(|t| t.split('-').next()).unwrap_or("");
    bare(lead).map(|v| Some((p, v))).ok_or_else(|| format!("{reference} names no version"))
}

/// What one file declares. A declaration that is not one version is a gap, never a guess.
fn parse_decl(file: &str, text: &str, gaps: &mut Vec<String>) -> Vec<Decl> {
    let name = file.rsplit('/').next().unwrap_or(file);
    let mut out = vec![];
    let mut add = |product: &'static str, v: Option<String>, raw: &str, what: &str| match v {
        Some(version) => out.push(Decl { product, version, file: file.to_string() }),
        None => gaps.push(format!("{file}: {what} {raw:?} is not one version")),
    };
    match name {
        ".nvmrc" | ".node-version" => {
            if let Some(l) = first_line(text) {
                add("nodejs", bare(l), l, "node");
            }
        }
        ".python-version" => {
            if let Some(l) = first_line(text) {
                add("python", bare(l), l, "python");
            }
        }
        "package.json" => {
            let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
            if let Some(s) = v.pointer("/engines/node").and_then(Value::as_str) {
                add("nodejs", node_spec(s), s, "engines.node");
            }
        }
        "pyproject.toml" => {
            let t = text.parse::<toml::Table>().unwrap_or_default();
            if let Some(s) = t.get("project").and_then(|p| p.get("requires-python")).and_then(|v| v.as_str()) {
                add("python", python_spec(s), s, "requires-python");
            }
        }
        "rust-toolchain" | "rust-toolchain.toml" => {
            // The TOML form, or the legacy file that is only the channel.
            let t = text.parse::<toml::Table>().ok();
            let channel = t.as_ref().and_then(|t| t.get("toolchain")?.get("channel")?.as_str().map(str::to_string))
                .or_else(|| t.is_none().then(|| first_line(text).map(str::to_string)).flatten());
            if let Some(c) = channel {
                add("rust", bare(&c), &c, "channel");
            }
        }
        "go.mod" => {
            if let Some(v) = text.lines().find_map(|l| l.trim().strip_prefix("go ")) {
                add("go", bare(v), v.trim(), "go");
            }
        }
        ".tool-versions" => {
            for l in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
                let mut w = l.split_whitespace();
                if let (Some(p), Some(v)) = (w.next().and_then(by_alias), w.next()) {
                    add(p, bare(v), v, l.split_whitespace().next().unwrap_or(""));
                }
            }
        }
        _ => {
            // A Dockerfile's FROM lines, or a compose file's `image:` keys.
            let refs: Vec<&str> = if name == "Dockerfile" {
                text.lines().filter_map(|l| {
                    let mut w = l.split_whitespace();
                    w.next().filter(|k| k.eq_ignore_ascii_case("FROM"))?;
                    w.find(|t| !t.starts_with("--"))
                }).collect()
            } else {
                text.lines().filter_map(|l| l.trim().strip_prefix("image:"))
                    .map(|v| v.split('#').next().unwrap_or("").trim().trim_matches(['"', '\''])).collect()
            };
            for r in refs.into_iter().filter(|r| !r.is_empty() && !r.contains('$')) {
                match image(r) {
                    Ok(Some((p, version))) => out.push(Decl { product: p, version, file: file.to_string() }),
                    Ok(None) => {}
                    Err(e) => gaps.push(format!("{file}: {e}")),
                }
            }
        }
    }
    out
}

/// Every runtime the project declares, once per product, version and file.
fn declared(root: &str, gaps: &mut Vec<String>) -> Vec<Decl> {
    let mut out: Vec<Decl> = vec![];
    for found in found_paths(root, DECLS) {
        let file = found.split('#').next().unwrap_or(&found).to_string();
        let path = Path::new(root).join(&file);
        let text = match crate::maint::read_capped(&path, FILE_BYTES) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::Other => {
                gaps.push(format!("{file} is {e}"));
                continue;
            }
            Err(_) => continue,
        };
        for d in parse_decl(&file, &text, gaps) {
            if !out.contains(&d) {
                out.push(d);
            }
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
struct Cycle {
    cycle: String,
    eol: Option<Eol>,
    latest: Option<String>,
}

/// `2025-04-30` as unix seconds, midnight UTC.
fn day_secs(s: &str) -> Option<u64> {
    let mut p = s.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, d) = (p.next()??, p.next()??, p.next()??);
    if p.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    u64::try_from(crate::usage::days_from_civil(y, m, d) * 86_400).ok()
}

/// endoflife.date's answer for one product, newest cycle first as it lists them.
fn parse_cycles(body: &str) -> Result<Vec<Cycle>, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "endoflife.date answered something that is not JSON".to_string())?;
    let rows = v.as_array().filter(|a| !a.is_empty()).ok_or("endoflife.date listed no release cycle")?;
    Ok(rows.iter().filter_map(|r| {
        let cycle = match r.get("cycle")? {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => return None,
        };
        let eol = match r.get("eol") {
            Some(Value::Bool(b)) => Some(Eol::Flag(*b)),
            Some(Value::String(s)) => day_secs(s).map(Eol::At),
            _ => None,
        };
        Some(Cycle { cycle, eol, latest: r.get("latest").and_then(Value::as_str).map(str::to_string) })
    }).collect())
}

/// The cycle a version is in: the longest one it equals or starts with, so `9.6.24` is 9.6 and never 9.
fn cycle_of<'a>(version: &str, cycles: &'a [Cycle]) -> Option<&'a Cycle> {
    cycles.iter().filter(|c| version == c.cycle || version.starts_with(&format!("{}.", c.cycle)))
        .max_by_key(|c| c.cycle.len())
}

type Cache = Mutex<BTreeMap<String, (Instant, Vec<Cycle>)>>;
/// A product's cycles for `KEEP`, shared by every project that declares it; a forced read asks again.
/// Process-wide, so a test reaching it unforced (maint.rs's registry ones never do) leaks into the next.
static CYCLES: Cache = Mutex::new(BTreeMap::new());

fn cycles(ex: &dyn Exec, id: &str, force: bool, cache: &Cache) -> Result<Vec<Cycle>, String> {
    if !force {
        if let Some((_, c)) = cache.lock().ok().and_then(|g| g.get(id).cloned()).filter(|(at, _)| at.elapsed() < KEEP) {
            return Ok(c);
        }
    }
    let r = ex.http(&HttpReq { url: format!("{API}/{id}.json"), body: None, token: None, secs: SECS, report: false })?;
    if r.code != 200 {
        return Err(format!("endoflife.date answered HTTP {}", r.code));
    }
    let c = parse_cycles(&r.body)?;
    if let Ok(mut g) = cache.lock() {
        g.insert(id.to_string(), (Instant::now(), c.clone()));
    }
    Ok(c)
}

fn read_with(ctx: &Ctx, ex: &dyn Exec, cache: &Cache) -> Result<Read, Coverage> {
    let mut gaps = vec![];
    let mut decls = declared(ctx.root, &mut gaps);
    if decls.is_empty() {
        let reason = if gaps.is_empty() { "declares no runtime version endoflife.date lists".to_string() } else { gaps.join("; ") };
        return Err(Coverage::Unsupported { reason });
    }
    let truncated = decls.len() > CAP;
    decls.truncate(CAP);
    let mut known = BTreeMap::new();
    let mut failed = vec![];
    for id in decls.iter().map(|d| d.product).collect::<BTreeSet<_>>() {
        match cycles(ex, id, ctx.force, cache) {
            Ok(c) => {
                known.insert(id, c);
            }
            Err(e) => failed.push(format!("{id}: {e}")),
        }
    }
    if known.is_empty() {
        return Err(Coverage::Error { reason: failed.join("; ") });
    }
    gaps.extend(failed);
    let items = decls.iter().filter_map(|d| {
        let all = known.get(d.product)?;
        let c = cycle_of(&d.version, all);
        Some(Runtime {
            product: d.product.to_string(),
            name: product(d.product).map_or(d.product, |p| p.1).to_string(),
            declared: d.version.clone(),
            cycle: c.map(|c| c.cycle.clone()),
            eol: c.and_then(|c| c.eol),
            latest: c.and_then(|c| c.latest.clone()),
            newest: all.first().map(|c| c.cycle.clone()),
            file: d.file.clone(),
            url: Some(format!("https://endoflife.date/{}", d.product)),
        })
    }).collect();
    Ok(Read { facts: Facts::Runtimes { items }, truncated, gaps })
}

/// The declared runtimes, then endoflife.date per product: a `public` read, so a scan makes it
/// only on a machine that opted in, and a click once.
pub(crate) fn runtime_eol(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    read_with(ctx, ex, &CYCLES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::MaintConfig;
    use crate::testutil::scratch_dir;

    const NONE: Forge = Forge { kind: ForgeKind::None, host: None, path: None, by: ForgeBy::None, api: None };

    fn repo(files: &[(&str, &str)]) -> String {
        let dir = scratch_dir();
        for (rel, text) in files {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        dir.to_string_lossy().to_string()
    }

    fn decls(file: &str, text: &str) -> (Vec<(&'static str, String)>, Vec<String>) {
        let mut gaps = vec![];
        let d = parse_decl(file, text, &mut gaps).into_iter().map(|d| (d.product, d.version)).collect();
        (d, gaps)
    }

    fn v(p: &'static str, s: &str) -> (&'static str, String) {
        (p, s.to_string())
    }

    fn answers() -> FakeExec {
        let mut ex = FakeExec::answering(Err("no answer"));
        for p in ["nodejs", "python", "postgresql", "go", "rust", "redis"] {
            ex = ex.on(&["curl", &format!("{API}/{p}.json")], Ok(&FakeExec::testdata(&format!("eol-{p}.json"))));
        }
        ex
    }

    fn read(root: &str, ex: &FakeExec, cache: &Cache, force: bool) -> Result<Read, Coverage> {
        read_with(&Ctx { root, cfg: &MaintConfig::default(), forge: &NONE, account: None, force }, ex, cache)
    }

    fn items(r: &Read) -> &[Runtime] {
        match &r.facts {
            Facts::Runtimes { items } => items,
            other => panic!("not runtimes: {other:?}"),
        }
    }

    #[test]
    fn version_files_declare_one_version_and_anything_else_is_a_gap() {
        assert_eq!(decls(".nvmrc", "v18.17.0\n"), (vec![v("nodejs", "18.17.0")], vec![]));
        assert_eq!(decls(".node-version", "# pinned\n20\n"), (vec![v("nodejs", "20")], vec![]));
        let (d, gaps) = decls(".nvmrc", "lts/hydrogen\n");
        assert!(d.is_empty() && gaps == [r#".nvmrc: node "lts/hydrogen" is not one version"#], "{gaps:?}");
        assert_eq!(decls(".python-version", "3.11.4\n3.12.1\n"), (vec![v("python", "3.11.4")], vec![]), "pyenv's first");
        assert_eq!(decls(".python-version", "pypy3.9\n").1.len(), 1, "an implementation is not a version");
        assert_eq!(decls(".nvmrc", "\n"), (vec![], vec![]), "an empty file declares nothing");
    }

    #[test]
    fn manifests_pin_a_cycle_only_where_the_spec_does() {
        let pkg = |s: &str| decls("package.json", &format!(r#"{{"name": "x", "engines": {{"node": "{s}"}}}}"#));
        for (spec, want) in [("18", "18"), ("^18.17.0", "18.17.0"), ("~20.1", "20.1"), ("18.x", "18"), ("v22", "22"), ("=20.11.1", "20.11.1")] {
            assert_eq!(pkg(spec).0, [v("nodejs", want)], "{spec}");
        }
        for range in [">=18", ">=18 <21", "18 || 20", "*", "18 - 20", "latest"] {
            let (d, gaps) = pkg(range);
            assert!(d.is_empty() && gaps[0].contains("engines.node"), "{range}: {gaps:?}");
        }
        assert_eq!(decls("package.json", r#"{"engines": {"npm": ">=9"}}"#), (vec![], vec![]), "no node, nothing said");
        assert_eq!(decls("package.json", "not json"), (vec![], vec![]));
        let py = |s: &str| decls("pyproject.toml", &format!("[project]\nname = \"x\"\nrequires-python = \"{s}\"\n"));
        assert_eq!(py("==3.11.*").0, [v("python", "3.11")]);
        assert_eq!(py("===3.12.1").0, [v("python", "3.12.1")]);
        for range in [">=3.9", ">=3.11,<3.12", "~=3.11", "^3.11"] {
            assert_eq!(py(range).1.len(), 1, "{range}");
        }
        assert_eq!(decls("pyproject.toml", "[tool.poetry]\nname = 1\n"), (vec![], vec![]));
        assert_eq!(decls("pyproject.toml", "[[[ junk"), (vec![], vec![]), "unparseable is nothing read, never a guess");
    }

    #[test]
    fn toolchains_go_mod_and_tool_versions() {
        assert_eq!(decls("rust-toolchain.toml", "[toolchain]\nchannel = \"1.75.0\"\ncomponents = [\"clippy\"]\n").0, [v("rust", "1.75.0")]);
        assert_eq!(decls("rust-toolchain", "1.80\n").0, [v("rust", "1.80")], "the legacy file is the channel alone");
        let (d, gaps) = decls("rust-toolchain.toml", "[toolchain]\nchannel = \"stable\"\n");
        assert!(d.is_empty() && gaps[0].contains("\"stable\""), "a channel follows releases: {gaps:?}");
        assert_eq!(decls("go.mod", "module example.com/x\n\ngo 1.21.3\n\ntoolchain go1.22.1\n").0, [v("go", "1.21.3")]);
        assert_eq!(decls("go.mod", "module example.com/x\n"), (vec![], vec![]));
        let (d, gaps) = decls(".tool-versions", "# asdf\nnodejs 18.17.0 20.1.0\npython 3.11.4\nruby 3.2.0\ngolang system\npostgres 13.4\n");
        assert_eq!(d, [v("nodejs", "18.17.0"), v("python", "3.11.4"), v("postgresql", "13.4")], "ruby is not read; the first version each");
        assert_eq!(gaps, [r#".tool-versions: golang "system" is not one version"#]);
    }

    #[test]
    fn images_are_read_from_official_names_and_their_tags() {
        let docker = "FROM --platform=linux/amd64 node:18-alpine AS build\nRUN x\nfrom docker.io/library/python:3.11-slim\nFROM nginx:1.25\n\
            FROM ${BASE}\nFROM node:lts\nFROM bitnami/postgresql:13\nFROM postgres@sha256:abc\nFROM build\n";
        let (d, gaps) = decls("Dockerfile", docker);
        assert_eq!(d, [v("nodejs", "18"), v("python", "3.11")], "a vendor's own image is not the runtime's");
        assert_eq!(gaps, ["Dockerfile: node:lts names no version", "Dockerfile: postgres@sha256:abc names no version"]);
        let compose = "services:\n  db:\n    image: \"postgres:13.4-alpine\" # pinned\n  cache:\n    image: redis:7.2\n  app:\n    build: .\n    image: ${APP}\n";
        assert_eq!(decls("compose.yaml", compose), (vec![v("postgresql", "13.4"), v("redis", "7.2")], vec![]));
        assert_eq!(decls("deploy/docker-compose.yml", "services:\n  db:\n    image: postgres\n").1,
            ["deploy/docker-compose.yml: postgres names no version"]);
    }

    #[test]
    fn a_cycle_is_the_longest_one_a_version_falls_in_and_eol_is_a_date_or_a_flag() {
        let node = parse_cycles(&FakeExec::testdata("eol-nodejs.json")).unwrap();
        let pg = parse_cycles(&FakeExec::testdata("eol-postgresql.json")).unwrap();
        let go = parse_cycles(&FakeExec::testdata("eol-go.json")).unwrap();
        let c = cycle_of("18.17.0", &node).unwrap();
        assert_eq!((c.cycle.as_str(), c.eol, c.latest.as_deref()), ("18", Some(Eol::At(day_secs("2025-04-30").unwrap())), Some("18.20.8")));
        assert_eq!(cycle_of("1.8.4", &node).unwrap().eol, Some(Eol::Flag(true)), "ended with no date");
        assert_eq!(cycle_of("1.27", &go).unwrap().eol, Some(Eol::Flag(false)), "no end announced");
        assert_eq!(cycle_of("9.6.24", &pg).unwrap().cycle, "9.6");
        assert_eq!(cycle_of("13", &pg).unwrap().cycle, "13");
        assert_eq!(cycle_of("1", &pg), None, "never a guess at a shorter cycle");
        let redis = parse_cycles(&FakeExec::testdata("eol-redis.json")).unwrap();
        assert_eq!(cycle_of("8.10.3", &redis).unwrap().cycle, "8.10", "a two-digit minor");
        // Each Rust minor ends the day the next ships; maint.ts reads an ended one as a pin.
        let rust = parse_cycles(&FakeExec::testdata("eol-rust.json")).unwrap();
        assert_eq!(cycle_of("1.98.1", &rust).unwrap().eol, Some(Eol::At(day_secs("2026-10-01").unwrap())));
        assert_eq!(cycle_of("1.99", &rust).unwrap().eol, Some(Eol::Flag(false)));
        assert_eq!(cycle_of("99", &node), None);
        assert_eq!(day_secs("1970-01-02"), Some(86_400));
        assert_eq!(day_secs("2025-13-01"), None);
        assert!(parse_cycles("<html>").is_err() && parse_cycles("[]").is_err() && parse_cycles("{}").is_err());
    }

    #[test]
    fn a_read_names_each_runtime_its_cycle_and_where_it_was_declared() {
        let root = repo(&[(".nvmrc", "18\n"), ("api/Dockerfile", "FROM python:3.9-slim\n"), ("compose.yml", "services:\n  db:\n    image: postgres:99\n"),
            ("package.json", r#"{"engines": {"node": ">=18"}}"#)]);
        let (ex, cache) = (answers(), Cache::default());
        let r = read(&root, &ex, &cache, false).unwrap();
        let got: Vec<_> = items(&r).iter().map(|x| (x.name.as_str(), x.declared.as_str(), x.cycle.as_deref(), x.file.as_str())).collect();
        assert_eq!(got, [("node", "18", Some("18"), ".nvmrc"), ("python", "3.9", Some("3.9"), "api/Dockerfile"), ("postgres", "99", None, "compose.yml")]);
        let pg = &items(&r)[2];
        assert_eq!((pg.eol, pg.newest.as_deref(), pg.url.as_deref()), (None, Some("18"), Some("https://endoflife.date/postgresql")),
            "a cycle nobody lists is unknown, never fine");
        assert_eq!(r.gaps, [r#"package.json: engines.node ">=18" is not one version"#]);
        let sent: Vec<_> = ex.calls().into_iter().map(|c| c[1].clone()).collect();
        assert_eq!(sent, [format!("{API}/nodejs.json"), format!("{API}/postgresql.json"), format!("{API}/python.json")],
            "a product's name and nothing else: no version, no path");
    }

    #[test]
    fn version_files_are_read_at_the_root_and_manifests_one_folder_down() {
        let root = repo(&[("web/.nvmrc", "16\n"), ("web/package.json", r#"{"engines": {"node": "20"}}"#),
            ("api/Dockerfile", "FROM python:3.11\n"), ("a/b/go.mod", "go 1.21\n")]);
        let r = read(&root, &answers(), &Cache::default(), true).unwrap();
        let got: Vec<_> = items(&r).iter().map(|x| (x.name.as_str(), x.file.as_str())).collect();
        assert_eq!(got, [("python", "api/Dockerfile"), ("node", "web/package.json")], "web/.nvmrc and a/b/go.mod are not read");
    }

    #[test]
    fn past_the_cap_a_read_is_truncated() {
        let images: String = (1..=45).map(|n| format!("  s{n}:\n    image: node:{n}\n")).collect();
        let r = read(&repo(&[("compose.yml", &format!("services:\n{images}"))]), &answers(), &Cache::default(), true).unwrap();
        assert!(r.truncated && items(&r).len() == CAP, "{}", items(&r).len());
    }

    #[test]
    fn cycles_are_kept_per_product_and_a_forced_read_asks_again() {
        let cache = Cache::default();
        let node = repo(&[(".nvmrc", "20\n")]);
        let first = answers();
        read(&node, &first, &cache, false).unwrap();
        assert_eq!(first.calls().len(), 1);
        let again = answers();
        read(&repo(&[(".node-version", "22\n")]), &again, &cache, false).unwrap();
        assert!(again.calls().is_empty(), "another project on the same product asks nothing");
        let both = answers();
        read(&repo(&[(".nvmrc", "20\n"), (".python-version", "3.12\n")]), &both, &cache, false).unwrap();
        assert_eq!(both.calls().iter().map(|c| c[1].as_str()).collect::<Vec<_>>(), [format!("{API}/python.json")], "keyed by product");
        let forced = answers();
        read(&node, &forced, &cache, true).unwrap();
        assert_eq!(forced.calls().len(), 1, "a forced read asks past the cache");
    }

    #[test]
    fn a_product_that_failed_is_a_gap_and_nothing_answered_is_an_error() {
        let root = repo(&[(".nvmrc", "18\n"), ("go.mod", "go 1.21\n")]);
        let ex = FakeExec::answering(Ok("<html>")).on(&["curl", &format!("{API}/nodejs.json")], Ok(&FakeExec::testdata("eol-nodejs.json")));
        let r = read(&root, &ex, &Cache::default(), true).unwrap();
        assert_eq!(items(&r).len(), 1);
        assert_eq!(r.gaps, ["go: endoflife.date answered something that is not JSON"]);
        assert!(matches!(read(&root, &FakeExec::answering(Err("boom")), &Cache::default(), true), Err(Coverage::Error { .. })));
        let none = repo(&[("Dockerfile", "FROM alpine:3.19\n")]);
        assert!(matches!(read(&none, &answers(), &Cache::default(), true), Err(Coverage::Unsupported { .. })));
        let ranged = repo(&[(".nvmrc", "lts/*\n")]);
        let Err(Coverage::Unsupported { reason }) = read(&ranged, &answers(), &Cache::default(), true) else { panic!() };
        assert!(reason.contains("lts/*"), "says what it could not read: {reason}");
    }

    #[test]
    fn the_files_detection_offers_it_on_are_the_files_it_reads() {
        let man: Value = serde_json::from_str(include_str!("../../src/maintmanifest.json")).unwrap();
        let detect: Vec<&str> = man.pointer("/sources/runtime-eol/detect").and_then(Value::as_array).unwrap()
            .iter().filter_map(Value::as_str).collect();
        assert_eq!(detect, DECLS);
        for (id, name, _) in PRODUCTS {
            assert_eq!(by_alias(name), Some(*id), "{name}");
        }
    }
}
