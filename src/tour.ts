// The guided tour: what the chapters are, when one is offered, and how a step decides
// it is finished. **Rules only** — no DOM, no Tauri, no render import — so all of it is
// unit-testable and ./tourui is left as the driver that measures elements and paints.
//
// WHY A CHAPTER IS THE UNIT. The first version of this was one linear tour, and a
// linear tour has to answer "how long is too long" once, for everybody. It cannot: the
// person evaluating Episko for ten minutes and the person who has used it for a week
// and never found the right-click menu want different lengths. So the welcome card
// leads into a picker, `quickstart` is the only chapter that cannot be unchecked, and
// each chapter is recorded in `cc-tour` on its own — take one now and three next month.
//
// The same shape pays for the *other* half of the feature. A release intro is not a
// second mechanism: it is a chapter carrying `since`, offered from *What's new* instead
// of from the picker, and shown in Settings › Guide beside the rest. One type, one
// renderer, one store, and nothing to keep in sync.
//
// Anchors are CSS selectors resolved by ./tourui against the live document. That join
// is invisible to `tsc` and to every unit test that imports rather than parses — the
// exact shape that produced dispatch.test.ts and ipc.test.ts — so test/tour.test.ts
// parses this file and fails if a static anchor does not exist in index.html. A step
// whose anchor only exists at runtime (a project row, a tool row) says `dynamic: true`
// and is exempt **by name**, so the exemption is a decision rather than an accident.

/**
 * What a step is allowed to ask about the running app.
 *
 * Deliberately a flat snapshot of primitives rather than the live `sessions` map: it
 * keeps this module free of ./state and ./types, it is trivial to build a fixture for,
 * and it forces each new predicate to declare the *fact* it needs instead of reaching
 * into a `Sess` and coupling the tour to a field's shape. ./tourui rebuilds it on every
 * `renderAll` pass — see `tourTick` — so everything here is a snapshot of right-now.
 */
export interface TourWorld {
  /** Projects pinned in the rail. */
  projects: number;
  /** Live sessions of any kind. */
  sessions: number;
  /** The active session's phase, or "" when nothing is on the stage. */
  phase: string;
  /** A permission is pending in *some* session — not necessarily the active one. */
  permPending: boolean;
  /** True once the user has answered at least one permission this run. */
  permAnswered: boolean;
  /** Which overlays are open right now; see `OPEN_IDS` for the vocabulary. */
  open: readonly string[];
  /** What holds the stage. Mirrors ./dom's `Stage`, without importing it. */
  stage: string;
  /** Files recorded against the active session (the inspector's Context card). */
  files: number;
  /**
   * The inspector's Context card is showing its **Tools** tab.
   *
   * Deliberately the tab and not "a tool row is expanded": the expandable row is issue
   * #96 and is not in this branch, and a step that waits for something the build cannot
   * do would strand the user on a disabled Next. When #96 lands, tighten this predicate
   * and the step's copy together.
   */
  toolsTab: boolean;
  /** Caffeinate is armed in any mode. */
  caffeinated: boolean;
}

/** The overlay names `TourWorld.open` may carry. One place, so a predicate cannot typo. */
export const OPEN_IDS = ["wt", "settings", "ctx", "run", "palette", "graph", "cost", "usage"] as const;
export type OpenId = (typeof OPEN_IDS)[number];
const isOpen = (w: TourWorld, id: OpenId) => w.open.includes(id);

/**
 * A secondary button on a card, for the one thing a step cannot ask the user to do
 * blind: type a prompt. The step names an *intent* and ./tourui performs it, so this
 * module still reaches no IPC. Add a member here and a case in ./tourui's `runAct`.
 */
export type TourActId = "paste-first-prompt";
export interface TourAct { label: string; id: TourActId }

