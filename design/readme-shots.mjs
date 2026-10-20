// The README's docs/shot-*.png: the real frontend, fed made-up sessions through readme-stub.js.
// Render: vite on :1420; a FRESH Playwright context per shot (1200×750, or 1440×860 for "dashboard", whose
// three columns need >1320px; deviceScaleFactor 2, locale en-US) with addInitScript `window.__SHOT =
// "<name>"` and THEN readme-stub.js, which reads it; goto :1420, addScriptTag({ type: "module", path: this file }), wait for
// window.__scene plus ~5s (the server poll fills the pill), screenshot.
import { launch, launchShell, setActive } from "/src/panes.ts";
import { sessions } from "/src/state.ts";
import { openPalette } from "/src/palui.ts";
import { openRunPicker } from "/src/taskui.ts";
import { openWt } from "/src/worktree.ts";
import { openUsage } from "/src/usagedlg.ts";
import { openDashboard } from "/src/dashboard.ts";
const S = window.__stub;
const H = S.handlers;
const now = () => Math.floor(Date.now() / 1000);

const BRANCH = { episko: "feat/back-forward", "billing-api": "main", "docs-site": "main", "garden-planner": "main" };
const nameOf = (wd) => wd.split("/").pop();
H["spawn_claude"] = () => null;
H["spawn_shell"] = () => null;
H["write_pty"] = () => null;
H["resize_pty"] = () => null;
H["git_branch"] = ({ workdir }) => BRANCH[nameOf(workdir)] ?? "main";
H["git_head"] = ({ workdir }) => ({ branch: BRANCH[nameOf(workdir)] ?? "main", short: "4c1e9a2" });
H["worktree_heads"] = ({ dir }) => [{ path: dir, branch: BRANCH[nameOf(dir)] ?? "main", is_main: true, exists: true }];
H["git_diffstat"] = ({ workdir }) => nameOf(workdir) === "episko"
  ? { added: 86, removed: 14, files: 4, untracked: 1, dirty: 5, upstream: "origin/feat/back-forward", ahead: 2, behind: 0, stash: 0 }
  : { added: 0, removed: 0, files: 0, untracked: 0, dirty: 0, upstream: "origin/main", ahead: 0, behind: 0, stash: 0 };
H["session_ports"] = () => [];
H["compose_containers"] = () => [];
H["list_external_sessions"] = () => [];
H["live_sessions"] = () => [];
H["update_tray"] = () => null;
H["log_frontend"] = () => null;
H["write_debug_file"] = () => null;
H["read_bg_log"] = ({ taskId }) => {
  const text = "\n> episko@0.36.0 dev\n> vite\n\n  VITE v6.4.3  ready in 412 ms\n\n  ➜  Local:   http://localhost:1420/\n  ➜  Network: use --host to expose\n";
  return { missing: false, path: `/tmp/claude-501/tasks/${taskId}.output`, text, len: text.length, unchanged: false, reason: "none", tried: [], rootRank: 0, discovered: false };
};
H["find_project_icon"] = async ({ dir }) => {
  if (nameOf(dir) !== "episko") return null;
  const b = await (await fetch("/design/appicon.png")).blob();
  const uri = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
  return { data_uri: uri };
};

