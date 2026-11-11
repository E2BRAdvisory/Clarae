import { describe, expect, it } from 'vitest';
import { tagSearchOf } from './linkSpec';

const spec = (over: Partial<Parameters<typeof tagSearchOf>[0]> = {}) => ({
  target: '',
  heading: '',
  block: '',
  alias: '',
  ...over,
});

describe('the search a followed link stands for', () => {
  it('is the tag search for a link with no target and a #tag as its alias', () => {
    expect(tagSearchOf(spec({ alias: '#topic' }))).toBe('tag:#topic');
    expect(tagSearchOf(spec({ alias: '#a/b-c_d' }))).toBe('tag:#a/b-c_d');
    expect(tagSearchOf(spec({ alias: '#àé1' }))).toBe('tag:#àé1');
  });

  it('is nothing for a link to a note, even one whose alias looks like a tag', () => {
    expect(tagSearchOf(spec({ target: 'Note', alias: '#topic' }))).toBeNull();
    expect(tagSearchOf(spec({ heading: 'H', alias: '#topic' }))).toBeNull();
    expect(tagSearchOf(spec({ block: 'b', alias: '#topic' }))).toBeNull();
  });

  it('is nothing for an alias that is no tag', () => {
    expect(tagSearchOf(spec())).toBeNull();
    expect(tagSearchOf(spec({ alias: '#' }))).toBeNull();
    expect(tagSearchOf(spec({ alias: 'topic' }))).toBeNull();
    expect(tagSearchOf(spec({ alias: '#two words' }))).toBeNull();
  });
});
