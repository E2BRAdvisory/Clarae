import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatsPanel } from './StatsPanel';
import { api, linkInfo } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { emptyLayout } from '../workspace/layout';

let mock: WailsMock;
let vaultId = '';

function panel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StatsPanel vaultId={vaultId} />
    </QueryClientProvider>,
  );
}

const row = (label: string): HTMLElement | null => {
  const dt = screen.queryByText(label, { selector: 'dt' });
  return (dt?.nextElementSibling as HTMLElement | null) ?? null;
};

describe('Statistics tab', () => {
  beforeEach(async () => {
    initI18n('en');
    mock = installWailsMock();
    const info = await api.vault.open('/vaults/Stats');
    vaultId = info.id;
    mock.vaults
      .get(vaultId)
      ?.files.set('Home.md', '---\ncreated: 2025-05-04\n---\n# Home\nhello brave world\n## Next\n');
    useAppStore.setState({ layout: emptyLayout(), stats: null });
    useAppStore.getState().setVault(info);
    useAppStore.getState().openNote('Home.md');
    useSync.setState({ info: {} });
  });

  it('shows the figures of a note on a local vault', async () => {
    panel();
    expect(await screen.findByText('Not shared')).toBeInTheDocument();
    // the note text loads after the first render
    await waitFor(() => expect(row('Words')).toHaveTextContent('5'));
    expect(row('Headings')).toHaveTextContent('2');
    expect(row('Versions (this device)')).toHaveTextContent('0');
    expect(screen.queryByText('Versions (cloud)')).toBeNull();
    expect(row('Created')?.textContent).toBe('May 4, 2025'); // frontmatter, no time of day
    expect(row('Author')).toHaveTextContent('You');
  });

  it('shows the cloud versions, the last editor and the recipients on a shared vault', async () => {
    const path = 'Home.md';
    mock.sync.history.set(`${vaultId}|${path}`, [
      {
        rev: 2,
        op: 'put',
        path,
        size: 9,
        authorId: 'u2',
        deviceId: 'd',
        time: '2026-02-01T00:00:00Z',
        hasContent: true,
        mine: false,
      },
      {
        rev: 1,
        op: 'put',
        path,
        size: 9,
        authorId: 'u1',
        deviceId: 'd',
        time: '2026-01-01T00:00:00Z',
        hasContent: true,
        mine: true,
      },
    ]);
    mock.sharing.owned.push({
      id: 's1',
      vaultId: 'cloud-1',
      vaultName: 'Docs',
      resourceType: 'vault',
      pathPrefix: '',
      displayName: 'Docs',
      ownerId: 'u-me',
      ownerName: 'me',
      createdAt: '2026-01-01T00:00:00Z',
      expiresAt: '',
      myPermission: 'manager',
      myStatus: '',
      grants: [
        {
          principalType: 'user',
          principalId: 'u2',
          principalName: 'Ada',
          permission: 'editor',
          status: 'accepted',
        },
        {
          principalType: 'group',
          principalId: 'g1',
          principalName: 'Team',
          permission: 'viewer',
          status: 'accepted',
        },
      ],
    });
    const link = linkInfo({
      linked: true,
      kind: 'shared',
      cloudVaultId: 'cloud-1',
      permission: 'owner',
    });
    mock.sync.links.set(vaultId, link); // the mock lists the shares of the vault's cloud copy
    useSync.setState({ info: { [vaultId]: link } });
    panel();
    expect(await screen.findByText('Team')).toBeInTheDocument();
    expect(row('Versions (cloud)')).toHaveTextContent('2');
    expect(row('Author')).toHaveTextContent('Ada');
    expect(screen.getByText('Ada', { selector: '.item' })).toBeInTheDocument();
  });

  it('says who shared a mount and that a private vault cannot be shared', async () => {
    useSync.setState({
      info: {
        [vaultId]: linkInfo({
          linked: true,
          kind: 'shared',
          mount: true,
          ownerName: 'Ada',
          permission: 'viewer',
        }),
      },
    });
    const { unmount } = panel();
    expect(await screen.findByText('Shared by Ada (Viewer)')).toBeInTheDocument();
    unmount();

    useSync.setState({ info: { [vaultId]: linkInfo({ linked: true, kind: 'private' }) } });
    panel();
    expect(await screen.findByText('Private vault: not shareable')).toBeInTheDocument();
  });
});
