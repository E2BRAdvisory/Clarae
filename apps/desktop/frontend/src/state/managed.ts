// The configuration distributed by the cloud (§2.6.6) as the UI uses it: which keys an
// administrator manages, which are locked, which features are on. Resolution order, last wins:
//   product defaults -> managed defaults -> the user's own settings -> locked keys (forced).
import { create } from 'zustand';
import { api, type ConfigState } from '../app/api';
import type { AppearanceSettings, EditorSettings } from './settings';

export interface Managed {
  /** A configuration from a server applies. */
  managed: boolean;
  version: number;
  config: Record<string, unknown>;
  /** Dotted keys the user cannot override ("editor.fontSize"; "editor" locks the whole section). */
  locked: string[];
  features: Record<string, boolean>;
}

export const unmanaged: Managed = {
  managed: false,
  version: 0,
  config: {},
  locked: [],
  features: {},
};

export function fromState(s: ConfigState): Managed {
  return {
    managed: s.managed,
    version: s.version,
    config: s.config ?? {},
    locked: s.lockedKeys ?? [],
    features: s.features ?? {},
  };
}

/** True when a key, or a section containing it, is locked. */
export function isLocked(locked: readonly string[], key: string): boolean {
  return locked.some((l) => l === key || key.startsWith(l + '.'));
}

function section(cfg: Record<string, unknown>, name: string): Record<string, unknown> {
  const v = cfg[name];
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

// Config key -> editor setting (the schema names differ in two places).
const EDITOR_KEYS: Record<string, keyof EditorSettings> = {
  fontSize: 'fontSize',
  lineWrap: 'wrap',
  readableWidth: 'readableWidth',
  spellcheck: 'spellcheck',
  newNoteFolder: 'newNoteFolder',
  attachmentsFolder: 'attachmentsFolder',
  linkFormat: 'linkFormat',
  smartPaste: 'smartPaste',
  newNoteLocation: 'newNoteLocation',
  attachmentLocation: 'attachmentLocation',
  confirmDelete: 'confirmDelete',
  queryIncludeHost: 'queryIncludeHost',
};

/** The editor settings the configuration sets, by their name in the app. */
export function managedEditor(cfg: Record<string, unknown>): Partial<EditorSettings> {
  const src = section(cfg, 'editor');
  const out: Record<string, unknown> = {};
  for (const [k, field] of Object.entries(EDITOR_KEYS)) if (k in src) out[field] = src[k];
  return out;
}

/** The appearance settings the configuration sets (zoom is a factor in the schema, a percent in the app). */
export function managedAppearance(cfg: Record<string, unknown>): Partial<AppearanceSettings> {
  const src = section(cfg, 'appearance');
  const out: Partial<AppearanceSettings> = {};
  if (typeof src['accent'] === 'string') out.accent = src['accent'];
  if (typeof src['zoom'] === 'number') out.zoom = Math.round(src['zoom'] * 100);
  return out;
}

/** The app-level theme the configuration sets, if any. */
export function managedTheme(cfg: Record<string, unknown>): string | undefined {
  const t = section(cfg, 'appearance')['theme'];
  return typeof t === 'string' ? t : undefined;
}

/** Default hotkeys of the configuration: command id -> combos. */
export function managedHotkeys(cfg: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, combo] of Object.entries(section(cfg, 'hotkeys')))
    if (typeof combo === 'string') out[id] = [combo];
  return out;
}

/** Which app fields of a settings object are locked. */
export function lockedFields<T extends string>(
  locked: readonly string[],
  sectionName: 'editor' | 'appearance',
  fields: Record<string, T>,
): Set<T> {
  const out = new Set<T>();
  for (const [k, field] of Object.entries(fields))
    if (isLocked(locked, `${sectionName}.${k}`)) out.add(field);
  return out;
}

export const editorKeyOf = (field: keyof EditorSettings): string | undefined =>
  Object.entries(EDITOR_KEYS).find(([, f]) => f === field)?.[0];

interface ManagedStore extends Managed {
  set: (m: Managed) => void;
  load: () => Promise<void>;
}

export const useManaged = create<ManagedStore>((set, get) => ({
  ...unmanaged,
  set: (m) => set(m),
  async load() {
    try {
      const loaded = fromState(await api.config.effective());
      // A newer configuration may have been pushed while this was loading.
      if (loaded.version >= get().version) set(loaded);
    } catch {
      /* unmanaged until the first fetch */
    }
  },
}));

/** Whether a feature is available (a flag missing from the configuration is on). */
export function featureOn(features: Record<string, boolean>, name: string): boolean {
  return features[name] ?? true;
}
