import { create } from 'zustand';

/** The note the user is working in, published by its view for the Properties sidebar. */
export interface ActiveNote {
  vaultId: string;
  path: string;
  /** Latest text, including edits that are not saved yet. */
  text: string;
  /** Saves pending edits and returns the hash of what is on disk. */
  prepare: () => Promise<string>;
  /** Reloads the note after a property was written. */
  reload: () => void;
}

interface State {
  note: ActiveNote | null;
  publish: (note: ActiveNote) => void;
  retire: (path: string) => void;
}

export const useActiveNote = create<State>((set) => ({
  note: null,
  publish: (note) => set({ note }),
  retire: (path) => set((s) => (s.note?.path === path ? { note: null } : s)),
}));
