//! The forge's own records (docs/maintenance.md § Adapters): the update bots' pull requests, every
//! bot source sharing one `gh pr list` through `deps.rs`'s cache, filtered by the bots table.

use crate::deps::{bot_prs_read, ChecksRollup, DepPr};
use crate::maint::{bots, found_any, gh_coverage, github_repo, CiStatus, Coverage, Ctx, Exec, Facts, Read, UpdatePr};
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
}
