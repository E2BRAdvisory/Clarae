import { create } from 'zustand';
import type { AppSettings, AuthState, VaultInfo } from '../app/api';
import type { IndexProgressPayload } from '../app/events';
import type { EditorStats } from '../editor/Editor';
import type { Reveal } from '../reading/ReadingView';
import {
  activeTab,
  closePane,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  closeTabsLeft,
  closeTabsRight,
  togglePin,
  cycleTab,
  emptyLayout,
  openPath,
  removePath,
  renamePath,
  setActivePane,
  setActiveTab,
  setMode,
  setSizes,
  splitPane,
  toggleLink,
  moveTab,
  type Layout,
} from '../workspace/layout';
import { useSettings, type NoteMode } from './settings';

export type LeftTab = 'files' | 'outline' | 'search';
export type RightTab = 'properties' | 'tags' | 'links' | 'slides' | 'stats';

/**
 * Maps a saved left tab to the current ones. Tags and Bookmarks moved to the right sidebar
 * (ADR-0026): a workspace saved before that shows the file tree.
 */
export function normalizeLeftTab(tab: unknown): LeftTab {
  return tab === 'outline' || tab === 'search' ? tab : 'files';
}

/**
 * Maps a saved right tab to the current ones: the old Outline tab moved to the left sidebar, and
 * Backlinks and Bookmarks are sections of the Links tab.
 */
export function normalizeRightTab(tab: unknown): RightTab {
  if (tab === 'backlinks' || tab === 'bookmarks') return 'links';
  return tab === 'tags' || tab === 'links' || tab === 'slides' || tab === 'stats'
    ? tab
    : 'properties';
}
export type SettingsSection =
  | 'general'
  | 'editor'
  | 'files'
  | 'daily'
  | 'drawing'
  | 'appearance'
  | 'hotkeys'
  | 'cloud'
  | 'sync'
  | 'sharing'
  | 'about';

export interface SidebarState<T extends string> {
  open: boolean;
  tab: T;
  width: number;
}

export interface OpenOptions {
  newTab?: boolean;
  paneId?: string;
  /** Open in a new pane split from the active one. */
  split?: 'row' | 'column';
  heading?: string;
  block?: string;
  line?: number;
  mode?: NoteMode;
}

export interface PaneReveal extends Reveal {
  paneId: string;
  path: string;
}

interface AppState {
  settings: AppSettings;
  auth: AuthState | null;
  vault: VaultInfo | null;
  layout: Layout;
  left: SidebarState<LeftTab>;
  right: SidebarState<RightTab>;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  paletteOpen: boolean;
  switcherOpen: boolean;
  indexProgress: IndexProgressPayload | null;
  searchQuery: string;
  stats: EditorStats | null;
  reveal: PaneReveal | null;
  /** Bumped to ask the search panel to take focus. */
  searchFocus: number;
  /** The vault menu at the bottom of the left sidebar is asked to open (command `vault:switch`). */
  vaultMenuOpen: boolean;

  setSettings: (s: AppSettings) => void;
  setAuth: (a: AuthState) => void;
  setVault: (v: VaultInfo | null) => void;
  setIndexProgress: (p: IndexProgressPayload | null) => void;
  setStats: (s: EditorStats | null) => void;

  setLayout: (l: Layout) => void;
  openNote: (path: string, o?: OpenOptions) => void;
  activateTab: (paneId: string, tabId: string) => void;
  focusPane: (paneId: string) => void;
  closeTabById: (tabId: string) => void;
  togglePinTab: (tabId: string) => void;
  closeTabsRightOf: (tabId: string) => void;
  closeTabsLeftOf: (tabId: string) => void;
  closeOtherTabsOf: (tabId: string) => void;
  closeAllTabsIn: (paneId: string) => void;
  closeActivePane: () => void;
  split: (dir: 'row' | 'column') => void;
  setTabMode: (tabId: string, mode: NoteMode) => void;
  cycleTabs: (delta: 1 | -1) => void;
  resizeSplit: (id: string, sizes: number[]) => void;
  moveTabTo: (tabId: string, paneId: string, index?: number) => void;
  toggleLinkedPane: (paneId: string) => void;
  pathRenamed: (from: string, to: string) => void;
  pathRemoved: (path: string) => void;

  setLeft: (patch: Partial<SidebarState<LeftTab>>) => void;
  setRight: (patch: Partial<SidebarState<RightTab>>) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setPaletteOpen: (open: boolean) => void;
  setSwitcherOpen: (open: boolean) => void;
  setVaultMenuOpen: (open: boolean) => void;
  search: (query: string) => void;
}

let nonce = 0;

/**
 * Takes over the opening of a path that must not become a tab (a file the app does not show,
 * ADR-0047): returns true when it handled it. Installed once by the workbench (installOpenFile);
 * without one every path opens in a tab.
 */
