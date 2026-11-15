// Web Worker running the layout (§M6-WP1): the UI thread only receives position buffers.
import type { LayoutEngine } from './layoutEngine';
import { LayoutEngine3D } from './layoutEngine3d';
import { createEngine, type WorkerIn, type WorkerOut } from './layoutHost';

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
  postMessage(msg: WorkerOut, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** Time spent computing between two posts: about one frame. */
const BUDGET_MS = 14;
let engine: LayoutEngine | LayoutEngine3D | null = null;
let running = false;
let generation = 0;

function post(done: boolean): void {
  if (!engine) return;
  const positions = engine.snapshot();
  scope.postMessage({ type: 'positions', positions, alpha: engine.alpha, done }, [
    positions.buffer,
  ]);
}

function loop(gen: number): void {
  if (!engine || gen !== generation) return;
  const start = performance.now();
  do engine.tick(1);
  while (!engine.settled && performance.now() - start < BUDGET_MS);
  const done = engine.settled;
  post(done);
  if (done) running = false;
  else setTimeout(() => loop(gen), 0);
}

function run(): void {
  if (running) return;
  running = true;
  setTimeout(() => loop(generation), 0);
}

scope.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      generation++;
      running = false;
      engine = createEngine(m.n, m.edges, m.forces, m.warm, m.dims ?? 2);
      post(false);
      run();
      break;
    case 'forces':
      engine?.setForces(m.forces);
      run();
      break;
    case 'reheat':
      engine?.reheat();
      run();
      break;
    case 'fix':
      if (engine instanceof LayoutEngine3D) engine.fix(m.index, m.x, m.y, m.z);
      run();
      break;
    case 'release':
      if (engine instanceof LayoutEngine3D) engine.release(m.index);
      run();
      break;
    case 'stop':
      generation++;
      running = false;
      engine = null;
      break;
  }
};
