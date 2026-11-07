//! `npm-registry` and `crates-registry` (docs/maintenance.md § Adapters): each direct dependency the
//! lockfiles list, then the newest release its registry names. Only a package's name leaves the machine.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::deps::Shared;
use crate::lockfile::Direct;
use crate::maint::exec::HttpReq;
use crate::maint::{found_paths, read_capped, Coverage, Ctx, Exec, Facts, PkgLatest, Read, CONFIG_CAP};
use crate::maint_sec::{ver, LOCK_BYTES};

const NAMES_CAP: usize = 300;
const WORKERS: usize = 4;
const SECS: u64 = 20;
const BUDGET: Duration = Duration::from_secs(60); // a read holds one of the scan's six slots; a click may wait behind it
const GAPS_SHOWN: usize = 8;
const NO_ANSWER: &str = "the registry did not answer";
const NOT_ASKED: &str = "not asked: the read ran out of time";
const KEEP: Duration = Duration::from_secs(6 * 3600);
const FORCE_KEEP: Duration = Duration::from_secs(600);
const STALL: Duration = Duration::from_secs(SECS + 30);
const NPM_HOSTS: &[&str] = &["https://registry.npmjs.org", "http://registry.npmjs.org"];

/// What a registry said of one name: its newest release, or why it named none.
type Answer = Result<String, &'static str>;
type Cache = Shared<(&'static str, String), Result<Answer, String>>;
type Over<'a> = &'a (dyn Fn() -> bool + Sync);
/// Per registry and name, shared by every project and scan: six projects asking for one package wait on one GET.
static LATEST: Cache = Shared::new(KEEP, FORCE_KEEP, STALL);

struct Registry {
    eco: &'static str, // lockfile.rs's spelling
    who: &'static str,
    locks: &'static [&'static str], // the manifest's `detect`, held to it by a test
    valid: fn(&str) -> bool,
    latest_url: fn(&str) -> String,
    page: fn(&str) -> String,
    parse: fn(&str) -> Result<Answer, String>,
}

/// `name` or `@scope/name`, in the characters a URL path takes as they are.
fn npm_name(n: &str) -> bool {
    let part = |s: &str| !s.is_empty() && !s.starts_with('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c));
    n.len() <= 214 && n.strip_prefix('@').map_or(part(n), |rest| rest.split_once('/').is_some_and(|(s, p)| part(s) && part(p)))
}

fn crate_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn npm_url(n: &str) -> String {
    format!("https://registry.npmjs.org/-/package/{}/dist-tags", n.replace('/', "%2f"))
}

fn npm_page(n: &str) -> String {
    format!("https://www.npmjs.com/package/{n}")
}

/// The sparse index's path for a crate, lowercased: `1/a`, `2/ab`, `3/a/abc`, `ab/cd/abcd…`.
fn index_path(name: &str) -> String {
    let n = name.to_ascii_lowercase();
    match n.len() {
        1 => format!("1/{n}"),
        2 => format!("2/{n}"),
        3 => format!("3/{}/{n}", &n[..1]),
        _ => format!("{}/{}/{n}", &n[..2], &n[2..4]),
    }
}

fn crate_url(n: &str) -> String {
    format!("https://index.crates.io/{}", index_path(n))
}

fn crate_page(n: &str) -> String {
    format!("https://crates.io/crates/{n}")
}

/// The `latest` dist-tag: what `npm install` picks, which may be below a newer prerelease.
fn parse_dist_tags(body: &str) -> Result<Answer, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "answered something that is not JSON".to_string())?;
    let tags = v.as_object().ok_or("answered something that is not a tag list")?;
    Ok(tags.get("latest").and_then(Value::as_str).map(str::to_string).ok_or("tags no release latest"))
}

/// The highest release the index lists that is neither yanked nor a prerelease (a `-` before any `+`).
fn parse_index(body: &str) -> Result<Answer, String> {
    let (mut seen, mut best) = (false, None::<String>);
    for line in body.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(vers) = v.get("vers").and_then(Value::as_str) else { continue };
        seen = true;
        let pre = vers.split('+').next().unwrap_or(vers).contains('-');
        if !pre && v.get("yanked").and_then(Value::as_bool) != Some(true) && best.as_deref().is_none_or(|b| ver(vers) >= ver(b)) {
            best = Some(vers.to_string());
        }
    }
    if !seen {
        return Err("answered something that is not an index file".into());
    }
    Ok(best.ok_or("lists only yanked or prerelease versions"))
}

const NPM: Registry = Registry {
    eco: "npm", who: "the npm registry", locks: &["package-lock.json", "pnpm-lock.yaml"],
    valid: npm_name, latest_url: npm_url, page: npm_page, parse: parse_dist_tags,
};

const CRATES: Registry = Registry {
    eco: "crates.io", who: "crates.io", locks: &["Cargo.lock"],
    valid: crate_name, latest_url: crate_url, page: crate_page, parse: parse_index,
};

