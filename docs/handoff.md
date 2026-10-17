# Session handoff

Handoff sends a stopped Claude session to another of your machines, or to a teammate, through
the sync server. It carries the conversation, the code it was working on and a short brief, and
the recipient resumes it as an ordinary shelved row. Everything else in docs/sync.md still
holds; this is the only channel that carries anything conversational.

## The channel

Handoff is an opt-in channel on the sync WebSocket. It is not a sync `Stream` and does not
bump `PROTOCOL`.

- A client says it speaks it with `hello.features: ["handoff"]`. A server sends `handoff*`
  messages only to a socket that said so, and answers one from a socket that did not with
  `bad_message`, as an older server would. Never send a peer what it did not advertise.
- A server says whether it allows it in `welcome.handoff`, **always** present on a server that
  knows about handoff: `{enabled, max_bytes, part_bytes, ttl_ms}`. An *absent* field is an older
  or downgraded server, and the app keeps that apart from `enabled: false` (`narrowCaps`).
- `welcome.devices[].handoff` is what each machine said at its last hello; the target list
  greys the ones that cannot receive (`targets`).
- The server's switch is `EPISKO_HANDOFF` (off by default), with `EPISKO_HANDOFF_TTL_HOURS`
  (72) and `EPISKO_HANDOFF_MAX_MB` (64). Settings › Sync shows it; no client can turn it on.
  Off is authoritative: a server started with it off expires every open handoff. A sender told
  its send is back can rely on that, and nothing left open is claimed once the switch is on again.
- After every hello the server sends the user's whole set (`handoff_list`), and `handoff` on
  every change. A missed message does no harm, because the next list carries the whole set.

## Privacy

A transcript contains everything the agent read: file contents, command output and any secret
that passed through it. So:

- The send sheet shows that warning, verbatim and with the server's hold time, on every send
  (`PRIVACY` in ./handoffview). It cannot be dismissed or remembered.
- A snapshot of uncommitted work leaves out `.env`, `.env.*`, `*.pem`, `id_rsa*`, `*.tfvars`,
  `*.p12` and `*.key`, and the sheet names what was left behind.
- On entering a terminal state the server deletes the parts and drops the meta (the brief).
  The row itself is kept 7 days so an offline sender still learns the outcome.
- **Permission modes never travel.** The recipient's resume is an ordinary `launch`, which
  reads its own `launchPermission`. The transcript would carry one anyway: Claude restores a
  session's last `permission-mode` record on resume unless a flag says otherwise, and the
  standard mode passes none, so the import resets every such record to `default` (`neutral_modes`).

## State machines

### Server (authoritative)

`uploading` → (last part lands and the sha256 matches) → `offered` → (`claim`, one winner)
→ `claimed` → (`complete` by the taker) → `done`. Terminal: `done`, `declined`, `recalled`,
`expired`. `recall` is the sender's, in `uploading`/`offered`; `decline` is the recipient's in
`offered` or the taker's in `claimed` (giving it back). A claim extends `expires` to at least
an hour out. The TTL sweep runs every ten minutes **whether or not the flag is on**, so held
blobs die on schedule after the switch is turned off.

- The server wipes `meta` on every terminal transition, `done` included. A record the app already
  holds keeps the meta it had while open (`applyInfo`), so a received session whose install
  failed still knows its title, project and memories, and its row still offers Retry.
- A recipient's pending quota (256 MiB) counts an upload no part has reached for an hour at
  what it holds, not what it declared, so offers that never send a byte cannot fill it.
- Revoking a person's **last** machine expires every open offer to "any of theirs", and a name
  that still owns a personal log or a handoff is never given out again by the registration code;
  only an admin's invite reissues it. A socket whose token was revoked is closed on its next message.
- A recipient deletes the pushed `handoff/<id>` branch only after the install has recorded its
  worktree, so a retry after a lost record can still fetch what it lands.

### Sender (`cc-handoff`, `dir: "out"`)

| Seen | Row | Resumable here |
| --- | --- | --- |
| before the offer | shelved, *preparing for …*, ↶ cancels | no |
| `uploading` / `offered` | *→ … · sending / waiting*, ↶ takes it back | no |
| `claimed` | *… is picking it up* | no |
| `done` | transcript archived, row removed, a *handed to …* row until ✕ | never |
| `declined` / `recalled` / `expired` / refused | settled, record removed, toast, an ordinary shelved row | yes |
| server unheard, or `welcome.handoff` absent | locked, *outcome unknown* | no |
| `enabled: false`, missing from a list, or unknown past expiry + 1h | *returned*: ⟲ asks first | after the confirm |

