//! The security facet (docs/maintenance.md § Adapters): `dependabot-alerts` through `dep_report`'s
//! shared cache, GitHub's code and secret scanning, and the SARIF files a project names. Every
//! finding becomes a reporter-neutral `Advisory`; `mergeAdvisories` folds them in `maint.ts`.

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;

use crate::deps::{alerts_read, coverage_of, DepAlert};
use crate::git::glob_match;
use crate::github::who_for;
use crate::maint::{github_repo, Advisory, AdvisoryKind, Coverage, Ctx, Exec, Facts, Read, Severity, SKIP_DIRS};

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

fn text<'a>(v: &'a Value, ptr: &str) -> &'a str {
    v.pointer(ptr).and_then(Value::as_str).unwrap_or("")
}

fn located(path: &str, line: Option<u64>) -> Option<String> {
    some(path).map(|p| match line {
        Some(l) => format!("{p}:{l}"),
        None => p,
    })
}

/// One line, at most 200 characters: a scanner's message can run to paragraphs.
fn summary_of(s: &str) -> String {
    let line = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    line.chars().take(200).collect()
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
        if p.starts_with('/') || p.contains("..") || p.contains('\\') || p.contains(':') {
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
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > SARIF_BYTES) {
            gaps.push(format!("{f} is too large to read"));
            continue;
        }
        match std::fs::read_to_string(&path).map_err(|e| format!("{f}: {e}")).and_then(|t| parse_sarif(&t, f, ctx.root)) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::{parse_maint, MaintConfig, ReadFn};
    use crate::testutil::scratch_dir;

    fn github() -> Forge {
        Forge { kind: ForgeKind::Github, host: Some("github.com".into()), path: Some("acme/app".into()), by: ForgeBy::Table }
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
}
