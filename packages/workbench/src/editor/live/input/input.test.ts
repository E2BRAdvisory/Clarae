// The input of the Live editor (A-W5b) on the mounted Milkdown editor: what typing, pasting and dropping
// do to the document, and what the file says afterwards. The user's keys are the real events or the
// ProseMirror calls the browser makes for them (`handleTextInput`, then the default insertion).
import { Fragment, Slice, type Node } from '@milkdown/kit/prose/model';
import {
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
} from '@milkdown/kit/prose/commands';
import { Selection, TextSelection, type Plugin } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { extract } from '@memobrain/markdown';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../../../reading/render';
import type { Suggestion } from '../../../app/api';
import { initI18n } from '../../../i18n';
import type { LiveEditor } from '../MilkdownAdapter';
import { EditorViewOf, openLive } from '../testing/mounted';
import { posAfter } from '../testing/helpers';
import { inertInput, type LiveInputApp } from './index';

vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => initI18n('en'));

const opened: { dispose(): void }[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.dispose();
  document.body.replaceChildren();
});

const sug = (over: Partial<Suggestion>): Suggestion => ({
  kind: 'note',
  label: 'X',
  path: 'X.md',
  detail: '',
  line: 0,
  score: 1,
  ...over,
});

interface Ed {
  editor: LiveEditor;
  view: EditorView;
  /** Types the characters one by one, as the browser hands them to ProseMirror. */
  type(text: string): void;
  /** Hands the text to ProseMirror in one piece, as a dictation, an emoji panel or a test that fills the editor does. */
  typeWhole(text: string): void;
  /** The caret at the end of the document. */
  end(): void;
  key(name: string, init?: KeyboardEventInit): KeyboardEvent;
  node(name: string): number;
}

async function open(raw: string, over: Parameters<typeof openLive>[1] = {}): Promise<Ed> {
  const live = await openLive(raw, over);
  opened.push(live);
  const view = EditorViewOf(live.editor);
  const type = (text: string): void => {
    for (const ch of text) {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (f) =>
        f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };
  const typeWhole = (text: string): void => {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, text, () => view.state.tr.insertText(text, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(text, from, to));
  };
  return {
    editor: live.editor,
    view,
    type,
    typeWhole,
    end: () => view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc))),
    key: (name, init = {}) => {
      const ev = new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      view.dom.dispatchEvent(ev);
      return ev;
    },
    node: (name) => {
      let n = 0;
      view.state.doc.descendants((x) => {
        if (x.type.name === name) n++;
      });
      return n;
    },
  };
}

const app = (over: Partial<LiveInputApp> = {}): LiveInputApp => ({ ...inertInput, ...over });

describe('what is typed as Obsidian syntax is the construct, not the text', () => {
  it('turns [[x]] into a wikilink, and ![[x]] into an embed, never into escaped brackets', async () => {
    const ed = await open('para\n');
    ed.end();
    ed.type(' see [[Note|alias]] and ![[pic.png|300]]');
    expect(ed.node('ofm_wikilink')).toBe(2);
    expect(ed.editor.text()).toBe('para see [[Note|alias]] and ![[pic.png|300]]\n');
    expect(ed.editor.text()).not.toContain('\\[');
  });

  it('leaves the caret after the node it made, and the text typed next outside it', async () => {
    const ed = await open('\n');
    ed.type('[[a]]');
    ed.type(' tail');
    expect(ed.editor.text()).toBe('[[a]] tail\n');
  });

  it('makes #tag a tag as the characters come, and not what a tag is not', async () => {
    const ed = await open('para\n');
    ed.end();
    ed.type(' #idea/sub and C# and #123 and (#in-paren');
    const text = ed.editor.text();
    expect(text).toBe('para #idea/sub and C# and #123 and (#in-paren\n');
    // the tags are marked, the others are text (which the file would write escaped)
    const marked: string[] = [];
    ed.view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'ofm_tag')) marked.push(n.text ?? '');
    });
    expect(marked).toEqual(['#idea/sub', '#in-paren']);
  });

  it('writes a typed tag unescaped even at the end of the block', async () => {
    const ed = await open('\n');
    ed.type('#tag');
    expect(ed.editor.text()).toBe('#tag\n');
  });

  it('makes ==highlight==, %%comment%%, a trailing ^id and [text](url)', async () => {
    const ed = await open('para\n');
    ed.end();
    ed.type(' ==hi== and %%note%% and [site](https://x.org)');
    expect(ed.editor.text()).toBe('para ==hi== and %%note%% and [site](https://x.org)\n');
    const marks = new Set<string>();
    ed.view.state.doc.descendants((n) => n.marks.forEach((m) => marks.add(m.type.name)));
    expect([...marks].sort()).toEqual(['link', 'ofm_highlight']);
    expect(ed.node('raw_inline')).toBe(1);
    ed.type(' ^abc');
    expect(ed.editor.text()).toBe('para ==hi== and %%note%% and [site](https://x.org) ^abc\n');
    const ids = new Set<string>();
    ed.view.state.doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'ofm_blockid')) ids.add(n.text ?? '');
    });
    expect([...ids]).toEqual(['^abc']);
  });

  it('does not make a ^id of what is not the end of the block, nor a link of an image', async () => {
    const ed = await open('para\n');
    ed.end();
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 3)));
    ed.type(' ^abc');
    const ids: string[] = [];
    ed.view.state.doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'ofm_blockid')) ids.push(n.text ?? '');
    });
    expect(ids).toEqual([]);
    ed.end();
    ed.type(' ![alt](a.png)');
    expect(ed.view.state.doc.textContent).toContain('![alt](a.png)');
  });

  it('marks nothing inside inline code', async () => {
    const ed = await open('`code` plain\n');
    const at = posAfter(ed.view.state.doc, 'cod');
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, at)));
    ed.type(' [[x]]');
    expect(ed.node('ofm_wikilink')).toBe(0);
  });

  it('types into an empty wikilink itself: the browser has no place for a caret in it', async () => {
    const ed = await open('para\n');
    ed.end();
    ed.editor.exec('wikilink');
    const press = (ch: string): KeyboardEvent => {
      const ev = new KeyboardEvent('keypress', {
        bubbles: true,
        cancelable: true,
        charCode: ch.charCodeAt(0),
      });
      ed.view.dom.dispatchEvent(ev);
      return ev;
    };
    expect(press('T').defaultPrevented).toBe(true);
    expect(ed.editor.text()).toBe('para[[T]]\n');
    // once it has a text node the browser has its caret in it: the key is left to it
    expect(press('a').defaultPrevented).toBe(false);
    expect(ed.view.state.selection.$from.parent.type.name).toBe('ofm_wikilink');
  });

  it('types next to a wikilink outside it: after the node and before it', async () => {
    const press = (ed: Ed, ch: string): void => {
      ed.view.dom.dispatchEvent(
        new KeyboardEvent('keypress', {
          bubbles: true,
          cancelable: true,
          charCode: ch.charCodeAt(0),
        }),
      );
    };
    const ed = await open('a [[x]] b\n');
    const node = posAfter(ed.view.state.doc, 'a ');
    // after the node
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, node + ed.view.state.doc.nodeAt(node)!.nodeSize),
      ),
    );
    press(ed, 'Z');
    expect(ed.editor.text()).toBe('a [[x]]Z b\n');
    // before it
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, node)));
    press(ed, 'Y');
    expect(ed.editor.text()).toBe('a Y[[x]]Z b\n');
  });

  it('leaves a wikilink with ] and takes an empty one away with Backspace', async () => {
    const ed = await open('para\n');
    ed.end();
    ed.editor.exec('wikilink'); // the caret is in the empty node
    ed.type('abc');
    ed.type(']]x');
    expect(ed.editor.text()).toBe('para[[abc]]x\n');
    const empty = await open('\n');
    empty.editor.exec('wikilink');
    expect(empty.editor.text()).toBe('[[]]\n');
    empty.key('Backspace');
    expect(empty.node('ofm_wikilink')).toBe(0);
  });
});

describe('a reference typed as text is the reference, not escaped text (N2)', () => {
  it('writes [^1] as typed, with the definition before it, after it, or nowhere', async () => {
    const after = await open('a\n\n[^1]: note\n');
    after.view.dispatch(
      after.view.state.tr.setSelection(
        TextSelection.create(after.view.state.doc, posAfter(after.view.state.doc, 'a')),
      ),
    );
    after.type('[^1] more');
    expect(after.editor.text()).toBe('a[^1] more\n\n[^1]: note\n');
    expect(after.node('raw_inline')).toBe(1);

    const none = await open('a\n');
    none.end();
    none.type(' see[^n] end');
    expect(none.editor.text()).toBe('a see[^n] end\n');
  });

  it('does the same when the closing bracket is typed over the one auto-pairing added', async () => {
    const ed = await open('a\n', { input: app({ autoPair: () => true }) });
    ed.end();
    ed.type(' [^1]');
    expect(ed.editor.text()).toBe('a [^1]\n');
    expect(ed.node('raw_inline')).toBe(1);
  });

  it('writes [text][ref] as typed when the note defines ref, and leaves a[i][j] as text', async () => {
    const ed = await open('a\n\n[ref]: https://x.org\n');
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, 'a')),
      ),
    );
    ed.type(' [text][Ref] and [ref][] and x[i][j]');
    expect(ed.editor.text()).toBe(
      'a [text][Ref] and [ref][] and x\\[i]\\[j]\n\n[ref]: https://x.org\n',
    );
    expect(ed.node('raw_inline')).toBe(2);
  });

  it('keeps the marks of the text it is typed in: bold stays one run, a link stays one link (R3)', async () => {
    const bold = await open('**ab**\n');
    bold.view.dispatch(
      bold.view.state.tr.setSelection(
        TextSelection.create(bold.view.state.doc, posAfter(bold.view.state.doc, 'a')),
      ),
    );
    bold.type('[^1]');
    expect(bold.node('raw_inline')).toBe(1);
    expect(bold.editor.text()).toBe('**a[^1]b**\n');
    const link = await open('[link ab](https://x.org)\n');
    link.view.dispatch(
      link.view.state.tr.setSelection(
        TextSelection.create(link.view.state.doc, posAfter(link.view.state.doc, 'link a')),
      ),
    );
    link.type('[^1]');
    expect(link.node('raw_inline')).toBe(1);
    expect(link.editor.text()).toBe('[link a[^1]b](https://x.org)\n');
  });

  it('stays text inside code', async () => {
    const ed = await open('a `xy`\n');
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, 'x')),
      ),
    );
    ed.type('[^1]');
    expect(ed.editor.text()).toBe('a `x[^1]y`\n');
    expect(ed.node('raw_inline')).toBe(0);
  });
});

