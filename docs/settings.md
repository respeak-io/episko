# Settings (`settings.ts`, `setsearch.ts`)

One scrolling page, a rail that is a table of contents, and a search. `SET_TABS` is still
the one declarative table; `SET_GROUPS` names the three headings and each tab carries its
`group`. A section is named for the surface or the question (*Sidebar*, *Attention*, *On its
own*), never for the feature that shipped it: the old rail read as a changelog.

## The page

- Every visible tab paints in order into `#setBody`, each under a sticky `.set-sech`. `setTab`
  is what the rail lights. The spy sets it on scroll: **the last section whose top is above the
  reading line**, a third of the way down the pane. Not the last header above the *top edge* —
  that rule lit a long section's neighbour for the whole of its last screenful, which is the
  one question the rail exists to answer.
- **The line, not a count of visible pixels**, though "the section filling most of the pane" is
  the obvious reading of the same complaint. On pixels a slim section can never win: *Keys* is
  one row (94px) beside a 300px *Diagnostics*, so it would never light at all, and neither
  would *Guide*. Under a line every section owns the rail for its own height of scrolling.
- **The line slides where the scroll cannot follow**: it is the top edge until the first
  screenful has been scrolled and it reaches the pane's foot as the scroll runs out
  (`Math.min(scrollTop, Math.max(h / 3, h - left))`). The sections at either end are otherwise
  unreachable — nothing can scroll the last screenful's three sections up to a fixed line, so
  a first try at this lit *Guide* at the bottom and never lit *Diagnostics* at all. The
  invariant the whole rule keeps: the section the rail names is always on screen.
- A click sets the tab and scrolls, and `spyHold` keeps the spy out of the smooth scroll it
  started. The tour reads `.set-tab.on` as `settingsTab`, so `goToTab` marks the tab itself
  rather than leaving it to a scroll that may never happen.
- `openSettingsOn(tab, row?)`: the quick opens, the ⑃ dialog, ⌘K and the tour land on a row
  lit for three seconds (`.set-lit`). `row` is the control's `id`, else its `set` verb, else
  its kind (`rowId`). Keep those stable: they are addresses. With no `row`, a row that shares
  the section's id is taken (`keys`), so a one-row section lights its row.
- A row is the label, `hint` (one sentence, on the page), `more` behind *why* (`openWhy`), the
  control on the right, and under it whatever folds (`openPanels`): the six panels, a toggle's
  preview, the agent's cards, a multi's chips. An action's preview is its answer and never
  folds. A seg with no logo is an inline picker with the active option's sub under the label.
- **A switch and the one number it governs are ONE row** (`cadence` on a toggle: auto-fetch's
  interval, the vitals sample rate). Split in two they were a riddle — *At most every · how
  old a count may get before arriving at the pane fetches again* reads as nothing, because the
  subject was in the row above. The cadence is `segInline` beside the switch, its active sub
  under the hint, and both dim (never disable) while the switch is off, so the stored choice
  survives. One `isDefault`/`reset` covers both halves; the search reads a cadence's options
  and labels as the row's own.
- **A `multi` with an empty list is not a picker**: no fold, the summary as plain text, and
  `empty` on the row saying where the list *is* filled. A dropdown that opens on one sentence
  reads as a control that does nothing — and both of these (stop rules, hand-trusted folders)
  are only ever filled elsewhere.
- `isDefault`/`reset` per control give the accent bar, ⟲ on hover and `@changed`. A control
  without `isDefault` is never marked; a list with no safe reset (trusted folders, stop rules)
  has none. `summary` is the fold button's text and the search's `value`.
- The rail ends with *Elsewhere*: Usage & spend and What's new keep their own windows
  (0.26.0). The doors call the openers through the host, and two pointer rows answer the
  search for them, because a search in Settings that says there is no such thing is worse
  than a report inside Settings.

## The search (`setsearch.ts`, pure)

- `parseQuery`: words plus `@changed` `@new` `@mac` `@in:<section|heading>` `@key:<cc-…>`. An
  unknown `@` word is reported in the status line, never ignored.
- `matchRow`: the filters first, then every word must match one field. The first field found
  wins and is the one reported: label 10 (+4 as a prefix), section 6, value 5, option 5,
  panel line 4, alias 4, key 4, hint 3, more 2 (the line ahead of the alias, so a hit
  inside a panel opens it). With no whole-word hit anywhere, letters in
  order in the label match and the hit is flagged `fuzzy`; the status line says so.
- A hit on an option, an alias, the key or a panel line shows under the row as *matched …*,
  because a row that appears for no visible reason teaches you the search is broken. A panel
  line hit opens the panel on that line. Page order is kept; the rail's counts carry the ranking.
- `@new` reads a control's `since` against What's new's seen versions (`versionUnread`,
  through the host), so it means "since you last read What's new", not "in this release".

## Contracts

- `test/tour.test.ts` and `test/dispatch.test.ts` parse `id: "…", label: "…"` pairs out of
  `settings.ts` as the tab list. A tab's `id` and `label` stay on one line, and nothing else
  in the file may use that shape (the doors use `open:`/`name:`). Every `data-fgo` target and
  every "Settings › X" in a tour card must name a tab.
- The provider-contract test forbids vendor ids in shared code, so the Agent row's aliases
  come from the registry's labels rather than being spelled here.
- WebKit draws its own ✕ on a `type="search"` field; ours is the only one (`styles.css`).
