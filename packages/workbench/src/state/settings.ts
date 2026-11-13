// Vault and appearance settings. Editor/appearance/hotkeys are stored per
// vault in .clarae/*.json (§3.4.6: synced per user later); unknown keys and
// values of the wrong type are ignored so a hand-edited file cannot break the app.
import { create } from 'zustand';
import { api } from '../app/api';
import { registerNoteFlusher } from '../workspaces/flush';
import {
  editorKeyOf,
  isLocked,
  lockedFields,
  managedAppearance,
  managedEditor,
  managedHotkeys,
  unmanaged,
  useManaged,
  type Managed,
} from './managed';

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
  /** Page preview: popover with the target note when hovering a wikilink. */
  pagePreview: boolean;
  /** Show the preview on plain hover; otherwise it needs Cmd/Ctrl held. */
  pagePreviewAlways: boolean;
  /** 'folder' = newNoteFolder, 'current' = next to the active note. */
  newNoteLocation: 'folder' | 'current';
  /** 'folder' = attachmentsFolder, 'current' = next to the note, 'subfolder' = attachmentsFolder inside the note's folder. */
  attachmentLocation: 'folder' | 'current' | 'subfolder';
  /** Ask before moving a file to the trash. */
  confirmDelete: boolean;
  /** Embedded searches also list the note that contains them. */
  queryIncludeHost: boolean;
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
  pagePreview: true,
  pagePreviewAlways: false,
  newNoteLocation: 'folder',
  attachmentLocation: 'folder',
  confirmDelete: true,
  queryIncludeHost: false,
};

export interface AppearanceSettings {
  accent: string;
  fontFamily: string;
  zoom: number;
  interfaceFontSize: number;
  /** Compact bar under the editor area with the figures of the active editor (ADR-0035). */
  statusBar: boolean;
}

export const defaultAppearance: AppearanceSettings = {
  accent: '#6c5ce7',
  fontFamily: '',
  zoom: 100,
  interfaceFontSize: 14,
  statusBar: false,
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

/** The keys of raw that are known and of the right type: what the user set explicitly. */
export function pickKnown<T extends object>(raw: unknown, defaults: T): Partial<T> {
  const base = defaults as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k in base && typeof v === typeof base[k]) out[k] = v;
    }
  }
  return out as Partial<T>;
}

function parseUser<T extends object>(text: string, defaults: T): Partial<T> {
  if (!text.trim()) return {};
  try {
    return pickKnown(JSON.parse(text), defaults);
  } catch {
    return {};
  }
}

/** The user's own choices, as stored in the vault: only the keys they set. */
interface UserSettings {
  editor: Partial<EditorSettings>;
  appearance: Partial<AppearanceSettings>;
  hotkeys: HotkeyOverrides;
}

const emptyUser = (): UserSettings => ({ editor: {}, appearance: {}, hotkeys: {} });

/**
 * Settings in force: product defaults, then the defaults of the administrator's configuration,
 * then what the user chose, then the keys the administrator locked (§2.6.6).
 */
export function resolveSettings(user: UserSettings, managed: Managed) {
  const me = managedEditor(managed.config);
  const ma = managedAppearance(managed.config);
  const editor: Record<string, unknown> = { ...defaultEditorSettings, ...me, ...user.editor };
  for (const field of lockedFields(managed.locked, 'editor', editorFieldsOf())) {
    if (field in me) editor[field] = (me as Record<string, unknown>)[field];
  }
  const appearance: Record<string, unknown> = { ...defaultAppearance, ...ma, ...user.appearance };
  for (const field of lockedFields(managed.locked, 'appearance', {
    accent: 'accent',
    zoom: 'zoom',
    statusBar: 'statusBar',
  })) {
    if (field in ma) appearance[field] = (ma as Record<string, unknown>)[field];
  }
  const mh = managedHotkeys(managed.config);
  const hotkeys: HotkeyOverrides = { ...mh, ...user.hotkeys };
  for (const id of Object.keys(mh))
    if (isLocked(managed.locked, `hotkeys.${id}`)) hotkeys[id] = mh[id] ?? [];
  return {
    editor: editor as unknown as EditorSettings,
    appearance: appearance as unknown as AppearanceSettings,
    hotkeys,
  };
}

