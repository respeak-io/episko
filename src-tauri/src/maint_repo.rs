//! The forge's own records (docs/maintenance.md § Adapters): the update bots' pull requests, every
//! bot source sharing one `gh pr list` through `deps.rs`'s cache; published releases; environments; open work on GitHub and GitLab.

use serde_json::Value;

use crate::deps::{bot_prs_read, ChecksRollup, DepPr};
use crate::maint::{bots, found_any, gh_coverage, github_repo, gitlab_project, CiStatus, Coverage, Ctx, DeployAttempt, DeployState, Deployed, EnvTier, Exec, Facts, ForgeRelease, Read, UpdatePr};
use crate::maint_git::{env_named, DEPLOY_CAP};
use crate::usage::iso_epoch_secs;

/// The rollup as one word, in `checkState`'s order: a failure outranks a check still running.
fn rolled(c: &ChecksRollup) -> CiStatus {
    if c.failed > 0 {
        CiStatus::Fail
    } else if c.pending > 0 {
        CiStatus::Running
    } else if c.passed > 0 {
        CiStatus::Pass
    } else if c.skipped > 0 {
        CiStatus::Skip
    } else {
        CiStatus::Unknown // nothing ran, which is not a pass
    }
}

fn update_pr(p: &DepPr) -> UpdatePr {
    UpdatePr {
        number: u64::try_from(p.number).unwrap_or(0),
        title: p.title.clone(),
        url: p.url.clone(),
        branch: p.branch.clone(),
        draft: p.draft,
        at: iso_epoch_secs(&p.updated_at),
        checks: rolled(&p.checks),
    }
}

/// One bot's open PRs, and whether its config is in the tree: configured with nothing open is
/// what `maint.ts` calls silent, never healthy.
fn update_prs(ctx: &Ctx, ex: &dyn Exec, bot: &str) -> Result<Read, Coverage> {
    let repo = github_repo(ctx)?;
    let (all, full) = bot_prs_read(ex, ctx.root, Some(repo), ctx.account, ctx.cfg.bots(), ctx.force)
        .map_err(|e| gh_coverage(&e, ctx.account))?;
    let configured = bots().iter().find(|b| b.id == bot).is_some_and(|b| found_any(ctx.root, &b.config));
    let prs = all.iter().filter(|p| p.bot == bot).map(update_pr).collect();
    let facts = Facts::UpdatePrs { bot: bot.to_string(), configured, prs, dashboard: None };
    Ok(Read { truncated: full, ..Read::of(facts) })
}

pub(crate) fn dependabot_prs(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    update_prs(ctx, ex, "dependabot")
}

pub(crate) fn renovate_prs(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    update_prs(ctx, ex, "renovate")
}

fn not_json(what: &str) -> Coverage {
    Coverage::Error { reason: format!("{what} answered something that is not the JSON it promises") }
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn flag(v: &Value, k: &str) -> bool {
    v.get(k) == Some(&Value::Bool(true))
}

// ---------- github-releases ----------

const RELEASE_CAP: usize = 100;
const RELEASE_FIELDS: &str = "tagName,name,publishedAt,createdAt,isDraft,isPrerelease,isLatest";

/// The published releases on one page: a draft is a release nobody has published, so it is never
/// the latest or counted. The latest is the one GitHub marks so, else the newest full release.
pub(crate) fn parse_releases(json: &str, repo: &str) -> Result<Read, Coverage> {
    let v: Value = serde_json::from_str(json).map_err(|_| not_json("gh release list"))?;
    let rows = v.as_array().ok_or_else(|| not_json("gh release list"))?;
    let published: Vec<&Value> = rows.iter().filter(|r| !flag(r, "isDraft") && !text(r, "tagName").is_empty()).collect();
    let at = |r: &Value| iso_epoch_secs(text(r, "publishedAt")).or_else(|| iso_epoch_secs(text(r, "createdAt")));
    let newest = |full: bool| published.iter().filter(|r| !full || !flag(r, "isPrerelease")).max_by_key(|r| at(r)).copied();
    let latest = published.iter().find(|r| flag(r, "isLatest")).copied().or_else(|| newest(true)).or_else(|| newest(false));
    let latest = latest.map(|r| {
        let tag = text(r, "tagName").to_string();
        // Only a tag that needs no escaping becomes a link; any other is shown, not guessed at.
        let safe = tag.chars().all(|c| c.is_ascii_alphanumeric() || "._-+/@".contains(c));
        ForgeRelease {
            url: safe.then(|| format!("https://github.com/{repo}/releases/tag/{tag}")),
            name: text(r, "name").to_string(),
            at: at(r),
            tag,
        }
    });
    let count = u32::try_from(published.len()).unwrap_or(u32::MAX);
    Ok(Read { truncated: rows.len() >= RELEASE_CAP, ..Read::of(Facts::Releases { latest, count }) })
}

pub(crate) fn github_releases(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let repo = github_repo(ctx)?;
    let cap = RELEASE_CAP.to_string();
    match ex.gh(ctx.root, ctx.account, &["release", "list", "--repo", repo, "--limit", &cap, "--json", RELEASE_FIELDS]) {
        Ok(json) => parse_releases(&json, repo),
        // Some gh versions say so in prose rather than printing `[]`; no release is a fact, not a failure.
        Err(e) if e.to_lowercase().contains("no releases found") => Ok(Read::of(Facts::Releases { latest: None, count: 0 })),
        Err(e) => Err(gh_coverage(&e, ctx.account)),
    }
}

// ---------- github-deployments ----------

const DEPLOY_Q: &str = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){environments(first:25){totalCount nodes{name latestCompletedDeployment{...D}}} deployments(first:100,orderBy:{field:CREATED_AT,direction:DESC}){nodes{...D}}}} fragment D on Deployment{environment state commitOid createdAt ref{name prefix} latestStatus{state createdAt environmentUrl logUrl}}";
const ENV_PAGE: u64 = 25;
const DEPLOY_PAGE: usize = 100;
const ENV_NAME_CAP: usize = 100;