The local verdicts `returned` and `refused` are final: a later word from the server cannot
reopen them, because the session may already have been resumed here (`applyInfo`).

Cancel is local only until `handoff_send` puts the offer on the socket. From then on the sheet
cannot be closed and ↶ sends a recall, settled by the server's `recalled`; settling locally
would delete staging an upload still reads, and the next `info` would rebuild the record. A
settle deletes the remote `handoff/<id>` branch only when the staged meta says one was
pushed, and a confirmed *returned* keeps it, since the recipient may have claimed it.

### Recipient (`dir: "in"`)

`offered` arrives → *Resume here* claims → the app downloads and checks the sha256 (one
re-fetch on a mismatch) → it sends `complete` itself → on `done` it installs: unpack, refuse
another project or provider, land the code, file the transcript, then resume. Before `done`
the only way out is *Give back*; nothing has been written. After `done` a failed install keeps
the blob and offers Retry: the sender has already let go, so this is now the only copy.

On screen (./handoffui, ./handoffview):

- An offer is a ⇠ row under the project whose id it carries (`incomingByProject`, through
  sync's path map), or in the *Incoming* strip above the projects when no checkout here has
  that id. It toasts once, on arrival; there is no sound in v1.
- The sheet shows the brief, how the code arrives (`codeText`) and *Resume it in*: every
  checkout of the project here, or a folder chosen by hand, which `handoff_install` still
  refuses if its project id differs. *Resume here* is greyed with `placeGate`'s reason: not
  cloned, not Claude, or a path past Claude's 200-character folder name once the worktree
  it may get is counted. The check runs before the claim because after `done` a refusal can
  be repaired but not undone.
- The chosen checkout is stored on the record at the claim, so the install that follows
  `ready` needs no sheet open. It runs once per `ready`; after a failure, a reconnect's repeat
  `ready` waits for the person's Retry, which may also pick another checkout.
- A successful install writes the roster row (`restorableFor`), marks the record `settled`
  (kept a week, so a later send of the same conversation from here is not taken for the old
  one), drops the staging and resumes through `resumeDormant`, the same path ⟲ takes.
- When another of your machines claims an offer made to all of them, this one shows *taken
  on …* until the server closes it.

## Why exactly one machine owns it

The server decides ownership with a compare-and-set: `offered → claimed` has one winner. The
recipient writes into `~/.claude` or git **only after `done`**, and the sender archives its
transcript **only after that same `done`**. If the TTL fires in any state before `done`,
ownership is the sender's again and the recipient has installed nothing.
`complete` is idempotent for the taker, so a crash between sending it and hearing `done` is
repaired by the next connection. The one hole is a sender that cannot hear the server: it
cannot know whether `done` happened, so it stays locked. When it gives up (expiry + 1h) it
asks the person at the keyboard, who can check with the recipient.

## The container (`EPKH`)

`"EPKH1\n"`, then per entry `u32 name_len | name | u64 len | bytes`, little-endian. Allowed
names: `manifest.json`, `transcript.jsonl`, `sidecar/tool-results/<n>`, `sidecar/subagents/<n>`,
`repo.bundle`, `memory/<n>.md`, with `<n>` matching `[A-Za-z0-9._-]+` (a memory name is at most
120 characters and never `MEMORY.md`). Any other name rejects the whole blob. The manifest
lists each file's length and sha256; the offer carries the whole blob's. Parts are 512 KiB raw
(base64 on the wire, about 683 KiB a frame), so a proxy in front of the server must pass
WebSocket messages of at least 1 MiB. At most two parts are in flight.

Staging lives under the app cache (`handoff/out`, `handoff/in`); the sender's archive of a
handed transcript lives under app data for 14 days.

## How the code travels

`handoff_git_state` classifies the checkout and `gitChoices` turns that into options. A clean,
pushed checkout sends nothing. Unpushed commits go as a pushed `handoff/<id>` branch or a
bundle. A dirty tree is snapshotted (a commit on a private index, never touching yours) and
goes either way, and **has no preset**: Send stays disabled until somebody chooses, because
neither answer is safe to assume. Applying in place and cherry-picking are not offered.

## Memories

Claude's saved memories live in `<project dir of the main checkout>/memory/`, one file per memory
with a `type` in its frontmatter (top level, or under `metadata:`, which wins), plus the
`MEMORY.md` index. Every worktree of a repo shares one folder, so `memory_dir` keys on the main
checkout (`repo_root_of`), not the folder the session ran in.

- `handoff_memories` lists them for the review step; `memoryOffer` decides what is offered. A
  teammate gets **project and reference** memories only, all unticked, the brief's suggestions
  marked; `user` and `feedback` describe the sender and never go. Your own machine is offered
  everything, the suggested ones ticked.
- `handoff_pack` refuses a non-team memory to a teammate itself, so a tick the sheet should not
  have offered still never leaves. Each travels as `memory/<name>.md` with its `originSessionId`
  line stripped, and their names, types and descriptions ride in the meta so the recipient's sheet
  can list them before anything is downloaded. The brief names only what was ticked. At most 50
  go with one handoff, the same cap the recipient narrows the meta to, so nothing is shipped that
  the other side would silently drop.
- The recipient ticks which to keep (all by default); the choice is stored on the record at the
  claim, so the install after `ready` needs no sheet. A memory is written **only if no file of
  that name exists** there, and a new one appends its line to `MEMORY.md`, which is never
  rewritten or trimmed. A received description reaches that index flattened to one line of at
  most 200 characters: Claude reads the index in every session, and the meta the sheet showed is
  not the file in the blob, so the file's text must not be able to add lines of its own.
- **A memory never fails the install.** The session matters more than any memory, so each
  memory is best effort: `Installed.kept` names one left alone because a different file of that
  name was already there (an identical one, which a retry finds, counts as written), `failed`
  says `name: reason`, and `memory_off` names the ones skipped because auto memory is off here.
- A teammate's install re-reads each file's own `type` and refuses anything but project and
  reference: the type on the sheet came in the relayed meta, and the sender's own check is only
  as good as the sender's build.
- Auto memory switched off (`autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY`), or
  moved by `autoMemoryDirectory`, means nothing is listed and nothing is written: a custom folder
  cannot be keyed by project, so it is left alone. The project's own
  `.claude/settings.local.json` and `.claude/settings.json` (in the checkout and the main one)
  outrank `~/.claude/settings.json`, as they do for Claude.
- `MEMORY.md` itself never travels. Keeping one person's memories in step across their own
  machines is the memory stream's job (docs/sync.md, *Claude's memory: your machines only*). A
  memory a handoff writes is a first discovery to that stream, so it goes out at stamp 1 and
  never undercuts a copy the server already holds.

