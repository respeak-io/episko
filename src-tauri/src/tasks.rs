// Runnables — the task/script layer.
//
// A `Runnable` is anything a project declares it can do: an npm script, a task in
// Muster's own `.muster/tasks.toml`, and (later) a VS Code task, a just recipe, a
// Make target. Providers *discover* them here; one executor (`spawn_task` in
// lib.rs) runs them, reusing the same PTY path as a session or a shell.
//
// Two rules shape this module:
//
// - **Discovery never executes the project.** Every provider here parses a file.
//   The introspecting providers (`just --dump`, `task --list`, `make -qp`) evaluate
//   the file they read — backtick variables and imports run shell at parse time —
//   so they are deliberately absent until there's a trust gate to put them behind.
// - **Ids are stable and namespaced** (`npm:test`, `muster:dev`). The frontend
//   persists pins and frecency against them, so they must survive a rescan.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// How to actually run a Runnable. `Argv` is exec'd directly; `Shell` is handed to
/// a login shell, so it may contain pipes, `&&`, globs and other shell syntax.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Exec {
    Argv { program: String, args: Vec<String> },
    Shell { line: String },
}

/// Everything `spawn_task` needs to start a run. A resolved subset of `Runnable` —
/// the frontend sends this after substituting inputs and choosing a working
/// directory, so the backend never has to re-derive either.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpec {
    pub exec: Exec,
    pub cwd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Runnable {
    /// Stable + namespaced: "npm:test", "muster:dev".
    pub id: String,
    pub label: String,
    /// The script body / doc comment — shown under the label in the picker.
    pub detail: Option<String>,
    /// Provider name, used to group the picker: "npm", "muster".
    pub source: String,
    /// Repo-relative file the task came from, for "reveal source".
    pub source_file: String,
    /// build | test | run | check | clean — from the file, else inferred by name.
    pub group: Option<String>,
    pub exec: Exec,
    /// Absolute working directory. Defaults to the discovery root.
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    /// Long-running (dev server, watcher): never auto-marked "done" on output, and
    /// its pane isn't auto-dismissed.
    pub background: bool,
    /// `Some(reason)` → the picker shows it greyed and refuses to run it. Being
    /// honest about what we can't run beats silently omitting it, which reads as
    /// "Muster didn't find your task".
    pub blocked: Option<String>,
}

/// Discover everything runnable in `root`. Order is stable: Muster's own tasks
/// first (they're the ones a human wrote for this app), then npm scripts.
pub fn discover(root: &Path) -> Vec<Runnable> {
    let mut out = Vec::new();
    out.extend(muster_tasks(root));
    out.extend(npm_scripts(root));
    dedupe_ids(&mut out);
    out
}

/// Ids must be unique — the frontend keys pins and frecency off them. A collision
/// (two `[[task]]` entries with the same label) gets a numeric suffix rather than
/// silently shadowing.
fn dedupe_ids(list: &mut [Runnable]) {
    let mut seen: BTreeMap<String, u32> = BTreeMap::new();
    for r in list.iter_mut() {
        let n = seen.entry(r.id.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            r.id = format!("{}~{}", r.id, *n);
        }
    }
}

// ── .muster/tasks.toml ──────────────────────────────────────────────────────
// Muster's own, IDE-agnostic format. The file a team commits *because* of Muster,
// and the escape hatch for anything the other providers can't express.

#[derive(Deserialize)]
struct MusterFile {
    #[serde(default)]
    task: Vec<MusterTask>,
}

