# Linux port and packaging — implementation plan

Goal: a Linux user downloads a `.deb`, `.rpm` or `.AppImage` from the GitHub release,
installs it, launches Episko and gets what a Windows user gets today: the embedded
terminal, telemetry, permissions, usage, the tray, keep-awake and the self-updater.
External terminal engines and *jump to a session's terminal* stay "—" on Linux in this
pass, exactly as they are on Windows.

Not in this pass (see §7): a hosted apt/rpm repo, AUR, Flathub, snap, the official
Debian archive.

## 0. Ground rules

- Read `CLAUDE.md` first, then `docs/testing.md`, `docs/native-ui.md`, `docs/releases.md`
  and the *Platform support* table in `README.md`. Every invariant there still holds.
- Branch `feat/linux` off `dev`. Commit per slice, push, open the PR against `dev`
  when slice A is green. Work through all slices without stopping for approval; batch
  judgement calls into the final report (§8).
- The gates, on the OS you are on, before every push: `pnpm build`, `pnpm test`,
  `cargo check --locked`, `cargo test --locked`, `cargo clippy --all-targets --locked
  -- -D warnings` (from `src-tauri/`). Run `rustup update stable` first: CI runs the
  newest stable and a stale local clippy has already let a red PR through once.
- `gh` on this machine holds two accounts; only **FAbrahamDev** can write to
  `respeak-io/episko`. `gh api user --jq .login`, switch if needed, switch back after.
- Comments stay within `test/comments.test.ts`'s budget (one or two lines; the why, not
  the what). A Linux rule worth a paragraph goes in `docs/`, with a one-line pointer.
- **Trust the code over this plan.** Line numbers below are from 2026-09-29 on `dev`
  at 0.32.0; re-grep before editing.

## 1. Already Linux-ready — do not redo

- Every `#[tauri::command]` behind a cfg has a `not(windows)` arm, so the crate should
  compile on Linux as is (`available_terminals`, `focus_external_session`,
  `open_terminal_here`, `set_caffeinate`, `spawn_external_terminal`).
- `sync.rs` `save_secret`/`load_secret` have a `not(any(windows, target_os = "macos"))`
  arm: a 0600 file. Leave it; `secret-tool` is a later nicety.
- The openers in `platform.rs` (`open_folder`, `reveal_path`, `open_url`, …) have
  `cfg(all(unix, not(target_os = "macos")))` arms using `xdg-open` (lines ~466, 526,
  624, 658).
- `tasks.rs:487` already maps the VS Code platform key to `"linux"`.
- `pty.rs` `bg_log_roots` has a `ClaudeOs::Unix` candidate (`/tmp/claude-<uid>`).
- `external.rs`'s process table and `platform.rs`'s `path_holders` are `sysinfo`;
  `session_ports` is the `listeners` crate, which reads `/proc` on Linux. No `ps`.
- Telemetry hooks use `/usr/bin/curl` and `/dev/null` on every non-Windows OS
  (`telemetry.rs:167,266`). Correct on every mainstream distro. **But curl is not
  installed on minimal Debian/Ubuntu** — that is a package dependency (slice D), or
  every session sits at `idle` with no telemetry and nothing says why.
- Frontend: `dom.ts` already yields a `linux` html class, `MOD = "Ctrl"`, `FILE_MANAGER =
  "file manager"`, `EMOJI_PICKER_KEY = ""` (and `projmenu.ts:108` hides the hint when
  empty). Copy/paste in shell/task panes is Ctrl+Shift+C/V, the Linux convention.
- The UI/terminal font is bundled (`@font-face` in `styles.css:3-15`), so no system
  font dependency.
- `tauri-plugin-updater` 2.10.1 (in `Cargo.lock`) installs `.deb` and `.rpm` updates
  via `pkexec` + `dpkg`/`rpm`, and AppImages in place. Nothing to add for the updater.
- `capabilities/default.json` has no `platforms` key, so no invoke is excluded on Linux.

## 2. Slice A — prove it compiles: a Linux leg in CI