let openInterceptor: ((path: string) => boolean) | null = null;

export function setOpenInterceptor(f: ((path: string) => boolean) | null): void {
  openInterceptor = f;
}

export const useAppStore = create<AppState>((set, get) => ({
  settings: { language: '', theme: 'system', trashMode: 'system' },
  auth: null,
  vault: null,
  layout: emptyLayout(),
  left: { open: true, tab: 'files', width: 280 },
  right: { open: false, tab: 'properties', width: 280 },
  settingsOpen: false,
  settingsSection: 'general',
  paletteOpen: false,
  switcherOpen: false,
  indexProgress: null,
  searchQuery: '',
  stats: null,
  reveal: null,
  searchFocus: 0,
  vaultMenuOpen: false,

  setSettings: (settings) => set({ settings }),
  setAuth: (auth) => set({ auth }),
  setVault: (vault) =>
    set({
      vault,
      layout: emptyLayout(),
      indexProgress: null,
      reveal: null,
      stats: null,
      searchQuery: '',
    }),
  setIndexProgress: (indexProgress) => set({ indexProgress }),
  setStats: (stats) => set({ stats }),

  setLayout: (layout) => set({ layout }),
  openNote(path, o = {}) {
    if (openInterceptor?.(path)) return;
    const mode = o.mode ?? useSettings.getState().editor.defaultMode;
    let layout = get().layout;
    let paneId = o.paneId ?? layout.activePane;
    if (o.split) {
      layout = splitPane(layout, paneId, o.split, mode, path);
      paneId = layout.activePane;
    } else {
      layout = openPath(layout, path, { mode, ...(o.newTab ? { newTab: true } : {}), paneId });
    }
    const wantsReveal = o.heading || o.block || o.line;
    set({
      layout,
      reveal: wantsReveal
        ? {
            paneId,
            path,
            ...(o.heading ? { heading: o.heading } : {}),
            ...(o.block ? { block: o.block } : {}),
            ...(o.line ? { line: o.line } : {}),
            nonce: ++nonce,
          }
        : null,
    });
  },
  activateTab: (paneId, tabId) => set({ layout: setActiveTab(get().layout, paneId, tabId) }),
  focusPane: (paneId) => set({ layout: setActivePane(get().layout, paneId) }),
  closeTabById: (tabId) => set({ layout: closeTab(get().layout, tabId) }),
  togglePinTab: (tabId) => set({ layout: togglePin(get().layout, tabId) }),
  closeTabsRightOf: (tabId) => set({ layout: closeTabsRight(get().layout, tabId) }),
  closeTabsLeftOf: (tabId) => set({ layout: closeTabsLeft(get().layout, tabId) }),
  closeOtherTabsOf: (tabId) => set({ layout: closeOtherTabs(get().layout, tabId) }),
  closeAllTabsIn: (paneId) => set({ layout: closeAllTabs(get().layout, paneId) }),
  closeActivePane: () => set({ layout: closePane(get().layout, get().layout.activePane) }),
  split(dir) {
    const l = get().layout;
    set({ layout: splitPane(l, l.activePane, dir, useSettings.getState().editor.defaultMode) });
  },
  setTabMode: (tabId, mode) => set({ layout: setMode(get().layout, tabId, mode) }),
  cycleTabs: (delta) => set({ layout: cycleTab(get().layout, delta) }),
  resizeSplit: (id, sizes) => set({ layout: setSizes(get().layout, id, sizes) }),
  moveTabTo: (tabId, paneId, index) => set({ layout: moveTab(get().layout, tabId, paneId, index) }),
  toggleLinkedPane: (paneId) => set({ layout: toggleLink(get().layout, paneId) }),
  pathRenamed: (from, to) => set({ layout: renamePath(get().layout, from, to) }),
  pathRemoved: (path) => set({ layout: removePath(get().layout, path) }),

  setLeft: (patch) => set({ left: { ...get().left, ...patch } }),
  setRight: (patch) => set({ right: { ...get().right, ...patch } }),
  openSettings: (section) =>
    set({ settingsOpen: true, ...(section ? { settingsSection: section } : {}) }),
  closeSettings: () => set({ settingsOpen: false }),
  setPaletteOpen: (paletteOpen) =>
    set({ paletteOpen, ...(paletteOpen ? { switcherOpen: false } : {}) }),
  setSwitcherOpen: (switcherOpen) =>
    set({ switcherOpen, ...(switcherOpen ? { paletteOpen: false } : {}) }),
  setVaultMenuOpen: (vaultMenuOpen) => set({ vaultMenuOpen }),
  search: (query) =>
    set({
      searchQuery: query,
      left: { ...get().left, open: true, tab: 'search' },
      searchFocus: get().searchFocus + 1,
    }),
}));

/** The note open in the active tab of the active pane. */
export const selectActivePath = (s: AppState): string | null => activeTab(s.layout)?.path ?? null;
