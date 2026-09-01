// The xterm side of a pane: creating a terminal, sizing it, and the two small
// translations between what Claude Code sends and what the UI wants.
//
// Everything here is shared by all three spawners (`spawn_claude`, `spawn_shell`,
// `spawn_task`), which is why it sits below them rather than inside any one — a font
// stack copied per spawner, or a second `fitSession`, is a drift bug waiting to
// happen. Nothing here reaches upward, so it needs no hook.
//
// Two rules worth not rediscovering: `fitSession` must only ever run on the *active*
// pane (an inactive one is display:none, so fit() would measure a zero-size box and
// resize the PTY to garbage), and the font atlas has to be dropped once the bundled
// Nerd Font arrives — the WebGL renderer bakes tofu boxes into it otherwise.

import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IS_WIN, toast } from "./dom";
import { dlog } from "./debug";
import type { Sess } from "./types";
import { findLinks, linkBases, type PathCand } from "./termlinks";
import { activeId, sessions, setTermFontSize, stageGroup, termFontSize } from "./state";

// Leads with the bundled Nerd Font (see @font-face in styles.css) so the terminal
// draws powerline / devicon glyphs on every OS; the rest stay as graceful fallbacks.
export const MONO = '"JetBrainsMono Nerd Font", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

// WebGL contexts come from a small LRU pool over the recently-staged panes — never
// one per pane for life, and never a create per pane switch either. Both extremes
// were tried and both are wrong, for reasons worth keeping:
//
// - Per pane for life: webviews cap a page at 16 live WebGL contexts and evict LRU
//   past it, so a fleet that ever crossed 16 panes silently downgraded its *oldest*
//   terminals — exactly the long-lived sessions you keep returning to — onto xterm's
//   slow DOM renderer, permanently.
// - Attach on activate / dispose on deactivate: every switch then creates a context,
//   and **JS cannot destroy one — only unreference it**. The browser frees the slot
//   at GC time; Chromium's GC keeps up, WKWebView's does not, so ~16 switches in
//   every attach logged "too many active WebGL contexts" and leaned on WebKit
//   force-losing a disposed zombie (observed in the dev build). Nor is
//   `WEBGL_lose_context.loseContext()` a release — a lost-but-referenced context
//   STAYS in WebKit's budget (it must remain restorable), and eviction then trips
//   over it with INVALID_OPERATION. Also observed.
//
// So: a pane keeps its addon when it leaves the stage, while it stays among the
// GL_POOL_MAX most recently staged. Flipping between warm panes costs nothing and
// creates nothing; only a cold pane creates a context, and the pool bounds the live
// count comfortably under the 16 budget. Exited and closed panes free their slot at
// once (see setActive / closeSession). A context lost anyway — a GPU reset, a
// degenerate >16-tile mosaic — costs one dlog and heals on the pane's next
// activation instead of downgrading it for good.
const glPool: Sess[] = []; // panes holding a live addon, most recently staged last
const GL_POOL_MAX = 8;     // live-context bound; the 16-slot budget keeps headroom for
                           // disposed contexts the browser has not collected yet
