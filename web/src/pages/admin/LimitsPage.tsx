import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, InlineError, TextField, useToast } from '@clarae/ui';
import { usePutStorageSettings, useStorageSettings, type StorageSettings } from '../../api/admin';
import { QueryState } from '../QueryState';
import { adminError } from './adminError';
import { ByteField, type ByteFieldValue } from './ByteField';
import { parseAmount, splitBytes, toBytes } from './bytes';

const MIN_FILE_BYTES = 1024;

export type LimitsError =
  | 'quota'
  | 'percents'
  | 'warnRange'
  | 'retention'
  | 'daily'
  | 'dailyLess'
  | 'maxFile'
  | 'maxFileMin';

interface Form {
  quota: ByteFieldValue;
  warn: string;
  critical: string;
  retention: string;
  daily: string;
  maxFile: ByteFieldValue;
}

function toForm(s: StorageSettings): Form {
  return {
    quota: splitBytes(s.default_quota_bytes),
    warn: String(s.warn_percent),
    critical: String(s.critical_percent),
    retention: String(s.history_retention_days),
    daily: String(s.history_daily_retention_days),
    maxFile: splitBytes(s.max_file_size_bytes),
  };
}

const int = (s: string): number | undefined => {
  const n = parseAmount(s);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
};

/** Mirrors the server rules: 1 <= warn < critical <= 100; daily >= retention; max file >= 1024 B. */
export function validateLimits(f: Form): {
  errors: Partial<Record<LimitsError, true>>;
  value?: StorageSettings;
} {
  const errors: Partial<Record<LimitsError, true>> = {};
  const quota = parseAmount(f.quota.value);
  if (quota === undefined) errors.quota = true;
  const warn = int(f.warn);
  const critical = int(f.critical);
  if (warn === undefined || critical === undefined) errors.percents = true;
  else if (warn < 1 || critical > 100 || warn >= critical) errors.warnRange = true;
  const retention = int(f.retention);
  const daily = int(f.daily);
  if (retention === undefined || retention < 1) errors.retention = true;
  if (daily === undefined || daily < 1) errors.daily = true;
  else if (retention !== undefined && daily < retention) errors.dailyLess = true;
  const maxAmount = parseAmount(f.maxFile.value);
  if (maxAmount === undefined) errors.maxFile = true;
  const maxFile = maxAmount === undefined ? undefined : toBytes(maxAmount, f.maxFile.unit);
  if (maxFile !== undefined && maxFile < MIN_FILE_BYTES) errors.maxFileMin = true;
  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    value: {
      default_quota_bytes: toBytes(quota as number, f.quota.unit),
      warn_percent: warn as number,
      critical_percent: critical as number,
      history_retention_days: retention as number,
      history_daily_retention_days: daily as number,
      max_file_size_bytes: maxFile as number,
    },
  };
}

function LimitsForm({ settings }: { settings: StorageSettings }) {
  const { t } = useTranslation();
  const toast = useToast();
  const put = usePutStorageSettings();
  const [form, setForm] = useState<Form>(() => toForm(settings));
  const [errors, setErrors] = useState<Partial<Record<LimitsError, true>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const r = validateLimits(form);
    setErrors(r.errors);
    if (!r.value) return;
    put.mutate(r.value, {
      onSuccess: (saved) => {
        setForm(toForm(saved));
        toast.push(t('admin.limits.savedToast'));
      },
      onError: (err) => setServerError(adminError(err, t)),
    });
  };

  const messages = (Object.keys(errors) as LimitsError[]).map((k) => (
    <li key={k}>{t(`admin.limits.error_${k}`)}</li>
  ));

  return (
    <form onSubmit={submit} noValidate aria-label={t('admin.sections.limits')}>
      <Card>
        <div className="nd-stack">
          <ByteField
            label={t('admin.limits.defaultQuota')}
            hint={t('admin.limits.defaultQuotaHint')}
            field={form.quota}
            onChange={(v) => set('quota', v)}
          />
          <div className="nd-row">
            <TextField
              label={t('admin.limits.warn')}
              type="number"
              min={1}
              max={100}
              value={form.warn}
              onChange={(e) => set('warn', e.target.value)}
            />
            <TextField
              label={t('admin.limits.critical')}
              type="number"
              min={1}
              max={100}
              value={form.critical}
              onChange={(e) => set('critical', e.target.value)}
            />
          </div>
          <div className="nd-row">
            <TextField
              label={t('admin.limits.retention')}
              hint={t('admin.limits.retentionHint')}
              type="number"
              min={1}
              value={form.retention}
              onChange={(e) => set('retention', e.target.value)}
            />
            <TextField
              label={t('admin.limits.daily')}
              hint={t('admin.limits.dailyHint')}
              type="number"
              min={1}
              value={form.daily}
              onChange={(e) => set('daily', e.target.value)}
            />
          </div>
          <ByteField
            label={t('admin.limits.maxFile')}
            hint={t('admin.limits.maxFileHint')}
            field={form.maxFile}
            onChange={(v) => set('maxFile', v)}
          />
          {messages.length > 0 && (
            <InlineError>
              <ul className="admin-errors">{messages}</ul>
            </InlineError>
          )}
          {serverError && <InlineError>{serverError}</InlineError>}
          <div className="nd-row">
            <Button type="submit" variant="primary" disabled={put.isPending}>
              {t('admin.limits.save')}
            </Button>
          </div>
        </div>
      </Card>
    </form>
  );
}

export function LimitsPage() {
  const { t } = useTranslation();
  const settings = useStorageSettings();
  return (
    <section aria-labelledby="admin-limits">
      <h2 id="admin-limits">{t('admin.sections.limits')}</h2>
      <QueryState query={settings}>{(s) => <LimitsForm settings={s} />}</QueryState>
    </section>
  );
}
