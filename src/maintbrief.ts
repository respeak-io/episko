// One brief per finding, written from the facts alone so an agent gets the evidence rather than a
// vendor's name for it. Each is prefilled and never sent: Episko presses Enter in two places only.

import { compatBlock, verifyBlock } from "./deps";
import {
  ciFailures, clampMaint, mergeAdvisories, okFacts, redFor, rtName, runtimeStates, span,
  type AdvisoryKind, type CiFailure, type Facts, type Finding, type MaintInput, type MergedAdvisory, type RuntimeState, type Verb,
} from "./maint";

export interface MaintBriefCtx {
  project: string;
  verify: string[]; // the project's own check commands (`verifyCommands` in ./deps)
  now?: number;
}

type Brief = (f: Finding, inp: MaintInput, ctx: MaintBriefCtx) => string[] | null;

const bullet = (s: string) => `- ${s}`;
const ago = (at: number, ctx: MaintBriefCtx) => span((ctx.now ?? Date.now()) / 1000 - at);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function factsOf<K extends Facts["kind"]>(f: Finding, inp: MaintInput, kind: K): Extract<Facts, { kind: K }> | null {
  const r = inp.reports[f.source];
  return r?.coverage.state === "ok" && r.facts?.kind === kind ? r.facts as Extract<Facts, { kind: K }> : null;
}

// The rows behind the finding's line, from the reports that line counted, worst first, so the
// brief names the fix whichever reporter knew it. `capped` when any of them hit its page cap.
function advisoriesOf(f: Finding, inp: MaintInput, ...want: AdvisoryKind[]): { all: MergedAdvisory[]; capped: boolean } {
  const kind = f.ref as AdvisoryKind;
  if (!want.includes(kind)) return { all: [], capped: false };
  const reps = okFacts(inp, "security").flatMap((r) =>
    r.facts.kind === "advisories" && r.facts.items.some((i) => i.kind === kind) ? [{ ...r, items: r.facts.items }] : []);
  return { all: mergeAdvisories(reps.map((r) => r.items)).filter((a) => a.kind === kind), capped: reps.some((r) => r.truncated) };
}
const cappedNote = (capped: boolean, what: string) =>
  capped ? ["", `This list hit a page cap, so more ${what} may exist than are named here: check again once these are done.`] : [];

const named = (a: MergedAdvisory) => `${a.id}${a.aliases.length ? ` (${a.aliases.join(", ")})` : ""}`;
const placesOf = (a: MergedAdvisory) => [...new Set(a.items.map((x) => x.location).filter((l): l is string => !!l))];
// One row reads as before; several get a heading each, so every one keeps its own facts.
const each = <T>(all: T[], head: (a: T) => string, body: (a: T) => string[]) =>
  all.length === 1 ? body(all[0]) : all.flatMap((a) => ["", `### ${head(a)}`, ...body(a)]);

// Every red workflow, as the one CI line counts them, oldest first.
const ciBrief: Brief = (_f, inp, ctx) => {
  const red = ciFailures(okFacts(inp, "ci"));
  if (!red.length) return null;
  const one = red.length === 1, sec = (ctx.now ?? Date.now()) / 1000, x = red[0];
  const age = (w: CiFailure) => redFor(w, sec);
  const body = (w: CiFailure) => {
    const facts = inp.reports[w.source]?.facts;
    const runs = facts?.kind === "ciRuns" ? facts.runs.filter((r) => r.workflow === w.workflow).slice(0, 8) : [];
    return [
      ...(w.url ? [w.url] : []), ...(one ? [""] : []),
      bullet(w.sha ? `first failing commit: ${w.sha}` : `failing at ${w.branch}'s head, ${runs[0]?.sha ?? "?"}; this CI reports no history`),
      bullet(`recent runs, newest first: ${runs.map((r) => r.status).join(", ")}`),
    ];
  };
  return [
    one ? `CI is failing on ${x.branch} in ${ctx.project}: the ${x.workflow} workflow${age(x) ? `, red for ${age(x)}` : ""}.`
      : `CI is failing in ${ctx.project}: ${red.length} workflows, oldest first. One cause may break several; say which.`,
    ...each(red, (w) => `${w.workflow} on ${w.branch}${age(w) ? `, red for ${age(w)}` : ""}`, body),
    "",
    `Read the failing ${one ? "run's log at the link above" : "runs' logs at the links above"} and find the cause before changing anything:`,
    "say whether the code, the test or the CI environment is wrong, and reproduce it locally if you can.",
    "Fix the cause, never the symptom: do not skip, retry or loosen a test to get it green.",
    "",
    ...verifyBlock(ctx.verify),
  ];
};