describe('a text that comes whole is read as if it had been typed', () => {
  it('makes the link of [[Second]] in the middle or at the end of the text, never an escaped one', async () => {
    const ed = await open('\n');
    ed.typeWhole('Hello [[Second]]');
    expect(ed.node('ofm_wikilink')).toBe(1);
    expect(ed.editor.text()).toBe('Hello [[Second]]\n');
    const mid = await open('\n');
    mid.typeWhole('see [[A]] and #tag and ==hi== now');
    expect(mid.node('ofm_wikilink')).toBe(1);
    expect(mid.editor.text()).toBe('see [[A]] and #tag and ==hi== now\n');
    const marks = new Set<string>();
    mid.view.state.doc.descendants((n) => n.marks.forEach((m) => marks.add(m.type.name)));
    expect([...marks].sort()).toEqual(['ofm_highlight', 'ofm_tag']);
  });

  it('closes a link that was started before, and does not pair brackets that came whole', async () => {
    const ed = await open('\n', { input: app({ autoPair: () => true }) });
    ed.type('x ');
    ed.typeWhole('(a) [t](u)');
    expect(ed.editor.text()).toBe('x (a) [t](u)\n');
    let linked = false;
    ed.view.state.doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'link')) linked = true;
    });
    expect(linked).toBe(true);
  });

  it('leaves alone a text without such characters, one with line breaks and a composition', async () => {
    const ed = await open('\n');
    ed.typeWhole('plain words');
    expect(ed.editor.text()).toBe('plain words\n');
    const lines = await open('\n');
    lines.typeWhole('[[a]]\n[[b]]');
    expect(lines.node('ofm_wikilink')).toBe(0);
  });
});

describe('auto-pairing (the autoPair setting)', () => {
  const on = (): LiveInputApp => app({ autoPair: () => true });

  it('types the closing character with the opening one, and over it', async () => {
    const ed = await open('\n', { input: on() });
    ed.type('(');
    expect(ed.editor.text()).toBe('()\n');
    ed.type('x');
    ed.type(')');
    expect(ed.editor.text()).toBe('(x)\n');
    expect(ed.view.state.selection.from).toBe(ed.view.state.doc.content.size - 1);
  });

  it('wraps the selection, and takes a pair with Backspace', async () => {
    const ed = await open('word\n', { input: on() });
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 1, 5)));
    ed.type('"');
    expect(ed.editor.text()).toBe('"word"\n');
    const pair = await open('\n', { input: on() });
    pair.type('[');
    pair.key('Backspace');
    expect(pair.editor.text()).toBe('\n');
  });

  it('does not pair a quote after a word, nor in front of text', async () => {
    const ed = await open('don\n', { input: on() });
    ed.end();
    ed.type("'t");
    expect(ed.editor.text()).toBe("don't\n");
    const before = await open('word\n', { input: on() });
    before.view.dispatch(
      before.view.state.tr.setSelection(TextSelection.create(before.view.state.doc, 1)),
    );
    before.type('(');
    expect(before.editor.text()).toBe('(word\n');
  });

  it('makes [[ an empty wikilink with the caret in it, and [text](url) a link typed over the pairs', async () => {
    const ed = await open('\n', { input: on() });
    ed.type('[[');
    expect(ed.node('ofm_wikilink')).toBe(1);
    ed.type('Note');
    expect(ed.editor.text()).toBe('[[Note]]\n');
    const link = await open('\n', { input: on() });
    link.type('[site](u)');
    expect(link.editor.text()).toBe('[site](u)\n');
    let marked = false;
    link.view.state.doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'link')) marked = true;
    });
    expect(marked).toBe(true);
  });

  it('is off with the setting off, in read-only, and in a code span', async () => {
    const off = await open('\n', { input: app({ autoPair: () => false }) });
    off.type('(');
    expect(off.editor.text()).toBe('(\n');
    const ro = await open('\n', { input: on(), readOnly: true });
    ro.type('(');
    expect(ro.editor.text()).toBe('\n');
  });
});

describe('the task cycle and the box of a custom state', () => {
  const cycle = async (raw: string): Promise<string[]> => {
    const ed = await open(raw);
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 3)));
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      expect(ed.editor.exec('task')).toBe(true);
      seen.push(ed.editor.text());
    }
    return seen;
  };

  it('goes plain, open, done, plain as editor:task does in Source', async () => {
    expect(await cycle('- item\n')).toEqual(['- [ ] item\n', '- [x] item\n', '- item\n']);
  });

  it('takes a custom state back to a plain item, and cycles every item of the selection', async () => {
    expect((await cycle('- [/] item\n'))[0]).toBe('- item\n');
    const ed = await open('- a\n- [ ] b\n- [x] c\n');
    const { doc } = ed.view.state;
    ed.view.dispatch(
      ed.view.state.tr.setSelection(TextSelection.create(doc, 3, doc.content.size - 3)),
    );
    expect(ed.editor.exec('task')).toBe(true);
    expect(ed.editor.text()).toBe('- [ ] a\n- [x] b\n- c\n');
  });

  it('shows a custom state as a box, and a click makes the item an open task', async () => {
    const changes = vi.fn();
    const ed = await open('- [/] half\n- plain\n', { onChange: changes });
    const box = ed.view.dom.querySelector('.ofm-task-state') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.textContent).toBe('[/]');
    expect(box.dataset['state']).toBe('/');
    expect(changes).not.toHaveBeenCalled();
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(ed.editor.text()).toBe('- [ ] half\n- plain\n');
    expect(changes).toHaveBeenCalledTimes(1);
    expect(ed.view.dom.querySelector('.ofm-task-state')).toBeNull();
  });
});

describe('the box of a task is a checkbox', () => {
  const boxes = (ed: Ed): HTMLElement[] => [
    ...ed.view.dom.querySelectorAll<HTMLElement>('[role="checkbox"]'),
  ];
  const box = async (ed: Ed, n = 0): Promise<HTMLElement> => {
    await vi.waitFor(() => expect(boxes(ed).length).toBeGreaterThan(n));
    return boxes(ed)[n] as HTMLElement;
  };

  it('has the role, the state, a name and a place in the tab order', async () => {
    const ed = await open('- [ ] open\n- [x] done\n- [/] custom\n- plain\n');
    const open_ = await box(ed, 0);
    expect(open_.getAttribute('aria-checked')).toBe('false');
    expect(open_.getAttribute('aria-label')).toBe('Task: open');
    expect(open_.tabIndex).toBe(0);
    expect((await box(ed, 1)).getAttribute('aria-checked')).toBe('true');
    const custom = await box(ed, 2);
    expect(custom.getAttribute('aria-checked')).toBe('mixed');
    expect(custom.textContent).toBe('[/]');
    expect(custom.getAttribute('aria-label')).toBe('Task: custom');
    expect(custom.tabIndex).toBe(0);
    expect(boxes(ed)).toHaveLength(3);
  });

  it('toggles with Space and Enter, and keeps the focus on the box that replaces it', async () => {
    const ed = await open('- [ ] one\n- [ ] two\n');
    const second = await box(ed, 1);
    second.focus();
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    second.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(ed.editor.text()).toBe('- [ ] one\n- [x] two\n');
    second.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(ed.editor.text()).toBe('- [ ] one\n- [ ] two\n');
    await vi.waitFor(() => expect(document.activeElement).toBe(boxes(ed)[1]));
    expect(boxes(ed)[1]?.getAttribute('aria-checked')).toBe('false');
  });

  it('takes the click of an assistive technology (no pointer), and not twice a click of the mouse', async () => {
    const ed = await open('- [ ] one\n');
    const one = await box(ed);
    one.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    expect(ed.editor.text()).toBe('- [x] one\n');
    // a click that follows the pointer press of a mouse (detail 1) is the press's, which has toggled already
    (await box(ed)).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
    );
    expect(ed.editor.text()).toBe('- [x] one\n');
  });

  it('is ticked by a press of the pointer on it, once, with one change of the document', async () => {
    const changes = vi.fn();
    const ed = await open('- [ ] one\n', { onChange: changes });
    const one = await box(ed);
    one.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(ed.editor.text()).toBe('- [x] one\n');
    expect(changes).toHaveBeenCalledTimes(1);
    (await box(ed)).dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(ed.editor.text()).toBe('- [ ] one\n');
  });

  it('opens the box of a custom state with Space, as a click does', async () => {
    const ed = await open('- [/] half\n');
    const custom = await box(ed);
    custom.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    expect(ed.editor.text()).toBe('- [ ] half\n');
  });

  it('does not take a key typed in the text', async () => {
    const ed = await open('- [ ] one\n');
    await box(ed);
    expect(ed.key(' ').defaultPrevented).toBe(false);
    expect(ed.editor.text()).toBe('- [ ] one\n');
  });

  it('is left by Tab and Shift+Tab as any control is, and the text is not written (N1)', async () => {
    const key = (el: Element, init: KeyboardEventInit): KeyboardEvent => {
      const ev = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
        ...init,
      });
      el.dispatchEvent(ev);
      return ev;
    };
    for (const raw of ['- [ ] one\n- [ ] two\n\npara\n', '- [/] one\n- [ ] two\n\npara\n']) {
      const ed = await open(raw);
      await box(ed, 1);
      // the caret is left in the paragraph, far from the box that has the focus
      ed.view.dispatch(
        ed.view.state.tr.setSelection(
          TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, 'pa')),
        ),
      );
      // every box: Crepe's and, in the second note, the one of the custom state (`.ofm-task-state`)
      expect(boxes(ed)).toHaveLength(2);
      for (const target of boxes(ed)) {
        target.focus();
        expect(key(target, {}).defaultPrevented).toBe(false);
        expect(key(target, { shiftKey: true }).defaultPrevented).toBe(false);
      }
      expect(ed.editor.text()).toBe(raw);
      // in the text the key is still the editor's (a tab goes in)
      expect(ed.key('Tab').defaultPrevented).toBe(true);
      expect(ed.editor.text()).toBe(raw.replace('para', 'pa\tra'));
    }
  });

  it('names the box of a custom state with the item, and keeps the focus on the box after Space (N5)', async () => {
    const ed = await open('- [/] half\n- [-] gone\n');
    const [one, two] = [await box(ed, 0), await box(ed, 1)];
    expect(one.getAttribute('aria-label')).toBe('Task: half');
    expect(two.getAttribute('aria-label')).toBe('Task: gone');
    two.focus();
    two.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(ed.editor.text()).toBe('- [/] half\n- [ ] gone\n');
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('checkbox'));
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('false');
  });
});

