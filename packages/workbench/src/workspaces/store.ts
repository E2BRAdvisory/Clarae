// Saved workspaces of the open vault (.clarae/workspaces.json, device-local).
// Loaded and reset automatically when the vault changes. A read-only vault
// (viewer mount) can load its workspaces but not change them.
import { create } from 'zustand';
import { api } from '../app/api';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import {
  emptyWorkspaces,
  parseWorkspaces,
  serializeWorkspaces,
  type SavedWorkspace,
  type WorkspacesFile,
} from './model';

export const WORKSPACES_FILE = 'workspaces.json';

interface WorkspacesState {
  vaultId: string | null;
  file: WorkspacesFile;
  loaded: boolean;
  load: (vaultId: string) => Promise<void>;
  reset: () => void;
  /** Applies a change to the list and saves it; false when the vault is read-only. */
  update: (fn: (list: SavedWorkspace[]) => SavedWorkspace[]) => Promise<boolean>;
}

export function workspacesReadOnly(vaultId: string | null): boolean {
  return !vaultId || infoOf(useSync.getState(), vaultId).readOnly;
}

export const useWorkspaces = create<WorkspacesState>((set, get) => ({
  vaultId: null,
  file: emptyWorkspaces(),
  loaded: false,

  async load(vaultId) {
    set({ vaultId, file: emptyWorkspaces(), loaded: false });
    try {
      const text = await api.vault.readConfig(vaultId, WORKSPACES_FILE);
      if (get().vaultId === vaultId) set({ file: parseWorkspaces(text), loaded: true });
    } catch {
      if (get().vaultId === vaultId) set({ loaded: true });
    }
  },

  reset: () => set({ vaultId: null, file: emptyWorkspaces(), loaded: false }),

  async update(fn) {
    const { vaultId, file } = get();
    if (!vaultId || workspacesReadOnly(vaultId)) return false;
    const workspaces = fn(file.workspaces);
    if (workspaces === file.workspaces) return true;
    const next = { ...file, workspaces };
    set({ file: next });
    await api.vault.writeConfig(vaultId, WORKSPACES_FILE, serializeWorkspaces(next));
    return true;
  },
}));

useAppStore.subscribe((s, prev) => {
  if (s.vault?.id === prev.vault?.id) return;
  if (s.vault) void useWorkspaces.getState().load(s.vault.id);
  else useWorkspaces.getState().reset();
});
