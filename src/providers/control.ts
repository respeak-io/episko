// Provider-specific approval routing belongs at the control-plane boundary. Claude's
// blocking HTTP hook and integrated sidecars use different backend commands; shared
// actions and lifecycle reducers should not know that distinction.

import { invoke } from "@tauri-apps/api/core";
import { CLAUDE_CLI, type Sess } from "../types";

export function resolveProviderPermission(s: Sess, requestId: string, behavior: string): Promise<unknown> {
  return s.provider === CLAUDE_CLI.id
    ? invoke("resolve_permission", { id: requestId, behavior })
    : invoke("resolve_agent_request", { sessionId: s.id, requestId, behavior });
}
