// The app's own yes/no dialog — the thing every confirmation in Episko goes through.
//
// WHY THIS EXISTS. All ten of these questions used to be `ask()` from
// tauri-plugin-dialog, which draws a *native* box: a Windows task dialog, a macOS
// sheet. Three things were wrong with that, and none of them are fixable from the
// call site:
//
//   • It looks like a different program. System font, system chrome, square on top of
//     an app whose every other surface is a blurred violet panel — and on Windows it
//     arrives with the OS ding.
//   • It cannot say which answer is the dangerous one. "Remove worktree" and "Cancel"
//     come back as two identical grey buttons in whatever order the platform likes,
//     so the one that deletes a checkout reads exactly like the one that doesn't.
//   • It renders the message as one flat blob of text. Every one of these messages was
//     written with paragraphs, and one of them with a bullet list of the processes it
//     is about to kill; the native box shows the newlines and nothing else.
//
// So the markup is ours now. `ask` keeps the plugin's signature *exactly* — same
// message string, same `{ title, kind, okLabel, cancelLabel }` — because the ten call
// sites' wording was already reviewed prose and this change is about the box, not the
// words. Swapping the import is the whole diff at each one. test/confirm.test.ts is
// what stops the plugin's `ask` creeping back in beside it.
//
// The one native dialog that stays is the *file picker* (`open`, in ./actions and
// ./icons). That one is not chrome we are imitating badly — it is the OS's file
// browser, with its sidebar, its recents and its permissions, and an in-app copy would
// be strictly worse.

import { $ } from "./dom";
import { dialogBody } from "./format";

/** The plugin's option bag, kept name-for-name so a call site reads unchanged. */
export type AskKind = "info" | "warning" | "error";
export interface AskOpts {
  title: string;
  /// Decides the glyph, the accent and — the part the native box could not do — whether
  /// the confirming button reads as destructive. `info` is the only one that doesn't.
  kind?: AskKind;
  okLabel?: string;
  cancelLabel?: string;
}

// A letter in a box rather than ⚠/ℹ️: those two are emoji-presentation on Windows in
// half the fonts we might land in, so they arrive as full-colour stickers next to
// 11px UI text. A glyph we draw the box for renders the same everywhere.
const GLYPH: Record<AskKind, string> = { info: "i", warning: "!", error: "!" };

/// Resolver for the question currently on screen; null when nothing is up.
let settleOpen: ((v: boolean) => void) | null = null;
/// Questions that arrived while one was already up. The scrim blocks the pointer, so
/// the only way to get here is async code (the quit guard firing mid-removal, say) —
/// and the honest answer to that is to ask both, in order, rather than to silently
/// cancel one of them.
const waiting: Array<() => void> = [];
/// What had focus before we took it, so Esc puts the caller back where it was — the
/// worktree dialog's list, the task manager's row.
let restoreFocus: HTMLElement | null = null;

/**
 * Ask a yes/no question. Resolves `true` only for the confirming button — Esc, the
 * cancel button and a click on the backdrop all resolve `false`, which is the same
 * contract the plugin's `ask` had, and the reason no call site needed rewriting.
 */
export function ask(message: string, opts: AskOpts): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const run = () => paint(message, opts, resolve);
    if (settleOpen) waiting.push(run);
    else run();
  });
}

function paint(message: string, opts: AskOpts, resolve: (v: boolean) => void) {
  const kind: AskKind = opts.kind ?? "info";
  const ok = opts.okLabel ?? "OK";
  const cancel = opts.cancelLabel ?? "Cancel";
  settleOpen = resolve;
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  $("cfmIc").textContent = GLYPH[kind];
  $("cfmTitle").textContent = opts.title;
  $("cfmBody").innerHTML = dialogBody(message);
  // textContent, not markup: these are button faces, and a label is a label.
  $("cfmYes").textContent = ok;
  $("cfmNo").textContent = cancel;

  const dlg = $("cfmDlg");
  dlg.className = `cfm k-${kind}`;
  // `info` is the only kind whose confirming button is not a loss: everything else here
  // ends a session, deletes a checkout or terminates somebody else's process.
  $("cfmYes").className = kind === "info" ? "cfm-btn go" : "cfm-btn danger";
  dlg.classList.add("show");
  $("cfmScrim").classList.add("show");
  // After the class lands, so the browser has a laid-out element to focus. Focus goes
  // to the confirming button because ⏎ confirms — the ring has to agree with the key.
  setTimeout(() => ($("cfmYes") as HTMLElement).focus(), 30);
}

