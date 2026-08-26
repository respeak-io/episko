# Signing Episko

Three independent "signings" — do **not** conflate them:

1. **Updater signing (minisign)** — `TAURI_SIGNING_PRIVATE_KEY`. Signs the auto-update
   artifacts so an installed app trusts the update it downloads. The public key is baked
   into `tauri.conf.json`; the matching private key lives in CI secrets. **Not** Azure,
   **not** from Tim. This is the thing that blocks a **local** `tauri build` (because
   `createUpdaterArtifacts: true`) — see *Local build* below.

2. **Windows code-signing (Azure Trusted Signing)** — the Respeak GmbH Azure profile.
   Removes the SmartScreen "Unbekannter Herausgeber" warning. Reuses the **same account +
   certificate profile already set up for pii-reduction (Schwärzwerk)** — see
   `pii-reduction/installer/SIGNING.md`. Values come from Tim. **Windows only.**

3. **macOS code-signing + notarization (Apple Developer ID)** — a **separate** Apple
   account (~99 $/yr). The Azure profile **cannot** sign macOS binaries. Notarization sits
   **on top of** Developer ID signing (Apple malware-scan + a stapled ticket); it does not
   replace signing. **Configured** — see *macOS* below. A local `tauri build` still produces
   an ad-hoc bundle, because the identity lives in an overlay CI merges rather than in
   `tauri.conf.json`.

## Windows — activate Azure Trusted Signing

The signing coordinates are already wired: the **account** (`Respeak`), **profile**
(`RespeakPublicTrust`), and **endpoint** (`https://weu.codesigning.azure.net`) live in
`src-tauri/tauri.signing.conf.json`; the subscription id plus the values for the SP setup
are in the **git-ignored** `src-tauri/.env.signing` (never committed — copy it from a
colleague / the password manager).

What's still needed (identical to `pii-reduction/installer/SIGNING.md`):

- A **service principal** (App Registration) holding the built-in role **"Artifact Signing
  Certificate Profile Signer"**, scoped to the account or profile. Creating the profile is
  not enough — without this role signing returns **403**. It yields `AZURE_TENANT_ID` /
  `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`, which become GitHub repo secrets.

### Create the service principal (least-privilege, one-time)

Run as an Azure user who can create app registrations and assign roles on the signing
account. The SP gets exactly **one role** on exactly the signing account — no
subscription-wide access, nothing else in the tenant.

```bash
# Load the real coordinates from the git-ignored env file (subscription, RG, account):
set -a; . src-tauri/.env.signing; set +a

az login
az account set --subscription "$AZURE_SUBSCRIPTION_ID"

# Scope = the Trusted Signing ACCOUNT (holds the Respeak GmbH profile that already signs
# Schwärzwerk — one profile signs both products, so one SP covers both).
SCOPE=$(az resource show -g "$AZURE_RESOURCE_GROUP" -n "$TRUSTED_SIGNING_ACCOUNT" \
  --resource-type "Microsoft.CodeSigning/codeSigningAccounts" --query id -o tsv)

# Create the SP AND assign only the signer role at that scope, in one shot.
az ad sp create-for-rbac \
  --name "episko-ci-signer" \
  --role "Artifact Signing Certificate Profile Signer" \
  --scopes "$SCOPE"
```

The one-time output maps to the three GitHub secrets:

| `az` output | GitHub repo secret |
| --- | --- |
| `appId`    | `AZURE_CLIENT_ID` |
| `tenant`   | `AZURE_TENANT_ID` |
| `password` | `AZURE_CLIENT_SECRET` |

```bash
gh secret set AZURE_CLIENT_ID     --body "<appId>"
gh secret set AZURE_TENANT_ID     --body "<tenant>"
gh secret set AZURE_CLIENT_SECRET --body "<password>"
```

Notes:
- **Tightest scope** (profile, not account): grab the certificate profile's *Resource ID*
  from the portal (profile → JSON/Properties) and pass it as `$SCOPE` instead.
- The role is **"Artifact Signing Certificate Profile Signer"** — Azure renamed "Trusted
  Signing" → "Artifact Signing", so the old `Trusted Signing …` name no longer resolves.
  If in doubt, list the current names:
  `az role definition list --query "[?contains(roleName,'Signing')].{role:roleName,id:name}" -o table`.
