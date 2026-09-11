# Environments (`env.rs`, `envs.ts`, `envui.ts`, `envdlg.ts`)

Which `.env` a checkout is pointed at, and one click to point it somewhere else. The idea is
[EcksDy's env-switcher](https://marketplace.visualstudio.com/items?itemName=EcksDy.env-switcher)
for VS Code: presets discovered by pattern, the target file swapped to whichever you pick, and
a status-bar item that goes red when the preset's name matches a regex.

Two things make it worth more here than in an editor. A worktree is its own checkout with its
own `.env`, so the answer differs **per pane** rather than per window. And the process reading
that file is usually an agent running unattended — *is this fleet on production?* is a question
the app should answer before anyone thinks to ask it.

**It ships off.** It reads files in every open checkout and puts a chip in the header, and
nobody installed Episko for this; Settings › Diagnostics ships the same way and for the same
reason. Settings › Environments is the switch.

## The file is the state

The extension remembers which preset you picked. Episko remembers nothing: **the active preset
is whichever one the target's content matches**. Nothing to persist, nothing to go stale, and it
stays right when you edit `.env` in another editor, switch worktrees, or an agent rewrites it
mid-turn. Comparison is on content normalised for line endings and trailing blank lines — a CRLF
round-trip by somebody else's editor must not read as "a person hand-wrote this".

| the target is… | `state` | the chip | switching |
| --- | --- | --- | --- |
| equal to a preset | `preset` | that preset's label and tone | silent |
| absent | `missing` | `no .env` | silent |
| equal to no preset | `modified` | `modified`, amber | **asks**, and offers the backup |

That last row is the only one worth stopping for, and it is the whole of the safety story: the
content exists nowhere else, so overwriting it destroys it. The confirm offers `<target>.bak`,
and the picker carries *Save as a preset* so the warning has an answer rather than just a tone
of voice. Every other switch is silent, because being silent is the feature.

## A checkout has as many environments as it has targets

One `.env` at the root is the one-element case, not the model. A monorepo has one per package,
and `EnvScan` is therefore a **list of groups** — each a target, its state, and the presets
found *beside that target*:

```toml
# .episko/episko.toml — committed, so "PROD is red" is the team's fact, like [branches] protect
[env]
targets = [".env", "*/.env", "apps/*/.env"]   # the default already covers these three
presets = [".env.*", "*.env", "envs/*", "env/*"]
ignore  = [".env.local", "*.example", "*.sample", "*.template", "*.bak"]

[[env.tag]]
match = "prod|live"     # JS RegExp source, always matched without regard to case
tone  = "danger"        # danger | warn | safe | none
label = "PRODUCTION"    # optional; replaces the name on the chip
```

A **target pattern's directory segment may hold a `*`**, and that is the only thing here that
reads a directory to find its children — capped at `MAX_TARGET_DIRS`, never descending into a
dot-directory or one of `SKIP_DIRS`, so `apps/*/.env` cannot turn into a crawl. The default
covers the root, `*/` and the nested `apps|packages|services/*`; any other layout is one line.

`*/.env` is the one that earns its keep. `frontend/` beside `backend/` — or `01_frontend/`
beside `02_backend/` — is the commonest monorepo shape there is, and without it every such repo
reported only what sits beside its root `.env`, which is usually nothing. It is affordable
because **a directory is read once however many preset patterns name it** (`collect_presets`):
`.env.*` and `*.env` are the same listing, and with a wildcard target that listing happens per
candidate directory.

A wildcard target must **never adopt a directory the preset patterns reserve** (`envs/*` →
`envs`). That is where a project keeps its presets, not a package with an environment of its
own, and adopting it listed `envs/staging.env` under two headings at once — the root's and a
phantom `envs/.env`'s. Found the moment `*/.env` became a default, by a test rather than by a
user; `preset_dirs` is the guard.

**Preset patterns resolve beside their own target**, so `.env.*` finds `apps/web/.env.prod` for
`apps/web/.env` with nothing spelled out, and `apps/web` never offers `apps/api`'s presets.

A candidate with **neither a target nor a preset is not an environment** and produces no group —
which is what keeps the feature invisible in a project that does not work this way. A candidate
with presets and no target *is* one: "no `.env` yet, pick one" is exactly what the picker is for.

Matching a filename reuses **`git.rs`'s `glob_match`**: a filename holds no `/`, so that
matcher's deliberate "`*` crosses a slash" (for `release/*`) cannot arise, and one matcher beats
two that nearly agree.

`git ls-files` is deliberately **not** the source, the way `files.rs` and `health.rs` use it:
`.env*` is gitignored in nearly every project, so the index behind the explorer cannot see these
files at all.

## The backend answers facts; the frontend owns the rules

`health.rs`'s division, and for the same two reasons: "dangerous" is a judgement rather than a
measurement, and a user-typed regex belongs in the engine that cannot take the app down with it.
So `env.rs` reports which files exist, how many assignments each holds, and which one each
target matches — and never compiles a pattern.

`envRegex` compiles case-insensitively always (nobody spells PROD one way), caps the source
length, caches by source because the dialog recompiles the whole table on every keystroke, and
answers `null` rather than throwing. A rule that will not compile is **skipped**, never allowed
to swallow the rules below it.

**The first rule that matches wins**, which is why `ENV_DEFAULT_TAGS` is ordered and why
`preprod` is asked before `prod` — the broad rule would otherwise call a pre-production
environment production.

## Nothing watches the filesystem

Keeping docs/explorer.md's rule. Four signals cover every way the answer changes:

1. arriving at a checkout nothing has read — `renderEnvs` kicks one, using the due map as its
   "asked" mark so a scan that fails is not re-kicked by every paint,
2. a switch completing,
3. a 20-second tick, on `tickAutoFetch`'s cadence and for its reason: a read nobody is looking
   at is not worth doing sooner,
4. **an agent writing a target or a preset** — `touchPath`/`touchTool` are the Context card's
   own readers, so a script that rewrites `.env` mid-turn is noticed for free and there is no
   second parser of a tool payload.

The scanned set is the stage's checkout plus every live pane's, so it is bounded by the panes
that are open rather than by the projects you have. Results live in `envByDir`, read by the
render path and written only by the poll — the shape `dirtyByFolder` and `fetchedByRepo` use.

## Four surfaces, one picker

The chip is drawn in the stage header (Settings › Environments), the status bar (Settings ›
Status bar, a normal `FOOT_SEGS` entry), the project dashboard's aside column, and — when a rule
calls it dangerous — on every sidebar row for a pane in that checkout. All of them open
`#envPop`, whose markup is `footerview.ts`'s `envPopHtml` so Settings can preview it with the
real renderer, the way the other footer popovers do.

**With several environments the chip speaks for the worst of them and counts the rest**
(`prod +2`), listing every one in its tooltip; a count with nothing behind it is not an answer.
An environment **no rule claims outranks one called safe**, because unaccounted-for is worth
more of your attention than known-harmless. The picker and the card then draw one section per
environment, headed by the target — and draw no header at all when there is only one, or two
identical lists of *prod / dev* sit under nothing that tells them apart.

The **sidebar mark is danger only**. A mark on every checkout that has a `.env` teaches you to
stop looking at that column — the same rule that keeps `.unwrap()` out of ./health.

## Why the badge is not the reactor

A flagged checkout raises **`#envBadge`**, its own badge in the family of `#telBadge` and
`#svrBadge`, sitting left of the servers badge because the ground the fleet is standing on
outranks what is still up.

It is deliberately **not** folded into `#attnBadge`. That badge is `attnPending`, which means *a
session is waiting on you*, and `needsYou`/`syncAttn` are the single answer to that question
(CLAUDE.md's needs-you rule). "You are pointed at production" is a standing condition like the
telemetry server being down — nothing is waiting, and nothing you do to a pane clears it.

The sound (`envDanger`) fires on a checkout **becoming** flagged, your own click included:
hearing it when you deliberately switch to production is the point. It does **not** fire on
first sight of a checkout, or every pane would chime at startup and say nothing. Priority 2, not
3 — a blocking permission stays the most urgent thing there is, and `test/sound.test.ts` holds
that.

## The rules are the project's, so a dialog writes them there

There is no project settings page in this app, on purpose: per-project choices live in the
project's context menu (*Agent ·*, *GitHub ·*), and committed project config lives in
`.episko/episko.toml` — `[health]`'s thresholds and a pattern-protected branch both say *edit
the file to change it*. Rules about what this project calls production are the same kind of
fact, and putting their editor in Settings would make a global page do project work.

So **`envdlg.ts` is the editor**, opened from the picker's ↗ — the one place that already means
*the panel that answers in full* (`usagedlg` is the precedent, and `"usage"` was the one
non-Settings quick open). It has two scopes and says at the top which one it is in:

- **a project** — seeded from whatever is in force there, saved into `.episko/episko.toml`.
- **Episko's fallback** — opened from Settings › Environments, saved to `cc-env`, and used by
  every project that never writes a table.

One editor, two backing stores, so there is no second rules table to keep in step.

It is a **draft with a Save**, not a live commit: the project half writes a committed file, and
that is a deliberate act rather than something a keystroke does. Creating that file asks first
(`notes.rs`'s `create` gate, one level up), replacing an existing `[env]` table asks in the
sharper wording, and *Remove from the project* takes the table back out while leaving the rest
of the file alone.

Inside the dialog, three rules hold:

- A rule commits to the draft live but repaints **only the preview**, because rebuilding the
  dialog would replace the `<input>` being typed into (`applyTitleExtra`'s rule, one dialog over).
- An **empty pattern is held back rather than committed**: `clampEnvPrefs` drops a rule with no
  pattern, which would take the row out from under the caret mid-edit. Only the pattern field
  toggles the row's invalid mark — a keystroke in the label beside it must not clear it.
- **Tones are live; the file list is not.** Which files are found is a disk read, so the preview
  re-reads on Save. In the fallback scope there is no file list at all: it previews the rules
  against a handful of *names*, because rules shown against a project you are not editing was
  the muddle this dialog exists to end.

Settings › Environments keeps only what is genuinely this machine's: the master switch, the
stage-header chip, and a door to the fallback rules.
