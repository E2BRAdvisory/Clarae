// The solid a kind of document has in the instanced level of the 3D graph, flat, for the legend.
// A plain geometric mark (presentation attributes only, no style), drawn in the colour of the text.
import type { Shape } from './lod';

export function ShapeGlyph({ shape, size = 14 }: { shape: Shape; size?: number }) {
  return (
    <svg
      className="svg-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-shape={shape}
    >
      {mark(shape)}
    </svg>
  );
}

function mark(shape: Shape) {
  switch (shape) {
    case 'cube':
      return <rect x="5" y="5" width="14" height="14" rx="1.5" />;
    case 'octahedron':
      return <polygon points="12,2.5 21.5,12 12,21.5 2.5,12" />;
    case 'cylinder':
      return <rect x="6" y="3.5" width="12" height="17" rx="3.5" />;
    case 'cone':
      return <polygon points="12,3 21.5,20.5 2.5,20.5" />;
    case 'torus':
      return <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="3.5" />;
    case 'icosahedron':
      return <polygon points="12,2.5 20.2,7.2 20.2,16.8 12,21.5 3.8,16.8 3.8,7.2" />;
    default:
      return <circle cx="12" cy="12" r="9" />;
  }
}
