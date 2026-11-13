import { describe, expect, it } from 'vitest';
import { EditorState, type ChangeSpec } from '@codemirror/state';
import { renderDeck } from './engine';
import {
  DIRECTIVE_KEYS,
  canReorder,
  deckSettings,
  deckSlides,
  frontmatterEdit,
  hiddenEdit,
  moveSlideEdit,
  notesEdit,
  includedDeck,
  setHiddenEdit,
  slideAt,
} from './slides';

/** The 0-based lines where Marp starts each slide: the first one, and every `---` that splits. */
function linesOf(source: string): number[] {
  const rows = source.split('\n');
  const out = [0];
  let fence = false;
  const fm = rows[0] === '---' ? rows.indexOf('---', 1) : -1;
  rows.forEach((r, i) => {
    if (/^```/.test(r)) fence = !fence;
    if (!fence && i > fm && r === '---') out.push(i);
  });
  return out;
}

const apply = (source: string, changes: ChangeSpec[]): string =>
  EditorState.create({ doc: source }).update({ changes }).state.doc.toString();

const DECK = `---
marp: true
theme: gaia
---

# One

text of one

---

## Two

- a
- b

---

Plain three
`;

describe('deckSlides', () => {
  it('tells where each slide starts and ends, with its title', () => {
    const s = deckSlides(DECK, linesOf(DECK));
    expect(s.map((x) => x.title)).toEqual(['One', 'Two', 'Plain three']);
    expect(s[0]).toMatchObject({ index: 0, start: 0, bodyStart: 4, end: 8 });
    expect(s[1]).toMatchObject({ start: 9, bodyStart: 10 });
    expect(s.every((x) => !x.hidden && x.notes === '')).toBe(true);
  });

  it('does not split on a --- inside a code block', () => {
    const src = '# A\n\n```md\n---\nx\n```\n\n---\n\n# B\n';
    const s = deckSlides(src, linesOf(src));
    expect(s).toHaveLength(2);
    expect(s[0]?.words).toBe(1); // the code is not counted
  });

  it('reads notes, leaving directives and the marker out', () => {
    const src =
      '# A\n\n<!-- _class: lead -->\n<!-- say hi -->\n<!-- clarae: hidden -->\n<!--\nsecond\nnote\n-->\n';
    const [a] = deckSlides(src, [0]);
    expect(a?.notes).toBe('say hi\n\nsecond\nnote');
    expect(a?.hidden).toBe(true);
  });

  it('works without frontmatter and with a headingDivider (no separators)', () => {
    const src = '# One\n\ntext\n\n# Two\n';
    const s = deckSlides(src, [0, 4]);
    expect(s.map((x) => x.title)).toEqual(['One', 'Two']);
    expect(canReorder(src, [0, 4])).toBe(false);
    expect(moveSlideEdit(src, [0, 4], 0, 1)).toEqual([]);
    expect(canReorder(DECK, linesOf(DECK))).toBe(true);
  });

  it('finds the slide of a line', () => {
    expect(slideAt([0, 9, 15], 3)).toBe(0);
    expect(slideAt([0, 9, 15], 9)).toBe(1);
    expect(slideAt([0, 9, 15], 99)).toBe(2);
  });
});

describe('moveSlideEdit', () => {
  const lines = linesOf(DECK);
  it('swaps two slides, keeping the separators and the frontmatter', () => {
    const out = apply(DECK, moveSlideEdit(DECK, lines, 0, 1));
    expect(out).toBe(`---
marp: true
theme: gaia
---

## Two

- a
- b

---

# One

text of one

---

Plain three
`);
  });

  it('moves a slide up, and to the end', () => {
    const up = apply(DECK, moveSlideEdit(DECK, lines, 2, -1));
    expect(deckSlides(up, linesOf(up)).map((x) => x.title)).toEqual(['One', 'Plain three', 'Two']);
    expect(up.endsWith('- b\n')).toBe(true);
  });

  it('does nothing at the ends, and moving back restores the text', () => {
    expect(moveSlideEdit(DECK, lines, 0, -1)).toEqual([]);
    expect(moveSlideEdit(DECK, lines, 2, 1)).toEqual([]);
    const once = apply(DECK, moveSlideEdit(DECK, lines, 1, 1));
    expect(apply(once, moveSlideEdit(once, linesOf(once), 2, -1))).toBe(DECK);
  });

  it('carries the notes and the marker of a slide with it', () => {
    const src = '# A\n\n---\n\n# B\n\n<!-- n -->\n<!-- clarae: hidden -->\n';
    const out = apply(src, moveSlideEdit(src, linesOf(src), 1, -1));
    const s = deckSlides(out, linesOf(out));
    expect(s[0]).toMatchObject({ title: 'B', notes: 'n', hidden: true });
    expect(s[1]).toMatchObject({ title: 'A', hidden: false });
  });

  it('is one change, even over code blocks with ---', () => {
    const src = '# A\n\n```\n---\n```\n\n---\n\n# B\n';
    const changes = moveSlideEdit(src, linesOf(src), 0, 1);
    expect(changes).toHaveLength(1);
    expect(apply(src, changes)).toContain('```\n---\n```');
  });
});

describe('hiddenEdit', () => {
  const lines = linesOf(DECK);
  it('leaves a slide out and puts it back, idempotently', () => {
    const hidden = apply(DECK, hiddenEdit(DECK, lines, 1, true));
    expect(deckSlides(hidden, linesOf(hidden)).map((x) => x.hidden)).toEqual([false, true, false]);
    expect(hiddenEdit(hidden, linesOf(hidden), 1, true)).toEqual([]);
    const back = apply(hidden, hiddenEdit(hidden, linesOf(hidden), 1, false));
    expect(back).toBe(DECK);
    expect(hiddenEdit(DECK, lines, 1, false)).toEqual([]);
  });

  it('leaves the first slide out below the frontmatter', () => {
    const out = apply(DECK, hiddenEdit(DECK, lines, 0, true));
    expect(out.startsWith('---\nmarp: true\ntheme: gaia\n---\n')).toBe(true);
    expect(deckSlides(out, linesOf(out))[0]?.hidden).toBe(true);
  });

  it('excludes and includes many slides in one set of changes', () => {
    const all = apply(DECK, setHiddenEdit(DECK, lines, [0, 1, 2], true));
    expect(deckSlides(all, linesOf(all)).every((x) => x.hidden)).toBe(true);
    expect(apply(all, setHiddenEdit(all, linesOf(all), [0, 1, 2], false))).toBe(DECK);
  });
});

describe('notesEdit', () => {
  const lines = linesOf(DECK);
  it('adds, rewrites and removes the notes of a slide', () => {
    const added = apply(DECK, notesEdit(DECK, lines, 1, 'say this'));
    expect(deckSlides(added, linesOf(added))[1]?.notes).toBe('say this');
    expect(added).toContain('<!-- say this -->');

    const again = apply(added, notesEdit(added, linesOf(added), 1, 'a\nb'));
    expect(deckSlides(again, linesOf(again))[1]?.notes).toBe('a\nb');
    expect(again).not.toContain('say this');

    const removed = apply(again, notesEdit(again, linesOf(again), 1, ''));
    expect(removed).toBe(DECK);
  });

  it('keeps directives and the marker when the notes change', () => {
    const src = '# A\n\n<!-- _class: lead -->\n<!-- old -->\n<!-- clarae: hidden -->\n';
    const out = apply(src, notesEdit(src, [0], 0, 'new'));
    expect(out).toContain('_class: lead');
    expect(out).toContain('clarae: hidden');
    expect(out).not.toContain('old');
    expect(deckSlides(out, [0])[0]?.notes).toBe('new');
  });

  it('cannot close the comment from the text of a note', () => {
    const out = apply(DECK, notesEdit(DECK, lines, 0, 'x --> y'));
    expect(deckSlides(out, linesOf(out))[0]?.notes).toBe('x --&gt; y');
  });
});

describe('settings', () => {
  it('reads the frontmatter, with defaults', () => {
    expect(deckSettings(DECK)).toEqual({
      theme: 'gaia',
      paginate: false,
      loop: false,
      notes: true,
    });
    expect(deckSettings('# x\n')).toEqual({
      theme: 'default',
      paginate: false,
      loop: false,
      notes: true,
    });
    expect(
      deckSettings(
        '---\ntheme: "uncover"\npaginate: true\nclarae-loop: true\nclarae-notes: false\n---\n',
      ),
    ).toEqual({ theme: 'uncover', paginate: true, loop: true, notes: false });
  });

  it('sets, adds and removes a key', () => {
    const set = apply(DECK, frontmatterEdit(DECK, 'theme', 'uncover'));
    expect(set).toContain('theme: uncover\n---');
    expect(deckSettings(apply(DECK, frontmatterEdit(DECK, 'paginate', true))).paginate).toBe(true);
    expect(apply(DECK, frontmatterEdit(DECK, 'theme', null))).not.toContain('theme');
    expect(frontmatterEdit(DECK, 'clarae-loop', null)).toEqual([]);
    const loop = apply(DECK, frontmatterEdit(DECK, 'clarae-loop', true));
    expect(deckSettings(loop).loop).toBe(true);
  });

  it('creates the frontmatter when the file has none', () => {
    const out = apply('# A\n', frontmatterEdit('# A\n', 'paginate', true));
    expect(out).toBe('---\nmarp: true\npaginate: true\n---\n\n# A\n');
  });
});

describe('what is a comment, as Marp reads it (ADR-0048)', () => {
  it('leaves a comment inside a code span or code block alone', () => {
    const src = '# HTML comments\n\nWrite `<!-- like this -->` in HTML.\n';
    expect(deckSlides(src, [0])[0]?.notes).toBe('');
    expect(notesEdit(src, [0], 0, 'x')).toEqual([
      { from: src.length - 1, insert: '\n\n<!-- x -->' },
    ]);
    expect(apply(src, notesEdit(src, [0], 0, 'x'))).toContain('`<!-- like this -->`');
    const marked = '# A\n\nUse `<!-- clarae: hidden -->` to hide.\n';
    expect(deckSlides(marked, [0])[0]?.hidden).toBe(false);
    expect(hiddenEdit(marked, [0], 0, false)).toEqual([]);
    const indented = '# A\n\n    <!-- not a note -->\n\ntext\n';
    expect(deckSlides(indented, [0])[0]?.notes).toBe('');
    expect(notesEdit(indented, [0], 0, '')).toEqual([]);
    const fenced = '# A\n\n```html\n<!-- code -->\n```\n';
    expect(deckSlides(fenced, [0])[0]?.notes).toBe('');
  });

  it('reads a comment in the middle of a paragraph and one inside a list item', () => {
    const src = '# A\n\ntext <!-- inline note --> more\n\n- item\n\n  <!-- in the item -->\n';
    expect(deckSlides(src, [0])[0]?.notes).toBe('inline note\n\nin the item');
  });

  it('keeps the list of directives of Marp, and nothing else', async () => {
    const found: string[] = [];
    const deck = async (key: string): Promise<boolean> => {
      const out = await renderDeck(`<!-- ${key}: x -->\n\nhi\n`, () => Promise.resolve(null));
      return out.notes[0] === ''; // no note: a directive
    };
    for (const k of [
      'marp',
      'title',
      'description',
      'author',
      'keywords',
      'url',
      'image',
      'transition',
      ...DIRECTIVE_KEYS,
      ...DIRECTIVE_KEYS.map((k) => `_${k}`),
      '_theme',
      '_size',
    ]) {
      if (await deck(k)) found.push(k);
    }
    const ours = (k: string): boolean =>
      deckSlides(`<!-- ${k}: x -->\n\nhi\n`, [0])[0]?.notes === '';
    for (const k of found) expect(ours(k), k).toBe(true);
    expect(found).toEqual(expect.arrayContaining(DIRECTIVE_KEYS as string[]));
    for (const k of ['marp', 'title', 'author', 'transition', '_theme', '_size'])
      expect(found.includes(k) || ours(k), k).toBe(false);
  });

  it('never writes a note that Marp would take for a directive', async () => {
    const out = apply('# A\n', notesEdit('# A\n', [0], 0, 'theme: dark\nclass: lead'));
    const deck = await renderDeck(out, () => Promise.resolve(null));
    expect(deck.notes[0]).toBe('theme\u200b: dark\nclass\u200b: lead');
    expect(deckSlides(out, [0])[0]?.notes).toBe(deck.notes[0]);
    expect(deck.css).not.toContain('gaia');
  });

  it('handles a file with CRLF line breaks', () => {
    const src = DECK.replace(/\n/g, '\r\n');
    const lines = linesOf(src.replace(/\r/g, ''));
    const s = deckSlides(src, lines);
    expect(s.map((x) => x.title)).toEqual(['One', 'Two', 'Plain three']);
    expect(canReorder(src, lines)).toBe(true);
    expect(s[1]).toMatchObject({ start: 9, bodyStart: 10 });
    expect(deckSettings(src).theme).toBe('gaia');
    const withNote = src.replace(
      'text of one',
      'text of one\r\n\r\n<!-- n -->\r\n<!-- clarae: hidden -->',
    );
    expect(deckSlides(withNote, linesOf(withNote.replace(/\r/g, '')))[0]).toMatchObject({
      notes: 'n',
      hidden: true,
    });
  });

  it('puts the marker of a last, empty slide after its separator', () => {
    const src = '# A\n\n---';
    const out = apply(src, hiddenEdit(src, [0, 2], 1, true));
    expect(out).toBe('# A\n\n---\n<!-- clarae: hidden -->');
    const s = deckSlides(out, [0, 2]);
    expect(s.map((x) => x.hidden)).toEqual([false, true]);
  });

  const TRICKY = [
    '# A\n\nWrite `<!-- n -->` here <!-- real -->\n',
    '# A\n\n    <!-- code -->\n\n<!-- note -->\n',
    '# A\n\n```md\n<!-- code -->\n```\n\n<!-- note -->\n<!-- clarae: hidden -->\n',
    '# A\r\n\r\n<!-- note -->\r\n\r\n---\r\n\r\n# B\r\n<!-- clarae: hidden -->\r\n',
    '---\nmarp: true\ntheme: gaia\n---\n\n<!-- _class: lead -->\n<!-- title: x -->\n# A\n\n---\n\n<!-- paginate: true\nheaderx: y -->\n',
    '# A\n\n<!--\nmulti\n\nparagraph note\n-->\n\ntext ``<!-- two ticks -->`` x\n',
    '# A\n\n<!-- prettier-ignore -->\n- a\n  `<!-- c -->` b\n',
    '# A <!-- in a heading -->\n\n<!-- a --> trailing <!-- b -->\n',
    '# A\n\ntext `unclosed <!-- note --> end\n',
    // a block comment cannot interrupt a paragraph: both are inline, and the text stays
    '# A\ntext\n<!-- n --> tail <!-- m -->\n',
    '# A\n\n- item\n<!-- lazy --> x\n',
    // a fence is closed by a line without an info string
    '# A\n\n```md\n```js\n<!-- in code -->\n```\n\n<!-- n -->\n',
    // a code span cannot run past the end of its paragraph
    '# A\n\nUse the ` char\n- item ` <!-- n --> `x`\n',
    '# A\n\nUse the ` char\n\n<!-- n --> `x`\n',
    // flow-style YAML is a directive too
    '# A\n\n<!-- {theme: gaia} -->\n',
    '# A\n\n<!-- { "_class": lead, foo: bar } -->\n<!-- {note: x} -->\n',
    '# A\n\n> <!-- bq note -->\n',
    '# A\n\n| a <!-- t --> | b |\n|---|---|\n| 1 | 2 |\n',
    '# A\n\ntext <!-- a -- b --> x\n',
    '1.  item\n\n    <!-- in item -->\n',
    '# A\n\n\t<!-- code -->\n\n<!-- n -->\n',
    '# A\n\n<!-- a &amp; b -->\n',
  ];
  it.each(TRICKY.map((t, i) => [i, t] as const))(
    'agrees with Marp on the notes and the hidden slides (%i)',
    async (_i, src) => {
      const deck = await renderDeck(src, () => Promise.resolve(null));
      const mine = deckSlides(src, deck.slideLines);
      expect(mine.map((x) => x.hidden)).toEqual(deck.hidden);
      expect(mine.map((x) => x.notes)).toEqual(deck.notes);
    },
  );
});

describe('notes edits keep the note off the slide (ADR-0048)', () => {
  const none = () => Promise.resolve(null);
  const textOf = (html: string): string =>
    new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  it.each([
    ['a list item', '# A\n\n- item\n\n  <!-- old -->\n'],
    ['a blockquote', '# A\n\n> <!-- old -->\n'],
    ['a paragraph', '# A\n\ntext <!-- old --> more\n'],
    ['a block', '# A\n\ntext\n\n<!-- old -->\n'],
    ['a block after a list', '# A\n\n- item\n\n<!-- old -->\n\n---\n\n# B\n'],
  ])('a multi-line note replaces one in %s', async (_label, src) => {
    const before = await renderDeck(src, none);
    const out = apply(src, notesEdit(src, before.slideLines, 0, 'line one\n\nline two'));
    const deck = await renderDeck(out, none);
    const mine = deckSlides(out, deck.slideLines);
    expect(deck.notes[0]).toBe('line one\n\nline two');
    expect(mine.map((x) => x.notes)).toEqual(deck.notes);
    expect(mine.map((x) => x.hidden)).toEqual(deck.hidden);
    expect(textOf(deck.html)).not.toMatch(/line (one|two)|-->/);
    // and a single line goes in place, wherever the old note was
    const one = apply(src, notesEdit(src, before.slideLines, 0, 'just one'));
    const d1 = await renderDeck(one, none);
    expect(d1.notes[0]).toBe('just one');
    expect(textOf(d1.html)).not.toContain('just one');
  });

  it('removes the old note when it is written again as a block, with the other notes', async () => {
    const src = '# A\n\n- item\n\n  <!-- old -->\n\n<!-- other -->\n';
    const out = apply(src, notesEdit(src, [0], 0, 'a\nb'));
    const deck = await renderDeck(out, none);
    expect(deck.notes[0]).toBe('a\nb');
    expect(deckSlides(out, deck.slideLines)[0]?.notes).toBe('a\nb');
    expect(textOf(deck.html)).not.toMatch(/\bb\b.*other|other/);
  });

  it('does not let a flow-style note become a directive, and shows no invisible character', async () => {
    const out = apply('# A\n', notesEdit('# A\n', [0], 0, '{theme: dark}'));
    const deck = await renderDeck(out, none);
    expect(deck.css).not.toContain('gaia');
    expect(deck.notes[0]).toBe('{theme\u200b: dark}');
    expect(deckSlides(out, [0])[0]?.notes).toBe(deck.notes[0]);
  });
});

describe('page numbers when slides are left out (ADR-0048)', () => {
  const none = () => Promise.resolve(null);
  const FM = '---\npaginate: true\n---\n';
  const pages = (html: string): string[] =>
    [
      ...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('div.marpit > svg'),
    ].map((svg) => {
      const sec = svg.querySelector('section');
      return `${sec?.getAttribute('data-marpit-pagination') ?? '-'}/${sec?.getAttribute('data-marpit-pagination-total') ?? '-'}`;
    });
  it.each([
    [
      'skip, left out',
      `${FM}# 1\n\n---\n<!-- _paginate: skip -->\n# 2\n<!-- clarae: hidden -->\n\n---\n# 3\n`,
      ['1/2', '2/2'],
    ],
    [
      'hold, left out',
      `${FM}# 1\n\n---\n<!-- _paginate: hold -->\n# 2\n<!-- clarae: hidden -->\n\n---\n# 3\n`,
      ['1/2', '2/2'],
    ],
    [
      'false, left out',
      `${FM}# 1\n\n---\n<!-- _paginate: false -->\n# 2\n<!-- clarae: hidden -->\n\n---\n# 3\n`,
      ['1/2', '2/2'],
    ],
    [
      'plain, left out',
      `${FM}# 1\n\n---\n# 2\n<!-- clarae: hidden -->\n\n---\n# 3\n`,
      ['1/2', '2/2'],
    ],
    [
      'false, kept',
      `${FM}# 1\n<!-- clarae: hidden -->\n\n---\n<!-- _paginate: false -->\n# 2\n\n---\n# 3\n`,
      ['-/-', '2/2'],
    ],
    [
      'skip, kept',
      `${FM}# 1\n\n---\n<!-- _paginate: skip -->\n# 2\n\n---\n# 3\n<!-- clarae: hidden -->\n\n---\n# 4\n`,
      ['1/2', '-/-', '2/2'],
    ],
    [
      'hold, kept',
      `${FM}# 1\n<!-- clarae: hidden -->\n\n---\n<!-- _paginate: hold -->\n# 2\n\n---\n# 3\n`,
      ['1/1', '1/1'],
    ],
    [
      'inherited skip, left out',
      `${FM}# 1\n\n---\n<!-- paginate: skip -->\n# 2\n<!-- clarae: hidden -->\n\n---\n# 3\n\n---\n<!-- paginate: true -->\n# 4\n`,
      ['1/2', '-/-', '2/2'],
    ],
  ])('closes the gap the way Marp numbers the kept slides alone (%s)', async (_l, src, want) => {
    const deck = await renderDeck(src, none);
    expect(pages(includedDeck(deck).html)).toEqual(want);
  });
});
