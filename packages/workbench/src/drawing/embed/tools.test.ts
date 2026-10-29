import { describe, expect, it } from 'vitest';
import type { SceneElement } from '../actions/types';
import { resetLatexSize } from '../latex/actions';
import { deconstruct } from './deconstruct';
import { refreshedLabel } from './tools';

const el = (id: string, type: string, extra: Record<string, unknown> = {}): SceneElement => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version: 3,
  versionNonce: 1,
  ...extra,
});

describe('deconstruct', () => {
  const box = el('box', 'rectangle', {
    boundElements: [
      { id: 'lbl', type: 'text' },
      { id: 'out', type: 'arrow' },
    ],
    frameId: 'frame-out',
  });
  const label = el('lbl', 'text', { containerId: 'box' });
  const arrow = el('arr', 'arrow', {
    startBinding: { elementId: 'box' },
    endBinding: { elementId: 'stay' },
  });
  const stay = el('stay', 'rectangle');
  const img = el('img', 'image', { fileId: 'f1' });
  const files = {
    f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA', created: 1 },
    f2: { id: 'f2', mimeType: 'image/png', dataURL: 'data:image/png;base64,BB', created: 1 },
  };

  it('takes the selection, its labels and only the images it uses', () => {
    const out = deconstruct(
      { elements: [box, label, arrow, stay, img], selected: ['box', 'arr', 'img'] },
      files,
    )!;
    expect(out.ids.sort()).toEqual(['arr', 'box', 'img', 'lbl']);
    const doc = JSON.parse(out.json) as {
      type: string;
      elements: SceneElement[];
      files: Record<string, unknown>;
    };
    expect(doc.type).toBe('excalidraw');
    expect(Object.keys(doc.files)).toEqual(['f1']);
    expect(doc.elements.map((e) => e.id)).toEqual(['box', 'lbl', 'arr', 'img']);
  });

  it('drops bindings and frames that point at elements left behind', () => {
    const out = deconstruct(
      { elements: [box, label, arrow, stay], selected: ['box', 'arr'] },
      files,
    )!;
    const doc = JSON.parse(out.json) as { elements: SceneElement[] };
    const b = doc.elements.find((e) => e.id === 'box')!;
    expect(b.boundElements).toEqual([{ id: 'lbl', type: 'text' }]); // the foreign arrow ref is gone
    expect(b.frameId).toBeNull();
    const a = doc.elements.find((e) => e.id === 'arr')!;
    expect(a.startBinding).toEqual({ elementId: 'box' });
    expect(a.endBinding).toBeNull();
  });

  it('does nothing for an empty selection and skips deleted elements', () => {
    expect(deconstruct({ elements: [box], selected: [] }, files)).toBeNull();
    const gone = el('g', 'rectangle', { isDeleted: true });
    const out = deconstruct({ elements: [gone, box], selected: ['g', 'box'] }, files)!;
    expect(out.ids).toEqual(['box']);
  });
});

describe('refreshedLabel', () => {
  it('is the note name plus a wrapped plain-text excerpt', () => {
    const t = refreshedLabel(
      'Notes/Plan.md',
      '---\nx: 1\n---\n# Plan\n\nShip the **first** version this week.\n',
    );
    expect(t).toBe('Plan\n\nShip the first version this week.');
  });
});

describe('reset-latex-size', () => {
  const formula = (w: number, h: number): SceneElement =>
    el('f', 'image', {
      width: w,
      height: h,
      customData: { memobrain: { kind: 'latex', latex: 'x', w0: 50, color: '#000' } },
    });

  it('goes back to the rendered width, keeping the aspect ratio', () => {
    const patch = resetLatexSize.run({ elements: [formula(150, 60)], selected: ['f'] });
    expect(patch.update!.f).toEqual({ width: 50, height: 20 });
  });

  it('leaves formulas at their size, other images and unselected ones alone', () => {
    expect(resetLatexSize.run({ elements: [formula(50, 20)], selected: ['f'] }).update).toEqual({});
    expect(resetLatexSize.run({ elements: [el('i', 'image')], selected: ['i'] }).update).toEqual(
      {},
    );
    expect(resetLatexSize.run({ elements: [formula(150, 60)], selected: [] }).update).toEqual({});
  });
});

describe('svgSize', () => {
  it('reads width/height, falling back to the viewBox', async () => {
    const { svgSize } = await import('./commands');
    expect(svgSize('<svg xmlns="x" width="320" height="180" viewBox="0 0 10 10"></svg>')).toEqual({
      width: 320,
      height: 180,
    });
    expect(svgSize('<svg viewBox="0 0 640 360"></svg>')).toEqual({ width: 640, height: 360 });
    expect(svgSize('<svg></svg>')).toEqual({ width: 0, height: 0 });
  });
});
