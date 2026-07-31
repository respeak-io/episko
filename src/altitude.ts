// The altitude picker, shared by every surface that can be looked at globally or
// through one project.
//
// It exists so the three of them cannot drift: Threads, the Trail and the Orbit all
// answer "all projects, or this one?" and a user who learns the control once should
// not meet three versions of it. The Board is deliberately absent — it is a file in a
// repo, so "all projects" is not a thing it could mean.
//
// Only projects that actually have something to show are offered. An altitude that
// renders an empty screen is a dead control, and the picker should describe the fleet
// rather than the favourites list.

import { esc } from "./format";
import { accentFor, FAVORITES, sessions } from "./state";

/** colorKey → the name the sidebar shows. */
export function projectLabel(colorKey: string): string {
  const fav = FAVORITES.find((f) => f.path === colorKey);
  if (fav) return fav.name;
  for (const s of sessions.values()) if (s.colorKey === colorKey) return s.project;
  return colorKey.split(/[/\\]/).pop() || colorKey;
}

/**
 * Segmented buttons: "all projects" plus one per key, sorted so a repaint never
 * reorders them. `active` is null at the meta altitude.
 */
export function altitudeSegs(keys: Iterable<string>, active: string | null): string {
  const uniq = [...new Set([...keys].filter(Boolean))].sort();
  return [
    `<button class="th-seg${active === null ? " on" : ""}" data-alt="">⌂ All projects</button>`,
    ...uniq.map((k) =>
      `<button class="th-seg${active === k ? " on" : ""}" data-alt="${esc(k)}">` +
      `<i style="background:${esc(accentFor(k))}"></i>${esc(projectLabel(k))}</button>`),
  ].join("");
}
