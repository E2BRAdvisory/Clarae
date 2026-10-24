import { create } from 'zustand';
import { api, linkInfo, type SyncConflict, type SyncLinkInfo, type SyncStatus } from '../app/api';

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

  refresh(vaultId: string): Promise<void>;
  refreshConflicts(vaultId: string): Promise<void>;
  setStatus(s: SyncStatus): void;
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

  async refresh(vaultId) {
    try {
      const [info, status] = await Promise.all([api.sync.info(vaultId), api.sync.status(vaultId)]);
      set((s) => ({
        info: { ...s.info, [vaultId]: info },
        status: { ...s.status, [vaultId]: status },
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
  setWizardOpen: (wizardOpen) => set({ wizardOpen }),
  setUnlockOpen: (unlockOpen) => set({ unlockOpen }),
  setConflictsOpen: (conflictsOpen) => set({ conflictsOpen }),
  openHistory: (historyPath) => set({ historyPath }),
  async checkDisk() {
    try {
      set({ diskWarning: (await api.crypto.diskEncryption()) === 'unencrypted' });
    } catch {
      set({ diskWarning: false });
    }
  },
}));

export const infoOf = (s: SyncState, vaultId: string | undefined): SyncLinkInfo =>
  vaultId ? (s.info[vaultId] ?? unlinked) : unlinked;
