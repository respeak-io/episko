// Routes an approval to the provider's own backend command; shared actions never learn the split.

import { invoke } from "@tauri-apps/api/core";
import { CLAUDE_CLI, type Sess } from "../types";

export function resolveProviderPermission(s: Sess, requestId: string, behavior: string): Promise<unknown> {
  return s.provider === CLAUDE_CLI.id
    ? invoke("resolve_permission", { id: requestId, behavior })
    : invoke("resolve_agent_request", { sessionId: s.id, requestId, behavior });
}
