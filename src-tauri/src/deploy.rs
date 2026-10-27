//! `[deploy]` in `.episko/episko.toml`: where a project runs (docs/maintenance.md). Read
//! forgivingly, proposed by the headless read-only agent `[stack]` uses, written only after Apply.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::maint::exec::HttpReq;
use crate::maint::{Coverage, Ctx, Exec, Facts, Probe, Read};
use crate::platform::{augmented_path, resolve_claude, sys_command};

/// Committed, and never a secret: `host` is an ssh alias and `sentry` an `org/project`, each
/// used only on a click. `urls` is name → address.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct DeployConfig {
    host: Option<String>,
    compose: Vec<String>,
    urls: BTreeMap<String, String>,
    sentry: Option<String>,
    version_url: Option<String>,
}

impl DeployConfig {
    fn is_empty(&self) -> bool {
        self.host.is_none() && self.compose.is_empty() && self.urls.is_empty() && self.sentry.is_none() && self.version_url.is_none()
    }

    /// Every address `http-probe` asks, name → URL: `urls`, then `version_url` as `version`
    /// unless one of them already is it.
    pub(crate) fn targets(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self.urls.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        if let Some(v) = self.version_url.as_ref().filter(|v| !out.iter().any(|(_, u)| u == *v)) {
            let name = if out.iter().any(|(n, _)| n == "version") { "version_url" } else { "version" };
            out.push((name.into(), v.clone()));
        }
        out
    }
}

fn path_of(dir: &str) -> PathBuf {
    Path::new(dir).join(".episko").join("episko.toml")
}

// The file detection reads: a subfolder or a worktree of a repo answers with its main checkout's.
fn file_of(dir: &str) -> PathBuf {
    path_of(&crate::maint::root_key(dir))
}

fn is_http(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    let rest = l.strip_prefix("https://").or_else(|| l.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty()) && !u.contains(char::is_whitespace)
}

fn org_project(s: &str) -> bool {
    let part = |p: &str| p.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && p.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    s.split_once('/').is_some_and(|(o, p)| part(o) && part(p))
}

fn safe_word(v: &str) -> bool {
    crate::maint::data_arg(v).is_ok()
}

// A bare list of addresses still reads: each is named by what follows its scheme.
fn url_name(u: &str) -> String {
    u.split_once("://").map_or(u, |(_, r)| r).trim_end_matches('/').to_string()
}

/// Value by value, so one wrong type drops that value and not the table; `compose = "api"` is one service.
fn from_table(t: &toml::Table) -> DeployConfig {
    let word = |k: &str| t.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let trimmed = |v: &toml::Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let compose = match t.get("compose") {
        Some(toml::Value::Array(a)) => a.iter().filter_map(trimmed).collect(),
        Some(v) => trimmed(v).into_iter().collect(),
        None => vec![],
    };
    let urls = match t.get("urls") {
        Some(toml::Value::Table(m)) => m.iter().filter_map(|(k, v)| trimmed(v).map(|u| (k.trim().to_string(), u))).collect(),
        Some(toml::Value::Array(a)) => a.iter().filter_map(trimmed).map(|u| (url_name(&u), u)).collect(),
        _ => BTreeMap::new(),
    };
    DeployConfig { host: word("host"), compose, urls, sentry: word("sentry"), version_url: word("version_url") }
}

/// The values safe to keep, and one line per value that is not; deploy.ts's `checkDeploy` says the same.
fn keep(d: DeployConfig) -> (DeployConfig, Vec<String>) {
    let mut out = vec![];
    let mut said = |ok: bool, line: String| {
        if !ok {
            out.push(line);
        }
        ok
    };
    let host = d.host.filter(|h| said(safe_word(h), format!("host = \"{h}\" is not an ssh alias or host name")));
    let compose = d.compose.into_iter().filter(|c| said(safe_word(c), format!("compose service \"{c}\" is not a name"))).collect();
    let urls = d.urls.into_iter().filter(|(n, u)| said(!n.is_empty() && is_http(u), format!("url {n} = \"{u}\" is not an http(s) address"))).collect();
    let sentry = d.sentry.filter(|s| said(org_project(s), format!("sentry = \"{s}\" is not org/project")));
    let version_url = d.version_url.filter(|u| said(is_http(u), format!("version_url = \"{u}\" is not an http(s) address")));
    (DeployConfig { host, compose, urls, sentry, version_url }, out)
}

fn raw_deploy(text: &str) -> Option<DeployConfig> {
    text.parse::<toml::Table>().ok()?.get("deploy")?.as_table().map(from_table)
}

