//! The local sources (docs/maintenance.md § Adapters): `git-local`, `git-tags` and `changelog`.
//! Thin wrappers over git.rs's readers; they never fetch, so their facts carry `fetched_at`.

use crate::git::{hygiene, maint_trunk, release_facts, repo_root_of};
use crate::maint::{Coverage, Ctx, Exec, Facts, Read};

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

const CHANGELOG_CAP: u64 = 4 * 1024 * 1024;

pub(crate) fn changelog(ctx: &Ctx, _ex: &dyn Exec) -> Result<Read, Coverage> {
    let path = std::path::Path::new(ctx.root).join("CHANGELOG.md");
    match std::fs::metadata(&path) {
        Err(_) => return Err(Coverage::Unsupported { reason: "no CHANGELOG.md".into() }),
        Ok(m) if m.len() > CHANGELOG_CAP => return Err(Coverage::Unsupported { reason: "CHANGELOG.md is too large to read".into() }),
        Ok(_) => {}
    }
    let text = std::fs::read_to_string(&path).map_err(|e| Coverage::Error { reason: e.to_string() })?;
    Ok(Read::of(parse_changelog(&text)))
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

    const NO_FORGE: Forge = Forge { kind: ForgeKind::None, host: None, path: None, by: ForgeBy::None };

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

    #[test]
    fn no_trunk_is_unsupported_for_tags_and_a_gap_for_branches() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        commit(&dir, "one");
        let root = dir.to_string_lossy().to_string();
        let cfg = MaintConfig::default();
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None };
        let ex = FakeExec::answering(Err("unused"));
        assert!(matches!(git_tags(&ctx, &ex), Err(Coverage::Unsupported { .. })), "no remote, no pinned trunk");
        let read = git_local(&ctx, &ex).expect("branches stand without a trunk");
        assert_eq!(read.gaps.len(), 2, "no remote and no trunk: {:?}", read.gaps);

        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        std::fs::write(dir.join(".episko/episko.toml"), "[maintenance]\ntrunk = \"main\"\n").unwrap();
        let cfg = read_config(&root);
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None };
        assert!(git_tags(&ctx, &ex).is_ok());
        assert_eq!(git_local(&ctx, &ex).expect("read").gaps.len(), 1, "only the missing remote");
        assert!(ex.calls().is_empty(), "local sources never touch the Exec");

        std::fs::write(dir.join(".episko/episko.toml"), "[maintenance]\ntrunk = \"dev\"\n").unwrap();
        let cfg = read_config(&root);
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None };
        match git_tags(&ctx, &ex) {
            Err(Coverage::Unsupported { reason }) => assert!(reason.contains("\"dev\""), "{reason}"),
            _ => panic!("a trunk that names nothing must not fall back to main"),
        }
    }
}