#[derive(Deserialize)]
struct MusterTask {
    label: String,
    run: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    background: bool,
    /// Relative to the project root.
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

fn muster_tasks(root: &Path) -> Vec<Runnable> {
    let path = root.join(".muster").join("tasks.toml");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let parsed: MusterFile = match toml::from_str(&text) {
        Ok(p) => p,
        // A malformed tasks.toml surfaces as one un-runnable row rather than
        // vanishing — otherwise a typo looks like "Muster ignored my file".
        Err(e) => {
            return vec![Runnable {
                id: "muster:__error".into(),
                label: ".muster/tasks.toml has an error".into(),
                detail: Some(first_line(&e.to_string())),
                source: "muster".into(),
                source_file: ".muster/tasks.toml".into(),
                group: None,
                exec: Exec::Shell { line: String::new() },
                cwd: root.display().to_string(),
                env: BTreeMap::new(),
                background: false,
                blocked: Some("fix the file to run this".into()),
            }]
        }
    };

    parsed
        .task
        .into_iter()
        .map(|t| {
            let slug = t.id.unwrap_or_else(|| slugify(&t.label));
            let cwd = match &t.cwd {
                Some(rel) => root.join(rel).display().to_string(),
                None => root.display().to_string(),
            };
            Runnable {
                id: format!("muster:{slug}"),
                group: t.group.or_else(|| infer_group(&t.label, &t.run)),
                detail: t.detail.or_else(|| Some(t.run.clone())),
                label: t.label,
                source: "muster".into(),
                source_file: ".muster/tasks.toml".into(),
                exec: Exec::Shell { line: t.run },
                cwd,
                env: t.env,
                background: t.background,
                blocked: None,
            }
        })
        .collect()
}

// ── package.json ────────────────────────────────────────────────────────────

/// Which package manager to invoke, decided by the lockfile that's actually
/// present. Guessing wrong is worse than it looks: `npm run` in a pnpm workspace
/// resolves a different (or missing) dependency tree.
fn package_runner(root: &Path) -> &'static str {
    for (lock, runner) in [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
        ("package-lock.json", "npm"),
    ] {
        if root.join(lock).exists() {
            return runner;
        }
    }
    "npm"
}

fn npm_scripts(root: &Path) -> Vec<Runnable> {
    let Ok(text) = std::fs::read_to_string(root.join("package.json")) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) else {
        return Vec::new();
    };
    let runner = package_runner(root);

    scripts
        .iter()
        .filter_map(|(name, body)| {
            let body = body.as_str()?;
            Some(Runnable {
                id: format!("npm:{name}"),
                label: name.clone(),
                detail: Some(body.to_string()),
                source: "npm".into(),
                source_file: "package.json".into(),
                group: infer_group(name, body),
                exec: Exec::Argv {
                    program: runner.to_string(),
                    args: vec!["run".into(), name.clone()],
                },
                cwd: root.display().to_string(),
                env: BTreeMap::new(),
                background: is_background(name, body),
                blocked: None,
            })
        })
        .collect()
}

// ── shared inference ────────────────────────────────────────────────────────

/// Group a task by what it's obviously for. Only used when the source file didn't
/// say (VS Code tasks and tasks.toml can declare a group outright).
fn infer_group(name: &str, body: &str) -> Option<String> {
    let n = name.to_ascii_lowercase();
    let b = body.to_ascii_lowercase();
    let any = |hay: &str, needles: &[&str]| needles.iter().any(|w| hay.contains(*w));

    if any(&n, &["test", "spec", "vitest", "jest"]) {
        return Some("test".into());
    }
    if any(&n, &["lint", "fmt", "format", "typecheck", "tsc", "clippy", "check"]) {
        return Some("check".into());
    }
    if any(&n, &["build", "compile", "bundle", "dist", "package"]) {
        return Some("build".into());
    }
    if any(&n, &["dev", "start", "serve", "watch", "preview"]) {
        return Some("run".into());
    }
    if any(&n, &["clean", "clear", "reset"]) {
        return Some("clean".into());
    }
    // Fall back to the command itself — "e2e": "playwright test" is a test.
    if any(&b, &["vitest", "jest", "playwright", "cargo test"]) {
        return Some("test".into());
    }
    None
}

