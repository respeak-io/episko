---
name: release
description: Cut an Episko release end to end — merge the open PRs into dev, run every gate on the merged result, roll the changelog on main, tag, and put main back into dev. Use when asked to cut, ship, tag or publish a release, or to prepare one. Stops at the three answers only a human has: the version, the click-through, and the tag push.
---

# Cutting a release

**`RELEASE.md` is the procedure; this file is only the driver.** It holds the click-through
checklist, what CI already guarantees, and the reasoning behind each step. Read it at step 4
rather than restating it here — a second copy of a checklist drifts from the first, and the
repo has shipped that failure twice already (`health.rs` vs `health.ts`, and the two
hand-kept status-letter tables that each claimed to be shared with the other). **When this
file and `RELEASE.md` disagree, `RELEASE.md` wins and gets fixed in the same commit.**

Work top to bottom. **Steps 3, 4 and 7 are STOP points** — do not pass one without an
answer from the human. Everything between them is mechanical and takes about ten minutes,
which is what the release history shows: every `release:` commit since 0.13.x lands within
two minutes of its merge commit.

---

## 0. Preflight

```sh
gh auth status                 # FAbrahamDev must be the ACTIVE account
git fetch origin --prune --tags
git rev-list --count origin/dev..origin/main      # must be 0
```

- **Two GitHub accounts are logged in on this machine.** `Blaxzter` is the wrong one for
  `respeak-io/episko`; `gh pr create` under it fails or files against the wrong identity.
- **The count must be 0**, meaning `main` is an ancestor of `dev`. Anything else means the
  last release skipped step 9 and `dev` is about to re-propose notes that already shipped.
- Local `main` is usually far behind — it is only touched at release time. Never assume it.

## 1. Merge every open PR into dev

```sh
gh pr list --state open --base dev --json number,title,mergeable,statusCheckRollup
```

Each one needs `build-check` green on **both** macOS and Windows. The `changelog` check
shows `SKIPPED` on a PR onto `dev` — that gate only runs on a PR onto `main`, and skipped is
correct here.

```sh
gh pr merge <n> --merge        # a merge commit, never a squash
```

**A long-lived branch will conflict, and two conflicts recur.** Merge it locally
(`git fetch origin pull/<n>/head:pr<n> && git merge --no-ff pr<n>`) and expect:

- **`CLAUDE.md`'s frontend module count**, in three places. The true number is
  `ls src/*.ts src/providers/*.ts | wc -l` **minus one** — `src/emojidata.ts` is generated
  data, not a module. Both sides of the conflict are stale by construction, so compute it;
  do not pick a side.
- **`CHANGELOG.md`'s `## Unreleased`.** Auto-merge appends one side after the other, which
  breaks the `+` / `~` / `!` grouping. Re-sort the entries by marker, stable within each group.

## 2. Gates, on the merged result

**This combination has been built nowhere.** Each PR's CI ran against the `dev` it was cut
from, not against the `dev` it just landed on, so green checks on every PR say nothing about
the merge. Run all of it locally:

```sh
pnpm exec tsc --noEmit
pnpm exec tsc -p tsconfig.test.json --noEmit
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
```

Then the three things CI cannot do:

```sh
# 1. the background-shell probe still finds what Claude Code writes — N must be >= 1.
#    libtest swallows a passing test's output, so ask for it.
cargo test --locked -- --show-output read_bg_log_finds_a_log

# 2. the CLI contract tests, not in CI. Four checks against the real `claude`.
#    Three cost nothing; `claude_cli_still_honours_our_instrumentation` spends tokens — ASK FIRST.
cargo test --locked -- --ignored --nocapture

# 3. no import cycles (CLAUDE.md requires a sweep after any change that adds an import)
```

A failure in the `--ignored` set is the highest-signal failure in the release: it means a
Claude Code release changed something under us and the app would have gone quiet rather than
gone red.

Last, check `upstream-contract` ran green within the last month
(`gh run list --workflow=upstream-contract.yml --limit 3`). It warns rather than failing when
the install endpoint moves, so it can die quietly; the release is the cadence at which a
human looks.

## 3. STOP — the version

Ask. The last tag is `git tag --sort=-v:refname | head -1`; the shape of what is in
`## Unreleased` decides minor vs. patch. Do not infer it.

Also check any tour chapter carrying a `since` (`grep -n 'since:' src/tour.ts`). *What's new*
offers a release intro on that exact string, so a chapter written for this release and cut as
another version is never offered and nothing says so.

## 4. STOP — the click-through

```sh
pnpm tauri build
```

