import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  anchor,
  autoSides,
  boundsOf,
  colorOf,
  drawOrder,
  edgeGeometry,
  groupMembers,
  History,
  moveNodes,
  parseCanvas,
  removeItems,
  resizeNode,
  serializeCanvas,
  setColor,
  setEdgeLabel,
  type CanvasData,
} from './model';

const base = (): CanvasData => ({
  nodes: [
    { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 400, label: 'Group' },
    { id: 'a', type: 'text', x: 20, y: 20, width: 100, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 300, y: 20, width: 100, height: 60, text: 'B' },
    { id: 'out', type: 'text', x: 800, y: 0, width: 100, height: 60, text: 'out' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', label: 'x' }],
});

describe('canvas model', () => {
  it('round-trips a file and keeps unknown fields', () => {
    const text = JSON.stringify({
      nodes: [{ id: 'n', type: 'text', x: 1, y: 2, width: 3, height: 4, text: 'hi', mine: 7 }],
      edges: [],
      extra: { keep: true },
    });
    const data = parseCanvas(text);
    expect(data['extra']).toEqual({ keep: true });
    expect(data.nodes[0]?.['mine']).toBe(7);
    expect(JSON.parse(serializeCanvas(data))).toEqual(JSON.parse(text));
    expect(serializeCanvas(data)).toContain('\n\t'); // tab indented like Obsidian
  });

  it('accepts an empty file and refuses broken ones', () => {
    expect(parseCanvas('')).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas('{}')).toEqual({ nodes: [], edges: [] });
    for (const bad of [
      '{',
      '[]',
      '{"nodes":[{"type":"text"}]}',
      '{"nodes":[{"id":"a","type":"video","x":0,"y":0,"width":1,"height":1}]}',
      '{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1}]}',
      '{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1},{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1}]}',
      '{"nodes":[],"edges":[{"id":"e","fromNode":"x","toNode":"y"}]}',
    ])
      expect(() => parseCanvas(bad), bad).toThrow();
  });

  it('adds nodes with defaults and unique ids', () => {
    const a = addNode({ nodes: [], edges: [] }, { type: 'text', x: 5, y: 6, text: '' });
    const b = addNode(a.data, { type: 'group', x: 0, y: 0, label: 'g', width: 400, height: 300 });
    expect(a.data.nodes[0]).toMatchObject({ x: 5, y: 6, width: 260, height: 120 });
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
    expect(b.id).not.toBe(a.id);
    expect(b.data.nodes).toHaveLength(2);
  });

  it('moves a node, and a group with the nodes inside it', () => {
    const moved = moveNodes(base(), ['a'], 10, -5);
    expect(moved.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 30, y: 15 });
    expect(moved.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 300, y: 20 });
    expect(groupMembers(base(), 'g').sort()).toEqual(['a', 'b']);
    const g = moveNodes(base(), ['g'], 100, 0);
    expect(g.nodes.map((n) => [n.id, n.x])).toEqual([
      ['g', 100],
      ['a', 120],
      ['b', 400],
      ['out', 800],
    ]);
  });

  it('resizes with a minimum size', () => {
    expect(resizeNode(base(), 'a', 10, 10).nodes[1]).toMatchObject({ width: 80, height: 50 });
    expect(resizeNode(base(), 'a', 301.4, 200).nodes[1]).toMatchObject({ width: 301, height: 200 });
  });

  it('connects facing sides, refusing loops and duplicates', () => {
    const d = base();
    expect(addEdge(d, 'a', 'a')).toBeNull();
    expect(addEdge(d, 'a', 'b')).toBeNull(); // already connected
    expect(addEdge(d, 'a', 'zz')).toBeNull();
    const r = addEdge(d, 'b', 'a');
    expect(r?.data.edges.at(-1)).toMatchObject({
      fromNode: 'b',
      toNode: 'a',
      fromSide: 'left',
      toSide: 'right',
      toEnd: 'arrow',
    });
    expect(
      autoSides({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 100, width: 10, height: 10 }),
    ).toEqual({ from: 'bottom', to: 'top' });
  });

  it('removes items and the edges they leave dangling', () => {
    expect(removeItems(base(), ['a']).edges).toEqual([]);
    expect(removeItems(base(), ['e1']).nodes).toHaveLength(4);
    expect(removeItems(base(), ['out']).edges).toHaveLength(1);
  });

  it('labels edges and colors nodes and edges', () => {
    expect(setEdgeLabel(base(), 'e1', 'depends').edges[0]?.label).toBe('depends');
    expect(setEdgeLabel(base(), 'e1', '').edges[0]).not.toHaveProperty('label');
    const c = setColor(base(), ['a', 'e1'], '4');
    expect(c.nodes[1]?.color).toBe('4');
    expect(c.edges[0]?.color).toBe('4');
    expect(setColor(c, ['a'], undefined).nodes[1]).not.toHaveProperty('color');
    expect(colorOf('1')).toBe('#fb464c');
    expect(colorOf('#abc')).toBe('#abc');
    expect(colorOf('javascript:x')).toBeUndefined();
  });

  it('computes geometry', () => {
    expect(boundsOf(base().nodes)).toEqual({ x: 0, y: 0, width: 900, height: 400 });
    expect(anchor({ x: 0, y: 0, width: 100, height: 50 }, 'right')).toEqual({ x: 100, y: 25 });
    const g = edgeGeometry(base(), base().edges[0]!);
    expect(g?.from).toEqual({ x: 120, y: 50 });
    expect(g?.to).toEqual({ x: 300, y: 50 });
    expect(g?.d.startsWith('M 120 50 C')).toBe(true);
    expect(edgeGeometry(base(), { id: 'x', fromNode: 'a', toNode: 'nope' })).toBeNull();
    expect(drawOrder(base().nodes)[0]?.id).toBe('g');
  });

  it('undoes and redoes', () => {
    const h = new History<number>();
    h.record(1);
    h.record(2);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeUndefined();
    expect(h.redo(1)).toBe(2);
    h.record(9); // a new edit drops the redo branch
    expect(h.canRedo).toBe(false);
    expect(h.canUndo).toBe(true);
  });
});
