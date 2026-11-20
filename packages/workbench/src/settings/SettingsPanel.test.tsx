import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPanel } from './SettingsPanel';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useSettings } from '../state/settings';
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

describe('settings, appearance section', () => {
  beforeEach(async () => {
    initI18n('en');
    installWailsMock();
    const info = await api.vault.open('/vaults/Notes');
    useAppStore.getState().setVault(info);
    await useSettings.getState().load(info.id);
    act(() => useAppStore.setState({ settingsOpen: true, settingsSection: 'appearance' }));
  });
  afterEach(() => {
    configurePlatform();
    useSettings.getState().reset();
  });

  it('has the terminal font, MesloLGS NF by default, after the size of the interface font', async () => {
    renderFiles();
    const field = await screen.findByLabelText('Terminal font');
    expect(field).toHaveValue('MesloLGS NF');
    expect(field).toHaveAttribute('placeholder', 'MesloLGS NF');
    const labels = [...document.querySelectorAll('.settings-body label')].map((l) => l.textContent);
    expect(labels.indexOf('Terminal font')).toBe(labels.indexOf('Interface font size') + 1);
  });

  it('saves what is typed with the other appearance settings, and an empty value is the default font', async () => {
    renderFiles();
    const field = await screen.findByLabelText('Terminal font');
    fireEvent.change(field, { target: { value: 'Fira Code' } });
    expect(useSettings.getState().appearance.terminalFont).toBe('Fira Code');
    expect(useSettings.getState().user.appearance).toMatchObject({ terminalFont: 'Fira Code' });
    fireEvent.change(field, { target: { value: '' } });
    expect(useSettings.getState().appearance.terminalFont).toBe('');
    expect(field).toHaveValue('');
  });

  it('has no terminal font in the browser, which has no terminal', async () => {
    configurePlatform({ kind: 'web' });
    renderFiles();
    await screen.findByLabelText('Interface font size');
    expect(screen.queryByLabelText('Terminal font')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Terminal font size')).not.toBeInTheDocument();
  });

  it('has the terminal font size, 13 by default, right after the font', async () => {
    renderFiles();
    const field = await screen.findByLabelText('Terminal font size');
    expect(field).toHaveValue(13);
    expect(field).toHaveAttribute('min', '8');
    expect(field).toHaveAttribute('max', '32');
    const labels = [...document.querySelectorAll('.settings-body label')].map((l) => l.textContent);
    expect(labels.indexOf('Terminal font size')).toBe(labels.indexOf('Terminal font') + 1);
  });

  it('saves the size typed, kept between 8 and 32, and a field that is not a number is the default', async () => {
    renderFiles();
    const field = await screen.findByLabelText('Terminal font size');
    const size = () => useSettings.getState().appearance.terminalFontSize;
    fireEvent.change(field, { target: { value: '18' } });
    expect(size()).toBe(18);
    expect(useSettings.getState().user.appearance).toMatchObject({ terminalFontSize: 18 });
    fireEvent.change(field, { target: { value: '99' } });
    expect(size()).toBe(32);
    fireEvent.change(field, { target: { value: '3' } });
    expect(size()).toBe(8);
    fireEvent.change(field, { target: { value: '' } });
    expect(size()).toBe(13);
  });
});
