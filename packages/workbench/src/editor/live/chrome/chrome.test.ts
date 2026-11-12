// The chrome around the document of the Live editor (ADR-0049, chrome/) on the mounted Milkdown editor: the
// handle of the blocks, the toolbar over a selection, the tooltip of a link and the placeholder. What the
// file says afterwards is the property that counts: none of it may touch what the user did not edit.
import { NodeSelection, Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../../i18n';
import type { LiveEditor } from '../MilkdownAdapter';
import { inertInput } from '../input';
import { EditorViewOf, openLive } from '../testing/mounted';
import { posAfter } from '../testing/helpers';
import { conformanceFixtures, demoVault, handWritten } from '../testing/corpus';
import { openLiveEditor } from '../MilkdownAdapter';
import { options } from '../testing/mounted';
import { addBlockBelow } from './handle';
import { sizeOf } from './index';
import { ariaCombo } from './shortcuts';

vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => initI18n('en'));

const opened: { dispose(): void }[] = [];
const original: unknown = (document as { elementFromPoint?: unknown }).elementFromPoint;
beforeEach(() => {
  // jsdom has no layout: the pointer is always over the document
  document.elementFromPoint = () => document.querySelector('.ProseMirror');
  // the plugin that uploads what is dropped asks for the class (a drop of the test is a plain event)
  vi.stubGlobal('DragEvent', class DragEvent extends Event {});
});
afterEach(async () => {
  // the drop indicator hides its line 30 ms after a drop: not after the editor is gone
  await new Promise((r) => setTimeout(r, 50));
  vi.unstubAllGlobals();
  for (const o of opened.splice(0)) o.dispose();
  document.body.replaceChildren();
  (document as { elementFromPoint?: unknown }).elementFromPoint = original;
});

interface Ed {
  editor: LiveEditor;
  view: EditorView;
  parent: HTMLElement;
  slash: ReturnType<typeof vi.fn>;
  /** Turns the setting `slashCommands` on or off under the open editor. */
  setSlash(on: boolean): void;
  handle(): HTMLElement;
  /** The pointer over the top-level block `index`. */
  hover(index: number): Promise<void>;
  /** The pointer over the node at `pos` (it may be deep in a block). */
  hoverPos(pos: number): Promise<void>;
  /** The position before the top-level block `index`. */
  at(index: number): number;
}

async function open(
  raw: string,
  over: { readOnly?: boolean; slash?: boolean; shortcut?: Parameters<typeof openLive>[1] } = {},
): Promise<Ed> {
  const slash = vi.fn();
  let slashOn = over.slash ?? true;
  const live = await openLive(raw, {
    readOnly: over.readOnly ?? false,
    input: {
      ...inertInput,
      slash: { enabled: () => slashOn, run: slash },
    },
    ...(over.shortcut ?? {}),
  });
  opened.push(live);
  const view = EditorViewOf(live.editor);
  const at = (index: number): number => {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += view.state.doc.child(i).nodeSize;
    return pos;
  };
  const handle = (): HTMLElement => {
    const el = live.parent.querySelector<HTMLElement>('.milkdown-block-handle');
    if (!el) throw new Error('no handle');
    return el;
  };
  // the provider of the handle puts it in the DOM one frame after the editor is created
  await vi.waitFor(() =>
    expect(live.parent.querySelector('.milkdown-block-handle')).not.toBeNull(),
  );
  const hoverPos = async (pos: number): Promise<void> => {
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos, inside: pos });
    view.dom.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }),
    );
    await vi.waitFor(() => expect(handle().dataset['show']).toBe('true'));
  };
  return {
    editor: live.editor,
    view,
    parent: live.parent,
    slash,
    setSlash: (on) => {
      slashOn = on;
    },
    handle,
    at,
    hover: (index) => hoverPos(at(index)),
    hoverPos,
  };
}

const press = (el: Element, type: string): void => {
  el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
};