// Another reporter may know a package's fix; another package's fix is never this one's.
function pkgRows(a: MergedAdvisory): string[] {
  const seen = new Set<string>();
  const fixOf = (x: (typeof a.items)[number]) =>
    x.fixed ?? a.items.find((y) => y.fixed && y.pkg === x.pkg && y.ecosystem === x.ecosystem)?.fixed ?? null;
  return a.items.filter((x) => { const k = `${x.pkg}@${x.version}@${x.location}`; return !seen.has(k) && !!seen.add(k); }).map((x) =>
    bullet(`${x.pkg ?? "?"} ${x.version ?? "?"}${x.ecosystem ? ` (${x.ecosystem})` : ""}${x.location ? ` in ${x.location}` : ""}; `
      + (fixOf(x) ? `fixed in ${fixOf(x)}` : "no fixed version published")));
}

const patchBrief: Brief = (f, inp, ctx) => {
  const { all, capped } = advisoriesOf(f, inp, "dependency");
  if (!all.length) return null;
  const one = all.length === 1;
  return [
    one ? `Patch ${named(all[0])} · ${all[0].severity} in ${ctx.project}.`
      : `Patch ${all.length} advisories in ${ctx.project}, worst first. One upgrade may clear several; say which.`,
    ...each(all, (a) => `${named(a)} · ${a.severity}`, (a) => [a.summary, ...(a.url ? [a.url] : []), ...(one ? [""] : []), ...pkgRows(a)]),
    ...cappedNote(capped, "advisories"),
    "",
    ...compatBlock(),
    ...verifyBlock(ctx.verify),
  ];
};

const rotateBrief: Brief = (f, inp, ctx) => {
  const { all, capped } = advisoriesOf(f, inp, "secret");
  if (!all.length) return null;
  const one = all.length === 1;
  return [
    one ? `A secret was reported in ${ctx.project}: ${all[0].summary}` : `${all.length} secrets were reported in ${ctx.project}.`,
    ...each(all, (a) => `${a.id}: ${a.summary}`, (a) => [
      ...(a.url ? [a.url] : []), ...(one ? [""] : []),
      bullet(`report: ${a.id}`), ...placesOf(a).map((l) => bullet(`found in ${l}`)),
    ]),
    ...cappedNote(capped, "secrets"),
    "",
    `Treat ${one ? "it" : "each"} as leaked. Say where it was issued and how to rotate or revoke it there, then remove it`,
    "from the code and load it from the environment or a secret store instead. Rewriting git history",
    "is a decision for a person: describe what it would take, do not do it.",
    "",
    ...verifyBlock(ctx.verify),
  ];
};

// A scanner's finding in the project's own code or config: judged in place, never silenced.
const codeBrief: Brief = (f, inp, ctx) => {
  const { all, capped } = advisoriesOf(f, inp, "code", "config");
  if (!all.length) return null;
  const one = all.length === 1, config = f.ref === "config";
  const sev = (a: MergedAdvisory) => a.severity === "unknown" ? "" : `, ${a.severity}`;
  return [
    one ? `A scanner reported ${config ? "a misconfiguration" : "a finding"} in ${ctx.project}: ${all[0].id}${sev(all[0])}.`
      : `A scanner reported ${all.length} ${config ? "misconfigurations" : "findings"} in ${ctx.project}, worst first.`,
    ...each(all, (a) => `${a.id}${sev(a)}`, (a) => [
      a.summary, ...(a.url ? [a.url] : []), ...(one ? [""] : []), ...placesOf(a).map((l) => bullet(`at ${l}`)),
    ]),
    ...cappedNote(capped, "findings"),
    "",
    "Read the code at each place and say whether each report is right before changing anything. If it",
    "is, fix the cause and add a test that would have caught it. If it is a false positive, say why and",
    "change nothing: do not add a suppression comment or weaken the rule to make it go away.",
    "",
    ...verifyBlock(ctx.verify),
  ];
};

