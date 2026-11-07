//! The Prod facet's error trackers (docs/maintenance.md § Adapters): `sentry-issues`, a project's unresolved
//! issues and newest release, read on a click with the token saved for the tracker's host. Facts only.

use serde_json::Value;

use crate::maint::exec::{Auth, HttpReq, HttpResp};
use crate::maint::{Coverage, Ctx, ErrIssue, ErrLevel, ErrRelease, ErrTrend, Exec, Facts, MaintConfig, Read};
use crate::maint_tokens::{valid_host, TokenCheck};
use crate::usage::iso_epoch_secs;

const SOURCE: &str = "sentry-issues";
const KIND: &str = "sentry";
const SAAS: &str = "sentry.io";
// Read scope, not thresholds: the window the issues were seen in, and the page the newest first seen fill.
const WINDOW_DAYS: u32 = 14;
const ISSUE_CAP: usize = 100;
const SECS: u64 = 15;
const TEXT_MAX: usize = 300;

/// The slot a host's token is saved under: the hosted service's regional and organisation subdomains
/// share its own, so `de.sentry.io` reads with the token saved for `sentry.io`.
pub(crate) fn slot_of(host: &str) -> String {
    if host == SAAS || host.ends_with(".sentry.io") { SAAS.into() } else { host.into() }
}

fn unsupported(reason: String) -> Coverage {
    Coverage::Unsupported { reason }
}

/// `[maintenance.params] sentry_url` (default the hosted service) and the slot its token is saved under.
/// Https only: a token never travels over http, and a committed URL picks only among saved slots.
fn base_of(cfg: &MaintConfig) -> Result<(String, String), Coverage> {
    let raw = cfg.param("sentry_url").unwrap_or("https://sentry.io");
    let u = url::Url::parse(raw).map_err(|_| unsupported(format!("sentry_url = \"{raw}\" is not an address")))?;
    if u.scheme() != "https" {
        return Err(unsupported(format!("sentry_url = \"{raw}\" is not https, and a token is never sent over http")));
    }
    if u.query().is_some() || u.fragment().is_some() || !u.username().is_empty() {
        return Err(unsupported(format!("sentry_url = \"{raw}\" is not a bare https address")));
    }
    let host = u.host_str().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
    let slot = format!("{}{}", slot_of(&host), u.port().map(|p| format!(":{p}")).unwrap_or_default());
    if !valid_host(&slot) {
        return Err(unsupported(format!("sentry_url = \"{raw}\" names no plain host")));
    }
    Ok((u.as_str().trim_end_matches('/').to_string(), slot))
}

/// `[maintenance.params] sentry_environment`: one name, or every environment when absent.
fn env_of(cfg: &MaintConfig) -> Result<Option<String>, Coverage> {
    match cfg.param("sentry_environment") {
        None => Ok(None),
        Some(e) if e.len() <= 64 && e.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) => Ok(Some(e.into())),
        Some(e) => Err(unsupported(format!("sentry_environment = \"{e}\" is not one environment name"))),
    }
}

/// The tracker's own word, kept raw beside this (a level it never documented is `unknown`).
fn level(raw: &str) -> ErrLevel {
    match raw.to_ascii_lowercase().as_str() {
        "fatal" => ErrLevel::Fatal,
        "error" => ErrLevel::Error,
        "warning" => ErrLevel::Warning,
        "info" => ErrLevel::Info,
        "debug" => ErrLevel::Debug,
        _ => ErrLevel::Unknown,
    }
}

/// An unresolved issue's substatus; an older self-hosted tracker sends none, which is `unknown`.
fn trend(raw: &str) -> ErrTrend {
    match raw.to_ascii_lowercase().as_str() {
        "new" => ErrTrend::New,
        "regressed" => ErrTrend::Regressed,
        "escalating" => ErrTrend::Escalating,
        "ongoing" => ErrTrend::Ongoing,
        _ => ErrTrend::Unknown,
    }
}

// A title reaches a card line and a brief: one line, cut short.
fn clip(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).take(TEXT_MAX).collect::<String>().trim().to_string()
}

fn web(u: &&str) -> bool {
    let l = u.to_ascii_lowercase();
    l.starts_with("https://") || l.starts_with("http://")
}