export function attachWebgl(s: Sess) {
  if (!s.term) return;
  const i = glPool.indexOf(s);
  if (i >= 0) glPool.splice(i, 1);
  if (s.gl) { glPool.push(s); return; } // warm — just refresh its recency
  let w: WebglAddon | undefined;
  try {
    w = new WebglAddon();
    w.onContextLoss(() => {
      // dispose() is the documented recovery for a lost context; detach also clears
      // `s.gl`, which is what lets the next setActive re-attach a fresh one.
      dlog("warn", `webgl context lost · ${s.id.slice(0, 8)} · DOM renderer until reactivated`);
      detachWebgl(s);
    });
    s.term.loadAddon(w);
    s.gl = w;
    glPool.push(s);
    // Evict the coldest *hidden* pane past the cap. Everything visible is exempt —
    // a tiled group larger than the pool keeps its tiles and accepts the browser's
    // own eviction (which the loss handler above turns into a heal, not a downgrade).
    while (glPool.length > GL_POOL_MAX) {
      const victim = glPool.find((x) => !x.pane.classList.contains("active"));
      if (!victim) break;
      detachWebgl(victim);
    }
  } catch (e) {
    // WebGL unavailable (GPU blocklist, RDP, acceleration off): the DOM renderer is
    // the honest fallback. Warn once per run, not once per pane switch — the retry
    // itself stays, since a crashed GPU process can come back.
    try { w?.dispose(); } catch { /* half-activated addon */ }
    if (!webglWarned) { webglWarned = true; dlog("warn", `webgl unavailable, so terminals use the DOM renderer (${e})`); }
  }
}
let webglWarned = false;
export function detachWebgl(s: Sess) {
  const w = s.gl;
  if (!w) return;
  s.gl = undefined; // clear first — dispose() must not re-enter through onContextLoss
  const i = glPool.indexOf(s);
  if (i >= 0) glPool.splice(i, 1);
  // Capture the addon's canvases before dispose() takes them out of the pane, then
  // zero them: the context slot itself is the browser's to reclaim (see above), but
  // the multi-MB backing stores are freeable right now.
  const canvases = [...s.pane.querySelectorAll("canvas")];
  try { w.dispose(); } catch { /* already disposed with its terminal */ }
  for (const c of canvases) { c.width = 0; c.height = 0; }
}

// An ended resumable agent pane keeps a full buffer of scrollback it can never grow
// again, tens of MB across a day — while provider history can reopen the conversation.
// So the buffer is reclaimed once the pane is done: immediately
// when it ends off stage, and on the way *off* the stage when you watched it end (the
// visible screen keeps its final output either way). Provider-backed panes only: a
// shell has no history, and a failed task's scrollback IS the log you open it to read.
export function trimScrollback(s: Sess) {
  if (!s.term || s.term.options.scrollback === 0) return;
  try { s.term.options.scrollback = 0; } catch { /* pane already disposed */ }
}

// Push a changed scrollback setting onto the panes already open. The setting exists for
// a fleet that has been up for hours, so applying it only to *new* terminals would mean
// the one thing it can help never gets it.
//
// **A pane already trimmed to 0 is left alone**, which is the whole subtlety here: that
// zero is `trimScrollback`'s deliberate reclaim on an ended pane, not a value anybody
// chose, and handing it 4000 back would refill the buffer this app just freed. Lowering
// the limit drops the oldest lines at once (xterm applies it on assignment); raising it
// only sets the new ceiling, since the lines it would have kept are already gone.
export function applyScrollback(list: Iterable<Sess>, lines: number) {
  for (const s of list) {
    if (!s.term || s.term.options.scrollback === 0) continue;
    try { s.term.options.scrollback = lines; } catch { /* pane disposed mid-pass */ }
  }
}

// The whole custom key rule for a shell pane, in one handler — xterm keeps only the
// *last* `attachCustomKeyEventHandler`, so a second call anywhere silently discards
// the first. Task panes take `clipboardKeys` alone: the ⌥/⌘ word-nav below is a login
// shell's business, and a task pane is running a program, not a prompt.
export function shellKeys(id: string, term: Terminal): (e: KeyboardEvent) => boolean {
  const clip = clipboardKeys(term), nav = macShellKeys(id);
  return (e) => clip(e) && nav(e);
}

// Ctrl+Shift+C / Ctrl+Shift+V — copy and paste for the panes that cannot have the
// plain chords. Ctrl+C is the interrupt a shell or task pane exists to send, and xterm
// turns Ctrl+V into a dead ^V (see `winClaudePaste`), so the shifted pair is the only
// copy/paste a terminal has left — which is exactly why Windows Terminal, GNOME
// Terminal and VS Code's terminal all use it. Unshifted ⌘C/⌘V on macOS are untouched:
// xterm passes them to the WebView, which copies and pastes natively.
//
// Both halves go through the Tauri clipboard plugin rather than `navigator.clipboard`.
// Writing would work either way, but `readText()` in the WebView sits behind the
// `clipboard-read` permission — a WebView2 prompt on Windows, WKWebView's paste-
// confirmation button on macOS — because Tauri does not build the webview with wry's
// `enable_clipboard_access()`. The host side has no such gate, so paste stays silent
// and immediate on both.
export function clipboardKeys(term: Terminal): (e: KeyboardEvent) => boolean {
  return (e) => {
    if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
    const k = e.key.toLowerCase();
    if (k !== "c" && k !== "v") return true;
    // Returning false only stops *xterm* from handling the key; the WebView still gets
    // its own default (devtools' inspect-element on Ctrl+Shift+C), hence both.
    e.preventDefault();
    if (k === "c") void copySelection(term);
    else void pasteClipboard(term);
    return false;
  };
}

