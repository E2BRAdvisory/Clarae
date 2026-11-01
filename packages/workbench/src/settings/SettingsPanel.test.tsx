import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPanel } from './SettingsPanel';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useAppStore } from '../state/store';
import { installWailsMock } from '../test/wails-mock';

function renderFiles() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SettingsPanel />
    </QueryClientProvider>,
  );
}

describe('settings, files section', () => {
  beforeEach(async () => {
    initI18n('en');
    installWailsMock();
    const info = await api.vault.open('/vaults/Notes');
    useAppStore.getState().setVault(info);
    act(() => useAppStore.setState({ settingsOpen: true, settingsSection: 'files' }));
  });
  afterEach(() => configurePlatform());

  it('lets the desktop choose the system trash', async () => {
    renderFiles();
    expect(await screen.findByLabelText('Deleted files go to')).toBeInTheDocument();
  });

  it('has no trash choice in the browser, which always uses the vault trash', async () => {
    configurePlatform({ kind: 'web' });
    renderFiles();
    await screen.findByRole('textbox', { name: /attachment/i });
    expect(screen.queryByLabelText('Deleted files go to')).not.toBeInTheDocument();
  });
});
