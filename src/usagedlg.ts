// The Usage & spend window. Nothing in it is a setting — it is a report — so it is its own
// dialog rather than a tab wedged into Settings, and the status bar's money and limits
// popovers open straight into it. ./usageview draws it; this file owns the element, the
// range buttons, the heatmap tooltip and the (throttled) token scan behind it.

import { invoke } from "@tauri-apps/api/core";
import { $, dropScrim } from "./dom";
import { dlog } from "./debug";
import { esc } from "./format";
import { setTokenScanning, tokenScanning, usagePanelHtml } from "./usageview";
import { setTokenDays, setUsageRange, tokenDays, tokenScanAt, type DayUsage } from "./usage";

export function usageOpen() { return $("usageDlg").classList.contains("show"); }

// Guarded like every other repainting surface: the panel repaints on the 30s tick and again
// when a scan lands, and an innerHTML assignment under the pointer drops the click on a
// range button and kills the tooltip's row mid-hover.
let lastUsage = "";
export function renderUsage() {
  if (!usageOpen()) return;
  const html = usagePanelHtml();
  if (html === lastUsage) return;
  lastUsage = html;
  $("usageBody").innerHTML = html;
}

export function openUsage() {
  $("scrim").classList.add("show");
  $("usageDlg").classList.add("show");
  renderUsage();
  void refreshTokens(); // throttled and cached; the panel paints from localStorage meanwhile
}
export function closeUsage() {
  $("usageDlg").classList.remove("show");
  uTip.hidden = true;
  dropScrim();
}

// A full read of the recent corpus, so at most once per 10 min unless forced; the panel
// paints from localStorage first and repaints when fresh numbers land.
export async function refreshTokens(force = false) {
  if (tokenScanning) return;
  if (!force && tokenDays.length && Date.now() - tokenScanAt < 6e5) return;
  setTokenScanning(true);
  renderUsage(); // surface the "scanning…" hint
  try {
    setTokenDays(await invoke<DayUsage[]>("token_usage_by_day", { days: 400 }));
  } catch (e) { dlog("warn", "token scan failed: " + e); }
  finally { setTokenScanning(false); renderUsage(); }
}

// ---------- the window's own event wiring ----------
$("usageClose").addEventListener("click", closeUsage);
$("usageBody").addEventListener("click", (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>("[data-urange]");
  if (r) { setUsageRange(+r.dataset.urange!); renderUsage(); }
});

// The heatmap/bar tooltip, on <body> rather than #usageBody so a repaint never drops it.
const uTip = Object.assign(document.createElement("div"), { className: "u-tip", hidden: true });
document.body.appendChild(uTip);
$("usageBody").addEventListener("mousemove", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
  if (!t) { uTip.hidden = true; return; }
  // dataset.tip is HTML-decoded on read; re-escape each line before re-inserting.
  uTip.innerHTML = t.dataset.tip!.split("||").map(esc).join("<br>");
  uTip.hidden = false;
  uTip.style.left = e.clientX + "px";
  uTip.style.top = (e.clientY - 14) + "px";
});
$("usageBody").addEventListener("mouseleave", () => { uTip.hidden = true; });
