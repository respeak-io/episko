// The board's pane. ./board owns the rules, this owns the markup and the events —
// the same split as ./trail + ./trailui and ./thread + ./threadsui.
//
// The middle columns are not cards *about* work: a card in flight carries its live
// pane, so it shows the tool running right now, the context used and the spend. That
// is the whole argument for the board living here rather than in a CLI — Episko owns
// the process — and it is also why the link is never committed (RFC rule 3).
//
// Moving a card right is dispatch: a worktree and a session, briefed with the card
// body. Moving it anywhere is one file rewritten, never a whole column.

import { invoke } from "@tauri-apps/api/core";
import { $, toast } from "./dom";
import { dlog } from "./debug";
import { esc } from "./format";
import {
  cardBrief, cardForSession, cardsIn, linkCard, liveSession, needsRenumber, orderFor,
  renumber, unlinkCard, wipFull, type BoardData, type Card,
} from "./board";
import { launch, setActive } from "./panes";
import {
  accentFor, boardProject, boardOpen, FAVORITES, sessions, setActiveId, setMirror,
} from "./state";
import { PILL_TEXT } from "./types";

let data: BoardData = { columns: [], cards: [], exists: false };
let loading = false;
/// The card being dragged, and the column it is over. Pure view state — it never
/// touches disk and is dropped on every repaint.
let dragId: string | null = null;

function projectName(root: string): string {
  const fav = FAVORITES.find((f) => f.path === root);
  if (fav) return fav.name;
  for (const s of sessions.values()) if (s.colorKey === root) return s.project;
  return root.split(/[/\\]/).pop() || root;
}

async function loadBoard(): Promise<void> {
  const root = boardProject();
  if (!root) return;
  loading = true;
  renderBoard();
  try {
    data = await invoke<BoardData>("list_cards", { root });
  } catch (e) {
    dlog("warn", `board: list_cards failed — ${e}`);
    data = { columns: [], cards: [], exists: false };
  } finally {
    loading = false;
  }
  renderBoard();
}

// ---------- markup ----------

function liveCardHtml(c: Card, s: NonNullable<ReturnType<typeof liveSession>>): string {
  const ctx = s.ctxPct ?? 0;
  const meter = ctx > 70 ? "hot" : ctx > 45 ? "warn" : "";
  const tool = s.attention ? `Asks: ${s.attention}` : (s.curTool ? `${s.curTool} ${s.curArg}` : PILL_TEXT[s.phase]);
  return `
    <div class="bc-meta">
      <span class="pill ${s.attention ? "attention" : s.phase}"><span class="pd"></span>${esc(s.attention ? "needs you" : PILL_TEXT[s.phase])}</span>
      ${s.worktree || s.branch ? `<span class="tag acc">⎇ ${esc(s.worktree || s.branch)}</span>` : ""}
    </div>
    <div class="bc-title">${esc(c.title)}</div>
    <div class="bc-now">▸ ${esc(tool)}</div>
    <div class="meter ${meter}"><i style="width:${Math.max(2, ctx)}%"></i></div>
    <div class="bc-foot">
      <span>${ctx}% ctx</span>
      <span>${s.cost != null ? "$" + s.cost.toFixed(2) : "—"}</span>
      <button class="mini-act" data-jump="${esc(c.id)}">Open</button>
    </div>`;
}

function cardHtml(c: Card, canDispatch: boolean): string {
  const s = liveSession(c.id, sessions);
  const tags = [
    ...c.labels.map((l) => `<span class="tag">${esc(l)}</span>`),
    c.assignee ? `<span class="tag">${esc(c.assignee)}</span>` : "",
  ].filter(Boolean).join("");
  const inner = s
    ? liveCardHtml(c, s)
    : `${tags ? `<div class="bc-meta">${tags}</div>` : ""}
       <div class="bc-title">${esc(c.title)}</div>
       ${canDispatch ? `<button class="bc-disp" data-dispatch="${esc(c.id)}">⏎ dispatch</button>` : ""}`;
  return `<div class="bcard${s ? " live" : ""}${s?.attention ? " blocked" : ""}" draggable="true"
    data-card="${esc(c.id)}">${inner}</div>`;
}

