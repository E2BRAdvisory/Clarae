import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, InlineError } from '@clarae/ui';
import { ByteField, type ByteFieldValue } from './ByteField';
import { parseAmount, splitBytes, toBytes } from './bytes';

type Mode = 'default' | 'unlimited' | 'custom';

/** `null` = the global default, `-1` = unlimited, otherwise bytes. */
export type QuotaChoice = number | null;

function initial(current: QuotaChoice | undefined): { mode: Mode; field: ByteFieldValue } {
  if (current === undefined || current === null)
    return { mode: 'default', field: { value: '', unit: 'GB' } };
  if (current < 0) return { mode: 'unlimited', field: { value: '', unit: 'GB' } };
  return { mode: 'custom', field: splitBytes(current) };
}

/** Pick the default, unlimited or an explicit quota; used for one user and for a selection. */
export function QuotaDialog({
  title,
  description,
  current,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  current?: QuotaChoice;
  pending: boolean;
  error: string | null;
  onSubmit: (quota: QuotaChoice) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const name = useId();
  const start = initial(current);
  const [mode, setMode] = useState<Mode>(start.mode);
  const [field, setField] = useState<ByteFieldValue>(start.field);
  const [invalid, setInvalid] = useState(false);

  const submit = () => {
    if (mode === 'default') return onSubmit(null);
    if (mode === 'unlimited') return onSubmit(-1);
    const n = parseAmount(field.value);
    if (n === undefined) return setInvalid(true);
    setInvalid(false);
    onSubmit(toBytes(n, field.unit));
  };

  const radio = (value: Mode, label: string) => (
    <label className="admin-radio">
      <input
        type="radio"
        name={name}
        value={value}
        checked={mode === value}
        onChange={() => setMode(value)}
      />{' '}
      {label}
    </label>
  );

  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={pending} onClick={submit}>
            {t('admin.quota.apply')}
          </Button>
        </>
      }
    >
      {description && <p>{description}</p>}
      <fieldset className="admin-fieldset">
        <legend>{t('admin.quota.legend')}</legend>
        {radio('default', t('admin.quota.useDefault'))}
        {radio('unlimited', t('admin.quota.unlimited'))}
        {radio('custom', t('admin.quota.custom'))}
      </fieldset>
      {mode === 'custom' && (
        <ByteField label={t('admin.quota.amount')} field={field} onChange={setField} />
      )}
      {invalid && <InlineError>{t('admin.quota.invalid')}</InlineError>}
      {error && <InlineError>{error}</InlineError>}
    </Dialog>
  );
}
