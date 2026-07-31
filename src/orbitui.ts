// The Orbit's canvas. ./orbit owns the arithmetic, this owns the drawing and the
// pointer — the same split as every other surface here.
//
// This is the ambient one: what you leave open on a second monitor, not what you work.
// A manager's real failure mode is not missing a list, it is not looking at the list
// for forty minutes while an agent sits blocked — and motion in the corner of your eye
// is the cheapest possible alert. It costs no notification, no badge and no sound.
//
// Canvas rather than SVG or DOM: this repaints every frame with tens of moving dots,
// and neither of the other two survives that without a lot of care.

import { $ } from "./dom";
import { esc } from "./format";
import { accentFor, orbitOpen, sessions, setActiveId, setMirror, dirtyByFolder, FAVORITES } from "./state";
import { noteList } from "./notes";
import { buildThreads, threadStatusKey, type Thread } from "./thread";
import { collapseUnclaimed, layout, type Dot } from "./orbit";
import { setActive } from "./panes";

const COLOUR: Record<string, string> = {
  attention: "#fb6f92", error: "#f26d6d", done: "#37c98b",
  working: "#e0a44a", thinking: "#e0a44a", idle: "#7b8496",
  ended: "#6b6478", unclaimed: "#7b8496",
};

let raf = 0;
let dots: Dot[] = [];
let collapsed = new Map<string, number>();
let flare = 0;
/// Which threads were urgent last frame, so a NEW one can flare the core. Without
/// this the centre would pulse forever while anything is blocked, which trains you to
/// ignore it — the flare has to mean "this just happened".
let urgentSeen = new Set<string>();
let hover: Dot | null = null;

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function projectName(colorKey: string): string {
  const fav = FAVORITES.find((f) => f.path === colorKey);
  if (fav) return fav.name;
  for (const s of sessions.values()) if (s.colorKey === colorKey) return s.project;
  return colorKey.split(/[/\\]/).pop() || colorKey;
}

function currentThreads(): Thread[] {
  return buildThreads({
    sessions: sessions.values(),
    notes: noteList(),
    dirty: dirtyByFolder,
    projectName,
  });
}

function recompute(): void {
  const all = currentThreads();
  const c = collapseUnclaimed(all);
  collapsed = c.collapsed;
  dots = layout(c.shown);

  const nowUrgent = new Set(dots.filter((d) => d.urgent).map((d) => d.thread.id));
  for (const id of nowUrgent) if (!urgentSeen.has(id)) flare = 1;
  urgentSeen = nowUrgent;

  const n = nowUrgent.size;
  $("orbitFoot").innerHTML = n
    ? `<span style="color:var(--st-attention)">${n} thread${n === 1 ? "" : "s"} pulling at you</span>`
    : "nothing needs you";
}

