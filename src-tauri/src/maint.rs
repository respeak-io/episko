//! Maintenance's backend (docs/maintenance.md): the wire, the compiled-in manifest, detection,
//! `[maintenance]`, the cost gate and the report cache. Rust reads facts; `maint.ts` judges them.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::forge::{Forge, ForgeKind};
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
#[allow(dead_code, reason = "`Off` is raised by the security adapters of later slices")]
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
#[allow(dead_code, reason = "made by the security adapters; the wire fixture pins it now")]
pub(crate) enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Unknown,
}

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code, reason = "made by the security adapters; the wire fixture pins it now")]
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
#[allow(dead_code, reason = "made by the security adapters; the wire fixture pins it now")]
pub(crate) struct Advisory {
    id: String,
    aliases: Vec<String>,
    kind: AdvisoryKind,
    pkg: Option<String>,
    ecosystem: Option<String>,
    version: Option<String>,
    severity: Severity,
    raw_severity: String,
    summary: String,
    fixed: Option<String>,
    location: Option<String>,
    url: Option<String>,
    tool: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "made by the update-bot adapters; the wire fixture pins it now")]
pub(crate) struct UpdatePr {
    number: u64,
    title: String,
    url: String,
    branch: String,
    draft: bool,
    at: Option<u64>,
    checks: CiStatus,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "made by github-releases; the wire fixture pins it now")]
pub(crate) struct ForgeRelease {
    tag: String,
    name: String,
    at: Option<u64>,
    url: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, reason = "made by http-probe; the wire fixture pins it now")]