export interface TourStep {
  /**
   * CSS selector for the element to light. Omitted means a centred card over a plain
   * dim — used for the two steps that describe something outside the window (the tray)
   * or nothing in particular (a chapter's closing card).
   */
  anchor?: string;
  /** The anchor only exists once the app is in a particular state; see the file header. */
  dynamic?: boolean;
  title: string;
  /**
   * Card body. HTML, authored in this file and never built from user input, so it is
   * assigned rather than escaped. Keep it to two short sentences: a card that has to be
   * *read* has already lost against the thing it is pointing at.
   */
  body: string;
  /**
   * Shown while the step waits on the user. Its presence is what disables Next — a step
   * with `wait` but no `done` is a bug the contract test catches.
   */
  wait?: string;
  /** Advance as soon as this is true. Evaluated on every `renderAll` pass. */
  done?: (w: TourWorld) => boolean;
  /** Skip the step entirely when false — a non-git folder has no worktree to offer. */
  when?: (w: TourWorld) => boolean;
  /** An extra button; see `TourAct`. */
  act?: TourAct;
  /** Offer a "skip the rest of this chapter" out. Only where a step can cost money. */
  skip?: string;
}

export interface Chapter {
  id: string;
  /**
   * Bumped when a chapter is rewritten enough that someone who took the old one should
   * be offered the new one. `done` holds `id@rev`, so a bump re-offers deliberately
   * instead of by accident.
   */
  rev: number;
  name: string;
  /** One line, shown in the picker and in Settings › Guide. */
  blurb: string;
  /** Rough length, e.g. "90s". Prose, not a number: it is a promise, not a measurement. */
  mins: string;
  /** Cannot be unchecked in the picker. Exactly one chapter should carry this. */
  required?: boolean;
  /**
   * A release intro. Offered from *What's new* on this version's entry rather than from
   * the picker, and never part of a first run.
   */
  since?: string;
  steps: TourStep[];
}

// ---------- the rail's vocabulary ----------
// Duplicated from GLYPH/GCLASS in ./sidebarview rather than imported, because the
// dependency direction forbids a logic module importing a view. test/tour.test.ts
// compares the two tables in both directions, so a state added to the rail without
// being added here fails the suite rather than quietly going untaught.
export const RAIL_LEGEND: { glyph: string; cls: string; label: string }[] = [
  { glyph: "●", cls: "g-work",  label: "working" },
  { glyph: "✓", cls: "g-done",  label: "your turn" },
  { glyph: "◆", cls: "g-attn",  label: "blocked on you" },
  { glyph: "◐", cls: "g-bg",    label: "fleet still running" },
  { glyph: "✕", cls: "g-error", label: "the turn broke" },
  { glyph: "○", cls: "g-idle",  label: "idle" },
  { glyph: "·", cls: "g-ended", label: "ended" },
];
const legendHtml = () => RAIL_LEGEND
  .map((l) => `<span class="tr-leg"><b class="${l.cls}">${l.glyph}</b>${l.label}</span>`).join("");

// ---------- the manifest ----------
// Everything above is machinery; this is the content. Adding a chapter is adding an
// entry, and adding a step is adding an object — there is no other place to touch.

