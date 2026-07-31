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
const SCRIM_DLGS = ["palette", "wtDlg", "diffDlg", "setDlg", "histDlg"];
export function dropScrim() {
  if (!SCRIM_DLGS.some((id) => $(id).classList.contains("show"))) $("scrim").classList.remove("show");
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
