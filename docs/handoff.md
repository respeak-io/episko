# Session handoff

Sending a stopped Claude session to another of your machines, or to a teammate, through the
sync server: the conversation, the code it was working on, and a short brief. The recipient
resumes it as an ordinary shelved row. Everything else about sync (docs/sync.md) still holds;
this is the one channel that carries anything conversational.

## The channel

Handoff is **not** a sync `Stream` and does not bump `PROTOCOL`. It is an opt-in channel on
the same WebSocket:

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
- After every hello the server sends the user's whole set (`handoff_list`), and `handoff` on
  every change. A missed message is therefore harmless: the next list is the whole truth.

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
  reads its own `launchPermission`.

## State machines

### Server (authoritative)

`uploading` → (last part lands and the sha256 matches) → `offered` → (`claim`, one winner)
→ `claimed` → (`complete` by the taker) → `done`. Terminal: `done`, `declined`, `recalled`,
`expired`. `recall` is the sender's, in `uploading`/`offered`; `decline` is the recipient's in
`offered` or the taker's in `claimed` (giving it back). A claim extends `expires` to at least
an hour out. The TTL sweep runs every ten minutes **whether or not the flag is on**, so held
blobs die on schedule after the switch is turned off.

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

### Recipient (`dir: "in"`)

`offered` arrives → *Resume here* claims → the app downloads and checks the sha256 (one
re-fetch on a mismatch) → it sends `complete` itself → on `done` it installs: unpack, refuse
another project or provider, land the code, file the transcript, then resume. Before `done`
the only way out is *Give back*; nothing has been written. After `done` a failed install keeps
the blob and offers Retry: the sender has already let go, so this is now the only copy.

## Why exactly one machine owns it

The server makes the one decision that matters, with a compare-and-set: `offered → claimed`
has one winner. The recipient writes into `~/.claude` or git **only after `done`**, and the
sender archives its transcript **only after that same `done`**. If the TTL fires in any state
before `done`, ownership is the sender's again and the recipient has installed nothing.
`complete` is idempotent for the taker, so a crash between sending it and hearing `done` is
repaired by the next connection. The one hole is a sender that cannot hear the server: it
cannot know whether `done` happened, so it stays locked rather than guessing, and when it
finally gives up (expiry + 1h) it asks a human, who can ask the other human.

## The container (`EPKH`)

`"EPKH1\n"`, then per entry `u32 name_len | name | u64 len | bytes`, little-endian. Allowed
names: `manifest.json`, `transcript.jsonl`, `sidecar/tool-results/<n>`, `sidecar/subagents/<n>`,
`repo.bundle`, `memory/<n>.md`, with `<n>` matching `[A-Za-z0-9._-]+`. Any other name rejects
the whole blob. The manifest lists each file's length and sha256; the offer carries the whole
blob's. Parts are 512 KiB raw (base64 on the wire, about 683 KiB a frame), so a proxy in front
of the server must pass WebSocket messages of at least 1 MiB. At most two parts are in flight.

Staging lives under the app cache (`handoff/out`, `handoff/in`); the sender's archive of a
handed transcript lives under app data for 14 days.

## How the code travels

`handoff_git_state` classifies the checkout and `gitChoices` turns that into options. A clean,
pushed checkout sends nothing. Unpushed commits go as a pushed `handoff/<id>` branch or a
bundle. A dirty tree is snapshotted (a commit on a private index, never touching yours) and
goes either way, and **has no preset**: Send stays disabled until somebody chooses, because
neither answer is safe to assume. Applying in place and cherry-picking are not offered.

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
| quota | refused with the reason on the row; ↶ cancels, or it is offered again on the next connection |
| checksum mismatch on seal | the server drops the parts and refuses |
| recipient's download corrupt | one re-fetch, then *Give back* |
| TTL before `done` | `expired`: the sender's row returns, the recipient installed nothing |
| server unreachable after the offer | the sender stays locked until it hears, or expiry + 1h |
| recipient's install fails after `done` | the blob stays; Retry or open the folder |
| another of my machines claimed it | the others say *taken on …* and drop the row |