const select = (ed: Ed, from: number, to: number): void =>
  ed.view.dispatch(
    ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, from, to)),
  );

const popup = (): HTMLElement | null => document.querySelector('.mb-suggest:not([hidden])');

describe('the handle of the blocks', () => {
  it('is in the editor with two controls outside the tab order: "+" a named button, the grip the pointer\'s alone', async () => {
    const ed = await open('one\n\ntwo\n');
    const [add, grip] = [...ed.handle().querySelectorAll<HTMLElement>('.operation-item')];
    expect(add?.getAttribute('aria-label')).toBe('Add a block below');
    // a screen reader's click on the grip would select the block: it is not shown to one (Alt+Up/Down move it)
    expect(grip?.getAttribute('aria-hidden')).toBe('true');
    expect(grip?.hasAttribute('role')).toBe(false);
    expect(grip?.title).toBe('Drag to move the block');
    expect(add?.tagName).toBe('BUTTON');
    expect(add?.tabIndex).toBe(-1);
    expect(grip?.tabIndex).toBe(-1);
    // hidden until the pointer is over a block
    expect(ed.handle().dataset['show']).toBe('false');
    // it is the handle that is dragged (the plugin of the blocks makes it so)
    expect(ed.handle().draggable).toBe(true);
    // drawn with the icons of the application, which are not read
    expect(ed.handle().querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
  });

  it('shows over a block the pointer is on, and goes with the editor', async () => {
    const ed = await open('one\n\ntwo\n');
    await ed.hover(1);
    expect(ed.handle().dataset['show']).toBe('true');
    ed.editor.dispose();
    await vi.waitFor(() => expect(ed.parent.querySelector('.milkdown-block-handle')).toBeNull());
  });

  it('adds an empty block below the one it is on and opens the slash menu there, with its groups', async () => {
    const ed = await open('one\n\ntwo\n');
    await ed.hover(0);
    const before = ed.editor.text();
    press(ed.handle().querySelector('button.operation-item') as Element, 'pointerup');
    expect(ed.view.state.doc.childCount).toBe(3);
    expect(ed.view.state.doc.child(1).type.name).toBe('paragraph');
    expect(ed.view.state.doc.child(1).content.size).toBe(0);
    // the caret is in the new block
    expect(ed.view.state.selection.from).toBe(ed.at(1) + 1);
    // the blocks that were there are written as they were
    expect(ed.editor.text().startsWith('one\n')).toBe(true);
    expect(ed.editor.text().endsWith('two\n')).toBe(true);
    expect(before).toBe('one\n\ntwo\n');
    await vi.waitFor(() => expect(popup()).not.toBeNull());
    const headings = [...(popup()?.querySelectorAll('.mb-suggest-group') ?? [])].map(
      (e) => e.textContent,
    );
    expect(headings).toEqual(['Text', 'Lists', 'Advanced', 'Vault']);
    const options = popup()?.querySelectorAll('[role="option"]') ?? [];
    expect(options).toHaveLength(18);
    // the headings are not options, and every option has an icon
    expect(popup()?.querySelectorAll('.mb-suggest-item .mb-suggest-icon svg')).toHaveLength(18);
    expect(popup()?.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('filters the menu as the user types, and an item turns the empty block into what it names', async () => {
    const ed = await open('one\n\ntwo\n');
    await ed.hover(0);
    press(ed.handle().querySelector('button.operation-item') as Element, 'pointerup');
    await vi.waitFor(() => expect(popup()).not.toBeNull());
    const { view } = ed;
    for (const ch of 'call') view.dispatch(view.state.tr.insertText(ch));
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('.mb-suggest:not([hidden]) .mb-suggest-label')].map(
          (e) => e.textContent,
        ),
      ).toEqual(['Callout']),
    );
    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(popup()).toBeNull();
    // the typed "call" went; the block is a callout now, and the rest of the note is as it was
    expect(ed.editor.text()).toBe('one\n\n> [!note] \n\ntwo\n');
  });

  it('closes with Escape and leaves the empty block; what is typed after is no query', async () => {
    const ed = await open('one\n\ntwo\n');
    await ed.hover(0);
    press(ed.handle().querySelector('button.operation-item') as Element, 'pointerup');
    await vi.waitFor(() => expect(popup()).not.toBeNull());
    ed.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(popup()).toBeNull();
    ed.view.dispatch(ed.view.state.tr.insertText('h'));
    await new Promise((r) => setTimeout(r, 120));
    expect(popup()).toBeNull();
    expect(ed.view.state.doc.child(1).textContent).toBe('h');
  });

  it('uses the empty paragraph it is on instead of adding another', async () => {
    const ed = await open('one\n\ntwo\n');
    // an empty block between the two
    await ed.hover(0);
    press(ed.handle().querySelector('button.operation-item') as Element, 'pointerup');
    await vi.waitFor(() => expect(popup()).not.toBeNull());
    ed.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(ed.view.state.doc.childCount).toBe(3);
    await ed.hover(1);
    press(ed.handle().querySelector('button.operation-item') as Element, 'pointerup');
    expect(ed.view.state.doc.childCount).toBe(3);
    expect(ed.view.state.selection.from).toBe(ed.at(1) + 1);
  });

  it('adds only the block when the slash menu is off', async () => {
    const ed = await open('one\n\ntwo\n', { slash: false });
    await ed.hover(0);
    press(ed.handle().querySelector('button.operation-item') as Element, 'pointerup');
    expect(ed.view.state.doc.childCount).toBe(3);
    await new Promise((r) => setTimeout(r, 120));
    expect(popup()).toBeNull();
  });

  it('adds an item beside a list item, not a paragraph in the list', async () => {
    const ed = await open('- a\n- b\n');
    const list = ed.view.state.doc.child(0);
    expect(list.type.name).toBe('bullet_list');
    // the first item stands for the whole list (it is on the same line); the second is an item of its own
    await ed.hoverPos(1 + list.child(0).nodeSize);
    press(ed.handle().querySelector('button.operation-item') as Element, 'pointerup');
    const items = ed.view.state.doc.child(0);
    expect(items.type.name).toBe('bullet_list');
    expect(items.childCount).toBe(3);
    expect(items.child(2).type.name).toBe('list_item');
    expect(items.child(2).textContent).toBe('');
    expect(ed.view.state.selection.$from.node(-1).type.name).toBe('list_item');
  });

  it('acts on a click that no pointer made (a screen reader), and once for a pointer', async () => {
    const ed = await open('one\n\ntwo\n', { slash: false });
    await ed.hover(0);
    const add = ed.handle().querySelector('button.operation-item') as Element;
    press(add, 'click');
    expect(ed.view.state.doc.childCount).toBe(3);
    // a release and the click that follows it are one gesture
    await ed.hover(2);
    press(add, 'pointerup');
    press(add, 'click');
    expect(ed.view.state.doc.childCount).toBe(4);
  });

  it('is not on a block that is no longer there: a reload between the pointer and the click', async () => {
    const ed = await open('a\n\nsecond block\n\nthird line\n');
    await ed.hover(1);
    expect(ed.editor.reload('second block\n\nthird line\n')).toBeNull();
    // the handle goes with the change, and a click that still reaches it adds nothing and splits nothing
    await vi.waitFor(() => expect(ed.handle().dataset['show']).toBe('false'));
    press(ed.handle().querySelector('button.operation-item') as Element, 'pointerup');
    expect(ed.editor.text()).toBe('second block\n\nthird line\n');
    expect(ed.view.state.doc.childCount).toBe(2);
  });

  it('adds no block to a block it found before the note changed under it', async () => {
    const ed = await open('a\n\nsecond block\n\nthird line\n');
    const node = ed.view.state.doc.child(1);
    const $pos = ed.view.state.doc.resolve(ed.at(1));
    expect(ed.editor.reload('second block\n\nthird line\n')).toBeNull();
    // the position it had is the inside of another block now: a block added there would split it
    expect(addBlockBelow(ed.view, { node, $pos })).toBeNull();
    expect(ed.editor.text()).toBe('second block\n\nthird line\n');
    // a block that is still there is found
    const here = ed.view.state.doc.resolve(0);
    expect(addBlockBelow(ed.view, { node: ed.view.state.doc.child(0), $pos: here })).not.toBeNull();
    expect(ed.view.state.doc.childCount).toBe(3);
  });

  it('does nothing in a read-only editor (no block, no menu)', async () => {
    const ed = await open('one\n\ntwo\n', { readOnly: true });
    expect(ed.parent.dataset['readonly']).toBe('true');
    await ed.hover(0);
    press(ed.handle().querySelector('button.operation-item') as Element, 'pointerup');
    expect(ed.view.state.doc.childCount).toBe(2);
    expect(ed.editor.text()).toBe('one\n\ntwo\n');
    expect(popup()).toBeNull();
  });
});

describe('dragging a block', () => {
  const RAW = '# Title\n\nodd   spacing  *emph*  __b__\n\n- a\n- b\n\nlast para\n';

  /** The drop of the block at the top-level `index` on the position `to`, as the handle's drag makes it. */
  function drag(ed: Ed, index: number, to: number): Event {
    const { view } = ed;
    const sel = NodeSelection.create(view.state.doc, ed.at(index));
    view.dispatch(view.state.tr.setSelection(sel));
    (view as unknown as { dragging: unknown }).dragging = {
      slice: sel.content(),
      move: true,
      node: sel,
    };
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: to, inside: -1 });
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { files: [], types: [], getData: () => '' },
    });
    view.dom.dispatchEvent(ev);
    return ev;
  }

  // (where the block lands is the drop indicator's: it reads the layout, which jsdom has not. The block it
  // lands on is the first here, and that is enough for what the file must say.)
  it('moves the block, and the others are written exactly as they were', async () => {
    const ed = await open(RAW);
    expect(ed.view.state.doc.childCount).toBe(4);
    drag(ed, 3, 0);
    expect(ed.view.state.doc.child(0).textContent).toBe('last para');
    expect(ed.editor.text()).toBe(
      'last para\n\n# Title\n\nodd   spacing  *emph*  __b__\n\n- a\n- b\n',
    );
  });

  it('keeps a thematic break, and every other block, as the file has it when the block crosses one', async () => {
    const raw = 'Setext\n======\n\n1) one\n2) two\n\n***\n\n__strong__ text\n';
    const ed = await open(raw);
    drag(ed, 3, 0);
    // (the move of Alt+Up goes the same way through the layer: a block paired with the entry of its old place
    // once wrote the rule as the text of the block that stood there, and lost it)
    expect(ed.editor.text()).toBe('__strong__ text\n\nSetext\n======\n\n1) one\n2) two\n\n***\n');
    const moved = await open('a\n\n---\n\nb\n');
    moved.view.dispatch(moved.view.state.tr.setSelection(Selection.atEnd(moved.view.state.doc)));
    expect(moved.editor.exec('move-up')).toBe(true);
    expect(moved.editor.text()).toBe('a\n\nb\n\n---\n');
  });

  it('writes a block that moved, and the ones it moved past, with the style of their own place in the file', async () => {
    // two lists the file keeps apart by their markers: if the list were written with the marker of the entry
    // that stood at its new place, it would take the one of the list next to it and become one list with it
    const raw = '# Title\n\n* odd\n\n- a\n- b\n\nlast para\n';
    const ed = await open(raw);
    drag(ed, 3, 0);
    expect(ed.editor.text()).toBe('last para\n\n# Title\n\n* odd\n\n- a\n- b\n');
  });

  it('keeps the code of an indented fence when the block moves to a place with another indentation', async () => {
    const ed = await open('para\n\n  ```js\n  code\n  more\n  ```\n\nlast\n');
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 1)));
    expect(ed.editor.exec('move-down')).toBe(true);
    // the fence at the new place has no indentation, and its code has none to strip either
    expect(ed.editor.text()).toBe('```js\ncode\nmore\n```\n\n  para\n\nlast\n');
  });

  it('keeps the code of an indented fence when a block is deleted before it and another is added after', async () => {
    const ed = await open('a\n\n  ```js\n  code\n  ```\n\nb\n');
    const { view } = ed;
    view.dispatch(view.state.tr.delete(0, view.state.doc.child(0).nodeSize));
    const p = view.state.schema.nodes['paragraph']!;
    view.dispatch(
      view.state.tr.insert(
        view.state.doc.content.size,
        p.create(null, view.state.schema.text('NEW')),
      ),
    );
    expect(ed.editor.text()).toBe('```js\ncode\n```\n\n  b\n\nNEW\n');
  });

  it('is an edit like any other: undone in one step', async () => {
    const ed = await open(RAW);
    drag(ed, 3, 0);
    expect(ed.editor.exec('undo')).toBe(true);
    expect(ed.editor.text()).toBe(RAW);
  });

  it('is refused by a read-only editor', async () => {
    const ed = await open(RAW, { readOnly: true });
    drag(ed, 3, 0);
    expect(ed.editor.text()).toBe(RAW);
  });
});