describe('the text of a task stays its first line', () => {
  /** A block of the schema pasted at the start of the text of the first task (the caret is there). */
  const pasteAtStart = async (raw: string, make: (e: Ed) => Node[], word = 'a'): Promise<Ed> => {
    const ed = await open(raw);
    const { doc } = ed.view.state;
    const at = posAfter(doc, word) - word.length;
    const tr = ed.view.state.tr
      .setSelection(TextSelection.create(doc, at))
      .replace(at, at, new Slice(Fragment.fromArray(make(ed)), 0, 0));
    // a paste leaves the caret in what it brought
    ed.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, posAfter(tr.doc, 'x'))));
    return ed;
  };
  const nodes = (ed: Ed) => {
    const n = ed.view.state.schema.nodes;
    const p = (t: string): Node => n['paragraph']!.create(null, ed.view.state.schema.text(t));
    const item = (t: string): Node => n['list_item']!.create(null, p(t));
    return {
      n,
      p,
      item,
      list: (...t: string[]): Node => n['bullet_list']!.create(null, t.map(item)),
    };
  };

  it('keeps a list pasted at the start of it after the text: the box stays on the item, the note reopens', async () => {
    const ed = await pasteAtStart('- [ ] a\n- [x] b\n', (e) => [nodes(e).list('x', 'y')]);
    expect(ed.editor.text()).toBe('- [ ] a\n  - x\n  - y\n- [x] b\n');
    const first = ed.view.state.doc.firstChild!.firstChild!;
    expect(first.attrs['checked']).toBe(false);
    expect(first.firstChild!.textContent).toBe('a');
    // the file that was written is a note the editor can open, with the tasks in it
    const again = await open(ed.editor.text());
    expect(again.node('list_item')).toBe(4);
    expect(again.editor.text()).toBe(ed.editor.text());
  });

  it('keeps the caret where it was after the move', async () => {
    const ed = await pasteAtStart('- [ ] a\n', (e) => [nodes(e).list('x')]);
    // the caret was in the pasted list, and the list moved after the text
    expect(ed.view.state.selection.$from.parent.textContent).toBe('x');
  });

  it('writes a rule typed at the start of its text after it, as `***` (a `---` under the text would underline it)', async () => {
    const ed = await open('- [ ] a\n- [x] b\n');
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 3)));
    ed.type('---');
    expect(ed.editor.text()).toBe('- [ ] a\n  ***\n- [x] b\n');
    expect((await open(ed.editor.text())).node('hr')).toBe(1);
  });

  it('does the same for a code block, and for a task of a quote', async () => {
    const code = await pasteAtStart('- [x] a\n', (e) => [
      e.view.state.schema.nodes['code_block']!.create(
        { language: 'js' },
        e.view.state.schema.text('x'),
      ),
    ]);
    expect(code.editor.text()).toBe('- [x] a\n  ```js\n  x\n  ```\n');
    const quote = await open('> - [ ] a\n> - [x] b\n');
    quote.view.dispatch(
      quote.view.state.tr.setSelection(TextSelection.create(quote.view.state.doc, 4)),
    );
    quote.type('---');
    expect(quote.editor.text()).toBe('> - [ ] a\n>   ***\n> - [x] b\n');
  });

  it('leaves the lines of the note it did not touch as the file has them (a CRLF note with closed headings)', async () => {
    const raw = '# Alpha #\r\n\r\n- [ ] task\r\n- [x] b\r\n\r\n# Beta #\r\n';
    const ed = await pasteAtStart(raw, (e) => [nodes(e).list('x')], 'task');
    expect(ed.editor.text()).toBe(raw.replace('- [ ] task\r\n', '- [ ] task\r\n  - x\r\n'));
  });

  it('writes a task that has no text left and holds blocks as an item, never with the box outside it', async () => {
    const ed = await open('- [ ] a\n  - x\n- [x] b\n');
    // the text of the first task is deleted: an empty paragraph, then the list
    const at = posAfter(ed.view.state.doc, 'a');
    ed.view.dispatch(ed.view.state.tr.delete(at - 1, at));
    expect(ed.editor.text()).not.toMatch(/^\[.\]/m);
    expect(ed.editor.text()).toBe('-\n  - x\n- [x] b\n');
    // the list is raw on the way back (an item that starts with a list is no item for the editor), as the file says it
    expect((await open(ed.editor.text())).editor.text()).toBe(ed.editor.text());
  });
});

describe('the lists in the accessibility tree', () => {
  const raw = '- one\n  1. first\n  2. second\n- [ ] open\n- [x] done\n';

  it('has the items as the children of the list, and the layout of an item as no role of its own', async () => {
    const ed = await open(raw);
    await vi.waitFor(() => expect(ed.view.dom.querySelectorAll('li.list-item').length).toBe(5));
    // no `div` that is no item between a list and what it holds: the item is the `div` Crepe puts there
    for (const list of ed.view.dom.querySelectorAll('ul, ol')) {
      for (const child of list.children)
        expect(child.getAttribute('role'), child.outerHTML).toBe('listitem');
    }
    for (const li of ed.view.dom.querySelectorAll('li.list-item')) {
      expect(li.getAttribute('role')).toBe('none');
      expect(li.parentElement?.getAttribute('role')).toBe('listitem');
    }
    // the bullets and the numbers are said by the list; the boxes of the tasks are checkboxes and stay
    const markers = [...ed.view.dom.querySelectorAll('li.list-item > .label-wrapper')];
    expect(markers.filter((m) => m.getAttribute('aria-hidden') === 'true')).toHaveLength(3);
    expect(ed.view.dom.querySelectorAll('[role="checkbox"][aria-hidden]')).toHaveLength(0);
    expect(
      ed.view.dom.querySelectorAll('.label-wrapper[aria-hidden] [role="checkbox"]'),
    ).toHaveLength(0);
  });

  it('reads the marker again when an item changes in place: a bullet that becomes a task has a checkbox, and a task that becomes a bullet has none', async () => {
    const ed = await open('- foo\n- bar\n');
    await vi.waitFor(() => expect(ed.view.dom.querySelectorAll('li.list-item').length).toBe(2));
    const hiddenBoxes = (): number =>
      ed.view.dom.querySelectorAll('.label-wrapper[aria-hidden] [role="checkbox"]').length;
    const hiddenMarkers = (): number =>
      ed.view.dom.querySelectorAll('.label-wrapper[aria-hidden="true"]').length;
    expect(hiddenMarkers()).toBe(2);
    // `[ ] ` typed at the start of the text: the item of the view is the same one, its attribute `checked` is set
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 3)));
    ed.type('[ ] ');
    expect(ed.editor.text()).toBe('- [ ] foo\n- bar\n');
    await vi.waitFor(() =>
      expect(ed.view.dom.querySelectorAll('[role="checkbox"]').length).toBe(1),
    );
    await vi.waitFor(() => expect(hiddenMarkers()).toBe(1));
    expect(hiddenBoxes()).toBe(0);
    expect(
      ed.view.dom
        .querySelector('[role="checkbox"]')
        ?.closest('.label-wrapper')
        ?.hasAttribute('aria-hidden'),
    ).toBe(false);
    // and back: the cycle takes the task through done to a plain item, whose glyph is the list's to say
    ed.editor.exec('task');
    ed.editor.exec('task');
    expect(ed.editor.text()).toBe('- foo\n- bar\n');
    await vi.waitFor(() =>
      expect(ed.view.dom.querySelectorAll('[role="checkbox"]').length).toBe(0),
    );
    await vi.waitFor(() => expect(hiddenMarkers()).toBe(2));
  });

  it('gives the roles to the item a paste made, and names the box of a task with its text', async () => {
    const ed = await open('- [ ] one\n');
    await vi.waitFor(() =>
      expect(ed.view.dom.querySelectorAll('[role="checkbox"]').length).toBe(1),
    );
    const box = (n: number): HTMLElement =>
      ed.view.dom.querySelectorAll<HTMLElement>('[role="checkbox"]')[n] as HTMLElement;
    expect(box(0).getAttribute('aria-label')).toBe('Task: one');
    // typing in the text renames its box, and an item made by a split is an item of the tree at once
    ed.end();
    ed.type('!');
    ed.key('Enter');
    ed.type('two');
    await vi.waitFor(() => expect(ed.view.dom.querySelectorAll('li.list-item').length).toBe(2));
    for (const li of ed.view.dom.querySelectorAll('li.list-item')) {
      expect(li.getAttribute('role')).toBe('none');
    }
    await vi.waitFor(() => expect(box(0).getAttribute('aria-label')).toBe('Task: one!'));
    // the box that is drawn again after a click is named again
    box(0).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    await vi.waitFor(() => expect(box(0).getAttribute('aria-checked')).toBe('true'));
    await vi.waitFor(() => expect(box(0).getAttribute('aria-label')).toBe('Task: one!'));
  });
});

describe('blanks typed before a construct that opens a paragraph', () => {
  const links = (md: string): number => extract('t', md).links.length;

  it('are text, as the blanks that open a paragraph of plain text are: never an indented code block', async () => {
    for (const [raw, probe] of [
      ['[[a]] text\n', '[[a]]'],
      ['#tag text\n', '#tag'],
      ['%%c%% text\n', '%%c%%'],
    ] as const) {
      for (const blanks of ['    ', '\t', '  ']) {
        const ed = await open(raw);
        ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 1)));
        ed.type(blanks);
        const text = ed.editor.text();
        expect(text, JSON.stringify([raw, blanks])).toContain(probe);
        expect(text).toMatch(/^&#x(?:20|9);/);
        // Reading: a paragraph, not `<pre><code>`
        expect(renderMarkdown(text)).not.toContain('<pre>');
      }
    }
    const ed = await open('[[a]] text\n');
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 1)));
    ed.type('    ');
    expect(links(ed.editor.text())).toBe(1);
    // and the note opens again in Live as a paragraph
    expect((await open(ed.editor.text())).node('raw_block')).toBe(0);
  });

  it('are the same in a list item', async () => {
    const item = await open('- [[a]] text\n- b\n');
    item.view.dispatch(
      item.view.state.tr.setSelection(TextSelection.create(item.view.state.doc, 3)),
    );
    item.type('    ');
    expect(item.editor.text()).toBe('- &#x20;   [[a]] text\n- b\n');
    expect(renderMarkdown(item.editor.text())).not.toContain('<pre>');
  });
});

