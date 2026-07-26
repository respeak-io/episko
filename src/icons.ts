// The per-project glyph: a favicon/logo scoured out of the repo by the backend, or
// one the user picked by hand, with the accent dot as the fallback. Two localStorage
// keys (discovered vs. hand-picked, deliberately separate — see below) and the one
// function that turns them into markup.
//
// It sits below the sidebar rather than inside it because three surfaces read the
// same store: the sidebar rows and the mini-rail paint it, the palette shows it
// beside a session, and the colour popover offers set/clear/reset. The four actions
// that *change* an icon repaint the two surfaces that show it, and reach them
// through hooks (PLAN.md's seam rule 2) rather than importing the renderer.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "./dom";
import { basename, esc } from "./format";

// Changing an icon changes two surfaces, both repainted from scratch. main.ts wires
// them at startup; until then (and in a test) an icon change paints nothing.
let renderSidebar: () => void = () => {};
export function setIconRenderSidebar(fn: typeof renderSidebar) { renderSidebar = fn; }
let renderMini: () => void = () => {};
export function setIconRenderMini(fn: typeof renderMini) { renderMini = fn; }

// Per-project icon (a favicon/logo scoured from the repo), keyed by project path.
// Value: data-URI = found, "" = probed & none (or user cleared). Presence of the
// key means "already probed" so we don't hit the backend twice.
const icons: Record<string, string> = JSON.parse(localStorage.getItem("cc-icons") || "{}");
function saveIcons() { localStorage.setItem("cc-icons", JSON.stringify(icons)); }
// find_project_icon's discovery has improved (it now reaches monorepo subdirs like
// `01_frontend/public/`). When it does, forget projects we'd cached as "no icon"
// (empty string) so they re-probe. Found data-URIs are kept as-is; a user who hid
// an icon will see it re-probed once (acceptable for this spike).
const ICON_CACHE_VERSION = "2";
if (localStorage.getItem("cc-icons-v") !== ICON_CACHE_VERSION) {
  for (const k of Object.keys(icons)) if (!icons[k]) delete icons[k];
  localStorage.setItem("cc-icons-v", ICON_CACHE_VERSION);
  saveIcons();
}
// A logo the user picked by hand. Kept in its own key — and consulted first — so
// that neither a re-probe nor an ICON_CACHE_VERSION bump can overwrite a
// deliberate choice with whatever discovery happens to find.
export const customIcons: Record<string, string> = JSON.parse(localStorage.getItem("cc-custom-icons") || "{}");
function saveCustomIcons() { localStorage.setItem("cc-custom-icons", JSON.stringify(customIcons)); }
export function iconFor(key: string): string | null { const v = customIcons[key] || icons[key]; return v ? v : null; }
export async function probeIcon(key: string) {
  if (key in icons) return; // already probed
  icons[key] = ""; // mark in-flight so we don't double-probe
  try {
    const r = await invoke<{ data_uri: string } | null>("find_project_icon", { dir: key });
    icons[key] = r?.data_uri || "";
  } catch { icons[key] = ""; }
  saveIcons();
  renderSidebar(); renderMini();
}
// "Use the color dot instead" — drops the hand-picked logo *and* marks discovery
// as "probed, none", so the row falls back to its accent dot and stays there.
export function clearIcon(key: string) {
  delete customIcons[key]; saveCustomIcons();
  icons[key] = ""; saveIcons();
  renderSidebar(); renderMini();
}
// Pick an image file to use as this project's glyph, in place of whatever the
// backend scoured out of the repo (or the color dot, when it found nothing).
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
// Forget the hand-picked logo and let discovery have another go at the repo.
export function resetCustomIcon(key: string) {
  delete customIcons[key]; saveCustomIcons();
  delete icons[key]; saveIcons();
  probeIcon(key); // re-probes, then renders
  renderSidebar(); renderMini();
}

export function projGlyph(key: string, accent: string): string {
  const ic = iconFor(key);
  return ic
    ? `<img class="picon" src="${ic}" alt="" title="${esc(basename(key))} — right-click for project actions" />`
    : `<span class="pdot" title="Click to recolor · right-click for project actions" style="background:${accent};color:${accent}"></span>`;
}

