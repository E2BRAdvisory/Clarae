// Force-directed layout on top of d3-force. Pure computation with no DOM access: it runs
// inside a Web Worker (layout.worker.ts) and, where workers are unavailable (unit tests),
// on the main thread (layoutHost.ts).
import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { Forces } from './types';

type SimNode = SimulationNodeDatum & { index: number };
type SimLink = SimulationLinkDatum<SimNode>;

/** Beyond this many nodes repulsion is approximated more coarsely: the cost per tick stays flat. */
const LARGE = 3000;

export class LayoutEngine {
  readonly n: number;
  private readonly sim: Simulation<SimNode, SimLink>;
  private readonly nodes: SimNode[];
  private readonly links: SimLink[];
  private readonly degree: Int32Array;
  private forces: Forces;
  private ticks = 0;

  /** edges holds source,target index pairs (length 2 * edge count). */
  constructor(n: number, edges: Int32Array, forces: Forces) {
    this.n = n;
    this.forces = forces;
    this.nodes = Array.from({ length: n }, (_, index) => ({ index }));
    this.links = [];
    this.degree = new Int32Array(n);
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const s = edges[i] as number;
      const t = edges[i + 1] as number;
      if (s < 0 || t < 0 || s >= n || t >= n) continue;
      this.links.push({ source: s, target: t });
      this.degree[s] = (this.degree[s] ?? 0) + 1;
      this.degree[t] = (this.degree[t] ?? 0) + 1;
    }
    this.sim = forceSimulation<SimNode>(this.nodes).stop();
    this.sim.force(
      'link',
      forceLink<SimNode, SimLink>(this.links)
        .id((d) => d.index)
        .iterations(n > LARGE ? 1 : 2),
    );
    this.sim.force('charge', forceManyBody<SimNode>());
    this.sim.force('x', forceX<SimNode>(0));
    this.sim.force('y', forceY<SimNode>(0));
    this.sim.alphaDecay(n > LARGE ? 0.035 : 0.0228);
    this.apply();
  }

  private apply(): void {
    const f = this.forces;
    const link = this.sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>>;
    const deg = this.degree;
    link.distance(f.linkDistance).strength((l) => {
      const s = (l.source as SimNode).index;
      const t = (l.target as SimNode).index;
      return (f.linkStrength * 1) / Math.max(1, Math.min(deg[s] ?? 1, deg[t] ?? 1));
    });
    const charge = this.sim.force('charge') as ReturnType<typeof forceManyBody<SimNode>>;
    charge
      .strength(-f.repel * 3)
      .theta(this.n > LARGE ? 1.2 : 0.9)
      .distanceMax(this.n > LARGE ? 300 : 1000);
    const k = f.center * 0.2;
    (this.sim.force('x') as ReturnType<typeof forceX<SimNode>>).strength(k);
    (this.sim.force('y') as ReturnType<typeof forceY<SimNode>>).strength(k);
  }

  setForces(forces: Forces): void {
    this.forces = forces;
    this.apply();
    this.reheat();
  }

  /** Restarts the cooling so the layout reacts to a changed force. */
  reheat(alpha = 0.6): void {
    this.sim.alpha(Math.max(this.sim.alpha(), alpha));
  }

  get alpha(): number {
    return this.sim.alpha();
  }

  /** True once the simulation has cooled below its minimum. */
  get settled(): boolean {
    return this.sim.alpha() < this.sim.alphaMin();
  }

  get tickCount(): number {
    return this.ticks;
  }

  tick(count = 1): void {
    this.sim.tick(count);
    this.ticks += count;
  }

  /** Current positions as x0,y0,x1,y1,… (a fresh buffer: safe to transfer). */
  snapshot(): Float32Array {
    const out = new Float32Array(this.n * 2);
    for (let i = 0; i < this.n; i++) {
      const nd = this.nodes[i] as SimNode;
      out[2 * i] = nd.x ?? 0;
      out[2 * i + 1] = nd.y ?? 0;
    }
    return out;
  }
}

/** Flattens graph edges into the Int32Array the engine takes. */
export function edgePairs(edges: readonly { source: number; target: number }[]): Int32Array {
  const out = new Int32Array(edges.length * 2);
  edges.forEach((e, i) => {
    out[2 * i] = e.source;
    out[2 * i + 1] = e.target;
  });
  return out;
}