function draw(): void {
  const cv = $("orbitCanvas") as HTMLCanvasElement;
  const wrap = $("orbitWrap");
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const r = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(240, r.width), H = Math.max(200, r.height);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  const maxR = Math.min(W, H) * 0.42;
  const t = performance.now();

  // Pressure rings — a faint scale, drawn first so everything sits above them.
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.45, 0.65, 0.85, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, maxR * frac, 0, Math.PI * 2);
    ctx.strokeStyle = frac === 0.25 ? "rgba(255,255,255,.075)" : "rgba(255,255,255,.035)";
    ctx.stroke();
  }

  // Project arcs, just beyond the rim, plus any collapsed inventory count.
  const arcs = new Map<string, { from: number; to: number }>();
  for (const d of dots) {
    const a = arcs.get(d.colorKey) ?? { from: Infinity, to: -Infinity };
    arcs.set(d.colorKey, { from: Math.min(a.from, d.angle), to: Math.max(a.to, d.angle) });
  }
  for (const [key] of new Map([...arcs, ...[...collapsed.keys()].map((k) => [k, { from: 0, to: 0 }] as const)])) {
    const a = arcs.get(key);
    const mid = a && Number.isFinite(a.from) ? (a.from + a.to) / 2 : -Math.PI / 2;
    ctx.fillStyle = accentFor(key) + "cc";
    ctx.font = '600 9px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const n = collapsed.get(key);
    const label = n ? `${projectName(key)} · +${n}` : projectName(key);
    ctx.fillText(label, cx + Math.cos(mid) * maxR * 1.13, cy + Math.sin(mid) * maxR * 1.13);
  }

  // The core — you.
  const pulse = 1 + flare * 0.5;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 34 * pulse);
  g.addColorStop(0, `rgba(167,139,250,${0.34 + flare * 0.4})`);
  g.addColorStop(1, "rgba(167,139,250,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, 34 * pulse, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = "#cbb6ff"; ctx.fill();
  if (flare > 0) flare = Math.max(0, flare - 1 / 60);

  for (const d of dots) {
    const key = threadStatusKey(d.thread);
    const col = COLOUR[key] ?? "#7b8496";
    const x = cx + Math.cos(d.angle) * maxR * d.radius;
    const y = cy + Math.sin(d.angle) * maxR * d.radius;
    (d as Dot & { _x: number; _y: number })._x = x;
    (d as Dot & { _x: number; _y: number })._y = y;

    if (d.urgent) {
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y);
      ctx.strokeStyle = col + (key === "attention" ? "66" : "33");
      ctx.lineWidth = 1; ctx.stroke();
      const halo = d.size + 5 + (reduced() ? 0 : Math.sin(t / 260) * 2.4);
      ctx.beginPath(); ctx.arc(x, y, halo, 0, Math.PI * 2);
      ctx.strokeStyle = col + "55"; ctx.lineWidth = 1.4; ctx.stroke();
    }

    const unclaimedDot = key === "unclaimed" || key === "idle" || key === "ended";
    ctx.beginPath();
    ctx.arc(x, y, d.size * (unclaimedDot ? 0.8 : 1), 0, Math.PI * 2);
    ctx.fillStyle = col + (unclaimedDot ? "5c" : "ee");
    ctx.fill();

    // The one thing pulling hardest names itself. The inward fall has to be legible
    // without a hover, or this view is decoration.
    if (key === "attention") {
      const right = x >= cx;
      const lx = x + (right ? d.size + 10 : -(d.size + 10));
      ctx.textAlign = right ? "left" : "right";
      ctx.textBaseline = "middle";
      ctx.font = '700 10.5px ui-monospace, "SF Mono", Menlo, monospace';
      const w1 = ctx.measureText(d.thread.title).width;
      ctx.font = '400 9.5px ui-monospace, "SF Mono", Menlo, monospace';
      const bw = Math.max(w1, ctx.measureText(d.thread.state).width) + 14;
      // A backdrop, because the label sits over whatever else is orbiting there.
      ctx.fillStyle = "rgba(12,10,18,.82)";
      ctx.beginPath();
      const bx = right ? lx - 7 : lx - bw + 7;
      if (ctx.roundRect) ctx.roundRect(bx, y - 17, bw, 34, 7); else ctx.rect(bx, y - 17, bw, 34);
      ctx.fill();
      ctx.font = '700 10.5px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.fillStyle = col;
      ctx.fillText(d.thread.title, lx, y - 6);
      ctx.font = '400 9.5px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.fillText(d.thread.state, lx, y + 6);
    }
  }
}

function frame(): void {
  if (!orbitOpen()) { raf = 0; return; }
  draw();
  // Reduced motion: positions still encode everything, so it is drawn once per state
  // change rather than animated. The loop simply stops.
  raf = reduced() ? 0 : requestAnimationFrame(frame);
}

/** Repaint from live state. Called by renderAll, so the orbit tracks the fleet. */
export function renderOrbit(): void {
  if (!orbitOpen()) return;
  recompute();
  if (!raf) { raf = reduced() ? 0 : requestAnimationFrame(frame); }
  if (reduced()) draw();
}

