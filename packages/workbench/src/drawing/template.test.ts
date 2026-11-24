import { describe, expect, it } from 'vitest';
import { cloneScene } from './actions/factory';
import type { SceneElement } from './actions/types';
import { templatePatch } from './template';

const el = (id: string, type: string, extra: Record<string, unknown> = {}): SceneElement => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  version: 7,
  versionNonce: 1,
  ...extra,
});

const scene = [
  el('frame', 'frame', { x: -50, y: -50, width: 400, height: 300 }),
  el('box', 'rectangle', {
    frameId: 'frame',
    groupIds: ['g1'],
    boundElements: [
      { id: 'label', type: 'text' },
      { id: 'arrow', type: 'arrow' },
      { id: 'gone', type: 'arrow' },
    ],
  }),
  el('label', 'text', { containerId: 'box', groupIds: ['g1'], frameId: 'frame' }),
  el('other', 'ellipse', { x: 200, boundElements: [{ id: 'arrow', type: 'arrow' }] }),
  el('arrow', 'arrow', {
    startBinding: { elementId: 'box', focus: 0, gap: 1 },
    endBinding: { elementId: 'other', focus: 0, gap: 1 },
  }),
  el('loose', 'arrow', { startBinding: { elementId: 'outside' }, endBinding: null }),
  el('pic', 'image', { fileId: 'f1', frameId: 'outside' }),
];

describe('cloneScene', () => {
  const out = cloneScene(scene, 10, 20, 123);
  const by = (i: number): SceneElement => out[i] as SceneElement;
  const id = (i: number): string => by(i).id;

  it('gives every element a new id and keeps the order', () => {
    expect(out.map((e) => e.type)).toEqual(scene.map((e) => e.type));
    const ids = new Set(out.map((e) => e.id));
    expect(ids.size).toBe(scene.length);
    for (const e of scene) expect(ids.has(e.id)).toBe(false);
    expect(by(1)).toMatchObject({
      x: 10,
      y: 20,
      version: 1,
      index: null,
      isDeleted: false,
      updated: 123,
    });
  });

  it('keeps the references between the elements', () => {
    expect(by(1)['frameId']).toBe(id(0));
    expect(by(2)['containerId']).toBe(id(1));
    expect(by(1)['boundElements']).toEqual([
      { id: id(2), type: 'text' },
      { id: id(4), type: 'arrow' },
    ]);
    expect(by(4)['startBinding']).toEqual({ elementId: id(1), focus: 0, gap: 1 });
    expect(by(4)['endBinding']).toEqual({ elementId: id(3), focus: 0, gap: 1 });
    // One group stays one group, under a new id.
    expect(by(1)['groupIds']).toEqual(by(2)['groupIds']);
    expect(by(1)['groupIds']).not.toEqual(['g1']);
  });

  it('drops the references to what is not copied, and adds no key an element did not have', () => {
    expect(by(5)['startBinding']).toBeNull();
    expect(by(6)['frameId']).toBeNull();
    expect(by(6)['fileId']).toBe('f1');
    expect('containerId' in by(0)).toBe(false);
    expect('startBinding' in by(1)).toBe(false);
  });

  it('never repeats an id across two copies', () => {
    const again = cloneScene(scene, 0, 0);
    expect(again.some((e) => out.some((o) => o.id === e.id))).toBe(false);
  });
});

describe('templatePatch', () => {
  const file = (elements: unknown[], files: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: {}, files });

  it('centers the template on the point and brings only the pictures it uses', () => {
    const text = file(
      [
        el('a', 'rectangle', { x: 100, y: 100 }),
        el('p', 'image', { x: 300, y: 100, fileId: 'f1' }),
      ],
      { f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:x', created: 1 }, f2: { id: 'f2' } },
    );
    const patch = templatePatch(text, { x: 0, y: 0 });
    expect(patch?.add).toHaveLength(2);
    // The box of the template is 100..400 x 100..150: its center (250, 125) lands on the point.
    expect(patch?.add?.[0]).toMatchObject({ x: -150, y: -25 });
    expect(Object.keys(patch?.files ?? {})).toEqual(['f1']);
    expect(patch?.view?.select).toEqual(patch?.add?.map((e) => e.id));
  });

  it('leaves out deleted elements and refuses what is not a drawing', () => {
    expect(
      templatePatch(file([el('a', 'rectangle', { isDeleted: true })]), { x: 0, y: 0 }),
    ).toBeNull();
    expect(templatePatch(file([]), { x: 0, y: 0 })).toBeNull();
    expect(templatePatch('# a note', { x: 0, y: 0 })).toBeNull();
  });
});
