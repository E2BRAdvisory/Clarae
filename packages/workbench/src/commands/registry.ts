// The command registry: every action the user can trigger by hotkey, from the
// command palette or from a menu. Titles live in the i18n files under
// "commands.<id>"; hotkeys are defaults that Settings > Hotkeys can override.
import { useSettings, type NoteMode } from '../state/settings';
import { activeTab, findPane } from '../workspace/layout';
import { createNote, deleteEntry, promptNewFolder, renameEntry, toggleTheme } from '../app/actions';
import { api } from '../app/api';
import { getActiveEditor } from '../editor/registry';
import { headingCommand, type EditorCommand } from '../editor/handle';
import { dialog } from '../ui/dialogs';
import { newCanvas } from '../canvas/commands';
import { openGraph, openLocalGraph } from '../graph/commands';
import { newBase } from '../bases/commands';
import { insertDrawing, newDrawing } from '../drawing/commands';
import { sceneCommands, toolCommands } from '../drawing/sceneCommands';
import { infoOf, useSync } from '../state/sync';
import { Feature } from '@clarae/api-client/features';
import { featureOn, useManaged } from '../state/managed';
import { useSharing } from '../state/sharing';
import { useRecovery } from '../recovery/store';
import { useImporter } from '../importer/store';
import { useUpdater } from '../updater/store';
import { useAppStore } from '../state/store';
import { invalidateVault } from '../app/actions';
import { notesCommands } from '../daily/commands';
import { bookmarkCommands } from '../bookmarks/commands';
import { workspaceCommands } from '../workspaces/commands';
import { previewCommands } from '../preview/commands';
import { exportNoteHtml, exportNoteImage, exportNotePdf } from '../export/commands';
import { startSlideshow } from '../slides/actions';
import {
  exportDeckHtml,
  exportDeckPdf,
  exportDeckPptx,
  isDeck,
  newPresentation,
  presentDeck,
} from '../marp/commands';
import i18next from 'i18next';
import { comboFromEvent, comboIndex, effectiveCombos, normalizeCombo } from './hotkeys';
import { can, type Capabilities } from '../platform';
import type { FeatureId } from '../parity/features.gen';
import { saveWorkspaceNow } from '../shell/useVaultSession';
import { settleNotes } from '../workspaces/flush';

export type CommandGroup = 'file' | 'navigate' | 'view' | 'editor' | 'app';