// ---- the episko repo: tasks, checkouts and branches ----
const WT = (b) => `${S.HOME}/code/.cc-worktrees/episko/${b}`;
const run = (source, sourceFile, label, line, extra = {}) => ({
  id: `${source}:${label}`, label, detail: line, source, sourceFile, group: null,
  exec: { mode: "shell", line }, cwd: S.P("episko"), env: {}, background: false, inputs: [],
  dependsOn: [], dependsOrder: "parallel", blocked: null, compound: false, defaultFor: null, ...extra,
});
H["discover_runnables"] = ({ workdir }) => nameOf(workdir) !== "episko" ? [] : [
  run("npm", "package.json", "dev", "vite", { background: true }),
  run("npm", "package.json", "test", "vitest run", { defaultFor: "test" }),
  run("just", "justfile", "check", "pnpm build && pnpm test && cargo clippy --all-targets -- -D warnings"),
  run("vscode", ".vscode/tasks.json", "Dev: Frontend + Backend", "", { compound: true, dependsOn: ["dev", "Backend: cargo watch"] }),
  run("vscode", ".vscode/tasks.json", "Backend: cargo watch", "cargo watch -x check", { background: true }),
  run("vscode", ".vscode/tasks.json", "Lint current file", "", { blocked: "needs an open editor file", detail: "needs an open editor file" }),
  run("launch", ".vscode/launch.json", "Debug Tauri", "cargo run --no-default-features"),
  run("launch", ".vscode/launch.json", "Attach", "", { blocked: "attaches to a running process — needs a debugger", detail: "attaches to a running process — needs a debugger" }),
  run("make", "Makefile", "icons", "tauri icon design/appicon.png"),
  run("make", "Makefile", "clean", "rm -rf dist src-tauri/target"),
];
H["list_task_overrides"] = () => [];
H["list_worktrees"] = ({ repoDir }) => nameOf(repoDir) !== "episko" ? [] : [
  { path: S.P("episko"), branch: "feat/back-forward", is_main: true, dirty: true, merged: false, locked: false, exists: true },
  { path: WT("fix-handoff-flake"), branch: "fix/handoff-flake", is_main: false, dirty: false, merged: false, locked: false, exists: true },
  { path: WT("feat-settings-search"), branch: "feat/settings-search", is_main: false, dirty: true, merged: false, locked: false, exists: true },
];
const br = (name, o = {}) => ({ name, current: false, checked_out: false, upstream: `origin/${name}`, ahead: 0, behind: 0, gone: false,
  merged: false, remote: false, base: "origin/main", author: "Mira Kühn", sha: "4c1e9a2", rel: "2 days ago", unix: now() - 2 * 86400,
  remote_ref: `refs/remotes/origin/${name}`, remote_sha: "4c1e9a2", t_ahead: 0, t_behind: 0, is_default: false, ...o });
H["git_branch_list"] = ({ repoDir }) => nameOf(repoDir) !== "episko" ? [] : [
  br("main", { is_default: true, author: "Sam Ortiz", rel: "3 hours ago", unix: now() - 3 * 3600 }),
  br("feat/back-forward", { current: true, checked_out: true, ahead: 2, t_ahead: 7, author: "Sam Ortiz", rel: "4 minutes ago", unix: now() - 240 }),
  br("fix/handoff-flake", { checked_out: true, t_ahead: 1, author: "Sam Ortiz", rel: "25 minutes ago", unix: now() - 1500 }),
  br("feat/settings-search", { checked_out: true, t_ahead: 4, rel: "1 hour ago", unix: now() - 3600 }),
  br("feat/stack-watch", { remote: true, upstream: "", t_ahead: 9, t_behind: 3, author: "Jonas Weber", rel: "yesterday", unix: now() - 86400 }),
  br("docs/readme-rework", { merged: true, author: "Sam Ortiz", rel: "5 days ago", unix: now() - 5 * 86400 }),
];
H["git_commit_info"] = ({ rev }) => ({ short: "4c1e9a2", subject: rev && rev.includes("handoff") ? "handoff: wait for the server's done before settling" : "nav: record locations in one place", author: "Sam Ortiz", rel: "4 minutes ago" });
H["git_working_set"] = ({ workdir }) => nameOf(workdir) === "episko"
  ? { added: 86, removed: 14, files: 4, untracked: 1, dirty: 5, upstream: "origin/feat/back-forward", ahead: 2, behind: 0, stash: 0,
      entries: [
        { path: "src/nav.ts", code: "M", from: null, added: 31, removed: 6 },
        { path: "src/main.ts", code: "M", from: null, added: 22, removed: 5 },
        { path: "src/keys.ts", code: "M", from: null, added: 6, removed: 1 },
        { path: "index.html", code: "M", from: null, added: 4, removed: 2 },
        { path: "test/nav.test.ts", code: "??", from: null, added: 64, removed: 0 },
      ] }
  : { added: 0, removed: 0, files: 0, untracked: 0, dirty: 0, upstream: "origin/main", ahead: 0, behind: 0, stash: 0, entries: [] };

const enc = new TextEncoder();
const out = (id, str) => {
  const bytes = enc.encode(str); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  S.emit("pty-output", { sessionId: id, data: btoa(bin), seq: 0 });
};
const hook = (id, data) => S.emit("telemetry", { kind: "hook", data: { session_id: id, transcript_path: `/Users/dev/.claude/projects/x/${id}.jsonl`, ...data } });
const status = (id, model, ctx, cost, mins) => S.emit("telemetry", { kind: "statusline", data: {
  session_id: id, model: { display_name: model }, context_window: { used_percentage: ctx, used_tokens: ctx * 2000 },
  cost: { total_cost_usd: cost, total_duration_ms: mins * 60000, total_api_duration_ms: mins * 25000 },
  rate_limits: { five_hour: { used_percentage: 58, resets_at: now() + 7920 }, seven_day: { used_percentage: 34, resets_at: now() + 4 * 86400 + 5000 } } } });
