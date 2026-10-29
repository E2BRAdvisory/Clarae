// In-memory counterpart of graph.Build (Go) for the Wails mock: same options and answer
// shape, simplified query support (substring, file:, path:, tag:, - negation).
import type { GraphData, GraphNode, GraphOptions } from './types';

export interface MockSource {
  /** Vault paths of notes (.md) and attachments. */
  paths: string[];
  /** Outgoing links of a note: resolved vault path ('' when unresolved) and the raw target. */
  links: (path: string) => { path: string; raw: string }[];
  tags: (path: string) => string[];
  text: (path: string) => string;
}

const stem = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '');

/** A tiny evaluator of the search language: AND of terms, `-` negation, file:/path:/tag:. */
export function matchesQuery(src: MockSource, path: string, query: string): boolean {
  const terms = query.match(/-?(?:\w+:)?(?:"[^"]*"|\S+)/g) ?? [];
  const lower = (s: string): string => s.toLowerCase();
  return terms.every((raw) => {
    const neg = raw.startsWith('-');
    let t = neg ? raw.slice(1) : raw;
    let op = '';
    const m = /^(file|path|tag|content):(.*)$/.exec(t);
    if (m) {
      op = m[1] as string;
      t = m[2] as string;
    }
    t = lower(t.replace(/^"|"$/g, '').replace(/^#/, ''));
    let hit: boolean;
    switch (op) {
      case 'file':
        hit = lower(stem(path)).includes(t);
        break;
      case 'path':
        hit = lower(path).includes(t);
        break;
      case 'tag':
        hit = src.tags(path).some((x) => lower(x) === t || lower(x).startsWith(t + '/'));
        break;
      default:
        hit = lower(stem(path)).includes(t) || lower(src.text(path)).includes(t);
    }
    return hit !== neg;
  });
}

const under = (p: string, folders: string[]): boolean =>
  folders.some((f) => {
    const x = f.replace(/^\/+|\/+$/g, '');
    return x === '' || p.startsWith(x + '/');
  });

export function buildMockGraph(src: MockSource, o: Partial<GraphOptions>): GraphData {
  const nodes: GraphNode[] = [];
  const index = new Map<string, number>();
  const add = (n: GraphNode): number => {
    index.set(n.id, nodes.length);
    nodes.push(n);
    return nodes.length - 1;
  };
  const tagWant = (o.tags ?? []).map((t) => t.replace(/^#/, '').toLowerCase());
  for (const p of [...src.paths].sort()) {
    const attachment = !p.endsWith('.md');
    if (attachment && !o.showAttachments) continue;
    if (o.query?.trim() && !matchesQuery(src, p, o.query)) continue;
    if (o.folders?.length && !under(p, o.folders)) continue;
    if (o.excludeFolders?.length && under(p, o.excludeFolders)) continue;
    if (tagWant.length) {
      const have = src.tags(p).map((t) => t.toLowerCase());
      if (!have.some((h) => tagWant.some((w) => h === w || h.startsWith(w + '/')))) continue;
    }
    add({
      id: p,
      label: attachment ? p.slice(p.lastIndexOf('/') + 1) : stem(p),
      kind: attachment ? 'attachment' : 'note',
      path: p,
      degree: 0,
      // The mock has no timestamps: one day per file, in path order.
      created: Date.UTC(2024, 0, 1) + nodes.length * 86_400_000,
    });
  }
  const seen = new Set<string>();
  const edges: { source: number; target: number }[] = [];
  const edge = (s: number, t: number): void => {
    const key = `${s}>${t}`;
    if (s === t || seen.has(key)) return;
    seen.add(key);
    edges.push({ source: s, target: t });
  };
  const aux = (id: string, label: string, kind: string): number =>
    index.get(id) ?? add({ id, label, kind, path: '', degree: 0, created: 0 });
  for (const p of src.paths) {
    const s = index.get(p);
    if (s === undefined || nodes[s]?.kind !== 'note') continue;
    for (const l of src.links(p)) {
      if (l.path) {
        const t = index.get(l.path);
        if (t !== undefined) edge(s, t);
      } else if (o.showGhosts) {
        const name = l.raw.split(/[#|]/)[0]?.trim() ?? '';
        if (name) edge(s, aux('ghost:' + name.toLowerCase(), name, 'ghost'));
      }
    }
    if (o.showTags)
      for (const t of new Set(src.tags(p).map((x) => x.toLowerCase())))
        edge(s, aux('tag:' + t, '#' + t, 'tag'));
  }
  // Local graph: breadth-first from the centre.
  let keep = nodes.map(() => true);
  if (o.center) {
    const c = index.get(o.center);
    if (c === undefined) return { nodes: [], edges: [], truncated: false, total: 0 };
    keep = nodes.map(() => false);
    keep[c] = true;
    let frontier = [c];
    for (let d = 0; d < Math.max(1, o.depth ?? 1); d++) {
      const next: number[] = [];
      for (const e of edges) {
        const fwd = o.direction !== 'in';
        const back = o.direction !== 'out';
        if (fwd && frontier.includes(e.source) && !keep[e.target]) {
          keep[e.target] = true;
          next.push(e.target);
        }
        if (back && frontier.includes(e.target) && !keep[e.source]) {
          keep[e.source] = true;
          next.push(e.source);
        }
      }
      frontier = next;
    }
  }
  const deg = nodes.map(() => 0);
  for (const e of edges)
    if (keep[e.source] && keep[e.target]) {
      deg[e.source] = (deg[e.source] ?? 0) + 1;
      deg[e.target] = (deg[e.target] ?? 0) + 1;
    }
  nodes.forEach((n, i) => {
    if (keep[i] && !deg[i] && !o.showOrphans && n.id !== o.center) keep[i] = false;
  });
  const remap = nodes.map(() => -1);
  const out: GraphNode[] = [];
  nodes.forEach((n, i) => {
    if (!keep[i]) return;
    remap[i] = out.length;
    out.push({ ...n, degree: 0 });
  });
  const outEdges = edges
    .filter((e) => (remap[e.source] as number) >= 0 && (remap[e.target] as number) >= 0)
    .map((e) => ({ source: remap[e.source] as number, target: remap[e.target] as number }));
  for (const e of outEdges) {
    (out[e.source] as GraphNode).degree++;
    (out[e.target] as GraphNode).degree++;
  }
  (o.groups ?? []).forEach((q, gi) => {
    if (!q.trim()) return;
    for (const n of out) if (n.path && matchesQuery(src, n.path, q)) (n.groups ??= []).push(gi);
  });
  return { nodes: out, edges: outEdges, truncated: false, total: out.length };
}
