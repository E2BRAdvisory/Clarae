// Per-vault drawing settings (.clarae/drawing.json, synced with the vault like the other
// settings files). Unknown keys and values of the wrong type are ignored so a hand-edited file
// cannot break the app.
import { create } from 'zustand';
import { api } from '../app/api';
import { attachmentDir } from '../settings/locations';
import { pickKnown, type EditorSettings } from '../state/settings';
import { useAppStore } from '../state/store';

export type DrawingOpenMode = 'edit' | 'view' | 'zen';
export type DrawingLocation = 'current' | 'folder' | 'attachments';

export interface DrawingSettings {
  /** How a drawing opens: editable, read-only, or zen (editable without the UI chrome). */
  defaultMode: DrawingOpenMode;
  /** Where "New drawing" creates the file. */
  creationLocation: DrawingLocation;
  /** Used when creationLocation is 'folder'. */
  creationFolder: string;
  /** File name template; tokens {YYYY} {MM} {DD} {HH} {mm}. */
  nameFormat: string;
  /** Width in px written into the embed of a new drawing (0 = no width). */
  embedWidth: number;
  /** Export dialog defaults. */
  exportScale: number;
  exportPadding: number;
  exportEmbedScene: boolean;
  /** Files written next to a drawing on every save ("Board.excalidraw.png"). */
  autoExport: 'none' | 'png' | 'svg' | 'both';
  autoExportTheme: 'light' | 'dark' | 'both';
  /** Style of new elements: '' / 0 = Excalidraw's own default. */
  defaultStroke: string;
  defaultFill: string;
  /** Excalidraw font family id (1 Virgil, 2 Helvetica, 3 Cascadia, 5 Excalifont, ...). */
  defaultFont: number;
  defaultFontSize: number;
  /** Ids of the actions starred in the tools panel ("laser-pointer", "auto-layout", ...). */
  toolFavorites: string[];
}

export const defaultDrawingSettings: DrawingSettings = {
  defaultMode: 'edit',
  creationLocation: 'current',
  creationFolder: '',
  nameFormat: 'Drawing {YYYY}-{MM}-{DD} {HH}.{mm}',
  embedWidth: 0,
  exportScale: 2,
  exportPadding: 10,
  exportEmbedScene: false,
  autoExport: 'none',
  autoExportTheme: 'light',
  defaultStroke: '',
  defaultFill: '',
  defaultFont: 0,
  defaultFontSize: 0,
  toolFavorites: [],
};

const FILE = 'drawing.json';
const MODES: readonly string[] = ['edit', 'view', 'zen'];
const LOCATIONS: readonly string[] = ['current', 'folder', 'attachments'];
const HEX = /^#[0-9a-f]{6}$/i;
const FONT_IDS: readonly number[] = [0, 1, 2, 3, 5, 6, 7, 8, 9];
const AUTO_EXPORTS: readonly string[] = ['none', 'png', 'svg', 'both'];
const AUTO_THEMES: readonly string[] = ['light', 'dark', 'both'];

