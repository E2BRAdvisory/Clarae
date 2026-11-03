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
import {
  insertTemplate,
  newNoteFromTemplate,
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
    enabled: () => canWrite() && inNote(),
    run: () => guard(insertTemplate()),
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
