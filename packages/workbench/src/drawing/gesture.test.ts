import { afterEach, describe, expect, it, vi } from 'vitest';
import { gestureUnderWay, whenIdle } from './gesture';

type State = Parameters<typeof gestureUnderWay>[0];
const rest: State = {
  editingTextElement: null,
  newElement: null,
  resizingElement: null,
  multiElement: null,
  selectionElement: null,
  selectedElementsAreBeingDragged: false,
  isResizing: false,
  isRotating: false,
};
const busy = (over: Record<string, unknown>): State => ({ ...rest, ...over });

/** An editor whose state the test changes; `set` reports the change like Excalidraw does. */
function editor(initial: State) {
  let state = initial;
  const listeners = new Set<(e: readonly never[], s: State, f: never) => void>();
  return {
    api: {
      getAppState: () => state,
      onChange: (cb: (e: readonly never[], s: State, f: never) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    } as unknown as Parameters<typeof whenIdle>[0],
    set: (next: State) => {
      state = next;
      listeners.forEach((l) => l([], state, {} as never));
    },
    listening: () => listeners.size,
  };
}

afterEach(() => vi.useRealTimers());

describe('a gesture under way in the drawing editor', () => {
  it('is typing, drawing, dragging, resizing, rotating or rubber-banding', () => {
    expect(gestureUnderWay(rest)).toBe(false);
    for (const key of [
      'editingTextElement',
      'newElement',
      'resizingElement',
      'multiElement',
      'selectionElement',
    ])
      expect(gestureUnderWay(busy({ [key]: { id: 'x' } }))).toBe(true);
    for (const key of ['selectedElementsAreBeingDragged', 'isResizing', 'isRotating'])
      expect(gestureUnderWay(busy({ [key]: true }))).toBe(true);
  });

  it('is not waited for when there is none', async () => {
    const e = editor(rest);
    expect(await whenIdle(e.api, 1000)).toBe(true);
    expect(e.listening()).toBe(0);
  });

  it('is waited for until it ends', async () => {
    const e = editor(busy({ selectedElementsAreBeingDragged: true }));
    let idle: boolean | undefined;
    void whenIdle(e.api, 1000).then((v) => (idle = v));
    e.set(busy({ selectedElementsAreBeingDragged: true })); // still dragging
    await Promise.resolve();
    expect(idle).toBeUndefined();
    e.set(rest);
    await Promise.resolve();
    expect(idle).toBe(true);
    expect(e.listening()).toBe(0);
  });

  it('is not waited for longer than asked', async () => {
    vi.useFakeTimers();
    const e = editor(busy({ editingTextElement: { id: 't' } }));
    const waiting = whenIdle(e.api, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toBe(false);
    expect(e.listening()).toBe(0);
  });
});
