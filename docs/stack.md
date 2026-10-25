# Dev stacks

> Rules and their reasons, compressed. Trust the code over the docs when they disagree, and fix the doc in the same commit.

A project's dev environment is rarely one server. `just dev` in one repo brings up a Compose stack, a background API with its own `trap`, and vite in the foreground; another repo's *Dev: Frontend + Backend* is a fail-fast prep chain, two servers and a browser opener, each its own pane. The servers popover used to see the panes that announced a URL and the ports under a pane's process tree, which is none of the containers: their ports are held by Docker's daemon, not by anything a pane started. A stack is the view that puts them together.

## Shape

- **A stack is one dev-task launch** (`buildStacks` in ./stack). A run group, or a lone task pane, is a stack when it holds a background task, when `[stack] up` names it, or when a live pane in it **listens on a port**: evidence beats classification, so an undescribed `just app` serving 127.0.0.1:38418 is one whatever its name made tasks.rs guess. A finished one-shot group is history and drops out.
- **Containers belong to a repo, not a checkout.** Compose projects are per machine: `docker compose` run from a worktree reuses the main checkout's project (same name, same `container_name`s), and the `working_dir` label just names whoever started it last. So a stack takes every Compose container whose `working_dir` is inside any checkout of its repo, and says `from <checkout>` when that is not its own. `[stack] compose` adds projects by name for a stack whose containers live elsewhere.
- **A container nobody's pane accounts for is a `leftover`**, one block per repo. Only running ones: a stopped container is not something to monitor. A repo Episko does not know is not listed at all.
- **The summed state needs no config.** `failed`: a member exited non-zero (or a server exited at all), or a container is restarting, unhealthy, or exited non-zero during this stack's life. `starting`: a prep step still runs, a server has not listened yet, or a health check is starting. `ready`: none of those. The block names the member or container behind the state.
- **An exit counts only if it happened during the stack's life.** Docker reports an exit only as "Exited (1) 3 weeks ago"; `agoMs` reads that back, and an exit older than the stack's first pane is hidden rather than blamed. Without this every later run of a repo with one stale failed container starts red.

## Pages

A stack lists every address worth opening as chips under its head (`stackPages`), from three sources, one row per URL:

1. **`[stack] pages`**, declared by the team: for what nothing announces, such as a Caddyfile's routes. First, and a declared name wins over an announced one.
2. **What its panes announced** (`run.pages`, folded by `foldPages` in ./servers): every labelled address in a dev script's banner, not just the last. When two share a port, the named host is kept: `wirksam.localhost` is chosen for its cookies and CORS, while `127.0.0.1` is only where vite bound.
3. **Reverse-proxy routes on its containers**: Traefik's `Host(...)` router rules, read from the container labels (`traefik_pages`). Caddy keeps its routes in a file, which is what `pages` is for.

## Rules

- **Facts in Rust, rules in TypeScript.** `stack.rs` lists containers and reads `[stack]`; `stack.ts` decides. Labels are read by name in the `docker ps` template, never from `{{.Labels}}`, which is comma-joined while `config_files` holds commas.
- **Docker is optional.** No CLI, or a daemon that does not answer in 8s, is `available: false`: the stack is its panes alone, and the poll backs off to once a minute. It polls every 4s while a stack pane is live and every 20s otherwise.
- **⏹ stops, never removes.** It runs `[stack] down` when the project names one, as a task through the normal launch path; otherwise `docker compose -p <project> stop` behind a confirm, since every checkout shares the containers. `down` deletes containers and networks, and that is the project's call to make.
- **✕ on a stack closes its panes, and only its panes.** The containers stay, and the block becomes a leftover with its own ⏹.
- **A stack's panes leave the other sections.** Their task rows and loose ports would otherwise be listed twice.

## `[stack]`

```toml
[stack]
up = "just:dev"        # the task that starts it: marks a run as a stack even when nothing in it is background
down = "just:down"     # what ⏹ runs instead of `docker compose stop`
compose = ["shared-infra"]  # Compose projects that belong here wherever they were started
pages = { App = "https://app.localhost:8443/ui/" }  # addresses nothing announces
```

Ids are task ids as `list_runnables` and the Run picker spell them. Everything is optional, and a broken file reads as no table.

## What each task is

tasks.rs guesses a long-running task from its name (`dev`, `start`, `serve`, `watch`), which makes `just app` a quick check and a GUI window something that never "finishes". The describer replaces the guess with a reading: every task gets a `[run."<id>"]` entry in `.episko/episko.toml`, written by the same headless, read-only agent as `[stack]` and reviewed the same way.

```toml
[run."just:dev"]
kind = "server"      # check test build server app watch infra-up infra-down deploy script
pages = { Frontend = "http://wirksam.localhost:47300", Backend = "http://wirksam.localhost:47301" }
ready = "Ctrl+C to stop"   # a line its output prints once it is up
stops = "episko:stop-dev-containers"
brings_up = ["db", "adminer"]
hash = "1f3a9c0e"    # cmdHash of the command it described
```

- **Pinned to the command it read.** `hash` is `cmdHash` of the command (a compound task: the tasks it runs). When the recipe changes, the entry is **stale**: the picker says *changed?* and the description changes nothing until it is re-checked. A description of a command that no longer exists is not a fact.
- **It can only add.** A fresh `server`/`app`/`watch` turns `background` on; nothing turns a declared `isBackground` or a tasks.toml `background = true` off.
- **What reads it:** the picker's end column (the kind, a `deploy` in red with its note as the tooltip), a stack member's readiness (`ready` latched off its output; an `app` is up while its window runs), the stack's page chips (`described`, after `[stack] pages`), and ⏹ (`stops`, when `[stack] down` is unset).
- **Measured:** wirksam, 37 tasks, 24 seconds. It followed `just dev` into `scripts/dev.mjs` for the real ports and host, and took the stop command from that script's own comment.

