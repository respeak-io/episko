# Episko

![Episko: parallel coding-agent sessions, each in its own terminal, with live telemetry](docs/shot-cockpit.png)

**Run a whole flock of coding-agent sessions at once.** Episko is a native desktop app that gives every agent its own real terminal and, for integrated providers, streams back phase, model, context use, usage, approvals and live activity so a dozen agents are as easy to mind as one chat. Claude Code and Codex are first-class providers; other installed CLIs use the same pane with a terminal-only adapter.

**[episko.dev](https://episko.dev)** · [Download](https://github.com/respeak-io/episko/releases/latest) · macOS + Windows · free and open source

> **Status: early, but in daily use.** Episko began as a Phase-0 spike (see [`SPIKE.md`](./SPIKE.md)) proving the two risky pieces: embedding a real terminal and instrumenting Claude Code per launch. It has grown well past that. Expect rough edges and fast-moving internals.

## What it does

- **Every session in one view.** A sidebar of projects and their sessions, each with a status glyph and context %, sorted so whatever needs you floats up. Sessions that need a decision are called out in the header and the tray. Projects can be grouped under your own headings (*Work*, *Side*) and a group folds to one line that still carries the most urgent glyph it hides.
- **Real terminals all the way down.** Each session is a genuine PTY running the provider's actual TUI: type into it, watch it think. Claude can render embedded ([xterm.js](https://xtermjs.org/)) or in Ghostty, Terminal.app or iTerm2; Codex currently stays embedded so its App Server connection remains attached. Plain shell panes too, for when you just need a prompt next to an agent.
- **Answer permission prompts in-app.** When Claude or Codex asks to run something, Episko surfaces the command with a risk read and lets you allow, deny, or drop into the terminal, instead of hunting for which window is blocked. Claude's starting permission mode is configurable too.
- **Live telemetry per session.** Model, context window use, time in state, the running tool, and recent activity with latencies. Claude adds exact dollar cost; Codex adds live token usage and its own rate-limit windows. Both share the git working set and inspector.
- **A dashboard per project.** Click a project for its week: commits and sessions summarised a day at a time, open issues and pull requests, the repo's checkouts, shared notes, and what it all cost. [See below](#every-project-has-a-homepage).
- **Send an agent at a GitHub issue.** Dispatch from the dashboard and Episko creates the worktree, sends the prompt, and writes a claim to the issue so a colleague's agent doesn't start the same work twice, then hands the issue back when the session ends.
- **Usage limits, before you hit them.** Your 5-hour and weekly limits with reset times, and a forecast that warms from amber to red when your current pace won't make it.
- **A usage dashboard.** Daily spend as a contribution heatmap, tokens by model, token composition (cache reads vs. input vs. output), and cost attributed per project.
- **Launch into worktrees.** The new-session dialog lists the repo, its worktrees and branches, and can create a worktree on the fly so parallel agents don't fight over one checkout. A session also notices when its agent drifts to *another* checkout mid-task, and offers the repair: follow it there, or move the conversation back.
- **A commit graph per project.** Right-click a project → *Commit graph…* for its lanes, merges, branch and tag labels. It reads a page at a time and fetches the next as you scroll, so opening it on a huge repo costs the same as on a small one.
- **Sessions started elsewhere show up too.** Claude Code sessions launched outside Episko are discovered and listed read-only, with jump-to-terminal on macOS (the exact tab) and Windows (the hosting window).
- **A whole-machine history.** Claude transcripts and Codex App Server threads in one searchable list, scoped by project and day and reopenable where each provider left off. Claude sessions started elsewhere are included too.
- **Survives a restart.** Episko remembers each provider and resume id, then asks Claude to resume its transcript or Codex to resume its thread. Even a webview reload rebuilds every live agent pane and re-adopts its still-running process, scrollback included.
- **Run the project's own tasks**: VS Code tasks, a `justfile`, package scripts, a Makefile and more, in the same panes, with a run's exit code as its status. [See below](#run-your-projects-tasks-too).
- **Other agents, in the same panes.** Which agent a session runs is a setting, not a question you answer every time: pick it in Settings › Sessions, override it per project, and `⌘N` obeys. Episko discovers Codex, OpenCode, Gemini, Cursor, Copilot, Grok, Droid, Amp, Qwen, Kimi, Kiro, Antigravity, Devin, Cline, Pi and more. The capability label beside each one says whether its inspector is connected or terminal-only; adding another first-class provider is an adapter, not another session model.
- **Command palette** (`⌘K`), a **settings window** (`⌘,`), per-project accent colours and icons, favourites and drag ordering, a daily cost rollup you can open by project and session, a *What's new* screen after updates, and a `caffeinate` toggle so long runs don't sleep.

## Every project has a homepage

Click a project in the sidebar and you land on its dashboard, the answer to "what is going on in this repo":

- **The week, a day at a time.** Commits and your sessions per day, each closed day summarised in a sentence (generated with Haiku through your own `claude` CLI, cached and opt-in per project). On days more than one person committed, a second sentence describes what the *project* did, written from the commits and pull requests alone.
- **A work log the team can share.** That project half can be committed as `.episko/digest.md`, so everyone who pulls reads one generated history instead of each paying to re-derive their own. Your half (session titles, spend) never reaches a file. Notes can be shared the same way (`.episko/notes.toml`).
- **Issues and pull requests**, with triage suggestions for the ones that have gone quiet, and **claims**: dispatching an agent at an issue assigns it on GitHub so a colleague's agent doesn't start the same work twice. A claim is only ever a hint: it expires, and ends with the session.
- **Checkouts**: the repo's worktrees with their dirty state, one click from a new session in any of them.

The dashboard degrades by what the folder can offer: a GitHub repo gets all of it; a plain git repo everything but the GitHub column (the shared files need git rather than GitHub, so a GitLab or self-hosted remote is this tier); a bare folder still gets sessions, spend and notes.

## Run your project's tasks, too

Agents aren't the only thing worth watching. Episko runs the task definitions your project **already ships**, with no new file to write and no editor required, in the same PTY panes it uses for coding-agent sessions:

`.episko/tasks.toml` · `.vscode/tasks.json` · `.vscode/launch.json` · `package.json` scripts · `justfile` · `Taskfile.yml` · `mise.toml` · `Makefile` · `Cargo.toml`

Hit **▶ Run** in the header (or `⌘⇧R`, or the **Tasks** group in `⌘K`) and pick one. A task run **is** a session: it inherits the phase state machine, sidebar glyphs, attention badge, tray and `⌘1`–`9`, because a run's exit code is simply its phase (0 → done, non-zero → error). Runs are deliberately un-instrumented (no settings file, no telemetry, no cost) and get their PATH from an *interactive login* shell, the same PATH and version-manager shims your own terminal has. `dependsOn` chains are honoured, and a failed dependency stops the chain, because "build then test" must not test a build that didn't happen. A chain folds into **one sidebar row** carrying the worst step's status, and opens into a tiled stage; closing a tile focuses the next step rather than abandoning the rest.

A parameterised task starts with what Episko already knows (the values you gave last time, or the definition's own defaults) and the `⋯` button (`⌥⏎`) reopens the prompt when you want to change them; the row's tooltip shows the command as it will actually run. There's also **run on stop**: a per-project rule that launches a task (the build, the tests) when an agent finishes a turn there, so verification happens without you asking for it.

Three rules shaped it:

- **Discovery never executes the project.** `just --dump`, `task --list` and `mise tasks ls` all evaluate what they read, so they sit behind a trust gate; Makefiles are parsed statically because `make -qp` would expand `$(shell …)`. Untrusted providers show one blocked row rather than vanishing.
- **What can't run says so.** A VS Code task needing an editor (`${file}`) is listed greyed with the reason, because a missing row reads as "Episko didn't find my task". `launch.json` runs without a debugger, so `attach` and compound configs are blocked rather than silently started as bare processes.
- **Personal preference → `localStorage`; project fact → `.episko/tasks.toml`**, which is the only file Episko writes, edited via `toml_edit` so hand-written comments and ordering survive.

A task inspector offers re-run / pin / stop / **send output to a session**, so a failing build can go straight to an agent. There's a per-project task panel for pinning, hiding and editing, and a prompt for `${input:…}` values and `just` recipe parameters.

## How it works

On each Claude launch Episko writes a throwaway `--settings` file whose `statusLine` command and lifecycle `hooks` POST to a tiny `tiny_http` server bound to an ephemeral localhost port. On each Codex launch it starts a loopback App Server and connects both Episko's observer and the real `codex --remote` TUI. Both transports normalize into the same provider-neutral event reducer; terminal-only providers simply omit capabilities they cannot supply.

Every POST is tagged with the launch id Episko chose, so telemetry routes to the right pane before any output appears, and keeps routing after `/clear`, `/compact` or `/resume`, each of which makes Claude mint a **new** runtime `session_id`. The permission hook is the one blocking call: the server holds the request open until you answer.

[`CLAUDE.md`](./CLAUDE.md) is the architecture document: the module map for both sides and the invariants that keep it working; the per-area deep-dive notes live in [`docs/`](./docs/). [`SPIKE.md`](./SPIKE.md) is the original Phase-0 write-up, kept as a historical record of a single-session prototype; it predates most of the app and is not a reference.

## Stack

- **[Tauri v2](https://tauri.app/)**: Rust backend, system WebView frontend
- **[portable-pty](https://crates.io/crates/portable-pty)**: the PTY (forkpty on macOS, ConPTY on Windows)
- **[tiny_http](https://crates.io/crates/tiny_http)**: the localhost telemetry receiver
- **[xterm.js](https://xtermjs.org/)**: terminal rendering
- Vanilla TypeScript frontend (Vite), no framework

## Install

Grab the latest build from the [Releases page](https://github.com/respeak-io/episko/releases/latest). Install [Claude Code](https://claude.com/claude-code), Codex, or another supported coding-agent CLI on your `PATH`; Claude remains the default until you choose another provider.

### macOS (Apple silicon)

Episko is self-signed but **not notarized through Apple**, so Gatekeeper quarantines the download and refuses to open it (*"… is damaged and can't be opened"*). Clear the quarantine flag **before** opening the `.dmg`:

```sh
xattr -dr com.apple.quarantine ~/Downloads/Episko_*.dmg
```

Then open it, drag **Episko** into Applications, and launch. If it's still blocked on first launch, run the same command on the installed app:

```sh
xattr -dr com.apple.quarantine /Applications/Episko.app
```

### Windows (10 / 11)

Download the `.msi` (or the `.exe` installer) and run it. SmartScreen may warn on first run; choose *More info ▸ Run anyway*.

Episko keeps itself current after install: it checks the latest GitHub release on launch and offers an in-app update. It never installs one behind your back, since a restart would kill your running sessions.

## Build from source

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (stable) + the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your platform
- At least one supported coding agent on your `PATH` ([Claude Code](https://claude.com/claude-code), Codex, or a terminal-only provider)

### Run it

```sh
pnpm install          # first time
pnpm tauri dev        # run the app
pnpm tauri build      # production bundle
```

Then: add a project folder, hit **＋ Session**, accept Claude's workspace-trust prompt the first time in a directory, and ask it something. Watch the sidebar glyph, inspector and footer update live.

Other useful commands:

```sh
pnpm exec tsc --noEmit    # typecheck (strict; this is the real linter)
pnpm test                 # vitest: frontend unit tests
cd src-tauri && cargo test
```

> Run dev builds from a **real terminal**, not from a terminal pane inside Episko, because anything started inside Episko becomes its descendant and gets filtered out of the external-session list.

## Platform support

| | macOS | Windows | Linux |
|---|---|---|---|
| Embedded terminal | ✅ | ✅ | — |
| Ghostty / Terminal / iTerm2 | ✅ | — | — |
| Telemetry, permissions, usage | ✅ | ✅ | — |
| External-session discovery | ✅ | ✅ | untested |
| Jump to a session's terminal | ✅ tab | ✅ window | — |

Release builds target Apple silicon (`aarch64`) and Windows x64. Intel Macs aren't covered; Linux isn't packaged, though the non-`ps` paths are written to be OS-agnostic.

## More screenshots

<sub>Renders of the interface with representative data.</sub>

**Answer a permission request without leaving the app**: the command, how risky it looks, and allow / deny / open-in-terminal.

![Permission request surfaced in the inspector, with Allow, Deny and In terminal buttons](docs/shot-permission.png)

**Every project has a homepage**: the week a day at a time, issues with claims, checkouts and shared notes.

![Project dashboard with a summary strip, per-day summaries including a team sentence, issues with a claim, checkouts and notes](docs/shot-dashboard.png)

**Run the project's own tasks**, grouped by where they came from. What can't run is listed with the reason rather than hidden.

![Run picker grouped by package.json scripts, justfile, VS Code tasks and Makefile, with blocked entries explained](docs/shot-run.png)

**Jump anywhere with `⌘K`**, with sessions ranked so whatever needs you comes first.

![Command palette listing sessions grouped by needs-you, sessions and launch actions](docs/shot-palette.png)

**Start a session on any branch or worktree**, creating one on the fly, with a preview of HEAD and what's uncommitted.

![New-session dialog showing the repo, its worktrees and branches, with worktree details](docs/shot-newsession.png)

**See where the money and tokens went**: daily spend, model mix, token composition, and cost per project.

![Usage dashboard with a daily spend heatmap, model mix, token composition and per-project attribution](docs/shot-usage.png)

## License

[MIT](./LICENSE) © Respeak GmbH, Karlsruhe

Episko is an independent project, not affiliated with, endorsed, or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.
