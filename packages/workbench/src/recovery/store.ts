import { create } from 'zustand';

/** What the File recovery dialog shows: the versions of one note, or the deleted files of the vault. */
export type RecoveryTarget = { kind: 'note'; path: string } | { kind: 'deleted' } | null;

interface RecoveryState {
  target: RecoveryTarget;
  openNote(path: string): void;
  openDeleted(): void;
  close(): void;
}

export const useRecovery = create<RecoveryState>((set) => ({
  target: null,
  openNote: (path) => set({ target: { kind: 'note', path } }),
  openDeleted: () => set({ target: { kind: 'deleted' } }),
  close: () => set({ target: null }),
}));
