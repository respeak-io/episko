# Dependency work

> Rules and their reasons, compressed. Trust the code over the docs when they disagree, and fix the doc in the same commit.

The Dependencies card on the project dashboard, its ⤢ overlay and the agent it dispatches.
Split the usual way: **`deps.ts` pure and tested** (versions, ranges, the verdict, grouping,
the brief), **`depsview.ts`** data → string, **`dashboard.ts`** the pane, the IPC and the
events, **`deps.rs`** the reads. It rides the dashboard's existing `openView` and sheet
machinery rather than growing a second overlay mechanism.

**Every verb here starts an agent. Nothing is merged, dismissed, commented or pinned on
your behalf.** That is the whole feature's shape: Episko assembles the brief a person would
have had to assemble by hand — the advisory, which packages it hit, what your manifest
declares, and this project's own checks — and an agent does the reading and the work. The
one write it makes anywhere is the launch itself.

## Where the facts come from

Four sources, on three different gates, and they do **not** all need GitHub:

- **Dependabot alerts** — `gh api repos/{owner}/{repo}/dependabot/alerts`. GitHub tier only.
- **The bots' pull requests** — one `gh pr list` with `statusCheckRollup`, `mergeable` and
  `mergeStateStatus`, filtered to `dependabot`/`renovate` in Rust (`bot_of`). GitHub tier.
- **What the manifests declare** — read off disk, no process, any tier. This is the half
  that makes a *verdict* possible, and it is why the card is useful on a GitLab remote.
- **What a package manager says is out of date** — `pnpm/npm/yarn outdated`, `cargo
  outdated`, `go list -m -u`, `pip list --outdated`. Any tier, and **only when asked**.

**Renovate's dashboard issue is linked, never reimplemented.** It is already in the board's
own issue list (`renovateDashboard` finds it there for free), its checkboxes are how you ask
Renovate for a PR, and a second control panel that cannot tick them would be worse than a link.

**Code scanning is deliberately absent.** CodeQL findings are about your code, not your
dependencies; putting them in a card called Dependencies would make the word mean nothing.

## The two failures that name nothing unless you name them

- **`gh`'s token has no `security_events` scope**, which is the default. The API answers
  *"You are not authorized to perform this operation"*, which reads like a permissions
  problem with the repo. `classify_deps` turns it into the command that fixes it:
  `gh auth refresh -h github.com -s security_events`. Without that line the feature looks
  broken rather than unconfigured, and the fix is invisible.
- **Dependabot alerts are switched off for the repository**, which answers with its own
  prose and is a *project* setting rather than a token one. Same treatment, different fix.
  Everything else falls through to `github.rs`'s `classify`, including the wrong-account
  case, which this shares because it shares `gh()`.

**A failed alert read does not take the PR list down with it.** They are separate `gh`
calls in one `thread::scope`, and the scope 403 is much commoner than a gh outage — so the
report is `available` whenever *either* half answered, and `enabled: false` is what says the
alert half did not. A board of bot PRs with one explanatory row beats an empty card.

**`dependency-graph/sbom` is not used.** It would give the installed version of everything
in one call, and it 404s on repos with the dependency graph off — measured, on this repo.
A verdict resting on a call that is usually absent is worse than one that says `unknown`.

## The verdict

The one thing Episko computes rather than relays. Three facts it can see — what the manifest
declares, what clears the advisory, and whether we depend on the package directly — become
one word (`Fix` in `deps.ts`):

| | |
| --- | --- |
| `lockfile` | the patched version is **inside** the declared range: no manifest edit at all |
| `manifest` | outside the range, same major: widen it |
| `major` | crosses a major boundary; breaking until somebody reads the changelog |
| `transitive` | nothing declares it; it arrives through a parent |
| `none` | there is no patched version yet |
| `unknown` | not in any manifest we read, or a range shape we do not model |

Four rules hold it up:

- **`satisfies` answers `null` for anything it does not model**, and `null` becomes
  `unknown` rather than either answer. `workspace:^`, `github:me/thing` and a git URL are
  all real manifest entries; a parser that guessed would be wrong silently, on the one
  screen whose whole job is to be trusted. Same rule as ./health's `measured: false`.
