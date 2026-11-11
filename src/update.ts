// App self-update and the footer's version label. Installing RESTARTS the app and kills every
// live PTY, so nothing here is automatic: the install waits on a confirmation that counts them.

import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { $, toast } from "./dom";
import { ask } from "./confirm";
import { dlog, setAppVersion } from "./debug";
import { sessions } from "./state";
import { esc } from "./format";
import { icon } from "./svgicons";
import { adopt, differing, drop, isPreviewVersion, updateVerb, type Channel } from "./channel";
import { CHANNEL, baseStore, markChannel, setUpdateChannel, updateChannel } from "./channelhook";

getVersion().then((v) => {
  setAppVersion(v); $("fVer").textContent = "v" + v;
  if (markChannel(v)) void offerSettings();
}).catch(() => {});

// The first run after a switch is the one moment both channels' settings are in view. Nothing is
// asked unless the preview kept a value stable does not share (docs/releases.md § Preview builds).
async function offerSettings() {
  const keys = differing(baseStore);
  if (!keys.length) return;
  const n = `${keys.length} setting${keys.length === 1 ? "" : "s"}`;
  const back = CHANNEL === "stable";
  const ok = await ask(back
    ? `You're back on stable. The preview kept its own value for ${n}.\n\nBring them to stable?`
    : `Stable has a different value for ${n} you changed in an earlier preview.\n\nUse stable's here?`, {
    title: back ? "Settings from the preview" : "Settings from stable", kind: "info",
    okLabel: back ? "Bring them along" : "Use stable's", cancelLabel: back ? "Keep stable's" : "Keep the preview's",
  });
  if (!ok) return;
  (back ? adopt : drop)(baseStore, keys);
  dlog("info", `channel switch: ${back ? "brought" : "dropped"} the preview's value for ${n}`);
  location.reload(); // state.ts read every setting at startup; the sessions survive (./actions reloadUi)
}

// ---------- app self-update (Tauri updater plugin) ----------
let pendingUpdate: Update | null = null;
let updateBusy = false;

// The plugin's `check` reads the one endpoint the config names; a channel needs updates.rs.
type UpdateMeta = ConstructorParameters<typeof Update>[0];
async function findUpdate(): Promise<Update | null> {
  const meta = await invoke<UpdateMeta | null>("check_update", { build: CHANNEL, want: updateChannel() });
  return meta ? new Update(meta) : null;
}

/** Settings › Updates. Checked at once, so a switch is offered while the choice is fresh. */
export function switchChannel(c: Channel) {
  setUpdateChannel(c);
  void checkForUpdates(true);
}

async function checkForUpdates(manual: boolean) {
  if (updateBusy) return;
  try {
    const upd = await findUpdate();
    pendingUpdate = upd;
    const chip = $("fUpdate");
    const want = updateChannel();
    if (upd) {
      chip.innerHTML = `${icon("arrowUpFromLine")}${esc(updateVerb(CHANNEL, want, upd.version))}`;
      chip.hidden = false;
      dlog("info", `update available: v${upd.version}`);
      if (manual) toast(`Episko v${upd.version} is available`);
    } else {
      chip.hidden = true;
      if (manual) toast(want === CHANNEL ? "You're on the latest version"
        : want === "preview" ? "No preview newer than this version yet" : "No stable release found");
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
  const v = pendingUpdate.version;
  const live = [...sessions.values()].filter((s) => !s.external).length;
  const warn = live
    ? `Episko will download v${v}, close ${live} running session${live === 1 ? "" : "s"}, and restart.`
    : `Episko will download v${v} and restart.`;
  const entering = CHANNEL === "stable" && isPreviewVersion(v), leaving = CHANNEL === "preview" && !isPreviewVersion(v);
  const why = entering ? "\n\nA preview is a build of work not released yet. Settings you change in it stay with the preview, and Settings › Updates takes you back."
    : leaving ? "\n\nSettings you changed in the preview stay with it. After the restart, Episko asks whether to bring along any that differ." : "";
  const ok = await ask(`${warn}${why}\n\nContinue?`, {
    title: entering ? "Switch to the preview" : leaving ? "Back to stable" : "Update Episko",
    kind: "warning",
    okLabel: entering || leaving ? "Switch & restart" : "Update & restart",
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