/// `lost` counts the asks in a row that reached nobody: at `WORKERS` the rest of the read stops, or a
/// black-holed host costs `SECS` a name while holding one of the scan's few slots. A 429 or a 5xx counts:
/// a registry refusing or failing is not helped by the other 296 names. Any other status is an answer.
fn ask(ex: &dyn Exec, reg: &Registry, name: &str, lost: &AtomicUsize) -> Result<Answer, String> {
    if lost.load(Ordering::Relaxed) >= WORKERS {
        return Err(NO_ANSWER.into());
    }
    let r = match ex.http(&HttpReq { url: (reg.latest_url)(name), body: None, auth: None, secs: SECS, report: false }) {
        Ok(r) if r.code != 429 && r.code < 500 => {
            lost.store(0, Ordering::Relaxed);
            r
        }
        other => {
            lost.fetch_add(1, Ordering::Relaxed);
            return Err(other.map_or_else(|e| e, |r| format!("{} answered HTTP {}", reg.who, r.code)));
        }
    };
    match r.code {
        200 => (reg.parse)(&r.body).map_err(|e| format!("{} {e}", reg.who)),
        404 => Ok(Err("not on the registry")),
        c => Err(format!("{} answered HTTP {c}", reg.who)),
    }
}

/// One name's answer, shared while it is young; a failure is never kept, and whoever joined one asks again itself.
fn latest(ex: &dyn Exec, reg: &Registry, name: &str, force: bool, cache: &Cache, lost: &AtomicUsize) -> Result<Answer, String> {
    let key = (reg.eco, name.to_string());
    let mut mine = false;
    let got = cache.get(key.clone(), force, || {
        mine = true;
        ask(ex, reg, name, lost)
    });
    if got.is_ok() {
        return got;
    }
    cache.forget(|k| *k == key);
    if mine { got } else { ask(ex, reg, name, lost) }
}

/// Every name asked, `WORKERS` at a time, each answer at its name's index, until `over` says the read has
/// had its time. What it asked is kept per name, so the next read gets further.
fn ask_all(ex: &dyn Exec, reg: &Registry, names: &[String], force: bool, cache: &Cache, over: Over) -> Vec<Result<Answer, String>> {
    let (next, lost) = (AtomicUsize::new(0), AtomicUsize::new(0));
    let mut got: Vec<Option<Result<Answer, String>>> = vec![None; names.len()];
    std::thread::scope(|s| {
        let workers: Vec<_> = (0..WORKERS.min(names.len())).map(|_| s.spawn(|| {
            let mut out = vec![];
            loop {
                if over() {
                    break out;
                }
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(n) = names.get(i) else { break out };
                out.push((i, latest(ex, reg, n, force, cache, &lost)));
            }
        })).collect();
        for w in workers {
            for (i, r) in w.join().unwrap_or_default() {
                got[i] = Some(r);
            }
        }
    });
    got.into_iter().map(|r| r.unwrap_or_else(|| Err(NOT_ASKED.into()))).collect()
}

/// One `.npmrc`'s registry keys and nothing else in it. One that exists and cannot be read sends nothing.
#[derive(Default)]
struct Npmrc {
    other: bool,         // `registry=` names another registry
    scopes: Vec<String>, // `@scope:registry=` names another one for these
}

fn npmrc(dir: &Path) -> Npmrc {
    let mut rc = Npmrc::default();
    let text = match read_capped(&dir.join(".npmrc"), CONFIG_CAP) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return rc,
        Err(_) => return Npmrc { other: true, ..rc },
    };
    for line in text.lines().map(str::trim).filter(|l| !l.starts_with(['#', ';'])) {
        let Some((k, v)) = line.split_once('=') else { continue };
        let (k, v) = (k.trim(), v.trim().trim_matches(['"', '\'']).trim_end_matches('/').to_ascii_lowercase());
        let public = NPM_HOSTS.contains(&v.as_str());
        if k == "registry" {
            rc.other |= !public;
        } else if let Some(scope) = k.strip_suffix(":registry").filter(|s| s.starts_with('@') && !public) {
            rc.scopes.push(scope.to_string());
        }
    }
    rc
}

/// Where a copy came from, for a package never sent.
fn origin(from: &str) -> &'static str {
    let f = from.to_ascii_lowercase();
    if f.starts_with("file:") || f.starts_with("link:") || f.starts_with("path+") {
        "from a path"
    } else if f.starts_with("git") || f.starts_with("bitbucket") || f.starts_with("codeload.") || f.contains(".git#") || f.contains("gitlab.com/") {
        "from git"
    } else if f.starts_with("registry+") || f.starts_with("sparse+") {
        "from another registry"
    } else {
        "from a tarball or another registry"
    }
}

/// One name across every importer that declares it.
#[derive(Default)]
struct Want {
    importers: BTreeSet<String>,
    installed: BTreeSet<String>,
    from: Vec<String>,
    dev: Vec<Option<bool>>,
    held: Option<&'static str>, // never sent, and why
}

