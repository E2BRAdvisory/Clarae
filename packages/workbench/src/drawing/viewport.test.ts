import { describe, expect, it, vi } from 'vitest';
import { bottomBarInset, fitOffsets, zoomTargets, zoomToSelection } from './viewport';

const el = (id: string, isDeleted = false) => ({ id, isDeleted });

describe('zoom to the selection', () => {
  it('targets the selected elements', () => {
    expect(zoomTargets([el('a'), el('b'), el('c')], ['b']).map((e) => e.id)).toEqual(['b']);
  });

  it('targets the whole drawing when nothing is selected', () => {
    expect(zoomTargets([el('a'), el('b')], []).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('never targets a deleted element, and falls back on the drawing when the selection is gone', () => {
    expect(zoomTargets([el('a'), el('b', true)], []).map((e) => e.id)).toEqual(['a']);
    expect(zoomTargets([el('a'), el('b', true)], ['b']).map((e) => e.id)).toEqual(['a']);
  });

  it('fits them clear of the editor chrome, and does nothing on an empty drawing', () => {
    const setViewport = vi.fn();
    const api = (elements: { id: string }[], selected: string[]) =>
      ({
        getSceneElements: () => elements,
        getAppState: () => ({
          selectedElementIds: Object.fromEntries(selected.map((id) => [id, true])),
        }),
        setViewport,
      }) as unknown as Parameters<typeof zoomToSelection>[0];

    zoomToSelection(api([], []));
    expect(setViewport).not.toHaveBeenCalled();

    zoomToSelection(api([el('a'), el('b')], ['a']));
    expect(setViewport).toHaveBeenCalledTimes(1);
    const options = setViewport.mock.calls[0]![0] as Record<string, unknown>;
    expect((options['target'] as { id: string }[]).map((e) => e.id)).toEqual(['a']);
    expect(options['fit']).toBe('contain');
    expect(options['offsets']).toEqual({ ui: true });

    // the whole drawing on request, clear of a bar Excalidraw does not measure
    zoomToSelection(api([el('a'), el('b')], ['a']), { everything: true, bottomInset: 56 });
    const all = setViewport.mock.calls[1]![0] as Record<string, unknown>;
    expect((all['target'] as { id: string }[]).map((e) => e.id)).toEqual(['a', 'b']);
    expect(all['offsets']).toEqual({ ui: true, bottom: 80 });
  });

  it('adds the margin of a fit to what the bottom bar covers', () => {
    expect(fitOffsets()).toEqual({ ui: true });
    expect(fitOffsets(0)).toEqual({ ui: true, bottom: 24 });
  });

  it('measures the bottom bar of the tray layout, in the pixels of the canvas', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="excalidraw"><div class="App-bottom-bar"></div></div>';
    const rect = (top: number, bottom: number) => () =>
      ({ top, bottom, height: bottom - top }) as DOMRect;
    host.querySelector('.excalidraw')!.getBoundingClientRect = rect(100, 700);
    host.querySelector('.App-bottom-bar')!.getBoundingClientRect = rect(650, 690);
    expect(bottomBarInset(host, 600)).toBe(50);
    // the app zoomed as a whole: screen pixels are not the pixels of the canvas
    expect(bottomBarInset(host, 300)).toBe(25);
    // no bar (the full layout, zen), or nothing mounted yet
    host.querySelector('.App-bottom-bar')!.remove();
    expect(bottomBarInset(host, 600)).toBeUndefined();
    expect(bottomBarInset(null, 600)).toBeUndefined();
  });
});
