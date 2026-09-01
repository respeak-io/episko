// Provider-neutral pending-approval queue. The cockpit shows one request at a time but
// must not lose an earlier ask when parallel tools raise a second; the scalar fields on
// `Sess` are a projection of the queue's head, so every call site agrees what is on screen.

import type { PendingPermission, Sess } from "./types";

function projectHead(s: Sess): void {
  const head = s.pendingPermissions[0];
  if (head) {
    s.attention = `permission: ${head.tool}`;
    s.pendingCmd = head.command;
    s.pendingPermId = head.id;
    s.pendRisk = head.risk;
  } else {
    s.attention = null;
    s.pendingCmd = "";
    s.pendingPermId = null;
    s.pendRisk = null;
  }
}

export function queuePermission(s: Sess, permission: PendingPermission): void {
  const at = s.pendingPermissions.findIndex((pending) => pending.id === permission.id);
  if (at >= 0) s.pendingPermissions[at] = permission;
  else s.pendingPermissions.push(permission);
  projectHead(s);
}

export function removePermission(s: Sess, id: string): void {
  s.pendingPermissions = s.pendingPermissions.filter((pending) => pending.id !== id);
  // Claude's blocking hook predates the queue and can still populate only the scalar
  // fields. Do not clear an unrelated legacy request when an unknown id resolves.
  if (s.pendingPermId === id || s.pendingPermissions.length) projectHead(s);
}

export function clearPermissionState(s: Sess): void {
  s.pendingPermissions = [];
  projectHead(s);
}

export function pendingPermissionIds(s: Sess): string[] {
  const ids = s.pendingPermissions.map((pending) => pending.id);
  if (s.pendingPermId && !ids.includes(s.pendingPermId)) ids.unshift(s.pendingPermId);
  return ids;
}
