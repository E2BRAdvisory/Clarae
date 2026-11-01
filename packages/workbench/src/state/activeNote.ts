import { create } from 'zustand';

/** The note the user is working in, published by its view for the Properties sidebar. */
export interface ActiveNote {
  vaultId: string;
  path: string;
  /**
   * The text as of the last pause in typing (subscribers re-render on it); edits that are not saved
   * yet are included.
   */
  text: string;
  /** The editor's text right now, for one-off reads (export, presentation, composer). */
  current: () => string;
  /**
   * Saves pending edits and returns the hash of what is on disk; rejects when the edits cannot be
   * saved (conflict, write error), so nothing is written over them.
   */
  prepare: () => Promise<string>;
  /** Shows the note again after a property was written (unsaved edits are kept). */
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
