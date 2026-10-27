# Maintenance

> Rules and their reasons, compressed. Trust the code over the docs when they disagree, and fix the doc in the same commit.

The fleet home stage gets a **Maintenance** view beside **Activity**, and the project dashboard gets **Today | Maintenance** tabs. Both answer one question per project: what is rotting while nobody looks. The answer is spread over seven **facets**, and every facet can be fed by any CI, any security reporter, any update bot or any forge. The whole feature is built so that a new vendor is one manifest row and one Rust read function, and that a vendor nobody has written an adapter for yet says *can't check (Woodpecker)* instead of looking healthy.

## The model

- **Seven facets, fixed and closed**, always in this order: `ci`, `security`, `deps`, `release`, `git`, `prod`, `work`. A card draws all seven in fixed positions, so the eye learns where CI is.
- **A source is one adapter for one facet**: `github-actions`, `gitlab-ci`, `dependabot-alerts`, `renovate-prs`, `git-tags`, `osv`… A facet has any number of sources, and several may apply to one project at once (Dependabot *and* `cargo audit`). A facet cell is the merge of its sources' reports.
- **A marker is a source we can recognise but not read yet** (a `Jenkinsfile`, `.woodpecker.yml`, `.snyk`). It exists so the cell says *can't check (Jenkins)* rather than *no CI*. Promoting a marker to a source is the normal way the feature grows.
- **Rust reads facts; TypeScript decides.** Rust detects what applies, runs the read, normalises the vendor's vocabulary (`MODERATE` → `medium`, `timed_out` → `fail`; that is a fact, and the raw value is kept beside it) and returns a typed coverage. Whether that is *failing 1d*, *drifting* or *needs you*, and in what order cards stand, is `maint.ts`'s. Thresholds are data a team can override, never constants in Rust (the `health.rs`/`health.ts` split).
- **The frontend never names a vendor.** GitHub Actions, GitLab CI and Woodpecker all arrive as `CiRuns`; a cell, a finding and a brief are written against the fact shape. `provider-contract.test.ts`'s rule, one level over: a feature gated on a vendor id is a feature the next vendor silently lacks.

## Coverage: unknown is never green

Every report carries a `Coverage`, and only `ok` carries facts.

| state | means | example |
|---|---|---|
| `ok` | read; facts follow (possibly empty) | 3 workflows, one failing |
| `off` | the feature is switched off on the forge | Dependabot alerts disabled; code scanning "no analysis found" |
| `noAccess` | we could not see it, with a `fix` | token lacks `security_events` → `gh auth refresh -h github.com -s security_events` |
| `noTool` | the CLI it needs is missing or not logged in, with a `fix` | `glab` not installed; `cargo-audit` absent |
| `unsupported` | detected, cannot be answered | no default branch known; GitLab vulnerabilities need Ultimate |
| `notRun` | a click-only source nobody has clicked on this machine | `npm audit`, prod URL check |
| `error` | anything else, the reason verbatim | |

`facetCell` resolves a cell top-down, and **only the last step can draw the grey dot**:

