// Static ids from index.html only: a miss is a typo and should throw here.
export const $ = (id: string) => document.getElementById(id)!;

let toastT: number | undefined; // one element: a second toast replaces the first rather than stacking
export function toast(m: string) { const el = $("toast"); el.textContent = m; el.classList.add("show"); clearTimeout(toastT); toastT = window.setTimeout(() => el.classList.remove("show"), 1900); }

// Overlays sharing #scrim; the last one to close clears it. ./confirm has its own
// backdrop and must stay off this list.
const SCRIM_DLGS = ["palette", "wtDlg", "diffDlg", "expDlg", "graphDlg", "setDlg", "histDlg", "callDlg"];
export function dropScrim() {
  if (!SCRIM_DLGS.some((id) => $(id).classList.contains("show"))) $("scrim").classList.remove("show");
}

export type Stage = "session" | "ext" | "dash" | "none"; // ext: the read-only mirror, external or dormant
export let stageGen = 0; // bumped per handover; an #inspector paint cache is valid within one tenancy
// The only code that may touch #extPane/#dashPane/#empty/insp-mini (the stage has one owner).
export function takeStage(show: Stage) {
  stageGen++;
  ($("extPane") as HTMLElement).hidden = show !== "ext";
  ($("dashPane") as HTMLElement).hidden = show !== "dash";
  ($("empty") as HTMLElement).style.display = show === "none" ? "grid" : "none";
  if (show !== "dash") $("app").classList.remove("insp-mini"); // dashboard-only mode
}

// MOD and chord are display only; handlers accept both modifiers.
const UA = typeof navigator === "undefined" ? "" : navigator.userAgent; // vitest's node env has no navigator
export const IS_MAC = UA.includes("Mac");
export const IS_WIN = UA.includes("Windows");
// A dev build also opens in a plain browser tab, where native-window verbs only throw.
export const IS_TAURI = typeof window !== "undefined" && "isTauri" in window; // set before any page script

export const MOD = IS_MAC ? "⌘" : "Ctrl";
export const FILE_MANAGER = IS_WIN ? "Explorer" : IS_MAC ? "Finder" : "file manager";
export const chord = (k: string) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);
