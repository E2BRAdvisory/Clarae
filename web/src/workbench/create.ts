/**
 * Creation of a private cloud vault in the browser (ADR-0037 §2): the console's "New vault" opens
 * `/vaults/new/open?kind=private&name=…`, because a private vault's keys (envelopes, recovery key)
 * are made by the Go core, which only the workbench page runs. The page opens an empty folder of its
 * own, lets the workbench's connect wizard ask for the passphrase (twice, at least 12 characters)
 * and show the recovery key once (SyncAPI.LinkNew), then carries on as a normal open of the new
 * vault. Cancelling removes the empty folder and goes back to the console.
 *
 * The folder is named `new-<uuid>`, not by the cloud id (it does not exist yet): the vault's marker
 * records it (`localPath`), and the next opens of the vault find the copy there (folderOf), so a copy
 * kept with changes that were not uploaded (D-04) is never left behind for a fresh one.
 */
import type { CoreHandle } from './bridge';
import { readMarkers, removeMarker, updateMarker } from './markers';

/** The vault id of the creation route. */
export const NEW_VAULT = 'new';

/** Where the vaults of this browser live in the core's file system. */
export const VAULTS_DIR = '/vaults';

const NAME_MAX = 120;

export interface Creation {
  kind: 'private';
  name: string;
}

/**
 * What the creation route asks for: null when the address is not the creation route, 'invalid' when
 * it is but does not say a private vault and a usable name.
 */
export function parseCreation(
  vaultId: string,
  params: URLSearchParams,
): Creation | null | 'invalid' {
  if (vaultId !== NEW_VAULT) return null;
  const name = (params.get('name') ?? '').trim();
  if (params.get('kind') !== 'private' || !name || name.length > NAME_MAX) return 'invalid';
  return { kind: 'private', name };
}

/** The copy's folder of a vault: where its marker says, or the folder named by its id. */
export function folderOf(vaultId: string): string {
  const recorded = readMarkers()[vaultId]?.localPath;
  return recorded?.startsWith(`${VAULTS_DIR}/`) ? recorded : `${VAULTS_DIR}/${vaultId}`;
}

export interface MountCreate {
  vaultId: string;
  name: string;
  kind: 'private';
  onCreated: (cloudVaultId: string) => void;
  onCancel: () => void;
}

export interface CreationDeps {
  core: Pick<CoreHandle, 'callWithin' | 'wipe'>;
  creation: Creation;
  /** Mounts the workbench's connect wizard; resolves to its unmount. */
  mount: (o: MountCreate) => Promise<() => void>;
  /** history.replaceState of the page's address. */
  replaceUrl: (path: string) => void;
  newId?: () => string;
  limits?: { open: number; close: number };
}

interface VaultInfo {
  id: string;
  name: string;
  path: string;
}

/**
 * Runs the creation. Resolves to the new cloud vault's id and the copy's folder, or to null when the
 * user cancelled (the empty folder and its marker are gone by then).
 */
export async function runCreation(
  d: CreationDeps,
): Promise<{ vaultId: string; path: string } | null> {
  const limits = d.limits ?? { open: 180_000, close: 60_000 };
  const tempId = `new-${d.newId ? d.newId() : crypto.randomUUID()}`;
  const path = `${VAULTS_DIR}/${tempId}`;
  // A tab closed before the vault exists leaves an empty private copy: the start-up sweep removes it.
  updateMarker(tempId, { name: d.creation.name, kind: 'private', localPath: path });
  const info = await d.core.callWithin<VaultInfo>(limits.open, 'VaultAPI', 'OpenVault', path);

  let unmount: () => void = () => undefined;
  const cloudId = await new Promise<string | null>((resolve) => {
    void d
      .mount({
        vaultId: info.id,
        name: d.creation.name,
        kind: d.creation.kind,
        onCreated: resolve,
        onCancel: () => resolve(null),
      })
      .then((u) => (unmount = u));
  });
  unmount();
  // Closed either way: a cancelled folder is removed, a created one is reopened under its new name.
  await d.core.callWithin(limits.close, 'VaultAPI', 'CloseVault', info.id).catch(() => undefined);

  if (!cloudId) {
    try {
      await d.core.wipe(path);
      removeMarker(tempId);
    } catch (e) {
      // The marker stays: the next start-up sweep removes the folder.
      console.warn('memobrain: could not remove the folder of a cancelled vault:', e);
    }
    return null;
  }
  // The copy now belongs to the cloud vault: its marker follows the cloud id (the guard keeps it
  // current from here on), and so does the address.
  removeMarker(tempId);
  updateMarker(cloudId, { name: d.creation.name, kind: 'private', localPath: path });
  d.replaceUrl(`${VAULTS_DIR}/${encodeURIComponent(cloudId)}/open`);
  return { vaultId: cloudId, path };
}