// Every runtime past or near its end, as the one Upgrade line counts them, worst first.
const upgradeBrief: Brief = (_f, inp, ctx) => {
  const due = runtimeStates(inp, clampMaint(inp.det?.config.thresholds), ctx.now).filter((r) => r.level === "bad" || r.level === "warn");
  if (!due.length) return null;
  const one = due.length === 1, r = due[0];
  const when = (x: RuntimeState) => typeof x.eol === "number" ? ` on ${new Date(x.eol * 1000).toISOString().slice(0, 10)}` : "";
  const end = (x: RuntimeState) => x.level === "bad" ? `reached its end of life${when(x)}` : `reaches its end of life${when(x)}`;
  return [
    one ? `Upgrade ${rtName(r)} in ${ctx.project}: it ${end(r)}, and gets no security fixes after it.`
      : `Upgrade ${due.length} runtimes in ${ctx.project} at or near their end of life, worst first. Each gets no security fixes after it.`,
    ...each(due, (x) => `${rtName(x)} · ${x.text}`, (x) => [
      ...(one ? [] : [`It ${end(x)}.`]), ...(x.url ? [x.url] : []), ...(one ? [""] : []),
      ...x.decls.map((d) => bullet(`${d.file} declares ${d.declared}`)),
      ...(x.newest ? [bullet(`the newest cycle is ${x.newest}`)] : []),
    ]),
    "",
    "Move each to a supported cycle, the newest the project's dependencies allow, in every file that",
    "declares it, and keep them in step: version files, the engines field, Dockerfiles, compose files and",
    "the CI matrix. Search the repository for the old version too: the files above are only those read.",
    "Read the runtime's release notes between the two cycles and say what changes for this code first.",
    "",
    ...verifyBlock(ctx.verify),
  ];
};

const releaseBrief: Brief = (f, inp, ctx) => {
  const r = factsOf(f, inp, "release");
  if (!r?.tag || !r.since) return null;
  const range = `${r.tag}..${r.trunk ?? "HEAD"}`;
  return [
    `${plural(r.since, "commit")} since ${r.tag} in ${ctx.project}${r.oldestUnreleasedAt ? `, the oldest ${ago(r.oldestUnreleasedAt, ctx)} old` : ""}.`,
    "",
    `Draft the release notes for them: read \`git log ${range}\` and any Unreleased section of the`,
    "changelog, group the changes the way this project's earlier releases do, and say what a user",
    "would notice. Propose the next version number and why.",
    "",
    "Do not bump a version, tag, push or publish anything: a person cuts the release.",
  ];
};

const pushBrief: Brief = (f, inp, ctx) => {
  const h = factsOf(f, inp, "hygiene");
  if (!h?.unpushed) return null;
  return [
    `${plural(h.unpushed, "commit")} in ${ctx.project} exist only on this machine.`,
    "",
    ...(h.localOnly.length ? [bullet(`never pushed: ${h.localOnly.join(", ")}`)] : []),
    bullet("list them with `git log --branches --not --remotes --oneline`"),
    "",
    "For each branch, say what the work is and whether it is ready. Run the project's checks on the",
    "ready ones and push them to their upstream; leave the rest with a one-line reason. Never force-push.",
    ...(ctx.verify.length ? ["", "The checks:", ...ctx.verify.map((c) => `    ${c}`)] : []),
  ];
};

const tidyBrief: Brief = (f, inp, ctx) => {
  const h = factsOf(f, inp, "hygiene");
  if (!h || !(h.merged.length + h.gone.length)) return null;
  return [
    `Tidy the local branches in ${ctx.project}.`,
    "",
    ...(h.merged.length ? [bullet(`merged into ${h.trunk ?? "the trunk"}: ${h.merged.join(", ")}`)] : []),
    ...(h.gone.length ? [bullet(`upstream gone: ${h.gone.join(", ")}`)] : []),
    "",
    "Delete the merged ones with `git branch -d`, never `-D`: a refusal means one is not merged after",
    "all, so report it instead. A branch whose upstream is gone may still hold work; check before",
    "deleting it and ask if it does. Touch no remote branch and no worktree.",
  ];
};

const reviewBrief: Brief = (f, inp, ctx) => {
  const u = factsOf(f, inp, "updatePrs");
  if (!u?.prs.length) return null;
  const prs = [...u.prs].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return [
    `Review ${plural(prs.length, "open update pull request")} in ${ctx.project}, oldest first.`,
    "",
    ...prs.map((p) => bullet(`#${p.number} ${p.title} · checks ${p.checks}${p.draft ? " · draft" : ""} · ${p.url}`)),
    "",
    "For each, read the diff and the package's release notes between the two versions and say",
    "whether it is safe to merge. Fix a red one on its own branch.",
    "",
    ...compatBlock(),
    ...verifyBlock(ctx.verify),
  ];
};

