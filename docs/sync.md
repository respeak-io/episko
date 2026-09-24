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

| Phase | Delivers | State |
| --- | --- | --- |
| 1. Personal sync | event log, prefs, usage partitioning, limits; one user, one token | built |
| 2. Identity and roster | root-commit ids, the path-keyed stores, the `cc-usage-detail` re-key, shared notes, presence | built |
| 3. Coordination | claims as leases, shown on the shared queue | built |

Not built yet: the *shelved on another device* row, which is a non-goal's honest half. It needs
a roster of dormant sessions that carries no title, since a title is written from the
conversation. Also not built: `episko-server` workspaces beyond the one default. A team runs
one server, which is the per-team answer.

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

## Project identity and the roster

`project_id` (git.rs) answers a folder's id: `git:<root sha>` (several roots sorted and joined
with `+`), or `remote:<owner/repo>` for a repo with no commit yet. It never uses the host, which
an ssh alias rewrites per machine. `synclink` asks once per folder and caches the answer in
`cc-proj-ids`. An id is useful without sync too: `addUsage` files a project's spend under it
(`setProjectKeyer`), and `rekeyDetail` moves name-keyed history onto the one id that name maps
to on this machine. A name that maps to several ids stays under the name, and that loss was
accepted.

The roster (favourites, order, groups, colours, custom icons, per-project agent and gh account)
travels as `roster` events keyed `fav|<id>`, `color|<id>`, and so on, with `order` and `groups`
as whole values. Rules, all in `roster.ts`:

- **Applied one entry at a time**, onto `pathOf(id)`, this machine's checkout of that project.
  An entry for a project not cloned here is **held** in `cc-sync-roster` and applied once an id
  resolves to a local folder.
- **Never send an absence you cannot see.** `mergeWire` carries entries for unknown ids through
  untouched, and keeps unknown ids in their slots in `order`.
- **Revealed entries lose.** An entry that only became visible (a pairing, an id resolving) goes
  at stamp 1 and never over a key the server already holds. Only a real local edit is stamped
  now.
- A group's `collapsed` state stays on this screen.

## Shared notes and the work log: where they go is per project

Project menu › **Sharing** holds one choice per project (`cc-episko-share`, synced with the
roster):

| Mode | Notes and work log |
| --- | --- |
| **Git** (the default) | Committed in `.episko/notes.toml` and `.episko/digest.md`, as before. With sync on, the server also carries them, so the team sees them before anyone pushes. |
| **Sync server** | Only the server carries them. Nothing is written into the repo, and no consent dialog appears, because choosing the mode is the consent. |
| **Nowhere** | Nothing is shared and nothing is offered. Notes a teammate committed still show. |

- **Notes** travel on the team stream `notes`, keyed `<project id>|<note id>`, with last writer
  wins. The dashboard shows the committed file and the server's copy as one list, one row per
  id, and the later `at` wins a disagreement (`sharedNow`).
- **Work-log lines** travel as `digest|<project id>|<day>` and seed the day's project sentence.
  A line from the file wins over the server's.
- **The "Not written down anywhere" offer** appears only in Git mode. Its **Don't offer this**
  button silences it for one project (`cc-digest-no`).

`tasks.toml`, `[branches] protect` and `[health]` never take this route, whatever the mode.
They change what runs or what is permitted.

## Running the server

```sh
cd episko-server && cargo build --release
EPISKO_DB=/srv/episko.db ./target/release/episko-server          # listens on 127.0.0.1:7878
EPISKO_DB=/srv/episko.db ./target/release/episko-server invite   # prints EPSK-XXXX-XXXX
```

It binds localhost and does not terminate TLS; put Caddy or Tailscale in front. The backup is
`cp episko.db`. `episko-server devices` lists paired machines, and `revoke <device>` shuts one
out; the app then halts and asks to pair again rather than retrying. Every six hours the server
compacts: an event superseded by a newer one of the same key goes once it is older than
`EPISKO_RETENTION_DAYS` (30). The latest per key always stays, so a device that was away for
months still converges. Docker: `episko-server/Dockerfile` and `docker-compose.yml`
(`episko-server/README.md`).

**A proxy in front: extra headers.** Every handshake, the pairing one included, carries
whatever `Name: value` headers Settings › Sync holds. That covers Traefik basic auth,
ForwardAuth on a header, and a Cloudflare Access service token (`CF-Access-Client-Id` +
`CF-Access-Client-Secret`). The rules:

- `parseHeaders` (sync.ts) and `check_headers` (sync.rs) each refuse the handshake's own
  headers (`Host`, `Upgrade`, `Sec-WebSocket-*`, …).
- Values are sealed beside the token (`Secret::Headers`, stored as hex JSON so the keychain arm
  can type it) and are **write-only**: status carries `headerNames` only.
- A 401, 403 or redirect from the proxy becomes a sentence naming the fix (`refused`), and the
  connection keeps retrying.
- A login-page redirect (browser SSO) cannot work, because nothing follows it.

**Testing against the real binary.** The ignored test `two_devices_meet_through_a_real_server`
in `sync.rs` pairs two devices through a running server and checks that a push arrives. Set
`EPISKO_E2E_URL` and `EPISKO_E2E_CODES` (two fresh invites, comma-separated), then run
`cargo test -- --ignored two_devices_meet`.

**The conversation.** A client sends `pair {code, label}` and gets back `paired {token, user,
device}`. It then sends `hello {token, since, protocol}` and gets `welcome`, followed by
`events` pages until `more` is false. After that it pushes with `push {events}`, answered by
`pushed {seqs}`, and hears the other devices' pushes as `events`. The rules the server enforces:

- It mints the device id, so two machines with one label never share a usage cell.
- It stamps `actor`/`device` from the token, whatever the client sent.
- It stores only a hash of each token.
- It refuses a mismatched protocol with `error {code: "protocol"}` rather than misreading it.