/// The one map from a forge's deployment word to `DeployState`; the raw word stays beside it.
pub(crate) fn norm_deploy(raw: &str) -> DeployState {
    match raw.to_ascii_uppercase().as_str() {
        "ACTIVE" | "SUCCESS" => DeployState::Live,
        "FAILURE" | "ERROR" => DeployState::Fail,
        "IN_PROGRESS" | "QUEUED" | "PENDING" => DeployState::Running,
        "WAITING" => DeployState::Waiting,
        "INACTIVE" => DeployState::Inactive,
        "DESTROYED" => DeployState::Gone,
        _ => DeployState::Unknown,
    }
}

/// One deployment as GraphQL answers it: `created` orders it, `at` is its latest status's time.
struct Attempt {
    created: Option<u64>,
    at: Option<u64>,
    raw: String,
    sha: String,
    tag: Option<String>,
    branch: Option<String>,
    site: Option<String>,
    log: Option<String>,
}

fn attempt_of(v: &Value) -> Option<Attempt> {
    let sha = text(v, "commitOid");
    if !(7..=64).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let created = iso_epoch_secs(text(v, "createdAt"));
    let status = v.get("latestStatus").filter(|s| s.is_object());
    let web = |k: &str| status.map(|s| text(s, k)).filter(|u| crate::deploy::is_http(u)).map(str::to_string);
    let named = |prefix: &str| v.get("ref").filter(|r| text(r, "prefix") == prefix).map(|r| text(r, "name").to_string()).filter(|n| !n.is_empty());
    Some(Attempt {
        created, at: status.and_then(|s| iso_epoch_secs(text(s, "createdAt"))).or(created), raw: text(v, "state").to_string(), sha: sha.to_string(),
        tag: named("refs/tags/"), branch: named("refs/heads/"), site: web("environmentUrl"), log: web("logUrl"),
    })
}

fn env_of(name: &str, mut tried: Vec<Attempt>) -> Deployed {
    tried.sort_by_key(|a| std::cmp::Reverse(a.created));
    tried.dedup_by(|a, b| a.sha == b.sha && a.created == b.created);
    let mut e = env_named(name);
    let live = tried.iter().position(|a| norm_deploy(&a.raw) == DeployState::Live);
    if live != Some(0) {
        e.last = tried.first().map(|a| DeployAttempt { state: norm_deploy(&a.raw), raw: a.raw.clone(), sha: a.sha.clone(), at: a.at, url: a.log.clone() });
    }
    if let Some(a) = live.map(|i| &tried[i]) {
        (e.sha, e.tag, e.branch, e.at, e.url) = (Some(a.sha.clone()), a.tag.clone(), a.branch.clone(), a.at, a.site.clone());
    }
    e
}

/// The first `errors[]` as `gh_coverage` should read it. A refusal is known by its `type`, never by a
/// word in its message: `classify` reads *token* as signed out, and an SSO refusal says token.
fn graphql_said(v: &Value) -> Option<String> {
    let e = v.get("errors")?.as_array()?.iter().find(|e| e.get("message").is_some_and(Value::is_string))?;
    let m = text(e, "message");
    Some(if text(e, "type") == "FORBIDDEN" { format!("HTTP 403: {m}") } else { m.to_string() })
}

/// Each environment GitHub answered: what is live, and a newer attempt that is not. Neither list is the
/// coverage; one of them, or an `errors[]` beside them, is a read in part: `truncated`, so it vouches for nothing.
pub(crate) fn parse_deployments(json: &str, account: Option<&str>) -> Result<(Vec<Deployed>, bool, Vec<String>), Coverage> {
    let v: Value = serde_json::from_str(json).map_err(|_| not_json("gh api graphql"))?;
    let said = graphql_said(&v);
    let repo = v.pointer("/data/repository").filter(|r| r.is_object());
    let list = |p: &str| repo.and_then(|r| r.pointer(p)).and_then(Value::as_array);
    let (nodes, deps) = (list("/environments/nodes"), list("/deployments/nodes"));
    if nodes.is_none() && deps.is_none() {
        let none = || Coverage::Error { reason: "GitHub answered no deployments".into() };
        return Err(said.map_or_else(none, |m| gh_coverage(&m, account)));
    }
    let mut by: std::collections::BTreeMap<String, Vec<Attempt>> = Default::default();
    let completed = nodes.into_iter().flatten().filter_map(|n| Some((text(n, "name"), n.get("latestCompletedDeployment").filter(|d| d.is_object())?)));
    let listed = deps.into_iter().flatten().map(|d| (text(d, "environment"), d));
    for (name, a) in completed.chain(listed).filter_map(|(n, d)| Some((n, attempt_of(d)?))) {
        by.entry(name.to_string()).or_default().push(a);
    }
    let named = by.len();
    by.retain(|n, _| !n.is_empty() && n.chars().count() <= ENV_NAME_CAP && !n.chars().any(char::is_control));
    let mut gaps = vec![];
    let part = said.is_some() || nodes.is_none() || deps.is_none();
    if part {
        gaps.push(format!("read in part: {}", said.as_deref().unwrap_or("GitHub left a list out")));
    }
    if by.len() < named {
        gaps.push(format!("{} left out for a name that cannot be shown", named - by.len()));
    }
    let mut envs: Vec<(Option<u64>, Deployed)> = by.into_iter().map(|(name, tried)| {
        let newest = tried.iter().map(|a| a.created).max().flatten();
        (newest, env_of(&name, tried))
    }).collect();
    // Newest first, a preview after the rest: it is hidden, so it must not push production off the list.
    envs.sort_by_key(|(at, e)| (e.tier == EnvTier::Preview, std::cmp::Reverse(*at)));
    let total = repo.and_then(|r| r.pointer("/environments/totalCount")).and_then(Value::as_u64).unwrap_or(0);
    let found = envs.len();
    envs.truncate(DEPLOY_CAP);
    // Only for a row the board draws: a preview is hidden, and the cap above may have cut any of them.
    let deep = if deps.is_some_and(|d| d.len() >= DEPLOY_PAGE) { format!(" among the newest {DEPLOY_PAGE}") } else { String::new() };
    gaps.extend(envs.iter().filter(|(_, e)| e.sha.is_none() && e.tier != EnvTier::Preview).map(|(_, e)| format!("{}: no live deployment{deep}", e.env)));
    if total > ENV_PAGE {
        gaps.push(format!("{total} environments; the first {ENV_PAGE} were read"));
    }
    if found > DEPLOY_CAP {
        gaps.push(format!("the {DEPLOY_CAP} most recently active of {found} environments are listed"));
    }
    Ok((envs.into_iter().map(|(_, e)| e).collect(), part || total > ENV_PAGE || found > DEPLOY_CAP, gaps))
}

