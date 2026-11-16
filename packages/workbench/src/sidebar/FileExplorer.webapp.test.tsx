import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useManaged } from '../state/managed';
import { queryClient } from '../state/queryClient';
import { selectActivePath, useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { DialogHost } from '../ui/dialogs';
import { emptyLayout } from '../workspace/layout';
import { display, FileExplorer } from './FileExplorer';

let mock: WailsMock;
let vaultId: string;

const files = (): Map<string, string> => mock.vaults.get(vaultId)!.files;
const webapps = (): string[] => [...files().keys()].filter((p) => p.endsWith('.webapp')).sort();

// The app's own query client: the actions refresh the tree through it (invalidateVault).
const renderExplorer = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <DialogHost />
      <FileExplorer vaultId={vaultId} />
    </QueryClientProvider>,
  );

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  queryClient.clear();
  configurePlatform();
  useSync.setState({ info: {} });
  useManaged.setState({ features: {} });
  act(() => useAppStore.getState().setVault(null));
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  files().set('Top.md', 'x');
  files().set('Projects/plan.md', 'x');
  files().set('Projects/Road.webapp', '{"version":1,"url":"https://example.com/"}');
  act(() => {
    useAppStore.getState().setVault(info);
    useAppStore.setState({ layout: emptyLayout() });
  });
});

afterEach(() => {
  cleanup();
  useManaged.setState({ features: {} });
});

const newApplicationButton = () => screen.queryByRole('button', { name: 'New application' });

async function fillTheForm(url: string, name: string): Promise<void> {
  expect(await screen.findByRole('dialog', { name: 'New application' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: url } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
}

describe('the explorer and applications', () => {
  it('shows an application without its extension', async () => {
    renderExplorer();
    fireEvent.click(await screen.findByText('Projects'));
    expect(await screen.findByText('Road')).toBeInTheDocument();
    expect(screen.queryByText('Road.webapp')).toBeNull();
    expect(display({ name: 'Road.webapp', isDir: false } as never)).toBe('Road');
    expect(display({ name: 'Road.WEBAPP', isDir: false } as never)).toBe('Road');
    expect(display({ name: 'a.webapp', isDir: true } as never)).toBe('a.webapp'); // a folder keeps its name
    expect(display({ name: 'plan.md', isDir: false } as never)).toBe('plan');
    expect(display({ name: 'pic.png', isDir: false } as never)).toBe('pic.png');
  });

  it('has a toolbar button that creates an application in the folder of the row in focus', async () => {
    renderExplorer();
    fireEvent.click(await screen.findByText('Projects'));
    await screen.findByText('plan');
    fireEvent.click(screen.getByText('plan')); // a file: its folder is the target
    fireEvent.click(newApplicationButton()!);
    await fillTheForm('https://github.com/', 'GitHub');
    await waitFor(() => expect(webapps()).toContain('Projects/GitHub.webapp'));
    expect(JSON.parse(files().get('Projects/GitHub.webapp')!)).toEqual({
      version: 1,
      url: 'https://github.com/',
    });
    // it opens in a tab, and the explorer lists it without the extension
    await waitFor(() =>
      expect(selectActivePath(useAppStore.getState())).toBe('Projects/GitHub.webapp'),
    );
    expect(await screen.findByText('GitHub')).toBeInTheDocument();
  });

  it('creates it at the top of the vault when nothing is in focus', async () => {
    renderExplorer();
    await screen.findByText('Projects');
    fireEvent.click(newApplicationButton()!);
    await fillTheForm('https://example.org/', 'Top app');
    await waitFor(() => expect(webapps()).toContain('Top app.webapp'));
  });

  it('offers the same entry in the menu of a folder and in the one of the empty space', async () => {
    renderExplorer();
    const folder = await screen.findByText('Projects');
    fireEvent.contextMenu(folder);
    fireEvent.click(within(await screen.findByRole('menu')).getByText('New application'));
    await fillTheForm('https://github.com/', 'FromMenu');
    await waitFor(() => expect(webapps()).toContain('Projects/FromMenu.webapp'));

    fireEvent.contextMenu(screen.getByRole('tree'));
    fireEvent.click(within(await screen.findByRole('menu')).getByText('New application'));
    await fillTheForm('https://github.com/', 'FromEmpty');
    await waitFor(() => expect(webapps()).toContain('FromEmpty.webapp'));
  });

  it('is not offered when the profile turns applications off', async () => {
    useManaged.setState({ features: { web_viewer: false } });
    renderExplorer();
    fireEvent.contextMenu(await screen.findByText('Projects'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText('New application')).toBeNull();
    expect(within(menu).getByText('New note')).toBeInTheDocument();
    expect(newApplicationButton()).toBeNull();
  });

  it('is not offered in a vault that may not be changed', async () => {
    useSync.setState({ info: { [vaultId]: { readOnly: true } } as never });
    renderExplorer();
    await screen.findByText('Projects');
    expect(newApplicationButton()).toBeNull();
    expect(screen.queryByText('New application')).toBeNull();
  });
});
