import { create } from 'zustand';

/** State of the full-screen presentation of a .marp file (ADR-0048): one at a time. */
interface ShowState {
  open: boolean;
  vaultId: string;
  path: string;
  /** The slide (0-based, among all of them) it starts from; a left-out one starts at the next. */
  index: number;
  start: (vaultId: string, path: string, index?: number) => void;
  close: () => void;
}

export const useMarpShow = create<ShowState>((set) => ({
  open: false,
  vaultId: '',
  path: '',
  index: 0,
  start: (vaultId, path, index = 0) => set({ open: true, vaultId, path, index }),
  close: () => set({ open: false }),
}));
