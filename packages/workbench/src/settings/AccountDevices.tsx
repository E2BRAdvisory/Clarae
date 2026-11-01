import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '@memobrain/cloud-features/workbench.css';
import { CoreCloudPort } from '../cloud/CoreCloudPort';
import { DevicesPanel, UsagePanel } from '../cloud/lazyPanels';

/**
 * Settings > Cloud: the storage of the account (the server's level, the space of each vault) and its
 * devices, with the components of @memobrain/cloud-features (ADR-0037 §2), the same as the
 * console's. The device the core runs on is marked and cannot be revoked from here.
 */
export function AccountDevices() {
  const { t, i18n } = useTranslation();
  const port = useMemo(() => new CoreCloudPort(), []);
  return (
    <>
      <section className="account-usage" aria-label={t('cloud.storage')}>
        <h3>{t('cloud.storage')}</h3>
        <UsagePanel port={port} lang={i18n.language} />
      </section>
      <section className="account-devices" aria-label={t('cloud.devices')}>
        <h3>{t('cloud.devices')}</h3>
        <DevicesPanel port={port} lang={i18n.language} />
      </section>
    </>
  );
}
