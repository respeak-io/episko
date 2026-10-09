// The project settings panel: one project's answers to what is otherwise global, and the
// choices that belong to its whole team. Owns `#projDlg`, assembles the rows from state and
// routes its own `data-ps` clicks; ./projsetview draws, ./projprefs resolves (docs/settings.md).
import { $, dropScrim, IS_MAC } from "./dom";
import { basename, tilde } from "./format";
import {
  accentFor, agentByProject, allAgents, autoFetchPrefs, defaultAgentDef, effectiveAgent, ghAccountFor,
  ghLogins, keyPrefs, permissionModeFor, projPrefs, shareModeOf, type ShareMode,
} from "./state";
import { AUTOFETCH_EVERY } from "./autofetch";
import { providerAdapter, providerPermissionMode } from "./providers";
import { ghWho } from "./ghwork";
import { activeBind, comboKeys } from "./keys";
import { clearStopRule, stopRules } from "./tasks";
import { projectIdOf, serverDigest, serverNotes, status as syncStatus, teamShare } from "./synclink";
import { btnCtl, nilCtl, projSettingsHtml, segCtl, type PsRow, type PsSeg } from "./projsetview";

export interface ProjSetHost {
  setAgent: (key: string, id: string | null) => void;
  setPerm: (key: string, provider: string, mode: string | null) => void;
  setFetch: (key: string, patch: { fetch?: boolean | null; fetchEvery?: number | null }) => void;
  setGh: (key: string, login: string | null) => void;
  setShare: (key: string, m: ShareMode) => void;
  moveLog: (key: string) => Promise<void>;
  hasDigest: (key: string) => Promise<boolean>;
  refreshGh: () => Promise<unknown>;
}
let host: ProjSetHost = {
  setAgent: () => {}, setPerm: () => {}, setFetch: () => {}, setGh: () => {}, setShare: () => {},
  moveLog: () => Promise.resolve(), hasDigest: () => Promise.resolve(false), refreshGh: () => Promise.resolve(),
};
export function setProjSetHost(h: ProjSetHost) { host = h; }

let key: string | null = null;
let digestFile = false;
let last = "";

export const projSettingsOpen = () => $("projDlg").classList.contains("show");

export function openProjectSettings(k: string) {
  key = k;
  digestFile = false;
  last = "";
  $("scrim").classList.add("show");
  $("projDlg").classList.add("show");
  renderProjSettings();
  // Both answers arrive after the first paint; neither is worth holding the dialog for.
  void host.refreshGh().then(renderProjSettings);
  void host.hasDigest(k).then((y) => { if (key === k) { digestFile = y; renderProjSettings(); } }).catch(() => {});
}
export function closeProjectSettings() {
  if (!projSettingsOpen()) return;
  $("projDlg").classList.remove("show");
  key = null;
  dropScrim();
}

const every = (ms: number) => `${ms / 60_000} min`;
const fetchText = (on: boolean, ms: number) => on ? `on, at most every ${every(ms)}` : "off";

function agentRow(k: string): PsRow {
  const pin = agentByProject[k];
  const eff = effectiveAgent(k), dflt = defaultAgentDef();
  const opts: PsSeg[] = [{ value: "", label: "Settings", sub: `Follow Settings › Launching (${dflt.label})` },
    ...allAgents().map((a) => ({ value: a.id, label: a.label }))];
  return {
    id: "agent", label: "Agent", hint: "What a new session here runs.",
    cur: pin ? `${eff.label} here; Settings says ${dflt.label}` : `${eff.label}, from Settings`,
    overridden: !!pin, ctl: segCtl("agent", "Agent", opts, pin ?? ""),
  };
}

