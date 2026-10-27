//! Which forge a remote lives on (docs/maintenance.md § Detection), decided before any file:
//! the `[maintenance] forge` pin, a known-host table, a host that names its software, else
//! `unknown`. No network probe, so a self-hosted host that names nothing waits for a pin.
//! Also GitLab's transport, `glab`, the twin of `github::gh`.

use crate::git::{remote_parts, ssh_hostname};
use crate::maint::Coverage;
use crate::platform::{augmented_path, sys_command};

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

pub(crate) const KINDS: [(ForgeKind, &str); 8] = [
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
    #[serde(skip)]
    pub(crate) api: Option<String>, // where an API is asked when `host` is not it: an alias's real host, a web port
}

impl Forge {
    /// The hostname a forge CLI is pointed at: `api` when the remote's own spelling is not it.
    pub(crate) fn api_host(&self) -> Option<&str> {
        self.api.as_deref().or(self.host.as_deref())
    }
}

/// `host:port` for an http(s) remote off its scheme's port, since glab keys a login by both.
fn web_port(url: &str, host: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let default = match scheme.to_ascii_lowercase().as_str() {
        "https" => "443",
        "http" => "80",
        _ => return None,
    };
    let auth = rest.split('/').next().unwrap_or(rest);
    let port = auth.rsplit_once('@').map_or(auth, |(_, a)| a).rsplit_once(':')?.1;
    (!port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && port != default).then(|| format!("{host}:{port}"))
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
    let Some(h) = host.clone() else {
        let (kind, by) = pinned.map_or((ForgeKind::None, ForgeBy::None), |k| (k, ForgeBy::Pin));
        return Forge { kind, host, path, by, api: None };
    };
    let ssh = url.is_some_and(|u| !u.trim_start().to_ascii_lowercase().starts_with("http"));
    let resolved = if known_host(&h).is_none() && ssh { resolve(&h) } else { None };
    let names = [Some(h.as_str()), resolved.as_deref()];
    let decided = names.iter().flatten().find_map(|n| known_host(n)).map(|k| (k, ForgeBy::Table))
        .or_else(|| names.iter().flatten().find_map(|n| named_host(n)).map(|k| (k, ForgeBy::Name)));
    // An alias is a bare name or one only the table knows resolved; a dotted host whose ssh
    // merely goes elsewhere (an IP, an ssh endpoint) is still the web host.
    let api = resolved.filter(|r| !h.contains('.') || known_host(r).is_some())
        .or_else(|| url.and_then(|u| web_port(u, &h)));
    // A pin the host table agrees with is the table's answer, so an ssh alias of github.com stays github.com.
    if let Some(kind) = pinned.filter(|k| decided != Some((*k, ForgeBy::Table))) {
        return Forge { kind, host, path, by: ForgeBy::Pin, api };
    }
    let (kind, by) = decided.unwrap_or((ForgeKind::Unknown, ForgeBy::None));
    Forge { kind, host, path, by, api }
}

pub(crate) fn forge_of(url: Option<&str>, pin: Option<&str>) -> Forge {
    forge_with(url, pin, ssh_hostname)
}

// ---------- GitLab through `glab` ----------

const GLAB_SECS: u64 = 60;

/// glab sends any of these to whatever `--hostname` names, ahead of the login it keeps for that
/// host, and the host comes from a cloned repository's remote or its committed pin.
const GLAB_ENV_TOKENS: &[&str] =
    &["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GLAB_IS_OAUTH2", "CI_JOB_TOKEN", "GITLAB_CI", "GLAB_ENABLE_CI_AUTOLOGIN"];

fn glab_cmd(root: &str, args: &[&str]) -> std::process::Command {
    let mut cmd = sys_command("glab");
    cmd.env("PATH", augmented_path())
        .current_dir(root)
        .args(args)
        .env("GLAB_NO_PROMPT", "1") // no terminal here: never prompt or open a browser
        .env("GLAB_CHECK_UPDATE", "false")
        .env("NO_COLOR", "1");
    for name in GLAB_ENV_TOKENS {
        cmd.env_remove(name);
    }
    cmd
}

