// The state of a task (A-W5b). A list item is a task when the file says `[ ]` or `[x]` after the marker:
// the layer reads it as the `checked` attribute of the item, and Crepe's list item draws the box and
// ticks it. A custom state (`[/]`, `[-]`, `[>]`: any other single character between the brackets) is
// no task for Markdown and stays the text `[/] ` at the start of the item, as the file has it. This
// file gives that text what CodeMirror's Live Preview gives it, a box that shows the state and a click
// that makes the item an open task, and gives the command `editor:task` its cycle:
//
//   plain item  ->  open task  ->  done task  ->  plain item        (a custom state also goes to plain)
//
// The decoration is the view of text that is there: it never changes the document.
//
// Both boxes (the one Crepe draws for `[ ]` and `[x]`, and the one of a custom state) are checkboxes for a
// screen reader (`role`, `aria-checked`, a name) and can be focused. Space and Enter on a focused box
// toggle it (a click that no pointer made does too: that is how an assistive technology activates it);
// Tab and Shift+Tab leave it as they leave any control (the key is not the editor's there).
import type { Ctx } from '@milkdown/kit/ctx';
import { listItemBlockConfig } from '@milkdown/kit/component/list-item-block';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { Fragment } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { saysNoText } from '../overrides';
import { isUserEdit } from '../userEdit';

/** A custom state at the start of the text of an item: `[/] `. */
export const CUSTOM_STATE = /^\[([^\]\sxX])\][ \t]/;

/** The custom state a list item starts with (its first paragraph is `[/] text`), or null. */
export function customState(item: PMNode): string | null {
  if (item.type.name !== 'list_item' || item.attrs['checked'] != null) return null;
  const first = item.firstChild;
  if (first?.type.name !== 'paragraph') return null;
  const head = first.textBetween(0, Math.min(first.content.size, 4), undefined, '￼');
  return CUSTOM_STATE.exec(head)?.[1] ?? null;
}

/**
 * One step of the cycle on the list item at `pos`: an open task is done, a done task and a custom state
 * become a plain item, a plain item an open task. Edits `tr`; the item is at `pos` in `tr.doc`.
 */
export function cycleTask(tr: Transaction, pos: number): void {
  const item = tr.doc.nodeAt(pos);
  if (!item || item.type.name !== 'list_item') return;
  const checked = item.attrs['checked'] as boolean | null | undefined;
  if (checked === false) {
    tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: true });
  } else if (checked === true) {
    tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: null });
  } else if (customState(item) !== null) {
    // the text `[/] ` goes: the first paragraph starts at pos + 1, its text at pos + 2
    tr.delete(pos + 2, pos + 2 + 4);
  } else {
    tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: false });
  }
}

/** A click on a custom state: the item is an open task. */
function openTask(tr: Transaction, pos: number): void {
  const item = tr.doc.nodeAt(pos);
  if (!item || customState(item) === null) return;
  tr.delete(pos + 2, pos + 2 + 4);
  tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: false });
}

const stateKey = new PluginKey<DecorationSet>('memobrain-task-states');
const CLASS = 'ofm-task-state';
const BOX = 'ofm-task-box';

const escapeAttr = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Crepe's box of a task, as a checkbox: the label it draws is wrapped in a focusable element that has the
 * role, the state and a name (the label of Crepe is an icon, which a screen reader cannot read).
 */
export function nameTaskBox(ctx: Ctx, name: string): void {
  ctx.update(listItemBlockConfig.key, (prev) => ({
    ...prev,
    renderLabel: (args) => {
      const html = prev.renderLabel(args);
      if (args.checked == null) return html;
      return `<span class="${BOX}" role="checkbox" tabindex="0" aria-checked="${String(args.checked)}" aria-label="${escapeAttr(name)}">${html}</span>`;
    },
  }));
}

/** The position of the list item a box belongs to: the deepest item whose view holds it. */
function itemOfBox(view: EditorView, box: Element): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'list_item') return true;
    const dom = view.nodeDOM(pos);
    if (dom instanceof Node && dom.contains(box)) found = pos;
    return true;
  });
  return found;
}

/** Ticks or unticks a task of Crepe's box (the one at `pos`), and puts the focus back on the box that replaces it. */
function toggleBox(view: EditorView, pos: number): void {
  const item = view.state.doc.nodeAt(pos);
  const checked = item?.attrs['checked'] as boolean | null | undefined;
  if (!item || checked == null) return;
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: !checked }));
  // the component draws the label again: the box that had the focus is gone
  focusBoxOf(view, pos);
}

