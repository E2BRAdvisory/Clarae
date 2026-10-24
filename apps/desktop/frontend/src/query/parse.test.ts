import { describe, expect, it } from 'vitest';
import { parseQueryBlock } from './parse';
import { appendHighlighted, queryTerms } from './highlight';

describe('parseQueryBlock', () => {
  it('keeps plain search syntax untouched', () => {
    const s = parseQueryBlock('tag:#todo path:"Projects/" -draft [status:open]');
    expect(s.query).toBe('tag:#todo path:"Projects/" -draft [status:open]');
    expect(s).toMatchObject({ sort: 'relevance', limit: undefined, view: 'list', context: true });
    expect(s.problems).toEqual([]);
  });

  it('reads option lines and joins the other lines', () => {
    const s = parseQueryBlock(
      'meeting\nfile:notes\nsort: modified\nlimit: 5\nview: cards\ncontext: off\nself: include\n',
    );
    expect(s.query).toBe('meeting file:notes');
    expect(s).toMatchObject({
      sort: 'modified',
      limit: 5,
      view: 'cards',
      context: false,
      self: 'include',
    });
  });

  it('collects options it does not understand without dropping the query', () => {
    const s = parseQueryBlock('x\nsort: sideways\nlimit: lots\nview: grid');
    expect(s.query).toBe('x');
    expect(s.problems).toHaveLength(3);
  });

  it('caps the limit', () => {
    expect(parseQueryBlock('x\nlimit: 99999').limit).toBe(500);
  });
});

describe('highlight', () => {
  it('extracts the words that carry text', () => {
    expect(queryTerms('tag:#a "big idea" -skip file:Plan OR /re.x/ [p:v] (x)')).toEqual([
      'big idea',
      'plan',
      'x',
    ]);
  });

  it('wraps matches in <mark> with DOM nodes only', () => {
    const el = document.createElement('div');
    appendHighlighted(el, 'A <b>Big</b> idea, big', ['big', 'idea']);
    expect(el.innerHTML).toBe(
      'A &lt;b&gt;<mark>Big</mark>&lt;/b&gt; <mark>idea</mark>, <mark>big</mark>',
    );
  });
});
