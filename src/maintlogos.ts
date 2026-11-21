// Each Maintenance source's icon, by manifest source id: source ids stop here, as vendor ids do in
// ./providers/logos. A service's mark is bundled in currentColor and never loaded from the service,
// since fetching one would ask it, which is what its switch decides (docs/maintenance.md). A source
// that names no service (a local read, a protocol) draws what it reads instead.

import { icon, type IconName } from "./svgicons";
import dependabot from "./assets/maint/dependabot.svg?raw";
import endoflife from "./assets/maint/endoflife.svg?raw";
import github from "./assets/maint/github.svg?raw";
import githubactions from "./assets/maint/githubactions.svg?raw";
import gitlab from "./assets/maint/gitlab.svg?raw";
import npm from "./assets/maint/npm.svg?raw";
import osv from "./assets/maint/osv.svg?raw";
import pnpm from "./assets/maint/pnpm.svg?raw";
import renovate from "./assets/maint/renovate.svg?raw";
import rust from "./assets/maint/rust.svg?raw";
import sentry from "./assets/maint/sentry.svg?raw";

const mark = (svg: string) => svg.replace("<svg ", `<svg class="ic solo mark" `);
// The mark of whatever the label names, so "Dependabot alerts" wears Dependabot's and not the forge's it is read from.
const MARKS: Readonly<Record<string, string>> = {
  "github-actions": mark(githubactions), "github-actions-reruns": mark(githubactions),
  "github-code-scanning": mark(github), "github-secret-scanning": mark(github), "github-releases": mark(github),
  "github-deployments": mark(github), "github-work": mark(github),
  "gitlab-ci": mark(gitlab), "gitlab-work": mark(gitlab),
  "dependabot-alerts": mark(dependabot), "dependabot-prs": mark(dependabot), "renovate-prs": mark(renovate),
  osv: mark(osv), "runtime-eol": mark(endoflife),
  "npm-audit": mark(npm), "npm-registry": mark(npm), "pnpm-audit": mark(pnpm),
  "cargo-audit": mark(rust), "crates-registry": mark(rust), "sentry-issues": mark(sentry),
};
const GLYPHS: Readonly<Record<string, IconName>> = {
  "forge-commit-status": "checks", "sarif-files": "fileCode", "git-local": "gitBranch", "git-tags": "tag",
  changelog: "fileText", "deploy-tags": "rocket", "http-probe": "link", "rdap-domain": "globe", "ssh-host": "server",
};

/** A source's icon: its service's mark, else what it reads; "" for an id neither table knows. */
export const sourceLogo = (id: string): string => MARKS[id] ?? (GLYPHS[id] ? icon(GLYPHS[id], "solo") : "");
export const sourceMarkIds = (): string[] => Object.keys(MARKS);
export const sourceGlyphIds = (): string[] => Object.keys(GLYPHS);
