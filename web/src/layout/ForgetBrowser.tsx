import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog } from '@memobrain/ui';
import { forgetAfterLeave, forgetThisBrowser, type ForgetResult } from '../workbench/forget';
import { unsyncedVaults, type VaultMarker } from '../workbench/markers';
import { accountKey } from '../workbench/storage';

type Pending = VaultMarker & { id: string };

type Step =
  | { kind: 'idle' }
  | { kind: 'confirm'; account: string; vaults: Pending[] }
  | { kind: 'working' }
  | { kind: 'busy'; account: string; stillOpen: boolean }
  | { kind: 'waiting'; account: string };

export interface ForgetBrowserOptions {
  /**
   * The identity provider's subject of the signed-in account: only its copies are removed (storage.ts).
   * Other accounts' copies in the same browser stay until those accounts sign out or forget it.
   */
  subject: string | undefined;
  /** Label of the button that confirms deleting copies with changes not uploaded. */
  confirmLabel: string;
  /** The copies are gone (or there were none). */
  onDone: () => void;
  /** Removing them failed for an unexpected reason. */
  onError: (e: unknown) => void;
}

/**
 * "Forget this browser" as the console runs it (signing out, the account page): copies that hold changes
 * not uploaded yet are listed and deleted only after a confirmation (D-04), and a workbench open in another
 * tab, which keeps the files locked, can be asked to leave first.
 */
export function useForgetBrowser(o: ForgetBrowserOptions): {
  start: () => void;
  working: boolean;
  dialogs: ReactNode;
} {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>({ kind: 'idle' });

  const finish = (account: string, r: ForgetResult, afterLeave: boolean): void => {
    if (r.busy) return setStep({ kind: 'busy', account, stillOpen: afterLeave });
    setStep({ kind: 'idle' });
    o.onDone();
  };
  const fail = (e: unknown): void => {
    setStep({ kind: 'idle' });
    o.onError(e);
  };
  const run = (account: string): void => {
    setStep({ kind: 'working' });
    forgetThisBrowser(account).then((r) => finish(account, r, false), fail);
  };
  const closeTabAndRetry = (account: string): void => {
    setStep({ kind: 'waiting', account });
    forgetAfterLeave(account).then((r) => finish(account, r, true), fail);
  };
  const start = (): void => {
    const subject = o.subject;
    if (!subject) return o.onDone(); // nobody signed in: nothing of theirs to remove
    setStep({ kind: 'working' });
    accountKey({ server: location.origin, subject }).then((account) => {
      const vaults = unsyncedVaults(account);
      if (vaults.length > 0) setStep({ kind: 'confirm', account, vaults });
      else run(account);
    }, fail);
  };
  const cancel = (): void => setStep({ kind: 'idle' });

  const describe = (v: Pending): string => {
    const parts: string[] = [];
    if (v.pending > 0) parts.push(t('forget.pendingCount', { count: v.pending }));
    if (v.conflicts > 0) parts.push(t('forget.conflictCount', { count: v.conflicts }));
    if (parts.length === 0) parts.push(t('forget.maybePending'));
    return parts.join(', ');
  };

  let dialogs: ReactNode = null;
  if (step.kind === 'confirm')
    dialogs = (
      <Dialog
        title={t('forget.confirmTitle')}
        onClose={cancel}
        actions={
          <>
            <Button onClick={cancel}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => run(step.account)}>
              {o.confirmLabel}
            </Button>
          </>
        }
      >
        <div className="nd-stack">
          <p>{t('forget.confirmBody')}</p>
          <ul>
            {step.vaults.map((v) => (
              <li key={v.id}>
                {v.id.startsWith('share:') ? (
                  <strong>{v.name || v.id}</strong>
                ) : (
                  <a href={`/vaults/${encodeURIComponent(v.id)}/open`}>{v.name || v.id}</a>
                )}{' '}
                — {describe(v)}
              </li>
            ))}
          </ul>
          <p>{t('forget.confirmHint')}</p>
        </div>
      </Dialog>
    );
  else if (step.kind === 'busy' || step.kind === 'waiting')
    dialogs = (
      <Dialog
        title={t('forget.busyTitle')}
        onClose={cancel}
        actions={
          <>
            <Button onClick={cancel}>{t('common.cancel')}</Button>
            <Button onClick={() => run(step.account)} disabled={step.kind === 'waiting'}>
              {t('common.retry')}
            </Button>
            <Button
              variant="primary"
              onClick={() => closeTabAndRetry(step.account)}
              disabled={step.kind === 'waiting'}
            >
              {t('forget.closeTab')}
            </Button>
          </>
        }
      >
        <p role="alert">
          {step.kind === 'waiting'
            ? t('forget.waiting')
            : step.stillOpen
              ? t('forget.stillOpen')
              : t('forget.busyBody')}
        </p>
      </Dialog>
    );

  return { start, working: step.kind !== 'idle' && step.kind !== 'confirm', dialogs };
}