describe('the name of a wikilink keeps what the file reads as a link', () => {
  const note = 'see [[ab]] and [[cd]] #tag\n';
  const inName = async (raw = note): Promise<Ed> => {
    const ed = await open(raw);
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, 'a')),
      ),
    );
    return ed;
  };

  it('does not take the second character of `%%` or `$$`: they would open a comment or a formula over the rest of the note', async () => {
    for (const pair of ['%%', '$$']) {
      const ed = await inName();
      ed.type(pair);
      expect(ed.editor.text()).toBe(`see [[a${pair[0]}b]] and [[cd]] #tag\n`);
      const found = extract('t', ed.editor.text());
      expect(found.links.map((l) => l.target)).toEqual(['a' + pair[0] + 'b', 'cd']);
      expect(found.tags).toHaveLength(1);
    }
    // a pair made by what is typed in the middle of one is no pair either
    const ed = await inName();
    ed.type('%x');
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, 'a%')),
      ),
    );
    ed.type('%');
    expect(ed.editor.text()).toBe('see [[a%xb]] and [[cd]] #tag\n');
  });

  it('does not take a `[`, which no name of a link has (`[[a[b]]` is no link for the file)', async () => {
    const ed = await inName();
    ed.type('[t](u)');
    expect(ed.editor.text()).toBe('see [[at(u)b]] and [[cd]] #tag\n');
  });

  it('does not close an inline formula (its rule would cut the link in two), and takes a lone `$` and `%`', async () => {
    const ed = await inName();
    ed.type('$x$');
    expect(ed.editor.text()).toBe('see [[a$xb]] and [[cd]] #tag\n');
    expect(ed.node('math_inline')).toBe(0);
    const price = await inName();
    price.type('50% off $5 ');
    expect(price.editor.text()).toBe('see [[a50% off $5 b]] and [[cd]] #tag\n');
  });

  it('takes pasted text as it takes typed text: one line, no bracket, nothing that opens a comment or a formula', async () => {
    const paste = (ed: Ed, text: string): Event => {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', {
        value: { files: [], getData: (t: string) => (t === 'text/plain' ? text : '') },
      });
      ed.view.dom.dispatchEvent(ev);
      return ev;
    };
    for (const [pasted, name] of [
      ['x%%\nc\n%%y', 'ax% c %yb'],
      ['x$$y', 'ax$yb'],
      ['[^1] ref', 'a^1 refb'],
      ['[x]: https://x.org', 'ax: https://x.orgb'],
      ['[t](u)', 'at(u)b'],
      ['two\nlines', 'atwo linesb'],
    ] as const) {
      const ed = await inName();
      expect(paste(ed, pasted).defaultPrevented, pasted).toBe(true);
      const written = ed.editor.text();
      expect(written, pasted).toBe(`see [[${name}]] and [[cd]] #tag\n`);
      // the file says the two links, and the note is the one that opens again
      expect(extract('t', written).links.map((l) => l.target)).toEqual([name, 'cd']);
      expect(extract('t', written).tags).toHaveLength(1);
      const again = await open(written);
      expect(again.node('ofm_wikilink')).toBe(2);
      expect(again.node('raw_block')).toBe(0);
      expect(again.editor.text()).toBe(written);
    }
  });

  it('takes nothing of a paste made only of what a name does not take, and replaces the selection with what it takes', async () => {
    const ed = await inName();
    const paste = (text: string): void => {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', {
        value: { files: [], getData: (t: string) => (t === 'text/plain' ? text : '') },
      });
      ed.view.dom.dispatchEvent(ev);
    };
    paste('[[]]');
    expect(ed.editor.text()).toBe(note);
    // `ab` selected: the pasted name replaces it
    const at = posAfter(ed.view.state.doc, 'ab');
    ed.view.dispatch(
      ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, at - 2, at)),
    );
    paste('x\ny');
    expect(ed.editor.text()).toBe('see [[x y]] and [[cd]] #tag\n');
  });

  it('takes the text of an HTML paste that has blocks, in the target and in the label: the link is not split, the alias not cut off', async () => {
    const aliased = 'see [[Note|label text]] and [[cd]] #tag\n';
    const pasteHtml = (ed: Ed, html: string): Event => {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', {
        value: { files: [], getData: (t: string) => (t === 'text/html' ? html : '') },
      });
      ed.view.dispatch(ed.view.state.tr); // the paste reads the selection the editor has
      ed.view.dom.dispatchEvent(ev);
      return ev;
    };
    // inside the target, at the end of the target, inside the label, at the end of the label
    for (const after of ['No', 'Note', 'la', 'label text']) {
      for (const html of [
        '<p>a</p><p>b</p>',
        '<ul><li>a</li><li>b</li></ul>',
        '<h1>a</h1>b<br>c',
      ]) {
        const ed = await inName(aliased);
        const at = posAfter(ed.view.state.doc, after);
        ed.view.dispatch(
          ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, at)),
        );
        expect(pasteHtml(ed, html).defaultPrevented, `${after} ${html}`).toBe(true);
        const written = ed.editor.text();
        const found = extract('t', written).links;
        expect(found, `${after} ${html}: ${written}`).toHaveLength(2);
        // the target is the one the name had (with the words inside it when the caret was in it), the label whole
        expect(written, `${after} ${html}`).toMatch(
          /^see \[\[[^\n\]]*\|[^\n\]]*\]\] and \[\[cd\]\] #tag\n$/,
        );
        expect(ed.node('ofm_wikilink'), html).toBe(2);
        const again = await open(written);
        expect(again.node('raw_block')).toBe(0);
        expect(again.editor.text()).toBe(written);
      }
    }
    // the exact text, in the middle of a target
    const ed = await inName(aliased);
    const at = posAfter(ed.view.state.doc, 'No');
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, at)));
    pasteHtml(ed, '<p>a</p><p>b</p>');
    expect(ed.editor.text()).toBe('see [[Noa bte|label text]] and [[cd]] #tag\n');
  });

  it('is left by Enter, which does not cut the node in two nor leave an empty one', async () => {
    const ed = await inName();
    const ev = ed.key('Enter');
    expect(ev.defaultPrevented).toBe(true);
    expect(ed.editor.text()).toBe(note);
    expect(ed.node('ofm_wikilink')).toBe(2);
    expect(ed.view.state.selection.$from.parent.type.name).toBe('paragraph');
    // at the edges of an empty name too
    const empty = await open('x  y\n');
    const made = empty.view.state.tr.insert(
      3,
      empty.view.state.schema.nodes['ofm_wikilink']!.create({ embed: false }),
    );
    empty.view.dispatch(made.setSelection(TextSelection.create(made.doc, 4)));
    expect(empty.view.state.selection.$from.parent.type.name).toBe('ofm_wikilink');
    empty.key('Enter');
    expect(empty.node('paragraph')).toBe(1);
    expect(empty.node('ofm_wikilink')).toBe(1);
  });
});

describe('a math block keeps its fence', () => {
  const note = '$$\nx\n$$\n\nsee [[a]]\n';
  const inBlock = async (): Promise<Ed> => {
    const ed = await open(note);
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, 'x')),
      ),
    );
    return ed;
  };

  it('does not take the second `$` of a `$$`: the file would write `$$$`, which the index does not read', async () => {
    for (const typed of ['$$', '$ $', '$$$']) {
      const ed = await inBlock();
      ed.type(typed);
      const written = ed.editor.text();
      expect(written, typed).not.toContain('$$$');
      expect(written, typed).toBe(`$$\nx${typed.includes(' ') ? '$ $' : '$'}\n$$\n\nsee [[a]]\n`);
      // the block and the link after it are what the index finds
      expect(extract('t', written).links.map((l) => l.target)).toEqual(['a']);
      expect((await open(written)).node('code_block')).toBe(1);
    }
  });

  it('takes the text typed whole, a paste that holds `$$`, and keeps the caret after what was taken', async () => {
    const whole = await inBlock();
    whole.typeWhole('a$$b');
    expect(whole.editor.text()).toBe('$$\nxa$b\n$$\n\nsee [[a]]\n');
    expect(whole.view.state.selection.from).toBe(posAfter(whole.view.state.doc, 'xa$b'));
    const ed = await inBlock();
    ed.view.dispatch(ed.view.state.tr.insertText('$$$y'));
    expect(ed.editor.text()).toBe('$$\nx$y\n$$\n\nsee [[a]]\n');
  });

  it('does not touch a note that is only opened, nor a block that an edit did not change', async () => {
    const ed = await open(note);
    ed.end();
    ed.type('!');
    expect(ed.editor.text()).toBe(note.replace('[[a]]', '[[a]]!'));
  });
});

