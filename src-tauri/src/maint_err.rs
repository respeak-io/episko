//! The Prod facet's error trackers (docs/maintenance.md § Adapters): `sentry-issues`, a project's unresolved
//! issues and newest release, read on a click with the token saved for the tracker's host, and on *Fix* the
//! latest event's stack trace of the issues it briefs, kept nowhere. Facts only.

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
// A trace's read scope: the issues one *Fix* asks about, the chain and frames each keeps, and a message's length.
const TRACE_CAP: usize = 5;
const EXCEPTIONS: usize = 3;
const FRAMES: usize = 40;
const VALUE_MAX: usize = 500;

/// The hosted API's own hosts. Any other `*.sentry.io` is a page, and some are served by a third party.
const HOSTED: &[&str] = &[SAAS, "us.sentry.io", "de.sentry.io"];

/// The slot a host's token is saved under: the hosted regions share the service's own, so `de.sentry.io`
/// reads with the token saved for `sentry.io`, and no other `*.sentry.io` has a slot at all.
pub(crate) fn slot_of(host: &str) -> Result<String, String> {
    if HOSTED.contains(&host) {
        Ok(SAAS.into())
    } else if host.ends_with(".sentry.io") {
        Err(format!("{host} is not Sentry's API: name https://sentry.io, or https://us.sentry.io or https://de.sentry.io for a region"))
    } else {
        Ok(host.into())
    }
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
    if u.query().is_some() || u.fragment().is_some() || !u.username().is_empty() || u.password().is_some() {
        return Err(unsupported(format!("sentry_url = \"{raw}\" is not a bare https address")));
    }
    let host = u.host_str().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
    let own = slot_of(&host).map_err(|e| unsupported(format!("sentry_url = \"{raw}\": {e}")))?;
    let slot = format!("{own}{}", u.port().map(|p| format!(":{p}")).unwrap_or_default());
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
    clip_to(s, TEXT_MAX)
}

fn clip_to(s: &str, max: usize) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).take(max).collect::<String>().trim().to_string()
}

