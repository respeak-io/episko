//! Maintenance's backend (docs/maintenance.md): the wire, the compiled-in manifest, detection,
//! `[maintenance]`, the cost gate and the report cache. Rust reads facts; `maint.ts` judges them.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::forge::{Forge, ForgeBy, ForgeKind};
use crate::git::{Hygiene, ReleaseFacts};
use crate::github::{classify, who_for};
use crate::platform::norm_path;

// ---------- the wire ----------

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Facet {
    Ci,
    Security,
    Deps,
    Release,
    Git,
    Prod,
    Work,
}

/// Fixed and closed, in the order every card draws them.
pub(crate) const FACETS: [Facet; 7] =
    [Facet::Ci, Facet::Security, Facet::Deps, Facet::Release, Facet::Git, Facet::Prod, Facet::Work];

impl Facet {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Facet::Ci => "ci",
            Facet::Security => "security",
            Facet::Deps => "deps",
            Facet::Release => "release",
            Facet::Git => "git",
            Facet::Prod => "prod",
            Facet::Work => "work",
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Cost {
    Local,
    Forge,
    Public,
    Tool,
    Remote,
}

impl Cost {
    fn id(self) -> &'static str {
        match self {
            Cost::Local => "local",
            Cost::Forge => "forge",
            Cost::Public => "public",
            Cost::Tool => "tool",
            Cost::Remote => "remote",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Scan,
    Explicit,
}

/// Only `Ok` carries facts; every other state says why there are none, and none of them is green.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Coverage {
    Ok,
    Off { reason: String },
    NoAccess { reason: String, fix: Option<String> },
    NoTool { tool: String, fix: Option<String> },
    Unsupported { reason: String },
    NotRun,
    Error { reason: String },
}

/// One vocabulary for every CI (`maint_ci::norm_status` is the only map into it).
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CiStatus {
    Pass,
    Fail,
    Running,
    Cancelled,
    Skip,
    Neutral,
    Unknown,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CiRun {
    pub(crate) workflow: String,
    pub(crate) status: CiStatus,
    pub(crate) raw: String, // the vendor's own word, beside the normalised one
    pub(crate) sha: String,
    pub(crate) at: Option<u64>,
    pub(crate) url: Option<String>,
}

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Unknown,
}

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AdvisoryKind {
    Dependency,
    Code,
    Secret,
    Config,
}

/// `id` is whatever the reporter calls it (GHSA, CVE, OSV, RUSTSEC); `aliases` lets one CVE
/// from three reporters fold into one row.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Advisory {
    pub(crate) id: String,
    pub(crate) aliases: Vec<String>,
    pub(crate) kind: AdvisoryKind,
    pub(crate) pkg: Option<String>,
    pub(crate) ecosystem: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) severity: Severity,
    pub(crate) raw_severity: String,
    pub(crate) summary: String,
    pub(crate) fixed: Option<String>,
    pub(crate) location: Option<String>,
    pub(crate) url: Option<String>,
    pub(crate) tool: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdatePr {
    pub(crate) number: u64,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) branch: String,
    pub(crate) draft: bool,
    pub(crate) at: Option<u64>, // last updated: a bot rebasing its PRs is a bot still running
    pub(crate) checks: CiStatus,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForgeRelease {
    pub(crate) tag: String,
    pub(crate) name: String,
    pub(crate) at: Option<u64>,
    pub(crate) url: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Probe {
    pub(crate) name: String,
    pub(crate) url: String,
    pub(crate) code: Option<u16>,
    pub(crate) ms: Option<u32>,
    pub(crate) cert_not_after: Option<u64>, // the leaf's; None is unknown, never fine
    pub(crate) err: Option<String>,
}

/// A release cycle's end: a date (unix secs), or the bare yes or no a list gives where it names none.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(untagged)]
pub(crate) enum Eol {
    At(u64),
    Flag(bool),
}

/// One runtime as one file declares it, and the release cycle that version is in.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Runtime {
    pub(crate) product: String, // the list's id: nodejs, postgresql
    pub(crate) name: String,    // as a project calls it: node, postgres
    pub(crate) declared: String,
    pub(crate) cycle: Option<String>, // None: no listed cycle holds the version, so its end is unknown
    pub(crate) eol: Option<Eol>,
    pub(crate) latest: Option<String>, // the newest release in that cycle
    pub(crate) newest: Option<String>, // the newest cycle listed
    pub(crate) file: String,
    pub(crate) url: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum Facts {
    CiRuns { branch: String, runs: Vec<CiRun> },
    Advisories { items: Vec<Advisory> },
    UpdatePrs { bot: String, configured: bool, prs: Vec<UpdatePr>, dashboard: Option<u64> },
    Release(ReleaseFacts),
    Releases { latest: Option<ForgeRelease>, count: u32 },
    Changelog { unreleased: Option<u32>, latest: Option<String>, latest_at: Option<u64> },
    Hygiene(Hygiene),
    Work { issues: u32, prs: u32, review_requested: Option<u32> },
    Probes { items: Vec<Probe> },
    Runtimes { items: Vec<Runtime> },
}

impl Facts {
    /// The one facet each kind may answer; a read that crosses it is an error, never a cell.
    pub(crate) fn facet(&self) -> Facet {
        match self {
            Facts::CiRuns { .. } => Facet::Ci,
            Facts::Advisories { .. } | Facts::Runtimes { .. } => Facet::Security,
            Facts::UpdatePrs { .. } => Facet::Deps,
            Facts::Release(_) | Facts::Releases { .. } | Facts::Changelog { .. } => Facet::Release,
            Facts::Hygiene(_) => Facet::Git,
            Facts::Work { .. } => Facet::Work,
            Facts::Probes { .. } => Facet::Prod,
        }
    }
}

/// `facet` and `cost` are `None` only for an id the manifest does not know.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceReport {
    source: String,
    facet: Option<Facet>,
    cost: Option<Cost>,
    coverage: Coverage,
    at: Option<u64>,       // unix secs the read finished; a cache hit keeps the original
    truncated: bool,       // a list hit its page cap: counts are floors
    gaps: Vec<String>,     // honest partial support
    facts: Option<Facts>,  // Some only when coverage is Ok
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Marker {
    facet: Facet,
    label: String,
    found: Vec<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Detection {
    repo_root: String,
    forge: Forge,
    sources: Vec<String>, // the ids that apply here, in `SOURCES` order
    markers: Vec<Marker>,
    config: MaintConfig,
    deploy: Option<crate::deploy::DeployConfig>, // `[deploy]`, its unsafe values dropped; None without one
}

/// `[maintenance]` as read. A file that exists and does not parse is `readable: false`, so
/// the tips say so instead of quietly applying defaults (`ProtectList.readable`'s rule).
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintConfig {
    readable: bool,
    forge: Option<String>,
    off: Vec<String>,
    sources: BTreeMap<String, Vec<String>>,
    bots: Vec<String>,
    trunk: Option<String>,
    tag_pattern: Option<String>,
    sarif: Vec<String>,
    params: BTreeMap<String, String>,
    thresholds: BTreeMap<String, f64>,
}

impl Default for MaintConfig {
    fn default() -> Self {
        Self {
            readable: true, forge: None, off: vec![], sources: BTreeMap::new(), bots: vec![], trunk: None,
            tag_pattern: None, sarif: vec![], params: BTreeMap::new(), thresholds: BTreeMap::new(),
        }
    }
}

impl MaintConfig {
    pub(crate) fn trunk(&self) -> Option<&str> {
        self.trunk.as_deref()
    }

    pub(crate) fn tag_pattern(&self) -> Option<&str> {
        self.tag_pattern.as_deref()
    }

    /// Self-hosted update-bot logins, beside the manifest's own.
    pub(crate) fn bots(&self) -> &[String] {
        &self.bots
    }

    /// Where the project's scanners leave SARIF, as globs relative to the root.
    pub(crate) fn sarif(&self) -> &[String] {
        &self.sarif
    }

    /// A manifest `needs` entry: the `[maintenance]` key a source reads, which must be set.
    fn has(&self, key: &str) -> bool {
        match key {
            "sarif" => !self.sarif.is_empty(),
            _ => false,
        }
    }
}

// ---------- the manifest ----------

/// The closed capability vocabulary `sees`/`blind` may use; `maint.ts`'s `MAINT_CAPS` mirrors it.
pub(crate) const MAINT_CAPS: &[&str] = &[
    "ci.default-branch", "ci.per-workflow", "ci.failing-since", "ci.disabled", "ci.external", "ci.other-branches",
    "git.unpushed", "git.local-only", "git.merged", "git.gone", "git.branch-age", "git.worktree-age",
    "git.squash-merged", "rel.unreleased", "rel.last", "rel.published", "rel.changelog",
    "sec.dependency", "sec.code", "sec.secret", "sec.runtime", "deps.update-prs", "deps.pr-checks",
    "work.issues", "work.prs", "work.review-requested", "prod.status", "prod.cert", "prod.host",
];

/// The keys a manifest `needs` may name: `[maintenance]`'s, which `MaintConfig::has` reads, and
/// `deploy.urls`, an address in `[deploy]`.
const NEEDS: &[&str] = &["sarif", "deploy.urls"];

fn needs_met(key: &str, cfg: &MaintConfig, deploy: Option<&crate::deploy::DeployConfig>) -> bool {
    match key {
        "deploy.urls" => deploy.is_some_and(|d| !d.targets().is_empty()),
        k => cfg.has(k),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    facets: Vec<FacetDef>,
    sources: BTreeMap<String, SourceMeta>,
    markers: Vec<MarkerDef>,
    bots: Vec<BotDef>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FacetDef {
    id: Facet,
    label: String,
    none: String,
}

#[derive(serde::Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceMeta {
    facet: Facet,
    label: String,
    cost: Cost,
    forge: Vec<String>,  // the forges it can talk to; empty is any
    detect: Vec<String>, // empty applies whenever the forge matches
    #[serde(default)]
    needs: Vec<String>, // `[maintenance]` keys that must be set: a source that reads what config names
    #[serde(default)]
    sends: Option<String>, // what a `public` source sends, which every door to it discloses
    #[serde(default)]
    settings: Option<String>, // the forge page that switches it on, `{path}` the repository's
    #[serde(default)]
    queue: bool, // the dashboard's queue lists its threads, so a Work count opens it
    sees: Vec<String>,
    blind: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MarkerDef {
    facet: Facet,
    label: String,
    forge: Vec<String>,
    detect: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BotDef {
    pub(crate) id: String,
    pub(crate) logins: Vec<String>,
    branch: String,
    dashboard: Option<String>,
    pub(crate) config: Vec<String>, // what says it is set up here: detect entries
}

fn kebab(s: &str) -> bool {
    !s.is_empty() && s.split('-').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

fn well_formed(who: &str, forge: &[String], detect: &[String]) -> Result<(), String> {
    if let Some(f) = forge.iter().find(|f| ForgeKind::from_id(f.strip_prefix('!').unwrap_or(f)).is_none()) {
        return Err(format!("{who}: unknown forge {f:?}"));
    }
    if forge.iter().any(|f| f.starts_with('!')) && !forge.iter().all(|f| f.starts_with('!')) {
        return Err(format!("{who}: a forge list either names forges or excludes them, never both"));
    }
    if let Some(d) = detect.iter().find(|d| d.is_empty() || d.starts_with('/') || d.contains("..") || d.contains('\\')) {
        return Err(format!("{who}: detect entry {d:?} must be a relative path"));
    }
    Ok(())
}

impl Manifest {
    /// Compiled in, so a bad row is a build bug: refused at load, which the registry tests do.
    /// A misspelt capability must fail rather than quietly drop a line from the coverage card.
    fn check(&self) -> Result<(), String> {
        if self.facets.iter().map(|f| f.id).collect::<Vec<_>>() != FACETS {
            return Err("facets must be the seven, in card order".into());
        }
        if let Some(f) = self.facets.iter().find(|f| f.label.is_empty() || f.none.is_empty()) {
            return Err(format!("facet {} needs a label and a none phrase", f.id.id()));
        }
        let mine: BTreeSet<&str> = self.sources.keys().map(String::as_str).collect();
        let reg: BTreeSet<&str> = SOURCES.iter().map(|d| d.id).collect();
        if mine != reg || reg.len() != SOURCES.len() {
            return Err(format!("manifest sources {mine:?} are not SOURCES {reg:?}"));
        }
        for (id, s) in &self.sources {
            if !kebab(id) || s.label.is_empty() {
                return Err(format!("source {id:?} needs a kebab-case id and a label"));
            }
            if let Some(c) = s.sees.iter().chain(&s.blind).find(|c| !MAINT_CAPS.contains(&c.as_str())) {
                return Err(format!("{id}: unknown capability {c:?}"));
            }
            if let Some(n) = s.needs.iter().find(|n| !NEEDS.contains(&n.as_str())) {
                return Err(format!("{id}: needs an unknown [maintenance] key {n:?}"));
            }
            if (s.cost == Cost::Public) != s.sends.as_deref().is_some_and(|x| !x.trim().is_empty()) {
                return Err(format!("{id}: a public source says what it sends, and only a public one"));
            }
            // One page per forge: a source any forge may answer has no single settings page.
            if s.settings.as_deref().is_some_and(|u| !u.starts_with("https://") || !u.contains("{path}") || s.cost != Cost::Forge || s.forge.len() != 1) {
                return Err(format!("{id}: settings is an https page with {{path}}, on a forge source of one forge"));
            }
            if s.queue && s.facet != Facet::Work {
                return Err(format!("{id}: only a work source's threads are in the queue"));
            }
            well_formed(id, &s.forge, &s.detect)?;
        }
        for m in &self.markers {
            // A marker with neither would claim every project on every forge.
            if m.label.is_empty() || (m.forge.is_empty() && m.detect.is_empty()) {
                return Err(format!("marker {:?} needs a label and a forge or a file", m.label));
            }
            well_formed(&m.label, &m.forge, &m.detect)?;
        }
        for b in &self.bots {
            if !kebab(&b.id) || b.logins.is_empty() || b.branch.is_empty() || b.config.is_empty() || b.dashboard.as_deref() == Some("") {
                return Err(format!("bot {:?} needs an id, logins, a branch prefix and config files", b.id));
            }
        }
        Ok(())
    }
}

static MANIFEST: LazyLock<Manifest> = LazyLock::new(|| {
    let m: Manifest = serde_json::from_str(include_str!("../../src/maintmanifest.json"))
        .expect("src/maintmanifest.json must be a valid maintenance manifest");
    if let Err(e) = m.check() {
        panic!("src/maintmanifest.json: {e}");
    }
    m
});

/// The update-bot table `deps::bot_of` reads.
pub(crate) fn bots() -> &'static [BotDef] {
    &MANIFEST.bots
}

fn meta_of(id: &str) -> Option<(&'static SourceMeta, &'static SourceDef)> {
    Some((MANIFEST.sources.get(id)?, SOURCES.iter().find(|d| d.id == id)?))
}

// ---------- [maintenance] ----------

/// Field by field, so one wrong type drops that value and not the table. Only a file that is
/// not TOML at all is unreadable. Nothing here names a binary or an argv: it selects built-ins.
pub(crate) fn parse_maint(text: &str) -> MaintConfig {
    let Ok(doc) = text.parse::<toml::Table>() else {
        return MaintConfig { readable: false, ..Default::default() };
    };
    let Some(t) = doc.get("maintenance").and_then(|v| v.as_table()) else { return MaintConfig::default() };
    let word = |k: &str| t.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let list = |v: Option<&toml::Value>| -> Vec<String> {
        v.and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
            .unwrap_or_default()
    };
    let table = |k: &str| t.get(k).and_then(|v| v.as_table());
    let sources = table("sources").into_iter().flatten()
        .filter(|(k, _)| FACETS.iter().any(|f| f.id() == k.as_str()))
        // A bare word is a list of one; any other wrong shape restricts nothing, never everything.
        .filter_map(|(k, v)| match v {
            toml::Value::String(s) => Some(vec![s.trim().to_string()]).filter(|l| !l[0].is_empty()),
            toml::Value::Array(a) => Some(list(Some(v))).filter(|l| !l.is_empty() || a.is_empty()),
            _ => None,
        }.map(|ids| (k.clone(), ids)))
        .collect();
    // A value with a scheme must be http(s): a param is data a built-in source fetches.
    let params = table("params").into_iter().flatten()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.trim().to_string())))
        .filter(|(_, s)| !s.contains("://") || s.starts_with("https://") || s.starts_with("http://"))
        .collect();
    let thresholds = table("thresholds").into_iter().flatten()
        .filter_map(|(k, v)| v.as_integer().map(|i| i as f64).or_else(|| v.as_float()).map(|n| (k.clone(), n)))
        .collect();
    MaintConfig {
        readable: true,
        forge: word("forge"),
        off: list(t.get("off")),
        sources,
        bots: list(t.get("bots")),
        trunk: word("trunk"),
        tag_pattern: word("tag_pattern"),
        sarif: list(t.get("sarif")),
        params,
        thresholds,
    }
}

/// No file is not a broken one: an unconfigured project reads as readable and empty.
pub(crate) fn read_config(root: &str) -> MaintConfig {
    match read_capped(&Path::new(root).join(".episko").join("episko.toml"), CONFIG_CAP) {
        Ok(text) => parse_maint(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => MaintConfig::default(),
        Err(_) => MaintConfig { readable: false, ..Default::default() },
    }
}

// ---------- [maintenance]'s setup: proposed by an agent, written after Apply ----------

/// The keys an agent proposes and Apply writes; `off`, `sources`, the thresholds and the params
/// stay a person's. An unknown key is refused by serde, never written.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct MaintSetup {
    trunk: Option<String>,
    tag_pattern: Option<String>,
    sarif: Vec<String>,
    bots: Vec<String>,
}

const SETUP_KEYS: &[&str] = &["trunk", "tag_pattern", "sarif", "bots"];

impl MaintSetup {
    fn of(c: &MaintConfig) -> Self {
        Self { trunk: c.trunk.clone(), tag_pattern: c.tag_pattern.clone(), sarif: c.sarif.clone(), bots: c.bots.clone() }
    }
}

/// A SARIF pattern that stays inside the project; `sarif_files` skips any other, as a gap.
pub(crate) fn sarif_inside(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && !p.contains("..") && !p.contains('\\') && !p.contains(':')
}

// One argv word git reads as a branch, not as wildmatch or a revision expression (`@{-1}`, `a..b`).
fn ref_word(v: &str) -> bool {
    let rev = v.contains("@{") || v.contains("..") || v == "@" || v == "HEAD";
    data_arg(v).is_ok() && !rev && !v.contains(['*', '?', '[', ']', '\\', '~', '^', ':'])
}

// `glob_match`'s dialect: `describe --match` would read any other wildcard as wildmatch.
fn tag_glob(v: &str) -> bool {
    data_arg(v).is_ok() && !v.contains(['?', '[', ']', '\\'])
}

fn login(v: &str) -> bool {
    !v.is_empty() && !v.starts_with('-') && v.chars().all(|c| c.is_ascii_alphanumeric() || "-_.[]/".contains(c))
}

/// The values safe to write, trimmed and deduplicated, and one line per value that is not.
fn keep_setup(s: MaintSetup) -> (MaintSetup, Vec<String>) {
    let mut out = vec![];
    let mut said = |ok: bool, line: String| {
        if !ok {
            out.push(line);
        }
        ok
    };
    let word = |v: Option<String>| v.map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
    let trunk = word(s.trunk).filter(|t| said(ref_word(t), format!("trunk = \"{t}\" is not a branch name")));
    let tag_pattern = word(s.tag_pattern).filter(|p| said(tag_glob(p), format!("tag_pattern = \"{p}\" is not a tag glob: * is its only wildcard")));
    let mut list = |v: Vec<String>, ok: fn(&str) -> bool, line: fn(&str) -> String| {
        let mut seen: Vec<String> = vec![];
        for x in v.iter().map(|x| x.trim()).filter(|x| !x.is_empty()) {
            if said(ok(x), line(x)) && !seen.iter().any(|y| y == x) {
                seen.push(x.to_string());
            }
        }
        seen
    };
    let sarif = list(s.sarif, sarif_inside, |p| format!("sarif = \"{p}\" is not a path inside the project"));
    let bots = list(s.bots, login, |b| format!("bots = \"{b}\" is not a login"));
    (MaintSetup { trunk, tag_pattern, sarif, bots }, out)
}

#[tauri::command]
pub(crate) fn maint_setup(dir: String) -> MaintSetup {
    MaintSetup::of(&read_config(&root_key(&dir)))
}

/// Unchecked, so the dialog can say what it left out: `unknown` is every other key the block set.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct MaintProposal {
    maintenance: MaintSetup,
    unknown: Vec<String>,
    why: Vec<String>,
}

fn parse_maint_proposal(out: &str) -> Result<MaintProposal, String> {
    let (block, why) = crate::deploy::fenced(out)?;
    let t = block.parse::<toml::Table>().map_err(|e| format!("the proposal is not valid TOML: {e}"))?;
    let m = t.get("maintenance").and_then(|v| v.as_table()).cloned().unwrap_or_default();
    let word = |k: &str| m.get(k).and_then(|v| v.as_str()).map(String::from);
    // A bare string is a list of one, as `compose` reads in `[deploy]`.
    let list = |k: &str| match m.get(k) {
        Some(toml::Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).map(String::from).collect(),
        Some(v) => v.as_str().map(String::from).into_iter().collect(),
        None => vec![],
    };
    let unknown = m.keys().filter(|k| !SETUP_KEYS.contains(&k.as_str())).cloned().collect();
    let maintenance = MaintSetup { trunk: word("trunk"), tag_pattern: word("tag_pattern"), sarif: list("sarif"), bots: list("bots") };
    Ok(MaintProposal { maintenance, unknown, why })
}

#[tauri::command]
pub(crate) async fn propose_maint(dir: String, prompt: String) -> Result<MaintProposal, String> {
    tauri::async_runtime::spawn_blocking(move || parse_maint_proposal(&crate::deploy::propose_toml(&dir, &prompt)?))
        .await
        .map_err(|e| e.to_string())?
}

/// Only a key whose value changed is replaced, so a hand-written value keeps its comment, and the
/// keys a person owns (`off`, the subtables) are never touched. `old` is the table as read.
fn set_setup(doc: &mut toml_edit::DocumentMut, old: &MaintSetup, s: &MaintSetup) -> Result<(), String> {
    if doc.get("maintenance").is_some_and(|i| !i.is_table_like()) {
        return Err("maintenance in .episko/episko.toml is not a table".into());
    }
    if old == s {
        return Ok(()); // nothing to write, so not even the header is touched
    }
    if doc.get("maintenance").is_none() {
        doc["maintenance"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let t = doc["maintenance"].as_table_like_mut().ok_or("maintenance is not a table")?;
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
    let list = |v: &[String]| (!v.is_empty()).then(|| toml_edit::value(v.iter().map(String::as_str).collect::<toml_edit::Array>()));
    put("trunk", old.trunk == s.trunk, word(&s.trunk));
    put("tag_pattern", old.tag_pattern == s.tag_pattern, word(&s.tag_pattern));
    put("sarif", old.sarif == s.sarif, list(&s.sarif));
    put("bots", old.bots == s.bots, list(&s.bots));
    let (empty, bare) = (t.is_empty(), t.iter().all(|(_, v)| v.is_table()));
    if empty {
        doc.remove("maintenance"); // an emptied table must not leave a bare header behind
    } else if let Some(table) = doc["maintenance"].as_table_mut() {
        // Only `[maintenance.thresholds]` left: no empty header above it, unless a comment rides on it.
        let noted = [table.decor().prefix(), table.decor().suffix()].iter().any(|r| r.and_then(|r| r.as_str()).is_some_and(|x| x.contains('#')));
        table.set_implicit(bare && !noted);
    }
    Ok(())
}

/// Reads degrade, writes fail loudly: an unsafe value is refused and named, never dropped.
#[tauri::command]
pub(crate) fn write_maint(dir: String, maintenance: MaintSetup, create: bool) -> Result<(), String> {
    let (s, refused) = keep_setup(maintenance);
    if !refused.is_empty() {
        return Err(refused.join("; "));
    }
    let wrote = crate::deploy::edit_toml(&dir, create, |text, doc| set_setup(doc, &MaintSetup::of(&parse_maint(text)), &s))?;
    if wrote {
        // Every key here feeds a cached read (trunk, tags, SARIF, the bots' PRs), so Apply must show.
        let key = root_key(&dir);
        invalidate(&key);
        crate::deps::dep_invalidate(key);
    }
    Ok(())
}

fn facet_off(cfg: &MaintConfig, facet: Facet) -> bool {
    cfg.off.iter().any(|o| o == facet.id())
}

fn enabled(cfg: &MaintConfig, id: &str, facet: Facet) -> bool {
    let picked = cfg.sources.get(facet.id()).is_none_or(|ids| ids.iter().any(|i| i == id));
    !facet_off(cfg, facet) && !cfg.off.iter().any(|o| o == id) && picked
}

// ---------- detection ----------

pub(crate) const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "venv", "__pycache__"];
const JSON_CAP: u64 = 2 * 1024 * 1024;
pub(crate) const CONFIG_CAP: u64 = 1024 * 1024;
const DETECT_TTL: Duration = Duration::from_secs(30);

/// A project file, refused unless its target is a regular file and bounded by the read itself:
/// a symlink to `/dev/zero` reports length 0 and never ends, and opening a FIFO blocks.
pub(crate) fn read_capped(path: &Path, cap: u64) -> std::io::Result<String> {
    use std::io::{Error, Read};
    let regular = |m: std::fs::Metadata| if m.is_file() { Ok(()) } else { Err(Error::other("not a regular file")) };
    regular(std::fs::metadata(path)?)?;
    let f = std::fs::File::open(path)?;
    regular(f.metadata()?)?;
    let mut buf = Vec::new();
    f.take(cap + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > cap {
        return Err(Error::other("too large to read"));
    }
    decode(buf).ok_or_else(|| Error::new(std::io::ErrorKind::InvalidData, "not UTF-8 text"))
}

/// UTF-8 with its BOM dropped, or UTF-16 behind one: Windows PowerShell 5.1's `echo 14 > .nvmrc`.
fn decode(buf: Vec<u8>) -> Option<String> {
    let utf16 = |be: bool| {
        let body = buf.get(2..).filter(|b| b.len() % 2 == 0)?;
        let units: Vec<u16> = body.as_chunks::<2>().0.iter().map(|&c| if be { u16::from_be_bytes(c) } else { u16::from_le_bytes(c) }).collect();
        String::from_utf16(&units).ok()
    };
    match buf.get(..2) {
        Some([0xFF, 0xFE]) => utf16(false),
        Some([0xFE, 0xFF]) => utf16(true),
        _ => String::from_utf8(buf).ok().map(|s| s.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(s)),
    }
}

fn present(p: &Path, dir: bool, key: Option<&str>) -> bool {
    if dir {
        return std::fs::read_dir(p).is_ok_and(|mut d| d.next().is_some());
    }
    let Some(key) = key else { return p.exists() }; // `.git` is a folder, or a file in a worktree
    read_capped(p, JSON_CAP).ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|v| v.get(key).is_some())
}

/// Each `detect` entry found under `root`, with where. A trailing `/` wants a non-empty
/// directory and `file#key` a top-level JSON key. An entry with a `/` or a leading `.` is
/// anchored at the root; a bare name is also looked for one level down, outside `SKIP_DIRS`.
fn probe(root: &Path, entries: &BTreeSet<&str>) -> BTreeMap<String, Vec<String>> {
    let mut subdirs: Vec<String> = std::fs::read_dir(root).into_iter().flatten().flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.') && !SKIP_DIRS.contains(&n.as_str()))
        .collect();
    subdirs.sort();
    let mut out = BTreeMap::new();
    for entry in entries {
        let (path, key) = match entry.split_once('#') {
            Some((p, k)) => (p, Some(k)),
            None => (*entry, None),
        };
        let anchored = path.contains('/') || path.starts_with('.');
        let bases = std::iter::once("").chain(subdirs.iter().map(String::as_str).filter(|_| !anchored));
        let found: Vec<String> = bases
            .map(|b| if b.is_empty() { path.to_string() } else { format!("{b}/{path}") })
            .filter(|rel| present(&root.join(rel.trim_end_matches('/')), path.ends_with('/'), key))
            .map(|rel| key.map_or(rel.clone(), |k| format!("{rel}#{k}")))
            .collect();
        if !found.is_empty() {
            out.insert(entry.to_string(), found);
        }
    }
    out
}

/// Whether a manifest `forge` list admits `kind`: empty is any forge, `!x` is any but x.
fn forge_admits(forge: &[String], kind: ForgeKind) -> bool {
    let not = forge.iter().any(|f| f.starts_with('!'));
    forge.is_empty() || (forge.iter().any(|f| f.strip_prefix('!').unwrap_or(f) == kind.id()) != not)
}

/// Whether any of these detect entries is present under `root`, by `probe`'s own rules.
pub(crate) fn found_any(root: &str, entries: &[String]) -> bool {
    !found_paths(root, entries).is_empty()
}

/// Where each of these detect entries was found under `root`, relative and `/`-separated.
pub(crate) fn found_paths<S: AsRef<str>>(root: &str, entries: &[S]) -> Vec<String> {
    probe(Path::new(root), &entries.iter().map(AsRef::as_ref).collect()).into_values().flatten().collect()
}

fn applies(forge: &[String], detect: &[String], kind: ForgeKind, probes: &BTreeMap<String, Vec<String>>) -> Option<Vec<String>> {
    if !forge_admits(forge, kind) {
        return None;
    }
    let found: Vec<String> = detect.iter().filter_map(|d| probes.get(d)).flatten().cloned().collect();
    (detect.is_empty() || !found.is_empty()).then_some(found)
}

/// Reads the remote, the files and `.episko/episko.toml`; spawns nothing `project_facts` does not.
fn detect_now(root: &str) -> Detection {
    let facts = crate::git::project_facts(root.to_string());
    let repo_root = facts.root.clone().unwrap_or_else(|| norm_path(root));
    let config = read_config(&repo_root);
    // The remote the git sources measure against: origin, else the first one listed.
    let url = facts.origin.clone().or_else(|| facts.root.as_deref().and_then(crate::git::primary_remote_url));
    let forge = crate::forge::forge_of(url.as_deref(), config.forge.as_deref());
    let entries: BTreeSet<&str> = MANIFEST.sources.values().flat_map(|s| &s.detect)
        .chain(MANIFEST.markers.iter().flat_map(|m| &m.detect))
        .map(String::as_str)
        .collect();
    let probes = probe(Path::new(&repo_root), &entries);
    let deploy = crate::deploy::read(&repo_root);
    let sources: Vec<String> = SOURCES.iter()
        .filter(|d| {
            let m = &MANIFEST.sources[d.id];
            applies(&m.forge, &m.detect, forge.kind, &probes).is_some()
                && m.needs.iter().all(|n| needs_met(n, &config, deploy.as_ref()))
                && enabled(&config, d.id, m.facet)
        })
        .map(|d| d.id.to_string())
        .collect();
    let host = forge.host.clone().unwrap_or_else(|| "this host".into());
    let mut markers: Vec<Marker> = MANIFEST.markers.iter()
        .filter(|m| !facet_off(&config, m.facet))
        .filter_map(|m| {
            applies(&m.forge, &m.detect, forge.kind, &probes)
                .map(|found| Marker { facet: m.facet, label: m.label.replace("{host}", &host), found })
        })
        .collect();
    // A table nothing reads yet must not be drawn as "no deploy": it is found, and said so.
    let prod_read = sources.iter().any(|id| MANIFEST.sources[id.as_str()].facet == Facet::Prod);
    if deploy.is_some() && !prod_read && !facet_off(&config, Facet::Prod) {
        markers.push(Marker { facet: Facet::Prod, label: "[deploy]".into(), found: vec![".episko/episko.toml".into()] });
    }
    Detection { repo_root, forge, sources, markers, config, deploy }
}

type Cache<K, V> = Mutex<Option<HashMap<K, (Instant, V)>>>;
static DETECTIONS: Cache<String, Detection> = Mutex::new(None);

pub(crate) fn root_key(root: &str) -> String {
    crate::git::repo_root_of(root).unwrap_or_else(|| norm_path(root))
}

/// Cached per repo root for `DETECT_TTL`, so `maint_read`'s applicability check does not walk
/// the tree once per source. Worktrees collapse to the repo: a card is one per project.
pub(crate) fn detect(root: &str, force: bool) -> Detection {
    let key = root_key(root);
    if !force {
        if let Some((at, d)) = DETECTIONS.lock().ok().and_then(|g| g.as_ref()?.get(&key).cloned()) {
            if at.elapsed() < DETECT_TTL {
                return d;
            }
        }
    }
    let d = detect_now(&key);
    if let Ok(mut g) = DETECTIONS.lock() {
        g.get_or_insert_with(HashMap::new).insert(key, (Instant::now(), d.clone()));
    }
    d
}

/// A `[deploy]` write's: the next detection reads the file again, while every report stays cached.
pub(crate) fn forget_detection(root: &str) {
    if let Ok(mut g) = DETECTIONS.lock() {
        if let Some(m) = g.as_mut() {
            m.remove(&root_key(root));
        }
    }
}

// ---------- Exec: the only side-effect seam ----------

pub(crate) use exec::{data_arg, Exec, SysExec};

pub(crate) mod exec {
    #![allow(dead_code, reason = "ssh and a token's http are called by the adapters of later slices")]

    use std::time::Duration;

    use super::Cost;
    use crate::platform::{augmented_path, kill_pid_tree, sys_command};

    /// What a program left behind. A non-zero exit is data, as `run_capped` says.
    #[derive(Clone, Debug, Default, PartialEq)]
    pub(crate) struct Output {
        pub(crate) code: Option<i32>,
        pub(crate) stdout: String,
        pub(crate) stderr: String,
    }

    impl From<std::process::Output> for Output {
        fn from(o: std::process::Output) -> Self {
            Self {
                code: o.status.code(),
                stdout: String::from_utf8_lossy(&o.stdout).to_string(),
                stderr: String::from_utf8_lossy(&o.stderr).to_string(),
            }
        }
    }

    /// GET without a body, POST with one. `token` is `(header prefix, env name)`: the value goes
    /// to curl on stdin, never on argv, and only a name on `ENV_TOKENS` is ever read. `report`
    /// sends nothing and answers curl's own `%{json}` then `%{certs}` as the body, with `code` 0.
    pub(crate) struct HttpReq {
        pub(crate) url: String,
        pub(crate) body: Option<String>,
        pub(crate) token: Option<(&'static str, &'static str)>,
        pub(crate) secs: u64,
        pub(crate) report: bool,
    }

    #[derive(Debug)]
    pub(crate) struct HttpResp {
        pub(crate) code: u16,
        pub(crate) body: String,
    }

    pub(crate) trait Exec: Sync {
        fn gh(&self, root: &str, account: Option<&str>, args: &[&str]) -> Result<String, String>;
        /// `gh api graphql`, keeping a `data` that arrived beside `errors[]` (`github::gh_capped`).
        fn gh_graphql(&self, root: &str, account: Option<&str>, args: &[&str]) -> Result<String, String> {
            self.gh(root, account, args)
        }
        fn glab(&self, root: &str, args: &[&str]) -> Result<String, String>;
        fn tool(&self, root: &str, bin: &str, args: &[&str], secs: u64) -> Result<Output, String>;
        fn http(&self, req: &HttpReq) -> Result<HttpResp, String>;
        fn ssh(&self, alias: &str, script: &str, secs: u64) -> Result<Output, String>;
        fn on_path(&self, bin: &str) -> bool;
    }

    /// What each cost class may start. `SysExec` enforces it, so no call site has to remember.
    pub(crate) const TRUSTED_BINS: &[(Cost, &[&str])] = &[
        (Cost::Local, &[]),
        (Cost::Forge, &["gh", "glab"]),
        (Cost::Public, &["curl"]),
        (Cost::Tool, &["npm", "pnpm", "cargo-audit"]),
        (Cost::Remote, &["curl", "ssh"]),
    ];

    pub(crate) fn trusted(cost: Cost, bin: &str) -> bool {
        TRUSTED_BINS.iter().any(|(c, bins)| *c == cost && bins.contains(&bin))
    }

    /// Env names a source may read a token from; none until an adapter needs one.
    const ENV_TOKENS: &[&str] = &[];

    #[cfg(windows)]
    const CURL: &str = r"C:\Windows\System32\curl.exe";
    #[cfg(not(windows))]
    const CURL: &str = "/usr/bin/curl";
    #[cfg(windows)]
    pub(crate) const NULL_DEV: &str = "NUL";
    #[cfg(not(windows))]
    pub(crate) const NULL_DEV: &str = "/dev/null";

    /// A probe: the body is thrown away, and a failed transfer is still a report, since `%{json}`
    /// carries curl's exit code and message. `-g`: a `[1-9]` in a committed URL is one address.
    pub(crate) fn report_cmd(req: &HttpReq) -> Result<std::process::Command, String> {
        if req.body.is_some() || req.token.is_some() {
            return Err("a report sends nothing".into());
        }
        let mut cmd = sys_command(CURL);
        cmd.args(["-sSg", "-o", NULL_DEV, "--max-time"]).arg(req.secs.to_string());
        cmd.args(["-w", r"%{json}\n%{certs}"]).arg(&req.url);
        Ok(cmd)
    }

    fn report(req: &HttpReq) -> Result<HttpResp, String> {
        let out = run_fed(report_cmd(req)?, None, req.secs + 5)?;
        if out.stdout.trim().is_empty() {
            return Err(format!("curl printed no report: {}", out.stderr.trim()));
        }
        Ok(HttpResp { code: 0, body: out.stdout })
    }

    /// A value from data on argv: one whole element, never a flag (`ssh_hostname`'s rule).
    pub(crate) fn data_arg(v: &str) -> Result<&str, String> {
        if v.is_empty() || v.starts_with('-') || v.contains(char::is_whitespace) {
            return Err(format!("{v:?} is not a safe argument"));
        }
        Ok(v)
    }

    /// `run_capped` with stdin fed, for what must not ride on argv: a token, a script.
    fn run_fed(mut cmd: std::process::Command, input: Option<String>, secs: u64) -> Result<Output, String> {
        use std::io::Write;
        use std::process::Stdio;
        let Some(text) = input else { return crate::deps::run_capped(cmd, secs).map(Output::from) };
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        if let Some(mut pipe) = child.stdin.take() {
            std::thread::spawn(move || {
                let _ = pipe.write_all(text.as_bytes());
            });
        }
        let pid = child.id();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        match rx.recv_timeout(Duration::from_secs(secs)) {
            Ok(r) => r.map(Output::from).map_err(|e| e.to_string()),
            Err(_) => {
                kill_pid_tree(pid);
                Err(format!("no answer after {secs}s"))
            }
        }
    }

    #[cfg(windows)]
    const BIN_EXTS: &[&str] = &[".com", ".exe", ".bat", ".cmd"]; // PATHEXT's default order
    #[cfg(not(windows))]
    const BIN_EXTS: &[&str] = &[""];

    /// `bin` in `path`'s absolute folders only: cmd.exe, and a bare name on Windows, look in the
    /// current folder first, where a cloned repository can plant its own `npm.cmd`.
    pub(crate) fn resolve_bin(bin: &str, path: &str) -> Option<std::path::PathBuf> {
        std::env::split_paths(path).filter(|d| d.is_absolute())
            .find_map(|d| BIN_EXTS.iter().map(|e| d.join(format!("{bin}{e}"))).find(|p| p.is_file()))
    }

    /// The resolved file itself; std runs a `.cmd` shim through cmd.exe with its own escaping, and
    /// no argument may carry what cmd.exe would read as syntax anyway.
    pub(crate) fn tool_cmd(bin: &str, args: &[&str], path: &str) -> Result<std::process::Command, String> {
        if let Some(a) = args.iter().find(|a| a.contains(['&', '|', '<', '>', '^', '%', '"', '\n'])) {
            return Err(format!("{a:?} is not a safe argument"));
        }
        let file = resolve_bin(bin, path).ok_or_else(|| format!("{bin} is not on PATH"))?;
        let mut cmd = sys_command(&file);
        // A shim's own `node` lookup would otherwise try the project's folder first.
        #[cfg(windows)]
        cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
        // npm.cmd runs `<prefix>\node_modules\npm\bin\npm-cli.js` when one exists, and a project's
        // `.npmrc` may name the prefix; env outranks it, and this folder's is the shim's own npm.
        #[cfg(windows)]
        if bin == "npm" {
            if let Some(dir) = file.parent() {
                cmd.env("npm_config_prefix", dir);
            }
        }
        // The child searches what `resolve_bin` did: a relative or empty entry is the project.
        let safe = std::env::join_paths(std::env::split_paths(path).filter(|d| d.is_absolute())).map_err(|e| e.to_string())?;
        cmd.env("PATH", safe).args(args);
        Ok(cmd)
    }

    /// curl's `-w` trailer is the status. A failed transfer still prints `000`, so a non-zero
    /// exit is curl's own error (DNS, refused, timeout), never an HTTP answer.
    pub(crate) fn http_answer(out: Output) -> Result<HttpResp, String> {
        let (body, code) = out.stdout.rsplit_once('\n').unwrap_or(("", out.stdout.as_str()));
        let code: u16 = code.trim().parse().unwrap_or(0);
        if code == 0 || out.code != Some(0) {
            let e = out.stderr.trim();
            return Err(if e.is_empty() { "no HTTP answer".into() } else { e.to_string() });
        }
        Ok(HttpResp { code, body: body.to_string() })
    }

    /// The real seam, made per read with that source's cost.
    pub(crate) struct SysExec {
        pub(crate) cost: Cost,
    }

    impl SysExec {
        fn trust(&self, bin: &str) -> Result<(), String> {
            if trusted(self.cost, bin) {
                Ok(())
            } else {
                Err(format!("{bin} is not trusted for a {} source", self.cost.id()))
            }
        }
    }

    impl Exec for SysExec {
        fn gh(&self, root: &str, account: Option<&str>, args: &[&str]) -> Result<String, String> {
            self.trust("gh")?;
            crate::github::gh_capped(root, account, args, false)
        }

        fn gh_graphql(&self, root: &str, account: Option<&str>, args: &[&str]) -> Result<String, String> {
            self.trust("gh")?;
            crate::github::gh_capped(root, account, args, true)
        }

        fn glab(&self, root: &str, args: &[&str]) -> Result<String, String> {
            self.trust("glab")?;
            crate::forge::glab(root, args)
        }

        fn tool(&self, root: &str, bin: &str, args: &[&str], secs: u64) -> Result<Output, String> {
            self.trust(bin)?;
            let mut cmd = tool_cmd(bin, args, &augmented_path())?;
            cmd.current_dir(root).env("NO_COLOR", "1").env("CI", "1");
            crate::deps::run_capped(cmd, secs).map(Output::from)
        }

        fn http(&self, req: &HttpReq) -> Result<HttpResp, String> {
            self.trust("curl")?;
            let scheme = req.url.get(..8).unwrap_or(&req.url).to_ascii_lowercase();
            if !(scheme.starts_with("https://") || scheme.starts_with("http://")) {
                return Err(format!("{} is not an http(s) URL", req.url));
            }
            if req.report {
                return report(req);
            }
            let mut cmd = sys_command(CURL);
            cmd.args(["-sSg", "-w", "\n%{http_code}", "--max-time"]).arg(req.secs.to_string());
            let mut input = None;
            if let Some((head, env)) = req.token {
                if !ENV_TOKENS.contains(&env) {
                    return Err(format!("{env} is not a token Episko reads"));
                }
                let v = std::env::var(env).map_err(|_| format!("{env}: token not visible to Episko"))?;
                cmd.args(["-H", "@-"]);
                input = Some(format!("{head}{v}\n"));
            }
            if let Some(body) = &req.body {
                if input.is_some() {
                    return Err("a token and a body cannot share curl's stdin".into());
                }
                cmd.args(["-H", "Content-Type: application/json", "--data-binary", "@-"]);
                input = Some(body.clone());
            }
            cmd.arg(&req.url);
            http_answer(run_fed(cmd, input, req.secs + 5)?)
        }

        fn ssh(&self, alias: &str, script: &str, secs: u64) -> Result<Output, String> {
            self.trust("ssh")?;
            let alias = data_arg(alias)?;
            let mut cmd = sys_command("ssh");
            cmd.env("PATH", augmented_path()).args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", alias, "sh", "-s"]);
            run_fed(cmd, Some(script.to_string()), secs)
        }

        fn on_path(&self, bin: &str) -> bool {
            resolve_bin(bin, &augmented_path()).is_some()
        }
    }

    /// Answers argv prefixes from fixed text or `src-tauri/testdata/maint/`, and records every
    /// call, with the account each `gh` ran as.
    #[cfg(test)]
    pub(crate) struct FakeExec {
        answers: Vec<(Vec<String>, Result<String, String>)>,
        fallback: Result<String, String>,
        calls: std::sync::Mutex<Vec<Vec<String>>>,
        accounts: std::sync::Mutex<Vec<Option<String>>>,
        gate: Option<std::sync::Arc<std::sync::Mutex<()>>>,
        exit: (i32, String),  // what every `tool` exits with, and its stderr
        missing: Vec<String>, // bins `on_path` cannot find
        fail_in: Option<(String, String)>, // a `tool` run in a folder ending so fails with this
    }

    #[cfg(test)]
    impl FakeExec {
        pub(crate) fn answering(fallback: Result<&str, &str>) -> Self {
            let fallback = fallback.map(str::to_string).map_err(str::to_string);
            Self {
                answers: vec![], fallback, calls: Default::default(), accounts: Default::default(), gate: None,
                exit: (0, String::new()), missing: vec![], fail_in: None,
            }
        }

        /// Holds every `gh` until the test drops its guard on `gate`, so readers provably overlap.
        pub(crate) fn gated(self, gate: std::sync::Arc<std::sync::Mutex<()>>) -> Self {
            Self { gate: Some(gate), ..self }
        }

        pub(crate) fn testdata(file: &str) -> String {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata").join("maint").join(file);
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        }

        pub(crate) fn recorded(file: &str) -> Self {
            Self { fallback: Ok(Self::testdata(file)), ..Self::answering(Ok("")) }
        }

        /// Answers a call whose argv starts with `prefix`; the first matching rule wins.
        pub(crate) fn on(mut self, prefix: &[&str], answer: Result<&str, &str>) -> Self {
            let answer = answer.map(str::to_string).map_err(str::to_string);
            self.answers.push((prefix.iter().map(|s| s.to_string()).collect(), answer));
            self
        }

        /// Every `tool` exits with `code` and prints `stderr`, beside whatever answers its stdout.
        pub(crate) fn exiting(self, code: i32, stderr: &str) -> Self {
            Self { exit: (code, stderr.to_string()), ..self }
        }

        pub(crate) fn failing_in(self, dir: &str, err: &str) -> Self {
            Self { fail_in: Some((dir.to_string(), err.to_string())), ..self }
        }

        pub(crate) fn without(self, bins: &[&str]) -> Self {
            Self { missing: bins.iter().map(|b| b.to_string()).collect(), ..self }
        }

        pub(crate) fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }

        pub(crate) fn gh_accounts(&self) -> Vec<Option<String>> {
            self.accounts.lock().unwrap().clone()
        }

        fn answer(&self, argv: Vec<String>) -> Result<String, String> {
            let hit = self.answers.iter().find(|(p, _)| argv.starts_with(p)).map(|(_, a)| a.clone());
            self.calls.lock().unwrap().push(argv);
            hit.unwrap_or_else(|| self.fallback.clone())
        }

        fn argv(bin: &str, args: &[&str]) -> Vec<String> {
            std::iter::once(bin).chain(args.iter().copied()).map(str::to_string).collect()
        }
    }

    #[cfg(test)]
    impl Exec for FakeExec {
        fn gh(&self, _root: &str, account: Option<&str>, args: &[&str]) -> Result<String, String> {
            if let Some(g) = &self.gate {
                drop(g.lock());
            }
            self.accounts.lock().unwrap().push(account.map(str::to_string));
            self.answer(Self::argv("gh", args))
        }
        fn glab(&self, _root: &str, args: &[&str]) -> Result<String, String> {
            self.answer(Self::argv("glab", args))
        }
        fn tool(&self, root: &str, bin: &str, args: &[&str], _secs: u64) -> Result<Output, String> {
            if let Some((_, err)) = self.fail_in.as_ref().filter(|(d, _)| root.ends_with(d.as_str())) {
                self.calls.lock().unwrap().push(Self::argv(bin, args));
                return Err(err.clone());
            }
            let (code, stderr) = self.exit.clone();
            self.answer(Self::argv(bin, args)).map(|stdout| Output { code: Some(code), stdout, stderr })
        }
        fn http(&self, req: &HttpReq) -> Result<HttpResp, String> {
            let mode: &[&str] = match (&req.body, req.report) {
                (_, true) => &["--report"],
                (Some(b), _) => &["--data", b],
                _ => &[],
            };
            self.answer(Self::argv("curl", &[&[req.url.as_str()][..], mode].concat())).map(|body| HttpResp { code: 200, body })
        }
        fn ssh(&self, alias: &str, _script: &str, _secs: u64) -> Result<Output, String> {
            self.answer(Self::argv("ssh", &[alias])).map(|stdout| Output { code: Some(0), stdout, stderr: String::new() })
        }
        fn on_path(&self, bin: &str) -> bool {
            !self.missing.iter().any(|m| m == bin)
        }
    }
}

// ---------- the registry, the gate and the cache ----------

/// What a read gets besides its `Exec`. `account` is the project's GitHub pin, passed to every `gh`;
/// `force` reaches past a cache the read shares with another surface (`deps.rs`'s).
pub(crate) struct Ctx<'a> {
    pub(crate) root: &'a str,
    pub(crate) cfg: &'a MaintConfig,
    pub(crate) forge: &'a Forge,
    pub(crate) account: Option<&'a str>,
    pub(crate) force: bool,
}