## The brief

`handoff_brief` runs `claude -p` on a `--fork-session --no-session-persistence` resume with
no tools, no hooks and no MCP, after the pane is gone. It writes nothing into any PTY, so the
two places Episko presses Enter are unchanged. A failure, or *Skip*, leaves an empty brief to
write by hand; every field is cut to the schema's bounds (`clampBrief`) whoever wrote it.

## Failures

| What | What happens |
| --- | --- |
| server off, or older than handoff | the entry points are greyed with the reason |
| sync drops mid-upload | the next connection re-offers; the server answers with the parts it `have`s |
| oversized, bad target | refused before or at the offer; the row goes back on the shelf |
| quota | refused with the reason on the row; ↶ asks the server, whose *gone* (it never took the offer) settles it here; otherwise it is offered again on the next connection |
| checksum mismatch on seal | the server drops the parts and refuses |
| recipient's download corrupt | one re-fetch, then *Give back* |
| TTL before `done` | `expired`: the sender's row returns, the recipient installed nothing |
| server unreachable after the offer | the sender stays locked until it hears, or expiry + 1h |
| recipient's install fails after `done` | the blob stays; Retry or open the folder. The record never ages out while it waits, since it is the only copy |
| a closed record past its week | dropped, unless still unresolved (`returned`, an unarchived `done`, an uninstalled arrival); staging no record names goes at boot once a day old (`handoff_prune`) |
| app quits between the offer and the server's answer | the record keeps `sent`, so ↶ after a restart is a recall, never a local settle that the server's row would undo |
| too many memories for the meta | descriptions are shortened, then dropped from the list (the files travel whole); past that the error names the memories |
| another of my machines claimed it | the others say *taken on …* and drop the row |
