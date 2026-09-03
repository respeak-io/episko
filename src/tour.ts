// The guided tour's rules: the chapters, when one is offered, how a step decides it is
// done. No DOM, Tauri or render import; ./tourui drives and paints. test/tour.test.ts
// parses this file to check static anchors against index.html; `dynamic: true` exempts one.

// What a step may ask about the running app: a flat snapshot of primitives rather than
// the `sessions` map, so this module stays free of ./state. ./tourui rebuilds it each pass.
export interface TourWorld {
  projects: number;  // pinned in the rail
  sessions: number;  // live, of any kind
  phase: string;  // the active session's, or "" with nothing on the stage
  agentOnStage: boolean;  // an integrated agent pane, not a shell, task or dashboard
  provider: string;  // "" when no agent pane owns the stage
  permissionCanAsk: boolean;  // the provider's launch policy can raise an approval card
  permPending: boolean;  // in some session, not necessarily the active one
  permAnswered: boolean;  // at least one answered this run
  // The mode new sessions start in (Settings › Sessions). Deliberately read by NOTHING: what
  // decides is `permissionCanAsk`, i.e. what the provider actually did, and three tests in
  // test/tour.test.ts pass this field precisely to pin that it is ignored.
  permMode: string;
  // What the reactor badge counts (`needsYouSessions`). The active pane never counts, so
  // on a first run only a blocking permission lights it, which is when the tour teaches it.
  attnCount: number;
  open: readonly string[];  // see OPEN_IDS
  settingsTab: string;  // "" when Settings is closed
  stage: string;  // mirrors ./dom's Stage without importing it
  // The Context card's Tools tab, not an expanded tool row: that row is issue #96 and
  // unshipped. Tighten this and the step's copy together when it lands.
  toolsTab: boolean;
  caffeinated: boolean;  // armed in any mode
}

// Claude's modes under which a shell command still raises a card. The adapters' `asks` field
// owns the answer, so this is documentation with a test on it: the contract test checks the
// list still names modes the app ships, which is what catches a mode renamed out from under it.
export const ASKING_MODES = ["default", "acceptEdits"] as const;
export const permAsks = (w: TourWorld): boolean => w.permissionCanAsk;

/** The overlay names `TourWorld.open` may carry. */
export const OPEN_IDS = ["wt", "settings", "ctx", "run", "palette", "graph", "cost", "usage"] as const;
export type OpenId = (typeof OPEN_IDS)[number];
const isOpen = (w: TourWorld, id: OpenId) => w.open.includes(id);

// A card's secondary button: the step names an intent and ./tourui performs it (`runAct`),
// so this module still reaches no IPC.
export type TourActId = "paste-first-prompt";
export interface TourAct { label: string; id: TourActId }

// A collapsed panel the anchor lives in (⌘I hides the inspector, ⌘B minimises the rail);
// ./tourui asks its host to open it before painting rather than stepping over the anchor.
export type TourNeed = "rail" | "inspector";

export interface TourStep {
  anchor?: string;  // CSS selector to light; omitted means a centred card over a plain dim
  dynamic?: boolean;  // exists only in some app state; exempt from the static-anchor test
  title: string;
  body: string;  // HTML authored here, never from user input; two short sentences at most
  wait?: string;  // shown while waiting; its presence is what disables Next
  done?: (w: TourWorld) => boolean;  // advance once true; evaluated every renderAll pass
  // Skip the step when false. Evaluated live, which is safe only because ./tourui indexes
  // the full step list rather than the filtered one, so a flip cannot renumber later steps.
  when?: (w: TourWorld) => boolean;
  needs?: readonly TourNeed[];  // opened before the step paints
  act?: TourAct;
  skip?: string;  // a "skip the rest of this chapter" out; only where a step can cost money
}

export interface Chapter {
  id: string;
  rev: number;  // bump to re-offer a rewritten chapter; `done` holds id@rev
  name: string;
  blurb: string;  // one line, in the picker and Settings › Guide
  mins: string;  // rough length, e.g. "90s"
  required?: boolean;  // cannot be unchecked in the picker; exactly one chapter
  since?: string;  // a release intro: offered from What's new, never on a first run
  steps: TourStep[];
}

