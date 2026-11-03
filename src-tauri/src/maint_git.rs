//! The local sources (docs/maintenance.md § Adapters): `git-local`, `git-tags`, `changelog`, `deploy-tags`.
//! Thin wrappers over git.rs's readers; they never fetch, so their facts carry `fetched_at`.

use crate::git::{deploy_lag, fetched_at, hygiene, maint_trunk, newest_tag, release_facts, repo_root_of, tag_at, tag_refs};
use crate::maint::{read_capped, Coverage, Ctx, Deployed, EnvTier, Exec, Facts, Read};

fn not_a_repo() -> Coverage {
    Coverage::Unsupported { reason: "not a git repository".into() }
}

pub(crate) fn git_local(ctx: &Ctx, _ex: &dyn Exec) -> Result<Read, Coverage> {
    if repo_root_of(ctx.root).is_none() {
        return Err(not_a_repo());
    }
    // Everything but `merged` stands without a trunk, so its absence is a gap, not the cell.
    let trunk = maint_trunk(ctx.root, ctx.cfg.trunk());
    let mut h = hygiene(ctx.root, trunk.as_deref().ok())
        .map_err(|reason| Coverage::Error { reason })?
        .ok_or_else(not_a_repo)?;
    let mut gaps = std::mem::take(&mut h.gaps);
    if let Err(why) = trunk {
        gaps.push(format!("merged branches not read: {why}"));
    }
    Ok(Read { gaps, ..Read::of(Facts::Hygiene(h)) })
}

pub(crate) fn git_tags(ctx: &Ctx, _ex: &dyn Exec) -> Result<Read, Coverage> {
    if repo_root_of(ctx.root).is_none() {
        return Err(not_a_repo());
    }
    let trunk = maint_trunk(ctx.root, ctx.cfg.trunk()).map_err(|reason| Coverage::Unsupported { reason })?;
    let f = release_facts(ctx.root, ctx.cfg.tag_pattern(), &trunk).map_err(|reason| Coverage::Error { reason })?;
    Ok(Read::of(Facts::Release(f)))
}

// ---------- what each environment runs ----------

/// The environments one read keeps: each costs a `rev-list` and a `log` here.
pub(crate) const DEPLOY_CAP: usize = 12;

/// The name table lives in Rust because it must name a vendor (`github-pages`). A name it does not
/// know is `other`: listed, never amber, the safe way to be wrong.
pub(crate) fn env_tier(name: &str) -> EnvTier {
    let lower = name.to_ascii_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let has = |set: &[&str]| words.iter().any(|w| set.contains(w));
    let digits = |w: &str| !w.is_empty() && w.bytes().all(|b| b.is_ascii_digit());
    let pr = words.iter().enumerate().any(|(i, w)| (*w == "pr" && words.get(i + 1).is_some_and(|n| digits(n))) || w.strip_prefix("pr").is_some_and(digits));
    if pr || has(&["preview", "review"]) {
        EnvTier::Preview
    } else if has(&["staging", "stage", "stg", "uat", "qa", "preprod", "pre"]) {
        EnvTier::Staging
    } else if has(&["prod", "production", "prd", "live"]) || lower == "github-pages" {
        EnvTier::Production
    } else {
        EnvTier::Other
    }
}

/// An environment nothing is known about yet.
pub(crate) fn env_named(env: &str) -> Deployed {
    Deployed {
        env: env.to_string(), tier: env_tier(env), sha: None, tag: None, branch: None, at: None, url: None, last: None,
        behind: None, behind_at: None, ahead: None,
    }
}

