import { describe, expect, it } from 'vitest';
import { appendRootKeys, withFileExtra } from './serialize';

const slow = (json: string, rest: Record<string, unknown>): string =>
  JSON.stringify({ ...(JSON.parse(json) as object), ...rest }, null, 2);

const scene = JSON.stringify(
  {
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'a', text: 'line\nbreak "quoted" }' }],
    appState: { gridSize: null },
    files: {},
  },
  null,
  2,
);

describe('the extra keys of a drawing file', () => {
  it('appends them as a parse and a stringify would', () => {
    for (const rest of [
      { clarae: { slideLoop: 'true', nested: { deep: [1, 2, { x: null }] } } },
      { clarae: {}, other: 'text\nwith a break', n: 3, list: [] },
      { 'odd "key"': true },
    ]) {
      expect(appendRootKeys(scene, rest)).toBe(slow(scene, rest));
    }
  });

  it('leaves the text alone when there is nothing to add', () => {
    expect(appendRootKeys(scene, {})).toBe(scene);
    expect(appendRootKeys(scene, { gone: undefined })).toBe(scene);
  });

  it('takes the slow way for a text that is not laid out on two spaces', () => {
    const compact = JSON.stringify(JSON.parse(scene));
    expect(appendRootKeys(compact, { clarae: { a: 1 } })).toBe(slow(compact, { clarae: { a: 1 } }));
    expect(appendRootKeys('{}', { clarae: { a: 1 } })).toBe(slow('{}', { clarae: { a: 1 } }));
  });

  it('writes the settings of a 1.x file under the current key only', () => {
    const out = JSON.parse(withFileExtra(scene, { memobrain: { slideLoop: 'true' } })) as Record<
      string,
      unknown
    >;
    expect(out['clarae']).toEqual({ slideLoop: 'true' });
    expect(out['memobrain']).toBeUndefined();
    expect(out['elements']).toHaveLength(1);
  });
});
