import { create } from 'zustand';
import type { AppSettings, AuthState, VaultInfo } from '../app/api';
import type { IndexProgressPayload } from '../app/events';

export type SidebarTab = 'files' | 'search';

interface AppState {
  settings: AppSettings;
  auth: AuthState | null;
  vault: VaultInfo | null;
  /** Path of the note open in the editor (vault relative). */
  openPath: string | null;
  sidebarTab: SidebarTab;
  settingsOpen: boolean;
  indexProgress: IndexProgressPayload | null;

  setSettings: (s: AppSettings) => void;
  setAuth: (a: AuthState) => void;
  setVault: (v: VaultInfo | null) => void;
  openNote: (path: string | null) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setSettingsOpen: (open: boolean) => void;
  setIndexProgress: (p: IndexProgressPayload | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  settings: { language: '', theme: 'system' },
  auth: null,
  vault: null,
  openPath: null,
  sidebarTab: 'files',
  settingsOpen: false,
  indexProgress: null,

  setSettings: (settings) => set({ settings }),
  setAuth: (auth) => set({ auth }),
  setVault: (vault) => set({ vault, openPath: null, indexProgress: null }),
  openNote: (openPath) => set({ openPath }),
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setIndexProgress: (indexProgress) => set({ indexProgress }),
}));