- **A bare version means opposite things in two ecosystems.** `serde = "1"` in Cargo.toml is
  `^1`; `"vitest": "1"` in package.json is exactly `1.0.0`. The ecosystem is therefore an
  argument to `satisfies`, and getting it wrong inverts every verdict for one of them.
- **A 0.x minor is a MAJOR bump.** Semver puts breaking changes there below 1.0.0, and the
  word is what a person acts on.
- **`transitive` is a locator, not a cost**, so it is **not** on the group's cost ladder. One
  advisory's transitive package is nearly always fixed by bumping the declared parent listed
  beside it, and pricing the group at "via a parent" hid the actual action — *bump vitest* —
  behind a word that names no verb. It wins a group only when nothing in that group is
  declared at all. Found by rendering the card against this repo's own alerts.

## One advisory is one row

GitHub files an alert **per package**, so this repo's `GHSA-82fw-gwwq-j7x9` arrives twice:
`vitest` (direct) and `@vitest/mocker` (transitive), one fix between them. `groupAdvisories`
keys by GHSA, and the row names the packages. Ungrouped, a board of sixty alerts is mostly
the same advisory said again, and the count at the top of the card means nothing.

An alert with **no** GHSA keys on its own number rather than on `""`, or every one of them
would collapse into a single row claiming to be one advisory.

**Order is severity, then what ships, then likelihood, then age.** EPSS is third and not
first: it moves daily, and a critical is a critical whatever this week's exploitation
probability says. `cvss` is carried and never ranked on — a real alert on this repo has
`severity: medium` with `cvss.score: 0`, so a CVSS sort would file it below everything.

**A bot PR that already covers an advisory is shown on the row** (`prFor`), because
dispatching an agent at work Dependabot has already opened a PR for is the commonest way
this feature could waste a turn. The join is the package name, from the bot's branch and
then its title — and a **grouped** run (`renovate/all-minor-patch`, *Update all non-major
dependencies*) names no package and must not claim one (`NOT_A_PACKAGE`), or a grouped PR
would mark every advisory as handled.

## The one thing on this pane that runs a command

`dep_outdated` spawns the project's own package manager. Everything else on the dashboard
is a read, so this one is fenced:

- **It is never on a load path.** No click on a project runs it; the Out of date tab opens
  empty and says so. `dep_tools` — which manifests exist, which binaries are on PATH — is
  the only part that runs at load, and it probes binaries rather than the project.
- **The manager is chosen by the lockfile, never by taste.** A repo with a `pnpm-lock.yaml`
  is never offered `npm outdated`, which would resolve a tree it does not have.
- **A non-zero exit is data.** `npm outdated` and `pnpm outdated` exit **1** precisely when
  they found something — measured, not assumed. Only a non-zero exit with nothing parsed is
  a failure.
- **A tool that applies and cannot run says why** (`blocked`), greyed with the reason, the
  rule `tasks.rs` already follows: `cargo-outdated` is a separate install, and a row that
  simply vanished would read as "nothing to update here".
- **120s and then killed**, since this resolves against a registry.
- **The answer is kept apart from the reads** (`depRun`/`depScanned`), and a scan that
  outlives the stage is dropped: it was an answer about another folder's lockfile.

## The brief is the product

`advisoryBrief` / `outdatedBrief` / `prBrief`. An agent is only as good as what it was told,
and "fix the dependabot alerts" is not a brief. Each carries the advisory and its packages,
the declared range beside the patched version, the verdict, and then two blocks that are the
reason this beats doing it by hand:

- **Before you change anything** — read the release notes between the installed and the
  target version; treat a major as breaking until the changelog *and* our call sites say
  otherwise; prefer the smallest upgrade that clears it; find a transitive package's parent
  rather than pinning an override; check peers and the toolchain floor.
- **Verify** — this project's **own** commands, from `discoverTasks` (`verifyCommands`,
  test before check before build, never a blocked one, never an id like `npm:test` that
  nobody can type). A project that declares none is told to say how it verified instead,
  rather than being handed a command that does not exist.

**The prompt is SENT, and the sheet is the reading** — the same deliberate exception the
issue dispatch beside it makes, and for the same reason. The whole brief is in an editable
textarea before anything starts, and the sheet carries what was edited rather than a row id,
so re-deriving it on submit cannot discard the edit. Newlines go as `\r` **inside one chunk**
(a paste-newline, never a submit) and the submitting `\r` is a write of its own a beat behind
— ./taskrun's contract, not a new one.

