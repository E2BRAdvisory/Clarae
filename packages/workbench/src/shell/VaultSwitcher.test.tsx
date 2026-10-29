import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VaultSwitcher } from './VaultSwitcher';
import { openVaultAt } from '../app/actions';
import { api, linkInfo } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { runCommand } from '../commands/registry';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { allPanes, emptyLayout, openPath } from '../workspace/layout';

let mock: WailsMock;
let vaultId = '';

async function setup() {
  initI18n('en');
  mock = installWailsMock({
    recent: [
      { id: 'a', name: 'Work', path: '/vaults/Work', lastOpenedAt: new Date() },
      { id: 'b', name: 'Home', path: '/vaults/Home', lastOpenedAt: new Date() },
      { id: 'c', name: 'Journal', path: '/vaults/Journal', lastOpenedAt: new Date() },
    ],
  });
  const info = await api.vault.open('/vaults/Work');
  vaultId = info.id;
  const files = mock.vaults.get(vaultId)?.files;
  files?.set('A.md', '# A');
  files?.set('B.md', '# B');
  files?.set('img.png', 'x');
  useAppStore.setState({ layout: emptyLayout(), vaultMenuOpen: false });
  useAppStore.getState().setVault(info);
  useSync.setState({ info: {} });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <VaultSwitcher vaultId={vaultId} />
    </QueryClientProvider>,
  );
}

describe('vault switcher', () => {
  beforeEach(async () => {
    await setup();
  });

  it('shows the vault name and how many notes it has (not other files)', async () => {
    const button = await screen.findByRole('button', { name: /Switch vault/ });
    expect(button).toHaveTextContent('Work');
    await waitFor(() => expect(button).toHaveTextContent('2 notes'));
  });

  it('opens a menu of the recent vaults, without the current one, and switches', async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Switch vault/ }));
    expect(await screen.findByRole('menuitem', { name: '✓ Work' })).toBeDisabled();
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      '✓ Work',
      'Home',
      'Journal',
      'Open another folder…',
      'Close vault',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Home' }));
    await waitFor(() => expect(useAppStore.getState().vault?.path).toBe('/vaults/Home'));
    expect(mock.vaults.has(vaultId)).toBe(false); // the previous one is closed
  });

  it('opens when the command `vault:switch` asks for it', async () => {
    await act(async () => {
      await runCommand('vault:switch');
    });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(useAppStore.getState().vaultMenuOpen).toBe(false); // the request is consumed
  });

  it('says whether the vault is private or shared once it is connected', async () => {
    act(() => {
      useSync.setState({ info: { [vaultId]: linkInfo({ linked: true, kind: 'private' }) } });
    });
    expect(await screen.findByText('Private')).toBeInTheDocument();
    act(() => {
      useSync.setState({ info: { [vaultId]: linkInfo({ linked: true, kind: 'shared' }) } });
    });
    expect(await screen.findByText('Shared')).toBeInTheDocument();
  });
});

describe('openVaultAt', () => {
  beforeEach(async () => {
    await setup();
  });

  it('saves the workspace of the vault it leaves, before the store is reset', async () => {
    useAppStore.setState({ layout: openPath(emptyLayout(), 'A.md', { mode: 'live' }) });
    const write = vi.spyOn(api.vault, 'writeConfig');
    await openVaultAt('/vaults/Home');
    const call = write.mock.calls.find(([id, name]) => id === vaultId && name === 'workspace.json');
    expect(call).toBeDefined();
    const saved = JSON.parse(call?.[2] ?? '{}') as {
      layout: { root: { tabs: { path: string }[] } };
    };
    expect(saved.layout.root.tabs.map((t) => t.path)).toEqual(['A.md']);
    expect(useAppStore.getState().vault?.path).toBe('/vaults/Home');
    // the store was reset only after saving: no tab of the old vault is left
    expect(allPanes(useAppStore.getState().layout.root).flatMap((p) => p.tabs)).toEqual([]);
    write.mockRestore();
  });

  it('does nothing when the vault is already open', async () => {
    useAppStore.setState({ layout: openPath(emptyLayout(), 'A.md', { mode: 'live' }) });
    const before = useAppStore.getState().layout;
    await openVaultAt('/vaults/Work');
    expect(useAppStore.getState().layout).toBe(before);
    expect(useAppStore.getState().vault?.id).toBe(vaultId);
  });
});
