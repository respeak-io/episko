// The review overlay's write verbs: which paths a ticked file means, what each verb may
// touch, and what its question says. No DOM, no Tauri; ./diffview drives them (docs/worktrees.md).

import type { DiffFile } from "./diff";
import type { StashEntry } from "./types";

/** Every path git must be told about: a rename is two, and committing half of one is a copy. */
export function filePaths(files: readonly DiffFile[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    out.add(f.path);
    if (f.oldPath && f.oldPath !== f.path) out.add(f.oldPath);
  }
  return [...out];
}

/** Only a plain modification can lose one hunk: for an added or deleted file the hunk IS the
 *  file, and reversing a rename's hunk would move the file back as well. */
export const canDiscardHunk = (f: DiffFile): boolean => f.status === "modified" && !f.binary && f.hunks.length > 0;

/** Why Commit is greyed, or "" when it is not. */
export function commitBlock(message: string, picked: number): string {
  if (!picked) return "Tick the files to commit";
  if (!message.trim()) return "Write a commit message first";
  return "";
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** The confirm for discarding files. Plain text for ./confirm's `dialogBody`; it names what
 *  is deleted outright, because a new file has no HEAD to go back to. */
export function discardQuestion(files: readonly DiffFile[], live: number): { title: string; message: string; okLabel: string } {
  const added = files.filter((f) => f.status === "added");
  const one = files.length === 1 ? files[0] : null;
  const title = one ? `Discard changes to ${one.path.split("/").pop()}?` : `Discard changes to ${plural(files.length, "file")}?`;
  const lines: string[] = [];
  if (one) lines.push(one.status === "added" ? `\`${one.path}\` is new, so it will be deleted.` : `\`${one.path}\` goes back to how the last commit has it.`);
  else {
    lines.push(`${plural(files.length - added.length, "file")} go back to how the last commit has them.`);
    if (added.length) lines.push(`${plural(added.length, "new file")} will be deleted.`);
  }
  lines.push("", "This cannot be undone. Stash instead if you might want it back.");
  if (live) lines.push("", `${plural(live, "agent is", "agents are")} working in this folder right now.`);
  return { title, message: lines.join("\n"), okLabel: "Discard" };
}

/** The stash stack is the repo's, shared by every worktree; one made on another branch says so. */
export function stashElsewhere(e: StashEntry, branch: string): boolean {
  return !!branch && !!e.branch && e.branch !== branch;
}
