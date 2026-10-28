//! The CI facet (docs/maintenance.md § Adapters): one vocabulary for every vendor's status, and
//! the forge reads, `github-actions`, `forge-commit-status` and `gitlab-ci`, on the default branch only.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::forge::{classify_glab, pct};
use crate::maint::exec::data_arg;
use crate::maint::{gh_coverage, github_repo, gitlab_project, CiRun, CiStatus, Coverage, Ctx, Exec, Facts, Read};
use crate::usage::iso_epoch_secs;

/// The only map from a vendor's word to `CiStatus`, case-blind. A word it does not know is
/// `Unknown`, never a pass or a failure, so a new vocabulary cannot read as green.
pub(crate) fn norm_status(raw: &str) -> CiStatus {
    match raw.trim().to_ascii_lowercase().as_str() {
        "success" => CiStatus::Pass,
        "failure" | "error" | "timed_out" | "startup_failure" | "action_required" | "failed" => CiStatus::Fail,
        // GitHub marks a check `stale` once it stops waiting for it: stopped, with no verdict.
        "cancelled" | "stale" | "canceled" | "canceling" => CiStatus::Cancelled,
        "skipped" => CiStatus::Skip,
        "neutral" => CiStatus::Neutral,
        "queued" | "in_progress" | "waiting" | "requested" | "pending" | "expected" => CiStatus::Running,
        "created" | "preparing" | "waiting_for_resource" | "waiting_for_callback" | "running" | "scheduled" => CiStatus::Running,
        // GitLab's pipeline held at a blocking manual job: nothing failed, nothing runs, no verdict.
        "manual" => CiStatus::Neutral,
        _ => CiStatus::Unknown,
    }
}

/// A run's `status` until it completes and its verdict after; a commit status has only the verdict.
pub(crate) fn check_status(status: &str, verdict: &str) -> CiStatus {
    let s = status.trim();
    norm_status(if s.is_empty() || s.eq_ignore_ascii_case("completed") { verdict } else { s })
}

fn raw_word<'a>(status: &'a str, verdict: &'a str) -> &'a str {
    if verdict.is_empty() { status } else { verdict }
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn not_json(what: &str) -> Coverage {
    Coverage::Error { reason: format!("{what} answered something that is not the JSON it promises") }
}

fn gh(ctx: &Ctx, ex: &dyn Exec, args: &[&str]) -> Result<String, Coverage> {
    ex.gh(ctx.root, ctx.account, args).map_err(|e| gh_coverage(&e, ctx.account))
}

// ---------- github-actions ----------

pub(crate) const RUN_CAP: usize = 50;
// A workflow absent from the branch's page is read on its own, this many at most and this deep.
const FLOW_CAP: usize = 8;
const FLOW_RUNS: usize = 20;
const RUN_FIELDS: &str = "databaseId,workflowDatabaseId,workflowName,status,conclusion,headSha,createdAt,url,event";
// A pull request's run carries its head branch's name, which a fork may well call `main`; a
// `dynamic` run is GitHub's own job (Dependabot Updates, CodeQL default setup, Pages), never CI.
const NOT_CI_EVENTS: &[&str] = &["pull_request", "pull_request_target", "dynamic"];

/// The forge's default branch, which is what "CI on the default branch" means; never a local guess.
fn default_branch(ctx: &Ctx, ex: &dyn Exec, repo: &str) -> Result<String, Coverage> {
    let out = gh(ctx, ex, &["api", &format!("repos/{repo}"), "--jq", ".default_branch"])?;
    let b = out.trim();
    data_arg(b)
        .ok()
        .filter(|b| *b != "null")
        .map(str::to_string)
        .ok_or_else(|| Coverage::Error { reason: format!("GitHub named no default branch for {repo}") })
}

/// Per workflow, every run back to and including its newest pass: the unbroken streak of
/// failures `maint.ts` dates *failing since* by, and nothing from before a pass reset it.
/// The flag says some workflow kept found no pass, so its history may go on past the page.
fn since_last_pass(runs: Vec<CiRun>, ends: fn(CiStatus) -> bool) -> (Vec<CiRun>, bool) {
    let (mut green, mut seen) = (HashSet::new(), HashSet::new());
    let kept: Vec<CiRun> = runs.into_iter()
        .filter(|r| {
            if green.contains(&r.workflow) {
                return false;
            }
            seen.insert(r.workflow.clone());
            if ends(r.status) {
                green.insert(r.workflow.clone());
            }
            true
        })
        .collect();
    (kept, seen.len() > green.len())
}

/// A run with the identity its stream is cut by; `alt` tells two streams of one name apart.
struct Keyed {
    key: String,
    alt: String,
    run: CiRun,
}

/// One stream per key, named as people read it; a name two keys share gets its `alt`
/// (`CI (nightly.yml)`), so neither hides the other's failure behind its pass.
fn by_stream(rows: Vec<Keyed>) -> Vec<CiRun> {
    let mut keys: HashMap<String, HashSet<String>> = HashMap::new();
    for k in &rows {
        keys.entry(k.run.workflow.clone()).or_default().insert(k.key.clone());
    }
    rows.into_iter()
        .map(|Keyed { alt, mut run, .. }| {
            if keys.get(&run.workflow).is_some_and(|k| k.len() > 1) {
                run.workflow = format!("{} ({alt})", run.workflow);
            }
            run
        })
        .collect()
}

/// `gh run list --json` rows, keyed by workflow id where gh gives one; `files` names it.
fn action_rows(json: &str, files: &HashMap<u64, String>) -> Result<(Vec<Keyed>, usize), Coverage> {
    let v: Value = serde_json::from_str(json).map_err(|_| not_json("gh run list"))?;
    let arr = v.as_array().ok_or_else(|| not_json("gh run list"))?;
    let rows = arr.iter()
        .filter(|o| !NOT_CI_EVENTS.contains(&text(o, "event")))
        .filter(|o| !text(o, "workflowName").is_empty())
        .map(|o| {
            let id = o.get("workflowDatabaseId").and_then(Value::as_u64);
            Keyed {
                key: id.map_or_else(|| text(o, "workflowName").to_string(), |i| i.to_string()),
                alt: id.map_or_else(String::new, |i| files.get(&i).cloned().unwrap_or_else(|| format!("#{i}"))),
                run: CiRun {
                    workflow: text(o, "workflowName").to_string(),
                    status: check_status(text(o, "status"), text(o, "conclusion")),
                    raw: raw_word(text(o, "status"), text(o, "conclusion")).to_string(),
                    sha: text(o, "headSha").to_string(),
                    at: iso_epoch_secs(text(o, "createdAt")),
                    url: Some(text(o, "url").to_string()).filter(|u| !u.is_empty()),
                },
            }
        })
        .collect();
    Ok((rows, arr.len()))
}

fn cut_runs(rows: Vec<Keyed>, full: bool) -> (Vec<CiRun>, bool) {
    let mut runs = by_stream(rows);
    runs.sort_by_key(|r| std::cmp::Reverse(r.at)); // stable, so gh's own order breaks a tie
    let (runs, open) = since_last_pass(runs, |s| s == CiStatus::Pass);
    (runs, open && full)
}

/// `gh run list --json`, newest first. `truncated` only when the page cap was reached and some
/// workflow's history runs off its end, so its streak is a floor.
#[cfg(test)]
pub(crate) fn parse_runs(json: &str) -> Result<(Vec<CiRun>, bool), Coverage> {
    let (rows, n) = action_rows(json, &HashMap::new())?;
    Ok(cut_runs(rows, n >= RUN_CAP))
}

/// One entry of `gh workflow list --all --json id,name,path,state`.
pub(crate) struct Flow {
    id: Option<u64>,
    name: String,
    file: String,
    state: String,
}

pub(crate) fn parse_flows(json: &str) -> Result<Vec<Flow>, String> {
    let v: Value = serde_json::from_str(json).map_err(|_| "gh workflow list answered no list".to_string())?;
    let arr = v.as_array().ok_or("gh workflow list answered no list")?;
    Ok(arr.iter()
        .map(|w| Flow {
            id: w.get("id").and_then(Value::as_u64),
            name: text(w, "name").to_string(),
            file: text(w, "path").to_string(),
            state: text(w, "state").to_string(),
        })
        .collect())
}

/// `gh workflow list --all`: a disabled workflow is CI that looks configured and runs nothing.
pub(crate) fn disabled_workflows(flows: &[Flow]) -> Vec<String> {
    flows.iter()
        .filter_map(|w| {
            let how = match w.state.as_str() {
                "disabled_manually" => "by hand",
                "disabled_inactivity" => "after 60 days without activity",
                "disabled_fork" => "in this fork",
                s if s.starts_with("disabled") => s,
                _ => return None,
            };
            Some(format!("workflow \"{}\" is disabled {how}, so it never runs", w.name))
        })
        .collect()
}

/// Active workflows with no run on the branch's page: a rarely run one is pushed off it by a busy
/// one and must not vanish. A `dynamic/` one is GitHub's job, whose runs are dropped anyway.
fn unseen<'a>(flows: &'a [Flow], rows: &[Keyed]) -> Vec<&'a Flow> {
    let seen = |w: &Flow| rows.iter().any(|k| w.id.map_or(k.run.workflow == w.name, |i| k.key == i.to_string()));
    flows.iter().filter(|w| w.state == "active" && !w.file.starts_with("dynamic/") && !seen(w)).collect()
}