function permRow(k: string): PsRow {
  const agent = effectiveAgent(k);
  const modes = providerAdapter(agent.id)?.permissionModes ?? [];
  if (!agent.capabilities.includes("launch-permissions") || !modes.length) {
    return { id: "perm", label: `Permission mode · ${agent.label}`, hint: "How much a new session may do before it asks.",
      ctl: nilCtl("—"), note: `${agent.label} keeps its permissions in its own terminal or config.` };
  }
  const own = projPrefs[k]?.perm?.[agent.id];
  const global = providerPermissionMode(agent.id, permissionModeFor(agent.id));
  const opts: PsSeg[] = [{ value: "", label: "Settings", sub: `Follow Settings › Launching (${global?.label ?? "default"})` },
    ...modes.map((m) => ({ value: m.id, label: m.label, sub: m.sub }))];
  const here = own ? providerPermissionMode(agent.id, own) : null;
  return {
    id: "perm", label: `Permission mode · ${agent.label}`, hint: "How much a new session here may do before it asks.",
    cur: here ? `${here.label} here; Settings says ${global?.label ?? "default"}` : `${global?.label ?? "default"}, from Settings`,
    overridden: !!here, ctl: segCtl("perm", "Permission mode", opts, here?.id ?? ""),
  };
}

function fetchRows(k: string): PsRow[] {
  const p = projPrefs[k];
  const g = autoFetchPrefs;
  const on = p?.fetch ?? g.enabled;
  const sw: PsSeg[] = [{ value: "", label: "Settings", sub: `Follow Settings › On its own (${fetchText(g.enabled, g.everyMs)})` },
    { value: "on", label: "On" }, { value: "off", label: "Off" }];
  const cad: PsSeg[] = [{ value: "", label: "Settings", sub: `Follow Settings (${every(g.everyMs)})` },
    ...AUTOFETCH_EVERY.map((ms) => ({ value: String(ms), label: every(ms) }))];
  return [{
    id: "fetch", label: "Fetch for the session on screen", hint: "Keeps this repo's ahead/behind counts fresh while you look at it.",
    cur: p?.fetch !== undefined ? `${on ? "On" : "Off"} here; Settings says ${g.enabled ? "on" : "off"}` : `${on ? "On" : "Off"}, from Settings`,
    overridden: p?.fetch !== undefined, ctl: segCtl("fetch", "Auto-fetch", sw, p?.fetch === undefined ? "" : p.fetch ? "on" : "off"),
  }, {
    id: "every", label: "At most every", hint: "How old a count may get before arriving here fetches again.",
    cur: p?.fetchEvery !== undefined ? `${every(p.fetchEvery)} here; Settings says ${every(g.everyMs)}` : `${every(g.everyMs)}, from Settings`,
    overridden: p?.fetchEvery !== undefined, ctl: segCtl("every", "Fetch cadence", cad, p?.fetchEvery ? String(p.fetchEvery) : ""),
  }];
}

function ghRow(k: string): PsRow {
  const pin = ghAccountFor(k);
  const who = ghWho(pin, ghLogins);
  const base = { id: "gh", label: "GitHub account", hint: "Which gh login this project's issues and pull requests are read as." };
  if (ghLogins.length < 2 && !pin) {
    return { ...base, ctl: nilCtl(who.login ?? "—"),
      note: ghLogins.length ? "Only one account is logged in to gh, so there is nothing to pin." : "gh is not logged in." };
  }
  const opts: PsSeg[] = [{ value: "", label: "gh's active", sub: "Follow whichever account gh has active" },
    ...ghLogins.map((a) => ({ value: a.login, label: a.login }))];
  if (pin && !who.known) opts.push({ value: pin, label: `${pin} (logged out)`, sub: "gh is no longer logged in as this account" });
  return { ...base, cur: pin ? `${pin} here${who.known ? "" : " · gh is not logged in as it"}` : `${who.login ?? "—"}, gh's active account`,
    overridden: !!pin, ctl: segCtl("gh", "GitHub account", opts, pin ?? "") };
}

// Read from the binding, never spelled: a rebound or cleared chord must not be advertised.
const paletteKey = () => comboKeys(activeBind(keyPrefs, "palette"), IS_MAC).join(IS_MAC ? "" : "+") || "the command palette";

function stopRow(k: string): PsRow {
  const r = stopRules[k];
  return {
    id: "stop", label: "Run after a session stops", hint: "A task that runs each time an agent here finishes a turn.",
    cur: r ? `Runs ${r.label}` : undefined, overridden: !!r,
    ctl: r ? btnCtl("unstop", "Remove") : nilCtl("none"),
    note: r ? undefined : `Set one with ⟲ in this project's task panel (${paletteKey()} → Manage this project's tasks).`,
  };
}

