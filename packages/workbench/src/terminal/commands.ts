// The commands of the integrated terminal; spread into the registry (commands/registry.ts). They need the
// capability `terminal` (the desktop): the registry never enables them anywhere else.
import type { Command } from '../commands/registry';
import { getActiveEditor } from '../editor/registry';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import { closeActiveTab, dock, newTerminalTab, toggleTerminal, undock } from './controller';
import { newTabDefault, toggleDefault } from './keys';
import { panelVisible, terminalOpen, useTerminal } from './store';

const state = useTerminal.getState;

/**
 * The open vault may not be changed (a share as viewer, or one that ended): a shell would write where the
 * application does not, so no terminal starts for it (the core refuses too: terminal-read-only).
 */
export function readOnlyVault(): boolean {
  const v = useAppStore.getState().vault;
  return v ? infoOf(useSync.getState(), v.id).readOnly : false;
}

/** A shell may start now: always in the separate window (it opens next to the front tab's vault), in the main one unless its vault is read-only. */
export const canStartTerminal = (): boolean => state().role === 'window' || !readOnlyVault();

export const terminalCommands: Command[] = [
  {
    id: 'terminal:toggle',
    group: 'view',
    feature: 'terminal',
    defaults: [toggleDefault()],
    requires: ['terminal'],
    // An open terminal can always be closed, whatever the vault in front is.
    enabled: () => terminalOpen(state()) || canStartTerminal(),
    run: async () => {
      await toggleTerminal();
      // The panel went away with the focus: give it back to the note.
      if (!panelVisible(state())) getActiveEditor()?.focus();
    },
  },
  {
    id: 'terminal:new-tab',
    group: 'view',
    feature: 'terminal',
    defaults: [newTabDefault()],
    requires: ['terminal'],
    enabled: canStartTerminal,
    run: () => newTerminalTab(),
  },
  {
    id: 'terminal:close-tab',
    group: 'view',
    feature: 'terminal',
    defaults: [],
    requires: ['terminal'],
    enabled: () => panelVisible(state()) && state().active !== null,
    run: () => closeActiveTab(),
  },
  {
    id: 'terminal:undock',
    group: 'view',
    feature: 'terminal',
    defaults: [],
    requires: ['terminal'],
    enabled: () => state().role === 'main' && state().mode === 'docked' && state().tabs.length > 0,
    run: () => undock(),
  },
  {
    id: 'terminal:dock',
    group: 'view',
    feature: 'terminal',
    defaults: [],
    requires: ['terminal'],
    enabled: () => state().mode === 'detached',
    run: () => dock(),
  },
];