// A link too long to be the tracker's own is dropped, not cut: a kept scan holds every one of these.
fn web(u: &&str) -> bool {
    let l = u.to_ascii_lowercase();
    (l.starts_with("https://") || l.starts_with("http://")) && u.len() <= TEXT_MAX
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

/// A coverage as a brief says it: the reason the read itself would give.
pub(crate) fn said(c: &Coverage) -> String {
    match c {
        Coverage::NoTool { tool, .. } => format!("{tool} not available"),
        Coverage::NoAccess { reason, .. } | Coverage::Off { reason } | Coverage::Unsupported { reason } | Coverage::Error { reason } => reason.clone(),
        Coverage::Ok | Coverage::NotRun => "not read".into(),
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

/// The project `[deploy] sentry` links, where its tracker answers, and the slot its token is saved under.
/// Nothing is asked of a host no token is saved for.
struct Linked {
    project: String,
    org: String,
    slug: String,
    base: String,
    slot: String,
    env: Option<String>,
}

fn linked(ctx: &Ctx, ex: &dyn Exec) -> Result<Linked, Coverage> {
    let project = crate::deploy::read(ctx.root).and_then(|d| d.sentry().map(str::to_string))
        .ok_or_else(|| unsupported("[deploy] names no error tracker project".into()))?;
    let (org, slug) = project.split_once('/').map(|(o, s)| (o.to_string(), s.to_string()))
        .ok_or_else(|| unsupported(format!("{project} is not org/project")))?;
    let (base, slot) = base_of(ctx.cfg)?;
    let env = env_of(ctx.cfg)?;
    if !ex.has_auth(KIND, &slot) {
        return Err(no_token(&slot));
    }
    Ok(Linked { project, org, slug, base, slot, env })
}

fn env_q(env: &Option<String>) -> String {
    env.as_deref().map(|e| format!("&environment={e}")).unwrap_or_default()
}

/// The unresolved issues of the project `[deploy] sentry` names, seen in the last fortnight, newest first
/// seen first, and its newest release. A `remote` read: a click asks it, with the token saved for its host.
pub(crate) fn sentry_issues(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let Linked { project, org, slug, base, slot, env } = linked(ctx, ex)?;
    // The numeric id: a wrong slug is a clean 404 here, and an older self-hosted tracker takes no slug below.
    let body = answered(get(ex, format!("{base}/api/0/projects/{org}/{slug}/"), &slot), &slot, &project)?;
    let id = parse_project(&body).map_err(|e| Coverage::Error { reason: format!("{slot}: {e}") })?;
    let env_q = env_q(&env);
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

// ---------- the stack trace behind an issue, read on Fix ----------

/// One issue's latest event, as much as a brief needs: its exceptions and where each was raised. Never its
/// user, tags, request or contexts, nor a frame's variables or source lines.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrTrace {
    pub(crate) exceptions: Vec<ErrException>, // the chain as the tracker orders it: its root cause first, the one raised last at the end
    pub(crate) exceptions_cut: u32,           // links between the root cause and the last two, not kept
    pub(crate) message: Option<String>,       // what the event says beside, or instead of, an exception
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrException {
    pub(crate) kind: String,
    pub(crate) value: String,
    pub(crate) frames: Vec<ErrFrame>, // innermost last
    pub(crate) frames_cut: u32,       // frames not kept: the outermost past FRAMES, and any naming no file or function
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrFrame {
    pub(crate) file: Option<String>,
    pub(crate) line: Option<u32>,
    pub(crate) function: Option<String>,
    pub(crate) in_app: bool,
}

/// `maint_trace`'s answer for one issue: its trace, or why it was not read.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraceAnswer {
    pub(crate) id: String,
    pub(crate) trace: Option<ErrTrace>,
    pub(crate) err: Option<String>,
}

fn frame(f: &Value) -> Option<ErrFrame> {
    let s = |k: &str| f.get(k).and_then(Value::as_str).filter(|t| !t.is_empty());
    // A page's address may carry a query; the path is all a brief needs.
    let file = s("filename").or_else(|| s("absPath")).or_else(|| s("module"))
        .map(|p| clip(p.split(['?', '#']).next().unwrap_or_default())).filter(|p| !p.is_empty());
    let function = s("function").map(clip);
    let line = f.get("lineNo").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
    let in_app = f.get("inApp").and_then(Value::as_bool) == Some(true);
    (file.is_some() || function.is_some()).then_some(ErrFrame { file, line, function, in_app })
}

fn exception(x: &Value) -> ErrException {
    let s = |k: &str| x.get(k).and_then(Value::as_str).map(clip).filter(|t| !t.is_empty());
    let all = x.pointer("/stacktrace/frames").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let mut frames: Vec<ErrFrame> = all.iter().filter_map(frame).collect();
    frames.drain(..frames.len().saturating_sub(FRAMES));
    ErrException {
        kind: s("type").or_else(|| s("module")).unwrap_or_else(|| "?".into()),
        value: x.get("value").and_then(Value::as_str).map(|v| clip_to(v, VALUE_MAX)).unwrap_or_default(),
        frames_cut: (all.len() - frames.len()) as u32,
        frames,
    }
}

/// The latest event's exception chain and message, each looked up by name: nothing else in it is copied out.
pub(crate) fn parse_event(body: &str) -> Result<ErrTrace, String> {
    let v = json(body)?;
    let entries = v.get("entries").and_then(Value::as_array).ok_or("the event carried no entries")?;
    let data = |kind: &'static str| entries.iter().filter(move |e| e.get("type").and_then(Value::as_str) == Some(kind)).filter_map(|e| e.get("data"));
    let mut exceptions: Vec<ErrException> = data("exception")
        .flat_map(|d| d.get("values").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default())
        .map(exception).collect();
    // The tracker orders a chain oldest first, so a long one keeps its root cause and loses its middle.
    let cut = exceptions.len().saturating_sub(EXCEPTIONS);
    if cut > 0 {
        exceptions.drain(1..=cut);
    }
    let text = |x: Option<&Value>| x.and_then(Value::as_str).map(|m| clip_to(m, VALUE_MAX)).filter(|m| !m.is_empty());
    let message = data("message").find_map(|d| text(d.get("formatted")).or_else(|| text(d.get("message"))))
        .or_else(|| if exceptions.is_empty() { text(v.get("message")) } else { None });
    Ok(ErrTrace { exceptions, exceptions_cut: cut as u32, message })
}

fn trace_of(ex: &dyn Exec, l: &Linked, id: &str) -> Result<ErrTrace, String> {
    // An id reaches a URL path, so it has the tracker's own shape: digits.
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{id:?} is not an issue id"));
    }
    let url = format!("{}/api/0/organizations/{}/issues/{id}/events/latest/?collapse=adjacentEvents{}", l.base, l.org, env_q(&l.env));
    let r = get(ex, url, &l.slot)?;
    match r.code {
        200 => parse_event(&r.body).map_err(|e| format!("{}: {e}", l.slot)),
        404 => Err(format!("{} has no latest event for this issue{}: merged or deleted since the check", l.slot,
            l.env.as_deref().map(|e| format!(" in {e}")).unwrap_or_default())),
        c => Err(said(&refusal(c, &r.body, &l.slot, &l.project))),
    }
}

/// The latest event of each issue *Fix* briefs, side by side and at most `TRACE_CAP`, read with the project,
/// token and refusals `sentry_issues` uses. One issue's failure is its own answer, never another's.
pub(crate) fn sentry_trace(ctx: &Ctx, ids: &[String], ex: &dyn Exec) -> Result<Vec<TraceAnswer>, Coverage> {
    let l = linked(ctx, ex)?;
    let answer = |id: &String, r: Result<ErrTrace, String>| TraceAnswer { id: id.clone(), err: r.as_ref().err().cloned(), trace: r.ok() };
    Ok(std::thread::scope(|s| {
        let jobs: Vec<_> = ids.iter().take(TRACE_CAP).map(|id| (id, s.spawn(|| trace_of(ex, &l, id)))).collect();
        jobs.into_iter().map(|(id, j)| answer(id, j.join().unwrap_or_else(|_| Err("the read panicked".into())))).collect()
    }))
}

pub(crate) type TraceFn = fn(&Ctx, &[String], &dyn Exec) -> Result<Vec<TraceAnswer>, Coverage>;

/// The error trackers *Fix* reads a stack trace from, by source id: exactly the manifest's `prod.error-trace`.
pub(crate) struct ErrDef {
    pub(crate) id: &'static str,
    pub(crate) trace: TraceFn,
}

pub(crate) static ERR_SOURCES: &[ErrDef] = &[ErrDef { id: SOURCE, trace: sentry_trace }];

/// *Fix*'s stack traces, read on that click and cached nowhere: the brief carries them and nothing keeps them.
#[tauri::command(async)]
pub(crate) fn maint_trace(root: String, source: String, ids: Vec<String>) -> Result<Vec<TraceAnswer>, String> {
    let def = ERR_SOURCES.iter().find(|d| d.id == source).ok_or_else(|| format!("{source} reads no stack trace"))?;
    crate::maint::on_click(&root, &source, |ctx, ex| (def.trace)(ctx, &ids, ex))?.map_err(|c| said(&c))
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
        let long = format!("[{{\"id\":\"1\",\"permalink\":\"https://sentry.io/{}\"}}]", "x".repeat(TEXT_MAX));
        assert_eq!(parse_issues(&long).unwrap()[0].url, None, "a link past the cap is dropped, never cut");
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
        assert_eq!(slot_of("us.sentry.io").as_deref(), Ok("sentry.io"));
        assert_eq!(slot_of("sentry.io.evil.example").as_deref(), Ok("sentry.io.evil.example"), "a look-alike is its own host");
        // A page under the hosted domain is not its API, and docs. and status. are served by a third party.
        for page in ["docs.sentry.io", "status.sentry.io", "acme.sentry.io"] {
            assert!(slot_of(page).is_err(), "{page}");
            let ex = recorded();
            let Err(Coverage::Unsupported { reason }) = read(&format!("sentry_url = \"https://{page}\"\n"), &ex) else { panic!("{page}") };
            assert!(reason.contains("not Sentry's API"), "{reason}");
            assert!(ex.calls().is_empty(), "{page}: never asked");
        }
        let ex = recorded();
        assert!(matches!(read("sentry_url = \"https://:pw@sentry.acme.com\"\n", &ex), Err(Coverage::Unsupported { .. })), "a password is a user");
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

    const EVENT_1: &str = "https://sentry.io/api/0/organizations/acme/issues/6000000101/events/latest/?collapse=adjacentEvents";
    const EVENT_2: &str = "https://sentry.io/api/0/organizations/acme/issues/6000000102/events/latest/?collapse=adjacentEvents";

    fn traces(params: &str, ids: &[&str], ex: &FakeExec) -> Result<Vec<TraceAnswer>, Coverage> {
        let (root, cfg) = project(params);
        let ids: Vec<String> = ids.iter().map(|i| i.to_string()).collect();
        sentry_trace(&Ctx { root: &root, cfg: &cfg, forge: &NONE, account: None, force: true, hosts: &[] }, &ids, ex)
    }

    // The fixture carries a user, tags, contexts, a request, breadcrumbs, frame variables and source lines on purpose.
    #[test]
    fn trace_keeps_frames_and_nothing_else() {
        let t = parse_event(&data("sentry-event-latest-hand.json")).unwrap();
        let (cause, raised) = (&t.exceptions[0], &t.exceptions[1]);
        assert_eq!((cause.kind.as_str(), cause.value.as_str()), ("KeyError", "'discount'"));
        assert_eq!((raised.kind.as_str(), raised.value.as_str(), t.exceptions_cut), ("ZeroDivisionError", "division by zero", 0), "the one raised last at the end");
        let at: Vec<_> = raised.frames.iter().map(|f| (f.file.as_deref(), f.line, f.function.as_deref(), f.in_app)).collect();
        assert_eq!(at, [
            (Some("threading.py"), Some(1073), Some("_bootstrap_inner"), false),
            (Some("billing/views.py"), Some(88), Some("checkout"), true),
            (Some("https://app.example.com/static/invoice.js"), Some(42), Some("total"), true),
        ], "innermost last; a page's query and a frame with only an address dropped");
        assert_eq!((raised.frames_cut, cause.frames_cut), (1, 0), "the address-only frame is counted, never lost silently");
        assert_eq!(t.message.as_deref(), Some("checkout failed for order 1182"));
        let wire = serde_json::to_string(&t).unwrap();
        for leak in ["hell@boy.cat", "192.168.1.1", "Hell Boy", "web-7f9c", "4242", "hunter2", "s3cr3t", "t0ps3cr3t", "leaked", "per_seat", "load_rates", "Linux", "CPython"] {
            assert!(!wire.contains(leak), "{leak} never leaves the event: {wire}");
        }
        let frame = |n: usize| format!("{{\"function\":\"f{n}\",\"filename\":\"a.py\",\"lineNo\":{n},\"inApp\":true}}");
        let exc = |k: usize| format!("{{\"type\":\"E{k}\",\"value\":\"{}\",\"stacktrace\":{{\"frames\":[{}]}}}}", "v".repeat(900), (0..100).map(frame).collect::<Vec<_>>().join(","));
        let big = format!("{{\"entries\":[{{\"type\":\"exception\",\"data\":{{\"values\":[{}]}}}}]}}", (0..5).map(exc).collect::<Vec<_>>().join(","));
        let t = parse_event(&big).unwrap();
        let kinds: Vec<_> = t.exceptions.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!((kinds, t.exceptions_cut), (vec!["E0", "E3", "E4"], 2), "the root cause and the last two links");
        let e = &t.exceptions[2];
        assert_eq!((e.frames.len(), e.frames_cut, e.frames[0].line, e.frames[39].line), (40, 60, Some(60), Some(99)), "the 40 innermost");
        assert_eq!((e.value.chars().count(), t.message.as_deref()), (500, None));
        let bare = parse_event("{\"message\":\"disk full\",\"entries\":[]}").unwrap();
        assert_eq!((bare.exceptions.len(), bare.message.as_deref()), (0, Some("disk full")), "an event with no exception says what it says");
        assert!(parse_event("<html>").is_err() && parse_event("{\"detail\":\"x\"}").is_err());
    }

    #[test]
    fn a_trace_reads_with_the_issues_token_and_refusals() {
        let ev = data("sentry-event-latest-hand.json");
        let ex = FakeExec::answering(Ok(&ev)).on(&["curl", EVENT_2], Ok(&data("sentry-401-invalid.json"))).coded(&["curl", EVENT_2], 401);
        let got = traces("", &["6000000101", "../projects", "6000000102"], &ex).unwrap();
        assert_eq!(got.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["6000000101", "../projects", "6000000102"], "in the order asked");
        assert!(got[0].trace.as_ref().is_some_and(|t| t.exceptions.len() == 2) && got[0].err.is_none());
        assert_eq!((got[1].trace.is_none(), got[1].err.as_deref()), (true, Some("\"../projects\" is not an issue id")));
        assert_eq!(got[2].err.as_deref(), Some("sentry.io refused the stored token: Invalid token"), "the read's own refusal");
        let mut calls = ex.calls();
        calls.sort();
        assert_eq!(calls, [["curl", EVENT_1, "--token", "sentry@sentry.io"], ["curl", EVENT_2, "--token", "sentry@sentry.io"]], "nothing is asked for what is no id");

        let ex = FakeExec::answering(Ok(&ev));
        let got = traces("sentry_environment = \"production\"\n", &["1", "2", "3", "4", "5", "6", "7"], &ex).unwrap();
        assert_eq!((got.len(), ex.calls().len()), (5, 5), "five at most");
        assert!(ex.calls().iter().all(|c| c[1].ends_with("?collapse=adjacentEvents&environment=production")), "that environment's latest event");
        let ex = FakeExec::answering(Ok("{\"detail\":\"Event not found\"}")).coded(&["curl"], 404);
        assert_eq!(traces("", &["1"], &ex).unwrap()[0].err.as_deref(), Some("sentry.io has no latest event for this issue: merged or deleted since the check"));
        let ex = FakeExec::answering(Err("curl: (28) Operation timed out"));
        assert_eq!(traces("", &["1"], &ex).unwrap()[0].err.as_deref(), Some("curl: (28) Operation timed out"));

        let ex = FakeExec::answering(Ok(&ev)).without_tokens();
        assert_eq!(traces("", &["1"], &ex).err(), Some(no_token("sentry.io")));
        assert!(ex.calls().is_empty(), "no token, no request");
        let ex = FakeExec::answering(Ok(&ev));
        assert!(matches!(traces("sentry_url = \"http://sentry.acme.com\"\n", &["1"], &ex), Err(Coverage::Unsupported { .. })));
        assert!(ex.calls().is_empty(), "never over http");
    }

    #[test]
    fn maint_trace_asks_only_a_tracker_the_project_links() {
        let (root, _) = project("");
        assert_eq!(maint_trace(root.clone(), "http-probe".into(), vec!["1".into()]).unwrap_err(), "http-probe reads no stack trace");
        // Linked, with no token saved (a test names no token folder): nothing is sent.
        assert_eq!(maint_trace(root, SOURCE.into(), vec!["1".into()]).unwrap_err(), "a token for sentry.io not available");
        let bare = scratch_dir().to_string_lossy().to_string();
        assert_eq!(maint_trace(bare, SOURCE.into(), vec!["1".into()]).unwrap_err(), "not detected in this project");
    }
}
