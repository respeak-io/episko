// The send sheet (#handoffDlg) and what a handoff's outcome does on this machine: archive a
// session the recipient now owns, or put one back on the shelf (docs/handoff.md). ./handoff
// decides, ./handoffview draws; this file owns the dialog, its listener and its guard.
import { invoke } from "@tauri-apps/api/core";
import { $, dropScrim, toast } from "./dom";
import { ask } from "./confirm";
import { dlog } from "./debug";
import {
  clampBrief, gitChoices, handoffBusy, lostOnHandoff, peerName, rowText, sendGate, targets,
  type Brief, type HandoffGit, type HandoffRec, type Peer, type Target,
} from "./handoff";
import { briefingHtml, reviewSheetHtml, sendSheetHtml } from "./handoffview";
import { dormants, handoffs, sessions } from "./state";
import { devices, handoffDevices, onlineDevices, serverHandoff, status as syncStatus } from "./synclink";
import { dormantBusy } from "./grouping";
import { canShelve, isClaude, isClaudeRow, midWork, phaseText } from "./types";

// What the sheet does that this module does not own; one host object (CLAUDE.md seam rule).
let host: {
  stopForTranscript: (id: string) => Promise<void>;
  shelve: (id: string) => boolean;
  forgetDormant: (id: string) => void;
  saveHandoffs: (list: HandoffRec[]) => void;
  renderAll: () => void;
} = { stopForTranscript: async () => {}, shelve: () => false, forgetDormant: () => {}, saveHandoffs: () => {}, renderAll: () => {} };
export function setHandoffHost(h: typeof host) { host = h; }

interface Packed { size: number; parts: number; sha256: string; left_behind: string[] }
type Step = "pick" | "brief" | "review" | "sending";
interface Sheet {
  src: string; live: boolean; title: string; project: string; workdir: string; colorKey: string; resumeId: string;
  step: Step; targets: Target[]; pick: number | null; warnings: string[];
  git: HandoffGit | null; gitErr: string; gitPick: string | null;
  hid: string | null; brief: Brief; briefNote: string; err: string; gen: number;
}
let sheet: Sheet | null = null;
let gen = 0;
let painted = "";
const settling = new Set<string>();

const me = () => ({ user: syncStatus.user, device: syncStatus.device });
const currentTargets = () => targets(devices, handoffDevices, me(), onlineDevices());
const recOf = (id: string) => handoffs.find((r) => r.id === id);
const save = (list: HandoffRec[]) => { host.saveHandoffs(list); host.renderAll(); };
const errText = (e: unknown) => String(e).replace(/^Error: /, "");

/** Why a session's "Send to…" is greyed, or null. `id` is a live pane's or a shelved row's. */
export function sendGateFor(id: string): string | null {
  const s = sessions.get(id);
  const d = s ? undefined : dormants.find((x) => x.id === id);
  if (!s && !d) return "That session is gone";
  const busy = handoffBusy(handoffs, s ? s.resumeId || s.id : d!.resumeId);
  if (busy) return `Already ${busy}`;
  const t = s
    ? { claude: isClaude(s), external: s.external, workdir: (s.home ?? s).workdir, canResume: canShelve(s) }
    : { claude: isClaudeRow(d!), workdir: d!.workdir, canResume: !dormantBusy(d!) };
  return sendGate(t, serverHandoff, syncStatus.connected, currentTargets().filter((x) => x.ready).length);
}

export const handoffOpen = () => sheet !== null;