/** Merges parsed JSON into the defaults, validating enums and ranges. */
export function parseDrawingSettings(text: string): DrawingSettings {
  let raw: unknown = {};
  try {
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    /* defaults */
  }
  const s = { ...defaultDrawingSettings, ...pickKnown(raw, defaultDrawingSettings) };
  if (!MODES.includes(s.defaultMode)) s.defaultMode = defaultDrawingSettings.defaultMode;
  if (!LOCATIONS.includes(s.creationLocation))
    s.creationLocation = defaultDrawingSettings.creationLocation;
  if (!Number.isFinite(s.embedWidth) || s.embedWidth < 0) s.embedWidth = 0;
  s.embedWidth = Math.min(4000, Math.round(s.embedWidth));
  if (!s.nameFormat.trim()) s.nameFormat = defaultDrawingSettings.nameFormat;
  s.exportScale = [1, 2, 3].includes(s.exportScale)
    ? s.exportScale
    : defaultDrawingSettings.exportScale;
  s.exportPadding = Number.isFinite(s.exportPadding)
    ? Math.min(200, Math.max(0, Math.round(s.exportPadding)))
    : defaultDrawingSettings.exportPadding;
  if (!AUTO_EXPORTS.includes(s.autoExport)) s.autoExport = defaultDrawingSettings.autoExport;
  if (s.defaultStroke && !HEX.test(s.defaultStroke)) s.defaultStroke = '';
  if (s.defaultFill && s.defaultFill !== 'transparent' && !HEX.test(s.defaultFill))
    s.defaultFill = '';
  if (!FONT_IDS.includes(s.defaultFont)) s.defaultFont = 0;
  s.defaultFontSize =
    Number.isFinite(s.defaultFontSize) && s.defaultFontSize >= 8 && s.defaultFontSize <= 120
      ? Math.round(s.defaultFontSize)
      : 0;
  s.toolFavorites = Array.isArray(s.toolFavorites)
    ? [...new Set(s.toolFavorites.filter((id) => typeof id === 'string' && id.length <= 64))].slice(
        0,
        100,
      )
    : [];
  if (!AUTO_THEMES.includes(s.autoExportTheme))
    s.autoExportTheme = defaultDrawingSettings.autoExportTheme;
  return s;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Base name (no extension) of a new drawing; characters file systems dislike are dropped. */
export function drawingName(s: Pick<DrawingSettings, 'nameFormat'>, now: Date): string {
  const tokens: Record<string, string> = {
    YYYY: String(now.getFullYear()),
    MM: pad(now.getMonth() + 1),
    DD: pad(now.getDate()),
    HH: pad(now.getHours()),
    mm: pad(now.getMinutes()),
  };
  const name = s.nameFormat.replace(/\{(YYYY|MM|DD|HH|mm)\}/g, (_, k: string) => tokens[k] ?? '');
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Drawing';
}

/** Folder for a new drawing created from the note at activePath ('' = vault root). */
export function drawingDir(
  s: Pick<DrawingSettings, 'creationLocation' | 'creationFolder'>,
  editor: Pick<EditorSettings, 'attachmentLocation' | 'attachmentsFolder'>,
  activePath: string | null,
): string {
  switch (s.creationLocation) {
    case 'folder':
      return s.creationFolder.replace(/^\/+|\/+$/g, '');
    case 'attachments':
      return attachmentDir(editor, activePath ?? '');
    default:
      return activePath && activePath.includes('/')
        ? activePath.slice(0, activePath.lastIndexOf('/'))
        : '';
  }
}

interface State {
  settings: DrawingSettings;
  vaultId: string | null;
  load: (vaultId: string) => Promise<void>;
  reset: () => void;
  set: (patch: Partial<DrawingSettings>) => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useDrawingSettings = create<State>((set, get) => ({
  settings: { ...defaultDrawingSettings },
  vaultId: null,
  async load(vaultId) {
    let text = '';
    try {
      text = await api.vault.readConfig(vaultId, FILE);
    } catch {
      /* defaults */
    }
    set({ vaultId, settings: parseDrawingSettings(text) });
  },
  reset: () => set({ vaultId: null, settings: { ...defaultDrawingSettings } }),
  set(patch) {
    const settings = parseDrawingSettings(JSON.stringify({ ...get().settings, ...patch }));
    set({ settings });
    const id = get().vaultId;
    if (!id) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void api.vault
        .writeConfig(id, FILE, JSON.stringify(settings, null, 2))
        .catch(() => undefined);
    }, 400);
  },
}));

// Follow the open vault.
useAppStore.subscribe((s, prev) => {
  if (s.vault?.id === prev.vault?.id) return;
  if (s.vault) void useDrawingSettings.getState().load(s.vault.id);
  else useDrawingSettings.getState().reset();
});
const alreadyOpen = useAppStore.getState().vault;
if (alreadyOpen) void useDrawingSettings.getState().load(alreadyOpen.id);

/** The editor state that makes new elements use the vault's default style. */
export function defaultItemState(
  s: Pick<DrawingSettings, 'defaultStroke' | 'defaultFill' | 'defaultFont' | 'defaultFontSize'>,
): Record<string, unknown> {
  return {
    ...(s.defaultStroke ? { currentItemStrokeColor: s.defaultStroke } : {}),
    ...(s.defaultFill ? { currentItemBackgroundColor: s.defaultFill } : {}),
    ...(s.defaultFont ? { currentItemFontFamily: s.defaultFont } : {}),
    ...(s.defaultFontSize ? { currentItemFontSize: s.defaultFontSize } : {}),
  };
}
