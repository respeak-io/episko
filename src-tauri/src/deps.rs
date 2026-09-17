// Dependency work: Dependabot's advisories, the update bots' pull requests, what the
// manifests declare, and what a package manager says is out of date. Reads only — every
// verb this feeds is an agent someone dispatched. Rules in src/deps.ts; docs/dependencies.md.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::github::{classify, gh, who_for};
use crate::platform::{augmented_path, sys_command};

const TTL: Duration = Duration::from_secs(120);
/// A package manager resolving against a registry is a network call, not a disk read.
const OUTDATED_SECS: u64 = 120;

// ---------- what a read answers ----------

#[derive(serde::Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DepAlert {
    pub number: i64,
    pub state: String,
    pub pkg: String,
    pub ecosystem: String,
    pub manifest: String,
    pub scope: String,
    pub relationship: String,
    pub severity: String,
    pub ghsa: String,
    pub cve: Option<String>,
    pub summary: String,
    pub cvss: f64,
    pub epss: f64,
    pub range: String,
    pub patched: Option<String>,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChecksRollup {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
    pub skipped: u32,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DepPr {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub branch: String,
    pub labels: Vec<String>,
    pub draft: bool,
    pub updated_at: String,
    pub mergeable: String,
    pub merge_state: String,
    pub checks: ChecksRollup,
    pub bot: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub(crate) struct DepReport {
    pub available: bool,
    pub reason: Option<String>,
    pub alerts: Vec<DepAlert>,
    pub prs: Vec<DepPr>,
    pub enabled: bool,
}

impl DepReport {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self { available: false, reason: Some(reason.into()), alerts: vec![], prs: vec![], enabled: false }
    }
}

struct Cached { at: Instant, report: DepReport }
static CACHE: Mutex<Option<HashMap<String, Cached>>> = Mutex::new(None);

// ---------- alerts ----------

/// `gh api` substitutes `{owner}`/`{repo}` from the repo in cwd, so no slug is parsed here.
const ALERTS_PATH: &str = "repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100";

pub(crate) fn parse_alerts(json: &str) -> Vec<DepAlert> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(arr) = v.as_array() else { return vec![] };
    arr.iter()
        .filter_map(|o| {
            let number = o.get("number")?.as_i64()?;
            let dep = o.get("dependency");
            let adv = o.get("security_advisory");
            let vuln = o.get("security_vulnerability");
            let pkg = dep
                .and_then(|d| d.get("package"))
                .or_else(|| vuln.and_then(|x| x.get("package")));
            let s = |v: Option<&serde_json::Value>, k: &str| {
                v.and_then(|x| x.get(k)).and_then(|x| x.as_str()).unwrap_or("").to_string()
            };
            Some(DepAlert {
                number,
                state: s(Some(o), "state"),
                pkg: s(pkg, "name"),
                ecosystem: s(pkg, "ecosystem"),
                manifest: s(dep, "manifest_path"),
                scope: s(dep, "scope"),
                relationship: s(dep, "relationship"),
                // The advisory's severity is the repo-wide one; the vulnerability's is per
                // package and is what the alert is actually filed at.
                severity: {
                    let per_pkg = s(vuln, "severity");
                    if per_pkg.is_empty() { s(adv, "severity") } else { per_pkg }
                },
                ghsa: s(adv, "ghsa_id"),
                cve: adv.and_then(|a| a.get("cve_id")).and_then(|x| x.as_str()).map(String::from),
                summary: s(adv, "summary"),
                cvss: adv
                    .and_then(|a| a.get("cvss"))
                    .and_then(|c| c.get("score"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
                epss: adv
                    .and_then(|a| a.get("epss"))
                    .and_then(|c| c.get("percentage"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
                range: s(vuln, "vulnerable_version_range"),
                patched: vuln
                    .and_then(|x| x.get("first_patched_version"))
                    .and_then(|f| f.get("identifier"))
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                url: s(Some(o), "html_url"),
                created_at: s(Some(o), "created_at"),
                updated_at: s(Some(o), "updated_at"),
            })
        })
        .collect()
}

// ---------- the bots' pull requests ----------

const PR_FIELDS: &str = "number,title,url,author,labels,updatedAt,headRefName,isDraft,mergeable,mergeStateStatus,statusCheckRollup";

/// `dependabot[bot]`, `app/renovate`, `renovate-bot` — one name per bot, "" for a human.
pub(crate) fn bot_of(login: &str) -> String {
    let l = login.to_lowercase();
    let l = l.strip_suffix("[bot]").unwrap_or(&l);
    let l = l.strip_prefix("app/").unwrap_or(l);
    match l {
        "dependabot" | "dependabot-preview" => "dependabot".into(),
        "renovate" | "renovate-bot" => "renovate".into(),
        _ => String::new(),
    }
}

/// A check run's `conclusion` where it has finished, its `status`/`state` where it has not.
/// Both shapes appear in one array: `CheckRun` and the older `StatusContext`.
fn roll_checks(v: Option<&serde_json::Value>) -> ChecksRollup {
    let mut r = ChecksRollup::default();
    let Some(arr) = v.and_then(|x| x.as_array()) else { return r };
    for c in arr {
        r.total += 1;
        let status = c.get("status").and_then(|x| x.as_str()).unwrap_or("").to_uppercase();
        let concl = c
            .get("conclusion")
            .and_then(|x| x.as_str())
            .map(str::to_uppercase)
            .filter(|s| !s.is_empty())
            .or_else(|| c.get("state").and_then(|x| x.as_str()).map(str::to_uppercase))
            .unwrap_or_default();
        if status == "IN_PROGRESS" || status == "QUEUED" || status == "PENDING" || concl == "PENDING" {
            r.pending += 1;
        } else if concl == "SUCCESS" || concl == "NEUTRAL" {
            r.passed += 1;
        } else if concl == "SKIPPED" {
            r.skipped += 1;
        } else if concl.is_empty() {
            r.pending += 1;
        } else {
            r.failed += 1;
        }
    }
    r
}

pub(crate) fn parse_bot_prs(json: &str) -> Vec<DepPr> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(arr) = v.as_array() else { return vec![] };
    arr.iter()
        .filter_map(|o| {
            let author = o
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let bot = bot_of(author);
            if bot.is_empty() {
                return None; // a human's PR belongs on the Open work board, not here
            }
            let s = |k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            Some(DepPr {
                number: o.get("number")?.as_i64()?,
                title: s("title"),
                url: s("url"),
                author: author.to_string(),
                branch: s("headRefName"),
                labels: o
                    .get("labels")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
                    .unwrap_or_default(),
                draft: o.get("isDraft").and_then(serde_json::Value::as_bool).unwrap_or(false),
                updated_at: s("updatedAt"),
                mergeable: s("mergeable"),
                merge_state: s("mergeStateStatus"),
                checks: roll_checks(o.get("statusCheckRollup")),
                bot,
            })
        })
        .collect()
}

/// Alerts and the bots' PRs, cached for TTL. Degrades to `available: false` plus a reason,
/// like every other gh read; `force` is an explicit refresh, never a repaint.
#[tauri::command]
pub(crate) async fn dep_report(root: String, force: bool, account: Option<String>) -> DepReport {
    tauri::async_runtime::spawn_blocking(move || {
        if !force {
            if let Ok(guard) = CACHE.lock() {
                if let Some(hit) = guard.as_ref().and_then(|m| m.get(&root)) {
                    if hit.at.elapsed() < TTL {
                        return hit.report.clone();
                    }
                }
            }
        }
        let acct = account.as_deref();
        // Two processes and two round trips that need nothing from each other, as `gh_threads` does.
        let (alerts, prs) = std::thread::scope(|s| {
            let a = s.spawn(|| gh(&root, acct, &["api", ALERTS_PATH]));
            let p = s.spawn(|| {
                gh(&root, acct, &["pr", "list", "--state", "open", "--limit", "60", "--json", PR_FIELDS])
            });
            (
                a.join().unwrap_or_else(|_| Err("gh api panicked".into())),
                p.join().unwrap_or_else(|_| Err("gh pr list panicked".into())),
            )
        });
        let bot_prs = prs.map(|j| parse_bot_prs(&j)).unwrap_or_default();
        let report = match alerts {
            // A PR list that answered is still a board: the alert half is the one that
            // needs a scope most people's gh has never been granted.
            Err(e) => DepReport {
                available: !bot_prs.is_empty(),
                reason: Some(classify_deps(&e, who_for(acct).as_deref())),
                alerts: vec![],
                prs: bot_prs,
                enabled: false,
            },
            Ok(json) => DepReport {
                available: true,
                reason: None,
                alerts: parse_alerts(&json),
                prs: bot_prs,
                enabled: true,
            },
        };
        if let Ok(mut guard) = CACHE.lock() {
            guard.get_or_insert_with(HashMap::new)
                .insert(root.clone(), Cached { at: Instant::now(), report: report.clone() });
        }
        report
    })
    .await
    .unwrap_or_else(|e| DepReport::unavailable(format!("gh task failed: {e}")))
}

/// The alerts endpoint fails in two ways nothing else does, and both read as "not found"
/// unless they are named: a token without `security_events`, and a repo with the feature off.
pub(crate) fn classify_deps(err: &str, who: Option<&str>) -> String {
    let e = err.to_lowercase();
    if e.contains("security_events") || e.contains("admin:repo_hook") || e.contains("not authorized") {
        return "gh's token cannot read security alerts — run `gh auth refresh -h github.com -s security_events`".into();
    }
    if e.contains("dependabot alerts are disabled") || e.contains("advanced security") {
        return "Dependabot alerts are switched off for this repository".into();
    }
    classify(err, who)
}

#[tauri::command]
pub(crate) fn dep_invalidate(root: String) {
    if let Ok(mut guard) = CACHE.lock() {
        if let Some(m) = guard.as_mut() {
            m.remove(&root);
        }
    }
}

// ---------- what the manifests declare ----------

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct DepManifest {
    pub path: String,
    pub ecosystem: String,
    pub ranges: BTreeMap<String, String>,
    pub dev: Vec<String>,
}

/// Every manifest worth reading, at the root and one level down (a workspace's members
/// live there). Never a recursive walk: `node_modules` and `target` are the common case
/// and a deep scan of either buys nothing the lockfile does not already answer.
const MANIFESTS: &[(&str, &str)] = &[
    ("package.json", "npm"),
    ("Cargo.toml", "cargo"),
    ("pyproject.toml", "pip"),
    ("requirements.txt", "pip"),
    ("go.mod", "go"),
];

#[tauri::command]
pub(crate) async fn dep_manifests(root: String) -> Vec<DepManifest> {
    tauri::async_runtime::spawn_blocking(move || read_manifests(Path::new(&root)))
        .await
        .unwrap_or_default()
}

const SKIP_DIRS: &[&str] = &["node_modules", "target", ".git", "dist", "vendor", ".venv", "venv"];

pub(crate) fn read_manifests(root: &Path) -> Vec<DepManifest> {
    let mut out = vec![];
    for (file, eco) in MANIFESTS {
        if let Some(m) = read_manifest(&root.join(file), file, eco) {
            out.push(m);
        }
    }
    let Ok(rd) = std::fs::read_dir(root) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) || !e.path().is_dir() {
            continue;
        }
        for (file, eco) in MANIFESTS {
            if let Some(m) = read_manifest(&e.path().join(file), &format!("{name}/{file}"), eco) {
                out.push(m);
            }
        }
    }
    out
}

fn read_manifest(path: &Path, rel: &str, eco: &str) -> Option<DepManifest> {
    let text = std::fs::read_to_string(path).ok()?;
    let (ranges, dev) = match (eco, rel.rsplit('/').next().unwrap_or(rel)) {
        ("npm", _) => parse_package_json(&text),
        ("cargo", _) => parse_cargo_toml(&text),
        ("pip", "pyproject.toml") => parse_pyproject(&text),
        ("pip", _) => parse_requirements(&text),
        ("go", _) => parse_go_mod(&text),
        _ => return None,
    };
    // An empty manifest is still a fact: it says this ecosystem is here and declares nothing
    // directly, which is what turns a transitive alert's verdict from "unknown" into "via a parent".
    Some(DepManifest { path: rel.to_string(), ecosystem: eco.to_string(), ranges, dev })
}

type Declared = (BTreeMap<String, String>, Vec<String>);

fn parse_package_json(text: &str) -> Declared {
    let mut ranges = BTreeMap::new();
    let mut dev = vec![];
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return (ranges, dev) };
    for key in ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] {
        let Some(map) = v.get(key).and_then(|x| x.as_object()) else { continue };
        for (name, spec) in map {
            let Some(range) = spec.as_str() else { continue };
            // First writer wins: a package in both dependencies and devDependencies ships.
            ranges.entry(name.clone()).or_insert_with(|| range.to_string());
            if key == "devDependencies" && !ranges.contains_key(name.as_str()) {
                dev.push(name.clone());
            }
        }
        if key == "devDependencies" {
            for name in map.keys() {
                let shipped = ["dependencies", "optionalDependencies", "peerDependencies"]
                    .iter()
                    .any(|k| v.get(k).and_then(|x| x.get(name)).is_some());
                if !shipped && !dev.contains(name) {
                    dev.push(name.clone());
                }
            }
        }
    }
    (ranges, dev)
}

