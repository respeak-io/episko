// The one prober of data-mt*: fleetui's and the dashboard's listeners call `maintClick` first,
// and a card never sits inside an fl*/dash* row, or one click fires both.
// A verb prefills an agent and never sends it: Episko presses Enter in two places only.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { actToast, toast } from "./dom";
import { dlog } from "./debug";
import { sshPrefill } from "./deploy";
import { verifyCommands } from "./deps";
import {
  BOARD_IDS, clampMaint, coverFirst, coverSetups, covText, doorAt, errorPicks, FACET_TAB, facetCell, findingTarget, narrowTrace, offers, prodChecks, prodNone, readsHost, SEV_BUCKETS, sweepReport,
  sweepRows, tabFindings, traceAsk, type Finding,
  fixBranch, parseSessionKey, sessionGate, sessionKey, sessionKind, sessionLeft, sessionPlan, sweepGate, sweepLine,
  type BoardId, type Door, type MaintInput, type MaintTab, type ProjectPick, type SessionLaunch, type SessionLine, type SessionWhere, type SevBucket,
} from "./maint";
import { briefFor, sessionBrief, sweepBrief, sweepPrompt, sweepSessionBrief, type MaintBriefCtx } from "./maintbrief";
import { askingFor, checkSweep, maintInput, runSource, runSweep, scanProject, setMaintHost, showSweep, shownSweep } from "./maintscan";
import { FACETS, findSource, tokenRow, type Facet } from "./maintsources";
import { MAINT_CHIPS, MAINT_SUBS, tabName, type MaintChip, type MaintSub } from "./maintview";
import { checkoutBusy } from "./grouping";
import { openMenu } from "./menu";
import { applyPick, emptyPick, pickNone, rangeOutcome } from "./pick";
import { termEngine } from "./state";
import { discoverTasks, execCmd } from "./tasks";
import type { GitActionResult, WtHead } from "./types";

/** What a pane hosting Maintenance does on its behalf; one object, the DashHost precedent. */
export interface MaintHost {
  scan: (force: boolean) => void; // the fleet's every project, the dashboard's one
  nameOf: (root: string) => string;
  prefill: (project: string, path: string, text: string) => void;
  terminal: (project: string, path: string, cmd: string) => void; // a shell with `cmd` typed in and never sent
  // `door` opens the view a board number counts (./maint Door); on its own dashboard, that view in place.
  openDashboard: (name: string, path: string, tab?: "today" | "maint", door?: Door) => void;
  // `root` undefined keeps the project filter, null clears it; the host owns both, never `mirror`.
  // `board` set scrolls to that board once painted, null to the tab's top.
  openTab: (sub: MaintSub, root?: string | null, board?: BoardId | null) => void;
  picks?: (tab: MaintTab) => PickRow[]; // the fleet's project picker; the dashboard is one project
  render: () => void;
  openView?: (view: "deps" | "branches") => void; // a dashboard card's ⤢; the fleet draws none
  openAcross?: (sub: MaintSub) => void; // a dashboard card's way to the fleet's tab
  deploy?: (root: string, what: "propose" | "file") => void; // the Runs on card's two doors
  setup?: (root: string, what: "propose" | "file") => void; // a Coverage row a [maintenance] key answers
  openCover?: (facet: Facet) => void; // the dashboard's: the facet's tab at its Coverage, which says why
  roots: () => string[]; // the projects this pane shows: what the fleet head's Check prod asks
  lines?: () => { order: string[]; pickable: ReadonlySet<string> }; // the tickable lines on screen; only the fleet draws ticks
  session?: (label: string, rows: SessionLaunch[], notes?: readonly string[]) => Promise<void>; // one tiled agent per row, each prefilled and never sent; settles once the last has landed
  openSettings?: (section: string, row?: string) => void; // a Coverage row's token door: Settings › Accounts at that kind
}

