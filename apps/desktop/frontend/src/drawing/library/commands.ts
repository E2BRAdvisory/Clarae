// Shape libraries and drawings of the Obsidian Excalidraw plugin, as commands: import and export a
// ".excalidrawlib", convert an ".excalidraw.md" into a drawing. All files are vault files; the
// native Go side only converts (ImportLegacy), the library itself is read and written here.
import i18next from 'i18next';
import { invalidateVault } from '../../app/actions';
import { api } from '../../app/api';
import { useAppStore } from '../../state/store';
import { dialog } from '../../ui/dialogs';
import { getSceneController } from '../actions/active';

const t = (key: string, options?: Record<string, unknown>): string =>
  i18next.t(`drawing.library.${key}`, options);
const LIBRARY_CONFIG = 'excalidraw-library.json';
const MAX_LISTED = 2000;

async function guard(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    await dialog.error(e);
  }
}

/** Asks for one vault file among those with the given ending; null when none or cancelled. */
async function pickVaultFile(
  vaultId: string,
  suffix: string,
  title: string,
): Promise<string | null> {
  const files = (await api.vault.listTree(vaultId))
    .filter((e) => !e.isDir && e.path.toLowerCase().endsWith(suffix))
    .map((e) => e.path)
    .sort()
    .slice(0, MAX_LISTED);
  if (files.length === 0) {
    await dialog.alert(title, t('noFiles', { suffix }));
    return null;
  }
  return dialog.pick(
    title,
    files.map((p) => ({ value: p, label: p })),
  );
}

const utf8 = (base64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

const toBase64 = (text: string): string => {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** "Import a shape library": merges a ".excalidrawlib" of the vault into the library. */
export function importLibrary(): Promise<void> {
  return guard(async () => {
    const c = getSceneController();
    if (!c?.canEdit()) return;
    const path = await pickVaultFile(c.vaultId, '.excalidrawlib', t('importTitle'));
    if (!path) return;
    const file = await api.vault.readBinary(c.vaultId, path);
    const n = await c.importLibrary(utf8(file.data));
    await dialog.alert(t('importTitle'), t('imported', { count: n }));
  });
}

/** "Export the shape library": writes it as a ".excalidrawlib" in the vault root. */
export function exportLibrary(): Promise<void> {
  return guard(async () => {
    const vault = useAppStore.getState().vault;
    if (!vault) return;
    let body = '';
    try {
      body = await api.vault.readConfig(vault.id, LIBRARY_CONFIG);
    } catch {
      /* no library yet */
    }
    const items = (JSON.parse(body || '{}') as { libraryItems?: unknown[] }).libraryItems ?? [];
    if (items.length === 0) return dialog.alert(t('exportTitle'), t('emptyLibrary'));
    const path = await api.vault.saveAttachment(
      vault.id,
      '',
      'Library.excalidrawlib',
      toBase64(body),
    );
    invalidateVault(vault.id);
    await dialog.alert(t('exportTitle'), t('exported', { path }));
  });
}

/** "Convert an .excalidraw.md": the Obsidian plugin's drawing becomes a standard drawing next to it. */
export function importLegacyDrawing(): Promise<void> {
  return guard(async () => {
    const vault = useAppStore.getState().vault;
    if (!vault) return;
    const src = await pickVaultFile(vault.id, '.excalidraw.md', t('legacyTitle'));
    if (!src) return;
    const path = await api.drawing.importLegacy(vault.id, src);
    invalidateVault(vault.id);
    useAppStore.getState().openNote(path, { newTab: true });
  });
}
