// The upstream nodes and settings that would rewrite the file, and what the layer does to them (B4).
import { editorViewCtx } from '@milkdown/kit/core';
import { extract } from '@memobrain/markdown';
import { TextSelection } from '@milkdown/kit/prose/state';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, posAfter, tx } from './testing/helpers';
import { createLiveCore, type LiveCore } from './headless';

let core: LiveCore;
beforeAll(async () => {
  core = await createLiveCore();
});
afterAll(() => core.destroy());

/** Milkdown's own round trip of a text, as an unprepared editor would do it. */
const roundTrip = (md: string): string => core.serialize(core.parse(md));
/** The layer's: open the file, write every block again. */
const forced = (md: string): string => {
  const s = open(core, md);
  return s.text(s.doc, { forceDirty: true });
};

describe('image-block (alt text and size are kept)', () => {
  const images = [
    '![schema](a.png)',
    '![alt|300](a.png)',
    '![1.5](a.png)',
    '![alt text](a.png "title")',
    '![](a.png)',
  ];
  for (const md of images) {
    it(md, () => {
      expect(roundTrip(md).trimEnd()).toBe(md);
      expect(forced(md + '\n')).toBe(md + '\n');
    });
  }

  it('the alt text is an attribute of the node, the |W part included', () => {
    const s = open(core, '![alt|300](a.png)\n');
    expect(s.doc.child(0).type.name).toBe('image-block');
    expect(s.doc.child(0).attrs['alt']).toBe('alt|300');
  });
});

describe('emoji (the text is not converted when the file is read)', () => {
  for (const md of ['smile :smile: and :+1:', 'a:b:c and 12:30:45']) {
    it(md, () => {
      expect(roundTrip(md).trimEnd()).toBe(md);
      const s = open(core, md + '\n');
      expect(s.doc.toString()).not.toMatch(/emoji/);
      expect(forced(md + '\n')).toBe(md + '\n');
    });
  }

  it('an emoji character is written back as the character', () => {
    expect(roundTrip('emoji 😄 stays').trimEnd()).toBe('emoji 😄 stays');
    expect(forced('emoji 😄 stays\n')).toBe('emoji 😄 stays\n');
  });
});

describe('math and code', () => {
  for (const md of [
    '```latex\nx^2\n```',
    '$$\ny\n$$',
    'inline $a^2$ here',
    '```LaTeX\nz\n```',
    '```js\nx\n```',
  ]) {
    it(JSON.stringify(md), () => {
      expect(forced(md + '\n')).toBe(md + '\n');
    });
  }

  it('a $$ block and a latex fence stay what they were, after an edit of their content', () => {
    for (const md of ['$$\ny\n$$\n', '```latex\ny\n```\n']) {
      const s = open(core, md);
      const code = s.doc.child(0);
      const doc = tx(s.doc).insertText('z', 1 + code.content.size).doc;
      expect(s.text(doc)).toBe(md.replace('y', 'yz'));
    }
  });
});

describe('the settings of the presets', () => {
  it('an empty paragraph is written as nothing, not as <br />', () => {
    const s = open(core, 'one\n\ntwo\n');
    const empty = core.schema.nodes['paragraph']!.create();
    const out = s.text(tx(s.doc).insert(s.doc.child(0).nodeSize, empty).doc);
    expect(out).not.toMatch(/<br/);
    expect(out).toBe('one\n\ntwo\n');
    // and as the whole document
    expect(roundTrip('')).toBe('');
    expect(forced('a\n\n\n\nb\n')).toBe('a\n\n\n\nb\n');
  });

  it('a table is not padded: one cell changed does not reflow the other rows', () => {
    const md = '| a | b |\n| - | - |\n| a long cell here | x |\n';
    expect(roundTrip(md)).toBe(md);
  });

  it('the trailing plugin adds no paragraph: not on load, not on a selection', () => {
    const s = open(core, '# T\n\n- item\n\n```\ncode\n```\n');
    const view = core.editor.action((ctx) => ctx.get(editorViewCtx));
    const loaded = view.state.doc;
    expect(loaded.eq(s.doc)).toBe(true);
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    expect(view.state.doc.eq(loaded)).toBe(true);
    expect(view.state.doc.childCount).toBe(3);
  });
});

describe('a task is written with its box on the line of its marker', () => {
  // the next item of a split at the end of the first line of a text of several lines starts with a line break
  const split = (md: string, line: string): string => {
    const s = open(core, md);
    // the paragraph and the item are split (a document the headless editor does not mend: the writing is what is tried)
    const t = tx(s.doc).split(posAfter(s.doc, line), 2);
    return s.text(t.doc, { forceDirty: true });
  };

  it('does not write the line break the text of an item starts with before its box', () => {
    for (const [md, out] of [
      ['- [x] a\n  b\n  c\n', '- [x] a\n- [x] b\n  c\n'],
      ['1. [ ] a\n   b\n', '1. [ ] a\n2. [ ] b\n'],
      ['> - [x] a\n>   b\n', '> - [x] a\n> - [x] b\n'],
      ['- [x] a\r\n  b\r\n', '- [x] a\r\n- [x] b\r\n'],
    ] as const) {
      expect(split(md, 'a'), md).toBe(out);
    }
  });
});

