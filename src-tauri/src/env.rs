//! Environments: which `.env` each of a checkout's environments is pointed at, and the presets
//! it could be pointed at instead. A checkout has one per target; only a target pattern's
//! wildcard segment reads a directory to find children, and the active preset is decided by
//! comparing content, so nothing here is remembered (docs/environments.md).

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Bigger than this is not an env file, and reading it would only slow the scan down.
const MAX_ENV_BYTES: u64 = 1 << 20;
/// A directory holding this many matches is not an env directory either.
const MAX_PRESETS: usize = 200;

/// The `[env]` table of `.episko/episko.toml`. Every field is optional: a project overrides
/// the app's defaults where it speaks and stays silent everywhere else.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvPolicy {
    /// One per environment the project keeps. A monorepo names them (`apps/*/.env`); a single
    /// app is the one-element case and reads exactly as it did.
    pub targets: Option<Vec<String>>,
    pub presets: Option<Vec<String>>,
    pub ignore: Option<Vec<String>>,
    /// `[[env.tag]]` in hand-written TOML, `tags` on the wire: `health.rs`'s alias trick.
    #[serde(default, alias = "tag")]
    pub tags: Vec<EnvTag>,
}

/// One naming rule. `pattern` is JS RegExp source, compiled by the frontend, which owns every
/// threshold here the way `health.ts` owns `health.rs`'s.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvTag {
    #[serde(rename = "match")]
    pub pattern: String,
    pub tone: Option<String>,
    pub label: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvPreset {
    /// Project-relative, forward slashes: the id every surface passes back.
    pub path: String,
    /// What a chip says before a rule renames it: `prod` from `.env.prod` or `envs/prod.env`.
    pub name: String,
    pub vars: u32,
    pub mtime_ms: f64,
    /// The target's content matches this one, so this is what the checkout is running.
    pub active: bool,
}

/// One environment: a target file and the presets sitting beside it. A checkout has as many
/// as its patterns find, which in a monorepo is one per package.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvGroup {
    /// Project-relative directory the target sits in; empty at the root.
    pub dir: String,
    /// Project-relative path of the target itself, and what every surface names the group by.
    pub target: String,
    /// `missing` · `preset` (one entry is `active`) · `modified` (content no preset holds).
    pub state: String,
    pub presets: Vec<EnvPreset>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvScan {
    pub groups: Vec<EnvGroup>,
    pub policy: EnvPolicy,
    /// The file exists and does not parse. A broken table overrides nothing, but it must not
    /// read as "this project said nothing" — `ProtectList.readable`'s rule (git.rs).
    pub policy_readable: bool,
}

#[derive(Deserialize, Default)]
struct RawEnvFile {
    env: Option<EnvPolicy>,
}

fn episko_toml(root: &Path) -> PathBuf {
    root.join(".episko").join("episko.toml")
}

/// A project-relative path that cannot escape the project: every component must be a plain
/// name, which refuses `..`, a leading separator and a Windows drive prefix in one test.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if rel.trim().is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("{rel} is not a path inside the project"));
    }
    Ok(root.join(p))
}

fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_ENV_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

/// Line endings and trailing blank lines only. Another editor's CRLF round-trip must not read
/// as "somebody hand-wrote this", which is the one state that stops a switch to ask.
fn normalized(bytes: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = bytes.iter().copied().filter(|b| *b != b'\r').collect();
    while matches!(out.last(), Some(b'\n')) {
        out.pop();
    }
    out
}

