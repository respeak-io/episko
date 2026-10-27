//! Which forge a remote lives on (docs/maintenance.md § Detection), decided before any file:
//! the `[maintenance] forge` pin, a known-host table, a host that names its software, else
//! `unknown`. No network probe, so a self-hosted host that names nothing waits for a pin.

use crate::git::{remote_parts, ssh_hostname};

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ForgeKind {
    Github,
    Gitlab,
    Forgejo,
    Gitea,
    Bitbucket,
    Azure,
    Unknown,
    None, // no remote at all
}

const KINDS: [(ForgeKind, &str); 8] = [
    (ForgeKind::Github, "github"),
    (ForgeKind::Gitlab, "gitlab"),
    (ForgeKind::Forgejo, "forgejo"),
    (ForgeKind::Gitea, "gitea"),
    (ForgeKind::Bitbucket, "bitbucket"),
    (ForgeKind::Azure, "azure"),
    (ForgeKind::Unknown, "unknown"),
    (ForgeKind::None, "none"),
];

impl ForgeKind {
    /// The manifest's spelling, which is also the wire's.
    pub(crate) fn id(self) -> &'static str {
        KINDS.iter().find(|(k, _)| *k == self).map_or("unknown", |(_, s)| s)
    }

    pub(crate) fn from_id(s: &str) -> Option<Self> {
        KINDS.iter().find(|(_, id)| *id == s).map(|(k, _)| *k)
    }
}

/// How the kind was decided, so a tip can say "pin it" exactly when nothing else could tell.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ForgeBy {
    Pin,
    Table,
    Name,
    None,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Forge {
    pub(crate) kind: ForgeKind,
    pub(crate) host: Option<String>, // as the remote spells it; an ssh alias stays an alias
    pub(crate) path: Option<String>, // everything after the host: `group/sub/repo` on GitLab
    pub(crate) by: ForgeBy,
}

fn known_host(h: &str) -> Option<ForgeKind> {
    Some(match h {
        "github.com" => ForgeKind::Github,
        "gitlab.com" => ForgeKind::Gitlab,
        "codeberg.org" => ForgeKind::Forgejo,
        "bitbucket.org" => ForgeKind::Bitbucket,
        "dev.azure.com" | "ssh.dev.azure.com" => ForgeKind::Azure,
        _ if h.ends_with(".visualstudio.com") => ForgeKind::Azure,
        _ => return None,
    })
}

fn named_host(h: &str) -> Option<ForgeKind> {
    [("gitlab", ForgeKind::Gitlab), ("forgejo", ForgeKind::Forgejo), ("gitea", ForgeKind::Gitea)]
        .into_iter()
        .find(|(n, _)| h.contains(n))
        .map(|(_, k)| k)
}

/// [`forge_of`] with the alias resolver injected. Only an ssh-ish remote can carry an
/// `~/.ssh/config` alias, and it is resolved only once the plain host has matched nothing.
pub(crate) fn forge_with(url: Option<&str>, pin: Option<&str>, resolve: impl Fn(&str) -> Option<String>) -> Forge {
    let (host, path) = url.and_then(remote_parts).map_or((None, None), |(h, p)| (Some(h), Some(p).filter(|p| !p.is_empty())));
    let pinned = pin
        .and_then(|p| ForgeKind::from_id(&p.trim().to_ascii_lowercase()))
        .filter(|k| !matches!(k, ForgeKind::Unknown | ForgeKind::None));
    if let Some(kind) = pinned {
        return Forge { kind, host, path, by: ForgeBy::Pin };
    }
    let Some(h) = host.clone() else {
        return Forge { kind: ForgeKind::None, host, path, by: ForgeBy::None };
    };
    let ssh = url.is_some_and(|u| !u.trim_start().to_ascii_lowercase().starts_with("http"));
    let real = if known_host(&h).is_none() && ssh { resolve(&h) } else { None };
    let names = [Some(h.as_str()), real.as_deref()];
    let decided = names.iter().flatten().find_map(|n| known_host(n)).map(|k| (k, ForgeBy::Table))
        .or_else(|| names.iter().flatten().find_map(|n| named_host(n)).map(|k| (k, ForgeBy::Name)));
    let (kind, by) = decided.unwrap_or((ForgeKind::Unknown, ForgeBy::None));
    Forge { kind, host, path, by }
}

