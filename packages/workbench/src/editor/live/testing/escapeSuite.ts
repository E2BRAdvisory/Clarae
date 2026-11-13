// The escape invariant (B2), as a property: what `extract()` finds in a block written by the editor
// is what the document has there, no more and no less. Text the user typed is text: written out, it
// never becomes a link, a tag, a block id or a comment, and read again it is the same text.
// Registered by src/test/conformance.test.ts (`task conformance`), where it is blocking.
import { extract } from '@clarae/markdown';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeComposer, type Composer } from '../fidelity/compose';
import { defaultStyle } from '../fidelity/style';
import { createLiveCore, type LiveCore } from '../headless';
import { rng } from './metrics';

export function describeEscapeInvariant(): void {
  // More runs, other sequences: LIVE_PROPERTY_RUNS=50000 LIVE_PROPERTY_SEED=3 (the defaults are the CI ones)
  const RUNS = Number(process.env['LIVE_PROPERTY_RUNS'] ?? 4000);
  const SEED = Number(process.env['LIVE_PROPERTY_SEED'] ?? 7);

  let core: LiveCore;
  let composer: Composer;
  beforeAll(async () => {
    core = await createLiveCore();
    composer = makeComposer(core);
  });
  afterAll(() => core.destroy());

  /** The pieces text is made of: every character the OFM rules and the Markdown serializer care about. */
  const PIECES = [
    '[[',
    ']]',
    '[',
    ']',
    '[[x]]',
    '[[a|b]]',
    '![[e.png]]',
    '!',
    '#',
    '#tag',
    '#a/b',
    '#1',
    'C#',
    ' #t',
    '^id',
    ' ^abc',
    '^[',
    '[^1]',
    '%%',
    '%%c%%',
    '$',
    '$$',
    '$x$',
    '==',
    '==h==',
    '*',
    '_',
    '**',
    '\\',
    '(',
    ')',
    '[x](y)',
    '[x][y]',
    '[x]:',
    '|',
    '`',
    '~~',
    ':',
    '<',
    '>',
    '&amp;',
    '&',
    ' ',
    '  ',
    'x',
    'ab',
    'word',
    '1.',
    '- ',
    '+ ',
    '> ',
    '1)',
    '---',
    '===',
    '[!note]',
    '[ ]',
    '[/]',
  ];

  function paragraphOf(text: string): PMNode {
    const { schema } = core;
    return schema.nodes['paragraph']!.create(null, text === '' ? [] : [schema.text(text)]);
  }

  /** A paragraph written alone with the style of a file (what the composer does for a dirty block). */
  function write(node: PMNode): string {
    return composer.fresh(node, defaultStyle);
  }

  /** What the index would find in `md`: links, tags, block ids, tasks, footnotes, headings. */
  function found(md: string) {
    const d = extract('t', md);
    return {
      links: d.links.map((l) => `${l.kind}:${l.target}`),
      tags: d.tags.map((t) => t.name),
      blockIds: d.blockIds.map((b) => b.id),
      tasks: d.tasks.length,
      footnotes: d.footnotes,
      headings: d.headings.length,
    };
  }

  const NONE = { links: [], tags: [], blockIds: [], tasks: 0, footnotes: [], headings: 0 };

  describe('text typed by the user stays text (B2)', () => {
    it('written out, it is found as nothing by the index, and read again it is the same text', () => {
      const rand = rng(SEED);
      const failures: string[] = [];
      let n = 0;
      for (let i = 0; i < RUNS; i++) {
        const parts = Array.from(
          { length: 1 + Math.floor(rand() * 7) },
          () => PIECES[Math.floor(rand() * PIECES.length)]!,
        );
        const text = parts.join('');
        // a text node of the editor never starts or ends with a line break; whitespace alone is not a block
        if (text.trim() === '' || /^\s|\s$/.test(text)) continue;
        // a URL typed as text is an external link for the index: out of this property
        n++;
        const md = write(paragraphOf(text));
        const f = found(md);
        if (JSON.stringify(f) !== JSON.stringify(NONE)) {
          failures.push(
            `${JSON.stringify(text)} -> ${JSON.stringify(md)} found ${JSON.stringify(f)}`,
          );
          continue;
        }
        // read again: one paragraph with the same text (`==x==` typed is a highlight once read: the
        // index does not know highlights, and Reading shows the text highlighted, as Obsidian does)
        if (/==/.test(text)) continue;
        const back = core.parse(md);
        const same =
          back.childCount === 1 &&
          back.child(0).type.name === 'paragraph' &&
          back.child(0).textContent === text;
        if (!same)
          failures.push(
            `${JSON.stringify(text)} -> ${JSON.stringify(md)} read as ${back.toString()}`,
          );
      }
      expect(n).toBeGreaterThan(RUNS * 0.7);
      expect(failures.slice(0, 25)).toEqual([]);
    }, 600_000);

    it('the cases the property found once, by name', () => {
      const cases: [string, string][] = [
        ['[[x]]', '\\[[x]]'],
        ['a [[x]] b', 'a \\[[x]] b'],
        ['#tag', '\\#tag'],
        ['see #a/b and #tag.', 'see \\#a/b and \\#tag.'],
        ['C# and #1 and (#x)', 'C# and #1 and (\\#x)'],
        ['end ^abc', 'end \\^abc'],
        ['a %%b%% c', 'a \\%\\%b\\%\\% c'],
        ['[!note]', '[!note]'],
      ];
      for (const [text, md] of cases) expect(write(paragraphOf(text))).toBe(md);
    });
  });

  describe('what the document has as OFM is what the index finds (B2)', () => {
    function inline(
      pieces: (
        string | { wikilink: string; embed?: boolean } | { tag: string } | { blockId: string }
      )[],
    ): PMNode {
      const { schema } = core;
      const nodes: PMNode[] = [];
      for (const p of pieces) {
        if (typeof p === 'string') nodes.push(schema.text(p));
        else if ('wikilink' in p) {
          nodes.push(
            schema.nodes['ofm_wikilink']!.create({ embed: Boolean(p.embed) }, [
              schema.text(p.wikilink),
            ]),
          );
        } else if ('tag' in p) nodes.push(schema.text(p.tag, [schema.marks['ofm_tag']!.create()]));
        else nodes.push(schema.text(p.blockId, [schema.marks['ofm_blockid']!.create()]));
      }
      return schema.nodes['paragraph']!.create(null, nodes);
    }

    it('wikilinks, embeds, tags and block ids are written as they are, never escaped', () => {
      const para = inline([
        'See ',
        { wikilink: 'Note#H|alias' },
        ' and ',
        { wikilink: 'img.png|300', embed: true },
        ' with ',
        { tag: '#a/b' },
        ' end ',
        { blockId: '^abc-1' },
      ]);
      const md = write(para);
      expect(md).toBe('See [[Note#H|alias]] and ![[img.png|300]] with #a/b end ^abc-1');
      const f = found(md);
      expect(f.links).toEqual(['wikilink:Note', 'wikilink:img.png']);
      expect(f.tags).toEqual(['a/b']);
      expect(f.blockIds).toEqual(['abc-1']);
    });

    it('plain text around them is still plain text', () => {
      const para = inline(['a [[typed]] ', { wikilink: 'real' }, ' and #typed ', { tag: '#real' }]);
      const md = write(para);
      expect(md).toBe('a \\[[typed]] [[real]] and \\#typed #real');
      const f = found(md);
      expect(f.links).toEqual(['wikilink:real']);
      expect(f.tags).toEqual(['real']);
    });

    it('random mixes: the index finds exactly the nodes of the document', () => {
      const rand = rng(SEED + 4);
      const words = ['x', 'word', '[[', ']]', '#t', '#', '^', '%%', '[', ']', '*', ' ', 'a b'];
      const failures: string[] = [];
      for (let i = 0; i < RUNS / 2; i++) {
        const pieces: Parameters<typeof inline>[0] = [];
        const links: string[] = [];
        const tags: string[] = [];
        const count = 1 + Math.floor(rand() * 5);
        for (let k = 0; k < count; k++) {
          const r = rand();
          if (r < 0.25) {
            const target = ['A', 'b c', 'd#e', 'f|g'][Math.floor(rand() * 4)]!;
            pieces.push({ wikilink: target });
            links.push(`wikilink:${target.split(/[|#]/)[0]!.trim()}`);
          } else if (r < 0.4) {
            // a tag needs a boundary before it
            pieces.push(' ', { tag: '#tg' }, ' ');
            tags.push('tg');
          } else {
            pieces.push(
              words[Math.floor(rand() * words.length)]! + words[Math.floor(rand() * words.length)]!,
            );
          }
        }
        const para = inline(pieces);
        if (para.textContent.trim() === '' || /^\s|\s$/.test(para.textContent)) continue;
        const md = write(para);
        const f = found(md);
        if (
          JSON.stringify(f.links) !== JSON.stringify(links) ||
          JSON.stringify(f.tags) !== JSON.stringify(tags) ||
          f.blockIds.length > 0
        ) {
          failures.push(
            `${para.toString()} -> ${JSON.stringify(md)} found ${JSON.stringify({ links: f.links, tags: f.tags, blockIds: f.blockIds })}`,
          );
        }
      }
      expect(failures.slice(0, 20)).toEqual([]);
    }, 600_000);
  });
}