pub(crate) struct Read {
    pub(crate) facts: Facts,
    pub(crate) truncated: bool,
    pub(crate) gaps: Vec<String>,
}

impl Read {
    pub(crate) fn of(facts: Facts) -> Self {
        Self { facts, truncated: false, gaps: vec![] }
    }
}

pub(crate) type ReadFn = fn(&Ctx, &dyn Exec) -> Result<Read, Coverage>;

pub(crate) struct SourceDef {
    pub(crate) id: &'static str,
    pub(crate) read: ReadFn,
}

/// One row per manifest source; a marker has no row until it is promoted (docs/maintenance.md).
pub(crate) static SOURCES: &[SourceDef] = &[
    SourceDef { id: "github-actions", read: crate::maint_ci::github_actions },
    SourceDef { id: "forge-commit-status", read: crate::maint_ci::forge_commit_status },
    SourceDef { id: "gitlab-ci", read: crate::maint_ci::gitlab_ci },
    SourceDef { id: "dependabot-alerts", read: crate::maint_sec::dependabot_alerts },
    SourceDef { id: "github-code-scanning", read: crate::maint_sec::gh_code_scanning },
    SourceDef { id: "github-secret-scanning", read: crate::maint_sec::gh_secret_scanning },
    SourceDef { id: "sarif-files", read: crate::maint_sec::sarif_files },
    SourceDef { id: "osv", read: crate::maint_sec::osv },
    SourceDef { id: "npm-audit", read: crate::maint_sec::npm_audit },
    SourceDef { id: "pnpm-audit", read: crate::maint_sec::pnpm_audit },
    SourceDef { id: "cargo-audit", read: crate::maint_sec::cargo_audit },
    SourceDef { id: "runtime-eol", read: crate::maint_eol::runtime_eol },
    SourceDef { id: "dependabot-prs", read: crate::maint_repo::dependabot_prs },
    SourceDef { id: "renovate-prs", read: crate::maint_repo::renovate_prs },
    SourceDef { id: "git-local", read: crate::maint_git::git_local },
    SourceDef { id: "git-tags", read: crate::maint_git::git_tags },
    SourceDef { id: "changelog", read: crate::maint_git::changelog },
    SourceDef { id: "github-releases", read: crate::maint_repo::github_releases },
    SourceDef { id: "github-work", read: crate::maint_repo::github_work },
    SourceDef { id: "gitlab-work", read: crate::maint_repo::gitlab_work },
    SourceDef { id: "http-probe", read: crate::deploy::http_probe },
];