/// One `glab` call. Its credential is glab's own login for the host the caller names with
/// `--hostname`, never an env token; a GraphQL answer that carries `data` is kept beside its `errors[]`.
pub(crate) fn glab(root: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::deps::run_capped(glab_cmd(root, args), GLAB_SECS).map_err(|e| {
        if e.starts_with("no answer") { format!("glab gave no answer after {GLAB_SECS}s") } else { format!("glab not available: {e}") }
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() || crate::github::graphql_answered(&stdout) {
        return Ok(stdout);
    }
    let said = |s: &str| s.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string);
    Err(said(&String::from_utf8_lossy(&out.stderr)).or_else(|| said(&stdout)).unwrap_or_else(|| "glab failed".into()))
}

/// A `glab` failure as a coverage, each fix naming the host glab must be signed in to:
/// missing or signed out is `noTool`, an account that cannot see the project is `noAccess`.
pub(crate) fn classify_glab(err: &str, host: &str) -> Coverage {
    let e = err.to_lowercase();
    let login = Some(format!("glab auth login --hostname {host}"));
    if e.contains("glab not available") {
        return Coverage::NoTool { tool: "glab".into(), fix: Some("install the GitLab CLI from https://gitlab.com/gitlab-org/cli".into()) };
    }
    if e.contains("rate limit") || e.contains("http 429") || e.contains("429 too many") {
        return Coverage::Error { reason: err.to_string() };
    }
    if e.contains("401") || e.contains("unauthorized") || e.contains("invalid_token") || e.contains("glab auth login") {
        return Coverage::NoTool { tool: "glab".into(), fix: login };
    }
    // GitLab answers a project an account may not see exactly like one that does not exist.
    if e.contains("404") || e.contains("project not found") {
        let reason = format!("the account glab uses on {host} cannot see this project");
        return Coverage::NoAccess { reason, fix: login };
    }
    if e.contains("403") || e.contains("forbidden") || e.contains("insufficient_scope") {
        return Coverage::NoAccess { reason: err.to_string(), fix: login };
    }
    Coverage::Error { reason: err.to_string() }
}

/// Percent-encodes everything but RFC 3986's unreserved characters: a project path is one
/// segment of a GitLab URL (`group%2Fsub%2Frepo`), and a branch is one query value.
pub(crate) fn pct(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
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
        assert_eq!(f.api_host(), Some("github.com"), "an API is asked at the real host");
        assert_eq!(of("https://gitlab.acme.io/x/y").api_host(), Some("gitlab.acme.io"));
        let elsewhere = |a: &str| Some(if a == "gitlab-work" { "gitlab.acme.io" } else { "10.1.2.3" }.to_string());
        assert_eq!(forge_with(Some("git@gitlab-work:g/r.git"), None, elsewhere).api_host(), Some("gitlab.acme.io"), "a bare alias");
        let f = forge_with(Some("git@gitlab.acme.io:g/r.git"), None, elsewhere);
        assert_eq!((f.kind, f.api_host()), (ForgeKind::Gitlab, Some("gitlab.acme.io")), "ssh routed to an IP keeps the web host");
        let ported = |u: &str| of(u).api_host().map(str::to_string);
        assert_eq!(ported("https://u:p@gitlab.acme.io:8443/g/r.git").as_deref(), Some("gitlab.acme.io:8443"), "glab keys a login by its port");
        assert_eq!(ported("https://gitlab.acme.io:443/g/r.git").as_deref(), Some("gitlab.acme.io"), "the scheme's own port is no port");
        assert_eq!(ported("ssh://git@gitlab.acme.io:2222/g/r.git").as_deref(), Some("gitlab.acme.io"), "an ssh port is not the web's");
        let pinned = forge_with(Some("git@github.com-work:acme/app.git"), Some("github"), resolve);
        assert_eq!((pinned.kind, pinned.by), (ForgeKind::Github, ForgeBy::Table), "a pin the alias confirms is the table's");
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

    #[test]
    fn glab_never_inherits_an_env_token() {
        let cmd = glab_cmd(".", &["api", "--hostname", "git.example.dev", "user"]);
        let removed: Vec<_> = cmd.get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().to_string()).collect();
        for name in GLAB_ENV_TOKENS {
            assert!(removed.iter().any(|r| r.eq_ignore_ascii_case(name)), "{name} reaches glab");
        }
    }

    #[test]
    fn glab_failures_carry_a_fix_for_their_host() {
        let login = Some("glab auth login --hostname gitlab.acme.io".to_string());
        let tool = |fix: Option<String>| Coverage::NoTool { tool: "glab".into(), fix };
        let install = Some("install the GitLab CLI from https://gitlab.com/gitlab-org/cli".to_string());
        let unseen = "the account glab uses on gitlab.acme.io cannot see this project".to_string();
        let table: [(&str, Coverage); 9] = [
            ("glab not available: program not found", tool(install)),
            ("glab: 401 Unauthorized (HTTP 401)", tool(login.clone())),
            ("glab: invalid_token: Token is expired. You can either do re-authorization or token refresh.", tool(login.clone())),
            ("none of the git remotes configured for this repository points to a known GitLab host. Please use `glab auth login` to authenticate", tool(login.clone())),
            ("glab: 404 Project Not Found (HTTP 404)", Coverage::NoAccess { reason: unseen, fix: login.clone() }),
            ("glab: insufficient_scope (HTTP 403)", Coverage::NoAccess { reason: "glab: insufficient_scope (HTTP 403)".into(), fix: login.clone() }),
            ("glab: 403 Forbidden (HTTP 403)", Coverage::NoAccess { reason: "glab: 403 Forbidden (HTTP 403)".into(), fix: login }),
            ("glab: 429 Too Many Requests (HTTP 429)", Coverage::Error { reason: "glab: 429 Too Many Requests (HTTP 429)".into() }),
            ("glab: 502 Bad Gateway (HTTP 502)", Coverage::Error { reason: "glab: 502 Bad Gateway (HTTP 502)".into() }),
        ];
        for (err, want) in table {
            assert_eq!(classify_glab(err, "gitlab.acme.io"), want, "{err}");
        }
    }

    #[test]
    fn a_path_and_a_branch_are_one_url_part_each() {
        assert_eq!(pct("group/sub/repo"), "group%2Fsub%2Frepo");
        assert_eq!(pct("feat/ä b&c=d"), "feat%2F%C3%A4%20b%26c%3Dd");
        assert_eq!(pct("v1.2_x-y~z"), "v1.2_x-y~z");
    }
}