fn json(body: &str) -> Result<Value, String> {
    serde_json::from_str(body).map_err(|_| "the answer was not JSON".to_string())
}

fn parse_project(body: &str) -> Result<String, String> {
    let v = json(body)?;
    let id = v.get("id").and_then(|x| x.as_str().map(str::to_string).or_else(|| x.as_u64().map(|n| n.to_string())));
    id.filter(|i| !i.is_empty() && i.bytes().all(|b| b.is_ascii_digit())).ok_or_else(|| "the project's answer carried no id".into())
}

fn issue(v: &Value) -> Option<ErrIssue> {
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    let id = s("id").filter(|i| !i.is_empty() && i.len() <= 32)?.to_string();
    let (raw_level, raw_trend) = (s("level").unwrap_or_default().to_string(), s("substatus").unwrap_or_default().to_string());
    // The tracker sends a count as a string, since it may outgrow a JavaScript number.
    let events = v.get("count").and_then(|c| c.as_u64().or_else(|| c.as_str()?.parse().ok())).unwrap_or(0);
    let short_id = clip(s("shortId").unwrap_or(&id));
    // Under a statsPeriod the top-level firstSeen is the window's first event; `lifetime` holds the issue's own.
    let born = v.get("lifetime").and_then(|l| l.get("firstSeen")).and_then(Value::as_str).or_else(|| s("firstSeen"));
    Some(ErrIssue {
        title: s("title").map(clip).filter(|t| !t.is_empty()).unwrap_or_else(|| short_id.clone()),
        culprit: s("culprit").map(clip).filter(|c| !c.is_empty()),
        level: level(&raw_level), raw_level: clip(&raw_level), trend: trend(&raw_trend), raw_trend: clip(&raw_trend),
        events, users: v.get("userCount").and_then(Value::as_u64).unwrap_or(0),
        first_seen: born.and_then(iso_epoch_secs), last_seen: s("lastSeen").and_then(iso_epoch_secs),
        unhandled: v.get("isUnhandled").and_then(Value::as_bool), url: s("permalink").filter(web).map(str::to_string),
        id, short_id,
    })
}

pub(crate) fn parse_issues(body: &str) -> Result<Vec<ErrIssue>, String> {
    let v = json(body)?;
    let list = v.as_array().ok_or("the issue list was not a list")?;
    Ok(list.iter().filter_map(issue).collect())
}

/// The newest release and its last event, the one positive evidence that events still arrive.
fn parse_release(body: &str) -> Result<(Option<ErrRelease>, Option<u64>), String> {
    let v = json(body)?;
    let Some(r) = v.as_array().ok_or("the release list was not a list")?.first() else { return Ok((None, None)) };
    let s = |k: &str| r.get(k).and_then(Value::as_str);
    let version = s("version").map(clip).filter(|x| !x.is_empty()).ok_or("the newest release has no version")?;
    let at = s("dateReleased").and_then(iso_epoch_secs).or_else(|| s("dateCreated").and_then(iso_epoch_secs));
    let new_issues = r.get("newGroups").and_then(Value::as_u64).map(|n| n.min(u32::MAX as u64) as u32);
    Ok((Some(ErrRelease { version, at, new_issues }), s("lastEvent").and_then(iso_epoch_secs)))
}

fn detail_of(body: &str) -> String {
    serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("detail")?.as_str().map(clip)).filter(|d| !d.is_empty())
        .map(|d| format!(": {d}")).unwrap_or_default()
}

/// No token saved for the slot: nothing is asked, and Coverage's door is Settings › Accounts.
pub(crate) fn no_token(slot: &str) -> Coverage {
    Coverage::NoTool { tool: format!("a token for {slot}"), fix: None }
}

/// A refusal as a coverage: a token refused or short of a scope, a project nobody here may see, a rate limit.
pub(crate) fn refusal(code: u16, body: &str, slot: &str, project: &str) -> Coverage {
    let said = detail_of(body);
    match code {
        401 => Coverage::NoAccess { reason: format!("{slot} refused the stored token{said}"), fix: None },
        403 => {
            let need = crate::maint::token_of(SOURCE).map(|t| t.scopes.join(", ")).unwrap_or_default();
            Coverage::NoAccess { reason: format!("a required scope is missing: this read needs {need}{said}"), fix: None }
        }
        404 => Coverage::NoAccess { reason: format!("{slot} has no project {project}, or this token's account cannot see it"), fix: None },
        429 => Coverage::Error { reason: format!("rate limited by {slot}") },
        c => Coverage::Error { reason: format!("{slot} answered HTTP {c}{said}") },
    }
}

