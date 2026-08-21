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

## The chapter is written against the app, not against a mock

The first cut was drawn from a design artifact and taught a launch that does not exist.
Every one of these is a real path through `src/`, and the manifest now follows it:

| It said | The app does |
| --- | --- |
| `＋ Session` opens the launcher | `#btnNew` acts on **whatever is on the stage** (`activeProjectCtx`). On a first run there is nothing there, so it opens **⌘K** — and the step waiting for `#wtDlg` could never be satisfied. |
| the project row's `＋` launches | `.padd` is built only for a project that **already has a session** (`projectHtml`). A fresh one renders `.phead.empty-p`, whose one affordance is `open →`. |
| type into `#iPill` | `#iPill` is the inspector's **status pill**. The typing goes into the xterm pane in `#terminals`. |
| the reactor badge is there to point at | `.attn-badge` is `display:none` without `.show`, and ./attn does not count the pane you are looking at — so for one session on the stage it exists **only while a permission is pending**. |
| the project menu has twelve verbs | ./projmenu builds **nine**. |
| "arm *Until agents idle*" | the cup arms whatever preset is stored, and the shipped default is `display`. The mode is behind the caret. |
| everyone gets the permission card | **three of the six permission modes answer for you** (`Auto`, `Don't ask`, `Bypass`) and `Plan` runs nothing to be asked about, so the card the chapter is proudest of never appears — and the step waiting for it stranded those users for its full 20s. |
| "open Settings › Sounds" | lighting ⚙ and naming the tab leaves the tab **in the dark** next to a hole still pointing at the button you already pressed. |

So the required chapter walks the path the app actually has: **add a project → open its
page → ＋ Session → (the launcher, if it is a repo) → type a prompt → the badge lights →
answer the permission → read the rail → ⌘K.** Two rules came out of writing it, and they
apply to every chapter:

- **A step must be reachable from the state the step before it left behind.** The
  worktrees chapter opens the launcher over the rail, so the step after it stays *in* the
  dialog and the one after that asks for it to be closed. A hole on a control behind a
  scrim is the same bug as a hole on nothing.
- **The hole follows the gesture, not the subject.** A step that opens a window hands
  over to a step *inside* it: `#setBtn` waits for Settings, then `[data-settab="sounds"]`
  lights the tab. One step doing both leaves the user hunting in the dark for the control
  the card just named — which is what "Settings › Sounds" did.
- **Two consecutive steps must not share an anchor.** The hole not moving reads as a
  Next that did not land. The contract test enforces it.
- **Ask the app whether the moment can even happen.** `permAsks` reads the launch
  permission mode, so the permission card gets a step in `Manual` / `Accept edits` and a
  **sibling** card in the modes that answer for you — same lesson, no wait, worded for
  what actually happened. Two steps and a `when` beat one step that hedges, and beat a
  20s dead end. The pair is exclusive: the test asserts exactly one of them applies in
  every state.
- **Show the colour, do not describe it.** The rail key is seven chips in the rail's own
  `--st-*` colours (`.tr-leg` carries the state class, so one variable tints glyph, fill
  and hairline together). Card prose also stops the `g-*` pulse: a live row is a live
  thing, a legend that blinks is a rendering fault.

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

`tourTick()` hangs off `renderAllNow` exactly like `syncAttn()`. Most of what the tour
reacts to ends in a `renderAll()`, so it needs **no clock of its own**: a burst from ten
sessions still costs one evaluation, and there is no interval to leak.

**But a dialog is not a repaint.** `openWt`, `openCostPop`, `openCtxMenu` and the
Settings tab switch all just add a class, and four steps wait on exactly those — so they
sat on a satisfied condition until some unrelated poller happened to paint, which is a
click that appears to do nothing for a second or two. `pokeTick` closes that: while a
chapter is running, `click`, `contextmenu` and `keydown` schedule one tick on the next
frame. Still not a clock — it fires on the gestures the user is making anyway, and never
when the tour is idle.

Each tick builds a `TourWorld` — a flat snapshot of primitives, deliberately not the live
`sessions` map, so `tour.ts` stays free of `./state` and every predicate has to declare
the *fact* it needs rather than reach into a `Sess`.

Three ordering rules are the whole of it, and every one was a bug first:

- **The permission latch is folded into the snapshot, not left to the next pass.**
  `permAnswered` is a field *of* the world, so flipping it after `world()` had read it
  left the predicate looking at the previous value. There is no clock here — a pass only
  happens when something changes — so "it will be right next tick" can mean a tick that
  never comes, and the most important step in the tour sat on a satisfied condition doing
  nothing.
- **A step is latched on the falling edge, never on `!permPending` alone.** That is also
  true of a session that has never been asked anything, which would skip the step
  instantly.