/// The cost classes, enforced here rather than at a call site: a scan never runs a program in
/// the project or touches the user's infrastructure, and sends nothing public without the opt-in.
pub(crate) fn permitted(cost: Cost, mode: Mode, public: bool) -> bool {
    match cost {
        Cost::Local | Cost::Forge => true,
        Cost::Public => mode == Mode::Explicit || public,
        Cost::Tool | Cost::Remote => mode == Mode::Explicit,
    }
}

fn ttl(cost: Cost) -> Duration {
    Duration::from_secs(match cost {
        Cost::Local => 60,
        Cost::Forge => 600,
        Cost::Public => 6 * 3600,
        Cost::Tool | Cost::Remote => 24 * 3600,
    })
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn report(id: &str, meta: Option<&SourceMeta>, coverage: Coverage) -> SourceReport {
    SourceReport {
        source: id.to_string(),
        facet: meta.map(|m| m.facet),
        cost: meta.map(|m| m.cost),
        coverage,
        at: None,
        truncated: false,
        gaps: vec![],
        facts: None,
    }
}

fn run(id: &str, meta: &SourceMeta, read: ReadFn, ctx: &Ctx, ex: &dyn Exec) -> SourceReport {
    let mut rep = report(id, Some(meta), Coverage::Ok);
    match read(ctx, ex) {
        Ok(r) if r.facts.facet() == meta.facet => {
            (rep.truncated, rep.gaps, rep.facts) = (r.truncated, r.gaps, Some(r.facts));
        }
        Ok(r) => {
            let reason = format!("a {} source answered {} facts", meta.facet.id(), r.facts.facet().id());
            rep.coverage = Coverage::Error { reason };
        }
        Err(Coverage::Ok) => rep.coverage = Coverage::Error { reason: "answered ok with no facts".into() },
        Err(c) => rep.coverage = c,
    }
    rep.at = Some(now_secs());
    rep
}

type Key = (String, String, String);
static REPORTS: Cache<Key, SourceReport> = Mutex::new(None);

/// Keyed by account as well as root, so a reader that bypassed an invalidation still cannot
/// serve one identity's answer to another. A refused class still shows its last explicit run.
#[allow(clippy::too_many_arguments)]
fn read_cached(root: &str, id: &str, meta: &SourceMeta, read: ReadFn, ctx: &Ctx, ex: &dyn Exec, mode: Mode, public: bool, force: bool, account: Option<&str>) -> SourceReport {
    let key = (root.to_string(), id.to_string(), account.unwrap_or("").to_string());
    let cached = REPORTS.lock().ok()
        .and_then(|g| g.as_ref()?.get(&key).cloned())
        .filter(|(at, _)| at.elapsed() < ttl(meta.cost))
        .map(|(_, r)| r);
    if !permitted(meta.cost, mode, public) {
        return cached.unwrap_or_else(|| report(id, Some(meta), Coverage::NotRun));
    }
    if let Some(hit) = cached.filter(|_| !force) {
        return hit;
    }
    let rep = run(id, meta, read, ctx, ex);
    if let Ok(mut g) = REPORTS.lock() {
        g.get_or_insert_with(HashMap::new).insert(key, (Instant::now(), rep.clone()));
    }
    rep
}

fn read_source(root: &str, id: &str, mode: Mode, public: bool, force: bool, account: Option<&str>) -> SourceReport {
    let Some((meta, def)) = meta_of(id) else {
        return report(id, None, Coverage::Error { reason: format!("{id} is not a maintenance source") });
    };
    // A frontend list can be stale; a source that no longer applies must not run.
    let det = detect(root, false);
    if !det.sources.iter().any(|s| s == id) {
        let reason = if !enabled(&det.config, id, meta.facet) {
            "switched off in .episko/episko.toml"
        } else {
            "not detected in this project"
        };
        return report(id, Some(meta), Coverage::Unsupported { reason: reason.into() });
    }
    let ctx = Ctx { root: &det.repo_root, cfg: &det.config, forge: &det.forge, account, force };
    read_cached(&det.repo_root, id, meta, def.read, &ctx, &SysExec { cost: meta.cost }, mode, public, force, account)
}

fn invalidate(key: &str) {
    if let Ok(mut g) = DETECTIONS.lock() {
        if let Some(m) = g.as_mut() {
            m.remove(key);
        }
    }
    if let Ok(mut g) = REPORTS.lock() {
        if let Some(m) = g.as_mut() {
            m.retain(|(root, _, _), _| root != key);
        }
    }
}

// ---------- forge errors ----------

/// A `gh` failure as a coverage: a missing or signed-out CLI and an account that cannot see the
/// repository each carry their fix; anything else is the reason verbatim.
pub(crate) fn gh_coverage(err: &str, account: Option<&str>) -> Coverage {
    let e = err.to_lowercase();
    let pick = Some("pick the GitHub account that can see it from the project menu".to_string());
    if e.contains("is not logged in as") {
        return Coverage::NoAccess { reason: err.to_string(), fix: Some("gh auth login".into()) };
    }
    // A private repository answers 404 to an account that may not see it.
    if e.contains("could not resolve to a repository") || e.contains("http 404") {
        let reason = classify("could not resolve to a repository", who_for(account).as_deref());
        return Coverage::NoAccess { reason, fix: pick };
    }
    // Before `classify`, whose "token" match would send an SSO or PAT refusal to `gh auth login`.
    if e.contains("http 403") && !e.contains("rate limit") {
        return Coverage::NoAccess { reason: err.to_string(), fix: pick };
    }
    let said = classify(err, who_for(account).as_deref());
    if said == "GitHub CLI (gh) is not installed" {
        return Coverage::NoTool { tool: "gh".into(), fix: Some("install the GitHub CLI from https://cli.github.com".into()) };
    }
    if said.contains("gh auth login") || e.contains("http 401") || e.contains("bad credentials") {
        return Coverage::NoTool { tool: "gh".into(), fix: Some("gh auth login".into()) };
    }
    Coverage::Error { reason: err.to_string() }
}

/// `owner/repo` on github.com. A host pinned as GitHub that is not github.com is refused, since
/// the same name there could be someone else's repository.
pub(crate) fn github_repo<'a>(ctx: &Ctx<'a>) -> Result<&'a str, Coverage> {
    let f = ctx.forge;
    if f.kind != ForgeKind::Github {
        return Err(Coverage::Unsupported { reason: "not a GitHub repository".into() });
    }
    if f.by == ForgeBy::Pin && f.host.as_deref() != Some("github.com") {
        return Err(Coverage::Unsupported { reason: "only github.com is read, and this host is pinned as GitHub".into() });
    }
    f.path.as_deref()
        .filter(|p| p.split('/').count() == 2)
        .and_then(|p| data_arg(p).ok())
        .ok_or_else(|| Coverage::Unsupported { reason: "the remote names no owner/repo".into() })
}

