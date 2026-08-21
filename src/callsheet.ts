// The call sheet: one tool call in full — everything it was asked to do and everything
// it came back with — at a width those payloads were written for.
//
// WHY THIS IS A DIALOG RATHER THAN MORE OF THE INSPECTOR. The rail is a fixed 296px
// grid column, which comes to about 38 characters of 10.5px mono once the panel's
// padding, the detail block's indent and the `<pre>`'s own box are taken out of it.
// Everything this shows is an 80–120 column artifact: a shell command, a diff hunk, a
// compiler error. At 38 columns a four-line hunk rendered as eleven, and
// `overflow-wrap: anywhere` broke tokens mid-identifier — including splitting a diff's
// `+`/`-` marker off the line whose whole meaning it carries. So the inspector's Tools
// list keeps the *summary* (which call, how long, did it fail) and this holds the
// record.
//
// A DOM-owning module on the ./diffview pattern: it owns #callDlg, its open/close and
// its own listeners, and it takes no host object, because everything it reads is state
// rather than render.
//
// Two things it deliberately does NOT do, both of which the rail had to:
//
// - **It does not nest a scroll inside a scroll.** The rail put a 220px `<pre>` inside
//   the scrolling inspector inside the page; here the detail pane is the only thing
//   that scrolls and the blocks inside it are their natural height.
// - **It does not break words.** `overflow-wrap` stays at its default, so a long line
//   wraps at whitespace or scrolls sideways rather than being cut mid-token. That is
//   the whole complaint about the 38-column rendering, and it is a CSS decision, not a
//   data one — ./toolio hands over the same text either way.

import { $, dropScrim, toast } from "./dom";
import { ageBucket, esc, escAttr, fmtLatency } from "./format";
import { toolClass } from "./inspectorview";
import { ACT_CAP } from "./phase";
import { actClipText } from "./toolio";
import { actKey, type Act } from "./types";
import { sessions } from "./state";

/// Which session's calls are on screen, and which of them is selected.
///
/// Two ids rather than a held `Act`: the activity ring shifts under a live session, so
/// anything held by reference would go on painting a call the session has already
/// dropped — the same reason ./inspector keys its fold set by `actKey` rather than by
/// array index.
let sid: string | null = null;
let sel: string | null = null;

export function callSheetOpen(): boolean { return sid !== null; }

/// Open the sheet on one call. `sessionId` travels with the click rather than being
/// read from `activeId`, so a row always opens the session it was rendered for even if
/// the stage has moved on between the paint and the click.
export function openCallSheet(sessionId: string, key: string) {
  sid = sessionId;
  sel = key;
  $("scrim").classList.add("show");
  $("callDlg").classList.add("show");
  renderCallSheet(true);
}

export function closeCallSheet() {
  // `sid === null`, not `!sid`: `callSheetOpen()` asks the first question and these ask
  // the second, so an empty-string id would answer "open" there and "closed" here — the
  // dialog and its scrim would show, paint nothing, and refuse to close. No call site
  // passes `""` today; the guards disagreeing is what makes one able to.
  if (sid === null) return;
  sid = null;
  sel = null;
  $("callDlg").classList.remove("show");
  dropScrim();
}

export function selectCall(key: string) {
  if (sid === null || key === sel) return;
  sel = key;
  renderCallSheet();
}

