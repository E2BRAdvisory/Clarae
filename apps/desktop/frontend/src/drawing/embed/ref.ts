// Embedding a part of a drawing: `![[Board.excalidraw#frame=Intro]]`, `#clippedframe=Intro`,
// `#group=<id>`, `#area=<element id>`. The fragment may also be written as a block reference
// (`#^frame=Intro`), the form the Obsidian Excalidraw plugin uses.

export type DrawingRefKind = 'frame' | 'clippedframe' | 'group' | 'area';

export interface DrawingRef {
  kind: DrawingRefKind;
  value: string;
}

const KINDS: readonly string[] = ['frame', 'clippedframe', 'group', 'area'];

/** The part a link fragment selects, or null for a plain embed (or an unrelated heading). */
export function parseDrawingRef(heading: string, block: string): DrawingRef | null {
  for (const frag of [heading, block]) {
    const eq = frag.indexOf('=');
    if (eq <= 0) continue;
    const kind = frag.slice(0, eq).trim().toLowerCase();
    const value = frag.slice(eq + 1).trim();
    if (KINDS.includes(kind) && value) return { kind: kind as DrawingRefKind, value };
  }
  return null;
}

/** Stable text for cache keys. */
export function refKey(ref: DrawingRef | null): string {
  return ref ? `${ref.kind}=${ref.value}` : '';
}

interface RefEl {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string | null;
  frameId?: string | null;
  groupIds?: readonly string[];
  isDeleted?: boolean;
}

const isFrame = (e: RefEl): boolean => e.type === 'frame' || e.type === 'magicframe';

function box(e: RefEl): { l: number; t: number; r: number; b: number } {
  return {
    l: Math.min(e.x, e.x + e.width),
    t: Math.min(e.y, e.y + e.height),
    r: Math.max(e.x, e.x + e.width),
    b: Math.max(e.y, e.y + e.height),
  };
}

/**
 * The elements a part covers and the frame to clip to (`clippedframe` only). null when the part
 * does not exist in the drawing, so the embed can say so instead of showing something else.
 */
export function refElements<T extends RefEl>(
  elements: readonly T[],
  ref: DrawingRef,
): { elements: T[]; frame: T | null } | null {
  const live = elements.filter((e) => !e.isDeleted);
  switch (ref.kind) {
    case 'frame':
    case 'clippedframe': {
      const want = ref.value.toLowerCase();
      const frame =
        live.find((e) => isFrame(e) && e.id === ref.value) ??
        live.find((e) => isFrame(e) && (e.name ?? '').trim().toLowerCase() === want);
      if (!frame) return null;
      return {
        elements: [frame, ...live.filter((e) => e.frameId === frame.id)],
        frame: ref.kind === 'clippedframe' ? frame : null,
      };
    }
    case 'group': {
      const members = live.filter((e) => e.groupIds?.includes(ref.value));
      return members.length > 0 ? { elements: members, frame: null } : null;
    }
    case 'area': {
      const target = live.find((e) => e.id === ref.value);
      if (!target) return null;
      const a = box(target);
      const inside = live.filter((e) => {
        const b = box(e);
        return b.l < a.r && b.r > a.l && b.t < a.b && b.b > a.t;
      });
      return { elements: inside, frame: null };
    }
  }
}