async function copySelection(term: Terminal) {
  const sel = term.getSelection();
  if (!sel) return; // nothing selected — a no-op, as in every other terminal
  try { await writeText(sel); toast("Copied"); }
  catch (e) { dlog("error", `clipboard write failed: ${e}`); toast("Couldn't copy: clipboard unavailable"); }
}

// `term.paste` rather than a direct `write_pty`: it is xterm's own paste path, so the
// text gets \r\n→\r normalisation and bracketed-paste wrapping when the program asked
// for it, then leaves through `onData` — the same route typing takes, whichever spawner
// owns the pane. A read that throws is nearly always an empty clipboard or one holding
// something that isn't text (arboard reports both as unavailable), so the toast says
// that rather than crying failure; the real error still reaches the debug console.
async function pasteClipboard(term: Terminal) {
  let text = "";
  try { text = await readText(); }
  catch (e) { dlog("error", `clipboard read failed: ${e}`); toast("Nothing to paste: no text on the clipboard"); return; }
  if (text) term.paste(text);
}

// macOS terminal key conventions for the embedded shell. xterm.js emits xterm's
// modified-arrow sequences (Option+Left = \e[1;3D etc.), which a plain login zsh
// doesn't bind by default — so word-nav keys self-insert garbage like ";3D".
// Terminal.app instead maps them to the Meta/emacs sequences zsh binds out of the
// box; we do the same here so the embedded shell navigates like a normal terminal.
// Only plain-shell PTYs get this (Claude's REPL handles its own key input).
function macShellKeys(id: string): (e: KeyboardEvent) => boolean {
  const send = (data: string, e: KeyboardEvent): boolean => { e.preventDefault(); invoke("write_pty", { sessionId: id, data }); return false; };
  return (e: KeyboardEvent) => {
    if (e.type !== "keydown") return true;
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "ArrowLeft") return send("\x1bb", e);      // backward-word
      if (e.key === "ArrowRight") return send("\x1bf", e);     // forward-word
      if (e.key === "Backspace") return send("\x1b\x7f", e);   // backward-kill-word
    }
    if (e.metaKey && !e.altKey && !e.ctrlKey) {
      if (e.key === "ArrowLeft") return send("\x01", e);       // beginning-of-line (^A)
      if (e.key === "ArrowRight") return send("\x05", e);      // end-of-line (^E)
    }
    return true;
  };
}

// A claude pane's keystrokes are NOT raw pass-through — this is the one input path
// that filters. Ctrl+C must stay an *interrupt*, never an exit: Claude's REPL quits on
// a second ^C inside its own double-press window, and in an embedded pane that reads
// as Episko losing a session rather than a terminal doing what terminals do — the pane
// is left behind as a dead `·` row. So a claude pane forwards the first ^C (cancel the
// turn / clear the prompt) and swallows whatever follows inside the guard window; press
// again a moment later and it interrupts normally. Ending a session stays an explicit
// act: ✕, ⌘K → Close, or `/exit` typed into Claude.
//
// Only claude panes get this — ^C in a shell or task pane is the whole point of those
// panes, and killing the process there is the expected outcome. Those two wire
// `term.onData` straight to `write_pty` (see ./panes).
//
// The window is deliberately a little longer than Claude's own (~2s): too long merely
// delays a repeat interrupt, too short lets the exit through.
const INTR_GUARD_MS = 3000;
export function claudeInput(id: string): (d: string) => void {
  let lastIntr = 0, warned = false;
  return (d) => {
    // Exactly ^C and nothing else: a paste arrives wrapped in bracketed-paste
    // sequences, so pasted text containing \x03 never lands here as a lone byte.
    if (d === "\x03") {
      const now = Date.now();
      if (now - lastIntr < INTR_GUARD_MS) {
        // One toast per burst — key repeat would otherwise fire it continuously.
        if (!warned) {
          warned = true;
          toast("Ctrl+C interrupts. Use ✕ or /exit to end the session");
          dlog("info", `guarded repeat ^C · ${id.slice(0, 8)}`);
        }
        return;
      }
      lastIntr = now;
      warned = false;
    }
    invoke("write_pty", { sessionId: id, data: d });
  };
}