function editorFieldsOf(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of Object.keys(defaultEditorSettings)) {
    const key = editorKeyOf(field as keyof EditorSettings);
    if (key) out[key] = field;
  }
  return out;
}

interface SettingsState {
  /** Settings in force (managed defaults and locks applied). */
  editor: EditorSettings;
  appearance: AppearanceSettings;
  hotkeys: HotkeyOverrides;
  user: UserSettings;
  vaultId: string | null;
  load: (vaultId: string) => Promise<void>;
  reset: () => void;
  setEditor: (patch: Partial<EditorSettings>) => void;
  setAppearance: (patch: Partial<AppearanceSettings>) => void;
  setHotkeys: (next: HotkeyOverrides) => void;
}

interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
  write: () => Promise<void>;
}

/** Settings files waiting for their write, by vault and file. */
const pendingWrites = new Map<string, PendingWrite>();

function persist(name: string, vaultId: string | null, value: unknown): void {
  if (!vaultId) return;
  const key = `${vaultId}\u0000${name}`;
  clearTimeout(pendingWrites.get(key)?.timer);
  const entry: PendingWrite = {
    timer: setTimeout(() => void entry.write(), 400),
    write: async () => {
      clearTimeout(entry.timer);
      if (pendingWrites.get(key) !== entry) return; // written already, or replaced by a newer value
      pendingWrites.delete(key);
      try {
        await api.vault.writeConfig(vaultId, name, JSON.stringify(value, null, 2));
      } catch {
        // A read-only vault, or one closed meanwhile: the settings stay in force for the session.
      }
    },
  };
  pendingWrites.set(key, entry);
}

/**
 * Writes the settings changes still waiting for their delay, now: before the vault is closed or
 * switched and before the app quits (registered with the flushers of the open documents).
 */
export async function flushSettings(): Promise<void> {
  await Promise.all([...pendingWrites.values()].map((w) => w.write()));
}

registerNoteFlusher(flushSettings);

/** Bumped by every load and reset: a load that another one (or a reset) overtook is dropped. */
let loadSeq = 0;

const managedNow = (): Managed => {
  const m = useManaged.getState();
  return {
    managed: m.managed,
    version: m.version,
    config: m.config,
    locked: m.locked,
    features: m.features,
  };
};

export const useSettings = create<SettingsState>((set, get) => ({
  ...resolveSettings(emptyUser(), unmanaged),
  user: emptyUser(),
  vaultId: null,
  async load(vaultId) {
    const seq = ++loadSeq;
    const [e, a, h] = await Promise.all([
      api.vault.readConfig(vaultId, 'editor.json'),
      api.vault.readConfig(vaultId, 'appearance.json'),
      api.vault.readConfig(vaultId, 'hotkeys.json'),
    ]);
    if (seq !== loadSeq) return; // another vault was opened (or this one closed) meanwhile
    const user: UserSettings = {
      editor: parseUser(e, defaultEditorSettings),
      appearance: parseUser(a, defaultAppearance),
      hotkeys: parseHotkeys(h),
    };
    set({ vaultId, user, ...resolveSettings(user, managedNow()) });
  },
  reset: () => {
    loadSeq++;
    void flushSettings(); // changes still waiting belong to the vault being left
    set({ vaultId: null, user: emptyUser(), ...resolveSettings(emptyUser(), managedNow()) });
  },
  setEditor(patch) {
    const user = { ...get().user, editor: { ...get().user.editor, ...patch } };
    set({ user, ...resolveSettings(user, managedNow()) });
    persist('editor.json', get().vaultId, user.editor);
  },
  setAppearance(patch) {
    const user = { ...get().user, appearance: { ...get().user.appearance, ...patch } };
    set({ user, ...resolveSettings(user, managedNow()) });
    persist('appearance.json', get().vaultId, user.appearance);
  },
  setHotkeys(next) {
    const user = { ...get().user, hotkeys: next };
    set({ user, ...resolveSettings(user, managedNow()) });
    persist('hotkeys.json', get().vaultId, next);
  },
}));

// A new configuration from the administrator re-resolves the settings in force.
useManaged.subscribe((m) => {
  const { user } = useSettings.getState();
  useSettings.setState(
    resolveSettings(user, {
      managed: m.managed,
      version: m.version,
      config: m.config,
      locked: m.locked,
      features: m.features,
    }),
  );
});

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
