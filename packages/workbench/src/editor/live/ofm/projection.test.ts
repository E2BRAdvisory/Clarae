// The Obsidian constructs and the raw nodes of the Markdown layer, one construct at a time: how the
// file is read into the document (nodes, marks, raw), and that the file is what comes back.
import { extract } from '@clarae/markdown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveCore, type LiveCore } from '../headless';
import { open, typeAfter } from '../testing/helpers';
import { shape } from '../testing/metrics';

let core: LiveCore;
beforeAll(async () => {
  core = await createLiveCore();
});
afterAll(() => core.destroy());

/** The document of a file as a string of nodes, and what writing every block again gives. */
function read(raw: string): { doc: string; again: string } {
  const s = open(core, raw);
  expect(s.text(s.doc), 'untouched').toBe(raw);
  return { doc: s.doc.toString(), again: s.text(s.doc, { forceDirty: true }) };
}

describe('Obsidian constructs are nodes and marks', () => {
  it('wikilinks and embeds keep their raw text inside, an escaped one is text', () => {
    const { doc, again } = read('See [[Note#H|alias]], ![[img.png|300]] and \\[[escaped]].\n');
    expect(doc).toBe(
      'doc(paragraph("See ", ofm_wikilink("Note#H|alias"), ", ", ofm_wikilink("img.png|300"), " and [[escaped]]."))',
    );
    expect(again).toBe('See [[Note#H|alias]], ![[img.png|300]] and \\[[escaped]].\n');
  });

  it('an embed is flagged, a wikilink in a table cell keeps its escaped pipe', () => {
    const s = open(core, '![[a.png]] [[b]]\n\n| x | y |\n| - | - |\n| [[p\\|q]] | z |\n');
    const embeds: unknown[] = [];
    s.doc.descendants((n) => {
      if (n.type.name === 'ofm_wikilink') embeds.push(n.attrs['embed']);
      return true;
    });
    expect(embeds).toEqual([true, false, false]);
    expect(s.text(typeAfter(s.doc, 'z', '!'))).toBe(
      '![[a.png]] [[b]]\n\n| x | y |\n| - | - |\n| [[p\\|q]] | z! |\n',
    );
  });

  it('tags are marks over the text, with their #; what the index does not read as a tag is text', () => {
    const { doc, again } = read('A #tag and #a/b and \\#notatag, (#paren) and C# and #123.\n');
    expect(doc).toBe(
      'doc(paragraph("A ", ofm_tag("#tag"), " and ", ofm_tag("#a/b"), " and #notatag, (", ofm_tag("#paren"), ") and C# and #123."))',
    );
    expect(again).toBe('A #tag and #a/b and \\#notatag, (#paren) and C# and #123.\n');
  });

  it('block ids are marks, in a paragraph and in a list item', () => {
    const { doc } = read('A paragraph ^abc-1\n\n- item ^id2\n');
    expect(doc).toBe(
      'doc(paragraph("A paragraph ", ofm_blockid("^abc-1")), bullet_list(list_item(paragraph("item ", ofm_blockid("^id2")))))',
    );
  });

  it('a highlight is a mark that wraps its content, other marks inside it included', () => {
    const { doc, again } = read('a ==hi **bold**== b\n');
    expect(doc).toBe(
      'doc(paragraph("a ", ofm_highlight("hi "), strong(ofm_highlight("bold")), " b"))',
    );
    expect(again).toBe('a ==hi **bold**== b\n');
  });

  it('inline comments and footnotes are raw inline, inline math is the Latex node: all as the file says', () => {
    const { doc, again } = read('x %%hidden [[a]]%% y $a^2$ z^[inline note]\n');
    expect(doc).toBe('doc(paragraph("x ", raw_inline, " y ", math_inline, " z", raw_inline))');
    expect(again).toBe('x %%hidden [[a]]%% y $a^2$ z^[inline note]\n');
  });

  it('what is inside a code span or a code block is not an OFM construct', () => {
    const { doc } = read('`[[x]] #tag` and\n\n```\n[[y]] #tag2\n```\n');
    expect(doc).not.toMatch(/ofm_/);
  });

  it('typing a wikilink as text writes it escaped: the index finds no backlink there', () => {
    const s = open(core, 'hello\n');
    const out = s.text(typeAfter(s.doc, 'hello', ' [[typed]] #typed'));
    expect(out).toBe('hello \\[[typed]] \\#typed\n');
    expect(extract('t', out).links).toEqual([]);
    expect(extract('t', out).tags).toEqual([]);
  });

  it('the fold of a callout is not in the document (A4): it is the text of its head, as the file has it', () => {
    const s = open(core, '> [!warning]- Folded\n> more\n');
    expect(s.doc.toString()).toBe(
      'doc(blockquote(paragraph("[!warning]- Folded", hardbreak, "more")))',
    );
    // no node or mark of the schema holds a view state
    const names = [
      ...Object.values(core.schema.nodes),
      ...Object.values(core.schema.marks),
    ].flatMap((t) => Object.keys(t.spec.attrs ?? {}));
    expect(names.filter((n) => /fold|open|collaps|expanded/i.test(n))).toEqual([]);
  });

  it('a custom task state is text, a standard one is the checkbox of the item', () => {
    const s = open(core, '- [/] half\n- [x] done\n- [ ] todo\n');
    const checked: unknown[] = [];
    s.doc.descendants((n) => {
      if (n.type.name === 'list_item') checked.push(n.attrs['checked']);
      return true;
    });
    expect(checked).toEqual([null, true, false]);
    expect(s.doc.toString()).toContain('"[/] half"');
  });
});