pub(crate) fn github_actions(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let repo = github_repo(ctx)?;
    // The workflow list needs no branch, so it runs beside the two calls that do.
    let (runs, flows) = std::thread::scope(|s| {
        let flows = s.spawn(|| ex.gh(ctx.root, ctx.account, &["workflow", "list", "--repo", repo, "--all", "--json", "id,name,path,state"]));
        let runs = default_branch(ctx, ex, repo).and_then(|branch| {
            let cap = RUN_CAP.to_string();
            let out = gh(ctx, ex, &["run", "list", "--repo", repo, "--branch", &branch, "--limit", &cap, "--json", RUN_FIELDS])?;
            Ok((branch, out))
        });
        (runs, flows.join().unwrap_or_else(|_| Err("gh workflow list panicked".into())))
    });
    let (branch, out) = runs?;
    let (flows, mut gaps) = match flows.and_then(|j| parse_flows(&j)) {
        Ok(f) => {
            let gaps = disabled_workflows(&f);
            (f, gaps)
        }
        Err(e) => (vec![], vec![format!("workflows not listed, so one with no run among the newest {RUN_CAP} is not seen: {e}")]),
    };
    let files: HashMap<u64, String> = flows.iter()
        .filter_map(|w| Some((w.id?, w.file.rsplit('/').next().unwrap_or(&w.file).to_string())))
        .collect();
    let (mut rows, n) = action_rows(&out, &files)?;
    let mut full = n >= RUN_CAP;
    let missing = unseen(&flows, &rows);
    let extra: Vec<_> = std::thread::scope(|s| {
        let asks: Vec<_> = missing.iter().take(FLOW_CAP)
            .map(|&w| {
                let (branch, files) = (&branch, &files);
                s.spawn(move || {
                    let (flow, limit) = (w.id.map_or_else(|| w.name.clone(), |i| i.to_string()), FLOW_RUNS.to_string());
                    let args = ["run", "list", "--repo", repo, "--workflow", &flow, "--branch", branch, "--limit", &limit, "--json", RUN_FIELDS];
                    (w, gh(ctx, ex, &args).and_then(|o| action_rows(&o, files)))
                })
            })
            .collect();
        asks.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let mut unread: Vec<&Flow> = missing.iter().skip(FLOW_CAP).copied().collect();
    for (w, got) in extra {
        match got {
            Ok((more, n)) => {
                full |= n >= FLOW_RUNS;
                rows.extend(more);
            }
            Err(_) => unread.push(w),
        }
    }
    // Not read is not passing: an `unknown` run keeps the cell off the grey dot.
    for w in unread {
        gaps.push(format!("workflow \"{}\" has no run among the newest {RUN_CAP} on {branch} and was not read", w.name));
        let run = CiRun { workflow: w.name.clone(), status: CiStatus::Unknown, raw: "not read".into(), sha: String::new(), at: None, url: None };
        let alt = w.id.and_then(|i| files.get(&i).cloned()).unwrap_or_default();
        rows.push(Keyed { key: w.id.map_or_else(|| w.name.clone(), |i| i.to_string()), alt, run });
    }
    let (runs, truncated) = cut_runs(rows, full);
    Ok(Read { facts: Facts::CiRuns { branch, runs }, truncated, gaps })
}

// ---------- forge-commit-status ----------

const ROLLUP_Q: &str = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{... on Commit{oid statusCheckRollup{contexts(first:100){totalCount nodes{__typename ... on CheckRun{name status conclusion detailsUrl startedAt completedAt checkSuite{app{slug}}} ... on StatusContext{context state targetUrl createdAt}}}}}}}}}";