/// Every direct dependency the lockfiles list, by name. An npm name a `.npmrc` gives another registry
/// is held back, and a root `.npmrc` that moves npm itself makes the whole read unsupported.
fn wanted(root: &str, reg: &Registry, gaps: &mut Vec<String>) -> Result<BTreeMap<String, Want>, Coverage> {
    let files = found_paths(root, reg.locks);
    if files.is_empty() {
        return Err(Coverage::Unsupported { reason: format!("no lockfile to ask about ({})", reg.locks.join(", ")) });
    }
    let npm = reg.eco == NPM.eco;
    let base = if npm { npmrc(Path::new(root)) } else { Npmrc::default() };
    if base.other {
        return Err(Coverage::Unsupported { reason: "the project's .npmrc points npm at another registry, or could not be read".into() });
    }
    let (mut out, mut read, mut broken) = (BTreeMap::<String, Want>::new(), 0, false);
    for f in &files {
        let text = match read_capped(&Path::new(root).join(f), LOCK_BYTES) {
            Err(e) if e.kind() == std::io::ErrorKind::Other => {
                gaps.push(format!("{f} is {e}"));
                continue;
            }
            text => text,
        };
        let p = match text.map_err(|e| format!("{f}: {e}")).and_then(|t| crate::lockfile::parse(f, &t)) {
            Ok(p) => p,
            Err(e) => {
                broken = true;
                gaps.push(e);
                continue;
            }
        };
        if p.direct.is_empty() {
            gaps.extend(p.gaps);
            continue;
        }
        read += 1;
        let dir = f.rsplit_once('/').map_or("", |(d, _)| d);
        let here = if npm && !dir.is_empty() { npmrc(&Path::new(root).join(dir)) } else { Npmrc::default() };
        for d in p.direct.into_iter().filter(|d| d.ecosystem == reg.eco) {
            let Direct { importer, name, version, from, dev, .. } = d;
            let scoped = name.split_once('/').is_some_and(|(s, _)| base.scopes.iter().chain(&here.scopes).any(|x| x == s));
            let w = out.entry(name).or_default();
            // An npm importer is a folder, so one in a nested lockfile is named from the root.
            w.importers.insert(if npm && !dir.is_empty() { if importer == "." { dir.to_string() } else { format!("{dir}/{importer}") } } else { importer });
            if here.other || scoped {
                w.held = Some("from the registry an .npmrc names");
            }
            w.installed.extend(version);
            w.from.extend(from);
            w.dev.push(dev);
        }
    }
    if npm {
        gaps.extend(found_paths(root, &["yarn.lock"]).into_iter().map(|f| format!("{f} not read")));
    }
    if read == 0 {
        let why = if gaps.is_empty() { String::new() } else { format!(": {}", gaps.join("; ")) };
        return Err(if broken { Coverage::Error { reason: gaps.join("; ") } } else { Coverage::Unsupported { reason: format!("no direct dependency read{why}") } });
    }
    Ok(out)
}

/// Shipped as soon as one importer ships it; dev only when every one says so.
fn dev_of(w: &Want) -> Option<bool> {
    if w.dev.contains(&Some(false)) {
        Some(false)
    } else if !w.dev.is_empty() && w.dev.iter().all(|d| *d == Some(true)) {
        Some(true)
    } else {
        None
    }
}

/// The crates one Cargo.toml's own tables use, normal then dev or build, an inherited one counted.
/// `[workspace.dependencies]` only sets a version for whoever inherits it, so it says neither.
fn cargo_uses(text: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    let (mut normal, mut dev) = (BTreeSet::new(), BTreeSet::new());
    let Ok(doc) = text.parse::<toml::Table>() else { return (normal, dev) };
    let targets = doc.get("target").and_then(|t| t.as_table()).into_iter().flat_map(|t| t.values()).filter_map(|t| t.as_table());
    for scope in std::iter::once(&doc).chain(targets) {
        for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
            let table = scope.get(key).and_then(|t| t.as_table()).into_iter().flatten();
            let names = table.map(|(k, v)| v.get("package").and_then(|p| p.as_str()).unwrap_or(k).to_string());
            if key == "dependencies" { normal.extend(names) } else { dev.extend(names) }
        }
    }
    (normal, dev)
}

/// Cargo.lock says nothing of dev: the manifests at the root and one folder down do, for a name they use.
fn cargo_dev(root: &str, wants: &mut BTreeMap<String, Want>) {
    let found = found_paths(root, &["Cargo.toml"]);
    let uses: Vec<_> = found.iter().filter_map(|f| read_capped(&Path::new(root).join(f), CONFIG_CAP).ok()).map(|t| cargo_uses(&t)).collect();
    for (name, w) in wants.iter_mut() {
        let normal = uses.iter().any(|(n, _)| n.contains(name));
        let dev = uses.iter().any(|(_, d)| d.contains(name));
        w.dev = vec![if normal { Some(false) } else if dev { Some(true) } else { None }];
    }
}