- **A waiting step is armed when it is entered, from the state it is entered in** — not
  by the first tick that finds it blocked. A step is almost always entered from *inside*
  a tick (the change that satisfied the step before it), and then nothing happens until
  the change that satisfies this one: there is no tick in between to do the arming, so
  the step would arrive unarmed and sit there. `armed` is what makes "it was already
  true when I got here" different from "it just became true", and the difference is
  visible: an already-satisfied step shows with **Next** enabled instead of flashing past
  — which is what every replay from Settings › Guide looks like.

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

- **A collapsed panel is opened, not stepped over.** ⌘I takes the whole inspector away
  (`#app.insp-off`) and with it the permission buttons and every Context card; ⌘B does
  the same to the rail. A step says which panel its anchor lives in (`needs: ["rail"]`),
  and ./tourui asks its host to open it before measuring anything — a control the user
  has folded away is not a missing anchor, it is a panel to open.
- **A missing anchor skips the step and `dlog`s** rather than lighting a hole over
  nothing — this feature's version of the dead `[data-*]` branch. An element that is
  present but has a zero box (a hidden pane's children) counts as missing. This is what
  makes `.wset` a good anchor: outside a git repo there is no working set to describe,
  and the step removes itself.
- **Except while the step is waiting.** A waiting step's anchor is routinely absent the
  moment it opens — that is the point of it: the permission step lights `.attn-btns`,
  which Claude has not raised yet. Skipping it for "no anchor" stepped straight over the
  single most important card in the tour, exactly when it was doing its job. While it
  waits, the hole falls back to a centred dim.
- **A waiting step grows a quiet "Skip this step" after 20s**, because a predicate can
  always turn out to be unsatisfiable on somebody's machine.
- **`when` is live, and `si` indexes the chapter's FULL step list.** A predicate has to
  be able to say "only while the badge is actually on screen", which changes twice in the
  middle of the quickstart — and an index into the *filtered* list would silently
  renumber every step after it, advancing past one or replaying one with nothing on
  screen to explain it. Navigation is what skips a `when` that fails (`neighbour`), never
  the index. The dots and the "5 / 8" read a third list: everything that applies now
  **plus everything that has applied earlier in this chapter**, so the denominator only
  ever grows — a total that shrinks looks like the tour losing its place.
- **It never takes Escape.** Escape backs out of whichever dialog is open — nine
  bindings, not one action — and those dialogs are *under* the tour. It closes on its own
  ✕. It binds no chord and gets no `keyPrefs` row: it is not an app-level action.
- **It never answers a permission for you.** The step lights the buttons and explains
  them; Deny is as valid an answer as Allow, and the predicate accepts either.
- **It writes nothing into your repo.** The only thing it touches is `cc-tour`.
- **It survives a quit.** `at` is written when the tour is left mid-chapter, and
  `startChapter` reads it back: the Settings › Guide row for a chapter you walked out of
  says **Resume** rather than Start, and picks up on the step you left. (It was written
  and read by nothing until this was wired up.)

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

The manifest rules it also enforces, one per way this feature has gone wrong:

- a step with `wait` must have `done` (otherwise Next is disabled forever and the ✕ is
  the only way out), and a step with `done` must have `wait` (otherwise it silently
  self-advances);
- **no two consecutive steps in a chapter share an anchor** — the hole not moving reads
  as a Next that did not land;
- an anchor that lives inside the rail or the inspector must declare `needs`, or the step
  lights nothing for anyone who works with that panel collapsed;
- the permission modes the manifest plans around must exist in `ALL_PERM_MODES` — a
  typo'd mode id makes `permAsks` false for everybody, which silently stops teaching the
  permission card to exactly the people who would get one;
- **"Settings › Sounds" has to name a real tab**: the copy is joined to `SET_TABS` in
  `settings.ts` exactly the way an anchor is joined to `index.html`, and nothing else
  checks it. Card copy that confidently names a window the app does not have is the same
  bug as a dead anchor, and it is the one a reader notices first.

## Adding a chapter

Append to `CHAPTERS` in `src/tour.ts`. That is the whole of it — the picker, Settings ›
Guide, the plan builder and the store all read the manifest. For a **release intro**, add
`since: "<version>"` and it disappears from the picker and appears on that release's
*What's new* entry instead.

Four things to get right:

- An anchor that only exists at runtime needs `dynamic: true`, or the contract test
  fails. One that is in `index.html` must **not** carry it.
- A step that waits needs a `done` predicate over `TourWorld`. If the fact it needs is
  not in `TourWorld` yet, add the field — and add it to the fixture in the test, which is
  where every predicate's edge cases are pinned.
- **Walk it in the app before you believe it.** Both times this feature has been wrong,
  the manifest was written from a picture of the app rather than from the app: every
  predicate passed, `tsc` was happy, and the step pointed at something that was not
  there. Open the chapter from Settings › Guide and press through it.
- An anchor inside the rail or the inspector needs `needs`, and a step that only makes
  sense in some states needs `when` — not a body that hedges about it.
