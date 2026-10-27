//! The CI facet (docs/maintenance.md § Adapters): one vocabulary for every vendor's status, and
//! the GitHub reads, `github-actions` and `forge-commit-status`, on the default branch only.

use std::collections::HashSet;

use serde_json::Value;

use crate::maint::exec::data_arg;
use crate::maint::{gh_coverage, github_repo, CiRun, CiStatus, Coverage, Ctx, Exec, Facts, Read};
use crate::usage::iso_epoch_secs;

/// The only map from a vendor's word to `CiStatus`, case-blind. A word it does not know is
/// `Unknown`, never a pass or a failure, so a new vocabulary cannot read as green.
pub(crate) fn norm_status(raw: &str) -> CiStatus {
    match raw.trim().to_ascii_lowercase().as_str() {
        "success" => CiStatus::Pass,
        "failure" | "error" | "timed_out" | "startup_failure" | "action_required" => CiStatus::Fail,
        // GitHub marks a check `stale` once it stops waiting for it: stopped, with no verdict.
        "cancelled" | "stale" => CiStatus::Cancelled,
        "skipped" => CiStatus::Skip,
        "neutral" => CiStatus::Neutral,
        "queued" | "in_progress" | "waiting" | "requested" | "pending" | "expected" => CiStatus::Running,
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
const RUN_FIELDS: &str = "databaseId,workflowName,status,conclusion,headSha,createdAt,url,event";
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
fn since_last_pass(runs: Vec<CiRun>) -> (Vec<CiRun>, bool) {
    let (mut green, mut seen) = (HashSet::new(), HashSet::new());
    let kept: Vec<CiRun> = runs.into_iter()
        .filter(|r| {
            if green.contains(&r.workflow) {
                return false;
            }
            seen.insert(r.workflow.clone());
            if r.status == CiStatus::Pass {
                green.insert(r.workflow.clone());
            }
            true
        })
        .collect();
    (kept, seen.len() > green.len())
}

/// `gh run list --json`, newest first. `truncated` only when the page cap was reached and some
/// workflow's history runs off its end, so its streak is a floor.
pub(crate) fn parse_runs(json: &str) -> Result<(Vec<CiRun>, bool), Coverage> {
    let v: Value = serde_json::from_str(json).map_err(|_| not_json("gh run list"))?;
    let arr = v.as_array().ok_or_else(|| not_json("gh run list"))?;
    let mut runs: Vec<CiRun> = arr.iter()
        .filter(|o| !NOT_CI_EVENTS.contains(&text(o, "event")))
        .filter(|o| !text(o, "workflowName").is_empty())
        .map(|o| CiRun {
            workflow: text(o, "workflowName").to_string(),
            status: check_status(text(o, "status"), text(o, "conclusion")),
            raw: raw_word(text(o, "status"), text(o, "conclusion")).to_string(),
            sha: text(o, "headSha").to_string(),
            at: iso_epoch_secs(text(o, "createdAt")),
            url: Some(text(o, "url").to_string()).filter(|u| !u.is_empty()),
        })
        .collect();
    runs.sort_by_key(|r| std::cmp::Reverse(r.at)); // stable, so gh's own order breaks a tie
    let (runs, open) = since_last_pass(runs);
    Ok((runs, open && arr.len() >= RUN_CAP))
}

/// `gh workflow list --all`: a disabled workflow is CI that looks configured and runs nothing.
pub(crate) fn disabled_workflows(json: &str) -> Result<Vec<String>, String> {
    let v: Value = serde_json::from_str(json).map_err(|_| "gh workflow list answered no list".to_string())?;
    let arr = v.as_array().ok_or("gh workflow list answered no list")?;
    Ok(arr.iter()
        .filter_map(|w| {
            let how = match text(w, "state") {
                "disabled_manually" => "by hand",
                "disabled_inactivity" => "after 60 days without activity",
                "disabled_fork" => "in this fork",
                s if s.starts_with("disabled") => s,
                _ => return None,
            };
            Some(format!("workflow \"{}\" is disabled {how}, so it never runs", text(w, "name")))
        })
        .collect())
}

pub(crate) fn github_actions(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let repo = github_repo(ctx)?;
    // The workflow list needs no branch, so it runs beside the two calls that do.
    let (runs, flows) = std::thread::scope(|s| {
        let flows = s.spawn(|| ex.gh(ctx.root, ctx.account, &["workflow", "list", "--repo", repo, "--all", "--json", "name,state"]));
        let runs = default_branch(ctx, ex, repo).and_then(|branch| {
            let cap = RUN_CAP.to_string();
            let out = gh(ctx, ex, &["run", "list", "--repo", repo, "--branch", &branch, "--limit", &cap, "--json", RUN_FIELDS])?;
            Ok((branch, parse_runs(&out)?))
        });
        (runs, flows.join().unwrap_or_else(|_| Err("gh workflow list panicked".into())))
    });
    let (branch, (runs, truncated)) = runs?;
    let gaps = flows.and_then(|j| disabled_workflows(&j)).unwrap_or_else(|e| vec![format!("disabled workflows not read: {e}")]);
    Ok(Read { facts: Facts::CiRuns { branch, runs }, truncated, gaps })
}

// ---------- forge-commit-status ----------

const ROLLUP_Q: &str = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{... on Commit{oid statusCheckRollup{contexts(first:100){totalCount nodes{__typename ... on CheckRun{name status conclusion detailsUrl startedAt completedAt checkSuite{app{slug}}} ... on StatusContext{context state targetUrl createdAt}}}}}}}}}";