export function renderBoard(): void {
  if (!boardOpen()) return;
  const root = boardProject()!;
  // Every known project, not just the one that happened to be active: a board is a
  // file in a repo, so being unable to open one without a live session in that repo
  // made the whole surface unreachable much of the time.
  const keys = new Set<string>(FAVORITES.map((f) => f.path));
  for (const s of sessions.values()) keys.add(s.colorKey);
  keys.add(root);
  ($("boardScope") as HTMLSelectElement).innerHTML = [...keys].filter(Boolean).sort()
    .map((k) => `<option value="${esc(k)}"${k === root ? " selected" : ""}>${esc(projectName(k))}</option>`).join("");

  if (loading) { $("boardCols").innerHTML = `<div class="b-empty">Reading the board…</div>`; return; }
  if (!data.exists) {
    // Creating a committable directory in someone's repo is a real side effect, so it
    // is asked for rather than assumed — the same courtesy tasks.rs extends.
    $("boardCols").innerHTML = `<div class="b-empty">
      <p>No board here yet.</p>
      <p class="b-dim">A board is plain markdown under <code>.episko/board/</code> — one file per card,
      committed with the repo, readable on GitHub by anyone who never installs Episko.</p>
      <button class="act primary" id="boardCreate">Create .episko/board/</button>
    </div>`;
    return;
  }

  // The in-flight columns are the ones a dispatch lands in: the first column whose id
  // looks like work in progress, else the middle one. Derived rather than configured,
  // so a team renaming their columns doesn't have to teach Episko about it.
  const dispatchCol = data.columns.find((c) => /doing|progress|flight|wip/i.test(c.id))?.id
    ?? data.columns[Math.floor(data.columns.length / 2)]?.id;

  $("boardCols").innerHTML = data.columns.map((col) => {
    const cards = cardsIn(data.cards, col.id);
    const full = wipFull(data.cards, col);
    return `<div class="bcol" data-col="${esc(col.id)}">
      <div class="bcol-h">
        <span class="bcol-n">${esc(col.label)}</span>
        <span class="bcol-k${full ? " full" : ""}">${cards.length}${col.wip ? `/${col.wip}` : ""}</span>
      </div>
      <div class="bcol-body" data-drop="${esc(col.id)}">
        ${cards.map((c) => cardHtml(c, col.id !== dispatchCol && !liveSession(c.id, sessions))).join("")
          || `<div class="bcol-empty">—</div>`}
      </div>
      <button class="bcol-add" data-add="${esc(col.id)}">＋</button>
    </div>`;
  }).join("");
}

export function renderBoardHeader(): void {
  ($("btnClose") as HTMLButtonElement).hidden = true;
  const root = boardProject();
  $("hProj").textContent = root ? projectName(root) : "Board";
  const hb = $("hBranch");
  hb.textContent = ".episko/board"; hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = "committed with the repo";
  $("hPath").textContent = "";
}

export function renderBoardInspector(): void {
  const live = data.cards.filter((c) => liveSession(c.id, sessions)).length;
  const pill = $("iPill"); pill.className = "pill idle";
  $("iPillTxt").textContent = `${data.cards.length} cards`;
  $("inspector").innerHTML = `
    <div class="td-stats">
      ${data.columns.slice(0, 4).map((col) =>
        `<div class="td-stat"><span class="label">${esc(col.label)}</span><b>${cardsIn(data.cards, col.id).length}</b></div>`).join("")}
    </div>
    <p class="ihint">One markdown file per card under <code>.episko/board/</code>, committed with
    the repo. ${live} card${live === 1 ? " has" : "s have"} a live pane — that link stays on this
    machine, because a session id means nothing to a teammate.</p>`;
}

// ---------- actions ----------

async function dispatchCard(id: string): Promise<void> {
  const root = boardProject();
  const c = data.cards.find((x) => x.id === id);
  if (!root || !c) return;
  const dispatchCol = data.columns.find((x) => /doing|progress|flight|wip/i.test(x.id))?.id;
  if (dispatchCol) {
    const col = data.columns.find((x) => x.id === dispatchCol)!;
    // A hint, not a rule: the board is a shared file, and a limit one person's client
    // refuses to exceed is not a limit at all. Say it and continue.
    if (wipFull(data.cards, col)) toast(`${col.label} is at its WIP limit — starting anyway`);
    await moveCard(id, dispatchCol, cardsIn(data.cards, dispatchCol).length);
  }
  const sid = await launch(projectName(root), root, { colorKey: root });
  if (typeof sid === "string") {
    linkCard(id, sid);
    // The card body is the brief — the title alone is rarely enough, and the body is
    // where the acceptance criteria live. Typed without a newline: Episko prefills,
    // the human presses Enter.
    const brief = cardBrief(c).replace(/\n/g, " ");
    setTimeout(() => { void invoke("write_pty", { sessionId: sid, data: brief }).catch(() => {}); }, 1400);
    toast("Dispatched — the card body is the brief, press Enter to send");
  }
  await loadBoard();
}