/// One GraphQL read of the environments; how far each is behind is counted in the clone, never asked.
pub(crate) fn github_deployments(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let repo = github_repo(ctx)?;
    let (owner, name) = repo.split_once('/').ok_or_else(|| Coverage::Unsupported { reason: "the remote names no owner/repo".into() })?;
    let (q, o, n) = (format!("query={DEPLOY_Q}"), format!("owner={owner}"), format!("name={name}"));
    let out = ex.gh_graphql(ctx.root, ctx.account, &["api", "graphql", "-f", &q, "-f", &o, "-f", &n])
        .map_err(|e| gh_coverage(&e, ctx.account))?;
    let (envs, truncated, gaps) = parse_deployments(&out, ctx.account)?;
    Ok(crate::maint_git::measure(ctx, envs, gaps, truncated))
}

// ---------- github-work ----------

const WORK_Q: &str = "query($owner:String!,$name:String!,$q:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}} search(query:$q,type:ISSUE,first:0){issueCount}}";

fn count(v: Option<&Value>) -> Option<u32> {
    v.and_then(Value::as_u64).map(|n| u32::try_from(n).unwrap_or(u32::MAX))
}

/// GraphQL's own totals, so 300 open issues read as 300 and not as a page's floor. An `errors[]`
/// beside a repository that answered costs only the review count (`None`, with a gap); without one it is the coverage.
pub(crate) fn parse_work(json: &str, account: Option<&str>) -> Result<Read, Coverage> {
    let v: Value = serde_json::from_str(json).map_err(|_| not_json("gh api graphql"))?;
    let errors: Vec<&str> = v.get("errors").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|e| e.get("message").and_then(Value::as_str))
        .collect();
    let Some(repo) = v.pointer("/data/repository").filter(|r| r.is_object()) else {
        let none = || Coverage::Error { reason: "GitHub answered no repository".into() };
        return Err(graphql_said(&v).map_or_else(none, |m| gh_coverage(&m, account)));
    };
    let (Some(issues), Some(prs)) = (count(repo.pointer("/issues/totalCount")), count(repo.pointer("/pullRequests/totalCount"))) else {
        return Err(Coverage::Error { reason: "GitHub answered no open totals".into() });
    };
    let review = count(v.pointer("/data/search/issueCount"));
    let gaps = match (review, errors.first()) {
        (Some(_), _) => vec![],
        (None, Some(m)) => vec![format!("review requests not read: {m}")],
        (None, None) => vec!["review requests not read".into()],
    };
    Ok(Read { gaps, ..Read::of(Facts::Work { issues, prs, review_requested: review }) })
}

/// Open issues and pull requests, and the pull requests waiting on the account Episko reads as.
pub(crate) fn github_work(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let repo = github_repo(ctx)?;
    let (owner, name) = repo.split_once('/').ok_or_else(|| Coverage::Unsupported { reason: "the remote names no owner/repo".into() })?;
    let (q, o, n) = (format!("query={WORK_Q}"), format!("owner={owner}"), format!("name={name}"));
    let search = format!("q=repo:{repo} is:pr is:open review-requested:@me");
    let out = ex.gh_graphql(ctx.root, ctx.account, &["api", "graphql", "-f", &q, "-f", &o, "-f", &n, "-f", &search])
        .map_err(|e| gh_coverage(&e, ctx.account))?;
    parse_work(&out, ctx.account)
}

// ---------- gitlab-work ----------

// Two variables of one value: GraphQL types `fullPath` as an ID and `projectPath` as a String.
// The spaces keep `: ID` from ever reading as glab's `:id` placeholder.
const GITLAB_WORK_Q: &str = "query($path: ID!, $p: String!){project(fullPath:$path){issues(state:opened){count} mergeRequests(state:opened){count}} currentUser{reviewRequestedMergeRequests(projectPath:$p,state:opened){count}}}";