/// One check run or commit status as a run of its own. GitHub Actions' check runs are left to
/// `github-actions`, which reads them per workflow, so one failure never counts twice.
fn context_run(n: &Value, sha: &str) -> Option<Keyed> {
    let at = |k: &str| iso_epoch_secs(text(n, k));
    let url = |k: &str| Some(text(n, k).to_string()).filter(|u| !u.is_empty());
    if let Some(name) = n.get("name").and_then(Value::as_str) {
        let app = n.pointer("/checkSuite/app/slug").and_then(Value::as_str).unwrap_or("");
        if app == "github-actions" {
            return None;
        }
        let (status, verdict) = (text(n, "status"), text(n, "conclusion"));
        let run = CiRun {
            workflow: name.to_string(),
            status: check_status(status, verdict),
            raw: raw_word(status, verdict).to_string(),
            sha: sha.to_string(),
            at: at("completedAt").or_else(|| at("startedAt")),
            url: url("detailsUrl"),
        };
        return Some(Keyed { key: format!("check:{app}/{name}"), alt: if app.is_empty() { "check".into() } else { app.into() }, run });
    }
    let name = n.get("context").and_then(Value::as_str)?;
    let run = CiRun {
        workflow: name.to_string(),
        status: norm_status(text(n, "state")),
        raw: text(n, "state").to_string(),
        sha: sha.to_string(),
        at: at("createdAt"),
        url: url("targetUrl"),
    };
    Some(Keyed { key: format!("status:{name}"), alt: "status".into(), run })
}

