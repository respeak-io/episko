// Copies the agent extensions Episko ships from episko-integrations (docs/agent-protocol.md):
// each agents/<id>/episko.ts into src-tauri/integrations/<id>.ts, the Episko half of each
// integration.json into src/providers/integrations.json, the table protocol.rs compiles them
// in with, and the site's agent chips. Reads a commit, never a working tree, and refuses one
// whose CI there has not passed: the vendoring PR this feeds runs no CI of its own.
//   node scripts/vendor-integrations.mjs [checkout] [ref] [--notes <file>]
//   defaults: ../episko-integrations, origin/main. --notes writes the PR body.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "respeak-io/episko-integrations";
const CAPABILITIES = ["session-state", "activity", "context", "usage", "launch-permissions"];
const RESERVED_ENV = ["EPISKO_URL", "EPISKO_TOKEN", "PWD", "PATH"];

const args = process.argv.slice(2);
const notesAt = args.indexOf("--notes");
const notesFile = notesAt >= 0 ? args.splice(notesAt, 2)[1] : null;
const from = resolve(args[0] ?? "../episko-integrations");
const ref = args[1] ?? "origin/main";
const here = (p) => new URL(`../${p}`, import.meta.url);

function fail(msg) {
  console.error(`vendor-integrations: ${msg}`);
  process.exit(1);
}

const git = (...a) => execFileSync("git", ["-C", from, ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
git("fetch", "--quiet", "origin");
const sha = git("rev-parse", `${ref}^{commit}`).trim();

// The run CI made for exactly this commit, on a push to main or on its pull request.
async function ciPassed() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "episko-vendor-integrations" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/runs?head_sha=${sha}&per_page=50`, { headers });
  if (!r.ok) fail(`the Actions API answered ${r.status} ${r.statusText}`);
  const runs = (await r.json()).workflow_runs.filter((w) => w.name === "ci" && ["push", "pull_request"].includes(w.event));
  if (runs.some((w) => w.conclusion === "success")) return;
  const seen = runs.map((w) => `${w.event}: ${w.conclusion ?? w.status}`).join(", ") || "no run";
  fail(`${sha.slice(0, 7)} has no passing CI run in ${REPO} (${seen})`);
}
await ciPassed();

// Episko's catalogue (pty.rs) is what finds the binary, so an integration needs a row there.
const pty = readFileSync(here("src-tauri/src/pty.rs"), "utf8");
const catalogue = new Set([...(/const AGENTS:[\s\S]*?=\s*&\[([\s\S]*?)\n\];/.exec(pty)?.[1] ?? "").matchAll(/\bid:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]));
const firstParty = Object.keys(JSON.parse(readFileSync(here("src/providers/manifest.json"), "utf8")));

const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
// The rules the bundled extension's launch must keep. episko-integrations' schema says more;
// these are the ones Episko would otherwise only learn about from a broken launch.
function checked(id, spec) {
  const bad = (why) => fail(`agents/${id}: ${why}`);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) bad("not a valid id");
  if (!catalogue.has(id)) bad("not in Episko's agent catalogue (AGENTS in src-tauri/src/pty.rs); add it there first");
  if (firstParty.includes(id)) bad("already a first-party provider in manifest.json");
  const { name, homepage, testedWith, capabilities, launch } = spec;
  if (typeof name !== "string" || !name || name.length > 40) bad("name");
  if (typeof homepage !== "string" || !homepage.startsWith("https://")) bad("homepage");
  if (typeof testedWith !== "string" || !/^\d+\.\d+\.\d+$/.test(testedWith)) bad("testedWith");
  if (!strings(capabilities) || !capabilities.includes("session-state") || capabilities.some((c) => !CAPABILITIES.includes(c))) bad("capabilities");
  if (!launch || typeof launch.extension !== "string" || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(ts|js|mjs)$/.test(launch.extension)) bad("launch.extension");
  const argv = launch.args ?? [];
  const env = launch.env ?? {};
  if (!strings(argv) || typeof env !== "object" || !strings(Object.values(env))) bad("launch.args or launch.env");
  if (Object.keys(env).some((k) => !/^[A-Z][A-Z0-9_]*$/.test(k) || RESERVED_ENV.includes(k))) bad("launch.env sets a variable Episko owns");
  if (![...argv, ...Object.values(env)].some((v) => /\{(file|dir)\}/.test(v))) bad("launch never says where the extension is");
  const modes = launch.permissionModes ?? [];
  if (!Array.isArray(modes) || modes.some((m) => !/^[a-z][a-z0-9-]*$/.test(m?.id ?? "") || !strings(m.args) || typeof m.label !== "string")) bad("launch.permissionModes");
  if (capabilities.includes("launch-permissions") !== modes.length > 0) bad("launch-permissions without permissionModes, or the reverse");
  return { name, homepage, testedWith, capabilities, launch };
}

const ids = git("ls-tree", "--name-only", "-d", `${sha}:agents`).split("\n").filter(Boolean).sort();
if (!ids.length) fail(`${sha.slice(0, 7)} has no agents/`);
const agents = {};
const sources = {};
for (const id of ids) {
  agents[id] = checked(id, JSON.parse(git("show", `${sha}:agents/${id}/integration.json`)));
  sources[id] = git("show", `${sha}:agents/${id}/episko.ts`);
}

const manifestPath = here("src/providers/integrations.json");
const before = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { source: "", agents: {} };
const source = `${REPO}@${sha}`;

const dir = here("src-tauri/integrations/");
for (const f of readdirSync(dir)) {
  if (f.endsWith(".ts") && !ids.includes(f.slice(0, -3))) rmSync(new URL(f, dir));
}
for (const id of ids) writeFileSync(new URL(`${id}.ts`, dir), sources[id]);
writeFileSync(manifestPath, `${JSON.stringify({ source, agents }, null, 2)}\n`);
writeFileSync(new URL("bundle.rs", dir), [
  `// Generated by scripts/vendor-integrations.mjs from ${source}. Do not edit.`,
  "const EXTENSIONS: &[(&str, &str)] = &[",
  ...ids.map((id) => `    ("${id}", include_str!("${id}.ts")),`),
  "];",
  "",
].join("\n"));

