import { useTranslation } from 'react-i18next';
import { CloudVaultsTable, MountsList } from '@memobrain/cloud-features';
import { useCloudPort } from '../api/cloud';
import { useWorkbenchAllowed } from '../api/queries';
import { mountHref } from './Shares';
import { VaultExport } from './VaultExport';

/** Where the console sends the creation of a private vault: the browser workbench makes its keys. */
export function privateCreationHref(name: string): string {
  return `/vaults/new/open?kind=private&name=${encodeURIComponent(name)}`;
}

/** A full page load to the workbench (a seam for the tests: jsdom cannot navigate). */
export const navigation = { assign: (href: string) => window.location.assign(href) };

export function VaultsPage() {
  const { t, i18n } = useTranslation();
  const canOpen = useWorkbenchAllowed();
  // The cloud vault lifecycle lives in @memobrain/cloud-features (ADR-0037 §2); a private vault is
  // created in the browser workbench, which holds the Go core's cryptography.
  const port = useCloudPort();

  return (
    <>
      <h1>{t('vaults.title')}</h1>
      <div className="nd-stack">
        <CloudVaultsTable
          port={port}
          lang={i18n.language}
          caption={t('vaults.title')}
          openHref={canOpen ? (v) => `/vaults/${encodeURIComponent(v.id)}/open` : undefined}
          extraColumn={{
            header: t('vaultExport.column'),
            render: (v) => <VaultExport vault={{ id: v.id, name: v.name }} kind={v.kind} />,
          }}
          onCreatePrivate={(name) => navigation.assign(privateCreationHref(name))}
        />
        {/* The shares accepted by the user, each one opened in the workbench as a mount (`?share=`):
            the same list as the workbench's Settings › Sharing (ADR-0045 §7). */}
        <MountsList
          port={port}
          lang={i18n.language}
          hideWhenEmpty
          openHref={canOpen ? (m) => mountHref(m.vault_id, m.share_id) : undefined}
        />
      </div>
    </>
  );
}