/// What both sources share: the lag against the trunk, counted here, so a commit the clone lacks or
/// a trunk nobody knows is a gap and `behind: None`, never 0. Nothing to measure spawns nothing.
pub(crate) fn measure(ctx: &Ctx, mut envs: Vec<Deployed>, mut gaps: Vec<String>, truncated: bool) -> Read {
    if envs.is_empty() {
        return Read { truncated, gaps, ..Read::of(Facts::Deployments { trunk: None, envs, fetched_at: None }) };
    }
    let trunk = maint_trunk(ctx.root, ctx.cfg.trunk());
    if let Err(why) = &trunk {
        gaps.push(format!("behind not counted: {why}"));
    }
    let tags = if envs.iter().any(|e| e.sha.is_some() && e.tag.is_none()) { tag_refs(ctx.root).unwrap_or_default() } else { vec![] };
    for e in &mut envs {
        let Some(sha) = e.sha.clone() else { continue };
        if let Ok(t) = &trunk {
            match deploy_lag(ctx.root, &sha, t) {
                Ok(Some(l)) => (e.behind, e.behind_at, e.ahead) = (Some(l.behind), l.behind_at, Some(l.ahead)),
                Ok(None) => gaps.push(format!("{}: {} is not in this clone; a fetch may bring it", e.env, sha.get(..7).unwrap_or(&sha))),
                Err(why) => gaps.push(format!("{}: behind not counted: {why}", e.env)),
            }
        }
        if e.tag.is_none() {
            e.tag = tag_at(&tags, &sha, ctx.cfg.tag_pattern()).map(str::to_string);
        }
    }
    Read { truncated, gaps, facts: Facts::Deployments { trunk: trunk.ok(), envs, fetched_at: fetched_at(ctx.root) } }
}

/// The tag convention `[deploy] envs` names: the newest tag a pattern accepts is what is live.
pub(crate) fn deploy_tags(ctx: &Ctx, _ex: &dyn Exec) -> Result<Read, Coverage> {
    if repo_root_of(ctx.root).is_none() {
        return Err(not_a_repo());
    }
    let deploy = crate::deploy::read(ctx.root).unwrap_or_default();
    if deploy.envs().is_empty() {
        return Err(Coverage::Unsupported { reason: "no envs in [deploy]".into() });
    }
    let tags = tag_refs(ctx.root).map_err(|reason| Coverage::Error { reason })?;
    let mut gaps = vec![];
    let envs = deploy.envs().iter().take(DEPLOY_CAP).map(|(env, pattern)| {
        let mut e = env_named(env);
        match newest_tag(&tags, pattern) {
            Some(t) => (e.sha, e.tag, e.at) = (t.commit.clone(), Some(t.name.clone()), t.at),
            None => gaps.push(format!("{env}: no tag matches {pattern}")),
        }
        e
    }).collect();
    let truncated = deploy.envs().len() > DEPLOY_CAP;
    if truncated {
        gaps.push(format!("only the first {DEPLOY_CAP} of [deploy] envs are read"));
    }
    Ok(measure(ctx, envs, gaps, truncated))
}

const CHANGELOG_CAP: u64 = 4 * 1024 * 1024;

pub(crate) fn changelog(ctx: &Ctx, _ex: &dyn Exec) -> Result<Read, Coverage> {
    let path = std::path::Path::new(ctx.root).join("CHANGELOG.md");
    match read_capped(&path, CHANGELOG_CAP) {
        Ok(text) => Ok(Read::of(parse_changelog(&text))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(Coverage::Unsupported { reason: "no CHANGELOG.md".into() }),
        Err(e) if e.kind() == std::io::ErrorKind::Other => Err(Coverage::Unsupported { reason: format!("CHANGELOG.md is {e}") }),
        Err(e) => Err(Coverage::Error { reason: e.to_string() }),
    }
}

fn heading(line: &str) -> Option<&str> {
    line.strip_prefix("## ").map(|h| h.trim())
}

/// `2026-10-22` anywhere in a heading, as UTC midnight.
fn heading_date(h: &str) -> Option<u64> {
    h.split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | '[' | ']')).find_map(|w| {
        let p: Vec<&str> = w.split('-').collect();
        let [y, m, d] = p[..] else { return None };
        if (y.len(), m.len(), d.len()) != (4, 2, 2) {
            return None;
        }
        let (y, m, d) = (y.parse::<i64>().ok()?, m.parse::<i64>().ok()?, d.parse::<i64>().ok()?);
        ((1..=12).contains(&m) && (1..=31).contains(&d)).then(|| crate::usage::days_from_civil(y, m, d) as u64 * 86_400)
    })
}

