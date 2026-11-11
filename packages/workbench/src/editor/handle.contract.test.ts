import { history } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { codeMirrorHandle } from './source/CodeMirrorAdapter';
import { describeHandleContract, type HandleHarness, type HandleInit } from './handleContract';

// jsdom cannot measure text: CodeMirror's own measuring (it runs after a change) gets empty answers.
beforeAll(() => {
  const none = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] };
  Range.prototype.getClientRects = () => none;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

const codeMirror = ({ doc, selection, readOnly }: HandleInit): HandleHarness => {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      ...(selection
        ? { selection: { anchor: selection.anchor, head: selection.head ?? selection.anchor } }
        : {}),
      extensions: [history(), EditorState.readOnly.of(!!readOnly)],
    }),
  });
  return { handle: codeMirrorHandle(view, { paneId: 'contract' }), dispose: () => view.destroy() };
};

describeHandleContract('CodeMirror', codeMirror);

// What a laid-out view adds: the wikilink under the cursor with its place on the screen.
describe('CodeMirror handle: linkAt on a laid-out view', () => {
  const none = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] };
  const rect = { left: 10, right: 60, top: 5, bottom: 21, width: 50, height: 16, x: 10, y: 5 };
  afterEach(() => {
    Range.prototype.getClientRects = () => none;
  });

  it('gives the link under the cursor and a rectangle for it', () => {
    const doc = 'see [[Target#Head|alias]] now';
    const harness = codeMirror({ doc, selection: { anchor: 8 } });
    try {
      Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
      const hit = harness.handle.linkAt('cursor');
      expect(hit?.spec).toMatchObject({ target: 'Target', heading: 'Head', alias: 'alias' });
      // CodeMirror answers a position with a zero-width rectangle: the span is from the first to the last.
      expect(hit?.rect).toMatchObject({ left: 10, top: 5, bottom: 21 });
    } finally {
      harness.dispose();
    }
  });
});

describe('CodeMirror handle: linkAt from a point of the screen', () => {
  const rect = { left: 10, right: 60, top: 5, bottom: 21, width: 50, height: 16, x: 10, y: 5 };
  const none = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] };
  afterEach(() => {
    Range.prototype.getClientRects = () => none;
  });

  // jsdom has no layout, so the point is turned into a position by a stub; what the handle does with
  // that position (the link there and its rectangle) is the code under test.
  it('gives the link at the position under the point, and nothing where there is no position', () => {
    const doc = 'see [[Target#Head|alias]] now';
    const harness = codeMirror({ doc, selection: { anchor: 0 } });
    try {
      const view = EditorView.findFromDOM(harness.handle.root);
      if (!view) throw new Error('no view');
      const at = vi.spyOn(view, 'posAtCoords');
      Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
      at.mockReturnValue(10);
      const hit = harness.handle.linkAt({ x: 30, y: 12 });
      expect(at).toHaveBeenCalledWith({ x: 30, y: 12 });
      expect(hit?.spec).toMatchObject({ target: 'Target', heading: 'Head', alias: 'alias' });
      expect(hit?.rect).toMatchObject({ left: 10, top: 5, bottom: 21 });
      at.mockReturnValue(1);
      expect(harness.handle.linkAt({ x: 1, y: 1 })).toBeNull();
      at.mockReturnValue(null);
      expect(harness.handle.linkAt({ x: 500, y: 500 })).toBeNull();
    } finally {
      harness.dispose();
    }
  });
});

describe('CodeMirror handle: more than one cursor', () => {
  const multi = (doc: string, ranges: [number, number?][]) => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h ?? a))),
        extensions: [history(), EditorState.allowMultipleSelections.of(true)],
      }),
    });
    return { view, handle: codeMirrorHandle(view, { paneId: 'multi' }) };
  };

  it('replaces every range when no caret is asked for, and leaves a caret after each', () => {
    const { view, handle } = multi('ab\ncd', [[2], [5]]);
    try {
      expect(handle.replaceSelection('X')).toBe(true);
      expect(handle.text()).toBe('abX\ncdX');
      expect(view.state.selection.ranges.map((r) => r.head)).toEqual([3, 7]);
      expect(handle.exec('undo')).toBe(true);
      expect(handle.text()).toBe('ab\ncd');
    } finally {
      view.destroy();
    }
  });

  it('replaces every selected text, not only the main one', () => {
    const { view, handle } = multi('ab\ncd', [
      [0, 2],
      [3, 5],
    ]);
    try {
      handle.replaceSelection('[[x]]');
      expect(handle.text()).toBe('[[x]]\n[[x]]');
    } finally {
      view.destroy();
    }
  });

  it('puts the caret asked for in the main range, the only one it replaces then', () => {
    const { view, handle } = multi('ab\ncd', [[2], [5]]);
    try {
      handle.replaceSelection('[[]]', { caret: 2 });
      expect(view.state.selection.ranges).toHaveLength(1);
      expect(handle.text()).toBe('ab[[]]\ncd');
      expect(view.state.selection.main.head).toBe(4);
    } finally {
      view.destroy();
    }
  });
});

describe('CodeMirror handle: the top line of a snapshot', () => {
  it('measures the scroll from the top of the document, below the padding of the content', () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'one\ntwo\nthree' }),
    });
    try {
      const handle = codeMirrorHandle(view, { paneId: 'top' });
      Object.defineProperty(view, 'documentPadding', { value: { top: 4, bottom: 0 } });
      const scrollTop = vi.spyOn(view.scrollDOM, 'scrollTop', 'get');
      const at = vi.spyOn(view, 'lineBlockAtHeight');
      scrollTop.mockReturnValue(10);
      handle.snapshot();
      expect(at).toHaveBeenLastCalledWith(6);
      // Still inside the padding: the top of the document, never a negative height.
      scrollTop.mockReturnValue(2);
      handle.snapshot();
      expect(at).toHaveBeenLastCalledWith(0);
    } finally {
      view.destroy();
    }
  });
});

describe('CodeMirror handle: identity and mode', () => {
  it('is the same object for a view, and its kind follows the mode of the pane', () => {
    let mode: 'live' | 'source' = 'live';
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: '' }) });
    try {
      const h = codeMirrorHandle(view, { paneId: 'p', mode: () => mode });
      expect(codeMirrorHandle(view)).toBe(h);
      expect(h.paneId).toBe('p');
      expect(h.kind).toBe('live');
      mode = 'source';
      expect(h.kind).toBe('source');
    } finally {
      view.destroy();
    }
  });
});
