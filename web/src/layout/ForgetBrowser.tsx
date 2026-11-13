import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog } from '@clarae/ui';
import {
  forgetAfterLeave,
  forgetThisBrowser,
  type LeaveResult,
  type UnsyncedCopy,
} from '../workbench/forget';
import { unsyncedVaults } from '../workbench/markers';
import { accountKey } from '../workbench/storage';

type Pending = UnsyncedCopy;

/** `accepted`: the copies whose changes the user agreed to lose (they were listed and confirmed). */
type Step =
  | { kind: 'idle' }
  | { kind: 'confirm'; account: string; vaults: Pending[] }
  | { kind: 'working' }
  | { kind: 'busy'; account: string; stillOpen: boolean; accepted: string[] }
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

  /** Lists the copies with changes; true when one was not accepted yet (the user is asked). */
  const confirm = (account: string, accepted: string[]): boolean => {
    const vaults = unsyncedVaults(account);
    if (vaults.every((v) => accepted.includes(v.id))) return false;
    setStep({ kind: 'confirm', account, vaults });
    return true;
  };
  const finish = (
    account: string,
    r: LeaveResult,
    afterLeave: boolean,
    accepted: string[],
  ): void => {
    // The workbench tab left, but what it could not upload is still in this browser: ask (D-04).
    if (!r.busy && r.unsynced?.length && confirm(account, accepted)) return;
    if (r.busy) return setStep({ kind: 'busy', account, stillOpen: afterLeave, accepted });
    if (!r.removed) return run(account, accepted);
    setStep({ kind: 'idle' });
    o.onDone();
  };
  const fail = (e: unknown): void => {
    setStep({ kind: 'idle' });
    o.onError(e);
  };
  /**
   * Removes the copies, unless a copy with changes the user did not accept is listed first (one
   * may have appeared meanwhile: a workbench tab closed right after an edit).
   */
  const run = (account: string, accepted: string[]): void => {
    if (confirm(account, accepted)) return;
    setStep({ kind: 'working' });
    forgetThisBrowser(account).then((r) => finish(account, r, false, accepted), fail);
  };
  const closeTabAndRetry = (account: string, accepted: string[]): void => {
    setStep({ kind: 'waiting', account });
    forgetAfterLeave(account, { accepted }).then((r) => finish(account, r, true, accepted), fail);
  };
  const start = (): void => {
    const subject = o.subject;
    if (!subject) return o.onDone(); // nobody signed in: nothing of theirs to remove
    setStep({ kind: 'working' });
    accountKey({ server: location.origin, subject }).then((account) => run(account, []), fail);
  };
  const cancel = (): void => setStep({ kind: 'idle' });

  const describe = (v: Pending): string => {
    const parts: string[] = [];
    if (v.pending > 0) parts.push(t('forget.pendingCount', { count: v.pending }));
    if (v.conflicts > 0) parts.push(t('forget.conflictCount', { count: v.conflicts }));
    if (parts.length === 0) parts.push(t('forget.maybePending'));
    if (v.cloudDeleted) parts.push(t('forget.cloudDeleted'));
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
            <Button
              variant="danger"
              onClick={() =>
                run(
                  step.account,
                  step.vaults.map((v) => v.id),
                )
              }
            >
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
                {v.id.startsWith('share:') || v.cloudDeleted ? (
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
            <Button
              onClick={() => step.kind === 'busy' && run(step.account, step.accepted)}
              disabled={step.kind === 'waiting'}
            >
              {t('common.retry')}
            </Button>
            <Button
              variant="primary"
              onClick={() => step.kind === 'busy' && closeTabAndRetry(step.account, step.accepted)}
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
