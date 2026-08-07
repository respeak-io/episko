# Sound alerts

**`sound.ts` decides, `chime.ts` plays.** The split is the same one `peek.ts`/`sidebar.ts`
uses: everything that can be reasoned about — the catalogue, the tones as data, the
clamping, the suppression rules — is pure and tested; the file that owns an
`AudioContext` does nothing a test would want to assert.

Settings › Sounds is the whole UI. State lives in `state.ts` (`soundPrefs`, one JSON
blob under `cc-sound`), persistence and the repaint in `actions.ts`, exactly as the peek
timings and the project groups do.

## Why the app makes a noise at all

Every signal Episko had before this one is visual — the sidebar glyph, the attention
badge, the tray — and all three need the window in front of you. But the entire point of
running six agents is that you have gone and done something else. A blocked permission is
the extreme case: Claude is *stopped*, burning nothing, achieving nothing, until you
answer, and until now nothing told you.

## The rule that matters: not playing six sounds

Playing a sound is trivial. Not playing six is the whole design, because the same
real-world moment reaches the frontend more than once **by design**:

- a permission arrives as both the blocking `PermissionRequest` hook **and** a
  `Notification` — and the redundancy is what makes it reliable
- a session ending arrives as both `SessionEnd` and `pty-exit`
- N busy agents fire a lifecycle hook each within the same animation frame

So `soundFor` gates every play behind two windows:

| Window | Length | What it collapses |
| --- | --- | --- |
| `SOUND_REPEAT_MS` | 1200ms | **the same event** twice — the by-design duplicates above |
| `SOUND_GAP_MS` | 350ms | **different events** in one burst — a fleet moving together is one moment |

…with one exception, and it is the reason the gap is not just a mute: **inside the gap,
a more urgent event still gets through.** A permission landing 80ms after a "your turn"
is not a duplicate of it, it is the thing you actually needed to hear. That is what the
`priority` field on each `SoundEventDef` is for and the only thing it is read for
(3 urgent · 2 needs you · 1 informational · 0 background).

Neither window is persisted or reset-on-quit: a fresh run must never suppress its first
sound, so `chime.ts` holds the gate in a module variable and that is the right lifetime.

## The catalogue, and why three events ship switched off

`SOUND_EVENTS` is ten entries. Seven are on by default; `toolFail`, `ended` and
`launched` are not, and that is not timidity — **a set of alerts that fires on every
failed grep is a set of alerts you stop hearing**, which makes the permission chime
worthless too. Anything that fires on routine activity is opt-in.

The sharpest instance is a split this codebase already draws for the label and now draws
again for the noise: `phase: "error"` is set BOTH by a tool call failing mid-turn and by
a turn the API killed. Only the second is a new `apiErr` stamp (which only `StopFailure`
writes), so only the second rings `error`; everything else that reddens the glyph is the
opt-in `toolFail`. See `hookSound`, and `docs/architecture.md` for the original bug.

## Where the events come from

Nothing reads a hook payload twice. What a hook *means* is `phase.ts`'s decision, and a
second reading here would be a second copy of that decision — the copy that drifts. So
`main.ts` snapshots three fields off the `Sess`, applies the hook, and asks `hookSound`
what changed:

| Event | Raised by |
| --- | --- |
| `permission` | the blocking `permission` listener, and `hookSound` on a new `attention` matching /permission/ |
| `question` | `hookSound` on any other new `attention` |
| `done` `error` `toolFail` `ended` | `hookSound` on the phase the state machine settled into |
| `taskDone` `taskFail` `ended` | `exitSound(kind, code)` in the `pty-exit` listener |
| `limit` | `limitCrossed` over the account-wide `rl` readings, outside the per-session branch — one crossing, one chime, however many sessions report it |
| `launched` | `launch()` in `panes.ts`, only on a spawn that worked |

`limitCrossed` compares two readings rather than testing a threshold, so a window
*reset* (the number falling) crosses nothing — and **the first reading of a run is a
baseline, not a crossing**, or every launch above 50% would ring at the one moment the
footer meter is already saying so on screen.

## Two things `chime.ts` exists to get right

Both are silent when wrong, which is why they are written down.

**The context starts suspended.** Every autoplay policy refuses audio until the page has
seen a gesture, and Episko's first sound is very often a permission that arrives while
nobody has touched anything for ten minutes. The context is therefore created lazily,
`resume()`d on every play, and woken by a one-shot capture-phase `pointerdown`/`keydown`
listener. Without that, the failure is not an error anywhere — it is a permission that
made no noise, which is indistinguishable from the feature being off.

**A gate-shaped envelope clicks.** Starting an oscillator at full gain and stopping it
puts a step discontinuity in the buffer. Every step gets a short attack and an
exponential decay instead, and the ramps only ever run to a small positive value because
`exponentialRampToValueAtTime` is undefined at zero. A step shorter than the attack has
its attack clamped, or it would ramp up past its own end and never come back down.

## The settings pane

Every button in Settings › Sounds **plays what it does** — changing a tone, switching an
event on, nudging the volume. That is not a flourish: a column of names ("Chime",
"Drop", "Buzz") is unusable, because nobody knows what a Drop is until they have heard
one, and a pane you cannot audition is one you set at random once and never revisit.

Deliberately silent: switching an event **off**, and Reset. A burst of ten tones is not a
useful answer to "make it quieter", and a sound as you switch something off says exactly
the wrong thing.

`previewTone`/`previewEvent` bypass the focus rule, the per-event switch and the burst
gate — you are looking straight at the window, which is the one moment `away` would
silence everything, and clicking through tones is meant to be rapid. They also leave the
gate untouched, so an audition can never suppress a real alert that lands mid-click. The
one thing they honour is the volume, because that is usually what is being judged.