export const CHAPTERS: Chapter[] = [
  {
    id: "quickstart", rev: 1, required: true,
    name: "Quick start", mins: "3 min",
    blurb: "Get an agent running, and learn to read the rail",
    steps: [
      {
        anchor: "[data-add]",
        title: "Add a project folder",
        body: "Point Episko at any repo on your machine. It never writes inside your project without asking first.",
        wait: "Pick a folder to continue",
        done: (w) => w.projects > 0,
      },
      {
        anchor: "#btnNew",
        title: "Start a session",
        body: "Every session starts here. Episko wires up the instrumentation — you never configure a hook.",
        wait: "Open the launcher",
        done: (w) => isOpen(w, "wt"),
      },
      {
        anchor: "#wtDlg",
        title: "Pick where it runs",
        body: "The repo itself, a worktree, or a branch. <b>Take the repo for now</b> — worktrees have a chapter of their own.",
        wait: "Launch it",
        done: (w) => w.sessions > 0 && !isOpen(w, "wt"),
      },
      {
        anchor: "#iPill",
        title: "Give it a first job",
        body: "A read-only one, worth a couple of cents:<br><code>Run git status and tell me what's uncommitted.</code><br>"
          + "It will ask permission before it runs anything — that is the next step, and the most important one here.",
        act: { label: "Paste it for me", id: "paste-first-prompt" },
        skip: "Skip the agent bit",
        wait: "Send the prompt to continue",
        done: (w) => w.phase === "working" || w.phase === "thinking" || w.permPending,
      },
      {
        anchor: ".attn-btns", dynamic: true,
        title: "It stopped, and went pink",
        body: `That <b class="g-attn">◆</b> means <b>blocked on you</b>. Claude is genuinely paused until you answer, `
          + "and it is the only event with its own urgent sound.<br>"
          + "<b>Allow</b> once, <b>Deny</b>, or hand it to a real terminal. How often it asks is yours, in Settings › Sessions.",
        wait: "Answer it — either way",
        done: (w) => !w.permPending && w.permAnswered,
      },
      {
        anchor: "#projects",
        title: "Read the rail",
        // The one step that pays for the whole chapter, and the one the legend is
        // duplicated for. It teaches a key rather than painting a demo fleet: a
        // fabricated rail, in an app whose entire job is showing you real work, would
        // be the wrong first impression — so this sits beside whatever the user
        // actually has running, however little that is.
        body: `<b>Eight glyphs, and the colour is the message.</b><div class="tr-legend">${legendHtml()}</div>`
          + `A <b class="g-attn">pink</b> row is blocked on you; a <b class="g-done">green</b> one finished and wants you. `
          + "The wash fades after a few seconds; the glyph stays until you have been to it.",
      },
      {
        anchor: "#attnBadge",
        title: "Your turn",
        body: "The badge counts every session waiting on you and orders them by urgency — a permission always outranks "
          + "a finished turn. <b>This is why you can run ten of these.</b>",
      },
      {
        anchor: "#kbar",
        title: "Everything else is behind ⌘K",
        body: "Jump to a session, launch a project, run a task, reopen a conversation from three weeks ago.<br>"
          + "Three prefixes: <code>⟩</code> commands, <code>@</code> sessions, <code>/</code> filter.",
      },
    ],
  },

  {
    id: "unattended", rev: 1,
    name: "Leave it running", mins: "70s",
    blurb: "Caffeinate, sounds, and the menu bar",
    steps: [
      {
        anchor: "#caf",
        title: "Keep the machine awake",
        body: "Five modes, but the one to know is <b>Until agents idle</b>: awake only while agents are actually working, "
          + "then it lets go by itself. A sleeping Mac kills a twenty-minute run.",
        wait: "Arm it",
        done: (w) => w.caffeinated,
      },
      {
        anchor: "#setBtn",
        title: "Tune what you hear",
        body: "Settings › Sounds gives every event its own tone and switch, previewable in place. <b>Four ship switched "
          + "off</b> — anything that fires on routine activity turns a fleet into a fruit machine.",
      },
      {
        anchor: "#setBtn",
        title: "The rule that stops the noise",
        body: "The same moment reaches Episko twice by design, so every play is gated. But a <b>more urgent</b> event "
          + "still cuts through the gap, which is the point: a permission always gets heard.",
      },
      {
        title: "It works with the window shut",
        body: "The menu-bar icon mirrors the rail — the same glyphs, grouped by project. Click any session there to jump "
          + "straight back into it.",
      },
    ],
  },

  {
    id: "worktrees", rev: 1,
    name: "Branches & worktrees", mins: "90s",
    blurb: "Right-click, peek, and a tree of its own",
    steps: [
      {
        anchor: ".pgroup", dynamic: true,
        title: "The project row has two hidden gestures",
        body: "<b>Right-click</b> it for twelve verbs — grouping projects, its colour and logo, the commit graph, copy path."
          + "<br><b>Rest on it</b> and the checkouts with nothing running in them come back. They collapse because a project "
          + "with four worktrees should not spend four rows saying “no session”.",
        wait: "Right-click the project",
        done: (w) => isOpen(w, "ctx"),
      },
      {
        anchor: "[data-ctx=\"worktree\"]", dynamic: true,
        title: "A tree of its own",
        body: "A second checkout on its own branch. The agent gets a whole tree to itself and <b>your editor never moves</b>.",
        wait: "Open it",
        done: (w) => isOpen(w, "wt") || !isOpen(w, "ctx"),
      },
      {
        anchor: "#projects",
        title: "Switching and removing",
        body: "Right-click a checkout to switch its branch or remove it. Switching is <b>refused while a session is still "
          + "working there</b>, and says so rather than going quietly grey.",
      },
      {
        title: "The commit graph",
        body: "One page at a time, lanes named by the branch that owns them. The fastest way to see where your worktrees "
          + "actually sit relative to each other. It is in that same right-click menu.",
      },
    ],
  },

  {
    id: "inspector", rev: 1,
    name: "Read what your agent did", mins: "60s",
    blurb: "Files, tools, and the diff it left",
    steps: [
      {
        anchor: "#inspector",
        title: "Files, as a set",
        body: "Every file it touched, once each — <b>read</b>, <b>edited</b>, <b>created</b>. Not a log of calls: an agent "
          + "re-reads what it just wrote constantly, so a file only ever climbs.",
      },
      {
        anchor: "[data-fmode=\"tools\"]", dynamic: true,
        title: "Tools, and what came back",
        body: "The same card flips to the running order of every tool call — searches and commands included, not just the "
          + "ones that moved a file.",
        wait: "Switch to Tools",
        done: (w) => w.toolsTab,
      },
      {
        anchor: "#inspector",
        title: "The working set",
        body: "What git thinks changed, live, while the agent works. Click a file to read the diff without leaving the app.",
      },
    ],
  },

  {
    id: "project", rev: 1,
    name: "The project homepage", mins: "90s",
    blurb: "Issues, PRs, and your own scripts",
    steps: [
      {
        anchor: "#projects",
        title: "A project is a page, not a terminal",
        body: "Clicking the project <em>name</em> opens its homepage. Three tiers, depending on whether it has GitHub, "
          + "git, or neither.",
        wait: "Open a project",
        done: (w) => w.stage === "dash",
      },
      {
        anchor: "#dashSpine",
        title: "Dispatch an agent at an issue",
        body: "Open issues and PRs, with a button on each row. It opens a worktree, briefs the session with the issue, and "
          + "<b>claims it</b> so nobody on the team doubles up.",
      },
      {
        anchor: "#dashPulse",
        title: "Today, and who else is in here",
        body: "What moved, what it cost, and a note you can leave for whoever opens this next.",
      },
      {
        anchor: "#btnRun",
        title: "Your scripts, without the terminal",
        body: "<code>package.json</code>, Makefile targets, and anything in <code>.episko/tasks.toml</code> — found, not "
          + "configured. <kbd>⌘</kbd><kbd>⇧</kbd><kbd>B</kbd> from anywhere.",
      },
    ],
  },

  {
    id: "cost", rev: 1,
    name: "What it costs", mins: "60s",
    blurb: "Today's spend and your limits",
    steps: [
      {
        anchor: "#fCostSeg",
        title: "Today, split",
        body: "The footer number is a button. It opens the breakdown by project and by session, so you can see which agent "
          + "is the expensive one.",
        wait: "Open the split",
        done: (w) => isOpen(w, "cost"),
      },
      {
        anchor: "#fUsageSeg",
        title: "Both windows, with a forecast",
        body: "Your 5-hour and weekly limits, plus the burn rate and <b>when you will actually hit them</b> at this pace.",
        wait: "Open the forecast",
        done: (w) => isOpen(w, "usage"),
      },
      {
        anchor: "#setBtn",
        title: "The whole history",
        body: "Settings › Usage has every day, per model and per project, back as far as your transcripts go.",
      },
    ],
  },
];

