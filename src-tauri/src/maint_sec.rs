//! The security facet (docs/maintenance.md § Adapters): `dependabot-alerts` through `dep_report`'s
//! shared cache, GitHub's code and secret scanning, the SARIF files a project names, OSV.dev over
//! the lockfiles and the audit tools. Every finding becomes a reporter-neutral `Advisory`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;

use crate::deps::{alerts_read, coverage_of, DepAlert};
use crate::git::glob_match;
use crate::github::who_for;
use crate::lockfile::{Pkg, LOCKFILES};
use crate::maint::exec::HttpReq;
use crate::maint::{found_paths, github_repo, read_capped, Advisory, AdvisoryKind, Coverage, Ctx, Exec, Facts, Read, Severity, SKIP_DIRS};

/// A reporter's severity word, case-blind; GraphQL's `MODERATE` is REST's `medium`. A word nobody
/// taught us is `Unknown`, and the raw one rides beside it.
pub(crate) fn norm_severity(raw: &str) -> Severity {
    match raw.trim().to_ascii_lowercase().as_str() {
        "critical" => Severity::Critical,
        "high" => Severity::High,
        "medium" | "moderate" => Severity::Medium,
        "low" => Severity::Low,
        _ => Severity::Unknown,
    }
}

/// A SARIF level, which is also GitHub's rule severity for a rule with no security score.
fn level_severity(level: &str) -> Severity {
    match level.trim().to_ascii_lowercase().as_str() {
        "error" => Severity::High,
        "warning" => Severity::Medium,
        "note" => Severity::Low,
        _ => Severity::Unknown,
    }
}

/// A CVSS-style `security-severity`, in GitHub's own bands.
fn score_severity(score: f64) -> Severity {
    match score {
        s if s >= 9.0 => Severity::Critical,
        s if s >= 7.0 => Severity::High,
        s if s >= 4.0 => Severity::Medium,
        s if s > 0.0 => Severity::Low,
        _ => Severity::Unknown,
    }
}

fn some(s: &str) -> Option<String> {
    Some(s.to_string()).filter(|s| !s.is_empty())
}

pub(crate) fn text<'a>(v: &'a Value, ptr: &str) -> &'a str {
    v.pointer(ptr).and_then(Value::as_str).unwrap_or("")
}

fn located(path: &str, line: Option<u64>) -> Option<String> {
    some(path).map(|p| match line {
        Some(l) => format!("{p}:{l}"),
        None => p,
    })
}

/// One line, at most 200 characters: a scanner's message can run to paragraphs. A control
/// character (ESC above all) becomes a space, since a summary may be typed into a prompt.
pub(crate) fn summary_of(s: &str) -> String {
    let line = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    line.chars().map(|c| if c.is_control() { ' ' } else { c }).take(200).collect()
}

const SECRET_TOOLS: &[&str] = &["gitleaks", "trufflehog", "detect-secrets", "ggshield"];

/// What a scanner's finding is about, from its tool and tags: a dependency CVE, a secret, a
/// misconfiguration, or else the code itself.
fn kind_of(tool: &str, id: &str, tags: &[&str]) -> AdvisoryKind {
    let tool = tool.to_ascii_lowercase();
    let tagged = |t: &str| tags.iter().any(|x| x.eq_ignore_ascii_case(t));
    if SECRET_TOOLS.iter().any(|s| tool.contains(s)) || tagged("secret") || tagged("secrets") {
        AdvisoryKind::Secret
    } else if tagged("vulnerability") || ["CVE-", "GHSA-"].iter().any(|p| id.get(..p.len()).is_some_and(|h| h.eq_ignore_ascii_case(p))) {
        AdvisoryKind::Dependency
    } else if tagged("misconfiguration") {
        AdvisoryKind::Config
    } else {
        AdvisoryKind::Code
    }
}

fn tags_of(v: Option<&Value>) -> Vec<&str> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

// ---------- dependabot-alerts ----------

/// One alert is one package; `mergeAdvisories` folds an advisory's packages back into one row.
fn advisory_of(a: &DepAlert) -> Advisory {
    let id = [a.ghsa.as_str(), a.cve.as_deref().unwrap_or("")].into_iter().find(|s| !s.is_empty())
        .map_or_else(|| format!("alert #{}", a.number), str::to_string);
    Advisory {
        aliases: a.cve.iter().filter(|c| **c != id).cloned().collect(),
        id,
        kind: AdvisoryKind::Dependency,
        pkg: some(&a.pkg),
        ecosystem: some(&a.ecosystem),
        version: None, // the alert names the vulnerable range, never what is installed
        severity: norm_severity(&a.severity),
        raw_severity: a.severity.clone(),
        summary: a.summary.clone(),
        fixed: a.patched.clone(),
        location: some(&a.manifest),
        url: some(&a.url),
        tool: "dependabot".into(),
    }
}

pub(crate) fn dependabot_alerts(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let repo = github_repo(ctx)?;
    let (alerts, full) = alerts_read(ex, ctx.root, Some(repo), ctx.account, ctx.force).map_err(|e| coverage_of(&e, ctx.account))?;
    let items = alerts.iter().map(advisory_of).collect();
    Ok(Read { truncated: full, ..Read::of(Facts::Advisories { items }) })
}

// ---------- github-code-scanning, github-secret-scanning ----------

const ALERT_CAP: usize = 100;

/// One page of open alerts and whether it filled. An answer that is not a list is a failure,
/// never a clean repository.
fn alert_page(ctx: &Ctx, ex: &dyn Exec, what: &str, cov: fn(&str, Option<&str>) -> Coverage) -> Result<(Vec<Value>, bool), Coverage> {
    let repo = github_repo(ctx)?;
    // A secret alert carries the leaked value itself unless asked not to, and nothing here reads it.
    let hide = if what == "secret-scanning" { "&hide_secret=true" } else { "" };
    let path = format!("repos/{repo}/{what}/alerts?state=open&per_page={ALERT_CAP}{hide}");
    let out = ex.gh(ctx.root, ctx.account, &["api", &path]).map_err(|e| cov(&e, ctx.account))?;
    let rows = serde_json::from_str::<Value>(&out).ok().and_then(|v| v.as_array().cloned())
        .ok_or_else(|| Coverage::Error { reason: format!("gh api {what} answered something that is not the JSON list it promises") })?;
    let full = rows.len() >= ALERT_CAP;
    Ok((rows, full))
}

/// Named before `coverage_of` (the token scope, then `gh_coverage`): no analysis uploaded is the
/// feature unused, and a private repository without Advanced Security cannot have it at all.
fn code_scanning_coverage(err: &str, account: Option<&str>) -> Coverage {
    let e = err.to_lowercase();
    if e.contains("no analysis found") || e.contains("code scanning is not enabled") {
        return Coverage::Off { reason: "code scanning has no analysis for this repository".into() };
    }
    if e.contains("advanced security") {
        return Coverage::Unsupported { reason: "code scanning needs GitHub Advanced Security on this repository".into() };
    }
    coverage_of(err, account)
}

/// Secret scanning shows its alerts to the repository's admins and security managers only, so a
/// plain 403 is about the account's role, not about whether it can see the code.
fn secret_scanning_coverage(err: &str, account: Option<&str>) -> Coverage {
    let e = err.to_lowercase();
    if e.contains("secret scanning is disabled") || e.contains("secret scanning is not enabled") {
        return Coverage::Off { reason: "secret scanning is switched off for this repository".into() };
    }
    if e.contains("advanced security") {
        return Coverage::Unsupported { reason: "secret scanning needs GitHub Advanced Security on this repository".into() };
    }
    if e.contains("http 403") && !e.contains("rate limit") && !e.contains("security_events") {
        let who = who_for(account).map(|w| format!(" (signed in as {w})")).unwrap_or_default();
        let reason = format!("only the repository's admins and security managers can read its secret scanning alerts{who}");
        return Coverage::NoAccess { reason, fix: Some("pick the GitHub account that administers it from the project menu".into()) };
    }
    coverage_of(err, account)
}

fn code_alert(a: &Value) -> Option<Advisory> {
    let id = text(a, "/rule/id");
    if id.is_empty() {
        return None;
    }
    // A security rule carries its own band; any other rule only `error`/`warning`/`note`.
    let (severity, raw) = match text(a, "/rule/security_severity_level") {
        "" => (level_severity(text(a, "/rule/severity")), text(a, "/rule/severity")),
        band => (norm_severity(band), band),
    };
    let tool = some(text(a, "/tool/name")).unwrap_or_else(|| "code scanning".into());
    let line = a.pointer("/most_recent_instance/location/start_line").and_then(Value::as_u64);
    let said = [text(a, "/most_recent_instance/message/text"), text(a, "/rule/description")];
    Some(Advisory {
        id: id.to_string(),
        aliases: vec![],
        kind: kind_of(&tool, id, &tags_of(a.pointer("/rule/tags"))),
        pkg: None,
        ecosystem: None,
        version: None,
        severity,
        raw_severity: raw.to_string(),
        summary: summary_of(said.into_iter().find(|s| !s.trim().is_empty()).unwrap_or("")),
        fixed: None,
        location: located(text(a, "/most_recent_instance/location/path"), line),
        url: some(text(a, "/html_url")),
        tool,
    })
}