Hand over `src-tauri/target/release/episko.exe` (or the `.app`) and **the checklist in
`RELEASE.md`**, which is the authority on what to click. Two rules travel with it:

- **On a build, not `pnpm tauri dev`.** The packaged app has the stripped PATH and the real
  bundle identity, which is where the OS edge actually bites.
- **Never launch it from inside an Episko pane.** It becomes a descendant of the installed
  app, so its sessions are filtered out of the external list, and the two share one
  `localStorage` and one `episko-debug.json` — nothing observed can be attributed to either.
  Quit the installed app and launch from Finder/Explorer.

A local build ends with `A public key has been found, but no private key`. That is the
minisign updater key, which only CI holds. Expected; both bundles are produced before it.

## 5. The PR to main

```sh
gh pr create --base main --head dev --title "release: <x.y.z>"
```

The body follows the house shape — see any previous one (`gh pr view <n> --json body`):
*What's in it* grouped new/changed/fixed, *Verified locally on the merged result* with the
real numbers from step 2, and anything known-red that is not being introduced here.

Wait for green, including the `changelog` gate, which now runs and refuses an empty
`## Unreleased`. Then `gh pr merge <n> --merge`.

## 6. The roll, on main

**The order is not the obvious one.** `changelog release` closes `## Unreleased` and opens a
fresh empty one, which is exactly what the `dev → main` gate refuses — so the roll cannot
happen on the branch the PR is cut from. It goes on `main` afterwards, as every release since
0.13.x has done.

```sh
git checkout main && git pull --ff-only
node scripts/changelog.mjs release <x.y.z>
```

Then, in **one** commit:

- **Write the lede.** `changelog release` writes only the heading. *What's new* renders the
  line under it as the release's headline and `release.yml` lifts the whole section into the
  GitHub release body, so a section with no entries **and** no lede is dropped at parse time
  and ships a release describing nothing.
- **The lede sits directly under the heading, with no blank line.** Every past section does;
  check with `awk '/^## [0-9]/{getline n; print $0, (n==""?"BLANK":"ok")}' CHANGELOG.md`.
- **The date is the day the tag is cut**, not the day the notes were written. If the roll and
  the tag land on different days, fix it before tagging.
- **Bump `version` in `package.json` AND `src-tauri/tauri.conf.json`**, both to match the tag.
  The footer shows the running version; a mismatch there is the first thing a user reports.

```sh
node scripts/changelog.mjs section <x.y.z> | head -3   # read it back
git commit -am "release: <x.y.z>" && git push origin main
```

`changelog check` now fails on `main` — correct, and not a problem. That gate only runs on a
pull request onto `main`, and the first entry of the next release clears it.

## 7. STOP — the tag

Confirm before pushing. The tag is what builds and publishes; nothing before it is public.

```sh
git tag -a v<x.y.z> -m "Episko <x.y.z>

<the lede>"
git push origin v<x.y.z>
```

**`-a -m` is required on this machine**, not a style choice: `tag.gpgsign = true` is set
globally, so a bare `git tag` dies with `fatal: no tag message?`. The repo's older tags are
lightweight because they were cut elsewhere; an annotated, SSH-signed tag triggers
`release.yml` identically (`git tag -v` to verify). Do **not** reach for
`-c tag.gpgsign=false` — never bypass the user's signing config to match an old shape.

## 8. Put main back into dev

```sh
git checkout dev && git merge --ff-only main && git push origin dev
```

**This is not tidying.** The merge leaves `main` with the entries rolled into a version
section and `dev` still holding them under `## Unreleased`, so the *next* dev → main PR
re-proposes all of them and the release after that ships the section twice.

## 9. After the tag

Watch `gh run watch <id> --exit-status` on `release.yml`, then check:

- Both matrix jobs green and **both platforms' assets** on the release. A partial matrix
  leaves a release only some users can install.
- `latest.json` present and listing both platforms, or the in-app updater offers nothing.
- **The updater actually updates** — install the *previous* version and take the update.
  This is the one step that cannot be checked before tagging, and the one whose failure is
  silently permanent for everyone already installed. **Human only.**
- episko.dev: `curl -s https://episko.dev | grep -o 'data-ver>v[0-9.]*'`. Check the **served
  HTML**, not the rendered page — the label the page fetches comes from the releases API at
  runtime, so a stale deploy only shows with JS off. If `site.yml` never fired, the fallback
  is `gh workflow run site.yml -f version=<x.y.z>`.

Do not close a `upstream-contract` issue on the strength of a fix in this release. Wait for
the weekly job to go green; naming the cause wrongly is how the last two were filed.