const stored = localStorage.getItem("cc-maint-chip");
export let maintChip: MaintChip = MAINT_CHIPS.includes(stored as MaintChip) ? stored as MaintChip : "all";
function setMaintChip(c: MaintChip) {
  maintChip = MAINT_CHIPS.includes(c) ? c : "all";
  localStorage.setItem("cc-maint-chip", maintChip);
}
// Not persisted: a fold you opened is a glance, and the next visit starts with the loud cards.
export let quietOpen = false;
// The Security strip's bucket, a glance like the fold: a second click on it shows every row again.
export let maintSev: SevBucket | null = null;
// The ticked card lines (`sessionKey`), a glance too: never persisted, and cleared by the session they start.
export let maintPicked = emptyPick();

async function fetchHere(root: string, name: string): Promise<void> {
  try {
    const r = await invoke<GitActionResult>("git_action", { workdir: root, op: "fetch" });
    toast(r.ok ? `${name}: fetched` : `${name}: ${r.summary}`);
  } catch (e) { toast(`${name}: fetch failed: ${e}`); }
  void scanProject(root, true);
}

// The project's own check commands, which every brief ends on.
async function verifyFor(root: string): Promise<string[]> {
  const tasks = await discoverTasks(root).catch((e) => { dlog("warn", `maint: tasks for ${root}: ${e}`); return []; });
  return verifyCommands(tasks.map((x) => ({ cmd: execCmd(x), group: x.group, blocked: x.blocked })));
}

// Fix on an error tracker's line reads the worst issues' stack traces on that click; a failure is said in the brief.
const readsTrace = (f: Finding) => !!traceAsk(f);
const tracing = new Set<string>(); // root|key of a Fix whose traces are out: a second click would open a second pane
async function tracesFor(root: string, f: Finding, inp: MaintInput): Promise<MaintBriefCtx["traces"]> {
  const ids = readsTrace(f) ? errorPicks(inp, clampMaint(inp.det?.config.thresholds)) : [];
  if (!ids.length) return undefined;
  try {
    return narrowTrace(await invoke<unknown>("maint_trace", { root, source: f.source, ids }));
  } catch (e) {
    dlog("warn", `maint: traces for ${root}: ${e}`);
    return Object.fromEntries(ids.map((id) => [id, String(e)]));
  }
}

const lineOf = (root: string, key: string, inp: MaintInput) =>
  [...tabFindings(root, inp, clampMaint(inp.det?.config.thresholds)), ...offers(root, inp), ...coverSetups(root, inp)].find((x) => x.key === key);

// Facts first: a finding whose facts have since changed is gone, and says so rather than guessing.
async function runVerb(root: string, key: string, host: MaintHost): Promise<void> {
  const inp = maintInput(root);
  const f = inp && lineOf(root, key, inp);
  if (!inp || !f) { toast("That has changed since the last check. Check again"); return; }
  const name = host.nameOf(root);
  if (f.verb === "fetch") { await fetchHere(root, name); return; }
  if (f.verb === "run") {
    if (askingFor(root, [f.source])) return; // already out: two audits would share one folder
    const label = findSource(f.source)?.label ?? f.source;
    toast(`${label} for ${name}…`);
    const r = await runSource(root, f.source);
    if (r.coverage.state !== "ok") toast(`${name}: ${label}: ${covText(r.coverage)}`);
    return;
  }
  // Open work lives in Today's queue; the rest of what Review means is the Maintenance tab's.
  if (f.verb === "review") { host.openDashboard(name, root, f.facet === "work" ? "today" : "maint"); return; }
  const out = `${root}|${key}`;
  if (readsTrace(f)) {
    if (tracing.has(out)) { toast("Still reading the stack traces"); return; }
    tracing.add(out);
    toast("Reading the stack traces…");
  }
  try {
    const [verify, traces] = await Promise.all([verifyFor(root), tracesFor(root, f, inp)]);
    const text = briefFor(f, inp, { project: name, verify, traces });
    if (!text) { toast("That has changed since the last check. Check again"); return; }
    host.prefill(name, root, text);
  } finally { tracing.delete(out); }
}

