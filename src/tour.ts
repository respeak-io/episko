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
  /**
   * A **claude** session is on the stage — not a shell pane, not a task, not the
   * dashboard. Everything the inspector chapter teaches is about that pane, so the
   * chapter opens by waiting for one instead of lighting cards that describe nothing.
   */
  agentOnStage: boolean;
  /** A permission is pending in *some* session — not necessarily the active one. */
  permPending: boolean;
  /** True once the user has answered at least one permission this run. */
  permAnswered: boolean;
  /**
   * The permission mode new sessions start in (Settings › Sessions).
   *
   * Three of the six modes answer for you, so **the card the quickstart is proudest of
   * never appears** — and a step that waits for it strands you for its full 20s before
   * offering a way past. The mode is the only thing that can say so in advance: a
   * session that has not been asked anything is indistinguishable from one that never
   * will be. See `permAsks`.
   */
  permMode: string;
  /**
   * How many sessions the reactor badge is counting right now (`needsYouSessions`).
   *
   * Not "has a session finished": the badge deliberately does **not** count the pane
   * you are looking at (./attn's `attnSeen` treats the active session as seen), so on
   * a first run — one session, on the stage — the only thing that ever lights it is a
   * blocking permission. That is exactly when the tour teaches it, and this field is
   * what lets the step know the badge is really there to point at.
   */
  attnCount: number;
  /** Which overlays are open right now; see `OPEN_IDS` for the vocabulary. */
  open: readonly string[];
  /** Which Settings tab is showing, or "" when Settings is closed. */
  settingsTab: string;
  /** What holds the stage. Mirrors ./dom's `Stage`, without importing it. */
  stage: string;
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

/**
 * The permission modes under which a shell command still raises Episko's card.
 *
 * `Auto`, `Don't ask` and `Bypass` answer for you, and `Plan` runs nothing to be asked
 * about — so under those the tour must not wait for a permission, and says what it would
 * have shown instead. Duplicated from `ALL_PERM_MODES` in ./state rather than imported
 * (this module holds rules, not app state, and `TourWorld` is primitives by design), so
 * test/tour.test.ts checks the two against each other exactly as it does the rail legend.
 */
export const ASKING_MODES = ["default", "acceptEdits"] as const;
/** Can a permission card still appear for what the quickstart asks Claude to run? */
export const permAsks = (w: TourWorld): boolean =>
  (ASKING_MODES as readonly string[]).includes(w.permMode);

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

/**
 * A panel the step's anchor lives inside, which the user may have collapsed.
 *
 * The tour lights real controls, so a control that is not on screen is not a missing
 * anchor to step over — it is a panel to open. ⌘I takes the whole inspector away
 * (`#app.insp-off`), which is where the permission buttons and every Context card
 * live, and ⌘B does the same to the rail (`#app.rail-mini`), which is where the
 * project rows and the ＋ live. ./tourui asks its host to open these before it paints.
 */
export type TourNeed = "rail" | "inspector";

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
  /**
   * Skip the step entirely when false — the reactor badge is not on screen to teach.
   *
   * Evaluated live, on every pass, and that is safe **only** because ./tourui indexes
   * the chapter's full step list rather than the filtered one: a `when` that flipped
   * under a filtered index would silently renumber every step after it.
   */
  when?: (w: TourWorld) => boolean;
  /** Panels this step's anchor lives in, opened before it paints; see `TourNeed`. */
  needs?: readonly TourNeed[];
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
// The state class goes on the chip rather than on the glyph: it carries the colour for
// the glyph, the tint and the hairline at once (see `.tr-leg` in styles.css), so the key
// SHOWS each state instead of naming its colour in prose.
const legendHtml = () => RAIL_LEGEND
  .map((l) => `<span class="tr-leg ${l.cls}"><b>${l.glyph}</b><i>${l.label}</i></span>`).join("");

// ---------- the manifest ----------
// Everything above is machinery; this is the content. Adding a chapter is adding an
// entry, and adding a step is adding an object — there is no other place to touch.