## Selecting rows

Four tables in this app tick rows — Branches, Checkouts, Advisories and Out of date — and
they had **three** answers to "select everything", in two different places, with shift-click
working in exactly one of them. They now share one rule and one pair of controls:

- **`pick.ts` owns the rule** and nothing else does: plain click toggles, shift takes the
  range from the anchor **in the order on screen** and *adds* rather than toggles (a range
  that flipped each row would undo half of itself), and a row shown for its reason is never
  ticked. Each table keeps its own `Pick` — the anchor rides **inside** it, so two tables on
  screen cannot share one by accident, which a module-level `branchLast` could.
- **`pickHead` and `pickButtons` are the controls**, both writing `data-dashpickall` /
  `data-dashpicknone` with a `kind`; one branch in the dispatcher answers all four tables,
  where six attributes used to. The tri-state tick sits in the header's own tick column and
  `All`/`None` in the action bar beside the count and the verb.
- **A row must set `user-select: none`.** Without it a shift-click drags a text selection
  across the table and the next repaint wipes it — a highlight that flashes on and then off,
  which is what "shift-click is broken" actually was. `rangePick` was correct and tested the
  whole time, nothing ever unticked a row, and the interaction was the whole bug. `pickRow`
  also clears a selection anchored *outside* the table, which CSS cannot reach.
- **A range that ticked less than it covered says so.** `anyDeletable` refuses most branches,
  so a shift over ten rows routinely ticks two and leaves the other eight exactly as they
  were — indistinguishable from the range having failed, especially next to a phantom
  highlight that had just covered all ten. `rangeOutcome` counts both halves and `pickRow`
  toasts once, only when something was refused.
- **The header tick reads "all" over the rows it can actually tick**, not over every row: a
  table whose blocked rows can never be ticked would otherwise have a box that never fills.
  Clearing from it drops only what is **shown**, so a tick made under another filter survives
  — the bar still counts it, and silently dropping a row you cannot see would be a lie.

## Easy to get wrong

- **Every `data-dash*` the card and overlay emit must be probed in `dashboard.ts`**, and
  `data-dashdepopen` must be probed **before** `data-dashdep`: the link sits inside the row
  and the row is the tick target, so a row-level probe placed first selects the advisory
  instead of opening it. `dispatch.test.ts` holds both, and now reads **`depsview.ts` as well
  as `dashview.ts`** — the pane's markup outgrew one file and the contract had to follow it
  rather than quietly stop covering what moved out. That test also fails if a *third*
  `*view.ts` starts emitting `data-dash*` without joining the list.
- **The card is absent when it has nothing to say AND nothing that could be asked**
  (`depSilent`) — a repo with a clean board but a `package.json` still gets one, because the
  scan is something it can offer. While the GitHub half is in flight it is a skeleton, which
  may then resolve to absent: that is the same skeleton-to-nothing the other GitHub cards
  already do, and it is why `depSilent` reads the **tools** as well as the tally.
- **Switching GitHub account drops this cache too** (`dep_invalidate`, beside
  `gh_invalidate`) and `reloadDashGh` re-reads both halves. The advisories were answered by
  the identity you have just stopped using, and a board that repaints as the new account
  beside a dependency card still showing the old one is worse than either alone.
- **`depsNow()` is one derivation for the card and the overlay.** Grouping and the verdict
  are the same work; two call sites computing it separately is how two surfaces start
  disagreeing about a count on the same screen.
- **A tick here arms work, not a delete**, so `.dbr .brck.on` overrides the Branches view's
  red with the accent. Same control, opposite meaning, and the colour is the only thing
  saying which.
- **`.lst-hd` sets `grid-template-columns: var(--cols)` later in the stylesheet**, so this
  view's header needs `.lst-hd.dep-hd` to win on specificity; at equal specificity the later
  rule takes it and the header collapses to no columns at all.
- **Manifests are read at the root and one level down, never recursively.** `node_modules`
  and `target` are the common case and a deep walk buys nothing a lockfile does not already
  answer. An *empty* manifest is still returned: it says this ecosystem is present and
  declares nothing directly, which is what turns a transitive alert's verdict from
  `unknown` into `transitive`.