/// GitLab's own totals. A project nobody signed in may see answers `null`, not an error; a
/// signed-out glab still reads a public project, and only the review count goes with it.
pub(crate) fn parse_gitlab_work(json: &str, host: &str) -> Result<Read, Coverage> {
    let v: Value = serde_json::from_str(json).map_err(|_| not_json("glab api graphql"))?;
    let errors: Vec<&str> = v.get("errors").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|e| e.get("message").and_then(Value::as_str))
        .collect();
    let Some(project) = v.pointer("/data/project").filter(|p| p.is_object()) else {
        let unseen = || crate::forge::classify_glab("404 Project Not Found", host);
        return Err(errors.first().map_or_else(unseen, |m| crate::forge::classify_glab(m, host)));
    };
    let (Some(issues), Some(prs)) = (count(project.pointer("/issues/count")), count(project.pointer("/mergeRequests/count"))) else {
        return Err(Coverage::Error { reason: "GitLab answered no open totals".into() });
    };
    let review = count(v.pointer("/data/currentUser/reviewRequestedMergeRequests/count"));
    let signed_out = v.pointer("/data/currentUser").is_some_and(Value::is_null);
    let gaps = match (review, errors.first()) {
        (Some(_), _) => vec![],
        (None, _) if signed_out => vec![format!("review requests not read: glab is not signed in to {host}")],
        (None, Some(m)) => vec![format!("review requests not read: {m}")],
        (None, None) => vec!["review requests not read".into()],
    };
    Ok(Read { gaps, ..Read::of(Facts::Work { issues, prs, review_requested: review }) })
}

