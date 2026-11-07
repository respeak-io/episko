//! `rdap-domain` (docs/maintenance.md § Adapters): when the domain behind each `[deploy]` address runs
//! out, asked of that domain's own registry over RDAP. Only the registered name ever leaves the machine.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::Hash;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::Value;

use crate::deps::Shared;
use crate::maint::exec::HttpReq;
use crate::maint::{Coverage, Ctx, Domain, Exec, Facts, Read};

const BOOTSTRAP: &str = "https://data.iana.org/rdap/dns.json";
const SECS: u64 = 20;
const CAP: usize = 12;
const KEEP: Duration = Duration::from_secs(24 * 3600);
const JOIN: Duration = Duration::from_secs(15); // a forced read joins one this young: one ⟳ of many projects asks once
const STALL: Duration = Duration::from_secs(SECS + 30);
const STATUS_MAX: usize = 12;
const TEXT_MAX: usize = 120;

/// Registries that answer RDAP for a TLD IANA lists no server for (each checked 2026-11-03 and 2026-11-07).
/// IANA wins wherever it lists one, and a test holds every entry absent from the recorded list.
const UNLISTED: &[(&str, &str)] = &[
    ("ac", "https://rdap.identitydigital.services/rdap/"),
    ("io", "https://rdap.identitydigital.services/rdap/"),
    ("me", "https://rdap.identitydigital.services/rdap/"),
    ("sh", "https://rdap.identitydigital.services/rdap/"),
];

// ---------- the Public Suffix List ----------

/// publicsuffix.org's list, vendored verbatim and refreshed by a RELEASE.md step.
const PSL_TEXT: &str = include_str!("../data/public_suffix_list.dat");

struct Psl {
    rules: HashMap<String, bool>, // as written (`*.ck`, `!www.ck`), an IDN as its A-label → in the private section
    tlds: HashSet<String>,        // the last label of every ICANN rule
}

static PSL: LazyLock<Psl> = LazyLock::new(|| parse_psl(PSL_TEXT));

fn parse_psl(text: &str) -> Psl {
    let (mut rules, mut tlds, mut private) = (HashMap::new(), HashSet::new(), false);
    for line in text.lines() {
        private |= line.contains("===BEGIN PRIVATE DOMAINS===");
        let Some(rule) = line.split_whitespace().next().filter(|r| !r.starts_with("//")).and_then(ascii_rule) else { continue };
        if !private {
            tlds.insert(rule.rsplit('.').next().unwrap_or(&rule).to_string());
        }
        rules.insert(rule, private);
    }
    Psl { rules, tlds }
}

/// A rule spelt as a host from `url` is: an IDN as its A-label, its `!` or `*.` kept.
fn ascii_rule(rule: &str) -> Option<String> {
    if rule.is_ascii() {
        return Some(rule.to_ascii_lowercase());
    }
    let (pre, name) = rule.strip_prefix('!').map(|n| ("!", n)).or_else(|| rule.strip_prefix("*.").map(|n| ("*.", n))).unwrap_or(("", rule));
    match url::Host::parse(name).ok()? {
        url::Host::Domain(d) => Some(format!("{pre}{d}")),
        _ => None,
    }
}

/// What a host's registry would be asked about, or why it is never sent.
#[derive(Debug, PartialEq)]
pub(crate) enum Reg {
    Domain(String),
    Skip(String),
}

/// publicsuffix.org's algorithm, less its implicit `*` rule: a host under no ICANN TLD (`localhost`,
/// `.lan`, `.internal`) has no registry, and one under a private rule is a platform's name to hand out.
pub(crate) fn registrable(host: &str) -> Reg {
    let host = match url::Host::parse(host.trim_end_matches('.')) {
        Ok(url::Host::Domain(d)) => d,
        Ok(_) => return Reg::Skip("an IP address".into()),
        Err(_) => return Reg::Skip("not a host name".into()),
    };
    let labels: Vec<&str> = host.split('.').collect();
    if labels.iter().any(|l| l.is_empty()) {
        return Reg::Skip("not a host name".into());
    }
    if !labels.last().is_some_and(|t| PSL.tlds.contains(*t)) {
        return Reg::Skip("under no public top-level domain".into());
    }
    let n = labels.len();
    let (mut exception, mut longest) = (None, None);
    for i in 0..n {
        let s = labels[i..].join(".");
        if let Some(&p) = PSL.rules.get(&format!("!{s}")) {
            exception.get_or_insert((n - i - 1, p));
        }
        let wild = (i + 1 < n).then(|| format!("*.{}", labels[i + 1..].join(".")));
        if let Some(&p) = PSL.rules.get(&s).or_else(|| wild.and_then(|w| PSL.rules.get(&w))) {
            longest.get_or_insert((n - i, p));
        }
    }
    let Some((len, private)) = exception.or(longest) else { return Reg::Skip(format!("{host} is a public suffix")) };
    let suffix = labels[n - len..].join(".");
    if private {
        Reg::Skip(format!("under {suffix}, whose owner hands out its names"))
    } else if len >= n {
        Reg::Skip(format!("{host} is a public suffix"))
    } else {
        Reg::Domain(labels[n - len - 1..].join("."))
    }
}