/// A secret has no severity of its own; whether it still works is the fact that matters.
fn secret_alert(a: &Value) -> Option<Advisory> {
    let n = a.get("number")?.as_u64()?;
    let what = [text(a, "/secret_type_display_name"), text(a, "/secret_type")].into_iter().find(|s| !s.is_empty()).unwrap_or("a secret");
    let valid = match text(a, "/validity") {
        "active" => ", still valid",
        "inactive" => ", no longer valid",
        _ => "",
    };
    let line = a.pointer("/first_location_detected/start_line").and_then(Value::as_u64);
    Some(Advisory {
        id: format!("secret #{n}"),
        aliases: vec![],
        kind: AdvisoryKind::Secret,
        pkg: None,
        ecosystem: None,
        version: None,
        severity: Severity::Unknown,
        raw_severity: String::new(),
        summary: format!("{what}{valid}"),
        fixed: None,
        location: located(text(a, "/first_location_detected/path"), line),
        url: some(text(a, "/html_url")),
        tool: "secret scanning".into(),
    })
}

pub(crate) fn gh_code_scanning(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let (rows, full) = alert_page(ctx, ex, "code-scanning", code_scanning_coverage)?;
    let items = rows.iter().filter_map(code_alert).collect();
    Ok(Read { truncated: full, ..Read::of(Facts::Advisories { items }) })
}

pub(crate) fn gh_secret_scanning(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let (rows, full) = alert_page(ctx, ex, "secret-scanning", secret_scanning_coverage)?;
    let items = rows.iter().filter_map(secret_alert).collect();
    Ok(Read { truncated: full, ..Read::of(Facts::Advisories { items }) })
}

// ---------- sarif-files ----------

const SARIF_BYTES: u64 = 32 * 1024 * 1024;
const SARIF_FILES: usize = 20;
const SARIF_ITEMS: usize = 1000;
const WALK_DEPTH: usize = 6;
const WALK_VISITS: usize = 5000;

/// Every file under `dir` (relative to `root`, `/`-separated), bounded; true when a cap cut it short.
fn walk(root: &Path, dir: &str, depth: usize, visits: &mut usize, out: &mut Vec<String>) -> bool {
    let Ok(entries) = std::fs::read_dir(root.join(dir)) else { return false };
    let mut cut = false;
    for e in entries.flatten() {
        *visits += 1;
        if *visits > WALK_VISITS {
            return true;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let rel = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
            cut |= depth >= WALK_DEPTH || walk(root, &rel, depth + 1, visits, out);
        } else if t.is_file() {
            out.push(rel);
        }
    }
    cut
}

/// The files `[maintenance] sarif` names. A pattern is walked from its directory part, so
/// `build/reports/*.sarif` reaches a folder detection never looks in; `*` is `glob_match`'s.
fn sarif_paths(root: &Path, patterns: &[String], gaps: &mut Vec<String>) -> (Vec<String>, bool) {
    let mut found = BTreeSet::new();
    let mut cut = false;
    for p in patterns {
        if !crate::maint::sarif_inside(p) {
            gaps.push(format!("sarif pattern {p:?} must be a path inside the project"));
            continue;
        }
        let base: Vec<&str> = p.split('/').take_while(|s| !s.contains('*')).collect();
        if base.len() == p.split('/').count() {
            if root.join(p).is_file() {
                found.insert(p.clone());
            }
            continue;
        }
        let (mut files, mut visits) = (vec![], 0);
        cut |= walk(root, &base.join("/"), base.len(), &mut visits, &mut files);
        found.extend(files.into_iter().filter(|f| glob_match(p, f)));
    }
    let many = found.len() > SARIF_FILES;
    (found.into_iter().take(SARIF_FILES).collect(), cut || many)
}

/// A result is a finding unless it is not a failure, was fixed since the baseline, or was
/// suppressed by a suppression nobody rejected.
fn open_result(r: &Value) -> bool {
    let kind = text(r, "/kind");
    let suppressed = r.get("suppressions").and_then(Value::as_array)
        .is_some_and(|s| s.iter().any(|x| text(x, "/status") != "rejected"));
    (kind.is_empty() || kind == "fail") && text(r, "/baselineState") != "absent" && !suppressed
}

fn score(v: Option<&Value>) -> Option<(f64, String)> {
    let v = v?;
    let s = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
    s.trim().parse::<f64>().ok().map(|n| (n, s))
}