- `create-for-rbac`'s secret defaults to a **1-year expiry** → rotate before it lapses
  (`az ad app credential reset --id <appId>`), or drop the stored secret entirely with
  **GitHub OIDC**: `az ad app federated-credential create` for the repo + `azure/login@v2`
  federated auth, which `DefaultAzureCredential` picks up automatically.

Then:

1. `tauri.signing.conf.json` already carries the account / profile / endpoint — nothing to fill.
2. Add `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` as GitHub **repo
   secrets** (from the `create-for-rbac` output above).
3. Done. `release.yml` auto-detects `AZURE_CLIENT_ID`: when present it installs the signing
   CLI and merges `tauri.signing.conf.json` via `--config`, so tauri-action signs the app
   `.exe`, the NSIS setup, and the `.msi`. Until that secret exists, releases build
   **unsigned exactly as before** — nothing else has to change.

Tool: `signCommand` calls `trusted-signing-cli` (`cargo install trusted-signing-cli`).
Tauri's docs may refer to the equivalent as `artifact-signing-cli` — verify the exact
binary name / install at setup and adjust `tauri.signing.conf.json` + the install step in
`release.yml` if needed. It reads the `AZURE_*` env for auth and signs each artifact (`%1`)
with a mandatory RFC3161 timestamp (Trusted Signing certs are valid only ~3 days; the
timestamp keeps the signature valid permanently). Alternative, if the CLI is fussy:
Microsoft's `signtool` + `Azure.CodeSigning.Dlib.dll` + a `metadata.json`, exactly the way
`pii-reduction/build_exe.ps1` does it.

> The CI wiring is inert until the Azure secret exists, so it can't be verified until then —
> confirm on the first real signed tag that the `--config` overlay is picked up and
> `signtool verify` / the CLI reports success.

After signing works, drop the "isn't code-signed / SmartScreen may warn" line from the
Windows section of `releaseBody` in `release.yml`.

## macOS — Apple Developer ID

Team **Q9P3NQ4858** (Respeak GmbH), identity `Developer ID Application: Respeak GmbH
(Q9P3NQ4858)`, committed in `src-tauri/tauri.macos.signing.conf.json` and merged by
`release.yml` via `--config` only when `APPLE_CERTIFICATE` exists. `tauri.conf.json` keeps
`signingIdentity: "-"`, so a local build needs no certificate and nothing changes for a
contributor who has none.

### Why this is not cosmetic

Gatekeeper is the visible half. The half that actually drove the work is **TCC**: macOS keys
a folder-access grant to the app's *designated requirement*, and an ad-hoc bundle has no
stable one — `codesign -d -r-` printed `designated => cdhash H"…"`, the hash of that exact
binary. Every release therefore looked like a brand-new app and re-asked for Documents,
Desktop, Downloads and the microphone. At roughly a release every other day that is a prompt
storm, and no amount of clicking Allow ever stuck. Signed, the requirement reads

    identifier "io.respeak.episko" and anchor apple generic
      and certificate leaf[subject.OU] = Q9P3NQ4858

which is stable across every rebuild, and across a certificate renewal within the same team.
**After the first signed release each machine needs one reset**, since the old cdhash rows
match nothing:

```sh
for s in SystemPolicyDocumentsFolder SystemPolicyDesktopFolder \
         SystemPolicyDownloadsFolder Microphone; do
  tccutil reset $s io.respeak.episko
done
```