describe('a heading with a reference or an address in it stays a heading when the note is opened again', () => {
  it('keeps `[^1]` (no definition) and an address pasted next to the title as the text of the heading', async () => {
    for (const [typed, text] of [
      ['[^1]', '## Title[^1]\n'],
      [' [^1]', '## Title [^1]\n'],
      ['https://x.org', '## Titlehttps://x.org\n'],
    ] as const) {
      const ed = await open('## Title\n');
      ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 6)));
      ed.type(typed);
      const written = ed.editor.text();
      expect(written, typed).toBe(
        text.replace('Title ', typed.startsWith(' ') ? 'Title ' : 'Title'),
      );
      const again = await open(written);
      expect(again.node('heading'), typed).toBe(1);
      expect(again.node('raw_block'), typed).toBe(0);
      expect(again.editor.text()).toBe(written);
    }
  });

  it('keeps a title or paragraph a title or paragraph with its mark when `[^1]` or `.` is typed at the end of an emphasis a letter follows', async () => {
    for (const raw of ['# *u*Roadmap\n', '# **u**Roadmap\n', 'para *u*Roadmap\n']) {
      for (const typed of ['[^1]', '.']) {
        const ed = await open(raw);
        ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 2)));
        if (raw.startsWith('para')) {
          ed.view.dispatch(
            ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 7)),
          );
        }
        ed.type(typed);
        const written = ed.editor.text();
        const again = await open(written);
        const where = `${JSON.stringify(raw)} + ${typed}: ${JSON.stringify(written)}`;
        expect(again.node('raw_block'), where).toBe(0);
        expect(again.node(raw.startsWith('#') ? 'heading' : 'paragraph'), where).toBe(1);
        // the mark is still there (a closing delimiter that no letter can follow after punctuation is no delimiter)
        const mark = raw.includes('**') ? 'strong' : 'emphasis';
        let marked = 0;
        again.view.state.doc.descendants((n) => {
          if (n.marks.some((m) => m.type.name === mark)) marked++;
        });
        expect(marked, where).toBeGreaterThan(0);
        expect(again.editor.text(), where).toBe(written);
      }
    }
  });

  it('is edited as a heading, and the outline reads the text typed (no backslash in the name)', async () => {
    const ed = await open('## Title [^1]\n\n## Next\n');
    expect(ed.node('heading')).toBe(2);
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, '[^1]')),
      ),
    );
    ed.type('x');
    expect(ed.editor.text()).toBe('## Title [^1]x\n\n## Next\n');
    expect(extract('t', ed.editor.text()).headings.map((h) => h.text)).toEqual([
      'Title [^1]x',
      'Next',
    ]);
  });
});

describe('Enter over a selection that spans blocks', () => {
  // `splitBlock` of the base keymap throws (`TypeError`, `RangeError`) where the range takes whole blocks with it
  const enter = chainCommands(newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock);

  it('throws as it is: this is what the key of the base keymap did with these ranges', async () => {
    for (const [raw, from, to] of [
      ['| img |\n|---|\n| x |\n\npara\n', 1, 23],
      ['a\n\n[x]: http://u\n\nb\n', 1, 3],
    ] as const) {
      const ed = await open(raw);
      ed.view.dispatch(
        ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, from, to)),
      );
      expect(() => enter(ed.view.state, ed.view.dispatch.bind(ed.view)), raw).toThrow();
    }
  });

  it('deletes the range and splits at the caret that is left, whatever the range took', async () => {
    for (const [raw, from, to] of [
      ['| img |\n|---|\n| x |\n\npara\n', 1, 23],
      ['a\n\n[x]: http://u\n\nb\n', 1, 3],
      ['- a\n  - b\n- c\n\npara\n', 4, 17],
    ] as const) {
      const ed = await open(raw);
      ed.view.dispatch(
        ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, from, to)),
      );
      const before = ed.editor.text();
      const ev = ed.key('Enter');
      // the range is gone (a range that took the whole note leaves an empty paragraph, which is all selected),
      // and the key did what is left to do: a split at the caret in a block of text, nothing otherwise
      expect(ed.editor.text(), raw).not.toBe(before);
      expect(ev.defaultPrevented || ed.view.state.selection.$from.parent.isTextblock, raw).toBe(
        true,
      );
      // and what is written is a note the editor opens again
      const written = ed.editor.text();
      expect((await open(written)).editor.text(), raw).toBe(written);
    }
  });

  it('leaves a range inside one block, a caret, Shift+Enter and a read-only editor to the key', async () => {
    const ed = await open('one two three\n');
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 4, 7)));
    ed.key('Enter');
    expect(ed.editor.text()).toBe('one\n\no three\n');
    const shift = await open('a\n\nb\n');
    shift.view.dispatch(
      shift.view.state.tr.setSelection(TextSelection.create(shift.view.state.doc, 1, 4)),
    );
    const before = shift.editor.text();
    shift.key('Enter', { shiftKey: true });
    expect(shift.editor.text()).not.toBe(before.replace('a\n\nb', ''));
  });
});

describe('moving items and blocks with Alt+Up and Alt+Down', () => {
  const inItem = async (raw: string, word: string): Promise<Ed> => {
    const ed = await open(raw);
    const at = posAfter(ed.view.state.doc, word);
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, at)));
    return ed;
  };

  it('swaps a list item with its neighbour, nested items going with it', async () => {
    const ed = await inItem('- a\n  - a1\n- b\n- c\n', 'b');
    expect(ed.key('ArrowUp', { altKey: true }).defaultPrevented).toBe(true);
    expect(ed.editor.text()).toBe('- b\n- a\n  - a1\n- c\n');
    ed.key('ArrowDown', { altKey: true });
    ed.key('ArrowDown', { altKey: true });
    expect(ed.editor.text()).toBe('- a\n  - a1\n- c\n- b\n');
    // the caret went with the item
    expect(ed.view.state.selection.$from.parent.textContent).toBe('b');
  });

  it('does nothing at the ends of the list, and moves the blocks of a document', async () => {
    const ed = await inItem('- a\n- b\n', 'a');
    expect(ed.editor.exec('move-up')).toBe(false);
    expect(ed.editor.text()).toBe('- a\n- b\n');
    const blocks = await inItem('one\n\ntwo\n\nthree\n', 'two');
    expect(blocks.editor.exec('move-up')).toBe(true);
    expect(blocks.editor.text()).toBe('two\n\none\n\nthree\n');
    expect(blocks.editor.exec('undo')).toBe(true);
    expect(blocks.editor.text()).toBe('one\n\ntwo\n\nthree\n');
  });

  it('leaves a table and a code block alone, and moves a quote as a whole', async () => {
    const table = await inItem('x\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', '1');
    expect(table.editor.exec('move-up')).toBe(false);
    const quote = await inItem('x\n\n> q1\n>\n> q2\n', 'q2');
    expect(quote.editor.exec('move-up')).toBe(true);
    expect(quote.editor.text()).toBe('> q1\n>\n> q2\n\nx\n');
  });
});

