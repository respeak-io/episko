// The one DOM accessor the whole app uses. Every element it looks up is a static
// one declared in index.html, which is why the non-null assertion is honest here
// rather than optimistic — a miss is a typo, and it should throw at the call site
// instead of silently doing nothing.
//
// It lives alone in its own module because it is what a DOM-owning module (the
// debug console, the dialogs) needs from main.ts and nothing else; without this,
// extracting any of them would mean importing main.ts, which the dependency
// direction forbids. The shortcut-glyph helpers at the bottom are here for the same
// reason — the sidebar, the mini-rail, the palette and the footer all label controls
// with a chord, so no one of them can own it.
export const $ = (id: string) => document.getElementById(id)!;

// The one-line transient notice, bottom of the stage. A single element reused by
// everything, so a second toast replaces the first rather than stacking — which is
// why a caller that wants both a label and a consequence must say them in one string.
let toastT: number | undefined;
export function toast(m: string) { const el = $("toast"); el.textContent = m; el.classList.add("show"); clearTimeout(toastT); toastT = window.setTimeout(() => el.classList.remove("show"), 1900); }

// Which overlays share the single #scrim backdrop. Dropping it is conditional
// because several can be open at once (the palette over the settings window, say) —
// the last one to close is the one that clears it.
const SCRIM_DLGS = ["palette", "wtDlg", "diffDlg", "graphDlg", "setDlg", "histDlg", "callDlg"];
export function dropScrim() {
  if (!SCRIM_DLGS.some((id) => $(id).classList.contains("show"))) $("scrim").classList.remove("show");
}

/**
 * What is on the stage. Three panes stacked in `#terminals` — the session terminals,
 * the read-only mirror (`#extPane`, shared by external and dormant sessions) and the
 * project dashboard (`#dashPane`) — plus the "no sessions" card.
 *
 * WHY THIS IS ONE FUNCTION. Every opener used to hide its rivals by hand, and only two
 * of the four did it completely. `#extPane` and `#dashPane` are both `position:absolute;
 * inset:0` with no `z-index`, so DOM order alone decides, and `#dashPane` is second —
 * meaning an opener that shows the mirror without hiding the dashboard puts it *behind*
 * a pane that is still fully opaque. Nothing errors, nothing logs, and the header, the
 * inspector and `--accent` all update correctly, so the click reads as "it only changed
 * the colours".
 *
 * So a caller now says what it wants on screen and this hides the rest:
 *   • `session` — an Episko pane; the panes themselves carry `.active`
 *   • `ext`     — the read-only mirror (external OR dormant)
 *   • `dash`    — the project dashboard
 *   • `none`    — nothing; the empty card comes back
 *
 * `insp-mini` goes with it, and that is not a bolt-on: the 44px inspector rail is a
 * *dashboard-only* mode (it exists because the dashboard's verbs live nowhere else), so
 * anything else taking the stage must clear it or the next session inherits a rail
 * holding the wrong buttons.
 */
export type Stage = "session" | "ext" | "dash" | "none";
/// Bumped on every handover. `#inspector` belongs to whoever holds the stage — ./mirror
/// and ./dashboard write it as well as ./inspector — so a "what did I last paint here"
/// cache is only valid within one tenancy. This module cannot import any of them, and
/// does not need to: a number they can all read is the whole contract.
export let stageGen = 0;
export function takeStage(show: Stage) {
  stageGen++;
  ($("extPane") as HTMLElement).hidden = show !== "ext";
  ($("dashPane") as HTMLElement).hidden = show !== "dash";
  ($("empty") as HTMLElement).style.display = show === "none" ? "grid" : "none";
  if (show !== "dash") $("app").classList.remove("insp-mini");
}

// Platform-aware shortcut hints. Display only: the key handlers already accept
// both modifiers (`e.metaKey || e.ctrlKey`), so only the glyphs differ per OS.
// Nothing below touches the DOM at module scope, deliberately: ./debug imports this
// module, so vitest pulls it into the node environment via every logic module that
// logs. The one-time rewrite of index.html's hard-coded ⌘ glyphs is bootstrap and
// stays in main.ts for exactly that reason.
// `navigator` is a *browser* global, and the note above promises this module is safe
// to import from vitest's `node` environment — which it was not: `globalThis.navigator`
// only exists from Node 21, so on the Node 20 CI pins, every suite that transitively
// reaches this file died at import with "navigator is not defined". It passed locally
// purely because the dev machine ran a newer Node. Read it defensively so the promise
// is actually true; in the WebView the app ships in, the fallback never fires.
const UA = typeof navigator === "undefined" ? "" : navigator.userAgent;
export const IS_MAC = UA.includes("Mac");
export const IS_WIN = UA.includes("Windows");
// Which OS is a different question from whether there is a *window* — in dev the
// frontend is plain HTML on vite's port, so it opens in a browser too, and there
// the user-agent still says "Windows" while nothing exists to minimize, maximize
// or drag. Anything that acts on the native window has to ask this as well (see
// the title-bar block in main.ts), or a browser tab grows controls that only
// throw. Tauri defines `isTauri` from an initialization script that runs before
// any page script, so reading it at module scope is honest; the `window` guard is
// vitest's node environment again, exactly like the UA read above.
export const IS_TAURI = typeof window !== "undefined" && "isTauri" in window;
export const MOD = IS_MAC ? "⌘" : "Ctrl";
/** Where "open folder" actually lands, so a row, shortcut or command can name it. */
export const FILE_MANAGER = IS_WIN ? "Explorer" : IS_MAC ? "Finder" : "file manager";
/** Inline chord text: "⌘K" on macOS, "Ctrl+K" elsewhere. */
export const chord = (k: string) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);
