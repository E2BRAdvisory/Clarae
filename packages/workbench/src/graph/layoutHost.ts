// The UI-side handle on the layout: a Web Worker where available, the same engine on the
// main thread otherwise (unit tests, hosts without module workers). One worker serves both
// surfaces: two dimensions for the canvas, three for the 3D scene.
import { LayoutEngine, type WarmStart } from './layoutEngine';
import { LayoutEngine3D } from './layoutEngine3d';
import type { Forces } from './types';

/** The dimensions of a layout: positions come as x,y pairs or x,y,z triples. */
export type Dims = 2 | 3;

export type WorkerIn =
  | { type: 'init'; n: number; edges: Int32Array; forces: Forces; warm?: WarmStart; dims?: Dims }
  | { type: 'forces'; forces: Forces }
  | { type: 'reheat' }
  /** 3D: holds a node where the user dragged it. */
  | { type: 'fix'; index: number; x: number; y: number; z: number }
  /** 3D: frees a held node, or all of them. */
  | { type: 'release'; index?: number }
  | { type: 'stop' };

/** The engine of a layout, in two or three dimensions. */
export function createEngine(
  n: number,
  edges: Int32Array,
  forces: Forces,
  warm: WarmStart | undefined,
  dims: Dims,
): LayoutEngine | LayoutEngine3D {
  return dims === 3
    ? new LayoutEngine3D(n, edges, forces, warm)
    : new LayoutEngine(n, edges, forces, warm);
}

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
  /** 3D: holds a node at a position (a node the user dragged stays where it was dropped). */
  fix(index: number, x: number, y: number, z: number): void;
  /** 3D: frees a held node, or all of them. */
  release(index?: number): void;
  dispose(): void;
}

export type OnPositions = (p: Float32Array, alpha: number, done: boolean) => void;

/**
 * Starts a layout of n nodes; onPositions is called with each new set of coordinates. A warm start
 * continues from known positions (see LayoutEngine).
 */
export function startLayout(
  n: number,
  edges: Int32Array,
  forces: Forces,
  onPositions: OnPositions,
  warm?: WarmStart,
  dims: Dims = 2,
): LayoutHost {
  if (typeof Worker !== 'undefined') {
    try {
      const worker = new Worker('/assets/layout.worker.js', { type: 'module' });
      worker.onmessage = (e: MessageEvent<WorkerOut>) =>
        onPositions(e.data.positions, e.data.alpha, e.data.done);
      const send = (m: WorkerIn): void => worker.postMessage(m);
      send({ type: 'init', n, edges, forces, dims, ...(warm ? { warm } : {}) });
      return {
        setForces: (f) => send({ type: 'forces', forces: f }),
        reheat: () => send({ type: 'reheat' }),
        fix: (index, x, y, z) => send({ type: 'fix', index, x, y, z }),
        release: (index) => send({ type: 'release', ...(index === undefined ? {} : { index }) }),
        dispose: () => {
          send({ type: 'stop' });
          worker.terminate();
        },
      };
    } catch {
      // fall through to the inline engine
    }
  }
  return inlineLayout(n, edges, forces, onPositions, warm, dims);
}

function inlineLayout(
  n: number,
  edges: Int32Array,
  forces: Forces,
  onPositions: OnPositions,
  warm: WarmStart | undefined,
  dims: Dims,
): LayoutHost {
  const engine = createEngine(n, edges, forces, warm, dims);
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
    fix: (index, x, y, z) => {
      if (engine instanceof LayoutEngine3D) engine.fix(index, x, y, z);
      run();
    },
    release: (index) => {
      if (engine instanceof LayoutEngine3D) engine.release(index);
      run();
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
