// The preservation layer on a real editor (headless): a clean block is its file text, byte for byte;
// a changed block is written alone with the style of the file; the file's own envelope survives.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveCore, type LiveCore } from '../headless';
import { renderMarkdown } from '../../../reading/render';
import { changedLines, nestedTasks, shape } from '../testing/metrics';
import {
  open,
  positionsOf,
  posAfter,
  replaceText,
  setChecked,
  tx,
  typeAfter,
} from '../testing/helpers';
import { LiveSession } from './session';

let core: LiveCore;
beforeAll(async () => {
  core = await createLiveCore();
});
afterAll(() => core.destroy());

const lines = (s: string): string[] => s.split('\n');

describe('a note nobody touched is the file', () => {
  const FILES: Record<string, string> = {
    'two paragraphs': 'Hello\n\nWorld\n',
    'blank lines kept as they are': 'Hello\n\n\n\nWorld\n\n\n',
    'no final newline': 'Hello\n\nWorld',
    'trailing spaces': 'Hello  \nsoft\n\nWorld \n',
    'odd indentation': '  - a\n    - b\n\n   para\n',
    'list markers and emphasis the file likes':
      '* a\n* b\n\nSome _emph_ and __strong__\n\n+ x\n+ y\n',
    'frontmatter, BOM and CRLF': '\uFEFF---\r\ntitle: A\r\n---\r\n# Title\r\n\r\ntext\r\n',
    empty: '',
    'tilde fence with info string': '~~~ts title="x"\nlet a: number;\n~~~\n',
  };
  for (const [name, raw] of Object.entries(FILES)) {
    it(name, () => {
      const s = open(core, raw);
      expect(s.text(s.doc)).toBe(raw);
    });
  }

  it('the table is built on the document after loading: the heading ids are there already', () => {
    const s = open(core, '# One\n\n## Two\n\ntext\n');
    const ids: unknown[] = [];
    s.doc.forEach((n) => n.type.name === 'heading' && ids.push(n.attrs['id']));
    expect(ids).toEqual(['one', 'two']);
    // so an edit elsewhere does not rewrite the headings
    expect(s.text(typeAfter(s.doc, 'text', '!'))).toBe('# One\n\n## Two\n\ntext!\n');
  });
});