/// Assignments, which is what a person means by "how big is this one". Comments and blank
/// lines are not it, and `export FOO=1` is.
fn var_count(bytes: &[u8]) -> u32 {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter(|l| {
            let t = l.trim().trim_start_matches("export ").trim_start();
            !t.starts_with('#') && !t.starts_with('=') && t.contains('=')
        })
        .count() as u32
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `.env.prod`, `prod.env` and `envs/prod` all name the same environment; a chip says which
/// one you are on, not how the project spells its files.
fn preset_name(rel: &str) -> String {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    let stripped = base
        .strip_prefix(".env.")
        .or_else(|| base.strip_suffix(".env"))
        .or_else(|| base.strip_prefix("env."))
        .unwrap_or(base);
    let trimmed = stripped.trim_matches('.');
    if trimmed.is_empty() { base.to_string() } else { trimmed.to_string() }
}

/// Never descended into when a target pattern's directory segment holds a `*`. Expanding one
/// is the only thing here that resembles a walk, and these are where the depth would go.
const SKIP_DIRS: [&str; 7] = ["node_modules", "dist", "build", "target", "vendor", "out", "coverage"];

/// How many directories one wildcard segment may fan out to, so `*/*/.env` on a large repo
/// cannot turn a scan into a crawl.
const MAX_TARGET_DIRS: usize = 64;

/// The directory names the preset patterns reserve (`envs/*` → `envs`). A wildcard target must
/// never adopt one: that is where a project keeps its presets, not a package with an
/// environment of its own, and adopting it lists the same file under two headings.
fn preset_dirs(pats: &[String]) -> Vec<String> {
    pats.iter()
        .filter_map(|p| p.trim().replace('\\', "/").rsplit_once('/').map(|(d, _)| d.to_string()))
        .flat_map(|d| d.split('/').map(String::from).collect::<Vec<_>>())
        .filter(|d| !d.is_empty() && !d.contains('*'))
        .collect()
}

/// The directories one `apps/*` names. A segment without `*` is joined; a segment with one is
/// the only place this reads a directory listing to find its children.
fn expand_dirs(root: &Path, dir: &str, reserved: &[String]) -> Vec<String> {
    if dir.is_empty() {
        return vec![String::new()];
    }
    let mut at = vec![String::new()];
    for seg in dir.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        let mut next = Vec::new();
        for base in &at {
            if !seg.contains('*') {
                let joined = if base.is_empty() { seg.to_string() } else { format!("{base}/{seg}") };
                if inside(root, &joined).is_ok_and(|p| p.is_dir()) {
                    next.push(joined);
                }
                continue;
            }
            let Ok(abs) = inside(root, base).or_else(|_| Ok::<_, String>(root.to_path_buf())) else { continue };
            let Ok(rd) = std::fs::read_dir(if base.is_empty() { root } else { &abs }) else { continue };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) || !e.path().is_dir() {
                    continue;
                }
                if reserved.contains(&name) {
                    continue;
                }
                if !crate::git::glob_match(seg, &name) {
                    continue;
                }
                next.push(if base.is_empty() { name } else { format!("{base}/{name}") });
                if next.len() >= MAX_TARGET_DIRS {
                    break;
                }
            }
        }
        next.sort();
        next.dedup();
        next.truncate(MAX_TARGET_DIRS);
        at = next;
    }
    at
}

/// Every (directory, target) a target pattern names, whether or not the target exists yet: a
/// package with presets and no `.env` is exactly the case the picker is for.
fn target_candidates(root: &Path, pats: &[String], reserved: &[String]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for pat in pats {
        let pat = pat.trim().replace('\\', "/");
        let (dir, file) = pat
            .rsplit_once('/')
            .map_or((String::new(), pat.clone()), |(d, f)| (d.to_string(), f.to_string()));
        if file.is_empty() || file.contains('*') {
            continue; // a target names one file; a wildcard there would make every preset a target
        }
        for d in expand_dirs(root, &dir, reserved) {
            let target = if d.is_empty() { file.clone() } else { format!("{d}/{file}") };
            if inside(root, &target).is_ok() {
                out.push((d, target));
            }
        }
    }
    out.sort();
    out.dedup();
    out.truncate(MAX_TARGET_DIRS);
    out
}

/// Every preset beside `base`, reading each directory ONCE however many patterns name it:
/// `.env.*` and `*.env` are the same listing, and a wildcard target means this runs per
/// candidate directory. The directory part is literal, so there is still no walk here.
fn collect_presets(root: &Path, base: &str, pats: &[String]) -> Vec<String> {
    let mut by_dir: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for pat in pats {
        let pat = pat.trim().replace('\\', "/");
        let (dir, file) = pat
            .rsplit_once('/')
            .map_or((String::new(), pat.clone()), |(d, f)| (d.to_string(), f.to_string()));
        if file.is_empty() {
            continue;
        }
        // Relative to the target's own directory, so `.env.*` finds `apps/web/.env.prod` for
        // `apps/web/.env` without the project spelling it out.
        let dir = match (base.is_empty(), dir.is_empty()) {
            (true, _) => dir,
            (false, true) => base.to_string(),
            (false, false) => format!("{base}/{dir}"),
        };
        by_dir.entry(dir).or_default().push(file);
    }
    let mut out = Vec::new();
    for (dir, files) in by_dir {
        let abs = if dir.is_empty() {
            root.to_path_buf()
        } else {
            match inside(root, &dir) {
                Ok(p) => p,
                Err(_) => continue,
            }
        };
        let Ok(rd) = std::fs::read_dir(&abs) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // A filename holds no `/`, so git.rs's matcher — where `*` crosses one, for
            // `release/*` — is the same function here, and one matcher beats two that agree.
            if !files.iter().any(|f| crate::git::glob_match(f, &name)) || !e.path().is_file() {
                continue;
            }
            out.push(if dir.is_empty() { name } else { format!("{dir}/{name}") });
            if out.len() >= MAX_PRESETS {
                return out;
            }
        }
    }
    out
}