/// `## Unreleased`'s entries and the newest released heading. `unreleased: None` is a changelog
/// with no such section, a different fact from an empty one. Entries are top-level bullets
/// (`-`, `*`, and this repo's `+ ~ !`); prose with no bullet still counts as one.
pub(crate) fn parse_changelog(text: &str) -> Facts {
    let (mut unreleased, mut latest, mut latest_at) = (None::<u32>, None, None);
    let (mut inside, mut prose) = (false, false);
    for line in text.lines() {
        if let Some(h) = heading(line) {
            let name = h.trim_start_matches('[');
            if name.to_ascii_lowercase().starts_with("unreleased") {
                (inside, unreleased) = (true, Some(0));
                continue;
            }
            inside = false;
            if latest.is_none() {
                latest = name.split([']', ' ']).next().filter(|v| !v.is_empty()).map(str::to_string);
                latest_at = heading_date(h);
            }
            continue;
        }
        if !inside || line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if ["- ", "* ", "+ ", "~ ", "! "].iter().any(|b| line.starts_with(b)) {
            unreleased = unreleased.map(|n| n + 1);
        } else if !line.starts_with(char::is_whitespace) {
            prose = true;
        }
    }
    let unreleased = unreleased.map(|n| if n == 0 && prose { 1 } else { n });
    Facts::Changelog { unreleased, latest, latest_at }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::{read_config, MaintConfig};
    use crate::testutil::{git, scratch_dir};

    const NO_FORGE: Forge = Forge { kind: ForgeKind::None, host: None, path: None, by: ForgeBy::None, api: None };

    fn changelog_of(text: &str) -> (Option<u32>, Option<String>, Option<u64>) {
        match parse_changelog(text) {
            Facts::Changelog { unreleased, latest, latest_at } => (unreleased, latest, latest_at),
            _ => unreachable!(),
        }
    }

    #[test]
    fn a_changelog_says_what_is_unreleased() {
        let ours = "# Changelog\n\nMarkers: `+` new\n\n## Unreleased\n+ one\n  continued\n~ two\n\n## 0.37.0 — 2026-10-22\n+ old\n";
        assert_eq!(changelog_of(ours), (Some(2), Some("0.37.0".into()), Some(1_792_627_200)));
        let kac = "## [Unreleased]\n### Added\n- a\n- b\n- c\n## [1.2.0] - 2026-01-05\n";
        assert_eq!(changelog_of(kac).0, Some(3), "Keep a Changelog's subsections still count");
        assert_eq!(changelog_of(kac).1.as_deref(), Some("1.2.0"));
        assert_eq!(changelog_of("## Unreleased\n\n## 1.0\n").0, Some(0), "an empty section is zero");
        assert_eq!(changelog_of("## Unreleased\nSome prose.\n").0, Some(1), "prose is an entry");
        assert_eq!(changelog_of("## 1.0 (2026-03-02)\n- x\n"), (None, Some("1.0".into()), Some(1_772_409_600)), "no section is None");
        assert_eq!(changelog_of("nothing here"), (None, None, None));
    }

    fn commit(dir: &std::path::Path, msg: &str) {
        git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
    }

    fn annotated(dir: &std::path::Path, at: u64, tag: &str) {
        let out = std::process::Command::new("git").current_dir(dir).env("GIT_COMMITTER_DATE", format!("@{at} +0000"))
            .args(["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "tag.gpgsign=false", "tag", "-a", tag, "-m", tag]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    fn tagged_repo(toml: &str) -> (std::path::PathBuf, String, MaintConfig) {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        std::fs::write(dir.join(".episko/episko.toml"), toml).unwrap();
        commit(&dir, "one");
        let root = dir.to_string_lossy().to_string();
        let cfg = read_config(&root);
        (dir, root, cfg)
    }

    fn deployed(r: &Read) -> Vec<Deployed> {
        let Facts::Deployments { envs, .. } = &r.facts else { panic!("{:?}", r.facts) };
        envs.clone()
    }

    #[test]
    fn a_series_of_tags_picks_the_newest_and_counts_what_is_not_live() {
        let (dir, root, cfg) = tagged_repo("[maintenance]\ntrunk = \"main\"\n[deploy]\nenvs = { prod = \"prod-*\", staging = \"staging\", none = \"nope-*\" }\n");
        annotated(&dir, 2_000, "prod-1");
        commit(&dir, "two");
        annotated(&dir, 3_000, "prod-2");
        git(&dir, &["-c", "tag.gpgsign=false", "tag", "staging"]);
        commit(&dir, "three");
        commit(&dir, "four");
        let ex = FakeExec::answering(Err("unused"));
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        let r = deploy_tags(&ctx, &ex).unwrap();
        let by = |n: &str| deployed(&r).into_iter().find(|e| e.env == n).unwrap();
        let prod = by("prod");
        assert_eq!((prod.tag.as_deref(), prod.at, prod.behind, prod.ahead, prod.tier), (Some("prod-2"), Some(3_000), Some(2), Some(0), EnvTier::Production), "by the tag's own date");
        assert!(prod.behind_at.is_some() && prod.sha.is_some() && prod.last.is_none());
        let staging = by("staging");
        assert_eq!((staging.at, staging.behind, staging.tier), (None, Some(2), EnvTier::Staging), "a moving lightweight tag has no deploy time");
        let none = by("none");
        assert_eq!((none.sha, none.behind), (None, None));
        assert_eq!(r.gaps, ["none: no tag matches nope-*"]);
        let Facts::Deployments { trunk, .. } = &r.facts else { panic!() };
        assert_eq!(trunk.as_deref(), Some("main"));
        assert!(ex.calls().is_empty(), "a local source never touches the Exec");
    }

    #[test]
    fn a_tag_on_a_side_branch_is_ahead_of_the_trunk() {
        let (dir, root, cfg) = tagged_repo("[maintenance]\ntrunk = \"main\"\n[deploy]\nenvs = { prod = \"prod-*\" }\n");
        git(&dir, &["checkout", "-q", "-b", "hotfix"]);
        commit(&dir, "hotfix");
        annotated(&dir, 2_000, "prod-1");
        git(&dir, &["checkout", "-q", "main"]);
        commit(&dir, "two");
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        let e = deployed(&deploy_tags(&ctx, &FakeExec::answering(Err("unused"))).unwrap()).remove(0);
        assert_eq!((e.behind, e.ahead), (Some(1), Some(1)));
    }

    #[test]
    fn no_trunk_is_a_gap_and_not_a_repo_is_unsupported() {
        let (dir, root, cfg) = tagged_repo("[deploy]\nenvs = { prod = \"prod-*\" }\n");
        annotated(&dir, 2_000, "prod-1");
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        let r = deploy_tags(&ctx, &FakeExec::answering(Err("unused"))).unwrap();
        let e = deployed(&r).remove(0);
        assert_eq!((e.tag.as_deref(), e.behind, e.ahead), (Some("prod-1"), None, None), "not counted is not 0");
        assert!(r.gaps[0].starts_with("behind not counted: no remote"), "{:?}", r.gaps);
        let Facts::Deployments { trunk, .. } = &r.facts else { panic!() };
        assert_eq!(*trunk, None);

        let plain = scratch_dir().to_string_lossy().to_string();
        let ctx = Ctx { root: &plain, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        assert!(matches!(deploy_tags(&ctx, &FakeExec::answering(Err("unused"))), Err(Coverage::Unsupported { reason }) if reason == "not a git repository"));
    }

    #[test]
    fn measure_names_a_commit_the_clone_lacks_and_finds_a_tag_at_the_live_one() {
        let (dir, root, cfg) = tagged_repo("[maintenance]\ntrunk = \"main\"\ntag_pattern = \"v*\"\n");
        annotated(&dir, 2_000, "nightly");
        annotated(&dir, 3_000, "v1.0");
        commit(&dir, "two");
        let sha = String::from_utf8_lossy(&std::process::Command::new("git").current_dir(&dir).args(["rev-parse", "HEAD~1"]).output().unwrap().stdout).trim().to_string();
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        let mut live = env_named("prod");
        live.sha = Some(sha);
        let mut lost = env_named("staging");
        lost.sha = Some("f".repeat(40));
        let r = measure(&ctx, vec![live, lost], vec![], false);
        let envs = deployed(&r);
        assert_eq!((envs[0].tag.as_deref(), envs[0].behind), (Some("v1.0"), Some(1)), "tag_pattern's tag, not the other at that commit");
        assert_eq!((envs[1].behind, envs[1].ahead, envs[1].tag.clone()), (None, None, None));
        assert_eq!(r.gaps, ["staging: fffffff is not in this clone; a fetch may bring it"]);
        let empty = measure(&ctx, vec![], vec![], false);
        assert!(matches!(empty.facts, Facts::Deployments { trunk: None, ref envs, fetched_at: None } if envs.is_empty()), "no environment, no stale-fetch line");
    }

    #[test]
    fn an_environments_name_says_its_tier() {
        // The first eight are real names from the committed recordings; the rest are written by hand.
        for (name, tier) in [
            ("github-pages", EnvTier::Production), ("Production", EnvTier::Production), ("Production – ui", EnvTier::Production),
            ("Preview", EnvTier::Preview), ("Preview – ui-v3", EnvTier::Preview),
            ("copilot", EnvTier::Other), ("Release", EnvTier::Other), ("next – ui", EnvTier::Other), ("automations", EnvTier::Other), ("release-gate", EnvTier::Other),
            ("prod", EnvTier::Production), ("live-eu", EnvTier::Production), ("staging", EnvTier::Staging), ("pre-prod", EnvTier::Staging), ("pr-123", EnvTier::Preview), ("pr7", EnvTier::Preview),
        ] {
            assert_eq!(env_tier(name), tier, "{name}");
        }
        assert_eq!(env_tier("product"), EnvTier::Other, "whole words, not prefixes");
        assert_eq!(env_tier("pr"), EnvTier::Other);
    }

    #[test]
    fn no_trunk_is_unsupported_for_tags_and_a_gap_for_branches() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        commit(&dir, "one");
        let root = dir.to_string_lossy().to_string();
        let cfg = MaintConfig::default();
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        let ex = FakeExec::answering(Err("unused"));
        assert!(matches!(git_tags(&ctx, &ex), Err(Coverage::Unsupported { .. })), "no remote, no pinned trunk");
        let read = git_local(&ctx, &ex).expect("branches stand without a trunk");
        assert_eq!(read.gaps.len(), 2, "no remote and no trunk: {:?}", read.gaps);

        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        std::fs::write(dir.join(".episko/episko.toml"), "[maintenance]\ntrunk = \"main\"\n").unwrap();
        let cfg = read_config(&root);
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        assert!(git_tags(&ctx, &ex).is_ok());
        assert_eq!(git_local(&ctx, &ex).expect("read").gaps.len(), 1, "only the missing remote");
        assert!(ex.calls().is_empty(), "local sources never touch the Exec");

        std::fs::write(dir.join(".episko/episko.toml"), "[maintenance]\ntrunk = \"dev\"\n").unwrap();
        let cfg = read_config(&root);
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        match git_tags(&ctx, &ex) {
            Err(Coverage::Unsupported { reason }) => assert!(reason.contains("\"dev\""), "{reason}"),
            _ => panic!("a trunk that names nothing must not fall back to main"),
        }
    }
}
