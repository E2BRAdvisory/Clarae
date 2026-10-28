import { describe, expect, it } from 'vitest';
import {
  autoExportPlan,
  defaultExportOptions,
  exportName,
  framesOf,
  scopeElements,
  type ExportEl,
} from './options';

const el = (id: string, type = 'rectangle', extra: Partial<ExportEl> = {}): ExportEl => ({
  id,
  type,
  ...extra,
});

describe('framesOf', () => {
  it('lists live frames, naming the unnamed ones by order', () => {
    const els = [
      el('f1', 'frame', { name: 'Intro' }),
      el('r'),
      el('f2', 'frame', { name: '  ' }),
      el('f3', 'frame', { name: 'Gone', isDeleted: true }),
      el('m', 'magicframe', { name: 'Magic' }),
    ];
    expect(framesOf(els)).toEqual([
      { id: 'f1', name: 'Intro' },
      { id: 'f2', name: 'Frame 2' },
      { id: 'm', name: 'Magic' },
    ]);
  });
});

describe('scopeElements', () => {
  const els = [
    el('f', 'frame', { name: 'S1' }),
    el('a', 'rectangle', { frameId: 'f' }),
    el('b', 'rectangle'),
    el('t', 'text', { containerId: 'b' }),
    el('gone', 'rectangle', { frameId: 'f', isDeleted: true }),
  ];

  it('all: every live element', () => {
    const r = scopeElements(els, [], { kind: 'all' });
    expect(r.elements.map((e) => e.id)).toEqual(['f', 'a', 'b', 't']);
    expect(r.frame).toBeNull();
  });

  it('selection: selected elements, their labels, and the children of selected frames', () => {
    expect(scopeElements(els, ['b'], { kind: 'selection' }).elements.map((e) => e.id)).toEqual([
      'b',
      't',
    ]);
    expect(scopeElements(els, ['f'], { kind: 'selection' }).elements.map((e) => e.id)).toEqual([
      'f',
      'a',
    ]);
    expect(scopeElements(els, [], { kind: 'selection' }).elements).toEqual([]);
  });

  it('frame: the frame and its children, with the frame to clip to', () => {
    const r = scopeElements(els, [], { kind: 'frame', id: 'f' });
    expect(r.elements.map((e) => e.id)).toEqual(['f', 'a']);
    expect(r.frame?.id).toBe('f');
    expect(scopeElements(els, [], { kind: 'frame', id: 'b' }).elements).toEqual([]);
    expect(scopeElements(els, [], { kind: 'frame', id: 'nope' }).frame).toBeNull();
  });
});

describe('exportName', () => {
  const base = defaultExportOptions({ exportScale: 2, exportPadding: 10, exportEmbedScene: false });
  it('encodes scope, theme and scale', () => {
    expect(exportName('a/Board.excalidraw', base)).toBe('Board@2x.png');
    expect(exportName('Board.excalidraw', { ...base, scale: 1 })).toBe('Board.png');
    expect(exportName('Board.excalidraw', { ...base, format: 'svg', dark: true })).toBe(
      'Board.dark.svg',
    );
    expect(
      exportName(
        'Board.excalidraw',
        { ...base, scope: { kind: 'frame', id: 'f' } },
        'Slide 1 / intro',
      ),
    ).toBe('Board.Slide-1-intro@2x.png');
    expect(
      exportName('Board.excalidraw', { ...base, scope: { kind: 'frame', id: 'f' } }, '???'),
    ).toBe('Board.frame@2x.png');
    expect(
      exportName('Board.excalidraw', { ...base, scope: { kind: 'selection' }, scale: 3 }),
    ).toBe('Board.selection@3x.png');
  });
});

describe('autoExportPlan', () => {
  it('lists the files to write', () => {
    expect(autoExportPlan('none', 'both')).toEqual([]);
    expect(autoExportPlan('png', 'light')).toEqual([{ variant: '', format: 'png' }]);
    expect(autoExportPlan('svg', 'dark')).toEqual([{ variant: 'dark', format: 'svg' }]);
    expect(autoExportPlan('both', 'both')).toEqual([
      { variant: 'light', format: 'png' },
      { variant: 'light', format: 'svg' },
      { variant: 'dark', format: 'png' },
      { variant: 'dark', format: 'svg' },
    ]);
  });
});
