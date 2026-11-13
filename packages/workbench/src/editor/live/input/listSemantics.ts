// What a screen reader reads of a list (A-W8). Crepe draws a list item as a `div` between the list and its
// `li` (`ul > div.milkdown-list-item-block > li`), which is no list for the accessibility tree: the rule of
// the lists of axe (`list`, `listitem`) fails, and a reader does not say how many items there are. The
// document is not touched, only the DOM the view of the item made:
//
//   div.milkdown-list-item-block   role="listitem"   (the child the list has)
//   li.list-item                   role="none"       (it is the box of the layout, no item of its own)
//   the bullet or the number       aria-hidden       (the list says it; a task's box is a checkbox and stays)
//
// and the box of a task has a name that tells which task it is: `Task: the text of the item`.
// The two roles are set at once, with the DOM the view has made; the names, and the marker of the items that
// changed (their views draw the new one after the update), a frame later (they read the text of the items,
// and a key typed in one of them need not wait for the others).
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

const key = new PluginKey('clarae-list-semantics');

/** The first paragraph of the item the `li` is the layout of: what the box of its task is the box of. */
function textOfItem(li: Element): string {
  const content = li.querySelector(':scope > .children > .content-dom');
  const head = content?.firstElementChild;
  return (head?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Gives the lists their roles and says, for every item, what its marker is to a reader: a bullet or a number
 * is left out of the tree (the list says it), a task's box is a checkbox and stays. The view of an item is
 * updated in place when the item changes (a bullet that becomes a task, a task that becomes a bullet: the
 * node is the same one), so the marker is read again for every item, not only for the ones that have no role.
 */
function applyRoles(dom: HTMLElement): void {
  for (const li of dom.querySelectorAll<HTMLElement>('li.list-item')) {
    if (!li.hasAttribute('role')) {
      li.setAttribute('role', 'none');
      li.parentElement?.setAttribute('role', 'listitem');
    }
    const marker = li.querySelector<HTMLElement>(':scope > .label-wrapper');
    if (!marker) continue;
    const plain = marker.querySelector(':scope > .label.bullet, :scope > .label.ordered') !== null;
    const task =
      marker.querySelector(':scope > .label.checked, :scope > .label.unchecked') !== null;
    if (plain) marker.setAttribute('aria-hidden', 'true');
    else if (task) marker.removeAttribute('aria-hidden');
  }
}

function applyNames(dom: HTMLElement, name: string): void {
  for (const box of dom.querySelectorAll<HTMLElement>(
    'li.list-item .label-wrapper [role="checkbox"]',
  )) {
    const li = box.closest('li.list-item');
    if (!li) continue;
    const text = textOfItem(li);
    const label = text === '' ? name : `${name}: ${text}`;
    if (box.getAttribute('aria-label') !== label) box.setAttribute('aria-label', label);
  }
}

/** The semantics of the lists and the names of the boxes of tasks, on the DOM the views of the items make. */
export const listSemantics = (taskName: string) =>
  $prose(
    () =>
      new Plugin({
        key,
        view(view: EditorView) {
          let frame = 0;
          // the views of the items change their DOM after the update that changed the item (a frame later at
          // the latest): the roles are read again then, with the names
          const later = (): void => {
            frame = 0;
            if (view.isDestroyed) return;
            applyRoles(view.dom);
            applyNames(view.dom, taskName);
          };
          const sync = (): void => {
            applyRoles(view.dom);
            applyNames(view.dom, taskName);
          };
          sync();
          return {
            update(v: EditorView, prev) {
              if (v.state.doc === prev.doc) return;
              applyRoles(v.dom);
              if (frame === 0) frame = requestAnimationFrame(later);
            },
            destroy() {
              if (frame !== 0) cancelAnimationFrame(frame);
            },
          };
        },
      }),
  );