Files: `.github/workflows/ci.yml`.

1. Add `ubuntu-22.04` to the `build-check` matrix. Use the **oldest** Ubuntu runner
   GitHub still offers: for slice D the same image builds the release, and the produced
   binary's glibc floor is the runner's. If 22.04 is gone, use 24.04 and write the floor
   into the install notes.
2. Add a step, gated `if: runner.os == 'Linux'`, before `pnpm install`:
   ```sh
   sudo apt-get update
   sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
     libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
   ```
3. Every existing step then runs unchanged on the new leg: `pnpm build`, `pnpm test`,
   `cargo check`, `cargo test`, `cargo clippy`, and the sync-crates loop (pure Rust,
   no platform gates — checked).
4. Expected failures to fix **per-OS, never by deleting the assertion**:
   - `platform.rs` ~1265 `augmented_path_carries_the_fallback_dirs…` asserts
     `/opt/homebrew/bin`. Assert the Homebrew dir only under `target_os = "macos"`;
     `/usr/local/bin`, `/usr/bin`, `/bin` and `.cargo/bin` hold everywhere.
   - Anything that spawns `zsh` or assumes a macOS `ps` output. `grep -n zsh src-tauri/src`
     finds the `$SHELL` fallbacks (slice B fixes those).
   - Tests that hit the real `claude` are `#[ignore]` and stay so.
5. Add one sentence to the cfg-flip note in `docs/testing.md`: the Linux leg now
   type-checks the unix arms on a second OS, so the flip is no longer the only cross-check.

Done when the PR shows three green `build-check` legs.

## 3. Slice B — the runtime arms that are macOS today

All of these compile on Linux and fail at runtime. Split each `not(windows)` arm into a
`target_os = "macos"` arm (unchanged) and a Linux arm, or branch inside with
`cfg!(target_os = "linux")` where the body is one line.

### B1. Keep-awake (`platform.rs:684 set_caffeinate`)

There is no `caffeinate` on Linux. The equivalent with the same shape — hold an
inhibitor for as long as a child lives — is `systemd-inhibit`, part of systemd itself,
so present on Ubuntu, Debian, Fedora, Arch and openSUSE with no extra package.

- Keep the wire format: the frontend keeps sending macOS flag strings
  (`caffeinate.ts:17-19` says so on purpose) and `valid_caffeinate_flag` stays shared.
- Map flags to `--what=`: `d` or `u` → `idle`; `i` or `s` → `sleep`; `m` → nothing
  (Linux has no disk-sleep inhibitor; drop it silently). Join with `:`.
- The held command must die with Episko the way `caffeinate -w <pid>` does. Use
  `sh -c 'while kill -0 <our pid> 2>/dev/null; do sleep 5; done'` as the wrapped
  command; the `-t <secs>` timer preset wraps `sleep <secs>` instead.
  ```
  systemd-inhibit --what=idle:sleep --who=Episko --why="<preset label>" --mode=block sh -c '…'
  ```
- If `systemd-inhibit` is not on `augmented_path()`, return
  `Err("keep-awake needs systemd-inhibit")`; `caffeinate.ts:92` already toasts the error.
- Verify on GNOME and KDE separately: KDE honours logind `idle` inhibitors; some GNOME
  versions blank the screen anyway. If the *display* preset does not hold on GNOME,
  add `gnome-session-inhibit --inhibit idle` when `XDG_CURRENT_DESKTOP` contains
  `GNOME`, and say which you verified in the report.
- Frontend (`caffeinate.ts`): `CAF_HOST` is `IS_WIN ? "PC" : "Mac"` — add a Linux word.
  The chip (`cafChip`, line ~33) shows literal flags on macOS and a word on Windows; on
  Linux show the inhibitor words (`idle`, `sleep`). The `full` preset is filtered out on
  Windows (line 32); on Linux it maps to `idle:sleep`, so keep it.

### B2. Login shell defaults (`platform.rs:284 resolve_claude`, `pty.rs:382 interactive_shell`)