/// Each registered domain behind `targets` with the `[deploy]` names under it, sorted, and one gap
/// per address that is never sent: an IP, a local name or a platform's subdomain.
pub(crate) fn domains_of(targets: &[(String, String)]) -> (Vec<(String, Vec<String>)>, Vec<String>) {
    let (mut by, mut gaps) = (BTreeMap::<String, Vec<String>>::new(), vec![]);
    for (name, addr) in targets {
        let reg = match url::Url::parse(addr).as_ref().map(url::Url::host) {
            Ok(Some(url::Host::Domain(h))) => registrable(h),
            Ok(Some(_)) => Reg::Skip("an IP address".into()),
            Ok(None) | Err(_) => Reg::Skip("no host name".into()),
        };
        match reg {
            Reg::Domain(d) => by.entry(d).or_default().push(name.clone()),
            Reg::Skip(why) => gaps.push(format!("{name}: not asked, {why}")),
        }
    }
    for names in by.values_mut() {
        names.sort();
        names.dedup();
    }
    (by.into_iter().collect(), gaps)
}

// ---------- the servers and the records ----------

type Servers = BTreeMap<String, String>; // TLD → its first https base, `/`-terminated

/// IANA's bootstrap: each TLD's first https server. An http-only one (.kg, .mg) is not used.
fn parse_bootstrap(body: &str) -> Result<Servers, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "the answer is not JSON".to_string())?;
    let mut out = Servers::new();
    for s in v.get("services").and_then(Value::as_array).ok_or("it lists no services")? {
        let (Some(tlds), Some(urls)) = (s.get(0).and_then(Value::as_array), s.get(1).and_then(Value::as_array)) else { continue };
        let Some(base) = urls.iter().filter_map(Value::as_str).find(|u| u.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("https://"))) else { continue };
        let base = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
        for t in tlds.iter().filter_map(Value::as_str) {
            out.entry(t.to_ascii_lowercase()).or_insert_with(|| base.clone());
        }
    }
    if out.is_empty() {
        return Err("it lists no https server".into());
    }
    Ok(out)
}

fn tld(domain: &str) -> &str {
    domain.rsplit('.').next().unwrap_or(domain)
}

/// Where `domain` is asked: IANA's server for its TLD, else the supplement's.
fn base_of(servers: &Servers, domain: &str) -> Option<String> {
    let t = tld(domain);
    servers.get(t).cloned().or_else(|| UNLISTED.iter().find(|(x, _)| *x == t).map(|(_, b)| b.to_string()))
}

#[derive(Clone, Debug, PartialEq)]
struct Record {
    expires: Option<u64>,
    status: Vec<String>,
    registrar: Option<String>,
    url: Option<String>,
}

/// RFC 8056's spelling: EPP's `clientHold` is `client hold`, and its `ok` is `active`.
fn status_word(s: &str) -> String {
    let s = s.trim();
    if s == "ok" {
        return "active".into();
    }
    let camel = s.chars().any(|c| c.is_ascii_lowercase());
    let mut out = String::new();
    for c in s.chars() {
        if camel && c.is_ascii_uppercase() && !out.is_empty() && !out.ends_with(' ') {
            out.push(' ');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn clip(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.chars().take(TEXT_MAX).collect())
}

fn web(u: &&str) -> bool {
    let l = u.to_ascii_lowercase();
    (l.starts_with("https://") || l.starts_with("http://")) && u.len() <= 300
}

/// A vCard property's text value: `["fn", {}, "text", "MarkMonitor Inc."]`.
fn vcard<'a>(e: &'a Value, key: &str) -> Option<&'a str> {
    e.get("vcardArray")?.get(1)?.as_array()?.iter().find(|p| p.get(0).and_then(Value::as_str) == Some(key))?.get(3)?.as_str()
}