// Windows image paste for Claude panes. Claude Code's only default binding for
// chat:imagePaste on native Windows is alt+v (ctrl+v joins it only under WSL) —
// and xterm makes Ctrl+V a dead key on top: it swallows the browser paste and
// sends ^V, which Claude ignores there. Net effect: Ctrl+V did *nothing* in an
// embedded pane on Windows. Route by clipboard content instead: tell xterm to
// leave Ctrl+V to the browser, then on the resulting paste event send ESC v
// (Claude's own alt+v chord) when an image is aboard — Claude reads the bitmap
// through its native clipboard path and shows its own feedback — while plain
// text falls through to xterm's normal bracketed paste.
//
// NOTE: xterm keeps only **one** custom key-event handler per terminal, so a new key
// rule for a claude pane belongs in here or in `claudeInput` above — never in a second
// `attachCustomKeyEventHandler` call. (`shellKeys` is safe: it is the *shell* pane's
// one handler, and no pane is both.)
export function winClaudePaste(id: string, term: Terminal, pane: HTMLElement) {
  if (!IS_WIN) return;
  term.attachCustomKeyEventHandler((e) =>
    !(e.type === "keydown" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "v"));
  // Capture phase: runs before xterm's textarea paste handler, so an image paste
  // never double-fires as a (empty) text paste.
  pane.addEventListener("paste", (e) => {
    if (!Array.from(e.clipboardData?.items ?? []).some((i) => i.type.startsWith("image/"))) return;
    e.preventDefault();
    e.stopPropagation();
    invoke("write_pty", { sessionId: id, data: "\x1bv" });
  }, true);
}

// ---------- clickable links ----------
//
// A pane's output is the one surface in this app where a path or a URL is *only*
// text. The inspector's Context card already makes a file the agent wrote clickable,
// but it is fed from PostToolUse and so cannot see what a Bash call did — a `cp`, a
// `>`, a generated PDF — and the working-set card sees only what git sees, which
// outside a repo is nothing. What is left is the sentence the agent typed, so that is
// where the click has to go.
//
// Registered on every pane whatever runs in it: a path in Codex's output is the same
// path, and a shell pane's `ls` is the case with no card behind it at all.
//
// Two mechanisms, because there are two kinds of link:
//
//   · **OSC 8**, the terminal-native hyperlink. xterm parses it already and hands it
//     to `options.linkHandler` — we simply had none, so every one was inert. It stays
//     http(s)-only (`allowNonHttpProtocols` left off, and `openHref` checks anyway):
//     a program may put any URI it likes in an OSC 8, `javascript:` included, and a
//     terminal pane is not the place to decide which of those are safe.
//   · **a link provider**, for everything printed as plain text — which is all of it
//     when the program never learned OSC 8. ./termlinks proposes; disk decides.

/// The joined rows as one string, with each character's cell recorded so a match can
/// be mapped back to a buffer range.
interface JoinedRow { text: string; cells: { x: number; y: number }[] }
/// Structural, because xterm exports `ILink` as a type but not a value and the
/// interface itself is not re-exported from the package root.
interface TermLink {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  text: string;
  activate: () => void;
}
type Buf = Terminal["buffer"]["active"];

