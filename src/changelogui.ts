// *What's new*: the release history dialog, and the one moment it opens by itself.
// ./changelog owns the parsing and the "should this open" rule; CHANGELOG.md is bundled
// at build time (`?raw`), so a build can only describe itself. Not on renderAll's path.

import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import raw from "../CHANGELOG.md?raw";
import { $, dropScrim } from "./dom";
import { dlog } from "./debug";
import { startChapter, tourForVersion } from "./tourui";
import { esc } from "./format";
import {
  grouped, inlineMd, MARK_GLYPH, MARK_LABEL, parseChangelog, parseSeen, recordSeen, releaseFor,
  shouldAnnounce, type Release,
} from "./changelog";

const LOG: Release[] = parseChangelog(raw);
// Every version What's new has been opened for, newest last; ./changelog owns the rules.
const SEEN = "cc-seen-versions";
const SEEN_LEGACY = "cc-seen-version"; // 0.13.0's single-value key, folded in by parseSeen

let version = "";
let sel = 0;

export const changelogOpen = () => $("clDlg").classList.contains("show");

// Read fresh, not cached: a stale copy would leave the footer handle lit after opening.
const seenVersions = () => parseSeen(localStorage.getItem(SEEN), localStorage.getItem(SEEN_LEGACY));

function syncHandle() {
  const unread = !!version && !seenVersions().includes(version);
  $("clBtn").classList.toggle("fresh", unread);
  $("clBtn").title = unread ? `What's new in ${version}` : "What's new";
}

// Called on open, not on close: a user who closes with Esc has still seen it.
function markSeen() {
  if (!version) return;
  localStorage.setItem(SEEN, JSON.stringify(recordSeen(seenVersions(), version)));
  syncHandle();
}

export function openChangelog(atVersion?: string) {
  if (!LOG.length) return;                    // nothing to show; the handle stays hidden
  // releaseFor owns the landing choice (incl. the dev-build fallback); don't re-derive it here.
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
  // A release's guided chapter is offered here and nowhere else. `tourForVersion`, not
  // `releaseChapter`: the offer lapses once the chapter is taken (it then lives in Settings › Guide).
  const guide = tourForVersion(r.version);
  $("clMain").innerHTML =
    `<div class="cl-vh"><h4>${esc(r.released ? `Episko ${r.version}` : "Next release")}</h4>
      ${r.date ? `<span class="when">${esc(r.date)}</span>` : `<span class="when">not released yet</span>`}
      ${running ? `<span class="chip ok">you're running this</span>` : ""}
      ${guide ? `<button class="cl-guide" data-clstart="${esc(guide.id)}">Show me &rarr;</button>` : ""}</div>`
    // A lede carries entry markup (a bold opening clause), so inlineMd rather than esc.
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
// `quiet`: the guided tour has claimed the screen (a first run), so mark the running
// version read and announce nothing. Keyed on the tour having opened, not on a missing
// seen-record, so it is not the fresh-install guard docs/releases.md retired.
export function initChangelog(quiet = false) {
  getVersion().then((v) => {
    version = v;
    syncHandle();
    if (quiet) { markSeen(); return; }
    // After the version resolves, not on a timer: opening over a half-painted app reads as a glitch.
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
  // Close first: every anchor the chapter lights is behind this dialog.
  $("clMain").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-clstart]");
    if (!b) return;
    closeChangelog();
    startChapter(b.dataset.clstart!);
  });
  $("clGh").addEventListener("click", () => {
    const r = LOG[sel];
    if (!r?.released) return;
    void openUrl(`https://github.com/respeak-io/episko/releases/tag/v${r.version}`).catch(() => {});
  });
}
