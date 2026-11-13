# Agent protocol (v1)

Claude Code and Codex are integrated by adapters inside Episko, which read each vendor's own
format. That only works for agents someone on the team runs and can test. For every other
agent, Episko publishes this protocol instead: a small, versioned event format that an
extension *inside the agent* speaks. The vendor-specific translation lives in that
extension, next to the agent it depends on, and Episko only checks, clips and displays what
arrives.

The extensions Episko ships live in
[episko-integrations](https://github.com/respeak-io/episko-integrations), where CI runs each
one inside its real agent against a scripted model. Copies are vendored into
`src-tauri/integrations/` (see its README). Today: OMP and OpenCode.

```text
agent process                                   Episko
┌──────────────────────────────┐   POST /agent  ┌──────────────────────────────────┐
│ agent events → extension ────┼───────────────►│ protocol.rs: token, size, version│
│ (vendor translation lives    │  loopback +    │ providers/protocol.ts: schema,   │
│  here, in the agent's repo   │  bearer token  │ clip → AgentEvent → shared Sess  │
│  ecosystem)                  │                └──────────────────────────────────┘
└──────────────────────────────┘
```

The JSON Schema in `src/providers/protocol-v1.schema.json` is the contract;
`test/protocol.test.ts` fails if the schema and the translator disagree on the event types.

## How Episko launches a protocol agent

A manifest entry (`src/providers/manifest.json`) with a `protocol` block is all Episko needs:

```json
"omp": {
  "capabilities": ["session-state", "activity", "context", "usage", "launch-permissions"],
  "protocol": {
    "extension": "episko.ts",
    "args": ["--extension", "{file}"],
    "env": {},
    "permissionModes": [{ "id": "write", "label": "Accept edits", "sub": "…", "glyph": "✎", "asks": true,
                          "args": ["--approval-mode", "write"] }]
  }
}
```

On each launch `protocol.rs`:

1. writes the bundled extension to `$TMPDIR/cc-launcher/ext-<pane id>/<extension>`;
2. mints a 128-bit token for the pane;
3. starts the agent with the permission mode's `args` (looked up by id, never passed
   through), then `args`, with `{file}` and `{dir}` filled in;
4. sets `env` (same placeholders) plus `EPISKO_URL` and `EPISKO_TOKEN`, and `PWD` to the
   pane's folder (OpenCode picks its project from `PWD`, not its cwd).

Closing the pane revokes the token and deletes the folder. Nothing is written to the agent's
own configuration or to the project, and the token never appears in argv. The env var is
inherited by every shell the agent starts; that is accepted, since the agent can already run
anything those shells can.

## Transport

```http
POST {EPISKO_URL}                 # http://127.0.0.1:<port>/agent?sid=<pane id>
Authorization: Bearer {EPISKO_TOKEN}
Content-Type: application/json

{ "v": 1, "events": [ { "type": "turn-start" }, … ] }
```

| Answer | Meaning |
| --- | --- |
| 204 | accepted |
| 400 | not JSON, `v` is not `1`, or `events` is not an array of 1–500 |
| 401 | unknown pane or wrong token; also every POST in flight after the pane closed |
| 413 | body over 1 MiB |

Error bodies are `{"error": "…"}` for the extension author. Episko never logs a body.

An extension must:

- act only when both variables are set, and post only to `http://127.0.0.1:` URLs;
- keep order: one POST in flight at a time, batching what queued up meanwhile;
- never block or wait on the agent's behalf, never throw into it, and drop events rather
  than grow without bound when Episko is gone;
- report the **main** agent only. Both OMP and OpenCode run extensions in subagents too,
  and a subagent's turn end is not the pane's.

## Events

Every event is an object with a `type`. Unknown fields are ignored. An event Episko cannot
read (wrong type for a field, an unknown enum value) is dropped whole and logged by field
name, never by value; the rest of the POST still applies. An unknown `type` is ignored, so a
later 1.x can add types without breaking older Episko builds. Strings are clipped to the
lengths in the schema.

| Type | Fields | Shown as |
| --- | --- | --- |
| `session` | `id?`, `model?`, `title?` | the conversation this pane is in. `id` is the agent's own (`[A-Za-z0-9_.:-]`, ≤128); a new `id` restarts the totals |
| `prompt` | `text` | your question, in the outline. May come just before or just after the `turn-start` it opens |
| `turn-start` | – | thinking |
| `tool-start` | `id`, `name`, `summary?`, `input?`, `command?` | working; a row in the Tools tab. `summary` is the short argument (a file name, a command); `command` is set when the tool runs a shell command, so Episko re-reads git when it may have changed something |
| `tool-end` | `id`, `name`, `output?`, `failed?`, `files?`, `command?` | closes the row with the same `id`. `files` is `[{path, kind: "read" \| "edited" \| "created"}]` for the Context card; leave shell commands out, git answers those |
| `answer` | `text` | the agent's closing message, filed under the question |
| `turn-end` | `failed?`, `error?`, `durationMs?` | done, or error with `error` as the reason |
| `plan` | `items: [{text, status}]` | the plan card; status is `pending`, `in_progress`, `completed` or `cancelled`. Always the whole list |
| `usage` | `contextTokens?`, `contextWindow?`, `totals?` | the context gauge and token counts. `totals` holds `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`: cumulative for the current session, `input` without cache reads, `output` including reasoning. Fields left out keep their last value |
| `cost` | `totalUsd` | cumulative for the current session |
| `error` | `message` | an error that interrupted the agent |

`totals` and `cost` only grow within one session `id`; Episko books the difference into
the day's usage, so a counter that restarts without a new `id` would be read as no spend.

## What Episko does with it

- The manifest's capabilities decide which surfaces appear; claim only what the extension
  actually sends (`docs/providers.md`).
- Every such session carries a **community** chip in the inspector, and the agent picker
  says so too. Episko ships these files but cannot vouch for the agent they run in.
- The revive watchdog never acts on a community session: a failure an extension reports
  must not make Episko type into the agent (`revive.ts`).
- Shared code sees normal `AgentEvent`s and never branches on the provider.

## Not in v1

- **Approvals from the app.** They need a back channel: the extension asks, Episko answers,
  and the agent waits for the answer, with its own terminal prompt as the fallback when
  Episko does not answer. That is the one exception to "never wait", so it gets its own
  version. Until then approvals stay in the agent's terminal.
- **Resume and history**, which need a public way to list and read the agent's
  conversations.
- **Rate limits**, whose account-scope rules (`docs/providers.md`) need a stable,
  non-identifying account id from the agent.

## Versions

`v` is the major version. Episko refuses a `v` it does not speak (400), so an extension can
tell. Additive changes (a new event type, a new optional field) stay in v1. Anything that
changes what an existing field means is v2, and Episko then accepts both for a while. Since
Episko ships the extensions it loads, a v2 lands in both repositories together.

## Adding an agent

1. The agent must have a public, per-launch way to load code into its own process: a flag,
   an environment variable, a config folder. Reading its screen does not count.
2. Write the extension in episko-integrations, with a replayed recording and an e2e run in
   the real CLI (its README has the steps).
3. Here: a manifest row with a `protocol` block and only the capabilities it sends, a
   registry entry `{ id, label, events: protocolEvents }` in `src/providers/index.ts`, the
   file added to `EXTENSIONS` in `protocol.rs`, then
   `node scripts/vendor-integrations.mjs ../episko-integrations`.
4. `cargo test` checks every protocol entry has a bundled extension and a path that cannot
   escape its folder; `pnpm test` checks the registry against the manifest.
5. Run the session in the app before you believe it (`RELEASE.md`).
