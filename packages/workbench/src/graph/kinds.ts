// The kind of document a node of the graph stands for, which the 3D view shows as an icon: the
// same kinds and icons as the file explorer, plus the tag and the note that does not exist yet.
import { classify, KIND_ICON, type EmbedKind } from '../embeds/media';
import type { IconName } from '../shell/icons';
import type { GraphNode } from './types';

export type NodeKind = EmbedKind | 'tag' | 'ghost';

/** Order of the legend: documents first, then what is not a file. */
export const NODE_KINDS: readonly NodeKind[] = [
  'note',
  'presentation',
  'drawing',
  'canvas',
  'base',
  'image',
  'pdf',
  'audio',
  'video',
  'other',
  'tag',
  'ghost',
];

export function nodeKind(nd: Pick<GraphNode, 'kind' | 'path'>): NodeKind {
  switch (nd.kind) {
    case 'tag':
    case 'ghost':
    case 'drawing':
    case 'canvas':
    case 'base':
      return nd.kind;
    default:
      // A note is a .md or a .marp, an attachment whatever its extension says.
      return nd.path ? classify(nd.path) : 'note';
  }
}

export const kindIcon = (kind: NodeKind): IconName =>
  kind === 'tag' ? 'tag' : kind === 'ghost' ? 'link' : KIND_ICON[kind];

/** The kinds present in a graph with the number of their nodes, in the order of the legend. */
export function kindCounts(
  nodes: readonly Pick<GraphNode, 'kind' | 'path'>[],
): { kind: NodeKind; count: number }[] {
  const counts = new Map<NodeKind, number>();
  for (const nd of nodes) {
    const k = nodeKind(nd);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return NODE_KINDS.filter((k) => counts.has(k)).map((kind) => ({
    kind,
    count: counts.get(kind) as number,
  }));
}
