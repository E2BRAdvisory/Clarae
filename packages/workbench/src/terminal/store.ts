// State of the integrated terminal (ADR-0064): the tabs, where the panel is, whether it is shown. It
// is global and outlives the vault view: the shells are the core's, and changing vault does not end
// them. The logic that changes it, and talks to the core, is controller.ts.
import { create } from 'zustand';
import type { TerminalMode } from '../app/events.gen';
import { DOCK_DEFAULT, readDock, type DockPrefs } from './dock';
import { emptyTabs, type TerminalTab } from './model';

/**
 * Which window this page is: the main one (the vault UI, which holds the panel while the core says
 * `docked`) or the separate one (terminal.html, which holds it while `detached`).
 */
export type TerminalRole = 'main' | 'window';

export interface TerminalState {
  role: TerminalRole;
  /** Where the core says the panel is. */
  mode: TerminalMode;
  /** The panel is shown in the main window (it may be hidden with its tabs alive). */
  open: boolean;
  tabs: TerminalTab[];
  active: string | null;
  /** Position and size in the main window, per device (dock.ts). */
  dock: DockPrefs;
  /** Vault ids that are locked (a private vault): their terminals are covered, the processes go on. */
  locked: Record<string, boolean>;
  /** The last failure of the core, translated, until dismissed; '' for none. */
  notice: string;
}

export const initialTerminal = (): TerminalState => ({
  role: 'main',
  mode: 'docked',
  open: false,
  ...emptyTabs,
  dock: typeof localStorage === 'undefined' ? { ...DOCK_DEFAULT } : readDock(),
  locked: {},
  notice: '',
});

export const useTerminal = create<TerminalState>(initialTerminal);

/** This page owns the panel: it draws the sessions and the other window ignores them. */
export const ownsPanel = (s: TerminalState): boolean =>
  s.role === 'main' ? s.mode === 'docked' : s.mode === 'detached';

/** The panel is on the screen of this page. */
export const panelVisible = (s: TerminalState): boolean =>
  ownsPanel(s) && (s.role === 'window' || s.open);

/** The terminal is open somewhere (docked and shown, or in the separate window): the ribbon button is pressed. */
export const terminalOpen = (s: TerminalState): boolean =>
  s.mode === 'detached' || (s.role === 'main' && s.open);

export const activeTab = (s: TerminalState): TerminalTab | undefined =>
  s.tabs.find((t) => t.id === s.active);
