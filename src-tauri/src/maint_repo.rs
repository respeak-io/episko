//! The forge's own records (docs/maintenance.md § Adapters): the update bots' pull requests, every
//! bot source sharing one `gh pr list` through `deps.rs`'s cache; published releases; open work.

use serde_json::Value;

use crate::deps::{bot_prs_read, ChecksRollup, DepPr};
use crate::maint::{bots, found_any, gh_coverage, github_repo, CiStatus, Coverage, Ctx, Exec, Facts, ForgeRelease, Read, UpdatePr};
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
        return Err(errors.first().map_or_else(none, |m| gh_coverage(m, account)));
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
        let forge = Forge { kind: ForgeKind::Github, host: Some("github.com".into()), path: Some("acme/app".into()), by: ForgeBy::Table };
        f(&Ctx { root, cfg: &cfg, forge: &forge, account: None, force }, ex)
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
}