fn ignored(skip: &[String], rel: &str) -> bool {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    skip.iter().any(|s| crate::git::glob_match(s, rel) || crate::git::glob_match(s, base))
}

/// A project's `[env]` table, and whether the file it lives in could be read at all.
fn read_policy(root: &Path) -> (EnvPolicy, bool) {
    match std::fs::read_to_string(episko_toml(root)) {
        Ok(t) => match toml::from_str::<RawEnvFile>(&t) {
            Ok(f) => (f.env.unwrap_or_default(), true),
            Err(_) => (EnvPolicy::default(), false),
        },
        Err(_) => (EnvPolicy::default(), true),
    }
}

/// One target and the presets beside it, or `None` when there is nothing here to say: no
/// target file and no presets is a directory that does not work this way.
fn scan_group(root: &Path, dir: &str, target: &str, pats: &[String], skip: &[String]) -> Option<EnvGroup> {
    let target_abs = inside(root, target).ok()?;
    let mut rel: Vec<String> = collect_presets(root, dir, pats);
    rel.sort();
    rel.dedup();
    rel.retain(|r| r != target && !ignored(skip, r));
    rel.truncate(MAX_PRESETS);

    let cur = read_capped(&target_abs).map(|b| normalized(&b));
    if cur.is_none() && rel.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(rel.len());
    for r in rel {
        let Ok(abs) = inside(root, &r) else { continue };
        let Ok(meta) = std::fs::metadata(&abs) else { continue };
        let body = read_capped(&abs);
        let active = matches!((&cur, &body), (Some(c), Some(b)) if *c == normalized(b));
        let vars = body.as_deref().map_or(0, var_count);
        out.push(EnvPreset { name: preset_name(&r), path: r, vars, mtime_ms: mtime_ms(&meta), active });
    }
    let state = if cur.is_none() {
        "missing"
    } else if out.iter().any(|p| p.active) {
        "preset"
    } else {
        "modified"
    };
    Some(EnvGroup { dir: dir.to_string(), target: target.to_string(), state: state.into(), presets: out })
}

/// Every environment this checkout keeps. `targets`, `presets` and `ignore` are the app's
/// defaults; the project's own table wins over each of them field by field.
#[tauri::command(async)]
pub(crate) fn env_scan(
    workdir: String, targets: Vec<String>, presets: Vec<String>, ignore: Vec<String>,
) -> EnvScan {
    let root = Path::new(&workdir);
    let (policy, policy_readable) = read_policy(root);
    let tpats = policy.targets.clone().unwrap_or(targets);
    let pats = policy.presets.clone().unwrap_or(presets);
    let skip = policy.ignore.clone().unwrap_or(ignore);

    let groups = target_candidates(root, &tpats, &preset_dirs(&pats))
        .into_iter()
        .filter_map(|(dir, target)| scan_group(root, &dir, &target, &pats, &skip))
        .collect();
    EnvScan { groups, policy, policy_readable }
}

/// Point the checkout at `preset`. `backup` copies the target aside first; the frontend asks
/// for that only when the target holds content no preset has, which exists nowhere else.
/// Returns the backup's path, or an empty string when none was taken.
#[tauri::command]
pub(crate) fn env_switch(
    workdir: String, target: String, preset: String, backup: bool,
) -> Result<String, String> {
    let root = Path::new(&workdir);
    let dst = inside(root, &target)?;
    let src = inside(root, &preset)?;
    if src == dst {
        return Err("that preset is the target file".into());
    }
    let body = read_capped(&src).ok_or_else(|| format!("{preset} could not be read"))?;
    let mut kept = String::new();
    if backup && dst.is_file() {
        let bak = format!("{target}.bak");
        std::fs::copy(&dst, inside(root, &bak)?).map_err(|e| format!("backing up {target}: {e}"))?;
        kept = bak;
    }
    std::fs::write(&dst, &body).map_err(|e| format!("writing {target}: {e}"))?;
    Ok(kept)
}