function settle(v: boolean) {
  const r = settleOpen;
  if (!r) return;
  settleOpen = null;
  $("cfmDlg").classList.remove("show");
  $("cfmScrim").classList.remove("show");
  // Its own backdrop, never the shared #scrim: these open *over* the worktree dialog
  // and the task manager, and sharing would mean either dropping their backdrop out
  // from under them or teaching `dropScrim` about a dialog that outranks all of them.
  restoreFocus?.focus();
  restoreFocus = null;
  r(v);
  // Only after the resolver has run, so a caller that asks a second question from its
  // own `.then` is the one that gets in next rather than racing the queue.
  waiting.shift()?.();
}

$("cfmYes").addEventListener("click", () => settle(true));
$("cfmNo").addEventListener("click", () => settle(false));
// Backdrop dismiss is safe here and only here: the answer it gives is always the
// non-destructive one.
$("cfmScrim").addEventListener("click", () => settle(false));

/**
 * The modality. A native dialog owned the whole window; this one has to earn that.
 *
 * Registered at module scope and in the CAPTURE phase deliberately. main.ts's own
 * `keydown` listeners — the shortcut dispatcher, the Esc chain, and the capture-phase
 * one for `reveal` — are added at the bottom of *its* module body, which runs after
 * every module it imports. So this handler is registered first and, on the same target
 * in the same phase, first registered is first called. That ordering is the whole
 * mechanism: without it ⌘K would open the palette *underneath* a question you have not
 * answered yet.
 *
 * Everything is stopped while a question is up, not just the three keys handled here,
 * because the alternative is the app's fourteen shortcuts staying live behind a modal.
 *
 * `stopImmediatePropagation`, never plain `stopPropagation` — and that distinction is
 * load-bearing rather than defensive. Stopping propagation moves the event on from the
 * *node*, so it does block main.ts's bubble-phase dispatcher (the event never reaches
 * the target, so it never comes back up). It does NOT block another listener on the
 * same node in the same phase, and main.ts has exactly one: the capture-phase handler
 * for `reveal`. Registered after this one, on `window`, in capture — so with the weaker
 * call ⌘⇧⏎ opened a Finder window from behind an unanswered "Remove worktree?".
 *
 * `preventDefault` is deliberately NOT part of the blanket: a `<button>` activates on
 * Space by its default action, and cancelling it would leave the two buttons keyboard-
 * dead for the one key most people reach for.
 */
window.addEventListener("keydown", (e) => {
  if (!settleOpen) return;
  const dlg = $("cfmDlg");
  const inside = e.target instanceof Node && dlg.contains(e.target);
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); settle(false); return; }
  if (e.key === "Enter") {
    e.stopImmediatePropagation();
    // A focused button already turns ⏎ into a click, and that click knows which button
    // it was. Answering here as well would make ⏎ confirm even with Cancel focused.
    if (!(document.activeElement instanceof HTMLButtonElement && dlg.contains(document.activeElement))) {
      e.preventDefault();
      settle(true);
    }
    return;
  }
  if (e.key === "Tab") {
    // Two buttons, so the trap is a toggle rather than a ring walk.
    e.preventDefault(); e.stopImmediatePropagation();
    const on = document.activeElement === $("cfmYes") ? "cfmNo" : "cfmYes";
    ($(on) as HTMLElement).focus();
    return;
  }
  e.stopImmediatePropagation();
  if (!inside) e.preventDefault();
}, true);
