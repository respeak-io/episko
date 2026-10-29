//! Claude subscriptions a pane can launch on (docs/accounts.md): `claude setup-token` tokens,
//! sealed per OS and handed to one process as `CLAUDE_CODE_OAUTH_TOKEN`. Which account a launch
//! takes is ./accounts.ts's to decide; nothing here returns a token to the webview.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

use crate::platform::{augmented_path, drop_secret, open_secret, resolve_claude, seal_secret, sealed_accounts, sys_command, SecretSlot};

/// The keychain service, so an item made by hand with `security add-generic-password` is found.
const SERVICE: &str = "episko-claude-token";
const EXT: &str = ".token";
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
const TOKEN_PREFIX: &str = "sk-ant-oat01-";

fn token_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default().join("accounts")
}

/// A label is a keychain account and a file name, so it stays plain.
pub(crate) fn valid_label(l: &str) -> bool {
    !l.is_empty() && l.len() <= 40 && l.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn slot<'a>(dir: &'a std::path::Path, file: &'a str, label: &'a str) -> SecretSlot<'a> {
    SecretSlot { dir, file, service: SERVICE, account: label }
}

/// `setup-token` prints the token across two lines, and a copy of one line still starts right.
fn token_shape(t: &str) -> Result<(), String> {
    if !t.starts_with(TOKEN_PREFIX) {
        return Err(format!("That isn't a setup token: those start with {TOKEN_PREFIX}"));
    }
    if !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("The token has characters in it a token never has. Paste it again, without spaces or line breaks.".into());
    }
    if t.len() < 100 {
        return Err(format!("This token is {} characters, and a whole one is about 108. It was probably cut where the terminal wrapped it.", t.len()));
    }
    Ok(())
}

/// The token behind a label, for `spawn_claude` only.
pub(crate) fn token_for<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<String, String> {
    if !valid_label(label) { return Err(format!("not an account label: {label}")); }
    let dir = token_dir(app);
    let file = format!("{label}{EXT}");
    open_secret(&slot(&dir, &file, label)).ok_or_else(|| format!("no token stored for the account {label}"))
}

/// The labels with a token stored, including items added by hand under the same service.
#[tauri::command]
pub(crate) fn claude_tokens(app: AppHandle) -> Vec<String> {
    sealed_accounts(&token_dir(&app), EXT, SERVICE).into_iter().filter(|l| valid_label(l)).collect()
}

#[tauri::command]
pub(crate) fn claude_token_save(app: AppHandle, label: String, token: String) -> Result<(), String> {
    if !valid_label(&label) { return Err("A name may use letters, digits, dots, dashes and underscores.".into()); }
    let token = token.trim();
    token_shape(token)?;
    let dir = token_dir(&app);
    seal_secret(&slot(&dir, &format!("{label}{EXT}"), &label), token)
}

#[tauri::command]
pub(crate) fn claude_token_forget(app: AppHandle, label: String) -> Result<(), String> {
    if !valid_label(&label) { return Err(format!("not an account label: {label}")); }
    let dir = token_dir(&app);
    drop_secret(&slot(&dir, &format!("{label}{EXT}"), &label));
    Ok(())
}

/// One check: did the token work, and the two windows the answer carried (percent, epoch s).
#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenCheck {
    ok: bool,
    error: Option<String>,
    h5: Option<f64>,
    h5_reset: Option<i64>,
    d7: Option<f64>,
    d7_reset: Option<i64>,
}

/// One Haiku turn of a few words, unpersisted: the cheapest call that both proves the token
/// and brings back a `rate_limit_event` (the usage probe answers nothing for a setup token).
#[tauri::command(async)]
pub(crate) fn claude_token_check(app: AppHandle, label: String) -> Result<TokenCheck, String> {
    let token = token_for(&app, &label)?;
    let cwd = crate::summarize::scratch_cwd();
    let _ = std::fs::create_dir_all(&cwd);
    let mut child = sys_command(resolve_claude())
        .env("PATH", augmented_path())
        .env("CLAUDE_CODE_OAUTH_TOKEN", token)
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .current_dir(cwd)
        .args([
            "-p", "--model", "haiku", "--output-format", "stream-json", "--verbose",
            "--no-session-persistence", "--settings", r#"{"disableAllHooks":true}"#, "Reply with ok",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start claude: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let lines: Vec<String> = BufReader::new(stdout).lines().map_while(Result::ok).collect();
        let _ = tx.send(lines);
    });
    let lines = rx.recv_timeout(CHECK_TIMEOUT);
    let _ = child.kill();
    let _ = child.wait();
    let lines = lines.map_err(|_| "claude did not answer within a minute".to_string())?;
    Ok(parse_check(&lines))
}

fn parse_check(lines: &[String]) -> TokenCheck {
    let mut c = TokenCheck::default();
    let mut answered = false;
    for v in lines.iter().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()) {
        match v["type"].as_str() {
            Some("rate_limit_event") => {
                let w = &v["rate_limit_info"]["unifiedWindows"];
                let pct = |k: &str| w[k]["utilization"].as_f64().map(|u| (u * 1000.0).round() / 10.0);
                let reset = |k: &str| w[k]["resetsAt"].as_i64();
                c.h5 = pct("five_hour").or(c.h5);
                c.h5_reset = reset("five_hour").or(c.h5_reset);
                c.d7 = pct("seven_day").or(c.d7);
                c.d7_reset = reset("seven_day").or(c.d7_reset);
            }
            Some("result") => {
                answered = true;
                c.ok = v["is_error"].as_bool() == Some(false);
                if !c.ok {
                    c.error = Some(v["result"].as_str().unwrap_or("the check failed").to_string());
                }
            }
            _ => {}
        }
    }
    if !answered {
        c.error = Some("claude ended without an answer".into());
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_is_plain_and_a_token_cut_at_the_wrap_is_refused() {
        assert!(valid_label("max20") && valid_label("work.max-5_b"));
        assert!(!valid_label("") && !valid_label("max 20") && !valid_label("a\"b") && !valid_label(&"x".repeat(41)));
        let whole = format!("{TOKEN_PREFIX}{}", "A".repeat(95));
        assert!(token_shape(&whole).is_ok());
        assert!(token_shape(&whole[..72]).unwrap_err().contains("72 characters"));
        assert!(token_shape("sk-ant-api03-xyz").is_err(), "an API key is not a setup token");
        assert!(token_shape(&format!("{} {}", &whole[..60], &whole[60..])).is_err());
    }

    #[test]
    fn a_check_reads_both_windows_and_a_refusal_carries_its_reason() {
        let ok = [
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.18,"resetsAt":1793275200},"seven_day":{"utilization":0.13,"resetsAt":1793732400}}}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"ok"}"#,
        ].map(String::from);
        let c = parse_check(&ok);
        assert!(c.ok && c.error.is_none());
        assert_eq!((c.h5, c.h5_reset, c.d7, c.d7_reset), (Some(18.0), Some(1793275200), Some(13.0), Some(1793732400)));

        let bad = [r#"{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate. API Error: 401 OAuth access token is invalid."}"#].map(String::from);
        let c = parse_check(&bad);
        assert!(!c.ok && c.error.unwrap().contains("401"));
        assert!(parse_check(&[]).error.is_some(), "silence is not a pass");
    }
}
