# Dev stacks

> Rules and their reasons, compressed. Trust the code over the docs when they disagree, and fix the doc in the same commit.

A project's dev environment is rarely one server. `just dev` in one repo brings up a Compose stack, a background API with its own `trap`, and vite in the foreground; another repo's *Dev: Frontend + Backend* is a fail-fast prep chain, two servers and a browser opener, each its own pane. The servers popover used to see the panes that announced a URL and the ports under a pane's process tree, which is none of the containers: their ports are held by Docker's daemon, not by anything a pane started. A stack is the view that puts them together.

## Shape

- **A stack is one dev-task launch** (`buildStacks` in ./stack). A run group, or a lone task pane, is a stack when it holds a background task or when `[stack] up` names it. A finished one-shot group is history and drops out.
- **Containers belong to a repo, not a checkout.** Compose projects are per machine: `docker compose` run from a worktree reuses the main checkout's project (same name, same `container_name`s), and the `working_dir` label just names whoever started it last. So a stack takes every Compose container whose `working_dir` is inside any checkout of its repo, and says `from <checkout>` when that is not its own. `[stack] compose` adds projects by name for a stack whose containers live elsewhere.
- **A container nobody's pane accounts for is a `leftover`**, one block per repo. Only running ones: a stopped container is not something to monitor. A repo Episko does not know is not listed at all.
- **The summed state needs no config.** `failed`: a member exited non-zero (or a server exited at all), or a container is restarting, unhealthy, or exited non-zero during this stack's life. `starting`: a prep step still runs, a server has not listened yet, or a health check is starting. `ready`: none of those. The block names the member or container behind the state.
- **An exit counts only if it happened during the stack's life.** Docker reports an exit only as "Exited (1) 3 weeks ago"; `agoMs` reads that back, and an exit older than the stack's first pane is hidden rather than blamed. Without this every later run of a repo with one stale failed container starts red.

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
```

Ids are task ids as `list_runnables` and the Run picker spell them. Everything is optional, and a broken file reads as no table.

## Not yet

Closing a stack's pane is still the single SIGHUP every pane gets, so a recipe's own `trap` cleanup may not run; sending Ctrl+C to the foreground group first is the next step. Container logs are not shown yet. Agents cannot see stacks until the MCP tools grow `stack_status` and `ensure_stack`.
