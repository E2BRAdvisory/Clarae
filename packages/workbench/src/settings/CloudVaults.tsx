import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import '@memobrain/cloud-features/workbench.css';
import { CoreCloudPort } from '../cloud/CoreCloudPort';
import { CloudVaultsTable } from '../cloud/lazyPanels';
import { usePlatform } from '../platform';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';

/**
 * Settings > Cloud: the account's cloud vaults, renamed, deleted and restored with the components of
 * @memobrain/cloud-features (ADR-0037 §2). A new cloud vault comes from connecting the open folder
 * (the connect wizard); the web workbench, whose page is a cloud vault already, offers no creation
 * and does not delete the vault it has open.
 */
export function CloudVaults() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const port = useMemo(() => new CoreCloudPort(), []);
  const web = usePlatform((s) => s.kind === 'web');
  const vault = useAppStore((s) => s.vault);
  const info = useSync((s) => infoOf(s, vault?.id));
  const openCloudId = info.linked && !info.mount ? info.cloudVaultId : '';

  const onNew =
    !web && vault && !info.linked
      ? () => {
          useAppStore.getState().closeSettings();
          useSync.getState().setWizardOpen(true);
        }
      : undefined;

  return (
    <CloudVaultsTable
      port={port}
      lang={i18n.language}
      caption={t('cloud.vaults')}
      onNew={onNew}
      isCurrent={web ? (v) => v.id === openCloudId : undefined}
      onChanged={() => {
        void qc.invalidateQueries({ queryKey: ['account'] });
        if (vault) void useSync.getState().refresh(vault.id);
      }}
    />
  );
}
