## Install

**macOS (Apple Silicon)**

1. Download **Episko_*_aarch64.dmg** from the assets below.
2. Episko is self-signed (not notarized by Apple), so macOS Gatekeeper blocks the first launch. Clear the quarantine flag once:
   ```sh
   xattr -dr com.apple.quarantine ~/Downloads/Episko_*.dmg
   ```
3. Open the `.dmg`, drag **Episko** into Applications, and launch it. If it's still blocked:
   ```sh
   xattr -dr com.apple.quarantine /Applications/Episko.app
   ```
Apple Silicon (M-series) only — Intel Macs aren't supported by this build.

**Windows (x64)**

1. Download **Episko_*_x64-setup.exe** (or the **.msi**) from the assets below.
2. Episko isn't code-signed, so Windows SmartScreen may warn on first run — click **More info → Run anyway**.

Requires `claude` on your `PATH`. Episko keeps itself up to date after install (checks the latest release on launch; never auto-installs).