const title = (id, t) => out(id, `\x1b]0;✳ ${t}\x07`);
let tu = 0;
const tool = (id, name, input, response) => {
  const tid = `tu_${++tu}`;
  hook(id, { hook_event_name: "PreToolUse", tool_name: name, tool_use_id: tid, tool_input: input });
  if (response !== undefined) hook(id, { hook_event_name: "PostToolUse", tool_name: name, tool_use_id: tid, tool_input: input, tool_response: response });
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the project dashboard: a week of commits, the graph, GitHub and Dependabot ----
const iso = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const PEOPLE = ["Sam Ortiz", "Mira Kühn", "Jonas Weber"];
const SUBJECTS = ["nav: record locations in one place", "handoff: wait for the server's done", "stack: name the container that broke",
  "review: pin the merge to the head you read", "deps: bump vite to 6.4.3", "outline: hunt from the nearer end", "settings: search the hint text too",
  "servers: one row per wrangler dev", "tasks: say when a program is missing", "docs: README around what is unusual"];
H["project_facts"] = ({ dir }) => ({ is_repo: true, root: dir, origin: "git@github.com:acme/episko.git", host: "github.com", slug: "acme/episko" });
H["git_log_days"] = ({ roots }) => {
  const out = []; let k = 0;
  for (let d = 0; d < 7; d++) for (let i = 0; i < [5, 3, 7, 0, 4, 6, 2][d]; i++, k++)
    out.push({ sha: (0x4c1e9a2 + k * 7919).toString(16).padStart(40, "a"), author: PEOPLE[k % 3], when: now() - d * 86400 - i * 3100 - 600, subject: SUBJECTS[k % SUBJECTS.length], root: roots[0] });
  return out;
};
H["git_graph"] = () => {
  const c = (i, subject, author, parents, refs = "") => ({ sha: `${i}`.padStart(40, "c"), short: `${i}`.padStart(7, "c"), parents: parents.map((p) => `${p}`.padStart(40, "c")), subject, author, unix: now() - i * 5400, rel: `${Math.max(1, Math.round(i * 1.5))} hours ago`, refs });
  return { more: false, commits: [
    c(1, "nav: record locations in one place", "Sam Ortiz", [3], "HEAD -> refs/heads/feat/back-forward, refs/remotes/origin/feat/back-forward"),
    c(2, "handoff: wait for the server's done", "Sam Ortiz", [4], "refs/heads/fix/handoff-flake"),
    c(3, "nav: two stacks and a cursor", "Sam Ortiz", [5]),
    c(4, "Merge pull request #212 from acme/feat/claim-leases", "Mira Kühn", [5, 6], "refs/remotes/origin/main, refs/heads/main"),
    c(5, "stack: name the container that broke", "Jonas Weber", [7]),
    c(6, "claims: a claim is a lease", "Mira Kühn", [7]),
    c(7, "deps: bump vite to 6.4.3", "dependabot[bot]", [8]),
    c(8, "review: pin the merge to the head you read", "Mira Kühn", [9]),
    c(9, "servers: one row per wrangler dev", "Jonas Weber", []),
  ] };
};
const thread = (number, kind, title, h, o = {}) => ({ number, kind, title, url: `https://github.com/acme/episko/${kind === "pr" ? "pull" : "issues"}/${number}`,
  assignees: [], labels: [], branch: null, author: PEOPLE[number % 3].split(" ")[0].toLowerCase(), draft: false, updated_at: iso(h), ...o });
H["gh_threads"] = () => ({ available: true, reason: null, viewer: "sam", threads: [
  thread(231, "issue", "Back button should skip sessions that were closed", 2, { labels: ["bug"], assignees: ["sam"] }),
  thread(228, "pr", "Stack: show which container failed its health check", 5, { branch: "feat/stack-health", author: "jonas", review_requested: true }),
  thread(226, "issue", "Handoff test fails about one run in five", 9, { labels: ["flaky"] }),
  thread(219, "issue", "Outline jump lands on the wrong prompt after /compact", 30, { labels: ["bug"] }),
  thread(214, "pr", "Settings search matches hint text", 52, { branch: "feat/settings-search", author: "mira", draft: true }),
  thread(198, "issue", "Linux packaging", 24 * 21, { labels: ["help wanted"] }),
] });
H["list_kept"] = () => [];
H["list_session_history"] = () => ["Fix the flaky handoff test", "Settings search", "Rewrite the README", "Back and forward", "Stack health names the container",
  "Claims become leases", "Pin the merge to the reviewed head", "Outline hunts from the nearer end", "One row per wrangler dev"].map((title, i) => ({
  provider: "claude", session_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, cwd: S.P("episko"), project: "episko", branch: "main",
  title, last_prompt: title, bytes: 200000, exists: true, last_active: now() - i * 15 * 3600, repo_root: S.P("episko") }));
H["list_shared_notes"] = () => [{ id: "n1", text: "Claims expire after 2h idle, so a sleeping laptop never holds an issue.", who: "Mira Kühn", at: iso(30).slice(0, 10) }];
H["has_digest"] = () => false;
H["list_protected_branches"] = () => [];
H["dep_report"] = () => ({ available: true, reason: null, enabled: true,
  alerts: [{ number: 14, state: "open", pkg: "esbuild", ecosystem: "npm", manifest: "pnpm-lock.yaml", scope: "development", relationship: "transitive",
    severity: "medium", ghsa: "GHSA-67mh-4wv8-2f99", cve: null, summary: "esbuild lets any website read the dev server's responses", cvss: 5.3, epss: 0.002,
    range: "<= 0.24.2", patched: "0.25.0", url: "https://github.com/advisories/GHSA-67mh-4wv8-2f99", createdAt: iso(70), updatedAt: iso(70) }],
  prs: ["@xterm/xterm 5.6.0", "vitest 3.3.1", "tauri 2.12.1"].map((t, i) => ({ number: 240 + i, title: `Bump ${t.replace(" ", " to ")}`, url: `https://github.com/acme/episko/pull/${240 + i}`,
    author: "app/dependabot", branch: `dependabot/npm_and_yarn/${t.split(" ")[0]}`, labels: ["dependencies"], draft: false, updatedAt: iso(20 + i * 3),
    mergeable: "MERGEABLE", mergeState: "CLEAN", checks: { total: 6, passed: 6, failed: 0, pending: 0, skipped: 0 }, bot: "dependabot" })) });
if (window.__SHOT === "dashboard") H["worktree_heads"] = ({ dir }) => nameOf(dir) !== "episko"
  ? [{ path: dir, branch: BRANCH[nameOf(dir)] ?? "main", is_main: true, exists: true }]
  : H["list_worktrees"]({ repoDir: dir }).map((w) => ({ path: w.path, branch: w.branch, is_main: w.is_main, exists: true }));

// ---- the sessions, oldest first ----
const E = S.P("episko"), B = S.P("billing-api"), D = S.P("docs-site");

const perm = await launch("episko", E);
title(perm, "Fix the flaky handoff test");
hook(perm, { hook_event_name: "UserPromptSubmit", prompt: "the handoff test fails one run in five, find out why" });
tool(perm, "Read", { file_path: E + "/test/handoff.test.ts" }, { type: "text", file: { filePath: E + "/test/handoff.test.ts", numLines: 380 } });
status(perm, "Opus 5.5", 23, 1.12, 9);
hook(perm, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "pnpm vitest run test/handoff.test.ts --repeat 20" } });
S.emit("permission", { id: "perm-1", data: { session_id: perm, tool_name: "Bash", tool_input: { command: "pnpm vitest run test/handoff.test.ts --repeat 20" } } });