describe('the suggestions: links, tags and the slash menu', () => {
  const calls: string[] = [];
  const backend = (over: Partial<LiveInputApp['completion']['backend']> = {}) => ({
    suggest: vi.fn((kind: string, query: string, notePath: string) => {
      calls.push(`${kind}:${query}:${notePath}`);
      return Promise.resolve(answer(kind));
    }),
    resolve: vi.fn((_from: string, target: string) => Promise.resolve(`${target}.md`)),
    ...over,
  });
  const answer = (kind: string): Suggestion[] => {
    if (kind === 'notes')
      return [
        sug({ label: 'Alpha', path: 'Alpha.md', detail: 'Alpha.md' }),
        sug({ label: 'Alphabet', path: 'dir/Alphabet.md', detail: 'dir' }),
        sug({ kind: 'alias', label: 'Al', path: 'Alpha.md', detail: 'Alpha' }),
      ];
    if (kind === 'headings') return [sug({ kind: 'heading', label: 'Intro', detail: 'H1' })];
    if (kind === 'blocks') return [sug({ kind: 'block', label: 'b1', detail: 'a paragraph' })];
    if (kind === 'tags') return [sug({ kind: 'tag', label: 'idea', detail: '3' })];
    return [];
  };
  const suggesting = (over: Partial<LiveInputApp> = {}): LiveInputApp => ({
    ...inertInput,
    completion: { backend: backend(), notePath: () => 'here.md', linkFormat: () => 'shortest' },
    slash: { enabled: () => true, run: () => undefined },
    delayMs: 0,
    ...over,
  });
  const popup = (): HTMLElement | null => document.querySelector('.mb-suggest:not([hidden])');
  const labels = (): string[] =>
    [...document.querySelectorAll('.mb-suggest:not([hidden]) .mb-suggest-label')].map(
      (e) => e.textContent ?? '',
    );
  const shown = (): Promise<void> => vi.waitFor(() => expect(popup()).not.toBeNull());

  it('offers the notes after [[ in the text of a list item, a task and a quote as well', async () => {
    for (const raw of ['- item\n', '1. item\n', '- [ ] item\n', '> item\n']) {
      const ed = await open(raw, { input: suggesting() });
      // the list items of Crepe put the selection of their mounting back one frame later
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      ed.end();
      ed.type(' [[al');
      await shown();
      expect(labels(), raw).toEqual(['Alpha', 'Alphabet', 'Al']);
      ed.key('Enter');
      expect(ed.node('ofm_wikilink'), raw).toBe(1);
      expect(ed.editor.text(), raw).toContain('item [[Alpha]]');
      expect(ed.editor.text(), raw).not.toContain('\\[');
      // one popup per editor, and it is closed
      expect(popup(), raw).toBeNull();
    }
  });

  it('offers the notes after [[ and puts the chosen one in a wikilink, the caret after it', async () => {
    calls.length = 0;
    const ed = await open('see\n', { input: suggesting() });
    ed.end();
    ed.type(' [[al');
    await shown();
    expect(labels()).toEqual(['Alpha', 'Alphabet', 'Al']);
    expect(calls.at(-1)).toBe('notes:al:');
    expect(popup()?.querySelector('[role=listbox]')?.getAttribute('aria-label')).toBe(
      'Suggestions',
    );
    expect(ed.key('ArrowDown').defaultPrevented).toBe(true);
    expect(popup()?.querySelectorAll('[aria-selected=true]')).toHaveLength(1);
    ed.key('Enter');
    expect(ed.node('ofm_wikilink')).toBe(1);
    expect(ed.editor.text()).toBe('see [[Alphabet]]\n');
    expect(popup()).toBeNull();
    ed.type('x');
    expect(ed.editor.text()).toBe('see [[Alphabet]]x\n');
  });

  it('follows the link format, and writes an alias as target|alias', async () => {
    const ed = await open('\n', {
      input: suggesting({
        completion: { backend: backend(), notePath: () => 'here.md', linkFormat: () => 'path' },
      }),
    });
    ed.type('[[a');
    await shown();
    ed.key('ArrowDown');
    ed.key('ArrowDown');
    ed.key('Tab');
    expect(ed.editor.text()).toBe('[[Alpha|Al]]\n');
  });

  it('completes [[note#headings and [[note#^blocks, and the node the caret is in', async () => {
    const ed = await open('\n', { input: suggesting({ autoPair: () => true }) });
    ed.type('[[Note#');
    await vi.waitFor(() => expect(labels()).toEqual(['Intro']));
    ed.key('Enter');
    expect(ed.editor.text()).toBe('[[Note#Intro]]\n');
    const blocks = await open('\n', { input: suggesting() });
    blocks.type('[[Note#^');
    await vi.waitFor(() => expect(labels()).toEqual(['^b1']));
    expect(calls.at(-1)).toBe('blocks::Note.md');
    blocks.key('Enter');
    expect(blocks.editor.text()).toBe('[[Note#^b1]]\n');
  });

  it('completes #tag as the text with the tag mark, and a lone # only when asked', async () => {
    const ed = await open('word\n', { input: suggesting() });
    ed.end();
    ed.type(' #i');
    await shown();
    expect(labels()).toEqual(['idea']);
    ed.key('Enter');
    expect(ed.editor.text()).toBe('word #idea\n');
    const marked: string[] = [];
    ed.view.state.doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'ofm_tag')) marked.push(n.text ?? '');
    });
    expect(marked).toEqual(['#idea']);
    const lone = await open('word\n', { input: suggesting() });
    lone.end();
    lone.type(' #');
    await new Promise((r) => setTimeout(r, 20));
    expect(popup()).toBeNull();
    lone.key(' ', { ctrlKey: true });
    await shown();
    expect(labels()).toEqual(['idea']);
  });

  it('closes with Escape, and drops an answer that came after the text moved on', async () => {
    const late: ((v: Suggestion[]) => void)[] = [];
    const slow = backend({
      suggest: vi.fn(
        (_k: string, query: string) =>
          new Promise<Suggestion[]>((r) =>
            late.push((v) => r(v.map((s) => ({ ...s, label: query })))),
          ),
      ),
    });
    const ed = await open('\n', {
      input: suggesting({
        completion: { backend: slow, notePath: () => '', linkFormat: () => 'shortest' },
      }),
    });
    ed.type('[[a');
    ed.type('b');
    // [[ asked, then [[a, then [[ab
    await vi.waitFor(() => expect(late).toHaveLength(3));
    late[2]?.([sug({})]);
    await shown();
    expect(labels()).toEqual(['ab']);
    late[0]?.([sug({})]);
    late[1]?.([sug({})]);
    await new Promise((r) => setTimeout(r, 10));
    expect(labels()).toEqual(['ab']);
    ed.key('Escape');
    expect(popup()).toBeNull();
    // plain text that looks like the start of a link is written escaped: it is no link until it is closed
    expect(ed.editor.text()).toBe('\\[\\[ab\n');
  });

  it('closes when the text no longer asks for it, and when the backend fails', async () => {
    const ed = await open('\n', { input: suggesting() });
    ed.type('[[a');
    await shown();
    ed.type(']');
    await vi.waitFor(() => expect(popup()).toBeNull());
    const failing = await open('\n', {
      input: suggesting({
        completion: {
          backend: backend({ suggest: vi.fn(() => Promise.reject(new Error('down'))) }),
          notePath: () => '',
          linkFormat: () => 'shortest',
        },
      }),
    });
    failing.type('[[a');
    await new Promise((r) => setTimeout(r, 20));
    expect(popup()).toBeNull();
    expect(failing.editor.text()).toBe('\\[\\[a\n');
  });

  it('is not opened by loading, reloading or selecting', async () => {
    const ed = await open('see [[al\n', { input: suggesting() });
    ed.end();
    ed.editor.reload('see [[alp\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(popup()).toBeNull();
  });

  it('draws the slash menu in groups with an icon each, and keeps the options in one listbox in the order shown', async () => {
    const ed = await open('\n', { input: suggesting() });
    ed.type('/');
    await shown();
    const headings = [...document.querySelectorAll('.mb-suggest-group')];
    expect(headings.map((h) => h.textContent)).toEqual(['Text', 'Lists', 'Advanced', 'Vault']);
    // the headings are for the eye: no role of their own, and not read
    expect(headings.every((h) => h.getAttribute('aria-hidden') === 'true')).toBe(true);
    const options = [
      ...document.querySelectorAll('.mb-suggest [role="listbox"] > [role="option"]'),
    ];
    expect(options).toHaveLength(18);
    expect(options.every((o) => o.querySelector('.mb-suggest-icon svg'))).toBe(true);
    // the groups come one after the other: the text ones first (headings, quote, callout, divider)
    expect(labels().slice(0, 6)).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Quote',
      'Callout',
      'Divider',
    ]);
    // a query that matches in two groups shows each heading once
    ed.type('t');
    const found = [...document.querySelectorAll('.mb-suggest-group')].map((h) => h.textContent);
    expect(new Set(found).size).toBe(found.length);
    // arrow keys move through the options in the order shown, headings skipped
    ed.key('ArrowDown');
    expect(document.querySelectorAll('.mb-suggest [aria-selected="true"]')).toHaveLength(1);
  });

  it('opens the slash menu at the start of a line and after a space, filters it, and runs the item', async () => {
    const run = vi.fn();
    const ed = await open('\n', { input: suggesting({ slash: { enabled: () => true, run } }) });
    ed.type('/');
    await shown();
    expect(labels()[0]).toBe('Heading 1');
    expect(labels()).toHaveLength(18);
    ed.type('call');
    expect(labels()).toEqual(['Callout']);
    ed.key('Enter');
    expect(ed.editor.text()).toBe('> [!note] \n');
    expect(popup()).toBeNull();
    // the caret is after the blank: what is typed next is the title, and it is still a callout
    ed.type('Title');
    expect(ed.editor.text()).toBe('> [!note] Title\n');
    expect(ed.editor.text()).not.toContain('\\');

    const quote = await open('title\n', {
      input: suggesting({ slash: { enabled: () => true, run } }),
    });
    quote.end();
    quote.type(' /tab');
    expect(labels()).toEqual(['Table']);
    quote.key('Enter');
    expect(quote.node('table')).toBe(1);

    const registry = await open('\n', {
      input: suggesting({ slash: { enabled: () => true, run } }),
    });
    registry.type('/task');
    registry.key('Enter');
    expect(run).toHaveBeenCalledWith('editor:task');
    expect(registry.editor.text()).toBe('\n');

    const date = await open('\n', { input: suggesting() });
    date.type('/date');
    date.key('Enter');
    expect(date.editor.text()).toMatch(/^\d{4}-\d{2}-\d{2}\n$/);
  });

  it('keeps the slash a character in code, math, words and URLs, and when it is off or read-only', async () => {
    const quiet = async (
      raw: string,
      type: string,
      over: Partial<LiveInputApp> = {},
      ro = false,
    ) => {
      const ed = await open(raw, { input: suggesting(over), readOnly: ro });
      ed.end();
      ed.type(type);
      await new Promise((r) => setTimeout(r, 10));
      return popup();
    };
    expect(await quiet('see\n', ' $x /')).toBeNull();
    expect(await quiet('either\n', '/')).toBeNull();
    expect(await quiet('see https:\n', '//x.org/')).toBeNull();
    expect(await quiet('\n', '/', { slash: { enabled: () => false, run: vi.fn() } })).toBeNull();
    expect(await quiet('\n', '/', {}, true)).toBeNull();
    // inside inline code
    const span = await open('use `code` here\n', { input: suggesting() });
    span.view.dispatch(
      span.view.state.tr.setSelection(
        TextSelection.create(span.view.state.doc, posAfter(span.view.state.doc, 'cod')),
      ),
    );
    span.type(' /');
    await new Promise((r) => setTimeout(r, 10));
    expect(popup()).toBeNull();
    // and in a code block, an editor of its own
    const code = await open('```\n\n```\n', { input: suggesting() });
    const at = code.view.state.doc.child(0).content.size;
    code.view.dispatch(
      code.view.state.tr.setSelection(TextSelection.create(code.view.state.doc, 1 + at)),
    );
    code.type('/');
    await new Promise((r) => setTimeout(r, 10));
    expect(popup()).toBeNull();
  });

  it('leaves the popup behind with the editor', async () => {
    const ed = await open('\n', { input: suggesting() });
    ed.type('/');
    await shown();
    opened.pop()?.dispose();
    await vi.waitFor(() => expect(document.querySelector('.mb-suggest')).toBeNull());
  });
});

describe('Tab and Shift+Tab', () => {
  const caret = (ed: Ed, after: string): void =>
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, after)),
      ),
    );

  it('sink and lift the items of a list, as the indent of Source does', async () => {
    const ed = await open('- a\n- b\n');
    caret(ed, 'b');
    expect(ed.key('Tab').defaultPrevented).toBe(true);
    expect(ed.editor.text()).toBe('- a\n  - b\n');
    ed.key('Tab', { shiftKey: true });
    expect(ed.editor.text()).toBe('- a\n- b\n');
    // the first item has nothing to sink under, a top-level one stays in the list: nothing is written
    caret(ed, 'a');
    ed.key('Tab');
    expect(ed.editor.text()).toBe('- a\n- b\n');
    ed.key('Tab', { shiftKey: true });
    expect(ed.editor.text()).toBe('- a\n- b\n');
  });

  it('write a tab character at the caret in a paragraph, never spaces, and take it away again', async () => {
    const ed = await open('para\n');
    caret(ed, 'pa');
    ed.key('Tab');
    expect(ed.editor.text()).toBe('pa\tra\n');
    expect(ed.editor.text()).not.toContain('  ');
    ed.key('Tab', { shiftKey: true });
    expect(ed.editor.text()).toBe('para\n');
    ed.key('Tab', { shiftKey: true });
    expect(ed.editor.text()).toBe('para\n');
  });

  it('write nothing where a tab has no sense: the start of a block, a selection', async () => {
    const ed = await open('para\n');
    ed.view.dispatch(ed.view.state.tr.setSelection(Selection.atStart(ed.view.state.doc)));
    expect(ed.key('Tab').defaultPrevented).toBe(true);
    expect(ed.editor.text()).toBe('para\n');
    const from = posAfter(ed.view.state.doc, 'p');
    ed.view.dispatch(
      ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, from, from + 2)),
    );
    ed.key('Tab');
    expect(ed.editor.text()).toBe('para\n');
  });

  it('write nothing at the start of a line after a forced line break either (N4)', async () => {
    const ed = await open('a\\\nb\n');
    expect(ed.view.state.doc.firstChild?.childCount).toBeGreaterThan(2);
    caret(ed, 'a');
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, ed.view.state.selection.from + 1),
      ),
    );
    ed.key('Tab');
    expect(ed.editor.text()).toBe('a\\\nb\n');
    expect(ed.editor.text()).not.toContain('&#');
  });

  it('leave a code block and a read-only editor alone, and go to the next cell of a table', async () => {
    // (a code block is an editor of its own in a browser: its Tab never gets here; nothing is written if it does)
    const code = await open('```js\nfoo\n```\n');
    caret(code, 'fo');
    code.key('Tab');
    expect(code.editor.text()).toBe('```js\nfoo\n```\n');
    const cell = await open('| h | k |\n| --- | --- |\n| one | 2 |\n');
    caret(cell, 'one');
    expect(cell.key('Tab').defaultPrevented).toBe(true);
    expect(cell.editor.text()).toBe('| h | k |\n| --- | --- |\n| one | 2 |\n');
    expect(cell.view.state.selection.$from.parent.textContent).toBe('2');
    const ro = await open('para\n', { readOnly: true });
    caret(ro, 'pa');
    ro.key('Tab');
    expect(ro.editor.text()).toBe('para\n');
  });
});

