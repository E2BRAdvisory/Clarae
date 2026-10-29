import { describe, expect, it } from 'vitest';
import { wikilinkAt } from './target';
import { placePopover } from './popover';

describe('wikilinkAt', () => {
  const line = 'See [[Note#Head|alias]], ![[Embed]] and [[Other#^blk]] now \\[[esc]]';

  it('finds the link under a column and parses heading, block and alias', () => {
    const a = wikilinkAt(line, 8);
    expect(a?.spec).toEqual({
      target: 'Note',
      heading: 'Head',
      block: '',
      alias: 'alias',
      embed: false,
    });
    expect(a && line.slice(a.from, a.to)).toBe('[[Note#Head|alias]]');
    expect(wikilinkAt(line, 4)?.spec.target).toBe('Note'); // on the opening bracket
    const b = wikilinkAt(line, line.indexOf('[[Other') + 3);
    expect(b?.spec).toMatchObject({ target: 'Other', block: 'blk', heading: '' });
  });

  it('ignores plain text, embeds and escaped links', () => {
    expect(wikilinkAt(line, 0)).toBeNull();
    expect(wikilinkAt(line, line.indexOf('Embed'))).toBeNull();
    expect(wikilinkAt(line, line.indexOf('esc'))).toBeNull();
    expect(wikilinkAt('[[ ]]', 2)).toBeNull();
  });

  it('accepts a same-note heading link', () => {
    expect(wikilinkAt('[[#Top]]', 3)?.spec).toMatchObject({ target: '', heading: 'Top' });
  });
});

describe('placePopover', () => {
  const vp = { width: 1000, height: 700 };
  const size = { width: 440, height: 300 };

  it('goes below the anchor when it fits', () => {
    expect(placePopover({ left: 100, right: 160, top: 50, bottom: 70 }, size, vp)).toEqual({
      left: 100,
      top: 76,
    });
  });

  it('flips above when there is no room below', () => {
    const p = placePopover({ left: 100, right: 160, top: 500, bottom: 520 }, size, vp);
    expect(p.top).toBe(500 - 6 - 300);
  });

  it('stays on screen horizontally and vertically', () => {
    expect(placePopover({ left: 900, right: 950, top: 50, bottom: 70 }, size, vp).left).toBe(552);
    const small = { width: 1000, height: 200 };
    expect(placePopover({ left: 0, right: 10, top: 100, bottom: 120 }, size, small).top).toBe(8);
  });
});
