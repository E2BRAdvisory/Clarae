import { describe, expect, it } from 'vitest';
import { applyPatch } from './apply';
import { actionById, SCENE_ACTIONS } from './registry';
import type { SceneElement } from './types';

const el = (over: Partial<SceneElement> & { id: string; type: string }): SceneElement => ({
  version: 3,
  versionNonce: 7,
  ...over,
});

describe('applyPatch', () => {
  it('bumps version and nonce only on touched elements', () => {
    const els = [el({ id: 'a', type: 'text' }), el({ id: 'b', type: 'text' })];
    const out = applyPatch(els, { update: { a: { text: 'x' } } }, () => 99, 1000);
    expect(out[0]).toMatchObject({ text: 'x', version: 4, versionNonce: 99, updated: 1000 });
    expect(out[1]).toBe(els[1]);
  });

  it('marks removed elements deleted instead of dropping them', () => {
    const out = applyPatch([el({ id: 'a', type: 'text' })], { remove: ['a'] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ isDeleted: true, version: 4 });
  });
});

describe('scene actions', () => {
  it('have unique ids', () => {
    expect(new Set(SCENE_ACTIONS.map((a) => a.id)).size).toBe(SCENE_ACTIONS.length);
  });

  it('reverse-arrows swaps ends and keeps the arrow in place', () => {
    const arrow = el({
      id: 'r',
      type: 'arrow',
      x: 10,
      y: 20,
      points: [
        [0, 0],
        [100, 50],
      ],
      endArrowhead: 'arrow',
      startArrowhead: null,
    });
    const patch = actionById('reverse-arrows')!.run({ elements: [arrow], selected: ['r'] });
    expect(patch.update!.r).toMatchObject({
      x: 110,
      y: 70,
      points: [
        [0, 0],
        [-100, -50],
      ],
      startArrowhead: 'arrow',
      endArrowhead: null,
    });
  });

  it('bullet-points is idempotent and ignores unselected text', () => {
    const els = [
      el({ id: 't1', type: 'text', text: 'one', originalText: 'one' }),
      el({ id: 't2', type: 'text', text: '• two', originalText: '• two' }),
      el({ id: 't3', type: 'text', text: 'three', originalText: 'three' }),
    ];
    const patch = actionById('bullet-points')!.run({ elements: els, selected: ['t1', 't2'] });
    expect(Object.keys(patch.update!)).toEqual(['t1']);
    expect(patch.update!.t1).toMatchObject({ text: '• one', originalText: '• one' });
  });

  it('cycle-stroke-width steps 1 → 2 → 4 → 1', () => {
    const run = (w: number) =>
      actionById('cycle-stroke-width')!.run({
        elements: [el({ id: 's', type: 'rectangle', strokeWidth: w })],
        selected: ['s'],
      }).update!.s?.strokeWidth;
    expect([run(1), run(2), run(4)]).toEqual([2, 4, 1]);
  });
});
