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
import { IS_WIN, toast } from "./dom";
import { dlog } from "./debug";
import { basename, tilde } from "./format";
import type { Sess } from "./types";
import { activeId, sessions, setTermFontSize, stageGroup, termFontSize } from "./state";

// Leads with the bundled Nerd Font (see @font-face in styles.css) so the terminal
// draws powerline / devicon glyphs on every OS; the rest stay as graceful fallbacks.
export const MONO = '"JetBrainsMono Nerd Font", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

export function loadWebgl(term: Terminal) {
  try {
    const w = new WebglAddon();
    w.onContextLoss(() => w.dispose()); // fall back to the DOM renderer
    term.loadAddon(w);
  } catch { /* WebGL unavailable — DOM renderer is fine */ }
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
  catch (e) { dlog("error", `clipboard write failed: ${e}`); toast("Couldn't copy — clipboard unavailable"); }
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
  catch (e) { dlog("error", `clipboard read failed: ${e}`); toast("Nothing to paste — no text on the clipboard"); return; }
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
          toast("Ctrl+C interrupts — use ✕ or /exit to end the session");
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

// Claude prepends an animated spinner to its OSC title: it cycles through braille
// dots (U+2800-U+28FF) and an eight-spoked asterisk (U+2733), e.g. a braille dot or
// a star before "Fixing the bug". Strip any leading run of those so the sidebar
// shows a steady summary; our own status stays in the row's colored .sglyph column.
// Missing the braille range is what left the title glyph flickering. (CC 2.x OSC.)
const TITLE_DECOR = /^(?:[\s•·∙⋅●○◦◆◇✦✧★☆✨✩-✷✺-✽∗＊*⏺⬤⭐⠀-⣿\uFE0F\u200D]|\u{1F31F})+/u;
// Claude Code sets the terminal title (OSC) to an auto-summary; keep it unless it's
// just the folder path/name (which we already show).
export function cleanTitle(t: string, s: Sess): string {
  const x = (t || "").replace(TITLE_DECOR, "").trim();
  if (!x) return s.title;
  if (x === s.workdir || x === tilde(s.workdir) || x === s.project || x === basename(s.workdir)) return "";
  return x;
}

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