const prodBrief: Brief = (f, inp, ctx) => {
  const p = factsOf(f, inp, "probes")?.items.find((x) => x.name === f.ref);
  if (!p) return null;
  const head = f.key.startsWith("prod:cert:") && p.certNotAfter !== null
    ? [`The certificate for ${p.url} (${ctx.project}) ${p.certNotAfter * 1000 <= (ctx.now ?? Date.now()) ? "has expired" : `expires in ${span(p.certNotAfter - (ctx.now ?? Date.now()) / 1000)}`}.`,
      "Find what is meant to renew it and why it has not."]
    : [`${p.name} (${p.url}) in ${ctx.project} ${p.code !== null ? `answered ${p.code}` : "did not answer"}${p.err ? `: ${p.err}` : ""}.`,
      "Find out why: read the service's logs and its recent deploys."];
  return [
    ...head,
    "",
    "Change nothing in production yourself. Say what is wrong, what you would change and how to",
    "verify it, and wait for a person before restarting, redeploying or rolling back anything.",
  ];
};

// A facet with nothing reading it, or code scanning off; the forge is named only as the remote spells it.
const setupBrief: Brief = (f, inp, ctx) => {
  const host = inp.det?.forge.host;
  const on = host ? ` The remote is on ${host}.` : "";
  const found = inp.det?.markers.filter((m) => m.facet === f.facet).flatMap((m) => m.found) ?? [];
  const seen = found.length ? ["", bullet(`already in the tree: ${found.join(", ")}`)] : [];
  if (f.facet === "ci") {
    return [
      `${ctx.project} has no CI on its default branch that Episko can read.${on}`, ...seen, "",
      "Add a CI workflow on the CI this remote already offers that runs the project's checks on every",
      "push to the default branch and on every pull request. Match how the project is built today:",
      "read its manifests and scripts first, and pin the toolchain versions they use.",
      ...(ctx.verify.length ? ["", "The checks:", ...ctx.verify.map((c) => `    ${c}`)] : []),
      "", "Do not push or enable anything on the remote: a person reviews the workflow first.",
    ];
  }
  if (f.facet === "deps") {
    return [
      `${ctx.project} has no update bot opening dependency pull requests.${on}`, ...seen, "",
      "Add the configuration for an update bot this remote supports, covering every package manager",
      "the project uses: group patch and minor updates, keep majors separate, and schedule it weekly.",
      "Say which bot you chose and why, and what a person must switch on for it to run.",
    ];
  }
  // `coverSetups`: the forge offers code scanning and has it switched off.
  if (f.facet === "security" && f.ref === "sec.code") {
    return [
      `${ctx.project} has code scanning switched off, so nothing analyses its code for vulnerabilities.${on}`, "",
      "Add a code-scanning workflow on the CI this remote already offers that analyses every language",
      "the project is written in, on every push to the default branch, on every pull request and once a",
      "week, and uploads its results to the remote's code scanning. Read the manifests and build scripts",
      "first, so a compiled language is built the way the project builds it today.",
      "", "Do not push or enable anything on the remote: a person reviews the workflow first, then switches code scanning on.",
    ];
  }
  return null;
};

const BRIEFS: Record<Verb, Brief> = {
  fix: (f, inp, ctx) => f.facet === "prod" ? prodBrief(f, inp, ctx) : f.facet === "ci" ? ciBrief(f, inp, ctx)
    : f.facet === "security" ? codeBrief(f, inp, ctx) : null,
  patch: patchBrief, rotate: rotateBrief, upgrade: upgradeBrief, release: releaseBrief, push: pushBrief, tidy: tidyBrief, review: reviewBrief,
  setup: setupBrief, fetch: () => null, run: () => null, // a fetch and a read are not an agent's work
};

/** The brief a finding's verb prefills, or null once the facts behind it are gone. */
export function briefFor(f: Finding, inp: MaintInput, ctx: MaintBriefCtx): string | null {
  return BRIEFS[f.verb](f, inp, ctx)?.join("\n") ?? null;
}
