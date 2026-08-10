# Project history: the commit graph panel

> Rules and their reasons, compressed. The full narratives live in git history (CLAUDE.md before the split). Trust the code over the docs when they disagree, and fix the doc in the same commit.

Opened from the project right-click menu (`Commit graph…`) and the dashboard inspector, never the header: history is a question you go looking for. The menu row drops when the folder isn't a repo (`git_head` already answered).

**The invariant is "never read a whole history", and it holds at both ends**: nothing runs until opened; then ONE page (`git log --skip=<n> -n <PAGE+1>`), next page only on scroll.

- **`more` is an observation** (one commit past the page) rather than a count, since counting means the walk this exists to avoid.
- **`--date-order`, not `--topo-order`**: paging by recency needs page 1 newest *across* refs; topo pulls a stale branch's whole chain forward.
- **`--decorate=full`**: short ref names can't be classified; `parseRefs` reads `refs/heads|remotes|tags`.
- **Not a repo → `Err`; a repo with no commits → an empty page**: git is inconsistent here and the panel must tell them apart.

Split: **`graph.ts` pure and tested** (lanes, naming, chips, geometry, `rowSvg`); **`graphview.ts`** owns dialog, IPC, scroll. `layoutGraph` re-runs over the whole accumulated list per page, which is cheap and keeps lanes consistent across page boundaries with no inter-fetch state.

**Lane naming** (each rule below was observed wrong on this repo's own history first); rows carry `label` (their line) and `merged` (what a merge took in):

- A row's label is the nearest ref **above** it on its own line rather than the line's first.
- **A tag never names a line** (labels propagate down; tags stay chips).
- What a merge took in is read from a ref **below** it, falling back to the merge subject (marked `from: "merge"`, the last place a deleted branch's name survives); `mergeBranchName` matches only git's/GitHub's own phrasings, because a guessed lane name is worse than a blank one.

**Chips are reduced rather than listed** (`refChips`): a local branch absorbs its remote twins (`main ⇡`), an unmatched remote keeps `origin/` (the prefix *is* the difference), `origin/HEAD` is dropped, order is fixed HEAD → local → remote → tag (the leftmost survives a narrow column), the tail folds to `+N`. Chips never flex-shrink; each has its own ceiling with ellipsis, the column *fades* overflow. Inside a chip only the name truncates; the `⇡` sits in a non-shrinking span.

**Layout couplings**: `.grow`'s CSS height must equal `ROW_H` (lanes are drawn edge-to-edge per row; nothing may add to a row's box, so selection is a background plus inset shadow rather than a border). The trailing columns are fixed-width (each row is its own grid; `auto` would stagger per author name). **The graph and the chips are ONE measured cell** (`sizeLeftColumn`): each row's SVG spans only the lanes that row touches, so chips land against the real silhouette. Sizing the two separately left ~100px of dead column in a many-lane repo.

**A row shows a subject; a message is prose.** The detail strip is a two-line summary; the full message opens in an overlay *inside* the dialog (`⤢`, ⏎, double-click), so the graph stays behind it, ↑/↓ still walk commits, and **Esc steps out one layer** (main.ts calls `graphEscape`, not `closeGraph`). The message is fetched **per commit** (`git_commit_message` → `git show -s --format=%B`, cached by sha). Carrying `%b` on every page forced a length cap that truncated the one message being read. The command refuses non-hex object names (a leading dash would read as an option). The strip's `⤢ Full message` and the overlay's `✕ Close` share one footprint (`.gswap`; `.graph-detail`'s 64px height puts them on the same pixels), so closing takes no mouse travel by construction.

**Naming trap**: `gc-*` is the ref-chip prefix, so the overlay's own classes are `gco-*`; `.gc-head` on the overlay header gave every HEAD chip a header's padding.

**A narrow panel gives up in order** (container queries on the *dialog*, not viewport): the date shortens (`2 days ago` → `2d`, both rendered, CSS picks), then the sha column, then author and header path. **The subject never yields.** It did, because an `fr` track gives up before fixed ones; it is now `minmax(0, var(--gleft-w))` with a floor, and the measured cap is also bounded by a share of panel width (`sizeLeftColumn`, re-run on resize, the one rung of the ladder in JS).

Lane colours are `--gl-0…7`, re-stepped for the light theme. Scope (`all refs` / `this branch`) resets on each open, deliberately not persisted, since all-refs is the answer the panel exists to give.
