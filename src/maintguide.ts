// What each Maintenance card and the header's chip answer, for their (i): what it shows, what it reads,
// how to read it and what you can do there. Markup only; ./maintui opens it. Sources are never named here.

import { esc } from "./format";
import type { ChipModel } from "./maintbadge";
import { FACET_DEFS, SOURCES, type Cost, type MaintCap } from "./maintsources";
import { icon, type IconName } from "./svgicons";

export const GUIDE_IDS = [
  "advisories", "runtimes", "update-prs", "packages", "ci", "flaky", "deployments", "releases", "hygiene", "work",
  "hosts", "addresses", "domains", "errors", "sweep", "cover", "also", "cards", "week", "todo", "runs", "sources", "chip",
] as const;
export type GuideId = (typeof GUIDE_IDS)[number];
export const isGuideId = (s: string): s is GuideId => (GUIDE_IDS as readonly string[]).includes(s);

interface Guide {
  title: string; ic: IconName;
  what: string; // what the card answers, in a sentence or two
  caps?: MaintCap[]; // what it is read from: every source that sees one of these
  from?: string; // or, where no source feeds it, where its rows come from
  look?: string; // how to read its colours and marks; the shared legend when absent
  act: string; // what you can do from it
  shapes?: [ChipModel, string][]; // the header chip only: each shape it takes, drawn, and when
}