describe('the box of a task is written whatever the delimiter of its ordered list', () => {
  it('keeps the box of the tasks of a list that follows another ordered list (`1)` takes turns with `1.`)', () => {
    const md = '- [x] b\n  1. a\n  2. b\n  1) [ ] nn\n  2) [x] mm\n';
    expect(forced(md)).toBe(md);
    const again = open(core, forced(md));
    const states: unknown[] = [];
    again.doc.descendants((n) => {
      if (n.type.name === 'list_item' && n.attrs['checked'] != null)
        states.push(n.attrs['checked']);
      return true;
    });
    expect(states).toEqual([true, false, true]);
    // the same with bullets (`*` takes turns with `-`)
    expect(forced('- x\n  - a\n  * [ ] t\n')).toBe('- x\n  - a\n  * [ ] t\n');
  });
});

describe('an item with no text keeps what it holds nested when the note is opened again', () => {
  /** The note with the text `words` deleted, one after the other (the items stay, empty), written again. */
  const emptied = (md: string, ...words: string[]): string => {
    const s = open(core, md);
    let doc = s.doc;
    for (const w of words) {
      const to = posAfter(doc, w);
      doc = tx(doc).delete(to - w.length, to).doc;
    }
    return s.text(doc, { forceDirty: true });
  };

  it('writes no blank line after the marker of an empty item (it would end the item)', () => {
    expect(emptied('- x\n\n  - y\n\n    - [ ] a\n', 'x', 'y')).toBe('-\n  -\n    - [ ] a\n');
    expect(emptied('> - x\n>\n>   - y\n>\n>     - [ ] a\n', 'x', 'y')).toBe(
      '> -\n>   -\n>     - [ ] a\n',
    );
    expect(emptied('1. x\n\n   - y\n', 'x')).toBe('1.\n   - y\n');
  });

  it('writes the paragraph that follows an empty first one as the text of the item', () => {
    expect(emptied('1. x\n\n   para\n', 'x')).toBe('1. para\n');
    // (the live editor moves the text up to the head of a task first: tasks.ts; here, none has)
    expect(emptied('- [ ] x\n\n  para\n', 'x')).toBe('- para\n');
  });

  it('puts a blank line between the text of an item and a list that starts with an empty item (a bare `-` under a line is its underline)', () => {
    const s = open(core, '- [ ] a\n  - [x] b\n');
    const at = posAfter(s.doc, 'b') - 1;
    // the list item of the inner list is split at the start of its text: an empty item, then `b`
    const doc = tx(s.doc).split(at, 2).doc;
    expect(s.text(doc, { forceDirty: true })).toBe('- [ ] a\n\n  -\n  - [x] b\n');
  });

  it('keeps the blank line of a wide item when its next paragraph becomes its text: what follows is the list the editor shows', () => {
    // `2. x` cannot interrupt a paragraph: written right under `a`, it would be a second line of `a`
    expect(emptied('- q\n\n  a\n\n  2. x\n', 'q')).toBe('- a\n\n  2. x\n');
    // a bare `-` under a line is its underline
    expect(emptied('- q\n\n  a\n\n  -\n    - x\n', 'q')).toBe('- a\n\n  -\n    - x\n');
  });

  it('puts the blank line before a list that starts with an empty item after a raw block too (the `-` would be a line of the HTML)', () => {
    const s = open(core, '- a\n\n  <div>x</div>\n\n  -\n');
    // the item is narrow (an edit made it so): the blank line is the layer's to keep
    const narrow = tx(s.doc).setNodeMarkup(1, undefined, {
      ...s.doc.nodeAt(1)!.attrs,
      spread: false,
    }).doc;
    expect(s.text(narrow, { forceDirty: true })).toBe('- a\n\n  <div>x</div>\n\n  -\n');
  });

  it('opens the notes the writing of such an item gives with what the editor showed: the list stays a list, the bare `-` is no underline', () => {
    const ordered = emptied('- q\n\n  a\n\n  2. x\n', 'q');
    const lists: string[] = [];
    open(core, ordered).doc.descendants((n) => {
      if (n.type.name === 'ordered_list') lists.push(n.type.name);
      return true;
    });
    expect(lists, ordered).toHaveLength(1);
    // (an empty item that holds a list is a block of its own for the layer: what matters is the file's reading)
    const bare = emptied('- q\n\n  a\n\n  -\n    - x\n', 'q');
    expect(extract('t.md', bare).headings, bare).toEqual([]);
  });
});