1. `[maintenance] off` names the facet → *not tracked*, muted.
2. Not detected yet, or a read still out → *unread*: `—` / a skeleton, never a dot (`dirtyTag`'s three states).
3. No source and no marker → *none*, phrased per facet: *no CI*, *no update bot*, *no release*, *no deploy*.
4. Markers only → *can't check (X)*, the tip naming what was found.
5. Sources, none `ok` → *can't check*; the tip shows the most useful coverage first: `noAccess`, `noTool` (they carry a fix), then `off`, `error`, `unsupported`, `notRun`.
6. At least one `ok` → the facet rule over the `ok` facts. **`ok` needs positive evidence**: CI with zero runs on the default branch is *never ran*, not a pass (the `prReady` rule); Security is clean only if a security source answered; a bot that is configured but has opened nothing for 30 days is *silent*, not healthy.
7. Partial coverage is stated, never hidden: *Dependabot clean · npm audit never run*. A list that hit its page cap (`truncated`) prints its count as `100+`.

Release and Git counts are as old as the last fetch, and Maintenance never fetches (that is `autofetch.ts`'s job). Their facts carry `fetched_at`, the newest `FETCH_HEAD` mtime of the repo and its worktrees (each checkout writes its own), and the tip says *as of last fetch 3d ago*; past a week it drifts on its own.

## Cost classes: nothing runs until asked

Each source declares one `cost`, and **Rust enforces it**, not a convention at the call site.

| cost | may do | runs in a scan | runs on a click |
|---|---|---|---|
| `local` | read files, read-only `git` through `git_cmd` | yes | yes |
| `forge` | read the forge through the user's own CLI credential (`gh`, `glab`) | yes | yes |
| `public` | send data to a third-party public service (OSV.dev gets package names) | only if this machine opted in | yes, one-off |
| `tool` | execute a program in the project (`npm audit`, `cargo audit`, `trivy`) | **never** | yes |
| `remote` | touch the user's infrastructure (HTTP to `[deploy] urls`, TLS, ssh) | **never** | yes |

`maint_read` takes a `mode` (`scan` or `explicit`) and a `public` flag, and refuses anything its class does not permit with `notRun`; the TS-side `runnable()` is a convenience, not the guard. A `tool` source is the second kind of command Episko runs in your project after `<pm> outdated`, and it follows the same rule: on a click, through `run_capped`, never on a load path (`docs/dependencies.md`).

**A scan is triggered only by a person:**

- **Fleet:** switching to the Maintenance view when the cache is empty or older than `MAINT_FRESH_MS` (10 min), or ⟳ (forced). Landing on Maintenance because `cc-fleet-view` was persisted at boot does **not** scan: the head says *Not checked this session · Check*. `openFleet`, `loadFleet`, `renderFleet` and `buildView` never call into `maintscan`, because `openFleet` runs at boot and on every exit from the stage (`docs/dashboard.md`'s *a fleet-wide sweep is exactly the "nothing runs until you ask" rule*). Choosing the tab is the ask that buys the sweep.
- **Project dashboard:** the first switch to the Maintenance tab per open scans that one project (`loadMaint`, shaped like `loadBranches`).
- **Explicit buttons:** *Run npm audit*, *Check with OSV.dev*, *Check prod*. Each names what runs or what leaves the machine.

A test reads the source of those six functions and fails if any of them reaches a scan.

## Detection

`maint_detect(root)` reads the remote, the files and `.episko/episko.toml`, and spawns nothing beyond the git remote read `project_facts` already does (plus, with no `origin`, the `git remote` listing that finds the primary remote, so the forge and the trunk come from one remote). It is cached per root for 30 s, so `maint_read`'s own applicability check (a stale frontend list must not run a source that no longer applies) does not walk the tree once per source.

- **The forge is decided before files.** `.github/workflows/` means GitHub Actions on github.com and Forgejo Actions on Codeberg; Renovate runs on every forge. Order: the `[maintenance] forge` pin, then a known-host table (`github.com`, `gitlab.com`, `codeberg.org` → forgejo, `bitbucket.org`, `dev.azure.com`/`*.visualstudio.com`), then a host containing `gitlab`/`gitea`/`forgejo`, then `unknown`. No network probe: a self-hosted host that names nothing stays `unknown` until pinned, and the tip says how. `git::split_remote` is already `pub(crate)`; `ssh_hostname` becomes it. The forge's `path` is everything after the host, not two segments: GitLab subgroups are `group/sub/repo`.
- **Files are probed, never executed**: a fixed list of paths at depth ≤ 2 under `SKIP_DIRS`, where a trailing `/` means a non-empty directory and `file#key` means a key inside a JSON file (`package.json#renovate`). The list is the union of the manifest's `detect` entries. An entry holding a `/` or starting with `.` is anchored at the root (GitHub reads `.github/workflows/` there and nowhere else); a bare name (`Jenkinsfile`, `Cargo.lock`) is also looked for one directory down, never inside a dot directory or `SKIP_DIRS`.
- **The git sources detect `.git`**, which is how a folder that is not a repo gets *not a git repository* rather than a Git cell that cannot answer. `[maintenance] off` and `sources` are applied in detection too, so `maint_read` refuses a source the file switched off (`unsupported`, *switched off in .episko/episko.toml*) and an off facet carries no markers.
- **Worktrees collapse to the repo root.** Facts are keyed by `repoRoot ?? path` (as `loadFleet` keys heads); a card is one per project.

## The manifest: `src/maintmanifest.json`

One checked-in file read by both sides, the `providers/manifest.json` precedent: Rust via `include_str!`, TS via `resolveJsonModule`. It sits flat in `src/` because the comment, IPC and sync gates do not recurse.

```jsonc
{
  "sources": {
    "github-actions": { "facet": "ci", "label": "GitHub Actions", "cost": "forge",
                        "forge": ["github"], "detect": [".github/workflows/"],
                        "sees": ["ci.default-branch", "ci.per-workflow", "ci.failing-since"],
                        "blind": ["ci.other-branches"] },
    "git-tags":       { "facet": "release", "label": "git tags", "cost": "local",
                        "forge": [], "detect": [], "sees": ["rel.unreleased", "rel.last"] }
  },
  "markers": [
    { "facet": "ci", "label": "Woodpecker", "detect": [".woodpecker.yml", ".woodpecker.yaml", ".woodpecker/"] }
  ],
  "bots": [
    { "id": "renovate", "logins": ["renovate[bot]", "app/renovate", "renovate-bot"],
      "branch": "renovate/", "dashboard": "Dependency Dashboard",
      "config": ["renovate.json", "renovate.json5", ".github/renovate.json", ".github/renovate.json5",
                 ".gitlab/renovate.json", ".renovaterc", ".renovaterc.json", "package.json#renovate"] }
  ]
}
```

- `facets` lists the seven in card order, each with its label and its *none* phrase (*no CI*, *no update bot*), so both sides phrase step 3 of `facetCell` from one place.
- `forge` restricts a source or a marker to the forges it can talk to; empty means any. An empty `detect` means "applies whenever the forge matches", so a marker needs at least one of the two or it would claim every project. A marker label may hold `{host}` (*CI on {host}*), filled from the remote.
- Rust parses the file with `deny_unknown_fields` and `Manifest::check` refuses it at load (the `providers/manifest.json` precedent): the seven facets in order, source ids equal to `SOURCES`, kebab-case ids, known forge ids, relative `detect` paths, every capability in `MAINT_CAPS`, and a complete `bots` row. A field the manifest does not define (an `argv`) fails the build's tests.
- `sees`/`blind` are a **closed capability vocabulary** (`MAINT_CAPS`). TS's `capsOf()` throws on an unknown one and Rust mirrors the list, the `providerCapabilities` rule: a misspelt capability must fail, not quietly drop a line from the coverage card.
- `bots` is the update-bot table that replaces `deps::bot_of`'s match and its dead TS twin `isBotPr`. `[maintenance] bots` adds logins for self-hosted Renovate; a closed match silently files their PRs on the human Open-work board.
- **Only the compiled-in manifest defines what runs.** No argv, binary or authenticated URL ever comes from `.episko/episko.toml`: a committed table may select, disable and parameterise built-in ids, so a teammate's commit cannot make your Episko run a binary.

## Wire types

Rust, `#[serde(rename_all = "camelCase")]`, tagged enums:

```rust
#[serde(tag = "state")] enum Coverage { Ok, Off { reason }, NoAccess { reason, fix: Option<String> },
    NoTool { tool, fix: Option<String> }, Unsupported { reason }, NotRun, Error { reason } }

struct SourceReport { source: String, facet: Option<Facet>, cost: Option<Cost>, coverage: Coverage, // None: an id the manifest does not know
    at: Option<u64>,      // unix secs the read finished; a cache hit keeps the original
    truncated: bool,      // a list hit its page cap: counts are floors
    gaps: Vec<String>,    // honest partial support: "yarn.lock not read"
    facts: Option<Facts> } // Some only when coverage is Ok

#[serde(tag = "kind")] enum Facts {
    CiRuns     { branch: String, runs: Vec<CiRun> },          // default branch only, newest first, ≤ 50
    Advisories { items: Vec<Advisory> },
    UpdatePrs  { bot: String, configured: bool, prs: Vec<UpdatePr>, dashboard: Option<u64> },
    Release    { trunk: Option<String>, tag: Option<String>, tag_at: Option<u64>, since: u32,
                 oldest_unreleased_at: Option<u64>, tags_seen: u32, fetched_at: Option<u64> },
    Releases   { latest: Option<ForgeRelease>, count: u32 },
    Changelog  { unreleased: Option<u32>, latest: Option<String>, latest_at: Option<u64> }, // None: no Unreleased section
    Hygiene    { trunk: Option<String>, unpushed: Option<u32>, local_only: Vec<String>, merged: Vec<String>,
                 gone: Vec<String>, branches: Vec<BranchAge>, worktrees: Vec<WtAge>, fetched_at: Option<u64> },
    Work       { issues: u32, prs: u32, review_requested: u32 },
    Probes     { items: Vec<Probe> } }

struct CiRun    { workflow, status /* pass|fail|running|cancelled|skip|neutral|unknown */, raw, sha, at, url }
struct Advisory { id, aliases: Vec<String>, kind /* dependency|code|secret|config */, pkg, ecosystem,
                  version, severity /* critical|high|medium|low|unknown */, raw_severity, summary,
                  fixed, location, url, tool }
struct Probe    { name, url, code: Option<u16>, ms: Option<u32>, cert_not_after: Option<u64>, err: Option<String> }
struct UpdatePr { number, title, url, branch, draft, at: Option<u64>, checks: CiStatus }
struct ForgeRelease { tag, name, at: Option<u64>, url: Option<String> }

struct Forge     { kind /* github|gitlab|forgejo|gitea|bitbucket|azure|unknown|none */, host: Option<String>,
                   path: Option<String>, by /* pin|table|name|none */ }   // none: no remote at all
struct Marker    { facet, label, found: Vec<String> }                   // found: the paths that matched
struct Detection { repo_root, forge: Forge, sources: Vec<String>, markers: Vec<Marker>,
                   config: MaintConfig /* incl. readable: bool */, deploy: Option<DeployConfig> /* slice 10 */ }
```

- `Forge.by` says how the kind was decided, so a tip can say *pin it in `[maintenance] forge`* exactly when nothing else could tell. The host stays as the remote spells it: an ssh alias resolves for the decision and is shown as written.
- `Changelog` is its own kind because an *Unreleased* section is neither a tag nor a published release. Its entries are top-level bullets (`-`, `*`, and this repo's `+ ~ !`), with prose and no bullet counting as one.

- **One CI vocabulary.** `maint_ci::norm_status(raw)` is the only map from a vendor's status to `CiRun.status`; `review::normalise_check` and `deps::roll_checks` are rewritten on top of it. Today they disagree on `NEUTRAL`, `CANCELLED` and `STALE`, so the slice that unifies them pins today's outcomes in fixtures first and records every changed verdict in the CHANGELOG.
- **`Advisory.id` is generic** (GHSA, CVE, OSV, RUSTSEC) and `aliases` carries the rest, so `mergeAdvisories` folds Dependabot, OSV and `cargo audit` reporting one CVE into one row at the worst severity.
- **The wire is pinned by a fixture.** `wire_fixture_is_current` (cargo) serialises a fixed report covering every `Coverage` and `Facts` variant and compares it with `test/fixtures/maint-wire.json`; `test/maint.test.ts` reads the same file and asserts `narrowMaint` accepts it and every `state`/`kind` is in the TS unions. Regenerate with `MAINT_WIRE_WRITE=1 cargo test`. A renamed field fails on both sides.
- **`narrowMaint` narrows rather than trusts**: a report of the wrong shape becomes an `error` coverage for that source alone.

## Backend (`src-tauri/src/`, flat files, all `pub(crate)`)

| Module | What |
|---|---|
| `maint.rs` | the wire types; `MANIFEST`; `SOURCES: &[SourceDef]`; `Exec` + `SysExec`; detection and its cache; `[maintenance]` (`MaintConfig`, forgiving, `readable` flag); the cost gate; the `(root, source, account)` report cache; the commands |
| `forge.rs` | `Forge` from a remote; the `glab(root, args)` transport and `classify_glab`, twins of `github::gh`/`classify` |
| `maint_ci.rs` | `norm_status`; `github_actions`, `forge_commit_status`, `gitlab_ci` |
| `maint_sec.rs` | `dependabot_alerts`, `gh_code_scanning`, `gh_secret_scanning`, `sarif_files`, `osv`, the audit tools |
| `maint_repo.rs` | `update_prs` (every bot source of a forge shares one `gh pr list`), `github_releases`, `github_work`, `gitlab_work` |
| `maint_git.rs` | `git_local`, `git_tags`, `changelog`: thin wrappers over git.rs's readers |
| `lockfile.rs` | pure lockfile parsers for OSV (`Cargo.lock`, `package-lock.json` v2/v3, `pnpm-lock.yaml`), reporting a gap for an unrecognised version rather than dropping packages |
| `deploy.rs` | `[deploy]` read/propose/write, `propose_toml` (factored out of `propose_stack`), `http_probe` |
| `git.rs` (+) | `maint_trunk(dir, asked)`, `hygiene(dir, trunk)` and `release_facts(dir, pattern, trunk)`: readers, not commands, because they need git.rs's private `git_cmd`, `remote_default`, `primary_remote` and `list_protected_branches`; `remote_parts` (the whole path after the host, which `split_remote` now builds on) |
| `deps.rs` (refactor) | `alerts_read`/`bot_prs_read` split out with their own caches; `dep_report` keeps composing them and its wire does not change; `coverage_of(err)` beside `classify_deps` |

```rust
struct Ctx<'a> { root: &'a str, cfg: &'a MaintConfig }   // account, forge, det, force join with the first adapter that reads them
struct SourceDef { id: &'static str, read: fn(&Ctx, &dyn Exec) -> Result<Read, Coverage> }
struct Read { facts: Facts, truncated: bool, gaps: Vec<String> }   // a Facts kind outside the source's facet is an `error`

trait Exec: Sync {
    fn gh(&self, root: &str, account: Option<&str>, args: &[&str]) -> Result<String, String>;
    fn glab(&self, root: &str, args: &[&str]) -> Result<String, String>;
    fn tool(&self, root: &str, bin: &str, args: &[&str], secs: u64) -> Result<Output, String>;
    fn http(&self, req: &HttpReq) -> Result<HttpResp, String>;   // absolute curl path
    fn ssh(&self, alias: &str, script: &str, secs: u64) -> Result<Output, String>;
    fn on_path(&self, bin: &str) -> bool;
}
```

- **`Exec` is the only side-effect seam**, in the inline `maint::exec` module. `Output` is maint's own (`code`, `stdout`, `stderr`) so `FakeExec` can build one. Until the first forge adapter calls through it, that module carries the one `dead_code` allow; `SysExec::glab` refuses until `forge::glab` exists, and `ENV_TOKENS` is empty until an adapter needs a token. `SysExec` wraps `github::gh`, `forge::glab`, `deps::run_capped`, `platform::sys_command` + `augmented_path`, and the absolute curl paths `telemetry.rs` already uses (a GUI app's PATH is stripped). Tests use `FakeExec`, which answers argv prefixes from recorded output in `src-tauri/testdata/maint/` and records every call. Local git sources go through git.rs and are tested against `testutil::git` repos instead.
- **`TRUSTED_BINS` per cost class** is enforced inside `SysExec::tool`: `forge` may reach `gh`/`glab`, `tool` the audit binaries, `remote` `curl`/`ssh`. Argv is always an array; a value from data is a whole element and is refused when it starts with `-` or holds whitespace (`ssh_hostname`'s rule).
- **Env tokens go on curl's stdin** (`-H @-`), never in argv, and only names on a fixed allowlist are read. An absent one is `noAccess` *token not visible to Episko*, never *not configured*: a Finder-launched app gets none of `~/.zshrc`'s exports.
- **Reads degrade, writes fail loudly.** `read` never panics into the IPC layer; a failing source never erases another's report (the `dep_report` rule).

**Registry contract tests** (cargo) run over every `SOURCES` row, so a new adapter inherits them:

- manifest source ids == `SOURCES` ids, unique and kebab-case; every facet has a source, a marker or a *none* phrase;
- a `FakeExec` answering `Err`, `""` and `"<html>"` never yields `Coverage::Ok`;
- `read`'s `Facts` kind belongs to the source's facet;
- in `mode: scan`, a counting `FakeExec` records zero calls for every `tool`/`remote` source and for `public` without the flag;
- every call a source makes uses only bins trusted for its cost.

### IPC

| command | args | returns |
|---|---|---|
| `maint_detect` | `root, force` | `Detection`, `#[tauri::command(async)]` |
| `maint_read` | `root, source, mode, public, force, account?` | `SourceReport`; `async` + `spawn_blocking`; an unknown id is `error` |
| `maint_invalidate` | `root` | drops both caches; called beside `gh_invalidate`/`dep_invalidate` on an account switch |
| `deploy_config` | `dir` | `DeployConfig` |
| `propose_deploy` | `dir, prompt` | `Result<DeployProposal, String>` |
| `write_deploy` | `dir, deploy, create` | `Result<(), String>` |

One command per capability, not per source: every `invoke` stays a literal the `ipc.test.ts` parser can read, while the set of sources stays data. Per-source granularity is the point of `maint_read`: one slow `gh` never holds a card, and cells land as they settle.

**Caches.** Rust: reports keyed `(root, source, account)` (the account in the key, so a reader that bypasses an invalidation still cannot serve the other identity's answer); TTL `local` 60 s, `forge` 10 min, `public` 6 h; a `tool`/`remote` result is kept 24 h and shown *as of*. `force` is an explicit refresh only; a repaint never becomes a process.

## Frontend (`src/`, flat)

| Module | Kind | What |
|---|---|---|
| `maintsources.ts` | tested logic | the manifest; `FACETS`, `MAINT_CAPS`, `COSTS`; `sourceDef(id)` (throws on unknown); `runnable(det, prefs, mode)`; `facetSources` |
| `maint.ts` | tested logic | wire mirrors and `narrowMaint`; `MAINT_DEFAULTS` + `clampMaint` (a 0 threshold is refused); `facetCell`; `findings`; `projectBand` (`needs`/`drifting`/`quiet`/`unread`); `rankMaint` (worst first, ending on `path.localeCompare`, so a repaint never reorders); `FACET_TAB`; `mergeAdvisories`; `comingUp`; `hostRows`; the tab row builders |
| `maintbrief.ts` | tested logic | one pure `briefFor` per finding kind, from facts only; advisory and PR briefs delegate to `deps.ts`, whose `advisoryBrief` stops saying *Dependabot* |
| `deploy.ts` | tested logic | `deployPrompt`, `checkDeploy`, `deployText`, `deploySummary` |
| `maintscan.ts` | behaviour | the ONE cache shared by fleet and dashboard (`Map<repoRoot, ProjectMaint>`); `scanProject`, `scanFleet` (at most 6 `maint_read`s in flight, a `maintSeq` guard copied from `loadFleet`), `runSource`; `setMaintRender` (no-op default). Imports state, never fleetui or dashboard |
| `maintview.ts` | markup | strip, card, finding lines, quiet fold, host rows, the five tabs, the dashboard tab's cards, the all-clear; emits **only `data-mt*`** |
| `maintui.ts` | behaviour | `maintClick(t, host): boolean`, the one prober of `data-mt*`, called first by fleetui's and dashboard's listeners; `MaintHost` |

Direction: `maintsources ← maint ← maintbrief` (logic) ← `maintview` ← `maintscan`/`maintui` ← `fleetui`, `dashboard` ← `main.ts`. A cycle check runs after each slice.

**The `data-mt*` contract** is a new `dispatch.test.ts` block: emitted in `maintview.ts` == probed in `maintui.ts` in both directions, nested verbs before their row, `data-mtproj` last, and `maintview.ts` emits neither `data-dash` nor `data-fl`. A maintenance card is never nested inside an `fl*`/`dash*` clickable row, or one click fires both listeners.

**Findings → verbs.** A finding is `{root, facet, key, level, text, verb, source, ref}`. *Fix* (CI, prod), *Patch* (advisory), *Rotate* (secret), *Release*, *Push*, *Tidy* (merged branches) prefill an agent via `host.launch` + `typeInto`, **with no newline** — the two places Episko presses Enter stay two. *Review* on bot PRs opens the existing `deps` overlay; *Run* is a `maint_read` in `explicit` mode, not an agent; *Set up* prefills a brief to add CI or Renovate, or starts `proposeDeploy`.

**Preferences** (`sync.ts` classifies each, `store.ts` reads JSON):

| key | class | holds |
|---|---|---|
| `cc-fleet-view` | pref | `"activity" \| "maint"`, default `activity`: a home stage that reshuffles itself on upgrade is a bug report |
| `cc-maint-chip` | pref | Needs you / Drifting / Quiet / All |
| `cc-maint-prefs` | local | `{public: string[], off: string[]}`: which public sources this machine may call and which sources it skips. It changes what runs, so it never travels |
| `cc-maint` | local | the cold-boot snapshot: per root `{at, cells, ≤12 findings}`, ≤ 200 roots, written once per completed scan, always rendered *as of* and muted, never a live dot. No advisory payloads, no URLs |

## Surfaces

**Fleet.** A `segBtn` pair `data-flview` in `.fl-top` switches the body; both views paint `#fleetHead`/`#fleetBody` through the existing `paint()` guard, and `buildView` reads the `maintscan` cache only. The overview is one card per project (`fleetCards` joined by path for name, accent and group), worst first, seven cells, finding lines under a card with problems, quiet projects folded into one line, chips filtering. The head shows coverage tiles and *checked 4m ago · ⟳*. A cell click sets `maintSub` and `maintFilter` (fleetui module state, **not** a nav field: `Loc {kind:"fleet"}` stays field-less, so the thirteen mirror read sites are not touched) and opens Security / Delivery / Code / Servers / Work filtered to that project (`FACET_TAB`: ci, release → delivery; security, deps → security; git → code; prod → servers; work → work). Escape clears the filter before it leaves the stage. Hosts get rows below the projects, joined many-to-many on `[deploy] host`. The all-clear shows what was covered (the `sees` caps answered and the ones blind) and *coming up* (certificate and EOL dates within 30 days).

**Project dashboard.** A static `#dashTabs` (`data-dashtab`, probed in `dashboard.ts`) and a sibling `#dashMaint`. `.db-cols` is **hidden, never rebuilt**, so a `#dashJot` draft survives. `dashTab` is not persisted and resets to Today on a project switch. `fitLanded` and the `#dashMoved` ResizeObserver are gated on Today (a hidden column measures 0 and collapses Landed); ⌘I fold is disabled on Maintenance; tour steps on `#dashNext` force Today. The tab holds the strip and findings, **Delivery** (CI per workflow, last release, version in prod), **Dependencies** (a new card on `depsNow()` + `depTally` + `depSilent`, whose ⤢ opens the existing `deps` overlay; the queue's advisory and bot-PR rows stay in Today), **Runs on**, **Git hygiene** (⤢ opens Branches) and **Coverage**. A cell click scrolls to its card; each card links *across projects* to the fleet tab. Every loader guards `root() !== r` and clears its own flag inside the guard.

## `[deploy]` and `[maintenance]`

```toml
[deploy]                                  # committed; proposed by an agent, written only after Apply
host = "prod-1"                           # an ssh alias; nothing connects until a click
compose = ["api", "worker"]
urls = { app = "https://app.example.com", api = "https://api.example.com/health" }
sentry = "acme/api"                       # org/project; the token is never in the file
version_url = "https://api.example.com/version"

[maintenance]                             # optional; absent = detect everything
forge = "gitlab"                          # for a self-hosted host whose name says nothing
off = ["prod", "github-secret-scanning"]  # a facet ("not tracked") or a source id
sources = { ci = ["woodpecker"] }         # restrict a facet to these ids; detection must still agree
bots = ["acme-renovate"]                  # self-hosted update-bot logins
trunk = "dev"
tag_pattern = "v*"                        # glob_match; which tags are releases
sarif = ["reports/*.sarif"]
[maintenance.params]                      # values a built-in source needs; a URL must be http(s)
woodpecker_server = "https://ci.example.com"
[maintenance.thresholds]                  # raw data; clampMaint applies them over the defaults
ci_failing_hours = 24
unreleased_commits = 30
unreleased_days = 21
stale_branch_days = 30
cert_warn_days = 21
```

- Read forgivingly, by every owner's own `RawFile` that ignores other tables. A file that exists and does not parse is `readable: false`, and the tips say *episko.toml unreadable* rather than quietly applying defaults (`ProtectList.readable`'s rule).
- `[deploy]` is written only by `write_deploy`: `toml_edit` read-modify-write, tmp file then rename, no write when unchanged (the file is committed and churn lands in a diff), the table removed when empty, `create` gating a new file. It is reached from the Apply dialog after `propose_deploy` (the restricted headless agent `propose_stack` uses, through the shared `propose_toml`; `checkDeploy` refuses non-http URLs, a `-`-leading alias and a bad `org/project`), or by hand through *Open file*. `[maintenance]` has no writer in v1.
- A round-trip test writes `[deploy]` and `[maintenance]` into a file holding every other table and runs `parse_stack`, `parse_protect`, `parse_allow` and `parse_health_policy` over it.
- Config lives in git and never in sync: it changes what runs (`docs/stack.md`).

## Adding an adapter

1. Add a row to `src/maintmanifest.json` (facet, label, cost, forge, detect, sees, blind); if it was a marker, delete the marker.
2. Write `read_x(ctx, ex) -> Result<Read, Coverage>` in the facet's `maint_*.rs`, using only `Exec`. Map stderr to a coverage with a `fix` when one exists. A non-zero exit from an audit tool is data (`run_capped`'s rule).
3. Add the `SourceDef` row. A new binary goes into `TRUSTED_BINS` under its cost class, and a new `tool` binary is a design review item.
4. Record a real output in `src-tauri/testdata/maint/` and test the parser and `read` over `FakeExec`. The registry contract tests apply on their own.
5. Only if the facts fit no existing `Facts` kind: add the variant on both sides, regenerate the wire fixture, teach `facetCell`/`findings`, test it. Otherwise nothing changes in TypeScript.
6. A new capability goes into `MAINT_CAPS` and its Rust mirror; a new env token onto the allowlist.
7. Add a row to the adapter table below: what it reads, its cost, its credential, what leaves the machine.

## Adapters in v1

| id | facet | cost | reads |
|---|---|---|---|
| `git-local` | git | local | unpushed commits on any branch (`rev-list --count --branches --not --remotes`; `None` with no remote, since nowhere to push is not "all unpushed"), local-only and gone branches, merged into trunk minus trunk/default/protected and any branch checked out in a worktree (a fresh session's branch is "merged"), branch and worktree ages (worktree `logs/HEAD` mtimes, no spawn). No trunk, or an unreadable `episko.toml`, is a gap (*merged branches not read*), not the cell |
| `git-tags` | release | local | the nearest tag by ancestry from trunk matching `tag_pattern` (`for-each-ref --merged` + `describe`, since `--simplify-by-decoration` drops a tagged root), commits since, the oldest unreleased commit; no tags → `tag: None`, never "0 unreleased"; no trunk → `unsupported` |
| `changelog` | release | local | an *Unreleased* section in the root's `CHANGELOG.md` (detected as `./CHANGELOG.md`, so a package's own is not it): its entry count and the newest released heading and date (`Changelog` facts) |
| `github-actions` | ci | forge | `gh run list --branch <default>`, newest per workflow, `failing since` from consecutive failures, disabled workflows from `gh workflow list --all` |
| `forge-commit-status` | ci | forge | commit status + check-runs on the trunk head: every CI that reports back to GitHub (CircleCI, Woodpecker, Jenkins, Azure, Buildkite) with no credential of its own |
| `gitlab-ci` | ci | forge | `glab api projects/:fullpath/pipelines?ref=<default>` |
| `dependabot-alerts` | security | forge | the alert half of `dep_report`, now with typed `noAccess`/`off` |
| `github-code-scanning`, `github-secret-scanning` | security | forge | the alert endpoints; *no analysis found* → `off`, GHAS 403 → `unsupported` |
| `sarif-files` | security | local | SARIF 2.1.0 files named by `[maintenance] sarif`: semgrep, CodeQL, gitleaks, Trivy and Snyk Code plug in with no adapter of their own |
| `osv` | security | public | lockfiles → OSV.dev querybatch → details by id (cached by id + `modified`, capped) |
| `npm-audit`, `pnpm-audit`, `cargo-audit` | security | tool | the tool's JSON; a missing `cargo-audit` is `noTool` with its install command |
| `dependabot-prs`, `renovate-prs` | deps | forge | one shared `gh pr list` filtered by the `bots` table; config files give *configured, silent* |
| `github-releases` | release | forge | `gh release list`: the last published release, beside `git-tags`' unreleased count |
| `github-work`, `gitlab-work` | work | forge | real totals (GraphQL `totalCount`, `issues_statistics`), not `gh_threads`' floor of 60 |
| `http-probe` | prod | remote | `[deploy] urls` and `version_url` through curl `-w %{json}` and `%{certs}`; a curl that cannot print the certificate leaves cert *unknown*, never fine |

Built: `git-local`, `git-tags`, `changelog` (slice 1). Every other row is a marker in `src/maintmanifest.json` until its slice promotes it. `forge-commit-status`, `sarif-files` and `http-probe` have none: a marker with no file to find would claim CI on every GitHub repo, so step 3's *no CI* could never be drawn, and the other two read what config names rather than what is on disk.

The trunk is `[maintenance] trunk` when it resolves to a commit (a typo is reported, never replaced by `main`), else the primary remote's default branch (origin, else the first remote; the forge is read from the same one). There is no local guess: a repo with no remote and no pinned trunk gets the tip *set [maintenance] trunk*.

Markers in v1: Woodpecker, CircleCI, Azure Pipelines, Jenkins, Forgejo/Gitea Actions, Bitbucket Pipelines, Drone, Snyk, Depfu, Mend, and *CI on <host>* for workflows on an `unknown` forge. Later, behind the same shape: ssh host facts (one `ssh -o BatchMode=yes` round trip per host), Sentry, GitLab MRs for Renovate, Gitea/Forgejo via token, pip-audit, osv-scanner, trivy, grype, snyk, govulncheck, endoflife.date.

## Slices

Each slice is one commit that leaves `pnpm build`, `pnpm test`, `cargo test` and `cargo clippy --all-targets -- -D warnings` green on both OSes, updates `CLAUDE.md`'s module tables and counts for what it adds, and adds this doc's rows for what it builds. A source not built yet is a marker, never a manifest source without a read function.

1. **Rust core and local sources.** `maintmanifest.json` (local sources, every other adapter as a marker, the `bots` table); `maint.rs` (types, `Exec`/`SysExec`/`FakeExec`, detection + cache, `[maintenance]`, the cost gate, the report cache, `maint_detect`/`maint_read`/`maint_invalidate` registered); `forge.rs`; git.rs `hygiene`/`release_facts`; `maint_git.rs`; `test/fixtures/maint-wire.json` with `wire_fixture_is_current`. No frontend calls it yet.
2. **TS pure core.** `maintsources.ts`, `maint.ts`, `maintbrief.ts` and their suites: the cell ladder over every coverage state, `rankMaint` stability, findings → verbs, `narrowMaint` over the wire fixture, and a source-reading test holding manifest ids to `SOURCES` and `MAINT_CAPS` to the Rust mirror.
3. **Fleet Maintenance overview.** `maintscan.ts`, `maintview.ts`, `maintui.ts`; the `data-flview` switch; the scan triggers and the test that `openFleet`/`loadFleet`/`renderFleet`/`buildView` never scan; `FleetHost.prefill` and `openDashboard(…, tab?)`; `actions.ts` calls `maint_invalidate` on an account switch; `sync.ts` keys; the `data-mt*` dispatch block; styles; `docs/dashboard.md`'s fleet rule restated. It ships honest Git and Release cells on every forge and *can't check (X)* everywhere else.
4. **One CI vocabulary and GitHub CI.** `norm_status`, with `roll_checks` and `normalise_check` on top of it (today's outcomes pinned first); `github-actions` and `forge-commit-status` promoted.
5. **Dependencies split.** `deps.rs` `alerts_read`/`bot_prs_read`/`coverage_of`, `bot_of` from the `bots` table, `dep_report`'s wire unchanged; `dependabot-alerts`, `dependabot-prs`, `renovate-prs`; `isBotPr` deleted, `advisoryBrief` source-neutral; `docs/dependencies.md` updated.
6. **The rest of GitHub.** `github-code-scanning`, `github-secret-scanning`, `sarif-files`, `github-releases`, `github-work`; `mergeAdvisories` over every reporter.
7. **Cross-project facet tabs.** Security / Delivery / Code / Servers / Work with the project filter, Escape stepping out of the filter, verbs on every row.
8. **Project dashboard tab.** `#dashTabs`/`#dashMaint`, `loadMaint`, the Delivery, Dependencies, Git hygiene and Coverage cards, the Landed/⌘I/tour gates; the stale Dependencies-card text in `docs/dashboard.md` and `docs/dependencies.md` fixed.
9. **GitLab.** `forge::glab` and `classify_glab` (`glab auth login --hostname <h>` as the fix); `gitlab-ci`, `gitlab-work` promoted.
10. **`[deploy]`.** `deploy.rs` (`deploy_config`, `propose_toml` shared with `propose_stack`, `propose_deploy`, `write_deploy`), `deploy.ts`, `proposeDeploy` in actions.ts, the project settings row, the Runs-on card, the round-trip test; `docs/stack.md` cross-reference.
11. **Prod.** `http-probe` (remote, explicit), *Check prod* on the project tab and the fleet head, host rows, `comingUp` from certificate dates.
12. **Explicit and public reporters.** `lockfile.rs`, `osv` with the per-machine opt-in and its disclosure sentence, `npm-audit`/`pnpm-audit`/`cargo-audit`; `CLAUDE.md`'s "the one command this app runs in your project" sentence rewritten to the cost-class rule in the same commit.
13. **Cold boot and Today.** The `cc-maint` snapshot; a failing default-branch CI as a `QueueInput` finding in Today's queue, ranked and chipped in `queue.ts` with tests.
