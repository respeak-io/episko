# Releasing Episko

Cutting a release is one command. Everything else on this page is the part no
automated gate can do.

**Why this is a file and not a README section.** README is for people deciding
whether to *use* Episko; this is a procedure for the one person shipping it, and it
is long enough that folding it in would bury the install instructions. It also has a
different lifetime — it changes when the OS edge changes, not when the app does.

---

## What CI already guarantees, so you needn't re-check it

Every push and PR to `dev`/`main` runs, on **both macOS and Windows** (`ci.yml`):

- `pnpm build` — `tsc --noEmit` (strict) plus the vite build
- `pnpm test` — 368 vitest tests over the logic modules
- `cargo check --locked` and `cargo test --locked` — 77 tests
- `cargo clippy --all-targets --locked -- -D warnings`

Both legs matter and neither is redundant: the platform code is `cfg`-gated, so each
OS compiles and lints only its own half.

**What CI cannot see** is everything below — the PTY, the tray, real windows, the
permission round trip, and whether Claude Code's own interfaces still match ours.

---

## Before tagging

### 1. The CLI contract test — run it, it is not in CI

```sh
cd src-tauri
cargo test --locked -- --ignored --nocapture
```

Runs one real `claude -p` against a throwaway session in a temp dir and asserts our
hooks reach our server, that routing still uses our launch id, and that the
transcript still carries the fields the cost ledger reads. **It needs `claude` on
PATH and an authenticated account, and it spends tokens** — which is exactly why it
is `#[ignore]`d and lives here rather than in the PR gate.

A failure here is the highest-signal failure in this document: it means a Claude Code
release changed something under us, and the app would otherwise have gone quiet
rather than gone red.

It does **not** cover the statusLine half (`-p` is non-interactive), the
`~/.claude/sessions` registry, or `PermissionRequest`. Those are the click-through
below.

### 2. Version bump

`package.json` and `src-tauri/tauri.conf.json` must agree, and the tag must match
both. The footer shows the running version; a mismatch there is the first thing a
user reports.

---

## The click-through

Do this on a **build**, not `pnpm tauri dev` — the packaged app has the stripped PATH
and the real bundle identity, which is where the OS edge actually bites.

**Never run a dev build from inside an Episko pane.** It becomes a descendant of the
installed app, so `ProcTable::is_descendant_of` filters its sessions out of the
external list; worse, the two share one `localStorage` and one `episko-debug.json`,
so nothing you observe can be attributed to either. Quit the installed app and use a
real terminal.

Tick these in order — each depends on the one above.

### Launch and telemetry

- [ ] **A session starts.** Add a project, `＋ Session`, accept Claude's
      workspace-trust prompt, ask it something. The terminal renders and accepts input.
- [ ] **Telemetry arrives.** The 🐞 console shows `telemetry: rx N · routed N ·
      dropped 0`, with `rx` climbing. `dropped` in warn colour is routing drift and is
      a release blocker. A fresh instance reads `rx 0` until a session is launched
      *inside it*.
- [ ] **The statusLine half arrives**, which the hook counter does not tell you —
      hooks log a line each, statusLine deliberately does not. The evidence is the
      inspector's **model / context % / cost / duration** and the footer meters being
      populated rather than `–`. **This is the known-suspect one on Windows** (see
      README's known limitations); confirm it explicitly rather than assuming.
- [ ] **Phases track reality.** The sidebar glyph moves idle → thinking → working →
      your-turn as the agent works, and the pane doesn't show the ended `·` while the
      process is still alive.

### The blocking path

- [ ] **A permission is answerable.** Ask a session to run something needing
      approval. The pane must raise `permission: <tool>` with a command preview and a
      risk chip, and **allow / deny / hand-to-terminal must each unblock Claude**. This
      is a *blocking* hook — if the UI doesn't answer, Claude hangs, so a failure here
      is a hard blocker.
- [ ] **Answering in the CLI instead** also clears the badge on the next lifecycle event.

### Identity across rotations

- [ ] **`/clear` (or `/compact`) does not orphan the pane.** Claude mints a new
      runtime `session_id`; telemetry must keep routing (inspector keeps updating) and
      the pane must **not** flip to the ended glyph. This is the single most
      regression-prone behaviour in the app.
- [ ] **Resume works after a restart.** Quit with a live session, reopen, resume it
      from the roster. It must resume the *same* conversation — that is `resumeId`, not
      the launch id, doing its job.

### Panes that aren't agents

- [ ] **`❯ Terminal`** opens a working shell pane.
- [ ] **`▶ Run`** discovers this project's tasks and runs one; exit 0 shows `done`,
      non-zero shows `error` and raises attention.
- [ ] **A run-on-stop rule fires** once per turn, does not steal the stage, and offers
      its output back to the session whose turn triggered it.

### Sessions Episko doesn't own

- [ ] **An external session appears.** Start `claude` in a plain terminal; it shows in
      the sidebar within ~3s as a read-only mirror. Then `/clear` inside it and confirm
      it does **not** duplicate or vanish (pid-based filtering, not id-based).
- [ ] **macOS only:** clicking it fronts its terminal window.

### The OS edge

- [ ] **Tray** mirrors the fleet; picking a session brings it to the stage.
- [ ] **Quit guard** warns about live sessions.
- [ ] **Caffeinate** asserts and releases (the icon reads armed vs asserting).
- [ ] **The window survives a resize** — panes refit, no stuck scrollback.

### Logs, after all of the above

- [ ] `episko.log` ends with `exit · clean shutdown`. A log that just stops is
      evidence of an abnormal termination, and `panic.log` next to it is the only trace
      of a panic that unwound cleanly out of `main`.
- [ ] The debug snapshot is current. It is written **compact** and only when the state
      changed, plus a 60s heartbeat — so a `generatedAt` older than ~60s means the
      frontend stopped flushing, not that nothing happened.

| | macOS | Windows |
| --- | --- | --- |
| debug snapshot | `$TMPDIR/cc-launcher/episko-debug.json` | `%TEMP%\cc-launcher\episko-debug.json` |
| rolling log | `~/Library/Logs/io.respeak.episko/episko.log` | `%LOCALAPPDATA%\io.respeak.episko\logs\episko.log` |

---

## Cutting it

```sh
git tag v0.11.1 && git push origin v0.11.1
```

`release.yml` builds both platforms against that tag, and both jobs append to the one
GitHub Release: macOS `aarch64` produces the `.dmg` + the updater artifact, Windows
x64 the NSIS `.exe` and `.msi`. The minisign key signs the updater artifacts on both;
**OS code-signing is separate** — macOS is self-signed and not notarized, and Windows
Azure Trusted Signing is opt-in and no-ops until the `AZURE_CLIENT_ID` secret exists
(see `src-tauri/SIGNING.md`).

Install instructions are embedded in the release body by the workflow, because GitHub
cannot pin a release and "always in the newest one" is the equivalent.

## After tagging

- [ ] Both matrix jobs green, and **both platforms' assets** on the release — a
      partial matrix leaves a release that only some users can install.
- [ ] `latest.json` is present and lists both platforms, or the in-app updater offers
      nothing.
- [ ] **The updater actually updates.** Install the *previous* version, launch it, and
      take the update. This is the one step that cannot be checked before tagging, and
      the one whose failure is silently permanent for everyone already installed.
- [ ] On Windows, SmartScreen warns but **More info → Run anyway** works. On macOS the
      quarantine steps in the release body clear it.