export interface Command {
  id: string;
  group: CommandGroup;
  /**
   * The feature of the registry (shared/parity/features.yaml) the command belongs to (ADR-0045 §3):
   * the type is generated from the registry, so a feature it lacks does not compile, and
   * `task parity` refuses a command whose feature does not list it.
   */
  feature: FeatureId;
  defaults: readonly string[];
  /** Hidden from the palette (still bindable). */
  hidden?: boolean;
  /**
   * Capabilities of the host the command needs (ADR-0037). Without them the command is never
   * enabled, whatever `enabled` says; scripts/parity.mjs reads this field to tell, per platform,
   * which commands exist.
   */
  requires?: readonly (keyof Capabilities)[];
  /** Whether the command applies right now (open vault, note, selection…). */
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
const flagOn = (name: Feature): boolean => featureOn(useManaged.getState().features, name);
const activePath = (): string | null => activeTab(store().layout)?.path ?? null;
const hasNote = (): boolean => activePath() !== null;
/** A Marp presentation is in focus and presentations are on (ADR-0047). */
const hasDeck = (): boolean => isDeck(activePath() ?? '') && flagOn(Feature.Presentations);
const syncInfo = () => infoOf(useSync.getState(), store().vault?.id);
const isLinked = (): boolean => hasVault() && syncInfo().linked;
const editorMode = (): boolean => {
  const t = activeTab(store().layout);
  return !!t && t.mode !== 'reading' && getActiveEditor() !== null;
};

const t = (key: string): string => i18next.t(key);

function withEditor(command: EditorCommand): () => void {
  return () => {
    const v = getActiveEditor();
    if (v) {
      v.exec(command);
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

/** Asks for a line number and puts the cursor of the active editor at its start (a number past the end is the last line). */
async function gotoLine(): Promise<void> {
  const before = getActiveEditor();
  if (!before) return;
  const lines = before.text().split('\n').length;
  const answer = await dialog.prompt(
    t('editor.gotoLine.title'),
    String(before.cursor().line),
    i18next.t('editor.gotoLine.label', { max: lines }),
  );
  const line = Number.parseInt((answer ?? '').trim(), 10);
  if (!Number.isFinite(line)) return; // cancelled, or not a number: nothing is done
  getActiveEditor()?.gotoLine(line);
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
    feature: 'note.create',
    defaults: ['Mod-n'],
    enabled: canWrite,
    run: () => guard(createNote()),
  },
  {
    id: 'note:new-tab',
    group: 'file',
    feature: 'note.create',
    defaults: ['Mod-Alt-n'],
    enabled: canWrite,
    run: () => guard(createNote({ newTab: true })),
  },
  {
    id: 'folder:new',
    group: 'file',
    feature: 'note.create',
    defaults: [],
    enabled: canWrite,
    run: () =>
      guard(promptNewFolder((title) => dialog.prompt(title), t('sidebar.promptFolderName'))),
  },
  {
    id: 'drawing:new',
    group: 'file',
    feature: 'drawing.edit',
    defaults: ['Mod-Alt-d'],
    enabled: () => canWrite() && flagOn(Feature.Drawings),
    run: () => guard(newDrawing()),
  },
  {
    id: 'canvas:new',
    group: 'file',
    feature: 'canvas',
    defaults: [],
    enabled: () => canWrite() && flagOn(Feature.Canvas),
    run: () => guard(newCanvas()),
  },
  {
    id: 'marp:new',
    group: 'file',
    feature: 'presentations',
    defaults: [],
    enabled: () => canWrite() && flagOn(Feature.Presentations),
    run: () => guard(newPresentation()),
  },
  {
    id: 'marp:present',
    group: 'view',
    feature: 'presentations',
    defaults: [],
    enabled: hasDeck,
    run: () => presentDeck(),
  },
  {
    id: 'marp:export-html',
    group: 'file',
    feature: 'presentations',
    defaults: [],
    enabled: hasDeck,
    run: exportDeckHtml,
  },
  {
    id: 'marp:export-pdf',
    group: 'file',
    feature: 'presentations',
    defaults: [],
    enabled: hasDeck,
    run: exportDeckPdf,
  },
  {
    // Not available yet (ADR-0047): it explains why instead of exporting.
    id: 'marp:export-pptx',
    group: 'file',
    feature: 'presentations',
    defaults: [],
    enabled: hasDeck,
    run: exportDeckPptx,
  },
  {
    id: 'bases:new',
    group: 'file',
    feature: 'bases',
    defaults: [],
    enabled: () => canWrite(),
    run: () => guard(newBase()),
  },
  {
    id: 'drawing:insert',
    group: 'editor',
    feature: 'drawing.edit',
    defaults: [],
    enabled: () => editorMode() && !readOnlyVault() && flagOn(Feature.Drawings),
    run: () => guard(insertDrawing()),
  },
  {
    id: 'note:rename',
    group: 'file',
    feature: 'note.rename',
    defaults: ['F2'],
    enabled: () => hasNote() && !readOnlyVault(),
    run: renameActive,
  },
  {
    id: 'note:delete',
    group: 'file',
    feature: 'note.delete',
    defaults: [],
    enabled: () => hasNote() && !readOnlyVault(),
    run: deleteActive,
  },
  {
    id: 'sharing:open',
    group: 'app',
    feature: 'share.manage',
    defaults: [],
    enabled: () => flagOn(Feature.Sharing),
    run: () => store().openSettings('sharing'),
  },
  {
    id: 'sharing:share',
    group: 'file',
    feature: 'share.create',
    defaults: [],
    enabled: () => {
      const v = store().vault;
      if (!v || !hasNote() || !flagOn(Feature.Sharing)) return false;
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
    feature: 'export.zip',
    defaults: [],
    enabled: hasVault,
    run: exportVaultZip,
  },
  {
    id: 'note:export-pdf',
    group: 'file',
    feature: 'export.note',
    defaults: [],
    enabled: () => hasNote() && /\.md$/i.test(activePath() ?? ''),
    run: exportNotePdf,
  },
  {
    id: 'note:export-image',
    group: 'file',
    feature: 'export.note',
    defaults: [],
    enabled: () => hasNote() && /\.md$/i.test(activePath() ?? ''),
    run: exportNoteImage,
  },
  {
    id: 'note:export-html',
    group: 'file',
    feature: 'export.note',
    defaults: [],
    enabled: hasNote,
    run: exportNoteHtml,
  },
  {
    id: 'update:check',
    group: 'file',
    feature: 'app.updater',
    defaults: [],
    requires: ['updater'],
    run: () => useUpdater.getState().check(),
  },
  {
    id: 'import:open',
    group: 'file',
    feature: 'import',
    defaults: [],
    enabled: canWrite,
    run: () => useImporter.getState().show(),
  },
  {
    id: 'vault:switch',
    group: 'file',
    feature: 'vault.multi-open',
    defaults: [],
    // The browser opens one vault per page, chosen in the console.
    requires: ['multiVault'],
    enabled: hasVault,
    run: () => {
      store().setLeft({ open: true });
      store().setVaultMenuOpen(true);
    },
  },
  {
    id: 'vault:close',
    group: 'file',
    feature: 'vault.open',
    defaults: [],
    enabled: hasVault,
    run: async () => {
      const v = store().vault;
      if (!v) return;
      // Pending edits and the workspace are written while the vault is still open.
      if (!(await settleNotes())) return;
      await saveWorkspaceNow(v.id);
      await api.vault.close(v.id);
      store().setVault(null);
    },
  },
  {
    id: 'index:rebuild',
    group: 'app',
    feature: 'index.rebuild',
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
    feature: 'note.random',
    defaults: ['Mod-o'],
    enabled: hasVault,
    run: () => store().setSwitcherOpen(true),
  },
  {
    id: 'palette:open',
    group: 'navigate',
    feature: 'command-palette',
    defaults: ['Mod-p', 'Mod-Shift-p'],
    run: () => store().setPaletteOpen(true),
  },
  {
    id: 'search:vault',
    group: 'navigate',
    feature: 'search',
    defaults: ['Mod-Shift-f'],
    enabled: hasVault,
    run: focusSearch,
  },
  {
    id: 'tab:next',
    group: 'navigate',
    feature: 'workspace.layout',
    defaults: ['Mod-Alt-ArrowRight'],
    enabled: hasNote,
    run: () => store().cycleTabs(1),
  },
  {
    id: 'tab:prev',
    group: 'navigate',
    feature: 'workspace.layout',
    defaults: ['Mod-Alt-ArrowLeft'],
    enabled: hasNote,
    run: () => store().cycleTabs(-1),
  },
  {
    id: 'tab:close',
    group: 'navigate',
    feature: 'workspace.layout',
    defaults: ['Mod-w'],
    enabled: hasNote,
    run: () => {
      const tab = activeTab(store().layout);
      if (tab) store().closeTabById(tab.id);
    },
  },
  {
    id: 'tab:pin',
    group: 'navigate',
    feature: 'workspace.layout',
    defaults: [],
    enabled: hasNote,
    run: () => {
      const tab = activeTab(store().layout);
      if (tab) store().togglePinTab(tab.id);
    },
  },
  {
    id: 'tab:close-right',
    group: 'navigate',
    feature: 'workspace.layout',
    defaults: [],
    enabled: hasNote,
    run: () => {
      const tab = activeTab(store().layout);
      if (tab) store().closeTabsRightOf(tab.id);
    },
  },
  {
    id: 'tab:close-left',
    group: 'navigate',
    feature: 'workspace.layout',
    defaults: [],
    enabled: hasNote,
    run: () => {
      const tab = activeTab(store().layout);
      if (tab) store().closeTabsLeftOf(tab.id);
    },
  },
  {
    id: 'tab:close-others',
    group: 'navigate',
    feature: 'workspace.layout',
    defaults: [],
    enabled: hasNote,
    run: () => {
      const tab = activeTab(store().layout);
      if (tab) store().closeOtherTabsOf(tab.id);
    },
  },
  {
    id: 'tab:close-all',
    group: 'navigate',
    feature: 'workspace.layout',
    defaults: [],
    enabled: hasNote,
    run: () => store().closeAllTabsIn(store().layout.activePane),
  },
  {
    id: 'pane:close',
    group: 'navigate',
    feature: 'workspace.layout',
    defaults: ['Mod-Shift-w'],
    enabled: hasVault,
    run: () => store().closeActivePane(),
  },

  // ---- view ----
  {
    id: 'mode:toggle-reading',
    group: 'view',
    feature: 'editor.modes',
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
    feature: 'editor.modes',
    defaults: ['Mod-Shift-e'],
    enabled: hasNote,
    run: () => {
      const tab = activeTab(store().layout);
      if (tab) store().setTabMode(tab.id, tab.mode === 'source' ? 'live' : 'source');
    },
  },
  {
    id: 'mode:live',
    group: 'view',
    feature: 'editor.modes',
    defaults: [],
    enabled: hasNote,
    run: setMode('live'),
  },
  {
    id: 'mode:source',
    group: 'view',
    feature: 'editor.modes',
    defaults: [],
    enabled: hasNote,
    run: setMode('source'),
  },
  {
    id: 'mode:reading',
    group: 'view',
    feature: 'editor.modes',
    defaults: [],
    enabled: hasNote,
    run: setMode('reading'),
  },
  {
    id: 'pane:split-right',
    group: 'view',
    feature: 'workspace.layout',
    defaults: ['Mod-\\'],
    enabled: hasNote,
    run: () => store().split('row'),
  },
  {
    id: 'pane:split-down',
    group: 'view',
    feature: 'workspace.layout',
    defaults: ['Mod-Shift-\\'],
    enabled: hasNote,
    run: () => store().split('column'),
  },
  {
    id: 'pane:link',
    group: 'view',
    feature: 'workspace.layout',
    defaults: [],
    enabled: hasNote,
    run: () => store().toggleLinkedPane(store().layout.activePane),
  },
  {
    id: 'sidebar:left',
    group: 'view',
    feature: 'workspace.layout',
    defaults: ['Mod-Shift-l'],
    run: () => store().setLeft({ open: !store().left.open }),
  },
  {
    id: 'sidebar:right',
    group: 'view',
    feature: 'workspace.layout',
    defaults: ['Mod-Shift-r'],
    run: () => store().setRight({ open: !store().right.open }),
  },
  {
    id: 'theme:toggle',
    group: 'view',
    feature: 'appearance',
    defaults: [],
    run: toggleTheme,
  },
  {
    id: 'app:toggle-status-bar',
    group: 'view',
    feature: 'appearance',
    defaults: [],
    run: () => {
      const s = useSettings.getState();
      s.setAppearance({ statusBar: !s.appearance.statusBar });
    },
  },
  {
    id: 'separator:insert',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: [],
    enabled: () => editorMode() && !readOnlyVault(),
    run: withEditor('separator'),
  },
  {
    id: 'sidebar:outline',
    group: 'view',
    feature: 'outline',
    defaults: [],
    enabled: hasNote,
    run: () => store().setLeft({ open: true, tab: 'outline' }),
  },
  {
    id: 'graph:open',
    group: 'view',
    feature: 'graph',
    defaults: ['Mod-Shift-g'],
    enabled: hasVault,
    run: () => openGraph(),
  },
  {
    id: 'graph:open-local',
    group: 'view',
    feature: 'graph',
    defaults: [],
    enabled: () => hasVault() && /\.md$/i.test(activePath() ?? ''),
    run: () => void openLocalGraph(),
  },
  {
    id: 'sidebar:properties',
    group: 'view',
    feature: 'properties',
    defaults: [],
    enabled: hasVault,
    run: () => store().setRight({ open: true, tab: 'properties' }),
  },
  {
    id: 'slides:start',
    group: 'view',
    feature: 'slides',
    defaults: [],
    enabled: () => hasNote() && /\.md$/i.test(activePath() ?? ''),
    run: () => startSlideshow(false),
  },
  {
    id: 'slides:start-here',
    group: 'view',
    feature: 'slides',
    defaults: [],
    enabled: () => hasNote() && /\.md$/i.test(activePath() ?? ''),
    run: () => startSlideshow(true),
  },
  {
    id: 'sidebar:slides',
    group: 'view',
    feature: 'slides',
    defaults: [],
    enabled: hasNote,
    run: () => store().setRight({ open: true, tab: 'slides' }),
  },
  {
    id: 'sidebar:stats',
    group: 'view',
    feature: 'note.stats',
    defaults: [],
    enabled: hasNote,
    run: () => store().setRight({ open: true, tab: 'stats' }),
  },
  {
    id: 'sidebar:backlinks',
    group: 'view',
    feature: 'links.backlinks',
    defaults: [],
    enabled: hasNote,
    run: () => store().setRight({ open: true, tab: 'links' }),
  },
  {
    id: 'sidebar:tags',
    group: 'view',
    feature: 'tags',
    defaults: [],
    enabled: hasVault,
    run: () => store().setRight({ open: true, tab: 'tags' }),
  },
  {
    id: 'sidebar:files',
    group: 'view',
    feature: 'files.explorer',
    defaults: [],
    enabled: hasVault,
    run: () => store().setLeft({ open: true, tab: 'files' }),
  },

  // ---- editor ----
  {
    id: 'editor:bold',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-b'],
    enabled: editorMode,
    run: withEditor('bold'),
  },
  {
    id: 'editor:italic',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-i'],
    enabled: editorMode,
    run: withEditor('italic'),
  },
  {
    id: 'editor:highlight',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-Shift-h'],
    enabled: editorMode,
    run: withEditor('highlight'),
  },
  {
    id: 'editor:strike',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-Shift-x'],
    enabled: editorMode,
    run: withEditor('strike'),
  },
  {
    id: 'editor:code',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-Shift-c'],
    enabled: editorMode,
    run: withEditor('code'),
  },
  {
    id: 'editor:comment',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: [],
    enabled: editorMode,
    run: withEditor('comment'),
  },
  {
    id: 'editor:link',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-k'],
    enabled: editorMode,
    run: withEditor('link'),
  },
  {
    id: 'editor:wikilink',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-Shift-k'],
    enabled: editorMode,
    run: withEditor('wikilink'),
  },
  ...[1, 2, 3, 4, 5, 6].map<Command>((n) => ({
    id: `editor:heading-${n}`,
    group: 'editor',
    feature: 'editor.formatting',
    defaults: [`Mod-${n}`],
    enabled: editorMode,
    run: withEditor(headingCommand(n)),
  })),
  {
    id: 'editor:bullet',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-Shift-8'],
    enabled: editorMode,
    run: withEditor('bullet'),
  },
  {
    id: 'editor:numbered',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-Shift-7'],
    enabled: editorMode,
    run: withEditor('numbered'),
  },
  {
    id: 'editor:quote',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-Shift-9'],
    enabled: editorMode,
    run: withEditor('quote'),
  },
  {
    id: 'editor:task',
    group: 'editor',
    feature: 'editor.formatting',
    defaults: ['Mod-Enter'],
    enabled: editorMode,
    run: withEditor('task'),
  },
  {
    id: 'editor:find',
    group: 'editor',
    feature: 'editor.find',
    defaults: ['Mod-f'],
    enabled: editorMode,
    run: () => getActiveEditor()?.openSearch(),
  },
  {
    id: 'editor:goto-line',
    group: 'editor',
    feature: 'editor.find',
    defaults: ['Mod-Alt-g'],
    enabled: editorMode,
    run: gotoLine,
  },

  // ---- cloud ----
  {
    id: 'sync:connect',
    group: 'app',
    feature: 'sync.link',
    defaults: [],
    enabled: () => hasVault() && !syncInfo().linked,
    run: () => useSync.getState().setWizardOpen(true),
  },
  {
    id: 'sync:now',
    group: 'app',
    feature: 'sync.engine',
    defaults: ['Mod-Shift-s'],
    enabled: () => isLinked() && !syncInfo().locked,
    run: () => guard(api.sync.syncNow(store().vault?.id ?? '')),
  },
  {
    id: 'sync:conflicts',
    group: 'app',
    feature: 'conflicts',
    defaults: [],
    enabled: isLinked,
    run: () => useSync.getState().setConflictsOpen(true),
  },
  {
    id: 'sync:history',
    group: 'app',
    feature: 'revisions',
    defaults: [],
    enabled: () => isLinked() && hasNote(),
    run: () => useSync.getState().openHistory(activePath()),
  },
  {
    id: 'recovery:open',
    group: 'file',
    feature: 'history.local',
    defaults: [],
    enabled: hasNote,
    run: () => {
      const p = activePath();
      if (p) useRecovery.getState().openNote(p);
    },
  },
  {
    id: 'recovery:deleted',
    group: 'file',
    feature: 'trash',
    defaults: [],
    enabled: hasVault,
    run: () => useRecovery.getState().openDeleted(),
  },
  {
    id: 'sync:settings',
    group: 'app',
    feature: 'sync.engine',
    defaults: [],
    run: () => store().openSettings('sync'),
  },
  {
    id: 'sync:unlock',
    group: 'app',
    feature: 'crypto.unlock',
    defaults: [],
    enabled: () => isLinked() && syncInfo().locked,
    run: () => useSync.getState().setUnlockOpen(true),
  },

  // ---- bookmarks, workspaces, page preview (M6-WP3b) ----
  ...bookmarkCommands,
  ...workspaceCommands,
  ...previewCommands,

  // ---- app ----
  {
    id: 'settings:open',
    group: 'app',
    feature: 'settings',
    defaults: ['Mod-,'],
    run: () => store().openSettings(),
  },
  {
    id: 'settings:hotkeys',
    group: 'app',
    feature: 'hotkeys',
    defaults: [],
    run: () => store().openSettings('hotkeys'),
  },
];

commands.push(...notesCommands, ...sceneCommands, ...toolCommands);

export const commandById = new Map(commands.map((c) => [c.id, c]));

/** The host offers everything the command requires (its `requires` capabilities). */
export function isAvailable(c: Command): boolean {
  return (c.requires ?? []).every((name) => can(name));
}

export function isEnabled(c: Command): boolean {
  return isAvailable(c) && (c.enabled ? c.enabled() : true);
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
