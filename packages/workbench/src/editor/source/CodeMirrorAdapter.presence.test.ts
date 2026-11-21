// What presence needs of the Source editor (ADR-0065): the source line and column under a point, the place of
// a line and column on the screen, and the signal that the places may have changed. jsdom has no layout: the
// view's measuring is stubbed, as the consumers' tests do.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeMirrorHandle } from './CodeMirrorAdapter';

let view: EditorView;
const DOC = 'first line\nsecond line\n\nfourth';

beforeEach(() => {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: DOC }),
  });
  vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 400));
});
afterEach(() => {
  vi.restoreAllMocks();
  view.destroy();
});

describe('locAt', () => {
  it('is the 1-based line and column of the source under the point', () => {
    const h = codeMirrorHandle(view);
    vi.spyOn(view, 'posAtCoords').mockReturnValue(DOC.indexOf('line', 11)); // "second line": the col of "line"
    expect(h.locAt({ x: 5, y: 5 })).toEqual({ line: 2, col: 8 });
    vi.spyOn(view, 'posAtCoords').mockReturnValue(0);
    expect(h.locAt({ x: 5, y: 5 })).toEqual({ line: 1, col: 1 });
  });

  it('is null when the point is not over the text', () => {
    vi.spyOn(view, 'posAtCoords').mockReturnValue(null);
    expect(codeMirrorHandle(view).locAt({ x: 5, y: 5 })).toBeNull();
  });
});

describe('pointAt', () => {
  it('puts the line and column where the view draws that character', () => {
    const coords = vi
      .spyOn(view, 'coordsAtPos')
      .mockReturnValue({ left: 40, top: 150, right: 48, bottom: 168 });
    const h = codeMirrorHandle(view);
    expect(h.pointAt({ line: 2, col: 3 })).toEqual({ x: 40, y: 150, height: 18 });
    expect(coords).toHaveBeenLastCalledWith(DOC.indexOf('second') + 2);
  });

  it('clamps a line and a column past the end of the text', () => {
    const coords = vi
      .spyOn(view, 'coordsAtPos')
      .mockReturnValue({ left: 40, top: 150, right: 48, bottom: 168 });
    const h = codeMirrorHandle(view);
    h.pointAt({ line: 99, col: 99 });
    expect(coords).toHaveBeenLastCalledWith(DOC.length);
    h.pointAt({ line: 2, col: 99 });
    expect(coords).toHaveBeenLastCalledWith(DOC.indexOf('\n', 11)); // end of "second line"
    h.pointAt({ line: 0, col: 0 });
    expect(coords).toHaveBeenLastCalledWith(0);
  });

  it('is null for a place that is not drawn or is scrolled out of the editor', () => {
    const coords = vi.spyOn(view, 'coordsAtPos').mockReturnValue(null);
    const h = codeMirrorHandle(view);
    expect(h.pointAt({ line: 2, col: 1 })).toBeNull();
    coords.mockReturnValue({ left: 40, top: 700, right: 48, bottom: 718 });
    expect(h.pointAt({ line: 2, col: 1 })).toBeNull();
  });
});

describe('onLayout', () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  it('fires once per frame for a scroll and for an edit, and no more after it is stopped', async () => {
    let calls = 0;
    const stop = codeMirrorHandle(view).onLayout(() => calls++);
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    await frame();
    expect(calls).toBe(1);
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    await frame();
    expect(calls).toBe(2);
    stop();
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    await frame();
    expect(calls).toBe(2);
  });
});
