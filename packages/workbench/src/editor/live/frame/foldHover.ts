// The chevron of an open block (A-W5c): one button that follows the pointer to the first line of the
// block that can fold, and folds it. The blocks that are folded have their own chevron (fold.ts), which
// is a decoration; an open block has none, so that a note of thousands of blocks has no decoration per
// block. The keyboard folds through the keys of the editor, the button is for the pointer.
import type { EditorView } from '@milkdown/kit/prose/view';
import { i18next } from '../../../i18n';
import { iconElement } from '../../../shell/icons';
import { foldableAt, foldStateOf, toggleFoldAt, type Foldable } from './fold';

/** How far down the block's top the pointer still is on its first line. */
const FIRST_LINE = 32;

/** The block that can fold whose first line the point is on, the innermost first; null if none. */
export function foldTargetAt(
  view: EditorView,
  x: number,
  y: number,
): { foldable: Foldable; rect: DOMRect } | null {
  const content = view.dom.getBoundingClientRect();
  let found: { pos: number; inside: number } | null | undefined;
  try {
    found = view.posAtCoords({
      left: Math.min(Math.max(x, content.left + 1), content.right - 1),
      top: y,
    });
  } catch {
    return null; // no layout
  }
  if (!found) return null;
  const { doc } = view.state;
  // the blocks the point is in, the innermost first: the node it is inside of (a code block or a table
  // is an editor of its own, and the position of a point in it is the node's, not a position in it) and
  // the ancestors of that, or of the position
  const candidates: number[] = [];
  const add = (pos: number): void => {
    const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
    for (let d = $pos.depth; d > 0; d--) {
      const before = $pos.before(d);
      if (!candidates.includes(before)) candidates.push(before);
    }
  };
  if (found.inside >= 0) {
    candidates.push(found.inside);
    add(found.inside);
  }
  add(found.pos);
  for (const pos of candidates) {
    const foldable = foldableAt(doc, pos);
    if (!foldable) continue;
    const dom = view.nodeDOM(foldable.pos);
    if (!(dom instanceof HTMLElement)) continue;
    const rect = dom.getBoundingClientRect();
    if (y >= rect.top - 2 && y <= rect.top + Math.min(rect.height, FIRST_LINE)) {
      return { foldable, rect };
    }
  }
  return null;
}

/** Attaches the chevron to the host of the editor; returns what takes it off. */
export function attachFoldHover(host: HTMLElement, getView: () => EditorView): () => void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'live-fold-hover';
  button.tabIndex = -1; // the keyboard has the keys of the editor
  button.hidden = true;
  button.setAttribute('aria-label', i18next.t('editor.fold.fold'));
  button.append(iconElement('chevronDown', 16));
  host.append(button);

  let at: number | null = null;
  let frame = 0;
  let pointer: { x: number; y: number } | null = null;

  const hide = (): void => {
    button.hidden = true;
    at = null;
  };

  const show = (): void => {
    frame = 0;
    if (!pointer) return hide();
    const view = getView();
    const state = foldStateOf(view.state);
    if (!state?.enabled) return hide();
    const hit = foldTargetAt(view, pointer.x, pointer.y);
    // a folded block shows its own chevron
    if (!hit || state.folded.has(hit.foldable.pos)) return hide();
    const box = host.getBoundingClientRect();
    button.style.left = `${Math.max(2, hit.rect.left - box.left + host.scrollLeft - 24)}px`;
    button.style.top = `${hit.rect.top - box.top + host.scrollTop + 2}px`;
    button.hidden = false;
    at = hit.foldable.pos;
  };

  const onMove = (e: MouseEvent): void => {
    if (e.target === button || button.contains(e.target as Node)) return;
    pointer = { x: e.clientX, y: e.clientY };
    if (!frame) frame = requestAnimationFrame(show);
  };
  const onLeave = (e: MouseEvent): void => {
    if (e.relatedTarget && button.contains(e.relatedTarget as Node)) return;
    pointer = null;
    hide();
  };
  const onDown = (e: MouseEvent): void => {
    e.preventDefault(); // the editor keeps the focus
    const pos = at;
    hide();
    if (pos !== null) toggleFoldAt(getView(), pos);
  };

  host.addEventListener('mousemove', onMove);
  host.addEventListener('mouseleave', onLeave);
  host.addEventListener('scroll', hide, { passive: true });
  button.addEventListener('mousedown', onDown);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    host.removeEventListener('mousemove', onMove);
    host.removeEventListener('mouseleave', onLeave);
    host.removeEventListener('scroll', hide);
    button.remove();
  };
}
