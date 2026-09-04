// Frontend provider registry: shared UI asks here for normalized events and history and
// never imports a vendor adapter or branches on a provider id. Adding a provider means one
// entry here, an adapter beside this file, and a control plane in agent.rs (docs/providers.md).

import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent, ProviderEvent } from "../agents";
import type { HistEntry } from "../history";
import {
  agentInstalled, CLAUDE_CLI, type AgentCli, type AgentPermissionMode, type Restorable,
} from "../types";
import { CODEX_PERMISSION_MODES, codexEvents, codexHistoryEntries, codexHistoryMessages } from "./codex";
import { forecast5h, forecast7d, type Forecast } from "../rl";

const CLAUDE_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  { id: "default",           label: "Manual",       sub: "Asks before anything risky · Episko's permission cards", glyph: "◇", asks: true },
  { id: "plan",              label: "Plan",         sub: "Reads and plans; runs nothing until you accept",         glyph: "⊙", asks: false },
  { id: "acceptEdits",       label: "Accept edits", sub: "File edits go through; commands still ask",              glyph: "✎", asks: true },
  { id: "auto",              label: "Auto",         sub: "A model classifier answers the prompts for you",         glyph: "◈", asks: false },
  { id: "dontAsk",           label: "Don't ask",    sub: "Never prompts · anything not pre-approved is denied",    glyph: "⊘", asks: false },
  { id: "bypassPermissions", label: "Bypass",       sub: "No permission checks at all. Claude confirms once",      glyph: "⚠", asks: false },
];

// `at` is the message's own ISO timestamp where the provider records one; a reader that
// wants a clock parses it and shows nothing when it is absent.
export interface ProviderMessage { role: string; text: string; at?: string | null }

export interface ProviderHistory {
  list(limit: number): Promise<HistEntry[]>;
  read(sessionId: string, cwd: string, limit: number): Promise<ProviderMessage[]>;
  reconcile(entries: Restorable[]): Promise<Restorable[]>;
}

export interface AgentProviderAdapter {
  id: string;
  label: string;
  events?: (event: ProviderEvent) => AgentEvent[];
  history?: ProviderHistory;
  permissionModes?: readonly AgentPermissionMode[];
  rateLimitForecasts?: () => { windowMins: number; forecast: Forecast }[];
}

const claudeHistory: ProviderHistory = {
  async list(limit) {
    const rows = await invoke<Omit<HistEntry, "provider">[]>("list_session_history", { limit });
    return rows.map((row) => ({ ...row, provider: "claude" }));
  },
  read(sessionId, cwd, limit) {
    return invoke<ProviderMessage[]>("read_transcript", { cwd, sessionId, limit });
  },
  async reconcile(entries) {
    const byDir = new Map<string, Restorable[]>();
    for (const entry of entries) {
      const group = byDir.get(entry.workdir);
      if (group) group.push(entry); else byDir.set(entry.workdir, [entry]);
    }
    const found: Restorable[] = [];
    await Promise.all([...byDir.entries()].map(async ([workdir, group]) => {
      const past = await invoke<{ session_id: string; title: string; last_active: number }[]>(
        "list_past_sessions", { workdir },
      );
      const byId = new Map(past.map((row) => [row.session_id.toLowerCase(), row]));
      for (const entry of group) {
        const hit = byId.get(entry.resumeId.toLowerCase());
        if (!hit) continue;
        found.push({
          ...entry,
          title: hit.title || entry.title || "",
          lastActivity: hit.last_active ? hit.last_active * 1000 : entry.lastActivity,
        });
      }
    }));
    return found;
  },
};

const codexHistory: ProviderHistory = {
  async list(limit) {
    const result = await invoke<unknown>("agent_history", {
      provider: "codex", threadId: null, limit,
    });
    return codexHistoryEntries(result);
  },
  async read(sessionId, _cwd, limit) {
    const result = await invoke<unknown>("agent_history", {
      provider: "codex", threadId: sessionId, limit,
    });
    return codexHistoryMessages(result, limit);
  },
  async reconcile(entries) {
    const rows = await codexHistory.list(300);
    const byId = new Map(rows.map((row) => [row.session_id.toLowerCase(), row]));
    const found: Restorable[] = [];
    for (const entry of entries) {
      const hit = byId.get(entry.resumeId.toLowerCase());
      if (!hit) continue;
      found.push({
        ...entry,
        title: hit.title || entry.title || "",
        lastActivity: hit.last_active ? hit.last_active * 1000 : entry.lastActivity,
      });
    }
    return found;
  },
};

export const PROVIDER_ADAPTERS: readonly AgentProviderAdapter[] = [
  { id: "claude", label: "Claude", history: claudeHistory, permissionModes: CLAUDE_PERMISSION_MODES, rateLimitForecasts: () => [
    { windowMins: 300, forecast: forecast5h() },
    { windowMins: 10080, forecast: forecast7d() },
  ] },
  { id: "codex", label: "Codex", events: codexEvents, history: codexHistory, permissionModes: CODEX_PERMISSION_MODES },
];

const PROVIDERS = new Map(PROVIDER_ADAPTERS.map((provider) => [provider.id, provider]));

export const providerAdapter = (id: string) => PROVIDERS.get(id);

export function providerPermissionMode(provider: string, id: string): AgentPermissionMode | null {
  const modes = providerAdapter(provider)?.permissionModes;
  if (!modes?.length) return null;
  return modes.find((mode) => mode.id === id) ?? modes[0];
}

/** Integrated history readers whose CLI is installed and advertises the capability. */
export function historyProviders(available: AgentCli[]): AgentProviderAdapter[] {
  return PROVIDER_ADAPTERS.filter((provider) => {
    const cli = provider.id === CLAUDE_CLI.id
      ? CLAUDE_CLI
      : available.find((candidate) => candidate.id === provider.id);
    return !!provider.history && !!cli && agentInstalled(cli) && cli.capabilities.includes("history");
  });
}

export async function readProviderHistory(
  provider: string, sessionId: string, cwd: string, limit: number,
): Promise<ProviderMessage[]> {
  const history = providerAdapter(provider)?.history;
  if (!history) throw new Error(`history is not integrated for ${provider}`);
  return history.read(sessionId, cwd, limit);
}

// A provider whose history call fails keeps its rows (a transient PATH/auth failure must not erase
// the roster); so does one without history, for rosters written by older builds.
export async function reconcileProviderRestorables(entries: Restorable[]): Promise<Restorable[]> {
  const grouped = new Map<string, Restorable[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.provider);
    if (group) group.push(entry); else grouped.set(entry.provider, [entry]);
  }
  const groups = await Promise.all([...grouped.entries()].map(async ([provider, rows]) => {
    const history = providerAdapter(provider)?.history;
    if (!history) return rows;
    try { return await history.reconcile(rows); }
    catch { return rows; }
  }));
  return groups.flat();
}