/// `%XX` escapes decoded; a malformed one is kept as written.
fn pct_decode(s: &str) -> String {
    let (b, mut out, mut i) = (s.as_bytes(), vec![], 0);
    while i < b.len() {
        let hex = s.get(i + 1..i + 3).filter(|h| b[i] == b'%' && h.bytes().all(|c| c.is_ascii_hexdigit()));
        match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
            Some(x) => (out.push(x), i += 3),
            None => (out.push(b[i]), i += 1),
        };
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn absolute(p: &str) -> bool {
    p.starts_with('/') || p.get(1..3) == Some(":/")
}

/// A SARIF URI as the repository names it: decoded, `/`-separated, and relative to the first
/// absolute base it lies under, so a CI log's `file:///home/runner/...` meets GitHub's `src/db.js`.
fn sarif_path(uri: &str, bases: &[String]) -> String {
    let p = pct_decode(uri.strip_prefix("file://").unwrap_or(uri)).replace('\\', "/");
    let p = if p.starts_with('/') && p.get(2..4) == Some(":/") { p[1..].to_string() } else { p };
    let p = p.strip_prefix("./").map(str::to_string).unwrap_or(p);
    for b in bases.iter().map(|b| b.trim_end_matches('/')).filter(|b| absolute(b) && absolute(&p)) {
        if p.get(..b.len()).is_some_and(|h| h.eq_ignore_ascii_case(b)) && p[b.len()..].starts_with('/') {
            return p[b.len() + 1..].to_string();
        }
    }
    p
}

/// One SARIF 2.1.0 log's open findings, from any tool: the rule is looked up in the driver and
/// in every extension, since CodeQL files its queries' rules under the query pack.
pub(crate) fn parse_sarif(json: &str, file: &str, root: &str) -> Result<Vec<Advisory>, String> {
    let v: Value = serde_json::from_str(json).map_err(|_| format!("{file} is not JSON"))?;
    let runs = v.get("runs").and_then(Value::as_array).ok_or_else(|| format!("{file} is not a SARIF log"))?;
    let mut out = vec![];
    for run in runs {
        let tool = some(text(run, "/tool/driver/name")).unwrap_or_else(|| "SARIF".into());
        let mut bases: Vec<String> = run.get("originalUriBaseIds").and_then(Value::as_object).into_iter().flatten()
            .filter_map(|(_, b)| b.get("uri").and_then(Value::as_str)).map(|u| sarif_path(u, &[])).collect();
        bases.push(root.replace('\\', "/"));
        let rules: Vec<&Value> = std::iter::once(run.pointer("/tool/driver/rules"))
            .chain(run.pointer("/tool/extensions").and_then(Value::as_array).into_iter().flatten().map(|x| x.get("rules")))
            .flatten().filter_map(Value::as_array).flatten().collect();
        for r in run.get("results").and_then(Value::as_array).into_iter().flatten().filter(|r| open_result(r)) {
            let id = [text(r, "/ruleId"), text(r, "/rule/id")].into_iter().find(|s| !s.is_empty()).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            let rule = rules.iter().find(|x| text(x, "/id") == id).copied();
            let props = |k: &str| r.pointer(&format!("/properties/{k}")).or_else(|| rule.and_then(|x| x.pointer(&format!("/properties/{k}"))));
            let level = [text(r, "/level"), rule.map_or("", |x| text(x, "/defaultConfiguration/level")), "warning"]
                .into_iter().find(|s| !s.is_empty()).unwrap_or("warning");
            let (severity, raw) = match score(props("security-severity")) {
                Some((n, s)) => (score_severity(n), s),
                None => (level_severity(level), level.to_string()),
            };
            let tags: Vec<&str> = tags_of(r.pointer("/properties/tags")).into_iter().chain(tags_of(rule.and_then(|x| x.pointer("/properties/tags")))).collect();
            let at = r.pointer("/locations/0/physicalLocation");
            let uri = at.map_or("", |p| text(p, "/artifactLocation/uri"));
            let line = at.and_then(|p| p.pointer("/region/startLine")).and_then(Value::as_u64);
            let said = [text(r, "/message/text"), rule.map_or("", |x| text(x, "/shortDescription/text"))];
            out.push(Advisory {
                id: id.to_string(),
                aliases: vec![],
                kind: kind_of(&tool, id, &tags),
                pkg: None,
                ecosystem: None,
                version: None,
                severity,
                raw_severity: raw,
                summary: summary_of(said.into_iter().find(|s| !s.trim().is_empty()).unwrap_or("")),
                fixed: None,
                location: located(&sarif_path(uri, &bases), line),
                url: rule.and_then(|x| some(text(x, "/helpUri"))),
                tool: tool.clone(),
            });
        }
    }
    Ok(out)
}

/// Whatever scanners left SARIF where `[maintenance] sarif` says: semgrep, CodeQL, gitleaks, Trivy
/// and Snyk Code need no adapter of their own. A file that cannot be read is a gap, never a clean one.
pub(crate) fn sarif_files(ctx: &Ctx, _ex: &dyn Exec) -> Result<Read, Coverage> {
    let patterns = ctx.cfg.sarif();
    if patterns.is_empty() {
        return Err(Coverage::Unsupported { reason: "no [maintenance] sarif in .episko/episko.toml".into() });
    }
    let root = Path::new(ctx.root);
    let mut gaps = vec![];
    let (files, mut truncated) = sarif_paths(root, patterns, &mut gaps);
    if files.is_empty() {
        return Err(Coverage::Unsupported { reason: format!("no file matches [maintenance] sarif: {}", patterns.join(", ")) });
    }
    let (mut items, mut seen, mut read) = (vec![], BTreeSet::new(), 0);
    for f in &files {
        let path = root.join(f);
        match read_capped(&path, SARIF_BYTES).map_err(|e| format!("{f}: {e}")).and_then(|t| parse_sarif(&t, f, ctx.root)) {
            Ok(found) => {
                read += 1;
                // Two logs of one run (or one log listed twice) report a finding once.
                items.extend(found.into_iter().filter(|a| seen.insert((a.id.clone(), a.location.clone(), a.tool.clone()))));
            }
            Err(e) => gaps.push(e),
        }
    }
    if read == 0 {
        return Err(Coverage::Error { reason: gaps.join("; ") });
    }
    truncated |= items.len() > SARIF_ITEMS;
    items.truncate(SARIF_ITEMS);
    Ok(Read { facts: Facts::Advisories { items }, truncated, gaps })
}

// ---------- versions and CVSS, as the lockfile reporters need them ----------

/// A version's numeric core (`1.6.0-rc.1` is `1.6.0`): enough to place an installed version
/// between an advisory's bounds, which is all it is asked.
fn ver(v: &str) -> [u64; 4] {
    let mut out = [0; 4];
    let core = v.trim().trim_start_matches(['v', '=']).split(['-', '+']).next().unwrap_or("");
    for (slot, part) in out.iter_mut().zip(core.split('.')) {
        *slot = part.parse().unwrap_or(0);
    }
    out
}

/// A CVSS 3.x base score from its vector, by FIRST's formula; `None` for any other version.
fn cvss3(vector: &str) -> Option<f64> {
    let mut parts = vector.split('/');
    if !parts.next()?.starts_with("CVSS:3") {
        return None;
    }
    let m: std::collections::HashMap<&str, &str> = parts.filter_map(|p| p.split_once(':')).collect();
    let changed = *m.get("S")? == "C";
    let av = match *m.get("AV")? { "N" => 0.85, "A" => 0.62, "L" => 0.55, "P" => 0.2, _ => return None };
    let ac = match *m.get("AC")? { "L" => 0.77, "H" => 0.44, _ => return None };
    let pr = match (*m.get("PR")?, changed) {
        ("N", _) => 0.85, ("L", false) => 0.62, ("L", true) => 0.68, ("H", false) => 0.27, ("H", true) => 0.5, _ => return None,
    };
    let ui = match *m.get("UI")? { "N" => 0.85, "R" => 0.62, _ => return None };
    let cia = |k: &str| match m.get(k).copied() { Some("H") => Some(0.56), Some("L") => Some(0.22), Some("N") => Some(0.0), _ => None };
    let iss: f64 = 1.0 - (1.0 - cia("C")?) * (1.0 - cia("I")?) * (1.0 - cia("A")?);
    let impact = if changed { 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02).powi(15) } else { 6.42 * iss };
    if impact <= 0.0 {
        return Some(0.0);
    }
    let base = (impact + 8.22 * av * ac * pr * ui) * if changed { 1.08 } else { 1.0 };
    // CVSS 3.1's Roundup: up to one decimal, done in integers so 4.0 stays 4.0.
    let i = (base.min(10.0) * 100_000.0).round() as u64;
    Some(if i.is_multiple_of(10_000) { i as f64 / 100_000.0 } else { (i / 10_000 + 1) as f64 / 10.0 })
}

/// A word if the reporter has one, else a CVSS 3 vector scored in GitHub's bands, the raw beside it.
fn graded(word: &str, vector: &str) -> (Severity, String) {
    if !word.is_empty() {
        return (norm_severity(word), word.to_string());
    }
    (cvss3(vector).map_or(Severity::Unknown, score_severity), vector.to_string())
}

pub(crate) fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

// ---------- osv ----------

pub(crate) const OSV_API: &str = "https://api.osv.dev/v1";
const OSV_BATCH: usize = 1000; // querybatch's own limit
const OSV_PKGS: usize = 5000;
const OSV_DETAILS: usize = 40; // records fetched per read, GHSA first; the rest are named without a severity
const OSV_SECS: u64 = 30;
const OSV_KEEP: usize = 2000;
pub(crate) const LOCK_BYTES: u64 = 64 * 1024 * 1024;

/// A vulnerability's record while its `modified` stands: querybatch names both, so a repeat
/// read fetches only what changed.
static OSV_RECORDS: Mutex<BTreeMap<String, (String, Value)>> = Mutex::new(BTreeMap::new());

/// Every package the lockfiles here install, once each, with the lockfile that named it first.
fn installed(root: &str, gaps: &mut Vec<String>) -> Result<Vec<(Pkg, String)>, Coverage> {
    let files = found_paths(root, LOCKFILES);
    if files.is_empty() {
        return Err(Coverage::Unsupported { reason: format!("no lockfile to ask about ({})", LOCKFILES.join(", ")) });
    }
    let (mut out, mut read, mut broken) = (BTreeMap::new(), 0, false);
    for f in &files {
        let path = Path::new(root).join(f);
        let text = match read_capped(&path, LOCK_BYTES) {
            Err(e) if e.kind() == std::io::ErrorKind::Other => {
                gaps.push(format!("{f} is {e}"));
                continue;
            }
            text => text,
        };
        match text.map_err(|e| format!("{f}: {e}")).and_then(|t| crate::lockfile::parse(f, &t)) {
            Ok(p) => {
                // A version no parser knows read nothing, however cleanly.
                read += usize::from(!p.pkgs.is_empty() || p.gaps.is_empty());
                gaps.extend(p.gaps);
                for pkg in p.pkgs {
                    out.entry(pkg).or_insert_with(|| f.clone());
                }
            }
            Err(e) => {
                broken = true;
                gaps.push(e);
            }
        }
    }
    gaps.extend(found_paths(root, &["yarn.lock"]).into_iter().map(|f| format!("{f} not read")));
    match read {
        0 if broken => Err(Coverage::Error { reason: gaps.join("; ") }),
        0 => Err(Coverage::Unsupported { reason: gaps.join("; ") }),
        _ => Ok(out.into_iter().collect()),
    }
}

pub(crate) fn osv_call(ex: &dyn Exec, url: String, body: Option<String>) -> Result<Value, String> {
    let r = ex.http(&HttpReq { url, body, token: None, secs: OSV_SECS, report: false })?;
    if r.code != 200 {
        return Err(format!("OSV.dev answered HTTP {}", r.code));
    }
    serde_json::from_str(&r.body).map_err(|_| "OSV.dev answered something that is not JSON".to_string())
}

/// An id goes into a URL path, so it is held to the characters OSV ids use.
pub(crate) fn osv_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
}

/// The fix for the range the installed version is in: `introduced` opens one, `fixed` closes it.
fn osv_fixed(r: &Value, p: &Pkg) -> Option<String> {
    let have = ver(&p.version);
    let mine = r.get("affected").and_then(Value::as_array).into_iter().flatten()
        .filter(|a| text(a, "/package/name") == p.name && text(a, "/package/ecosystem") == p.ecosystem);
    for range in mine.flat_map(|a| a.get("ranges").and_then(Value::as_array).into_iter().flatten()) {
        let mut from = None;
        for e in range.get("events").and_then(Value::as_array).into_iter().flatten() {
            if let Some(i) = e.get("introduced").and_then(Value::as_str) {
                from = Some(ver(i));
            } else if let Some(f) = e.get("fixed").and_then(Value::as_str) {
                if from.is_some_and(|lo| lo <= have) && have < ver(f) {
                    return Some(f.to_string());
                }
                from = None;
            }
        }
    }
    None
}

