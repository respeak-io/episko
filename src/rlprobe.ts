// The one thing about account usage the telemetry stream cannot tell us: the per-model
// weekly windows. Asked of the CLI (`claude_usage_limits`) when a surface that shows them
// opens — never on a timer, so nothing here spawns a process you did not ask for.

import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debug";
import { applyPlanLimits, rlScoped, type PlanLimits } from "./rl";

// Each probe is a short-lived `claude` process, so a popover opened, closed and reopened is
// answered from the last reading. Stamped before the call and on failure too: a machine with
// no working CLI must back off rather than spawn one per click.
const TTL = 60_000;
let lastTry = 0;
let inflight: Promise<void> | null = null;

export function refreshScopedLimits(force = false): Promise<void> {
  if (inflight) return inflight; // both surfaces open at once still asks once
  if (!force && lastTry && Date.now() - lastTry < TTL) return Promise.resolve();
  lastTry = Date.now();
  inflight = invoke<PlanLimits>("claude_usage_limits")
    .then(applyPlanLimits)
    .catch((e) => { dlog("warn", "usage limits: " + e); })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Whether a reading has ever landed — the surfaces say "asking…" rather than "none" until it has. */
export const scopedAsked = () => rlScoped.at > 0;
