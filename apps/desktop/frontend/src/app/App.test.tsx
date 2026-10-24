import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { api } from './api';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

describe('App shell', () => {
  it('shows the welcome screen with recent vaults', async () => {
    initI18n('en');
    installWailsMock({
      recent: [{ id: 'abc', name: 'Work', path: '/home/me/Work', lastOpenedAt: new Date() }],
    });
    useAppStore.getState().setVault(null);
    renderApp();
    expect(await screen.findByText('Open a vault')).toBeInTheDocument();
    expect(await screen.findByText('Work')).toBeInTheDocument();
  });

  it('opens a vault and lists its files', async () => {
    initI18n('en');
    const mock = installWailsMock();
    const info = await api.vault.open('/vaults/Demo');
    mock.vaults.get(info.id)?.files.set('Notes/today.md', '# Today');
    useAppStore.getState().setVault(info);
    renderApp();
    await waitFor(() => expect(screen.getByText('today')).toBeInTheDocument());
    expect(screen.getByText('Notes')).toBeInTheDocument();
  });
});