/// GitHub's reviewed word where the record is GitHub's; else the record's or its package's vector.
pub(crate) fn record_severity(r: &Value) -> (Severity, String) {
    let vector = r.get("severity").and_then(Value::as_array).into_iter().flatten()
        .find(|s| text(s, "/type").starts_with("CVSS_V3")).map(|s| text(s, "/score"))
        .or_else(|| r.pointer("/affected/0/database_specific/cvss").and_then(Value::as_str)).unwrap_or("");
    graded(text(r, "/database_specific/severity"), vector)
}

/// One package's hit; with no record (past the per-read cap, or a lookup that failed) it is
/// still a finding, named with no severity.
fn osv_advisory(p: &Pkg, at: &str, id: &str, rec: Option<&Value>) -> Advisory {
    let r = rec.unwrap_or(&Value::Null);
    let (severity, raw_severity) = record_severity(r);
    Advisory {
        id: id.to_string(),
        aliases: strs(r.get("aliases")).into_iter().filter(|a| a != id).collect(),
        kind: AdvisoryKind::Dependency,
        pkg: Some(p.name.clone()),
        ecosystem: Some(p.ecosystem.to_string()),
        version: Some(p.version.clone()),
        severity,
        raw_severity,
        summary: summary_of([text(r, "/summary"), text(r, "/details")].into_iter().find(|s| !s.trim().is_empty()).unwrap_or("")),
        fixed: osv_fixed(r, p),
        location: Some(at.to_string()),
        url: Some(format!("https://osv.dev/vulnerability/{id}")),
        tool: "OSV.dev".into(),
    }
}

/// The lockfiles' packages to OSV.dev's querybatch, then each vulnerability's record by id: a
/// `public` read, so a scan makes it only on a machine that opted in.
pub(crate) fn osv(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let mut gaps = vec![];
    let mut pkgs = installed(ctx.root, &mut gaps)?;
    let mut truncated = pkgs.len() > OSV_PKGS;
    pkgs.truncate(OSV_PKGS);
    let mut hits: Vec<(usize, String, String)> = vec![]; // (package, id, modified)
    for (n, chunk) in pkgs.chunks(OSV_BATCH).enumerate() {
        let queries: Vec<Value> = chunk.iter()
            .map(|(p, _)| serde_json::json!({ "package": { "name": p.name, "ecosystem": p.ecosystem }, "version": p.version }))
            .collect();
        let body = serde_json::json!({ "queries": queries }).to_string();
        let v = osv_call(ex, format!("{OSV_API}/querybatch"), Some(body)).map_err(|reason| Coverage::Error { reason })?;
        let results = v.get("results").and_then(Value::as_array).filter(|r| r.len() == chunk.len())
            .ok_or_else(|| Coverage::Error { reason: "OSV.dev did not answer one result per package".into() })?;
        for (i, r) in results.iter().enumerate() {
            truncated |= r.get("next_page_token").is_some(); // more vulnerabilities than one page
            for x in r.get("vulns").and_then(Value::as_array).into_iter().flatten().filter(|x| osv_id(text(x, "/id"))) {
                hits.push((n * OSV_BATCH + i, text(x, "/id").to_string(), text(x, "/modified").to_string()));
            }
        }
    }
    let want: BTreeMap<&str, &str> = hits.iter().map(|(_, id, m)| (id.as_str(), m.as_str())).collect();
    let mut records: BTreeMap<String, Value> = BTreeMap::new();
    if let Ok(seen) = OSV_RECORDS.lock() {
        records.extend(want.iter().filter_map(|(id, m)| seen.get(*id).filter(|(was, _)| was == m).map(|(_, v)| (id.to_string(), v.clone()))));
    }
    let (mut asked, mut unasked) = (0, 0);
    let mut missing: Vec<(&str, &str)> = want.into_iter().filter(|(id, _)| !records.contains_key(*id)).collect();
    // GitHub's records carry a reviewed severity word, so the cap is spent on them first.
    missing.sort_by_key(|(id, _)| !id.starts_with("GHSA-"));
    for (id, modified) in missing {
        if asked == OSV_DETAILS {
            unasked += 1;
            continue;
        }
        asked += 1;
        match osv_call(ex, format!("{OSV_API}/vulns/{id}"), None) {
            Ok(v) => {
                if let Ok(mut seen) = OSV_RECORDS.lock() {
                    if seen.len() >= OSV_KEEP {
                        seen.clear();
                    }
                    seen.insert(id.to_string(), (modified.to_string(), v.clone()));
                }
                records.insert(id.to_string(), v);
            }
            Err(e) => gaps.push(format!("{id}: {e}")),
        }
    }
    if unasked > 0 {
        gaps.push(format!("{unasked} more advisories than are looked up in one check: their severity is unknown until the next"));
    }
    let items = hits.iter().map(|(i, id, _)| osv_advisory(&pkgs[*i].0, &pkgs[*i].1, id, records.get(id))).collect();
    Ok(Read { facts: Facts::Advisories { items }, truncated, gaps })
}

// ---------- npm-audit, pnpm-audit, cargo-audit ----------

const AUDIT_SECS: u64 = 180; // cargo audit clones its advisory database on a first run
const AUDIT_DIRS: usize = 4;

/// One audit tool: run in each folder holding its lockfile, its JSON read whatever it exits
/// with, since these exit non-zero precisely when they found something (`run_capped`'s rule).
struct Audit {
    lock: &'static str,
    bin: &'static str,
    args: &'static [&'static str],
    tool: &'static str,
    fix: &'static str,
    parse: fn(&str, &str, &str) -> Result<Vec<Advisory>, String>,
}

const NPM_AUDIT: Audit = Audit {
    lock: "package-lock.json", bin: "npm", args: &["audit", "--json"], tool: "npm audit",
    fix: "install Node.js, which brings npm: https://nodejs.org", parse: parse_npm_audit,
};
// pnpm loads a project's `.pnpmfile.cjs` and switches to its `packageManager` version; only a CLI
// flag outranks a `pnpm-workspace.yaml` that asks for either (env does not).
const PNPM_SAFE: [&str; 2] = ["--config.ignore-pnpmfile=true", "--config.manage-package-manager-versions=false"];
const PNPM_AUDIT: Audit = Audit {
    lock: "pnpm-lock.yaml", bin: "pnpm", args: &["audit", "--json", PNPM_SAFE[0], PNPM_SAFE[1]], tool: "pnpm audit",
    fix: "corepack enable pnpm", parse: parse_npm_audit,
};
// The subcommand's own binary, never `cargo audit`: a project's `.cargo/config.toml` may alias `audit`.
const CARGO_AUDIT: Audit = Audit {
    lock: "Cargo.lock", bin: "cargo-audit", args: &["audit", "--json"], tool: "cargo audit",
    fix: "cargo install cargo-audit --locked", parse: parse_cargo_audit,
};

fn ghsa_of(url: &str) -> Option<String> {
    url.trim_end_matches('/').rsplit('/').next().filter(|s| s.starts_with("GHSA-")).map(str::to_string)
}

/// `>=1.2.6` as the version it names; any other range shape is kept as written.
fn floor_of(range: &str) -> Option<String> {
    let r = range.trim();
    match r.strip_prefix(">=").map(str::trim) {
        Some(v) if !v.contains([' ', ',', '<', '|']) => Some(v.to_string()),
        _ if r.is_empty() || r == "<0.0.0" => None, // npm's way of saying no fix exists
        _ => Some(r.to_string()),
    }
}