// ---------- lookups ----------

export const chapterKey = (c: Chapter) => `${c.id}@${c.rev}`;
export const chapterById = (id: string): Chapter | undefined => CHAPTERS.find((c) => c.id === id);
/** The picker's list: everything that is not a release intro. */
export const pickerChapters = (): Chapter[] => CHAPTERS.filter((c) => !c.since);
/** The chapter a release ships, if any. Exact match on the version — see ./changelogui. */
export const releaseChapter = (version: string): Chapter | null =>
  CHAPTERS.find((c) => c.since === version) ?? null;

// ---------- the store ----------
// One JSON blob under `cc-tour`, for the same reason cc-peek, cc-sound and cc-keys are
// one each: the halves are only ever read together, and a key per chapter would be six.

export const TOUR_KEY = "cc-tour";

export interface TourState {
  v: 1;
  /** Chapters finished OR skipped, as `id@rev`. A set, like cc-seen-versions. */
  done: string[];
  /** Chapters picked but not yet taken, in order. One flows into the next. */
  queue: string[];
  /** Where a chapter was interrupted, so a quit mid-tour resumes rather than restarts. */
  at: { ch: string; step: number } | null;
}

export const tourDefaults = (): TourState => ({ v: 1, done: [], queue: [], at: null });

/**
 * Read the store defensively. Anything hand-edited into the key decays to "offer
 * nothing", which is silent — never to "offer everything", which would ambush someone
 * mid-session. Same instinct as `parseSeen` in ./changelog.
 */