/// `serde = "1"`, `serde = { version = "1", … }`, and `workspace = true`, which declares a
/// version somewhere else entirely and must not be reported as a range of its own.
fn parse_cargo_toml(text: &str) -> Declared {
    let mut ranges = BTreeMap::new();
    let mut dev = vec![];
    let Ok(doc) = text.parse::<toml::Table>() else { return (ranges, dev) };
    let mut tables: Vec<(&str, &toml::Table)> = vec![];
    for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(t) = doc.get(key).and_then(|x| x.as_table()) {
            tables.push((key, t));
        }
        // A workspace root declares the versions its members inherit.
        if let Some(t) = doc.get("workspace").and_then(|w| w.get(key)).and_then(|x| x.as_table()) {
            tables.push((key, t));
        }
    }
    for (key, t) in tables {
        for (name, spec) in t {
            let range = match spec {
                toml::Value::String(s) => Some(s.clone()),
                toml::Value::Table(tt) => tt.get("version").and_then(|v| v.as_str()).map(String::from),
                _ => None,
            };
            let Some(range) = range else { continue };
            ranges.entry(name.clone()).or_insert(range);
            if key != "dependencies" && !dev.contains(name) {
                dev.push(name.clone());
            }
        }
    }
    dev.retain(|n| doc.get("dependencies").and_then(|d| d.get(n)).is_none());
    (ranges, dev)
}