export function openSend(id: string) {
  const why = sendGateFor(id);
  if (why) { toast(why); return; }
  const s = sessions.get(id);
  const d = s ? undefined : dormants.find((x) => x.id === id)!;
  const at = s ? s.home ?? s : d!;
  const warnings: string[] = [];
  if (s && midWork(s)) warnings.push(`It is still going (${phaseText(s)}); the turn it is in will not finish.`);
  if (s) {
    const lost = lostOnHandoff(s);
    if (lost.jobs) warnings.push(`${lost.jobs} background job${lost.jobs === 1 ? "" : "s"} stop with it and do not come back.`);
    for (const url of lost.servers) warnings.push(`The server at ${url} stops with it.`);
  }
  const list = currentTargets();
  const ready = list.filter((t) => t.ready);
  sheet = {
    src: id, live: !!s, title: (s ? s.title : d!.title) || (s ? s.project : d!.project), project: s ? s.project : d!.project,
    workdir: at.workdir, colorKey: s ? s.colorKey : d!.colorKey, resumeId: s ? s.resumeId || s.id : d!.resumeId,
    step: "pick", targets: list, pick: ready.length === 1 ? list.indexOf(ready[0]) : null, warnings,
    git: null, gitErr: "", gitPick: null, hid: null, brief: clampBrief({}), briefNote: "", err: "", gen: ++gen,
  };
  const mine = sheet.gen;
  invoke<HandoffGit>("handoff_git_state", { workdir: sheet.workdir }).then((g) => {
    if (sheet?.gen !== mine) return;
    sheet.git = g;
    sheet.gitPick = gitChoices(g, serverHandoff?.max_bytes ?? 0).preset;
    paint();
  }).catch((e) => { if (sheet?.gen === mine) { sheet.gitErr = errText(e); paint(); } });
  painted = "";
  $("scrim").classList.add("show");
  $("handoffDlg").classList.add("show");
  paint();
}

function peerOf(t: Target): Peer {
  return t.mine && t.device ? { user: t.user, device: t.device, label: t.label } : { user: t.user, label: t.label };
}

function paint() {
  if (!sheet) return;
  const who = sheet.pick === null ? "" : sheet.targets[sheet.pick]?.label ?? "";
  $("handTitle").textContent = sheet.step === "pick" ? "Send to…" : `Send to ${who}`;
  let html: string;
  if (sheet.step === "pick") html = sendSheetHtml({ title: sheet.title, project: sheet.project, targets: sheet.targets, pick: sheet.pick, warnings: sheet.warnings, live: sheet.live });
  else if (sheet.step === "brief") html = briefingHtml(who);
  else {
    const ch = sheet.git ? gitChoices(sheet.git, serverHandoff?.max_bytes ?? 0) : null;
    const options = sheet.gitErr ? [{ id: "none" as const, label: "Send only the conversation" }] : ch?.options ?? null;
    html = reviewSheetHtml({
      who, brief: sheet.brief, briefNote: sheet.briefNote, options, pick: sheet.gitErr ? "none" : sheet.gitPick,
      gitNote: sheet.gitErr ? `Couldn't read the checkout: ${sheet.gitErr}` : ch?.note ?? "",
      ttlHours: Math.round((serverHandoff?.ttl_ms ?? 72 * 3_600_000) / 3_600_000), maxBytes: serverHandoff?.max_bytes ?? 0,
      err: sheet.err, busy: sheet.step === "sending",
    });
  }
  if (html !== painted) { painted = html; $("handBody").innerHTML = html; }
}

export function closeHandoff() {
  if (!sheet) return;
  // Once the session is stopped, closing is Cancel: the record goes and the row stays shelved.
  if (sheet.hid && (sheet.step === "brief" || sheet.step === "review")) void cancelPacking(sheet.hid, true);
  sheet = null;
  $("handoffDlg").classList.remove("show");
  dropScrim();
}

async function proceed() {
  const sh = sheet;
  if (!sh || sh.pick === null || sh.step !== "pick") return;
  const t = sh.targets[sh.pick];
  if (sh.live) {
    const s = sessions.get(sh.src);
    if (!s) { toast("That session is gone"); closeHandoff(); return; }
    sh.step = "brief";
    paint();
    await host.stopForTranscript(sh.src);
    if (!host.shelve(sh.src) || sheet !== sh) { if (sheet === sh) closeHandoff(); return; }
  }
  const hid = crypto.randomUUID();
  sh.hid = hid;
  sh.step = "brief";
  save([...handoffs, { id: hid, dir: "out", resumeId: sh.resumeId, peer: peerOf(t), state: "packing", title: sh.title, colorKey: sh.colorKey, checkout: sh.workdir, at: Date.now() }]);
  dlog("info", `handoff ${hid.slice(0, 8)}: ${sh.resumeId.slice(0, 8)} → ${t.label}`);
  paint();
  try {
    const b = await invoke<Brief>("handoff_brief", { workdir: sh.workdir, resumeId: sh.resumeId, model: null });
    if (sheet !== sh || sh.step !== "brief") return;
    sh.brief = clampBrief(b);
  } catch (e) {
    if (sheet !== sh || sh.step !== "brief") return;
    sh.briefNote = `Couldn't write one (${errText(e)}); write your own or leave it empty.`;
  }
  sh.step = "review";
  paint();
}