/// What a reader may use: unsafe values dropped, and no table (or an empty one) is `None`.
pub(crate) fn parse_deploy(text: &str) -> Option<DeployConfig> {
    raw_deploy(text).map(|d| keep(d).0).filter(|d| !d.is_empty())
}

pub(crate) fn read(dir: &str) -> Option<DeployConfig> {
    std::fs::read_to_string(file_of(dir)).ok().and_then(|t| parse_deploy(&t))
}

#[tauri::command]
pub(crate) fn deploy_config(dir: String) -> DeployConfig {
    read(&dir).unwrap_or_default()
}

// ---------- http-probe: remote, so a click only (maint.rs's gate) ----------

const PROBE_SECS: u64 = 10;
const PROBE_CAP: usize = 12;

/// What one curl report says, before it is named.
#[derive(Debug, PartialEq)]
struct CurlReport {
    code: Option<u16>,
    ms: Option<u32>,
    err: Option<String>,
    cert_not_after: Option<u64>,
}

/// Seconds since the epoch for a certificate date in either spelling curl's backends print:
/// OpenSSL's `Nov  9 23:59:59 2026 GMT` and x509asn1's (Schannel, GnuTLS) `2026-11-09 23:59:59 GMT`.
fn cert_date(s: &str) -> Option<u64> {
    let w: Vec<&str> = s.split_whitespace().collect();
    let month = |m: &str| ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        .iter().position(|x| m.eq_ignore_ascii_case(x)).map(|i| i as i64 + 1);
    let (y, m, d, time, zone): (i64, i64, i64, &str, &[&str]) = match w.as_slice() {
        [mon, d, t, y, z @ ..] if month(mon).is_some() => (y.parse().ok()?, month(mon)?, d.parse().ok()?, *t, z),
        [date, t, z @ ..] => {
            let mut p = date.split('-').map(|x| x.parse::<i64>().ok());
            (p.next()??, p.next()??, p.next()??, *t, z)
        }
        _ => return None,
    };
    if !matches!(zone, [] | ["GMT"] | ["UTC"] | ["Z"]) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let mut hms = time.split('.').next()?.split(':').map(|x| x.parse::<i64>().ok());
    let (h, mi, sec) = (hms.next()??, hms.next()??, hms.next().unwrap_or(Some(0))?);
    if !(0..24).contains(&h) || !(0..60).contains(&mi) || !(0..=60).contains(&sec) {
        return None;
    }
    let secs = crate::usage::days_from_civil(y, m, d) * 86_400 + h * 3600 + mi * 60 + sec;
    u64::try_from(secs).ok()
}

/// The leaf's expiry: the first certificate's `Expire date` (OpenSSL) or `Expire Date`
/// (x509asn1). Only the leaf: a server may still send a cross-signed root that expired years ago.
fn leaf_expiry(certs: &str) -> Option<u64> {
    let mut subjects = 0;
    for line in certs.lines() {
        let (k, v) = line.split_once(':').unwrap_or((line, ""));
        if k.trim().eq_ignore_ascii_case("subject") {
            subjects += 1;
            if subjects > 1 {
                return None;
            }
        } else if k.trim().eq_ignore_ascii_case("expire date") {
            return cert_date(v);
        }
    }
    None
}

/// `-w '%{json}\n%{certs}'`'s output. A failed transfer is still a report (`exitcode`,
/// `errormsg`); what is not a report at all is an error, never a probe that looks down.
fn parse_report(out: &str) -> Result<CurlReport, String> {
    let text = out.trim_start();
    let mut it = serde_json::Deserializer::from_str(text).into_iter::<serde_json::Value>();
    let v = match it.next() {
        Some(Ok(v)) if v.get("http_code").is_some() || v.get("response_code").is_some() => v,
        _ => return Err("curl printed no report".into()),
    };
    let rest = &text[it.byte_offset()..];
    let code = ["response_code", "http_code"].iter().find_map(|k| v[*k].as_u64()).filter(|c| (100..1000).contains(c));
    let exit = v["exitcode"].as_i64().unwrap_or(0);
    let said = v["errormsg"].as_str().map(str::trim).filter(|m| !m.is_empty()).map(String::from);
    let err = said.or_else(|| (exit != 0).then(|| format!("curl exited {exit}")));
    // An older curl's json has no `certs`; the raw `%{certs}` after it is the same chain.
    let certs = v["certs"].as_str().filter(|c| !c.is_empty()).unwrap_or(rest);
    Ok(CurlReport {
        code: code.map(|c| c as u16),
        ms: v["time_total"].as_f64().map(|t| (t * 1000.0).round() as u32),
        err,
        cert_not_after: leaf_expiry(certs),
    })
}

