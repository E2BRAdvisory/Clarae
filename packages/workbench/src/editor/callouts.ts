import { StateEffect, StateField, type EditorState } from '@codemirror/state';

// The callout head rules live with the other inline rules in @memobrain/markdown.
export { CALLOUT_RE, parseCalloutHead, type CalloutHead } from '@memobrain/markdown';

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
