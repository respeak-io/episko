# Native UI: one title bar, and the tray menu

> Rules and their reasons, compressed. The full narratives live in git history (CLAUDE.md before the split). Trust the code over the docs when they disagree, and fix the doc in the same commit.

## One title bar: the header

The app draws its own header, so the native bar is gone on both platforms, by different routes, and the difference is the point:

- **macOS keeps its decorations**: `titleBarStyle: "Overlay"` + `hiddenTitle`, the *real* traffic lights floated over `.top` (drawing our own loses the green button's zoom-or-fullscreen duality); `html.mac` reserves the gap, `html.fs` closes it in fullscreen. **`trafficLightPosition.y` is not the gap above the buttons**: tao sizes the titlebar container to `button_height + y` and AppKit keeps the button at `origin.y = 9` of a 14pt button, so the visible gap is `y − 9` and centring wants `9 + (H − 14) / 2`, giving **22** for today's 40px `.top`; the arithmetic is checkable in a ten-line `swift` script against a bare `NSWindow`, cheaper than a rebuild per guess.
- **Windows**: `decorations: false`, `#winCtl` draws minimize/maximize/close.
- **A browser gets neither**: the same HTML opens on vite's port, and `IS_WIN` is a user-agent read, so everything acting on the native window gates on **`IS_TAURI`** (`dom.ts`), including the platform class itself (no class → CSS shows no controls, reserves no gap).

Easy to get wrong:

- **The window is built in `setup()` rather than by the config** (`"create": false`): `decorations` is not a per-platform config key, and a `tauri.windows.conf.json` would replace the whole `windows` array. **Flipping it after creation behaves differently**: tauri attaches its undecorated-resize child window only when the webview is created over an *already* undecorated window; a late flip yields edges that cannot be dragged. (tao does not drop `WS_CAPTION`; it zeroes the non-client area, keeping shadow/corners/snap, so a style-bit check reads "decorated" either way; measure `GetClientRect` vs `GetWindowRect` instead: 1px inset here, 30 with a bar.)
- **Dragging is `data-tauri-drag-region="deep"`** on the header, which excludes only what the DOM calls clickable. `#kbar` is a `<div>` with a click listener, so it opts out explicitly (`="false"`), or the drag swallows its mouseup and ⌘K stops opening with nothing logged.
- **Close goes through the OS close request** (`win.close()`), giving the same `quit-requested` confirm as Ctrl+Q, never around the guard.
- **Maximize is only asked for**; the glyph flips on the `onResized` that comes back (also catching Win+↑, snap, and the drag region's own double-click; the same listener tells macOS it entered fullscreen).

## No OS dialogs: `confirm.ts`

The same argument as the title bar, one layer up. Every yes/no question was
`ask()` from `tauri-plugin-dialog`, which draws the platform's own box; all ten now go
through `ask` in `confirm.ts`, which keeps that function's exact signature so a call
site changes only its import.

- **The reason is not only that it looked foreign.** A native box cannot say which of
  its two buttons is the destructive one — "Remove" and "Cancel" come back as two grey
  buttons in whatever order the platform prefers — and it flattens a message written in
  paragraphs into one blob. `kind` now picks the button: `info` accent, `warning`/
  `error` red. `dialogBody` (`format.ts`) reads the message's blank lines, bullets and
  backticks, so the prose stays plain text and is edited where it is written.
- **`open` stays native and must.** That one is the OS *file browser* — sidebar,
  recents, permissions — and an in-app imitation is strictly worse. It is the only
  export of that plugin still imported anywhere; `test/confirm.test.ts` fails on any
  other, in any module.
- **It has its own backdrop, not `#scrim`.** These open *over* `#wtDlg` and `#mgrDlg`,
  so sharing would mean pulling the backdrop out from under the dialog that asked, or
  teaching `dropScrim` about a dialog that outranks everything it lists. z-index 90/91,
  above every other overlay; the contract test asserts nothing outranks it.
- **A modal has to actually own the keyboard**, and one capture listener is not enough
  to do it. `confirm.ts` registers its `keydown` at module scope so it runs before
  main.ts's (added later, same target, same phase), and calls
  **`stopImmediatePropagation`** — the weaker `stopPropagation` blocks main.ts's
  *bubble* dispatcher but not its capture-phase listener for `reveal`, which is how
  ⌘⇧⏎ opened a Finder window from behind an unanswered "Remove worktree?". Esc, the
  cancel button and a backdrop click all resolve `false`; a question raised while
  another is up queues behind it rather than cancelling it.
- **Closed means `visibility: hidden`, not just `opacity: 0`.** The app's older
  overlays get away with opacity alone; this one has two buttons that answer a
  destructive question, and an invisible "Remove worktree" left in the tab order is
  reachable by ⇥ from anywhere in the app.

## The tray menu

The OS owns the font, row height, highlight and radius; Episko controls each row's string and its 16px image. Sessions group under their project and carry status as a coloured icon beside a `title · status` label, the title being Claude's own OSC summary of the conversation (clipped to one line; the branch fills in until a summary arrives); the header row says which repo. The menu is as wide as its widest row, so the clip length in `tray.ts` is the width policy.

- **Menu item text is always drawn in the menu's own colour**: glyphs in labels (`◆` waiting, `✕` died) arrived Quit-grey. Icons are images and are **not** tinted, which is the whole reason they exist.
- **Therefore the icon must not be a template image**, the exact opposite of the tray icon in `run()`, which *is* one. Swap the two and every dot comes out menu-grey.
- **The frontend picks shape and colour, Rust only rasterises**: `GCLASS` maps status → class, `styles.css` gives the hue, `tray.ts` reads it back (`classRgb`); a palette copied into Rust would part from the sidebar at the first re-step (`g-ended` already differs between themes).
- **32px source**: muda scales to an 18pt row on macOS and blits into a hard-coded 16×16 on Windows, and 32 halves exactly for one and still out-resolves the other on retina.
- **A project header is a *disabled* item, and disabled is load-bearing**: the menu handler treats every unrecognised id as a session to select (the `sid` catch-all); disabled items fire no `MenuEvent`. Anything new needs a matched id or `enabled(false)`.
- **The signature guard covers the icons**: shape and colour are in the signature alongside the label, because a shell going live→ended changes no wording but must repaint.

Windows has no `set_title` (icon only); whether the 16×16 blit reads well there is a `RELEASE.md` click-through.
