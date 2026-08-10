# Releases & the changelog

> Rules and their reasons, compressed. The full narratives live in git history (CLAUDE.md before the split). Trust the code over the docs when they disagree, and fix the doc in the same commit.

`CHANGELOG.md` is the only place release notes are written, with three consumers that must never disagree: the app's *What's new* (`changelog.ts` → `changelogui.ts`), `release.yml` (lifts the tag's section into the release body), and `ci.yml` (refuses a dev→main PR whose `## Unreleased` is empty).

- **The app ships the file** (`?raw` import), never fetches it, so a build can only ever describe itself.
- **The gate is on the PR rather than the tag**, because a failed tag has the ship decision already behind it. `pnpm changelog draft` writes the section through Haiku and **stops** (never commits); the gate checks only non-empty, never that a model wrote it.
- **Three markers, not six headings**: `+` new, `~` changed, `!` fixed.
- **A section with no entries and no lede is dropped at parse time**: `changelog release` opens a fresh empty `## Unreleased`, so every released build ships one; kept, it rendered a "next" row that opened on nothing. The branch policy stays enforced by `changelog.mjs check`, which has its own parser.
- **`inlineMd`'s ordering is load-bearing**: bold runs first and must tolerate a `*` inside it; italic runs *inside* bold's output, anchored on a `*`-free run so `2 * 3` is left alone. It lives in `changelog.ts` rather than the DOM module, so it is tested; where it used to live, the missing italic rule went unnoticed for nine releases. The lede goes through it too.
- **`shouldAnnounce` opens once per released version**; `cc-seen-versions` is a set (the legacy single-value `cc-seen-version` is folded in once); a build with no section (a dev build) is silent.
- **Don't reintroduce the fresh-install guard.** It keyed on the seen-record being absent, which is exactly every install's state on the release that *introduces* the record, which is why 0.13.0 shipped silent. Any "does localStorage look used" rescue is measured wrong (`cc-icons`/`cc-restore` are written during first boot, before `changelogui` imports) and untestable (import-order dependent). The cost of living without it: a first-time user sees their installed version's notes once.
- **The release body is assembled in a workflow step rather than inlined YAML**: a multi-line `${{ }}` in a literal block mangles indentation; the install text lives in `.github/release-install.md` and is concatenated.
- A tag with no matching section still releases (the notes say so); failing after the ship decision just moves the problem.
