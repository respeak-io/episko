// Each public service's mark, by manifest source id: source ids stop here, as vendor ids do in
// ./providers/logos. Bundled and in currentColor, never loaded from the service, since fetching one
// would ask it, which is exactly what the switch drawn beside it decides (docs/maintenance.md).

import { icon } from "./svgicons";
import endoflife from "./assets/maint/endoflife.svg?raw";
import npm from "./assets/maint/npm.svg?raw";
import osv from "./assets/maint/osv.svg?raw";
import rust from "./assets/maint/rust.svg?raw";

const mark = (svg: string) => svg.replace("<svg ", `<svg class="ic solo mark" `);
const LOGOS: Readonly<Record<string, string>> = {
  osv: mark(osv), "runtime-eol": mark(endoflife), "npm-registry": mark(npm), "crates-registry": mark(rust),
};

/** A source's mark; one with none (RDAP is a protocol, not a service) is a globe. */
export const sourceLogo = (id: string): string => LOGOS[id] ?? icon("globe", "solo");
export const sourceLogoIds = (): string[] => Object.keys(LOGOS);
