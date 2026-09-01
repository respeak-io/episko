// App self-update and the footer's version label. Installing RESTARTS the app and kills every
// live PTY, so nothing here is automatic: the install waits on a confirmation that counts them.

import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { $, toast } from "./dom";
import { ask } from "./confirm";
import { dlog, setAppVersion } from "./debug";
import { sessions } from "./state";

getVersion().then((v) => { setAppVersion(v); $("fVer").textContent = "v" + v; }).catch(() => {});

// ---------- app self-update (Tauri updater plugin) ----------
let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null;
let updateBusy = false;

async function checkForUpdates(manual: boolean) {
  if (updateBusy) return;
  try {
    const upd = await check();
    pendingUpdate = upd;
    const chip = $("fUpdate");
    if (upd) {
      chip.textContent = `⇧ update to v${upd.version}`;
      chip.hidden = false;
      dlog("info", `update available: v${upd.version}`);
      if (manual) toast(`Episko v${upd.version} is available`);
    } else {
      chip.hidden = true;
      if (manual) toast("You're on the latest version");
    }
  } catch (e) {
    const msg = String(e);
    // A manifest that does not list this platform yet (no Windows release, say) reports as
    // "None of the fallback platforms … were found": no update for us, not a failure.
    if (msg.includes("were found in the response")) {
      $("fUpdate").hidden = true;
      dlog("info", "no update published for this platform yet");
      if (manual) toast("No update published for this platform yet");
      return;
    }
    dlog("error", `update check failed: ${msg}`);
    if (manual) toast("Update check failed. See debug console");
  }
}

async function runUpdate() {
  if (!pendingUpdate || updateBusy) return;
  const live = [...sessions.values()].filter((s) => !s.external).length;
  const warn = live
    ? `Episko will download v${pendingUpdate.version}, close ${live} running session${live === 1 ? "" : "s"}, and restart.`
    : `Episko will download v${pendingUpdate.version} and restart.`;
  const ok = await ask(`${warn}\n\nContinue?`, {
    title: "Update Episko",
    kind: "warning",
    okLabel: "Update & restart",
    cancelLabel: "Not now",
  });
  if (!ok) return;
  updateBusy = true;
  try {
    toast(`Downloading v${pendingUpdate.version}…`);
    await pendingUpdate.downloadAndInstall((ev) => {
      if (ev.event === "Finished") toast("Installing update…");
    });
    await relaunch();
  } catch (e) {
    updateBusy = false;
    dlog("error", `update install failed: ${String(e)}`);
    toast("Update failed. See debug console");
  }
}

$("fUpdate").addEventListener("click", runUpdate);
$("fVer").addEventListener("click", () => checkForUpdates(true));
setTimeout(() => checkForUpdates(false), 3000); // quiet check once the app has settled
// "Check for Updates…" in the tray menu; a long-running Episko otherwise never learns of a release.
listen("tray-check-updates", () => { void checkForUpdates(true); });
