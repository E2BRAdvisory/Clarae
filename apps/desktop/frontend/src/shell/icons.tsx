// Icons: the Material UI "Two tone" set. The path data is generated (iconData.ts, see
// scripts/gen-icons.mjs), so nothing is loaded at runtime: local, offline and CSP-safe.
// The secondary tone is the same colour at 30% opacity, so icons follow the text colour.
import { ICON_DATA } from './iconData';

export type IconName = keyof typeof ICON_DATA;

/** Icons drawn mirrored (the MUI glyph points the other way). */
const FLIPPED = new Set<IconName>(['sidebarLeft']);

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="svg-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      style={FLIPPED.has(name) ? { transform: 'scaleX(-1)' } : undefined}
    >
      {ICON_DATA[name].map(([d, opacity], i) => (
        <path key={i} d={d} opacity={opacity} />
      ))}
    </svg>
  );
}

/** The same icon as a DOM node, for CodeMirror widgets (which are not React). */
export function iconElement(name: IconName, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'svg-icon');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [d, opacity] of ICON_DATA[name]) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    if (opacity !== undefined) p.setAttribute('opacity', String(opacity));
    svg.append(p);
  }
  return svg;
}
