import { useId, useState, type FormEvent } from 'react';
import { Button, Dialog, InlineError, TextField } from '@clarae/ui';
import type { TFunction } from './i18n';
import type { CloudCapabilities, VaultKind } from './port';

export const NAME_MAX = 120;

export interface NewVaultDialogProps {
  t: TFunction;
  capabilities: Pick<CloudCapabilities, 'createShared' | 'createPrivate'>;
  /** Shown under the form (the error of the last attempt). */
  error?: string | undefined;
  busy?: boolean;
  onCancel: () => void;
  /** A shared vault is created by the port; a private one is the host's (see CloudCapabilities). */
  onSubmit: (name: string, kind: VaultKind) => void;
}

/**
 * Name and type of a new cloud vault. The consequences of the type are spelled out before the
 * choice, because it cannot be changed later (D-02): a private vault is end-to-end encrypted with a
 * passphrase and a recovery key, and can never be shared.
 */
export function NewVaultDialog({
  t,
  capabilities,
  error,
  busy = false,
  onCancel,
  onSubmit,
}: NewVaultDialogProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<VaultKind>(capabilities.createShared ? 'shared' : 'private');
  const legendId = useId();
  const formId = useId();
  const trimmed = name.trim();
  const valid =
    trimmed.length > 0 &&
    trimmed.length <= NAME_MAX &&
    (kind === 'shared' ? capabilities.createShared : capabilities.createPrivate);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && !busy) onSubmit(trimmed, kind);
  };

  return (
    <Dialog
      title={t('create.title')}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>{t('vaults.cancel')}</Button>
          <Button variant="primary" type="submit" form={formId} disabled={!valid || busy}>
            {kind === 'private' ? t('create.continue') : t('create.submit')}
          </Button>
        </>
      }
    >
      <form id={formId} className="mbcf-form" onSubmit={submit}>
        <TextField
          label={t('create.name')}
          value={name}
          maxLength={NAME_MAX}
          required
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="mbcf-choices" aria-labelledby={legendId}>
          <legend id={legendId} className="mbcf-legend">
            {t('create.kind')}
          </legend>
          <label className="mbcf-choice" data-active={kind === 'shared' || undefined}>
            <input
              type="radio"
              name="mbcf-kind"
              value="shared"
              checked={kind === 'shared'}
              disabled={!capabilities.createShared}
              onChange={() => setKind('shared')}
            />
            <span>
              <strong>{t('create.shared')}</strong>
              <span className="mbcf-muted">{t('create.sharedText')}</span>
            </span>
          </label>
          <label className="mbcf-choice" data-active={kind === 'private' || undefined}>
            <input
              type="radio"
              name="mbcf-kind"
              value="private"
              checked={kind === 'private'}
              disabled={!capabilities.createPrivate}
              onChange={() => setKind('private')}
            />
            <span>
              <strong>{t('create.private')}</strong>
              <span className="mbcf-muted">{t('create.privateText')}</span>
              <span className="mbcf-muted">
                {capabilities.createPrivate
                  ? t('create.privateInBrowser')
                  : t('create.privateUnavailable')}
              </span>
            </span>
          </label>
        </fieldset>
        <p className="mbcf-muted">{t('create.kindFixed')}</p>
        {error && <InlineError>{error}</InlineError>}
      </form>
    </Dialog>
  );
}