// A board number: a fetch runs here; anything else is a view of the project's dashboard (a page is data-mturl's).
function openDoor(at: string, root: string, host: MaintHost): void {
  const [board, col] = at.split(".");
  const d = BOARD_IDS.includes(board as BoardId) ? doorAt(board as BoardId, col ?? "") : null;
  if (!d || d.to === "url") return;
  if (d.to === "fetch") { void fetchHere(root, host.nameOf(root)); return; }
  host.openDashboard(host.nameOf(root), root, d.to === "queue" || d.to === "landed" ? "today" : undefined, d);
}

// Coverage's Check all: a public source once per project still offering it. Never a tool: an audit
// runs in the project's folder, so those stay one chip, one project, at a time.
async function runAll(source: string, host: MaintHost): Promise<void> {
  const d = findSource(source);
  if (d?.cost !== "public") return;
  const roots = host.roots().filter((r) => { const inp = maintInput(r); return !!inp && !askingFor(r, [source]) && offers(r, inp).some((o) => o.source === source); });
  if (!roots.length) return;
  toast(`${d.label} for ${roots.length} project${roots.length === 1 ? "" : "s"}…`);
  const reps = await Promise.all(roots.map((r) => runSource(r, source)));
  const failed = reps.filter((x) => x.coverage.state !== "ok").length;
  if (failed) toast(`${d.label}: ${failed} of ${reps.length} could not be read. Coverage says why`);
}

// Every address of every project asked, each project's checks as one click-only read per source.
async function checkProd(roots: readonly string[]): Promise<void> {
  const jobs = roots.flatMap((r) => { const inp = maintInput(r); return inp ? prodChecks(inp).map((id) => [r, id] as const) : []; });
  if (!jobs.length) { toast(prodNone()); return; }
  const reps = await Promise.all(jobs.map(([r, id]) => runSource(r, id)));
  const failed = reps.filter((x) => x.coverage.state !== "ok").length;
  if (failed) toast(`Prod: ${failed} of ${reps.length} checks could not run. The Prod cell says why`);
}

// One host's card asks every project naming it, and Rust's join makes that one round trip. prodChecks
// is the consent: a host disallowed since this button was drawn has nothing to ask.
async function checkHost(alias: string, host: MaintHost): Promise<void> {
  const jobs = host.roots().flatMap((r) => {
    const inp = maintInput(r);
    return inp?.det?.deploy?.host === alias ? prodChecks(inp).filter(readsHost).map((id) => [r, id] as const) : [];
  });
  if (!jobs.length) { toast(`${alias} is not allowed on this machine`); return; }
  const reps = await Promise.all(jobs.map(([r, id]) => runSource(r, id)));
  const failed = reps.find((x) => x.coverage.state !== "ok");
  // Rust's own check: [deploy] names another host now, and ./maintscan has just re-read it.
  if (failed?.coverage.state === "notRun") toast(`${alias}: nothing connected, since [deploy] no longer names it. The project's card shows the host it names now`);
  else if (failed) toast(`${alias}: ${covText(failed.coverage)}`);
}

// Allow and Disallow are a per-machine tick and connect nowhere; only Check connects, and SSH only types.
function hostAct(at: HTMLElement, host: MaintHost): void {
  const act = at.dataset.mthost, alias = at.dataset.mtkey ?? "", root = at.dataset.mtroot ?? "";
  if (act === "allow" || act === "deny") { setMaintHost(alias, act === "allow"); host.render(); }
  if (act === "check") void checkHost(alias, host);
  if (act === "ssh" && root) {
    const cmd = sshPrefill(alias);
    if (cmd) host.terminal(host.nameOf(root), root, cmd);
    else toast(`${alias} is not an ssh alias or host name`);
  }
}

// ---------- the advisory sweep: nothing runs until the person submits ----------

function startSweep(at: HTMLElement, host: MaintHost): void {
  const q = at.closest(".mt-sweep")?.querySelector<HTMLInputElement>(".mt-sweepq")?.value.trim() ?? "";
  if (!q) { toast("Paste an advisory id, or a package and its range"); return; }
  void runSweep(q, host.roots());
}