const LEGEND = "Red is broken and needs you now, amber is drifting. A grey dot was checked and is fine; a ? could not be counted, a dash was not read.";
const G: Record<GuideId, Guide> = {
  advisories: { title: "Advisories and findings", ic: "shield", caps: ["sec.dependency", "sec.code", "sec.secret"],
    what: "Known vulnerabilities in what each project installs, and what code and secret scanning found in its code. One row per vulnerability across every project and reporter, grouped by severity; a group's chips are the projects it hits.",
    look: "Critical and high are red and open on their first rows, medium amber, low muted; a committed secret counts as worse than any of them. Click a group's head to fold or open it, and a project's chip to see only that project.",
    act: "Patch on a row starts an agent on that advisory alone; Patch all at the top briefs one agent per project on every advisory there. Each brief says what is installed, what fixes it and how to verify, and is prefilled, never sent: you press Enter." },
  runtimes: { title: "Runtime end-of-life", ic: "hourglass", caps: ["sec.runtime"],
    what: "The runtime and image versions each project declares (.nvmrc, engines, a toolchain file, a Dockerfile's image…) and when their release cycle ends.",
    look: "Ended is red, ending soon amber. A version no cycle holds is a ?, never fine.",
    act: "Upgrade starts an agent that moves the runtime in every file that declares it. The date opens the page that dates it." },
  "update-prs": { title: "Update pull requests", ic: "merge", caps: ["deps.update-prs", "deps.pr-checks"],
    what: "Open pull requests from update bots, per project and bot: how many, how many pass their checks, how many fail, and how old the oldest is.",
    look: "A failing update is amber, never red: it is drift, not an outage. A bot that has opened nothing for a long while is listed under Coverage.",
    act: "A number opens the project's dependency view at those pull requests." },
  packages: { title: "Packages", ic: "box", caps: ["deps.latest"],
    what: "How far each project's direct dependencies are behind their newest release, counted in major versions.",
    look: "Never red or amber: being behind is a ranking, not an alarm. A + is a floor: some packages could not be placed.",
    act: "Upgrade starts an agent with the packages behind their newest major. Behind opens the project's dependency view, where the package manager is asked." },
  ci: { title: "CI on the default branch", ic: "checks", caps: ["ci.default-branch", "ci.per-workflow", "ci.failing-since", "ci.external"],
    what: "Whether each project's default branch is green: each workflow's newest run, and how long one has been failing.",
    look: "Red: a workflow's newest run failed. The strip is the last runs, oldest to newest, and each dot opens its run.",
    act: "Fix starts an agent with the failing workflows and since when." },
  flaky: { title: "Flaky jobs", ic: "zap", caps: ["ci.reruns"],
    what: "Jobs that failed and then passed on a re-run of the same commit: noise that hides real failures.",
    look: "Amber, never red: a flaky job is noise, not a broken build.",
    act: "Fix starts an agent that hunts the nondeterminism in the job's logs. It never adds a retry." },
  deployments: { title: "Deployments", ic: "rocket", caps: ["rel.deployed"],
    what: "What each environment runs, and how many commits it is behind the trunk.",
    look: "Production far behind is amber; a failed deploy is red on production and amber elsewhere. Preview environments are hidden.",
    act: "Plan deploy writes down what would ship and stops: nothing is deployed for you. Fix reads a failed deploy's log." },
  releases: { title: "Releases", ic: "tag", caps: ["rel.unreleased", "rel.last", "rel.published", "rel.changelog"],
    what: "The last release tag, the commits since it and how old the oldest is, the published release and the changelog's Unreleased entries.",
    look: "Amber once unreleased work has waited past the threshold.",
    act: "Draft release starts an agent that writes the release; it never tags or publishes." },
  hygiene: { title: "Git hygiene", ic: "gitBranch", caps: ["git.unpushed", "git.local-only", "git.merged", "git.gone", "git.branch-age", "git.worktree-age"],
    what: "Housekeeping per repository, as of its last fetch: unpushed commits, branches only on this machine, merged or gone branches, untouched branches and idle worktrees.",
    look: "Unpushed work is amber, since it exists on this machine only. The rest is tidying, and grey.",
    act: "A number opens Branches with that filter picked. Push and Tidy start agents; Fetch runs git fetch here." },
  work: { title: "Open work", ic: "inbox", caps: ["work.issues", "work.prs", "work.review-requested"],
    what: "Open issues and pull requests per project, and the reviews waiting on you.",
    look: "A review requested of you is amber; open counts are grey.",
    act: "A number opens the project's queue on that chip." },
  hosts: { title: "Hosts", ic: "server", caps: ["prod.host"],
    what: "Each server a project's [deploy] host names: disks, pending and security updates, a needed reboot, containers and load.",
    look: "Only a part that needs you is coloured. A ? is a part that did not answer. Nothing connects until you click.",
    act: "Allow lets this machine reach a host; Check reads it over your own ssh, read-only. SSH opens a shell with the command typed in, never sent." },
  addresses: { title: "Addresses", ic: "plug", caps: ["prod.status", "prod.cert"],
    what: "Each [deploy] address: whether it answers, how fast, and when its certificate expires.",
    look: "No answer or an error status is red, a certificate close to its expiry amber. Nothing connects until you click.",
    act: "Check prod asks every address once." },
  domains: { title: "Domains", ic: "cloud", caps: ["prod.domain"],
    what: "When the registered domain behind each address runs out, as its registry says.",
    look: "Lapsed or expired is red, expiring soon amber.",
    act: "Fix starts an agent that finds who renews it; it changes nothing. The registrar opens its own page." },
  errors: { title: "Errors", ic: "bug", caps: ["prod.errors", "prod.errors-new"],
    what: "The error tracker [deploy] links: unresolved issues, and which are new since the newest release or came back.",
    look: "New or returning errors are amber, fatal ones or many affected users red. A tracker that heard nothing is grey, never fine.",
    act: "Fix reads the worst issues' stack traces and starts an agent to fix the cause, test first." },
  sweep: { title: "Advisory sweep", ic: "search",
    what: "One question asked of every project at once: does this advisory, or this package at this range, affect it?",
    from: "An advisory id is looked up on its public database, which receives that id and nothing else. A package and range sends nothing. Every project's lockfiles are read here and never run.",
    look: "Affected is red, unsure amber; patched and not using it are grey. Unsure means a version could not be placed, so it is never guessed.",
    act: "Patch an affected project, ask a read-only agent about an unsure one, or Brief N agents for every affected project. Copy report puts the verdicts on the clipboard." },
  cover: { title: "Coverage", ic: "eyeOff",
    what: "Everything this tab could not read, so a quiet board is never mistaken for a clean one.",
    from: "What each source said when it was asked, or that it never was.",
    look: "Grouped by what closes each gap: a click, a login or token, a switch on the forge, a retry, or nothing here at all.",
    act: "Each row carries its one action: Check or Run on a project, Copy a command, open a settings page or Settings › Maintenance. Once a project is checked, its chip says what came back and opens the board that shows it; Clear takes the answers off the row." },
  also: { title: "Also on this tab", ic: "list",
    what: "Lines of this tab that no board above carries, such as a facet nobody has set up.",
    from: "The same checks as the boards.", act: "Each line has its own verb." },
  cards: { title: "Project cards", ic: "layoutList",
    what: "One card per project, worst first. Its seven cells are the facets Maintenance checks; under them, each thing to do is one line.",
    from: "Every source each project has, read when you open this view or click Check. Nothing runs in a project, and nothing public or remote is asked, unless you click it.",
    act: "A cell or a line opens its tab at the board that counts it. Tick lines and Brief N agents starts one agent per line, tiled, each prefilled: you press Enter." },
  week: { title: "Since last week", ic: "history",
    what: "What changed between each project's check about a week ago and its latest: advisories, CI, releases, packages, deployments.",
    from: "The marks finished checks left on this machine. It asks nothing itself.",
    look: "Only what was read in full both times is compared; the line under the figures names the projects that were not.",
    act: "A line opens where it is counted." },
  todo: { title: "To do", ic: "squareCheck",
    what: "Everything to do in this project: the card's lines and the rows only a tab shows.",
    from: "This project's last check.",
    act: "A row opens the sub-tab and board that counts it; its verb starts an agent or a check." },
  runs: { title: "Runs on", ic: "server",
    what: "Where this project runs, from [deploy] in .episko/episko.toml: its host, addresses, environments and error tracker.",
    from: "The file only. Nothing connects to these until you click Check prod.",
    look: "Each address shows its last answer once one exists.",
    act: "Check prod asks them. Propose with an agent reads the repository, read-only, and proposes [deploy] for you to apply." },
  sources: { title: "Coverage", ic: "eyeOff",
    what: "Every source Maintenance found for this project and what became of it: read, switched off, refused, or not run yet.",
    from: "Detection: the project's files and its forge decide which sources apply.",
    look: "Grouped as a tab's Coverage is, by what closes each gap: a click, a login or token, a switch on the forge, a retry, or nothing here. What read cleanly is only named, under Read.",
    act: "Each row carries its action: a check to run, a command to copy, a settings page, a token or a host to allow." },
  chip: { title: "The Maintenance chip", ic: "wrench",
    what: "It speaks for whatever is on the stage, so it changes shape as you move between a project and the overview of every project.",
    shapes: [
      [{ tone: "bad", dots: ["ok", "warn", "ok", "ok", "bad", "ok", "unread"], count: 2, busy: null, frac: null, tip: [] },
        `A project is on the stage: one of its sessions, its dashboard or a review. One dot per facet, in card order: ${FACET_DEFS.map((f) => f.label).join(", ")}. The number is its red and amber lines.`],
      [{ tone: "bad", dots: null, count: 3, busy: null, frac: null, tip: [] },
        "No project on the stage: it speaks for every project. No dots; the number counts the projects that need you or are drifting."],
      [{ tone: "muted", dots: null, count: null, busy: "4/11", frac: null, tip: [] },
        "A check is reading: reads done of one project's, or projects done of all."],
    ],
    from: "Each project's last check, kept on this machine. The chip asks nothing itself; Check in its overview reads a project again.",
    look: "Red needs you now, amber is drifting, a grey dot was checked and is fine, a hollow one was not read. No colour at all: only an earlier check is known until this session checks again. No number: nothing is red or amber.",
    act: "Click it for an overview: the project on the stage, then every project. A facet or a line opens its tab in that project's Maintenance view; the ↗ in a heading opens the whole view." },
};

