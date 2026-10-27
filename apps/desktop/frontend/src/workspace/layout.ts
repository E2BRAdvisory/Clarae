// The workspace model (§2.2.1 "Pannelli, tab, split, linked panes"): a tree of
// panes (each with tabs) and splits. Everything here is pure: functions take a
// Layout and return a new one, so the model is easy to test and to persist
// (.memobrain/workspace.json).
import type { NoteMode } from '../state/settings';

export interface Tab {
  id: string;
  path: string;
  mode: NoteMode;
}

export interface Pane {
  kind: 'pane';
  id: string;
  tabs: Tab[];
  active: string | null;
  /** Panes sharing a link group follow each other's navigation. */
  link?: string;
}

export interface Split {
  kind: 'split';
  id: string;
  dir: 'row' | 'column';
  children: LayoutNode[];
  /** Fractions summing to 1, one per child. */
  sizes: number[];
}

export type LayoutNode = Pane | Split;

export interface Layout {
  root: LayoutNode;
  activePane: string;
}

let counter = 0;
let idFactory: (prefix: string) => string = (prefix) =>
  `${prefix}${Date.now().toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Tests inject deterministic ids. */
export function setIdFactory(f: (prefix: string) => string): void {
  idFactory = f;
}

export function emptyLayout(): Layout {
  const pane: Pane = { kind: 'pane', id: idFactory('p'), tabs: [], active: null };
  return { root: pane, activePane: pane.id };
}

export function allPanes(node: LayoutNode): Pane[] {
  return node.kind === 'pane' ? [node] : node.children.flatMap(allPanes);
}

export function findPane(layout: Layout, id: string): Pane | undefined {
  return allPanes(layout.root).find((p) => p.id === id);
}

export function paneOfTab(layout: Layout, tabId: string): Pane | undefined {
  return allPanes(layout.root).find((p) => p.tabs.some((t) => t.id === tabId));
}

export function activeTab(layout: Layout): Tab | undefined {
  const p = findPane(layout, layout.activePane);
  return p?.tabs.find((t) => t.id === p.active);
}

/** All paths currently open in any tab. */
export function openPaths(layout: Layout): string[] {
  return [...new Set(allPanes(layout.root).flatMap((p) => p.tabs.map((t) => t.path)))];
}

function mapPanes(node: LayoutNode, fn: (p: Pane) => Pane): LayoutNode {
  if (node.kind === 'pane') return fn(node);
  return { ...node, children: node.children.map((c) => mapPanes(c, fn)) };
}

/** Collapses empty splits and single-child splits; keeps sizes normalized. */
function normalize(node: LayoutNode): LayoutNode {
  if (node.kind === 'pane') return node;
  const children = node.children.map(normalize);
  if (children.length === 1) return children[0] as LayoutNode;
  const total = node.sizes.reduce((a, b) => a + b, 0) || 1;
  const sizes =
    children.length === node.children.length
      ? node.sizes.map((s) => s / total)
      : children.map(() => 1 / children.length);
  // Merge a child split of the same direction into its parent.
  const flat: LayoutNode[] = [];
  const flatSizes: number[] = [];
  children.forEach((c, i) => {
    if (c.kind === 'split' && c.dir === node.dir) {
      c.children.forEach((cc, j) => {
        flat.push(cc);
        flatSizes.push((sizes[i] ?? 0) * (c.sizes[j] ?? 0));
      });
    } else {
      flat.push(c);
      flatSizes.push(sizes[i] ?? 0);
    }
  });
  return { ...node, children: flat, sizes: flatSizes };
}

export interface OpenOptions {
  paneId?: string;
  /** Open in a new tab instead of replacing the active tab. */
  newTab?: boolean;
  mode: NoteMode;
}

function withLinked(layout: Layout, source: Pane, path: string, mode: NoteMode): Layout {
  if (!source.link) return layout;
  let next = layout;
  for (const p of allPanes(layout.root)) {
    if (p.id === source.id || p.link !== source.link) continue;
    next = openIn(next, p.id, path, mode, false);
  }
  return next;
}

function openIn(
  layout: Layout,
  paneId: string,
  path: string,
  mode: NoteMode,
  newTab: boolean,
): Layout {
  const pane = findPane(layout, paneId);
  if (!pane) return layout;
  const existing = pane.tabs.find((t) => t.path === path);
  let tabs = pane.tabs;
  let active = pane.active;
  if (existing) {
    active = existing.id;
  } else if (newTab || !pane.active) {
    const tab: Tab = { id: idFactory('t'), path, mode };
    tabs = [...pane.tabs, tab];
    active = tab.id;
  } else {
    tabs = pane.tabs.map((t) => (t.id === pane.active ? { ...t, path } : t));
  }
  return {
    root: mapPanes(layout.root, (p) => (p.id === paneId ? { ...p, tabs, active } : p)),
    activePane: paneId,
  };
}

/** Opens a file: replaces the active tab, or adds a tab. Linked panes follow. */
export function openPath(layout: Layout, path: string, opts: OpenOptions): Layout {
  const paneId = opts.paneId ?? layout.activePane;
  const next = openIn(layout, paneId, path, opts.mode, !!opts.newTab);
  const pane = findPane(next, paneId);
  const followed = pane ? withLinked(next, pane, path, opts.mode) : next;
  return { ...followed, activePane: paneId };
}

export function setActiveTab(layout: Layout, paneId: string, tabId: string): Layout {
  return {
    root: mapPanes(layout.root, (p) =>
      p.id === paneId && p.tabs.some((t) => t.id === tabId) ? { ...p, active: tabId } : p,
    ),
    activePane: paneId,
  };
}

export function setActivePane(layout: Layout, paneId: string): Layout {
  return findPane(layout, paneId) ? { ...layout, activePane: paneId } : layout;
}

export function setMode(layout: Layout, tabId: string, mode: NoteMode): Layout {
  return {
    ...layout,
    root: mapPanes(layout.root, (p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, mode } : t)),
    })),
  };
}

function removePane(layout: Layout, paneId: string): Layout {
  const strip = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === 'pane') return node.id === paneId ? null : node;
    const children = node.children.map(strip).filter((c): c is LayoutNode => c !== null);
    if (children.length === 0) return null;
    if (children.length === node.children.length) return { ...node, children };
    return { ...node, children, sizes: children.map(() => 1 / children.length) };
  };
  const root = strip(layout.root);
  if (!root) return emptyLayout();
  const normalized = normalize(root);
  const panes = allPanes(normalized);
  const activePane = panes.some((p) => p.id === layout.activePane)
    ? layout.activePane
    : (panes[0] as Pane).id;
  return { root: normalized, activePane };
}

/** Closes a tab; an emptied pane disappears unless it is the last one. */
export function closeTab(layout: Layout, tabId: string): Layout {
  const pane = paneOfTab(layout, tabId);
  if (!pane) return layout;
  const idx = pane.tabs.findIndex((t) => t.id === tabId);
  const tabs = pane.tabs.filter((t) => t.id !== tabId);
  if (tabs.length === 0 && allPanes(layout.root).length > 1) return removePane(layout, pane.id);
  const active =
    pane.active === tabId ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : pane.active;
  return {
    ...layout,
    root: mapPanes(layout.root, (p) => (p.id === pane.id ? { ...p, tabs, active } : p)),
  };
}

export function closePane(layout: Layout, paneId: string): Layout {
  if (allPanes(layout.root).length <= 1) {
    return { ...layout, root: mapPanes(layout.root, (p) => ({ ...p, tabs: [], active: null })) };
  }
  return removePane(layout, paneId);
}

/** Splits a pane; the new pane shows `path` (default: the active tab's note). */
export function splitPane(
  layout: Layout,
  paneId: string,
  dir: 'row' | 'column',
  mode: NoteMode,
  path?: string,
): Layout {
  const pane = findPane(layout, paneId);
  if (!pane) return layout;
  const source = pane.tabs.find((t) => t.id === pane.active);
  const p = path ?? source?.path;
  const fresh: Pane = {
    kind: 'pane',
    id: idFactory('p'),
    tabs: p ? [{ id: idFactory('t'), path: p, mode: source?.mode ?? mode }] : [],
    active: null,
  };
  fresh.active = fresh.tabs[0]?.id ?? null;
  const replace = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'pane') {
      return node.id === paneId
        ? { kind: 'split', id: idFactory('s'), dir, children: [node, fresh], sizes: [0.5, 0.5] }
        : node;
    }
    return { ...node, children: node.children.map(replace) };
  };
  return { root: normalize(replace(layout.root)), activePane: fresh.id };
}

/** Moves a tab to another pane (or reorders within the pane) at index. */
export function moveTab(layout: Layout, tabId: string, toPaneId: string, index?: number): Layout {
  const from = paneOfTab(layout, tabId);
  const to = findPane(layout, toPaneId);
  const tab = from?.tabs.find((t) => t.id === tabId);
  if (!from || !to || !tab) return layout;
  const sameIdx = from.id === to.id;
  const without = (sameIdx ? to.tabs : to.tabs).filter((t) => t.id !== tabId);
  const at = Math.min(Math.max(0, index ?? without.length), without.length);
  const target = [...without.slice(0, at), tab, ...without.slice(at)];
  let next: Layout = {
    root: mapPanes(layout.root, (p) => {
      if (p.id === to.id) return { ...p, tabs: target, active: tab.id };
      if (p.id === from.id) {
        const rest = p.tabs.filter((t) => t.id !== tabId);
        return { ...p, tabs: rest, active: p.active === tabId ? (rest[0]?.id ?? null) : p.active };
      }
      return p;
    }),
    activePane: to.id,
  };
  if (!sameIdx && findPane(next, from.id)?.tabs.length === 0 && allPanes(next.root).length > 1)
    next = { ...removePane(next, from.id), activePane: to.id };
  return next;
}

export function setSizes(layout: Layout, splitId: string, sizes: number[]): Layout {
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'pane') return node;
    if (node.id === splitId && sizes.length === node.children.length) {
      const total = sizes.reduce((a, b) => a + b, 0) || 1;
      return { ...node, sizes: sizes.map((s) => Math.max(0.05, s / total)) };
    }
    return { ...node, children: node.children.map(apply) };
  };
  return { ...layout, root: apply(layout.root) };
}

/** Links the pane with the most recent other pane (or unlinks it). */
export function toggleLink(layout: Layout, paneId: string): Layout {
  const panes = allPanes(layout.root);
  const pane = panes.find((p) => p.id === paneId);
  if (!pane) return layout;
  if (pane.link) {
    const group = pane.link;
    const members = panes.filter((p) => p.link === group);
    return {
      ...layout,
      root: mapPanes(layout.root, (p) => {
        if (p.id === paneId || (members.length <= 2 && p.link === group)) {
          const rest = { ...p };
          delete rest.link;
          return rest;
        }
        return p;
      }),
    };
  }
  const other = panes.find((p) => p.id !== paneId);
  if (!other) return layout;
  const group = other.link ?? idFactory('l');
  return {
    ...layout,
    root: mapPanes(layout.root, (p) =>
      p.id === paneId || p.id === other.id ? { ...p, link: group } : p,
    ),
  };
}

export function cycleTab(layout: Layout, delta: 1 | -1): Layout {
  const pane = findPane(layout, layout.activePane);
  if (!pane || pane.tabs.length < 2) return layout;
  const i = pane.tabs.findIndex((t) => t.id === pane.active);
  const next = pane.tabs[(i + delta + pane.tabs.length) % pane.tabs.length];
  return next ? setActiveTab(layout, pane.id, next.id) : layout;
}

/** A file or folder was renamed: tabs follow it. */
export function renamePath(layout: Layout, from: string, to: string): Layout {
  return {
    ...layout,
    root: mapPanes(layout.root, (p) => ({
      ...p,
      tabs: p.tabs.map((t) =>
        t.path === from
          ? { ...t, path: to }
          : t.path.startsWith(from + '/')
            ? { ...t, path: to + t.path.slice(from.length) }
            : t,
      ),
    })),
  };
}

/** A file or folder was deleted: its tabs close. */
export function removePath(layout: Layout, path: string): Layout {
  let next = layout;
  for (const p of allPanes(layout.root)) {
    for (const t of p.tabs)
      if (t.path === path || t.path.startsWith(path + '/')) next = closeTab(next, t.id);
  }
  return next;
}

// ---- persistence -----------------------------------------------------------

const MODES: readonly NoteMode[] = ['live', 'source', 'reading'];

function parseNode(raw: unknown, depth = 0): LayoutNode | null {
  if (!raw || typeof raw !== 'object' || depth > 8) return null;
  const n = raw as Record<string, unknown>;
  if (n['kind'] === 'pane') {
    if (typeof n['id'] !== 'string' || !Array.isArray(n['tabs'])) return null;
    const tabs: Tab[] = [];
    for (const t of n['tabs']) {
      const o = t as Record<string, unknown>;
      if (
        o &&
        typeof o['id'] === 'string' &&
        typeof o['path'] === 'string' &&
        MODES.includes(o['mode'] as NoteMode)
      ) {
        tabs.push({ id: o['id'], path: o['path'], mode: o['mode'] as NoteMode });
      }
    }
    const active =
      typeof n['active'] === 'string' && tabs.some((t) => t.id === n['active'])
        ? n['active']
        : (tabs[0]?.id ?? null);
    return {
      kind: 'pane',
      id: n['id'],
      tabs,
      active,
      ...(typeof n['link'] === 'string' ? { link: n['link'] } : {}),
    };
  }
  if (n['kind'] === 'split') {
    if (
      typeof n['id'] !== 'string' ||
      (n['dir'] !== 'row' && n['dir'] !== 'column') ||
      !Array.isArray(n['children'])
    )
      return null;
    const children = n['children']
      .map((c) => parseNode(c, depth + 1))
      .filter((c): c is LayoutNode => c !== null);
    if (children.length === 0) return null;
    const sizes =
      Array.isArray(n['sizes']) &&
      n['sizes'].length === children.length &&
      n['sizes'].every((s) => typeof s === 'number' && s > 0)
        ? (n['sizes'] as number[])
        : children.map(() => 1);
    return { kind: 'split', id: n['id'], dir: n['dir'], children, sizes };
  }
  return null;
}

/** Validates a persisted layout; anything malformed yields null (start fresh). */
export function parseLayout(raw: unknown): Layout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const node = parseNode(r['root']);
  if (!node) return null;
  const root = normalize(node);
  const panes = allPanes(root);
  const activePane =
    typeof r['activePane'] === 'string' && panes.some((p) => p.id === r['activePane'])
      ? r['activePane']
      : (panes[0] as Pane).id;
  return { root, activePane };
}
