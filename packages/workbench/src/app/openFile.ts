// Opening a file of the vault by its type (ADR-0047). Notes, canvases, bases, drawings and the media
// the application shows (images, PDF, audio, video) open in a tab; any other file opens with the
// system's application on the desktop, or is offered as a download in the browser. Every way of
// opening a file (explorer, quick switcher, search, links) goes through useAppStore.openNote, which
// hands such a file to openExternally once installOpenFile has run.
import { openTarget } from '../embeds/media';
import { isGraphPath } from '../graph/paths';
import { i18next } from '../i18n';
import { can } from '../platform';
import { setOpenInterceptor, useAppStore, type OpenOptions } from '../state/store';
import { dialog } from '../ui/dialogs';
import { errorCodeOf } from '../util/errors';
import { api } from './api';

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Whether a path opens in a tab: the graph's pseudo paths, notes and the files the app shows. */
export const opensInApp = (path: string): boolean =>
  isGraphPath(path) || openTarget(path) === 'in-app';

/**
 * Opens a file the application does not show. On the desktop the system's application for its type
 * opens it; a program is never run (the core refuses it), the file manager shows it instead when
 * the user agrees. In the browser the user confirms a download of the file.
 */
export async function openExternally(path: string): Promise<void> {
  const vault = useAppStore.getState().vault;
  if (!vault) return;
  const name = nameOf(path);
  try {
    if (!can('openWithSystemApp')) {
      if (
        await dialog.confirm(
          i18next.t('openFile.title'),
          i18next.t('openFile.message', { name }),
          false,
          i18next.t('openFile.download'),
        )
      )
        await downloadVaultFile(path);
      return;
    }
    try {
      await api.vault.openWithSystemApp(vault.id, path);
    } catch (e) {
      if (errorCodeOf(e) !== 'executable') throw e;
      if (
        await dialog.confirm(
          i18next.t('openFile.title'),
          i18next.t('openFile.executable', { name }),
          false,
          i18next.t('openFile.reveal'),
        )
      )
        await api.vault.revealInFolder(vault.id, path);
    }
  } catch (e) {
    await dialog.error(e);
  }
}

/** Saves a copy of a file outside the vault (a download in the browser), errors in a dialog. */
export async function downloadVaultFile(path: string): Promise<void> {
  const vault = useAppStore.getState().vault;
  if (!vault) return;
  try {
    await api.vault.downloadFile(vault.id, path);
  } catch (e) {
    await dialog.error(e);
  }
}

/**
 * Opens any file of the vault: in a tab when the application shows it, otherwise as
 * openExternally does (the `openFileHandler` of ADR-0047).
 */
export function openFile(path: string, o: OpenOptions = {}): void {
  if (opensInApp(path)) useAppStore.getState().openNote(path, o);
  else void openExternally(path);
}

/** Routes every openNote of a file the application does not show to openExternally. */
export function installOpenFile(): void {
  setOpenInterceptor((path) => {
    if (opensInApp(path)) return false;
    void openExternally(path);
    return true;
  });
}
