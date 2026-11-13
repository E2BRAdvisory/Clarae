// Settings of daily notes, unique notes, templates, slash commands and the composer.
// Stored per vault in .clarae/daily.json (only the keys the user set); the administrator's
// configuration provides defaults for `daily_notes.{folder,format,template}` and may lock them
// (§2.6.6), exactly like the editor settings: product defaults -> managed -> user -> locked.
import { create } from 'zustand';
import { api } from '../app/api';
import { isLocked, useManaged, type Managed } from '../state/managed';
import { pickKnown } from '../state/settings';
import { useAppStore } from '../state/store';

export type MergeSeparator = 'heading' | 'rule' | 'none';

export interface NotesSettings {
  /** Folder of the templates in the vault. */
  templatesFolder: string;
  dailyFolder: string;
  /** Moment-style format of the daily note name (may contain '/' for sub-folders). */
  dailyFormat: string;
  /** Template reference ("path" or "library:path"); "" = empty note. */
  dailyTemplate: string;
  uniqueFolder: string;
  uniqueFormat: string;
  uniqueTemplate: string;
  /** Template applied to every new note (New note, links to missing notes); "" = empty note. */
  newNoteTemplate: string;
  /** The "/" menu in the editor. */
  slashCommands: boolean;
  /** Extract selection: replace it with an embed instead of a link. */
  extractEmbed: boolean;
  /** Extract selection: copy the properties of the source note. */
  extractFrontmatter: boolean;
  mergeSeparator: MergeSeparator;
}

export const defaultNotesSettings: NotesSettings = {
  templatesFolder: 'Templates',
  dailyFolder: '',
  dailyFormat: 'YYYY-MM-DD',
  dailyTemplate: '',
  uniqueFolder: '',
  uniqueFormat: 'YYYYMMDDHHmm',
  uniqueTemplate: '',
  newNoteTemplate: '',
  slashCommands: true,
  extractEmbed: false,
  extractFrontmatter: false,
  mergeSeparator: 'heading',
};

/** Config key (under `daily_notes`) -> setting. */
const DAILY_KEYS = {
  folder: 'dailyFolder',
  format: 'dailyFormat',
  template: 'dailyTemplate',
} as const satisfies Record<string, keyof NotesSettings>;

/** The dotted configuration key of a setting, when the administrator can manage it. */
export function notesCfgKey(field: keyof NotesSettings): string | undefined {
  const hit = Object.entries(DAILY_KEYS).find(([, f]) => f === field);
  return hit ? `daily_notes.${hit[0]}` : undefined;
}

function managedDaily(cfg: Record<string, unknown>): Partial<NotesSettings> {
  const src = cfg['daily_notes'];
  const out: Record<string, unknown> = {};
  if (typeof src === 'object' && src !== null && !Array.isArray(src)) {
    for (const [k, field] of Object.entries(DAILY_KEYS)) {
      const v = (src as Record<string, unknown>)[k];
      if (typeof v === 'string') out[field] = v;
    }
  }
  return out;
}

/** Settings in force: defaults, then the managed ones, then the user's, then the locked keys. */
export function resolveNotesSettings(
  user: Partial<NotesSettings>,
  managed: Managed,
): NotesSettings {
  const md = managedDaily(managed.config);
  const out: Record<string, unknown> = { ...defaultNotesSettings, ...md, ...user };
  for (const [k, field] of Object.entries(DAILY_KEYS))
    if (isLocked(managed.locked, `daily_notes.${k}`) && field in md)
      out[field] = (md as Record<string, unknown>)[field];
  return out as unknown as NotesSettings;
}

interface State {
  /** Settings in force. */
  settings: NotesSettings;
  user: Partial<NotesSettings>;
  vaultId: string | null;
  load: (vaultId: string) => Promise<void>;
  /** Resolves once the settings of vaultId are loaded (loading them when needed). */
  ready: (vaultId: string) => Promise<NotesSettings>;
  reset: () => void;
  set: (patch: Partial<NotesSettings>) => void;
}

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

let timer: ReturnType<typeof setTimeout> | undefined;
let loading: { id: string; promise: Promise<void> } | null = null;

export const useNotesSettings = create<State>((set, get) => ({
  settings: resolveNotesSettings({}, managedNow()),
  user: {},
  vaultId: null,
  async load(vaultId) {
    let text = '';
    try {
      text = await api.templates.readSettings(vaultId);
    } catch {
      /* defaults */
    }
    let user: Partial<NotesSettings> = {};
    try {
      if (text.trim()) user = pickKnown(JSON.parse(text), defaultNotesSettings);
    } catch {
      /* a hand-edited file must not break the app */
    }
    set({ vaultId, user, settings: resolveNotesSettings(user, managedNow()) });
  },
  async ready(vaultId) {
    if (get().vaultId !== vaultId) {
      if (loading?.id !== vaultId) {
        const promise = get()
          .load(vaultId)
          .finally(() => {
            if (loading?.id === vaultId) loading = null;
          });
        loading = { id: vaultId, promise };
      }
      await loading?.promise;
    }
    return get().settings;
  },
  reset: () => set({ vaultId: null, user: {}, settings: resolveNotesSettings({}, managedNow()) }),
  set(patch) {
    const user = { ...get().user, ...patch };
    set({ user, settings: resolveNotesSettings(user, managedNow()) });
    const id = get().vaultId;
    if (!id) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void api.templates.writeSettings(id, JSON.stringify(user, null, 2)).catch(() => undefined);
    }, 400);
  },
}));

// A new configuration from the administrator re-resolves the settings in force.
useManaged.subscribe(() => {
  const { user } = useNotesSettings.getState();
  useNotesSettings.setState({ settings: resolveNotesSettings(user, managedNow()) });
});

// Follow the open vault.
useAppStore.subscribe((s, prev) => {
  if (s.vault?.id === prev.vault?.id) return;
  if (s.vault) void useNotesSettings.getState().load(s.vault.id);
  else useNotesSettings.getState().reset();
});
const alreadyOpen = useAppStore.getState().vault;
if (alreadyOpen) void useNotesSettings.getState().load(alreadyOpen.id);
