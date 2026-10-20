// A stand-in for Tauri's IPC so the frontend boots in a plain browser (see readme-shots.mjs): it seeds
// first-run keys, projects and a year of spend, records every invoke, and lets the scene emit events.
(() => {
  const HOME = "/Users/dev";
  const P = (n) => `${HOME}/code/${n}`;
  const PROJECTS = ["episko", "billing-api", "docs-site", "garden-planner"];
  const day = (i) => new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
  // Deterministic, weekday-heavy spend: the heatmap needs a year with texture, not noise.
  const spendOn = (i) => {
    const wd = new Date(Date.now() - i * 864e5).getDay();
    const base = wd === 0 || wd === 6 ? 2.5 : 14;
    return i > 300 ? 0 : Math.round((base + base * 0.9 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.31))) * 100) / 100;
  };
  const SHARE = { episko: 0.46, "billing-api": 0.31, "docs-site": 0.15, "garden-planner": 0.08 };
  const MODELS = { "Opus 5.5": 0.71, "Sonnet 5.5": 0.22, "Haiku 5.5": 0.04, "Fable 5.1": 0.03 };
  const split = (total, shares) => Object.fromEntries(Object.entries(shares).map(([k, f]) => [k, Math.round(total * f * 100) / 100]));
  const usage = {}, detail = {};
  for (let i = 0; i < 365; i++) {
    const v = i === 0 ? 31.21 : spendOn(i);
    if (!v) continue;
    usage[day(i)] = v;
    if (i < 90) detail[day(i)] = { models: split(v, MODELS), projects: split(v, SHARE) };
  }
  const seed = {
    "cc-tour": { v: 1, done: [], queue: [], at: null },
    "cc-seen-versions": ["0.36.0"],
    "cc-favorites": PROJECTS.map((n) => ({ name: n, path: P(n) })),
    "cc-proj-order": PROJECTS.map(P),
    "cc-proj-groups": { groups: [{ id: "g1", name: "Work", collapsed: false }, { id: "g2", name: "Side", collapsed: false }],
      of: { [P("episko")]: "g1", [P("billing-api")]: "g1", [P("docs-site")]: "g1", [P("garden-planner")]: "g2" } },
    "cc-sort": "manual",
    "cc-foot": { hidden: ["engine", "io", "debug"] },
    "cc-trusted": [P("episko")],
    "cc-usage": usage,
    "cc-usage-detail": detail,
  };
  // The dashboard has no selected pane, so the footer's limits would read as dashes there.
  if (window.__SHOT === "dashboard") Object.assign(seed, {
    "cc-foot": { hidden: ["engine", "io", "debug", "limits"] },
    "cc-digest-no": [P("episko")],
    "cc-dash-seen": { [P("episko")]: Date.now() - 6 * 864e5 },
  });
  try { for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); } catch {}

  const cbs = new Map(); let nextCb = 1;
  const listeners = [];
  const calls = [];
  const handlers = {};
  window.__stub = {
    cbs, listeners, calls, handlers, HOME, P, day, spendOn,
    emit(event, payload) {
      let n = 0;
      for (const l of listeners) if (l.event === event) { const cb = cbs.get(l.handler); if (cb) { cb({ event, id: 0, payload }); n++; } }
      return n;
    },
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    plugins: {},
    transformCallback(cb) { const id = nextCb++; cbs.set(id, cb); return id; },
    unregisterCallback(id) { cbs.delete(id); },
    convertFileSrc(p) { return p; },
    invoke(cmd, args) {
      calls.push([cmd, args]);
      if (cmd === "plugin:event|listen") { listeners.push({ event: args.event, handler: args.handler }); return Promise.resolve(listeners.length); }
      if (cmd === "plugin:event|unlisten" || cmd === "plugin:event|emit") return Promise.resolve();
      const h = handlers[cmd];
      if (h) { try { return Promise.resolve(h(args)); } catch (e) { return Promise.reject(String(e)); } }
      return Promise.reject(`stub: ${cmd}`);
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  handlers["plugin:app|version"] = () => "0.36.0";
  handlers["home_dir"] = () => HOME;
  handlers["plugin:path|resolve_directory"] = () => HOME;
  // Tokens by day and model, in proportion to the seeded spend, for Usage & spend's charts.
  handlers["token_usage_by_day"] = () => {
    const out = [];
    for (let i = 0; i < 300; i++) {
      const v = i === 0 ? 31.21 : spendOn(i);
      if (!v) continue;
      const t = Math.round(v * 2.6e6);
      out.push({ day: day(i), input: Math.round(t * 0.02), output: Math.round(t * 0.05), cache_read: Math.round(t * 0.83), cache_write: Math.round(t * 0.1),
        models: { "claude-opus-5-5": Math.round(t * 0.7), "claude-sonnet-5-5": Math.round(t * 0.24), "claude-haiku-5-5": Math.round(t * 0.04), "claude-fable-5-1": Math.round(t * 0.02) },
        sessions: 3 + (i % 7), projects: { episko: Math.round(t * 0.46), "billing-api": Math.round(t * 0.31), "docs-site": Math.round(t * 0.15), "garden-planner": Math.round(t * 0.08) } });
    }
    return out;
  };
})();
