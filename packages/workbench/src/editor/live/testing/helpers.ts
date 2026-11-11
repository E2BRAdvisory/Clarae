// Small helpers for the tests of the layer: open a note, edit its document like the view would.
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { LiveCore } from '../headless';
import { LiveSession } from '../fidelity/session';

export function open(core: LiveCore, raw: string): LiveSession {
  const r = LiveSession.open(core, raw);
  if (!r.ok) throw new Error(`refused: ${r.reason} ${r.detail ?? ''}`);
  return r.session;
}

/** A transaction on `doc`, as the view would start one. */
export function tx(doc: PMNode): Transaction {
  return EditorState.create({ doc }).tr;
}

/** The position just after the first occurrence of `text` in the text nodes of `doc` (-1: not there). */
export function posAfter(doc: PMNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text) {
      const i = node.text.indexOf(text);
      if (i >= 0) found = pos + i + text.length;
    }
    return true;
  });
  return found;
}

/** `doc` with `insert` typed right after the first occurrence of `after`. */
export function typeAfter(doc: PMNode, after: string, insert: string): PMNode {
  const at = posAfter(doc, after);
  if (at < 0) throw new Error(`no text ${JSON.stringify(after)}`);
  return tx(doc).insertText(insert, at).doc;
}

/** `doc` with the first occurrence of `text` replaced by `by`. */
export function replaceText(doc: PMNode, text: string, by: string): PMNode {
  const to = posAfter(doc, text);
  if (to < 0) throw new Error(`no text ${JSON.stringify(text)}`);
  return tx(doc).insertText(by, to - text.length, to).doc;
}

/** The positions of the nodes of a type, in document order. */
export function positionsOf(doc: PMNode, type: string): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === type) out.push(pos);
    return true;
  });
  return out;
}

/** `doc` with the checkbox of the n-th list item set. */
export function setChecked(doc: PMNode, n: number, checked: boolean | null): PMNode {
  const pos = positionsOf(doc, 'list_item')[n];
  if (pos === undefined) throw new Error(`no list item ${n}`);
  const node = doc.nodeAt(pos)!;
  return tx(doc).setNodeMarkup(pos, undefined, { ...node.attrs, checked }).doc;
}