async function send() {
  const sh = sheet;
  if (!sh || !sh.hid || sh.step !== "review" || sh.pick === null) return;
  const how = sh.gitErr ? "none" : sh.gitPick;
  if (!how) return;
  const t = sh.targets[sh.pick];
  const hid = sh.hid;
  sh.step = "sending";
  sh.err = "";
  paint();
  const brief = clampBrief(sh.brief);
  const empty = !brief.summary && !brief.state && !brief.next_steps.length && !brief.open_questions.length;
  try {
    const packed = await invoke<Packed>("handoff_pack", {
      id: hid, workdir: sh.workdir, resumeId: sh.resumeId, git: how, memories: [],
      meta: { title: sh.title, project: sh.project, ...(empty ? {} : { brief }) },
    });
    // Cancelled from its row while packing: what was just staged must not be offered later.
    if (!recOf(hid)) { void settleOut(hid, sh.workdir, sh.resumeId, false); return; }
    const sent = await invoke<boolean>("handoff_send", { id: hid, toUser: t.user, toDevice: t.mine ? t.device ?? null : null });
    if (sheet === sh) { sheet = null; $("handoffDlg").classList.remove("show"); dropScrim(); }
    const left = packed.left_behind.length ? ` · left behind: ${packed.left_behind.slice(0, 3).join(", ")}${packed.left_behind.length > 3 ? "…" : ""}` : "";
    toast((sent ? `Sending to ${t.label}` : `Packed · it goes to ${t.label} when sync reconnects`) + left);
  } catch (e) {
    if (sheet !== sh) { toast(`Not sent: ${errText(e)}`); return; }
    sh.step = "review";
    sh.err = errText(e);
    paint();
  }
}

function settleOut(id: string, workdir: string | undefined, resumeId: string | null, archive: boolean): Promise<void> {
  return invoke<void>("handoff_settle", { id, dir: "out", workdir: workdir ?? null, resumeId, archive });
}

/** Cancel before the offer: the record goes, the staging with it, and the row stays shelved. */
async function cancelPacking(id: string, quiet = false) {
  const r = recOf(id);
  if (!r) return;
  save(handoffs.filter((x) => x.id !== id));
  await invoke("handoff_recall", { id }).catch(() => {});
  await settleOut(id, r.checkout, null, false).catch((e) => dlog("warn", `handoff ${id.slice(0, 8)}: ${errText(e)}`));
  if (!quiet) toast("Cancelled · the session stays on your shelf");
}

/** Take back: a row's ↶. Before the offer it is a cancel; after it, the server decides. */
export function takeBack(id: string) {
  const r = recOf(id);
  if (!r || r.dir !== "out") return;
  if (r.state === "packing") { void cancelPacking(id); return; }
  if (!rowText(r, Date.now()).actions.includes("takeback")) { toast(`Too late: ${peerName(r.peer)} is picking it up`); return; }
  invoke("handoff_recall", { id }).then(() => toast("Taking it back…")).catch((e) => toast(`Can't take it back yet: ${errText(e)}`));
}

/** The send of this conversation that Take back can still stop, if any. */
export function recallable(resumeId: string): HandoffRec | undefined {
  const rid = resumeId.toLowerCase();
  return handoffs.find((r) => r.dir === "out" && r.resumeId.toLowerCase() === rid
    && rowText(r, Date.now()).actions.some((a) => a === "takeback" || a === "cancel"));
}

/** A handed row's ✕: the record goes; the conversation was archived when it was handed. */
export function dismissHanded(id: string) {
  save(handoffs.filter((x) => x.id !== id));
}