// ---------- a session: one click, one tiled agent per line ----------

type BriefOf = (l: SessionLine, ctx: MaintBriefCtx, where: SessionWhere) => string | null;
interface LineRun { gate?: typeof sessionGate; notes?: readonly string[]; begin?: () => void }
// Held until the last pane has landed: a pane joins `sessions` only once its worktree exists, so a
// second click any sooner would plan over the same checkouts.
let starting = false;

const branchExists = (root: string, branch: string) =>
  invoke<unknown>("git_commit_info", { dir: root, rev: `refs/heads/${branch}` }).then((c) => !!c, () => false);
// Asked as a line is ticked, so the bar can say "earlier" before the click. Start asks again.
const earlierSeen = new Set<string>();
export const maintEarlier = (root: string, branch: string) => earlierSeen.has(sessionKey({ root, key: branch }));
async function noteEarlier(tick: string, host: MaintHost): Promise<void> {
  const { root, key } = parseSessionKey(tick), branch = fixBranch({ key }), at = sessionKey({ root, key: branch });
  const has = await branchExists(root, branch);
  if (has === earlierSeen.has(at)) return;
  if (has) earlierSeen.add(at); else earlierSeen.delete(at);
  host.render();
}

// Re-planned from fresh heads and branches: the bar's plan is a paint old and can under-state a busy checkout.
async function launchLines(label: string, lines: readonly SessionLine[], briefOf: BriefOf, host: MaintHost, run: LineRun = {}): Promise<void> {
  if (!host.session || !lines.length) return;
  if (starting) { toast("Still starting the last ones"); return; }
  starting = true;
  try {
    const roots = [...new Set(lines.map((l) => l.f.root))];
    const heads = new Map(await Promise.all(roots.map(async (r) =>
      [r, await invoke<WtHead[]>("worktree_heads", { dir: r }).catch(() => null)] as const)));
    const headsOf = (r: string) => heads.get(r) ?? [];
    const earlier = new Set<string>();
    await Promise.all(lines.filter((l) => sessionKind(l.f) === "branch").map(async ({ f }) => {
      const b = fixBranch(f);
      if (await branchExists(f.root, b)) earlier.add(sessionKey({ root: f.root, key: b }));
    }));
    const plan = sessionPlan(lines, {
      heads: headsOf, plain: (r) => heads.get(r)?.length === 0, earlier: (r, b) => earlier.has(sessionKey({ root: r, key: b })),
      busy: (path, r) => checkoutBusy(path, headsOf(r)), name: host.nameOf, now: Date.now(),
    });
    const why = (run.gate ?? sessionGate)(plan, termEngine === "embedded");
    if (why) { actToast(why); return; }
    const verify = new Map(await Promise.all(roots.map(async (r) => [r, await verifyFor(r)] as const)));
    const lineAt = (row: { root: string; key: string }) => lines.find((x) => x.f.root === row.root && x.f.key === row.key);
    // A ticked errors line takes the verb's own trace path, so its pane's brief is the one Fix would prefill.
    if (plan.rows.some((row) => { const l = lineAt(row); return !!l && readsTrace(l.f); })) toast("Reading the stack traces…");
    // One project at a time, so a tracker most of them share never has more than TRACE_CAP of these out at once.
    const traces: MaintBriefCtx["traces"][] = [];
    for (const row of plan.rows) { const l = lineAt(row); traces.push(l ? await tracesFor(row.root, l.f, l.inp) : undefined); }
    const rows = plan.rows.flatMap((row, n) => {
      const l = lineAt(row), project = host.nameOf(row.root);
      const text = l && briefOf(l, { project, verify: verify.get(row.root) ?? [], traces: traces[n] }, row.where);
      return text ? [{ root: row.root, project, where: row.where, branch: row.branch, text, what: row.text }] : [];
    });
    if (!rows.length) { toast("That has changed since the last check. Check again"); return; }
    run.begin?.();
    await host.session(label, rows, [...(run.notes ?? []), ...sessionLeft(plan)]);
  } finally { starting = false; }
}