/// PEP 621's `[project] dependencies = ["foo>=1,<2"]` plus Poetry's own table.
fn parse_pyproject(text: &str) -> Declared {
    let mut ranges = BTreeMap::new();
    let mut dev = vec![];
    let Ok(doc) = text.parse::<toml::Table>() else { return (ranges, dev) };
    let list = doc.get("project").and_then(|p| p.get("dependencies")).and_then(|d| d.as_array());
    for item in list.into_iter().flatten() {
        if let Some((name, range)) = item.as_str().and_then(split_pep508) {
            ranges.entry(name).or_insert(range);
        }
    }
    let poetry = doc.get("tool").and_then(|t| t.get("poetry"));
    for (key, is_dev) in [("dependencies", false), ("dev-dependencies", true)] {
        let Some(t) = poetry.and_then(|p| p.get(key)).and_then(|x| x.as_table()) else { continue };
        for (name, spec) in t {
            if name == "python" {
                continue;
            }
            let range = match spec {
                toml::Value::String(s) => s.clone(),
                toml::Value::Table(tt) => tt.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                _ => continue,
            };
            ranges.entry(name.clone()).or_insert(range);
            if is_dev && !dev.contains(name) {
                dev.push(name.clone());
            }
        }
    }
    (ranges, dev)
}

