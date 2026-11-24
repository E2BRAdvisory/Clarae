// Commands of daily notes, unique notes, templates, the composer and the random note.
// They are appended to the command registry (commands/registry.ts); titles live in the
// i18n files under "commands.<id>" with ':' and '-' mapped to '_'.
import { extractSelection, mergeActiveNote } from '../composer/actions';
import type { Command } from '../commands/registry';
import { getActiveEditor } from '../editor/registry';
import { infoOf, useSync } from '../state/sync';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { activeTab } from '../workspace/layout';
import { Feature } from '@clarae/api-client/features';
import { featureOn, useManaged } from '../state/managed';
import { importTemplatesFolder } from './migration';
import {
  applyTemplate,
  editTemplate,
  newDrawingFromTemplate,
  newNoteFromTemplate,
  newPresentationFromTemplate,
  newTemplate,
  saveAsTemplate,
  newUniqueNote,
  openAdjacentDaily,
  openDaily,
  openRandomNote,
} from './actions';

const store = () => useAppStore.getState();
const hasVault = (): boolean => store().vault !== null;
const canWrite = (): boolean => {
  const v = store().vault;
  return v !== null && !infoOf(useSync.getState(), v.id).readOnly;
};
const activePath = (): string | null => activeTab(store().layout)?.path ?? null;
const inNote = (): boolean => {
  const t = activeTab(store().layout);
  return !!t && t.mode !== 'reading' && getActiveEditor() !== null;
};

const flagOn = (name: Feature): boolean => featureOn(useManaged.getState().features, name);
const ext = (re: RegExp): boolean => re.test(activePath() ?? '');
/** The kinds of file a template exists for, when their function is on. */
const isDrawing = (): boolean => ext(/\.excalidraw$/i) && flagOn(Feature.Drawings);
const isDeck = (): boolean => ext(/\.marp$/i) && flagOn(Feature.Presentations);
const isNote = (): boolean => ext(/\.md$/i);

async function guard(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    await dialog.error(e);
  }
}

export const notesCommands: Command[] = [
  {
    id: 'daily:open-today',
    group: 'navigate',
    feature: 'daily',
    defaults: [],
    enabled: canWrite,
    run: () => guard(openDaily()),
  },
  {
    id: 'daily:previous',
    group: 'navigate',
    feature: 'daily',
    defaults: [],
    enabled: () => canWrite() && activePath() !== null,
    run: () => guard(openAdjacentDaily(-1)),
  },
  {
    id: 'daily:next',
    group: 'navigate',
    feature: 'daily',
    defaults: [],
    enabled: () => canWrite() && activePath() !== null,
    run: () => guard(openAdjacentDaily(1)),
  },
  {
    id: 'unique:new',
    group: 'file',
    feature: 'templates',
    defaults: [],
    enabled: canWrite,
    run: () => guard(newUniqueNote()),
  },
  {
    id: 'template:insert',
    group: 'editor',
    feature: 'templates',
    defaults: [],
    // "Apply template": the id is the one of "Insert template", so the hotkeys set for it stay.
    enabled: () => canWrite() && ((isNote() && inNote()) || isDrawing() || (isDeck() && inNote())),
    run: () => guard(applyTemplate()),
  },
  {
    id: 'template:new-drawing-from',
    group: 'file',
    feature: 'templates',
    defaults: [],
    enabled: () => canWrite() && flagOn(Feature.Drawings),
    run: () => guard(newDrawingFromTemplate()),
  },
  {
    id: 'template:new-presentation-from',
    group: 'file',
    feature: 'templates',
    defaults: [],
    enabled: () => canWrite() && flagOn(Feature.Presentations),
    run: () => guard(newPresentationFromTemplate()),
  },
  {
    id: 'template:new',
    group: 'file',
    feature: 'templates',
    defaults: [],
    enabled: canWrite,
    run: () => guard(newTemplate()),
  },
  {
    id: 'template:save-as',
    group: 'file',
    feature: 'templates',
    defaults: [],
    enabled: () => canWrite() && (isNote() || isDrawing() || isDeck()),
    run: () => guard(saveAsTemplate()),
  },
  {
    id: 'template:import-folder',
    group: 'file',
    feature: 'templates',
    defaults: [],
    enabled: canWrite,
    run: () => guard(importTemplatesFolder()),
  },
  {
    id: 'template:edit',
    group: 'file',
    feature: 'templates',
    defaults: [],
    enabled: hasVault,
    run: () => guard(editTemplate()),
  },
  {
    id: 'template:new-from',
    group: 'file',
    feature: 'templates',
    defaults: [],
    enabled: canWrite,
    run: () => guard(newNoteFromTemplate()),
  },
  {
    id: 'composer:merge',
    group: 'file',
    feature: 'composer',
    defaults: [],
    enabled: () => canWrite() && !!activePath()?.toLowerCase().endsWith('.md'),
    run: () => guard(mergeActiveNote()),
  },
  {
    id: 'composer:extract',
    group: 'editor',
    feature: 'composer',
    defaults: [],
    enabled: () => canWrite() && inNote(),
    run: () => guard(extractSelection()),
  },
  {
    id: 'note:random',
    group: 'navigate',
    feature: 'note.random',
    defaults: [],
    enabled: hasVault,
    run: () => guard(openRandomNote()),
  },
];