describe('what has no schema, or is not written back the same, stays raw (kept whole, byte for byte)', () => {
  // [name, file, the types of the blocks of the document]
  const BLOCKS: [string, string, string[]][] = [
    ['a multi-line comment', '%%\nmultiline\ncomment\n%%\n\nafter\n', ['raw_block', 'paragraph']],
    [
      'a comment that crosses a paragraph',
      'start %%a\n\nb%% end\n\nafter\n',
      ['raw_block', 'paragraph'],
    ],
    ['math that crosses lines in a paragraph', 'text $$\na\n$$ more\n', ['raw_block']],
    ['a setext heading', 'Title\n=====\n\nSub\n---\n', ['raw_block', 'raw_block']],
    [
      'indented code',
      'para\n\n    indented\n    code\n\npara\n',
      ['paragraph', 'raw_block', 'paragraph'],
    ],
    [
      'link definitions',
      '[a][1] and [b]\n\n[1]: https://a.example "T"\n[b]: https://b.example\n',
      ['paragraph', 'raw_block', 'raw_block'],
    ],
    ['a footnote definition', 'text[^1]\n\n[^1]: the note\n', ['paragraph', 'raw_block']],
    ['an html block', '<div class="x">\n  <b>hi</b>\n</div>\n\npara\n', ['raw_block', 'paragraph']],
    [
      'a table with a cell the editor cannot hold',
      '| a | `x` \\| y |\n| - | - |\n| 1 | 2 |\n',
      ['table'],
    ],
    [
      'a compact table, which the index counts differently once padded',
      '|a|b|\n|-|-|\n|1|2|\n',
      ['raw_block'],
    ],
  ];
  for (const [name, raw, types] of BLOCKS) {
    it(`${name}`, () => {
      const s = open(core, raw);
      expect(s.text(s.doc)).toBe(raw);
      const blocks: string[] = [];
      s.doc.forEach((n) => blocks.push(n.type.name));
      expect(blocks).toEqual(types);
      // written again, the file means the same to the index
      expect(shape(s.text(s.doc, { forceDirty: true }))).toBe(shape(raw));
    });
  }

  it('a raw block next to an edit is not touched', () => {
    const raw =
      'Title\n=====\n\ntext here\n\n[1]: https://a.example "T"\n\n    code\n\n%%\nnote\n%%\n';
    const s = open(core, raw);
    expect(s.text(typeAfter(s.doc, 'text', '!'))).toBe(raw.replace('text here', 'text! here'));
  });

  it('inline: references, html, entities and autolinks are raw inline', () => {
    const { doc, again } = read(
      '[a][1] <b>x</b> &copy; and <https://x.example> and www.example.org\n\n[1]: /u\n',
    );
    expect(doc).toBe(
      'doc(paragraph(raw_inline, " ", raw_inline, "x", raw_inline, " ", raw_inline, " and ", raw_inline, " and ", raw_inline), raw_block)',
    );
    expect(again).toBe(
      '[a][1] <b>x</b> &copy; and <https://x.example> and www.example.org\n\n[1]: /u\n',
    );
  });

  it('a link with a title or a plain destination is a link; one the serializer would write differently is raw', () => {
    const plain = read('[a](https://x.example "T") and [b](c.md)\n');
    expect(plain.doc).not.toMatch(/raw_inline/);
    expect(plain.again).toBe('[a](https://x.example "T") and [b](c.md)\n');
    const odd = read('[a](<my file.md>) and [b](x(y))\n');
    expect(odd.doc).toMatch(/raw_inline/);
    expect(odd.again).toBe('[a](<my file.md>) and [b](x(y))\n');
  });

  it('the info string of a fence is kept, and so is the fence', () => {
    const s = open(core, '~~~ts title="x" {1,3}\nlet a;\n~~~\n');
    const code = s.doc.child(0);
    expect(code.type.name).toBe('code_block');
    expect(code.attrs).toMatchObject({ language: 'ts', meta: 'title="x" {1,3}' });
    expect(s.text(s.doc, { forceDirty: true })).toBe('~~~ts title="x" {1,3}\nlet a;\n~~~\n');
  });

  it('a mark span that crosses a construct cannot be placed: the block is raw, never "almost" projected', () => {
    const s = open(core, '*a [[b* c]]\n');
    expect(s.doc.toString()).toBe('doc(raw_block)');
    expect(s.text(s.doc)).toBe('*a [[b* c]]\n');
  });
});
