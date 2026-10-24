import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { FileExplorer } from './FileExplorer';

let mock: WailsMock;
let vaultId: string;

const renderExplorer = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FileExplorer vaultId={vaultId} />
    </QueryClientProvider>,
  );

async function openVault(): Promise<void> {
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  const files = mock.vaults.get(vaultId)!.files;
  files.set('Top.md', 'x');
  files.set('Projects/Alpha/plan.md', 'x');
  files.set('Projects/readme.md', 'x');
  act(() => useAppStore.getState().setVault(info));
}

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  act(() => useAppStore.getState().setVault(null));
  await openVault();
});

describe('file explorer folders', () => {
  it('starts completely closed: only the top level is listed', async () => {
    renderExplorer();
    expect(await screen.findByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Top')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.queryByText('readme')).toBeNull();
  });

  it('keeps what the user opened while the vault stays open, even across a remount', async () => {
    const first = renderExplorer();
    fireEvent.click(await screen.findByText('Projects'));
    expect(await screen.findByText('readme')).toBeInTheDocument();
    expect(screen.queryByText('plan')).toBeNull(); // Alpha is still closed
    first.unmount(); // switching to another sidebar tab unmounts the explorer
    renderExplorer();
    expect(await screen.findByText('readme')).toBeInTheDocument();
  });

  it('closes everything again when the vault is reopened', async () => {
    const first = renderExplorer();
    fireEvent.click(await screen.findByText('Projects'));
    expect(await screen.findByText('readme')).toBeInTheDocument();
    first.unmount();
    act(() => useAppStore.getState().setVault(null));
    await openVault();
    renderExplorer();
    expect(await screen.findByText('Projects')).toBeInTheDocument();
    expect(screen.queryByText('readme')).toBeNull();
  });
});