## Setting it up with an agent

Two doors, one agent. The **▶ Run picker** carries a *Dev stack* strip, since that is where you go to start one: it shows the table, offers **▶ Start stack** when `up` names a task this checkout has (that row is tagged *stack*), and otherwise offers the agent. Project settings › *The team's* › **Dev stack** shows the same and adds *Open file*.

**The agent is headless, like the day summary** (`propose_stack`): `claude -p` in the project, with no PTY and no session, `--restricted --tools Read,Glob,Grep --strict-mcp-config`. It can read and search the project and nothing else: no shell, no edits, no web, no MCP, and none of the user's settings files, whose allow rules could otherwise reopen Bash. It is handed the ids discovery found (`stackPrompt`), so it never guesses a slug, and answers with one fenced `toml` block plus a `WHY` line per value naming the file and lines it read. Measured on a real repo: about 13 seconds; the budget is 300.

**Nothing is written until Apply.** `checkProposal` drops any `up`/`down` that names no task the project has or the proposal adds, and says so; the review dialog shows each value with its reason. Apply writes the proposed tasks to `.episko/tasks.toml` first (a `down` may name one), then `[stack]` through `toml_edit` (`write_stack`), keeping every other table and comment. Nothing is committed. Creating `.episko/episko.toml` needs no second question: the dialog was it.

**It never syncs.** `up` and `down` name tasks Episko runs, the same class as `tasks.toml`, which docs/sync.md keeps in git: a value that arrived through the server would change what ⏹ runs with no commit anyone reviewed.

## Left behind

A process outlives its pane in two ways. The pane closes and something under it ignores the hangup, or, on **Windows, which never kills a child with its parent**, a dev script dies and its watcher grandchild runs on. The second leaked nine `vite build --watch` (about 13 GB) over three days. None held a port, so the orphan port rows could not see them.

- **Seen, then lost.** Each poll records every process under a live pane, keyed by pid **and start time** (`AppState.seen_procs`), and forgets one that exited or whose pid was reused. A recorded process that no live pane holds any more is left behind; the popover shows each orphaned tree once, at its top (`track_left`).
- **Found by folder**, for a stray from before this run or from another terminal: a *runtime* (`RUNTIMES`: node, python, bun…) whose parent is gone and whose command line or cwd lies in a checkout Episko knows. Only runtimes, because an editor's own processes carry the project path too and must never be accused.
- **Not news:** a tree younger than `LEFT_GRACE_MS` (a closing pane takes a beat to die) and the daemons that outlive their parent by design and retire on their own (`DAEMONS`: git's fsmonitor, MSBuild nodes, the Gradle daemon…).
- **✕ asks, then kills the tree.** `kill_proc_tree` refuses unless its last poll reported that pid with that start time, then names every member, since POSIX `kill -pid` reaches only a group leader's group.
- **Closing a pane on Windows kills its tree first** (`kill_session`, `taskkill /T` while the root still links it), which is what POSIX's hangup already did. A process that dies on its own still leaves its children, and those are what the section lists.

## Running in your panes

The same poll lists what every live pane is running now, as a table per pane with a ✕ per process. Two folds keep it readable, because a Claude pane on Windows carries about thirty processes before it has done anything: six MCP servers, each behind `cmd /c`, `npx` and a console host.

- **Started with the agent** (`splitLaunch`): a branch whose top began within `AT_LAUNCH_S` of the pane's root, and is not a shell, is the agent's own helpers, its MCP servers. Measured: up to 35s after `claude.exe` on a busy Windows machine. A shell branch (`bash`, `zsh`, `pwsh`) is how the agent runs a command, so it is work however early it began. A pane running only those is folded into one line at the end of the section. Only an agent pane is split; everything under a shell counts as work.
- **Wrappers** (`isPlumbing`: shells, console hosts, `npx`/`pnpm`/`uvx` launchers) are hidden and their children lifted to their depth (`procRows`), so `cmd /c npx vite` reads as `vite`. *Show wrappers* puts them back.

## Toasts

- **Closing or shelving a pane** says what went with it, from the last poll's view of its tree (`paneClosing`, before `kill_session`). Only work started since the pane opened is named; the agent's MCP servers are expected to go.
- **A tree that outlived what started it** is announced once (`newlyLeft`), with *Kill* and *Show*. A folder match never is: it was found at startup, not seen leaving.

## One poll, off the main thread

`process_poll` takes one process snapshot for the ports, the pane trees and the left-behind trees. On Windows the snapshot costs ~45ms, the socket table ~30ms and the command/memory read ~30ms, measured. It is `#[tauri::command(async)]`: a plain `#[tauri::command]` runs on the main thread, which on Windows is the one that drags and paints the window, and `session_ports` used to run there every 4s.

## Not yet

Closing a stack's pane is still the single SIGHUP every pane gets, so a recipe's own `trap` cleanup may not run; sending Ctrl+C to the foreground group first is the next step. Container logs are not shown yet. Agents cannot see stacks until the MCP tools grow `stack_status` and `ensure_stack`.