/// Long-running by convention. Deliberately conservative — a false positive means
/// a finished task never settles into "done", which is more confusing than a dev
/// server that briefly claims it finished. `.muster/tasks.toml` can always say so
/// explicitly with `background = true`.
fn is_background(name: &str, body: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let b = body.to_ascii_lowercase();
    matches!(n.as_str(), "dev" | "start" | "serve" | "watch")
        || n.ends_with(":watch")
        || n.ends_with(":dev")
        || b.contains("--watch")
        || b.contains("nodemon")
        || b.contains("tauri dev")
}

/// A stable, filename-ish id fragment for a human-written label.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "task".into()
    } else {
        out
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or(s).trim().to_string()
}

/// Parse the project's runnables. Cheap enough (two small files) to run on every
/// picker open — no cache until a provider needs to shell out.
#[tauri::command]
pub fn discover_runnables(workdir: String) -> Result<Vec<Runnable>, String> {
    let root = Path::new(&workdir);
    if !root.is_dir() {
        return Err(format!("not a directory: {workdir}"));
    }
    Ok(discover(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch project directory that cleans itself up.
    struct Tmp(std::path::PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "muster-tasks-{tag}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn write(&self, rel: &str, body: &str) {
            let f = self.0.join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, body).unwrap();
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn finds_npm_scripts_with_the_lockfile_s_runner() {
        let t = Tmp::new("npm");
        t.write(
            "package.json",
            r#"{"scripts":{"test":"vitest run","dev":"vite --watch"}}"#,
        );
        t.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

        let found = discover(&t.0);
        let test = found.iter().find(|r| r.id == "npm:test").unwrap();
        assert_eq!(
            test.exec,
            Exec::Argv { program: "pnpm".into(), args: vec!["run".into(), "test".into()] }
        );
        assert_eq!(test.group.as_deref(), Some("test"));
        assert!(!test.background);
        assert_eq!(test.detail.as_deref(), Some("vitest run"));

        let dev = found.iter().find(|r| r.id == "npm:dev").unwrap();
        assert!(dev.background, "a dev script is long-running");
    }

    #[test]
    fn npm_runner_defaults_to_npm_without_a_lockfile() {
        let t = Tmp::new("norunner");
        t.write("package.json", r#"{"scripts":{"build":"tsc"}}"#);
        let found = discover(&t.0);
        assert_eq!(
            found[0].exec,
            Exec::Argv { program: "npm".into(), args: vec!["run".into(), "build".into()] }
        );
        assert_eq!(found[0].group.as_deref(), Some("build"));
    }

    #[test]
    fn reads_muster_tasks_toml() {
        let t = Tmp::new("toml");
        t.write(
            ".muster/tasks.toml",
            r#"
[[task]]
label = "Dev server"
run = "pnpm tauri dev"
background = true

[[task]]
label = "Migrate"
run = "just migrate"
group = "run"
cwd = "src-tauri"
env = { RUST_LOG = "debug" }
"#,
        );
        let found = discover(&t.0);
        assert_eq!(found.len(), 2);

        assert_eq!(found[0].id, "muster:dev-server");
        assert_eq!(found[0].exec, Exec::Shell { line: "pnpm tauri dev".into() });
        assert!(found[0].background);

        assert_eq!(found[1].id, "muster:migrate");
        assert_eq!(found[1].cwd, t.0.join("src-tauri").display().to_string());
        assert_eq!(found[1].env.get("RUST_LOG").map(String::as_str), Some("debug"));
    }

    #[test]
    fn a_broken_tasks_toml_reports_itself_instead_of_vanishing() {
        let t = Tmp::new("broken");
        t.write(".muster/tasks.toml", "[[task]]\nlabel = \"oops\"\n"); // no `run`
        let found = discover(&t.0);
        assert_eq!(found.len(), 1);
        assert!(found[0].blocked.is_some());
        assert!(found[0].label.contains("tasks.toml"));
    }

    #[test]
    fn muster_tasks_come_before_npm_scripts() {
        let t = Tmp::new("order");
        t.write("package.json", r#"{"scripts":{"test":"vitest"}}"#);
        t.write(".muster/tasks.toml", "[[task]]\nlabel = \"Deploy\"\nrun = \"./deploy.sh\"\n");
        let found = discover(&t.0);
        assert_eq!(found[0].source, "muster");
        assert_eq!(found[1].source, "npm");
    }

    #[test]
    fn duplicate_labels_get_distinct_ids() {
        let t = Tmp::new("dupe");
        t.write(
            ".muster/tasks.toml",
            "[[task]]\nlabel = \"Test\"\nrun = \"a\"\n\n[[task]]\nlabel = \"Test\"\nrun = \"b\"\n",
        );
        let found = discover(&t.0);
        assert_eq!(found[0].id, "muster:test");
        assert_eq!(found[1].id, "muster:test~2");
    }

    #[test]
    fn missing_files_are_not_an_error() {
        let t = Tmp::new("empty");
        assert!(discover(&t.0).is_empty());
    }

    #[test]
    fn discover_runnables_rejects_a_non_directory() {
        assert!(discover_runnables("/definitely/not/here".into()).is_err());
    }

    /// The frontend hands a discovered `exec` straight back to `spawn_task`, so the
    /// serialized and deserialized shapes have to be the same object. This pins the
    /// wire format both ways — a rename here silently breaks every task launch, and
    /// nothing else in the suite would notice.
    #[test]
    fn exec_round_trips_through_the_shape_the_frontend_sees() {
        let argv = Exec::Argv { program: "pnpm".into(), args: vec!["run".into(), "test".into()] };
        let json = serde_json::to_string(&argv).unwrap();
        assert_eq!(json, r#"{"mode":"argv","program":"pnpm","args":["run","test"]}"#);
        assert_eq!(serde_json::from_str::<Exec>(&json).unwrap(), argv);

        let shell = Exec::Shell { line: "pnpm tauri dev".into() };
        let json = serde_json::to_string(&shell).unwrap();
        assert_eq!(json, r#"{"mode":"shell","line":"pnpm tauri dev"}"#);
        assert_eq!(serde_json::from_str::<Exec>(&json).unwrap(), shell);
    }

    /// Dogfood: discovery has to work on this repo, which has both a package.json
    /// (with a pnpm lockfile) and a committed .muster/tasks.toml. Asserts the shape
    /// rather than specific task names, so renaming a script doesn't break the suite.
    #[test]
    fn discovers_this_repo() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let found = discover(root);
        assert!(!found.is_empty(), "muster's own repo should have runnables");
        assert!(found.iter().any(|r| r.source == "muster"), "reads .muster/tasks.toml");
        assert!(found.iter().any(|r| r.source == "npm"), "reads package.json scripts");
        assert!(
            found.iter().all(|r| r.blocked.is_none()),
            "nothing in our own task file should be un-runnable"
        );

        let mut ids: Vec<_> = found.iter().map(|r| r.id.as_str()).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "ids must be unique — pins key off them");

        // The lockfile is pnpm, so npm scripts must invoke pnpm.
        let npm = found.iter().find(|r| r.source == "npm").unwrap();
        match &npm.exec {
            Exec::Argv { program, .. } => assert_eq!(program, "pnpm"),
            other => panic!("npm scripts should be argv, got {other:?}"),
        }
    }

    /// A TaskSpec built from a Runnable the way `launchTask` builds it.
    #[test]
    fn task_spec_accepts_what_launch_task_sends() {
        let spec: TaskSpec = serde_json::from_str(
            r#"{"exec":{"mode":"shell","line":"just test"},"cwd":"/tmp","env":{"RUST_LOG":"debug"}}"#,
        )
        .unwrap();
        assert_eq!(spec.cwd, "/tmp");
        assert_eq!(spec.env.get("RUST_LOG").map(String::as_str), Some("debug"));
        // env is optional — a task with none omits the key entirely.
        let bare: TaskSpec =
            serde_json::from_str(r#"{"exec":{"mode":"argv","program":"ls","args":[]},"cwd":"/tmp"}"#)
                .unwrap();
        assert!(bare.env.is_empty());
    }
}
