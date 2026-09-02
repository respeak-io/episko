// The per-project glyph: a logo found in the repo, one the user picked, or the accent dot. Discovered
// and hand-picked icons live in separate localStorage keys so a re-probe never overwrites a choice.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "./dom";
import { readObj } from "./store";
import { basename, esc } from "./format";

// Wired by main.ts at startup; until then (and in a test) an icon change paints nothing.
let renderSidebar: () => void = () => {};
export function setIconRenderSidebar(fn: typeof renderSidebar) { renderSidebar = fn; }
let renderMini: () => void = () => {};
export function setIconRenderMini(fn: typeof renderMini) { renderMini = fn; }

// path → data URI; "" means probed and none found, and a present key is never re-probed.
const icons: Record<string, string> = readObj<string>("cc-icons");
function saveIcons() { localStorage.setItem("cc-icons", JSON.stringify(icons)); }
// Bump when discovery improves: cached "no icon" entries are re-probed, found data URIs are kept.
const ICON_CACHE_VERSION = "2";
if (localStorage.getItem("cc-icons-v") !== ICON_CACHE_VERSION) {
  for (const k of Object.keys(icons)) if (!icons[k]) delete icons[k];
  localStorage.setItem("cc-icons-v", ICON_CACHE_VERSION);
  saveIcons();
}
// Consulted before `icons`, so neither a re-probe nor a version bump can overwrite it.
export const customIcons: Record<string, string> = readObj<string>("cc-custom-icons");
function saveCustomIcons() { localStorage.setItem("cc-custom-icons", JSON.stringify(customIcons)); }
export function iconFor(key: string): string | null { const v = customIcons[key] || icons[key]; return v ? v : null; }
export async function probeIcon(key: string) {
  if (key in icons) return;
  icons[key] = ""; // mark in-flight so we don't double-probe
  try {
    const r = await invoke<{ data_uri: string } | null>("find_project_icon", { dir: key });
    icons[key] = r?.data_uri || "";
  } catch { icons[key] = ""; }
  saveIcons();
  renderSidebar(); renderMini();
}
// "Use the color dot instead": drops the hand-picked logo and marks discovery as probed-none.
export function clearIcon(key: string) {
  delete customIcons[key]; saveCustomIcons();
  icons[key] = ""; saveIcons();
  renderSidebar(); renderMini();
}
export async function pickCustomIcon(key: string) {
  const file = await open({
    multiple: false,
    title: `Logo for ${basename(key)}`,
    defaultPath: key,
    filters: [{ name: "Images", extensions: ["png", "svg", "ico", "jpg", "jpeg", "webp", "gif"] }],
  });
  if (!file || typeof file !== "string") return;
  try {
    const r = await invoke<{ data_uri: string }>("read_custom_icon", { path: file });
    customIcons[key] = r.data_uri;
    saveCustomIcons();
    renderSidebar(); renderMini();
    toast(`Logo set for ${basename(key)}`);
  } catch (e) { toast(String(e)); }
}
export function resetCustomIcon(key: string) {
  delete customIcons[key]; saveCustomIcons();
  delete icons[key]; saveIcons();
  probeIcon(key); // re-probes, then renders
  renderSidebar(); renderMini();
}

export function projGlyph(key: string, accent: string): string {
  const ic = iconFor(key);
  return ic
    ? `<img class="picon" src="${ic}" alt="" title="${esc(basename(key))} · right-click for project actions" />`
    : `<span class="pdot" title="Click to recolor · right-click for project actions" style="background:${accent};color:${accent}"></span>`;
}