/// `name[extra] >= 1.0, < 2 ; marker` — the name, and everything up to the marker.
fn split_pep508(line: &str) -> Option<(String, String)> {
    let body = line.split(';').next()?.trim();
    let cut = body.find(|c: char| "<>=!~ (".contains(c)).unwrap_or(body.len());
    let name = body[..cut].split('[').next()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some((name, body[cut..].replace(['(', ')'], "").trim().to_string()))
}

fn parse_requirements(text: &str) -> Declared {
    let mut ranges = BTreeMap::new();
    for line in text.lines() {
        let l = line.split('#').next().unwrap_or("").trim();
        if l.is_empty() || l.starts_with('-') {
            continue;
        }
        if let Some((name, range)) = split_pep508(l) {
            ranges.entry(name).or_insert(range);
        }
    }
    (ranges, vec![])
}

/// `require foo v1.2.3` and the parenthesised block form; `// indirect` is transitive.
fn parse_go_mod(text: &str) -> Declared {
    let mut ranges = BTreeMap::new();
    let mut dev = vec![];
    let mut in_block = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with("require (") {
            in_block = true;
            continue;
        }
        if in_block && l == ")" {
            in_block = false;
            continue;
        }
        let body = if in_block { l } else { l.strip_prefix("require ").unwrap_or("") };
        let indirect = body.contains("// indirect");
        let body = body.split("//").next().unwrap_or("").trim();
        let mut it = body.split_whitespace();
        let (Some(name), Some(ver)) = (it.next(), it.next()) else { continue };
        if !ver.starts_with('v') {
            continue;
        }
        ranges.insert(name.to_string(), ver.to_string());
        if indirect {
            dev.push(name.to_string());
        }
    }
    (ranges, dev)
}