describe('the toolbar over a selection', () => {
  const toolbar = (ed: Ed): HTMLElement => {
    const el = ed.parent.querySelector<HTMLElement>('.milkdown-toolbar');
    if (!el) throw new Error('no toolbar');
    return el;
  };
  const item = (ed: Ed, key: string): HTMLElement => {
    const el = toolbar(ed).querySelector<HTMLElement>(`[data-toolbar-item="${key}"]`);
    if (!el) throw new Error(`no item ${key}`);
    return el;
  };
  const RAW = 'hello world\n\n*  odd   spacing  *emph*\n\nlast\n';

  it('is a toolbar with a name, and every button has one', async () => {
    const ed = await open(RAW);
    expect(toolbar(ed).getAttribute('role')).toBe('toolbar');
    expect(toolbar(ed).getAttribute('aria-label')).toBe('Format the selection');
    const buttons = [...toolbar(ed).querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Bold',
      'Italic',
      'Strikethrough',
      'Highlight',
      'Inline code',
      'Inline math',
      'Insert link',
    ]);
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
  });

  it('formats the selection and writes only the block it is in', async () => {
    for (const [key, wrapped] of [
      ['bold', '**hello**'],
      ['italic', '*hello*'],
      ['strikethrough', '~~hello~~'],
      ['highlight', '==hello=='],
      ['code', '`hello`'],
    ] as const) {
      const ed = await open(RAW);
      ed.view.focus();
      select(ed, 1, posAfter(ed.view.state.doc, 'hello'));
      press(item(ed, key), 'pointerdown');
      expect(ed.editor.text(), key).toBe(`${wrapped} world\n\n*  odd   spacing  *emph*\n\nlast\n`);
      // the same button takes it away
      select(ed, 1, posAfter(ed.view.state.doc, 'hello'));
      press(item(ed, key), 'pointerdown');
      expect(ed.editor.text(), `${key} off`).toBe(RAW);
      ed.editor.dispose();
    }
  });

  it('shows the shortcuts of the application, not the ones Milkdown binds', async () => {
    const ed = await open(RAW, {
      shortcut: {
        shortcut: (id) =>
          ({
            'editor:bold': { display: 'Ctrl+B', aria: 'Control+B' },
            'editor:strike': { display: 'Ctrl+Shift+X', aria: 'Control+Shift+X' },
          })[id],
      },
    });
    expect(item(ed, 'bold').title).toBe('Bold (Ctrl+B)');
    expect(item(ed, 'bold').getAttribute('aria-keyshortcuts')).toBe('Control+B');
    expect(item(ed, 'strikethrough').title).toBe('Strikethrough (Ctrl+Shift+X)');
    // no binding in the application: none shown, whatever Milkdown binds to the mark
    expect(item(ed, 'italic').title).toBe('Italic');
    expect(item(ed, 'italic').hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(item(ed, 'code').title).toBe('Inline code');
  });

  it('writes the shortcuts in the grammar of aria-keyshortcuts', () => {
    expect(ariaCombo('Mod-Shift-h', false)).toBe('Control+Shift+H');
    expect(ariaCombo('Mod-b', true)).toBe('Meta+B');
    expect(ariaCombo('Mod-Alt-ArrowUp', false)).toBe('Control+Alt+ArrowUp');
    expect(ariaCombo('Mod--', false)).toBe('Control+-');
  });

  it('changes nothing in a read-only editor', async () => {
    const ed = await open(RAW, { readOnly: true });
    select(ed, 1, posAfter(ed.view.state.doc, 'hello'));
    press(item(ed, 'bold'), 'pointerdown');
    expect(ed.editor.text()).toBe(RAW);
  });
});

