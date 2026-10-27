// One brief per finding, written from the facts alone so an agent gets the evidence rather than a
// vendor's name for it. Each is prefilled and never sent: Episko presses Enter in two places only.

import { compatBlock, verifyBlock } from "./deps";
import { ciFailures, mergeAdvisories, span, type Facts, type Finding, type MaintInput, type Verb } from "./maint";

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

// Every reporter's rows, so the brief names the fix whichever of them knew it.
function advisoryOf(f: Finding, inp: MaintInput) {
  const lists = Object.values(inp.reports).flatMap((r) =>
    r.coverage.state === "ok" && r.facts?.kind === "advisories" ? [r.facts.items] : []);
  return mergeAdvisories(lists).find((a) => a.id === f.ref || (f.ref !== null && a.aliases.includes(f.ref))) ?? null;
}

const ciBrief: Brief = (f, inp, ctx) => {
  const facts = factsOf(f, inp, "ciRuns");
  const x = facts && ciFailures([facts]).find((w) => w.workflow === f.ref);
  if (!facts || !x) return null;
  const runs = facts.runs.filter((r) => r.workflow === x.workflow).slice(0, 8);
  return [
    `CI is failing on ${x.branch} in ${ctx.project}: the ${x.workflow} workflow${x.since !== null ? `, red for ${ago(x.since, ctx)}` : ""}.`,
    ...(x.url ? [x.url] : []),
    "",
    bullet(`first failing commit: ${x.sha}`),
    bullet(`recent runs, newest first: ${runs.map((r) => r.status).join(", ")}`),
    "",
    "Read the failing run's log at the link above and find the cause before changing anything:",
    "say whether the code, the test or the CI environment is wrong, and reproduce it locally if you can.",
    "Fix the cause, never the symptom: do not skip, retry or loosen a test to get it green.",
    "",
    ...verifyBlock(ctx.verify),
  ];
};

const patchBrief: Brief = (f, inp, ctx) => {
  const a = advisoryOf(f, inp);
  if (!a) return null;
  const seen = new Set<string>();
  // Another reporter may know this package's fix; another package's fix is never this one's.
  const fixOf = (x: (typeof a.items)[number]) =>
    x.fixed ?? a.items.find((y) => y.fixed && y.pkg === x.pkg && y.ecosystem === x.ecosystem)?.fixed ?? null;
  const rows = a.items.filter((x) => { const k = `${x.pkg}@${x.version}@${x.location}`; return !seen.has(k) && !!seen.add(k); }).map((x) =>
    bullet(`${x.pkg ?? "?"} ${x.version ?? "?"}${x.ecosystem ? ` (${x.ecosystem})` : ""}${x.location ? ` in ${x.location}` : ""}; `
      + (fixOf(x) ? `fixed in ${fixOf(x)}` : "no fixed version published")));
  return [
    `Patch ${a.id}${a.aliases.length ? ` (${a.aliases.join(", ")})` : ""} · ${a.severity} in ${ctx.project}.`,
    a.summary,
    ...(a.url ? [a.url] : []),
    "",
    ...rows,
    "",
    ...compatBlock(),
    ...verifyBlock(ctx.verify),
  ];
};

const rotateBrief: Brief = (f, inp, ctx) => {
  const a = advisoryOf(f, inp);
  if (!a) return null;
  const where = [...new Set(a.items.map((x) => x.location).filter((l): l is string => !!l))];
  return [
    `A secret was reported in ${ctx.project}: ${a.summary}`,
    ...(a.url ? [a.url] : []),
    "",
    bullet(`report: ${a.id}`),
    ...where.map((l) => bullet(`found in ${l}`)),
    "",
    "Treat it as leaked. Say where it was issued and how to rotate or revoke it there, then remove it",
    "from the code and load it from the environment or a secret store instead. Rewriting git history",
    "is a decision for a person: describe what it would take, do not do it.",
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

// A facet with nothing reading it; the forge is named only as the remote spells it.
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
  return null;
};

const BRIEFS: Record<Verb, Brief> = {
  fix: (f, inp, ctx) => f.facet === "prod" ? prodBrief(f, inp, ctx) : f.facet === "ci" ? ciBrief(f, inp, ctx) : null,
  patch: patchBrief, rotate: rotateBrief, release: releaseBrief, push: pushBrief, tidy: tidyBrief, review: reviewBrief,
  setup: setupBrief, fetch: () => null, run: () => null, // a fetch and a read are not an agent's work
};

/** The brief a finding's verb prefills, or null once the facts behind it are gone. */
export function briefFor(f: Finding, inp: MaintInput, ctx: MaintBriefCtx): string | null {
  return BRIEFS[f.verb](f, inp, ctx)?.join("\n") ?? null;
}