/// Open issues and merge requests, and the merge requests waiting on the account glab uses here.
pub(crate) fn gitlab_work(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let (host, path) = gitlab_project(ctx)?;
    let (q, a, b) = (format!("query={GITLAB_WORK_Q}"), format!("path={path}"), format!("p={path}"));
    let out = ex.glab(ctx.root, &["api", "--hostname", host, "graphql", "-f", &q, "-f", &a, "-f", &b])
        .map_err(|e| crate::forge::classify_glab(&e, host))?;
    parse_gitlab_work(&out, host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::{parse_maint, ReadFn};
    use crate::testutil::scratch_dir;

    const PRS: &str = r#"[
      {"number":1,"author":{"login":"dependabot[bot]"},"headRefName":"dependabot/npm_and_yarn/vitest-4.1.11","title":"Bump vitest",
       "updatedAt":"2026-10-20T10:00:00Z","statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}]},
      {"number":2,"author":{"login":"acme-renovate[bot]"},"headRefName":"renovate/serde","title":"Update serde",
       "updatedAt":"2026-10-21T10:00:00Z","statusCheckRollup":[]},
      {"number":3,"author":{"login":"a-human"},"headRefName":"feat/x","title":"t"}]"#;

    fn read(root: &str, toml: &str, f: ReadFn, ex: &FakeExec) -> Result<Read, Coverage> {
        read_as(root, toml, f, ex, false)
    }

    fn read_as(root: &str, toml: &str, f: ReadFn, ex: &FakeExec, force: bool) -> Result<Read, Coverage> {
        let cfg = parse_maint(toml);
        let forge = Forge { kind: ForgeKind::Github, host: Some("github.com".into()), path: Some("acme/app".into()), by: ForgeBy::Table, api: None };
        f(&Ctx { root, cfg: &cfg, forge: &forge, account: None, force, hosts: &[] }, ex)
    }

    fn of(r: &Read) -> (bool, Vec<(u64, CiStatus)>) {
        let Facts::UpdatePrs { configured, prs, .. } = &r.facts else { panic!("{:?}", r.facts) };
        (*configured, prs.iter().map(|p| (p.number, p.checks)).collect())
    }

    #[test]
    fn each_bot_takes_its_own_prs_from_one_shared_list() {
        let dir = scratch_dir();
        let root = dir.to_string_lossy().to_string();
        let ex = FakeExec::answering(Ok(PRS));
        let mine = "[maintenance]\nbots = [\"acme-renovate\"]\n";
        let d = read(&root, mine, dependabot_prs, &ex).unwrap();
        let r = read(&root, mine, renovate_prs, &ex).unwrap();
        assert_eq!(of(&d), (false, vec![(1, CiStatus::Fail)]), "security updates need no config file");
        assert_eq!(of(&r), (false, vec![(2, CiStatus::Unknown)]), "no check ran: not a pass");
        assert_eq!(ex.calls().len(), 1, "one gh pr list for both bots");
        let Facts::UpdatePrs { prs, .. } = &d.facts else { panic!() };
        assert_eq!(prs[0].at, iso_epoch_secs("2026-10-20T10:00:00Z"));
    }

    #[test]
    fn a_forced_scan_still_asks_once_for_both_bots() {
        let root = scratch_dir().to_string_lossy().to_string();
        let ex = FakeExec::answering(Ok(PRS));
        std::thread::scope(|s| {
            s.spawn(|| read_as(&root, "", dependabot_prs, &ex, true).unwrap());
            s.spawn(|| read_as(&root, "", renovate_prs, &ex, true).unwrap());
        });
        read_as(&root, "", dependabot_prs, &ex, true).unwrap();
        assert_eq!(ex.calls().len(), 1, "{:?}", ex.calls());
    }

    #[test]
    fn a_config_file_with_no_pr_is_configured_and_silent() {
        let dir = scratch_dir();
        std::fs::write(dir.join("renovate.json"), "{}").unwrap();
        let root = dir.to_string_lossy().to_string();
        let r = read(&root, "", renovate_prs, &FakeExec::answering(Ok("[]"))).unwrap();
        assert_eq!(of(&r), (true, vec![]));
        assert!(!r.truncated);
        let page = serde_json::to_string(&vec![serde_json::json!({"number": 9, "author": {"login": "x"}}); 60]).unwrap();
        let other = scratch_dir();
        let r = read(&other.to_string_lossy(), "", dependabot_prs, &FakeExec::answering(Ok(&page))).unwrap();
        assert!(r.truncated, "a full page of PRs makes every count a floor");
    }

    #[test]
    fn a_gh_failure_is_a_coverage() {
        let dir = scratch_dir();
        let e = read(&dir.to_string_lossy(), "", renovate_prs, &FakeExec::answering(Err("gh: Not Found (HTTP 404)"))).err().unwrap();
        assert!(matches!(e, Coverage::NoAccess { .. }), "{e:?}");
    }

    fn github_read(f: ReadFn, ex: &FakeExec) -> Result<Read, Coverage> {
        read_as("/maint-test/repo", "", f, ex, true)
    }

    #[test]
    fn the_release_list_leaves_drafts_out_and_names_the_latest() {
        let ex = FakeExec::answering(Ok(&FakeExec::testdata("gh-release-list.json")));
        let r = github_read(github_releases, &ex).unwrap();
        let Facts::Releases { latest, count } = &r.facts else { panic!("{:?}", r.facts) };
        let latest = latest.as_ref().unwrap();
        assert_eq!(*count, 3, "the draft is not a release");
        assert_eq!((latest.tag.as_str(), latest.name.as_str()), ("v1.2.0", "1.2.0"), "GitHub's latest, not the newer prerelease");
        assert_eq!(latest.at, iso_epoch_secs("2026-10-10T10:05:00Z"));
        assert_eq!(latest.url.as_deref(), Some("https://github.com/acme/app/releases/tag/v1.2.0"));
        assert!(!r.truncated);
        assert!(ex.calls()[0].windows(2).any(|w| w == ["--repo", "acme/app"]), "{:?}", ex.calls());

        let drafts = r#"[{"tagName":"v2","isDraft":true},{"tagName":"v1-rc","isPrerelease":true,"publishedAt":"2026-10-01T00:00:00Z"}]"#;
        let Facts::Releases { latest, count } = parse_releases(drafts, "a/b").unwrap().facts else { panic!() };
        assert_eq!((latest.map(|l| l.tag), count), (Some("v1-rc".to_string()), 1), "a prerelease beats nothing");
        let Facts::Releases { latest, count } = parse_releases(r#"[{"tagName":"v1","isDraft":true}]"#, "a/b").unwrap().facts else { panic!() };
        assert_eq!((latest, count), (None, 0), "only drafts: nothing published");
        let page = serde_json::to_string(&vec![serde_json::json!({"tagName": "v1"}); RELEASE_CAP]).unwrap();
        assert!(parse_releases(&page, "a/b").unwrap().truncated);
        assert!(parse_releases("{}", "a/b").is_err() && parse_releases("", "a/b").is_err());

        let none = github_read(github_releases, &FakeExec::answering(Err("release not found: no releases found"))).unwrap();
        assert!(matches!(none.facts, Facts::Releases { latest: None, count: 0 }));
    }

    #[test]
    fn work_counts_are_totals_and_errors_cost_only_what_they_name() {
        let ex = FakeExec::answering(Ok(&FakeExec::testdata("gh-work.json")));
        let r = github_read(github_work, &ex).unwrap();
        assert!(matches!(r.facts, Facts::Work { issues: 312, prs: 7, review_requested: Some(2) }), "{:?}", r.facts);
        assert!(r.gaps.is_empty() && !r.truncated);
        let call = &ex.calls()[0];
        assert!(call.contains(&"owner=acme".to_string()) && call.contains(&"q=repo:acme/app is:pr is:open review-requested:@me".to_string()), "{call:?}");

        let r = parse_work(&FakeExec::testdata("gh-work-errors.json"), None).unwrap();
        assert!(matches!(r.facts, Facts::Work { issues: 12, prs: 3, review_requested: None }), "not read is not 0");
        assert_eq!(r.gaps, ["review requests not read: Search is temporarily unavailable"]);
        let e = parse_work(&FakeExec::testdata("gh-work-no-repo.json"), Some("bob")).err().unwrap();
        assert!(matches!(e, Coverage::NoAccess { ref reason, .. } if reason.contains("bob")), "{e:?}");
        assert!(matches!(parse_work(r#"{"data":{"repository":{}}}"#, None), Err(Coverage::Error { .. })), "no totals is no answer");
        assert!(parse_work("<html>", None).is_err());
    }

    fn deploys(file: &str) -> (Vec<Deployed>, bool, Vec<String>) {
        parse_deployments(&FakeExec::testdata(file), None).unwrap()
    }

    fn env<'a>(envs: &'a [Deployed], name: &str) -> &'a Deployed {
        envs.iter().find(|e| e.env == name).unwrap_or_else(|| panic!("{name}"))
    }

    #[test]
    fn a_pages_site_is_production_with_its_address() {
        let (envs, truncated, gaps) = deploys("gh-deployments-pages.json");
        assert_eq!((envs.len(), truncated, gaps.len()), (1, false, 0));
        let e = &envs[0];
        assert_eq!((e.env.as_str(), e.tier), ("github-pages", EnvTier::Production));
        assert!(e.sha.as_deref().is_some_and(|s| s.starts_with("bcdcb0b")), "{:?}", e.sha);
        assert_eq!((e.url.as_deref(), e.branch.as_deref(), e.tag.clone()), (Some("https://respeak-io.github.io/lucide-motion-vue/"), Some("main"), None));
        assert_eq!((e.at, e.last.clone()), (iso_epoch_secs("2026-08-25T11:02:20Z"), None), "its SUCCESS status's time; live is the newest");
    }

    #[test]
    fn an_old_environment_is_found_through_its_latest_completed_deployment() {
        let (envs, _, gaps) = deploys("gh-deployments-vite.json");
        assert!(envs.iter().all(|e| e.env != "copilot"), "no deployment at all is no environment");
        let release = env(&envs, "Release");
        assert_eq!((release.tier, release.branch.as_deref(), release.tag.clone(), release.last.clone()), (EnvTier::Other, Some("main"), None, None), "many ACTIVE: the newest is live");
        assert!(release.sha.as_deref().is_some_and(|s| s.starts_with("cce559a")));
        let prod = env(&envs, "Production");
        assert_eq!((prod.tier, prod.branch.clone()), (EnvTier::Production, None), "the 2021 host sends no ref");
        assert!(prod.sha.as_deref().is_some_and(|s| s.starts_with("ffb30b2")) && prod.at.is_some_and(|at| at < iso_epoch_secs("2022-01-01T00:00:00Z").unwrap()));
        assert_eq!(env(&envs, "Preview").tier, EnvTier::Preview);
        assert!(gaps.is_empty(), "{gaps:?}");
        // The recording's one deployment from a tag, on its own: the ref names what is live.
        let mut v: Value = serde_json::from_str(&FakeExec::testdata("gh-deployments-vite.json")).unwrap();
        v.pointer_mut("/data/repository/deployments/nodes").unwrap().as_array_mut().unwrap().retain(|d| d.pointer("/ref/name").and_then(Value::as_str) == Some("v6.4.5"));
        v.pointer_mut("/data/repository/environments/nodes").unwrap().as_array_mut().unwrap().clear();
        let (envs, _, _) = parse_deployments(&v.to_string(), None).unwrap();
        assert_eq!((envs[0].env.as_str(), envs[0].tag.as_deref(), envs[0].branch.clone()), ("Release", Some("v6.4.5"), None));
    }

    #[test]
    fn past_the_cap_previews_go_first_and_a_failure_is_the_last_attempt() {
        let (envs, truncated, gaps) = deploys("gh-deployments-shadcn.json");
        assert_eq!((envs.len(), truncated), (DEPLOY_CAP, true));
        assert!(gaps.contains(&format!("the {DEPLOY_CAP} most recently active of 15 environments are listed")), "{gaps:?}");
        assert_eq!(envs.iter().filter(|e| e.tier == EnvTier::Production).count(), 7, "no preview pushed production off the list");
        assert_eq!(env(&envs, "Preview – ui").tier, EnvTier::Preview);
        let next = env(&envs, "next – ui");
        let last = next.last.as_ref().unwrap();
        assert_eq!((next.sha.clone(), last.state, last.raw.as_str()), (None, DeployState::Fail, "FAILURE"));
        assert!(last.sha.starts_with("fb4de9b") && last.url.is_some());
        assert!(gaps.contains(&format!("next – ui: no live deployment among the newest {DEPLOY_PAGE}")), "{gaps:?}");
        assert!(!gaps.iter().any(|g| g.starts_with("Preview")), "a hidden preview, cut or not, has no row to explain: {gaps:?}");
        assert_eq!(env(&envs, "Production – ui").last, None);
    }

    #[test]
    fn a_repository_nobody_may_see_is_no_access() {
        let e = parse_deployments(&FakeExec::testdata("gh-deployments-no-repo.json"), Some("bob")).err().unwrap();
        assert!(matches!(e, Coverage::NoAccess { ref reason, ref fix } if reason.contains("bob") && fix.as_deref().is_some_and(|f| f.contains("account"))), "{e:?}");
        let refused = r#"{"data":{"repository":{"environments":null,"deployments":null}},"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by personal access token"}]}"#;
        assert!(matches!(parse_deployments(refused, None), Err(Coverage::NoAccess { .. })), "a token without Deployments: read is not signed out");
        assert!(matches!(parse_deployments(r#"{"data":{"repository":{}}}"#, None), Err(Coverage::Error { .. })));
        assert!(matches!(parse_deployments("<html>", None), Err(Coverage::Error { .. })));
    }

    // Hand-written from GraphQL's error shape: no public repository can be made to refuse on cue.
    const SSO: &str = r#"{"data":{"repository":null},"errors":[{"type":"FORBIDDEN","message":"Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization."}]}"#;

    #[test]
    fn a_refusal_is_read_by_its_type_and_not_by_its_words() {
        for e in [parse_deployments(SSO, None).err().unwrap(), parse_work(SSO, None).err().unwrap()] {
            assert!(matches!(e, Coverage::NoAccess { ref fix, .. } if fix.as_deref().is_some_and(|f| f.contains("account"))), "it says token, and is no sign-in: {e:?}");
        }
        let busy = r#"{"data":{"repository":{"environments":null,"deployments":null}},"errors":[{"type":"SERVICE_UNAVAILABLE","message":"Something went wrong"}]}"#;
        assert!(matches!(parse_deployments(busy, None), Err(Coverage::Error { ref reason }) if reason == "Something went wrong"), "an outage is not a refusal");
    }

    #[test]
    fn a_half_answer_says_so_and_keeps_what_came_back() {
        let a = "a".repeat(40);
        let live = node("prod", "ACTIVE", &a, "2026-10-01T00:00:00Z", "null");
        let beside = format!(r#"{{"data":{{"repository":{{"environments":{{"totalCount":1,"nodes":[{{"name":"prod","latestCompletedDeployment":null}}]}},"deployments":{{"nodes":[{live},null]}}}}}},"errors":[{{"type":"SOMETHING","message":"boom"}}]}}"#);
        let (envs, cut, gaps) = parse_deployments(&beside, None).unwrap();
        assert_eq!((envs.len(), cut, gaps), (1, true, vec!["read in part: boom".to_string()]), "an errored node must not read as a whole answer");

        let one_list = format!(r#"{{"data":{{"repository":{{"environments":null,"deployments":{{"nodes":[{live}]}}}}}},"errors":[{{"type":"FORBIDDEN","message":"no"}}]}}"#);
        let (envs, cut, gaps) = parse_deployments(&one_list, None).unwrap();
        assert_eq!((envs[0].sha.as_deref(), cut, gaps), (Some(a.as_str()), true, vec!["read in part: HTTP 403: no".to_string()]), "the other list still answers");

        let silent = r#"{"data":{"repository":{"environments":{"totalCount":0,"nodes":[]},"deployments":null}}}"#;
        let (envs, cut, gaps) = parse_deployments(silent, None).unwrap();
        assert_eq!((envs.len(), cut, gaps), (0, true, vec!["read in part: GitHub left a list out".to_string()]));
    }

    // Hand-written: no public repository showed these states when the fixtures were recorded.
    fn node(env: &str, state: &str, sha: &str, at: &str, status: &str) -> String {
        format!(r#"{{"environment":"{env}","state":"{state}","commitOid":"{sha}","createdAt":"{at}","ref":null,"latestStatus":{status}}}"#)
    }

    fn page(nodes: &[String]) -> String {
        format!(r#"{{"data":{{"repository":{{"environments":{{"totalCount":0,"nodes":[]}},"deployments":{{"nodes":[{}]}}}}}}}}"#, nodes.join(","))
    }

    #[test]
    fn every_word_the_forge_sends_has_a_state() {
        for (raw, want) in [
            ("ACTIVE", DeployState::Live), ("SUCCESS", DeployState::Live), ("FAILURE", DeployState::Fail), ("ERROR", DeployState::Fail),
            ("IN_PROGRESS", DeployState::Running), ("QUEUED", DeployState::Running), ("PENDING", DeployState::Running),
            ("WAITING", DeployState::Waiting), ("INACTIVE", DeployState::Inactive), ("DESTROYED", DeployState::Gone),
            ("ABANDONED", DeployState::Unknown), ("SOMETHING_NEW", DeployState::Unknown), ("", DeployState::Unknown),
        ] {
            assert_eq!(norm_deploy(raw), want, "{raw}");
        }
    }

    #[test]
    fn a_newer_attempt_is_kept_beside_what_is_live() {
        let (a, b) = ("a".repeat(40), "b".repeat(40));
        let ok = r#"{"state":"SUCCESS","createdAt":"2026-10-02T00:00:00Z","environmentUrl":"javascript:alert(1)","logUrl":"https://ci.example/1"}"#;
        for (word, state) in [("WAITING", DeployState::Waiting), ("IN_PROGRESS", DeployState::Running), ("QUEUED", DeployState::Running), ("DESTROYED", DeployState::Gone), ("ABANDONED", DeployState::Unknown)] {
            let json = page(&[node("prod", word, &b, "2026-10-03T00:00:00Z", "null"), node("prod", "ACTIVE", &a, "2026-10-01T00:00:00Z", ok)]);
            let (envs, _, _) = parse_deployments(&json, None).unwrap();
            let last = envs[0].last.as_ref().unwrap();
            assert_eq!((last.state, last.raw.as_str(), last.sha.as_str(), last.at), (state, word, b.as_str(), iso_epoch_secs("2026-10-03T00:00:00Z")));
            assert_eq!(envs[0].sha.as_deref(), Some(a.as_str()), "{word} is not what is live");
            assert_eq!((envs[0].at, envs[0].url.clone()), (iso_epoch_secs("2026-10-02T00:00:00Z"), None), "a non-http address is dropped");
        }
    }

    #[test]
    fn what_cannot_be_shown_or_typed_is_dropped() {
        let a = "a".repeat(40);
        let long = "x".repeat(ENV_NAME_CAP + 1);
        let json = page(&[
            node("prod", "ACTIVE", "not-hex", "2026-10-03T00:00:00Z", "null"),
            node("prod", "ACTIVE", &a, "2026-10-01T00:00:00Z", "null"),
            node(r"a\u0007b", "ACTIVE", &a, "2026-10-01T00:00:00Z", "null"),
            node(&long, "ACTIVE", &a, "2026-10-01T00:00:00Z", "null"),
            node("", "ACTIVE", &a, "2026-10-01T00:00:00Z", "null"),
        ]);
        let (envs, _, gaps) = parse_deployments(&json, None).unwrap();
        assert_eq!(envs.iter().map(|e| e.env.as_str()).collect::<Vec<_>>(), ["prod"]);
        assert_eq!(envs[0].sha.as_deref(), Some(a.as_str()), "a bad oid drops that deployment alone");
        assert_eq!(gaps, ["3 left out for a name that cannot be shown"]);
    }

    #[test]
    fn the_lag_is_counted_in_the_clone_with_one_graphql_read() {
        use crate::testutil::git;
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        let commit = |m: &str| git(&dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", m]);
        let head = || String::from_utf8_lossy(&std::process::Command::new("git").current_dir(&dir).args(["rev-parse", "HEAD"]).output().unwrap().stdout).trim().to_string();
        commit("one");
        let live = head();
        git(&dir, &["checkout", "-q", "-b", "hotfix"]);
        commit("hotfix");
        let side = head();
        git(&dir, &["checkout", "-q", "main"]);
        commit("two");
        commit("three");
        let root = dir.to_string_lossy().to_string();
        let missing = "f".repeat(40);
        let json = page(&[
            node("prod", "ACTIVE", &live, "2026-10-03T00:00:00Z", "null"),
            node("staging", "ACTIVE", &side, "2026-10-02T00:00:00Z", "null"),
            node("qa", "ACTIVE", &missing, "2026-10-01T00:00:00Z", "null"),
        ]);
        let ex = FakeExec::answering(Ok(&json));
        let r = read(&root, "[maintenance]\ntrunk = \"main\"\n", github_deployments, &ex).unwrap();
        let Facts::Deployments { trunk, envs, .. } = &r.facts else { panic!("{:?}", r.facts) };
        assert_eq!(trunk.as_deref(), Some("main"));
        let prod = env(envs, "prod");
        assert_eq!((prod.behind, prod.ahead), (Some(2), Some(0)));
        assert!(prod.behind_at.is_some());
        let staging = env(envs, "staging");
        assert_eq!((staging.behind, staging.ahead), (Some(2), Some(1)));
        assert_eq!((env(envs, "qa").behind, env(envs, "qa").ahead), (None, None), "not in this clone is not 0");
        assert_eq!(r.gaps, ["qa: fffffff is not in this clone; a fetch may bring it"]);
        let calls = ex.calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert_eq!(calls[0][..3], ["gh", "api", "graphql"]);
        assert!(calls[0].contains(&format!("query={DEPLOY_Q}")) && calls[0].contains(&"owner=acme".to_string()) && calls[0].contains(&"name=app".to_string()), "{calls:?}");
    }

    #[test]
    fn no_environment_is_ok_and_adds_nothing() {
        let root = scratch_dir().to_string_lossy().to_string();
        let empty = page(&[]);
        let r = read(&root, "", github_deployments, &FakeExec::answering(Ok(&empty))).unwrap();
        assert!(matches!(r.facts, Facts::Deployments { trunk: None, ref envs, fetched_at: None } if envs.is_empty()), "{:?}", r.facts);
        assert!(r.gaps.is_empty());
    }

    fn gitlab_read(ex: &FakeExec) -> Result<Read, Coverage> {
        let cfg = parse_maint("");
        let forge = Forge { kind: ForgeKind::Gitlab, host: Some("gitlab.com".into()), path: Some("gitlab-org/cli".into()), by: ForgeBy::Table, api: None };
        gitlab_work(&Ctx { root: "/maint-test/gl", cfg: &cfg, forge: &forge, account: None, force: true, hosts: &[] }, ex)
    }

    #[test]
    fn gitlab_work_counts_totals_and_a_signed_out_glab_costs_only_reviews() {
        // Recorded signed out, so the project's totals came back and the review count did not.
        let ex = FakeExec::answering(Ok(&FakeExec::testdata("glab-work.json")));
        let r = gitlab_read(&ex).unwrap();
        assert!(matches!(r.facts, Facts::Work { issues: 256, prs: 87, review_requested: None }), "{:?}", r.facts);
        assert_eq!(r.gaps, ["review requests not read: glab is not signed in to gitlab.com"]);
        let call = &ex.calls()[0];
        assert_eq!(call[..5], ["glab", "api", "--hostname", "gitlab.com", "graphql"]);
        assert!(call.contains(&"path=gitlab-org/cli".to_string()) && call.contains(&"p=gitlab-org/cli".to_string()), "{call:?}");

        let mine = r#"{"data":{"project":{"issues":{"count":3},"mergeRequests":{"count":1}},"currentUser":{"reviewRequestedMergeRequests":{"count":1}}}}"#;
        let r = parse_gitlab_work(mine, "gitlab.com").unwrap();
        assert!(matches!(r.facts, Facts::Work { issues: 3, prs: 1, review_requested: Some(1) }) && r.gaps.is_empty());

        let Err(Coverage::NoAccess { fix, .. }) = parse_gitlab_work(&FakeExec::testdata("glab-work-no-project.json"), "gitlab.com") else { panic!() };
        assert_eq!(fix.as_deref(), Some("glab auth login --hostname gitlab.com"), "a project nobody may see is null, not an error");
        assert!(matches!(parse_gitlab_work(r#"{"data":{"project":{}}}"#, "gitlab.com"), Err(Coverage::Error { .. })), "no totals is no answer");
        assert!(matches!(gitlab_read(&FakeExec::answering(Err("glab not available: program not found"))), Err(Coverage::NoTool { .. })));
        assert!(parse_gitlab_work("<html>", "gitlab.com").is_err());

        let said = r#"{"data":{"project":null},"errors":[{"message":"403 Forbidden"}]}"#;
        assert!(matches!(parse_gitlab_work(said, "gitlab.com"), Err(Coverage::NoAccess { reason, .. }) if reason == "403 Forbidden"), "a null project's own error decides");
        let partial = r#"{"data":{"project":{"issues":{"count":2},"mergeRequests":{"count":0}},"currentUser":{}},"errors":[{"message":"Field 'reviewRequestedMergeRequests' doesn't exist"}]}"#;
        let r = parse_gitlab_work(partial, "gitlab.acme.io").unwrap();
        assert!(matches!(r.facts, Facts::Work { issues: 2, prs: 0, review_requested: None }), "{:?}", r.facts);
        assert_eq!(r.gaps, ["review requests not read: Field 'reviewRequestedMergeRequests' doesn't exist"]);
    }
}
