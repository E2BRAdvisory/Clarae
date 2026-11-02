import { useTranslation } from 'react-i18next';
import { Table } from '@memobrain/ui';
import { CloudVaultsTable } from '@memobrain/cloud-features';
import { useCloudPort, useSharingAllowed } from '../api/cloud';
import { useShares, useWorkbenchAllowed, type Share } from '../api/queries';
import { mountHref } from './Shares';
import { VaultExport } from './VaultExport';

/** Where the console sends the creation of a private vault: the browser workbench makes its keys. */
export function privateCreationHref(name: string): string {
  return `/vaults/new/open?kind=private&name=${encodeURIComponent(name)}`;
}

/** A full page load to the workbench (a seam for the tests: jsdom cannot navigate). */
export const navigation = { assign: (href: string) => window.location.assign(href) };

/** Shares received and accepted: each one opens in the workbench as a mount (`?share=`). */
function SharedWithMe({ shares }: { shares: Share[] }) {
  const { t } = useTranslation();
  const canOpen = useWorkbenchAllowed();
  return (
    <Table caption={t('vaults.mounts')}>
      <thead>
        <tr>
          <th scope="col">{t('vaults.colName')}</th>
          <th scope="col">{t('vaults.colOwner')}</th>
          {canOpen && (
            <th scope="col">
              <span className="nd-visually-hidden">{t('vaults.open')}</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {shares.map((s) => (
          <tr key={s.id}>
            <th scope="row">{s.display_name}</th>
            <td>{s.owner_name}</td>
            {canOpen && (
              <td>
                {/* A full page load: the workbench has its own HTML and style sheet (ADR-0029). */}
                <a
                  className="nd-button nd-button--small"
                  href={mountHref(s.vault_id, s.id)}
                  aria-label={t('vaults.openAria', { name: s.display_name })}
                >
                  {t('vaults.open')}
                </a>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function VaultsPage() {
  const { t, i18n } = useTranslation();
  const canOpen = useWorkbenchAllowed();
  // The cloud vault lifecycle lives in @memobrain/cloud-features (ADR-0037 §2); a private vault is
  // created in the browser workbench, which holds the Go core's cryptography.
  const port = useCloudPort();
  const sharingOn = useSharingAllowed();
  const received = useShares('received');
  const mounts = sharingOn ? (received.data ?? []).filter((s) => s.my_status === 'accepted') : [];

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
        {mounts.length > 0 && <SharedWithMe shares={mounts} />}
      </div>
    </>
  );
}