fn get(ex: &dyn Exec, url: String, slot: &str) -> Result<HttpResp, String> {
    ex.http(&HttpReq { url, body: None, auth: Some(Auth::Sealed { kind: KIND, slot: slot.into() }), secs: SECS, report: false })
}

/// A 200 or the coverage its refusal is; a transfer that failed is curl's own error, verbatim.
fn answered(r: Result<HttpResp, String>, slot: &str, project: &str) -> Result<String, Coverage> {
    let r = r.map_err(|reason| Coverage::Error { reason })?;
    if r.code != 200 {
        return Err(refusal(r.code, &r.body, slot, project));
    }
    Ok(r.body)
}

/// The unresolved issues of the project `[deploy] sentry` names, seen in the last fortnight, newest first
/// seen first, and its newest release. A `remote` read: a click asks it, with the token saved for its host.
pub(crate) fn sentry_issues(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let project = crate::deploy::read(ctx.root).and_then(|d| d.sentry().map(str::to_string))
        .ok_or_else(|| unsupported("[deploy] names no error tracker project".into()))?;
    let (org, slug) = project.split_once('/').ok_or_else(|| unsupported(format!("{project} is not org/project")))?;
    let (base, slot) = base_of(ctx.cfg)?;
    let env = env_of(ctx.cfg)?;
    if !ex.has_auth(KIND, &slot) {
        return Err(no_token(&slot));
    }
    // The numeric id: a wrong slug is a clean 404 here, and an older self-hosted tracker takes no slug below.
    let body = answered(get(ex, format!("{base}/api/0/projects/{org}/{slug}/"), &slot), &slot, &project)?;
    let id = parse_project(&body).map_err(|e| Coverage::Error { reason: format!("{slot}: {e}") })?;
    let env_q = env.as_deref().map(|e| format!("&environment={e}")).unwrap_or_default();
    // An empty groupStatsPeriod skips the per-issue series but keeps `lifetime`, which collapsing stats would drop.
    let issues_url = format!("{base}/api/0/organizations/{org}/issues/?project={id}&query=is%3Aunresolved&sort=new\
        &limit={ISSUE_CAP}&statsPeriod={WINDOW_DAYS}d&groupStatsPeriod=&collapse=filtered{env_q}");
    // Scoped like the issues, or its date and last event could be another environment's.
    let releases_url = format!("{base}/api/0/projects/{org}/{slug}/releases/?per_page=1{env_q}");
    let (issues, rel) = std::thread::scope(|s| {
        let rel = s.spawn(|| get(ex, releases_url, &slot));
        (get(ex, issues_url, &slot), rel.join().unwrap_or_else(|_| Err("the read panicked".into())))
    });
    // The project just answered, so a 404 here is the environment the tracker does not have.
    if let (Ok(r), Some(e)) = (&issues, &env) {
        if r.code == 404 {
            return Err(unsupported(format!("{project} on {slot} has no environment {e}: sentry_environment must name one it has")));
        }
    }
    let body = answered(issues, &slot, &project)?;
    let issues = parse_issues(&body).map_err(|e| Coverage::Error { reason: format!("{slot}: {e}") })?;
    let truncated = issues.len() >= ISSUE_CAP;
    let mut gaps = vec![];
    if truncated {
        gaps.push(format!("only the {ISSUE_CAP} issues first seen most recently are read"));
    }
    // A release read that failed costs its date, never the issues.
    let rel = rel.and_then(|r| if r.code == 200 { parse_release(&r.body) } else { Err(format!("HTTP {}", r.code)) });
    let (release, rel_last) = rel.unwrap_or_else(|e| {
        gaps.push(format!("the newest release was not read ({e})"));
        (None, None)
    });
    let last_event = issues.iter().filter_map(|i| i.last_seen).chain(rel_last).max();
    let url = Some(format!("{base}/organizations/{org}/issues/?project={id}&query=is%3Aunresolved{env_q}"));
    let facts = Facts::Errors { project, environment: env, window_days: WINDOW_DAYS, release, last_event, url, issues };
    Ok(Read { facts, truncated, gaps })
}

