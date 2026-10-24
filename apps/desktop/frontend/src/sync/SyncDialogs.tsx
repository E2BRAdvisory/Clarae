import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { ConflictsView } from './ConflictsView';
import { ConnectWizard } from './ConnectWizard';
import { HistoryView } from './HistoryView';
import { UnlockDialog } from './UnlockDialog';

/** Hosts the synchronization dialogs of the open vault. */
export function SyncDialogs() {
  const vault = useAppStore((s) => s.vault);
  const { wizardOpen, unlockOpen, conflictsOpen, historyPath } = useSync();
  if (!vault) return null;
  return (
    <>
      {wizardOpen && <ConnectWizard vaultId={vault.id} vaultName={vault.name} />}
      {unlockOpen && <UnlockDialog vaultId={vault.id} />}
      {conflictsOpen && <ConflictsView vaultId={vault.id} />}
      {historyPath && <HistoryView vaultId={vault.id} path={historyPath} />}
    </>
  );
}
