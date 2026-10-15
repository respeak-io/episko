//! A dev stack's other half: the Docker Compose containers a task brought up, and the
//! `[stack]` table of `.episko/episko.toml`. Facts only; which pane and container make one
//! stack, and what state it is in, is `stack.ts`'s (docs/stack.md).

use crate::platform::{augmented_path, resolve_claude, sys_command};

/// One container Compose made. Matched to a checkout by `working_dir`, the directory
/// `docker compose` ran in, which is the one label that says whose a container is.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Container {
    id: String,
    name: String,
    state: String,  // running, exited, restarting, created, paused, dead
    status: String, // "Up 3 hours (healthy)", "Exited (1) 2 minutes ago": health and exit live here
    ports: String,
    project: String,
    service: String,
    working_dir: String,
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Containers {
    available: bool, // false: no docker, or a daemon that is not answering; nothing to say about the list
    error: String,
    list: Vec<Container>,
}

// Labels by name rather than `{{.Labels}}`: that one is comma-joined, and `config_files` has commas in it.
const PS_FORMAT: &str = "{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t\
{{.Label \"com.docker.compose.project\"}}\t{{.Label \"com.docker.compose.service\"}}\t\
{{.Label \"com.docker.compose.project.working_dir\"}}";

fn parse_ps(out: &str) -> Vec<Container> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() != 8 || f[5].is_empty() || f[7].is_empty() {
                return None; // not made by Compose, so no checkout can own it
            }
            let s = |i: usize| f[i].trim().to_string();
            Some(Container {
                id: s(0), name: s(1), state: s(2), status: s(3), ports: s(4),
                project: s(5), service: s(6), working_dir: crate::platform::norm_path(f[7].trim()),
            })
        })
        .collect()
}

fn docker(args: &[&str]) -> std::process::Command {
    let mut c = sys_command("docker");
    c.env("PATH", augmented_path()).args(args);
    c
}

/// Every Compose container on the machine, stopped ones included: a crash loop and a
/// service that exited 1 are exactly what a stack view exists to show.
#[tauri::command]
pub(crate) async fn compose_containers() -> Containers {
    tauri::async_runtime::spawn_blocking(|| {
        let cmd = docker(&["ps", "-a", "--filter", "label=com.docker.compose.project", "--format", PS_FORMAT]);
        match crate::deps::run_capped(cmd, 8) {
            Ok(o) if o.status.success() => Containers {
                available: true, error: String::new(), list: parse_ps(&String::from_utf8_lossy(&o.stdout)),
            },
            Ok(o) => Containers { error: String::from_utf8_lossy(&o.stderr).trim().to_string(), ..Default::default() },
            Err(e) => Containers { error: e, ..Default::default() },
        }
    })
    .await
    .unwrap_or_default()
}

