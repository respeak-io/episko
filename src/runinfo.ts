// What each task IS, as the describer read it: `[run."<id>"]` in .episko/episko.toml. Pure; the
// name rule in tasks.rs (`dev`, `start`, …) is only the fallback for a project nobody described.
// A description is pinned to the command it read (`hash`), so an edited task reads as stale.

import { stackSummary, type StackCfg, type TaskRef } from "./stack";
import type { Runnable } from "./types";

export const RUN_KINDS = ["check", "test", "build", "server", "app", "watch", "infra-up", "infra-down", "deploy", "script"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
// What never exits on its own: a pane that stays up, a member a stack waits on, a run MCP reports once it is up.
export const LONG_KINDS: ReadonlySet<string> = new Set(["server", "app", "watch"]);

export interface RunInfo {
  kind: string; pages?: Record<string, string>; ready?: string | null; stops?: string | null;
  brings_up?: string[]; note?: string | null; hash: string;
}

/** FNV-1a over the command, 8 hex digits: a fingerprint, not a secret. */
export function cmdHash(cmd: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < cmd.length; i++) { h ^= cmd.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// What a description is pinned to: the command, or for a compound task the tasks it runs.
export const taskCmd = (r: Pick<Runnable, "compound" | "dependsOn" | "exec">): string =>
  r.compound ? r.dependsOn.join(" + ") : r.exec.mode === "shell" ? r.exec.line : [r.exec.program, ...r.exec.args].join(" ");

/**
 * Lay descriptions over discovery. A fresh one can only turn `background` ON (a declared
 * `isBackground` or tasks.toml `background` is never overridden off); a stale one is shown
 * as stale and changes nothing, since it described a command that no longer exists.
 */
export function applyRunInfo(rs: readonly Runnable[], infos: Readonly<Record<string, RunInfo>>): Runnable[] {
  return rs.map((r) => {
    const info = infos[r.id];
    if (!info || !RUN_KINDS.includes(info.kind as RunKind)) return r;
    if (info.hash !== cmdHash(taskCmd(r))) return { ...r, described: "stale" as const };
    return {
      ...r, described: "fresh" as const, kind: info.kind as RunKind,
      background: r.background || LONG_KINDS.has(info.kind),
      ready: info.ready ?? undefined, describedPages: info.pages, stops: info.stops ?? undefined, note: info.note ?? undefined,
    };
  });
}

export function describedTally(rs: readonly Runnable[]): { fresh: number; stale: number; missing: number } {
  const real = rs.filter((r) => !r.blocked);
  const fresh = real.filter((r) => r.described === "fresh").length;
  const stale = real.filter((r) => r.described === "stale").length;
  return { fresh, stale, missing: real.length - fresh - stale };
}

/**
 * The headless describer's prompt (stack.rs runs it read-only, in the project). Handed every id
 * discovery found with its command, so it describes tasks rather than inventing them, and asked
 * for one fenced block: `[stack]`, one `[run."<id>"]` per task, any `[[task]]` it adds.
 */
export function describePrompt(current: StackCfg, tasks: readonly TaskRef[]): string {
  const now = stackSummary(current);
  return [
    "Read this software project and describe what each of its tasks does when run, and how its development environment starts and stops.",
    "Episko, a desktop app that runs these tasks in terminal panes, uses your answer to monitor them: which ones keep running, which addresses they serve, when they are ready, and how to stop them.",
    "You can only read files. Look at the justfile, .vscode/tasks.json and launch.json, package.json scripts, Makefile, .episko/tasks.toml, docker-compose files, env files and the scripts they call. Follow a task into the script it runs before deciding what it is.",
    "",
    "These are the tasks Episko found here, id · command. Use the ids exactly as written:",
    ...(tasks.length ? tasks.map((t) => `- ${t.id} · ${t.cmd}`) : ["(none)"]),
    "",
    "Answer with exactly one fenced ```toml block containing:",
    "",
    "1. One table per task above, [run.\"<id>\"], with:",
    `- kind, exactly one of: ${RUN_KINDS.join(", ")}. check = lint/typecheck/format check; test = runs tests and exits; build = produces artifacts and exits; server = keeps serving on a port; app = opens a desktop or browser window and keeps running; watch = rebuilds on change and keeps running; infra-up / infra-down = starts or stops containers or services and then exits; deploy = publishes, releases, pushes or uploads anywhere outside this machine; script = anything else that exits.`,
    "- pages (servers and apps only): an inline table, name = URL, of the addresses it serves, exactly as the scripts, env files or proxy config define them. A named host like app.localhost matters: never rewrite it to localhost.",
    "- ready (servers and apps only): a short piece of text its output prints once it is up and usable, if the scripts print one.",
    "- stops: the id of the task that stops what this one starts, if there is one.",
    "- brings_up: the docker compose service names it starts, if any.",
    "- note: one short sentence, only for a deploy or anything destructive (what it publishes or deletes).",
    "Leave a field out when the files do not support it.",
    "",
    `2. A [stack] table: up = the id that brings the whole dev environment up; down = the id that stops it, especially its containers; compose = Compose project names started from outside this repository (usually leave it out); pages = an inline table of addresses a developer opens that no single task serves. ${now ? `The current table is: ${now}. Keep what is right.` : "There is none yet."}`,
    "",
    "3. Only if no listed task stops the containers: a [[task]] with label and run (a shell command run from the project root, using docker compose stop rather than down), and point down at episko:<the label lowercased, every run of other characters turned into one dash>.",
    "",
    "After the block write a line containing only WHY, then one line per [stack] value starting with \"- up:\", \"- down:\", \"- compose:\", \"- pages:\" or \"- task:\" saying which file and lines it is based on. Write nothing else.",
  ].join("\n");
}

/** The describer's entries for tasks that exist, pinned to their command; a bad kind is dropped. */
export function checkRun(run: Readonly<Record<string, Omit<RunInfo, "hash"> & { hash?: string }>>, rs: readonly Runnable[]): { run: Record<string, RunInfo>; dropped: string[] } {
  const byId = new Map(rs.map((r) => [r.id, r]));
  const out: Record<string, RunInfo> = {};
  const dropped: string[] = [];
  for (const [id, info] of Object.entries(run)) {
    const r = byId.get(id);
    if (!r) { dropped.push(`${id} is not a task in this project`); continue; }
    if (!RUN_KINDS.includes(info.kind as RunKind)) { dropped.push(`${id}: "${info.kind}" is not a kind`); continue; }
    const pages = Object.fromEntries(Object.entries(info.pages ?? {}).filter(([, u]) => /^https?:\/\/\S+$/i.test(u)));
    const stops = info.stops && byId.has(info.stops) ? info.stops : undefined;
    out[id] = { ...info, pages, stops, hash: cmdHash(taskCmd(r)) };
  }
  return { run: out, dropped };
}

/** One paragraph for the review dialog: counts by kind, every long-running task, every deploy. */
export function runSummaryText(run: Readonly<Record<string, RunInfo>>, before: Readonly<Record<string, RunInfo>>): string {
  const ids = Object.keys(run);
  if (!ids.length) return "";
  const by = new Map<string, string[]>();
  for (const id of ids) by.set(run[id].kind, [...(by.get(run[id].kind) ?? []), id]);
  const counts = RUN_KINDS.filter((k) => by.has(k)).map((k) => `${by.get(k)!.length} ${k}`).join(", ");
  const changed = ids.filter((id) => before[id] && before[id].kind !== run[id].kind);
  const lines = [`Describes ${ids.length} task${ids.length === 1 ? "" : "s"}: ${counts}.`];
  const long = ids.filter((id) => LONG_KINDS.has(run[id].kind));
  if (long.length) lines.push("", "Keep running:", "", ...long.map((id) => `- \`${id}\` (${run[id].kind})${Object.keys(run[id].pages ?? {}).length ? `: ${Object.values(run[id].pages!).join(", ")}` : ""}`));
  const risky = by.get("deploy") ?? [];
  if (risky.length) lines.push("", "Deploys:", "", ...risky.map((id) => `- \`${id}\`${run[id].note ? `: ${run[id].note}` : ""}`));
  if (changed.length) lines.push("", `Changed kind since the last description: ${changed.map((id) => `\`${id}\` ${before[id].kind} → ${run[id].kind}`).join(", ")}.`);
  return lines.join("\n");
}