export function parseTourState(raw: string | null): TourState {
  const d = tourDefaults();
  if (!raw) return d;
  try {
    const o = JSON.parse(raw) as Partial<TourState> | null;
    if (!o || typeof o !== "object") return d;
    const strs = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
    const at = o.at;
    return {
      v: 1,
      done: strs(o.done),
      // A queued id we no longer ship is dropped here rather than at the point it would
      // be played, so the queue cannot strand the user on a chapter that does not exist.
      queue: strs(o.queue).filter((id) => !!chapterById(id)),
      at: at && typeof at.ch === "string" && typeof at.step === "number" && chapterById(at.ch)
        ? { ch: at.ch, step: Math.max(0, Math.floor(at.step)) }
        : null,
    };
  } catch {
    return d;                                   // truncated or hand-mangled
  }
}

export const isDone = (st: TourState, c: Chapter) => st.done.includes(chapterKey(c));

/** Mark a chapter done. Idempotent, and it drops the chapter from the queue with it. */
export function recordDone(st: TourState, c: Chapter): TourState {
  const key = chapterKey(c);
  return {
    ...st,
    done: st.done.includes(key) ? st.done : [...st.done, key],
    queue: st.queue.filter((id) => id !== c.id),
    at: st.at?.ch === c.id ? null : st.at,
  };
}

/**
 * Does the picker offer itself on this boot?
 *
 * **The absence of the key, and nothing else.** Not "is this version new", because a
 * new build alone must never open anything — and not "does localStorage look used",
 * which is how the fresh-install guard in docs/releases.md shipped 0.13.0 silent. The
 * first run is the only run this returns true for, whatever happens to the version
 * afterwards.
 */
export const shouldOfferPicker = (raw: string | null) => raw === null;

/** A release intro is offered only if it exists, is not done, and this build is it. */
export function shouldOfferRelease(version: string, st: TourState): Chapter | null {
  const c = releaseChapter(version);
  return c && !isDone(st, c) ? c : null;
}

// ---------- walking a chapter ----------

/** The steps that apply right now; a `when` that fails removes the step from the count. */
export const visibleSteps = (c: Chapter, w: TourWorld): TourStep[] =>
  c.steps.filter((s) => !s.when || s.when(w));

/** Is Next disabled? A step waits only if it says so *and* its condition is unmet. */
export const stepBlocked = (s: TourStep, w: TourWorld) => !!s.wait && !(s.done?.(w) ?? true);

/** Has a waiting step's condition been met? False for a step that never waits. */
export const stepSatisfied = (s: TourStep, w: TourWorld) => !!s.wait && !!s.done?.(w);

/**
 * The plan a picker selection turns into: the chosen chapters in manifest order, so the
 * required one always comes first however the boxes were ticked.
 */
export const planFor = (ids: readonly string[]): Chapter[] =>
  CHAPTERS.filter((c) => !c.since && ids.includes(c.id));
