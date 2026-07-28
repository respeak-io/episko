# design/

Where interface work happens before it becomes code.

| File | What |
| --- | --- |
| `mockkit.css` | Episko's visual language packaged for mockups — tokens, the shell grid, and the components that recur (chips, actions, pills, rows, meters, palette, toast). |
| `prototype.html` | The Phase-0 cockpit mock. Historical: it is where the current chrome was designed. Not maintained against the app. |
| `appicon.png` | Source for the bundle icon. |

## Building a mock

Mocks are published as Claude artifacts, which are **one self-contained file** —
a strict CSP blocks external stylesheets, fonts and scripts. So a mock cannot
`<link>` this kit; paste `mockkit.css` into a `<style>` block at the top and write
only the page-specific CSS after it.

That is the whole workflow, and the reason the kit exists: without it every mock
re-derives the shell from `src/styles.css`, drifts a little, and the next one
drifts differently.

```html
<style>
  /* ── mockkit.css (pasted verbatim) ───────────────────────── */
  …
  /* ── this mock only ──────────────────────────────────────── */
  .dash { … }
</style>

<div class="app framed no-insp" style="height:min(720px,80vh)">
  <header class="top">…</header>
  <aside class="rail">…</aside>
  <main class="stage">…</main>
  <footer class="foot">…</footer>
</div>
```

Shell variants: `framed` (bounded window inside a document, instead of filling the
viewport), `no-insp` / `insp-off` (drop the inspector column), `rail-mini` (54px
icon rail). Overlays — `.scrim`, `.palette`, `.pop`, `.toast` — are positioned
against the shell, so `framed` keeps them inside the window.

## Two rules

- **Sync tokens in the same commit.** `mockkit.css` copies its `:root` block from
  `src/styles.css`. A kit that has drifted is worse than no kit, because the mock
  still looks plausible while showing colours the app doesn't have.
- **Dark only, on purpose.** The app ships a light theme; a mock is judged against
  one ground. If a mock genuinely needs both, copy the `:root[data-theme="light"]`
  block out of `src/styles.css` — the artifact runtime stamps `data-theme` on the
  root element to match the viewer.

## Published mocks

Private artifacts on claude.ai; the URL is the live copy, this list is the index.

| Mock | Link |
| --- | --- |
| Project start screen (fixed layout) | https://claude.ai/code/artifact/fdc21958-f2b0-41d2-a836-a02a7573663f |
| Project dashboard (configurable widgets — rejected as too busy) | https://claude.ai/code/artifact/83f10da5-59f2-4a4f-9677-243933582c6d |
| Oversee the fleet (concept page) | https://claude.ai/code/artifact/fca71414-3cce-4d0d-ac6d-3c2c654822fa |
| Limit forecast | https://claude.ai/code/artifact/d0a6e8ab-e740-447f-b0bb-10f355224df9 |
| Usage & spend | https://claude.ai/code/artifact/a0c01607-668d-437a-9fc4-25a3f67d4134 |
| Settings redesign | https://claude.ai/code/artifact/59e595ea-157f-4dfd-bafe-b20055ec5746 |
| Cockpit redesign | https://claude.ai/code/artifact/ae43e98c-75ec-4680-961f-e473a7dd8077 |
| Interface prototype (Phase 0) | https://claude.ai/code/artifact/58983952-f52c-4338-af1d-6dab86587573 |
