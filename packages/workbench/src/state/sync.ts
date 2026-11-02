import { create } from 'zustand';
import { can } from '../platform';
import { api, linkInfo, type SyncConflict, type SyncLinkInfo, type SyncStatus } from '../app/api';
import type { VaultCloudDeletedPayload } from '../app/events';
import { useAppStore } from './store';

const unlinked: SyncLinkInfo = linkInfo();

interface SyncState {
  info: Record<string, SyncLinkInfo>;
  status: Record<string, SyncStatus>;
  conflicts: Record<string, SyncConflict[]>;
  /** Dialogs (each one concerns the open vault). */
  wizardOpen: boolean;
  unlockOpen: boolean;
  conflictsOpen: boolean;
  historyPath: string | null;
  diskWarning: boolean;
  /**
   * Folders disconnected because their cloud vault was deleted elsewhere (vault:cloud-deleted):
   * local vault id -> name of the deleted cloud vault. Cleared when the folder is linked again.
   */
  cloudDeleted: Record<string, string>;

  refresh(vaultId: string): Promise<void>;
  refreshConflicts(vaultId: string): Promise<void>;
  setStatus(s: SyncStatus): void;
  /** The core disconnected a folder whose cloud vault was deleted elsewhere. */
  cloudVaultDeleted(p: VaultCloudDeletedPayload): void;
  setWizardOpen(open: boolean): void;
  setUnlockOpen(open: boolean): void;
  setConflictsOpen(open: boolean): void;
  openHistory(path: string | null): void;
  checkDisk(): Promise<void>;
}

export const useSync = create<SyncState>((set, get) => ({
  info: {},
  status: {},
  conflicts: {},
  wizardOpen: false,
  unlockOpen: false,
  conflictsOpen: false,
  historyPath: null,
  diskWarning: false,
  cloudDeleted: {},

  async refresh(vaultId) {
    try {
      const [info, status] = await Promise.all([api.sync.info(vaultId), api.sync.status(vaultId)]);
      set((s) => ({
        info: { ...s.info, [vaultId]: info },
        status: { ...s.status, [vaultId]: status },
        cloudDeleted: info.linked ? without(s.cloudDeleted, vaultId) : s.cloudDeleted,
      }));
      if (info.linked) void get().refreshConflicts(vaultId);
    } catch {
      /* the vault was closed meanwhile */
    }
  },
  async refreshConflicts(vaultId) {
    try {
      const list = await api.sync.conflicts(vaultId);
      set((s) => ({ conflicts: { ...s.conflicts, [vaultId]: list } }));
    } catch {
      /* not linked */
    }
  },
  setStatus(st) {
    set((s) => ({ status: { ...s.status, [st.vaultId]: st } }));
    // A state change may mean a link/lock change too: refresh the cheap info.
    void api.sync
      .info(st.vaultId)
      .then((info) => set((s) => ({ info: { ...s.info, [st.vaultId]: info } })))
      .catch(() => undefined);
  },
  cloudVaultDeleted(p) {
    // The link, its conflicts and the dialogs about them are gone with the cloud vault; the
    // dialogs are those of the open vault (SyncDialogs).
    const open = p.vaultId === useAppStore.getState().vault?.id;
    set((s) => ({
      cloudDeleted: { ...s.cloudDeleted, [p.vaultId]: p.name || s.info[p.vaultId]?.name || '' },
      info: { ...s.info, [p.vaultId]: unlinked },
      conflicts: without(s.conflicts, p.vaultId),
      ...(open ? { unlockOpen: false, conflictsOpen: false, historyPath: null } : {}),
    }));
    void get().refresh(p.vaultId);
  },
  setWizardOpen: (wizardOpen) => set({ wizardOpen }),
  setUnlockOpen: (unlockOpen) => set({ unlockOpen }),
  setConflictsOpen: (conflictsOpen) => set({ conflictsOpen }),
  openHistory: (historyPath) => set({ historyPath }),
  async checkDisk() {
    if (!can('diskEncryptionCheck')) {
      set({ diskWarning: false });
      return;
    }
    try {
      set({ diskWarning: (await api.crypto.diskEncryption()) === 'unencrypted' });
    } catch {
      set({ diskWarning: false });
    }
  },
}));

export const infoOf = (s: SyncState, vaultId: string | undefined): SyncLinkInfo =>
  vaultId ? (s.info[vaultId] ?? unlinked) : unlinked;

function without<T>(m: Record<string, T>, key: string): Record<string, T> {
  if (!(key in m)) return m;
  const next = { ...m };
  delete next[key];
  return next;
}
