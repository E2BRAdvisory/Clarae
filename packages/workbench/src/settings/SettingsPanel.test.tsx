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

describe('settings, about section', () => {
  beforeEach(async () => {
    initI18n('en');
    installWailsMock();
    const info = await api.vault.open('/vaults/Notes');
    useAppStore.getState().setVault(info);
    act(() => useAppStore.setState({ settingsOpen: true, settingsSection: 'about' }));
  });
  afterEach(() => configurePlatform());

  it('credits the terminal libraries with their versions, creack/pty too on the desktop', async () => {
    renderFiles();
    const text = (await screen.findByText(/Twemoji/)).textContent ?? '';
    expect(text).toMatch(
      /xterm\.js \(@xterm\/xterm 6\.0\.0, @xterm\/addon-fit 0\.11\.0, @xterm\/addon-web-links 0\.12\.0\)/,
    );
    expect(text).toMatch(/creack\/pty \(v1\.1\.24\), MIT licence/);
  });

  it('credits xterm.js alone in the browser, whose build has no pty', async () => {
    configurePlatform({ kind: 'web' });
    renderFiles();
    const text = (await screen.findByText(/Twemoji/)).textContent ?? '';
    expect(text).toMatch(/xterm\.js/);
    expect(text).not.toMatch(/creack/);
  });
});