/** The header chip's markup, here so the chip guide draws exactly what the header does. */
export function chipHtml(c: ChipModel): string {
  if (c.busy) return `<span class="u-spin"></span><span class="mb-n mono">${esc(c.busy)}</span>`;
  const dots = c.dots ? `<span class="mb-dots">${c.dots.map((l) => `<i class="l-${l}"></i>`).join("")}</span>` : "";
  return `<span class="mb-ic">${icon("wrench", "solo")}</span>${dots}${c.count ? `<span class="mb-n">${c.count}</span>` : ""}`;
}
export const chipClass = (c: ChipModel): string => `mt-badge show t-${c.tone}${c.busy ? " busy" : ""}`;

const shapesHtml = (ss: readonly [ChipModel, string][]) => `<div class="mg-shapes">${ss.map(([c, said]) =>
  `<span class="${chipClass(c)}" aria-hidden="true">${chipHtml(c)}</span><p>${esc(said)}</p>`).join("")}</div>`;

export const COST_WORD: Record<Cost, string> = {
  local: "Every check · this machine", forge: "Every check · the forge", public: "On a click · a public service",
  tool: "On a click · runs in the project", remote: "Check prod · your servers",
};
// The sources behind a card, grouped by when they are asked; a public one also rides every check if Settings allows it.
function fromHtml(caps: readonly MaintCap[]): string {
  const srcs = SOURCES.filter((s) => s.sees.some((c) => caps.includes(c)));
  const by = (Object.keys(COST_WORD) as Cost[]).flatMap((c) => {
    const ls = srcs.filter((s) => s.cost === c).map((s) => s.label);
    return ls.length ? [`<li><span class="k">${esc(COST_WORD[c])}</span>${esc(ls.join(", "))}</li>`] : [];
  });
  return by.length ? `<ul class="mg-src">${by.join("")}</ul>` : "";
}

/** The popover's inner markup for one card. */
export function guideHtml(id: GuideId): string {
  const g = G[id];
  const from = g.caps ? fromHtml(g.caps) : g.from ? `<p>${esc(g.from)}</p>` : "";
  const part = (k: string, body: string) => body ? `<div class="mg-part"><span class="mg-k">${esc(k)}</span>${body}</div>` : "";
  return `<div class="mg-h">${icon(g.ic)}<b>${esc(g.title)}</b></div><p class="mg-what">${esc(g.what)}</p>`
    + (g.shapes ? part("Its shapes", shapesHtml(g.shapes)) : "")
    + part("Read from", from) + part("How to read it", `<p>${esc(g.look ?? LEGEND)}</p>`) + part("What you can do", `<p>${esc(g.act)}</p>`);
}
/** The icon a card's head wears, the same as its popover's. */
export const guideIcon = (id: GuideId): IconName => G[id].ic;
