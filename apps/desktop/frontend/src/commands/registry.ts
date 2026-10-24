// The command registry: every action the user can trigger by hotkey, from the
// command palette or from a menu. Titles live in the i18n files under
// "commands.<id>"; hotkeys are defaults that Settings > Hotkeys can override.
import { useSettings, type NoteMode } from '../state/settings';
import { activeTab, findPane } from '../workspace/layout';
import { createNote, deleteEntry, renameEntry } from '../app/actions';
import { api } from '../app/api';
import { getActiveEditor } from '../editor/registry';
import * as fmt from '../editor/commands';
import { dialog } from '../ui/dialogs';
import { newCanvas } from '../canvas/commands';
import { insertDrawing, newDrawing } from '../drawing/commands';
import { infoOf, useSync } from '../state/sync';
import { featureOn, useManaged } from '../state/managed';
import { useSharing } from '../state/sharing';
import { useAppStore } from '../state/store';
import { invalidateVault } from '../app/actions';
import i18next from 'i18next';
import { comboFromEvent, comboIndex, effectiveCombos, normalizeCombo } from './hotkeys';
import type { EditorView } from '@codemirror/view';

export type CommandGroup = 'file' | 'navigate' | 'view' | 'editor' | 'app';

export interface Command {
  id: string;
  group: CommandGroup;
  defaults: readonly string[];
  /** Hidden from the palette (still bindable). */
  hidden?: boolean;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

const store = () => useAppStore.getState();
const hasVault = (): boolean => store().vault !== null;
/** The open vault may not be changed (viewer on a share, or a share that ended). */
const readOnlyVault = (): boolean => {
  const v = store().vault;
  return v ? infoOf(useSync.getState(), v.id).readOnly : false;
};
const canWrite = (): boolean => hasVault() && !readOnlyVault();
const feature = (name: string): boolean => featureOn(useManaged.getState().features, name);
const activePath = (): string | null => activeTab(store().layout)?.path ?? null;
const hasNote = (): boolean => activePath() !== null;
const syncInfo = () => infoOf(useSync.getState(), store().vault?.id);
const isLinked = (): boolean => hasVault() && syncInfo().linked;
const editorMode = (): boolean => {
  const t = activeTab(store().layout);
  return !!t && t.mode !== 'reading' && getActiveEditor() !== null;
};

const t = (key: string): string => i18next.t(key);

function withEditor(fn: (v: EditorView) => boolean): () => void {
  return () => {
    const v = getActiveEditor();
    if (v) {
      fn(v);
      v.focus();
    }
  };
}

function setMode(mode: NoteMode): () => void {
  return () => {
    const tab = activeTab(store().layout);
    if (tab) store().setTabMode(tab.id, mode);
  };
}

async function guard(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    await dialog.error(e);
  }
}

async function renameActive(): Promise<void> {
  const path = activePath();
  if (!path) return;
  const name = path.split('/').pop() ?? path;
  const next = await dialog.prompt(t('sidebar.promptRename'), name);
  if (!next || next === name) return;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const to = dir + (path.endsWith('.md') && !next.endsWith('.md') ? next + '.md' : next);
  await guard(
    renameEntry(path, to, ({ notes, links }) =>
      dialog.confirm(t('sidebar.rename'), i18next.t('sidebar.confirmLinkUpdate', { links, notes })),
    ),
  );
}

async function deleteActive(): Promise<void> {
  const path = activePath();
  if (!path) return;
  if (!(await dialog.confirm(t('sidebar.trash'), path, true))) return;
  await guard(deleteEntry(path));
}

/** Writes the open vault to a ZIP file chosen in the native "save as" dialog. */
export async function exportVaultZip(): Promise<void> {
  const v = store().vault;
  if (!v) return;
  try {
    const res = await api.vault.exportZip(v.id);
    if (res.cancelled) return;
    await dialog.alert(
      t('export.doneTitle'),
      i18next.t('export.done', { count: res.files, path: res.path }),
    );
  } catch (e) {
    await dialog.error(e);
  }
}