const fan = await launch("episko", E);
title(fan, "Settings search");
hook(fan, { hook_event_name: "UserPromptSubmit", prompt: "prototype the settings search three ways in parallel and compare" });
for (const a of ["a1", "a2", "a3"]) hook(fan, { hook_event_name: "SubagentStart", agent_id: a, agent_type: "general-purpose" });
hook(fan, { hook_event_name: "Stop" });
status(fan, "Opus 5.5", 64, 4.7, 31);

const done = await launch("episko", E);
title(done, "Rewrite the README");
hook(done, { hook_event_name: "UserPromptSubmit", prompt: "rewrite the README around what is unusual about the app" });
hook(done, { hook_event_name: "Stop" });
status(done, "Opus 5.5", 72, 2.9, 18);

const err = await launch("billing-api", B);
title(err, "Move auth to sessions");
hook(err, { hook_event_name: "UserPromptSubmit", prompt: "move auth from JWTs to server sessions" });
status(err, "Opus 5.5", 51, 3.3, 22);
hook(err, { hook_event_name: "StopFailure", error: "server_error", error_details: "529 Overloaded" });

const hooks = await launch("billing-api", B);
title(hooks, "Retry failed webhooks");
hook(hooks, { hook_event_name: "UserPromptSubmit", prompt: "retry failed webhooks with backoff" });
tool(hooks, "Edit", { file_path: B + "/src/webhooks/retry.ts", old_string: "a", new_string: "b" }, { filePath: B + "/src/webhooks/retry.ts" });
status(hooks, "Sonnet 5.5", 38, 0.84, 12);

