//! The security facet (docs/maintenance.md § Adapters): `dependabot-alerts`, the alert half of
//! `dep_report` through its shared cache, each alert as a reporter-neutral `Advisory`.

use crate::deps::{alerts_read, coverage_of, DepAlert};
use crate::maint::{github_repo, Advisory, AdvisoryKind, Coverage, Ctx, Exec, Facts, Read, Severity};

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

fn some(s: &str) -> Option<String> {
    Some(s.to_string()).filter(|s| !s.is_empty())
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::MaintConfig;

    // A distinct root per read: a forced read still joins an answer under `FORCE_JOIN` old.
    fn read(root: &str, ex: &FakeExec) -> Result<Read, Coverage> {
        let cfg = MaintConfig::default();
        let forge = Forge { kind: ForgeKind::Github, host: Some("github.com".into()), path: Some("acme/app".into()), by: ForgeBy::Table };
        dependabot_alerts(&Ctx { root, cfg: &cfg, forge: &forge, account: Some("alice"), force: true }, ex)
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
        let Facts::Advisories { items } = &r.facts else { panic!() };
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
    }
}