/// One registry's record of `domain`. A record of another name is no answer: Verisign spells it upper case.
fn parse_record(domain: &str, body: &str) -> Result<Record, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "the answer is not JSON".to_string())?;
    if v.get("objectClassName").and_then(Value::as_str) != Some("domain") {
        return Err("the answer is not a domain record".into());
    }
    let name = v.get("ldhName").and_then(Value::as_str).unwrap_or("");
    if !name.trim_end_matches('.').eq_ignore_ascii_case(domain) {
        return Err(format!("the answer is for {name:?}, not {domain}"));
    }
    let events = v.get("events").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let expires = match events.iter().find(|e| e.get("eventAction").and_then(Value::as_str) == Some("expiration")) {
        None => None,
        Some(e) => {
            let at = e.get("eventDate").and_then(Value::as_str).unwrap_or("");
            Some(crate::usage::iso_epoch_secs(at).ok_or_else(|| format!("its expiry {at:?} does not parse"))?)
        }
    };
    let status = v.get("status").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
        .iter().filter_map(Value::as_str).map(status_word).filter(|s| !s.is_empty() && s.len() <= 64).take(STATUS_MAX).collect();
    let reg = v.get("entities").and_then(Value::as_array).and_then(|es| es.iter().find(|e| {
        e.get("roles").and_then(Value::as_array).is_some_and(|r| r.iter().any(|x| x.as_str() == Some("registrar")))
    }));
    let page = reg.and_then(|e| e.get("links")?.as_array()?.iter().find_map(|l| {
        (l.get("type").and_then(Value::as_str) == Some("text/html")).then(|| l.get("href").and_then(Value::as_str)).flatten().filter(web)
    })).or_else(|| reg.and_then(|e| vcard(e, "url")).filter(web));
    Ok(Record { expires, status, registrar: reg.and_then(|e| vcard(e, "fn")).and_then(clip), url: page.map(str::to_string) })
}

fn get(ex: &dyn Exec, url: String) -> Result<crate::maint::exec::HttpResp, String> {
    ex.http(&HttpReq { url, body: None, auth: None, secs: SECS, report: false })
}

fn ask_servers(ex: &dyn Exec) -> Result<Servers, String> {
    let r = get(ex, BOOTSTRAP.into())?;
    if r.code != 200 {
        return Err(format!("HTTP {}", r.code));
    }
    parse_bootstrap(&r.body)
}

fn ask(ex: &dyn Exec, base: &str, domain: &str) -> Result<Record, String> {
    let r = get(ex, format!("{base}domain/{domain}"))?;
    match r.code {
        200 => parse_record(domain, &r.body),
        404 => Err("the registry has no record of it".into()),
        429 => Err("the registry is limiting requests".into()),
        300..=399 => Err(format!("redirected (HTTP {}), not followed", r.code)),
        c => Err(format!("the registry answered HTTP {c}")),
    }
}

type Boot = Shared<(), Result<Servers, String>>;
type Records = Shared<String, Result<Record, String>>;
/// Process-wide, the tests passing their own. The servers say nothing of a project, so even a forced
/// read takes them for a day; a record is kept a day per domain across projects, and a forced read asks again.
static BOOT: Boot = Shared::new(KEEP, KEEP, STALL);
static RECORDS: Records = Shared::new(KEEP, JOIN, STALL);

/// `cache`'s answer, a failure kept by nobody: a reader that joined one asks for itself (maint_pkgs's rule).
fn kept<K: Eq + Hash + Clone, T: Clone>(cache: &Shared<K, Result<T, String>>, key: K, force: bool, ask: impl Fn() -> Result<T, String>) -> Result<T, String> {
    let mut mine = false;
    let got = cache.get(key.clone(), force, || {
        mine = true;
        ask()
    });
    if got.is_ok() {
        return got;
    }
    cache.forget(|k| *k == key);
    if mine { got } else { ask() }
}