/// npm 7+'s report (`vulnerabilities`, the advisory objects in each `via`) and the older shape
/// pnpm still prints (`advisories`), into one row per advisory and package.
pub(crate) fn parse_npm_audit(json: &str, lock: &str, tool: &str) -> Result<Vec<Advisory>, String> {
    let v: Value = serde_json::from_str(json).map_err(|_| format!("{tool} printed no JSON report"))?;
    if let Some(e) = v.get("error") {
        return Err([text(e, "/summary"), text(e, "/code")].into_iter().find(|s| !s.is_empty()).unwrap_or("failed").to_string());
    }
    let row = |id: String, aliases, pkg: &str, version: Option<String>, sev: &str, title: &str, fixed, url: &str| Advisory {
        id, aliases, kind: AdvisoryKind::Dependency, pkg: some(pkg), ecosystem: Some("npm".into()), version,
        severity: norm_severity(sev), raw_severity: sev.to_string(), summary: summary_of(title), fixed,
        location: Some(lock.to_string()), url: some(url), tool: tool.to_string(),
    };
    let mut out: Vec<Advisory> = vec![];
    if let Some(vulns) = v.get("vulnerabilities").and_then(Value::as_object) {
        for e in vulns.values() {
            let fix = e.get("fixAvailable").filter(|f| f.is_object());
            // A string `via` points at another package's entry, which carries the advisory itself.
            for via in e.get("via").and_then(Value::as_array).into_iter().flatten().filter(|x| x.is_object()) {
                let (url, pkg) = (text(via, "/url"), text(via, "/name"));
                let id = ghsa_of(url).unwrap_or_else(|| format!("npm-{}", via.get("source").map_or(String::new(), Value::to_string)));
                let fixed = fix.filter(|f| text(f, "/name") == pkg).and_then(|f| some(text(f, "/version")));
                out.push(row(id, vec![], pkg, None, text(via, "/severity"), text(via, "/title"), fixed, url));
            }
        }
    } else if let Some(advs) = v.get("advisories").and_then(Value::as_object) {
        for a in advs.values() {
            let url = text(a, "/url");
            let id = some(text(a, "/github_advisory_id")).or_else(|| ghsa_of(url))
                .unwrap_or_else(|| format!("npm-{}", a.get("id").map_or(String::new(), Value::to_string)));
            let version = some(text(a, "/findings/0/version"));
            out.push(row(id, strs(a.get("cves")), text(a, "/module_name"), version, text(a, "/severity"), text(a, "/title"),
                floor_of(text(a, "/patched_versions")), url));
        }
    } else {
        return Err(format!("{tool} printed something that is not an audit report"));
    }
    let mut seen = BTreeSet::new();
    out.retain(|a| seen.insert((a.id.clone(), a.pkg.clone())));
    Ok(out)
}

/// The lowest patched floor above what is installed: `>=0.6.14, <1.0.0` and `>=1.6.1` for 1.6.0 is 1.6.1.
fn patched_for(installed: &str, patched: &[String]) -> Option<String> {
    let have = ver(installed);
    patched.iter().filter_map(|p| p.split(',').next().and_then(|c| c.trim().strip_prefix(">=")).map(str::trim))
        .filter(|v| ver(v) > have).min_by_key(|v| ver(v)).map(str::to_string)
}

/// cargo audit's `--json` report: its vulnerabilities, each a RUSTSEC id with its aliases. The
/// warnings (unmaintained, yanked) are not vulnerabilities and are left to the tool.
pub(crate) fn parse_cargo_audit(json: &str, lock: &str, tool: &str) -> Result<Vec<Advisory>, String> {
    let v: Value = serde_json::from_str(json).map_err(|_| format!("{tool} printed no JSON report"))?;
    let list = v.pointer("/vulnerabilities/list").and_then(Value::as_array)
        .ok_or_else(|| format!("{tool} printed something that is not an audit report"))?;
    Ok(list.iter().filter_map(|x| {
        let a = x.get("advisory")?;
        let id = some(text(a, "/id"))?;
        let installed = text(x, "/package/version");
        let (severity, raw_severity) = graded("", text(a, "/cvss"));
        Some(Advisory {
            aliases: strs(a.get("aliases")),
            kind: AdvisoryKind::Dependency,
            pkg: some(text(x, "/package/name")),
            ecosystem: Some("crates.io".into()),
            version: some(installed),
            severity,
            raw_severity,
            summary: summary_of([text(a, "/title"), text(a, "/description")].into_iter().find(|s| !s.trim().is_empty()).unwrap_or("")),
            fixed: patched_for(installed, &strs(x.pointer("/versions/patched"))),
            location: Some(lock.to_string()),
            url: Some(format!("https://rustsec.org/advisories/{id}.html")),
            tool: tool.to_string(),
            id,
        })
    }).collect())
}

fn audit(ctx: &Ctx, ex: &dyn Exec, a: &Audit) -> Result<Read, Coverage> {
    let locks = found_paths(ctx.root, &[a.lock]);
    if locks.is_empty() {
        return Err(Coverage::Unsupported { reason: format!("no {} here", a.lock) });
    }
    if !ex.on_path(a.bin) {
        return Err(Coverage::NoTool { tool: a.bin.into(), fix: Some(a.fix.into()) });
    }
    let (mut items, mut gaps, mut read) = (vec![], vec![], 0);
    for lock in locks.iter().take(AUDIT_DIRS) {
        let dir = lock.rsplit_once('/').map_or(ctx.root.to_string(), |(d, _)| Path::new(ctx.root).join(d).to_string_lossy().to_string());
        // A folder that timed out is a gap, as one that printed no report is: the others still answered.
        let out = match ex.tool(&dir, a.bin, a.args, AUDIT_SECS) {
            Ok(out) => out,
            Err(e) => {
                gaps.push(format!("{lock}: {e}"));
                continue;
            }
        };
        match (a.parse)(&out.stdout, lock, a.tool) {
            Ok(found) => {
                read += 1;
                items.extend(found);
            }
            Err(e) => {
                let said = out.stderr.lines().map(str::trim).find(|l| !l.is_empty()).filter(|_| out.stdout.trim().is_empty());
                gaps.push(format!("{lock}: {}", said.unwrap_or(&e)));
            }
        }
    }
    if read == 0 {
        return Err(Coverage::Error { reason: gaps.join("; ") });
    }
    Ok(Read { facts: Facts::Advisories { items }, truncated: locks.len() > AUDIT_DIRS, gaps })
}

pub(crate) fn npm_audit(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    audit(ctx, ex, &NPM_AUDIT)
}

pub(crate) fn pnpm_audit(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    audit(ctx, ex, &PNPM_AUDIT)
}