describe('the numbers of an ordered list after an item came or went', () => {
  const caret = (ed: Ed, after: string): void =>
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, after)),
      ),
    );

  it('go on counting after Enter, as Source does: no two items with one number', async () => {
    const ed = await open('1. a\n2. b\n3. c\n');
    caret(ed, 'a');
    ed.key('Enter');
    ed.type('z');
    expect(ed.editor.text()).toBe('1. a\n2. z\n3. b\n4. c\n');
    const quote = await open('> 1. a\n> 2. b\n');
    caret(quote, 'a');
    quote.key('Enter');
    quote.type('z');
    expect(quote.editor.text()).toBe('> 1. a\n> 2. z\n> 3. b\n');
    const nested = await open('- x\n  1. a\n  2. b\n');
    caret(nested, 'a');
    nested.key('Enter');
    nested.type('z');
    expect(nested.editor.text()).toBe('- x\n  1. a\n  2. z\n  3. b\n');
    const from3 = await open('3. a\n4. b\n');
    caret(from3, 'a');
    from3.key('Enter');
    from3.type('z');
    expect(from3.editor.text()).toBe('3. a\n4. z\n5. b\n');
  });

  it('close the gap of an item taken out', async () => {
    const ed = await open('1. a\n2. b\n3. c\n');
    let at = -1;
    let size = 0;
    ed.view.state.doc.descendants((n, pos) => {
      if (n.type.name === 'list_item' && n.textContent === 'b') {
        at = pos;
        size = n.nodeSize;
      }
      return true;
    });
    ed.view.dispatch(ed.view.state.tr.delete(at, at + size));
    expect(ed.editor.text()).toBe('1. a\n2. c\n');
  });

  it('leave a list that does not count, and one whose numbers would change their width, alone', async () => {
    const ones = await open('1. a\n1. b\n1. c\n');
    caret(ones, 'a');
    ones.key('Enter');
    ones.type('z');
    expect(ones.editor.text()).toBe('1. a\n2. z\n1. b\n1. c\n');
    const wide = await open('8. a\n9. b\n10. c\n');
    caret(wide, 'a');
    wide.key('Enter');
    wide.type('z');
    expect(wide.editor.text()).toBe('8. a\n9. z\n9. b\n10. c\n');
  });
});

describe('blanks at the end of a block', () => {
  it('are written as they are, never as the character reference &#x20;', async () => {
    const ed = await open('abc\n');
    ed.end();
    ed.type(' ');
    expect(ed.editor.text()).toBe('abc \n');
    ed.type('def ');
    expect(ed.editor.text()).toBe('abc def \n');
    const heading = await open('# Title\n');
    heading.end();
    heading.type(' ');
    expect(heading.editor.text()).toBe('# Title \n');
    expect(ed.editor.text()).not.toContain('&#x');
  });
});

