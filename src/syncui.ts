// Sync on screen: the top bar's red badge and the status bar's segment (docs/sync.md). A sync
// nobody can hear must never look like a quiet one, so `down` raises the telemetry badge's twin.
import { $ } from "./dom";
import { openSettingsOn, repaintSync } from "./settings";
import { health, pending, prefsArrived, status } from "./synclink";
import { openReview } from "./syncreview";
import { syncSummary } from "./syncview";

let painted = "";

export function renderSync() {
  const h = health();
  const waiting = Object.keys(pending).length;
  const key = `${h}|${status.configured}|${status.halted}|${status.error ?? ""}|${prefsArrived}|${waiting}`;
  if (key === painted) return;
  const first = painted === "";
  painted = key;
  const b = $("syncBadge");
  const down = h === "down" || status.halted;
  b.className = down ? "tel-badge show" : "tel-badge";
  b.title = !down ? "" : status.halted
    ? "The sync server no longer accepts this machine. Open Settings › Sync to pair it again."
    : `Sync server unreachable${status.error ? ` (${status.error})` : ""}. Everything keeps working here; changes wait until it is back.`;
  const seg = $("fSyncSeg");
  seg.hidden = !status.configured;
  $("fSync").textContent = syncSummary(status, h)
    + (waiting ? ` · ${waiting} to review` : prefsArrived ? " · reload to apply" : "");
  seg.className = `fseg fclick sync-${down ? "down" : h}`;
  if (!first) repaintSync();
}

$("syncBadge").addEventListener("click", () => openSettingsOn("sync"));
// Settings waiting for a yes are the more urgent thing behind the segment.
$("fSyncSeg").addEventListener("click", () => (Object.keys(pending).length ? openReview() : openSettingsOn("sync")));