fn read_with(ctx: &Ctx, ex: &dyn Exec, reg: &Registry, cache: &Cache, over: Over) -> Result<Read, Coverage> {
    let mut gaps = vec![];
    let mut wants = wanted(ctx.root, reg, &mut gaps)?;
    if reg.eco == CRATES.eco {
        cargo_dev(ctx.root, &mut wants);
    }
    // Why each name is never sent: held back, from elsewhere, unresolved, or not a name a registry takes.
    let why = |name: &str, w: &Want| -> Option<&'static str> {
        w.held.or_else(|| w.installed.is_empty().then(|| w.from.first().map_or("not resolved in the lockfile", |f| origin(f))))
            .or_else(|| (!(reg.valid)(name)).then_some("not a name the registry takes"))
    };
    let asked: Vec<String> = wants.iter().filter(|(n, w)| why(n, w).is_none()).map(|(n, _)| n.clone()).collect();
    let truncated = asked.len() > NAMES_CAP;
    let names = &asked[..asked.len().min(NAMES_CAP)];
    let answers: BTreeMap<&str, Result<Answer, String>> = names.iter().map(String::as_str).zip(ask_all(ex, reg, names, ctx.force, cache, over)).collect();
    let failed: Vec<(&str, &String)> = answers.iter().filter_map(|(n, a)| a.as_ref().err().map(|e| (*n, e))).collect();
    if !names.is_empty() && failed.len() == names.len() {
        let reasons: BTreeSet<&str> = failed.iter().map(|(_, e)| e.as_str()).collect();
        return Err(Coverage::Error { reason: reasons.into_iter().collect::<Vec<_>>().join("; ") });
    }
    let (late, failed): (Vec<_>, Vec<_>) = failed.into_iter().partition(|(_, e)| e.as_str() == NOT_ASKED);
    gaps.extend(failed.iter().take(GAPS_SHOWN).map(|(n, e)| format!("{n}: {e}")));
    if failed.len() > GAPS_SHOWN {
        gaps.push(format!("{} more names failed", failed.len() - GAPS_SHOWN));
    }
    if !late.is_empty() {
        gaps.push(format!("{} names not asked: a read stops after {}s, and the next one gets further", late.len(), BUDGET.as_secs()));
    }
    let (mut items, mut current) = (vec![], 0u32);
    for (name, w) in &wants {
        let held = why(name, w);
        let (latest, said) = match (held, answers.get(name.as_str())) {
            (Some(h), _) => (None, Some(h)),
            (None, None) => continue, // past the cap: `truncated` says so
            (None, Some(Ok(Ok(l)))) => (Some(l.clone()), None),
            (None, Some(Ok(Err(e)))) => (None, Some(*e)),
            (None, Some(Err(e))) => (None, Some(if e == NOT_ASKED { NOT_ASKED } else { NO_ANSWER })),
        };
        // At or past its newest everywhere it is installed: counted, never on the wire.
        if latest.as_deref().is_some_and(|l| w.installed.iter().all(|v| v == l || ver(v) > ver(l))) {
            current += 1;
            continue;
        }
        items.push(PkgLatest {
            name: name.clone(), ecosystem: reg.eco.to_string(), importers: w.importers.iter().cloned().collect(),
            installed: w.installed.iter().cloned().collect(), latest, dev: dev_of(w),
            url: held.is_none().then(|| (reg.page)(name)), why: said.map(str::to_string),
        });
    }
    Ok(Read { facts: Facts::Packages { items, current }, truncated, gaps })
}

/// The direct npm dependencies and the registry's `latest` for each: a `public` read, so a scan makes
/// it only on a machine that opted in, and a click once.
pub(crate) fn npm_registry(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let start = Instant::now();
    read_with(ctx, ex, &NPM, &LATEST, &|| start.elapsed() >= BUDGET)
}