export function renderOrbitHeader(): void {
  ($("btnClose") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = "Orbit";
  const hb = $("hBranch");
  hb.textContent = "all projects"; hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = "radius = pressure · angle = project · size = spend";
  $("hPath").textContent = "";
}

export function renderOrbitInspector(): void {
  const urgent = dots.filter((d) => d.urgent).length;
  const pill = $("iPill");
  pill.className = `pill ${urgent ? "attention" : "idle"}`;
  $("iPillTxt").textContent = urgent ? `${urgent} pulling` : "all clear";
  const hidden = [...collapsed.values()].reduce((a, b) => a + b, 0);
  $("inspector").innerHTML = `
    <div class="td-stats">
      <div class="td-stat"><span class="label">Orbiting</span><b>${dots.length}</b></div>
      <div class="td-stat"><span class="label">Pulling</span><b>${urgent}</b></div>
    </div>
    <p class="ihint">Radius is <b>pressure</b>: a state sets the floor, waiting raises it — so a
    finished turn nobody answered creeps inward all afternoon and the picture keeps changing
    while nothing changes.${hidden ? ` ${hidden} unclaimed threads are collapsed into their project arcs.` : ""}</p>
    <p class="ihint">A companion to the Threads board, not a replacement — you cannot read titles
    off a radial plot. Click any dot to open its row.</p>`;
}

export function openOrbit(): void {
  setMirror({ kind: "orbit" });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  ($("empty") as HTMLElement).style.display = "none";
  for (const id of ["extPane", "trailPane", "threadsPane", "boardPane"]) ($(id) as HTMLElement).hidden = true;
  ($("orbitPane") as HTMLElement).hidden = false;
  // No single project owns the fleet, so the app's own accent stands.
  document.documentElement.style.removeProperty("--accent");
  renderOrbitHeader(); recompute(); renderOrbitInspector();
  if (!raf) raf = reduced() ? 0 : requestAnimationFrame(frame);
  if (reduced()) draw();
}

export function closeOrbit(): void {
  if (!orbitOpen()) return;
  setMirror(null);
  cancelAnimationFrame(raf); raf = 0;
  ($("orbitPane") as HTMLElement).hidden = true;
}

export function wireOrbit(): void {
  const wrap = $("orbitWrap");
  const tip = $("orbitTip");

  wrap.addEventListener("mousemove", (e) => {
    const r = wrap.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best: Dot | null = null, bd = 16;
    for (const d of dots) {
      const p = d as Dot & { _x?: number; _y?: number };
      if (p._x == null || p._y == null) continue;
      const dist = Math.hypot(p._x - mx, p._y - my);
      if (dist < bd + d.size) { bd = dist; best = d; }
    }
    hover = best;
    if (!best) { tip.classList.remove("show"); wrap.style.cursor = "default"; return; }
    const p = best as Dot & { _x: number; _y: number };
    tip.innerHTML = `${esc(best.thread.title)}<span class="tp">${esc(best.thread.state)}</span>`;
    tip.classList.add("show");
    wrap.style.cursor = "pointer";
    const tw = tip.offsetWidth || 150;
    tip.style.left = `${Math.min(Math.max(6, p._x - tw / 2), r.width - tw - 6)}px`;
    tip.style.top = `${p._y + best.size + 9}px`;
  });
  wrap.addEventListener("mouseleave", () => { hover = null; tip.classList.remove("show"); });

  // Every dot is a click into the row it represents — the view is ambient, and acting
  // on something means leaving it.
  wrap.addEventListener("click", () => {
    if (hover?.thread.sess) setActive(hover.thread.sess.id);
  });

  if (window.ResizeObserver) new ResizeObserver(() => { if (orbitOpen()) draw(); }).observe(wrap);
}