/// Copy the selected call and its result. `navigator.clipboard` rather than the
/// clipboard plugin, matching every other non-terminal copy in the app — the plugin
/// exists for the panes, where `navigator.clipboard` raises an OS permission prompt on
/// read.
///
/// It survives here as a convenience rather than as the workaround it was in the rail:
/// the inspector rebuilt itself several times a second and an assignment mid-drag took
/// your text selection with it, so hand-selecting the output simply did not work. See
/// `renderCallSheet` for why it does here.
export function copySelectedCall(side: string) {
  const a = selected();
  if (!a) return;
  // An empty block copies its own placeholder rather than putting nothing on the
  // clipboard and reporting success — "(nothing returned)" is the answer, and silently
  // leaving whatever was there before is worse than pasting it.
  const text = side === "inp" ? (a.inp || "(no arguments)")
    : side === "out" ? (a.out || (a.durMs == null ? "still running" : "(nothing returned)"))
    : actClipText(a);
  const what = side === "inp" ? "Input copied" : side === "out" ? "Output copied" : "Call copied";
  navigator.clipboard.writeText(text)
    .then(() => toast(what))
    .catch(() => toast("copy failed"));
}

function selected(): Act | undefined {
  const s = sid ? sessions.get(sid) : null;
  return s?.activity.find((x) => actKey(x) === sel);
}

// ---------- render ----------

// The two halves are cached separately, and that split is the point rather than a
// micro-optimisation. See renderCallSheet.
let lastHead = "";
let lastList = "";
let lastDetail = "";

/**
 * Paint the sheet, assigning each surface only when its markup actually changed — the
 * same innerHTML guard the sidebar, the dashboard and the inspector use.
 *
 * **The list and the detail are guarded independently, and that is what makes reading
 * the output work.** The sheet rides `renderAll`, so it has to, or a call that lands
 * while it is open would never appear; but a *finished* call's detail markup is a
 * constant string, so its guard skips every pass forever and the text you are dragging
 * a selection across is never replaced under the pointer. Share one cache between the
 * halves and every new call arriving in the list would reassign the detail too, which
 * is exactly the bug this whole card was moved out of the rail to escape.
 *
 * `force` clears both caches. openCallSheet passes it because the dialog it is painting
 * into may still hold the markup of the last call it showed, which would otherwise
 * match and skip.
 */
export function renderCallSheet(force = false) {
  if (sid === null) return;
  const s = sessions.get(sid);
  // The pane went away under the sheet (closed, or the session ended and was swept).
  // Nothing left to show and no honest way to show it, so step out.
  if (!s) { closeCallSheet(); return; }
  if (force) { lastHead = ""; lastList = ""; lastDetail = ""; }

  const acts = s.activity;
  const failed = acts.filter((a) => a.failed).length;
  const head = `${acts.length} call${acts.length === 1 ? "" : "s"} kept`
    + (failed ? ` · <span class="bad">${failed} failed</span>` : "");
  if (head !== lastHead) { lastHead = head; $("callSub").innerHTML = head; }
  const title = s.title || s.branch || s.project || "Session";
  if ($("callTitle").textContent !== title) $("callTitle").textContent = title;

  const list = listHtml(acts) || `<div class="call-empty">No tool calls yet.</div>`;
  if (list !== lastList) { lastList = list; $("callList").innerHTML = list; }

  const detail = detailHtml(selected());
  if (detail !== lastDetail) { lastDetail = detail; $("callDetail").innerHTML = detail; }
}

/// The whole ring, under recency headers. The rail shows eight rows and no more, which
/// is right for a rail; the sheet has the height for all twelve, and once a list is long
/// enough to scan it wants to say *when* — the gap between two calls is often the
/// interesting thing about them (a 40-minute hole is where the turn actually went).
///
/// `now` is read once for the whole list rather than per row, so two calls a millisecond
/// apart can never land in different bands and draw a divider between themselves.
function listHtml(acts: readonly Act[]): string {
  const now = Date.now();
  let band = "";
  return acts.map((a) => {
    const b = ageBucket(now - a.startMs);
    const head = b === band ? "" : `<div class="call-gh">${esc(b)}</div>`;
    band = b;
    return head + rowHtml(a);
  }).join("");
}