/// The host glab asks and the project's full path (`group/sub/repo`), shared by every GitLab
/// adapter. Any host may be GitLab, so unlike `github_repo` a pinned one is read.
pub(crate) fn gitlab_project<'a>(ctx: &Ctx<'a>) -> Result<(&'a str, &'a str), Coverage> {
    let f = ctx.forge;
    if f.kind != ForgeKind::Gitlab {
        return Err(Coverage::Unsupported { reason: "not a GitLab project".into() });
    }
    let host = f.api_host().and_then(|h| data_arg(h).ok())
        .ok_or_else(|| Coverage::Unsupported { reason: "the remote names no GitLab host".into() })?;
    let path = f.path.as_deref()
        .filter(|p| p.split('/').count() >= 2 && !p.split('/').any(str::is_empty))
        .ok_or_else(|| Coverage::Unsupported { reason: "the remote names no group/project".into() })?;
    Ok((host, path))
}

// ---------- commands ----------

#[tauri::command(async)]
pub(crate) fn maint_detect(root: String, force: bool) -> Detection {
    detect(&root, force)
}

/// One source of one project, so a slow `gh` never holds a card. `mode` is `scan` or
/// `explicit`; anything else is read as `scan`, the class that refuses more.
#[tauri::command]
pub(crate) async fn maint_read(root: String, source: String, mode: String, public: bool, force: bool, account: Option<String>) -> SourceReport {
    let id = source.clone();
    let mode = if mode == "explicit" { Mode::Explicit } else { Mode::Scan };
    tauri::async_runtime::spawn_blocking(move || read_source(&root, &source, mode, public, force, account.as_deref()))
        .await
        .unwrap_or_else(|e| report(&id, meta_of(&id).map(|(m, _)| m), Coverage::Error { reason: format!("the read failed: {e}") }))
}

