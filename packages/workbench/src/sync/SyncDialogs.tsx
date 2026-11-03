import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { LazyDialog } from '../ui/LazyDialog';
import { lazyView } from '../ui/lazyView';
import { UnlockDialog } from './UnlockDialog';

// The connect wizard, the conflicts and the history of a note are fetched the first time they open:
// they stay out of the startup bundle (ADR-0020). The unlock dialog stays in it, since a locked
// private vault asks for its passphrase as soon as it opens.
const ConnectWizard = lazyView(async () => ({
  default: (await import('./ConnectWizard')).ConnectWizard,
}));
const ConflictsView = lazyView(async () => ({
  default: (await import('./ConflictsView')).ConflictsView,
}));
const HistoryView = lazyView(async () => ({
  default: (await import('./HistoryView')).HistoryView,
}));

/** Hosts the synchronization dialogs of the open vault. */
export function SyncDialogs() {
  const vault = useAppStore((s) => s.vault);
  const { wizardOpen, unlockOpen, conflictsOpen, historyPath } = useSync();
  if (!vault) return null;
  return (
    <>
      {wizardOpen && (
        <LazyDialog onClose={() => useSync.getState().setWizardOpen(false)}>
          <ConnectWizard vaultId={vault.id} vaultName={vault.name} />
        </LazyDialog>
      )}
      {unlockOpen && <UnlockDialog vaultId={vault.id} />}
      {conflictsOpen && (
        <LazyDialog onClose={() => useSync.getState().setConflictsOpen(false)}>
          <ConflictsView vaultId={vault.id} />
        </LazyDialog>
      )}
      {historyPath && (
        <LazyDialog onClose={() => useSync.getState().openHistory(null)}>
          <HistoryView vaultId={vault.id} path={historyPath} />
        </LazyDialog>
      )}
    </>
  );
}