pub(crate) fn forge_of(url: Option<&str>, pin: Option<&str>) -> Forge {
    forge_with(url, pin, ssh_hostname)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_alias(_: &str) -> Option<String> {
        None
    }

    fn of(url: &str) -> Forge {
        forge_with(Some(url), None, no_alias)
    }

    #[test]
    fn the_host_table_decides_before_any_name() {
        let g = of("git@github.com:acme/app.git");
        assert_eq!((g.kind, g.by, g.path.as_deref()), (ForgeKind::Github, ForgeBy::Table, Some("acme/app")));
        assert_eq!(of("https://codeberg.org/a/b").kind, ForgeKind::Forgejo, "Codeberg runs Forgejo");
        assert_eq!(of("https://bitbucket.org/a/b.git").kind, ForgeKind::Bitbucket);
        assert_eq!(of("https://dev.azure.com/org/proj/_git/repo").path.as_deref(), Some("org/proj/_git/repo"));
        assert_eq!(of("https://acme.visualstudio.com/proj/_git/repo").kind, ForgeKind::Azure);
    }

    #[test]
    fn a_gitlab_path_keeps_every_subgroup() {
        let f = of("https://gitlab.com/group/sub/deeper/repo.git");
        assert_eq!((f.kind, f.path.as_deref()), (ForgeKind::Gitlab, Some("group/sub/deeper/repo")));
        let f = of("git@gitlab.com:group/sub/repo.git");
        assert_eq!(f.path.as_deref(), Some("group/sub/repo"));
    }

    #[test]
    fn a_self_hosted_name_is_read_and_a_silent_one_stays_unknown() {
        let f = of("https://gitlab.acme.io/x/y.git");
        assert_eq!((f.kind, f.by), (ForgeKind::Gitlab, ForgeBy::Name));
        assert_eq!(of("https://gitea.example.org/x/y").kind, ForgeKind::Gitea);
        let f = of("https://git.acme.io/x/y.git");
        assert_eq!((f.kind, f.by, f.host.as_deref()), (ForgeKind::Unknown, ForgeBy::None, Some("git.acme.io")));
    }

    #[test]
    fn the_pin_wins_and_a_nonsense_pin_is_ignored() {
        let f = forge_with(Some("https://git.acme.io/x/y.git"), Some("GitLab"), no_alias);
        assert_eq!((f.kind, f.by), (ForgeKind::Gitlab, ForgeBy::Pin));
        let f = forge_with(Some("https://github.com/x/y"), Some("forgejo"), no_alias);
        assert_eq!(f.kind, ForgeKind::Forgejo, "a pin outranks even the table");
        assert_eq!(forge_with(Some("https://git.acme.io/x/y"), Some("teamcity"), no_alias).kind, ForgeKind::Unknown);
        assert_eq!(forge_with(None, Some("gitea"), no_alias).kind, ForgeKind::Gitea, "a pin needs no remote");
    }

    #[test]
    fn an_ssh_alias_resolves_and_keeps_its_spelling() {
        let resolve = |a: &str| (a == "github.com-work").then(|| "github.com".to_string());
        let f = forge_with(Some("git@github.com-work:acme/app.git"), None, resolve);
        assert_eq!((f.kind, f.by, f.host.as_deref()), (ForgeKind::Github, ForgeBy::Table, Some("github.com-work")));
        // An https host is a real hostname: no alias lookup, no `ssh -G` spawned for it.
        let never = |_: &str| -> Option<String> { panic!("an https remote must not be resolved") };
        assert_eq!(forge_with(Some("https://github.com-work/a/b"), None, never).kind, ForgeKind::Unknown);
        assert_eq!(forge_with(Some("git@github.com:a/b"), None, never).kind, ForgeKind::Github, "a known host skips the lookup");
    }

    #[test]
    fn no_remote_is_its_own_answer() {
        let f = forge_with(None, None, no_alias);
        assert_eq!((f.kind, f.host, f.path), (ForgeKind::None, None, None));
        assert_eq!(of("/srv/git/app.git").kind, ForgeKind::None, "a local path is no forge");
        for k in KINDS.map(|(k, _)| k) {
            assert_eq!(ForgeKind::from_id(k.id()), Some(k));
        }
    }
}
