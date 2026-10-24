import { StateEffect, StateField, type EditorState } from '@codemirror/state';

/** Parses a callout title line (after the quote marker): [!type]± title */
export const CALLOUT_RE = /^(\s*>+\s*)\[!([A-Za-z0-9_-]+)\]([+-]?)[ \t]*(.*)$/;

export interface CalloutHead {
  /** Characters before "[!" (the quote marker and spaces). */
  prefixLength: number;
  type: string;
  /** "+" (open by default), "-" (folded by default) or "" (not foldable). */
  marker: string;
  title: string;
}

export function parseCalloutHead(line: string): CalloutHead | null {
  const m = CALLOUT_RE.exec(line);
  if (!m) return null;
  return {
    prefixLength: (m[1] ?? '').length,
    type: (m[2] ?? '').toLowerCase(),
    marker: m[3] ?? '',
    title: (m[4] ?? '').trim(),
  };
}

/** Title-line positions whose fold state the user flipped from the default. */
export const toggleCallout = StateEffect.define<number>({
  map: (pos, changes) => changes.mapPos(pos, -1),
});

export const calloutToggles = StateField.define<ReadonlySet<number>>({
  create: () => new Set(),
  update(set, tr) {
    let next: Set<number> | null = null;
    if (tr.docChanged) {
      next = new Set();
      for (const p of set) next.add(tr.changes.mapPos(p, -1));
    }
    for (const e of tr.effects) {
      if (e.is(toggleCallout)) {
        next ??= new Set(set);
        if (next.has(e.value)) next.delete(e.value);
        else next.add(e.value);
      }
    }
    return next ?? set;
  },
});

/** Whether the callout whose title line starts at titlePos is currently folded. */
export function isCalloutFolded(state: EditorState, titlePos: number, marker: string): boolean {
  if (marker === '') return false;
  const toggled = state.field(calloutToggles, false)?.has(titlePos) ?? false;
  return (marker === '-') !== toggled;
}