/// Drops both caches for a project; called beside `gh_invalidate` on an account switch.
#[tauri::command]
pub(crate) fn maint_invalidate(root: String) {
    invalidate(&root_key(&root));
}

#[cfg(test)]
mod tests {
    use super::exec::{data_arg, trusted, FakeExec, HttpReq};
    use super::*;
    use crate::forge::ForgeBy;
    use crate::testutil::{git, scratch_dir};
    use std::path::PathBuf;

    fn commit(dir: &Path, msg: &str) {
        git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg]);
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn a_capped_read_refuses_what_is_not_a_bounded_regular_file() {
        let dir = scratch_dir();
        write(&dir, "small.txt", "hello");
        write(&dir, "big.txt", &"x".repeat(65));
        assert_eq!(read_capped(&dir.join("small.txt"), 64).unwrap(), "hello");
        assert_eq!(read_capped(&dir.join("big.txt"), 64).unwrap_err().to_string(), "too large to read");
        assert_eq!(read_capped(&dir, 64).unwrap_err().to_string(), "not a regular file");
        assert_eq!(read_capped(&dir.join("none"), 64).unwrap_err().kind(), std::io::ErrorKind::NotFound);
        std::fs::write(dir.join("bom.txt"), b"\xEF\xBB\xBF14\n").unwrap();
        std::fs::write(dir.join("le.txt"), [0xFF, 0xFE, b'1', 0, b'4', 0]).unwrap();
        std::fs::write(dir.join("bin.txt"), [0xC3, 0x28]).unwrap();
        assert_eq!((read_capped(&dir.join("bom.txt"), 64).unwrap(), read_capped(&dir.join("le.txt"), 64).unwrap()), ("14\n".into(), "14".into()));
        assert_eq!(read_capped(&dir.join("bin.txt"), 64).unwrap_err().kind(), std::io::ErrorKind::InvalidData);
        // The device reports length 0, so only the read itself can stop it.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/dev/zero", dir.join("CHANGELOG.md")).unwrap();
            assert_eq!(read_capped(&dir.join("CHANGELOG.md"), 64).unwrap_err().to_string(), "not a regular file");
            let cfg = MaintConfig::default();
            let forge = Forge { kind: ForgeKind::Unknown, host: None, path: None, by: ForgeBy::Table, api: None };
            let root = dir.to_string_lossy().to_string();
            let ctx = Ctx { root: &root, cfg: &cfg, forge: &forge, account: None, force: true };
            assert!(matches!(crate::maint_git::changelog(&ctx, &FakeExec::answering(Ok(""))), Err(Coverage::Unsupported { .. })));
        }
    }

    /// A repo every local source can answer: a tag, a changelog, a trunk and a SARIF report named in config.
    fn fixture_repo() -> PathBuf {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        commit(&dir, "one");
        git(&dir, &["-c", "tag.gpgsign=false", "tag", "v1.0"]);
        commit(&dir, "two");
        write(&dir, "CHANGELOG.md", "# Changelog\n\n## Unreleased\n+ a thing\n\n## 1.0 — 2026-10-01\n+ first\n");
        write(&dir, ".episko/episko.toml", "[maintenance]\ntrunk = \"main\"\nsarif = [\"reports/*.sarif\"]\n[deploy]\nurls = { app = \"https://app.example.com\" }\n");
        write(&dir, "reports/scan.sarif", "{\"version\": \"2.1.0\", \"runs\": []}");
        dir
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    /// `fixture_repo` on each forge a source reads, holding every file a source detects, so each
    /// read gets as far as its `Exec` instead of bailing on "not a repo" or "no forge" first.
    fn rich_repos() -> Vec<(String, Detection)> {
        let repos: Vec<(String, Detection)> = ["https://github.com/acme/app.git", "https://gitlab.com/acme/app.git"].into_iter().map(|remote| {
            let dir = fixture_repo();
            git(&dir, &["remote", "add", "origin", remote]);
            for d in MANIFEST.sources.values().flat_map(|s| &s.detect) {
                let (path, key) = d.split_once('#').map_or((d.as_str(), None), |(p, k)| (p, Some(k)));
                match key {
                    _ if dir.join(path).exists() => {}
                    Some(k) => write(&dir, path, &format!("{{\"{k}\": {{}}}}")),
                    None if path.ends_with('/') => write(&dir, &format!("{path}x"), ""),
                    None => write(&dir, path, &lock_sample(path)),
                }
            }
            let det = detect(&s(&dir), true);
            let admitted = SOURCES.iter().filter(|d| forge_admits(&MANIFEST.sources[d.id].forge, det.forge.kind)).count();
            assert_eq!(det.sources.len(), admitted, "{remote} must detect every source of its forge");
            (s(&dir), det)
        }).collect();
        let all: BTreeSet<&str> = repos.iter().flat_map(|(_, d)| d.sources.iter().map(String::as_str)).collect();
        assert_eq!(all.len(), SOURCES.len(), "some source is read on no fixture forge");
        repos
    }

    /// A lockfile with packages in it, so a source that reads one gets as far as its `Exec`.
    fn lock_sample(path: &str) -> String {
        match path {
            "Cargo.lock" => FakeExec::testdata("lock-cargo.lock"),
            "package-lock.json" => FakeExec::testdata("lock-npm-v3.json"),
            "pnpm-lock.yaml" => FakeExec::testdata("lock-pnpm-v9.yaml"),
            ".nvmrc" => "18\n".into(),
            _ => String::new(),
        }
    }

    const NO_FORGE: Forge = Forge { kind: ForgeKind::None, host: None, path: None, by: ForgeBy::None, api: None };

    fn garbage() -> Vec<FakeExec> {
        vec![FakeExec::answering(Err("boom")), FakeExec::answering(Ok("")), FakeExec::recorded("html-error.html")]
    }

    #[test]
    fn the_manifest_loads_and_matches_the_registry() {
        MANIFEST.check().unwrap();
        let ids: Vec<&str> = SOURCES.iter().map(|d| d.id).collect();
        assert_eq!(ids.len(), BTreeSet::from_iter(&ids).len(), "unique ids");
        assert!(ids.iter().all(|i| kebab(i)), "{ids:?}");
        for f in FACETS {
            let covered = MANIFEST.sources.values().any(|s| s.facet == f) || MANIFEST.markers.iter().any(|m| m.facet == f);
            let phrased = MANIFEST.facets.iter().any(|d| d.id == f && !d.none.is_empty());
            assert!(covered || phrased, "{} has no source, marker or none phrase", f.id());
        }
        // Every capability is used, so the vocabulary stays closed in both directions.
        let used: BTreeSet<&str> = MANIFEST.sources.values().flat_map(|s| s.sees.iter().chain(&s.blind)).map(String::as_str).collect();
        assert_eq!(used, MAINT_CAPS.iter().copied().collect::<BTreeSet<&str>>());
        // Every bot is read as `<id>-prs`; where a marker stands in for it off that source's forges,
        // the marker detects exactly the bot's config files.
        for b in &MANIFEST.bots {
            assert!(MANIFEST.sources.contains_key(&format!("{}-prs", b.id)), "bot {} has no source", b.id);
            if let Some(m) = MANIFEST.markers.iter().find(|m| m.facet == Facet::Deps && m.label.to_lowercase() == b.id) {
                assert_eq!(&m.detect, &b.config, "bot {}", b.id);
            }
        }
    }

    /// A marker says "nothing reads it yet", which is a lie wherever a source of its facet reads
    /// the same file on the same forge.
    #[test]
    fn no_marker_claims_a_file_a_source_reads() {
        let meet = |a: &[String], b: &[String]| crate::forge::KINDS.iter().any(|(k, _)| forge_admits(a, *k) && forge_admits(b, *k));
        for m in &MANIFEST.markers {
            for (id, s) in MANIFEST.sources.iter().filter(|(_, s)| s.facet == m.facet && meet(&s.forge, &m.forge)) {
                assert!(!m.detect.iter().any(|d| s.detect.contains(d)), "marker {} overlaps source {id}", m.label);
            }
        }
        let jenkins = [("Jenkinsfile", "pipeline {}")];
        let d = detect(&s(&repo_with("https://github.com/a/b.git", &jenkins)), true);
        assert!(d.sources.iter().any(|x| x == "forge-commit-status") && !labels(&d).contains(&"Jenkins".to_string()));
        let d = detect(&s(&repo_with("https://gitlab.com/a/b.git", &jenkins)), true);
        assert!(labels(&d).contains(&"Jenkins".to_string()), "off GitHub it is still a marker");
        // No CI file on GitHub must still draw "no CI": the status read never claims every repo.
        let bare = detect(&s(&repo_with("https://github.com/a/b.git", &[])), true);
        assert!(!bare.sources.iter().any(|x| MANIFEST.sources[x].facet == Facet::Ci), "{:?}", bare.sources);
    }

    #[test]
    fn a_bad_manifest_row_is_refused() {
        let bad = r#"{"facets": [], "sources": {}, "markers": [], "bots": []}"#;
        assert!(serde_json::from_str::<Manifest>(bad).unwrap().check().is_err(), "the facets are the seven");
        let typo = include_str!("../../src/maintmanifest.json").replace("\"rel.last\"", "\"rel.lats\"");
        assert!(serde_json::from_str::<Manifest>(&typo).unwrap().check().unwrap_err().contains("rel.lats"));
        let mixed = include_str!("../../src/maintmanifest.json").replacen("[\"!github\"]", "[\"gitlab\", \"!github\"]", 1);
        assert!(serde_json::from_str::<Manifest>(&mixed).unwrap().check().unwrap_err().contains("never both"));
        let needs = include_str!("../../src/maintmanifest.json").replace("\"needs\": [\"sarif\"]", "\"needs\": [\"sarfi\"]");
        let man = include_str!("../../src/maintmanifest.json");
        let mut m: Manifest = serde_json::from_str(man).unwrap();
        m.sources.get_mut("osv").unwrap().sends = None;
        assert!(m.check().unwrap_err().contains("says what it sends"), "a public source must disclose");
        let mut m: Manifest = serde_json::from_str(man).unwrap();
        m.sources.get_mut("git-tags").unwrap().sends = Some("x".into());
        assert!(m.check().is_err(), "and only a public one");
        for (src, url) in [("dependabot-alerts", "http://github.com/{path}"), ("dependabot-alerts", "https://github.com/settings"), ("osv", "https://osv.dev/{path}")] {
            let mut m: Manifest = serde_json::from_str(man).unwrap();
            m.sources.get_mut(src).unwrap().settings = Some(url.into());
            assert!(m.check().unwrap_err().contains("settings"), "{src}: {url}");
        }
        for forge in [vec![], vec!["github".to_string(), "gitlab".to_string()]] {
            let mut m: Manifest = serde_json::from_str(man).unwrap();
            m.sources.get_mut("dependabot-alerts").unwrap().forge = forge.clone();
            assert!(m.check().unwrap_err().contains("settings"), "one page per forge: {forge:?}");
        }
        let mut m: Manifest = serde_json::from_str(man).unwrap();
        m.sources.get_mut("git-tags").unwrap().queue = true;
        assert!(m.check().unwrap_err().contains("queue"), "only a work source's threads are in the queue");
        assert!(serde_json::from_str::<Manifest>(&needs).unwrap().check().unwrap_err().contains("sarfi"), "a key config cannot set");
        let ok = |f: &[&str], k| forge_admits(&f.iter().map(|s| s.to_string()).collect::<Vec<_>>(), k);
        assert!(ok(&["!github"], ForgeKind::None) && !ok(&["!github"], ForgeKind::Github) && ok(&[], ForgeKind::Github));
        let extra = include_str!("../../src/maintmanifest.json").replace("\"facet\": \"git\",", "\"facet\": \"git\", \"argv\": [\"rm\"],");
        assert!(serde_json::from_str::<Manifest>(&extra).is_err(), "no field the manifest does not define");
    }

    /// The sources a rich repo detects, each with its forge's context.
    fn detected<'a>(root: &'a str, det: &'a Detection) -> impl Iterator<Item = (&'static SourceDef, Ctx<'a>)> {
        SOURCES.iter().filter(|d| det.sources.iter().any(|x| x == d.id))
            .map(move |d| (d, Ctx { root, cfg: &det.config, forge: &det.forge, account: None, force: true }))
    }

    #[test]
    fn no_source_answers_ok_on_garbage() {
        for (root, det) in rich_repos() {
            for (def, ctx) in detected(&root, &det) {
                let meta = &MANIFEST.sources[def.id];
                for ex in garbage() {
                    crate::deps::dep_invalidate(root.clone()); // a forced read still joins a fresh shared answer
                    let rep = run(def.id, meta, def.read, &ctx, &ex);
                    if meta.cost == Cost::Local {
                        assert!(ex.calls().is_empty(), "{}: a local source never reads the Exec", def.id);
                        continue;
                    }
                    // A read that bailed before the seam would pass below without proving anything.
                    assert!(!ex.calls().is_empty(), "{} never reached its Exec", def.id);
                    assert_ne!(rep.coverage, Coverage::Ok, "{} answered ok on garbage", def.id);
                    assert!(rep.facts.is_none());
                }
            }
        }
    }

    #[test]
    fn every_source_answers_facts_of_its_own_facet() {
        let root = s(&fixture_repo());
        let cfg = read_config(&root);
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        let mut oks = 0;
        for def in SOURCES {
            // The raw read, not `run`: `run` would turn a crossed facet into an error and hide it.
            if let Ok(r) = (def.read)(&ctx, &FakeExec::answering(Ok(""))) {
                assert_eq!(r.facts.facet(), MANIFEST.sources[def.id].facet, "{}", def.id);
                oks += 1;
            }
        }
        assert_eq!(oks, SOURCES.iter().filter(|d| MANIFEST.sources[d.id].cost == Cost::Local).count());
    }

    fn meta(facet: Facet, cost: Cost) -> SourceMeta {
        SourceMeta { facet, label: "test".into(), cost, forge: vec![], detect: vec![], needs: vec![], sends: None, settings: None, queue: false, sees: vec![], blind: vec![] }
    }

    fn calls_tool(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
        ex.tool(ctx.root, "npm", &["audit", "--json"], 5).map_err(|reason| Coverage::Error { reason })?;
        Ok(Read::of(Facts::Advisories { items: vec![] }))
    }

    #[test]
    fn the_gate_refuses_before_any_call() {
        let cfg = MaintConfig::default();
        let costs = [Cost::Local, Cost::Forge, Cost::Public, Cost::Tool, Cost::Remote];
        for (n, cost) in costs.into_iter().enumerate() {
            for (m, mode) in [Mode::Scan, Mode::Explicit].into_iter().enumerate() {
                for public in [false, true] {
                    let root = format!("/maint-test/gate/{n}/{m}/{public}");
                    let ex = FakeExec::answering(Ok("[]"));
                    let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
                    let rep = read_cached(&root, "t", &meta(Facet::Security, cost), calls_tool, &ctx, &ex, mode, public, true, None);
                    let ran = !ex.calls().is_empty();
                    assert_eq!(ran, permitted(cost, mode, public), "{cost:?} {mode:?} public={public}");
                    if !ran {
                        assert_eq!(rep.coverage, Coverage::NotRun);
                    }
                }
            }
        }
        assert!(!permitted(Cost::Tool, Mode::Scan, true) && !permitted(Cost::Remote, Mode::Scan, true));
        assert!(!permitted(Cost::Public, Mode::Scan, false) && permitted(Cost::Public, Mode::Scan, true));
    }

    #[test]
    fn registry_sources_make_no_call_in_a_scan_their_class_forbids() {
        let root = s(&fixture_repo());
        let cfg = read_config(&root);
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        for def in SOURCES {
            let m = &MANIFEST.sources[def.id];
            if permitted(m.cost, Mode::Scan, false) {
                continue;
            }
            let ex = FakeExec::answering(Ok(""));
            let root = format!("/maint-test/scan/{}", def.id);
            let rep = read_cached(&root, def.id, m, def.read, &ctx, &ex, Mode::Scan, false, true, None);
            assert!(ex.calls().is_empty(), "{} ran in a scan", def.id);
            assert_eq!(rep.coverage, Coverage::NotRun);
        }
    }

    /// No scan runs a program in the project, forced or opted in; only an opted-in one sends to a
    /// public service. Every such source is reached on a rich repo, so none slips past unasked.
    #[test]
    fn a_scan_runs_no_tool_and_sends_nothing_public_without_the_opt_in() {
        let mut seen = BTreeSet::new();
        for (root, det) in rich_repos() {
            for (def, ctx) in detected(&root, &det) {
                let m = &MANIFEST.sources[def.id];
                if !matches!(m.cost, Cost::Tool | Cost::Public) {
                    continue;
                }
                seen.insert(def.id);
                for public in [false, true] {
                    let ex = FakeExec::answering(Ok(""));
                    let key = format!("{root}/scan/{}/{public}", def.id);
                    let rep = read_cached(&key, def.id, m, def.read, &ctx, &ex, Mode::Scan, public, true, None);
                    let ran = !ex.calls().is_empty();
                    assert_eq!(ran, m.cost == Cost::Public && public, "{} public={public}: {:?}", def.id, ex.calls());
                    if !ran {
                        assert_eq!(rep.coverage, Coverage::NotRun, "{}", def.id);
                    }
                }
            }
        }
        let want: BTreeSet<&str> = MANIFEST.sources.iter().filter(|(_, s)| matches!(s.cost, Cost::Tool | Cost::Public)).map(|(id, _)| id.as_str()).collect();
        assert_eq!(seen, want);
        assert!(want.contains("osv") && want.contains("cargo-audit") && want.contains("runtime-eol"), "{want:?}");
    }

    #[test]
    fn every_call_uses_a_bin_trusted_for_its_cost() {
        let repos = rich_repos();
        for (root, det) in &repos {
            for (def, ctx) in detected(root, det) {
                let m = &MANIFEST.sources[def.id];
                let ex = FakeExec::answering(Ok(""));
                crate::deps::dep_invalidate(root.clone());
                let _ = (def.read)(&ctx, &ex);
                assert_eq!(ex.calls().is_empty(), m.cost == Cost::Local, "{}: only a local source makes no call", def.id);
                for call in ex.calls() {
                    assert!(trusted(m.cost, &call[0]), "{} ({:?}) called {call:?}", def.id, m.cost);
                }
            }
        }
        // The real seam refuses before it spawns anything.
        let root = &repos[0].0;
        assert!(SysExec { cost: Cost::Local }.gh(root, None, &["api", "user"]).unwrap_err().contains("not trusted"));
        assert!(SysExec { cost: Cost::Tool }.glab(root, &["api", "user"]).unwrap_err().contains("not trusted"));
        assert!(SysExec { cost: Cost::Forge }.tool(root, "npm", &["audit"], 5).unwrap_err().contains("not trusted"));
        assert!(SysExec { cost: Cost::Tool }.tool(root, "rm", &["-rf", "."], 5).unwrap_err().contains("not trusted"));
        assert!(SysExec { cost: Cost::Tool }.ssh("prod", "uptime", 5).unwrap_err().contains("not trusted"));
        let req = HttpReq { url: "file:///etc/passwd".into(), body: None, token: None, secs: 5, report: false };
        assert!(SysExec { cost: Cost::Remote }.http(&req).is_err(), "only http(s)");
        let req = HttpReq { url: "https://x.example".into(), body: None, token: Some(("Authorization: Bearer ", "HOME")), secs: 5, report: false };
        assert!(SysExec { cost: Cost::Remote }.http(&req).unwrap_err().contains("not a token"), "only allowlisted env names");
        assert!(SysExec { cost: Cost::Remote }.http(&HttpReq { report: true, ..req }).unwrap_err().contains("sends nothing"));
        let probe = HttpReq { url: "HTTPS://x.example/[1-3]".into(), body: None, token: None, secs: 5, report: true };
        let argv: Vec<_> = exec::report_cmd(&probe).unwrap().get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(argv, ["-sSg", "-o", exec::NULL_DEV, "--max-time", "5", "-w", r"%{json}\n%{certs}", "HTTPS://x.example/[1-3]"], "no glob, no body");
        for bad in ["-oProxyCommand=x", "a b", ""] {
            assert!(data_arg(bad).is_err(), "{bad:?}");
        }
        assert_eq!(data_arg("prod-1"), Ok("prod-1"));
    }

    /// Executed, not read: what cmd.exe picks is the hazard, and only running it shows which.
    #[test]
    fn a_tool_is_the_file_on_path_never_one_the_project_planted() {
        let (proj, bin) = (scratch_dir(), scratch_dir());
        #[cfg(windows)]
        let (name, planted, real) = ("npm.cmd", "@echo PLANTED %*\r\n", "@echo REAL %*\r\n");
        #[cfg(not(windows))]
        let (name, planted, real) = ("npm", "#!/bin/sh\necho PLANTED \"$@\"\n", "#!/bin/sh\necho REAL \"$@\"\n");
        for (dir, text) in [(&proj, planted), (&bin, real)] {
            std::fs::write(dir.join(name), text).unwrap();
            #[cfg(unix)]
            std::fs::set_permissions(dir.join(name), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        }
        let path = std::env::join_paths([Path::new("."), &bin]).unwrap().to_string_lossy().to_string();
        let mut cmd = exec::tool_cmd("npm", &["audit", "--json"], &path).unwrap();
        assert_eq!(cmd.get_program(), bin.join(name).as_os_str(), "the absolute file, so nothing searches the project");
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args, ["audit", "--json"]);
        let child_path = cmd.get_envs().find(|(k, _)| *k == "PATH").and_then(|(_, v)| v).unwrap();
        assert_eq!(std::env::split_paths(child_path).collect::<Vec<_>>(), std::slice::from_ref(&bin), "nor does the child's own lookup");
        let out = cmd.current_dir(&proj).output().unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        assert!(said.contains("REAL audit --json") && !said.contains("PLANTED"), "{said}");
        for bad in ["a&b", "%PATH%", "\"x", "a\nb", "a|b"] {
            assert!(exec::tool_cmd("npm", &[bad], &path).is_err(), "{bad:?}");
        }
        assert!(exec::tool_cmd("npm", &["audit"], ".").is_err(), "a relative PATH entry is never searched");
        assert!(exec::resolve_bin("npm", &path).is_some_and(|p| p.starts_with(&bin)));
    }

    #[test]
    fn a_failed_transfer_is_curls_error_never_http_0() {
        let out = |code, stdout: &str, stderr: &str| exec::Output { code, stdout: stdout.into(), stderr: stderr.into() };
        let dns = exec::http_answer(out(Some(6), "\n000", "curl: (6) Could not resolve host: api.osv.dev"));
        assert_eq!(dns.err().as_deref(), Some("curl: (6) Could not resolve host: api.osv.dev"));
        assert_eq!(exec::http_answer(out(Some(28), "\n000", "")).err().as_deref(), Some("no HTTP answer"));
        let ok = exec::http_answer(out(Some(0), "{\"a\":1}\n404", "")).unwrap();
        assert_eq!((ok.code, ok.body.as_str()), (404, "{\"a\":1}"), "a status is the server's answer, even a 404");
    }

    /// The real shim, executed: a project `.npmrc` naming a prefix that holds its own npm-cli.js.
    #[cfg(windows)]
    #[test]
    fn npm_never_runs_the_npm_cli_a_project_prefix_names() {
        let path = crate::platform::augmented_path();
        if exec::resolve_bin("npm", &path).is_none() {
            eprintln!("npm is not installed here; skipped");
            return;
        }
        let proj = scratch_dir();
        let cli = proj.join("evil").join("node_modules").join("npm").join("bin");
        std::fs::create_dir_all(&cli).unwrap();
        std::fs::write(cli.join("npm-cli.js"), "console.log('PLANTED')\n").unwrap();
        std::fs::write(proj.join(".npmrc"), "prefix=evil\n").unwrap();
        std::fs::write(proj.join("package.json"), "{\"name\":\"x\",\"version\":\"1.0.0\"}\n").unwrap();
        let out = exec::tool_cmd("npm", &["--version"], &path).unwrap().current_dir(&proj).output().unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        assert!(!said.contains("PLANTED") && said.trim().starts_with(|c: char| c.is_ascii_digit()), "{said}");
    }

    fn counts_gh(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
        ex.gh(ctx.root, None, &["api", "x"]).map_err(|reason| Coverage::Error { reason })?;
        Ok(Read::of(Facts::Work { issues: 1, prs: 0, review_requested: Some(0) }))
    }

    #[test]
    fn the_report_cache_is_keyed_by_account() {
        let root = "/maint-test/cache-by-account";
        let cfg = MaintConfig::default();
        let ctx = Ctx { root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        let ex = FakeExec::answering(Ok("{}"));
        let m = meta(Facet::Work, Cost::Forge);
        let go = |acct: Option<&str>, force: bool| read_cached(root, "t", &m, counts_gh, &ctx, &ex, Mode::Scan, false, force, acct);
        let first = go(Some("alice"), false);
        assert_eq!(first.coverage, Coverage::Ok);
        assert_eq!(go(Some("alice"), false), first, "a hit keeps the original `at`");
        assert_eq!(ex.calls().len(), 1);
        go(Some("bob"), false);
        assert_eq!(ex.calls().len(), 2, "another identity never reads alice's answer");
        go(Some("alice"), true);
        assert_eq!(ex.calls().len(), 3, "force is a refresh");
        invalidate(root);
        go(Some("bob"), false);
        assert_eq!(ex.calls().len(), 4, "invalidate drops every account's entry");
    }

    #[test]
    fn a_refused_class_shows_its_last_explicit_run() {
        let root = "/maint-test/tool-as-of";
        let cfg = MaintConfig::default();
        let ctx = Ctx { root, cfg: &cfg, forge: &NO_FORGE, account: None, force: true };
        let ex = FakeExec::answering(Ok("[]"));
        let m = meta(Facet::Security, Cost::Tool);
        let ran = read_cached(root, "t", &m, calls_tool, &ctx, &ex, Mode::Explicit, false, false, None);
        let later = read_cached(root, "t", &m, calls_tool, &ctx, &ex, Mode::Scan, false, true, None);
        assert_eq!((later, ex.calls().len()), (ran, 1), "a scan, even forced, never becomes a process");
    }

    #[test]
    fn maintenance_is_read_forgivingly() {
        let c = parse_maint(
            "[branches]\nprotect = [\"main\"]\n[maintenance]\nforge = \"gitlab\"\noff = [\"prod\", 3]\ntrunk = 7\n\
             sources = { ci = [\"woodpecker\"], nonsense = [\"x\"], security = \" osv \", prod = 3, git = [1], release = [] }\n\
             [maintenance.params]\nwoodpecker_server = \"https://ci.example.com\"\nsneaky = \"file:///etc/passwd\"\n\
             [maintenance.thresholds]\nstale_branch_days = 24\nunreleased_days = 2.5\nbad = \"x\"\n",
        );
        assert!(c.readable);
        assert_eq!((c.forge.as_deref(), c.off.clone(), c.trunk.clone()), (Some("gitlab"), vec!["prod".to_string()], None));
        assert_eq!(c.sources.keys().collect::<Vec<_>>(), ["ci", "release", "security"], "only facets restrict, and only as a list");
        assert_eq!((c.sources["security"].clone(), c.sources["release"].len()), (vec!["osv".to_string()], 0), "a word is a list of one; [] is meant");
        assert_eq!(c.params.keys().collect::<Vec<_>>(), ["woodpecker_server"], "a param URL must be http(s)");
        assert_eq!(c.thresholds.get("stale_branch_days"), Some(&24.0));
        assert_eq!(c.thresholds.len(), 2);
        assert_eq!(parse_maint("[stack]\nup = \"x\"\n"), MaintConfig::default(), "no table is defaults");
    }

    #[test]
    fn a_broken_episko_toml_is_unreadable_never_defaults() {
        let dir = scratch_dir();
        assert!(read_config(&s(&dir)).readable, "no file is not a broken one");
        write(&dir, ".episko/episko.toml", "[maintenance\nforge = \n");
        let c = read_config(&s(&dir));
        assert!(!c.readable);
        assert!(!detect(&s(&dir), true).config.readable, "detection carries the flag to the tips");
    }

    fn repo_with(remote: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["remote", "add", "origin", remote]);
        for (rel, text) in files {
            write(&dir, rel, text);
        }
        dir
    }

    fn labels(d: &Detection) -> Vec<String> {
        d.markers.iter().map(|m| m.label.clone()).collect()
    }

    #[test]
    fn workflows_mean_github_actions_only_on_github() {
        let wf = [(".github/workflows/ci.yml", "on: push\n")];
        let d = detect(&s(&repo_with("https://codeberg.org/a/b.git", &wf)), true);
        assert_eq!(d.forge.kind, ForgeKind::Forgejo);
        assert!(labels(&d).contains(&"Forgejo/Gitea Actions".to_string()), "{:?}", labels(&d));
        assert!(!labels(&d).iter().any(|l| l.starts_with("GitHub")), "{:?}", labels(&d));
        assert!(!d.sources.iter().any(|x| x == "github-actions"));
        let d = detect(&s(&repo_with("https://github.com/a/b.git", &wf)), true);
        assert!(d.sources.iter().any(|x| x == "github-actions"), "{:?}", d.sources);
        assert!(d.markers.iter().all(|m| m.facet != Facet::Ci), "a source, not a marker: {:?}", labels(&d));
        let d = detect(&s(&repo_with("https://git.acme.io/a/b.git", &wf)), true);
        assert_eq!((d.forge.kind, d.forge.by), (ForgeKind::Unknown, ForgeBy::None));
        assert!(labels(&d).contains(&"CI on git.acme.io".to_string()), "{:?}", labels(&d));
    }

    #[test]
    fn gitlab_ci_yml_is_a_source_on_gitlab_and_a_marker_elsewhere() {
        let yml = [(".gitlab-ci.yml", "test:\n  script: [true]\n")];
        let ci = |d: &Detection| d.sources.iter().filter(|x| MANIFEST.sources[x.as_str()].facet == Facet::Ci).cloned().collect::<Vec<_>>();
        for remote in ["https://gitlab.com/g/sub/r.git", "https://gitlab.acme.io/g/r.git"] {
            let d = detect(&s(&repo_with(remote, &yml)), true);
            assert_eq!(ci(&d), ["gitlab-ci"], "{remote}");
            assert!(d.markers.iter().all(|m| m.facet != Facet::Ci), "a source, not a marker: {:?}", labels(&d));
        }
        let unknown = repo_with("https://git.acme.io/g/r.git", &yml);
        let d = detect(&s(&unknown), true);
        assert!(ci(&d).is_empty() && labels(&d).contains(&"CI on git.acme.io".to_string()), "{:?}", labels(&d));
        write(&unknown, ".episko/episko.toml", "[maintenance]\nforge = \"gitlab\"\n");
        assert_eq!(ci(&detect(&s(&unknown), true)), ["gitlab-ci"], "a pinned self-hosted GitLab is read");
        let d = detect(&s(&repo_with("https://gitlab.com/g/r.git", &[])), true);
        assert!(ci(&d).is_empty() && d.sources.iter().any(|x| x == "gitlab-work"), "no file is no CI; issues need none");
    }

    #[test]
    fn files_are_probed_by_their_shape() {
        let dir = repo_with("https://git.acme.io/g/sub/r.git", &[
            ("package.json", "{\"name\": \"x\", \"renovate\": {\"extends\": []}}"),
            ("ci/Jenkinsfile", "pipeline {}"),
            ("node_modules/Jenkinsfile", ""),
            ("sub/.snyk", ""),
        ]);
        std::fs::create_dir_all(dir.join(".github/workflows")).unwrap();
        let d = detect(&s(&dir), true);
        assert_eq!(d.forge.path.as_deref(), Some("g/sub/r"));
        let found = |l: &str| d.markers.iter().find(|m| m.label == l).map(|m| m.found.clone());
        assert_eq!(found("Renovate"), Some(vec!["package.json#renovate".to_string()]), "file#key");
        assert_eq!(found("Jenkins"), Some(vec!["ci/Jenkinsfile".to_string()]), "one level down, never into SKIP_DIRS");
        assert_eq!(found("Snyk"), None, "a dot name is anchored at the root");
        assert_eq!(found("CI on git.acme.io"), None, "an empty workflows dir is no CI");

        write(&dir, "package.json", "{\"name\": \"x\"}");
        assert_eq!(detect(&s(&dir), true).markers.iter().find(|m| m.label == "Renovate"), None, "no key, no Renovate");
    }

    #[test]
    fn sources_follow_files_and_config() {
        let gh = ["dependabot-alerts", "github-code-scanning", "github-secret-scanning", "dependabot-prs", "renovate-prs"];
        let dir = repo_with("https://github.com/a/b.git", &[("CHANGELOG.md", "# Changelog\n")]);
        let rest = ["git-local", "git-tags", "changelog", "github-releases", "github-work"];
        assert_eq!(detect(&s(&dir), true).sources, [&gh[..], &rest].concat());
        write(&dir, ".episko/episko.toml", "[maintenance]\nsources = { release = [\"changelog\"] }\n");
        assert_eq!(detect(&s(&dir), true).sources, [&gh[..], &["git-local", "changelog", "github-work"]].concat());
        // A source that reads what config names applies only once config names something.
        write(&dir, ".episko/episko.toml", "[maintenance]\nsarif = [\"out/*.sarif\"]\n");
        assert!(detect(&s(&dir), true).sources.iter().any(|x| x == "sarif-files"));
        write(&dir, ".episko/episko.toml", "[maintenance]\noff = [\"release\", \"git-local\", \"ci\", \"security\", \"deps\", \"work\"]\n");
        let d = detect(&s(&dir), true);
        assert!(d.sources.is_empty(), "{:?}", d.sources);
        assert!(d.markers.iter().all(|m| m.facet != Facet::Ci), "an off facet has no markers either");
        let rep = read_source(&s(&dir), "git-tags", Mode::Explicit, true, true, None);
        assert_eq!(rep.coverage, Coverage::Unsupported { reason: "switched off in .episko/episko.toml".into() });
        assert!(read_source(&s(&dir), "nope", Mode::Explicit, true, true, None).facet.is_none());

        let plain = scratch_dir();
        let d = detect(&s(&plain), true);
        assert_eq!((d.forge.kind, d.sources.len()), (ForgeKind::None, 0), "a folder that is not a repo");

        // `changelog` reads the root's file, so a package's one level down must not detect it.
        let mono = repo_with("https://gitlab.com/a/b.git", &[("pkg/CHANGELOG.md", "# pkg\n")]);
        assert_eq!(detect(&s(&mono), true).sources, ["git-local", "git-tags", "gitlab-work"]);
    }

    #[test]
    fn a_deploy_table_nothing_reads_is_found_not_none() {
        let dir = repo_with("https://github.com/a/b.git", &[(".episko/episko.toml", "[deploy]
host = \"prod-1\"
")]);
        let d = detect(&s(&dir), true);
        assert!(d.deploy.is_some());
        assert!(labels(&d).contains(&"[deploy]".to_string()), "{:?}", labels(&d));
        write(&dir, ".episko/episko.toml", "[deploy]
host = \"prod-1\"
[maintenance]
off = [\"prod\"]
");
        assert!(!labels(&detect(&s(&dir), true)).contains(&"[deploy]".to_string()), "an off facet has no markers");
        write(&dir, ".episko/episko.toml", "[deploy]
host = \"-oProxyCommand=x\"
");
        let d = detect(&s(&dir), true);
        assert!(d.deploy.is_none() && !labels(&d).contains(&"[deploy]".to_string()), "nothing safe is no table");
        // An address is what http-probe reads: then it is a source, and the marker steps aside.
        write(&dir, ".episko/episko.toml", "[deploy]\nhost = \"prod-1\"\nurls = { app = \"https://app.example.com\" }\n");
        let d = detect(&s(&dir), true);
        assert!(d.sources.iter().any(|x| x == "http-probe") && !labels(&d).contains(&"[deploy]".to_string()), "{:?}", labels(&d));
    }

    /// A scan never touches the user's infrastructure, forced or with the public opt-in; a click does.
    #[test]
    fn http_probe_makes_no_http_call_in_a_scan() {
        let root = s(&fixture_repo());
        let det = detect(&root, true);
        assert!(det.sources.iter().any(|x| x == "http-probe"), "{:?}", det.sources);
        let (meta, def) = meta_of("http-probe").unwrap();
        assert_eq!(meta.cost, Cost::Remote);
        let ctx = Ctx { root: &root, cfg: &det.config, forge: &det.forge, account: None, force: true };
        let ex = FakeExec::recorded("curl-openssl.txt");
        for public in [false, true] {
            let rep = read_cached(&root, "http-probe", meta, def.read, &ctx, &ex, Mode::Scan, public, true, None);
            assert_eq!(rep.coverage, Coverage::NotRun);
        }
        assert!(ex.calls().is_empty(), "{:?}", ex.calls());
        let rep = read_cached(&root, "http-probe", meta, def.read, &ctx, &ex, Mode::Explicit, false, true, None);
        assert_eq!((rep.coverage.clone(), ex.calls()), (Coverage::Ok, vec![vec!["curl".to_string(), "https://app.example.com".into(), "--report".into()]]));
        let later = read_cached(&root, "http-probe", meta, def.read, &ctx, &ex, Mode::Scan, false, true, None);
        assert_eq!((later, ex.calls().len()), (rep, 1), "a scan shows the click's answer and asks nothing");
    }

    #[test]
    fn the_forge_comes_from_the_remote_the_git_sources_use() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["remote", "add", "upstream", "git@github.com:a/b.git"]);
        let d = detect(&s(&dir), true);
        assert_eq!((d.forge.kind, d.forge.path.as_deref()), (ForgeKind::Github, Some("a/b")), "no origin is not no remote");
    }

    #[test]
    fn detection_is_cached_per_repo_until_forced() {
        let dir = repo_with("https://github.com/a/b.git", &[]);
        commit(&dir, "base");
        let wt = scratch_dir().join("wt");
        git(&dir, &["worktree", "add", "-q", "-b", "side", &s(&wt)]);
        let before = detect(&s(&dir), true);
        assert!(!before.sources.iter().any(|x| x == "changelog"));
        write(&dir, "CHANGELOG.md", "# Changelog\n");
        assert_eq!(detect(&s(&dir), false), before, "inside the TTL a read is the cached walk");
        assert_eq!(detect(&s(&wt), false), before, "a worktree shares its repo's entry");
        let after = detect(&s(&wt), true);
        assert!(after.sources.iter().any(|x| x == "changelog"), "{:?}", after.sources);
        assert_eq!(detect(&s(&dir), false), after, "a forced walk replaces the entry for both");
    }

    #[test]
    fn worktrees_collapse_to_the_repo_root() {
        let dir = repo_with("https://github.com/a/b.git", &[]);
        commit(&dir, "base");
        let wt = scratch_dir().join("wt");
        git(&dir, &["worktree", "add", "-q", "-b", "side", &s(&wt)]);
        assert_eq!(detect(&s(&wt), true).repo_root, detect(&s(&dir), true).repo_root);
    }

    fn wire_sample() -> (Detection, Vec<SourceReport>) {
        let ok = |id: &str, facet: Facet, cost: Cost, facts: Facts| SourceReport {
            source: id.into(), facet: Some(facet), cost: Some(cost), coverage: Coverage::Ok, at: Some(1_790_000_000),
            truncated: false, gaps: vec![], facts: Some(facts),
        };
        let not = |id: &str, coverage: Coverage| SourceReport {
            source: id.into(), facet: Some(Facet::Security), cost: Some(Cost::Forge), coverage, at: None,
            truncated: false, gaps: vec![], facts: None,
        };
        let (gh_runs, _) = crate::maint_ci::parse_runs(&FakeExec::testdata("gh-run-list.json")).unwrap();
        let reports = vec![
            // The recorded list as parsed, so maint.test.ts dates failing-since over the real join.
            ok("github-actions", Facet::Ci, Cost::Forge, Facts::CiRuns { branch: "main".into(), runs: gh_runs }),
            ok("osv", Facet::Security, Cost::Public, Facts::Advisories { items: vec![Advisory {
                id: "GHSA-xxxx-yyyy-zzzz".into(), aliases: vec!["CVE-2026-0001".into()], kind: AdvisoryKind::Dependency,
                pkg: Some("lodash".into()), ecosystem: Some("npm".into()), version: Some("4.17.20".into()),
                severity: Severity::High, raw_severity: "HIGH".into(), summary: "Prototype pollution".into(),
                fixed: Some("4.17.21".into()), location: Some("package-lock.json".into()), url: None, tool: "osv".into(),
            }] }),
            ok("renovate-prs", Facet::Deps, Cost::Forge, Facts::UpdatePrs { bot: "renovate".into(), configured: true, prs: vec![UpdatePr {
                number: 42, title: "Update serde".into(), url: "https://github.com/acme/app/pull/42".into(),
                branch: "renovate/serde".into(), draft: false, at: Some(1_790_000_000), checks: CiStatus::Pass,
            }], dashboard: Some(7) }),
            ok("git-tags", Facet::Release, Cost::Local, Facts::Release(ReleaseFacts {
                trunk: Some("origin/main".into()), tag: Some("v1.2.0".into()), tag_at: Some(1_789_000_000), since: 12,
                oldest_unreleased_at: Some(1_789_100_000), tags_seen: 9, fetched_at: Some(1_790_000_000),
            })),
            ok("github-releases", Facet::Release, Cost::Forge, Facts::Releases { latest: Some(ForgeRelease {
                tag: "v1.2.0".into(), name: "1.2.0".into(), at: Some(1_789_000_000), url: None,
            }), count: 9 }),
            ok("changelog", Facet::Release, Cost::Local, Facts::Changelog { unreleased: Some(3), latest: Some("1.2.0".into()), latest_at: Some(1_788_998_400) }),
            ok("git-local", Facet::Git, Cost::Local, Facts::Hygiene(Hygiene {
                trunk: Some("origin/main".into()), unpushed: Some(2), local_only: vec!["wip".into()], merged: vec!["old".into()],
                gone: vec!["gone".into()], branches: vec![crate::git::BranchAge { name: "wip".into(), at: 1_790_000_000 }],
                worktrees: vec![crate::git::WtAge { path: "/repo-wt".into(), branch: "wip".into(), at: None }],
                fetched_at: None, gaps: vec!["never on the wire".into()],
            })),
            ok("github-work", Facet::Work, Cost::Forge, Facts::Work { issues: 12, prs: 3, review_requested: Some(1) }),
            ok("http-probe", Facet::Prod, Cost::Remote, Facts::Probes { items: vec![Probe {
                name: "app".into(), url: "https://app.example.com".into(), code: Some(200), ms: Some(120),
                cert_not_after: Some(1_795_000_000), err: None,
            }] }),
            ok("runtime-eol", Facet::Security, Cost::Public, Facts::Runtimes { items: vec![Runtime {
                product: "nodejs".into(), name: "node".into(), declared: "18".into(), cycle: Some("18".into()),
                eol: Some(Eol::At(1_745_971_200)), latest: Some("18.20.8".into()), newest: Some("26".into()),
                file: ".nvmrc".into(), url: Some("https://endoflife.date/nodejs".into()),
            }, Runtime {
                product: "nodejs".into(), name: "node".into(), declared: "3".into(), cycle: Some("3".into()),
                eol: Some(Eol::Flag(true)), latest: None, newest: Some("26".into()), file: "Dockerfile".into(), url: None,
            }, Runtime {
                product: "postgresql".into(), name: "postgres".into(), declared: "99".into(), cycle: None,
                eol: None, latest: None, newest: Some("18".into()), file: "compose.yml".into(), url: None,
            }] }),
            not("github-code-scanning", Coverage::Off { reason: "no analysis found".into() }),
            // The classifiers' own answers, so maint.test.ts reads the fix strings `whyWord` matches.
            not("dependabot-alerts", crate::deps::coverage_of("HTTP 403: token lacks security_events", None)),
            not("github-work", gh_coverage("HTTP 401: Bad credentials", None)),
            not("gitlab-work", crate::forge::classify_glab("401 Unauthorized", "gitlab.com")),
            not("gitlab-ci", crate::forge::classify_glab("404 Project Not Found", "gitlab.com")),
            not("cargo-audit", Coverage::NoTool { tool: "cargo-audit".into(), fix: Some("cargo install cargo-audit".into()) }),
            not("gitlab-ci", Coverage::Unsupported { reason: "no default branch known".into() }),
            not("npm-audit", Coverage::NotRun),
            not("github-secret-scanning", Coverage::Error { reason: "HTTP 502".into() }),
            SourceReport {
                truncated: true,
                gaps: vec!["yarn.lock not read".into()],
                ..ok("osv", Facet::Security, Cost::Public, Facts::Advisories { items: vec![] })
            },
            report("nope", None, Coverage::Error { reason: "nope is not a maintenance source".into() }),
        ];
        let cfg = parse_maint("[maintenance]\nforge = \"github\"\noff = [\"prod\"]\nsources = { ci = [\"woodpecker\"] }\nbots = [\"acme-renovate\"]\ntrunk = \"main\"\ntag_pattern = \"v*\"\nsarif = [\"reports/*.sarif\"]\n[maintenance.params]\nwoodpecker_server = \"https://ci.example.com\"\n[maintenance.thresholds]\nstale_branch_days = 24\n");
        let det = Detection {
            repo_root: "/repo".into(),
            forge: Forge { kind: ForgeKind::Github, host: Some("github.com".into()), path: Some("acme/app".into()), by: ForgeBy::Table, api: None },
            sources: vec!["git-local".into(), "git-tags".into()],
            markers: vec![Marker { facet: Facet::Ci, label: "Woodpecker".into(), found: vec![".woodpecker.yml".into()] }],
            config: cfg,
            deploy: crate::deploy::parse_deploy("[deploy]
host = \"prod-1\"
compose = [\"api\", \"worker\"]
urls = { app = \"https://app.example.com\" }
sentry = \"acme/api\"
version_url = \"https://app.example.com/version\"
"),
        };
        (det, reports)
    }

    /// A new variant stops at these exhaustive matches; name it in `ALL_*` beside them, and
    /// `wire_fixture_is_current` then fails until the sample carries it.
    const ALL_STATES: [&str; 7] = ["ok", "off", "noAccess", "noTool", "unsupported", "notRun", "error"];
    const ALL_KINDS: [&str; 10] = ["ciRuns", "advisories", "updatePrs", "release", "releases", "changelog", "hygiene", "work", "probes", "runtimes"];

    fn state_of(c: &Coverage) -> &'static str {
        match c {
            Coverage::Ok => "ok",
            Coverage::Off { .. } => "off",
            Coverage::NoAccess { .. } => "noAccess",
            Coverage::NoTool { .. } => "noTool",
            Coverage::Unsupported { .. } => "unsupported",
            Coverage::NotRun => "notRun",
            Coverage::Error { .. } => "error",
        }
    }

    fn kind_of(f: &Facts) -> &'static str {
        match f {
            Facts::CiRuns { .. } => "ciRuns",
            Facts::Advisories { .. } => "advisories",
            Facts::UpdatePrs { .. } => "updatePrs",
            Facts::Release(_) => "release",
            Facts::Releases { .. } => "releases",
            Facts::Changelog { .. } => "changelog",
            Facts::Hygiene(_) => "hygiene",
            Facts::Work { .. } => "work",
            Facts::Probes { .. } => "probes",
            Facts::Runtimes { .. } => "runtimes",
        }
    }

    #[test]
    fn wire_fixture_is_current() {
        let (det, sample) = wire_sample();
        let got = serde_json::json!({ "detection": det, "reports": sample });
        let (mut states, mut kinds) = (BTreeSet::new(), BTreeSet::new());
        for (r, wire) in sample.iter().zip(got["reports"].as_array().unwrap()) {
            // The names here are serde's own, so `ALL_*` cannot drift from the wire either.
            assert_eq!(wire["coverage"]["state"].as_str(), Some(state_of(&r.coverage)));
            states.insert(state_of(&r.coverage));
            if let Some(f) = &r.facts {
                assert_eq!(wire["facts"]["kind"].as_str(), Some(kind_of(f)));
                kinds.insert(kind_of(f));
            }
        }
        assert_eq!(states, BTreeSet::from(ALL_STATES), "every Coverage state");
        assert_eq!(kinds, BTreeSet::from(ALL_KINDS), "every Facts kind");
        assert!(!got["reports"].to_string().contains("never on the wire"), "Hygiene's gaps ride on the report");

        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/maint-wire.json");
        if std::env::var_os("MAINT_WIRE_WRITE").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, serde_json::to_string_pretty(&got).unwrap() + "\n").unwrap();
            return;
        }
        let text = std::fs::read_to_string(&path).expect("test/fixtures/maint-wire.json: regenerate with MAINT_WIRE_WRITE=1 cargo test");
        let want: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(got, want, "the maint wire changed: MAINT_WIRE_WRITE=1 cargo test, then teach src/maint.ts");
    }

    fn setup(trunk: Option<&str>, tag: Option<&str>, sarif: &[&str], bots: &[&str]) -> MaintSetup {
        let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect();
        MaintSetup { trunk: trunk.map(String::from), tag_pattern: tag.map(String::from), sarif: v(sarif), bots: v(bots) }
    }

    fn cfg_file(dir: &Path) -> PathBuf {
        dir.join(".episko").join("episko.toml")
    }

    /// deploy.ts's `checkMaintCfg` runs the same table, so the two languages cannot drift apart.
    #[test]
    fn setup_checks_agree_with_deploy_ts() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/maint-checks.json");
        let table: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in table["cases"].as_array().unwrap() {
            let (field, v) = (case["field"].as_str().unwrap(), case["value"].as_str().unwrap());
            let want: Vec<String> = case["refused"].as_str().map(String::from).into_iter().collect();
            if field == "key" {
                let p = parse_maint_proposal(&format!("```toml\n[maintenance]\n{v} = 1\n```\n")).unwrap();
                // The proposal names the key and serde refuses it at write; the line is deploy.ts's alone.
                assert_eq!((p.unknown, want.len()), (vec![v.to_string()], 1), "{v}");
                continue;
            }
            let s = match field {
                "trunk" => setup(Some(v), None, &[], &[]),
                "tag_pattern" => setup(None, Some(v), &[], &[]),
                "sarif" => setup(None, None, &[v], &[]),
                "bots" => setup(None, None, &[], &[v]),
                other => panic!("no field {other}"),
            };
            let (kept, out) = keep_setup(s);
            assert_eq!(out, want, "{field} = {v:?}");
            assert_eq!(kept == MaintSetup::default(), !want.is_empty(), "{field} = {v:?}");
        }
    }

    #[test]
    fn a_setup_key_the_writer_does_not_know_is_refused() {
        let bad = serde_json::from_value::<MaintSetup>(serde_json::json!({ "trunk": "dev", "off": ["prod"] }));
        assert!(bad.is_err(), "an unknown key never reaches the file");
        let ok = serde_json::from_value::<MaintSetup>(serde_json::json!({ "tagPattern": "v*" })).unwrap();
        assert_eq!(ok, setup(None, Some("v*"), &[], &[]));
        let p = parse_maint_proposal("```toml\n[maintenance]\ntrunk = \"dev\"\nsarif = \"out/x.sarif\"\noff = [\"prod\"]\n[maintenance.thresholds]\nx = 1\n```\nWHY\n- trunk: CONTRIBUTING.md\n").unwrap();
        assert_eq!(p.maintenance, setup(Some("dev"), None, &["out/x.sarif"], &[]), "a bare string is a list of one");
        assert_eq!((p.unknown, p.why), (vec!["off".to_string(), "thresholds".into()], vec!["trunk: CONTRIBUTING.md".to_string()]));
        assert!(parse_maint_proposal("nothing").is_err());
        let (kept, out) = keep_setup(setup(Some(" dev "), Some(""), &["a.sarif", " a.sarif", ""], &[]));
        assert_eq!((kept, out.len()), (setup(Some("dev"), None, &["a.sarif"], &[]), 0), "trimmed, deduplicated, empties gone");
    }

    #[test]
    fn a_setup_write_keeps_every_hand_written_line() {
        let dir = scratch_dir();
        let before = "# team settings\n[branches]\nprotect = [\"dev\"]\n\n[maintenance]\ntrunk = \"dev\" # releases are cut here\n\
                      off = [\"prod\"]\n\n[maintenance.thresholds]\nstale_branch_days = 14\n";
        write(&dir, ".episko/episko.toml", before);
        let want = setup(Some("dev"), Some("v*"), &["reports/*.sarif"], &["acme-renovate"]);
        write_maint(s(&dir), want.clone(), false).unwrap();
        let text = std::fs::read_to_string(cfg_file(&dir)).unwrap();
        let head = "# team settings\n[branches]\nprotect = [\"dev\"]\n\n[maintenance]\ntrunk = \"dev\" # releases are cut here\noff = [\"prod\"]\n";
        assert!(text.starts_with(head), "{text}");
        let c = parse_maint(&text);
        assert_eq!(MaintSetup::of(&c), want);
        assert_eq!((c.off.clone(), c.thresholds.get("stale_branch_days")), (vec!["prod".to_string()], Some(&14.0)), "a person's keys stay");
        assert_eq!(serde_json::to_value(crate::git::parse_protect(&text)).unwrap(), serde_json::to_value(crate::git::parse_protect(before)).unwrap());
        // Removing what the agent no longer proposes takes only those keys.
        write_maint(s(&dir), setup(Some("dev"), None, &[], &[]), false).unwrap();
        let after = std::fs::read_to_string(cfg_file(&dir)).unwrap();
        assert_eq!(MaintSetup::of(&parse_maint(&after)), setup(Some("dev"), None, &[], &[]));
        assert!(after.contains("trunk = \"dev\" # releases are cut here") && after.contains("stale_branch_days = 14"), "{after}");
    }

    #[test]
    fn an_unchanged_setup_writes_nothing() {
        let dir = scratch_dir();
        let text = "[maintenance]\nbots   = [ 'acme-renovate' ]\ntrunk='dev'\n";
        write(&dir, ".episko/episko.toml", text);
        let mtime = std::fs::metadata(cfg_file(&dir)).unwrap().modified().unwrap();
        write_maint(s(&dir), setup(Some("dev"), None, &[], &["acme-renovate"]), false).unwrap();
        assert_eq!(std::fs::read_to_string(cfg_file(&dir)).unwrap(), text);
        assert_eq!(std::fs::metadata(cfg_file(&dir)).unwrap().modified().unwrap(), mtime);
        assert!(!dir.join(".episko").join("episko.toml.tmp").exists());
        let held = "[maintenance] # ops owns this\n\n[maintenance.thresholds]\nstale_branch_days = 14\n";
        write(&dir, ".episko/episko.toml", held);
        write_maint(s(&dir), MaintSetup::default(), false).unwrap();
        assert_eq!(std::fs::read_to_string(cfg_file(&dir)).unwrap(), held, "a header over subtables only is left alone");
        write(&dir, ".episko/episko.toml", "[maintenance] # ops owns this\ntrunk = \"dev\"\n\n[maintenance.thresholds]\nx = 1\n");
        write_maint(s(&dir), MaintSetup::default(), false).unwrap();
        let after = std::fs::read_to_string(cfg_file(&dir)).unwrap();
        assert!(after.contains("[maintenance] # ops owns this") && !after.contains("trunk"), "a commented header survives: {after}");
    }

    #[test]
    fn a_setup_write_drops_the_projects_cached_reports() {
        let dir = scratch_dir();
        write(&dir, ".episko/episko.toml", "[maintenance]\ntrunk = \"dev\"\n");
        let key = root_key(&s(&dir));
        let held = || REPORTS.lock().unwrap().as_ref().is_some_and(|m| m.keys().any(|(r, _, _)| *r == key));
        let put = || REPORTS.lock().unwrap().get_or_insert_with(HashMap::new)
            .insert((key.clone(), "git-tags".into(), String::new()), (Instant::now(), report("git-tags", None, Coverage::NotRun)));
        put();
        write_maint(s(&dir), setup(Some("dev"), None, &[], &[]), false).unwrap();
        assert!(held(), "an unchanged file keeps every report");
        write_maint(s(&dir), setup(Some("main"), None, &[], &[]), false).unwrap();
        assert!(!held(), "a new trunk is read again, not served from the cache");
    }

    #[test]
    fn a_setup_write_refuses_and_names_an_unsafe_value() {
        let dir = scratch_dir();
        write(&dir, ".episko/episko.toml", "[maintenance]\ntrunk = \"dev\"\n");
        let e = write_maint(s(&dir), setup(Some("--orphan"), Some("v[0-9]*"), &["../x.sarif"], &[]), false).unwrap_err();
        assert!(e.contains("trunk = \"--orphan\"") && e.contains("tag_pattern = \"v[0-9]*\"") && e.contains("../x.sarif"), "{e}");
        assert_eq!(maint_setup(s(&dir)), setup(Some("dev"), None, &[], &[]), "refused, so nothing moved");
    }

    #[test]
    fn a_setup_creates_a_file_only_when_asked() {
        let dir = scratch_dir();
        assert_eq!(write_maint(s(&dir), setup(Some("dev"), None, &[], &[]), false), Err(crate::deploy::NO_FILE.to_string()));
        assert!(!cfg_file(&dir).exists());
        write_maint(s(&dir), MaintSetup::default(), true).unwrap();
        assert!(!cfg_file(&dir).exists(), "nothing to write is no new file");
        write_maint(s(&dir), setup(Some("dev"), Some("v*"), &[], &[]), true).unwrap();
        assert_eq!(maint_setup(s(&dir)), setup(Some("dev"), Some("v*"), &[], &[]));
    }

    #[test]
    fn a_setup_table_beside_its_subtables() {
        let dev = setup(Some("dev"), None, &[], &[]);
        let mut doc = "[maintenance.thresholds]\nstale_branch_days = 14\n".parse::<toml_edit::DocumentMut>().unwrap();
        set_setup(&mut doc, &MaintSetup::default(), &dev).unwrap();
        let text = doc.to_string();
        assert_eq!(MaintSetup::of(&parse_maint(&text)), dev, "{text}");
        assert_eq!(parse_maint(&text).thresholds.get("stale_branch_days"), Some(&14.0), "{text}");
        set_setup(&mut doc, &dev, &MaintSetup::default()).unwrap();
        assert_eq!(doc.to_string(), "[maintenance.thresholds]\nstale_branch_days = 14\n", "no empty header is left above it");
        let mut gone = "[stack]\nup = \"x\"\n\n[maintenance]\ntrunk = \"dev\"\n".parse::<toml_edit::DocumentMut>().unwrap();
        set_setup(&mut gone, &dev, &MaintSetup::default()).unwrap();
        assert_eq!(gone.to_string(), "[stack]\nup = \"x\"\n");
        let mut bad = "maintenance = 3\n".parse::<toml_edit::DocumentMut>().unwrap();
        assert!(set_setup(&mut bad, &MaintSetup::default(), &dev).is_err());
    }
}