await launchShell("billing-api", B);

const docs = await launch("docs-site", D);
title(docs, "Proofread the quickstart");
hook(docs, { hook_event_name: "UserPromptSubmit", prompt: "proofread the quickstart and fix anything that no longer matches the CLI" });
status(docs, "Sonnet 5.5", 17, 0.31, 4);

// ---- the pane on stage ----
const main = await launch("episko", E);
setActive(main);
await wait(300);
const s = sessions.get(main);
const cols = s.term?.cols ?? 90;
title(main, "Back and forward");
const P = (t) => hook(main, { hook_event_name: "UserPromptSubmit", prompt: t });
P("add back and forward between screens, like a browser: ⌘[ ⌘] on a Mac and the mouse's own back and forward buttons");
tool(main, "Bash", { command: "pnpm dev", run_in_background: true, description: "Start the dev server" }, { stdout: "", stderr: "", backgroundTaskId: "b7x2k1" });
tool(main, "TodoWrite", { todos: [
  { content: "Record locations in one place (renderAllNow)", status: "completed", activeForm: "Recording locations" },
  { content: "step() skips and drops closed sessions", status: "completed", activeForm: "Skipping closed sessions" },
  { content: "Wire ⌘[ ⌘] and the mouse buttons in main.ts", status: "in_progress", activeForm: "Wiring the keys" },
  { content: "Tests for visit/step/sameLoc", status: "pending", activeForm: "Writing tests" },
] });
tool(main, "Read", { file_path: E + "/src/nav.ts" }, { type: "text", file: { filePath: E + "/src/nav.ts", numLines: 212 } });
tool(main, "Read", { file_path: E + "/src/dom.ts" }, { type: "text", file: { filePath: E + "/src/dom.ts", numLines: 388 } });
tool(main, "Grep", { pattern: "takeStage\\(", path: "src" }, { mode: "files_with_matches", numFiles: 14, filenames: [] });
tool(main, "Edit", { file_path: E + "/src/nav.ts", old_string: "a", new_string: "b" }, { filePath: E + "/src/nav.ts" });
tool(main, "Write", { file_path: E + "/test/nav.test.ts", content: "x" }, { type: "create", filePath: E + "/test/nav.test.ts" });
P("also skip a session that has been closed, don't reopen it");
tool(main, "Edit", { file_path: E + "/src/main.ts", old_string: "a", new_string: "b" });
status(main, "Opus 5.5", 41, 3.84, 26);