/// Settings › Accounts' Check: the API root as the token sees it, and which needed scopes it lacks
/// (`x:write` and `x:admin` include `x:read`). An answer with no `auth` is a token the host does not know.
pub(crate) fn sentry_check(slot: &str, need: &[String], ex: &dyn Exec) -> TokenCheck {
    let failed = |e: String| TokenCheck { error: Some(e), ..Default::default() };
    match get(ex, format!("https://{slot}/api/0/"), slot) {
        Err(e) => failed(e),
        // Only the host is saved, so a tracker under a path prefix answers its API root elsewhere.
        Ok(r) if r.code == 404 => failed(format!("{slot} has no API at /api/0/; one served under a path is checked by Check prod, through sentry_url")),
        Ok(r) if r.code != 200 => failed(format!("{slot} answered HTTP {}{}", r.code, detail_of(&r.body))),
        Ok(r) => parse_check(&r.body, slot, need),
    }
}

fn parse_check(body: &str, slot: &str, need: &[String]) -> TokenCheck {
    let Ok(v) = json(body) else { return TokenCheck { error: Some(format!("{slot}: the answer was not JSON")), ..Default::default() } };
    let Some(auth) = v.get("auth").filter(|a| a.is_object()) else {
        return TokenCheck { error: Some(format!("{slot} does not know this token")), ..Default::default() };
    };
    let scopes: Vec<String> = auth.get("scopes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
        .iter().filter_map(Value::as_str).map(clip).collect();
    let has = |want: &str| {
        let res = want.split_once(':').map_or(want, |(r, _)| r);
        [want.to_string(), format!("{res}:write"), format!("{res}:admin")].iter().any(|s| scopes.contains(s))
    };
    let missing: Vec<String> = need.iter().filter(|n| !has(n)).cloned().collect();
    let user = v.get("user");
    let who = user.and_then(|u| u.get("email").or_else(|| u.get("username"))).and_then(Value::as_str).map(clip).filter(|w| !w.is_empty());
    TokenCheck { ok: missing.is_empty(), who, scopes, missing, error: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::testutil::scratch_dir;

    const NONE: Forge = Forge { kind: ForgeKind::None, host: None, path: None, by: ForgeBy::None, api: None };
    const PROJECT: &str = "https://sentry.io/api/0/projects/acme/api/";
    const ISSUES: &str = "https://sentry.io/api/0/organizations/acme/issues/?project=4505278496&query=is%3Aunresolved&sort=new&limit=100&statsPeriod=14d&groupStatsPeriod=&collapse=filtered";
    const RELEASES: &str = "https://sentry.io/api/0/projects/acme/api/releases/?per_page=1";

    fn data(f: &str) -> String {
        FakeExec::testdata(f)
    }

    /// A project linked to `acme/api`, with `params` as `[maintenance.params]` lines.
    fn project(params: &str) -> (String, MaintConfig) {
        let dir = scratch_dir();
        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        let toml = format!("[deploy]\nsentry = \"acme/api\"\n[maintenance.params]\n{params}");
        std::fs::write(dir.join(".episko/episko.toml"), &toml).unwrap();
        (dir.to_string_lossy().to_string(), crate::maint::parse_maint(&toml))
    }

    fn read(params: &str, ex: &FakeExec) -> Result<Read, Coverage> {
        let (root, cfg) = project(params);
        sentry_issues(&Ctx { root: &root, cfg: &cfg, forge: &NONE, account: None, force: true, hosts: &[] }, ex)
    }

    /// The hand-written answers, `over` ruling first: FakeExec's first matching rule wins.
    fn recorded_with(over: &[(&str, Result<&str, &str>)]) -> FakeExec {
        let ex = over.iter().fold(FakeExec::answering(Ok(&data("sentry-issues-hand.json"))), |ex, (url, a)| ex.on(&["curl", url], *a));
        ex.on(&["curl", PROJECT], Ok(&data("sentry-project-hand.json"))).on(&["curl", RELEASES], Ok(&data("sentry-releases-hand.json")))
    }

    fn recorded() -> FakeExec {
        recorded_with(&[])
    }

    #[test]
    fn issues_parse_counts_dates_and_vocabulary() {
        let all = parse_issues(&data("sentry-issues-hand.json")).unwrap();
        assert_eq!(all.len(), 5);
        let a = &all[0];
        assert_eq!((a.id.as_str(), a.short_id.as_str(), a.events, a.users), ("6000000101", "PUMP-STATION-1A", 150, 120), "a count arrives as a string");
        assert_eq!(a.first_seen, iso_epoch_secs("2026-11-05T21:19:55Z"), "a fraction of a second is dropped");
        assert_eq!((a.level, a.trend, a.unhandled), (ErrLevel::Fatal, ErrTrend::New, Some(true)));
        assert_eq!(a.culprit.as_deref(), Some("raven.scripts.runner in main"));
        assert_eq!((all[1].trend, all[2].trend, all[4].trend), (ErrTrend::Regressed, ErrTrend::Escalating, ErrTrend::Ongoing));
        assert_eq!((all[1].level, all[2].level), (ErrLevel::Error, ErrLevel::Warning));
        assert_eq!(all[2].unhandled, None, "absent is unknown, never handled");
        // The window's first event fell after the release; the issue itself is older, so it is not new.
        assert_eq!((all[1].first_seen, all[1].events, all[1].users), (iso_epoch_secs("2026-09-01T08:00:00Z"), 12, 3), "lifetime's birth, the window's counts");
        assert_eq!(all[4].first_seen, iso_epoch_secs("2026-06-01T03:00:00Z"));
        assert_eq!(all[3].first_seen, iso_epoch_secs("2026-10-30T00:00:00Z"), "no lifetime block: the top-level date");
        let odd = &all[3];
        assert_eq!((odd.level, odd.raw_level.as_str()), (ErrLevel::Unknown, "sample"), "an odd word kept raw beside unknown");
        assert_eq!((odd.trend, odd.raw_trend.as_str()), (ErrTrend::Unknown, ""), "no substatus from an older tracker");
        assert_eq!((odd.events, odd.url.as_deref(), odd.culprit.as_deref()), (7, None, None), "a number count, a page that is not http(s) dropped");
        assert_eq!(odd.title, "Custom message with a second line", "one line");
        assert!(parse_issues("{\"detail\":\"x\"}").is_err() && parse_issues("<html>").is_err());
    }

    #[test]
    fn a_full_page_is_truncated() {
        let one = |n: usize| format!("{{\"id\":\"{n}\",\"shortId\":\"P-{n}\",\"title\":\"t\",\"count\":\"1\",\"userCount\":0,\"level\":\"error\",\"substatus\":\"ongoing\"}}");
        let page = format!("[{}]", (0..ISSUE_CAP).map(one).collect::<Vec<_>>().join(","));
        let ex = recorded_with(&[(ISSUES, Ok(&page))]);
        let r = read("", &ex).unwrap();
        assert!(r.truncated && r.gaps.iter().any(|g| g.contains("first seen most recently")));
        let Facts::Errors { issues, .. } = r.facts else { panic!() };
        assert_eq!(issues.len(), ISSUE_CAP);
    }

    #[test]
    fn a_read_asks_the_project_then_its_issues_and_newest_release() {
        let ex = recorded();
        let r = read("", &ex).unwrap();
        let Facts::Errors { project, environment, window_days, release, last_event, url, issues } = r.facts else { panic!() };
        assert_eq!((project.as_str(), environment, window_days, issues.len()), ("acme/api", None, 14, 5));
        let rel = release.unwrap();
        assert_eq!((rel.version.as_str(), rel.at, rel.new_issues), ("pump-station@1.4.0", iso_epoch_secs("2026-11-01T10:30:00Z"), Some(4)));
        assert_eq!(last_event, iso_epoch_secs("2026-11-06T22:00:00Z"), "the newest of the release's and the issues'");
        assert_eq!(url.as_deref(), Some("https://sentry.io/organizations/acme/issues/?project=4505278496&query=is%3Aunresolved"));
        assert!(!r.truncated && r.gaps.is_empty());
        let mut calls = ex.calls();
        calls.sort();
        assert_eq!(calls.len(), 3);
        assert!(calls.iter().all(|c| c.ends_with(&["--token".into(), "sentry@sentry.io".into()])), "{calls:?}");
        assert!(calls.iter().any(|c| c[1] == ISSUES), "every environment unless one is named: {calls:?}");
    }

    #[test]
    fn release_newest_and_last_event() {
        assert_eq!(parse_release("[]").unwrap(), (None, None));
        let only_made = "[{\"version\":\"2.0\",\"dateCreated\":\"2026-11-02T00:00:00Z\",\"dateReleased\":null,\"newGroups\":0,\"lastEvent\":null}]";
        let (r, last) = parse_release(only_made).unwrap();
        assert_eq!((r.unwrap().at, last), (iso_epoch_secs("2026-11-02T00:00:00Z"), None), "made, never marked released");
        // A failed releases read is a gap beside the issues, never the read.
        let ex = recorded_with(&[(RELEASES, Ok("<html>"))]).coded(&["curl", RELEASES], 502);
        let r = read("", &ex).unwrap();
        assert!(r.gaps.iter().any(|g| g.contains("newest release was not read (HTTP 502)")), "{:?}", r.gaps);
        let Facts::Errors { release, issues, .. } = r.facts else { panic!() };
        assert!(release.is_none() && issues.len() == 5);
    }

    #[test]
    fn refusals_become_coverages() {
        let refused = |status: u16, body: &str| {
            let ex = recorded_with(&[(PROJECT, Ok(body))]).coded(&["curl", PROJECT], status);
            read("", &ex).err().unwrap()
        };
        let Coverage::NoAccess { reason, fix: None } = refused(401, &data("sentry-401-invalid.json")) else { panic!() };
        assert_eq!(reason, "sentry.io refused the stored token: Invalid token");
        let Coverage::NoAccess { reason, fix: None } = refused(401, &data("sentry-401-none.json")) else { panic!() };
        assert!(reason.contains("refused the stored token"));
        let Coverage::NoAccess { reason, fix: None } = refused(403, "{\"detail\":\"You do not have permission to perform this action.\"}") else { panic!() };
        assert!(reason.starts_with("a required scope is missing: this read needs event:read, project:read, org:read"), "{reason}");
        let Coverage::NoAccess { reason, fix: None } = refused(404, "{\"detail\":\"The requested resource does not exist\"}") else { panic!() };
        assert_eq!(reason, "sentry.io has no project acme/api, or this token's account cannot see it");
        assert_eq!(refused(429, ""), Coverage::Error { reason: "rate limited by sentry.io".into() });
        assert!(matches!(refused(200, "<html>proxy</html>"), Coverage::Error { reason } if reason.contains("not JSON")));
        assert!(matches!(refused(200, ""), Coverage::Error { .. }));
        assert!(matches!(refused(503, ""), Coverage::Error { reason } if reason == "sentry.io answered HTTP 503"));
        // The issue list refused after the project answered is the read's coverage too.
        let ex = recorded_with(&[(ISSUES, Ok(""))]).coded(&["curl", ISSUES], 403);
        assert!(matches!(read("", &ex), Err(Coverage::NoAccess { .. })));
        let ex = recorded_with(&[(PROJECT, Err("curl: (6) Could not resolve host: sentry.io"))]);
        assert_eq!(read("", &ex).err(), Some(Coverage::Error { reason: "curl: (6) Could not resolve host: sentry.io".into() }));
    }

    #[test]
    fn no_token_no_request() {
        let ex = recorded().without_tokens();
        assert_eq!(read("", &ex).err(), Some(Coverage::NoTool { tool: "a token for sentry.io".into(), fix: None }));
        assert!(ex.calls().is_empty(), "nothing is asked without a token");
    }

    #[test]
    fn the_token_goes_only_to_its_host() {
        let own = "sentry_url = \"https://sentry.acme.com/sentry/\"\n";
        let (p, i) = (data("sentry-project-hand.json"), data("sentry-issues-hand.json"));
        let ex = FakeExec::answering(Ok(&i)).on(&["curl", "https://sentry.acme.com/sentry/api/0/projects/acme/api/"], Ok(&p))
            .on(&["curl", "https://sentry.acme.com/sentry/api/0/projects/acme/api/releases/?per_page=1"], Ok("[]"));
        assert!(read(own, &ex).is_ok());
        assert!(ex.calls().iter().all(|c| c[1].starts_with("https://sentry.acme.com/sentry/api/0/") && c[3] == "sentry@sentry.acme.com"), "{:?}", ex.calls());
        for bad in ["sentry_url = \"http://sentry.acme.com\"\n", "sentry_url = \"https://sentry.acme.com/?x=1\"\n", "sentry_url = \"https://u@sentry.acme.com\"\n"] {
            let ex = recorded();
            assert!(matches!(read(bad, &ex), Err(Coverage::Unsupported { .. })), "{bad}");
            assert!(ex.calls().is_empty(), "{bad}: never asked");
        }
        let ex = recorded();
        let _ = read("sentry_url = \"https://de.sentry.io\"\n", &ex);
        assert!(ex.calls().iter().all(|c| c[1].starts_with("https://de.sentry.io/") && c[3] == "sentry@sentry.io"), "a region reads with the hosted slot: {:?}", ex.calls());
        let ex = recorded();
        let _ = read("sentry_url = \"https://sentry.acme.com:8443\"\n", &ex);
        assert!(ex.calls().iter().all(|c| c[3] == "sentry@sentry.acme.com:8443"), "a port is its own slot");
        assert_eq!(slot_of("acme.sentry.io"), "sentry.io");
        assert_eq!(slot_of("sentry.io.evil.example"), "sentry.io.evil.example", "a look-alike is its own host");
    }

    #[test]
    fn environment_is_one_word() {
        let ex = recorded();
        let Facts::Errors { environment, .. } = read("sentry_environment = \"production\"\n", &ex).unwrap().facts else { panic!() };
        assert_eq!(environment.as_deref(), Some("production"));
        assert!(ex.calls().iter().any(|c| c[1] == format!("{ISSUES}&environment=production")));
        assert!(ex.calls().iter().any(|c| c[1] == format!("{RELEASES}&environment=production")), "the release is that environment's too");
        // A name the tracker does not have: the project answered, so the issues' 404 is the environment's.
        let ex = recorded().coded(&["curl", &format!("{ISSUES}&environment=prod")], 404);
        let Err(Coverage::Unsupported { reason }) = read("sentry_environment = \"prod\"\n", &ex) else { panic!() };
        assert_eq!(reason, "acme/api on sentry.io has no environment prod: sentry_environment must name one it has");
        for bad in ["prod&query=x", "prod uction", "prod/x"] {
            let ex = recorded();
            assert!(matches!(read(&format!("sentry_environment = \"{bad}\"\n"), &ex), Err(Coverage::Unsupported { .. })), "{bad}");
            assert!(ex.calls().is_empty());
        }
    }

    #[test]
    fn token_check_reads_scopes() {
        let need: Vec<String> = ["event:read", "project:read", "org:read"].map(String::from).to_vec();
        let c = parse_check(&data("sentry-root-hand.json"), "sentry.io", &need);
        assert_eq!((c.ok, c.who.as_deref(), c.missing.clone()), (false, Some("jane@example.com"), vec!["org:read".to_string()]), "event:write includes event:read");
        let all = data("sentry-root-hand.json").replace("\"team:read\"", "\"org:admin\"");
        assert!(parse_check(&all, "sentry.io", &need).ok);
        let anon = parse_check(&data("sentry-root-anon.json"), "sentry.io", &need);
        assert!(!anon.ok && anon.error.as_deref() == Some("sentry.io does not know this token"), "auth: null is not ok");
        let ex = FakeExec::answering(Ok(&data("sentry-401-invalid.json"))).coded(&["curl"], 401);
        let c = sentry_check("sentry.io", &need, &ex);
        assert_eq!(c.error.as_deref(), Some("sentry.io answered HTTP 401: Invalid token"));
        assert_eq!(ex.calls(), [["curl", "https://sentry.io/api/0/", "--token", "sentry@sentry.io"]]);
        let ex = FakeExec::answering(Ok("<html>")).coded(&["curl"], 404);
        assert!(sentry_check("sentry.acme.com", &need, &ex).error.unwrap().contains("checked by Check prod"), "a path prefix is not a refusal");
    }
}