/// `[deploy] urls` and `version_url`, each asked once, side by side. An address that does not
/// answer is a probe that says so; one curl gave no report for is a gap, and all of them the read's failure.
pub(crate) fn http_probe(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    let targets = read(ctx.root).map(|d| d.targets()).unwrap_or_default();
    if targets.is_empty() {
        return Err(Coverage::Unsupported { reason: "no address in [deploy]".into() });
    }
    let truncated = targets.len() > PROBE_CAP;
    let asked = &targets[..targets.len().min(PROBE_CAP)];
    let answers: Vec<Result<CurlReport, String>> = std::thread::scope(|s| {
        let jobs: Vec<_> = asked.iter().map(|(_, url)| s.spawn(move || {
            let req = HttpReq { url: url.clone(), body: None, token: None, secs: PROBE_SECS, report: true };
            ex.http(&req).and_then(|r| parse_report(&r.body))
        })).collect();
        jobs.into_iter().map(|j| j.join().unwrap_or_else(|_| Err("the probe panicked".into()))).collect()
    });
    let (mut items, mut gaps) = (vec![], vec![]);
    for ((name, url), a) in asked.iter().zip(answers) {
        match a {
            Ok(r) => items.push(Probe { name: name.clone(), url: url.clone(), code: r.code, ms: r.ms, cert_not_after: r.cert_not_after, err: r.err }),
            Err(e) => gaps.push(format!("{name}: {e}")),
        }
    }
    if items.is_empty() {
        return Err(Coverage::Error { reason: gaps.join("; ") });
    }
    if truncated {
        gaps.push(format!("only the first {PROBE_CAP} addresses are asked"));
    }
    Ok(Read { facts: Facts::Probes { items }, truncated, gaps })
}

// ---------- the proposal ----------

const PROPOSE_SECS: u64 = 300;

/// Ask a headless Claude to read the project, the way the day summary asks for a sentence: `-p`,
/// no PTY, no session. `--restricted` plus `--tools Read,Glob,Grep` means it can look and nothing
/// else: no shell, no edits, no web, no MCP, none of the user's settings (docs/stack.md).
pub(crate) fn propose_toml(dir: &str, prompt: &str) -> Result<String, String> {
    let mut cmd = sys_command(resolve_claude());
    cmd.env("PATH", augmented_path()).current_dir(dir).args([
        "-p", prompt, "--model", "sonnet", "--restricted", "--tools", "Read,Glob,Grep",
        "--strict-mcp-config", "--no-session-persistence",
    ]);
    let o = crate::deps::run_capped(cmd, PROPOSE_SECS)
        .map_err(|e| if e.starts_with("no answer") { format!("no proposal after {PROPOSE_SECS}s") } else { format!("could not start claude: {e}") })?;
    if !o.status.success() {
        return Err(format!("claude exited {}: {}", o.status, String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&o.stdout).to_string())
}

/// The answer's fenced `toml` block, and the `- ` lines after a `WHY` line; anything around them
/// is ignored. No block is a failure the dialog reports.
pub(crate) fn fenced(out: &str) -> Result<(String, Vec<String>), String> {
    let start = out.find("```toml").ok_or("the agent answered without a proposal")? + "```toml".len();
    let len = out[start..].find("```").ok_or("the agent's proposal was cut off")?;
    let why = out[start + len + 3..]
        .lines()
        .skip_while(|l| l.trim() != "WHY")
        .filter_map(|l| l.trim().strip_prefix("- ").map(str::to_string))
        .collect();
    Ok((out[start..start + len].to_string(), why))
}

/// Unchecked, so the dialog can say what it left out and why.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct DeployProposal {
    deploy: DeployConfig,
    why: Vec<String>,
}

fn parse_deploy_proposal(out: &str) -> Result<DeployProposal, String> {
    let (block, why) = fenced(out)?;
    let t = block.parse::<toml::Table>().map_err(|e| format!("the proposal is not valid TOML: {e}"))?;
    let deploy = t.get("deploy").and_then(|v| v.as_table()).map(from_table).unwrap_or_default();
    Ok(DeployProposal { deploy, why })
}

