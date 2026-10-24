// Saved workspaces (§2.2.1 "Workspaces"): named snapshots of the layout (panes,
// tabs, splits, link groups) and of the sidebars, stored in
// .nodus/workspaces.json. Like .nodus/workspace.json this file is
// device-specific and is NOT synchronized (shared/go/pathrules excludes every
// ".nodus/workspace*.json"; §3.4.6). Everything here is pure.
//
//   { "version": 1,
//     "workspaces": [
//       { "name": "Writing", "savedAt": 1700000000000,
//         "layout": { "root": ..., "activePane": "p1" },   // same shape as workspace.json
//         "left":  { "open": true,  "tab": "files",   "width": 280 },
//         "right": { "open": false, "tab": "outline", "width": 280 } } ] }
import { allPanes, parseLayout, removePath, type Layout } from '../workspace/layout';

export const WORKSPACES_VERSION = 1;

export interface SidebarSnapshot {
  open: boolean;
  tab: string;
  width: number;
}

export interface SavedWorkspace {
  name: string;
  savedAt: number;
  layout: Layout;
  left: SidebarSnapshot;
  right: SidebarSnapshot;
}

export interface WorkspacesFile {
  version: number;
  workspaces: SavedWorkspace[];
  extra: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export const clampWidth = (w: number): number => Math.min(600, Math.max(180, w));

function parseSidebar(raw: unknown, fallbackTab: string): SidebarSnapshot {
  const o = isObject(raw) ? raw : {};
  return {
    open: typeof o['open'] === 'boolean' ? o['open'] : true,
    tab: typeof o['tab'] === 'string' && /^[a-z][a-z-]*$/.test(o['tab']) ? o['tab'] : fallbackTab,
    width: typeof o['width'] === 'number' ? clampWidth(o['width']) : 280,
  };
}

export function emptyWorkspaces(): WorkspacesFile {
  return { version: WORKSPACES_VERSION, workspaces: [], extra: {} };
}

/** Parses the file; malformed entries are dropped, garbage yields an empty list. */
export function parseWorkspaces(text: string): WorkspacesFile {
  if (!text.trim()) return emptyWorkspaces();
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObject(raw)) return emptyWorkspaces();
    const { version, workspaces, ...extra } = raw;
    const seen = new Set<string>();
    const list: SavedWorkspace[] = [];
    for (const w of Array.isArray(workspaces) ? workspaces : []) {
      if (!isObject(w) || typeof w['name'] !== 'string' || !w['name'].trim()) continue;
      const layout = parseLayout(w['layout']);
      const key = w['name'].toLowerCase();
      if (!layout || seen.has(key)) continue;
      seen.add(key);
      list.push({
        name: w['name'],
        savedAt: typeof w['savedAt'] === 'number' ? w['savedAt'] : 0,
        layout,
        left: parseSidebar(w['left'], 'files'),
        right: parseSidebar(w['right'], 'outline'),
      });
    }
    return {
      version: typeof version === 'number' ? version : WORKSPACES_VERSION,
      workspaces: list,
      extra,
    };
  } catch {
    return emptyWorkspaces();
  }
}

export function serializeWorkspaces(file: WorkspacesFile): string {
  return JSON.stringify(
    {
      ...file.extra,
      version: Math.max(file.version, WORKSPACES_VERSION),
      workspaces: file.workspaces,
    },
    null,
    2,
  );
}

export const normalizeName = (name: string): string => name.trim().replace(/\s+/g, ' ');

export function findWorkspace(list: SavedWorkspace[], name: string): SavedWorkspace | undefined {
  const key = normalizeName(name).toLowerCase();
  return list.find((w) => w.name.toLowerCase() === key);
}

/** Snapshot of the current layout and sidebars. */
export function captureWorkspace(
  name: string,
  layout: Layout,
  left: SidebarSnapshot,
  right: SidebarSnapshot,
  now = Date.now(),
): SavedWorkspace {
  return {
    name: normalizeName(name),
    savedAt: now,
    // A plain copy: the saved layout must not share structure with live state.
    layout: JSON.parse(JSON.stringify(layout)) as Layout,
    left: { open: left.open, tab: left.tab, width: clampWidth(left.width) },
    right: { open: right.open, tab: right.tab, width: clampWidth(right.width) },
  };
}

/** Adds the workspace, or overwrites the one with the same name (case-insensitive) in place. */
export function upsertWorkspace(list: SavedWorkspace[], ws: SavedWorkspace): SavedWorkspace[] {
  const key = ws.name.toLowerCase();
  const at = list.findIndex((w) => w.name.toLowerCase() === key);
  if (at < 0) return [...list, ws];
  return list.map((w, i) => (i === at ? { ...ws, name: w.name } : w));
}

/** Renames; 'exists' when another workspace already has the name, 'missing' when from is unknown. */
export function renameWorkspace(
  list: SavedWorkspace[],
  from: string,
  to: string,
): SavedWorkspace[] | 'exists' | 'missing' {
  const target = findWorkspace(list, from);
  const name = normalizeName(to);
  if (!target) return 'missing';
  if (!name) return 'missing';
  const clash = findWorkspace(list, name);
  if (clash && clash !== target) return 'exists';
  return list.map((w) => (w === target ? { ...w, name } : w));
}

export function removeWorkspace(list: SavedWorkspace[], name: string): SavedWorkspace[] {
  const target = findWorkspace(list, name);
  return target ? list.filter((w) => w !== target) : list;
}

/** The layout without the tabs whose file no longer exists. */
export function pruneMissing(layout: Layout, exists: ReadonlySet<string>): Layout {
  let next = layout;
  for (const p of allPanes(layout.root))
    for (const tab of p.tabs) if (!exists.has(tab.path)) next = removePath(next, tab.path);
  return next;
}
