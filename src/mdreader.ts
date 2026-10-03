// The markdown reader: a `.md` link anywhere in the app opens here rather than in whatever the
// OS maps the extension to. Owns #mdDlg on the ./callsheet pattern; ./markdown owns the rules,
// and nothing in the rendered document navigates the webview (docs/markdown.md).

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { $, dropScrim, toast } from "./dom";
import { basename, esc, escAttr, tilde } from "./format";
import { isMarkdownPath, renderMarkdown, type MdHeading } from "./markdown";
import { mdPrefs, sessions } from "./state";
import { dlog } from "./debug";

interface MdText { path: string; text: string; truncated: boolean }
interface Page { path: string; slug: string; top: number }

// A back stack of documents, so following a link through a docs folder is a walk, not a trap.
let stack: Page[] = [];
let doc: MdText | null = null;
let source = false;
let gen = 0; // a read that lands after a newer one was asked for is dropped
const images = new Map<string, string>();
const IMAGE_CACHE = 48;

export function mdReaderOpen(): boolean { return stack.length > 0; }

/// Every "open this file" in the app comes through here: a markdown file is read in-app
/// unless Settings › Reader says otherwise, and anything else goes to the OS as before.
export async function openFileOrRead(path: string) {
  if (mdPrefs.enabled && isMarkdownPath(path)) { void openMarkdown(path); return; }
  try { await invoke("open_file", { path }); }
  catch (e) { toast(String(e)); }
}

export async function openMarkdown(path: string, slug = "") {
  const cur = stack[stack.length - 1];
  if (cur) cur.top = $("mdScroll").scrollTop;
  if (!cur || cur.path !== path) stack.push({ path, slug, top: 0 });
  else cur.slug = slug;
  source = false;
  $("scrim").classList.add("show");
  $("mdDlg").classList.add("show");
  $("mdScroll").focus({ preventScroll: true }); // arrows and PageDown scroll the page, not type into a pane
  await load();
}

export function closeMdReader() {
  if (!stack.length) return;
  stack = [];
  doc = null;
  gen++;
  $("mdDlg").classList.remove("show");
  dropScrim();
}

async function back() {
  if (stack.length < 2) return;
  stack.pop();
  source = false;
  await load();
}

async function load() {
  const page = stack[stack.length - 1];
  if (!page) return;
  const my = ++gen;
  $("mdTitle").textContent = basename(page.path);
  $("mdSub").textContent = tilde(page.path);
  let got: MdText | null = null;
  let err = "";
  try { got = await invoke<MdText>("read_markdown", { path: page.path }); }
  catch (e) { err = String(e); }
  if (my !== gen) return;
  doc = got;
  if (!got) {
    paintHead();
    $("mdToc").innerHTML = "";
    $("mdDoc").innerHTML = `<div class="mdr-err">Couldn't read this file.<br><span>${esc(err)}</span></div>`;
    return;
  }
  paint(page);
}

/// Repaints what is open, for a Settings change; the scroll position is kept.
export function renderMdReader() {
  const page = stack[stack.length - 1];
  if (!page || !doc) return;
  page.top = $("mdScroll").scrollTop;
  page.slug = "";
  paint(page);
}

// The project that holds the document answers a `/docs/x.md` link, as GitHub does.
function rootOf(path: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  let best = "";
  for (const s of sessions.values()) {
    const w = s.workdir || "";
    if (w && norm(path).startsWith(norm(w).replace(/\/?$/, "/")) && w.length > best.length) best = w;
  }
  return best;
}

function paintHead() {
  const d = $("mdDlg");
  d.dataset.width = mdPrefs.width;
  d.dataset.size = mdPrefs.size;
  d.classList.toggle("no-toc", !mdPrefs.outline || source);
  ($("mdBack") as HTMLButtonElement).disabled = stack.length < 2;
  const tool = (id: string, label: string, tip: string, on = false) =>
    `<button class="mdr-tool${on ? " on" : ""}" type="button" data-mdtool="${id}" title="${escAttr(tip)}">${label}</button>`;
  $("mdTools").innerHTML = (doc ? tool("source", "Source", "Show the file as written", source) : "")
    + tool("reload", "⟳", "Read the file again")
    + tool("copy", "⧉", "Copy the path")
    + tool("reveal", "◫", "Show it in its folder")
    + tool("open", "↗", "Open it in its default app");
}