/// One call in the list: what it was, what it was pointed at, how long it took and when.
///
/// The clock is `a.time` (`HH:MM`, stamped when the Pre hook landed) rather than
/// anything recomputed here. A per-row relative age would be a second clock disagreeing
/// with the band header above it, and it would make this markup differ on every single
/// repaint, which would defeat the list's `innerHTML` guard by construction — the same
/// trap `dwellText` is kept out of the inspector's markup for.
function rowHtml(a: Act): string {
  const cls = toolClass(a.tool);
  const k = actKey(a);
  const running = a.durMs == null;
  const lat = running ? "···" : fmtLatency(a.durMs!);
  return `<button class="call-row${a.failed ? " bad" : ""}${k === sel ? " on" : ""}" type="button" data-callsel="${escAttr(k)}">`
    + `<span class="dot ${cls}"></span>`
    + `<span class="nm ${cls}">${esc(a.tool)}</span>`
    + `<span class="arg">${esc(a.arg)}</span>`
    + `<span class="lat${running ? " run" : ""}">${lat}</span>`
    + `<span class="tm">${esc(a.time)}</span>`
    + `</button>`;
}

/// One block of the detail pane. `esc` rather than `escAttr` because a `<pre>`'s
/// content is a text node; both sides arrive already capped — ./toolio does that at
/// capture, since a `Read` response is a whole file and a view-side cut would keep all
/// of it alive for every call in the ring.
///
/// Each block gets its own copy button, and what it copies is the block **as is** —
/// no header, no labels, nothing wrapped around it. That is the difference from the
/// header's Copy, which hands over the labelled pair: one is for reading a call later,
/// the other is for pasting a command back into a shell or an error into a search box,
/// and a `# executed` line on top ruins the second.
function block(side: "inp" | "out", label: string, body: string, bad: boolean, dim: boolean): string {
  return `<div class="call-blk">`
    + `<div class="call-blh${bad ? " bad" : ""}">${esc(label)}`
    + `<button class="call-bcopy" type="button" data-callcopy="${side}" title="Copy this on its own">⧉</button>`
    + `</div>`
    + `<pre class="call-pre${bad ? " bad" : ""}${dim ? " dim" : ""}">${esc(body)}</pre>`
    + `</div>`;
}

function detailHtml(a: Act | undefined): string {
  if (!a) {
    // Reached by opening a call and then leaving the sheet open long enough for the
    // session to run ACT_CAP more — saying so beats silently jumping the selection to
    // a call you did not ask for.
    return `<div class="call-empty">`
      + `This call has aged out. Only the last ${ACT_CAP} are kept, and the session has run enough tools since to drop it.`
      + `</div>`;
  }
  const running = a.durMs == null;
  // The two "nothing here" cases are spelled out rather than left as an empty box,
  // because they are different facts and both are worth reading: a call still in flight
  // has an input and no answer *yet*, and a finished call whose output is blank really
  // did return nothing (`mkdir`, `git add`).
  const out = a.out || (running ? "still running…" : "(nothing returned)");
  const cls = toolClass(a.tool);
  const meta = `${a.time} · ${running ? "running" : fmtLatency(a.durMs!)}`;
  return `<div class="call-dh">`
    + `<span class="dot ${cls}"></span><b class="${cls}">${esc(a.tool)}</b>`
    + `<span class="call-arg">${esc(a.arg)}</span>`
    + `<span class="call-meta">${esc(meta)}</span>`
    + `<button class="call-copy" type="button" data-callcopy="both" title="Copy this call and its result">Copy</button>`
    + `</div>`
    // Why the call was made, above what was run. It used to sit *inside* the Executed
    // block, where it read fine and copied badly — see ./toolio's `descText`. Set in the
    // UI font rather than mono, so nothing about it looks like part of the payload.
    + (a.desc ? `<p class="call-why">${esc(a.desc)}</p>` : "")
    + block("inp", "Executed", a.inp || "(no arguments)", false, !a.inp)
    + block("out", a.failed ? "Failed" : "Returned", out, a.failed, !a.out);
}

$("callClose").addEventListener("click", closeCallSheet);
