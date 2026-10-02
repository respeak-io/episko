// The review before a synced preference applies here: what each one becomes, ticked to apply,
// with a way to keep a setting to this machine for good (docs/sync.md). ./synclink holds the
// waiting values and ./syncview draws the list; this file owns #srvDlg and its keyboard.
import { $ } from "./dom";
import { deviceName } from "./sync";
import { devices, pending, resolvePending, setExcluded, status } from "./synclink";
import { reviewHtml } from "./syncview";

let reload: () => void = () => {};
export function setReviewReload(fn: () => void) { reload = fn; }

const off = new Set<string>(); // unticked: declined when the dialog is answered
let painted = "";
const isOpen = () => $("srvDlg").classList.contains("show");

function paint() {
  const items = Object.values(pending).sort((a, b) => b.at - a.at);
  if (!items.length) { close(); return; }
  for (const k of off) if (!pending[k]) off.delete(k);
  const html = reviewHtml(items, off, (d) => deviceName(devices, d, status.device), Date.now());
  if (html !== painted) { painted = html; $("srvBody").innerHTML = html; }
  const n = items.length - [...off].filter((k) => pending[k]).length;
  $("srvApply").textContent = n ? `Apply ${n}` : "Keep mine";
  $("srvReload").hidden = !n;
}

/** Opens on what is waiting; a no-op when nothing is, or when it is already up. */
export function openReview() {
  if (isOpen() || !Object.keys(pending).length) return;
  off.clear();
  painted = "";
  paint();
  $("srvDlg").classList.add("show");
  $("srvScrim").classList.add("show");
}
/** A batch arrived while the dialog was up: show it, without undoing the ticks already made. */
export function refreshReview() { if (isOpen()) paint(); }

function close() {
  $("srvDlg").classList.remove("show");
  $("srvScrim").classList.remove("show");
}
function answer(andReload: boolean) {
  const keys = Object.keys(pending);
  const accept = keys.filter((k) => !off.has(k));
  resolvePending(accept, keys.filter((k) => off.has(k)));
  close();
  if (andReload && accept.length) reload();
}

$("srvBody").addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-srv]");
  if (!el) return;
  const [verb, ...rest] = el.dataset.srv!.split("|");
  const key = rest.join("|");
  if (verb === "keep") { e.preventDefault(); setExcluded(key, true); paint(); return; }
  if (verb === "tick") { (el as HTMLInputElement).checked ? off.delete(key) : off.add(key); paint(); }
});
$("srvApply").addEventListener("click", () => answer(false));
$("srvReload").addEventListener("click", () => answer(true));
// Later keeps everything waiting: nothing is decided by closing the dialog.
$("srvLater").addEventListener("click", close);
$("srvScrim").addEventListener("click", close);
// Capture phase at module scope, like ./confirm, so Esc closes this before main.ts sees it.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !isOpen()) return;
  e.preventDefault(); e.stopImmediatePropagation();
  close();
}, true);