/// The default branch head's status rollup. No context at all is an empty list, which
/// `maint.ts` reads as *never ran*: a commit nothing reported on has passed nothing.
pub(crate) fn parse_rollup(json: &str) -> Result<Read, Coverage> {
    let v: Value = serde_json::from_str(json).map_err(|_| not_json("gh api graphql"))?;
    let repo = v.pointer("/data/repository").filter(|r| r.is_object())
        .ok_or_else(|| Coverage::Error { reason: "GitHub answered no repository".into() })?;
    let head = repo.get("defaultBranchRef").filter(|b| b.is_object())
        .ok_or_else(|| Coverage::Unsupported { reason: "no default branch: the repository is empty".into() })?;
    let (branch, sha) = (text(head, "name"), head.pointer("/target/oid").and_then(Value::as_str).unwrap_or(""));
    if branch.is_empty() || sha.is_empty() {
        return Err(Coverage::Error { reason: "GitHub named no default branch head".into() });
    }
    let ctxs = head.pointer("/target/statusCheckRollup/contexts");
    let nodes = ctxs.and_then(|c| c.get("nodes")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let total = ctxs.and_then(|c| c.get("totalCount")).and_then(Value::as_u64).unwrap_or(0);
    let runs = by_stream(nodes.iter().filter_map(|n| context_run(n, sha)).collect());
    Ok(Read { truncated: total > nodes.len() as u64, ..Read::of(Facts::CiRuns { branch: branch.to_string(), runs }) })
}

pub(crate) fn forge_commit_status(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let repo = github_repo(ctx)?;
    let (owner, name) = repo.split_once('/').ok_or_else(|| Coverage::Unsupported { reason: "the remote names no owner/repo".into() })?;
    let (q, o, n) = (format!("query={ROLLUP_Q}"), format!("owner={owner}"), format!("name={name}"));
    parse_rollup(&gh(ctx, ex, &["api", "graphql", "-f", &q, "-f", &o, "-f", &n])?)
}

// ---------- gitlab-ci ----------

// A merge request's pipeline is the PR run of GitHub; the rest are GitLab's own scans, never CI.
const NOT_CI_SOURCES: &[&str] = &["merge_request_event", "external_pull_request_event", "security_orchestration_policy",
    "ondemand_dast_scan", "ondemand_dast_validation", "container_registry_push"];

/// GitLab's project record names the default branch; an empty repository names none.
pub(crate) fn parse_default_branch(json: &str) -> Result<String, Coverage> {
    let v: Value = serde_json::from_str(json).map_err(|_| not_json("glab api"))?;
    if !v.is_object() {
        return Err(not_json("glab api"));
    }
    match v.get("default_branch").and_then(Value::as_str).filter(|b| !b.is_empty()) {
        Some(b) => data_arg(b).map(str::to_string).map_err(|reason| Coverage::Error { reason }),
        None => Err(Coverage::Unsupported { reason: "no default branch: the repository is empty".into() }),
    }
}

/// A pipeline is the whole config, so its stream is its trigger: a push's red is not cleared by a
/// run by hand. Schedules share one, as the list names no schedule (`ci.per-workflow`'s blind spot).
fn stream(source: &str) -> String {
    match source {
        "push" | "" => "pipeline".into(),
        "schedule" => "scheduled pipeline".into(),
        "parent_pipeline" => "child pipeline".into(),
        "pipeline" => "multi-project pipeline".into(),
        s => format!("pipeline ({s})"),
    }
}

/// `projects/<path>/pipelines`, newest first, cut per stream at its newest pass as GitHub's are,
/// or at one held at a manual job, which reached its gate without a failure.
pub(crate) fn parse_pipelines(json: &str) -> Result<(Vec<CiRun>, bool), Coverage> {
    let v: Value = serde_json::from_str(json).map_err(|_| not_json("glab api"))?;
    let arr = v.as_array().ok_or_else(|| not_json("glab api"))?;
    let mut runs: Vec<CiRun> = arr.iter()
        .filter(|o| !NOT_CI_SOURCES.contains(&text(o, "source")))
        .map(|o| CiRun {
            workflow: stream(text(o, "source")),
            status: norm_status(text(o, "status")),
            raw: text(o, "status").to_string(),
            sha: text(o, "sha").to_string(),
            at: iso_epoch_secs(text(o, "created_at")),
            url: Some(text(o, "web_url").to_string()).filter(|u| !u.is_empty()),
        })
        .collect();
    runs.sort_by_key(|r| std::cmp::Reverse(r.at));
    let (runs, open) = since_last_pass(runs, |s| matches!(s, CiStatus::Pass | CiStatus::Neutral));
    Ok((runs, open && arr.len() >= RUN_CAP))
}

pub(crate) fn gitlab_ci(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let (host, path) = gitlab_project(ctx)?;
    let project = format!("projects/{}", pct(path));
    let glab = |endpoint: &str| ex.glab(ctx.root, &["api", "--hostname", host, endpoint]).map_err(|e| classify_glab(&e, host));
    let branch = parse_default_branch(&glab(&project)?)?;
    let (runs, truncated) = parse_pipelines(&glab(&format!("{project}/pipelines?ref={}&per_page={RUN_CAP}", pct(&branch)))?)?;
    Ok(Read { truncated, ..Read::of(Facts::CiRuns { branch, runs }) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::MaintConfig;

    fn github() -> Forge {
        Forge { kind: ForgeKind::Github, host: Some("github.com".into()), path: Some("acme/app".into()), by: ForgeBy::Table, api: None }
    }

    fn read_with(forge: &Forge, account: Option<&str>, read: crate::maint::ReadFn, ex: &FakeExec) -> Result<Read, Coverage> {
        let cfg = MaintConfig::default();
        read(&Ctx { root: "/maint-test/ci", cfg: &cfg, forge, account, force: true }, ex)
    }

    fn runs_of(r: &Read) -> (&str, &[CiRun]) {
        match &r.facts {
            Facts::CiRuns { branch, runs } => (branch, runs),
            other => panic!("not ciRuns: {other:?}"),
        }
    }

    #[test]
    fn every_github_word_has_one_status() {
        use CiStatus::*;
        let table = [
            ("success", Pass), ("failure", Fail), ("neutral", Neutral), ("cancelled", Cancelled),
            ("skipped", Skip), ("timed_out", Fail), ("action_required", Fail), ("stale", Cancelled),
            ("startup_failure", Fail), ("error", Fail), ("expected", Running), ("pending", Running),
            ("queued", Running), ("in_progress", Running), ("waiting", Running), ("requested", Running),
            ("completed", Unknown), ("", Unknown), ("something_new", Unknown),
        ];
        for (raw, want) in table {
            assert_eq!(norm_status(raw), want, "{raw:?}");
            assert_eq!(norm_status(&raw.to_ascii_uppercase()), want, "GraphQL spells it in capitals");
        }
        assert_eq!(check_status("IN_PROGRESS", ""), Running, "a status outranks an empty verdict");
        assert_eq!(check_status("completed", "failure"), Fail);
        assert_eq!(check_status("", "SUCCESS"), Pass, "a commit status is its verdict alone");
        assert_eq!(check_status("COMPLETED", ""), Unknown, "finished with no verdict is not a pass");
    }

    /// Pinned before review.rs and deps.rs moved onto `check_status`; a `*Was` field marks a
    /// verdict that changed then, and each one is in CHANGELOG.md.
    #[test]
    fn check_verdicts_hold_to_the_pinned_table() {
        let rows: Vec<Value> = serde_json::from_str(&FakeExec::testdata("check-verdicts.json")).unwrap();
        let mut changed = 0;
        for r in &rows {
            let n = &r["node"];
            let review = if n.get("context").is_some() {
                crate::review::normalise_check("", text(n, "state"))
            } else {
                crate::review::normalise_check(text(n, "status"), text(n, "conclusion"))
            };
            let pr = serde_json::json!([{ "number": 1, "author": { "login": "dependabot[bot]" }, "statusCheckRollup": [n] }]);
            let c = &crate::deps::parse_bot_prs(&pr.to_string(), &[]).unwrap()[0].checks;
            let roll = match (c.passed, c.failed, c.pending, c.skipped) {
                (1, 0, 0, 0) => "passed",
                (0, 1, 0, 0) => "failed",
                (0, 0, 1, 0) => "pending",
                (0, 0, 0, 1) => "skipped",
                _ => "in no bucket",
            };
            assert_eq!((review, roll), (text(r, "review"), text(r, "roll")), "{n}");
            for (now, was) in [("review", "reviewWas"), ("roll", "rollWas")] {
                if let Some(w) = r.get(was) {
                    assert_ne!(w, &r[now], "{was} is only for a verdict that changed");
                    changed += 1;
                }
            }
        }
        assert_eq!(changed, 5, "a newly changed verdict needs a *Was field and a CHANGELOG line");
    }

    #[test]
    fn a_streak_of_failures_dates_failing_since_and_a_pass_resets_it() {
        let (runs, truncated) = parse_runs(&FakeExec::testdata("gh-run-list.json")).unwrap();
        assert!(!truncated);
        let of = |w: &str| runs.iter().filter(|r| r.workflow == w).map(|r| (r.status, r.at)).collect::<Vec<_>>();
        let ci = of("ci");
        assert_eq!(ci.iter().map(|(s, _)| *s).collect::<Vec<_>>(), [CiStatus::Fail, CiStatus::Fail, CiStatus::Fail, CiStatus::Pass]);
        let since = ci.iter().take_while(|(s, _)| *s == CiStatus::Fail).last().and_then(|(_, at)| *at);
        assert_eq!(since, iso_epoch_secs("2026-10-24T09:00:00Z"), "the oldest of three failures");
        assert_eq!(of("site"), [(CiStatus::Pass, iso_epoch_secs("2026-10-26T12:00:00Z"))], "a pass ends the history");
        assert_eq!(of("lint").len(), 2, "running on top of a pass keeps both");
        assert!(!runs.iter().any(|r| r.sha == "f0f0f0f"), "a fork's PR named main is not the default branch");
        assert!(!runs.iter().any(|r| r.workflow == "Dependabot Updates"), "a dynamic run is GitHub's job, not CI");
        let ci_first = runs.iter().find(|r| r.workflow == "ci").unwrap();
        assert_eq!((ci_first.raw.as_str(), ci_first.url.is_some()), ("failure", true));

        assert_eq!(parse_runs("[]").unwrap(), (vec![], false), "no run is an empty list, never a pass");
        let page = |verdict: &str| {
            let row = serde_json::json!({ "workflowName": "ci", "status": "completed", "conclusion": verdict });
            parse_runs(&serde_json::to_string(&vec![row; RUN_CAP]).unwrap()).unwrap().1
        };
        assert!(!page("success"), "a full page whose workflows all passed in it is the whole story");
        assert!(page("failure"), "a full page of failures may go on past it: a floor");
        assert!(!parse_runs(&serde_json::to_string(&vec![serde_json::json!({ "workflowName": "ci", "conclusion": "failure" }); 3]).unwrap()).unwrap().1);
        assert!(parse_runs("<html>").is_err() && parse_runs("{}").is_err());
    }

    #[test]
    fn github_actions_reads_the_default_branch_as_the_project_account() {
        let ex = FakeExec::answering(Err("unexpected call"))
            .on(&["gh", "api", "repos/acme/app"], Ok("dev\n"))
            .on(&["gh", "run", "list"], Ok(&FakeExec::testdata("gh-run-list.json")))
            .on(&["gh", "workflow", "list"], Ok(&FakeExec::testdata("gh-workflow-list.json")));
        let r = read_with(&github(), Some("alice"), github_actions, &ex).unwrap();
        assert_eq!(runs_of(&r).0, "dev");
        assert!(ex.calls().iter().any(|c| c.windows(2).any(|w| w == ["--branch", "dev"])), "{:?}", ex.calls());
        assert_eq!(ex.gh_accounts(), vec![Some("alice".to_string()); 3], "every gh call runs as the pinned account");
        assert_eq!(r.gaps.len(), 2, "{:?}", r.gaps);
        assert!(r.gaps.iter().any(|g| g.contains("\"nightly\"") && g.contains("60 days")), "{:?}", r.gaps);

        let ex = FakeExec::answering(Ok("[]")).on(&["gh", "api"], Ok("main")).on(&["gh", "workflow"], Err("HTTP 502"));
        let r = read_with(&github(), None, github_actions, &ex).unwrap();
        assert!(runs_of(&r).1.is_empty(), "an empty list is facts, and maint.ts says never ran");
        assert_eq!(r.gaps.len(), 1, "the side read degrades alone");
        assert!(r.gaps[0].starts_with("workflows not listed") && r.gaps[0].ends_with("HTTP 502"), "{:?}", r.gaps);
    }

    fn run(id: u64, name: &str, verdict: &str, at: &str) -> Value {
        serde_json::json!({ "workflowDatabaseId": id, "workflowName": name, "status": "completed", "conclusion": verdict,
            "event": "push", "createdAt": format!("2026-10-{at}T00:00:00Z"), "headSha": "abc" })
    }

    fn flow(id: u64, name: &str, path: &str) -> Value {
        serde_json::json!({ "id": id, "name": name, "path": path, "state": "active" })
    }

    fn json(v: &[Value]) -> String {
        serde_json::to_string(v).unwrap()
    }

    /// A nightly that failed is pushed off a page of fifty green pushes; it is read on its own.
    #[test]
    fn a_workflow_off_the_page_is_read_on_its_own_never_dropped() {
        let page = json(&vec![run(1, "CI", "success", "27"); RUN_CAP]);
        let flows = json(&[flow(1, "CI", ".github/workflows/ci.yml"), flow(2, "E2E", ".github/workflows/e2e.yml"),
            flow(3, "Pages", "dynamic/pages/pages-build-deployment")]);
        let ex = FakeExec::answering(Err("unexpected call"))
            .on(&["gh", "api"], Ok("main"))
            .on(&["gh", "workflow", "list"], Ok(&flows))
            .on(&["gh", "run", "list", "--repo", "acme/app", "--workflow", "2"], Ok(&json(&[run(2, "E2E", "failure", "20")])))
            .on(&["gh", "run", "list", "--repo", "acme/app", "--branch"], Ok(&page));
        let r = read_with(&github(), None, github_actions, &ex).unwrap();
        let got: Vec<(&str, CiStatus)> = runs_of(&r).1.iter().map(|r| (r.workflow.as_str(), r.status)).collect();
        assert_eq!(got, [("CI", CiStatus::Pass), ("E2E", CiStatus::Fail)]);
        assert!(r.gaps.is_empty(), "{:?}", r.gaps);
        assert_eq!(ex.calls().iter().filter(|c| c.contains(&"--workflow".to_string())).count(), 1, "a dynamic workflow is never asked");

        // Past the cap, or a read that failed, is an `unknown` run: not read is never a pass.
        let many: Vec<Value> = (0..FLOW_CAP as u64 + 2).map(|i| flow(10 + i, &format!("w{i}"), "x.yml")).collect();
        let ex = FakeExec::answering(Ok("[]"))
            .on(&["gh", "api"], Ok("main"))
            .on(&["gh", "workflow", "list"], Ok(&json(&many)))
            .on(&["gh", "run", "list", "--repo", "acme/app", "--workflow", "10"], Err("HTTP 502"))
            .on(&["gh", "run", "list", "--repo", "acme/app", "--branch"], Ok(&json(&[run(1, "CI", "success", "27")])));
        let r = read_with(&github(), None, github_actions, &ex).unwrap();
        let unknown: Vec<&str> = runs_of(&r).1.iter().filter(|r| r.status == CiStatus::Unknown).map(|r| r.workflow.as_str()).collect();
        assert_eq!(unknown.len(), 3, "w0 failed, two past the cap: {unknown:?}");
        assert_eq!(r.gaps.len(), 3, "{:?}", r.gaps);
    }

    /// Two workflow files may share a `name:`; one's pass must not end the other's failures.
    #[test]
    fn workflows_of_one_name_are_two_streams() {
        let rows = json(&[run(1, "CI", "success", "27"), run(2, "CI", "failure", "26"), run(1, "CI", "failure", "25")]);
        let (runs, _) = parse_runs(&rows).unwrap();
        let got: Vec<(&str, CiStatus)> = runs.iter().map(|r| (r.workflow.as_str(), r.status)).collect();
        assert_eq!(got, [("CI (#1)", CiStatus::Pass), ("CI (#2)", CiStatus::Fail)]);

        let flows = json(&[flow(1, "CI", ".github/workflows/ci.yml"), flow(2, "CI", ".github/workflows/nightly.yml")]);
        let ex = FakeExec::answering(Err("unexpected call"))
            .on(&["gh", "api"], Ok("main"))
            .on(&["gh", "workflow", "list"], Ok(&flows))
            .on(&["gh", "run", "list"], Ok(&rows));
        let r = read_with(&github(), None, github_actions, &ex).unwrap();
        let names: Vec<&str> = runs_of(&r).1.iter().map(|r| r.workflow.as_str()).collect();
        assert_eq!(names, ["CI (ci.yml)", "CI (nightly.yml)"]);

        let check = |app: &str, verdict: &str| serde_json::json!({ "__typename": "CheckRun", "name": "build", "status": "COMPLETED",
            "conclusion": verdict, "checkSuite": { "app": { "slug": app } } });
        let rollup = serde_json::json!({ "data": { "repository": { "defaultBranchRef": { "name": "main", "target": { "oid": "abc",
            "statusCheckRollup": { "contexts": { "totalCount": 3, "nodes": [check("circleci", "SUCCESS"), check("buildkite", "FAILURE"),
            { "__typename": "StatusContext", "context": "lint", "state": "SUCCESS" }] } } } } } } });
        let r = parse_rollup(&rollup.to_string()).unwrap();
        let got: Vec<(&str, CiStatus)> = runs_of(&r).1.iter().map(|r| (r.workflow.as_str(), r.status)).collect();
        assert_eq!(got, [("build (circleci)", CiStatus::Pass), ("build (buildkite)", CiStatus::Fail), ("lint", CiStatus::Pass)]);
    }

    #[test]
    fn a_forge_github_cannot_answer_for_is_refused_before_any_call() {
        let ex = FakeExec::answering(Ok("[]"));
        let pinned = Forge { host: Some("ghe.acme.io".into()), by: ForgeBy::Pin, ..github() };
        let gitlab = Forge { kind: ForgeKind::Gitlab, ..github() };
        let deep = Forge { path: Some("a/b/c".into()), ..github() };
        for f in [pinned, gitlab, deep] {
            for read in [github_actions as crate::maint::ReadFn, forge_commit_status] {
                assert!(matches!(read_with(&f, None, read, &ex), Err(Coverage::Unsupported { .. })), "{f:?}");
            }
        }
        assert!(ex.calls().is_empty());
    }

    #[test]
    fn gh_failures_carry_their_fix() {
        let read = |err: &str, account: Option<&str>| {
            let ex = FakeExec::answering(Err(err));
            read_with(&github(), account, forge_commit_status, &ex).err().unwrap()
        };
        let Coverage::NoTool { tool, fix } = read("To get started with GitHub CLI, please run:  gh auth login", None) else { panic!() };
        assert_eq!((tool.as_str(), fix.as_deref()), ("gh", Some("gh auth login")), "not authenticated");
        assert!(matches!(read("HTTP 401: Bad credentials (https://api.github.com/graphql)", None), Coverage::NoTool { .. }));
        let Coverage::NoTool { fix, .. } = read("gh not available: program not found", None) else { panic!() };
        assert!(fix.unwrap().contains("cli.github.com"), "not installed");
        let Coverage::NoAccess { reason, fix } = read("gh: Not Found (HTTP 404)", Some("bob")) else { panic!() };
        assert!(reason.contains("signed in as bob") && fix.unwrap().contains("account"), "{reason}");
        let Coverage::NoAccess { reason, .. } = read("gh: Could not resolve to a Repository with the name 'acme/app'.", Some("bob")) else { panic!() };
        assert!(reason.contains("bob"), "{reason}");
        let Coverage::NoAccess { reason, fix } = read("gh is not logged in as alice, which this project is set to use", Some("alice")) else { panic!() };
        assert!(reason.contains("alice") && fix.as_deref() == Some("gh auth login"), "wrong account: {reason}");
        assert!(matches!(read("HTTP 403: Resource not accessible by integration", None), Coverage::NoAccess { .. }));
        // Signed in, but the org's SSO or a fine-grained token says no: an account fix, never `gh auth login`.
        for e in ["HTTP 403: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.",
                  "HTTP 403: Resource not accessible by personal access token"] {
            let Coverage::NoAccess { fix, .. } = read(e, Some("bob")) else { panic!("{e}") };
            assert!(fix.unwrap().contains("account"), "{e}");
        }
        let limited = "HTTP 403: API rate limit exceeded for user ID 1";
        assert_eq!(read(limited, Some("bob")), Coverage::Error { reason: limited.into() }, "a rate limit blames no account");
        assert_eq!(read("HTTP 502: Bad Gateway", None), Coverage::Error { reason: "HTTP 502: Bad Gateway".into() });
    }

    #[test]
    fn commit_statuses_from_other_cis_are_runs_and_actions_is_left_out() {
        let ex = FakeExec::answering(Ok(&FakeExec::testdata("gh-rollup.json")));
        let r = read_with(&github(), Some("alice"), forge_commit_status, &ex).unwrap();
        let (branch, runs) = runs_of(&r);
        assert_eq!(branch, "main");
        let got: Vec<(&str, CiStatus, &str)> = runs.iter().map(|r| (r.workflow.as_str(), r.status, r.raw.as_str())).collect();
        assert_eq!(got, [
            ("ci/jenkins", CiStatus::Fail, "FAILURE"),
            ("ci/circleci: test", CiStatus::Pass, "SUCCESS"),
            ("buildkite/app", CiStatus::Running, "IN_PROGRESS"),
        ]);
        assert!(runs.iter().all(|r| r.sha == "0123456789abcdef0123456789abcdef01234567"));
        assert_eq!(runs[0].at, iso_epoch_secs("2026-10-26T08:00:00Z"));
        assert!(r.truncated, "totalCount beyond the page is a floor");
        let call = &ex.calls()[0];
        assert!(call.contains(&"owner=acme".to_string()) && call.contains(&"name=app".to_string()), "{call:?}");
        assert_eq!(ex.gh_accounts(), [Some("alice".to_string())]);
    }

    #[test]
    fn zero_contexts_never_pass() {
        for file in ["gh-rollup-none.json", "gh-rollup-actions-only.json"] {
            let r = parse_rollup(&FakeExec::testdata(file)).unwrap();
            assert!(runs_of(&r).1.is_empty(), "{file}: nothing reported, so nothing passed");
        }
        let empty = r#"{"data":{"repository":{"defaultBranchRef":null}}}"#;
        assert!(matches!(parse_rollup(empty), Err(Coverage::Unsupported { .. })), "an empty repository");
        assert!(matches!(parse_rollup(r#"{"data":{"repository":null}}"#), Err(Coverage::Error { .. })));
    }

    fn gitlab() -> Forge {
        Forge { kind: ForgeKind::Gitlab, host: Some("gitlab.com".into()), path: Some("gitlab-org/cli".into()), by: ForgeBy::Table, api: None }
    }

    #[test]
    fn every_gitlab_word_has_one_status() {
        use CiStatus::*;
        let table = [
            ("success", Pass), ("failed", Fail), ("canceled", Cancelled), ("canceling", Cancelled), ("skipped", Skip),
            ("created", Running), ("waiting_for_resource", Running), ("preparing", Running), ("waiting_for_callback", Running),
            ("pending", Running), ("running", Running), ("scheduled", Running), ("manual", Neutral),
        ];
        for (raw, want) in table {
            assert_eq!(norm_status(raw), want, "{raw:?}");
        }
    }

    /// The recording is gitlab-org/cli's real `main` list; a slice of it is the list as it stood earlier.
    fn pipelines_from(skip: usize) -> (Vec<CiRun>, bool) {
        let all: Vec<Value> = serde_json::from_str(&FakeExec::testdata("glab-pipelines.json")).unwrap();
        parse_pipelines(&serde_json::to_string(&all[skip..]).unwrap()).unwrap()
    }

    #[test]
    fn gitlab_pipelines_keep_each_trigger_back_to_its_pass() {
        let (runs, truncated) = pipelines_from(0);
        assert!(!truncated, "a full page whose streams all passed in it is the whole story");
        let got: Vec<(&str, CiStatus)> = runs.iter().map(|r| (r.workflow.as_str(), r.status)).collect();
        assert_eq!(got, [("pipeline", CiStatus::Pass), ("scheduled pipeline", CiStatus::Pass)]);
        assert_eq!(runs[0].url.as_deref(), Some("https://gitlab.com/gitlab-org/cli/-/pipelines/2995406019"));

        let (runs, _) = pipelines_from(1);
        let push: Vec<(CiStatus, &str)> = runs.iter().filter(|r| r.workflow == "pipeline").map(|r| (r.status, r.raw.as_str())).collect();
        assert_eq!(push, [(CiStatus::Fail, "failed"), (CiStatus::Pass, "success")], "a schedule's pass does not end a push streak");
        assert_eq!(runs[0].at, iso_epoch_secs("2026-10-27T15:17:57.002Z"));
        let (runs, _) = pipelines_from(8);
        assert_eq!((runs[0].status, runs[0].raw.as_str()), (CiStatus::Cancelled, "canceled"));
        // At 28 a security policy's pipeline leads the list; it is GitLab's scan, so 29 is the newest run.
        let (runs, _) = pipelines_from(28);
        assert_eq!(runs[0].url.as_deref(), Some("https://gitlab.com/gitlab-org/cli/-/pipelines/2980941350"), "{:?}", runs[0]);

        let red = serde_json::json!({ "status": "failed", "source": "push", "created_at": "2026-10-27T15:17:57Z" });
        assert!(parse_pipelines(&serde_json::to_string(&vec![red; RUN_CAP]).unwrap()).unwrap().1, "a full red page is a floor");
        assert_eq!(parse_pipelines("[]").unwrap(), (vec![], false), "no pipeline is never ran, not a pass");
        assert!(parse_pipelines("<html>").is_err() && parse_pipelines("{}").is_err());
    }

    fn pipeline(source: &str, status: &str, at: &str) -> Value {
        serde_json::json!({ "status": status, "source": source, "created_at": format!("2026-10-{at}T00:00:00Z") })
    }

    fn streams(rows: &[Value]) -> Vec<(String, CiStatus)> {
        parse_pipelines(&serde_json::to_string(rows).unwrap()).unwrap().0.into_iter().map(|r| (r.workflow, r.status)).collect()
    }

    #[test]
    fn a_gitlab_trigger_never_clears_another_and_a_manual_gate_ends_a_streak() {
        use CiStatus::*;
        let got = streams(&[pipeline("web", "success", "27"), pipeline("merge_request_event", "success", "26"),
            pipeline("push", "failed", "25"), pipeline("push", "success", "24")]);
        let want = [("pipeline (web)", Pass), ("pipeline", Fail), ("pipeline", Pass)];
        assert_eq!(got, want.map(|(w, s)| (w.to_string(), s)), "a merge request's pass is dropped, not an end");
        let gated = vec![pipeline("push", "manual", "27"); RUN_CAP];
        let (runs, truncated) = parse_pipelines(&serde_json::to_string(&gated).unwrap()).unwrap();
        assert_eq!((runs.len(), truncated), (1, false), "a deploy gate on every pipeline is no endless streak");
        let got = streams(&[pipeline("push", "failed", "27"), pipeline("push", "manual", "26"), pipeline("push", "failed", "25")]);
        assert_eq!(got, [("pipeline".to_string(), Fail), ("pipeline".to_string(), Neutral)]);
    }

    #[test]
    fn the_default_branch_is_gitlabs_answer() {
        assert_eq!(parse_default_branch(&FakeExec::testdata("glab-project.json")), Ok("main".to_string()));
        assert!(matches!(parse_default_branch(r#"{"id": 1, "default_branch": null}"#), Err(Coverage::Unsupported { .. })), "an empty repository");
        assert!(matches!(parse_default_branch(r#"{"default_branch": "-x"}"#), Err(Coverage::Error { .. })), "never a flag on argv");
        for bad in ["[]", "<html>", ""] {
            assert!(matches!(parse_default_branch(bad), Err(Coverage::Error { .. })), "{bad:?}");
        }
    }

    #[test]
    fn gitlab_ci_asks_the_projects_host_for_its_default_branch() {
        let ex = FakeExec::answering(Err("unexpected call"))
            .on(&["glab", "api", "--hostname", "gitlab.com", "projects/gitlab-org%2Fcli/pipelines?ref=main&per_page=50"], Ok(&FakeExec::testdata("glab-pipelines.json")))
            .on(&["glab", "api", "--hostname", "gitlab.com", "projects/gitlab-org%2Fcli"], Ok(&FakeExec::testdata("glab-project.json")));
        let r = read_with(&gitlab(), None, gitlab_ci, &ex).unwrap();
        assert_eq!(runs_of(&r).0, "main");
        assert_eq!(ex.calls().len(), 2, "the project, then its default branch's pipelines");

        let aliased = Forge { host: Some("gitlab-work".into()), api: Some("gitlab.acme.io".into()), ..gitlab() };
        let ex = FakeExec::answering(Err("glab: 404 Project Not Found (HTTP 404)"));
        let Err(Coverage::NoAccess { fix, .. }) = read_with(&aliased, None, gitlab_ci, &ex) else { panic!() };
        assert_eq!(fix.as_deref(), Some("glab auth login --hostname gitlab.acme.io"), "the alias's real host");
        assert_eq!(ex.calls()[0][3], "gitlab.acme.io");

        let ex = FakeExec::answering(Ok("[]"));
        for f in [github(), Forge { path: Some("solo".into()), ..gitlab() }, Forge { host: None, ..gitlab() }] {
            assert!(matches!(read_with(&f, None, gitlab_ci, &ex), Err(Coverage::Unsupported { .. })), "{f:?}");
        }
        assert!(ex.calls().is_empty());
    }

    /// Spends no tokens, but needs `glab` on PATH and the network: `cargo test -- --ignored`.
    #[test]
    #[ignore = "needs glab and gitlab.com"]
    fn live_glab_reads_a_public_gitlab_project() {
        let root = crate::testutil::scratch_dir().to_string_lossy().to_string();
        let cfg = MaintConfig::default();
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &gitlab(), account: None, force: true };
        let ex = crate::maint::SysExec { cost: crate::maint::Cost::Forge };
        let r = gitlab_ci(&ctx, &ex).unwrap_or_else(|c| panic!("{c:?}"));
        let (branch, runs) = runs_of(&r);
        assert_eq!(branch, "main");
        assert!(!runs.is_empty() && runs.iter().all(|r| r.status != CiStatus::Unknown), "{runs:?}");
        let w = crate::maint_repo::gitlab_work(&ctx, &ex).unwrap_or_else(|c| panic!("{c:?}"));
        assert!(matches!(w.facts, Facts::Work { issues, .. } if issues > 0), "{:?}", w.facts);
    }
}