describe('a changed block is written alone', () => {
  it('one typed character changes one line, whatever the rest looks like', () => {
    const raw =
      '# T\n\nfirst  \nline\n\n*   odd\n*   list\n\n> quote\n\n| a|b |\n|--|--|\n|1 |2|\n\nlast\n';
    const s = open(core, raw);
    const out = s.text(typeAfter(s.doc, 'last', '!'));
    expect(out).toBe(raw.replace('last', 'last!'));
    const out2 = s.text(typeAfter(s.doc, 'quote', '!'));
    expect(changedLines(raw, out2)).toBe(1);
    expect(out2).toBe(raw.replace('> quote', '> quote!'));
  });

  it('a paragraph is written with the emphasis of the file, and a tight list stays tight', () => {
    const raw = 'Some _emph_ and **strong**\n\n* a\n* b\n\nEnd\n';
    const s = open(core, raw);
    expect(s.text(typeAfter(s.doc, 'Some', '!'))).toBe(
      'Some! _emph_ and **strong**\n\n* a\n* b\n\nEnd\n',
    );
    expect(s.text(typeAfter(s.doc, 'b', '!'))).toBe(
      'Some _emph_ and **strong**\n\n* a\n* b!\n\nEnd\n',
    );
  });

  it('a new block is written with the markers the file uses', () => {
    const s = open(core, '* a\n* b\n\nSome _emph_ here\n\n~~~js\nlet x\n~~~\n');
    const list = core.parse('- new item\n').firstChild!;
    // emphasis made by editing (the toolbar, the shortcut): no delimiter of its own, the file's is used
    const { schema } = core;
    const para = schema.nodes['paragraph']!.create(null, [
      schema.text('a '),
      schema.text('new', [schema.marks['emphasis']!.create()]),
      schema.text(' paragraph'),
    ]);
    const code = core.parse('```py\nx = 1\n```\n').firstChild!;
    const out = s.text(tx(s.doc).insert(s.doc.content.size, [list, para, code]).doc);
    expect(out).toBe(
      '* a\n* b\n\nSome _emph_ here\n\n~~~js\nlet x\n~~~\n\n* new item\n\na _new_ paragraph\n\n~~~py\nx = 1\n~~~\n',
    );
  });

  it('a new block between two is separated by one blank line; a removed one takes its separator', () => {
    const raw = 'one\n\ntwo\n\nthree\n';
    const s = open(core, raw);
    const para = core.parse('inserted\n').firstChild!;
    const afterOne = s.doc.child(0).nodeSize;
    expect(s.text(tx(s.doc).insert(afterOne, para).doc)).toBe('one\n\ninserted\n\ntwo\n\nthree\n');
    const twoStart = afterOne;
    expect(s.text(tx(s.doc).delete(twoStart, twoStart + s.doc.child(1).nodeSize).doc)).toBe(
      'one\n\nthree\n',
    );
    const threeStart = twoStart + s.doc.child(1).nodeSize;
    expect(s.text(tx(s.doc).delete(threeStart, threeStart + s.doc.child(2).nodeSize).doc)).toBe(
      'one\n\ntwo\n',
    );
  });

  it('a table keeps the cells the file padded by hand; only the edited row is written', () => {
    const raw = '| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| 3   | 4   |\n';
    const s = open(core, raw);
    const out = s.text(replaceText(s.doc, '3', '30'));
    expect(changedLines(raw, out)).toBe(1);
    expect(lines(out)[0]).toBe('| a   | b   |');
  });

  it('a code block keeps its fence and info string; only its lines change', () => {
    const raw = '~~~ts title="x"\nlet a = 1;\nlet b = 2;\n~~~\n';
    const s = open(core, raw);
    expect(s.text(typeAfter(s.doc, 'let b', '!'))).toBe(
      '~~~ts title="x"\nlet a = 1;\nlet b! = 2;\n~~~\n',
    );
  });

  it('ticking one task of a list of 200 items changes one line', () => {
    const raw = nestedTasks(200);
    const s = open(core, raw);
    const out = s.text(setChecked(s.doc, 120, true));
    expect(changedLines(raw, out)).toBe(1);
    expect(lines(out)[120]).toBe('  - [x] item 120');
    // and unticked again it is the file
    expect(s.text(setChecked(setChecked(s.doc, 120, true), 120, false))).toBe(raw);
  });

  it('an item of a nested list is written inside its list, with the indentation of the file', () => {
    const raw = '- a\n  - b\n    - c\n  - d\n- e\n';
    const s = open(core, raw);
    expect(s.text(typeAfter(s.doc, 'c', '!'))).toBe('- a\n  - b\n    - c!\n  - d\n- e\n');
    const dItem = positionsOf(s.doc, 'list_item')[3]!;
    const d = s.doc.nodeAt(dItem)!;
    expect(s.text(tx(s.doc).delete(dItem, dItem + d.nodeSize).doc)).toBe(
      '- a\n  - b\n    - c\n- e\n',
    );
  });

  it('an ordered list keeps its numbering style', () => {
    expect(
      open(core, '1. a\n1. b\n1. c\n').text(
        typeAfter(open(core, '1. a\n1. b\n1. c\n').doc, 'b', '!'),
      ),
    ).toBe('1. a\n1. b!\n1. c\n');
    const s = open(core, '3. a\n4. b\n');
    expect(s.text(typeAfter(s.doc, 'b', '!'))).toBe('3. a\n4. b!\n');
  });

  it('a callout is a quote: editing its body leaves the head, and the fold marker, as they are', () => {
    const raw = '> [!warning]- Folded\n> more text\n\nafter\n';
    const s = open(core, raw);
    expect(s.text(typeAfter(s.doc, 'more', '!'))).toBe(
      '> [!warning]- Folded\n> more! text\n\nafter\n',
    );
  });

  it('a quote that ends in an empty > line keeps it, or the next line would join the quote', () => {
    const raw = '> bar\n>\nbaz\n';
    const s = open(core, raw);
    const out = s.text(typeAfter(s.doc, 'bar', '!'));
    expect(out).toBe('> bar!\n>\nbaz\n');
  });
});