/// Cap on the joined text. A path is one line's worth of characters; anything past
/// this is a paragraph, and walking it per hover is not free.
const MAX_JOIN = 4000;
/// How many wrap-runs to join either side of the hovered one. **Two**, not one: an
/// agent breaks a long path at ITS spaces, and a path with two spaces in it comes out
/// across three rows — from the middle one, joining a single run reaches one end and
/// never the other, which is exactly what a real hover found (three separate proposals
/// on one path, none of them the whole thing).
const EXTRA_RUNS = 2;
/// Hover answers, kept because the same row is re-asked on every mouse move that
/// leaves and re-enters it. Cleared wholesale rather than aged: an entry is two
/// strings and the cost of a miss is one `stat` sweep.
const RESOLVED_MAX = 300;
const resolved = new Map<string, [number, string] | null>();

const runStart = (buf: Buf, y: number): number => { while (y > 0 && buf.getLine(y)?.isWrapped) y--; return y; };
const runEnd = (buf: Buf, y: number): number => { while (y + 1 < buf.length && buf.getLine(y + 1)?.isWrapped) y++; return y; };

/// The hovered row's wrap-run, plus `EXTRA_RUNS` either side, as one string.
///
/// The neighbours are not padding for luck. xterm's `isWrapped` marks the rows the
/// *terminal* broke, and those join with nothing between them because the break was
/// never in the text. But the long path in an agent's answer was already broken by
/// the **agent**, at a space, before it ever reached us: that break is a real newline,
/// carries no wrap flag, and the row it ends is padded out with blank cells to the
/// full width. So a hard break joins with **one space** — the width of the padding is
/// an artifact of the window and the path on disk has a single space there, which a
/// literal join would turn into sixty and no candidate would survive.
///
/// Over-joining is safe for the same reason over-proposing is: a candidate spanning
/// two unrelated lines does not exist, so it is never underlined.
function joinRows(term: Terminal, y: number): JoinedRow {
  const buf = term.buffer.active;
  let first = runStart(buf, y);
  for (let n = 0; n < EXTRA_RUNS && first > 0; n++) first = runStart(buf, first - 1);
  let last = runEnd(buf, y);
  for (let n = 0; n < EXTRA_RUNS && last + 1 < buf.length; n++) last = runEnd(buf, last + 1);
  const text: string[] = [];
  const cells: { x: number; y: number }[] = [];
  const cell = buf.getNullCell();
  for (let ly = first; ly <= last && cells.length < MAX_JOIN; ly++) {
    // A hard break: separate the rows by the one space the padding stands for. Never
    // an endpoint of a candidate (those are `\S+` runs), so the cell it reports is
    // only ever passed over.
    if (ly > first && !buf.getLine(ly)?.isWrapped) {
      text.push(" ");
      cells.push(cells[cells.length - 1] ?? { x: 0, y: ly });
    }
    const line = buf.getLine(ly);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      // Width 0 is the right half of a wide glyph — one character, already counted.
      if (cell.getWidth() === 0) continue;
      const ch = cell.getChars() || " ";
      // Per UTF-16 unit, so a surrogate pair or a combining mark keeps `text` and
      // `cells` index-aligned; both halves report the cell the glyph starts in.
      for (let i = 0; i < ch.length; i++) cells.push({ x, y: ly });
      text.push(ch);
    }
    // Drop the row's trailing blanks along with it, so the separator above is the
    // whole of the gap rather than the start of a sixty-column one.
    while (text.length && text[text.length - 1] === " " && cells[cells.length - 1].y === ly) {
      text.pop();
      cells.pop();
    }
  }
  return { text: text.join(""), cells };
}

/// `[start, end)` in the joined string → the 1-based buffer range xterm underlines.
function mkRange(row: JoinedRow, start: number, end: number): TermLink["range"] | null {
  const a = row.cells[start];
  const b = row.cells[Math.min(end, row.cells.length) - 1];
  if (!a || !b) return null;
  return { start: { x: a.x + 1, y: a.y + 1 }, end: { x: b.x + 1, y: b.y + 1 } };
}