/// The direct crates.io dependencies and the index's newest release for each, as `npm_registry`.
pub(crate) fn crates_registry(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let start = Instant::now();
    read_with(ctx, ex, &CRATES, &LATEST, &|| start.elapsed() >= BUDGET)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::MaintConfig;
    use crate::testutil::scratch_dir;

    const NONE: Forge = Forge { kind: ForgeKind::None, host: None, path: None, by: ForgeBy::None, api: None };
    const NPM_FILES: [(&str, &str); 3] =
        [("lodash", "npm-dist-tags-lodash.json"), ("minimist", "npm-dist-tags-minimist.json"), ("@types/minimist", "npm-dist-tags-types-minimist.json")];

    fn repo(files: &[(&str, &str)]) -> String {
        let dir = scratch_dir();
        for (rel, text) in files {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        dir.to_string_lossy().to_string()
    }

    fn fresh() -> Cache {
        Shared::new(KEEP, FORCE_KEEP, STALL)
    }

    /// The registries' recorded answers (2026-11-03) for the packages the recorded lockfiles name.
    fn answers() -> FakeExec {
        let mut ex = FakeExec::answering(Err("no answer"));
        for (name, file) in NPM_FILES {
            ex = ex.on(&["curl", &npm_url(name)], Ok(&FakeExec::testdata(file)));
        }
        for name in ["smallvec", "itoa"] {
            ex = ex.on(&["curl", &crate_url(name)], Ok(&FakeExec::testdata(&format!("crates-index-{name}.ndjson"))));
        }
        ex
    }

    fn read(root: &str, ex: &FakeExec, reg: &Registry, cache: &Cache, force: bool) -> Result<Read, Coverage> {
        read_with(&Ctx { root, cfg: &MaintConfig::default(), forge: &NONE, account: None, force, hosts: &[] }, ex, reg, cache, &|| false)
    }

    fn facts(r: &Read) -> (&[PkgLatest], u32) {
        match &r.facts {
            Facts::Packages { items, current } => (items, *current),
            other => panic!("not packages: {other:?}"),
        }
    }

    fn sent(ex: &FakeExec) -> Vec<String> {
        let mut urls: Vec<String> = ex.calls().into_iter().map(|c| c[1].clone()).collect();
        urls.sort();
        urls
    }

    /// A package-lock whose root declares `deps`, each installed at the version given and from npm.
    fn npm_lock(deps: &[(&str, &str)]) -> String {
        let decl: Vec<String> = deps.iter().map(|(n, v)| format!("\"{n}\": \"{v}\"")).collect();
        let pkgs: Vec<String> = deps.iter().map(|(n, v)| format!(",\"node_modules/{n}\": {{\"version\": \"{v}\", \"resolved\": \"https://registry.npmjs.org/{n}/-/x-{v}.tgz\"}}")).collect();
        format!("{{\"lockfileVersion\": 3, \"packages\": {{\"\": {{\"dependencies\": {{{}}}}}{}}}}}", decl.join(","), pkgs.concat())
    }

    #[test]
    fn dist_tags_name_npm_latest_and_the_index_its_newest_release() {
        let tags = |f: &str| parse_dist_tags(&FakeExec::testdata(f)).unwrap();
        assert_eq!(tags("npm-dist-tags-lodash.json"), Ok("4.18.1".into()));
        assert_eq!(tags("npm-dist-tags-minimist.json"), Ok("1.2.8".into()), "a backport tag is not the newest");
        assert_eq!(tags("npm-dist-tags-types-minimist.json"), Ok("1.2.5".into()), "only `latest` among the ts* tags");
        assert!(parse_dist_tags(&FakeExec::testdata("npm-dist-tags-missing.json")).is_err(), "a 404's body is no tag list");
        assert_eq!(parse_dist_tags("{\"next\": \"2.0.0\"}").unwrap(), Err("tags no release latest"));
        let index = |f: &str| parse_index(&FakeExec::testdata(f)).unwrap();
        assert_eq!(index("crates-index-smallvec.ndjson"), Ok("1.16.4".into()), "2.0.0-beta.4 and the yanked lines are skipped");
        assert_eq!(index("crates-index-itoa.ndjson"), Ok("1.0.18".into()));
        let lines = "{\"vers\":\"1.0.0\",\"yanked\":false}\n{\"vers\":\"1.1.0+build.7\",\"yanked\":false}\n\
                     {\"vers\":\"1.2.0-rc.1+x\",\"yanked\":false}\n{\"vers\":\"1.3.0\",\"yanked\":true}\n";
        assert_eq!(parse_index(lines).unwrap(), Ok("1.1.0+build.7".into()), "build metadata is no prerelease");
        assert_eq!(parse_index("{\"vers\":\"1.0.0\",\"yanked\":true}\n").unwrap(), Err("lists only yanked or prerelease versions"));
        for junk in ["", "<html>", "[]"] {
            assert!(parse_index(junk).is_err() && parse_dist_tags(junk).is_err(), "{junk:?}");
        }
        assert!(parse_index("{\"name\":\"x\"}").is_err(), "a line naming no version is no index");
    }

    #[test]
    fn the_sparse_index_path_depends_on_the_name_length() {
        assert_eq!(index_path("a"), "1/a");
        assert_eq!(index_path("cc"), "2/cc");
        assert_eq!(index_path("syn"), "3/s/syn");
        assert_eq!(index_path("Itoa"), "it/oa/itoa");
        assert_eq!(crate_url("smallvec"), "https://index.crates.io/sm/al/smallvec");
        assert_eq!(npm_url("@types/minimist"), "https://registry.npmjs.org/-/package/@types%2fminimist/dist-tags");
        assert!(npm_name("@types/minimist") && npm_name("lodash.merge") && !npm_name("@types") && !npm_name("a b") && !npm_name("../x"));
        assert!(crate_name("serde_json") && !crate_name("a/b") && !crate_name(""));
    }

    #[test]
    fn a_read_asks_each_direct_name_once_and_puts_only_what_is_behind_on_the_wire() {
        let root = repo(&[("package-lock.json", &FakeExec::testdata("lock-npm-v3.json")), ("pnpm-lock.yaml", &FakeExec::testdata("lock-pnpm-v9.yaml"))]);
        let ex = answers();
        let r = read(&root, &ex, &NPM, &fresh(), false).unwrap();
        assert_eq!(sent(&ex), [npm_url("@types/minimist"), npm_url("lodash"), npm_url("minimist")], "two lockfiles, one ask per name, no version, no path");
        let (items, current) = facts(&r);
        let got: Vec<_> = items.iter().map(|p| (p.name.as_str(), p.installed.clone(), p.latest.as_deref(), p.dev)).collect();
        assert_eq!(got, [("lodash", vec!["4.17.20".to_string()], Some("4.18.1"), Some(false)), ("minimist", vec!["1.2.5".to_string()], Some("1.2.8"), Some(false))]);
        assert_eq!(current, 1, "@types/minimist is at its newest: counted, not listed");
        assert_eq!((items[0].importers.clone(), items[0].url.as_deref()), (vec![".".to_string()], Some("https://www.npmjs.com/package/lodash")));
        assert!(!r.truncated && r.gaps.is_empty(), "{:?}", r.gaps);
        let cargo = repo(&[("src-tauri/Cargo.lock", &FakeExec::testdata("lock-cargo.lock")),
            ("src-tauri/Cargo.toml", "[package]\nname = \"rec\"\n[dependencies]\nsmallvec = \"1\"\n[dev-dependencies]\nitoa = \"1\"\n")]);
        let ex = answers();
        let r = read(&cargo, &ex, &CRATES, &fresh(), false).unwrap();
        assert_eq!(sent(&ex), [crate_url("itoa"), crate_url("smallvec")]);
        let (items, current) = facts(&r);
        let got: Vec<_> = items.iter().map(|p| (p.name.as_str(), p.importers.clone(), p.latest.as_deref(), p.dev)).collect();
        assert_eq!(got, [("smallvec", vec!["rec".to_string()], Some("1.16.4"), Some(false))], "the member's name declares it, and Cargo.toml says it ships");
        assert_eq!(current, 1);
    }

    #[test]
    fn what_another_registry_holds_is_never_sent() {
        let lock = r#"{"lockfileVersion": 3, "packages": {"": {"dependencies": {"lodash": "4", "@acme/ui": "1", "inhouse": "1", "fork": "1"}},
          "node_modules/lodash": {"version": "4.17.20", "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz"},
          "node_modules/@acme/ui": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/@acme/ui/-/ui-1.0.0.tgz"},
          "node_modules/inhouse": {"version": "1.0.0", "resolved": "https://npm.acme.example/inhouse/-/inhouse-1.0.0.tgz"},
          "node_modules/fork": {"version": "1.0.0", "resolved": "git+ssh://git@example.com/me/fork.git#abc"}}}"#;
        let root = repo(&[("package-lock.json", lock), (".npmrc", "; ours\n@acme:registry=https://npm.acme.example/\n//npm.acme.example/:_authToken=${TOKEN}\n")]);
        let ex = answers();
        let r = read(&root, &ex, &NPM, &fresh(), true).unwrap();
        assert_eq!(sent(&ex), [npm_url("lodash")], "a scope .npmrc moves, a resolved host and git stay here");
        let why: Vec<_> = facts(&r).0.iter().map(|p| (p.name.as_str(), p.why.as_deref(), p.url.is_some())).collect();
        assert_eq!(why, [("@acme/ui", Some("from the registry an .npmrc names"), false), ("fork", Some("from git"), false),
            ("inhouse", Some("from a tarball or another registry"), false), ("lodash", None, true)]);
        let moved = repo(&[("package-lock.json", lock), (".npmrc", "registry = \"https://npm.acme.example/\"\n")]);
        let ex = answers();
        assert!(matches!(read(&moved, &ex, &NPM, &fresh(), true), Err(Coverage::Unsupported { .. })), "npm itself is elsewhere");
        assert!(ex.calls().is_empty());
        let nested = repo(&[("web/package-lock.json", lock), ("web/.npmrc", "registry=https://npm.acme.example\n")]);
        let ex = answers();
        let r = read(&nested, &ex, &NPM, &fresh(), true).unwrap();
        assert!(ex.calls().is_empty(), "a folder's own .npmrc holds its lockfile back: {:?}", ex.calls());
        assert!(facts(&r).0.iter().all(|p| p.importers == ["web"] && p.why.is_some()));
        let public = repo(&[("package-lock.json", lock), (".npmrc", "registry=https://registry.npmjs.org/\n")]);
        assert!(read(&public, &answers(), &NPM, &fresh(), true).is_ok(), "the default registry spelt out is no move");
    }

    #[test]
    fn a_404_is_an_item_one_failed_name_a_gap_and_none_answering_an_error() {
        let root = repo(&[("package-lock.json", &npm_lock(&[("lodash", "4.17.20"), ("left-pad-ghost", "1.0.0"), ("minimist", "1.2.5")]))]);
        let ghost = npm_url("left-pad-ghost");
        let ex = answers().on(&["curl", &ghost], Ok(&FakeExec::testdata("npm-dist-tags-missing.json"))).coded(&["curl", &ghost], 404);
        let cache = fresh();
        let r = read(&root, &ex, &NPM, &cache, true).unwrap();
        let ghost_item = facts(&r).0.iter().find(|p| p.name == "left-pad-ghost").unwrap();
        assert_eq!((ghost_item.latest.as_deref(), ghost_item.why.as_deref()), (None, Some("not on the registry")));
        assert!(r.gaps.is_empty(), "a 404 is an answer: {:?}", r.gaps);
        let ex = answers().coded(&["curl", &npm_url("minimist")], 503);
        let r = read(&root, &ex, &NPM, &fresh(), true).unwrap();
        assert_eq!(r.gaps.iter().filter(|g| g.starts_with("minimist: ")).count(), 1, "{:?}", r.gaps);
        let m = facts(&r).0.iter().find(|p| p.name == "minimist").unwrap();
        assert_eq!(m.why.as_deref(), Some("the registry did not answer"), "unknown, so never counted current");
        let Err(Coverage::Error { reason }) = read(&root, &FakeExec::answering(Ok("<html>")), &NPM, &fresh(), true) else { panic!() };
        assert_eq!(reason, "the npm registry answered something that is not JSON");
    }

    #[test]
    fn a_registry_that_reaches_nobody_stops_being_asked() {
        let deps: Vec<(String, &str)> = (0..NAMES_CAP).map(|i| (format!("p{i:03}"), "1.0.0")).collect();
        let refs: Vec<(&str, &str)> = deps.iter().map(|(n, v)| (n.as_str(), *v)).collect();
        let root = repo(&[("package-lock.json", &npm_lock(&refs))]);
        let ex = FakeExec::answering(Err("Operation timed out"));
        let Err(Coverage::Error { reason }) = read(&root, &ex, &NPM, &fresh(), true) else { panic!() };
        assert!(reason.contains("Operation timed out"), "{reason}");
        assert!(ex.calls().len() <= 2 * WORKERS, "a black hole costs one timeout a worker, not 25 minutes: {}", ex.calls().len());
        for code in [503, 429] {
            let status = FakeExec::answering(Ok("")).coded(&["curl"], code);
            assert!(matches!(read(&root, &status, &NPM, &fresh(), true), Err(Coverage::Error { .. })));
            assert!(status.calls().len() <= 2 * WORKERS, "{code} is no reason to ask 296 more times: {}", status.calls().len());
        }
        let gone = FakeExec::answering(Ok("")).coded(&["curl"], 404);
        let r = read(&root, &gone, &NPM, &fresh(), true).unwrap();
        assert_eq!((gone.calls().len(), facts(&r).0.len()), (NAMES_CAP, NAMES_CAP), "a 404 says something about that name alone");
        let some = repo(&[("package-lock.json", &npm_lock(&[("lodash", "4.17.20"), ("x1", "1.0.0"), ("x2", "1.0.0"), ("x3", "1.0.0"), ("minimist", "1.2.5")]))]);
        let few = answers();
        let r = read(&some, &few, &NPM, &fresh(), true).unwrap();
        assert_eq!(few.calls().len(), 5, "three names timing out never stop the rest");
        assert_eq!(r.gaps.len(), 3, "{:?}", r.gaps);
        let long: Vec<(String, &str)> = (0..20).map(|i| (format!("p{i:02}"), "1.0.0")).collect();
        let mut refs: Vec<(&str, &str)> = long.iter().map(|(n, v)| (n.as_str(), *v)).collect();
        refs.push(("lodash", "4.17.20"));
        let many = repo(&[("package-lock.json", &npm_lock(&refs))]);
        let ex = answers().coded(&["curl", &npm_url("lodash")], 200).coded(&["curl"], 503);
        let r = read(&many, &ex, &NPM, &fresh(), true).unwrap();
        assert_eq!((facts(&r).0.len(), r.gaps.len(), r.gaps.last().unwrap().as_str()), (21, GAPS_SHOWN + 1, "12 more names failed"), "every name stays unplaced, and the tip stays short");
    }

    #[test]
    fn a_read_out_of_time_stops_asking_says_so_and_the_next_one_gets_further() {
        let deps: Vec<(String, &str)> = (0..40).map(|i| (format!("p{i:02}"), "1.0.0")).collect();
        let refs: Vec<(&str, &str)> = deps.iter().map(|(n, v)| (n.as_str(), *v)).collect();
        let root = repo(&[("package-lock.json", &npm_lock(&refs))]);
        let ctx = Ctx { root: &root, cfg: &MaintConfig::default(), forge: &NONE, account: None, force: false, hosts: &[] };
        let (cache, polls) = (fresh(), AtomicUsize::new(0));
        let first = FakeExec::answering(Ok("{\"latest\": \"2.0.0\"}"));
        let r = read_with(&ctx, &first, &NPM, &cache, &|| polls.fetch_add(1, Ordering::Relaxed) >= 10).unwrap();
        assert_eq!(first.calls().len(), 10, "no name is asked once the time is up");
        assert_eq!(r.gaps, ["30 names not asked: a read stops after 60s, and the next one gets further"]);
        let unasked = facts(&r).0.iter().filter(|p| p.why.as_deref() == Some(NOT_ASKED)).count();
        assert_eq!((unasked, facts(&r).0.len()), (30, 40), "unplaced, so never counted as current");
        let next = FakeExec::answering(Ok("{\"latest\": \"2.0.0\"}"));
        let r = read_with(&ctx, &next, &NPM, &cache, &|| false).unwrap();
        assert_eq!((next.calls().len(), r.gaps.len()), (30, 0), "the 10 it has are not asked twice");
        let none = read_with(&ctx, &next, &NPM, &fresh(), &|| true);
        assert!(matches!(none, Err(Coverage::Error { ref reason }) if reason == NOT_ASKED), "nothing asked is no read");
    }

    #[test]
    fn past_the_cap_a_read_is_truncated() {
        let deps: Vec<(String, &str)> = (0..=NAMES_CAP).map(|i| (format!("p{i:03}"), "1.0.0")).collect();
        let refs: Vec<(&str, &str)> = deps.iter().map(|(n, v)| (n.as_str(), *v)).collect();
        let root = repo(&[("package-lock.json", &npm_lock(&refs))]);
        let ex = FakeExec::answering(Ok("{\"latest\": \"2.0.0\"}"));
        let r = read(&root, &ex, &NPM, &fresh(), true).unwrap();
        assert!(r.truncated);
        assert_eq!((ex.calls().len(), facts(&r).0.len()), (NAMES_CAP, NAMES_CAP));
    }

    #[test]
    fn answers_are_kept_per_name_across_projects_and_a_forced_read_takes_only_a_young_one() {
        let cache = fresh();
        let a = repo(&[("package-lock.json", &npm_lock(&[("lodash", "4.17.20")]))]);
        let first = answers();
        read(&a, &first, &NPM, &cache, false).unwrap();
        assert_eq!(first.calls().len(), 1);
        let b = repo(&[("pnpm-lock.yaml", &FakeExec::testdata("lock-pnpm-v9.yaml"))]);
        let again = answers();
        read(&b, &again, &NPM, &cache, false).unwrap();
        assert_eq!(sent(&again), [npm_url("@types/minimist"), npm_url("minimist")], "another project's lodash asks nothing");
        let young = answers();
        read(&a, &young, &NPM, &cache, true).unwrap();
        assert!(young.calls().is_empty(), "a forced read joins an answer under ten minutes old");
        cache.age(FORCE_KEEP, |_| true);
        let old = answers();
        read(&a, &old, &NPM, &cache, true).unwrap();
        assert_eq!(old.calls().len(), 1, "and asks past one older");
        let failing = repo(&[("package-lock.json", &npm_lock(&[("minimist", "1.2.5"), ("lodash", "1"), ("left", "1")]))]);
        let cache = fresh();
        read(&failing, &answers(), &NPM, &cache, false).unwrap();
        assert!(cache.holds(|k| k.1 == "minimist") && !cache.holds(|k| k.1 == "left"), "a failure is never kept");
    }

    #[test]
    fn crates_from_git_are_named_and_never_sent() {
        let lock = "version = 4\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\ndependencies = [\n \"itoa\",\n \"forked\",\n]\n\
                    [[package]]\nname = \"itoa\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\
                    [[package]]\nname = \"forked\"\nversion = \"0.3.0\"\nsource = \"git+https://example.com/forked#abc\"\n";
        let root = repo(&[("Cargo.lock", lock)]);
        let ex = answers();
        let r = read(&root, &ex, &CRATES, &fresh(), true).unwrap();
        assert_eq!(sent(&ex), [crate_url("itoa")]);
        let got: Vec<_> = facts(&r).0.iter().map(|p| (p.name.as_str(), p.latest.as_deref(), p.why.as_deref(), p.dev)).collect();
        assert_eq!(got, [("forked", None, Some("from git"), None), ("itoa", Some("1.0.18"), None, None)], "no Cargo.toml, so dev is unknown");
    }

    #[test]
    fn a_crate_a_workspace_only_declares_is_judged_by_the_tables_that_use_it() {
        let entry = |n: &str| format!("[[package]]\nname = \"{n}\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n");
        let lock = format!("version = 4\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\ndependencies = [\n \"criterion\",\n \"nowhere\",\n \"serde\",\n \"tokio\",\n \"winsys\",\n]\n{}",
            ["criterion", "nowhere", "serde", "tokio", "winsys"].map(entry).concat());
        let root = repo(&[("Cargo.lock", &lock),
            ("Cargo.toml", "[workspace]\nmembers = [\"app\"]\n[workspace.dependencies]\ncriterion = \"0.5\"\nserde = \"1\"\ntokio = \"1\"\nnowhere = \"1\"\n"),
            ("app/Cargo.toml", "[package]\nname = \"app\"\n[dependencies]\nserde.workspace = true\nrt = { package = \"tokio\", workspace = true }\n\
                                [dev-dependencies]\ncriterion.workspace = true\n[target.'cfg(windows)'.dependencies]\nwinsys = \"1\"\n")]);
        let ex = FakeExec::answering(Ok("{\"vers\":\"9.0.0\",\"yanked\":false}\n"));
        let r = read(&root, &ex, &CRATES, &fresh(), true).unwrap();
        let got: Vec<_> = facts(&r).0.iter().map(|p| (p.name.as_str(), p.dev)).collect();
        assert_eq!(got, [("criterion", Some(true)), ("nowhere", None), ("serde", Some(false)), ("tokio", Some(false)), ("winsys", Some(false))],
            "a version the workspace sets ships nothing by itself");
    }

    #[test]
    fn no_lockfile_none_readable_or_none_naming_a_dependency_is_never_an_empty_answer() {
        assert!(matches!(read(&repo(&[("README.md", "x")]), &answers(), &NPM, &fresh(), true), Err(Coverage::Unsupported { .. })));
        let v1 = repo(&[("package-lock.json", r#"{"lockfileVersion": 1, "dependencies": {"a": {"version": "1.0.0"}}}"#)]);
        let Err(Coverage::Unsupported { reason }) = read(&v1, &answers(), &NPM, &fresh(), true) else { panic!() };
        assert!(reason.contains("lockfileVersion 1 not read"), "{reason}");
        let empty = repo(&[("package-lock.json", r#"{"lockfileVersion": 3, "packages": {"": {"name": "x"}}}"#)]);
        assert!(matches!(read(&empty, &answers(), &NPM, &fresh(), true), Err(Coverage::Unsupported { .. })), "an importer the parser missed never reads as nothing behind");
        let broken = repo(&[("package-lock.json", "<html>")]);
        assert!(matches!(read(&broken, &answers(), &NPM, &fresh(), true), Err(Coverage::Error { .. })));
        let yarn = repo(&[("package-lock.json", &npm_lock(&[("lodash", "4.17.20")])), ("yarn.lock", "")]);
        assert_eq!(read(&yarn, &answers(), &NPM, &fresh(), true).unwrap().gaps, ["yarn.lock not read"]);
    }

    #[test]
    fn the_files_detection_offers_each_on_are_the_files_it_reads() {
        let man: Value = serde_json::from_str(include_str!("../../src/maintmanifest.json")).unwrap();
        for (id, reg) in [("npm-registry", &NPM), ("crates-registry", &CRATES)] {
            let detect: Vec<&str> = man.pointer(&format!("/sources/{id}/detect")).and_then(Value::as_array).unwrap()
                .iter().filter_map(Value::as_str).collect();
            assert_eq!(detect, reg.locks, "{id}");
            assert!(reg.locks.iter().all(|l| crate::lockfile::LOCKFILES.contains(l)));
        }
    }
}
