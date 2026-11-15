// The force-directed layout in three dimensions, on d3-force-3d (d3-force with a z axis). Like
// the 2D engine it is pure computation and runs in the layout worker: a tick in three dimensions
// costs several times one in two (measured in the M18-D0 spike), so it must stay off the UI
// thread. Positions are x0,y0,z0,x1,…
import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type ForceLink3D,
  type ForceManyBody3D,
  type ForcePosition3D,
  type Simulation3D,
  type SimulationLink3D,
  type SimulationNode3D,
} from 'd3-force-3d';
import type { WarmStart } from './layoutEngine';
import type { Forces } from './types';

type SimNode = SimulationNode3D & { index: number };
type SimLink = SimulationLink3D<SimNode>;

/**
 * Beyond this many nodes repulsion is approximated more coarsely, reaches less far and the
 * layout cools faster: the lighter forces of the spike, which settle 5 000 nodes in seconds.
 */
const LARGE = 1000;

export class LayoutEngine3D {
  readonly n: number;
  readonly dims = 3;
  private readonly sim: Simulation3D<SimNode>;
  private readonly nodes: SimNode[];
  private readonly links: SimLink[];
  private readonly degree: Int32Array;
  private forces: Forces;
  private ticks = 0;

  /**
   * edges holds source,target index pairs. A warm start passes positions to continue from
   * (x0,y0,z0,…; NaN where unknown, those nodes are placed by d3) and a lower alpha.
   */
  constructor(n: number, edges: Int32Array, forces: Forces, warm?: WarmStart) {
    this.n = n;
    this.forces = forces;
    this.nodes = Array.from({ length: n }, (_, index) => {
      const x = warm?.positions[3 * index];
      const y = warm?.positions[3 * index + 1];
      const z = warm?.positions[3 * index + 2];
      return x !== undefined &&
        y !== undefined &&
        z !== undefined &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(z)
        ? { index, x, y, z }
        : { index };
    });
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
    this.sim = forceSimulation<SimNode>(this.nodes, 3).stop();
    this.sim.force(
      'link',
      forceLink<SimNode, SimLink>(this.links)
        .id((d) => d.index)
        .iterations(n > LARGE ? 1 : 2),
    );
    this.sim.force('charge', forceManyBody());
    this.sim.force('x', forceX(0));
    this.sim.force('y', forceY(0));
    this.sim.force('z', forceZ(0));
    this.sim.alphaDecay(n > LARGE ? 0.05 : 0.0228);
    if (warm) this.sim.alpha(warm.alpha);
    this.apply();
  }

  private apply(): void {
    const f = this.forces;
    const deg = this.degree;
    (this.sim.force('link') as ForceLink3D<SimNode, SimLink>)
      .distance(f.linkDistance)
      .strength((l) => {
        const s = (l.source as SimNode).index;
        const t = (l.target as SimNode).index;
        return f.linkStrength / Math.max(1, Math.min(deg[s] ?? 1, deg[t] ?? 1));
      });
    (this.sim.force('charge') as ForceManyBody3D)
      .strength(-f.repel * 3)
      .theta(this.n > LARGE ? 1.5 : 0.9)
      .distanceMax(this.n > LARGE ? 250 : 1000);
    const k = f.center * 0.2;
    for (const axis of ['x', 'y', 'z']) (this.sim.force(axis) as ForcePosition3D).strength(k);
  }

  setForces(forces: Forces): void {
    this.forces = forces;
    this.apply();
    this.reheat();
  }

  /** Restarts the cooling so the layout reacts to a changed force or a moved node. */
  reheat(alpha = 0.6): void {
    this.sim.alpha(Math.max(this.sim.alpha(), alpha));
  }

  /**
   * Holds a node where the user put it: the others arrange themselves around it. The layout is
   * warmed just enough for the neighbours to follow.
   */
  fix(index: number, x: number, y: number, z: number): void {
    const nd = this.nodes[index];
    if (!nd) return;
    nd.fx = nd.x = x;
    nd.fy = nd.y = y;
    nd.fz = nd.z = z;
    this.reheat(0.3);
  }

  /** Lets a held node go (all of them without an index). */
  release(index?: number): void {
    const free = (nd: SimNode | undefined): void => {
      if (nd) nd.fx = nd.fy = nd.fz = null;
    };
    if (index === undefined) this.nodes.forEach(free);
    else free(this.nodes[index]);
    this.reheat(0.3);
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

  /** Current positions as x0,y0,z0,x1,… (a fresh buffer: safe to transfer). */
  snapshot(): Float32Array {
    const out = new Float32Array(this.n * 3);
    for (let i = 0; i < this.n; i++) {
      const nd = this.nodes[i] as SimNode;
      out[3 * i] = nd.x ?? 0;
      out[3 * i + 1] = nd.y ?? 0;
      out[3 * i + 2] = nd.z ?? 0;
    }
    return out;
  }
}
