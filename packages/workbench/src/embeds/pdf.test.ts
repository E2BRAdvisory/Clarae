import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPdf } from './pdf';

// A pdf.js stand-in that behaves like the real one where it matters: a render on a canvas that is
// already being rendered fails, and cancel() frees the canvas and rejects the render's promise.
const fake = vi.hoisted(() => {
  const state = {
    busy: new WeakSet<object>(),
    renders: [] as { page: number; finish: () => void; cancelled: boolean }[],
    overlapping: 0,
  };
  class RenderingCancelledException extends Error {
    override name = 'RenderingCancelledException';
  }
  const page = (n: number) => ({
    getViewport: () => ({ width: 10, height: 10 }),
    render: ({ canvas }: { canvas: object }) => {
      if (state.busy.has(canvas)) {
        state.overlapping++;
        return { promise: Promise.reject(new Error('same canvas')), cancel: () => undefined };
      }
      state.busy.add(canvas);
      let resolve: () => void = () => undefined;
      let reject: (e: unknown) => void = () => undefined;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const entry = {
        page: n,
        cancelled: false,
        finish: () => {
          state.busy.delete(canvas);
          resolve();
        },
      };
      state.renders.push(entry);
      return {
        promise,
        cancel: () => {
          entry.cancelled = true;
          state.busy.delete(canvas);
          reject(new RenderingCancelledException('cancelled'));
        },
      };
    },
  });
  return { state, page };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: (n: number) => Promise.resolve(fake.page(n)),
    }),
    destroy: () => Promise.resolve(),
  }),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }));

const tick = () => new Promise((r) => setTimeout(r, 0));
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(() => {
  fake.state.renders = [];
  fake.state.overlapping = 0;
  unhandled.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.restoreAllMocks();
});

declare const process: {
  on(ev: string, fn: (e: unknown) => void): void;
  off(ev: string, fn: (e: unknown) => void): void;
};

describe('renderPdf', () => {
  it('cancels the render in progress when the page is turned, without errors', async () => {
    const el = document.createElement('div');
    const dispose = renderPdf(el, 'docs/a.pdf', () => Promise.resolve(new Uint8Array(1)), 1);
    await vi.waitFor(() => expect(fake.state.renders).toHaveLength(1));
    const next = el.querySelectorAll('button')[1] as HTMLButtonElement;
    next.click();
    next.click();
    await vi.waitFor(() => expect(el.textContent).toContain('3/3'));
    await vi.waitFor(() => expect(fake.state.renders.at(-1)?.page).toBe(3));
    await tick();
    expect(fake.state.overlapping).toBe(0);
    expect(fake.state.renders[0]?.cancelled).toBe(true);
    // The viewer is still there: a cancelled render is not a failure of the embed.
    expect(el.querySelector('canvas')).not.toBeNull();

    // Leaving stops the render still running.
    dispose();
    expect(fake.state.renders.at(-1)?.cancelled).toBe(true);
    next.click();
    await tick();
    await tick();
    expect(unhandled).toEqual([]);
  });
});
