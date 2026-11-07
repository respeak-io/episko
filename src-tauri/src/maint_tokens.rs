//! Tokens Maintenance reads a service with (docs/maintenance.md, docs/accounts.md): one per kind and host,
//! sealed through platform's secret store. No command returns one; only `SysExec` opens a token, for its slot.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::maint::{Cost, Exec, SysExec};
use crate::platform::{drop_secret, open_secret, seal_secret, sealed_accounts, SecretSlot};

/// A kind of token: the keychain service its items live under, the slot a host's token is saved in,
/// and the one cheap read that says whether it works.
pub(crate) struct Kind {
    pub(crate) id: &'static str,
    service: &'static str,
    slot: fn(&str) -> String,
    check: fn(&str, &[String], &dyn Exec) -> TokenCheck,
}

/// Every kind the manifest's `token` may name (`Manifest::check` holds it); bearer only until one needs more.
pub(crate) static KINDS: &[Kind] = &[
    Kind { id: "sentry", service: "episko-sentry-token", slot: crate::maint_err::slot_of, check: crate::maint_err::sentry_check },
];

const EXT: &str = ".token";
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// `maint_read` has no `AppHandle`, so setup names the folder once.
pub(crate) fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

fn base() -> Option<&'static Path> {
    DIR.get().map(PathBuf::as_path)
}

/// A slot: a lower-case host and an optional port, so it is a keychain account and, `:` as `_`, a file name.
pub(crate) fn valid_host(h: &str) -> bool {
    let (name, port) = h.split_once(':').map_or((h, None), |(n, p)| (n, Some(p)));
    let label = |l: &str| !l.is_empty() && !l.starts_with('-') && !l.ends_with('-')
        && l.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    name.len() <= 253 && name.split('.').all(label)
        && port.is_none_or(|p| p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()) && p.parse::<u16>().is_ok_and(|n| n > 0))
}

/// What a person may paste: printable, no space or quote, so the keychain arm can type it.
fn token_shape(t: &str) -> Result<(), String> {
    if !t.chars().all(|c| c.is_ascii_alphanumeric() || "_=+/.-".contains(c)) {
        return Err("The token has characters in it a token never has. Paste it again, without spaces or line breaks.".into());
    }
    if !(20..=512).contains(&t.len()) {
        return Err(format!("A token is 20 to 512 characters, and this is {}. Paste it again whole.", t.len()));
    }
    Ok(())
}

fn kind_of(id: &str) -> Result<&'static Kind, String> {
    KINDS.iter().find(|k| k.id == id).ok_or_else(|| format!("{id} is not a token kind Episko keeps"))
}

/// A pasted address as a slot: no scheme, path or trailing dot, and the kind's own family folded in.
fn slot_for(k: &Kind, host: &str) -> Result<String, String> {
    let h = host.trim().to_ascii_lowercase();
    let h = h.strip_prefix("https://").or_else(|| h.strip_prefix("http://")).unwrap_or(&h);
    let h = h.split('/').next().unwrap_or_default().trim_end_matches('.');
    let (name, port) = h.split_once(':').map_or((h, None), |(n, p)| (n, Some(p)));
    let slot = format!("{}{}", (k.slot)(name), port.filter(|p| *p != "443").map(|p| format!(":{p}")).unwrap_or_default());
    if valid_host(&slot) { Ok(slot) } else { Err(format!("{host:?} is not a host name")) }
}

fn file_of(host: &str) -> String {
    format!("{}{EXT}", host.replace(':', "_"))
}

fn with_slot<T>(base: &Path, k: &Kind, host: &str, f: impl FnOnce(&SecretSlot) -> T) -> T {
    let (dir, file) = (base.join(k.id), file_of(host));
    f(&SecretSlot { dir: &dir, file: &file, service: k.service, account: host })
}

fn save_in(base: &Path, k: &Kind, host: &str, token: &str) -> Result<(), String> {
    token_shape(token)?;
    with_slot(base, k, host, |s| seal_secret(s, token))
}

fn open_in(base: &Path, k: &Kind, host: &str) -> Option<String> {
    valid_host(host).then(|| with_slot(base, k, host, open_secret)).flatten()
}

fn forget_in(base: &Path, k: &Kind, host: &str) {
    with_slot(base, k, host, drop_secret);
}

fn list_in(base: &Path) -> Vec<StoredToken> {
    KINDS.iter().flat_map(|k| {
        sealed_accounts(&base.join(k.id), EXT, k.service).into_iter()
            .map(|a| a.replace('_', ":")).filter(|h| valid_host(h))
            .map(|host| StoredToken { kind: k.id.into(), host })
    }).collect()
}

/// Whether a token of `kind` is saved for `host`, for `Exec::has_auth`.
pub(crate) fn has(kind: &str, host: &str) -> bool {
    open(kind, host).is_some()
}

/// The token itself, for `SysExec` alone, which checks where it goes first (`exec::sealed_ok`).
pub(crate) fn open(kind: &str, host: &str) -> Option<String> {
    open_in(base()?, kind_of(kind).ok()?, host)
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredToken {
    kind: String,
    host: String,
}

/// One check: whether the host knows the token, as whom, and which needed scopes it lacks.
#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenCheck {
    pub(crate) ok: bool,
    pub(crate) who: Option<String>,
    pub(crate) scopes: Vec<String>,
    pub(crate) missing: Vec<String>,
    pub(crate) error: Option<String>,
}

