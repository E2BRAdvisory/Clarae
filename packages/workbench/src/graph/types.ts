import type { graph } from '../../wailsjs/go/models';

export type GraphOptions = graph.Options;
export type GraphNode = graph.Node;
export type GraphEdge = graph.Edge;
/** Answer of GraphAPI.Build (plain data, without the generated helper). */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  total: number;
}
export type GraphDirection = 'both' | 'in' | 'out';

/** The four adjustable forces of the layout (ranges are enforced by the settings parser). */
export interface Forces {
  /** Pull towards the centre, 0..1. */
  center: number;
  /** Repulsion between nodes, 0..20. */
  repel: number;
  /** Strength of links, 0..2 (1 = d3 default: 1 / min(degree)). */
  linkStrength: number;
  /** Rest length of links, 10..300. */
  linkDistance: number;
}

export const defaultForces: Forces = { center: 0.3, repel: 10, linkStrength: 1, linkDistance: 40 };
export const forceRanges: Record<keyof Forces, { min: number; max: number; step: number }> = {
  center: { min: 0, max: 1, step: 0.01 },
  repel: { min: 0, max: 20, step: 0.5 },
  linkStrength: { min: 0, max: 2, step: 0.05 },
  linkDistance: { min: 10, max: 300, step: 5 },
};