describe('the envelope of the file', () => {
  it('BOM, frontmatter and CRLF are put back; only the changed line is different', () => {
    const raw =
      '\uFEFF---\r\ntitle: A\r\ntags: [x]\r\n---\r\n# Title\r\n\r\nfirst\r\n\r\nsecond\r\n';
    const s = open(core, raw);
    const out = s.text(typeAfter(s.doc, 'first', '!'));
    expect(out).toBe(raw.replace('first', 'first!'));
    // a block that is new gets the line ending of the file too
    const added = s.text(
      tx(s.doc).insert(s.doc.content.size, core.parse('new one\n').firstChild!).doc,
    );
    expect(added).toBe(raw + '\r\nnew one\r\n');
  });

  it('a file without a final newline stays without it, and one with several keeps them', () => {
    const s = open(core, 'a\n\nb');
    expect(s.text(typeAfter(s.doc, 'b', '!'))).toBe('a\n\nb!');
    const t = open(core, 'a\n\nb\n\n\n');
    expect(t.text(typeAfter(t.doc, 'b', '!'))).toBe('a\n\nb!\n\n\n');
  });

  it('a file with both kinds of line ending is refused: it opens in Source', () => {
    const r = LiveSession.open(core, 'a\r\nb\nc\r\n');
    expect(r).toMatchObject({ ok: false, reason: 'mixed-eol' });
  });

  it('a rule inserted as the first block of a note is written ***, so no frontmatter appears (M6)', () => {
    const s = open(core, 'text\n\n---\n\nmore\n');
    const hr = core.parse('---\n').firstChild!;
    expect(hr.type.name).toBe('hr');
    const out = s.text(tx(s.doc).insert(0, hr).doc);
    expect(out.startsWith('***\n')).toBe(true);
    // and the file, opened again, has no frontmatter
    const again = open(core, out);
    expect(again.envelope.frontmatter).toBe('');
    expect(again.text(again.doc)).toBe(out);
  });

  it('a template with a frontmatter inserted at the start: the frontmatter goes to the envelope', () => {
    const s = open(core, 'Hello\n');
    expect(s.adoptInserted('---\ntags: [daily]\n---\n# Day\n')).toBe('# Day\n');
    expect(s.envelope.frontmatter).toBe('---\ntags: [daily]\n---\n');
    expect(s.text(s.doc)).toBe('---\ntags: [daily]\n---\nHello\n');
  });
});

describe('the file changed outside (A1)', () => {
  it('the table is rebuilt from the new text for every block: a change of form only is seen', () => {
    const s = open(core, '- a\n- b\n\ntext\n');
    const r = s.reload('* a\n* b\n\ntext\n');
    expect(r).toHaveProperty('doc');
    const doc = (r as { doc: NonNullable<unknown> }).doc as typeof s.doc;
    expect(s.text(doc)).toBe('* a\n* b\n\ntext\n');
    // an edit afterwards keeps the new form, not the one the session had before
    expect(s.text(typeAfter(doc, 'b', '!'))).toBe('* a\n* b!\n\ntext\n');
  });

  it('a change of the line endings alone is the envelope, not a transaction', () => {
    const s = open(core, 'a\n\nb\n');
    const r = s.reload('a\r\n\r\nb\r\n');
    expect(r).toEqual({ doc: null });
    expect(s.text(s.doc)).toBe('a\r\n\r\nb\r\n');
  });

  it('a change of the frontmatter alone replaces the envelope: no transaction, no new document', () => {
    const s = open(core, '---\na: 1\n---\nBody\n');
    const before = s.doc;
    expect(s.reload('---\na: 2\nb: 3\n---\nBody\n')).toEqual({ doc: null });
    expect(s.doc).toBe(before);
    expect(s.text(s.doc)).toBe('---\na: 2\nb: 3\n---\nBody\n');
    expect(s.text(typeAfter(s.doc, 'Body', '!'))).toBe('---\na: 2\nb: 3\n---\nBody!\n');
  });

  it('a body that changed gives the new document', () => {
    const s = open(core, 'one\n\ntwo\n');
    const r = s.reload('one\n\ntwo\n\nthree\n');
    expect(r).toHaveProperty('doc');
    expect(s.text((r as { doc: typeof s.doc }).doc)).toBe('one\n\ntwo\n\nthree\n');
  });

  it('a refusal leaves the session as it was', () => {
    const s = open(core, 'one\n');
    expect(s.reload('a\r\nb\nc\r\n')).toMatchObject({ ok: false, reason: 'mixed-eol' });
    expect(s.text(s.doc)).toBe('one\n');
  });
});

