// The part of d3-force-3d the 3D graph layout uses (the package ships no types). It is d3-force
// with a number of dimensions: nodes get z, vz and fz next to x and y.
declare module 'd3-force-3d' {
  export interface SimulationNode3D {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    /** A fixed coordinate: the simulation leaves the node there (null or undefined frees it). */
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLink3D<N extends SimulationNode3D> {
    source: N | number;
    target: N | number;
    index?: number;
  }

  export interface Simulation3D<N extends SimulationNode3D> {
    tick(iterations?: number): this;
    stop(): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaDecay(decay: number): this;
    force(name: string): unknown;
    force(name: string, force: unknown): this;
    numDimensions(): number;
    nodes(): N[];
  }

  export interface ForceLink3D<N extends SimulationNode3D, L extends SimulationLink3D<N>> {
    id(id: (node: N) => number | string): this;
    iterations(iterations: number): this;
    distance(distance: number): this;
    strength(strength: number | ((link: L) => number)): this;
  }

  export interface ForceManyBody3D {
    strength(strength: number): this;
    theta(theta: number): this;
    distanceMax(distance: number): this;
  }

  export interface ForcePosition3D {
    strength(strength: number): this;
  }

  export function forceSimulation<N extends SimulationNode3D>(
    nodes?: N[],
    numDimensions?: 1 | 2 | 3,
  ): Simulation3D<N>;
  export function forceLink<N extends SimulationNode3D, L extends SimulationLink3D<N>>(
    links?: L[],
  ): ForceLink3D<N, L>;
  export function forceManyBody(): ForceManyBody3D;
  export function forceX(x?: number): ForcePosition3D;
  export function forceY(y?: number): ForcePosition3D;
  export function forceZ(z?: number): ForcePosition3D;
}