function paint(page: Page) {
  if (!doc) return;
  paintHead();
  const note = doc.truncated ? `<div class="mdr-note">Only the first 4 MiB of this file is shown.</div>` : "";
  if (source) {
    $("mdToc").innerHTML = "";
    $("mdDoc").innerHTML = note + `<pre class="mdr-src">${esc(doc.text)}</pre>`;
  } else {
    const r = renderMarkdown(doc.text, { docPath: doc.path, root: rootOf(doc.path), images: mdPrefs.images, remote: mdPrefs.remote });
    $("mdToc").innerHTML = tocHtml(r.headings);
    $("mdDoc").innerHTML = note + (r.html.trim() || `<p class="mdr-empty">This file is empty.</p>`);
    void fillImages(gen);
  }
  const sc = $("mdScroll");
  if (page.slug && !source) jump(page.slug);
  else sc.scrollTop = page.top;
  spy();
}

// The rail lights the section being read: the last heading above a line a third of the way down,
// the rule Settings' own rail uses (docs/settings.md). Kept in view, since a changelog's runs to sixty.
let spyQueued = false;
function spy() {
  spyQueued = false;
  const sc = $("mdScroll");
  const line = sc.getBoundingClientRect().top + Math.min(sc.scrollTop, sc.clientHeight / 3);
  let cur = "";
  for (const h of $("mdDoc").querySelectorAll<HTMLElement>("[data-mdh]")) {
    if (h.getBoundingClientRect().top > line + 1) break;
    cur = h.dataset.mdh || "";
  }
  let lit: HTMLElement | null = null;
  for (const b of $("mdToc").querySelectorAll<HTMLElement>(".mdr-toc")) {
    const on = b.dataset.mdanchor === cur;
    b.classList.toggle("on", on);
    if (on) lit = b;
  }
  (lit as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
}
$("mdScroll").addEventListener("scroll", () => {
  if (!spyQueued) { spyQueued = true; requestAnimationFrame(spy); }
}, { passive: true });

function tocHtml(hs: MdHeading[]): string {
  const shown = hs.filter((h) => h.depth <= 3);
  if (shown.length < 2) return "";
  const top = Math.min(...shown.map((h) => h.depth));
  return `<div class="mdr-toch">Contents</div>` + shown.map((h) =>
    `<button class="mdr-toc d${h.depth - top}" type="button" data-mdanchor="${escAttr(h.slug)}" title="${escAttr(h.text)}">${esc(h.text)}</button>`,
  ).join("");
}

// Read in after the paint, each on its own: one missing screenshot must not blank the page.
async function fillImages(my: number) {
  for (const img of $("mdDoc").querySelectorAll<HTMLImageElement>("img[data-mdimg]")) {
    const path = img.dataset.mdimg || "";
    let uri = images.get(path);
    if (!uri) {
      try { uri = await invoke<string>("read_md_image", { path }); }
      catch (e) {
        if (my !== gen) return;
        img.replaceWith(Object.assign(document.createElement("span"), { className: "mdr-miss", textContent: `▤ ${img.alt || basename(path)} · ${e}` }));
        continue;
      }
      if (images.size >= IMAGE_CACHE) images.delete(images.keys().next().value!);
      images.set(path, uri);
    }
    if (my !== gen) return;
    img.src = uri;
  }
}

function jump(slug: string) {
  const want = slug.toLowerCase();
  const hit = [...$("mdDoc").querySelectorAll<HTMLElement>("[data-mdh]")].find((h) => h.dataset.mdh === want);
  if (!hit) { dlog("info", `md: no heading #${want} in ${stack[stack.length - 1]?.path ?? ""}`); return; }
  hit.scrollIntoView({ block: "start" });
  hit.classList.remove("lit");
  void hit.offsetWidth;
  hit.classList.add("lit");
}

async function tool(id: string) {
  const path = doc?.path ?? stack[stack.length - 1]?.path;
  if (!path) return;
  if (id === "source") { source = !source; renderMdReader(); }
  else if (id === "reload") await load();
  else if (id === "copy") writeText(path).then(() => toast("Path copied")).catch(() => toast("copy failed"));
  else if (id === "reveal") invoke("reveal_file", { path }).catch((e) => toast(String(e)));
  else if (id === "open") invoke("open_file", { path }).catch((e) => toast(String(e)));
}

// The reader's own listener, like #fleetPane's: its attributes never reach main.ts's dispatcher.
$("mdDlg").addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-mdurl],[data-mdanchor],[data-mdfile],[data-mdtool]");
  if (!el) return;
  ev.preventDefault();
  const d = el.dataset;
  if (d.mdtool) void tool(d.mdtool);
  else if (d.mdanchor) jump(d.mdanchor);
  else if (d.mdurl) openUrl(d.mdurl).catch((e) => toast("Couldn't open the link: " + e));
  else if (d.mdfile) {
    if (isMarkdownPath(d.mdfile)) void openMarkdown(d.mdfile, d.mdslug || "");
    else invoke("open_file", { path: d.mdfile }).catch((e) => toast(String(e)));
  }
});
$("mdBack").addEventListener("click", () => { void back(); });
$("mdClose").addEventListener("click", closeMdReader);
