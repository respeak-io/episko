// Provider-owned visual identity for the agent selectors: vendor ids stop here, callers
// get a trusted SVG fragment. Lobe Icons is pinned; the four local marks are first-party.

import amp from "@lobehub/icons-static-svg/icons/amp-color.svg?raw";
import antigravity from "@lobehub/icons-static-svg/icons/antigravity-color.svg?raw";
import claude from "@lobehub/icons-static-svg/icons/claudecode-color.svg?raw";
import cline from "@lobehub/icons-static-svg/icons/cline.svg?raw";
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg?raw";
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg?raw";
import devin from "@lobehub/icons-static-svg/icons/devin-color.svg?raw";
import gemini from "@lobehub/icons-static-svg/icons/geminicli-color.svg?raw";
import copilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg?raw";
import grok from "@lobehub/icons-static-svg/icons/grok.svg?raw";
import hermes from "@lobehub/icons-static-svg/icons/hermesagent.svg?raw";
import kilo from "@lobehub/icons-static-svg/icons/kilocode.svg?raw";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import kiro from "@lobehub/icons-static-svg/icons/kiro-color.svg?raw";
import mastracode from "@lobehub/icons-static-svg/icons/mastra.svg?raw";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?raw";
import qodercli from "@lobehub/icons-static-svg/icons/qoder-color.svg?raw";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import droid from "../assets/agents/droid.svg?raw";
import maki from "../assets/agents/maki.svg?raw";
import omp from "../assets/agents/omp.svg?raw";
import pi from "../assets/agents/pi.svg?raw";

const LOGOS: Readonly<Record<string, string>> = {
  amp, antigravity, claude, cline, codex, cursor, devin, droid, gemini, copilot,
  grok, hermes, kilo, kimi, kiro, maki, mastracode, omp, opencode, pi,
  qodercli, qwen,
};

// An unmapped id still renders as an agent; provider-contract.test.ts fails if a known one is unmapped.

const FALLBACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/></svg>`;

export const agentLogo = (id: string): string => LOGOS[id] ?? FALLBACK;
export const agentLogoIds = (): string[] => Object.keys(LOGOS);