### The five repo secrets

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the Developer ID `.p12` (cert **and** private key) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_API_ISSUER` | App Store Connect issuer id (UUID) |
| `APPLE_API_KEY` | App Store Connect key id |
| `APPLE_API_KEY_P8` | base64 of the `.p8` private key |

There is deliberately **no `APPLE_SIGNING_IDENTITY`**: the identity is not a secret and lives
in the committed overlay, the same way the Azure account/profile do. Notarization uses an App
Store Connect **Team Key** (needs all three of issuer/key-id/`.p8`) rather than an Apple ID +
app-specific password, so it is not tied to one person's Apple ID. The Apple ID route still
works if the key is ever unavailable — `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` — but
then only that person can release.

`notarytool` wants the key as a **file**, so `release.yml` decodes `APPLE_API_KEY_P8` into
`$RUNNER_TEMP` and exports `APPLE_API_KEY_PATH`.

### The DMG is a second notarization, and tauri-action does not do it

The bundler notarizes and staples the `.app`, then builds the `.dmg` **from** that stapled
app and signs it — and stops. But the `.dmg` is what a user downloads, so it is the file that
carries the quarantine flag, and an unnotarized disk image still raises *"Apple could not
verify this app is free of malware"* on first open. That is the entire friction signing
exists to remove, so `release.yml` submits the `.dmg` separately, staples it, and re-uploads
it over the copy tauri-action already pushed (`gh release upload --clobber`).

Check a disk image with the **disk-image** assessment, not the installer one:

```sh
spctl -a -t open --context context:primary-signature -vv <dmg>   # accepted
spctl -a -t install -vv <dmg>                                    # MISLEADING on a .dmg
```

The updater's `.app.tar.gz` needs nothing extra: the ticket is a plain file at
`Contents/CodeResources`, written before the tarball is built, and tar preserves it.

### Verifying a build

```sh
codesign -dv --verbose=4 <app>   # TeamIdentifier=Q9P3NQ4858, flags=…(runtime), no `adhoc`
codesign -d -r- <app>            # team-anchored DR, and NO cdhash
spctl -a -vvv <app>              # accepted, source=Notarized Developer ID
xcrun stapler validate <app>
```

`codesign -d -r-` is the one that matters. If a `cdhash` is still in the designated
requirement, signing silently fell back to ad-hoc and nothing downstream is worth checking.

### The certificate itself

Created manually (Keychain Access CSR → developer.apple.com → **Developer ID Application** →
**G2 Sub-CA**; "Previous Sub-CA" is for toolchains older than Xcode 11.4.1). Required role is
**Account Holder** — an Admin cannot create one this way, only a cloud-managed variant.

Two facts worth keeping in view. A team gets **five** Developer ID Application certificates
ever, valid five years; you burn slots by re-issuing on each machine rather than importing
the `.p12`. And the `.cer` Apple hands back is only the public half — the signing capability
is the private key generated locally by the CSR, so **a lost private key is a lost
certificate**, not something re-downloadable.

One certificate covers the whole team, every product. Schwärzwerk on macOS would reuse this
one; it is Windows signing that is separate (#2 above).

### Where the material lives

The KeePassXC vault, under `Respeak/Signing`: `Developer ID Application (Respeak)` with the
`.p12` attached and its export password, `Apple notarization (Episko)` with the `.p8`
attached plus key id / issuer id, and `Tauri updater key (Episko)` with `muster.key`. That
last one is the irreplaceable one — its public half is compiled into `tauri.conf.json`, so
losing it means no installed copy of Episko can ever update again. Pull material out with
`keepassxc-cli attachment-export` rather than keeping loose copies on disk.

## Local build (no Azure / Tim values needed)

The only blocker for a local `tauri build` is the updater key (#1). Generate a throwaway one:

```powershell
pnpm tauri signer generate -- -w $env:USERPROFILE\.tauri\episko_test.key -p ""
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:USERPROFILE\.tauri\episko_test.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
pnpm tauri build
```

A throwaway key means the produced updater `.sig` won't verify against real releases — fine
for just building and running the app locally. Use the real CI secret for an actual release.

A local macOS build is **ad-hoc** unless you ask for otherwise, since the identity is in the
overlay rather than `tauri.conf.json`. To reproduce a release build locally (certificate in
your keychain, notarization credentials exported):

```sh
export APPLE_API_ISSUER=… APPLE_API_KEY=… APPLE_API_KEY_PATH=…/AuthKey_XXXX.p8
pnpm tauri build --config src-tauri/tauri.macos.signing.conf.json
```

Add `--config '{"bundle":{"createUpdaterArtifacts":false}}'` to skip the minisign key
entirely when all you want to check is signing. Expect the **first ever** submission from a
new team to take ~35 minutes; later ones are under a minute.