// Claude Code's classic renderer, approximated: the conversation, then the spinner.
const R = "\x1b[0m", DIM = "\x1b[2m", BOLD = "\x1b[1m", W = "\x1b[38;2;220;216;230m", G = "\x1b[38;2;78;201;137m";
const ORANGE = "\x1b[38;2;215;119;87m", GREY = "\x1b[38;2;140;134;156m", USER = "\x1b[38;2;170;160;190m";
const ADD = "\x1b[48;2;22;60;38m\x1b[38;2;190;235;205m", DEL = "\x1b[48;2;72;26;32m\x1b[38;2;240;190;195m";
const pad = (str, n) => str + " ".repeat(Math.max(0, n - [...str].length));
const lines = [
  `${USER}> add back and forward between screens, like a browser: ⌘[ ⌘] on a Mac and${R}`,
  `${USER}  the mouse's own back and forward buttons${R}`,
  "",
  `${W}⏺ The stage already has one owner, takeStage, so the history can record in one${R}`,
  `${W}  place. Let me read how a location is described today.${R}`,
  "",
  `${G}⏺${R} ${BOLD}Read${R}(src/nav.ts)`,
  `  ${GREY}⎿  Read 212 lines${R}`,
  "",
  `${G}⏺${R} ${BOLD}Search${R}(pattern: "takeStage\\(", path: "src")`,
  `  ${GREY}⎿  Found 14 files${R}`,
  "",
  `${G}⏺${R} ${BOLD}Update${R}(src/nav.ts)`,
  `  ${GREY}⎿  Updated src/nav.ts with 4 additions and 1 removal${R}`,
  `      ${GREY}38${R}   export function visit(loc: Loc): void {`,
  `      ${GREY}39${R} ${DEL}-   stack.push(loc);\x1b[K${R}`,
  `      ${GREY}39${R} ${ADD}+   if (sameLoc(stack[cursor], loc)) return;\x1b[K${R}`,
  `      ${GREY}40${R} ${ADD}+   stack.splice(cursor + 1);\x1b[K${R}`,
  `      ${GREY}41${R} ${ADD}+   stack.push(loc);\x1b[K${R}`,
  `      ${GREY}42${R} ${ADD}+   cursor = stack.length - 1;\x1b[K${R}`,
  `      ${GREY}43${R}   }`,
  "",
  `${G}⏺${R} ${BOLD}Write${R}(test/nav.test.ts)`,
  `  ${GREY}⎿  Wrote 64 lines to test/nav.test.ts${R}`,
  "",
  `${USER}> also skip a session that has been closed, don't reopen it${R}`,
  "",
  `${W}⏺ Good call. step() will drop a dead entry as it walks past it, so ⌘[ never${R}`,
  `${W}  resurrects a pane you closed.${R}`,
  "",
  `${G}⏺${R} ${BOLD}Update${R}(src/main.ts)`,
  "",
  `${ORANGE}✻ Wiring the keys…${R} ${GREY}(26s · ↓ 1.8k tokens · esc to interrupt)${R}`,
];
await wait(1500); s.fit?.fit();
out(main, lines.join("\r\n") + "\x1b[?25l");
await wait(400);

// ---- what each shot adds on top of the cockpit ----
const shot = window.__SHOT || "cockpit";
if (shot === "permission") {
  setActive(perm);
  await wait(1500);
  const ps = sessions.get(perm); ps.fit?.fit();
  const w = (ps.term?.cols ?? 85) - 2;
  const BOX = "\x1b[38;2;177;150;232m";
  const row = (t = "", c = "") => `${BOX}│${R} ${c}${t}${R}${" ".repeat(Math.max(0, w - 4 - [...t].length))} ${BOX}│${R}`;
  out(perm, [
    `${USER}> the handoff test fails one run in five, find out why${R}`,
    "",
    `${G}⏺${R} ${BOLD}Read${R}(test/handoff.test.ts)`,
    `  ${GREY}⎿  Read 380 lines${R}`,
    "",
    `${W}⏺ Two tests share one fake server and race on its done event. Running the${R}`,
    `${W}  suite twenty times in a row should show the flake.${R}`,
    "",
    `${G}⏺${R} ${BOLD}Bash${R}(pnpm vitest run test/handoff.test.ts --repeat 20)`,
    "",
    `${BOX}╭${"─".repeat(w - 2)}╮${R}`,
    row("Bash command", BOLD),
    row(),
    row("  pnpm vitest run test/handoff.test.ts --repeat 20"),
    row("  Run the handoff suite twenty times to catch the flake", GREY),
    row(),
    row("Do you want to proceed?"),
    row("❯ 1. Yes", BOX),
    row("  2. Yes, and don't ask again for pnpm vitest commands"),
    row("  3. No, and tell Claude what to do differently (esc)"),
    `${BOX}╰${"─".repeat(w - 2)}╯${R}\x1b[?25l`,
  ].join("\r\n"));
} else if (shot === "palette") openPalette();
else if (shot === "run") await openRunPicker();
else if (shot === "newsession") await openWt("episko", E);
else if (shot === "dashboard") openDashboard("episko", E);
else if (shot === "usage") {
  openUsage();
  await wait(1200);
  // The caption is about money and tokens, so start the shot at the daily spend card.
  const head = [...document.querySelectorAll("#usageDlg *")].find((e) => e.childElementCount === 0 && /daily spend/i.test(e.textContent ?? ""));
  head?.closest("section, .card, div")?.scrollIntoView({ block: "start" });
}
await wait(800);
window.__scene = { main, shot, ids: { perm, fan, done, err, hooks, docs, main }, cols: s.term?.cols };
