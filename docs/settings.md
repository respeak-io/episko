# Settings (`settings.ts`, `setsearch.ts`)

One scrolling page, a rail that is a table of contents, and a search. `SET_TABS` is still
the one declarative table; `SET_GROUPS` names the three headings and each tab carries its
`group`. A section is named for the surface or the question (*Sidebar*, *Attention*, *On its
own*), never for the feature that shipped it: the old rail read as a changelog.

## The page

- Every visible tab paints in order into `#setBody`, each under a sticky `.set-sech`. `setTab`
  is what the rail lights. The spy sets it on scroll (the last header at or above the top
  edge, one header of slack, the diff overlay's rule); a rail click sets it and scrolls, and
  `spyHold` keeps the spy out of the smooth scroll it started, or a short last section would
  light its neighbour. The tour reads `.set-tab.on` as `settingsTab`, so `goToTab` marks the
  tab itself rather than leaving it to a scroll that may never happen.
- `openSettingsOn(tab, row?)`: the quick opens, the ⑃ dialog, ⌘K and the tour land on a row
  lit for three seconds (`.set-lit`). `row` is the control's `id`, else its `set` verb, else
  its kind (`rowId`). Keep those stable: they are addresses. With no `row`, a row that shares
  the section's id is taken (`keys`), so a one-row section lights its row.
- A row is the label, `hint` (one sentence, on the page), `more` behind *why* (`openWhy`), the
  control on the right, and under it whatever folds (`openPanels`): the six panels, a toggle's
  preview, the agent's cards, a multi's chips. An action's preview is its answer and never
  folds. A seg with no logo is an inline picker with the active option's sub under the label.
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
