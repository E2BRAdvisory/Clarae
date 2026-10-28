import { describe, expect, it } from 'vitest';
import type { SceneElement } from './actions/types';
import { describeScene } from './describe';

const el = (id: string, type: string, x: number, y: number, extra = {}): SceneElement => ({
  id,
  type,
  x,
  y,
  version: 1,
  versionNonce: 1,
  ...extra,
});

describe('describeScene', () => {
  it('counts types, orders texts and frames, lists links and skips deleted elements', () => {
    const d = describeScene([
      el('r1', 'rectangle', 0, 0),
      el('r2', 'rectangle', 50, 0, { link: '[[Plan]]' }),
      el('r3', 'rectangle', 0, 0, { isDeleted: true }),
      el('t2', 'text', 0, 100, { text: 'second' }),
      el('t1', 'text', 0, 10, { text: ' first ' }),
      el('t0', 'text', 0, 0, { text: '   ' }),
      el('f', 'frame', 0, 0, { name: 'Intro' }),
    ]);
    expect(d.counts).toEqual(
      [
        { type: 'rectangle', count: 2 },
        { type: 'text', count: 3 },
        { type: 'frame', count: 1 },
      ].sort((a, b) => b.count - a.count),
    );
    expect(d.texts).toEqual(['first', 'second']);
    expect(d.frames).toEqual(['Intro']);
    expect(d.links).toEqual(['[[Plan]]']);
  });

  it('describes an empty drawing', () => {
    expect(describeScene([])).toEqual({ counts: [], frames: [], texts: [], links: [] });
  });
});
