import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import type { Suggestion } from '../../app/api';
import { linkTextFor, ofmCompletionSources, type CompletionBackend } from './completions';
import { htmlToMarkdown } from './paste';

const sug = (over: Partial<Suggestion>): Suggestion => ({
  kind: 'note',
  label: 'X',
  path: 'X.md',
  detail: '',
  line: 0,
  score: 1,
  ...over,
});

describe('link text', () => {
  const s = sug({ label: 'Plan', path: 'Projects/Plan.md' });
  it('honors the link format', () => {
    expect(linkTextFor(s, 'Notes/A.md', 'shortest', false)).toBe('Plan');
    expect(linkTextFor(s, 'Notes/A.md', 'shortest', true)).toBe('Projects/Plan');
    expect(linkTextFor(s, 'Notes/A.md', 'path', false)).toBe('Projects/Plan');
    expect(linkTextFor(s, 'Notes/A.md', 'relative', false)).toBe('../Projects/Plan');
    expect(
      linkTextFor(sug({ path: 'Notes/B.md', label: 'B' }), 'Notes/A.md', 'relative', false),
    ).toBe('B');
  });
  it('names a presentation in full: only a .md note resolves by its title', () => {
    const deck = sug({ label: 'Review', path: 'Talks/Review.marp' });
    expect(linkTextFor(deck, 'Notes/A.md', 'shortest', false)).toBe('Review.marp');
    expect(linkTextFor(deck, 'Notes/A.md', 'path', false)).toBe('Talks/Review.marp');
  });
});

describe('completion sources', () => {
  const calls: string[] = [];
  const backend: CompletionBackend = {
    suggest: (kind, query, notePath) => {
      calls.push(`${kind}:${query}:${notePath}`);
      if (kind === 'notes')
        return Promise.resolve([
          sug({ label: 'Roadmap', path: 'Roadmap.md' }),
          sug({ kind: 'alias', label: 'Plan', path: 'Roadmap.md', detail: 'Roadmap' }),
        ]);
      if (kind === 'headings')
        return Promise.resolve([
          sug({ kind: 'heading', label: 'Goals', path: 'Roadmap.md', detail: '##' }),
        ]);
      if (kind === 'tags')
        return Promise.resolve([sug({ kind: 'tag', label: 'travel', detail: '3' })]);
      if (kind === 'properties')
        return Promise.resolve([sug({ kind: 'property', label: 'status', detail: 'text' })]);
      return Promise.resolve([sug({ kind: 'block', label: 'b1', detail: 'text' })]);
    },
    resolve: (_f, t) => Promise.resolve(t ? t + '.md' : 'Cur.md'),
  };
  const sources = ofmCompletionSources({
    backend,
    notePath: () => 'Cur.md',
    linkFormat: () => 'shortest',
  });
  const run = async (i: number, doc: string, pos = doc.length) => {
    const state = EditorState.create({ doc });
    return sources[i]?.(new CompletionContext(state, pos, false));
  };

  it('completes notes and aliases after [[', async () => {
    const r = await run(0, 'see [[Ro');
    const res = r && 'options' in r ? r : null;
    expect(res?.from).toBe(6);
    expect(res?.options.map((o) => o.label)).toEqual(['Roadmap', 'Plan']);
    expect(calls).toContain('notes:Ro:');
  });

  it('completes headings and blocks of the linked note', async () => {
    const h = await run(0, '[[Roadmap#Go');
    expect(h && 'options' in h && h.options[0]?.displayLabel).toBe('Goals');
    expect(calls).toContain('headings:Go:Roadmap.md');
    const b = await run(0, '[[#^b');
    expect(b && 'options' in b && b.options[0]?.displayLabel).toBe('^b1');
    expect(calls).toContain('blocks:b:Cur.md');
  });

  it('does not trigger outside wikilinks, and completes tags only after the # character', async () => {
    expect(await run(0, 'plain text')).toBeNull();
    const t = await run(1, 'a #tra');
    expect(t && 'options' in t && t.options[0]?.label).toBe('travel');
    expect(await run(1, '# Heading')).toBeNull();
  });

  it('completes property names only inside the frontmatter', async () => {
    const inside = await run(2, '---\nsta\n---\n\nbody', 7);
    expect(inside && 'options' in inside && inside.options[0]?.label).toBe('status');
    expect(await run(2, '---\nstatus: x\n---\n\nbo', 20)).toBeNull();
    expect(await run(2, 'no frontmatter\nsta', 18)).toBeNull();
  });
});

describe('smart paste conversion', () => {
  it('converts rich HTML to Markdown', () => {
    expect(
      htmlToMarkdown(
        '<h2>Title</h2><p>Some <strong>bold</strong> and <a href="https://e.com">link</a></p><ul><li>a</li><li>b</li></ul>',
      ),
    ).toBe('## Title\n\nSome **bold** and [link](https://e.com)\n\n- a\n- b');
  });
});