describe('smart paste and drop', () => {
  const file = (name: string, type = ''): File =>
    new File([new Uint8Array([1, 2, 3])], name, { type });

  const pasteEvent = (data: { files?: File[]; text?: string; html?: string }): Event => {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: {
        files: data.files ?? [],
        getData: (t: string) =>
          t === 'text/plain' ? (data.text ?? '') : t === 'text/html' ? (data.html ?? '') : '',
      },
    });
    return ev;
  };

  /** A paste event as the browser raises it, with the clipboard of the test. */
  const paste = (ed: Ed, data: { files?: File[]; text?: string; html?: string }): Event => {
    const ev = pasteEvent(data);
    ed.view.dom.dispatchEvent(ev);
    return ev;
  };

  /** Whether the smart paste takes the event (the editor's own handling of what it lets go needs a browser). */
  const takes = (ed: Ed, type: 'paste' | 'drop', ev: Event): boolean => {
    const plugin = ed.view.state.plugins.find((p) =>
      String((p.spec.key as { key?: string } | undefined)?.key).startsWith(
        'memobrain-pending-inserts',
      ),
    );
    const handler = plugin?.props.handleDOMEvents?.[type] as
      ((this: Plugin, view: EditorView, event: Event) => boolean | void) | undefined;
    return handler?.call(plugin as Plugin, ed.view, ev) === true;
  };

  const dropEvent = (ed: Ed, files: File[], pos: number): Event => {
    vi.spyOn(ed.view, 'posAtCoords').mockReturnValue({ pos, inside: -1 });
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files } });
    return ev;
  };

  const drop = (ed: Ed, files: File[], pos: number): Event => {
    const ev = dropEvent(ed, files, pos);
    ed.view.dom.dispatchEvent(ev);
    return ev;
  };

  /** An application that stores attachments (the mock of the store, and of the error report, are returned). */
  const smart = (
    over: {
      save?: (name: string, base64: string) => Promise<string>;
      enabled?: () => boolean;
    } = {},
  ) => {
    const save = vi.fn(
      over.save ?? ((name: string, _base64: string) => Promise.resolve(`attachments/${name}`)),
    );
    const onError = vi.fn();
    const input: LiveInputApp = {
      ...inertInput,
      paste: { saveAttachment: save, enabled: over.enabled ?? (() => true), onError },
    };
    return { input, save, onError };
  };

  it('stores a pasted file and puts its embed in the text at the caret', async () => {
    const { input, save } = smart();
    const ed = await open('before after\n', { input });
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, 'before')),
      ),
    );
    const ev = paste(ed, { files: [file('photo.png', 'image/png')] });
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(ed.node('ofm_wikilink')).toBe(1));
    expect(save).toHaveBeenCalledWith('photo.png', 'AQID');
    expect(ed.editor.text()).toBe('before![[attachments/photo.png]] after\n');
    // the caret follows the embed
    expect(ed.view.state.selection.from).toBe(
      posAfter(ed.view.state.doc, 'before') +
        ed.view.state.doc.nodeAt(posAfter(ed.view.state.doc, 'before'))!.nodeSize,
    );
  });

  it('names a generic image by the time, and keeps the name of a real file', async () => {
    const { input } = smart();
    const ed = await open('x\n', { input });
    ed.end();
    paste(ed, { files: [file('image.png', 'image/png')] });
    await vi.waitFor(() => expect(ed.node('ofm_wikilink')).toBe(1));
    expect(ed.editor.text()).toMatch(/^x!\[\[attachments\/Pasted image \d{14}\.png\]\]\n$/);
  });

  it('puts several files in paragraphs of their own after the first', async () => {
    const ed = await open('x\n', { input: smart().input });
    ed.end();
    paste(ed, { files: [file('a.png'), file('b.png')] });
    await vi.waitFor(() => expect(ed.node('ofm_wikilink')).toBe(2));
    expect(ed.editor.text()).toBe('x![[attachments/a.png]]\n\n![[attachments/b.png]]\n');
  });

  it('inserts a dropped file where it was dropped, wherever the text is by the time it is stored', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { input } = smart({
      save: async (name) => {
        await gate;
        return `attachments/${name}`;
      },
    });
    const ed = await open('first\n\nsecond\n', { input });
    const at = posAfter(ed.view.state.doc, 'second');
    expect(drop(ed, [file('a.png')], at).defaultPrevented).toBe(true);
    // while the file is being written, the user types in front of the drop point
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 1)));
    ed.type('NEW ');
    release();
    await vi.waitFor(() => expect(ed.node('ofm_wikilink')).toBe(1));
    expect(ed.editor.text()).toBe('NEW first\n\nsecond![[attachments/a.png]]\n');
    // the user's caret was elsewhere: it stays there
    expect(ed.view.state.selection.from).toBe(5);
  });

  it('is one undo step, and reports a file that cannot be stored without inserting anything', async () => {
    const { input } = smart();
    const ed = await open('x\n', { input });
    ed.end();
    paste(ed, { files: [file('a.png')] });
    await vi.waitFor(() => expect(ed.node('ofm_wikilink')).toBe(1));
    ed.editor.exec('undo');
    expect(ed.editor.text()).toBe('x\n');

    const error = new Error('disk full');
    const bad = smart({ save: () => Promise.reject(error) });
    const failing = await open('x\n', { input: bad.input });
    failing.end();
    paste(failing, { files: [file('a.png')] });
    await vi.waitFor(() => expect(bad.onError).toHaveBeenCalledWith(error));
    expect(failing.editor.text()).toBe('x\n');
  });

  it('inserts nothing in a read-only editor, in one that is gone, or with smart paste off', async () => {
    const { input, save } = smart();
    const ro = await open('x\n', { input, readOnly: true });
    ro.end();
    expect(takes(ro, 'paste', pasteEvent({ files: [file('a.png')] }))).toBe(false);
    expect(takes(ro, 'drop', dropEvent(ro, [file('a.png')], 1))).toBe(false);
    expect(save).not.toHaveBeenCalled();

    const off = smart({ enabled: () => false });
    const plain = await open('x\n', { input: off.input });
    plain.end();
    expect(takes(plain, 'paste', pasteEvent({ files: [file('a.png')] }))).toBe(false);
    expect(takes(plain, 'drop', dropEvent(plain, [file('a.png')], 1))).toBe(false);
    expect(off.save).not.toHaveBeenCalled();

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = smart({
      save: async (name) => {
        await gate;
        return `attachments/${name}`;
      },
    });
    const gone = await open('x\n', { input: slow.input });
    gone.end();
    paste(gone, { files: [file('a.png')] });
    opened.pop()?.dispose();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(slow.save).toHaveBeenCalled();
  });

  it('makes the selection a link when a URL is pasted over it, and not otherwise', async () => {
    const ed = await open('say hello now\n', { input: smart().input });
    const from = posAfter(ed.view.state.doc, 'say ');
    ed.view.dispatch(
      ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, from, from + 5)),
    );
    expect(paste(ed, { text: 'https://example.org/a' }).defaultPrevented).toBe(true);
    expect(ed.editor.text()).toBe('say [hello](https://example.org/a) now\n');
    const empty = await open('x\n', { input: smart().input });
    empty.end();
    // no selection: the URL is text as any other, written as it came
    paste(empty, { text: 'https://example.org/a' });
    expect(empty.node('link')).toBe(0);
    expect(empty.editor.text()).toContain('xhttps://example.org/a');
    expect(empty.editor.text()).not.toContain('](');
  });

  it('turns rich HTML into the nodes of its Markdown, and lets plain text and its own copies go', async () => {
    const ed = await open('x\n', { input: smart().input });
    ed.end();
    const ev = paste(ed, {
      html: '<p>See <strong>this</strong> and <a href="https://x.org">that</a></p>',
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(ed.editor.text()).toBe('xSee **this** and [that](https://x.org)\n');
    const list = await open('x\n', { input: smart().input });
    list.end();
    paste(list, { html: '<ul><li>a</li><li>b</li></ul>' });
    expect(list.node('list_item')).toBe(2);
    expect(list.editor.text()).toContain('- a\n- b');
    const own = await open('x\n', { input: smart().input });
    own.end();
    const copy = pasteEvent({ html: '<p data-pm-slice="1 1 []">copied <b>here</b></p>' });
    expect(takes(own, 'paste', copy)).toBe(false);
    // plain text is the smart paste's own now (the clipboard plugin would lose the OFM nodes)
    expect(takes(own, 'paste', pasteEvent({ html: '<span>plain</span>', text: 'plain' }))).toBe(
      true,
    );
  });

  describe('plain text is Markdown that goes in as written', () => {
    const at = (ed: Ed, after: string): void =>
      ed.view.dispatch(
        ed.view.state.tr.setSelection(
          TextSelection.create(ed.view.state.doc, posAfter(ed.view.state.doc, after)),
        ),
      );

    it('keeps wikilinks, embeds and tags, in the middle of a line too', async () => {
      const ed = await open('see  now\n', { input: smart().input });
      at(ed, 'see ');
      expect(paste(ed, { text: '[[Other note#H|al]] and ![[img.png|200]]' }).defaultPrevented).toBe(
        true,
      );
      expect(ed.editor.text()).toBe('see [[Other note#H|al]] and ![[img.png|200]] now\n');
      expect(ed.node('ofm_wikilink')).toBe(2);
    });

    it('keeps $$ blocks, %% comments and footnote definitions', async () => {
      const ed = await open('\n', { input: smart().input });
      paste(ed, { text: '$$\nx^2\n$$' });
      expect(ed.editor.text()).toBe('$$\nx^2\n$$\n');
      const c = await open('\n', { input: smart().input });
      paste(c, { text: '%%\nhidden\n%%' });
      expect(c.editor.text()).toBe('%%\nhidden\n%%\n');
      const f = await open('a\n\n', { input: smart().input });
      f.end();
      paste(f, { text: '[^1]: note' });
      expect(f.editor.text()).toContain('[^1]: note');
      expect(f.editor.text()).not.toContain('\\');
    });

    it('does not need smart paste to be on, and keeps the blanks at the edges of a line', async () => {
      const ed = await open('ab\n', { input: smart({ enabled: () => false }).input });
      at(ed, 'a');
      paste(ed, { text: ' [[x]] ' });
      expect(ed.editor.text()).toBe('a [[x]] b\n');
    });

    it('puts a line end of the text in a table cell as a blank, so the table stays one', async () => {
      const ed = await open('| h | k |\n| --- | --- |\n| one | 2 |\n', { input: smart().input });
      at(ed, 'one');
      paste(ed, { text: 'x\ny' });
      expect(ed.editor.text()).toBe('| h | k |\n| --- | --- |\n| onex y | 2 |\n');
    });

    it('keeps a reference to a footnote or to a link definition, with or without the definition (N2)', async () => {
      const ed = await open('hello world\n\n[^1]: note\n\n[r]: https://x.org\n', {
        input: smart().input,
      });
      at(ed, 'hello ');
      paste(ed, { text: '[^1] and [t][r]' });
      expect(ed.editor.text()).toBe(
        'hello [^1] and [t][r]world\n\n[^1]: note\n\n[r]: https://x.org\n',
      );
      expect(ed.node('raw_inline')).toBe(2);
      // a footnote without a definition stays as pasted; a link reference without one stays text
      const none = await open('x\n', { input: smart().input });
      none.end();
      paste(none, { text: ' y[^2] and a[i][j]' });
      expect(none.editor.text()).toBe('x y[^2] and a\\[i]\\[j]\n');
      // the definition goes in with the reference
      const both = await open('x\n', { input: smart().input });
      both.end();
      paste(both, { text: '\n\nsee [t][r]\n\n[r]: https://x.org' });
      expect(both.editor.text()).toContain('see [t][r]');
      expect(both.editor.text()).not.toContain('\\[');
      // an escape in the source is the text it says
      const esc = await open('x\n', { input: smart().input });
      esc.end();
      paste(esc, { text: ' \\[^1]' });
      expect(esc.node('raw_inline')).toBe(0);
    });

    it('keeps the marks of the text a pasted reference was in (R3)', async () => {
      const ed = await open('x\n', { input: smart().input });
      ed.end();
      paste(ed, { text: ' **x [^1] y**' });
      expect(ed.node('raw_inline')).toBe(1);
      expect(ed.editor.text()).toBe('x **x [^1] y**\n');
    });

    it('decides for each reference whether the source escaped it (R4)', async () => {
      const ed = await open('x\n', { input: smart().input });
      ed.end();
      paste(ed, { text: ' see [^1] and \\[x] and \\[^2]' });
      expect(ed.node('raw_inline')).toBe(1);
      expect(ed.editor.text()).toBe('x see [^1] and \\[x] and \\[^2]\n');
    });

    it('keeps a line that starts like a block as text at the end of a paragraph too (R4)', async () => {
      const ed = await open('abc\n', { input: smart().input });
      ed.end();
      paste(ed, { text: '- x' });
      expect(ed.editor.text()).toBe('abc- x\n');
      expect(ed.node('paragraph')).toBe(1);
    });

    it('keeps a line that starts like a block as text in the middle of a paragraph (N3)', async () => {
      for (const line of ['- 5 degrees', '# x', '1. x', '> x']) {
        const ed = await open('abcdef\n', { input: smart().input });
        at(ed, 'abc');
        paste(ed, { text: line });
        expect(ed.editor.text(), line).toBe(`abc${line}def\n`);
      }
      const tagged = await open('abcdef\n', { input: smart().input });
      at(tagged, 'abc');
      paste(tagged, { text: '- see #tag' });
      expect(tagged.editor.text()).toBe('abc- see #tagdef\n');
      // an empty paragraph takes it as the block it is
      const empty = await open('\n', { input: smart().input });
      paste(empty, { text: '- item' });
      expect(empty.editor.text()).toBe('- item\n');
    });

    it('puts a line end in a heading as a blank, so the heading stays one (N3)', async () => {
      const ed = await open('# Title\n', { input: smart().input });
      at(ed, 'Ti');
      paste(ed, { text: 'a\nb' });
      expect(ed.editor.text()).toBe('# Tia btle\n');
    });

    it('does not write the blanks at the start of a line as character references (N4)', async () => {
      const lead = await open('x\n', { input: smart().input });
      lead.view.dispatch(lead.view.state.tr.setSelection(Selection.atStart(lead.view.state.doc)));
      paste(lead, { text: '  \t x' });
      expect(lead.editor.text()).toBe('xx\n');
      // the blank of the first line of a text of more lines is kept in the middle of a line
      const multi = await open('c\n', { input: smart().input });
      multi.end();
      paste(multi, { text: ' a\nb' });
      expect(multi.editor.text()).toBe('c a\nb\n');
    });

    it('writes the bar of a wikilink in a table cell as an escaped one (N6)', async () => {
      const ed = await open('| h | k |\n| --- | --- |\n| one | 2 |\n', { input: smart().input });
      at(ed, 'one');
      paste(ed, { text: '[[a|b]]' });
      expect(ed.editor.text()).toBe('| h | k |\n| --- | --- |\n| one[[a\\|b]] | 2 |\n');
      const typed = await open('| h | k |\n| --- | --- |\n| one | 2 |\n');
      typed.view.dispatch(
        typed.view.state.tr.setSelection(
          TextSelection.create(typed.view.state.doc, posAfter(typed.view.state.doc, 'one')),
        ),
      );
      typed.type('[[x|y]]');
      expect(typed.editor.text()).toBe('| h | k |\n| --- | --- |\n| one[[x\\|y]] | 2 |\n');
    });

    it('is not taken in a code block or with files of the editor itself', async () => {
      const code = await open('```js\nfoo\n```\n', { input: smart().input });
      at(code, 'fo');
      expect(takes(code, 'paste', pasteEvent({ text: '[[x]]' }))).toBe(false);
      const own = await open('x\n', { input: smart().input });
      own.end();
      expect(
        takes(own, 'paste', pasteEvent({ html: '<p data-pm-slice="1 1 []">x</p>', text: 'x' })),
      ).toBe(false);
    });

    it('is taken in the name of a wikilink, which keeps the text of it that a name has (no bracket)', async () => {
      const link = await open('see [[Note]]\n', { input: smart().input });
      link.view.dispatch(
        link.view.state.tr.setSelection(
          TextSelection.create(link.view.state.doc, posAfter(link.view.state.doc, 'No')),
        ),
      );
      expect(takes(link, 'paste', pasteEvent({ text: '[[x]]' }))).toBe(true);
      expect(link.editor.text()).toBe('see [[Noxte]]\n');
    });
  });
});
