// *What's new* — the release history, and the one moment it opens by itself.
//
// ./changelog owns the parsing and the "should this open" rule and is tested; this owns
// the dialog, its markup and its events. The file itself is bundled at build time
// (`?raw`), so this reaches no network and a build can only ever describe itself.
//
// Deliberately NOT on renderAll's path: it is opened by a click or once after an
// update, and nothing about it changes while it is shut.

import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import raw from "../CHANGELOG.md?raw";
import { $, dropScrim } from "./dom";
import { dlog } from "./debug";
import { esc } from "./format";
import {
  grouped, inlineMd, MARK_GLYPH, MARK_LABEL, parseChangelog, parseSeen, recordSeen, releaseFor,
  shouldAnnounce, type Release,
} from "./changelog";

const LOG: Release[] = parseChangelog(raw);
/// Every version this machine has had *What's new* opened for, newest last. A list
/// rather than a single last-seen string so that returning to a version already read
/// stays quiet — `parseSeen` / `recordSeen` / `shouldAnnounce` in ./changelog own the
/// rules, and this module only owns where the list is kept.
const SEEN = "cc-seen-versions";
/// 0.13.0's single-value key, folded into the list above by `parseSeen`.
const SEEN_LEGACY = "cc-seen-version";

let version = "";
let sel = 0;

export const changelogOpen = () => $("clDlg").classList.contains("show");

/// Read fresh each time rather than cached: it is a handful of calls a session, and a
/// stale copy would leave the footer handle lit after the screen had been opened.
const seenVersions = () => parseSeen(localStorage.getItem(SEEN), localStorage.getItem(SEEN_LEGACY));

/// The footer handle stays lit until the running version has been read once. It is the
/// only signal that there is something new — which is why it sits beside the version
/// number rather than in the top bar: that number is the thing it explains.
function syncHandle() {
  const unread = !!version && !seenVersions().includes(version);
  $("clBtn").classList.toggle("fresh", unread);
  $("clBtn").title = unread ? `What's new in ${version}` : "What's new";
}

/// Mark the running version read. Called on open, not on close: opening it *is* the
/// reading, and a user who closes with Esc has still seen it.
function markSeen() {
  if (!version) return;
  localStorage.setItem(SEEN, JSON.stringify(recordSeen(seenVersions(), version)));
  syncHandle();
}

export function openChangelog(atVersion?: string) {
  if (!LOG.length) return;                    // nothing to show; the handle stays hidden
  // `releaseFor` owns which one to land on, including the dev-build fallback — it is
  // tested, and re-deriving it here is how the two would drift.
  const target = releaseFor(atVersion ?? version, LOG);
  sel = Math.max(0, LOG.indexOf(target!));
  $("scrim").classList.add("show");
  $("clDlg").classList.add("show");
  render();
  markSeen();
}

export function closeChangelog() {
  $("clDlg").classList.remove("show");
  dropScrim();
}

function render() {
  const r = LOG[sel];
  if (!r) return;
  $("clSub").textContent = version ? `you're on ${version}` : "";

  $("clRail").innerHTML = `<div class="cl-railh">Releases</div>` + LOG.map((x, i) => {
    const running = x.released && x.version === version;
    return `<div class="cl-v${i === sel ? " on" : ""}${running ? " running" : ""}${x.released ? "" : " unrel"}"
        data-clv="${i}" title="${esc(x.released ? `Episko ${x.version}` : "Not released yet")}">
      <span class="dot"></span>
      <span class="n">${esc(x.released ? x.version : "next")}</span>
      <span class="d">${esc(shortDate(x.date))}</span></div>`;
  }).join("");

  const running = r.released && r.version === version;
  $("clMain").innerHTML =
    `<div class="cl-vh"><h4>${esc(r.released ? `Episko ${r.version}` : "Next release")}</h4>
      ${r.date ? `<span class="when">${esc(r.date)}</span>` : `<span class="when">not released yet</span>`}
      ${running ? `<span class="chip ok">you're running this</span>` : ""}</div>`
    // A lede carries the same markup an entry does — 0.10.0's and 0.11.0's both open on
    // a bold clause — so it goes through the same renderer rather than plain `esc`.
    + (r.lede ? `<p class="cl-lede">${inlineMd(r.lede)}</p>` : "")
    + grouped(r).map((g) => `<div class="cl-group">
        <div class="cl-gh"><span class="t">${esc(MARK_LABEL[g.mark])}</span></div>
        ${g.entries.map((e) => `<div class="cl-item ${g.mark}">
          <span class="m">${MARK_GLYPH[g.mark]}</span>
          <span class="tx">${inlineMd(e.text)}</span></div>`).join("")}
      </div>`).join("");

  ($("clGh") as HTMLButtonElement).hidden = !r.released;
}

const shortDate = (d: string) => (d ? d.slice(5).replace("-", "/") : "—");

// ---------- wiring ----------
export function initChangelog() {
  getVersion().then((v) => {
    version = v;
    syncHandle();
    // The one moment it opens by itself. Deliberately after the version resolves
    // rather than on a timer: opening over a half-painted app reads as a glitch.
    if (shouldAnnounce(v, seenVersions(), LOG)) {
      dlog("info", `changelog: first run of v${v}`);
      openChangelog(v);
    }
  }).catch(() => { /* not in Tauri (vite dev in a browser) — the handle stays quiet */ });

  $("clBtn").addEventListener("click", () => (changelogOpen() ? closeChangelog() : openChangelog()));
  $("clClose").addEventListener("click", closeChangelog);
  $("clRail").addEventListener("click", (e) => {
    const v = (e.target as HTMLElement).closest<HTMLElement>("[data-clv]");
    if (!v) return;
    sel = +v.dataset.clv!;
    render();
  });
  $("clGh").addEventListener("click", () => {
    const r = LOG[sel];
    if (!r?.released) return;
    void openUrl(`https://github.com/respeak-io/episko/releases/tag/v${r.version}`).catch(() => {});
  });
}