// The site's two agent chip rows: first-party first, then one dashed chip per integration.
const sitePath = here("site/index.html");
const esc = (t) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const names = ids.map((id) => agents[id].name);
const chipTitle = "Community integration: live status through an extension Episko ships";
let site = readFileSync(sitePath, "utf8");
let rows = 0;
site = site.replace(/((?:<span class="on">[^<]*<\/span>)+)((?:<span class="co"[^>]*>[^<]*<\/span>)*)((?:<span>[^<+]*<\/span>)*)<span>\+(\d+)<\/span>/g,
  (_, on, co, rest, more) => {
    rows++;
    const count = (html) => (html.match(/<span/g) ?? []).length;
    const total = count(on) + count(co) + count(rest) + Number(more);
    const kept = [...rest.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]).filter((n) => !names.includes(n));
    while (kept.length && total - count(on) - names.length - kept.length < 0) kept.pop();
    const plus = total - count(on) - names.length - kept.length;
    return on + names.map((n) => `<span class="co" title="${chipTitle}">${esc(n)}</span>`).join("")
      + kept.map((n) => `<span>${n}</span>`).join("") + `<span>+${plus}</span>`;
  });
if (rows !== 2) fail(`expected the site's two agent chip rows, found ${rows}; fix the pattern in this script`);
const said = names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
let faqs = 0;
site = site.replace(/(context and usage\. )[^."<]*( report status, tools, context and cost through community integrations)/g,
  (_, a, b) => { faqs++; return a + esc(said) + b; });
if (faqs !== 2) fail(`expected the FAQ answer twice (page and JSON-LD), found ${faqs}; fix the pattern in this script`);
writeFileSync(sitePath, site);
const stale = here("src-tauri/integrations/SOURCE");
if (existsSync(stale)) rmSync(stale);

for (const id of ids) console.log(`src-tauri/integrations/${id}.ts <- agents/${id}/episko.ts`);
console.log(`from ${source}`);

if (notesFile) {
  const old = /@([0-9a-f]{40})$/.exec(before.source ?? "")?.[1];
  let log = "";
  if (old && old !== sha) {
    try { log = git("log", "--format=- %h %s", `${old}..${sha}`).trim(); } catch { log = `- (${old.slice(0, 7)} is not an ancestor of ${sha.slice(0, 7)})`; }
  }
  const was = before.agents ?? {};
  const lines = [
    ...ids.filter((id) => !was[id]).map((id) => `- **added** ${agents[id].name} (tested with ${agents[id].testedWith})`),
    ...Object.keys(was).filter((id) => !agents[id]).map((id) => `- **removed** ${was[id].name}`),
    ...ids.filter((id) => was[id] && was[id].testedWith !== agents[id].testedWith).map((id) => `- ${agents[id].name}: tested with ${was[id].testedWith} → ${agents[id].testedWith}`),
  ];
  writeFileSync(notesFile, [
    `Vendors [${REPO}@${sha.slice(0, 7)}](https://github.com/${REPO}/commit/${sha}), whose CI passed.`,
    "",
    ...(lines.length ? [...lines, ""] : []),
    ...(log ? ["Commits since the last vendoring:", "", log, ""] : []),
    "This PR runs no CI of its own: the code was tested in its agents there, and Episko's suites run on `dev` after the merge. Review the diff: it is what ships.",
    "",
  ].join("\n"));
}