const SHARE: Record<ShareMode, string> = { git: "Git", server: "Sync server", off: "Nowhere" };
function shareRow(k: string): PsRow {
  const mode = shareModeOf(k);
  const id = projectIdOf(k);
  const paired = syncStatus.configured;
  const off = !paired ? "Pair a sync server first, in Settings › Sync" : !id ? "Not in git, so the server has nothing to file it under" : undefined;
  const opts: PsSeg[] = [
    { value: "git", label: "Git", sub: "Committed in .episko/" },
    { value: "server", label: "Sync server", sub: "Through sync; nothing in the repo", off: mode === "server" ? undefined : off },
    { value: "off", label: "Nowhere", sub: "Nothing is shared or offered" },
  ];
  const team = paired ? teamShare(id) : null;
  const lines = paired ? Object.keys(serverDigest(id)).length : 0, notes = paired ? serverNotes(id).length : 0;
  const facts = [lines ? `${lines} work-log day${lines === 1 ? "" : "s"}` : "", notes ? `${notes} note${notes === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const cur = [
    team && team.mode !== mode && mode !== "off" ? `the team last chose ${SHARE[team.mode]}${team.by ? ` (${team.by})` : ""}` : "",
    facts ? `on the server: ${facts}` : "", digestFile ? ".episko/digest.md is in the repo" : "",
  ].filter(Boolean).join(" · ");
  const move = digestFile && mode !== "git" && id
    ? btnCtl("movelog", "Move to the server", "Send .episko/digest.md's days to the server, then delete the file and commit the deletion") : "";
  return {
    id: "share", label: "Notes and work log", hint: "Where shared notes and each day's project line go. Git or Sync server switches your teammates too; Nowhere is yours alone.",
    cur: cur || undefined, ctl: move + segCtl("share", "Notes and work log", opts, mode),
  };
}

const mineRows = (k: string): PsRow[] => [agentRow(k), permRow(k), ...fetchRows(k), ghRow(k), stopRow(k)];
/** How many of this project's own rows answer for themselves: the panel's lead and the menu's sub. */
export const overrideCount = (k: string): number => mineRows(k).filter((r) => r.overridden).length;

export function renderProjSettings() {
  if (!projSettingsOpen() || !key) return;
  const k = key;
  const html = projSettingsHtml({
    name: basename(k), path: tilde(k), accent: accentFor(k),
    mine: mineRows(k),
    team: [shareRow(k)],
    teamNote: "Branch locks, claims and health thresholds are committed in .episko/episko.toml and edited where they act.",
  });
  if (html === last) return;
  last = html;
  $("projBody").innerHTML = html;
}

function act(verb: string, val: string) {
  const k = key;
  if (!k) return;
  const provider = effectiveAgent(k).id;
  if (verb === "agent") host.setAgent(k, val || null);
  else if (verb === "perm") host.setPerm(k, provider, val || null);
  else if (verb === "fetch") host.setFetch(k, { fetch: val === "" ? null : val === "on" });
  else if (verb === "every") host.setFetch(k, { fetchEvery: val ? Number(val) : null });
  else if (verb === "gh") host.setGh(k, val || null);
  else if (verb === "unstop") clearStopRule(k);
  else if (verb === "share") host.setShare(k, val as ShareMode);
  else if (verb === "movelog") { void host.moveLog(k).then(() => { digestFile = false; renderProjSettings(); }); return; }
  else if (verb === "reset") {
    if (val === "stop") clearStopRule(k);
    else return act(val, "");
  }
  renderProjSettings();
}

$("projClose").addEventListener("click", closeProjectSettings);
$("projBody").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ps]");
  if (!b || (b as HTMLButtonElement).disabled) return;
  const raw = b.dataset.ps!;
  const i = raw.indexOf("|");
  act(i < 0 ? raw : raw.slice(0, i), i < 0 ? "" : raw.slice(i + 1));
});