// ---------- what a package manager says ----------

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct DepTool {
    pub id: String,
    pub label: String,
    pub cmd: String,
    pub blocked: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Default)]
pub(crate) struct Outdated {
    pub pkg: String,
    pub current: String,
    pub wanted: String,
    pub latest: String,
    pub kind: String,
    pub deprecated: bool,
}

#[derive(serde::Serialize, Clone, Debug)]
pub(crate) struct OutdatedRun {
    pub tool: String,
    pub ok: bool,
    pub reason: Option<String>,
    pub rows: Vec<Outdated>,
}

impl OutdatedRun {
    fn failed(tool: &str, reason: impl Into<String>) -> Self {
        Self { tool: tool.into(), ok: false, reason: Some(reason.into()), rows: vec![] }
    }
}

/// Which manager this project actually uses, from the lockfile rather than from taste: a
/// repo with a `pnpm-lock.yaml` must never be offered `npm outdated`, which would resolve
/// a tree it does not have.
fn js_tool(root: &Path) -> Option<(&'static str, &'static str, &'static str)> {
    if root.join("pnpm-lock.yaml").exists() {
        return Some(("pnpm", "pnpm", "pnpm outdated --format json"));
    }
    if root.join("yarn.lock").exists() {
        return Some(("yarn", "yarn", "yarn outdated --json"));
    }
    if root.join("package.json").exists() {
        return Some(("npm", "npm", "npm outdated --json"));
    }
    None
}

/// What could be asked here, each either runnable or blocked with the reason. A tool that
/// simply does not apply is absent; a tool that applies and cannot run says why (tasks.rs's rule).
#[tauri::command]
pub(crate) async fn dep_tools(root: String) -> Vec<DepTool> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&root);
        let mut out = vec![];
        if let Some((id, bin, cmd)) = js_tool(p) {
            out.push(DepTool {
                id: id.into(),
                label: format!("{id} outdated"),
                cmd: cmd.into(),
                blocked: if on_path(bin) { None } else { Some(format!("{bin} is not on PATH")) },
            });
        }
        if p.join("Cargo.toml").exists() {
            let blocked = if !on_path("cargo") {
                Some("cargo is not on PATH".to_string())
            } else if !cargo_outdated_present() {
                Some("cargo-outdated is not installed — `cargo install cargo-outdated`".to_string())
            } else {
                None
            };
            out.push(DepTool {
                id: "cargo".into(),
                label: "cargo outdated".into(),
                cmd: "cargo outdated --root-deps-only --format json".into(),
                blocked,
            });
        }
        if p.join("go.mod").exists() {
            out.push(DepTool {
                id: "go".into(),
                label: "go list -u".into(),
                cmd: "go list -m -u -json all".into(),
                blocked: if on_path("go") { None } else { Some("go is not on PATH".into()) },
            });
        }
        if p.join("requirements.txt").exists() || p.join("pyproject.toml").exists() {
            out.push(DepTool {
                id: "pip".into(),
                label: "pip outdated".into(),
                cmd: "pip list --outdated --format=json".into(),
                blocked: if on_path("pip") { None } else { Some("pip is not on PATH".into()) },
            });
        }
        out
    })
    .await
    .unwrap_or_default()
}

fn on_path(bin: &str) -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    sys_command(probe)
        .env("PATH", augmented_path())
        .arg(bin)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn cargo_outdated_present() -> bool {
    run_capped(cargo_cmd(&["outdated", "--version"], "."), 20)
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn cargo_cmd(args: &[&str], dir: &str) -> std::process::Command {
    let mut c = sys_command("cargo");
    c.env("PATH", augmented_path()).current_dir(dir).args(args);
    c
}

/// Like `git_run`, with two differences that matter here: its own wording, and a non-zero
/// exit that is DATA — `npm`/`pnpm outdated` exit 1 precisely when they found something.
fn run_capped(mut cmd: std::process::Command, secs: u64) -> Result<std::process::Output, String> {
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("{e}"))?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(_) => {
            #[cfg(not(windows))]
            let _ = sys_command("kill").arg("-9").arg(pid.to_string()).status();
            #[cfg(windows)]
            let _ = sys_command("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).status();
            Err(format!("no answer after {secs}s — the registry may be unreachable"))
        }
    }
}