pub(crate) struct Probe {
    name: String,
    url: String,
    code: Option<u16>,
    ms: Option<u32>,
    cert_not_after: Option<u64>,
    err: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[allow(dead_code, reason = "the adapters of later slices make the other kinds")]
pub(crate) enum Facts {
    CiRuns { branch: String, runs: Vec<CiRun> },
    Advisories { items: Vec<Advisory> },
    UpdatePrs { bot: String, configured: bool, prs: Vec<UpdatePr>, dashboard: Option<u64> },
    Release(ReleaseFacts),
    Releases { latest: Option<ForgeRelease>, count: u32 },
    Changelog { unreleased: Option<u32>, latest: Option<String>, latest_at: Option<u64> },
    Hygiene(Hygiene),
    Work { issues: u32, prs: u32, review_requested: u32 },
    Probes { items: Vec<Probe> },
}

impl Facts {
    /// The one facet each kind may answer; a read that crosses it is an error, never a cell.
    pub(crate) fn facet(&self) -> Facet {
        match self {
            Facts::CiRuns { .. } => Facet::Ci,
            Facts::Advisories { .. } => Facet::Security,
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
}

// ---------- the manifest ----------

/// The closed capability vocabulary `sees`/`blind` may use; `maint.ts`'s `MAINT_CAPS` mirrors it.
pub(crate) const MAINT_CAPS: &[&str] = &[
    "ci.default-branch", "ci.per-workflow", "ci.failing-since", "ci.disabled", "ci.external", "ci.other-branches",
    "git.unpushed", "git.local-only", "git.merged", "git.gone", "git.branch-age", "git.worktree-age",
    "git.squash-merged", "rel.unreleased", "rel.last", "rel.published", "rel.changelog",
];

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
struct BotDef {
    id: String,
    logins: Vec<String>,
    branch: String,
    dashboard: Option<String>,
    config: Vec<String>,
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
        .map(|(k, v)| (k.clone(), list(Some(v))))
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
    match std::fs::read_to_string(Path::new(root).join(".episko").join("episko.toml")) {
        Ok(text) => parse_maint(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => MaintConfig::default(),
        Err(_) => MaintConfig { readable: false, ..Default::default() },
    }
}

fn facet_off(cfg: &MaintConfig, facet: Facet) -> bool {
    cfg.off.iter().any(|o| o == facet.id())
}

fn enabled(cfg: &MaintConfig, id: &str, facet: Facet) -> bool {
    let picked = cfg.sources.get(facet.id()).is_none_or(|ids| ids.iter().any(|i| i == id));
    !facet_off(cfg, facet) && !cfg.off.iter().any(|o| o == id) && picked
}

// ---------- detection ----------

const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "venv", "__pycache__"];
const JSON_CAP: u64 = 2 * 1024 * 1024;
const DETECT_TTL: Duration = Duration::from_secs(30);

fn present(p: &Path, dir: bool, key: Option<&str>) -> bool {
    if dir {
        return std::fs::read_dir(p).is_ok_and(|mut d| d.next().is_some());
    }
    let Some(key) = key else { return p.exists() };
    p.is_file()
        && std::fs::metadata(p).is_ok_and(|m| m.len() <= JSON_CAP)
        && std::fs::read_to_string(p).ok()
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
    let sources = SOURCES.iter()
        .filter(|d| {
            let m = &MANIFEST.sources[d.id];
            applies(&m.forge, &m.detect, forge.kind, &probes).is_some() && enabled(&config, d.id, m.facet)
        })
        .map(|d| d.id.to_string())
        .collect();
    let host = forge.host.clone().unwrap_or_else(|| "this host".into());
    let markers = MANIFEST.markers.iter()
        .filter(|m| !facet_off(&config, m.facet))
        .filter_map(|m| {
            applies(&m.forge, &m.detect, forge.kind, &probes)
                .map(|found| Marker { facet: m.facet, label: m.label.replace("{host}", &host), found })
        })
        .collect();
    Detection { repo_root, forge, sources, markers, config }
}

type Cache<K, V> = Mutex<Option<HashMap<K, (Instant, V)>>>;
static DETECTIONS: Cache<String, Detection> = Mutex::new(None);

fn root_key(root: &str) -> String {
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

// ---------- Exec: the only side-effect seam ----------

pub(crate) use exec::{Exec, SysExec};

pub(crate) mod exec {
    #![allow(dead_code, reason = "only gh is called yet; the GitLab, tool and remote adapters of later slices call the rest")]

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
    /// to curl on stdin, never on argv, and only a name on `ENV_TOKENS` is ever read.
    pub(crate) struct HttpReq {
        pub(crate) url: String,
        pub(crate) body: Option<String>,
        pub(crate) token: Option<(&'static str, &'static str)>,
        pub(crate) secs: u64,
    }

    #[derive(Debug)]
    pub(crate) struct HttpResp {
        pub(crate) code: u16,
        pub(crate) body: String,
    }

    pub(crate) trait Exec: Sync {
        fn gh(&self, root: &str, account: Option<&str>, args: &[&str]) -> Result<String, String>;
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
        (Cost::Tool, &["npm", "pnpm", "cargo"]),
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
            crate::github::gh(root, account, args)
        }

        fn glab(&self, _root: &str, _args: &[&str]) -> Result<String, String> {
            self.trust("glab")?;
            Err("GitLab is not read yet (forge::glab arrives with the GitLab slice)".into())
        }

        fn tool(&self, root: &str, bin: &str, args: &[&str], secs: u64) -> Result<Output, String> {
            self.trust(bin)?;
            let mut cmd = sys_command(bin);
            cmd.env("PATH", augmented_path()).current_dir(root).args(args).env("NO_COLOR", "1").env("CI", "1");
            crate::deps::run_capped(cmd, secs).map(Output::from)
        }

        fn http(&self, req: &HttpReq) -> Result<HttpResp, String> {
            self.trust("curl")?;
            if !(req.url.starts_with("https://") || req.url.starts_with("http://")) {
                return Err(format!("{} is not an http(s) URL", req.url));
            }
            let mut cmd = sys_command(CURL);
            cmd.args(["-sS", "-w", "\n%{http_code}", "--max-time"]).arg(req.secs.to_string());
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
            let out = run_fed(cmd, input, req.secs + 5)?;
            let (body, code) = out.stdout.rsplit_once('\n').unwrap_or(("", out.stdout.as_str()));
            let code = code.trim().parse().map_err(|_| out.stderr.trim().to_string())?;
            Ok(HttpResp { code, body: body.to_string() })
        }

        fn ssh(&self, alias: &str, script: &str, secs: u64) -> Result<Output, String> {
            self.trust("ssh")?;
            let alias = data_arg(alias)?;
            let mut cmd = sys_command("ssh");
            cmd.env("PATH", augmented_path()).args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", alias, "sh", "-s"]);
            run_fed(cmd, Some(script.to_string()), secs)
        }

        fn on_path(&self, bin: &str) -> bool {
            crate::deps::on_path(bin)
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
    }

    #[cfg(test)]
    impl FakeExec {
        pub(crate) fn answering(fallback: Result<&str, &str>) -> Self {
            let fallback = fallback.map(str::to_string).map_err(str::to_string);
            Self { answers: vec![], fallback, calls: Default::default(), accounts: Default::default() }
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
            self.accounts.lock().unwrap().push(account.map(str::to_string));
            self.answer(Self::argv("gh", args))
        }
        fn glab(&self, _root: &str, args: &[&str]) -> Result<String, String> {
            self.answer(Self::argv("glab", args))
        }
        fn tool(&self, _root: &str, bin: &str, args: &[&str], _secs: u64) -> Result<Output, String> {
            self.answer(Self::argv(bin, args)).map(|stdout| Output { code: Some(0), stdout, stderr: String::new() })
        }
        fn http(&self, req: &HttpReq) -> Result<HttpResp, String> {
            self.answer(Self::argv("curl", &[&req.url])).map(|body| HttpResp { code: 200, body })
        }
        fn ssh(&self, alias: &str, _script: &str, _secs: u64) -> Result<Output, String> {
            self.answer(Self::argv("ssh", &[alias])).map(|stdout| Output { code: Some(0), stdout, stderr: String::new() })
        }
        fn on_path(&self, _bin: &str) -> bool {
            true
        }
    }
}

// ---------- the registry, the gate and the cache ----------

/// What a read gets besides its `Exec`. `account` is the project's GitHub pin, passed to every `gh`.
pub(crate) struct Ctx<'a> {
    pub(crate) root: &'a str,
    pub(crate) cfg: &'a MaintConfig,
    pub(crate) forge: &'a Forge,
    pub(crate) account: Option<&'a str>,
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
    SourceDef { id: "git-local", read: crate::maint_git::git_local },
    SourceDef { id: "git-tags", read: crate::maint_git::git_tags },
    SourceDef { id: "changelog", read: crate::maint_git::changelog },
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
    let ctx = Ctx { root: &det.repo_root, cfg: &det.config, forge: &det.forge, account };
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

    /// A repo every local source can answer: a tag, a changelog, a trunk named in config.
    fn fixture_repo() -> PathBuf {
        let dir = scratch_dir();
        git(&dir, &["init", "-q", "-b", "main"]);
        commit(&dir, "one");
        git(&dir, &["-c", "tag.gpgsign=false", "tag", "v1.0"]);
        commit(&dir, "two");
        write(&dir, "CHANGELOG.md", "# Changelog\n\n## Unreleased\n+ a thing\n\n## 1.0 — 2026-10-01\n+ first\n");
        write(&dir, ".episko/episko.toml", "[maintenance]\ntrunk = \"main\"\n");
        dir
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    /// `fixture_repo` on github.com holding every file a source detects, so each read gets as
    /// far as its `Exec` instead of bailing on "not a repo" or "no forge" first.
    fn rich_repo() -> PathBuf {
        let dir = fixture_repo();
        git(&dir, &["remote", "add", "origin", "https://github.com/acme/app.git"]);
        for d in MANIFEST.sources.values().flat_map(|s| &s.detect) {
            let (path, key) = d.split_once('#').map_or((d.as_str(), None), |(p, k)| (p, Some(k)));
            match key {
                _ if dir.join(path).exists() => {}
                Some(k) => write(&dir, path, &format!("{{\"{k}\": {{}}}}")),
                None if path.ends_with('/') => write(&dir, &format!("{path}x"), ""),
                None => write(&dir, path, ""),
            }
        }
        assert_eq!(detect(&s(&dir), true).sources.len(), SOURCES.len(), "the fixture must detect every source");
        dir
    }

    const NO_FORGE: Forge = Forge { kind: ForgeKind::None, host: None, path: None, by: ForgeBy::None };

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
        // A bot's config files are what its deps marker detects; the two lists must not drift.
        for b in &MANIFEST.bots {
            let m = MANIFEST.markers.iter().find(|m| m.facet == Facet::Deps && m.label.to_lowercase() == b.id);
            assert_eq!(m.map(|m| &m.detect), Some(&b.config), "bot {}", b.id);
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
        let ok = |f: &[&str], k| forge_admits(&f.iter().map(|s| s.to_string()).collect::<Vec<_>>(), k);
        assert!(ok(&["!github"], ForgeKind::None) && !ok(&["!github"], ForgeKind::Github) && ok(&[], ForgeKind::Github));
        let extra = include_str!("../../src/maintmanifest.json").replace("\"facet\": \"git\",", "\"facet\": \"git\", \"argv\": [\"rm\"],");
        assert!(serde_json::from_str::<Manifest>(&extra).is_err(), "no field the manifest does not define");
    }

    #[test]
    fn no_source_answers_ok_on_garbage() {
        let root = s(&rich_repo());
        let det = detect(&root, true);
        let ctx = Ctx { root: &root, cfg: &det.config, forge: &det.forge, account: None };
        for def in SOURCES {
            let meta = &MANIFEST.sources[def.id];
            for ex in garbage() {
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

    #[test]
    fn every_source_answers_facts_of_its_own_facet() {
        let root = s(&fixture_repo());
        let cfg = read_config(&root);
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None };
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
        SourceMeta { facet, label: "test".into(), cost, forge: vec![], detect: vec![], sees: vec![], blind: vec![] }
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
                    let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None };
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
        let ctx = Ctx { root: &root, cfg: &cfg, forge: &NO_FORGE, account: None };
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

    #[test]
    fn every_call_uses_a_bin_trusted_for_its_cost() {
        let root = s(&rich_repo());
        let det = detect(&root, true);
        let ctx = Ctx { root: &root, cfg: &det.config, forge: &det.forge, account: None };
        for def in SOURCES {
            let m = &MANIFEST.sources[def.id];
            let ex = FakeExec::answering(Ok(""));
            let _ = (def.read)(&ctx, &ex);
            assert_eq!(ex.calls().is_empty(), m.cost == Cost::Local, "{}: only a local source makes no call", def.id);
            for call in ex.calls() {
                assert!(trusted(m.cost, &call[0]), "{} ({:?}) called {call:?}", def.id, m.cost);
            }
        }
        // The real seam refuses before it spawns anything.
        assert!(SysExec { cost: Cost::Local }.gh(&root, None, &["api", "user"]).unwrap_err().contains("not trusted"));
        assert!(SysExec { cost: Cost::Forge }.tool(&root, "npm", &["audit"], 5).unwrap_err().contains("not trusted"));
        assert!(SysExec { cost: Cost::Tool }.tool(&root, "rm", &["-rf", "."], 5).unwrap_err().contains("not trusted"));
        assert!(SysExec { cost: Cost::Tool }.ssh("prod", "uptime", 5).unwrap_err().contains("not trusted"));
        let req = HttpReq { url: "file:///etc/passwd".into(), body: None, token: None, secs: 5 };
        assert!(SysExec { cost: Cost::Remote }.http(&req).is_err(), "only http(s)");
        let req = HttpReq { url: "https://x.example".into(), body: None, token: Some(("Authorization: Bearer ", "HOME")), secs: 5 };
        assert!(SysExec { cost: Cost::Remote }.http(&req).unwrap_err().contains("not a token"), "only allowlisted env names");
        for bad in ["-oProxyCommand=x", "a b", ""] {
            assert!(data_arg(bad).is_err(), "{bad:?}");
        }
        assert_eq!(data_arg("prod-1"), Ok("prod-1"));
    }

    fn counts_gh(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
        ex.gh(ctx.root, None, &["api", "x"]).map_err(|reason| Coverage::Error { reason })?;
        Ok(Read::of(Facts::Work { issues: 1, prs: 0, review_requested: 0 }))
    }

    #[test]
    fn the_report_cache_is_keyed_by_account() {
        let root = "/maint-test/cache-by-account";
        let cfg = MaintConfig::default();
        let ctx = Ctx { root, cfg: &cfg, forge: &NO_FORGE, account: None };
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
        let ctx = Ctx { root, cfg: &cfg, forge: &NO_FORGE, account: None };
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
             sources = { ci = [\"woodpecker\"], nonsense = [\"x\"] }\n\
             [maintenance.params]\nwoodpecker_server = \"https://ci.example.com\"\nsneaky = \"file:///etc/passwd\"\n\
             [maintenance.thresholds]\nstale_branch_days = 24\nunreleased_days = 2.5\nbad = \"x\"\n",
        );
        assert!(c.readable);
        assert_eq!((c.forge.as_deref(), c.off.clone(), c.trunk.clone()), (Some("gitlab"), vec!["prod".to_string()], None));
        assert_eq!(c.sources.keys().collect::<Vec<_>>(), ["ci"], "only facets restrict");
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
        let dir = repo_with("https://github.com/a/b.git", &[("CHANGELOG.md", "# Changelog\n")]);
        assert_eq!(detect(&s(&dir), true).sources, ["git-local", "git-tags", "changelog"]);
        write(&dir, ".episko/episko.toml", "[maintenance]\nsources = { release = [\"changelog\"] }\n");
        assert_eq!(detect(&s(&dir), true).sources, ["git-local", "changelog"]);
        write(&dir, ".episko/episko.toml", "[maintenance]\noff = [\"release\", \"git-local\", \"ci\"]\n");
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
        let mono = repo_with("https://github.com/a/b.git", &[("pkg/CHANGELOG.md", "# pkg\n")]);
        assert_eq!(detect(&s(&mono), true).sources, ["git-local", "git-tags"]);
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
            ok("github-work", Facet::Work, Cost::Forge, Facts::Work { issues: 12, prs: 3, review_requested: 1 }),
            ok("http-probe", Facet::Prod, Cost::Remote, Facts::Probes { items: vec![Probe {
                name: "app".into(), url: "https://app.example.com".into(), code: Some(200), ms: Some(120),
                cert_not_after: Some(1_795_000_000), err: None,
            }] }),
            not("github-code-scanning", Coverage::Off { reason: "no analysis found".into() }),
            not("dependabot-alerts", Coverage::NoAccess { reason: "token lacks security_events".into(), fix: Some("gh auth refresh -h github.com -s security_events".into()) }),
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
            forge: Forge { kind: ForgeKind::Github, host: Some("github.com".into()), path: Some("acme/app".into()), by: ForgeBy::Table },
            sources: vec!["git-local".into(), "git-tags".into()],
            markers: vec![Marker { facet: Facet::Ci, label: "Woodpecker".into(), found: vec![".woodpecker.yml".into()] }],
            config: cfg,
        };
        (det, reports)
    }

    /// A new variant stops at these exhaustive matches; name it in `ALL_*` beside them, and
    /// `wire_fixture_is_current` then fails until the sample carries it.
    const ALL_STATES: [&str; 7] = ["ok", "off", "noAccess", "noTool", "unsupported", "notRun", "error"];
    const ALL_KINDS: [&str; 9] = ["ciRuns", "advisories", "updatePrs", "release", "releases", "changelog", "hygiene", "work", "probes"];

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
}
