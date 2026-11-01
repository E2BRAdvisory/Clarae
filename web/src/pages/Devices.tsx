import { useTranslation } from 'react-i18next';
import { DevicesPanel } from '@memobrain/cloud-features';
import { useCloudPort, useThisBrowserDeviceId } from '../api/cloud';

/** The account's devices: the DevicesPanel of @memobrain/cloud-features (ADR-0037 §2). */
export function DevicesPage() {
  const { t, i18n } = useTranslation();
  const port = useCloudPort();
  const thisBrowser = useThisBrowserDeviceId();
  return (
    <>
      <h1>{t('devices.title')}</h1>
      <DevicesPanel port={port} lang={i18n.language} currentDeviceId={thisBrowser} />
    </>
  );
}
