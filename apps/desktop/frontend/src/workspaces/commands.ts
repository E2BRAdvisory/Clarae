// Workspace commands; spread into the registry (commands/registry.ts).
import type { Command } from '../commands/registry';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import {
  canEditWorkspaces,
  manageWorkspaces,
  pickAndLoadWorkspace,
  saveWorkspace,
} from './actions';

const hasVault = (): boolean => useAppStore.getState().vault !== null;

async function guard(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    await dialog.error(e);
  }
}

export const workspaceCommands: Command[] = [
  {
    id: 'workspace:save',
    group: 'view',
    defaults: [],
    enabled: () => hasVault() && canEditWorkspaces(),
    run: () => guard(saveWorkspace()),
  },
  {
    id: 'workspace:load',
    group: 'view',
    defaults: [],
    enabled: hasVault,
    run: () => guard(pickAndLoadWorkspace()),
  },
  {
    id: 'workspace:manage',
    group: 'view',
    defaults: [],
    enabled: hasVault,
    run: () => guard(manageWorkspaces()),
  },
];
