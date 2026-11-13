import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import '@clarae/cloud-features/workbench.css';
import { CoreCloudPort } from '../cloud/CoreCloudPort';
import { CloudVaultsTable } from '../cloud/lazyPanels';
import { useCan } from '../platform';
import { useAction } from '../ui/ActionButton';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';

/**
 * Settings > Cloud: the account's cloud vaults, renamed, deleted and restored with the components of
 * @clarae/cloud-features (ADR-0037 §2). A new cloud vault comes from connecting the open folder
 * (the connect wizard); the web workbench, whose page is a cloud vault already, offers no creation
 * and does not delete the vault it has open. Both follow `unlinkVault`: where a folder can live
 * without its cloud vault (the desktop), the open folder is connected to a new one and deleting its
 * cloud vault disconnects it; where the copy belongs to the cloud vault (the browser) neither applies.
 */
export function CloudVaults() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const port = useMemo(() => new CoreCloudPort(), []);
  const canUnlink = useCan('unlinkVault');
  const vault = useAppStore((s) => s.vault);
  const info = useSync((s) => infoOf(s, vault?.id));
  const openCloudId = info.linked && !info.mount ? info.cloudVaultId : '';

  // Offered where the open folder can be connected to a new cloud vault (cloud-vault:new).
  const newVault = useAction('cloud-vault:new');
  const onNew = newVault?.enabled ? () => void newVault.run() : undefined;

  return (
    <CloudVaultsTable
      port={port}
      lang={i18n.language}
      caption={t('cloud.vaults')}
      onNew={onNew}
      isCurrent={canUnlink ? undefined : (v) => v.id === openCloudId}
      onChanged={() => {
        void qc.invalidateQueries({ queryKey: ['account'] });
        if (vault) void useSync.getState().refresh(vault.id);
      }}
    />
  );
}
