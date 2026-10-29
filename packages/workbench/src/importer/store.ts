import { create } from 'zustand';

interface ImporterState {
  open: boolean;
  show(): void;
  hide(): void;
}

/** Whether the import wizard is open (opened by the "Import…" command and by Settings). */
export const useImporter = create<ImporterState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