Both fall back to `/bin/zsh` when `$SHELL` is unset. On Linux fall back to `/bin/bash`.
`$SHELL` is almost always set, so this is a one-liner each, but the fallback is what a
`.desktop` launch under a minimal session sees.

### B3. External terminals (`pty.rs:1059 available_terminals`, `pty.rs:978 find_ghostty`, `pty.rs:1188 open_terminal_here`)

- `available_terminals`: gate the `Terminal.app` and `iTerm.app` probes under
  `target_os = "macos"`. Ghostty is one CLI on both OSes and `find_ghostty` already
  runs a `command -v ghostty` probe before the macOS paths, so leave the `ghostty`
  engine reachable on Linux and **verify it by hand** (slice E). If tinting or `-e`
  misbehaves on Linux, gate it out and say so; do not ship a half-working engine.
- `open_terminal_here` Linux arm (the project menu's *Open terminal here*): try, in
  order, `$TERMINAL`, `ghostty --working-directory=<dir>`, `kitty -d <dir>`,
  `alacritty --working-directory <dir>`, `wezterm start --cwd <dir>`,
  `gnome-terminal --working-directory=<dir>`, `konsole --workdir <dir>`,
  `x-terminal-emulator` (no cwd flag: spawn with `current_dir`). First found wins;
  none → `Err("no terminal emulator found")`.
- `spawn_external_terminal`'s Terminal/iTerm arms are unreachable on Linux once
  `available_terminals` stops offering them; no change beyond the ghostty check.

### B4. Jump to a session's terminal (`external.rs:415 focus_external_session`)

`owning_terminal` (line 260) looks for `.app/Contents/MacOS/` and returns `None` on
Linux, so the command already fails cleanly with *couldn't find the terminal window*.
Leave it. Mark the README cell "—". An X11 `xdotool search --pid` arm is §7.

### B5. `augmented_path` (`platform.rs:399`)

The fallback list already carries `~/.local/bin`, `~/.claude/local`, `~/.cargo/bin`,
`/usr/local/bin`, `/usr/bin`, `/bin`, and the login-shell probe supplies nvm's node.
No change beyond the test in slice A. Do not add distro-specific dirs.

### B6. Things to verify rather than change

- `bg_log_roots`: start a `Bash{run_in_background:true}` dev server from a Claude
  session on Linux and confirm the header row leaves *starting…*. Claude Code's Linux
  layout is `${CLAUDE_CODE_TMPDIR ?? /tmp}/claude-<uid>`; the `Unix` arm encodes that.
- `session_ports`: a `pnpm dev` inside a shell pane shows its port in the header pill.
- Sync: pair against a server; the token lands as a 0600 file in the app dir.
- `read_legacy_localstorage` and *Settings › Privacy* are macOS-only with stubs; nothing
  to do.

## 4. Slice C — the window, the tray and the webview

### C1. The title bar (`lib.rs:322`, `main.ts:641`, `styles.css:119-122`, `docs/native-ui.md`)

`titleBarStyle: Overlay`, `hiddenTitle` and `trafficLightPosition` in `tauri.conf.json`
are macOS-only and ignored elsewhere. Only the Windows arm sets `decorations = false`,
so Linux today would get a GTK title bar **above** the app's own header: two bars, which
`RELEASE.md` › *The title bar* forbids.

Decision to make, in this order:

1. Try the Windows shape: `#[cfg(any(windows, target_os = "linux"))] win_cfg.decorations
   = false;`, show `.wctl` under `html.linux` as well as `html.win`, and widen the
   window-control block in `main.ts:641-654` from `IS_WIN` to `!IS_MAC` (the block's
   outer guard from `IS_MAC || IS_WIN` to `IS_TAURI`). Then **resize from every edge and
   corner** on both X11 and Wayland, and drag the header. Undecorated resize on Linux is
   tao's to provide and behaves differently per compositor.
2. If edge resize does not work under Wayland, keep native decorations on Linux
   (`decorations = true`) and make the header stop pretending to be a title bar there:
   no `.wctl`, no drag region needed. One bar either way.

Write the outcome into `docs/native-ui.md` beside the Windows rule, and add a Linux
bullet to `RELEASE.md` › *The title bar*.

### C2. The tray (`lib.rs:153 update_tray`, `lib.rs:341`)

- Runtime needs `libayatana-appindicator3-1` (slice D dependency).
- On GNOME there is **no tray at all** without the AppIndicator/KStatusNotifierItem
  shell extension. Not our bug; say so in the install notes.
- `set_title` is a label on KDE and ignored on GNOME; `icon_as_template(true)` is a
  macOS no-op elsewhere, so check the icon's contrast on a dark and a light panel.
- `tray-icon` writes the icon to a temp file on every `set_icon` on Linux. `tray.ts:96`
  already guards `update_tray` by signature; confirm nothing else repaints the tray icon
  per pass (grep `set_icon` in `lib.rs`).

### C3. The webview

- WebKitGTK + NVIDIA proprietary driver (and some VMs) renders a blank window. The known
  workaround is `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Only if reproduced: set it in
  `main.rs` on Linux when `/proc/driver/nvidia` exists, before `run()`, and note it in
  the install notes either way.
- xterm's WebGL addon: `terminal.ts:33 onContextLoss` is the fallback. Confirm a pane
  still paints (DOM renderer) when WebGL is unavailable, e.g. under `LIBGL_ALWAYS_SOFTWARE=1`.
- The file picker (`tauri-plugin-dialog` `open`) is GTK or the xdg portal. Pick a
  project with a non-ASCII name and confirm `nfcPath` leaves it matching what Claude
  writes under `~/.claude/projects`.
- `html.win .ibtn .gl { top: … }` (`styles.css:111-114`) are Segoe-metric nudges; do
  not copy them to `.linux` unless the glyphs are visibly off with the bundled font.

## 5. Slice D — bundle, release, docs

### D1. `src-tauri/tauri.conf.json`

```json
"linux": {
  "deb": { "depends": ["curl"] },
  "rpm": { "depends": ["curl"] }
}
```
under `bundle`. Then build once (`pnpm tauri build --bundles deb`), run
`dpkg-deb -I src-tauri/target/release/bundle/deb/*.deb`, and check `Depends` carries
`libwebkit2gtk-4.1-0` and `libgtk-3-0` (the bundler adds those) **and**
`libayatana-appindicator3-1`. If the bundler did not add the appindicator lib, add it to
`depends` explicitly; the tray is on. Check the generated `.desktop` entry's `Name`,
`Icon` and `Categories` while there.

### D2. `.github/workflows/release.yml`

- Add `- platform: ubuntu-22.04` (same image as slice A) with `args: ""` to the matrix,
  and the apt-prerequisites step gated on that platform. The signing steps are already
  gated per OS and stay inert here.
- `tauri-action` uploads the `.deb`, `.rpm`, `.AppImage`, their `.sig` files, and merges
  `linux-x86_64` into the one `latest.json`. Nothing else to wire.
- Update the header comment that lists what each leg produces.
- To test a bundle **without cutting a release**: on the CI Linux leg, add a
  `pnpm tauri build --bundles deb` + `actions/upload-artifact` step behind
  `if: github.event_name == 'workflow_dispatch'`, so a `.deb` from any branch can be
  pulled from the run and installed in a VM. Remove or keep it, your call; say which.

### D3. Install notes, README, site, changelog

- `.github/release-install.md`: a **Linux (x64)** block — `.deb` for Debian/Ubuntu
  (`sudo apt install ./Episko_*_amd64.deb`), `.rpm` for Fedora/openSUSE
  (`sudo dnf install ./Episko-*.x86_64.rpm`), `.AppImage` (`chmod +x`; needs `libfuse2`
  on Ubuntu 22.04 and later), the glibc floor, the GNOME tray-extension note, and that
  updates of a `.deb`/`.rpm` install ask for your password through polkit.
- `README.md` platform table: a real Linux column (embedded ✅, external engines —,
  telemetry ✅, discovery ✅, jump —), and rewrite the sentence under it.
- `site/index.html`: a third download button (`dlLinux`, `.deb`) beside the two at
  ~1592-1600, and a `find(/\.deb$/i)` in `paint()` at ~1897. `site/llms.txt:40` names
  the formats too.
- `CHANGELOG.md` › `## Unreleased`: one `+` entry, written for a user, per
  `docs/releases.md`. Something like *Episko runs on Linux: a .deb, .rpm and AppImage
  ship with every release and keep themselves up to date.* Plus a `~` for anything
  the title-bar decision changed.
- `RELEASE.md`: a Linux bullet under *The OS edge* (tray, keep-awake) and *The title
  bar*, and the Linux paths in the logs table at ~572.
- `docs/native-ui.md`: the C1 outcome. `docs/sync.md`: one line that Linux stores the
  token as a 0600 file.

## 6. Slice E — verify on a real Linux desktop

There is no Linux machine on the team, so this slice is the one that finds the bugs.

**WSL on this machine**: `wsl -l -q` lists an `Ubuntu` distro and Windows 11 has WSLg,
so `pnpm tauri dev` shows a window. Rules: clone into the WSL filesystem (not `/mnt/e`;
NTFS is slow and PTY permissions differ), `nvm use` from `.nvmrc`, install Rust, then
the apt line from slice A. **Ask the human for the `sudo` line**; nothing else needs
them. Limits of WSL: no tray (WSLg's Weston has no status-notifier host),
`systemd-inhibit` needs systemd enabled in `/etc/wsl.conf`, and `claude` inside WSL is a
separate install with its own `~/.claude`. So the tray, keep-awake and the title-bar
decision need a **VM** (an Ubuntu 24.04 live image is enough) or a real desktop, on
X11 and Wayland, GNOME and KDE.

Walk `RELEASE.md`'s click-through as a Linux column; the minimum set:

- [ ] Launch from the `.desktop` entry (stripped PATH): `claude` is found, a session
      starts, model / context % / cost land within one statusLine.
- [ ] A permission prompt blocks the pane and resolves from the inspector.
- [ ] A background dev server's row leaves *starting…* and shows its URL; the header
      pill counts a port opened by hand in a shell pane.
- [ ] Tray mirrors the fleet; picking a session brings it to the stage.
- [ ] Keep-awake: `systemd-inhibit --list` shows Episko while armed and not after.
- [ ] Window: one bar; drag, double-click, resize from every edge; the quit guard on ✕.
- [ ] Open folder / reveal / open URL / open terminal here.
- [ ] Sync pairing; the token file is `0600`.
- [ ] Updater: install version N-1's `.deb`, launch, accept the update, relaunch on N.
- [ ] Quit with live sessions warns; nothing left in `~/.claude/sessions`.

## 7. Later, not now

- A hosted apt + rpm repo so `apt install episko` works after adding one source line
  (`reprepro`/`aptly` in the release workflow, a GPG key as a secret, the pool on the
  existing Cloudflare site). About a day, once there are Linux users.
- AUR `episko-bin` PKGBUILD repacking the release `.deb` (an hour).
- X11 *jump to terminal* via `xdotool search --pid`; nothing general exists on Wayland.
- `secret-tool` (libsecret) for the sync token instead of the 0600 file.
- Flathub and snap: the app's whole job is spawning host binaries and reading
  `~/.claude`, which means `--filesystem=host` plus `flatpak-spawn --host` in front of
  every `Command::new`. A separate project, only on demand. The official Debian archive
  and Launchpad PPAs are not realistic for a Tauri app.

## 8. Report back

One message at the end: the PR link, which slices landed, the title-bar decision and
what it was verified on (compositor, desktop, driver), what GNOME did with the idle
inhibitor, the `Depends` line of the built `.deb`, every judgement call made, and what
was left out and why.
