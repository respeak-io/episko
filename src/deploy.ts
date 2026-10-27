// `[deploy]`'s rules (docs/maintenance.md): what the agent is asked, which of its values may be
// kept, and how the table reads in a dialog and a settings row. deploy.rs reads and writes it.

/** Where a project runs. `host` is an ssh alias and `sentry` an org/project: nothing here is a secret. */
export interface DeployCfg {
  host: string | null; compose: string[]; urls: Record<string, string>; sentry: string | null; versionUrl: string | null;
}
/** What `propose_deploy` hands back, unchecked, with one reason per value. */
export interface DeployProposal { deploy: DeployCfg; why: string[] }

/** `write_deploy`'s refusal for a file that is not there yet (deploy.rs's `NO_FILE`). */
export const NO_FILE = "no .episko/episko.toml here yet";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strOr = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;

export const isEmptyDeploy = (d: DeployCfg): boolean =>
  !d.host && !d.compose.length && !Object.keys(d.urls).length && !d.sentry && !d.versionUrl;

/** The wire's table, or null for none: a wrong shape drops that value, never the rest. */
export function narrowDeploy(raw: unknown): DeployCfg | null {
  if (!isObj(raw)) return null;
  const urls = isObj(raw.urls) ? Object.fromEntries(Object.entries(raw.urls).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  const d: DeployCfg = {
    host: strOr(raw.host), compose: Array.isArray(raw.compose) ? raw.compose.filter((x): x is string => typeof x === "string") : [],
    urls, sentry: strOr(raw.sentry), versionUrl: strOr(raw.versionUrl),
  };
  return isEmptyDeploy(d) ? null : d;
}

// deploy.rs's `keep`, word for word: an alias or service becomes one argv element, so never a flag.
const isWord = (v: string) => v !== "" && !v.startsWith("-") && !/\s/.test(v);
const isHttp = (u: string) => /^https?:\/\/\S+$/i.test(u);
const PART = "[A-Za-z0-9][A-Za-z0-9._-]*";
const isOrgProject = (s: string) => new RegExp(`^${PART}/${PART}$`).test(s);

/** The values Apply may write, and one line for each it may not. */
export function checkDeploy(p: DeployProposal): { deploy: DeployCfg; dropped: string[] } {
  const d = p.deploy, dropped: string[] = [];
  const keep = (ok: boolean, line: string) => { if (!ok) dropped.push(line); return ok; };
  const t = (v: string | null) => v?.trim() || null;
  const host = t(d.host), sentry = t(d.sentry), versionUrl = t(d.versionUrl);
  return {
    deploy: {
      host: host && keep(isWord(host), `host = "${host}" is not an ssh alias or host name`) ? host : null,
      compose: d.compose.map((c) => c.trim()).filter((c) => keep(isWord(c), `compose service "${c}" is not a name`)),
      urls: Object.fromEntries(Object.entries(d.urls).map(([n, u]) => [n.trim(), u.trim()] as const)
        .filter(([n, u]) => keep(!!n && isHttp(u), `url ${n} = "${u}" is not an http(s) address`))),
      sentry: sentry && keep(isOrgProject(sentry), `sentry = "${sentry}" is not org/project`) ? sentry : null,
      versionUrl: versionUrl && keep(isHttp(versionUrl), `version_url = "${versionUrl}" is not an http(s) address`) ? versionUrl : null,
    },
    dropped,
  };
}

/** One line for the project settings row; empty when there is no table. */
export function deploySummary(d: DeployCfg | null): string {
  if (!d) return "";
  const n = Object.keys(d.urls).length;
  return [
    d.host && `on ${d.host}`, d.compose.length && `compose ${d.compose.join(", ")}`,
    n && `${n} address${n === 1 ? "" : "es"}`, d.sentry && `errors in ${d.sentry}`, d.versionUrl && "a version endpoint",
  ].filter(Boolean).join(" · ");
}

// JSON's string escapes are TOML's basic-string escapes, so a value cannot close its quotes.
const tq = (s: string) => JSON.stringify(s);
const tkey = (k: string) => /^[A-Za-z0-9_-]+$/.test(k) ? k : tq(k);

/** The table as TOML, value for value: the agent keeps only what it is shown. */
export function deployToml(d: DeployCfg): string {
  const urls = Object.entries(d.urls).map(([n, u]) => `${tkey(n)} = ${tq(u)}`).join(", ");
  return ["[deploy]", d.host && `host = ${tq(d.host)}`, d.compose.length && `compose = [${d.compose.map(tq).join(", ")}]`,
    urls && `urls = { ${urls} }`, d.sentry && `sentry = ${tq(d.sentry)}`, d.versionUrl && `version_url = ${tq(d.versionUrl)}`,
  ].filter(Boolean).join("\n");
}

/** One line per current value the proposal removes or changes, so Discard is an informed choice. */
export function deployLosses(current: DeployCfg | null, next: DeployCfg): string[] {
  if (!current) return [];
  const out: string[] = [];
  const one = (k: string, a: string | null, b: string | null) => {
    if (a && a !== b) out.push(b ? `\`${k} = "${a}"\` becomes \`"${b}"\`` : `\`${k} = "${a}"\` is removed`);
  };
  one("host", current.host, next.host);
  for (const c of current.compose) if (!next.compose.includes(c)) out.push(`compose service \`${c}\` is removed`);
  for (const [n, u] of Object.entries(current.urls)) one(`urls.${n}`, u, next.urls[n] ?? null);
  one("sentry", current.sentry, next.sentry);
  one("version_url", current.versionUrl, next.versionUrl);
  return out;
}

/** The headless reader's question, given what the table says now. */
export function deployPrompt(current: DeployCfg | null): string {
  const now = current && !isEmptyDeploy(current) ? deployToml(current) : "";
  return [
    "Read this software project and find out where it runs in production.",
    "Episko, a desktop app, records the answer so it can later check those addresses when a person asks; it connects to nothing on its own.",
    "You can only read files. Look at Dockerfiles, docker-compose files (especially production ones), CI workflows that deploy, deploy scripts, the justfile, Makefile and package.json scripts, hosting config files, reverse proxy config (Caddyfile, nginx), env example files and the README.",
    "",
    "Answer with exactly one fenced ```toml block containing a [deploy] table with:",
    "- host: the ssh alias or host name deploys go to, exactly as the scripts write it (ssh prod-1, DOCKER_HOST=ssh://prod-1). Leave it out for a hosted platform with no machine of its own.",
    "- compose: the Compose service names that run there, as a list.",
    "- urls: an inline table, name = URL, of the public addresses it serves: the app itself, and a health endpoint if it has one.",
    "- sentry: \"org/project\" if the code reports errors to an error tracker configured with an organisation and a project.",
    "- version_url: a URL that answers with the running version, if the code serves one.",
    "Leave a field out when the files do not support it. Never write a token, password, key or any other secret.",
    now ? `The current table is below. Repeat every value in it that is still right, even one the files do not show: a value you leave out is removed.\n\`\`\`toml\n${now}\n\`\`\``
      : "There is none yet.",
    "",
    "After the block write a line containing only WHY, then one line per value starting with \"- host:\", \"- compose:\", \"- urls:\", \"- sentry:\" or \"- version_url:\" saying which file and lines it is based on. Write nothing else.",
  ].join("\n");
}

const why = (p: DeployProposal, key: string) => p.why.find((w) => w.toLowerCase().startsWith(key + ":"))?.slice(key.length + 1).trim();
const said = (p: DeployProposal, key: string) => why(p, key) ? `: ${why(p, key)}` : "";

/** The review dialog's text, in ./format's `dialogBody` dialect: blank lines, bullets, backticks. */
export function deployText(p: DeployProposal, checked: { deploy: DeployCfg; dropped: string[] }, current: DeployCfg | null): string {
  const d = checked.deploy, lines: string[] = [];
  if (d.host) lines.push(`- \`host = "${d.host}"\`${said(p, "host")}`);
  if (d.compose.length) lines.push(`- \`compose = [${d.compose.map((c) => `"${c}"`).join(", ")}]\`${said(p, "compose")}`);
  for (const [n, u] of Object.entries(d.urls)) lines.push(`- ${n}: \`${u}\``);
  if (Object.keys(d.urls).length && why(p, "urls")) lines.push(`  ${why(p, "urls")}`);
  if (d.sentry) lines.push(`- \`sentry = "${d.sentry}"\`${said(p, "sentry")}`);
  if (d.versionUrl) lines.push(`- \`version_url = "${d.versionUrl}"\`${said(p, "version_url")}`);
  const out = [lines.length ? `For \`[deploy]\` in \`.episko/episko.toml\`:\n\n${lines.join("\n")}` : "Claude found nothing it could support for `[deploy]`."];
  const lost = lines.length ? deployLosses(current, d) : [];
  if (lost.length) out.push(`Changes what it says now:\n\n${lost.map((x) => `- ${x}`).join("\n")}`);
  if (checked.dropped.length) out.push(`Left out:\n\n${checked.dropped.map((x) => `- ${x}`).join("\n")}`);
  if (lines.length) out.push("Nothing connects anywhere until you ask for a check. Nothing is committed: review it in git like any other change.");
  return out.join("\n\n");
}