async function startSession(host: MaintHost): Promise<void> {
  const ticks = [...maintPicked.picked].map(parseSessionKey);
  const lines = ticks.flatMap(({ root, key }) => {
    const inp = maintInput(root), f = inp && lineOf(root, key, inp);
    return f && inp ? [{ f, inp }] : [];
  });
  const gone = ticks.length - lines.length;
  const notes = gone ? [`${gone} line${gone === 1 ? "" : "s"} changed since the last check`] : [];
  const clear = () => { maintPicked = pickNone(); host.render(); };
  if (!lines.length) { if (gone) toast(notes[0]); clear(); return; }
  await launchLines("Maintenance", lines, ({ f, inp }, ctx, where) => sessionBrief(f, inp, ctx, where), host, { notes, begin: clear });
}

// A range over ten lines may tick two, and unsaid that reads as the range not having worked.
function tickLine(key: string, host: MaintHost, shift: boolean): void {
  const o = host.lines?.();
  if (!o) return;
  if (shift) window.getSelection()?.removeAllRanges(); // one anchored outside the cards still paints over them
  const before = maintPicked, ctx = { ...o, range: shift };
  maintPicked = applyPick(before, key, ctx);
  for (const k of maintPicked.picked) if (!before.picked.has(k)) void noteEarlier(k, host);
  host.render();
  if (!shift || !before.anchor || before.anchor === key) return;
  const { took, refused } = rangeOutcome(ctx, before.anchor, key);
  if (refused) toast(`${took} ticked · ${refused} not offered: no agent answers those lines`);
}

// Each affected project's brief, prefilled and never sent; the facts are the run's, as drawn.
// With agents opening outside Episko there are no panes to tile: one each, in the project's own folder.
async function briefSweep(roots: readonly string[], host: MaintHost): Promise<void> {
  const s = shownSweep(), adv = s?.adv;
  if (!s || !adv) return;
  if (host.session && termEngine === "embedded") {
    const lines = roots.map((root) => ({ f: sweepLine(adv, root), inp: maintInput(root) ?? { det: null, reports: {} } }));
    const briefOf: BriefOf = ({ f, inp }, ctx, where) => {
      const facts = s.facts.find((x) => x.root === f.root);
      return facts ? sweepSessionBrief(adv, facts, f, inp, ctx, where) : null;
    };
    await launchLines("Advisory sweep", lines, briefOf, host, { gate: sweepGate });
    return;
  }
  for (const root of roots) {
    const f = s.facts.find((x) => x.root === root), name = host.nameOf(root);
    const text = f && sweepBrief(adv, f, { project: name, verify: await verifyFor(root) });
    if (text) host.prefill(name, root, text);
  }
}

function sweepAct(at: HTMLElement, host: MaintHost): void {
  const act = at.dataset.mtsweep, s = shownSweep(), root = at.dataset.mtroot ?? "";
  if (act === "run") { startSweep(at, host); return; }
  if (act === "open") { showSweep(Number(at.dataset.mtkey)); return; }
  if (!s?.adv) return;
  // A root on Brief or Copy is the tab's project filter: they act on exactly the rows drawn.
  const rows = sweepRows(s.adv, s.facts, s.roots), mine = root ? rows.filter((r) => r.root === root) : rows;
  if (act === "patch") void briefSweep([root], host);
  if (act === "brief") void briefSweep(mine.filter((r) => r.verdict === "affected").map((r) => r.root), host);
  const row = rows.find((r) => r.root === root);
  if (act === "check" && row) void checkSweep(s.n, root, sweepPrompt(s.adv, row, host.nameOf(root)));
  if (act === "copy") {
    const names = Object.fromEntries(mine.map((r) => [r.root, host.nameOf(r.root)]));
    const text = sweepReport(s.adv, mine, names, s.agents);
    void writeText(text).then(() => toast("Copied the sweep's report")).catch(() => toast("Could not copy the report"));
  }
}

const subOf = (v: string | undefined): MaintSub => MAINT_SUBS.includes(v as MaintSub) ? v as MaintSub : "overview";

