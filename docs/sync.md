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

## Where the code lives

Three crates joined by **path dependency**, not a cargo workspace. Each keeps its own
`Cargo.lock` and `target/`, so the release pipeline is unchanged. CI tests and lints the two
sync crates in their own step. Converting to a workspace later is one small PR.

- `episko-proto/` holds the wire types (`ClientMsg`, `ServerMsg`, `Event`, `Stream`). Both
  sides compile against it, so a message's shape cannot drift.
- `episko-server/` is the binary. `store.rs` holds the SQLite log, invites and tokens.
  `serve.rs` runs one thread per WebSocket connection, fans pushes out, and keeps presence in
  memory.
- `src-tauri/src/sync.rs` owns the connection. The socket, backoff and token live in Rust, so
  the token never reaches the webview and the socket survives a reload. It decides nothing
  about what syncs, and emits each server message as `sync-event`.
- `src/sync.ts` holds the rules (tested). `src/synclink.ts` is the driver. `src/syncui.ts`
  draws the badge and the status-bar segment, and `src/syncview.ts` draws the Settings › Sync
  panel.

## How a write travels

`synclink.hookStorage()` replaces `Storage.prototype.setItem`/`removeItem` once, before
anything writes. Every `localStorage` write in the app therefore passes one choke point, and
no call site has to remember sync exists.

1. A `pref` write marks the key **dirty** and stamps it, in `cc-sync-dirty` and
   `cc-sync-stamps`. Both survive a restart, so an edit made offline is still owed later.
2. A flush builds one push. It carries the dirty prefs, every day whose `cc-usage` total grew
   past what the server last took (`cc-sync-sent`), the day's detail split, and the limit
   readings if they changed.
3. The server answers `pushed`. Only then is a key cleared, and only if its stamp has not moved
   since. A key edited again mid-flight stays owed.
4. A reconnect (`welcome`) discards whatever was in flight and rebuilds the push from scratch.

Arriving events are applied through the rules. Remote prefs are written to `localStorage`
**without** marking them dirty, and take effect on the next reload. Settings › Sync and the
status bar say so. Peer spend lands in `cc-usage-peers`/`cc-detail-peers`, and every money
surface reads `dayTotal`/`dayDetail` in `usage.ts`. After applying a batch, the frontend acks
its highest seq, which `sync.rs` persists as the cursor. A crash between the two replays a
batch, and that is harmless because every merge is idempotent.

**Joining an existing setup adopts it.** A newly paired machine does not push its prefs at
once: they wait in `cc-sync-seed` until the first catch-up ends. It then offers only the keys
the server had nothing for, at the oldest possible stamp.

## Running the server

```sh
cd episko-server && cargo build --release
EPISKO_DB=/srv/episko.db ./target/release/episko-server          # listens on 127.0.0.1:7878
EPISKO_DB=/srv/episko.db ./target/release/episko-server invite   # prints EPSK-XXXX-XXXX
```

It binds localhost and does not terminate TLS; put Caddy or Tailscale in front. The backup is
`cp episko.db`.

**The conversation.** A client sends `pair {code, label}` and gets back `paired {token, user,
device}`. It then sends `hello {token, since, protocol}` and gets `welcome`, followed by
`events` pages until `more` is false. After that it pushes with `push {events}`, answered by
`pushed {seqs}`, and hears the other devices' pushes as `events`. The rules the server enforces:

- It mints the device id, so two machines with one label never share a usage cell.
- It stamps `actor`/`device` from the token, whatever the client sent.
- It stores only a hash of each token.
- It refuses a mismatched protocol with `error {code: "protocol"}` rather than misreading it.