// ---------- the rail's vocabulary ----------
// Duplicated from GLYPH/GCLASS in ./sidebarview (a logic module may not import a view);
// test/tour.test.ts compares the two tables in both directions.
export const RAIL_LEGEND: { glyph: string; cls: string; label: string }[] = [
  { glyph: "●", cls: "g-work",  label: "working" },
  { glyph: "✓", cls: "g-done",  label: "your turn" },
  { glyph: "◆", cls: "g-attn",  label: "blocked on you" },
  { glyph: "◐", cls: "g-bg",    label: "fleet still running" },
  { glyph: "✕", cls: "g-error", label: "the turn broke" },
  { glyph: "○", cls: "g-idle",  label: "idle" },
  { glyph: "·", cls: "g-ended", label: "ended" },
];
// The state class goes on the chip: `.tr-leg` colours glyph, tint and hairline from it.
const legendHtml = () => RAIL_LEGEND
  .map((l) => `<span class="tr-leg ${l.cls}"><b>${l.glyph}</b><i>${l.label}</i></span>`).join("");

// ---------- the manifest ----------

export const CHAPTERS: Chapter[] = [
  {
    // Each step lights a control that actually works in the state the previous step leaves behind.
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
        // The row, not its ＋: a project with nothing running has no `.padd`, and opening
        // the page is what gives ＋ Session a project to act on in the next step.
        anchor: ".phead", dynamic: true, needs: ["rail"],
        title: "Open the project",
        body: "Click the row. A project opens as a <b>page</b> — what moved today, its issues, its scripts — and "
          + "every way of starting a session hangs off it. There is a whole chapter on that page.",
        wait: "Open it to continue",
        done: (w) => w.stage === "dash",
      },
      {
        // ＋ Session acts on whatever is on the stage; with an empty stage it opens ⌘K instead.
        anchor: "#btnNew",
        title: "Start a session",
        body: "This runs the coding agent selected for the project in its real terminal and connects the provider's "
          + "structured state when it has one. Nothing is written into your repo.",
        wait: "Start one to continue",
        // A git repo is asked where first; anything else launches on the spot.
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
        // The pane, not the status pill: this is where the typing goes.
        anchor: "#terminals",
        title: "Give it a first job",
        body: "This pane <em>is</em> the agent's real terminal. Ask it for something read-only:<br>"
          + "<code>Run git status and tell me what's uncommitted.</code>",
        act: { label: "Paste it for me", id: "paste-first-prompt" },
        skip: "Skip the chapter",
        wait: "Send it to continue",
        // In an asking mode, hold until the ask lands so the badge is on screen for the next
        // step; in a mode that answers for you the turn starting is enough (waiting would
        // strand the user for 20s). A turn that ends without asking releases either way.
        done: (w) => w.permPending || w.permAnswered || w.phase === "done"
          || (!permAsks(w) && (w.phase === "working" || w.phase === "thinking")),
      },
      {
        // Only while the badge is on screen: ./attn never counts the pane you are looking
        // at, so on a first run a pending permission is the one moment it exists.
        anchor: "#attnBadge",
        when: (w) => w.attnCount > 0 || w.permPending,
        title: "It wants you",
        body: "The <b>reactor</b> counts every session waiting on you and sorts them by urgency — a permission always "
          + "outranks a finished turn. Click it to jump straight to the one at the top. <b>This is why you can run ten "
          + "of these.</b>",
      },
      {
        anchor: ".attn-btns", dynamic: true, needs: ["inspector"],
        // Only when this turn actually produced a card; a policy that can ask is not a promise.
        when: (w) => w.permPending || w.permAnswered,
        title: "Blocked on you",
        body: `<b>This command was not auto-allowed</b>, so the agent stopped. That <b class="g-attn">◆</b> means it is genuinely `
          + "paused until you answer — the only event with its own urgent sound.<br><b>Allow</b> once, <b>Deny</b>, "
          + "or hand it to a real terminal.",
        wait: "Answer it — either way",
        done: (w) => (w.permAnswered && !w.permPending) || (w.phase === "done" && !w.permPending),
      },
      {
        // The pair's other half, for a mode that answers for you: it teaches, never waits.
        when: (w) => !w.permPending && !w.permAnswered,
        title: "What you are not being asked",
        body: "No permission card appeared for that command: the provider considered it safe or its configured policy "
          + `answered automatically. When an integrated provider does stop, the row goes <b class="g-attn">pink ◆</b>, `
          + "an urgent sound plays, and <b>Allow</b> / <b>Deny</b> / <b>In terminal</b> appear here. Claude's starting mode is in Settings › Sessions.",
      },
      {
        anchor: "#projects", needs: ["rail"],
        // A key beside whatever the user really has running, never a fabricated demo fleet.
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
        // The cup arms whatever preset is stored; the mode this step teaches is behind the caret.
        body: "The cup arms it; the <b>▾</b> beside it picks from five modes. The one to know is <b>Until agents "
          + "idle</b> — awake only while agents are working, then it lets go by itself. A machine that sleeps kills "
          + "a twenty-minute run.",
        wait: "Arm it to continue",
        done: (w) => w.caffeinated,
      },
      {
        // Two steps for two gestures: a step that opens a window hands over to one inside it.
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
        // `.phead` carries the `data-key` ./projmenu's contextmenu handler matches on;
        // `.pgroup` also wraps the session rows.
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
        // The launcher is open over the rail, behind the scrim: every step from here stays
        // inside the dialog until one asks for it to be closed.
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
        // Every card here is built for an agent pane; a shell, task or dashboard on the
        // stage leaves nothing to light.
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
        // `.wset` exists only in a git repo; a non-waiting step with no anchor is stepped over.
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
export const pickerChapters = (): Chapter[] => CHAPTERS.filter((c) => !c.since);
export const releaseChapter = (version: string): Chapter | null =>
  CHAPTERS.find((c) => c.since === version) ?? null;

// ---------- the store ----------
// One JSON blob under `cc-tour`: the halves are only ever read together.

export const TOUR_KEY = "cc-tour";

export interface TourState {
  v: 1;
  done: string[];  // finished or skipped, as id@rev
  queue: string[];  // picked but not yet taken, in order
  at: { ch: string; step: number } | null;  // where a chapter was interrupted, so a quit mid-tour resumes
}

export const tourDefaults = (): TourState => ({ v: 1, done: [], queue: [], at: null });

// Read defensively: a hand-mangled key decays to "offer nothing", never to "offer
// everything", which would ambush someone mid-session.
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
      // A queued id we no longer ship is dropped here, not when it would be played.
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

export function recordDone(st: TourState, c: Chapter): TourState {
  const key = chapterKey(c);
  return {
    ...st,
    done: st.done.includes(key) ? st.done : [...st.done, key],
    queue: st.queue.filter((id) => id !== c.id),
    at: st.at?.ch === c.id ? null : st.at,
  };
}

// The absence of the key and nothing else: a new build alone must never open anything,
// and "does localStorage look used" is the fresh-install guard docs/releases.md warns of.
export const shouldOfferPicker = (raw: string | null) => raw === null;

export function shouldOfferRelease(version: string, st: TourState): Chapter | null {
  const c = releaseChapter(version);
  return c && !isDone(st, c) ? c : null;
}

// ---------- walking a chapter ----------

// Exported so ./tourui's three uses share one reading of "no `when` means yes".
export const stepApplies = (s: TourStep, w: TourWorld): boolean => !s.when || s.when(w);


/** Is Next disabled? A step waits only if it says so *and* its condition is unmet. */
export const stepBlocked = (s: TourStep, w: TourWorld) => !!s.wait && !(s.done?.(w) ?? true);

/** Has a waiting step's condition been met? False for a step that never waits. */
export const stepSatisfied = (s: TourStep, w: TourWorld) => !!s.wait && !!s.done?.(w);

/** The chosen chapters in manifest order, so the required one always comes first. */
export const planFor = (ids: readonly string[]): Chapter[] =>
  CHAPTERS.filter((c) => !c.since && ids.includes(c.id));
