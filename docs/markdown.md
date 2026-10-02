# The markdown reader (`markdown.ts`, `mdreader.ts`)

A `.md` file opened from inside the app is read in `#mdDlg` rather than handed to the OS. The
three entry points are the ones that already opened files: a MOD+click on a path in a pane
(`openFilePath` in ./terminal), a Context-card row and ⌘P's ↵ (`openTouchedFile` in ./actions).
All of them call `openFileOrRead`, the ONE place that decides reader vs. OS; don't add a second
extension test at a call site. `cc-markdown` holds the Settings › Reader choices.

## The document is untrusted, and the webview is not sandboxed

`tauri.conf.json` sets `csp: null` and the reader lives in the main webview, so a script that
got into a rendered README could call every `#[tauri::command]` the app has. The renderer is
`marked` (GFM), and ./markdown overrides every token that could carry author markup:

- **Raw HTML never passes.** `htmlOut` keeps a short list of tag *names* (`kbd`, `sup`,
  `details`, …) and drops every attribute; any other tag is removed and its text kept. An
  `<img>` is re-emitted as one of ours, so a centred README logo still shows.
- **No link carries its URL as an `href`.** Every link is `href="#"` plus `data-mdurl` (http(s)
  and mailto only), `data-mdfile` (a path resolved against the document) or `data-mdanchor`.
  Any other scheme renders as text. mdreader's own click listener decides what each means.
- **Images.** A local image is `data-mdimg` with no `src`; mdreader reads it through
  `read_md_image` as a data URI (there is no asset protocol). A web image gets a `src` only when
  *Load images from the web* is on (off by default: a fetch tells the server you opened the file).
- Heading anchors are `data-mdh`, never `id`: a document's `#settings` must not collide with the
  app's own ids.

`test/markdown.test.ts` renders a list of hostile inputs and asserts no tag, handler, `style`,
`javascript:` or `src` survives. Add a case there before loosening anything above.

## The backend half

`read_markdown` and `read_md_image` (platform.rs) each check the extension themselves (`MD_EXTS`,
`image_mime`), so neither is a general file reader whatever the frontend sends. A document is cut
at 4 MiB and says so; an image over 12 MiB is refused with the reason drawn in its place.

## Links between documents

`resolveHref` resolves against the document's folder; a leading `/` resolves against the project
holding the document (the longest open session workdir that prefixes it), as GitHub does. A
markdown target opens in place and pushes onto the back stack; any other file goes to the OS.
