// App self-update, and the footer's version label it hangs off.
//
// Installing an update RESTARTS the app, which kills every live PTY and every Claude
// session with it — so nothing here is automatic. A check surfaces as a footer chip
// and (when asked for) a toast; the install only runs after a confirmation that names
// how many sessions it would end.
//
// Self-contained: it needs no hook, because the one thing it reads about the rest of
// the app is how many live panes there are, and that is ./state.

import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { ask } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { $, toast } from "./dom";
import { dlog, setAppVersion } from "./debug";
import { sessions } from "./state";

// show the running app's version (from tauri.conf.json) in the footer, so it's
// clear which build is installed after an update.
getVersion().then((v) => { setAppVersion(v); $("fVer").textContent = "v" + v; }).catch(() => {});

// ---------- app self-update (Tauri updater plugin) ----------
// Checks the latest GitHub release (respeak-io/episko) for a newer Episko.
// Installing an update RESTARTS the app, which kills every live PTY/Claude
// session — so we never auto-install: the update surfaces as a footer chip and
// a one-time toast, and only downloads + relaunches after an explicit,
// session-count-aware confirmation. Clicking the version label re-checks.
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
    // The update manifest (latest.json) may not list this platform yet — e.g. no
    // Windows release has been published. The updater reports that as "None of the
    // fallback platforms [...] were found in the response platforms object". That's
    // "no update for this platform", not a failure — surface it quietly.
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
// quiet check on launch, once the app has settled.
setTimeout(() => checkForUpdates(false), 3000);
// "Check for Updates…" in the menu-bar menu. Without this the only checks are the
// one at launch and the easily-missed click on the version label, so a long-running
// Episko never learns about a release until it's restarted. Manual → it reports
// either way ("you're on the latest version"), so the menu item always answers.
listen("tray-check-updates", () => { void checkForUpdates(true); });