/// Run one package manager and read its answer. Explicit only: this resolves against a
/// registry and can take a minute, so nothing calls it on a pane's load path.
#[tauri::command]
pub(crate) async fn dep_outdated(root: String, tool: String) -> OutdatedRun {
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<&str> = match tool.as_str() {
            "pnpm" => vec!["outdated", "--format", "json"],
            "npm" => vec!["outdated", "--json"],
            "yarn" => vec!["outdated", "--json"],
            "cargo" => vec!["outdated", "--root-deps-only", "--format", "json"],
            "go" => vec!["list", "-m", "-u", "-json", "all"],
            "pip" => vec!["list", "--outdated", "--format=json"],
            _ => return OutdatedRun::failed(&tool, format!("{tool} is not a package manager Episko runs")),
        };
        let bin = if tool == "pip" { "pip" } else { tool.as_str() };
        let mut cmd = sys_command(bin);
        cmd.env("PATH", augmented_path())
            .current_dir(&root)
            .args(&args)
            // npm prints a progress spinner to a pipe otherwise, and yarn asks questions.
            .env("NO_COLOR", "1")
            .env("CI", "1");
        let out = match run_capped(cmd, OUTDATED_SECS) {
            Ok(o) => o,
            Err(e) => return OutdatedRun::failed(&tool, e),
        };
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let rows = match tool.as_str() {
            "pnpm" | "npm" => parse_npm_outdated(&stdout),
            "yarn" => parse_yarn_outdated(&stdout),
            "cargo" => parse_cargo_outdated(&stdout),
            "go" => parse_go_list(&stdout),
            _ => parse_pip_outdated(&stdout),
        };
        // A non-zero exit with nothing parsed is the only real failure: these tools exit 1
        // to mean "there are updates", which is the answer rather than an error.
        if rows.is_empty() && !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let first = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
            if !first.trim().is_empty() {
                return OutdatedRun::failed(&tool, first.trim());
            }
        }
        OutdatedRun { tool, ok: true, reason: None, rows }
    })
    .await
    .unwrap_or_else(|e| OutdatedRun::failed("", format!("task failed: {e}")))
}

/// npm and pnpm agree on the shape: an object keyed by package name. npm calls the field
/// `type`, pnpm `dependencyType`; both may be absent.
pub(crate) fn parse_npm_outdated(json: &str) -> Vec<Outdated> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(map) = v.as_object() else { return vec![] };
    let mut rows: Vec<Outdated> = map
        .iter()
        .map(|(name, o)| {
            let s = |k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            Outdated {
                pkg: name.clone(),
                current: s("current"),
                wanted: s("wanted"),
                latest: s("latest"),
                kind: {
                    let t = s("dependencyType");
                    if t.is_empty() { s("type") } else { t }
                },
                deprecated: o.get("isDeprecated").and_then(serde_json::Value::as_bool).unwrap_or(false),
            }
        })
        .filter(|r| !r.latest.is_empty())
        .collect();
    rows.sort_by(|a, b| a.pkg.cmp(&b.pkg));
    rows
}

/// Yarn 1 streams newline-delimited JSON and puts the table in `data.body`, one array per row:
/// `[name, current, wanted, latest, type, url]`.
pub(crate) fn parse_yarn_outdated(text: &str) -> Vec<Outdated> {
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|x| x.as_str()) != Some("table") {
            continue;
        }
        let Some(body) = v.get("data").and_then(|d| d.get("body")).and_then(|b| b.as_array()) else { continue };
        return body
            .iter()
            .filter_map(|row| {
                let c = row.as_array()?;
                let at = |i: usize| c.get(i).and_then(|x| x.as_str()).unwrap_or("").to_string();
                Some(Outdated {
                    pkg: at(0),
                    current: at(1),
                    wanted: at(2),
                    latest: at(3),
                    kind: at(4),
                    deprecated: false,
                })
            })
            .filter(|r| !r.pkg.is_empty())
            .collect();
    }
    vec![]
}