fn read_with(ctx: &Ctx, ex: &dyn Exec, boot: &Boot, recs: &Records) -> Result<Read, Coverage> {
    let targets = crate::deploy::read(ctx.root).map(|d| d.targets()).unwrap_or_default();
    let (mut domains, mut gaps) = domains_of(&targets);
    if domains.is_empty() {
        let reason = ["no address in [deploy] is under a public registry".to_string()].into_iter().chain(gaps).collect::<Vec<_>>();
        return Err(Coverage::Unsupported { reason: reason.join("; ") });
    }
    let truncated = domains.len() > CAP;
    domains.truncate(CAP);
    let servers = kept(boot, (), false, || ask_servers(ex))
        .map_err(|e| Coverage::Error { reason: format!("IANA's list of RDAP servers could not be read: {e}") })?;
    let (listed, unlisted): (Vec<_>, Vec<_>) = domains.into_iter().map(|(d, names)| (base_of(&servers, &d), d, names)).partition(|x| x.0.is_some());
    let none: Vec<String> = unlisted.iter().map(|(_, d, _)| format!("{d}: .{} lists no RDAP service", tld(d))).collect();
    if listed.is_empty() {
        let tlds: std::collections::BTreeSet<String> = unlisted.iter().map(|(_, d, _)| format!(".{}", tld(d))).collect();
        let verb = if tlds.len() == 1 { "lists" } else { "list" };
        return Err(Coverage::Unsupported { reason: format!("{} {verb} no RDAP service", tlds.into_iter().collect::<Vec<_>>().join(", ")) });
    }
    let force = ctx.force;
    let answers: Vec<Result<Record, String>> = std::thread::scope(|s| {
        let jobs: Vec<_> = listed.iter().map(|(base, d, _)| s.spawn(move || {
            kept(recs, d.clone(), force, || ask(ex, base.as_deref().unwrap_or_default(), d))
        })).collect();
        jobs.into_iter().map(|j| j.join().unwrap_or_else(|_| Err("the read panicked".into()))).collect()
    });
    let (mut items, mut failed) = (vec![], vec![]);
    for ((_, domain, names), a) in listed.into_iter().zip(answers) {
        match a {
            Ok(r) => items.push(Domain { domain, names, expires: r.expires, status: r.status, registrar: r.registrar, url: r.url }),
            Err(e) => failed.push(format!("{domain}: {e}")),
        }
    }
    failed.extend(none);
    if items.is_empty() {
        return Err(Coverage::Error { reason: failed.join("; ") });
    }
    gaps.extend(failed);
    if truncated {
        gaps.push(format!("only the first {CAP} domains are asked"));
    }
    Ok(Read { facts: Facts::Domains { items }, truncated, gaps })
}