/// Where each pane's process is right now, cached briefly.
///
/// `Sess.workdir` is where a pane was *launched*, and for a shell that is half an
/// answer: `cd` is most of what a shell is for, and after one every relative path the
/// pane prints is relative to somewhere Episko has no record of. So the live cwd is
/// asked for and put FIRST among the bases.
///
/// The TTL is what keeps this off the hover path in practice — a burst of hovers over
/// one screenful asks once. It is deliberately short rather than event-driven: nothing
/// tells us about a `cd`, since a shell reports its directory to no one.
const CWD_TTL_MS = 3000;
const cwds = new Map<string, { at: number; dir: string }>();
async function liveCwd(id: string): Promise<string> {
  const hit = cwds.get(id);
  if (hit && Date.now() - hit.at < CWD_TTL_MS) return hit.dir;
  let dir = "";
  try { dir = (await invoke<string | null>("session_cwd", { sessionId: id })) ?? ""; }
  catch { /* the pane exited between the hover and the ask */ }
  cwds.set(id, { at: Date.now(), dir });
  return dir;
}

/// Ask disk which proposal is real. One round trip per start position, and the answer
/// is cached against the bases it was asked with — the file set grows as the session
/// works, and a path that did not resolve an hour ago may resolve now.
async function resolvePath(s: Sess | undefined, cands: PathCand[]): Promise<{ abs: string; end: number } | null> {
  // Most authoritative first: where the process is now, the checkout its work drifted
  // to, where it was launched. `linkBases` drops the empties and the duplicates.
  const dirs = s ? [await liveCwd(s.id), s.drift?.dir ?? "", s.workdir] : [];
  const bases = linkBases(dirs, (s?.files ?? []).map((f) => f.path));
  if (!bases.length) return null;
  const texts = cands.map((c) => c.text);
  const key = `${bases.join("\u0002")}\u0000${texts.join("\u0001")}`;
  let hit = resolved.get(key);
  if (hit === undefined) {
    try { hit = await invoke<[number, string] | null>("resolve_link_path", { bases, cands: texts }); }
    catch (e) { dlog("warn", `resolve_link_path failed: ${e}`); hit = null; }
    if (resolved.size > RESOLVED_MAX) resolved.clear();
    resolved.set(key, hit);
    // Why a path-shaped thing did not become a link, said once per distinct line
    // (the answer is cached above, so hovering it again is silent). This is the only
    // question this feature ever raises — "that IS a file, why is it not blue?" — and
    // without the bases in the message it cannot be answered from the outside.
    if (!hit) dlog("info", `link: nothing on disk for "${texts[texts.length - 1] ?? ""}" · ${bases.length} base(s), first ${bases[0] ?? "none"}`);
  }
  if (!hit) return null;
  const cand = cands[hit[0]];
  return cand ? { abs: hit[1], end: cand.end } : null;
}