/// `stop`, never `down`: down removes the containers and their networks, which is the
/// project's call to make (`[stack] down`), not ours. Compose finds the project by label alone.
#[tauri::command]
pub(crate) async fn compose_stop(project: String) -> Result<(), String> {
    if project.is_empty() || project.starts_with('-') {
        return Err("no compose project named".into()); // never let a name become a flag
    }
    tauri::async_runtime::spawn_blocking(move || {
        let o = crate::deps::run_capped(docker(&["compose", "-p", &project, "stop"]), 120)?;
        if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The `[stack]` table: `up` and `down` are task ids (`just:dev`), so both run through the
/// same path a click takes; `compose` names Compose projects that belong to this stack
/// wherever they were started from, for a stack shared between checkouts.
#[derive(serde::Serialize, serde::Deserialize, Default, Debug, PartialEq, Clone)]
pub(crate) struct StackConfig {
    up: Option<String>,
    down: Option<String>,
    #[serde(default)]
    compose: Vec<String>,
}

#[derive(serde::Deserialize, Default)]
struct RawFile {
    stack: Option<StackConfig>,
}

/// Forgiving like `[health]`: a broken file means "no table", never an error a stack cannot show.
fn parse_stack(text: &str) -> StackConfig {
    toml::from_str::<RawFile>(text).ok().and_then(|f| f.stack).unwrap_or_default()
}

#[tauri::command]
pub(crate) fn stack_config(dir: String) -> StackConfig {
    std::fs::read_to_string(std::path::Path::new(&dir).join(".episko").join("episko.toml"))
        .map(|t| parse_stack(&t))
        .unwrap_or_default()
}

/// A task the proposal adds to `.episko/tasks.toml`, for a project with no way to stop its stack.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
pub(crate) struct ProposedTask {
    label: String,
    run: String,
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct StackProposal {
    stack: StackConfig,
    tasks: Vec<ProposedTask>,
    why: Vec<String>, // one line per value, what it is based on: the dialog shows these
}

#[derive(serde::Deserialize, Default)]
struct RawProposal {
    stack: Option<StackConfig>,
    #[serde(default)]
    task: Vec<ProposedTask>,
}

/// The answer is a fenced `toml` block, then `WHY` and one `- ` line per value; anything around
/// them is ignored. No block, or one that does not parse, is a failure the dialog reports.
fn parse_proposal(out: &str) -> Result<StackProposal, String> {
    let start = out.find("```toml").ok_or("the agent answered without a proposal")? + "```toml".len();
    let len = out[start..].find("```").ok_or("the agent's proposal was cut off")?;
    let raw: RawProposal = toml::from_str(&out[start..start + len]).map_err(|e| format!("the proposal is not valid TOML: {e}"))?;
    let rest = &out[start + len + 3..];
    let why = rest
        .lines()
        .skip_while(|l| l.trim() != "WHY")
        .filter_map(|l| l.trim().strip_prefix("- ").map(str::to_string))
        .collect();
    Ok(StackProposal { stack: raw.stack.unwrap_or_default(), tasks: raw.task, why })
}

const PROPOSE_SECS: u64 = 300;

/// Ask a headless Claude to read the project and propose `[stack]`, the way the day summary
/// asks for a sentence: `-p`, no PTY, no session. `--restricted` plus `--tools Read,Glob,Grep`
/// means it can look and nothing else: no shell, no edits, no web, no MCP, none of the user's
/// settings (whose allow rules could otherwise reopen Bash). It runs in the project, read-only.
#[tauri::command]
pub(crate) async fn propose_stack(dir: String, prompt: String) -> Result<StackProposal, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = sys_command(resolve_claude());
        cmd.env("PATH", augmented_path()).current_dir(&dir).args([
            "-p", &prompt, "--model", "sonnet", "--restricted", "--tools", "Read,Glob,Grep",
            "--strict-mcp-config", "--no-session-persistence",
        ]);
        let o = crate::deps::run_capped(cmd, PROPOSE_SECS)
            .map_err(|e| if e.starts_with("no answer") { format!("no proposal after {PROPOSE_SECS}s") } else { format!("could not start claude: {e}") })?;
        if !o.status.success() {
            return Err(format!("claude exited {}: {}", o.status, String::from_utf8_lossy(&o.stderr).trim()));
        }
        parse_proposal(&String::from_utf8_lossy(&o.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write `[stack]` as accepted, through `toml_edit` so every other table and comment survives.
/// Creating the file is fine here: the dialog that showed the proposal was the question.
#[tauri::command]
pub(crate) fn write_stack(dir: String, stack: StackConfig) -> Result<(), String> {
    let path = std::path::Path::new(&dir).join(".episko").join("episko.toml");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = text.parse::<toml_edit::DocumentMut>().map_err(|e| e.to_string())?;
    set_stack(&mut doc, &stack);
    std::fs::create_dir_all(path.parent().ok_or("bad project dir")?).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, doc.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn set_stack(doc: &mut toml_edit::DocumentMut, s: &StackConfig) {
    if doc.get("stack").and_then(|i| i.as_table()).is_none() {
        doc["stack"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let t = doc["stack"].as_table_mut().expect("just made a table");
    for (k, v) in [("up", &s.up), ("down", &s.down)] {
        match v.as_deref().filter(|x| !x.trim().is_empty()) {
            Some(x) => t[k] = toml_edit::value(x),
            None => { t.remove(k); }
        }
    }
    if s.compose.is_empty() {
        t.remove("compose");
    } else {
        t["compose"] = toml_edit::value(s.compose.iter().map(String::as_str).collect::<toml_edit::Array>());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_lines_become_containers_and_strangers_are_dropped() {
        let out = "fba89\tpii-db-1\trunning\tUp 3 hours (healthy)\t127.0.0.1:5432->5432/tcp\tschwaerzwerk-platform\tdb\t/w/pii/apps/platform/deploy\n\
                   aa11\tloner\trunning\tUp 1 hour\t\t\t\t\n\
                   bb22\tbroken line\n";
        let got = parse_ps(out);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].service, "db");
        assert_eq!(got[0].status, "Up 3 hours (healthy)");
        assert_eq!(got[0].working_dir, crate::platform::norm_path("/w/pii/apps/platform/deploy"));
    }

    #[test]
    fn the_stack_table_is_read_and_a_broken_file_is_no_table() {
        let c = parse_stack("[health]\nnesting = 8\n\n[stack]\nup = \"just:dev\"\ndown = \"just:down\"\ncompose = [\"schwaerzwerk-platform\"]\n");
        assert_eq!(c.up.as_deref(), Some("just:dev"));
        assert_eq!(c.down.as_deref(), Some("just:down"));
        assert_eq!(c.compose, vec!["schwaerzwerk-platform"]);
        assert_eq!(parse_stack("not [ valid"), StackConfig::default());
        assert_eq!(parse_stack("[health]\nnesting = 8\n"), StackConfig::default());
    }

    #[test]
    fn a_proposal_is_the_toml_block_and_its_reasons() {
        let out = "Here is what I found.\n\n```toml\n[stack]\nup = \"vscode:dev-frontend-backend\"\ndown = \"episko:stop-containers\"\n\n[[task]]\nlabel = \"Stop containers\"\nrun = \"docker compose -f 02_backend/docker-compose.dev.yml stop\"\n```\n\nWHY\n- up: the default build task starts prep, backend and frontend\n- down: nothing stopped the containers, so a task does\n";
        let p = parse_proposal(out).unwrap();
        assert_eq!(p.stack.up.as_deref(), Some("vscode:dev-frontend-backend"));
        assert_eq!(p.tasks, vec![ProposedTask { label: "Stop containers".into(), run: "docker compose -f 02_backend/docker-compose.dev.yml stop".into() }]);
        assert_eq!(p.why.len(), 2);
        assert!(parse_proposal("I could not find anything.").is_err());
        assert!(parse_proposal("```toml\n[stack\n```").is_err());
    }

    #[test]
    fn writing_stack_keeps_every_other_table_and_comment() {
        let mut doc = "# team settings\n[branches]\nprotect = [\"dev\"]\n\n[stack]\nup = \"old\"\ncompose = [\"x\"]\n".parse::<toml_edit::DocumentMut>().unwrap();
        set_stack(&mut doc, &StackConfig { up: Some("just:dev".into()), down: Some("just:down".into()), compose: vec![] });
        let text = doc.to_string();
        assert!(text.starts_with("# team settings\n[branches]\nprotect = [\"dev\"]"), "{text}");
        assert!(text.contains("up = \"just:dev\"") && text.contains("down = \"just:down\""), "{text}");
        assert!(!text.contains("compose"), "{text}");
        assert_eq!(parse_stack(&text).up.as_deref(), Some("just:dev"));
    }

    #[test]
    fn a_project_name_never_becomes_a_flag() {
        let r = tauri::async_runtime::block_on(compose_stop("--all".into()));
        assert!(r.is_err());
    }
}