// The edit path (nothing forced) must mean what writing every block again means: the same blocks when the
// text is read again, the same index entry (positions apart) and the same Reading HTML.
describe('the edit path means what the forced one means', () => {
  const ws = (x: string): string => x.replace(/\s+/g, ' ');
  /** The blocks of a document with their text, the way a reader sees them. */
  const outline = (doc: LiveSession['doc']): string[] => {
    const out: string[] = [];
    doc.descendants((n) => {
      if (n.isBlock) out.push(n.type.name + (n.isTextblock ? `:${n.textContent.trim()}` : ''));
      return true;
    });
    return out;
  };

  /** Enter after `at`: the written text reads back as the document the editor shows, and as the forced text. */
  const enter = (raw: string, at: string): void => {
    const s = open(core, raw);
    const doc = tx(s.doc).split(posAfter(s.doc, at)).doc;
    const out = s.text(doc);
    const forced = s.text(doc, { forceDirty: true });
    expect(outline(open(core, out).doc)).toEqual(outline(doc));
    expect(shape(out)).toBe(shape(forced));
    expect(ws(renderMarkdown(out))).toBe(ws(renderMarkdown(forced)));
  };
  it('Enter in a paragraph of a quote: the new paragraph stays in the quote', () => {
    enter('> first second\n', 'first');
  });

  it('Enter in a callout keeps the `> ` of the lines it did not touch', () => {
    enter('> [!note] Title\n> body one two\n\nafter\n', 'body one');
  });

  it('Enter in an item: the new paragraph is indented in the item, and so are the lines that follow', () => {
    enter('- item one two\n  more\n', 'item one');
    enter('1. item one two\n   more\n', 'item one');
    enter('- a\n  - nested one two\n- b\n', 'nested one');
  });

  it('Enter in a paragraph with no blank line before the next block keeps the paragraphs apart', () => {
    enter('para one two\n# Heading\n', 'para one');
    enter('para one two\n- item\n', 'para one');
    enter('para one two\n> quote\n', 'para one');
    enter('# Heading\npara one two\n', 'para one');
  });

  it('Enter in a task, a heading and a code block', () => {
    enter('- [ ] task one two\n', 'task one');
    enter('# Heading one two\n\ntext\n', 'Heading one');
    enter('```ts\nconst a = 1;\nconst b = 2;\n```\n\nafter\n', 'const a');
  });

  it('a fence typed in a code block does not close it: the note after it stays a note', () => {
    const raw = '```\nalpha\n```\n\nafter\n';
    const s = open(core, raw);
    const doc = replaceText(s.doc, 'alpha', 'alpha\n```\nbeta');
    const out = s.text(doc);
    expect(out).toBe(s.text(doc, { forceDirty: true }));
    const back = open(core, out).doc;
    expect(outline(back)).toEqual(['code_block:alpha\n```\nbeta', 'paragraph:after']);
    expect(ws(renderMarkdown(out))).toContain('<p>after</p>');
  });

  it('a line that is a fence shorter than the one of the block is code, and the block keeps its fence', () => {
    const raw = '````\nalpha\n````\n';
    const s = open(core, raw);
    const out = s.text(replaceText(s.doc, 'alpha', 'alpha\n```\nbeta'));
    expect(out).toBe('````\nalpha\n```\nbeta\n````\n');
  });

  it('a tilde fence is closed by tildes only, and a closing line with spaces counts', () => {
    const s = open(core, '~~~\nalpha\n~~~\n\nafter\n');
    const tildes = s.text(replaceText(s.doc, 'alpha', 'a\n~~~  \nb'));
    expect(outline(open(core, tildes).doc)).toEqual(['code_block:a\n~~~  \nb', 'paragraph:after']);
    const ticks = s.text(replaceText(s.doc, 'alpha', 'a\n```\nb'));
    expect(ticks).toBe('~~~\na\n```\nb\n~~~\n\nafter\n');
  });

  it('a fence line typed in a block inside a quote does not close it either', () => {
    const raw = '> ```\n> alpha\n> ```\n\nafter\n';
    const s = open(core, raw);
    const doc = replaceText(s.doc, 'alpha', 'alpha\n```\nbeta');
    const out = s.text(doc);
    expect(ws(renderMarkdown(out))).toContain('<p>after</p>');
    expect(shape(out)).toBe(shape(s.text(doc, { forceDirty: true })));
  });

  it('a block kept as it is is not swallowed by a new block next to it (a fence that is not closed)', () => {
    const raw = '`````\n\n```\naaa\n';
    const s = open(core, raw);
    const doc = tx(s.doc).split(9).doc;
    expect(shape(s.text(doc))).toBe(shape(s.text(doc, { forceDirty: true })));
  });
});