/// `cargo outdated --format json`: `{"dependencies":[{"name","project","compat","latest","kind"}]}`.
/// `project` is what is in the lockfile; `compat` is what the declared range allows, and is
/// `---` when there is nothing newer inside it.
pub(crate) fn parse_cargo_outdated(json: &str) -> Vec<Outdated> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(arr) = v.get("dependencies").and_then(|x| x.as_array()) else { return vec![] };
    let clean = |s: &str| if s == "---" || s == "Removed" { String::new() } else { s.to_string() };
    arr.iter()
        .filter_map(|o| {
            let s = |k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("");
            let latest = clean(s("latest"));
            if latest.is_empty() {
                return None;
            }
            Some(Outdated {
                pkg: s("name").to_string(),
                current: clean(s("project")),
                wanted: clean(s("compat")),
                latest,
                kind: s("kind").to_string(),
                deprecated: false,
            })
        })
        .collect()
}

/// `go list -m -u -json all` is a stream of concatenated JSON objects, not an array; only
/// the ones carrying an `Update` are out of date.
pub(crate) fn parse_go_list(text: &str) -> Vec<Outdated> {
    let mut out = vec![];
    let mut de = serde_json::Deserializer::from_str(text).into_iter::<serde_json::Value>();
    while let Some(Ok(v)) = de.next() {
        let Some(update) = v.get("Update").and_then(|u| u.get("Version")).and_then(|x| x.as_str()) else { continue };
        let name = v.get("Path").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let current = v.get("Version").and_then(|x| x.as_str()).unwrap_or("").to_string();
        out.push(Outdated {
            pkg: name,
            current,
            wanted: String::new(),
            latest: update.to_string(),
            kind: if v.get("Indirect").and_then(serde_json::Value::as_bool).unwrap_or(false) { "indirect".into() } else { "direct".into() },
            deprecated: v.get("Deprecated").is_some(),
        });
    }
    out
}