pub(crate) fn cargo_audit(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    audit(ctx, ex, &CARGO_AUDIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::{parse_maint, MaintConfig, ReadFn};
    use crate::testutil::scratch_dir;

    fn github() -> Forge {
        Forge { kind: ForgeKind::Github, host: Some("github.com".into()), path: Some("acme/app".into()), by: ForgeBy::Table, api: None }
    }

    // A distinct root per read: a forced read still joins an answer under `FORCE_JOIN` old.
    fn read(root: &str, ex: &FakeExec) -> Result<Read, Coverage> {
        read_with(root, dependabot_alerts, ex)
    }

    fn read_with(root: &str, f: ReadFn, ex: &FakeExec) -> Result<Read, Coverage> {
        let cfg = MaintConfig::default();
        f(&Ctx { root, cfg: &cfg, forge: &github(), account: Some("alice"), force: true }, ex)
    }

    fn items(r: &Read) -> &[Advisory] {
        match &r.facts {
            Facts::Advisories { items } => items,
            other => panic!("not advisories: {other:?}"),
        }
    }

    #[test]
    fn a_summary_carries_no_control_character() {
        assert_eq!(summary_of("\n  Run: x\u{1b}[13u y\u{7f}\u{9b}z  \nmore"), "Run: x [13u y  z");
    }

    #[test]
    fn an_alert_becomes_an_advisory_naming_its_reporter_only_as_a_tool() {
        let json = r#"[{"number":5,"html_url":"https://github.com/acme/app/security/dependabot/5",
          "dependency":{"package":{"ecosystem":"npm","name":"vitest"},"manifest_path":"pnpm-lock.yaml"},
          "security_advisory":{"ghsa_id":"GHSA-x","cve_id":"CVE-1","summary":"s","severity":"high"},
          "security_vulnerability":{"severity":"moderate","first_patched_version":{"identifier":"4.1.11"}}},
          {"number":6,"security_advisory":{"severity":"weird"}}]"#;
        let ex = FakeExec::answering(Ok(json));
        let r = read("/maint-test/sec/one", &ex).unwrap();
        let items = items(&r);
        let a = &items[0];
        assert_eq!((a.id.as_str(), a.aliases.clone()), ("GHSA-x", vec!["CVE-1".to_string()]));
        assert_eq!((a.severity, a.raw_severity.as_str()), (Severity::Medium, "moderate"), "the per-package word, normalised");
        assert_eq!((a.fixed.as_deref(), a.location.as_deref()), (Some("4.1.11"), Some("pnpm-lock.yaml")));
        assert_eq!((items[1].id.as_str(), items[1].severity), ("alert #6", Severity::Unknown), "never an empty id");
        assert!(!r.truncated);
        assert!(ex.calls()[0].iter().any(|a| a.starts_with("repos/acme/app/dependabot/alerts")), "{:?}", ex.calls());
        assert_eq!(ex.gh_accounts(), [Some("alice".to_string())]);
    }

    #[test]
    fn a_token_without_the_scope_says_how_to_add_it_and_a_disabled_feature_is_off() {
        let scope = read("/maint-test/sec/scope", &FakeExec::answering(Err("HTTP 403: You are not authorized (needs security_events)"))).err().unwrap();
        let Coverage::NoAccess { fix, .. } = scope else { panic!("{scope:?}") };
        assert!(fix.unwrap().contains("-s security_events"));
        let off = read("/maint-test/sec/off", &FakeExec::answering(Err("HTTP 403: Dependabot alerts are disabled for this repository."))).err().unwrap();
        assert!(matches!(off, Coverage::Off { .. }), "{off:?}");
        assert!(read("/maint-test/sec/object", &FakeExec::answering(Ok("{\"message\":\"x\"}"))).is_err(), "an object is no list");
    }

    #[test]
    fn a_full_page_is_truncated() {
        let page = serde_json::to_string(&vec![serde_json::json!({"number": 1}); 100]).unwrap();
        assert!(read("/maint-test/sec/full", &FakeExec::answering(Ok(&page))).unwrap().truncated);
        let rule = serde_json::json!({"number": 1, "rule": {"id": "js/x", "severity": "error"}});
        for f in [gh_code_scanning as ReadFn, gh_secret_scanning] {
            let page = serde_json::to_string(&vec![rule.clone(); ALERT_CAP]).unwrap();
            assert!(read_with("/r", f, &FakeExec::answering(Ok(&page))).unwrap().truncated, "a full page of alerts is a floor");
            let less = serde_json::to_string(&vec![rule.clone(); ALERT_CAP - 1]).unwrap();
            assert!(!read_with("/r", f, &FakeExec::answering(Ok(&less))).unwrap().truncated);
        }
    }

    #[test]
    fn code_scanning_alerts_carry_their_rule_place_and_band() {
        let ex = FakeExec::answering(Ok(&FakeExec::testdata("gh-code-scanning-alerts.json")));
        let r = read_with("/r", gh_code_scanning, &ex).unwrap();
        let got: Vec<_> = items(&r).iter().map(|a| (a.id.as_str(), a.kind, a.severity, a.raw_severity.as_str(), a.location.as_deref())).collect();
        assert_eq!(got, [
            ("js/sql-injection", AdvisoryKind::Code, Severity::High, "high", Some("src/db.js:42")),
            ("js/unused-local-variable", AdvisoryKind::Code, Severity::Low, "note", Some("src/util.js:3")),
        ]);
        assert_eq!(items(&r)[0].tool, "CodeQL");
        assert_eq!(items(&r)[0].summary, "This query string depends on a user-provided value.");
        assert!(ex.calls()[0].iter().any(|a| a.starts_with("repos/acme/app/code-scanning/alerts?state=open")), "{:?}", ex.calls());
        assert_eq!(ex.gh_accounts(), [Some("alice".to_string())]);
    }

    #[test]
    fn code_scanning_nobody_set_up_is_off_and_one_github_cannot_offer_is_unsupported() {
        let cs = |e: &str| read_with("/r", gh_code_scanning, &FakeExec::answering(Err(e))).err().unwrap();
        assert!(matches!(cs("gh: no analysis found (HTTP 404)"), Coverage::Off { .. }));
        let ghas = cs("gh: Advanced Security must be enabled for this repository to use code scanning. (HTTP 403)");
        assert!(matches!(ghas, Coverage::Unsupported { .. }), "{ghas:?}");
        let Coverage::NoAccess { fix, .. } = cs("HTTP 403: Resource not accessible by integration (needs security_events)") else { panic!() };
        assert!(fix.unwrap().contains("security_events"), "the scope, as Dependabot's alerts need it");
        assert!(matches!(cs("gh: Not Found (HTTP 404)"), Coverage::NoAccess { .. }), "a repository the account cannot see");
        assert!(matches!(cs("HTTP 502"), Coverage::Error { .. }));
    }

    #[test]
    fn secret_scanning_alerts_say_whether_the_secret_still_works() {
        let ex = FakeExec::answering(Ok(&FakeExec::testdata("gh-secret-scanning-alerts.json")));
        let r = read_with("/r", gh_secret_scanning, &ex).unwrap();
        assert!(ex.calls()[0].iter().any(|a| a.ends_with("&hide_secret=true")), "never fetch the leaked value: {:?}", ex.calls());
        let got: Vec<_> = items(&r).iter().map(|a| (a.id.as_str(), a.kind, a.summary.as_str(), a.location.as_deref())).collect();
        assert_eq!(got, [
            ("secret #3", AdvisoryKind::Secret, "GitHub Personal Access Token, still valid", Some("scripts/seed.ts:12")),
            ("secret #4", AdvisoryKind::Secret, "Slack Incoming Webhook URL", None),
        ]);
        assert!(items(&r).iter().all(|a| a.severity == Severity::Unknown), "a secret has no severity to invent");
    }

    #[test]
    fn secret_scanning_403_names_the_role_it_needs() {
        let ss = |e: &str| read_with("/r", gh_secret_scanning, &FakeExec::answering(Err(e))).err().unwrap();
        let Coverage::NoAccess { reason, fix } = ss("gh: Resource not accessible by personal access token (HTTP 403)") else { panic!() };
        assert!(reason.contains("admins and security managers") && reason.contains("alice"), "{reason}");
        assert!(fix.unwrap().contains("account"));
        assert!(matches!(ss("gh: Secret scanning is disabled on this repository. (HTTP 404)"), Coverage::Off { .. }));
        assert!(matches!(ss("gh: Advanced Security must be enabled for this repository to use secret scanning. (HTTP 403)"), Coverage::Unsupported { .. }));
        let Coverage::NoAccess { fix, .. } = ss("HTTP 403: needs the security_events scope") else { panic!() };
        assert!(fix.unwrap().contains("gh auth refresh"));
        assert!(matches!(ss("HTTP 403: API rate limit exceeded for user ID 1"), Coverage::Error { .. }), "a rate limit blames no role");
    }

    fn sarif(file: &str) -> Vec<Advisory> {
        parse_sarif(&FakeExec::testdata(file), file, "/work/app").unwrap()
    }

    #[test]
    fn sarif_from_semgrep_codeql_and_gitleaks_reads_as_one_shape() {
        let s = sarif("semgrep.sarif");
        let got: Vec<_> = s.iter().map(|a| (a.kind, a.severity, a.raw_severity.as_str(), a.location.as_deref())).collect();
        assert_eq!(got, [
            (AdvisoryKind::Code, Severity::High, "error", Some("app/views.py:17")),
            (AdvisoryKind::Code, Severity::Medium, "warning", Some("app/debug.py:4")),
        ], "the suppressed one is left out");
        assert_eq!(s[0].summary, "Detected user input used to manually construct a SQL string.", "one line of the message");
        assert!(s[0].url.as_deref().unwrap().starts_with("https://semgrep.dev/r/"));
        assert_eq!(s[0].tool, "Semgrep OSS");

        let c = sarif("codeql.sarif");
        let got: Vec<_> = c.iter().map(|a| (a.id.as_str(), a.severity, a.raw_severity.as_str(), a.location.as_deref())).collect();
        assert_eq!(got, [
            ("js/sql-injection", Severity::High, "8.8", Some("src/db.js:42")),
            ("js/log-injection", Severity::High, "7.8", Some("src/log.js:5")),
        ], "rules found in the extension, scores as text or number, a fixed result dropped");

        let g = sarif("gitleaks.sarif");
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].id.as_str(), g[0].kind, g[0].location.as_deref()), ("generic-api-key", AdvisoryKind::Secret, Some("config/dev.env:3")));
        assert_eq!(g[0].severity, Severity::Medium, "no level is SARIF's default, warning");

        assert!(parse_sarif("{}", "x.sarif", "").is_err() && parse_sarif("<html>", "x.sarif", "").is_err());
        assert_eq!(kind_of("Trivy", "CVE-2026-1", &["vulnerability"]), AdvisoryKind::Dependency);
        assert_eq!(kind_of("Trivy", "AVD-DS-0002", &["misconfiguration"]), AdvisoryKind::Config);
        assert_eq!(kind_of("Grype", "cve-2026-1", &[]), AdvisoryKind::Dependency, "a lowercase id is still a CVE");
    }

    #[test]
    fn a_sarif_location_is_named_as_the_repository_names_it() {
        let bases = ["C:/work/my app".to_string(), "/home/runner/work/app/app/".to_string()];
        assert_eq!(sarif_path("file:///C:/work/my%20app/src/a.js", &bases), "src/a.js");
        assert_eq!(sarif_path("file:///c:/work/my%20app/src/a.js", &bases), "src/a.js", "a drive letter in either case");
        assert_eq!(sarif_path("/home/runner/work/app/app/lib/b.rs", &bases), "lib/b.rs");
        assert_eq!(sarif_path("./src/c.py", &bases), "src/c.py");
        assert_eq!(sarif_path("src\\d.cs", &bases), "src/d.cs");
        assert_eq!(sarif_path("/elsewhere/e.js", &bases), "/elsewhere/e.js", "outside every base: kept as reported");
        assert_eq!(sarif_path("src/100%25.js", &["src".to_string()]), "src/100%.js", "a relative base strips nothing");
        assert_eq!(pct_decode("a%2xb%"), "a%2xb%");
    }

    fn sarif_repo(toml: &str, files: &[(&str, &str)]) -> (String, MaintConfig) {
        let dir = scratch_dir();
        for (rel, text) in files {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        (dir.to_string_lossy().to_string(), parse_maint(toml))
    }

    fn read_sarif(root: &str, cfg: &MaintConfig) -> Result<Read, Coverage> {
        let ex = FakeExec::answering(Err("no call"));
        let r = sarif_files(&Ctx { root, cfg, forge: &github(), account: None, force: false }, &ex);
        assert!(ex.calls().is_empty(), "a local source runs nothing");
        r
    }

    #[test]
    fn sarif_files_reads_what_the_patterns_name_and_says_what_it_could_not() {
        let semgrep = FakeExec::testdata("semgrep.sarif");
        let gitleaks = FakeExec::testdata("gitleaks.sarif");
        let (root, cfg) = sarif_repo("[maintenance]\nsarif = [\"build/reports/*.sarif\", \"leaks.sarif\", \"../x.sarif\"]\n", &[
            ("build/reports/semgrep.sarif", &semgrep),
            ("build/reports/again/semgrep.sarif", &semgrep),
            ("build/reports/broken.sarif", "{not json"),
            ("build/reports/notes.txt", "x"),
            ("leaks.sarif", &gitleaks),
        ]);
        let r = read_sarif(&root, &cfg).unwrap();
        assert_eq!(items(&r).len(), 3, "a finding two logs repeat counts once");
        assert!(items(&r).iter().any(|a| a.kind == AdvisoryKind::Secret));
        assert!(r.gaps.iter().any(|g| g.contains("broken.sarif")), "{:?}", r.gaps);
        assert!(r.gaps.iter().any(|g| g.contains("../x.sarif")), "a pattern outside the project is refused");
        assert!(!r.truncated);

        let (root, cfg) = sarif_repo("[maintenance]\nsarif = [\"out/*.sarif\"]\n", &[]);
        assert!(matches!(read_sarif(&root, &cfg), Err(Coverage::Unsupported { .. })), "nothing matched is no report, not a clean one");
        let (root, cfg) = sarif_repo("[maintenance]\nsarif = [\"bad.sarif\"]\n", &[("bad.sarif", "<html>")]);
        assert!(matches!(read_sarif(&root, &cfg), Err(Coverage::Error { .. })), "no file read is never ok");
        let (root, cfg) = sarif_repo("", &[]);
        assert!(matches!(read_sarif(&root, &cfg), Err(Coverage::Unsupported { .. })));
    }

    #[test]
    fn a_sarif_walk_cut_short_by_a_cap_is_a_floor() {
        let log = r#"{"runs":[]}"#;
        let (root, cfg) = sarif_repo("[maintenance]\nsarif = [\"deep/*.sarif\"]\n", &[
            ("deep/top.sarif", log),
            ("deep/a/b/c/d/e/f/below.sarif", log),
        ]);
        assert!(read_sarif(&root, &cfg).unwrap().truncated, "a folder below the depth cap was never looked in");
        let many: Vec<(String, &str)> = (0..=SARIF_FILES).map(|i| (format!("r/{i}.sarif"), log)).collect();
        let many: Vec<(&str, &str)> = many.iter().map(|(p, t)| (p.as_str(), *t)).collect();
        let (root, cfg) = sarif_repo("[maintenance]\nsarif = [\"r/*.sarif\"]\n", &many);
        assert!(read_sarif(&root, &cfg).unwrap().truncated, "more files than are read");
    }

    #[test]
    fn cvss3_scores_by_firsts_formula() {
        let s = |v: &str| cvss3(&format!("CVSS:3.1/{v}"));
        assert_eq!(s("AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), Some(9.8));
        assert_eq!(s("AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H"), Some(7.2));
        assert_eq!(s("AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H"), Some(8.1));
        assert_eq!(s("AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L"), Some(5.3));
        assert_eq!(s("AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N"), Some(6.1), "a changed scope");
        assert_eq!(s("AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N"), Some(0.0));
        assert_eq!(cvss3("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), None, "another version is not guessed at");
        assert_eq!(cvss3("CVSS:3.1/AV:X"), None);
    }

    fn lock_repo(files: &[(&str, &str)]) -> String {
        sarif_repo("", files).0
    }

    fn read_at(root: &str, f: ReadFn, ex: &FakeExec) -> Result<Read, Coverage> {
        f(&Ctx { root, cfg: &MaintConfig::default(), forge: &github(), account: None, force: true }, ex)
    }

    const OSV_NPM: &str = r#"{"lockfileVersion": 3, "packages": {"": {}, "node_modules/minimist": {"version": "1.2.5"}}}"#;

    fn osv_answers() -> FakeExec {
        let mut ex = FakeExec::answering(Err("no such record"))
            .on(&["curl", "https://api.osv.dev/v1/querybatch"], Ok(&FakeExec::testdata("osv-querybatch.json")));
        for id in ["GHSA-43w2-9j62-hq99", "RUSTSEC-2021-0003", "GHSA-xvch-5gv4-984h"] {
            ex = ex.on(&["curl", &format!("https://api.osv.dev/v1/vulns/{id}")], Ok(&FakeExec::testdata(&format!("osv-{id}.json"))));
        }
        ex
    }

    #[test]
    fn osv_asks_once_per_package_and_reads_each_record_with_githubs_severity() {
        let root = lock_repo(&[("Cargo.lock", &FakeExec::testdata("lock-cargo.lock")), ("web/package-lock.json", OSV_NPM), ("yarn.lock", "")]);
        let ex = osv_answers();
        let r = read_at(&root, osv, &ex).unwrap();
        let sent = &ex.calls()[0];
        assert_eq!(sent[..3], ["curl", "https://api.osv.dev/v1/querybatch", "--data"]);
        let body: Value = serde_json::from_str(&sent[3]).unwrap();
        assert_eq!(body["queries"][1], serde_json::json!({ "package": { "name": "smallvec", "ecosystem": "crates.io" }, "version": "1.6.0" }));
        assert_eq!(body["queries"].as_array().unwrap().len(), 3, "names and versions, nothing else");
        let got: Vec<_> = items(&r).iter()
            .map(|a| (a.id.as_str(), a.pkg.as_deref(), a.severity, a.raw_severity.as_str(), a.fixed.as_deref(), a.location.as_deref()))
            .collect();
        let vector = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
        assert_eq!(got, [
            ("GHSA-43w2-9j62-hq99", Some("smallvec"), Severity::Critical, "CRITICAL", Some("1.6.1"), Some("Cargo.lock")),
            ("RUSTSEC-2021-0003", Some("smallvec"), Severity::Critical, vector, Some("1.6.1"), Some("Cargo.lock")),
            ("GHSA-xvch-5gv4-984h", Some("minimist"), Severity::Critical, "CRITICAL", Some("1.2.6"), Some("web/package-lock.json")),
        ], "GitHub's word where the record is GitHub's, a scored vector where it is not, the fix for the installed range");
        assert_eq!(items(&r)[1].aliases, ["CVE-2021-25900", "GHSA-43w2-9j62-hq99"], "so the two fold into one row");
        assert_eq!(items(&r)[2].version.as_deref(), Some("1.2.5"));
        assert_eq!(r.gaps, ["yarn.lock not read"]);
        assert!(!r.truncated);

        // A record whose `modified` stands is not fetched again.
        let again = osv_answers();
        read_at(&root, osv, &again).unwrap();
        assert_eq!(again.calls().len(), 1, "{:?}", again.calls());
    }

    #[test]
    fn osv_caps_its_follow_ups_and_says_what_a_page_left_out() {
        let mut ids: Vec<String> = (0..=OSV_DETAILS).map(|n| format!(r#"{{"id":"CAP-{n}","modified":"m"}}"#)).collect();
        ids.push(r#"{"id":"GHSA-zzzz-zzzz-zzzz","modified":"m"}"#.into()); // sorts after every CAP-
        let batch = format!(r#"{{"results":[{{"vulns":[{}],"next_page_token":"x"}}]}}"#, ids.join(","));
        let ex = FakeExec::answering(Ok("{}")).on(&["curl", "https://api.osv.dev/v1/querybatch"], Ok(&batch));
        let root = lock_repo(&[("package-lock.json", OSV_NPM)]);
        let r = read_at(&root, osv, &ex).unwrap();
        let asked: Vec<_> = ex.calls().into_iter().filter(|c| c[1].contains("/vulns/")).map(|c| c[1].clone()).collect();
        assert_eq!(asked.len(), OSV_DETAILS);
        assert!(asked[0].ends_with("/vulns/GHSA-zzzz-zzzz-zzzz"), "GitHub's word is asked for first: {asked:?}");
        assert_eq!(items(&r).len(), OSV_DETAILS + 2, "the ones past the cap are still findings");
        assert_eq!(items(&r).iter().filter(|a| a.severity == Severity::Unknown).count(), OSV_DETAILS + 2);
        assert!(r.gaps.iter().any(|g| g.starts_with("2 more advisories")), "{:?}", r.gaps);
        assert!(r.truncated, "a package with another page of vulnerabilities is a floor");

        let wrong = FakeExec::answering(Ok(r#"{"results":[]}"#));
        assert!(matches!(read_at(&root, osv, &wrong), Err(Coverage::Error { .. })), "not one result per package");
        assert!(matches!(read_at(&lock_repo(&[]), osv, &wrong), Err(Coverage::Unsupported { .. })), "no lockfile is nothing to ask");
        let v1 = lock_repo(&[("package-lock.json", r#"{"lockfileVersion": 1}"#)]);
        let Err(Coverage::Unsupported { reason }) = read_at(&v1, osv, &wrong) else { panic!() };
        assert!(reason.contains("lockfileVersion 1"), "a lockfile no parser knows is never a clean one: {reason}");
        assert_eq!(wrong.calls().len(), 1, "nothing is sent for a lockfile that was not read");
    }

    #[test]
    fn an_audit_that_exits_1_with_its_report_found_something() {
        let npm = lock_repo(&[("package-lock.json", "{}")]);
        let ex = FakeExec::answering(Ok(&FakeExec::testdata("npm-audit.json"))).exiting(1, "");
        let r = read_at(&npm, npm_audit, &ex).unwrap();
        assert_eq!(ex.calls(), [["npm", "audit", "--json"]]);
        let a = items(&r).iter().find(|a| a.id == "GHSA-xvch-5gv4-984h").unwrap();
        assert_eq!((a.pkg.as_deref(), a.severity, a.fixed.as_deref(), a.tool.as_str()), (Some("minimist"), Severity::Critical, Some("1.2.8"), "npm audit"));
        let lodash = items(&r).iter().filter(|a| a.pkg.as_deref() == Some("lodash")).map(|a| (a.id.as_str(), a.severity)).collect::<Vec<_>>();
        assert_eq!(lodash.len(), 5);
        assert!(lodash.contains(&("GHSA-29mw-wpgm-hmr9", Severity::Medium)), "moderate is medium");

        let pnpm = lock_repo(&[("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")]);
        let ex = FakeExec::answering(Ok(&FakeExec::testdata("pnpm-audit.json"))).exiting(1, "");
        let r = read_at(&pnpm, pnpm_audit, &ex).unwrap();
        assert_eq!(ex.calls(), [["pnpm", "audit", "--json", PNPM_SAFE[0], PNPM_SAFE[1]]]);
        let a = items(&r).iter().find(|a| a.id == "GHSA-xvch-5gv4-984h").unwrap();
        assert_eq!((a.aliases.clone(), a.version.as_deref(), a.fixed.as_deref()), (vec!["CVE-2021-44906".to_string()], Some("1.2.5"), Some("1.2.6")));
        assert_eq!(items(&r).len(), 6);

        let cargo = lock_repo(&[("Cargo.lock", &FakeExec::testdata("lock-cargo.lock"))]);
        let ex = FakeExec::answering(Ok(&FakeExec::testdata("cargo-audit.json"))).exiting(1, "");
        let r = read_at(&cargo, cargo_audit, &ex).unwrap();
        assert_eq!(ex.calls(), [["cargo-audit", "audit", "--json"]], "never `cargo audit`, which a project alias can take");
        let got: Vec<_> = items(&r).iter().map(|a| (a.id.as_str(), a.severity, a.version.as_deref(), a.fixed.as_deref())).collect();
        assert_eq!(got, [("RUSTSEC-2021-0003", Severity::Critical, Some("1.6.0"), Some("1.6.1"))], "a warning is not a vulnerability");
        assert_eq!(items(&r)[0].aliases, ["CVE-2021-25900", "GHSA-43w2-9j62-hq99"]);
    }

    /// The real pnpm, executed: its pnpmfile is project code. `config get` reads no registry.
    #[test]
    fn pnpm_never_loads_the_projects_pnpmfile() {
        let path = crate::platform::augmented_path();
        if crate::maint::exec::resolve_bin("pnpm", &path).is_none() {
            eprintln!("pnpm is not installed here; skipped");
            return;
        }
        let proj = lock_repo(&[("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"), ("package.json", "{\"name\":\"x\",\"version\":\"1.0.0\"}\n")]);
        let proj = std::path::PathBuf::from(proj);
        std::fs::write(proj.join(".pnpmfile.cjs"), "console.error('PLANTED'); console.log('PLANTED'); module.exports = {}\n").unwrap();
        // A workspace may ask for the pnpmfile back; only the CLI flag outranks it.
        std::fs::write(proj.join("pnpm-workspace.yaml"), "packages: ['.']\nignorePnpmfile: false\n").unwrap();
        let args = ["config", "get", "registry", PNPM_SAFE[0], PNPM_SAFE[1]];
        let out = crate::maint::exec::tool_cmd("pnpm", &args, &path).unwrap().current_dir(&proj).env("CI", "1").output().unwrap();
        let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(!said.contains("PLANTED") && said.contains("http"), "{said}");
    }

    #[test]
    fn an_audit_tool_that_is_not_there_says_how_to_get_it() {
        let npm = lock_repo(&[("package-lock.json", "{}")]);
        let ex = FakeExec::answering(Ok("{}")).without(&["npm"]);
        let Err(Coverage::NoTool { tool, fix }) = read_at(&npm, npm_audit, &ex) else { panic!() };
        assert_eq!((tool.as_str(), fix.is_some(), ex.calls().len()), ("npm", true, 0));
        let cargo = lock_repo(&[("Cargo.lock", "")]);
        let ex = FakeExec::answering(Ok("")).without(&["cargo-audit"]);
        let Err(Coverage::NoTool { tool, fix }) = read_at(&cargo, cargo_audit, &ex) else { panic!() };
        assert_eq!((tool.as_str(), fix.as_deref()), ("cargo-audit", Some("cargo install cargo-audit --locked")));
        let offline = FakeExec::answering(Ok(r#"{"error": {"code": "ENOTFOUND", "summary": "request to registry failed"}}"#)).exiting(1, "");
        let Err(Coverage::Error { reason }) = read_at(&npm, npm_audit, &offline) else { panic!() };
        assert!(reason.contains("request to registry failed"), "{reason}");
        assert!(matches!(read_at(&lock_repo(&[]), npm_audit, &offline), Err(Coverage::Unsupported { .. })));
    }

    #[test]
    fn a_folder_whose_audit_timed_out_is_a_gap_beside_the_folders_that_answered() {
        let two = lock_repo(&[("package-lock.json", "{}"), ("web/package-lock.json", "{}")]);
        let ex = FakeExec::recorded("npm-audit.json").failing_in("web", "no answer after 180s");
        let r = read_at(&two, npm_audit, &ex).unwrap();
        assert!(!items(&r).is_empty(), "the root's findings survive");
        assert_eq!(r.gaps, ["web/package-lock.json: no answer after 180s"]);
        let slow = FakeExec::answering(Err("no answer after 180s"));
        let Err(Coverage::Error { reason }) = read_at(&two, npm_audit, &slow) else { panic!() };
        assert!(reason.contains("no answer after 180s") && reason.contains("web/package-lock.json"), "{reason}");
    }

    #[test]
    fn the_files_detection_offers_these_sources_on_are_the_files_they_read() {
        let man: Value = serde_json::from_str(include_str!("../../src/maintmanifest.json")).unwrap();
        let detect = |id: &str| -> BTreeSet<String> { strs(man.pointer(&format!("/sources/{id}/detect"))).into_iter().collect() };
        assert_eq!(detect("osv"), LOCKFILES.iter().map(|s| s.to_string()).collect(), "a lockfile with no parser, or one never offered");
        for (id, a) in [("npm-audit", NPM_AUDIT), ("pnpm-audit", PNPM_AUDIT), ("cargo-audit", CARGO_AUDIT)] {
            assert_eq!(detect(id), BTreeSet::from([a.lock.to_string()]), "{id}");
        }
    }

    #[test]
    fn a_patched_range_names_the_floor_above_what_is_installed() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(patched_for("1.6.0", &p(&[">=0.6.14, <1.0.0", ">=1.6.1"])).as_deref(), Some("1.6.1"));
        assert_eq!(patched_for("0.6.5", &p(&[">=0.6.14, <1.0.0", ">=1.6.1"])).as_deref(), Some("0.6.14"));
        assert_eq!(patched_for("2.0.0", &p(&[">=1.6.1"])), None);
        assert_eq!((floor_of(">=1.2.6").as_deref(), floor_of("<0.0.0")), (Some("1.2.6"), None), "npm's no-fix range");
        assert_eq!(floor_of(">=1.0.0 <2.0.0").as_deref(), Some(">=1.0.0 <2.0.0"), "kept as written");
    }
}
