// The wikilink under a position of a CodeMirror view and where it is on screen: shared by the
// handle (`linkAt`) and by the hover extension that previews pages.
import type { EditorView } from '@codemirror/view';
import { wikilinkAt } from '../../preview/target';
import type { AnchorRect, LinkSpec } from '../types';

function spanRect(view: EditorView, from: number, to: number): AnchorRect | null {
  const a = view.coordsAtPos(from);
  const b = view.coordsAtPos(to);
  if (!a || !b) return null;
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** The wikilink whose `[[…]]` covers the document position `pos`; `rect` is null when it is not laid out. */
export function wikilinkAtPos(
  view: EditorView,
  pos: number,
): { spec: LinkSpec; rect: AnchorRect | null } | null {
  const line = view.state.doc.lineAt(pos);
  const link = wikilinkAt(line.text, pos - line.from);
  if (!link) return null;
  return { spec: link.spec, rect: spanRect(view, line.from + link.from, line.from + link.to) };
}
