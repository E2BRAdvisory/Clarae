// The pointers of the other people in a file, drawn over the document (ADR-0065): an SVG pointer and a label with
// the name, in the colour of the person (getUserColor, the same as the avatar). The layer ignores the mouse
// (`pointer-events: none`), places each pointer with a transform, and shows nothing for a person who has not
// moved, who left, or whose place is not on screen. What a position means on the screen is the business of the
// view's adapter (`place`): a text position of an editor, a point of a scene, a point of a board.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { PresencePos } from '../app/api';
import { getUserColor } from './colors';
import { useCursors, useMembers } from './store';

/** A place in the layer: pixels from its top-left corner. */
export interface LayerPoint {
  x: number;
  y: number;
}

export interface LiveCursorsOverlayProps {
  vaultId: string;
  path: string;
  /** Where a position is in the layer (`origin` is the box of the layer on the screen); null: not shown. */
  place: (pos: PresencePos, origin: DOMRect) => LayerPoint | null;
  /** Called when the places may have changed (scroll, zoom, an edit); returns the stop function. */
  subscribe?: (listener: () => void) => (() => void) | undefined;
  /** The layer covers the window (notes: the editor is placed by screen coordinates) instead of its container. */
  fixed?: boolean;
}

export function LiveCursorsOverlay({
  vaultId,
  path,
  place,
  subscribe,
  fixed,
}: LiveCursorsOverlayProps) {
  const members = useMembers(vaultId, path);
  const cursors = useCursors(vaultId, path);
  const layer = useRef<HTMLDivElement>(null);
  // Where the layer is on the screen: measured once it is in the page, and again whenever a place may have moved.
  const [origin, setOrigin] = useState<DOMRect | null>(null);
  const measure = useCallback(() => setOrigin(layer.current?.getBoundingClientRect() ?? null), []);
  useLayoutEffect(measure, [measure]);
  useEffect(() => subscribe?.(measure), [subscribe, measure]);
  // The layer moves or changes size with its pane (a sidebar dragged, a split resized).
  useEffect(() => {
    const el = layer.current;
    window.addEventListener('resize', measure);
    const size = el && typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (el) size?.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      size?.disconnect();
    };
  }, [measure]);
  return (
    <div
      ref={layer}
      className={`presence-cursors${fixed ? ' fixed' : ''}`}
      aria-hidden="true"
      data-testid="presence-cursors"
    >
      {origin &&
        members.map((m) => {
          const pos = cursors[m.sid];
          const at = pos ? place(pos, origin) : null;
          if (!at) return null;
          const color = getUserColor(m.userId);
          const style = {
            transform: `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`,
            '--presence-bg': color.background,
            '--presence-fg': color.foreground,
          } as CSSProperties;
          return (
            <div
              key={m.sid}
              className="presence-cursor"
              data-testid="presence-cursor"
              data-sid={m.sid}
              data-user={m.userId}
              data-color={color.index}
              style={style}
            >
              <svg
                className="presence-pointer"
                width="16"
                height="20"
                viewBox="0 0 16 20"
                focusable="false"
              >
                <path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.6 11.6 L13 11.6 Z" />
              </svg>
              <span className="presence-cursor-label">{m.name}</span>
            </div>
          );
        })}
    </div>
  );
}
