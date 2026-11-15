// What the graph view asks of a surface that draws the graph: the 2D canvas (Graph2D) and the
// 3D scene (three/Graph3D) take the same model and report the same gestures, so everything
// around them — data, filters, timelapse, toolbar, status — is written once (GraphView).
import type { GraphModel } from './model';
import type { GraphSettings } from './settings';

export interface GraphSurfaceProps {
  /** The graph to draw; null while the first answer is on its way. */
  model: GraphModel | null;
  /**
   * The layout of this model continues from the one on screen: a refresh after file changes, not
   * new options (those lay the graph out from scratch and fit it).
   */
  warm: boolean;
  settings: GraphSettings;
  /** Nodes shown by the timelapse; null shows everything. */
  visible: Uint8Array | null;
  /** The node walked to with the keyboard (-1: none). */
  focusNode: number;
  onFocusNode: (index: number) => void;
  /** Opens what a node stands for: a file, the search of a tag, a note to create. */
  onOpenNode: (index: number, newTab: boolean) => void;
  /** Accessible name of the surface. */
  label: string;
  /** 3D: how many nodes the user dragged and left held in place. */
  onHeldNodes?: (count: number) => void;
  /** 3D: the surface cannot draw (no slot left, lost context, failed start): the view falls back to 2D. */
  onUnavailable?: (reason: Unavailable3D) => void;
}

/** Why a 3D surface gave up: all the slots are taken, the GPU took the context back, it did not start. */
export type Unavailable3D = 'limit' | 'lost' | 'failed';

export interface GraphSurfaceHandle {
  /** Brings the whole graph into view. */
  fit(): void;
  /** 3D: frees the nodes held in place after a drag. */
  releaseNodes(): void;
}
