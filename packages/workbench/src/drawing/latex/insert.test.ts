import { describe, expect, it } from 'vitest';
import { applyPatch } from '../actions/apply';
import type { SceneElement } from '../actions/types';
import { latexOf, latexPatch } from './insert';

const center = { x: 100, y: 50 };

describe('latexPatch', () => {
  it('inserts an image element centered on the viewport, with the source in customData', async () => {
    const patch = await latexPatch('x^2 + y^2', { center, color: '#1e1e1e' });
    const [el] = patch.add ?? [];
    expect(el).toMatchObject({ type: 'image', status: 'saved', isDeleted: false, link: null });
    expect(Number(el?.x) + Number(el?.width) / 2).toBeCloseTo(100, 1);
    expect(Number(el?.y) + Number(el?.height) / 2).toBeCloseTo(50, 1);
    expect(latexOf(el)).toMatchObject({ kind: 'latex', latex: 'x^2 + y^2' });
    const file = Object.values(patch.files ?? {})[0];
    expect(file?.id).toBe(el?.fileId);
    expect(file?.mimeType).toBe('image/svg+xml');
    expect(file?.dataURL).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('edits in place: new file, same id and position, the user scale is kept', async () => {
    const first = await latexPatch('a', { center, color: '#000000' });
    const original = { ...(first.add?.[0] as SceneElement) };
    const meta = latexOf(original)!;
    const resized: SceneElement = {
      ...original,
      width: meta.w0 * 2,
      height: Number(original.height) * 2,
    };
    const patch = await latexPatch('a + b + c', { center, color: '#000000', existing: resized });
    const after = applyPatch([resized], patch, () => 1, 1)[0]!;
    expect(after.id).toBe(resized.id);
    expect(after.x).toBe(resized.x);
    expect(after.fileId).not.toBe(resized.fileId);
    expect(latexOf(after)?.latex).toBe('a + b + c');
    const m2 = latexOf(after)!;
    expect(Number(after.width) / m2.w0).toBeCloseTo(2, 5);
    expect(after.version).toBe(resized.version + 1);
  });

  it('an edit keeps the color of the formula; a new one takes the given color', async () => {
    const first = await latexPatch('a', { center, color: '#336699' });
    const el = first.add?.[0] as SceneElement;
    expect(latexOf(el)?.color).toBe('#336699');
    expect(Object.values(first.files ?? {})[0]?.dataURL).toBe(
      Object.values((await latexPatch('a', { center, color: '#336699' })).files ?? {})[0]?.dataURL,
    );
    const edit = await latexPatch('b', { center, existing: el });
    const after = applyPatch([el], edit, () => 1, 1)[0]!;
    expect(latexOf(after)?.color).toBe('#336699');
    const svg = atob(String(Object.values(edit.files ?? {})[0]?.dataURL).split(',')[1] ?? '');
    expect(svg).toContain('#336699');
  });

  it('rejects invalid TeX without a patch', async () => {
    await expect(latexPatch('\\frac{a}', { center, color: '#000000' })).rejects.toThrow();
    await expect(latexPatch('  ', { center, color: '#000000' })).rejects.toThrow();
  });

  it('reads a formula of a 1.x file and rewrites it under the new key only', async () => {
    const legacy: SceneElement = {
      id: 'f',
      type: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      version: 3,
      versionNonce: 1,
      customData: {
        other: 1,
        memobrain: { kind: 'latex', latex: 'x^2', w0: 50, color: '#112233' },
      },
    };
    expect(latexOf(legacy)).toEqual({ kind: 'latex', latex: 'x^2', w0: 50, color: '#112233' });
    const edit = await latexPatch('y^2', { center, existing: legacy });
    const after = applyPatch([legacy], edit, () => 1, 1)[0]!;
    expect(latexOf(after)?.latex).toBe('y^2');
    expect(after.customData).toMatchObject({ other: 1, clarae: { kind: 'latex', latex: 'y^2' } });
    expect(after.customData).not.toHaveProperty('memobrain');
  });

  it('latexOf only recognises formulas', () => {
    expect(latexOf(undefined)).toBeNull();
    expect(latexOf({ id: 'a', type: 'image', version: 1, versionNonce: 1 })).toBeNull();
    expect(
      latexOf({
        id: 'a',
        type: 'image',
        version: 1,
        versionNonce: 1,
        customData: { clarae: { kind: 'md' } },
      }),
    ).toBeNull();
  });
});