export const CHAPTERS: Chapter[] = [
  {
    // rev 2 — the first cut was written against a mock rather than against the app, and
    // taught a launch flow that does not exist: it lit `＋ Session` and waited for the
    // launcher, but with nothing on the stage that button has no project to act on and
    // opens ⌘K instead (main.ts's `activeProjectCtx`), and even with one, `requestLaunch`
    // only offers the dialog for a repo that already has a session in it. So the required
    // chapter's second step could never be satisfied, and the user was left driving a
    // palette the tour had never mentioned. Every step below now lights the control that
    // the state left by the step before it actually responds to.
    id: "quickstart", rev: 2, required: true,
    name: "Quick start", mins: "3 min",
    blurb: "Get an agent running, and learn to read the rail",
    steps: [
      {
        anchor: "[data-add]", needs: ["rail"],
        title: "Add a project folder",
        body: "Point Episko at any folder with code in it — <b>a git repo shows the most</b>. Your system's folder "
          + "picker opens in front of this card.",
        wait: "Pick a folder to continue",
        done: (w) => w.projects > 0,
      },
      {
        // The row, and not its ＋: a project with nothing running in it renders as
        // `.phead.empty-p`, whose only affordance is "open →" — `.padd` is built for a
        // project that already HAS a session (./sidebar's `projectHtml`), which on a
        // first run is exactly what this one does not. Opening the page is also what
        // gives ＋ Session a project to act on, one step below.
        anchor: ".phead", dynamic: true, needs: ["rail"],
        title: "Open the project",
        body: "Click the row. A project opens as a <b>page</b> — what moved today, its issues, its scripts — and "
          + "every way of starting a session hangs off it. There is a whole chapter on that page.",
        wait: "Open it to continue",
        done: (w) => w.stage === "dash",
      },
      {
        // ＋ Session acts on whatever is on the stage, which is why the step above has
        // to come first: with an empty stage this button opens ⌘K instead — a question
        // the tour has just answered — and the first cut waited here for a launcher that
        // therefore never opened.
        anchor: "#btnNew",
        title: "Start a session",
        body: "This runs Claude Code in the project and instruments <em>that one launch</em> — a throwaway settings "
          + "file, thrown away with the session. You never edit a hook, and nothing is written into your repo.",
        wait: "Start one to continue",
        // Two shapes, because the app has two: a git repo is asked *where* first, and
        // anything else launches on the spot. The step after this covers the dialog and
        // is skipped when there wasn't one.
        done: (w) => isOpen(w, "wt") || w.sessions > 0,
      },
      {
        anchor: "#wtDlg",
        when: (w) => isOpen(w, "wt"),
        title: "Pick where it runs",
        body: "The repo itself, one of its worktrees, or any branch — one row each, <kbd>⏎</kbd> to launch. "
          + "<b>Take the repo for now</b>; worktrees have a chapter of their own.",
        wait: "Launch it",
        done: (w) => w.sessions > 0 && !isOpen(w, "wt"),
      },
      {
        // The pane, not the status pill: this is where the typing goes. The first cut
        // lit `#iPill` — the inspector's readout — which was the mock's idea of an
        // input. A pane is most of the window, so ./tourui pins the card inside a hole
        // this big rather than trying to sit beside it.
        anchor: "#terminals",
        title: "Give it a first job",
        body: "This pane <em>is</em> Claude Code. Ask it for something read-only, worth a couple of cents:<br>"
          + "<code>Run git status and tell me what's uncommitted.</code>",
        act: { label: "Paste it for me", id: "paste-first-prompt" },
        skip: "Skip the chapter",
        wait: "Send it to continue",
        // In an **asking** mode this deliberately does NOT release when the turn merely
        // starts: the step after it points at the reactor badge, which for a single
        // session on the stage only ever lights while a permission is pending (see
        // TourWorld.attnCount). Holding until the ask lands is what puts the badge on
        // screen in time to be taught.
        //
        // In a mode that answers for you there is nothing to hold for, and waiting would
        // strand the user for the full 20s before the "Skip this step" out appears — so
        // the turn starting is enough. Either way a turn that ends without ever asking
        // releases it, because a prompt Claude answers from memory raises nothing.
        done: (w) => w.permPending || w.permAnswered || w.phase === "done"
          || (!permAsks(w) && (w.phase === "working" || w.phase === "thinking")),
      },
      {
        // Only while the badge is genuinely on screen. `.attn-badge` is display:none
        // without `.show`, and ./attn deliberately does not count the pane you are
        // looking at — so on a first run this is the one moment it exists at all. The
        // old chapter lit it unconditionally, one step after the permission had been
        // answered, and so skipped itself silently on every single run.
        anchor: "#attnBadge",
        when: (w) => w.attnCount > 0 || w.permPending,
        title: "It wants you",
        body: "The <b>reactor</b> counts every session waiting on you and sorts them by urgency — a permission always "
          + "outranks a finished turn. Click it to jump straight to the one at the top. <b>This is why you can run ten "
          + "of these.</b>",
      },
      {
        anchor: ".attn-btns", dynamic: true, needs: ["inspector"],
        // Only in a mode that can actually raise one. `permAsks` is a fact about the
        // launch, so this resolves the moment the step is reached rather than after the
        // user has stared at "Answer it — either way" for twenty seconds waiting for a
        // card their permission mode had already promised never to show.
        when: (w) => permAsks(w) || w.permPending || w.permAnswered,
        title: "Blocked on you",
        body: `<b>Bash is not auto-allowed</b>, so Claude stopped. That <b class="g-attn">◆</b> means it is genuinely `
          + "paused until you answer — the only event with its own urgent sound.<br><b>Allow</b> once, <b>Deny</b>, "
          + "or hand it to a real terminal.",
        wait: "Answer it — either way",
        done: (w) => (w.permAnswered && !w.permPending) || (w.phase === "done" && !w.permPending),
      },
      {
        // The other half of the pair: the same lesson for someone whose mode answers for
        // them. It teaches rather than waits, because there is nothing coming to wait
        // for — and skipping the subject entirely would drop the app's most consequential
        // interaction from the one chapter everybody takes.
        when: (w) => !permAsks(w) && !w.permPending && !w.permAnswered,
        title: "What you are not being asked",
        body: "Your permission mode answers for you, so Claude ran that without stopping. In <b>Manual</b> it stops "
          + `instead: the row goes <b class="g-attn">pink ◆</b>, an urgent sound plays, and <b>Allow</b> / <b>Deny</b> / `
          + "<b>In terminal</b> appear in this panel. That switch is in Settings › Sessions.",
      },
      {
        anchor: "#projects", needs: ["rail"],
        // The one step that pays for the whole chapter, and the one the legend is
        // duplicated for. It teaches a key rather than painting a demo fleet: a
        // fabricated rail, in an app whose entire job is showing you real work, would
        // be the wrong first impression — so this sits beside whatever the user
        // actually has running, however little that is.
        title: "Read the rail",
        body: `<b>Seven glyphs, and the colour is the message.</b><div class="tr-legend">${legendHtml()}</div>`
          + `A <b class="g-attn">pink</b> row is blocked on you; a <b class="g-done">green</b> one finished and wants you. `
          + "The wash fades after a few seconds; the glyph stays until you have been to it.",
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
    id: "unattended", rev: 2,
    name: "Leave it running", mins: "90s",
    blurb: "Caffeinate, sounds, and the menu bar",
    steps: [
      {
        anchor: "#caf",
        title: "Keep the machine awake",
        // The cup arms whatever preset is stored, and the shipped default is "Keep
        // display awake" — the mode this step is actually about lives behind the caret.
        // Saying "arm it" and naming a different mode is how the first cut read.
        body: "The cup arms it; the <b>▾</b> beside it picks from five modes. The one to know is <b>Until agents "
          + "idle</b> — awake only while agents are working, then it lets go by itself. A machine that sleeps kills "
          + "a twenty-minute run.",
        wait: "Arm it to continue",
        done: (w) => w.caffeinated,
      },
      {
        // Two steps, because it is two gestures. Lighting ⚙ and then asking for
        // "Settings › Sounds" left the tab the user actually had to press sitting in
        // the dark next to a hole still pointing at the button that had already been
        // pressed. **The hole follows the gesture**: a step that opens a window hands
        // over to a step inside it.
        anchor: "#setBtn",
        title: "Everything else is in here",
        body: "Sounds, permission modes, keys, worktrees, and every day's usage — one window, and it is where the rest "
          + "of this chapter lives.",
        wait: "Open Settings",
        done: (w) => isOpen(w, "settings"),
      },
      {
        anchor: "[data-settab=\"sounds\"]", dynamic: true,
        title: "Tune what you hear",
        body: "Every event has its own tone and its own switch, previewable in place. <b>Four ship switched off</b> — "
          + "anything that fires on routine activity turns a fleet into a fruit machine.",
        wait: "Open the Sounds tab",
        done: (w) => w.settingsTab === "sounds",
      },
      {
        anchor: "#setBody",
        title: "The rule that stops the noise",
        body: "The same moment reaches Episko twice by design, so every play is gated. But a <b>more urgent</b> event "
          + "still cuts through the gap, which is the point: a permission always gets heard.",
      },
      {
        title: "It works with the window shut",
        body: "<kbd>esc</kbd> closes Settings. The {tray} icon mirrors the rail — the same glyphs, grouped by project "
          + "— so you can jump back into any session without the window at all.",
      },
    ],
  },

  {
    id: "worktrees", rev: 2,
    name: "Branches & worktrees", mins: "90s",
    blurb: "Right-click, peek, and a tree of its own",
    steps: [
      {
        // `.phead` and not `.pgroup`: the head is what carries `data-key`, which is what
        // ./projmenu's contextmenu handler matches on. The group wrapper around it
        // includes the session rows, so lighting it pointed at a target twice the size
        // of the one that answers.
        anchor: ".phead", dynamic: true, needs: ["rail"],
        title: "The project row has two hidden gestures",
        body: "<b>Right-click</b> it for the project's own menu — a session, a worktree, the commit graph, grouping, "
          + "its colour and logo.<br><b>Rest on it</b> and the checkouts with nothing running in them come back.",
        wait: "Right-click the project",
        done: (w) => isOpen(w, "ctx"),
      },
      {
        anchor: "[data-ctx=\"worktree\"]", dynamic: true,
        title: "A tree of its own",
        body: "A second checkout on its own branch. The agent gets a whole tree to itself and <b>your editor never "
          + "moves</b>. (No such row means this folder is not a git repo with a branch on it.)",
        wait: "Open it",
        done: (w) => isOpen(w, "wt") || !isOpen(w, "ctx"),
      },
      {
        // The step before this one opens the launcher OVER the rail, behind the scrim.
        // The first cut's next step lit `#projects` anyway — a hole on a control the
        // user could not reach. Every step from here stays inside the dialog until one
        // of them asks for it to be closed.
        anchor: "#wtDlg",
        when: (w) => isOpen(w, "wt"),
        title: "One dialog, every destination",
        body: "The repo, each of its worktrees, then every branch — one row each, with what the highlighted one would "
          + "cost you on the right. <kbd>⏎</kbd> launches; a name that does not exist yet offers to branch it.",
      },
      {
        anchor: "#projects", needs: ["rail"],
        title: "Switching and removing",
        body: "<kbd>esc</kbd> closes that. Back in the rail, right-click a checkout to switch its branch or remove it "
          + "— switching is <b>refused while a session is still working there</b>, and says so rather than going "
          + "quietly grey.",
        wait: "Close the dialog to continue",
        done: (w) => !isOpen(w, "wt"),
      },
      {
        title: "The commit graph",
        body: "One page at a time, lanes named by the branch that owns them. The fastest way to see where your "
          + "worktrees actually sit relative to each other. It is in that same right-click menu.",
      },
    ],
  },

  {
    id: "inspector", rev: 2,
    name: "Read what your agent did", mins: "60s",
    blurb: "Files, tools, and the diff it left",
    steps: [
      {
        // The chapter's precondition, said out loud rather than assumed: every card it
        // describes is built by `renderInspector` for a claude pane, so with a shell,
        // a task or the dashboard on the stage there is nothing here to light. Arriving
        // with a session already up costs one click; arriving without one used to cost
        // a step that sat on a dead anchor for twenty seconds.
        anchor: "#inspector", needs: ["inspector"],
        title: "Files, as a set",
        body: "This panel is about whatever pane is on the stage. Its Context card lists every file the agent touched, "
          + "once each — <b>read</b>, <b>edited</b>, <b>created</b>. Not a log of calls: an agent re-reads what it just "
          + "wrote constantly, so a file only ever climbs.",
        wait: "Put an agent on the stage",
        done: (w) => w.agentOnStage,
      },
      {
        anchor: "[data-fmode=\"tools\"]", dynamic: true, needs: ["inspector"],
        title: "Tools, and what came back",
        body: "The same card flips to the running order of every tool call — searches and commands included, not just "
          + "the ones that moved a file.",
        wait: "Switch to Tools",
        done: (w) => w.toolsTab,
      },
      {
        // `.wset` exists only for a session in a git repo, and a missing anchor on a
        // step that is not waiting is stepped over by design — which is the right
        // answer here: there is no working set to describe outside a repo.
        anchor: ".wset", dynamic: true, needs: ["inspector"],
        title: "The working set",
        body: "What git thinks changed, live, while the agent works — plus how the branch sits against its upstream. "
          + "Click a file to read the diff without leaving the app.",
      },
    ],
  },

  {
    id: "project", rev: 2,
    name: "The project homepage", mins: "90s",
    blurb: "Issues, PRs, and your own scripts",
    steps: [
      {
        anchor: "#projects", needs: ["rail"],
        title: "A project is a page, not a terminal",
        body: "The <b>＋</b> starts a session; clicking the project <em>name</em> opens its homepage. Three tiers, "
          + "depending on whether it has GitHub, git, or neither.",
        wait: "Open a project",
        done: (w) => w.stage === "dash",
      },
      {
        anchor: "#dashSpine",
        title: "Dispatch an agent at an issue",
        body: "Open issues and PRs, with a button on each row. It opens a worktree, briefs the session with the issue, "
          + "and <b>claims it</b> so nobody on the team doubles up.",
      },
      {
        anchor: "#dashPulse",
        title: "Today, and who else is in here",
        body: "What moved, what it cost, and a note you can leave for whoever opens this next.",
      },
      {
        anchor: "#btnRun",
        title: "Your scripts, without the terminal",
        body: "<code>package.json</code>, Makefile targets, and anything in <code>.episko/tasks.toml</code> — found, "
          + "not configured. <kbd>⌘</kbd><kbd>⇧</kbd><kbd>B</kbd> from anywhere.",
      },
    ],
  },

  {
    id: "cost", rev: 2,
    name: "What it costs", mins: "60s",
    blurb: "Today's spend and your limits",
    steps: [
      {
        anchor: "#fCostSeg",
        title: "Today, split",
        body: "The footer number is a button. It opens the breakdown by project and by session, so you can see which "
          + "agent is the expensive one.",
        wait: "Open the split",
        done: (w) => isOpen(w, "cost"),
      },
      {
        anchor: "#fUsageSeg",
        title: "Both windows, with a forecast",
        body: "Your 5-hour and weekly limits, plus the burn rate and <b>when you will actually hit them</b> at this "
          + "pace. It reads your own transcripts; nothing is sent anywhere.",
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

/**
 * Does this step apply to the app as it is right now?
 *
 * The one rule `when` has, exported rather than re-implemented in ./tourui, because the
 * driver asks it three ways — what to advance to, what to go back to, and what to count
 * — and three copies of "no `when` means yes" is three places to get it wrong.
 */
export const stepApplies = (s: TourStep, w: TourWorld): boolean => !s.when || s.when(w);


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
