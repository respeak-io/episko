# Changelog

Every release, newest first. This file is the **only** place release notes are written:
the app ships it and shows it in *What's new*, `release.yml` lifts the matching section
into the GitHub release, and CI refuses a `dev → main` pull request whose `Unreleased`
section is empty.

`pnpm changelog` drafts `Unreleased` from the commits since the last tag. It writes a
draft and stops — nothing here is generated at release time, so what ships is what
somebody read.

Markers: `+` new · `~` changed · `!` fixed

## Unreleased

Two things 0.13.0 shipped that had never been clicked.

! **Clicking a project opens its dashboard.** It did nothing at all in 0.13.0 — the
  header carried the right attribute and the handler had the right branch, but the
  attribute was missing from the delegated click selector, so the branch was
  unreachable and the whole feature was dead on arrival.
! **The sidebar shows a hairline filling under a project while it counts down** to
  revealing that project's idle checkouts. Without it the panel appeared a second after
  you stopped moving, which read as a glitch rather than as a deliberate pause.
! **What's new opens by itself after an update again.** It skipped 0.13.0 entirely: the
  release that introduced the screen is the one where nobody has a record of having read
  it, and that empty record was being read as "brand new install, stay quiet". It now
  remembers every version it has shown you, so each one announces once and going back to
  an older build stays silent.
~ **The release-notes button is a document icon, and sits to the right of the version
  number** it explains rather than the left. It was also sharing a CSS class with the
  usage sparkline, which gave an 18px button a 24px-tall glyph.

## 0.13.0 — 2026-07-31

A project is a place you arrive at now, not a session you fall into.

+ **Clicking a project opens a dashboard.** The last week of that project's commits and
  sessions, summarised a day at a time, with every commit one keystroke away.
+ **Issues and pull requests**, with triage for the ones that have gone quiet and a
  *claim* so a colleague's agent doesn't start the same work twice. Starting an agent on
  an issue creates a worktree, sends the prompt, and says so on GitHub.
+ **A shared work log.** `.episko/digest.md` is committed, so the team reads one history
  instead of each paying to re-derive it. Notes can be shared the same way.
+ **What's new** — this screen. It opens once after an update, and the ✦ beside the
  version number in the footer reopens it.
~ **The sidebar only lists checkouts something is running in.** Rest on a project for a
  moment to see the rest; the timings are yours to set in Settings › Worktrees.
~ The project header's ⌘I collapses the inspector to an icon rail rather than hiding it,
  because on the dashboard it holds the only copy of History, Terminal and Run.

## 0.12.0 — 2026-07-31
Six branches landed at once, and the window finally has one title bar.

+ The app draws its own title bar on both platforms — the native one is gone.
+ A session notices when an agent leaves the checkout it was launched in, and offers to
  follow it there or move the conversation.
+ **Commit graph** — a project's history, one page at a time, from the project menu.
+ Choose the permission mode a session starts in.
+ Right-click a ⑃ cluster header for its own menu; ＋ launches straight into that checkout.
~ The ＋ Session picker offers branches that exist only on a remote.
~ The main checkout stops dressing as a worktree — it wears ⌂ and the project's own accent.
! Ctrl+Shift+C / Ctrl+Shift+V copy and paste in shell and task panes.
! A turn the API killed no longer turns green a minute later.
! Windows: one canonical path spelling, so a repo stops rendering as two.

## 0.11.1 — 2026-07-28
A one-line fix for something that made a whole feature look broken.

! A symlinked working directory found no past sessions at all. The transcript folder is
  keyed by the *physical* path, so encoding the spelling you typed found nothing — which
  read as "no history" rather than as a failure.

## 0.11.0 — 2026-07-27
**Runnables** — Episko runs the task definitions your project already ships.

+ Run tasks from `package.json`, `justfile`, `Makefile`, `Taskfile.yml`, `mise.toml`,
  `Cargo.toml`, and VS Code's `tasks.json` / `launch.json`. A run is just another pane,
  so it gets the phase glyphs, the tray and ⌘1–9 for free.
+ **Run after a session stops**: when an agent finishes a turn in a project, verify it.
+ A project task panel for pinning, hiding, editing and overriding — writing only ever
  to `.episko/tasks.toml`, never to another tool's file.
+ The episko.dev site, and a README written around what Episko actually does.
! Ctrl+C interrupts an embedded Claude pane; it never exits it.
! Ctrl+V pastes images correctly.

## 0.10.1 — 2026-07-23
Cleanup after the rename.

! Recover settings stranded by the Muster → Episko rename. macOS keys localStorage to
  the bundle id, so a renamed bundle looked like a factory reset.

## 0.10.0 — 2026-07-23
**Muster is now Episko.** Same app, better name.

~ Renamed throughout, including the bundle id — see 0.10.1 for the settings this stranded.
! Windows: one canonical path spelling, so external sessions merge into their project.
! Embedded-terminal ghost cells — resize is debounced and forces a repaint.

## 0.9.0 — 2026-07-22
Released as Muster.

+ Worktree grouping in the sidebar: several checkouts of one repo read as one project.
+ Session history — reopen a session you closed.

## 0.8.0 — 2026-07-21
Released as Muster.

+ Usage analytics: spend per day, per model and per project, with a token ledger read
  from Claude's own transcripts.

## 0.7.0 — 2026-07-21
Released as Muster.

+ External sessions — Claude sessions started outside the app are listed, mirrored
  read-only, and can be jumped to in their own terminal.

## 0.6.0 — 2026-07-21
Released as Muster.

+ The permission cockpit: a blocking permission request is answered in the app, without
  switching to the pane that asked.

## 0.5.1 — 2026-07-20
Released as Muster.

! The tray title no longer lags a phase behind the sidebar.

## 0.5.0 — 2026-07-20
Released as Muster.

+ The ⑃ worktree dialog: create, switch and prune checkouts without leaving the app.

## 0.4.3 — 2026-07-18
Released as Muster. The first build worth installing.

+ Auto-update, so this is the last one you install by hand.