/// One check run or commit status as a run of its own. GitHub Actions' check runs are left to
/// `github-actions`, which reads them per workflow, so one failure never counts twice.
fn context_run(n: &Value, sha: &str) -> Option<CiRun> {
    let at = |k: &str| iso_epoch_secs(text(n, k));
    let url = |k: &str| Some(text(n, k).to_string()).filter(|u| !u.is_empty());
    if let Some(name) = n.get("name").and_then(Value::as_str) {
        if n.pointer("/checkSuite/app/slug").and_then(Value::as_str) == Some("github-actions") {
            return None;
        }
        let (status, verdict) = (text(n, "status"), text(n, "conclusion"));
        return Some(CiRun {
            workflow: name.to_string(),
            status: check_status(status, verdict),
            raw: raw_word(status, verdict).to_string(),
            sha: sha.to_string(),
            at: at("completedAt").or_else(|| at("startedAt")),
            url: url("detailsUrl"),
        });
    }
    let name = n.get("context").and_then(Value::as_str)?;
    Some(CiRun {
        workflow: name.to_string(),
        status: norm_status(text(n, "state")),
        raw: text(n, "state").to_string(),
        sha: sha.to_string(),
        at: at("createdAt"),
        url: url("targetUrl"),
    })
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
    let runs = nodes.iter().filter_map(|n| context_run(n, sha)).collect();
    Ok(Read { truncated: total > nodes.len() as u64, ..Read::of(Facts::CiRuns { branch: branch.to_string(), runs }) })
}

pub(crate) fn forge_commit_status(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let repo = github_repo(ctx)?;
    let (owner, name) = repo.split_once('/').ok_or_else(|| Coverage::Unsupported { reason: "the remote names no owner/repo".into() })?;
    let (q, o, n) = (format!("query={ROLLUP_Q}"), format!("owner={owner}"), format!("name={name}"));
    parse_rollup(&gh(ctx, ex, &["api", "graphql", "-f", &q, "-f", &o, "-f", &n])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::MaintConfig;

    fn github() -> Forge {
        Forge { kind: ForgeKind::Github, host: Some("github.com".into()), path: Some("acme/app".into()), by: ForgeBy::Table }
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
        assert_eq!(r.gaps, ["disabled workflows not read: HTTP 502"], "the side read degrades alone");
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
}
