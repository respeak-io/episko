// Line icons for controls whose glyph alone would not say what they do. Inline SVG on a 24-unit
// grid, stroked in `currentColor`, so an icon takes its button's colour and state. A leaf: data
// in, markup out, imports nothing. Text glyphs (⟳, ↗, ✓) stay where they already read clearly.

const P = {
  tree: '<path d="M5 3v14a2 2 0 0 0 2 2h4"/><path d="M5 8h6"/><rect x="13" y="5" width="8" height="6" rx="1.5"/><rect x="13" y="15" width="8" height="6" rx="1.5"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  comment: '<path d="M21 14a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  box: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/>',
  boxCheck: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8 12.5 3 3 5-6.5"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1L20.5 8.5"/><path d="M20.5 3.5v5h-5"/>',
  external: '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  squash: '<path d="m7 3 5 5 5-5"/><path d="m7 21 5-5 5 5"/><path d="M4 12h16"/>',
  rebase: '<circle cx="6" cy="18" r="2.5"/><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 8.5v7"/><path d="M18 8.5a9 9 0 0 1-9.5 9"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m6 6 1 14h10l1-14"/><path d="M10 11v5M14 11v5"/>',
  draft: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3.2 3"/>',
  ready: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.5 3 3 5-6.5"/>',
  reopen: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
  agent: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V5"/><circle cx="12" cy="3.5" r="1.2"/><path d="M9 13v2M15 13v2"/>',
  reply: '<path d="M9 16 4 11l5-5"/><path d="M20 19v-3a5 5 0 0 0-5-5H4"/>',
  suggest: '<path d="M12 4v8M8 8h8"/><path d="M8 18h8"/>',
  pencil: '<path d="M13 21h8"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  unfold: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  fold: '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  pilcrow: '<path d="M13 4v16M17 4v16"/><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  unified: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  files: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M9 15h6M12 12v6"/>',
  since: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  checks: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.5 3 3 5-6.5"/>',
  changes: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  send: '<path d="m21.5 2.5-6.5 19-4-8.5-8.5-4z"/><path d="M21.5 2.5 11 13"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
} as const;

export type IconName = keyof typeof P;

/** One icon. `cls` adds to `ic`; `solo` drops the gap a label after it would want. */
export function icon(name: IconName, cls = ""): string {
  return `<svg class="ic${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>`;
}
