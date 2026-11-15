import { beforeEach, describe, expect, it } from 'vitest';
import type { Slide } from './slides';
import { useDrawingSlides } from './slidesStore';

const slide = (id: string, name = id): Slide => ({
  id,
  name,
  notes: '',
  included: true,
  version: 1,
});
const store = () => useDrawingSlides.getState();
const shown = () => store().slides.map((s) => s.id);

beforeEach(() => useDrawingSlides.setState({ owner: '', path: '', slides: [] }));

describe('the frames the Slideshow tab shows', () => {
  it('are those of the editor that publishes them', () => {
    store().publish('A', 'Board.excalidraw', [slide('f1')]);
    expect(store().path).toBe('Board.excalidraw');
    expect(shown()).toEqual(['f1']);
    store().publish('A', 'Board.excalidraw', [slide('f1'), slide('f2')]);
    expect(shown()).toEqual(['f1', 'f2']);
  });

  it('stay those of the owner when another editor of the drawing publishes', () => {
    store().publish('A', 'Board.excalidraw', [slide('f1')]);
    store().publish('B', 'Board.excalidraw', [slide('other')]);
    expect(store().owner).toBe('A');
    expect(shown()).toEqual(['f1']);
  });

  it('become those of the editor that comes into focus', () => {
    store().publish('A', 'Board.excalidraw', [slide('f1')]);
    store().publish('B', 'Board.excalidraw', [slide('f1'), slide('f2')], true);
    expect(store().owner).toBe('B');
    expect(shown()).toEqual(['f1', 'f2']);
  });

  it('survive the closing of an editor that does not own them', () => {
    store().publish('A', 'Board.excalidraw', [slide('f1')]);
    store().publish('B', 'Board.excalidraw', [slide('f2')], true);
    // the pane of A closes: the panel keeps showing B's frames
    store().clear('A');
    expect(store().owner).toBe('B');
    expect(shown()).toEqual(['f2']);
  });

  it('pass to the editor that is left when the owner closes', () => {
    store().publish('A', 'Board.excalidraw', [slide('f1')]);
    store().publish('B', 'Board.excalidraw', [slide('f2')], true);
    store().clear('B');
    expect(shown()).toEqual([]);
    // the editor still mounted publishes again: nobody owns the panel, so it is taken
    store().publish('A', 'Board.excalidraw', [slide('f1')]);
    expect(store().owner).toBe('A');
    expect(shown()).toEqual(['f1']);
  });

  it('do not re-render the panel for the same frames', () => {
    store().publish('A', 'Board.excalidraw', [slide('f1')]);
    const before = store().slides;
    store().publish('A', 'Board.excalidraw', [slide('f1')]);
    expect(store().slides).toBe(before);
  });
});
