// The app's own yes/no dialog. `ask` keeps tauri-plugin-dialog's signature so a call site changes
// only its import; the OS file picker (`open`) is the one native dialog left (docs/native-ui.md).

import { $ } from "./dom";
import { dialogBody } from "./format";

export type AskKind = "info" | "warning" | "error";
export interface AskOpts {
  title: string;
  kind?: AskKind; // `info` gets the accent button; `warning`/`error` mark the confirming button destructive
  okLabel?: string;
  cancelLabel?: string;
}

// A letter in a box rather than ⚠/ℹ️, which arrive as colour emoji in half the Windows fonts.
const GLYPH: Record<AskKind, string> = { info: "i", warning: "!", error: "!" };

let settleOpen: ((v: boolean) => void) | null = null; // resolver of the question on screen
// Questions raised while one is up are asked afterwards, in order, never dropped.
const waiting: Array<() => void> = [];
let restoreFocus: HTMLElement | null = null;

/** Resolves `true` only for the confirming button; Esc, Cancel and the backdrop resolve `false`. */
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
  $("cfmYes").textContent = ok;
  $("cfmNo").textContent = cancel;

  const dlg = $("cfmDlg");
  dlg.className = `cfm k-${kind}`;
  $("cfmYes").className = kind === "info" ? "cfm-btn go" : "cfm-btn danger";
  dlg.classList.add("show");
  $("cfmScrim").classList.add("show");
  // After the class lands, so there is a laid-out element to focus; ⏎ confirms, so Yes gets the ring.
  setTimeout(() => ($("cfmYes") as HTMLElement).focus(), 30);
}

function settle(v: boolean) {
  const r = settleOpen;
  if (!r) return;
  settleOpen = null;
  $("cfmDlg").classList.remove("show");
  $("cfmScrim").classList.remove("show"); // never the shared #scrim: the dialog under us still needs it
  restoreFocus?.focus();
  restoreFocus = null;
  r(v);
  // `r(v)` only schedules the caller's continuation, so drain a microtask later: a follow-up
  // question it asks must paint before a queued one, and its own `settle` then drains the queue.
  queueMicrotask(() => { if (!settleOpen) waiting.shift()?.(); });
}

$("cfmYes").addEventListener("click", () => settle(true));
$("cfmNo").addEventListener("click", () => settle(false));
$("cfmScrim").addEventListener("click", () => settle(false));

// Capture phase at module scope, so it runs before main.ts's keydown listeners (same target and
// phase, added later). `stopImmediatePropagation`, never plain `stopPropagation`: only the former
// also blocks main.ts's capture-phase `reveal` handler. No blanket `preventDefault`: buttons need Space.
window.addEventListener("keydown", (e) => {
  if (!settleOpen) return;
  const dlg = $("cfmDlg");
  const inside = e.target instanceof Node && dlg.contains(e.target);
  if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); settle(false); return; }
  if (e.key === "Enter") {
    e.stopImmediatePropagation();
    // A focused button already turns ⏎ into a click; answering here too would confirm with Cancel focused.
    if (!(document.activeElement instanceof HTMLButtonElement && dlg.contains(document.activeElement))) {
      e.preventDefault();
      settle(true);
    }
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault(); e.stopImmediatePropagation(); // two buttons, so the focus trap is a toggle
    const on = document.activeElement === $("cfmYes") ? "cfmNo" : "cfmYes";
    ($(on) as HTMLElement).focus();
    return;
  }
  e.stopImmediatePropagation();
  if (!inside) e.preventDefault();
}, true);