/** The box of the item at `pos`, focused once the component has drawn it (the one that had the focus is gone). */
function focusBoxOf(view: EditorView, pos: number): void {
  requestAnimationFrame(() => {
    if (view.isDestroyed) return;
    const dom = view.nodeDOM(pos);
    if (dom instanceof Element) dom.querySelector<HTMLElement>(`.${BOX}`)?.focus();
  });
}

/** A custom state's box: the item becomes an open task (`refocus`: the box that replaces it has the focus). */
function activateState(view: EditorView, box: Element, refocus = false): boolean {
  if (!view.editable) return false;
  const $at = view.state.doc.resolve(view.posAtDOM(box, 0));
  for (let d = $at.depth; d > 0; d--) {
    if ($at.node(d).type.name !== 'list_item') continue;
    const pos = $at.before(d);
    const tr = view.state.tr;
    openTask(tr, pos);
    view.dispatch(tr);
    if (refocus) focusBoxOf(view, pos);
    return true;
  }
  return false;
}

/** Activates the box an event is on (Crepe's or a custom state's): true when there was one. */
function activate(view: EditorView, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !view.dom.contains(target)) return false;
  const crepe = target.closest(`.${BOX}`);
  if (crepe) {
    const pos = itemOfBox(view, crepe);
    if (pos < 0) return false;
    toggleBox(view, pos);
    return true;
  }
  const custom = target.closest(`.${CLASS}`);
  return custom ? activateState(view, custom, true) : false;
}

/** The name of a custom state's box: the label and the text of the item, so that the boxes of a list differ. */
function labelOf(name: string, item: PMNode): string {
  const text = (item.firstChild?.textContent ?? '').replace(CUSTOM_STATE, '').trim().slice(0, 80);
  return text === '' ? name : `${name}: ${text}`;
}

function decorate(doc: PMNode, name: string): DecorationSet {
  const out: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) return false;
    const state = customState(node);
    if (state !== null) {
      // pos + 2: the text of the first paragraph; the three characters are the box
      out.push(
        Decoration.inline(pos + 2, pos + 2 + 3, {
          class: CLASS,
          'data-state': state,
          role: 'checkbox',
          'aria-checked': 'mixed',
          'aria-label': labelOf(name, node),
          tabindex: '0',
        }),
      );
    }
    return true;
  });
  return DecorationSet.create(doc, out);
}

/** A task whose first paragraph says no text while another paragraph of the item has text, or -1. */
function textOfHeadlessTask(item: PMNode): number {
  if (item.type.name !== 'list_item' || item.attrs['checked'] == null || item.childCount < 2) {
    return -1;
  }
  if (item.child(0).type.name !== 'paragraph' || !saysNoText(item.child(0))) return -1;
  for (let i = 1; i < item.childCount; i++) {
    const k = item.child(i);
    if (k.type.name === 'paragraph' && k.content.size > 0) return i;
  }
  return -1;
}

/**
 * The text of a task is what follows its box on the line of the marker: the file cannot say a task whose
 * first paragraph is empty (`- [ ]` then a line break is no task). A paste, a rule typed or a split at the
 * start of its text leaves the item so (`- [ ] a`, a list pasted before `a`: an empty paragraph, the list,
 * `a`). The first paragraph that has text becomes the head and the blocks that preceded it follow it, the
 * item is still a task; the selection stays on what it was on.
 */
function mendTaskHeads(tr: Transaction): boolean {
  const found: number[] = [];
  tr.doc.descendants((node, pos) => {
    if (node.isTextblock) return false;
    if (textOfHeadlessTask(node) > 0) found.push(pos);
    return true;
  });
  if (found.length === 0) return false;
  // the steps that came before are not the ones that move `found`
  const first = tr.steps.length;
  let { anchor, head } = tr.selection;
  const text = tr.selection instanceof TextSelection;
  // the last first: what precedes it keeps its place, and an item inside another is mended before it
  for (const at of found.reverse()) {
    const pos = tr.mapping.slice(first).map(at, -1);
    const item = tr.doc.nodeAt(pos);
    const j = item ? textOfHeadlessTask(item) : -1;
    if (!item || j < 0) continue;
    const kids: PMNode[] = [];
    item.forEach((k) => kids.push(k));
    const order = [kids[j]!, ...kids.slice(1, j), ...kids.slice(j + 1)];
    // where each block started in the item, and where it starts now
    const from: number[] = [];
    let o = 0;
    for (const k of kids) {
      from.push(o);
      o += k.nodeSize;
    }
    const to = new Map<PMNode, number>();
    let n = 0;
    for (const k of order) {
      to.set(k, n);
      n += k.nodeSize;
    }
    const start = pos + 1;
    const move = (p: number): number => {
      if (p < start || p > start + item.content.size) return p;
      const rel = p - start;
      let i = kids.length - 1;
      while (i > 0 && from[i]! > rel) i--;
      if (i === 0) return rel === 0 ? start : start + 1; // the empty paragraph that goes: the head that comes
      return start + to.get(kids[i]!)! + (rel - from[i]!);
    };
    const next = { anchor: move(anchor), head: move(head) };
    // (a rule that now follows the text is written `***` by the serializer: `---` there would underline it)
    tr.replaceWith(start, start + item.content.size, Fragment.fromArray(order));
    anchor = next.anchor;
    head = next.head;
  }
  if (text) tr.setSelection(TextSelection.create(tr.doc, anchor, head));
  return true;
}