fn dir() -> Result<&'static Path, String> {
    base().ok_or_else(|| "the token folder is not set up".into())
}

/// Every saved token's kind and host, never its value.
#[tauri::command(async)]
pub(crate) fn maint_tokens() -> Vec<StoredToken> {
    base().map(list_in).unwrap_or_default()
}

/// Seals `token` for `host`, which a read then sends only to that host or a subdomain of it, over https.
/// Answers the slot it was saved under, which may fold the host typed (`de.sentry.io` is `sentry.io`).
#[tauri::command(async)]
pub(crate) fn maint_token_save(kind: String, host: String, token: String) -> Result<String, String> {
    let k = kind_of(&kind)?;
    let slot = slot_for(k, &host)?;
    save_in(dir()?, k, &slot, token.trim())?;
    crate::maint::forget_token_reads(&kind);
    Ok(slot)
}

#[tauri::command(async)]
pub(crate) fn maint_token_forget(kind: String, host: String) -> Result<(), String> {
    let k = kind_of(&kind)?;
    forget_in(dir()?, k, &slot_for(k, &host)?);
    crate::maint::forget_token_reads(&kind);
    Ok(())
}

/// One cheap authenticated read of the host's own API root: no project or issue is asked about.
#[tauri::command(async)]
pub(crate) fn maint_token_check(kind: String, host: String) -> Result<TokenCheck, String> {
    let k = kind_of(&kind)?;
    let need = crate::maint::token_kind(&kind).map(|t| t.scopes.as_slice()).unwrap_or_default();
    Ok((k.check)(&slot_for(k, &host)?, need, &SysExec { cost: Cost::Remote }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentry() -> &'static Kind {
        kind_of("sentry").unwrap()
    }

    #[test]
    fn hosts_and_tokens_are_plain() {
        for ok in ["sentry.io", "sentry.acme.com", "sentry.acme.com:8443", "10.0.0.5", "localhost:9000"] {
            assert!(valid_host(ok), "{ok}");
        }
        for bad in ["", "Sentry.io", "a_b.com", "a b.com", "a\"b", "a\nb", "a..b", ".a.com", "a.com.", "-a.com", "a.com:", "a.com:0", "a.com:99999", "a.com:8a", "https://a.com"] {
            assert!(!valid_host(bad), "{bad:?}");
        }
        assert!(token_shape(&format!("sntryu_{}", "a1".repeat(32))).is_ok());
        assert!(token_shape("short").unwrap_err().contains("20 to 512"));
        for bad in ["sntryu_abc def ghi jkl mno", "sntryu_abc\"defghijklmnopqr", "sntryu_abc\ndefghijklmnopqr"] {
            assert!(token_shape(bad).unwrap_err().contains("characters"), "{bad:?}");
        }
    }

    #[test]
    fn a_pasted_address_is_its_slot() {
        let s = |h: &str| slot_for(sentry(), h);
        assert_eq!(s("https://sentry.io/").unwrap(), "sentry.io");
        assert_eq!(s("de.sentry.io").unwrap(), "sentry.io", "a region shares the hosted service's slot");
        assert_eq!(s("acme.sentry.io").unwrap(), "sentry.io");
        assert_eq!(s(" Sentry.Acme.com:8443/x ").unwrap(), "sentry.acme.com:8443");
        assert_eq!(s("sentry.acme.com:443").unwrap(), "sentry.acme.com", "the default port is no port");
        assert!(s("a_b.example").is_err() && s("").is_err());
        assert!(kind_of("jira").is_err(), "no kind beyond the ones built");
    }

    #[test]
    fn a_port_round_trips_through_the_file_name() {
        assert_eq!(file_of("sentry.acme.com:8443"), "sentry.acme.com_8443.token");
        assert_eq!(file_of("sentry.io"), "sentry.io.token");
    }

    // Not on macOS: that arm writes the login keychain, which a test must never touch (sync.rs's rule).
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn seal_open_forget_round_trip() {
        let base = crate::testutil::scratch_dir();
        let token = format!("sntryu_{}", "b2".repeat(32));
        save_in(&base, sentry(), "sentry.acme.com:8443", &token).unwrap();
        let file = base.join("sentry").join("sentry.acme.com_8443.token");
        #[cfg(windows)]
        assert_ne!(std::fs::read(&file).unwrap(), token.as_bytes(), "sealed, not plain");
        assert!(file.is_file());
        assert_eq!(open_in(&base, sentry(), "sentry.acme.com:8443").as_deref(), Some(token.as_str()));
        assert_eq!(open_in(&base, sentry(), "sentry.io"), None, "another host's slot is another token");
        assert_eq!(list_in(&base), [StoredToken { kind: "sentry".into(), host: "sentry.acme.com:8443".into() }]);
        assert!(save_in(&base, sentry(), "sentry.io", "short").is_err(), "a refused shape writes nothing");
        assert_eq!(list_in(&base).len(), 1);
        forget_in(&base, sentry(), "sentry.acme.com:8443");
        assert_eq!(open_in(&base, sentry(), "sentry.acme.com:8443"), None);
        assert!(list_in(&base).is_empty());
    }
}
