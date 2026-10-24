// Vault and appearance settings. Editor/appearance/hotkeys are stored per
// vault in .nodus/*.json (§3.4.6: synced per user later); unknown keys and
// values of the wrong type are ignored so a hand-edited file cannot break the app.
import { create } from 'zustand';
import { api } from '../app/api';

export type NoteMode = 'live' | 'source' | 'reading';
export type LinkFormat = 'shortest' | 'path' | 'relative';

export interface EditorSettings {
  defaultMode: NoteMode;
  lineNumbers: boolean;
  wrap: boolean;
  readableWidth: boolean;
  spellcheck: boolean;
  fontSize: number;
  tabSize: number;
  autoPair: boolean;
  smartPaste: boolean;
  foldHeadings: boolean;
  linkFormat: LinkFormat;
  attachmentsFolder: string;
  newNoteFolder: string;
}

export const defaultEditorSettings: EditorSettings = {
  defaultMode: 'live',
  lineNumbers: false,
  wrap: true,
  readableWidth: true,
  spellcheck: true,
  fontSize: 15,
  tabSize: 4,
  autoPair: true,
  smartPaste: true,
  foldHeadings: true,
  linkFormat: 'shortest',
  attachmentsFolder: '',
  newNoteFolder: '',
};

export interface AppearanceSettings {
  accent: string;
  fontFamily: string;
  zoom: number;
  interfaceFontSize: number;
}

export const defaultAppearance: AppearanceSettings = {
  accent: '#6c5ce7',
  fontFamily: '',
  zoom: 100,
  interfaceFontSize: 14,
};

/** Hotkey overrides: command id -> combos ([] = unbound). */
export type HotkeyOverrides = Record<string, string[]>;

/** Merges parsed JSON into defaults, keeping only known keys of the right type. */
export function mergeSettings<T extends object>(raw: unknown, defaults: T): T {
  const base = defaults as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k in base && typeof v === typeof base[k]) out[k] = v;
    }
  }
  return out as T;
}

export function parseSettings<T extends object>(text: string, defaults: T): T {
  if (!text.trim()) return { ...defaults };
  try {
    return mergeSettings(JSON.parse(text), defaults);
  } catch {
    return { ...defaults };
  }
}

export function parseHotkeys(text: string): HotkeyOverrides {
  if (!text.trim()) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    const out: HotkeyOverrides = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[id] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

interface SettingsState {
  editor: EditorSettings;
  appearance: AppearanceSettings;
  hotkeys: HotkeyOverrides;
  vaultId: string | null;
  load: (vaultId: string) => Promise<void>;
  reset: () => void;
  setEditor: (patch: Partial<EditorSettings>) => void;
  setAppearance: (patch: Partial<AppearanceSettings>) => void;
  setHotkeys: (next: HotkeyOverrides) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function persist(name: string, vaultId: string | null, value: unknown): void {
  if (!vaultId) return;
  clearTimeout(timers.get(name));
  timers.set(
    name,
    setTimeout(() => {
      void api.vault
        .writeConfig(vaultId, name, JSON.stringify(value, null, 2))
        .catch(() => undefined);
    }, 400),
  );
}

export const useSettings = create<SettingsState>((set, get) => ({
  editor: { ...defaultEditorSettings },
  appearance: { ...defaultAppearance },
  hotkeys: {},
  vaultId: null,
  async load(vaultId) {
    const [e, a, h] = await Promise.all([
      api.vault.readConfig(vaultId, 'editor.json'),
      api.vault.readConfig(vaultId, 'appearance.json'),
      api.vault.readConfig(vaultId, 'hotkeys.json'),
    ]);
    set({
      vaultId,
      editor: parseSettings(e, defaultEditorSettings),
      appearance: parseSettings(a, defaultAppearance),
      hotkeys: parseHotkeys(h),
    });
  },
  reset: () =>
    set({
      vaultId: null,
      editor: { ...defaultEditorSettings },
      appearance: { ...defaultAppearance },
      hotkeys: {},
    }),
  setEditor(patch) {
    const editor = { ...get().editor, ...patch };
    set({ editor });
    persist('editor.json', get().vaultId, editor);
  },
  setAppearance(patch) {
    const appearance = { ...get().appearance, ...patch };
    set({ appearance });
    persist('appearance.json', get().vaultId, appearance);
  },
  setHotkeys(next) {
    set({ hotkeys: next });
    persist('hotkeys.json', get().vaultId, next);
  },
}));

/** Applies appearance settings to the document (CSS variables and zoom). */
export function applyAppearance(a: AppearanceSettings): void {
  const root = document.documentElement;
  root.style.setProperty(
    '--accent',
    /^#[0-9a-fA-F]{3,8}$/.test(a.accent) ? a.accent : defaultAppearance.accent,
  );
  if (a.fontFamily.trim())
    root.style.setProperty('--font-ui', `${a.fontFamily.replace(/[;{}]/g, '')}, sans-serif`);
  else root.style.removeProperty('--font-ui');
  root.style.setProperty('--font-size', `${Math.min(24, Math.max(10, a.interfaceFontSize))}px`);
  root.style.setProperty('zoom', String(Math.min(2, Math.max(0.5, a.zoom / 100))));
}
