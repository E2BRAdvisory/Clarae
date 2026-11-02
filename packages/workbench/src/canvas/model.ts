// The JSON Canvas model (https://jsoncanvas.org, spec 1.0) and the pure operations the
// canvas editor applies to it. Unknown fields are kept, so files written by other tools
// survive an edit. Nothing here touches the DOM.

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type NodeType = 'text' | 'file' | 'link' | 'group';

export interface CNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  [extra: string]: unknown;
}

export interface CEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  fromEnd?: 'none' | 'arrow';
  toNode: string;
  toSide?: Side;
  toEnd?: 'none' | 'arrow';
  color?: string;
  label?: string;
  [extra: string]: unknown;
}

export interface CanvasData {
  nodes: CNode[];
  edges: CEdge[];
  [extra: string]: unknown;
}

/** The six preset colors of the spec ("1".."6"); any other value is a CSS hex color. */
export const PRESET_COLORS: Record<string, string> = {
  '1': '#fb464c',
  '2': '#e9973f',
  '3': '#e0de71',
  '4': '#44cf6e',
  '5': '#53dfdd',
  '6': '#a882ff',
};

export function colorOf(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return PRESET_COLORS[color] ?? (/^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined);
}

export const MIN_WIDTH = 80;
export const MIN_HEIGHT = 50;
export const DEFAULT_SIZE = { width: 260, height: 120 };

const TYPES: readonly NodeType[] = ['text', 'file', 'link', 'group'];

/** Parses a .canvas file; an empty file is an empty canvas, anything invalid throws. */
export function parseCanvas(text: string): CanvasData {
  if (text.trim() === '') return { nodes: [], edges: [] };
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('not a canvas file');
  const o = raw as Record<string, unknown>;
  const nodes = o['nodes'] ?? [];
  const edges = o['edges'] ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(edges))
    throw new Error('nodes and edges must be lists');
  const ids = new Set<string>();
  for (const n of nodes as Record<string, unknown>[]) {
    if (typeof n['id'] !== 'string' || n['id'] === '') throw new Error('a node has no id');
    if (ids.has(n['id'])) throw new Error(`duplicate id ${n['id']}`);
    ids.add(n['id']);
    if (!TYPES.includes(n['type'] as NodeType))
      throw new Error(`node ${n['id']} has an unknown type`);
    for (const k of ['x', 'y', 'width', 'height'])
      if (typeof n[k] !== 'number') throw new Error(`node ${n['id']} has no ${k}`);
  }
  for (const e of edges as Record<string, unknown>[]) {
    if (typeof e['id'] !== 'string' || e['id'] === '') throw new Error('an edge has no id');
    if (!ids.has(String(e['fromNode'])) || !ids.has(String(e['toNode'])))
      throw new Error(`edge ${e['id']} points to a missing node`);
  }
  return { ...o, nodes: nodes as CNode[], edges: edges as CEdge[] };
}

export function serializeCanvas(data: CanvasData): string {
  return JSON.stringify(data, null, '\t');
}

export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---- geometry ----

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boundsOf(nodes: readonly Rect[]): Rect {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x1 = Math.min(...nodes.map((n) => n.x));
  const y1 = Math.min(...nodes.map((n) => n.y));
  const x2 = Math.max(...nodes.map((n) => n.x + n.width));
  const y2 = Math.max(...nodes.map((n) => n.y + n.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function anchor(n: Rect, side: Side): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: n.x + n.width / 2, y: n.y };
    case 'bottom':
      return { x: n.x + n.width / 2, y: n.y + n.height };
    case 'left':
      return { x: n.x, y: n.y + n.height / 2 };
    case 'right':
      return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

/** The sides that face each other: horizontal neighbours connect left/right, others top/bottom. */
export function autoSides(from: Rect, to: Rect): { from: Side; to: Side } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy))
    return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

const DIR: Record<Side, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export interface EdgeGeometry {
  d: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  mid: { x: number; y: number };
}

/** SVG path (cubic curve) of an edge, with its end points and the middle for the label. */
export function edgeGeometry(data: CanvasData, edge: CEdge): EdgeGeometry | null {
  const a = data.nodes.find((n) => n.id === edge.fromNode);
  const b = data.nodes.find((n) => n.id === edge.toNode);
  if (!a || !b) return null;
  const auto = autoSides(a, b);
  const fs = edge.fromSide ?? auto.from;
  const ts = edge.toSide ?? auto.to;
  const p1 = anchor(a, fs);
  const p2 = anchor(b, ts);
  const k = Math.max(40, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3);
  const c1 = { x: p1.x + DIR[fs].x * k, y: p1.y + DIR[fs].y * k };
  const c2 = { x: p2.x + DIR[ts].x * k, y: p2.y + DIR[ts].y * k };
  const mid = {
    x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
    y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
  };
  return {
    d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
    from: p1,
    to: p2,
    mid,
  };
}

const inside = (outer: Rect, n: Rect): boolean =>
  n.x >= outer.x &&
  n.y >= outer.y &&
  n.x + n.width <= outer.x + outer.width &&
  n.y + n.height <= outer.y + outer.height;

