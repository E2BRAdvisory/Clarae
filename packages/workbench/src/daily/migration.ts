// The move of the templates from the folder of the vault they were in up to 1.8 to the templates
// folder of its configuration folder (ADR-0068). The core plans and moves (TemplatesAPI); here are
// the question asked once per vault when it opens and the "Import templates from the folder" command.
import i18next from 'i18next';
import { invalidateVault } from '../app/actions';
import { api, type TemplateMigration } from '../app/api';
import { useAppStore } from '../state/store';
import { flushAllNotes } from '../workspaces/flush';
import { dialog } from '../ui/dialogs';
import { useNotesSettings } from './settings';

const t = (key: string, opts: Record<string, unknown> = {}): string =>
  i18next.t(`templates.migration.${key}`, opts);

/** After the core moved files: the tabs on them follow, the settings it rewrote are read again. */
async function settle(vaultId: string, res: TemplateMigration): Promise<void> {
  if (useAppStore.getState().vault?.id === vaultId)
    for (const [from, to] of Object.entries(res.paths ?? {}))
      useAppStore.getState().pathRenamed(from, to);
  invalidateVault(vaultId);
  if (useNotesSettings.getState().vaultId === vaultId)
    await useNotesSettings.getState().load(vaultId);
}

/** Unsaved edits of the open files reach the disk before the files move. */
const saveFirst = async (): Promise<void> => {
  await flushAllNotes();
};

async function report(res: TemplateMigration): Promise<void> {
  const lines = [t('moved', { count: res.moved })];
  if (res.skipped.length > 0) lines.push(t('skipped', { list: res.skipped.join(', ') }));
  await dialog.alert(t('title'), lines.join('\n\n'));
}

/**
 * Asks, once per vault, whether the templates found in the old folder are to be moved. Nothing is
 * asked when there is nothing to move, when the move was already answered or when it cannot run
 * (a read-only vault, a folder shared with the user or with others, shares that cannot be read).
 * A refusal is recorded: the templates stay where they are and keep working.
 */
export async function offerTemplateMigration(
  vaultId: string,
  stillOpen: () => boolean = () => true,
): Promise<void> {
  let plan: TemplateMigration;
  try {
    plan = await api.templates.migrationPlan(vaultId);
  } catch {
    return; // asked again at the next opening
  }
  if (!stillOpen() || plan.done || plan.blocked || plan.files.length === 0) return;
  const yes = await dialog.confirm(
    t('title'),
    t('ask', { count: plan.files.length, folder: plan.folder }),
    false,
    t('move'),
  );
  if (!stillOpen()) return;
  try {
    if (!yes) {
      await api.templates.declineMigration(vaultId);
      if (useNotesSettings.getState().vaultId === vaultId)
        await useNotesSettings.getState().load(vaultId);
      return;
    }
    await saveFirst();
    const res = await api.templates.migrate(vaultId);
    await settle(vaultId, res);
    if (res.blocked) await dialog.alert(t('title'), blockedText(res.blocked));
    else if (res.skipped.length > 0) await report(res);
  } catch (e) {
    await dialog.error(e);
  }
}

/** Why the core refused the move, in words. */
function blockedText(reason: string): string {
  switch (reason) {
    case 'read-only':
      return t('blocked_read_only');
    case 'mount':
      return t('blocked_mount');
    case 'shared-folder':
      return t('blocked_shared_folder');
    default:
      return t('blocked_offline');
  }
}

/** "Import templates from the folder": the same move, whenever the user asks for it. */
export async function importTemplatesFolder(): Promise<void> {
  const vaultId = useAppStore.getState().vault?.id;
  if (!vaultId) return;
  if (!(await dialog.confirm(t('title'), t('askImport'), false, t('move')))) return;
  await saveFirst();
  const res = await api.templates.migrate(vaultId);
  if (res.blocked) {
    await dialog.alert(t('title'), blockedText(res.blocked));
    return;
  }
  await settle(vaultId, res);
  if (res.files.length === 0) await dialog.alert(t('title'), t('nothing', { folder: res.folder }));
  else await report(res);
}