async function openHref(url: string) {
  // Belt and braces with `allowNonHttpProtocols`: this is reached from OSC 8 payloads
  // a program controls, and the opener plugin's scope refuses the rest anyway.
  if (!/^https?:\/\//i.test(url)) { dlog("warn", `link ignored · not http(s) · ${url.slice(0, 80)}`); return; }
  try { await openUrl(url); }
  catch (e) { toast("Couldn't open the link: " + e); }
}

// The terminal's twin of ./actions' `openTouchedFile`, and deliberately a copy of its
// two lines rather than an import: ./actions imports *this* module, so the arrow has
// to keep pointing one way. Both surface the backend's error rather than swallowing
// it, for the reason stated there — a silent no-op reads as a broken button, while
// "no longer there" reads as the truth.
async function openFilePath(path: string) {
  try { await invoke("open_file", { path }); }
  catch (e) { toast(String(e)); }
}

async function provide(id: string, term: Terminal, y: number, cb: (links: TermLink[] | undefined) => void) {
  const row = joinRows(term, y - 1); // provideLinks counts rows 1-based; the buffer does not
  const hits = row.text.trim() ? findLinks(row.text) : [];
  if (!hits.length) { cb(undefined); return; }
  const s = sessions.get(id);
  const out: TermLink[] = [];
  // ./termlinks proposes freely and leaves the overlaps here, because only disk's
  // answer says how far a path actually reaches: on `src/a.ts and docs/b.md` the first
  // proposal's longest candidate covers the second, and almost always loses to a
  // shorter one. Two links over the same cells would let xterm underline whichever it
  // asked about first, so a clash is settled once — after resolution, first wins.
  const taken: [number, number][] = [];
  const claim = (a: number, b: number) => {
    if (taken.some(([x, y]) => a < y && x < b)) return false;
    taken.push([a, b]);
    return true;
  };
  for (const h of hits) {
    if (h.kind === "url") {
      const range = claim(h.start, h.end) ? mkRange(row, h.start, h.end) : null;
      if (range) out.push({ range, text: h.text, activate: () => { void openHref(h.text); } });
      continue;
    }
    const won = await resolvePath(s, h.cands);
    if (!won || !claim(h.start, won.end)) continue;
    const range = mkRange(row, h.start, won.end);
    if (range) out.push({ range, text: won.abs, activate: () => { void openFilePath(won.abs); } });
  }
  cb(out.length ? out : undefined);
}

/// Make this pane's output clickable. Called by every spawner right after
/// `term.open(pane)`; unlike `attachCustomKeyEventHandler`, xterm keeps every link
/// provider that is registered, so this composes rather than replacing.
export function wireLinks(id: string, term: Terminal) {
  term.options.linkHandler = { activate: (_e, text) => { void openHref(text); } };
  term.registerLinkProvider({ provideLinks: (y, cb) => { void provide(id, term, y, cb); } });
}

// Fit one terminal to its pane, push the new size to its PTY, and force a full
// repaint. The repaint is not cosmetic: on a resize the WebGL renderer only redraws
// cells its damage tracker flagged, so a cell that went glyph→blank can keep a stale
// glyph in the GL framebuffer (the "floating chars" past a shrunk table). refresh()
// re-rasterizes every visible row straight from the buffer, clearing those ghosts.
// Only ever call this on the *active* pane — an inactive one is display:none, so
// fit() would measure a zero-size box and resize the PTY to garbage.
export function fitSession(s: Sess) {
  if (!s.term || !s.fit) return;
  try {
    s.fit.fit();
    invoke("resize_pty", { sessionId: s.id, rows: s.term.rows, cols: s.term.cols });
    s.term.refresh(0, s.term.rows - 1);
  } catch { /* pane not measurable yet */ }
}
/// Re-measure whatever the stage is currently showing. With a run group tiled that is
/// several panes, not one — a window resize reflows the grid, so every visible pane's
/// cell changed size, and refitting only the focused one leaves the rest at the wrong
/// geometry (a wrapped, misaligned build log next to a correct one).
export function refit() {
  if (stageGroup) {
    for (const s of sessions.values()) if (s.run?.groupId === stageGroup) fitSession(s);
    return;
  }
  if (!activeId) return;
  const s = sessions.get(activeId);
  if (s) fitSession(s);
}
export function applyFontSize() { for (const s of sessions.values()) if (s.term) s.term.options.fontSize = termFontSize; refit(); localStorage.setItem("cc-term-font", String(termFontSize)); }
export function bumpFont(d: number) { setTermFontSize(Math.max(8, Math.min(28, termFontSize + d))); applyFontSize(); toast(`Terminal font ${termFontSize}px`); }

// The WebGL/canvas renderer bakes a glyph texture atlas on first paint. If the
// bundled Nerd Font (font-display:block) isn't ready yet, that atlas caches tofu
// boxes for the icon glyphs and never repaints them on its own. So force the font
// to load, then drop every open terminal's atlas once it's ready — the next frame
// re-rasterizes with real glyphs. Terminals opened after this point are already fine.
void (async () => {
  try {
    await Promise.all([
      document.fonts.load(`${termFontSize}px "JetBrainsMono Nerd Font"`),
      document.fonts.load(`bold ${termFontSize}px "JetBrainsMono Nerd Font"`),
    ]);
    await document.fonts.ready;
  } catch { /* Font Loading API unavailable — the browser still applies the @font-face */ }
  for (const s of sessions.values()) s.term?.clearTextureAtlas();
  // A session opened before the font arrived had its cell width measured against
  // the *fallback* metrics, so its column count (and the size we spawned Claude at)
  // is slightly off and stays off until the next resize. Re-fit now that the real
  // font's metrics are in, so the PTY width matches what we actually render.
  refit();
})();
