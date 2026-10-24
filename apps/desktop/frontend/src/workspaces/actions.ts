// Save, load, rename, overwrite and delete workspaces (commands and dialogs).
import i18next from 'i18next';
import { api } from '../app/api';
import { useAppStore, type LeftTab, type RightTab } from '../state/store';
import { dialog } from '../ui/dialogs';
import { flushAllNotes } from './flush';
import {
  captureWorkspace,
  findWorkspace,
  normalizeName,
  pruneMissing,
  removeWorkspace,
  renameWorkspace,
  upsertWorkspace,
  type SavedWorkspace,
} from './model';
import { useWorkspaces, workspacesReadOnly } from './store';

const t = (key: string, opts: Record<string, unknown> = {}): string => i18next.t(key, opts);
const store = () => useAppStore.getState();

export const canEditWorkspaces = (): boolean => {
  const v = store().vault;
  return !!v && !workspacesReadOnly(v.id);
};

const snapshotNow = (name: string): SavedWorkspace => {
  const s = store();
  return captureWorkspace(name, s.layout, s.left, s.right);
};

/** "Save workspace…": asks for a name; an existing name is overwritten after confirmation. */
export async function saveWorkspace(): Promise<void> {
  if (!canEditWorkspaces()) return;
  const raw = await dialog.prompt(t('workspaces.savePrompt'));
  const name = raw === null ? '' : normalizeName(raw);
  if (!name) return;
  const exists = findWorkspace(useWorkspaces.getState().file.workspaces, name);
  if (
    exists &&
    !(await dialog.confirm(
      t('workspaces.overwrite'),
      t('workspaces.overwriteConfirm', { name: exists.name }),
    ))
  )
    return;
  await useWorkspaces.getState().update((list) => upsertWorkspace(list, snapshotNow(name)));
}

/** Replaces the layout and sidebars with the saved ones. */
export async function loadWorkspace(ws: SavedWorkspace): Promise<void> {
  const vault = store().vault;
  if (!vault) return;
  // Pending edits are written first: loading closes every tab that is not part of the workspace.
  await flushAllNotes();
  const tree = await api.vault.listTree(vault.id);
  const layout = pruneMissing(ws.layout, new Set(tree.map((e) => e.path)));
  store().setLayout(layout);
  store().setLeft({ open: ws.left.open, tab: ws.left.tab as LeftTab, width: ws.left.width });
  store().setRight({ open: ws.right.open, tab: ws.right.tab as RightTab, width: ws.right.width });
}

async function chooseWorkspace(title: string): Promise<SavedWorkspace | null> {
  const list = useWorkspaces.getState().file.workspaces;
  if (list.length === 0) {
    await dialog.alert(t('workspaces.title'), t('workspaces.none'));
    return null;
  }
  const name = await dialog.pick(
    title,
    list.map((w) => ({ value: w.name, label: w.name })),
  );
  return name === null ? null : (findWorkspace(list, name) ?? null);
}

/** "Load workspace…" */
export async function pickAndLoadWorkspace(): Promise<void> {
  const ws = await chooseWorkspace(t('workspaces.load'));
  if (ws) await loadWorkspace(ws);
}

async function rename(ws: SavedWorkspace): Promise<void> {
  const to = await dialog.prompt(t('workspaces.renamePrompt'), ws.name);
  if (to === null || normalizeName(to) === ws.name) return;
  const outcome: { result: ReturnType<typeof renameWorkspace> } = { result: 'missing' };
  await useWorkspaces.getState().update((list) => {
    outcome.result = renameWorkspace(list, ws.name, to);
    return typeof outcome.result === 'string' ? list : outcome.result;
  });
  if (outcome.result === 'exists')
    await dialog.alert(t('workspaces.title'), t('workspaces.exists', { name: normalizeName(to) }));
}

/** "Manage workspaces": choose one, then load, rename, overwrite with the current layout, or delete. */
export async function manageWorkspaces(): Promise<void> {
  const ws = await chooseWorkspace(t('workspaces.manage'));
  if (!ws) return;
  const editable = canEditWorkspaces();
  const actions = [
    { value: 'load', label: t('workspaces.actionLoad') },
    ...(editable
      ? [
          { value: 'rename', label: t('workspaces.actionRename') },
          { value: 'overwrite', label: t('workspaces.actionOverwrite') },
          { value: 'delete', label: t('workspaces.actionDelete') },
        ]
      : []),
  ];
  const action = await dialog.pick(ws.name, actions);
  switch (action) {
    case 'load':
      await loadWorkspace(ws);
      break;
    case 'rename':
      await rename(ws);
      break;
    case 'overwrite':
      if (
        await dialog.confirm(
          t('workspaces.overwrite'),
          t('workspaces.overwriteConfirm', { name: ws.name }),
        )
      )
        await useWorkspaces
          .getState()
          .update((list) => upsertWorkspace(list, snapshotNow(ws.name)));
      break;
    case 'delete':
      if (
        await dialog.confirm(
          t('workspaces.delete'),
          t('workspaces.deleteConfirm', { name: ws.name }),
          true,
        )
      )
        await useWorkspaces.getState().update((list) => removeWorkspace(list, ws.name));
      break;
    default:
      break;
  }
}
