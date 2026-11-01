import { useTranslation } from 'react-i18next';
import { UsagePanel } from '@memobrain/cloud-features';
import { useCloudPort } from '../api/cloud';

/**
 * The account's storage: the UsagePanel of @memobrain/cloud-features (ADR-0037 §2), with the level
 * the server computed and the space of each vault.
 */
export function UsagePage() {
  const { t, i18n } = useTranslation();
  const port = useCloudPort();
  return (
    <>
      <h1>{t('usage.title')}</h1>
      <UsagePanel port={port} lang={i18n.language} />
    </>
  );
}
