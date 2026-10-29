// Graph view settings, stored per vault in .memobrain/graph.json. Like the other settings files,
// unknown keys and values of the wrong type are ignored so a hand-edited file cannot break the view.
import { create } from 'zustand';
import { api } from '../app/api';
import { infoOf, useSync } from '../state/sync';
import { defaultForces, forceRanges, type Forces, type GraphDirection } from './types';

export interface ColorGroup {
  /** Search query (§2.4) selecting the notes of the group. */
  query: string;
  /** #rrggbb */
  color: string;
}

export interface GraphSettings {
  query: string;
  tags: string[];
  folders: string[];
  showOrphans: boolean;
  showGhosts: boolean;
  showAttachments: boolean;
  showTags: boolean;
  forces: Forces;
  /** Multiplier of node radius, 0.5..3. */
  nodeSize: number;
  /** Labels appear from this zoom level on, 0.2..4. */
  labelZoom: number;
  groups: ColorGroup[];
  localDepth: number;
  localDirection: GraphDirection;
  /** Duration of the timelapse, in seconds. */
  timelapseSeconds: number;
}

export const defaultGraphSettings: GraphSettings = {
  query: '',
  tags: [],
  folders: [],
  showOrphans: true,
  showGhosts: false,
  showAttachments: false,
  showTags: false,
  forces: defaultForces,
  nodeSize: 1,
  labelZoom: 1.2,
  groups: [],
  localDepth: 1,
  localDirection: 'both',
  timelapseSeconds: 10,
};

/** Colours offered to new groups, cycled (readable on both built-in themes). */
export const GROUP_COLORS = ['#e5484d', '#f5a524', '#30a46c', '#0091ff', '#8e4ec6', '#12a594'];

const HEX = /^#[0-9a-fA-F]{6}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const clamp = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

export function mergeGraphSettings(raw: unknown): GraphSettings {
  const d = defaultGraphSettings;
  if (!isRecord(raw)) return { ...d, forces: { ...d.forces }, groups: [] };
  const f = isRecord(raw['forces']) ? raw['forces'] : {};
  const forces = { ...d.forces };
  for (const k of Object.keys(forces) as (keyof Forces)[]) {
    const r = forceRanges[k];
    forces[k] = clamp(f[k], r.min, r.max, d.forces[k]);
  }
  const groups: ColorGroup[] = [];
  if (Array.isArray(raw['groups'])) {
    for (const g of raw['groups']) {
      if (!isRecord(g) || typeof g['query'] !== 'string') continue;
      const color = typeof g['color'] === 'string' && HEX.test(g['color']) ? g['color'] : '';
      groups.push({
        query: g['query'],
        color: color || (GROUP_COLORS[groups.length % 6] as string),
      });
    }
  }
  const dir = raw['localDirection'];
  return {
    query: typeof raw['query'] === 'string' ? raw['query'] : d.query,
    tags: strings(raw['tags']),
    folders: strings(raw['folders']),
    showOrphans: bool(raw['showOrphans'], d.showOrphans),
    showGhosts: bool(raw['showGhosts'], d.showGhosts),
    showAttachments: bool(raw['showAttachments'], d.showAttachments),
    showTags: bool(raw['showTags'], d.showTags),
    forces,
    nodeSize: clamp(raw['nodeSize'], 0.5, 3, d.nodeSize),
    labelZoom: clamp(raw['labelZoom'], 0.2, 4, d.labelZoom),
    groups,
    localDepth: Math.round(clamp(raw['localDepth'], 1, 5, d.localDepth)),
    localDirection: dir === 'in' || dir === 'out' || dir === 'both' ? dir : d.localDirection,
    timelapseSeconds: clamp(raw['timelapseSeconds'], 2, 120, d.timelapseSeconds),
  };
}

export function parseGraphSettings(text: string): GraphSettings {
  if (!text.trim()) return mergeGraphSettings(null);
  try {
    return mergeGraphSettings(JSON.parse(text));
  } catch {
    return mergeGraphSettings(null);
  }
}

interface State {
  vaultId: string | null;
  settings: GraphSettings;
  loaded: boolean;
  load: (vaultId: string) => Promise<void>;
  update: (patch: Partial<GraphSettings>) => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useGraphSettings = create<State>((set, get) => ({
  vaultId: null,
  settings: mergeGraphSettings(null),
  loaded: false,
  async load(vaultId) {
    if (get().vaultId === vaultId && get().loaded) return;
    set({ vaultId, loaded: false });
    let text = '';
    try {
      text = await api.vault.readConfig(vaultId, 'graph.json');
    } catch {
      // missing or unreadable: defaults
    }
    if (get().vaultId === vaultId) set({ settings: parseGraphSettings(text), loaded: true });
  },
  update(patch) {
    const { vaultId, settings } = get();
    const next = { ...settings, ...patch };
    set({ settings: next });
    if (!vaultId || infoOf(useSync.getState(), vaultId).readOnly) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // A refused write (closed vault, read-only mount) leaves the settings in memory only.
      void Promise.resolve()
        .then(() => api.vault.writeConfig(vaultId, 'graph.json', JSON.stringify(next, null, 2)))
        .catch(() => undefined);
    }, 400);
  },
}));
