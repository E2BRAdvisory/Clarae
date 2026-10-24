// The UI-side handle on the layout: a Web Worker where available, the same engine on the
// main thread otherwise (unit tests, hosts without module workers).
import { LayoutEngine } from './layoutEngine';
import type { Forces } from './types';

export type WorkerIn =
  | { type: 'init'; n: number; edges: Int32Array; forces: Forces }
  | { type: 'forces'; forces: Forces }
  | { type: 'reheat' }
  | { type: 'stop' };

export type WorkerOut = {
  type: 'positions';
  positions: Float32Array;
  alpha: number;
  /** The simulation has cooled: no more updates until a force changes. */
  done: boolean;
};

export interface LayoutHost {
  setForces(forces: Forces): void;
  reheat(): void;
  dispose(): void;
}

export type OnPositions = (p: Float32Array, alpha: number, done: boolean) => void;

/** Starts a layout of n nodes; onPositions is called with each new set of coordinates. */
export function startLayout(
  n: number,
  edges: Int32Array,
  forces: Forces,
  onPositions: OnPositions,
): LayoutHost {
  if (typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (e: MessageEvent<WorkerOut>) =>
        onPositions(e.data.positions, e.data.alpha, e.data.done);
      const send = (m: WorkerIn): void => worker.postMessage(m);
      send({ type: 'init', n, edges, forces });
      return {
        setForces: (f) => send({ type: 'forces', forces: f }),
        reheat: () => send({ type: 'reheat' }),
        dispose: () => {
          send({ type: 'stop' });
          worker.terminate();
        },
      };
    } catch {
      // fall through to the inline engine
    }
  }
  return inlineLayout(n, edges, forces, onPositions);
}

function inlineLayout(
  n: number,
  edges: Int32Array,
  forces: Forces,
  onPositions: OnPositions,
): LayoutHost {
  const engine = new LayoutEngine(n, edges, forces);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const step = (): void => {
    timer = null;
    if (disposed) return;
    const start = performance.now();
    do engine.tick(1);
    while (!engine.settled && performance.now() - start < 14);
    onPositions(engine.snapshot(), engine.alpha, engine.settled);
    if (!engine.settled) timer = setTimeout(step, 0);
  };
  const run = (): void => {
    if (timer === null && !disposed) timer = setTimeout(step, 0);
  };
  onPositions(engine.snapshot(), engine.alpha, false);
  run();
  return {
    setForces: (f) => {
      engine.setForces(f);
      run();
    },
    reheat: () => {
      engine.reheat();
      run();
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