describe('the tooltip of a link', () => {
  it('has the names of its buttons in the language of the application', async () => {
    const ed = await open('[a link](https://example.com)\n');
    const preview = ed.parent.querySelector('.milkdown-link-preview');
    expect(preview).not.toBeNull();
    const names = [...(preview?.querySelectorAll('.button .live-sr') ?? [])].map(
      (e) => e.textContent,
    );
    expect(names).toEqual(['Copy link', 'Edit link', 'Remove link']);
    expect(preview?.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(3);
    // the icons are what is clicked: buttons for the accessibility tree, each with its name
    expect(
      [...(preview?.querySelectorAll('.button') ?? [])].map((b) => b.getAttribute('role')),
    ).toEqual(['button', 'button', 'button']);
    // the notice of a copied link is a live region that is always there
    const status = ed.parent.querySelector('.live-chrome-status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.hasAttribute('hidden')).toBe(false);
    const edit = ed.parent.querySelector('.milkdown-link-edit');
    expect(edit?.querySelector('.input-area')?.getAttribute('aria-label')).toBe('Paste link…');
    expect(edit?.querySelector('.input-area')?.getAttribute('placeholder')).toBe('Paste link…');
  });

  it('watches the field of a link once, however often its confirm button comes and goes', async () => {
    const ed = await open('[a link](https://example.com)\n');
    const edit = ed.parent.querySelector('.milkdown-link-edit .link-edit');
    if (!edit) throw new Error('no link edit');
    const Native = globalThis.MutationObserver;
    let made = 0;
    globalThis.MutationObserver = class extends Native {
      constructor(cb: MutationCallback) {
        super(cb);
        made++;
      }
    };
    try {
      for (let i = 0; i < 8; i++) {
        const icon = document.createElement('span');
        icon.className = 'button';
        edit.append(icon);
        await new Promise((r) => setTimeout(r, 0));
        // a button that comes is named as one
        expect(icon.getAttribute('role')).toBe('button');
        icon.remove();
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      globalThis.MutationObserver = Native;
    }
    expect(made).toBe(0);
  });

  it('passes a click that no pointer made (a screen reader) to its icons, which act on a press', async () => {
    const ed = await open('[a link](https://example.com)\n');
    const icon = ed.parent.querySelector<HTMLElement>('.milkdown-link-preview .button');
    if (!icon) throw new Error('no icon');
    const pressed = vi.fn();
    icon.addEventListener('pointerdown', pressed);
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pressed).toHaveBeenCalledTimes(1);
    // the click that follows a pointer's press is that press's
    icon.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pressed).toHaveBeenCalledTimes(2);
  });
});

describe('the size of the pane', () => {
  it('tells where the margins and the handle shrink', () => {
    expect([1200, 640, 639, 420, 419, 100].map(sizeOf)).toEqual([
      'wide',
      'wide',
      'compact',
      'compact',
      'narrow',
      'narrow',
    ]);
  });
});

describe('the placeholder', () => {
  const placeholder = (ed: Ed): HTMLElement | null =>
    ed.parent.querySelector<HTMLElement>('.crepe-placeholder');

  it('is on the empty block the caret is in, and nowhere else', async () => {
    const ed = await open('one\n\ntwo\n');
    expect(placeholder(ed)).toBeNull();
    // an empty block, with the caret in it
    const para = ed.view.state.schema.nodes['paragraph']!.create();
    ed.view.dispatch(ed.view.state.tr.insert(ed.at(1), para));
    ed.view.dispatch(
      ed.view.state.tr.setSelection(Selection.near(ed.view.state.doc.resolve(ed.at(1)), 1)),
    );
    expect(placeholder(ed)?.dataset['placeholder']).toBe('Write, or press / for commands');
    // the caret elsewhere: none
    select(ed, 1, 1);
    expect(placeholder(ed)).toBeNull();
  });

  it('says what the menu is not there for when the slash menu is off', async () => {
    const ed = await open('one\n', { slash: false });
    const para = ed.view.state.schema.nodes['paragraph']!.create();
    ed.view.dispatch(ed.view.state.tr.insert(ed.at(1), para));
    ed.view.dispatch(
      ed.view.state.tr.setSelection(Selection.near(ed.view.state.doc.resolve(ed.at(1)), 1)),
    );
    expect(placeholder(ed)?.dataset['placeholder']).toBe('Write here');
  });

  it('follows the setting of the slash menu as it changes', async () => {
    const ed = await open('one\n');
    const para = ed.view.state.schema.nodes['paragraph']!.create();
    ed.view.dispatch(ed.view.state.tr.insert(ed.at(1), para));
    const caret = (): void =>
      ed.view.dispatch(
        ed.view.state.tr.setSelection(Selection.near(ed.view.state.doc.resolve(ed.at(1)), 1)),
      );
    caret();
    expect(placeholder(ed)?.dataset['placeholder']).toBe('Write, or press / for commands');
    ed.setSlash(false);
    select(ed, 1, 1);
    caret();
    expect(placeholder(ed)?.dataset['placeholder']).toBe('Write here');
  });

  it('is never in a code block, and is no part of the document', async () => {
    const ed = await open('```js\n```\n');
    expect(ed.editor.text()).toBe('```js\n```\n');
    expect(placeholder(ed)).toBeNull();
  });

  it('is not written to the file', async () => {
    const ed = await open('one\n');
    const para = ed.view.state.schema.nodes['paragraph']!.create();
    ed.view.dispatch(ed.view.state.tr.insert(ed.at(1), para));
    ed.view.dispatch(
      ed.view.state.tr.setSelection(Selection.near(ed.view.state.doc.resolve(ed.at(1)), 1)),
    );
    expect(ed.editor.text()).not.toContain('Write');
  });
});

describe('a note that is opened and saved with the chrome on', () => {
  it('is the file, byte for byte, across the corpus of the notes of the application', async () => {
    const samples = [...conformanceFixtures(), ...demoVault(), ...handWritten()];
    expect(samples.length).toBeGreaterThan(20);
    const differing: string[] = [];
    for (const sample of samples) {
      const parent = document.body.appendChild(document.createElement('div'));
      const r = await openLiveEditor(parent, sample.raw, options());
      // a note the layer refuses stays in Source (what is not mounted cannot differ); one that opens is the file
      if (r.ok) {
        if (r.editor.text() !== sample.raw) differing.push(sample.id);
        r.editor.dispose();
      }
      parent.remove();
    }
    expect(differing).toEqual([]);
  }, 120_000);
});