/** Before a returned session resumes: the server never said, so the person is asked. */
export async function confirmReturned(resumeId: string): Promise<boolean> {
  const rid = resumeId.toLowerCase();
  const r = handoffs.find((x) => x.dir === "out" && x.state === "returned" && x.resumeId.toLowerCase() === rid);
  if (!r) return true;
  const who = peerName(r.peer);
  const ok = await ask(
    `The sync server stopped answering before it said whether ${who} picked this session up.\n\nCheck with ${who} before resuming, or two machines carry on one conversation.`,
    { title: "Resume a session you handed over?", kind: "warning", okLabel: "Resume here", cancelLabel: "Not yet" },
  );
  if (!ok) return false;
  save(handoffs.filter((x) => x.id !== r.id));
  void settleOut(r.id, r.checkout, null, false).catch(() => {});
  return true;
}

const BACK_TEXT: Record<string, (who: string, r: HandoffRec) => string> = {
  declined: (who) => `${who} declined it · it's back on your shelf`,
  recalled: () => "Taken back · it's on your shelf again",
  expired: (who) => `${who} didn't pick it up in time · it's back on your shelf`,
  refused: (_who, r) => `Not sent: ${r.reason ?? "the server refused it"}`,
};

/** Acts on every sent record whose outcome is in: after each event, and once at boot. */
export function settleDue() {
  for (const r of handoffs) {
    if (r.dir !== "out" || settling.has(r.id)) continue;
    if (r.state === "done" && !r.settled) void settleDone(r);
    else if (r.state === "done") dropShelved(r); // a roster read after the settle brought it back
    else if (BACK_TEXT[r.state]) void settleBack(r);
  }
}

function dropShelved(r: HandoffRec) {
  const rid = r.resumeId.toLowerCase();
  if (handoffs.some((x) => x.dir === "in" && x.resumeId.toLowerCase() === rid && x.at > r.at)) return;
  for (const d of dormants.filter((x) => x.resumeId.toLowerCase() === rid)) host.forgetDormant(d.id);
}

async function settleDone(r: HandoffRec) {
  settling.add(r.id);
  const rid = r.resumeId.toLowerCase();
  const workdir = r.checkout ?? dormants.find((d) => d.resumeId.toLowerCase() === rid)?.workdir;
  try {
    await settleOut(r.id, workdir, r.resumeId, true);
    dropShelved(r);
    save(handoffs.map((x) => (x.id === r.id ? { ...x, settled: true, at: Date.now() } : x)));
    toast(`Handed to ${peerName(r.peer)}`);
  } catch (e) {
    dlog("warn", `handoff ${r.id.slice(0, 8)}: archive failed: ${errText(e)}`);
  } finally {
    settling.delete(r.id);
  }
}

async function settleBack(r: HandoffRec) {
  settling.add(r.id);
  try {
    await settleOut(r.id, r.checkout, null, false).catch((e) => dlog("warn", `handoff ${r.id.slice(0, 8)}: ${errText(e)}`));
    save(handoffs.filter((x) => x.id !== r.id));
    toast(BACK_TEXT[r.state](peerName(r.peer), r));
  } finally {
    settling.delete(r.id);
  }
}

$("handBody").addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-hand]");
  if (!el || !sheet || (el as HTMLButtonElement).disabled) return;
  const [verb, arg] = el.dataset.hand!.split("|");
  if (verb === "pick") { sheet.pick = Number(arg); paint(); }
  else if (verb === "git") { sheet.gitPick = arg; paint(); }
  else if (verb === "go") void proceed();
  else if (verb === "skip" && sheet.step === "brief") { sheet.step = "review"; paint(); }
  else if (verb === "send") void send();
  else if (verb === "close" || verb === "cancel") closeHandoff();
});
// No repaint per keystroke: that would replace the textarea being typed into.
$("handBody").addEventListener("input", (e) => {
  const el = e.target as HTMLTextAreaElement;
  const k = el.dataset?.hbrief as keyof Brief | undefined;
  if (!sheet || !k) return;
  const v = el.value;
  sheet.brief = { ...sheet.brief, [k]: k === "summary" || k === "state" ? v : v.split("\n") };
});
