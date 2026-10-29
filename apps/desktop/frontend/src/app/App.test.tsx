import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { api } from './api';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { emptyLayout, allPanes } from '../workspace/layout';
import { useSettings } from '../state/settings';

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
    // Folders start closed: the nested note appears only once its folder is opened.
    await waitFor(() => expect(screen.getByText('Notes')).toBeInTheDocument());
    expect(screen.queryByText('today')).toBeNull();
    fireEvent.click(screen.getByText('Notes'));
    await waitFor(() => expect(screen.getByText('today')).toBeInTheDocument());
  });

  describe('with a vault open', () => {
    async function openDemo() {
      initI18n('en');
      const mock = installWailsMock();
      const info = await api.vault.open('/vaults/Demo');
      const files = mock.vaults.get(info.id)?.files;
      files?.set('Home.md', '---\nstatus: draft\n---\n# Home\nSee [[Ideas]]');
      files?.set('Ideas.md', '# Ideas\nA #seed');
      useAppStore.setState({
        layout: emptyLayout(),
        searchQuery: '',
        paletteOpen: false,
        switcherOpen: false,
        settingsOpen: false,
      });
      useAppStore.getState().setVault(info);
      return { mock, info };
    }
    beforeEach(() => useSettings.getState().reset());

    it('opens a note from the file tree into a tab', async () => {
      await openDemo();
      renderApp();
      fireEvent.click(await screen.findByText('Home'));
      expect(await screen.findByRole('tab', { name: /Home/ })).toBeInTheDocument();
      expect(await screen.findByLabelText('Note editor')).toBeInTheDocument();
      expect(useAppStore.getState().layout.root).toMatchObject({ kind: 'pane' });
    });

    it('shows the typed properties of the note in the Properties sidebar tab', async () => {
      await openDemo();
      useAppStore.getState().openNote('Home.md');
      useAppStore.getState().setRight({ open: true, tab: 'properties' });
      renderApp();
      expect(await screen.findByTitle('status')).toBeInTheDocument();
      expect(screen.getByDisplayValue('draft')).toBeInTheDocument();
    });

    it('lists the links of the note in the Links tab, and the headings in Statistics', async () => {
      await openDemo();
      useAppStore.getState().openNote('Home.md');
      useAppStore.getState().setRight({ open: true, tab: 'links' });
      renderApp();
      const section = await screen.findByRole('region', { name: 'Links' });
      expect(await within(section).findByText('Ideas')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Statistics' }));
      expect(await screen.findByText('Headings')).toBeInTheDocument();
    });

    it('shows the vault status in the header only while the right sidebar is closed', async () => {
      await openDemo();
      useAppStore.getState().setRight({ open: false });
      renderApp();
      await screen.findByRole('tab', { name: 'Files' });
      expect(document.querySelector('.titlebar .vault-status')).not.toBeNull();
      expect(document.querySelector('.sidebar.right')).toBeNull();
      useAppStore.getState().setRight({ open: true });
      await waitFor(() =>
        expect(document.querySelector('.sidebar.right .vault-status')).not.toBeNull(),
      );
      expect(document.querySelector('.titlebar .vault-status')).toBeNull();
    });

    it('switches a note to reading view with the mode toggle', async () => {
      await openDemo();
      useAppStore.getState().openNote('Home.md');
      renderApp();
      fireEvent.click(await screen.findByRole('button', { name: 'Reading' }));
      const link = await screen.findByText('Ideas', { selector: 'a.wikilink' });
      expect(link).toBeInTheDocument();
    });

    it('opens the command palette with the hotkey and runs a command', async () => {
      await openDemo();
      useAppStore.getState().openNote('Home.md');
      renderApp();
      fireEvent.keyDown(window, { key: 'p', code: 'KeyP', ctrlKey: true });
      const input = await screen.findByPlaceholderText('Type a command…');
      fireEvent.change(input, { target: { value: 'split right' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(allPanes(useAppStore.getState().layout.root)).toHaveLength(2));
    });

    it('quick switcher opens an existing note and offers to create a missing one', async () => {
      const { mock, info } = await openDemo();
      renderApp();
      useAppStore.getState().setSwitcherOpen(true);
      const input = await screen.findByPlaceholderText('Find or create a note…');
      fireEvent.change(input, { target: { value: 'idea' } });
      await screen.findByRole('option', { name: /Ideas/ });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() =>
        expect(useAppStore.getState().layout.root).toMatchObject({ tabs: [{ path: 'Ideas.md' }] }),
      );

      useAppStore.getState().setSwitcherOpen(true);
      const input2 = await screen.findByPlaceholderText('Find or create a note…');
      fireEvent.change(input2, { target: { value: 'Brand new' } });
      fireEvent.click(await screen.findByText('Create "Brand new"'));
      await waitFor(() => expect(mock.vaults.get(info.id)?.files.has('Brand new.md')).toBe(true));
    });

    it('lists tags and filters the vault by tag when clicked', async () => {
      await openDemo();
      useAppStore.getState().setRight({ open: true, tab: 'tags' });
      renderApp();
      fireEvent.click(await screen.findByText('#seed'));
      await waitFor(() => expect(useAppStore.getState().searchQuery).toBe('tag:#seed'));
      expect(useAppStore.getState().left.tab).toBe('search');
    });

    it('opens settings on the requested section', async () => {
      await openDemo();
      renderApp();
      useAppStore.getState().openSettings('hotkeys');
      expect(await screen.findByPlaceholderText('Filter commands…')).toBeInTheDocument();
    });
  });
});