/** Ids of the nodes lying inside a group (they travel with it). */
export function groupMembers(data: CanvasData, groupId: string): string[] {
  const g = data.nodes.find((n) => n.id === groupId && n.type === 'group');
  if (!g) return [];
  return data.nodes.filter((n) => n.id !== groupId && inside(g, n)).map((n) => n.id);
}

// ---- operations (pure: they return a new CanvasData) ----

function omit<T extends object>(o: T, key: string): T {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)) as T;
}

const patchNodes = (
  data: CanvasData,
  ids: ReadonlySet<string>,
  f: (n: CNode) => CNode,
): CanvasData => ({ ...data, nodes: data.nodes.map((n) => (ids.has(n.id) ? f(n) : n)) });

/** What a new node needs; the id is generated and the size defaults. */
export interface NodeInit {
  type: NodeType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
}

export function addNode(data: CanvasData, node: NodeInit): { data: CanvasData; id: string } {
  const id = newId();
  const full: CNode = { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, ...node, id };
  return { data: { ...data, nodes: [...data.nodes, full] }, id };
}

/** Moves nodes; a moved group takes the nodes inside it along. */
export function moveNodes(
  data: CanvasData,
  ids: readonly string[],
  dx: number,
  dy: number,
): CanvasData {
  const all = new Set(ids);
  for (const id of ids) for (const m of groupMembers(data, id)) all.add(m);
  return patchNodes(data, all, (n) => ({ ...n, x: n.x + dx, y: n.y + dy }));
}

export function resizeNode(
  data: CanvasData,
  id: string,
  width: number,
  height: number,
): CanvasData {
  return patchNodes(data, new Set([id]), (n) => ({
    ...n,
    width: Math.max(MIN_WIDTH, Math.round(width)),
    height: Math.max(MIN_HEIGHT, Math.round(height)),
  }));
}

export function setNodeField(
  data: CanvasData,
  id: string,
  field: 'text' | 'label',
  value: string,
): CanvasData {
  return patchNodes(data, new Set([id]), (n) =>
    field === 'text' ? { ...n, text: value } : { ...n, label: value },
  );
}

/** Sets (or, with undefined, clears) the color of nodes and edges. */
export function setColor(
  data: CanvasData,
  ids: readonly string[],
  color: string | undefined,
): CanvasData {
  const set = new Set(ids);
  const apply = <T extends { color?: string }>(x: T): T => {
    const rest = omit(x, 'color');
    return color === undefined ? rest : { ...rest, color };
  };
  return {
    ...data,
    nodes: data.nodes.map((n) => (set.has(n.id) ? apply(n) : n)),
    edges: data.edges.map((e) => (set.has(e.id) ? apply(e) : e)),
  };
}

/** Connects two nodes with the sides that face each other; null for a self loop or a duplicate. */
export function addEdge(
  data: CanvasData,
  fromId: string,
  toId: string,
  sides?: { from: Side; to: Side },
): { data: CanvasData; id: string } | null {
  if (fromId === toId) return null;
  const a = data.nodes.find((n) => n.id === fromId);
  const b = data.nodes.find((n) => n.id === toId);
  if (!a || !b) return null;
  if (data.edges.some((e) => e.fromNode === fromId && e.toNode === toId)) return null;
  const s = sides ?? autoSides(a, b);
  const id = newId();
  const edge: CEdge = {
    id,
    fromNode: fromId,
    fromSide: s.from,
    toNode: toId,
    toSide: s.to,
    toEnd: 'arrow',
  };
  return { data: { ...data, edges: [...data.edges, edge] }, id };
}

export function setEdgeLabel(data: CanvasData, id: string, label: string): CanvasData {
  return {
    ...data,
    edges: data.edges.map((e) => {
      if (e.id !== id) return e;
      const rest = omit(e, 'label');
      return label === '' ? rest : { ...rest, label };
    }),
  };
}

/** Removes nodes and edges by id, and the edges left dangling. */
export function removeItems(data: CanvasData, ids: readonly string[]): CanvasData {
  const gone = new Set(ids);
  const nodes = data.nodes.filter((n) => !gone.has(n.id));
  const alive = new Set(nodes.map((n) => n.id));
  return {
    ...data,
    nodes,
    edges: data.edges.filter(
      (e) => !gone.has(e.id) && alive.has(e.fromNode) && alive.has(e.toNode),
    ),
  };
}

/** Draw order: groups first (behind), then the others in file order. */
export function drawOrder(nodes: readonly CNode[]): CNode[] {
  return [...nodes.filter((n) => n.type === 'group'), ...nodes.filter((n) => n.type !== 'group')];
}

// ---- undo / redo ----

/** Snapshot history. The canvas data is immutable, so snapshots are just references. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private readonly limit = 100) {}

  /** Records the state before a change. */
  record(before: T): void {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: T): T | undefined {
    const prev = this.past.pop();
    if (prev === undefined) return undefined;
    this.future.push(current);
    return prev;
  }
  redo(current: T): T | undefined {
    const next = this.future.pop();
    if (next === undefined) return undefined;
    this.past.push(current);
    return next;
  }
  /** Forgets every step (the state was replaced from outside: the snapshots no longer apply). */
  clear(): void {
    this.past = [];
    this.future = [];
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