/// The registered domain behind each `[deploy]` address, from its own registry: a `public` read,
/// so a scan makes it only on a machine that opted in, and a click once.
pub(crate) fn rdap_domain(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    read_with(ctx, ex, &BOOT, &RECORDS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::MaintConfig;
    use crate::testutil::scratch_dir;

    const NONE: Forge = Forge { kind: ForgeKind::None, host: None, path: None, by: ForgeBy::None, api: None };
    const VERISIGN: &str = "https://rdap.verisign.com/com/v1/domain/";

    fn caches() -> (Boot, Records) {
        (Shared::new(KEEP, KEEP, STALL), Shared::new(KEEP, JOIN, STALL))
    }

    fn project(deploy: &str) -> String {
        let dir = scratch_dir();
        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        std::fs::write(dir.join(".episko").join("episko.toml"), format!("[deploy]\n{deploy}\n")).unwrap();
        dir.to_string_lossy().to_string()
    }

    fn read(root: &str, ex: &FakeExec, force: bool, (boot, recs): &(Boot, Records)) -> Result<Read, Coverage> {
        let cfg = MaintConfig::default();
        read_with(&Ctx { root, cfg: &cfg, forge: &NONE, account: None, force, hosts: &[] }, ex, boot, recs)
    }

    fn servers() -> FakeExec {
        FakeExec::answering(Err("no answer")).on(&["curl", BOOTSTRAP], Ok(&FakeExec::testdata("rdap-dns.json")))
    }

    fn urls(calls: &[Vec<String>]) -> Vec<&str> {
        calls.iter().map(|c| c[1].as_str()).collect()
    }

    fn domain(r: &Result<Read, Coverage>) -> (Vec<Domain>, Vec<String>) {
        match r {
            Ok(Read { facts: Facts::Domains { items }, gaps, .. }) => (items.clone(), gaps.clone()),
            other => panic!("{:?}", other.as_ref().err()),
        }
    }

    #[test]
    fn the_list_is_upstreams_and_parses_whole() {
        assert!(PSL_TEXT.contains("// VERSION: ") && PSL_TEXT.contains("Mozilla Public"), "its header and version are kept");
        assert!(PSL.rules.len() > 9000, "{}: a truncated download", PSL.rules.len());
        let private = PSL.rules.values().filter(|p| **p).count();
        assert!(private > 1000 && PSL.rules.len() - private > 5000, "both sections");
        assert!(["com", "uk", "io", "de", "dev", "ck"].iter().all(|t| PSL.tlds.contains(*t)));
        assert!(!PSL.tlds.contains("app.localhost") && !PSL.tlds.contains("vercel"));
    }

    #[test]
    fn a_registered_domain_follows_the_public_suffix_list() {
        let d = |h: &str| registrable(h);
        let is = |s: &str| Reg::Domain(s.to_string());
        assert_eq!(d("www.bbc.co.uk"), is("bbc.co.uk"));
        assert_eq!(d("api.github.com"), is("github.com"));
        assert_eq!(d("foo.bar.ck"), is("foo.bar.ck"), "a wildcard rule");
        assert_eq!(d("x.www.ck"), is("www.ck"), "its exception");
        assert_eq!(d("bücher.de"), is("xn--bcher-kva.de"), "an IDN as its A-label");
        assert_eq!(d("API.Example.COM."), is("example.com"), "case and a trailing dot");
        for platform in ["a.b.vercel.app", "user.github.io", "x.pages.dev", "x.azurewebsites.net"] {
            assert!(matches!(d(platform), Reg::Skip(ref w) if w.contains("whose owner hands out")), "{platform}: {:?}", d(platform));
        }
        for local in ["localhost", "app.localhost", "nas.lan", "x.internal", "x.local", "a.test"] {
            assert_eq!(d(local), Reg::Skip("under no public top-level domain".into()), "{local}");
        }
        assert_eq!(d("co.uk"), Reg::Skip("co.uk is a public suffix".into()));
        assert_eq!(d("10.0.0.5"), Reg::Skip("an IP address".into()));
    }

    #[test]
    fn domains_of_groups_deploy_names_and_says_what_it_skips() {
        let t = |n: &str, u: &str| (n.to_string(), u.to_string());
        let (domains, gaps) = domains_of(&[
            t("app", "https://app.example.com"), t("api", "https://api.example.com:8443/health?x=1"), t("version", "https://example.com/version"),
            t("lan", "http://10.0.0.5:8080"), t("pages", "https://x.github.io"), t("v6", "http://[::1]:3000"),
        ]);
        assert_eq!(domains, vec![("example.com".to_string(), vec!["api".to_string(), "app".into(), "version".into()])]);
        assert_eq!(gaps, ["lan: not asked, an IP address", "pages: not asked, under github.io, whose owner hands out its names", "v6: not asked, an IP address"]);
    }

    #[test]
    fn the_bootstrap_maps_each_tld_to_its_https_server() {
        let s = parse_bootstrap(&FakeExec::testdata("rdap-dns.json")).unwrap();
        assert_eq!(s.get("com").map(String::as_str), Some("https://rdap.verisign.com/com/v1/"));
        assert_eq!(s.get("uk").map(String::as_str), Some("https://rdap.nominet.uk/uk/"));
        assert_eq!(s.get("dev").map(String::as_str), Some("https://pubapi.registry.google/rdap/"));
        assert!(!s.contains_key("io") && !s.contains_key("de"), "unlisted ccTLDs");
        assert!(!s.contains_key("kg") && !s.contains_key("mg"), "an http-only server is not used");
        assert!(parse_bootstrap("<html>").is_err() && parse_bootstrap("{\"services\": []}").is_err());
    }

    #[test]
    fn the_supplement_never_shadows_iana() {
        let recorded = parse_bootstrap(&FakeExec::testdata("rdap-dns.json")).unwrap();
        for (t, _) in UNLISTED {
            assert!(!recorded.contains_key(*t), ".{t} is listed by IANA now: drop it from UNLISTED");
        }
        assert_eq!(base_of(&recorded, "nic.io").as_deref(), Some("https://rdap.identitydigital.services/rdap/"));
        assert_eq!(base_of(&recorded, "denic.de"), None, "de and ch publish no expiry, so they are not added");
        let listed = Servers::from([("io".to_string(), "https://rdap.nic.io/".to_string())]);
        assert_eq!(base_of(&listed, "nic.io").as_deref(), Some("https://rdap.nic.io/"), "IANA wins where both list one");
    }

    #[test]
    fn a_record_names_its_expiry_status_and_registrar() {
        let rec = |d: &str, f: &str| parse_record(d, &FakeExec::testdata(f)).unwrap();
        let at = |s: &str| crate::usage::iso_epoch_secs(s);
        let mark = Some("MarkMonitor Inc.".to_string());
        let gh = rec("github.com", "rdap-github.com.json");
        assert_eq!(gh.expires, at("2028-10-09T18:20:50Z"));
        assert_eq!(gh.status, ["client delete prohibited", "client transfer prohibited", "client update prohibited"]);
        assert_eq!((gh.registrar, gh.url.as_deref()), (mark.clone(), Some("http://www.markmonitor.com")), "its text/html link");
        let bbc = rec("bbc.co.uk", "rdap-bbc.co.uk.json");
        assert_eq!(bbc.expires, at("2034-12-13T03:49:48Z"));
        assert_eq!((bbc.registrar.as_deref(), bbc.url.as_deref()), (Some("British Broadcasting Corporation"), Some("https://www.bbc.co.uk/")), "a vCard url");
        let dev = rec("web.dev", "rdap-web.dev.json");
        assert_eq!((dev.expires, dev.registrar), (at("2027-10-29T15:57:39.435Z"), mark));
        let de = rec("denic.de", "rdap-denic.de.json");
        assert_eq!(de, Record { expires: None, status: vec!["active".into()], registrar: None, url: None }, "no expiry published");
        let io = rec("nic.io", "rdap-nic.io.json");
        assert_eq!((io.expires, io.url), (at("2027-05-01T00:00:02Z"), None), "an RDAP link is never the registrar's page");
        assert!(parse_record("example.com", &FakeExec::testdata("rdap-github.com.json")).unwrap_err().contains("\"GITHUB.COM\""));
        let entity = FakeExec::testdata("rdap-github.com.json").replacen("\"domain\"", "\"entity\"", 1);
        assert_eq!(parse_record("github.com", &entity).unwrap_err(), "the answer is not a domain record");
        assert!(parse_record("github.com", "<html>").is_err());
        // Hand-written: the recorded record with only its status words edited.
        let held = FakeExec::testdata("rdap-github.com.json").replace("\"client delete prohibited\"", "\"clientHold\", \"redemptionPeriod\", \"ok\"");
        assert_eq!(parse_record("github.com", &held).unwrap().status[..3], ["client hold", "redemption period", "active"]);
    }

    #[test]
    fn a_read_sends_only_the_registered_domain() {
        let root = project("urls = { app = \"https://app.github.com:8443/login?next=/x\", api = \"https://api.github.com/v1\", lan = \"http://10.0.0.5:8080\", pages = \"https://acme.github.io\" }\nversion_url = \"https://status.github.com/version\"");
        let ex = servers().on(&["curl", &format!("{VERISIGN}github.com")], Ok(&FakeExec::testdata("rdap-github.com.json")));
        let (items, gaps) = domain(&read(&root, &ex, false, &caches()));
        assert_eq!(urls(&ex.calls()), [BOOTSTRAP.to_string(), format!("{VERISIGN}github.com")], "no host, path or port");
        assert_eq!(items.len(), 1);
        assert_eq!((items[0].domain.as_str(), &items[0].names[..]), ("github.com", &["api".to_string(), "app".into(), "version".into()][..]));
        assert_eq!(gaps, ["lan: not asked, an IP address", "pages: not asked, under github.io, whose owner hands out its names"]);
    }

    // The codes are hand-made through `coded`; the bodies they ride on are never read.
    #[test]
    fn a_domain_its_registry_could_not_answer_is_a_gap_and_none_answering_is_an_error() {
        let root = project("urls = { a = \"https://github.com\", b = \"https://gitlab.com\", c = \"https://bitbucket.org\", d = \"https://example.net\", e = \"https://denic.de\" }");
        let ex = servers().on(&["curl", &format!("{VERISIGN}github.com")], Ok(&FakeExec::testdata("rdap-github.com.json")))
            .on(&["curl"], Ok("")).coded(&["curl", &format!("{VERISIGN}gitlab.com")], 404)
            .coded(&["curl", "https://rdap.publicinterestregistry.org/rdap/domain/bitbucket.org"], 429)
            .coded(&["curl", "https://rdap.verisign.com/net/v1/domain/example.net"], 301);
        let (items, gaps) = domain(&read(&root, &ex, false, &caches()));
        assert_eq!(items.iter().map(|d| d.domain.as_str()).collect::<Vec<_>>(), ["github.com"]);
        assert_eq!(gaps, [
            "bitbucket.org: the registry is limiting requests", "example.net: redirected (HTTP 301), not followed",
            "gitlab.com: the registry has no record of it", "denic.de: .de lists no RDAP service",
        ]);
        let root = project("urls = { b = \"https://gitlab.com\" }");
        let none = FakeExec::answering(Ok("")).on(&["curl", BOOTSTRAP], Ok(&FakeExec::testdata("rdap-dns.json")))
            .coded(&["curl", &format!("{VERISIGN}gitlab.com")], 404);
        assert_eq!(read(&root, &none, false, &caches()).err(), Some(Coverage::Error { reason: "gitlab.com: the registry has no record of it".into() }));
        let Err(Coverage::Error { reason }) = read(&root, &FakeExec::answering(Err("curl: (6) Could not resolve host")), false, &caches()) else { panic!() };
        assert!(reason.starts_with("IANA's list of RDAP servers could not be read"), "{reason}");
        let root = project("urls = { a = \"https://denic.de\", b = \"https://www.ethz.ch\" }");
        assert_eq!(read(&root, &servers(), false, &caches()).err(), Some(Coverage::Unsupported { reason: ".ch, .de list no RDAP service".into() }));
        let root = project("urls = { lan = \"http://10.0.0.5\" }");
        assert_eq!(read(&root, &servers(), false, &caches()).err(), Some(Coverage::Unsupported {
            reason: "no address in [deploy] is under a public registry; lan: not asked, an IP address".into() }));
    }

    #[test]
    fn records_are_kept_per_domain_and_a_forced_read_asks_again() {
        let (one, two) = (project("urls = { app = \"https://github.com\" }"), project("urls = { www = \"https://www.github.com\" }"));
        let ex = servers().on(&["curl", &format!("{VERISIGN}github.com")], Ok(&FakeExec::testdata("rdap-github.com.json")));
        let c = caches();
        read(&one, &ex, false, &c).unwrap();
        read(&two, &ex, false, &c).unwrap();
        assert_eq!(ex.calls().len(), 2, "another project on the same domain asks nothing");
        read(&two, &ex, true, &c).unwrap();
        assert_eq!(ex.calls().len(), 2, "a forced read joins one under {JOIN:?} old");
        c.1.age(JOIN + Duration::from_secs(1), |_| true);
        read(&two, &ex, true, &c).unwrap();
        assert_eq!(urls(&ex.calls()), [BOOTSTRAP.to_string(), format!("{VERISIGN}github.com"), format!("{VERISIGN}github.com")], "the servers once, however forced");
        let (failing, c) = (servers(), caches());
        assert!(read(&one, &failing, false, &c).is_err() && read(&one, &failing, false, &c).is_err());
        assert_eq!(failing.calls().len(), 3, "a failed record is kept by nobody, unforced or not");
    }

    #[test]
    fn past_the_cap_a_read_is_truncated() {
        let many: Vec<String> = (0..12).map(|i| format!("z{i} = \"https://z{i}.com\"")).collect();
        let root = project(&format!("urls = {{ gh = \"https://github.com\", {} }}", many.join(", ")));
        let ex = servers().on(&["curl", &format!("{VERISIGN}github.com")], Ok(&FakeExec::testdata("rdap-github.com.json")));
        let r = read(&root, &ex, false, &caches()).unwrap();
        assert!(r.truncated && r.gaps.last().is_some_and(|g| g == "only the first 12 domains are asked"), "{:?}", r.gaps);
        assert_eq!(ex.calls().len(), 1 + CAP);
    }
}
