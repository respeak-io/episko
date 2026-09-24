# Sync

A small self-hosted server (one binary, one SQLite file) so a user's preferences and spend
follow them between machines, and a team's notes, presence and claims stop making a round trip
through git. The full design is the *Episko Sync Server — Design Plan* doc; this file keeps the
rules code has to obey and the decisions taken on its open questions.

## The rule that decides every other question

**The server is an accelerator over git and `localStorage`, never an authority.** Every feature
works with it down or absent, and a solo user never needs one. Every synced fact keeps a local
source of truth, and the server only makes that fact arrive sooner. `notes.rs` ("a committed
file works on any remote or none") and `claim.ts` ("a hint, never a lock") already took this
stance.

The corollary is the telemetry-health rule, one level up: **when sync is unreachable, the app
says so.** `syncHealth` in `sync.ts` answers `down` once nothing has succeeded for
`SYNC_DOWN_MS`, or when nothing ever has. `down` raises the same red top-bar badge as a dead
telemetry port. `off` (not configured) is silent.

## What may leave the machine

`SYNC_KEYS` in `src/sync.ts` classifies every `cc-` key into one of four classes:

| Class | Treatment |
| --- | --- |
| `pref` | last-writer-wins per key (phase 1) |
| `account` | partitioned by device, summed on read (phase 1) |
| `roster` | path-keyed; waits for project identity (phase 2) |
| `local` | never leaves |

It is an **allowlist**. An unclassified key reads as `local`, and `test/sync.test.ts` fails
until a new key is classified, so every key is a deliberate choice.

**Facts and coordination sync. Anything that changes what runs, or what is permitted, stays in
git or on this machine.** This is why the following are `local`, even though some of them look
like preferences:

- `cc-perm-modes` / `cc-perm-mode`. A synced value could set bypass-permissions on every
  machine.
- `cc-trusted`, `cc-task-*`, `cc-autofetch`, `cc-digest-ok` and `cc-revive`. Each one decides
  something Episko runs, or types, on your behalf.

`tasks.toml`, `[branches] protect` and `[health]` stay git-only for the same reason.

**The privacy floor.** Nothing conversational goes over the wire: no transcripts, prompts, tool
payloads, diffs, file contents or health measurements. `sync.ts` never touches storage itself.
Callers pass it a getter, and the contract test fails if it imports anything but `./store` or
reaches `localStorage`, `fetch` or Tauri.

## Merge rules

- **Prefs**: newer `at` wins, and a tie goes to the larger device id so every machine agrees.
  A key we would not send is a key we will not take. A JSON value that no longer parses is
  dropped on its own.
- **Usage**: the wire key is `day|device`. `cc-usage` keeps meaning *this machine*, and other
  machines land in `cc-usage-peers`, which `uBuckets`/`daySpend` fold in at read time. A cell
  only grows, and our own device is never taken back from the server.
- **Limits**: the freshest reading wins. An absent window list learned nothing and the held
  reading stands, while `[]` is a real answer (the `model_scoped` rule).
- **Cursors** never rewind.

## Decisions on the open questions

1. Presence is worth an always-on connection. The transport is a **WebSocket** (`tungstenite`
   is already a dependency), driven from Rust.
2. `.episko` files: add a per-project switch that chooses git or the server as the channel, and
   the same place silences the "not written down anywhere" notice. `digest.md` follows the
   switch.
3. Project identity: the **root commit sha** is the primary id (several roots: sort them and
   hash the list). An explicit `[project] id` is not required.
4. `cc-usage-detail`: **re-key by project id**, with a migration. Per-project history that
   cannot be mapped is accepted as lost.
5. One workspace **per team**.
6. The Windows token lives under **DPAPI**, and on macOS in the keychain.
7. No user-facing audit view. A debug-only "what did this device send" is fine.

## Phasing

| Phase | Delivers |
| --- | --- |
| 1. Personal sync | event log, prefs, usage partitioning, limits; one user, one token |
| 2. Identity and roster | root-commit ids, the seven path-keyed stores' migrations, `cc-usage-detail` re-key, shared notes, presence |
| 3. Coordination | claims as leases, the shared queue and dashboard |

Built so far: `src/sync.ts` (the rules) and `test/sync.test.ts`. Still to build: `episko-proto`
(the shared wire types), `episko-server`, `sync.rs` (the socket and token, emitting
`sync-event`), `syncui.ts` (the Settings `sync` section and the status-bar segment), and the
`cc-usage-peers` fold in `usage.ts`.