#[tauri::command]
pub(crate) async fn propose_deploy(dir: String, prompt: String) -> Result<DeployProposal, String> {
    tauri::async_runtime::spawn_blocking(move || parse_deploy_proposal(&propose_toml(&dir, &prompt)?))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- the write ----------

/// `write_deploy`'s refusal when the file is missing and `create` is false; deploy.ts matches it.
pub(crate) const NO_FILE: &str = "no .episko/episko.toml here yet";

/// Only what changed is replaced, so a hand-written value and its comment survive an Apply. `raw` is
/// the table as written: what `keep` drops was never shown, so no proposal can mean to remove it.
fn set_deploy(doc: &mut toml_edit::DocumentMut, raw: &DeployConfig, d: &DeployConfig) -> Result<(), String> {
    let old = &keep(raw.clone()).0;
    if doc.get("deploy").is_some_and(|i| !i.is_table_like()) {
        return Err("deploy in .episko/episko.toml is not a table".into());
    }
    if doc.get("deploy").is_none() {
        if d.is_empty() {
            return Ok(());
        }
        doc["deploy"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let t = doc["deploy"].as_table_like_mut().ok_or("deploy is not a table")?;
    let mut put = |k: &str, same: bool, v: Option<toml_edit::Item>| match v {
        _ if same => {}
        None => {
            t.remove(k);
        }
        Some(i) => {
            t.insert(k, i);
        }
    };
    let word = |v: &Option<String>| v.as_deref().map(toml_edit::value);
    put("host", old.host == d.host, word(&d.host));
    let mut compose = d.compose.clone();
    compose.extend(raw.compose.iter().filter(|c| !old.compose.contains(c) && !d.compose.contains(c)).cloned());
    let list = (!compose.is_empty()).then(|| toml_edit::value(compose.iter().map(String::as_str).collect::<toml_edit::Array>()));
    put("compose", old.compose == d.compose, list);
    let mut urls = d.urls.clone();
    for (k, v) in raw.urls.iter().filter(|(k, _)| !old.urls.contains_key(*k)) {
        urls.entry(k.clone()).or_insert_with(|| v.clone());
    }
    let urls = (!urls.is_empty()).then(|| {
        let mut m = toml_edit::InlineTable::new();
        for (k, v) in &urls {
            m.insert(k, v.as_str().into());
        }
        toml_edit::value(m)
    });
    put("urls", old.urls == d.urls, urls);
    put("sentry", old.sentry == d.sentry, word(&d.sentry));
    put("version_url", old.version_url == d.version_url, word(&d.version_url));
    if t.is_empty() {
        doc.remove("deploy"); // an emptied table must not leave a bare header behind
    }
    Ok(())
}

/// Reads degrade, writes fail loudly: an unsafe value is refused, never dropped in silence. The
/// file is committed, so an unchanged table writes nothing; `create` gates a new file.
#[tauri::command]
pub(crate) fn write_deploy(dir: String, deploy: DeployConfig, create: bool) -> Result<(), String> {
    let path = file_of(&dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => String::new(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(NO_FILE.into()),
        Err(e) => return Err(e.to_string()),
    };
    let (deploy, refused) = keep(deploy);
    if !refused.is_empty() {
        return Err(refused.join("; "));
    }
    let mut doc = text.parse::<toml_edit::DocumentMut>().map_err(|e| format!(".episko/episko.toml does not parse: {e}"))?;
    set_deploy(&mut doc, &raw_deploy(&text).unwrap_or_default(), &deploy)?;
    let out = doc.to_string();
    if out == text {
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().ok_or("bad project dir")?).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    crate::maint::forget_detection(&dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maint::exec::FakeExec;
    use crate::testutil::scratch_dir;

    fn cfg(host: &str, urls: &[(&str, &str)]) -> DeployConfig {
        DeployConfig {
            host: Some(host.into()),
            urls: urls.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn deploy_is_read_forgivingly() {
        let d = parse_deploy(
            "[stack]\nup = \"x\"\n[deploy]\nhost = \"prod-1\"\ncompose = \"api\"\nurls = [\"https://app.example.com/\", \"ftp://x\"]\n\
             sentry = 7\nversion_url = \"https://api.example.com/version\"\n",
        )
        .unwrap();
        assert_eq!(d.host.as_deref(), Some("prod-1"));
        assert_eq!(d.compose, ["api"], "a string is one service");
        assert_eq!(d.urls.keys().collect::<Vec<_>>(), ["app.example.com"], "a list is named by host; ftp is dropped");
        assert_eq!((d.sentry, d.version_url.as_deref()), (None, Some("https://api.example.com/version")), "a wrong type drops that value");
        let bad = parse_deploy("[deploy]\nhost = \"-oProxyCommand=x\"\nsentry = \"acme\"\ncompose = [\"a b\"]\n");
        assert_eq!(bad, None, "nothing safe is left, so there is no table");
        assert_eq!(parse_deploy("[deploy\nhost = "), None);
        assert_eq!(parse_deploy("[stack]\nup = \"x\"\n"), None);
    }

    #[test]
    fn checks_name_what_they_refuse() {
        let (d, out) = keep(DeployConfig {
            host: Some("-bad".into()), compose: vec!["api".into(), "".into()], sentry: Some("acme/api".into()),
            urls: [("app".to_string(), "javascript:alert(1)".to_string())].into_iter().collect(), version_url: Some("https://v.example".into()),
        });
        assert_eq!((d.host, d.compose, d.sentry.as_deref()), (None, vec!["api".to_string()], Some("acme/api")));
        assert_eq!(out.len(), 3, "{out:?}");
        assert!(!org_project("acme") && !org_project("a/b/c") && !org_project("-a/b") && org_project("acme-co/api.web"));
        assert!(is_http("HTTPS://x.example") && !is_http("https://") && !is_http("https://a b"));
    }

    /// deploy.ts's `checkDeploy` runs the same table, so the two languages cannot drift apart.
    #[test]
    fn checks_agree_with_deploy_ts() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/deploy-checks.json");
        let table: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in table["cases"].as_array().unwrap() {
            let (field, v) = (case["field"].as_str().unwrap(), case["value"].as_str().unwrap().to_string());
            let mut d = DeployConfig::default();
            match field {
                "url" => { d.urls.insert("app".into(), v.clone()); }
                "version_url" => d.version_url = Some(v.clone()),
                "host" => d.host = Some(v.clone()),
                "compose" => d.compose = vec![v.clone()],
                "sentry" => d.sentry = Some(v.clone()),
                other => panic!("no field {other}"),
            }
            let (kept, out) = keep(d);
            let want: Vec<String> = case["refused"].as_str().map(String::from).into_iter().collect();
            assert_eq!(out, want, "{field} = {v:?}");
            assert_eq!(kept.is_empty(), !want.is_empty(), "{field} = {v:?}");
        }
    }

    #[test]
    fn a_proposal_is_the_toml_block_and_its_reasons() {
        let out = "Found it.\n```toml\n[deploy]\nhost = \"prod-1\"\nurls = { app = \"https://app.example.com\" }\nsentry = \"bad\"\n```\nWHY\n- host: deploy.sh runs ssh prod-1\n";
        let p = parse_deploy_proposal(out).unwrap();
        assert_eq!(p.deploy.sentry.as_deref(), Some("bad"), "unchecked, so the dialog can say what it left out");
        assert_eq!(p.why, ["host: deploy.sh runs ssh prod-1"]);
        assert_eq!(parse_deploy_proposal("```toml\n```\n").unwrap().deploy, DeployConfig::default());
        assert!(parse_deploy_proposal("nothing here").is_err());
        assert!(parse_deploy_proposal("```toml\n[deploy\n```").is_err());
    }

    #[test]
    fn writing_keeps_every_other_table_and_comment() {
        let dir = scratch_dir();
        let before = "# team settings\n[branches]\nprotect = [\"dev\"]\n\n[deploy]\nhost = \"old\" # the box under the desk\nsentry = \"acme/api\"\n";
        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        std::fs::write(path_of(&s(&dir)), before).unwrap();
        let mut d = cfg("old", &[("app", "https://app.example.com")]);
        d.sentry = Some("acme/api".into());
        write_deploy(s(&dir), d.clone(), false).unwrap();
        let text = std::fs::read_to_string(path_of(&s(&dir))).unwrap();
        assert!(text.starts_with("# team settings\n[branches]\nprotect = [\"dev\"]"), "{text}");
        assert!(text.contains("host = \"old\" # the box under the desk"), "an unchanged value keeps its comment: {text}");
        assert_eq!(parse_deploy(&text), Some(d));
    }

    #[test]
    fn a_value_the_read_dropped_survives_an_apply() {
        let dir = scratch_dir();
        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        let before = "[deploy]\nhost = \"-x\"\ncompose = [\"api\", \"a b\"]\n\
                      urls = { app = \"https://app.example.com\", staging = \"staging.example.com\" } # staging lacks a scheme\n";
        std::fs::write(path_of(&s(&dir)), before).unwrap();
        let shown = read(&s(&dir)).unwrap();
        assert_eq!((shown.host.as_deref(), shown.urls.len(), shown.compose.len()), (None, 1, 1), "the proposal never sees them");
        write_deploy(s(&dir), DeployConfig { sentry: Some("acme/api".into()), ..shown.clone() }, false).unwrap();
        let text = std::fs::read_to_string(path_of(&s(&dir))).unwrap();
        assert!(text.starts_with(before), "an unchanged key keeps its dropped value and comment: {text}");
        let mut more = shown;
        more.urls.insert("docs".into(), "https://docs.example.com".into());
        more.compose.push("db".into());
        write_deploy(s(&dir), more, false).unwrap();
        let raw = raw_deploy(&std::fs::read_to_string(path_of(&s(&dir))).unwrap()).unwrap();
        assert_eq!(raw.urls.keys().collect::<Vec<_>>(), ["app", "docs", "staging"], "a rewritten table carries what was never shown");
        assert_eq!((raw.compose, raw.host.as_deref()), (vec!["api".to_string(), "db".into(), "a b".into()], Some("-x")));
    }

    #[test]
    fn an_unchanged_table_writes_nothing() {
        let dir = scratch_dir();
        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        // Spelt as a person would, which a rewrite would normalise: the bytes must not move.
        let text = "[deploy]\ncompose = \"api\"\nhost   = 'prod-1'\n";
        std::fs::write(path_of(&s(&dir)), text).unwrap();
        let d = DeployConfig { compose: vec!["api".into()], ..cfg("prod-1", &[]) };
        let mtime = std::fs::metadata(path_of(&s(&dir))).unwrap().modified().unwrap();
        write_deploy(s(&dir), d, false).unwrap();
        assert_eq!(std::fs::read_to_string(path_of(&s(&dir))).unwrap(), text);
        assert_eq!(std::fs::metadata(path_of(&s(&dir))).unwrap().modified().unwrap(), mtime);
        assert!(!dir.join(".episko").join("episko.toml.tmp").exists());
    }

    #[test]
    fn an_emptied_table_is_removed() {
        let mut doc = "[stack]\nup = \"x\"\n\n[deploy]\nhost = \"prod-1\"\n".parse::<toml_edit::DocumentMut>().unwrap();
        set_deploy(&mut doc, &cfg("prod-1", &[]), &DeployConfig::default()).unwrap();
        assert_eq!(doc.to_string(), "[stack]\nup = \"x\"\n");
        let mut doc = "[stack]\nup = \"x\"\n".parse::<toml_edit::DocumentMut>().unwrap();
        set_deploy(&mut doc, &DeployConfig::default(), &DeployConfig::default()).unwrap();
        assert!(!doc.to_string().contains("deploy"), "no table is made for nothing");
        let mut bad = "deploy = 3\n".parse::<toml_edit::DocumentMut>().unwrap();
        assert!(set_deploy(&mut bad, &DeployConfig::default(), &cfg("x", &[])).is_err());
    }

    #[test]
    fn a_missing_file_is_created_only_when_asked() {
        let dir = scratch_dir();
        assert_eq!(write_deploy(s(&dir), cfg("prod-1", &[]), false), Err(NO_FILE.to_string()));
        assert!(!path_of(&s(&dir)).exists());
        write_deploy(s(&dir), DeployConfig::default(), true).unwrap();
        assert!(!path_of(&s(&dir)).exists(), "nothing to write is no new file");
        write_deploy(s(&dir), cfg("prod-1", &[]), true).unwrap();
        assert_eq!(read(&s(&dir)), Some(cfg("prod-1", &[])));
        assert!(write_deploy(s(&dir), cfg("-oProxyCommand=x", &[]), false).unwrap_err().contains("ssh alias"), "refused, not dropped");
        assert_eq!(read(&s(&dir)), Some(cfg("prod-1", &[])));
    }

    /// Detection and the write must name one file, or Apply lands where nothing reads it.
    #[test]
    fn a_write_from_a_subfolder_or_worktree_is_what_detection_reads() {
        use crate::testutil::git;
        let repo = scratch_dir();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
        let sub = repo.join("apps").join("web");
        std::fs::create_dir_all(&sub).unwrap();
        let found = |dir: &Path, force: bool| serde_json::to_value(crate::maint::detect(&s(dir), force)).unwrap()["deploy"].clone();
        assert_eq!(found(&sub, true), serde_json::Value::Null);
        write_deploy(s(&sub), cfg("prod-1", &[]), true).unwrap();
        assert!(path_of(&s(&repo)).exists() && !path_of(&s(&sub)).exists());
        assert_eq!(found(&repo, false), serde_json::to_value(cfg("prod-1", &[])).unwrap(), "the write dropped the cached detection");
        assert_eq!(deploy_config(s(&sub)), cfg("prod-1", &[]));
        let wt = scratch_dir().join("wt");
        git(&repo, &["worktree", "add", "-q", "-b", "side", &s(&wt)]);
        write_deploy(s(&wt), cfg("prod-2", &[]), false).unwrap();
        assert_eq!(found(&wt, false), serde_json::to_value(cfg("prod-2", &[])).unwrap());
        assert!(!path_of(&s(&wt)).exists(), "a worktree shares its repo's table");
    }

    // 2026-11-29 23:59:59 UTC and 2026-11-30 08:12:43 UTC.
    const GITHUB_LEAF: u64 = 1_795_996_799;
    const OPENSSL_LEAF: u64 = 1_796_026_363;

    #[test]
    fn a_cert_date_reads_in_every_backends_spelling() {
        assert_eq!(cert_date("2026-11-29 23:59:59 GMT"), Some(GITHUB_LEAF), "x509asn1: Schannel, GnuTLS, Rustls");
        assert_eq!(cert_date("Nov 30 08:12:43 2026 GMT"), Some(OPENSSL_LEAF), "OpenSSL");
        assert_eq!(cert_date("Dec  4 08:12:43 2026 GMT"), Some(OPENSSL_LEAF + 4 * 86_400), "a padded day");
        assert_eq!(cert_date("Jan  1 00:00:00 1970 GMT"), Some(0));
        for bad in ["", "soon", "2026-13-01 00:00:00 GMT", "Nov 30 08:12:43 2026 CET", "Foo 30 08:12:43 2026 GMT", "2026-11-29 25:00:00 GMT"] {
            assert_eq!(cert_date(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_curl_report_reads_from_each_tls_backend() {
        let schannel = parse_report(&FakeExec::testdata("curl-schannel.txt")).unwrap();
        assert_eq!((schannel.code, schannel.err.as_deref(), schannel.cert_not_after), (Some(200), None, Some(GITHUB_LEAF)));
        assert!(schannel.ms.is_some_and(|ms| ms > 0));
        let openssl = parse_report(&FakeExec::testdata("curl-openssl.txt")).unwrap();
        assert_eq!(openssl, CurlReport { code: Some(200), ms: Some(142), err: None, cert_not_after: Some(OPENSSL_LEAF) });
        // No `certs` in the json: the raw block after it is read instead.
        let libressl = parse_report(&FakeExec::testdata("curl-libressl.txt")).unwrap();
        assert_eq!((libressl.code, libressl.cert_not_after), (Some(503), Some(OPENSSL_LEAF + 4 * 86_400)));
    }

    #[test]
    fn a_failed_transfer_is_a_report_and_garbage_is_not() {
        let refused = parse_report(&FakeExec::testdata("curl-refused.txt")).unwrap();
        assert_eq!(refused.code, None);
        assert!(refused.err.as_deref().is_some_and(|e| e.starts_with("Failed to connect")), "{refused:?}");
        let exit = parse_report(r#"{"http_code":0,"exitcode":28,"errormsg":null}"#).unwrap();
        assert_eq!(exit.err.as_deref(), Some("curl exited 28"), "an exit code with no message still says so");
        let plain = parse_report(&FakeExec::testdata("curl-plain-http.txt")).unwrap();
        assert_eq!((plain.code, plain.cert_not_after), (Some(200), None), "no TLS, so no certificate to read");
        // Certs a curl could not print leave the date unknown, never fine.
        let bare = parse_report(r#"{"http_code":200,"exitcode":0}"#).unwrap();
        assert_eq!((bare.code, bare.cert_not_after), (Some(200), None));
        for junk in ["", "<html>oops</html>", "{}", "[1]", "%{json}"] {
            assert!(parse_report(junk).is_err(), "{junk:?}");
        }
    }

    #[test]
    fn only_the_leaf_dates_the_certificate() {
        let chain = "Subject:CN=app\nIssuer:CN=R11\nVersion:2\n-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n\
            Subject:CN=old root\nExpire Date:2021-09-30 14:01:15 GMT\n";
        assert_eq!(leaf_expiry(chain), None, "an expired cross-sign later in the chain is not the site's date");
        assert_eq!(leaf_expiry("subject:CN=app\r\nexpire date:2026-11-29 23:59:59 GMT\r\n"), Some(GITHUB_LEAF));
    }

    fn probe_repo(deploy: &str) -> String {
        let dir = scratch_dir();
        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        std::fs::write(path_of(&s(&dir)), deploy).unwrap();
        s(&dir)
    }

    #[test]
    fn the_probe_asks_every_address_and_names_each_answer() {
        let root = probe_repo("[deploy]\nurls = { app = \"https://app.example.com\", api = \"https://api.example.com/health\" }\nversion_url = \"https://api.example.com/version\"\n");
        let cfg = crate::maint::read_config(&root);
        let forge = crate::forge::forge_of(None, None);
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &forge, account: None, force: true };
        let refused = FakeExec::testdata("curl-refused.txt");
        let ex = FakeExec::recorded("curl-openssl.txt").on(&["curl", "https://api.example.com/health"], Ok(&refused));
        let r = http_probe(&ctx, &ex).unwrap();
        let Facts::Probes { items } = r.facts else { panic!("not probes") };
        let got: Vec<_> = items.iter().map(|p| (p.name.as_str(), p.code, p.err.is_some(), p.cert_not_after)).collect();
        assert_eq!(got, [("api", None, true, None), ("app", Some(200), false, Some(OPENSSL_LEAF)), ("version", Some(200), false, Some(OPENSSL_LEAF))]);
        assert_eq!(ex.calls().len(), 3);
        assert!(ex.calls().iter().all(|c| c.last().map(String::as_str) == Some("--report")), "{:?}", ex.calls());
        // No report is never a site drawn as down: a gap for one address, the read's failure for all.
        let one = FakeExec::recorded("curl-openssl.txt").on(&["curl", "https://app.example.com"], Ok("<html>"));
        let r = http_probe(&ctx, &one).unwrap();
        let Facts::Probes { items } = r.facts else { panic!("not probes") };
        assert_eq!((items.len(), r.gaps.as_slice()), (2, ["app: curl printed no report".to_string()].as_slice()));
        assert!(matches!(http_probe(&ctx, &FakeExec::answering(Ok("<html>"))), Err(Coverage::Error { .. })));
        let none = probe_repo("[deploy]\nhost = \"prod-1\"\n");
        let ctx = Ctx { root: &none, ..ctx };
        assert!(matches!(http_probe(&ctx, &FakeExec::answering(Ok(""))), Err(Coverage::Unsupported { .. })));
    }

    #[test]
    fn version_url_joins_the_targets_once() {
        let d = parse_deploy("[deploy]\nurls = { version = \"https://a.example/v\" }\nversion_url = \"https://a.example/version\"\n").unwrap();
        assert_eq!(d.targets(), [("version".to_string(), "https://a.example/v".to_string()), ("version_url".into(), "https://a.example/version".into())]);
        let same = parse_deploy("[deploy]\nurls = { app = \"https://a.example\" }\nversion_url = \"https://a.example\"\n").unwrap();
        assert_eq!(same.targets().len(), 1, "one address is asked once");
    }

    /// Every owner reads the file through its own forgiving parse; a `[deploy]` write must leave
    /// each of their answers exactly as it was.
    #[test]
    fn deploy_round_trips_beside_every_other_table() {
        let before = "# Episko's committed settings\n[branches]\nprotect = [\"dev\", \"release/*\"]\n\n[claim]\nassign = false\n\n\
            [health]\nnesting = 8\nlong_fn = 120\n\n[stack]\nup = \"just:dev\"\ncompose = [\"db\"]\n\n[run.\"just:dev\"]\nkind = \"server\"\nhash = \"abc\"\n\n\
            [maintenance]\ntrunk = \"dev\"\noff = [\"work\"]\n[maintenance.thresholds]\nstale_branch_days = 14\n";
        let mut doc = before.parse::<toml_edit::DocumentMut>().unwrap();
        let d = DeployConfig {
            compose: vec!["api".into(), "worker".into()], sentry: Some("acme/api".into()),
            version_url: Some("https://api.example.com/version".into()),
            ..cfg("prod-1", &[("app", "https://app.example.com"), ("api", "https://api.example.com/health")])
        };
        set_deploy(&mut doc, &DeployConfig::default(), &d).unwrap();
        let after = doc.to_string();
        assert!(after.starts_with(before), "{after}");
        assert_eq!(parse_deploy(&after), Some(d));
        assert_eq!(crate::stack::parse_stack(&after), crate::stack::parse_stack(before));
        assert_ne!(crate::stack::parse_stack(before), Default::default());
        assert_eq!(crate::git::parse_protect(&after), crate::git::parse_protect(before));
        assert_eq!(serde_json::to_value(crate::git::parse_protect(&after)).unwrap()["patterns"], serde_json::json!(["dev", "release/*"]));
        assert!(!crate::github::parse_allow(&after).assign);
        let h = crate::health::parse_health_policy(&after);
        assert_eq!((h.nesting, h.long_fn), (Some(8), Some(120)));
        let m = crate::maint::parse_maint(&after);
        assert_eq!(m.trunk(), Some("dev"));
        assert_eq!(m, crate::maint::parse_maint(before));
    }
}