function focusSearch(): void {
  store().search(store().searchQuery);
}

export const commands: Command[] = [
  // ---- file ----
  {
    id: 'note:new',
    group: 'file',
    defaults: ['Mod-n'],
    enabled: canWrite,
    run: () => guard(createNote()),
  },
  {
    id: 'note:new-tab',
    group: 'file',
    defaults: ['Mod-Alt-n'],
    enabled: canWrite,
    run: () => guard(createNote({ newTab: true })),
  },
  {
    id: 'drawing:new',
    group: 'file',
    defaults: [],
    enabled: () => canWrite() && feature('drawings'),
    run: () => guard(newDrawing()),
  },
  {
    id: 'canvas:new',
    group: 'file',
    defaults: [],
    enabled: () => canWrite() && feature('canvas'),
    run: () => guard(newCanvas()),
  },
  {
    id: 'drawing:insert',
    group: 'editor',
    defaults: [],
    enabled: () => editorMode() && !readOnlyVault() && feature('drawings'),
    run: () => guard(insertDrawing()),
  },
  {
    id: 'note:rename',
    group: 'file',
    defaults: ['F2'],
    enabled: () => hasNote() && !readOnlyVault(),
    run: renameActive,
  },
  {
    id: 'note:delete',
    group: 'file',
    defaults: [],
    enabled: () => hasNote() && !readOnlyVault(),
    run: deleteActive,
  },
  {
    id: 'sharing:open',
    group: 'app',
    defaults: [],
    enabled: () => feature('sharing'),
    run: () => store().openSettings('sharing'),
  },
  {
    id: 'sharing:share',
    group: 'file',
    defaults: [],
    enabled: () => {
      const v = store().vault;
      if (!v || !hasNote() || !feature('sharing')) return false;
      const info = infoOf(useSync.getState(), v.id);
      return info.linked && info.kind === 'shared' && !info.mount;
    },
    run: () => {
      const path = activePath();
      if (path) useSharing.getState().openShare({ path, isDir: false });
    },
  },
  {
    id: 'vault:export-zip',
    group: 'file',
    defaults: [],
    enabled: hasVault,
    run: exportVaultZip,
  },
  {
    id: 'vault:close',
    group: 'file',
    defaults: [],
    enabled: hasVault,
    run: async () => {
      const v = store().vault;
      if (!v) return;
      await api.vault.close(v.id);
      store().setVault(null);
    },
  },
  {
    id: 'index:rebuild',
    group: 'app',
    defaults: [],
    enabled: hasVault,
    run: async () => {
      const v = store().vault;
      if (!v) return;
      await guard(api.vault.rebuildIndex(v.id));
      invalidateVault(v.id);
    },
  },

  // ---- navigate ----
  {
    id: 'switcher:open',
    group: 'navigate',
    defaults: ['Mod-o'],
    enabled: hasVault,
    run: () => store().setSwitcherOpen(true),
  },
  {
    id: 'palette:open',
    group: 'navigate',
    defaults: ['Mod-p', 'Mod-Shift-p'],
    run: () => store().setPaletteOpen(true),
  },
  {
    id: 'search:vault',
    group: 'navigate',
    defaults: ['Mod-Shift-f'],
    enabled: hasVault,
    run: focusSearch,
  },
  {
    id: 'tab:next',
    group: 'navigate',
    defaults: ['Mod-Alt-ArrowRight'],
    enabled: hasNote,
    run: () => store().cycleTabs(1),
  },
  {
    id: 'tab:prev',
    group: 'navigate',
    defaults: ['Mod-Alt-ArrowLeft'],
    enabled: hasNote,
    run: () => store().cycleTabs(-1),
  },
  {
    id: 'tab:close',
    group: 'navigate',
    defaults: ['Mod-w'],
    enabled: hasNote,
    run: () => {
      const tab = activeTab(store().layout);
      if (tab) store().closeTabById(tab.id);
    },
  },
  {
    id: 'pane:close',
    group: 'navigate',
    defaults: ['Mod-Shift-w'],
    enabled: hasVault,
    run: () => store().closeActivePane(),
  },

  // ---- view ----
  {
    id: 'mode:toggle-reading',
    group: 'view',
    defaults: ['Mod-e'],
    enabled: hasNote,
    run: () => {
      const tab = activeTab(store().layout);
      if (!tab) return;
      const def = useSettings.getState().editor.defaultMode;
      store().setTabMode(
        tab.id,
        tab.mode === 'reading' ? (def === 'reading' ? 'live' : def) : 'reading',
      );
    },
  },
  {
    id: 'mode:toggle-source',
    group: 'view',
    defaults: ['Mod-Shift-e'],
    enabled: hasNote,
    run: () => {
      const tab = activeTab(store().layout);
      if (tab) store().setTabMode(tab.id, tab.mode === 'source' ? 'live' : 'source');
    },
  },
  { id: 'mode:live', group: 'view', defaults: [], enabled: hasNote, run: setMode('live') },
  { id: 'mode:source', group: 'view', defaults: [], enabled: hasNote, run: setMode('source') },
  { id: 'mode:reading', group: 'view', defaults: [], enabled: hasNote, run: setMode('reading') },
  {
    id: 'pane:split-right',
    group: 'view',
    defaults: ['Mod-\\'],
    enabled: hasNote,
    run: () => store().split('row'),
  },
  {
    id: 'pane:split-down',
    group: 'view',
    defaults: ['Mod-Shift-\\'],
    enabled: hasNote,
    run: () => store().split('column'),
  },
  {
    id: 'pane:link',
    group: 'view',
    defaults: [],
    enabled: hasNote,
    run: () => store().toggleLinkedPane(store().layout.activePane),
  },
  {
    id: 'sidebar:left',
    group: 'view',
    defaults: ['Mod-Shift-l'],
    run: () => store().setLeft({ open: !store().left.open }),
  },
  {
    id: 'sidebar:right',
    group: 'view',
    defaults: ['Mod-Shift-r'],
    run: () => store().setRight({ open: !store().right.open }),
  },
  {
    id: 'sidebar:outline',
    group: 'view',
    defaults: [],
    enabled: hasNote,
    run: () => store().setRight({ open: true, tab: 'outline' }),
  },
  {
    id: 'sidebar:backlinks',
    group: 'view',
    defaults: [],
    enabled: hasNote,
    run: () => store().setRight({ open: true, tab: 'backlinks' }),
  },
  {
    id: 'sidebar:tags',
    group: 'view',
    defaults: [],
    enabled: hasVault,
    run: () => store().setLeft({ open: true, tab: 'tags' }),
  },
  {
    id: 'sidebar:files',
    group: 'view',
    defaults: [],
    enabled: hasVault,
    run: () => store().setLeft({ open: true, tab: 'files' }),
  },

  // ---- editor ----
  {
    id: 'editor:bold',
    group: 'editor',
    defaults: ['Mod-b'],
    enabled: editorMode,
    run: withEditor(fmt.toggleBold),
  },
  {
    id: 'editor:italic',
    group: 'editor',
    defaults: ['Mod-i'],
    enabled: editorMode,
    run: withEditor(fmt.toggleItalic),
  },
  {
    id: 'editor:highlight',
    group: 'editor',
    defaults: ['Mod-Shift-h'],
    enabled: editorMode,
    run: withEditor(fmt.toggleHighlight),
  },
  {
    id: 'editor:strike',
    group: 'editor',
    defaults: ['Mod-Shift-x'],
    enabled: editorMode,
    run: withEditor(fmt.toggleStrike),
  },
  {
    id: 'editor:code',
    group: 'editor',
    defaults: ['Mod-Shift-c'],
    enabled: editorMode,
    run: withEditor(fmt.toggleInlineCode),
  },
  {
    id: 'editor:comment',
    group: 'editor',
    defaults: [],
    enabled: editorMode,
    run: withEditor(fmt.toggleComment),
  },
  {
    id: 'editor:link',
    group: 'editor',
    defaults: ['Mod-k'],
    enabled: editorMode,
    run: withEditor(fmt.insertLink),
  },
  {
    id: 'editor:wikilink',
    group: 'editor',
    defaults: ['Mod-Shift-k'],
    enabled: editorMode,
    run: withEditor(fmt.insertWikilink),
  },
  ...[1, 2, 3, 4, 5, 6].map<Command>((n) => ({
    id: `editor:heading-${n}`,
    group: 'editor',
    defaults: [`Mod-${n}`],
    enabled: editorMode,
    run: withEditor(fmt.setHeading(n)),
  })),
  {
    id: 'editor:bullet',
    group: 'editor',
    defaults: ['Mod-Shift-8'],
    enabled: editorMode,
    run: withEditor(fmt.toggleBulletList),
  },
  {
    id: 'editor:numbered',
    group: 'editor',
    defaults: ['Mod-Shift-7'],
    enabled: editorMode,
    run: withEditor(fmt.toggleNumberedList),
  },
  {
    id: 'editor:quote',
    group: 'editor',
    defaults: ['Mod-Shift-9'],
    enabled: editorMode,
    run: withEditor(fmt.toggleQuote),
  },
  {
    id: 'editor:task',
    group: 'editor',
    defaults: ['Mod-Enter'],
    enabled: editorMode,
    run: withEditor(fmt.toggleTask),
  },

  // ---- cloud ----
  {
    id: 'sync:connect',
    group: 'app',
    defaults: [],
    enabled: () => hasVault() && !syncInfo().linked,
    run: () => useSync.getState().setWizardOpen(true),
  },
  {
    id: 'sync:now',
    group: 'app',
    defaults: ['Mod-Shift-s'],
    enabled: () => isLinked() && !syncInfo().locked,
    run: () => guard(api.sync.syncNow(store().vault?.id ?? '')),
  },
  {
    id: 'sync:conflicts',
    group: 'app',
    defaults: [],
    enabled: isLinked,
    run: () => useSync.getState().setConflictsOpen(true),
  },
  {
    id: 'sync:history',
    group: 'app',
    defaults: [],
    enabled: () => isLinked() && hasNote(),
    run: () => useSync.getState().openHistory(activePath()),
  },
  { id: 'sync:settings', group: 'app', defaults: [], run: () => store().openSettings('sync') },
  {
    id: 'sync:unlock',
    group: 'app',
    defaults: [],
    enabled: () => isLinked() && syncInfo().locked,
    run: () => useSync.getState().setUnlockOpen(true),
  },

  // ---- app ----
  { id: 'settings:open', group: 'app', defaults: ['Mod-,'], run: () => store().openSettings() },
  {
    id: 'settings:hotkeys',
    group: 'app',
    defaults: [],
    run: () => store().openSettings('hotkeys'),
  },
];

export const commandById = new Map(commands.map((c) => [c.id, c]));

export function isEnabled(c: Command): boolean {
  return c.enabled ? c.enabled() : true;
}

/** Effective combos per command given the user's overrides. */
export function currentCombos(overrides: Record<string, string[]>): Map<string, string[]> {
  return effectiveCombos(commands, overrides);
}

/** The enabled command a keyboard event triggers, if any. */
export function commandForEvent(
  e: KeyboardEvent,
  overrides: Record<string, string[]>,
): Command | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  const ids = comboIndex(currentCombos(overrides)).get(normalizeCombo(combo)) ?? [];
  for (const id of ids) {
    const c = commandById.get(id);
    if (c && isEnabled(c)) return c;
  }
  return null;
}

export async function runCommand(id: string): Promise<void> {
  const c = commandById.get(id);
  if (!c || !isEnabled(c)) return;
  await c.run();
}

// Used by tests and the palette to find the pane a command acts on.
export const activePane = () => findPane(store().layout, store().layout.activePane);

/** Localized title of a command ("commands.<id>" with ':' and '-' mapped to '_'). */
export function commandTitle(id: string): string {
  return i18next.t(`commands.${id.replace(/[:-]/g, '_')}`, { defaultValue: id });
}