/// `pip list --outdated --format=json`: `[{"name","version","latest_version","latest_filetype"}]`.
pub(crate) fn parse_pip_outdated(json: &str) -> Vec<Outdated> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return vec![] };
    let Some(arr) = v.as_array() else { return vec![] };
    arr.iter()
        .filter_map(|o| {
            let s = |k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let latest = s("latest_version");
            if latest.is_empty() {
                return None;
            }
            let current = s("version");
            Some(Outdated { pkg: s("name"), wanted: current.clone(), current, latest, kind: String::new(), deprecated: false })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_alert_down_to_its_patched_version() {
        let json = r#"[{"number":5,"state":"open","html_url":"u","created_at":"c","updated_at":"d",
          "dependency":{"package":{"ecosystem":"npm","name":"vitest"},"manifest_path":"pnpm-lock.yaml",
            "scope":"development","relationship":"direct"},
          "security_advisory":{"ghsa_id":"GHSA-x","cve_id":"CVE-1","summary":"s","severity":"high",
            "cvss":{"score":5.9},"epss":{"percentage":0.00375}},
          "security_vulnerability":{"severity":"medium","vulnerable_version_range":">= 2.1.0, < 4.1.11",
            "first_patched_version":{"identifier":"4.1.11"}}}]"#;
        let a = &parse_alerts(json)[0];
        assert_eq!(a.pkg, "vitest");
        assert_eq!(a.patched.as_deref(), Some("4.1.11"));
        // The per-package severity wins over the advisory's repo-wide one.
        assert_eq!(a.severity, "medium");
        assert_eq!(a.relationship, "direct");
    }

    #[test]
    fn an_alert_with_no_fix_yet_says_so_rather_than_guessing() {
        let json = r#"[{"number":1,"security_vulnerability":{"vulnerable_version_range":"< 2",
          "first_patched_version":null},"security_advisory":{"severity":"low"}}]"#;
        assert_eq!(parse_alerts(json)[0].patched, None);
    }

    #[test]
    fn keeps_only_the_bots_prs_and_rolls_their_checks_up() {
        let json = r#"[
          {"number":1,"author":{"login":"dependabot[bot]"},"headRefName":"dependabot/npm_and_yarn/vitest-4.1.11",
           "title":"Bump vitest","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","labels":[],
           "statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"COMPLETED","conclusion":"FAILURE"},
             {"status":"IN_PROGRESS"},{"status":"COMPLETED","conclusion":"SKIPPED"}]},
          {"number":2,"author":{"login":"a-human"},"headRefName":"feat/x","title":"t","labels":[]}]"#;
        let prs = parse_bot_prs(json);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].bot, "dependabot");
        assert_eq!(prs[0].checks, ChecksRollup { total: 4, passed: 1, failed: 1, pending: 1, skipped: 1 });
    }

    #[test]
    fn names_the_scope_a_token_is_missing_rather_than_repeating_ghs_prose() {
        let msg = classify_deps("You are not authorized to perform this operation.", Some("me"));
        assert!(msg.contains("security_events"), "{msg}");
        assert!(classify_deps("Dependabot alerts are disabled for this repository", None).contains("switched off"));
    }

    #[test]
    fn reads_a_package_json_and_marks_only_what_never_ships() {
        let (ranges, dev) = parse_package_json(
            r#"{"dependencies":{"a":"^1.0.0","b":"~2.1"},"devDependencies":{"c":"3.x","a":"^1.0.0"}}"#);
        assert_eq!(ranges.get("a").map(String::as_str), Some("^1.0.0"));
        assert_eq!(dev, vec!["c"]); // `a` is in both, and a shipped dependency is not dev
    }

    #[test]
    fn reads_both_cargo_spellings_and_skips_an_inherited_version() {
        let (ranges, dev) = parse_cargo_toml(
            "[dependencies]\nserde = \"1\"\ntoml = { version = \"0.9\" }\nsub = { workspace = true }\n\
             [dev-dependencies]\ntauri = \"2\"\n");
        assert_eq!(ranges.get("serde").map(String::as_str), Some("1"));
        assert_eq!(ranges.get("toml").map(String::as_str), Some("0.9"));
        assert!(!ranges.contains_key("sub"), "workspace = true declares no range here");
        assert_eq!(dev, vec!["tauri"]);
    }

    #[test]
    fn reads_pep508_and_go_mod() {
        let (py, _) = parse_requirements("# c\nrequests>=2.0,<3\ndjango[argon2] == 4.2\n-e .\n");
        assert_eq!(py.get("requests").map(String::as_str), Some(">=2.0,<3"));
        assert_eq!(py.get("django").map(String::as_str), Some("== 4.2"));
        let (go, indirect) = parse_go_mod("require (\n\tgithub.com/x/y v1.2.3\n\tgithub.com/z/w v0.1.0 // indirect\n)\n");
        assert_eq!(go.get("github.com/x/y").map(String::as_str), Some("v1.2.3"));
        assert_eq!(indirect, vec!["github.com/z/w"]);
    }

    #[test]
    fn reads_every_package_managers_own_answer() {
        let npm = parse_npm_outdated(
            r#"{"vitest":{"current":"4.1.0","wanted":"4.1.0","latest":"4.1.11","dependencyType":"devDependencies"}}"#);
        assert_eq!(npm[0].latest, "4.1.11");
        assert_eq!(npm[0].kind, "devDependencies");
        // `---` is cargo-outdated's "nothing newer inside the declared range", not a version.
        let cargo = parse_cargo_outdated(
            r#"{"dependencies":[{"name":"serde","project":"1.0.1","compat":"---","latest":"2.0.0","kind":"normal"}]}"#);
        assert_eq!(cargo[0].wanted, "");
        assert_eq!(cargo[0].latest, "2.0.0");
        // Only a module carrying an Update is out of date; the stream is not an array.
        let go = parse_go_list(r#"{"Path":"a","Version":"v1"}{"Path":"b","Version":"v1","Update":{"Version":"v2"}}"#);
        assert_eq!(go.len(), 1);
        assert_eq!(go[0].pkg, "b");
        let pip = parse_pip_outdated(r#"[{"name":"requests","version":"2.0.0","latest_version":"2.32.0"}]"#);
        assert_eq!(pip[0].latest, "2.32.0");
    }

    #[test]
    fn reads_the_manifests_beside_and_one_level_under_the_root() {
        let dir = crate::testutil::scratch_dir();
        std::fs::write(dir.join("package.json"), r#"{"dependencies":{"a":"^1"}}"#).unwrap();
        std::fs::create_dir_all(dir.join("crates/core")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/evil")).unwrap();
        std::fs::write(dir.join("node_modules/evil/package.json"), r#"{"dependencies":{"no":"1"}}"#).unwrap();
        let found = read_manifests(&dir);
        assert!(found.iter().any(|m| m.path == "package.json" && m.ranges.contains_key("a")));
        assert!(!found.iter().any(|m| m.path.contains("node_modules")), "node_modules is never walked");
    }

    #[test]
    fn tells_a_bot_from_a_person() {
        assert_eq!(bot_of("dependabot[bot]"), "dependabot");
        assert_eq!(bot_of("app/renovate"), "renovate");
        assert_eq!(bot_of("FAbrahamDev"), "");
    }
}