async function moveCard(id: string, status: string, index: number): Promise<void> {
  const root = boardProject();
  if (!root) return;
  const order = orderFor(data.cards, status, index, id);
  try {
    await invoke("move_card", { root, id, status, order });
    // Renumbering rewrites every file in the column, which is the multi-file write the
    // sparse scheme exists to avoid — so it happens only when the gaps have actually
    // closed up, never as routine maintenance.
    const after = data.cards.map((c) => (c.id === id ? { ...c, status, order } : c));
    if (needsRenumber(after, status)) {
      dlog("info", `board: renumbering ${status} — gaps closed up`);
      for (const r of renumber(after, status)) {
        await invoke("move_card", { root, id: r.id, status, order: r.order });
      }
    }
  } catch (e) {
    dlog("warn", `board: move failed — ${e}`);
    toast(`Could not move the card: ${e}`);
  }
  await loadBoard();
}

/// When an agent working a card ends, move the card on and drop the link.
///
/// Green → review, red → the blocked column: the exit code is the verdict, exactly as
/// it is for a task run. This is the cheap half of the RFC's P3 loop, built out of the
/// two things already shipped rather than new machinery.
export async function boardSessionEnded(sessionId: string, code: number): Promise<void> {
  const cardId = cardForSession(sessionId);
  if (!cardId) return;
  unlinkCard(cardId);
  if (!boardProject()) return;
  const target = code === 0
    ? data.columns.find((c) => /review|done/i.test(c.id))?.id
    : data.columns.find((c) => /block|needs|error/i.test(c.id))?.id;
  if (target) await moveCard(cardId, target, cardsIn(data.cards, target).length);
}

// ---------- open / close ----------

export function openBoard(root: string): void {
  setMirror({ kind: "board", project: root });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  ($("empty") as HTMLElement).style.display = "none";
  ($("extPane") as HTMLElement).hidden = true;
  ($("trailPane") as HTMLElement).hidden = true;
  ($("threadsPane") as HTMLElement).hidden = true;
  ($("boardPane") as HTMLElement).hidden = false;
  document.documentElement.style.setProperty("--accent", accentFor(root));
  renderBoardHeader(); renderBoardInspector(); renderBoard();
  void loadBoard();
}

export function closeBoard(): void {
  if (!boardOpen()) return;
  setMirror(null);
  ($("boardPane") as HTMLElement).hidden = true;
}

// ---------- events ----------

export function wireBoard(): void {
  const pane = $("boardPane");

  $("boardScope").addEventListener("change", (e) => {
    openBoard((e.target as HTMLSelectElement).value);
  });

  pane.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.id === "boardCreate") {
      const root = boardProject();
      if (root) void invoke("create_board", { root }).then(() => loadBoard()).catch((err) => toast(String(err)));
      return;
    }
    const disp = t.closest<HTMLElement>("[data-dispatch]");
    if (disp) { void dispatchCard(disp.dataset.dispatch!); return; }
    const jump = t.closest<HTMLElement>("[data-jump]");
    if (jump) {
      const s = liveSession(jump.dataset.jump!, sessions);
      if (s) setActive(s.id);
      return;
    }
    const add = t.closest<HTMLElement>("[data-add]");
    if (add) { void newCard(add.dataset.add!); return; }
  });

  // Drag to move. HTML5 DnD rather than pointer maths: it is what the sidebar's
  // project reordering already uses, and it gives keyboard and accessibility
  // affordances for free.
  pane.addEventListener("dragstart", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-card]");
    if (!card) return;
    dragId = card.dataset.card!;
    card.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", dragId);
  });
  pane.addEventListener("dragend", () => {
    dragId = null;
    pane.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    pane.querySelectorAll(".over").forEach((el) => el.classList.remove("over"));
  });
  pane.addEventListener("dragover", (e) => {
    const body = (e.target as HTMLElement).closest<HTMLElement>("[data-drop]");
    if (!body || !dragId) return;
    e.preventDefault();
    pane.querySelectorAll(".over").forEach((el) => el.classList.remove("over"));
    body.classList.add("over");
  });
  pane.addEventListener("drop", (e) => {
    const body = (e.target as HTMLElement).closest<HTMLElement>("[data-drop]");
    if (!body || !dragId) return;
    e.preventDefault();
    const status = body.dataset.drop!;
    // Index from the drop position, so dropping between two cards lands between them.
    const cards = [...body.querySelectorAll<HTMLElement>("[data-card]")].filter((el) => el.dataset.card !== dragId);
    const y = (e as DragEvent).clientY;
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { index = i; break; }
    }
    const id = dragId;
    dragId = null;
    void moveCard(id, status, index);
  });
}

async function newCard(status: string): Promise<void> {
  const root = boardProject();
  if (!root) return;
  const title = window.prompt("New card");
  if (!title?.trim()) return;
  try {
    await invoke("create_card", { root, title: title.trim(), status, body: "" });
    await loadBoard();
  } catch (e) {
    toast(`Could not create the card: ${e}`);
  }
}
