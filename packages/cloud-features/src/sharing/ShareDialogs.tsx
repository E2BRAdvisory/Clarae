import { useState } from 'react';
import { Button, Dialog, InlineError, SelectField, TextField } from '@memobrain/ui';
import { NAME_MAX } from '../NewVaultDialog';
import type { TFunction } from '../i18n';
import type { CloudVault, NewShare, Share, ShareUpdate } from '../port';

/** The end of a day picked in a date field ("2026-12-31"), local time, as RFC 3339. */
export function expiryOf(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T23:59:59`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The local day of an RFC 3339 expiry, for a date field. */
export function dayOf(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? '';
const cleanFolder = (path: string) => path.trim().replace(/^\/+|\/+$/g, '');

export interface NewShareDialogProps {
  t: TFunction;
  /** The account's vaults: only the shared ones are offered (D-02). */
  vaults: CloudVault[];
  /** The vault selected at first. */
  vaultId?: string | undefined;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (input: NewShare) => void;
}

/** A new share of a whole shared vault or of one of its folders, with an optional expiry. */
export function NewShareDialog({
  t,
  vaults,
  vaultId,
  busy,
  error,
  onCancel,
  onSubmit,
}: NewShareDialogProps) {
  const shared = vaults.filter((v) => v.kind === 'shared');
  const hasPrivate = vaults.some((v) => v.kind === 'private');
  const [vault, setVault] = useState(
    shared.find((v) => v.id === vaultId)?.id ?? shared[0]?.id ?? '',
  );
  const [what, setWhat] = useState<'vault' | 'folder'>('vault');
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [day, setDay] = useState('');

  const vaultName = shared.find((v) => v.id === vault)?.name ?? '';
  const suggested = what === 'folder' ? baseName(cleanFolder(folder)) : vaultName;
  const shownName = nameTouched ? name : suggested;
  const valid =
    vault !== '' &&
    shownName.trim() !== '' &&
    shownName.trim().length <= NAME_MAX &&
    (what === 'vault' || cleanFolder(folder) !== '');

  const submit = () => {
    const expires = expiryOf(day);
    onSubmit({
      vault_id: vault,
      display_name: shownName.trim(),
      ...(what === 'folder' ? { path_prefix: cleanFolder(folder) } : {}),
      ...(expires ? { expires_at: expires } : {}),
    });
  };

  return (
    <Dialog
      title={t('shareForm.newTitle')}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !valid} onClick={submit}>
            {t('shareForm.create')}
          </Button>
        </>
      }
    >
      {shared.length === 0 ? (
        <p>{t('shareForm.noSharedVaults')}</p>
      ) : (
        <div className="mbcf-form">
          <SelectField
            label={t('shareForm.vault')}
            value={vault}
            onChange={(e) => setVault(e.target.value)}
          >
            {shared.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </SelectField>
          {hasPrivate && <p className="mbcf-muted">{t('shareForm.privateExcluded')}</p>}
          <fieldset className="mbcf-choices">
            <legend className="mbcf-legend">{t('shareForm.what')}</legend>
            {(['vault', 'folder'] as const).map((w) => (
              <label key={w} className="mbcf-choice" data-active={what === w || undefined}>
                <input
                  type="radio"
                  name="mbcf-share-what"
                  value={w}
                  checked={what === w}
                  onChange={() => setWhat(w)}
                />
                <span>{w === 'vault' ? t('shareForm.wholeVault') : t('shareForm.folder')}</span>
              </label>
            ))}
          </fieldset>
          {what === 'folder' && (
            <TextField
              label={t('shareForm.folderPath')}
              hint={t('shareForm.folderHint')}
              value={folder}
              autoComplete="off"
              onChange={(e) => setFolder(e.target.value)}
            />
          )}
          <TextField
            label={t('shareForm.name')}
            hint={t('shareForm.nameHint')}
            value={shownName}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
          />
          <TextField
            label={t('shareForm.expiry')}
            hint={t('shareForm.expiryHint')}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
      )}
      {error && <InlineError>{error}</InlineError>}
    </Dialog>
  );
}

export interface EditShareDialogProps {
  t: TFunction;
  share: Share;
  busy: boolean;
  error: string;
  onCancel: () => void;
  /** Only what changed; nothing when nothing did. */
  onSubmit: (change: ShareUpdate) => void;
}

/** Rename a share, set or remove its expiry (PATCH /shares/{id}). */
export function EditShareDialog({
  t,
  share,
  busy,
  error,
  onCancel,
  onSubmit,
}: EditShareDialogProps) {
  const [name, setName] = useState(share.display_name);
  const [day, setDay] = useState(dayOf(share.expires_at));
  const [noExpiry, setNoExpiry] = useState(!share.expires_at);

  const change: ShareUpdate = {};
  if (name.trim() !== share.display_name) change.display_name = name.trim();
  if (noExpiry) {
    if (share.expires_at) change.clear_expiry = true;
  } else {
    const expires = expiryOf(day);
    if (expires && day !== dayOf(share.expires_at)) change.expires_at = expires;
  }
  const valid =
    name.trim() !== '' &&
    name.trim().length <= NAME_MAX &&
    (noExpiry || expiryOf(day) !== undefined) &&
    Object.keys(change).length > 0;

  return (
    <Dialog
      title={t('shareForm.editTitle', { name: share.display_name })}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !valid} onClick={() => onSubmit(change)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="mbcf-form">
        <TextField
          label={t('shareForm.name')}
          hint={t('shareForm.nameHint')}
          value={name}
          maxLength={NAME_MAX}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
        <label className="mbcf-check">
          <input
            type="checkbox"
            checked={noExpiry}
            onChange={(e) => setNoExpiry(e.target.checked)}
          />
          <span>{t('shareForm.clearExpiry')}</span>
        </label>
        {!noExpiry && (
          <TextField
            label={t('shareForm.expiry')}
            hint={t('shareForm.expiryHint')}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        )}
      </div>
      {error && <InlineError>{error}</InlineError>}
    </Dialog>
  );
}