/**
 * The size of the line breaks a task's text starts with (the line breaks of a text that goes on over several
 * lines, which a split at the end of the first one leaves at the start of the next item), or 0. A text
 * does not start with a line break for the file, and the box of a task that is written before one is
 * written after it, on the line below the marker: the item is no task and the note is refused.
 * A hard line break at the start is one of them only when the paragraph holds nothing else (a line break
 * typed before the text, and a block pasted after it): with text after it, `- [ ] \`, a line break and the
 * text is a task the file can say.
 */
export function leadingBreaks(item: PMNode): number {
  const head = item.firstChild;
  if (item.type.name !== 'list_item' || item.attrs['checked'] == null) return 0;
  if (head?.type.name !== 'paragraph') return 0;
  if (head.childCount > 0 && saysNoText(head)) return head.content.size;
  let size = 0;
  for (let i = 0; i < head.childCount; i++) {
    const k = head.child(i);
    if (k.type.name === 'hardbreak' && k.attrs['isInline'] === true) size += k.nodeSize;
    else break;
  }
  return size;
}

/** The line breaks at the start of the text of a task go: the item says its text on its first line. */
function trimTaskHeads(tr: Transaction): boolean {
  const found: { pos: number; size: number }[] = [];
  tr.doc.descendants((node, pos) => {
    if (node.isTextblock) return false;
    const size = leadingBreaks(node);
    if (size > 0) found.push({ pos, size });
    return true;
  });
  if (found.length === 0) return false;
  // the last first: the positions of what precedes do not move
  for (const { pos, size } of found.reverse()) tr.delete(pos + 2, pos + 2 + size);
  return true;
}

export const taskKeepsItsText = $prose(
  () =>
    new Plugin({
      key: new PluginKey('memobrain-task-text'),
      // one transaction for both: a plugin does not see the transaction it appended itself, and the text of
      // a task that was cut from its box by a line break (trimmed) is the text a mend moves up
      appendTransaction: (trs, _old, state) => {
        if (!trs.some((t) => t.docChanged)) return null;
        const tr = state.tr;
        const trimmed = trs.some(isUserEdit) && trimTaskHeads(tr);
        const mended = mendTaskHeads(tr);
        return trimmed || mended ? tr : null;
      },
    }),
);

/** The box of a custom state, the click on it, and the keys of both kinds of box. */
export const taskStates = (name: string) =>
  $prose(
    () =>
      new Plugin<DecorationSet>({
        key: stateKey,
        state: {
          init: (_c, state: EditorState) => decorate(state.doc, name),
          apply: (tr, set, _old, state) => (tr.docChanged ? decorate(state.doc, name) : set),
        },
        props: {
          decorations: (state) => stateKey.getState(state) ?? DecorationSet.empty,
          handleDOMEvents: {
            mousedown(view: EditorView, event: Event) {
              const target = event.target;
              if (!(target instanceof Element)) return false;
              const box = target.closest(`.${CLASS}`);
              if (!box || !view.dom.contains(box)) return false;
              if (!activateState(view, box)) return false;
              event.preventDefault();
              return true;
            },
            // a click no pointer made (detail 0): the way an assistive technology presses a checkbox
            click(view: EditorView, event: Event) {
              if ((event as MouseEvent).detail !== 0) return false;
              if (!activate(view, event.target)) return false;
              event.preventDefault();
              return true;
            },
            keydown(view: EditorView, event: Event) {
              const e = event as KeyboardEvent;
              // Tab and Shift+Tab on a box that has the focus move the focus, as on any control: the keymap
              // of the editor (indent, outdent) would write in the text where the caret was left
              if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const t = e.target;
                return t instanceof Element && t.closest(`.${BOX}, .${CLASS}`) !== null;
              }
              if (e.key !== ' ' && e.key !== 'Enter') return false;
              if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
              // only a box that has the focus: the caret of the text is elsewhere
              const target = e.target;
              if (!(target instanceof Element) || !target.closest(`.${BOX}, .${CLASS}`)) {
                return false;
              }
              if (!activate(view, target)) return false;
              e.preventDefault();
              return true;
            },
          },
        },
      }),
  );
