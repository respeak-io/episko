# The guided tour

`src/tour.ts` (rules + manifest, tested) · `src/tourui.ts` (veil, card, picker) ·
`test/tour.test.ts` (the contract) · Settings › Guide · a `Show me →` on *What's new*.

Episko's most meaningful surfaces are the ones you cannot infer by looking: the rail's
seven glyphs and two washes, the blocking permission card, the badge that counts what is
waiting on you. A first run landed on an empty rail and explained none of it.

## A chapter is the unit

The first design was one linear tour, and a linear tour has to answer "how long is too
long" once, for everybody. It cannot. So the welcome card leads into a **picker**:

- `quickstart` is `required` and cannot be unchecked.
- Five more are opt-in, each recorded in `cc-tour` **on its own**.
- Everything stays replayable from **Settings › Guide**, forever.

The same shape pays for the other half of the feature. **A release intro is not a second
mechanism** — it is a chapter carrying `since: "0.21.0"`, offered from *What's new*
instead of from the picker, listed in Settings › Guide beside the rest. One type, one
renderer, one store, and nothing to keep in sync.

## When it opens by itself

Exactly once, and only ever on the **absence of `cc-tour`**.

Not "is this version new" — a new build alone must never open anything. Not "does
localStorage look used", which is how the fresh-install guard in `docs/releases.md`
shipped 0.13.0 silent. `shouldOfferPicker(raw)` is `raw === null` and nothing else; the
first thing the tour writes ends the first run for good.

**The hand-off in `main.ts` is one line and load-bearing**: `initChangelog(initTour())`.
The tour goes first because on a genuine first run it takes the screen, and *What's new*
must then stay quiet rather than opening on top of it — so `initTour` returns whether it
did, and a quiet `initChangelog` marks the running version read instead of announcing it.
That finally retires the compromise `docs/releases.md` records ("a first-time user sees
their installed version's notes once", over an app they have not looked at yet) **without
reintroducing the guard**: it keys on the tour having actually opened, not on a record
being absent, so it cannot misfire on the release that introduces a key.

## How a step advances

`tourTick()` hangs off `renderAllNow` exactly like `syncAttn()`. Everything the tour
reacts to already ends in a `renderAll()`, so it needs **no clock of its own**: a burst
from ten sessions still costs one evaluation, and there is no interval to leak.

Each tick builds a `TourWorld` — a flat snapshot of primitives, deliberately not the live
`sessions` map, so `tour.ts` stays free of `./state` and every predicate has to declare
the *fact* it needs rather than reach into a `Sess`.

Two ordering rules in that tick are the whole of it, and both were bugs first:

- **The permission latch is folded into the snapshot, not left to the next pass.**
  `permAnswered` is a field *of* the world, so flipping it after `world()` had read it
  left the predicate looking at the previous value. There is no clock here — a pass only
  happens when something changes — so "it will be right next tick" can mean a tick that
  never comes, and the most important step in the tour sat on a satisfied condition doing
  nothing.
- **A step is latched on the falling edge, never on `!permPending` alone.** That is also
  true of a session that has never been asked anything, which would skip the step
  instantly.

## The hole is real

The veil is `pointer-events: none` and the dark is a single `box-shadow: 0 0 0 9999px`
spreading *out* of one small rounded div, so nothing overlays the lit control: the user
genuinely presses `＋ Session`, and genuinely presses **Allow**. Nothing is simulated,
which is the only reason the interactive half teaches anything.

It is **not on the shared `#scrim`** and must never join `SCRIM_DLGS`. The tour lights
controls *inside* the launcher, the project context menu and the settings window, so it
sits above all three (tier 80/81, over the context menu's 60 and *What's new*'s 61) and
coexists with them; `dropScrim()` stays a question only dialogs answer.

## Nothing can strand the user

- **A missing anchor skips the step and `dlog`s** rather than lighting a hole over
  nothing — this feature's version of the dead `[data-*]` branch. An element that is
  present but has a zero box (a hidden pane's children) counts as missing.
- **Except while the step is waiting.** A waiting step's anchor is routinely absent the
  moment it opens — that is the point of it: the permission step lights `.attn-btns`,
  which Claude has not raised yet. Skipping it for "no anchor" stepped straight over the
  single most important card in the tour, exactly when it was doing its job. While it
  waits, the hole falls back to a centred dim.
- **A waiting step grows a quiet "Skip this step" after 20s**, because a predicate can
  always turn out to be unsatisfiable on somebody's machine.
- **It never takes Escape.** Escape backs out of whichever dialog is open — nine
  bindings, not one action — and those dialogs are *under* the tour. It closes on its own
  ✕. It binds no chord and gets no `keyPrefs` row: it is not an app-level action.
- **It never answers a permission for you.** The step lights the buttons and explains
  them; Deny is as valid an answer as Allow, and the predicate accepts either.
- **It writes nothing into your repo.** The only thing it touches is `cc-tour`.
- **It survives a quit.** `at` is written when the tour is left mid-chapter.

## The store

One JSON blob under `cc-tour`, for the same reason `cc-peek`, `cc-sound` and `cc-keys`
are one each: the halves are only ever read together.

```jsonc
{
  "v": 1,
  "done":  ["quickstart@1"],          // finished OR skipped — a set, like cc-seen-versions
  "queue": ["cost", "unattended"],    // picked but not yet taken; one flows into the next
  "at":    { "ch": "cost", "step": 2 } // or null
}
```

Chapters are keyed `id@rev`, so **rewriting one can re-offer it deliberately** by bumping
`rev`. `parseTourState` decays anything hand-edited to "offer nothing" (silent) rather
than "offer everything" (an ambush), and drops a queued or resumed id the build no longer
ships, so the queue cannot strand you on a chapter that does not exist.

## The contract test

`test/tour.test.ts` is the **third** suite here that reads source instead of calling it,
after `dispatch.test.ts` and `ipc.test.ts`, and for the same reason: a step's `anchor` is
a join between two files that nothing else checks. `tsc` sees a string; every unit test
passes, because the rules underneath are fine; the step simply lights nothing.

It checks both directions. Every **static** anchor must resolve in `index.html`, and
every anchor flagged `dynamic` must **not** — so the flag stays a decision about an
element built at runtime rather than a stale escape hatch. It also compares
`RAIL_LEGEND` against `GLYPH`/`GCLASS` in `sidebarview.ts` in both directions: the legend
is duplicated (a logic module may not import a view), and this is what stops a state
being added to the rail without the tour learning it.

Two manifest rules it also enforces: a step with `wait` must have `done` (otherwise Next
is disabled forever and the ✕ is the only way out), and a step with `done` must have
`wait` (otherwise it silently self-advances).

## Adding a chapter

Append to `CHAPTERS` in `src/tour.ts`. That is the whole of it — the picker, Settings ›
Guide, the plan builder and the store all read the manifest. For a **release intro**, add
`since: "<version>"` and it disappears from the picker and appears on that release's
*What's new* entry instead.

Two things to get right:

- An anchor that only exists at runtime needs `dynamic: true`, or the contract test
  fails. One that is in `index.html` must **not** carry it.
- A step that waits needs a `done` predicate over `TourWorld`. If the fact it needs is
  not in `TourWorld` yet, add the field — and add it to the fixture in the test, which is
  where every predicate's edge cases are pinned.
