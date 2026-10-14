# The Episko MCP server

> Rules and their reasons, compressed. Trust the code over the docs when they disagree, and fix the doc in the same commit.

An agent running in Episko knows nothing about Episko, so it starts the project's scripts the only way it can: Bash. A test run is then a tool call scrolling past in the pane, and a dev server is a background shell Episko has to reverse-engineer (`servers.ts`). Every Claude pane is therefore launched with a small MCP server that lets the agent use Episko's own task path instead: `list_runnables`, `run_task`, `task_status`.

## Shape

- **Off until you switch it on**, in Settings › Launching (`cc-agent-tools`, local) or per project (`cc-proj-prefs`' `tools`, read through `agentToolsFor` at launch). The server's instructions change how every agent works, which is a behaviour nobody should get by updating. Off means nothing at all: no file, no token, no `--mcp-config`. A running session keeps what it was launched with.

- **Per launch, like the instrumentation.** `spawn_claude` writes `$TMPDIR/cc-launcher/mcp-<uuid>.json` beside the `--settings` file and passes `--mcp-config`. Nothing in `~/.claude` changes, and the server disappears with the pane. The URL carries the stable launch id as `?sid=`, the `X-CC-Session` rule again: Claude's own session id rotates, ours does not.
- **It shares the telemetry listener.** `/mcp` is routed in `run_telemetry_server` before any telemetry parsing, so it gets the supervisor's re-bind for free and an instrument file's port is also the MCP port.
- **The backend speaks the protocol; the frontend answers the tools.** `initialize`, `tools/list`, `ping` and notifications are answered in `mcp.rs`. A `tools/call` is held open (the PermissionRequest shape: `mcp_pending`, `mcp-call` event, `resolve_mcp`), because task discovery, inputs, `dependsOn` and the pane itself all live in the frontend. A tool that launched its own process from Rust would be a second launch path, which is exactly what this exists to remove.
- **The request is parked before the event is emitted**, or an answer faster than the server thread finds nothing to answer (a test caught it).
- **Steering is the server's `instructions`.** Claude Code puts them in the system prompt, so no `--append-system-prompt` is needed. Whether that is enough to beat the agent's habit of typing `pnpm test` is the open question this spike exists to answer.

## Rules

- **A token per launch, always checked.** Telemetry can be unauthenticated because the worst a forged POST does is fake a phase. A tool call starts processes, and 127.0.0.1 is reachable by every local process and by a DNS-rebinding web page. The token is 128 bits from the OS, sent as a bearer header, compared without an early exit, and dropped when the pane is killed. It lives in a `0600` file and never in argv, which every user can read through `ps`.
- **The agent goes through the same door a click does.** Discovery runs in the session's own `workdir` (the checkout it is editing, as run-on-stop does) under the same trust gate, so an untrusted folder's introspected tasks come back as the blocked row, not as a way round it. The launch is `launchWithDeps` with `focus: false` and `forSession`, so the run is an ordinary task pane: glyph, phase, re-run, ✕.
- **Inputs are never a prompt.** The agent's value wins, then the user's last value, then the default. A password is never reused. Anything still unanswered is refused with the list of what is missing, because nobody is at the dialog the attended path would open.
- **One-shot tasks only.** A background task never exits, so it has no result to return, and starting one per call is the server pile-up `stopRuleBlocked` exists to prevent. A compound task is refused with the names of the tasks it runs. Both are follow-ups, not oversights.
- **Output is captured from the pane's own stream**, not from `run.tail` (40 lines, a hint for a human). `appendOutput` keeps the last 16 KB the way a terminal would leave it: escapes stripped, a `\r` progress line folded to its last state. Capture starts on the first chunk, which can arrive before `launchTask` returns, so the watch is registered by caller and task id before the launch and claimed by the pane on its first output.
- **A long run returns a handle.** `run_task` waits `wait_seconds` (default 600, max 1800) and then answers *still running* with the pane id; `task_status` keeps waiting. A finished run stays answerable for an hour.
- **Agents create runs; they never type into a pane.** There is no tool that writes to another session's PTY. That keeps the "Episko presses Enter in exactly two places" rule (CLAUDE.md) intact.

## Not yet

Only embedded Claude panes get the server; the Ghostty and external-terminal engines and the other providers (Codex takes MCP servers through its own config) do not. Background tasks would return once `taskServerUrl` latches an address. Read-only fleet tools (`list_sessions`, which files other panes are editing) are the natural next step. `claude_cli_reaches_our_mcp_tools` (RELEASE.md) is the contract test against the real CLI.