/// The target's current content as a new preset, so the warning that it is about to be
/// overwritten has an answer. Never overwrites: a preset that exists is somebody else's file.
#[tauri::command]
pub(crate) fn env_save_preset(workdir: String, target: String, dest: String) -> Result<(), String> {
    let root = Path::new(&workdir);
    let src = inside(root, &target)?;
    let dst = inside(root, &dest)?;
    if src == dst {
        return Err("that is the target file".into());
    }
    if dst.exists() {
        return Err(format!("{dest} already exists"));
    }
    let body = read_capped(&src).ok_or_else(|| format!("{target} could not be read"))?;
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(&dst, &body).map_err(|e| format!("writing {dest}: {e}"))
}

/// Move the rules into `.episko/episko.toml`, so they are the team's rather than this
/// machine's. `create` gates the first write: a new committable file in someone's repo is a
/// real side effect, the stance `notes.rs` takes. `toml_edit`, so hand edits survive.
#[tauri::command]
pub(crate) fn env_write_policy(
    workdir: String, targets: Vec<String>, presets: Vec<String>, ignore: Vec<String>,
    tags: Vec<EnvTag>, create: bool,
) -> Result<(), String> {
    let path = episko_toml(Path::new(&workdir));
    if !path.is_file() && !create {
        return Err("no .episko/episko.toml yet".into());
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|e| e.to_string())?;
    if doc.get("env").and_then(|e| e.as_table()).is_none() {
        doc["env"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let t = doc["env"].as_table_mut().ok_or("env is not a table")?;
    t["targets"] = toml_edit::value(targets.into_iter().collect::<toml_edit::Array>());
    t["presets"] = toml_edit::value(presets.into_iter().collect::<toml_edit::Array>());
    t["ignore"] = toml_edit::value(ignore.into_iter().collect::<toml_edit::Array>());
    if tags.is_empty() {
        t.remove("tag");
    } else {
        let mut arr = toml_edit::ArrayOfTables::new();
        for tag in tags {
            let mut tt = toml_edit::Table::new();
            tt["match"] = toml_edit::value(tag.pattern);
            if let Some(tone) = tag.tone {
                tt["tone"] = toml_edit::value(tone);
            }
            if let Some(label) = tag.label {
                tt["label"] = toml_edit::value(label);
            }
            arr.push(tt);
        }
        t["tag"] = toml_edit::Item::ArrayOfTables(arr);
    }
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, doc.to_string()).map_err(|e| e.to_string())
}

/// Take the `[env]` table back out, so the project falls back to whatever each machine has.
/// The rest of the file is left exactly as it was; a missing table is already the answer.
#[tauri::command]
pub(crate) fn env_drop_policy(workdir: String) -> Result<(), String> {
    let path = episko_toml(Path::new(&workdir));
    let Ok(existing) = std::fs::read_to_string(&path) else { return Ok(()) };
    let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|e| e.to_string())?;
    if doc.remove("env").is_none() {
        return Ok(());
    }
    std::fs::write(&path, doc.to_string()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::scratch_dir;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// `ENV_DEFAULTS` in envs.ts, which is what the frontend actually sends. The backend has no
    /// defaults of its own, so testing against anything else would be testing a fiction.
    fn defaults() -> (Vec<String>, Vec<String>, Vec<String>) {
        (
            [".env", "*/.env", "apps/*/.env", "packages/*/.env", "services/*/.env"].map(String::from).into(),
            [".env.*", "*.env", "envs/*", "env/*"].map(String::from).into(),
            [".env.local", "*.example", "*.sample", "*.template", "*.bak"].map(String::from).into(),
        )
    }

    fn scan_at(root: &Path) -> EnvScan {
        let (t, p, i) = defaults();
        env_scan(root.to_string_lossy().into(), t, p, i)
    }

    /// The one-environment case every test but the monorepo one is about.
    fn only(scan: &EnvScan) -> &EnvGroup {
        assert_eq!(scan.groups.len(), 1, "expected one environment, got {:?}", scan.groups);
        &scan.groups[0]
    }

    fn names(g: &EnvGroup) -> Vec<&str> {
        g.presets.iter().map(|p| p.name.as_str()).collect()
    }

    #[test]
    fn names_an_environment_however_the_project_spells_the_file() {
        assert_eq!(preset_name(".env.prod"), "prod");
        assert_eq!(preset_name("prod.env"), "prod");
        assert_eq!(preset_name("envs/prod"), "prod");
        assert_eq!(preset_name("envs/prod.env"), "prod");
        assert_eq!(preset_name("env.staging"), "staging");
        assert_eq!(preset_name(".env"), ".env");
    }

    #[test]
    fn refuses_every_path_that_leaves_the_project() {
        let root = Path::new("/tmp/p");
        for bad in ["../x", "a/../../x", "/etc/passwd", "", "  "] {
            assert!(inside(root, bad).is_err(), "{bad} should be refused");
        }
        assert!(inside(root, "envs/prod.env").is_ok());
    }

    #[test]
    fn a_crlf_round_trip_still_reads_as_the_same_preset() {
        assert_eq!(normalized(b"A=1\r\nB=2\r\n"), normalized(b"A=1\nB=2"));
        assert_ne!(normalized(b"A=1"), normalized(b"A=2"));
        assert_eq!(var_count(b"# c\n\nA=1\nexport B=2\n=bad\n"), 2);
    }

    #[test]
    fn finds_presets_in_the_directories_the_patterns_name() {
        let root = scratch_dir();
        write(&root, ".env.prod", "A=1\n");
        write(&root, ".env.dev", "A=2\n");
        write(&root, "envs/staging.env", "A=3\n");
        // Every way a file is not a preset: a sample, a template however it is qualified, the
        // local overlay, a backup a switch left behind, and anything no pattern's directory names.
        write(&root, ".env.example", "A=\n");
        write(&root, ".env.hetzner.template", "A=7\n");
        write(&root, ".env.local", "A=5\n");
        write(&root, ".env.bak", "A=6\n");
        write(&root, "node_modules/pkg/.env.junk", "A=4\n");
        // `envs/` is where the presets live, so `*/.env` must not adopt it as an environment of
        // its own — that would list envs/staging.env under two headings at once.
        let scan = scan_at(&root);
        let g = only(&scan);
        let mut got = names(g);
        got.sort();
        assert_eq!(got, ["dev", "prod", "staging"]);
        assert_eq!(g.state, "missing");
    }

    #[test]
    fn a_monorepo_gets_one_environment_per_package() {
        let root = scratch_dir();
        write(&root, "apps/web/.env", "A=1\n");
        write(&root, "apps/web/.env.prod", "A=1\n");
        write(&root, "apps/web/.env.dev", "A=2\n");
        write(&root, "apps/api/.env.prod", "B=1\n");
        // A package with neither a target nor a preset is not an environment, and a wildcard
        // segment never descends into the directories a build fills.
        write(&root, "apps/docs/README.md", "hi\n");
        write(&root, "node_modules/pkg/.env.prod", "X=1\n");
        let scan = scan_at(&root);
        let targets: Vec<&str> = scan.groups.iter().map(|g| g.target.as_str()).collect();
        assert_eq!(targets, ["apps/api/.env", "apps/web/.env"]);

        let api = &scan.groups[0];
        assert_eq!(api.state, "missing"); // presets, no target yet — exactly what the picker is for
        assert_eq!(names(api), ["prod"]);

        let web = &scan.groups[1];
        assert_eq!(web.state, "preset");
        assert_eq!(web.presets.iter().filter(|p| p.active).map(|p| &p.name).collect::<Vec<_>>(), ["prod"]);
        // Presets resolve beside their own target, so web never offers api's.
        assert_eq!(names(web), ["dev", "prod"]);
    }

    #[test]
    fn one_wildcard_level_finds_the_commonest_monorepo_shape() {
        // `01_frontend`/`02_backend` at the root matches none of apps|packages|services, and
        // reporting only what sits beside the root .env is what `*/.env` exists to stop.
        let root = scratch_dir();
        write(&root, ".env.testing", "A=0\n");
        write(&root, "01_frontend/.env", "A=1\n");
        write(&root, "01_frontend/.env.prod", "A=1\n");
        write(&root, "01_frontend/.env.test", "A=2\n");
        write(&root, "02_backend/.env", "B=9\n");
        write(&root, "02_backend/.env.dev", "B=1\n");
        // Neither a target nor a preset of its own: its `.env` is a level deeper than any pattern.
        write(&root, "00_scripts/clone_db/.env", "C=1\n");
        write(&root, "03_terraform/main.tf", "x\n");
        let scan = scan_at(&root);
        assert_eq!(
            scan.groups.iter().map(|g| g.target.as_str()).collect::<Vec<_>>(),
            [".env", "01_frontend/.env", "02_backend/.env"],
        );
        assert_eq!(names(&scan.groups[0]), ["testing"]);
        assert_eq!(names(&scan.groups[1]), ["prod", "test"]);
        assert_eq!(scan.groups[1].state, "preset"); // .env is a copy of .env.prod
        assert_eq!(scan.groups[2].state, "modified"); // B=9 matches neither
    }

    #[test]
    fn a_checkout_with_no_environments_at_all_reports_none() {
        let root = scratch_dir();
        write(&root, "src/main.rs", "fn main() {}\n");
        assert!(scan_at(&root).groups.is_empty());
    }

    #[test]
    fn the_active_preset_is_whichever_one_the_target_matches() {
        let root = scratch_dir();
        write(&root, ".env.prod", "A=1\n");
        write(&root, ".env.dev", "A=2\n");
        write(&root, ".env", "A=1\r\n");
        let scan = scan_at(&root);
        assert_eq!(only(&scan).state, "preset");
        assert_eq!(only(&scan).presets.iter().filter(|p| p.active).map(|p| &p.name).collect::<Vec<_>>(), ["prod"]);

        write(&root, ".env", "A=999\n");
        let after = scan_at(&root);
        assert_eq!(only(&after).state, "modified");
    }

    #[test]
    fn switching_writes_the_target_and_can_keep_what_was_there() {
        let root = scratch_dir();
        let dir = root.to_string_lossy().to_string();
        write(&root, ".env.prod", "A=1\n");
        write(&root, ".env", "HAND=written\n");
        let kept = env_switch(dir.clone(), ".env".into(), ".env.prod".into(), true).unwrap();
        assert_eq!(kept, ".env.bak");
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), "A=1\n");
        assert_eq!(std::fs::read_to_string(root.join(".env.bak")).unwrap(), "HAND=written\n");
        assert!(env_switch(dir.clone(), ".env".into(), ".env".into(), false).is_err());
        assert!(env_switch(dir, ".env".into(), "../escape".into(), false).is_err());
    }

    #[test]
    fn saving_a_preset_never_overwrites_one() {
        let root = scratch_dir();
        let dir = root.to_string_lossy().to_string();
        write(&root, ".env", "A=1\n");
        env_save_preset(dir.clone(), ".env".into(), "envs/mine.env".into()).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("envs/mine.env")).unwrap(), "A=1\n");
        assert!(env_save_preset(dir, ".env".into(), "envs/mine.env".into()).is_err());
    }

    #[test]
    fn the_project_table_overrides_the_defaults_and_round_trips() {
        let root = scratch_dir();
        let dir = root.to_string_lossy().to_string();
        write(&root, "config/live", "A=1\n");
        write(&root, "app.env", "A=1\n");
        let tags = vec![EnvTag { pattern: "live".into(), tone: Some("danger".into()), label: None }];
        env_write_policy(
            dir, vec!["app.env".into()], vec!["config/*".into()], vec![], tags.clone(), true,
        )
        .unwrap();
        let scan = scan_at(&root);
        let g = only(&scan);
        assert_eq!(g.target, "app.env");
        assert_eq!(g.state, "preset");
        assert_eq!(names(g), ["live"]);
        assert_eq!(scan.policy.tags, tags);
        assert!(scan.policy_readable);

        // Taking it out again leaves the file, and the defaults come back.
        env_drop_policy(root.to_string_lossy().into()).unwrap();
        let back = scan_at(&root);
        assert_eq!(back.policy, EnvPolicy::default());
        assert!(back.policy_readable);
        assert!(episko_toml(&root).is_file());
    }

    #[test]
    fn a_broken_table_says_so_rather_than_reading_as_silence() {
        let root = scratch_dir();
        write(&root, ".episko/episko.toml", "[env\ntargets =");
        write(&root, ".env.prod", "A=1\n");
        let scan = scan_at(&root);
        assert!(!scan.policy_readable);
        // The defaults still apply: a table nobody can read must not take the feature away.
        assert_eq!(only(&scan).target, ".env");
    }
}