export type PickRow = ProjectPick & { accent: string; icon: string | null };
const ALL = "*"; // the menu's "All projects": a root is an absolute path, never this
function pickProject(at: HTMLElement, sub: MaintSub, host: MaintHost): void {
  if (sub === "overview" || !host.picks) return;
  const cur = at.dataset.mtroot || null, picks = host.picks(sub);
  const needs = (n: number) => n ? `${n} need${n === 1 ? "s" : ""} you` : undefined;
  const tone = (p: ProjectPick) => p.level === "bad" || p.level === "warn" ? p.level : undefined;
  openMenu(at, {
    title: tabName(sub), sub: "show one project's rows",
    groups: [
      { items: [{ id: ALL, label: "All projects", mark: cur ? "" : "✓" }] },
      { label: "Projects", items: picks.map((p) => ({ id: p.root, label: p.name, mark: p.root === cur ? "✓" : "", sub: needs(p.n), tone: tone(p),
        avatar: { icon: p.icon, accent: p.accent, name: p.name } })) },
    ],
    onPick: (id) => host.openTab(sub, id === ALL ? null : id),
  });
}

/** True when the click was Maintenance's. Nested controls are probed before the row holding them. */
export function maintClick(t: HTMLElement, host: MaintHost, shift = false): boolean {
  const tick = t.closest<HTMLElement>("[data-mttick]");
  if (tick) { tickLine(sessionKey({ root: tick.dataset.mtroot!, key: tick.dataset.mttick! }), host, shift); return true; }
  const none = t.closest<HTMLElement>("[data-mtpicknone]");
  if (none) { maintPicked = pickNone(); host.render(); return true; }
  const start = t.closest<HTMLElement>("[data-mtsession]");
  if (start) { void startSession(host); return true; }
  const scan = t.closest<HTMLElement>("[data-mtscan]");
  if (scan) { host.scan(scan.dataset.mtscan === "force"); return true; }
  const sweep = t.closest<HTMLElement>("[data-mtsweep]");
  if (sweep) { sweepAct(sweep, host); return true; }
  const prod = t.closest<HTMLElement>("[data-mtprod]");
  if (prod) { void checkProd(prod.dataset.mtprod ? [prod.dataset.mtprod] : host.roots()); return true; }
  const chip = t.closest<HTMLElement>("[data-mtchip]");
  if (chip) {
    if (chip.getAttribute("aria-disabled") !== "true") { setMaintChip(chip.dataset.mtchip as MaintChip); host.render(); }
    return true;
  }
  const fold = t.closest<HTMLElement>("[data-mtfold]");
  if (fold) { quietOpen = fold.dataset.mtfold === "1"; host.render(); return true; }
  const sev = t.closest<HTMLElement>("[data-mtsev]");
  if (sev) {
    const b = sev.dataset.mtsev as SevBucket;
    if (maintSev === b || !SEV_BUCKETS.includes(b)) maintSev = null;
    else if (sev.getAttribute("aria-disabled") !== "true") maintSev = b;
    host.render();
    return true;
  }
  const tab = t.closest<HTMLElement>("[data-mttab]");
  if (tab) { host.openTab(subOf(tab.dataset.mttab)); return true; }
  const pick = t.closest<HTMLElement>("[data-mtpick]");
  if (pick) { pickProject(pick, subOf(pick.dataset.mtpick), host); return true; }
  const view = t.closest<HTMLElement>("[data-mtview]");
  if (view) { host.openView?.(view.dataset.mtview === "branches" ? "branches" : "deps"); return true; }
  const across = t.closest<HTMLElement>("[data-mtacross]");
  if (across) { host.openAcross?.(subOf(across.dataset.mtacross)); return true; }
  const dep = t.closest<HTMLElement>("[data-mtdeploy]");
  if (dep) { host.deploy?.(dep.dataset.mtroot!, dep.dataset.mtdeploy === "file" ? "file" : "propose"); return true; }
  const cfg = t.closest<HTMLElement>("[data-mtcfg]");
  if (cfg) { host.setup?.(cfg.dataset.mtroot!, cfg.dataset.mtcfg === "file" ? "file" : "propose"); return true; }
  const all = t.closest<HTMLElement>("[data-mtrunall]");
  if (all) { void runAll(all.dataset.mtrunall ?? "", host); return true; }
  // Asking a public source in every scan is Settings › On its own's switch; this only opens it there.
  const pref = t.closest<HTMLElement>("[data-mtpref]");
  if (pref) { if (findSource(pref.dataset.mtpref ?? "")?.cost === "public") host.openSettings?.("auto", `maintpub:${pref.dataset.mtpref}`); return true; }
  // A token is pasted in Settings, never here: the door names the kind, and nothing it opens connects.
  const tok = t.closest<HTMLElement>("[data-mttoken]");
  if (tok) { const k = findSource(tok.dataset.mttoken ?? "")?.token; host.openSettings?.("accounts", k ? tokenRow(k.id) : undefined); return true; }
  const url = t.closest<HTMLElement>("[data-mturl]");
  if (url) { void openUrl(url.dataset.mturl!).catch((e) => toast(`open failed: ${e}`)); return true; }
  const copy = t.closest<HTMLElement>("[data-mtcopy]");
  if (copy) {
    // Tauri's clipboard, never navigator.clipboard, which raises an OS permission prompt.
    const text = copy.dataset.mtcopy!;
    void writeText(text).then(() => toast("Copied")).catch(() => toast(text));
    return true;
  }
  const hostDoor = t.closest<HTMLElement>("[data-mthost]");
  if (hostDoor) { hostAct(hostDoor, host); return true; }
  const door = t.closest<HTMLElement>("[data-mtdoor]");
  if (door) { openDoor(door.dataset.mtdoor ?? "", door.dataset.mtroot!, host); return true; }
  const verb = t.closest<HTMLElement>("[data-mtverb]");
  if (verb) { void runVerb(verb.dataset.mtroot!, verb.dataset.mtverb!, host); return true; }
  // A card line, after its verb so Patch only prefills: the tab and board that line summarises.
  const find = t.closest<HTMLElement>("[data-mtfind]");
  if (find) {
    const facet = find.dataset.mtfind as Facet;
    if (!FACETS.includes(facet)) return true;
    const to = findingTarget({ facet, key: find.dataset.mtkey ?? "" });
    maintSev = null; // a severity picked earlier could hide the very rows this line counts
    host.openTab(to.tab, find.dataset.mtroot!, to.board);
    return true;
  }
  const cell = t.closest<HTMLElement>("[data-mtcell]");
  if (cell) {
    const facet = cell.dataset.mtcell as Facet, root = cell.dataset.mtroot!, inp = maintInput(root);
    if (!FACETS.includes(facet)) return true;
    if (host.openCover && inp && coverFirst(facetCell(facet, inp, clampMaint(inp.det?.config.thresholds)))) host.openCover(facet);
    else host.openTab(FACET_TAB[facet], root);
    return true;
  }
  const proj = t.closest<HTMLElement>("[data-mtproj]");
  if (proj) { host.openDashboard(proj.dataset.mtname!, proj.dataset.mtproj!, "maint"); return true; }
  return false;
}

/** Enter or Space on a card line's text opens it as a click would; its verb is a button of its own.
 *  On a tick they toggle it. Enter in the sweep's box submits it, and nothing else typed there is Maintenance's. */
export function maintKey(e: KeyboardEvent, host: MaintHost): boolean {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.matches(".mt-sweepq")) {
    if (e.key !== "Enter" || e.isComposing) return false;
    e.preventDefault();
    startSweep(t, host);
    return true;
  }
  if ((e.key !== "Enter" && e.key !== " ") || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  if (t instanceof HTMLElement && t.matches("[data-mttick]")) {
    e.preventDefault();
    maintClick(t, host);
    return true;
  }
  if (!(t instanceof HTMLElement) || !t.matches("[data-mtfind] > .t")) return false;
  e.preventDefault();
  return maintClick(t, host);
}
