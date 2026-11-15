import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { api, type VaultInfo } from '../app/api';
import { actionById } from '../commands/actions';
import { commandById, isAvailable, isEnabled, runCommand } from '../commands/registry';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useManaged } from '../state/managed';
import { useSettings } from '../state/settings';
import { activeTab, emptyLayout, openPath } from '../workspace/layout';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { DialogHost } from '../ui/dialogs';
import { confirmedOrigins, confirmOrigin } from './origins';

let mock: WailsMock;
let vault: VaultInfo;

const files = (): Map<string, string> => mock.vaults.get(vault.id)?.files as Map<string, string>;
const webapps = (): string[] => [...files().keys()].filter((p) => p.endsWith('.webapp')).sort();
const enabled = (id: string): boolean => isEnabled(commandById.get(id) as never);
const flag = (on: boolean): void => {
  useManaged.setState({ features: on ? { web_viewer: true } : {} });
};
const open = (path: string): void =>
  useAppStore.setState({
    layout: openPath(useAppStore.getState().layout, path, { mode: 'live', newTab: true }),
  });

beforeEach(async () => {
  mock = installWailsMock();
  initI18n('en');
  configurePlatform();
  useSettings.getState().reset();
  useSync.setState({ info: {} });
  vault = await api.vault.open('/vaults/Apps');
  useAppStore.getState().setVault(vault);
  useAppStore.setState({ layout: emptyLayout() });
  flag(true);
  localStorage.clear();
  render(createElement(DialogHost));
});

/** A dialog left open by a test would be the first the next test sees (the queue lives in the module). */
async function drainDialogs(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const open = screen.queryByRole('dialog');
    if (!open) return;
    const cancel = within(open).queryByRole('button', { name: 'Cancel' });
    act(() => {
      fireEvent.click(cancel ?? within(open).getByRole('button', { name: 'OK' }));
    });
    await Promise.resolve();
  }
}

afterEach(async () => {
  await drainDialogs();
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({ vault: null, layout: emptyLayout() });
  configurePlatform();
});

const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe('which commands are there', () => {
  it('are off with the flag, everywhere', () => {
    flag(false);
    open('GitHub.webapp');
    for (const id of ['app:new', 'app:open', 'app:edit-url', 'app:clear-data'])
      expect(enabled(id), id).toBe(false);
  });

  it('create and change an application with the flag, with or without an embedded browser', () => {
    open('GitHub.webapp');
    for (const platform of [
      {},
      { capabilities: { embeddedBrowser: false } },
      { kind: 'web' as const },
    ]) {
      configurePlatform(platform);
      for (const id of ['app:new', 'app:open', 'app:edit-url', 'app:open-in-browser'])
        expect(isAvailable(commandById.get(id) as never), id).toBe(true);
      for (const id of ['app:new', 'app:open', 'app:edit-url']) expect(enabled(id), id).toBe(true);
    }
  });

  it('need the embedded browser to navigate and to clear the data', () => {
    for (const platform of [
      { capabilities: { embeddedBrowser: false } },
      { kind: 'web' as const },
    ]) {
      configurePlatform(platform);
      for (const id of ['app:back', 'app:forward', 'app:reload', 'app:clear-data'])
        expect(isAvailable(commandById.get(id) as never), id).toBe(false);
    }
    configurePlatform();
    for (const id of ['app:back', 'app:forward', 'app:reload', 'app:clear-data'])
      expect(isAvailable(commandById.get(id) as never), id).toBe(true);
  });

  it('navigate only a tab that has a view', () => {
    open('GitHub.webapp');
    expect(enabled('app:reload')).toBe(false);
    expect(enabled('app:back')).toBe(false);
    expect(enabled('app:forward')).toBe(false);
  });

  it('do not change an application in a vault that may not be changed', () => {
    open('GitHub.webapp');
    useSync.setState({ info: { [vault.id]: { readOnly: true } } as never });
    expect(enabled('app:new')).toBe(false);
    expect(enabled('app:edit-url')).toBe(false);
    // looking is allowed
    expect(enabled('app:open')).toBe(true);
    expect(enabled('app:open-in-browser')).toBe(true);
    expect(enabled('app:clear-data')).toBe(true);
  });

  it('edit and open in the browser only an application in focus', () => {
    open('Note.md');
    expect(enabled('app:edit-url')).toBe(false);
    expect(enabled('app:open-in-browser')).toBe(false);
  });

  it('need a vault', () => {
    useAppStore.getState().setVault(null);
    for (const id of ['app:new', 'app:open', 'app:clear-data']) expect(enabled(id), id).toBe(false);
  });
});

describe('app:new', () => {
  it('asks for an address and a name, writes the file next to the active one and opens it', async () => {
    files().set('Tools/Note.md', '# note');
    open('Tools/Note.md');
    void runCommand('app:new');
    expect(await screen.findByRole('dialog', { name: 'New application' })).toBeInTheDocument();
    fill('Address', 'https://github.com/');
    fill('Name', 'GitHub');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(webapps()).toEqual(['Tools/GitHub.webapp']));
    expect(JSON.parse(files().get('Tools/GitHub.webapp') as string)).toEqual({
      version: 1,
      url: 'https://github.com/',
    });
    expect(activeTab(useAppStore.getState().layout)?.path).toBe('Tools/GitHub.webapp');
  });

  it('names the file after the site, completes the address, and never overwrites', async () => {
    for (const expected of ['example.com.webapp', 'example.com 1.webapp']) {
      void runCommand('app:new');
      await screen.findByRole('dialog', { name: 'New application' });
      fill('Address', 'example.com/start');
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      await waitFor(() => expect(webapps()).toContain(expected));
    }
    expect((JSON.parse(files().get('example.com.webapp') as string) as { url: string }).url).toBe(
      'https://example.com/start',
    );
  });

  it('refuses an address that is not http or https, and keeps asking', async () => {
    void runCommand('app:new');
    await screen.findByRole('dialog', { name: 'New application' });
    for (const [url, message] of [
      ['javascript:alert(1)', /Only http and https/],
      ['file:///etc/passwd', /Only http and https/],
      ['https://user:pw@example.com', /user name or password/],
      ['', /Enter an address/],
    ] as const) {
      fill('Address', url);
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('dialog', { name: 'New application' })).toBeInTheDocument();
    }
    expect(webapps()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(webapps()).toEqual([]);
  });

  it('keeps the name a file can have', async () => {
    void runCommand('app:new');
    await screen.findByRole('dialog', { name: 'New application' });
    fill('Address', 'https://example.com');
    fill('Name', 'a/b: c');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(webapps()).toEqual(['a b c.webapp']));
  });
});

describe('app:edit-url', () => {
  it('changes the address in the file, and says when it differs', async () => {
    files().set('GitHub.webapp', `${JSON.stringify({ version: 1, url: 'https://github.com/' })}\n`);
    open('GitHub.webapp');
    void runCommand('app:edit-url');
    await screen.findByRole('dialog', { name: 'Change the address' });
    expect(screen.getByLabelText('Address')).toHaveValue('https://github.com/');
    fill('Address', 'gitlab.com');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(JSON.parse(files().get('GitHub.webapp') as string) as object).toEqual({
        version: 1,
        url: 'https://gitlab.com',
      }),
    );
  });

  it('does not write what it would not open', async () => {
    const before = `${JSON.stringify({ version: 1, url: 'https://github.com/' })}\n`;
    files().set('GitHub.webapp', before);
    open('GitHub.webapp');
    void runCommand('app:edit-url');
    await screen.findByRole('dialog', { name: 'Change the address' });
    fill('Address', 'data:text/html,<script>alert(1)</script>');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Only http and https/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(files().get('GitHub.webapp')).toBe(before);
  });

  it('repairs a file that cannot be read', async () => {
    files().set('Broken.webapp', 'not json');
    open('Broken.webapp');
    void runCommand('app:edit-url');
    await screen.findByRole('dialog', { name: 'Change the address' });
    expect(screen.getByLabelText('Address')).toHaveValue('');
    fill('Address', 'https://example.com');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect((JSON.parse(files().get('Broken.webapp') as string) as { url: string }).url).toBe(
        'https://example.com',
      ),
    );
  });
});

describe('app:open', () => {
  it('lists the applications of the vault, and opens the one picked', async () => {
    files().set(
      'Tools/GitHub.webapp',
      `${JSON.stringify({ version: 1, url: 'https://github.com/' })}\n`,
    );
    files().set('Jira.webapp', `${JSON.stringify({ version: 1, url: 'https://jira.test/' })}\n`);
    files().set('.trash/Old.webapp', '{}');
    files().set('Note.md', '# note');
    void runCommand('app:open');
    const list = await screen.findByRole('listbox', { name: 'Applications' });
    expect([...list.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Jira',
      'Tools/GitHub',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Tools/GitHub' }));
    await waitFor(() =>
      expect(activeTab(useAppStore.getState().layout)?.path).toBe('Tools/GitHub.webapp'),
    );
  });

  it('says there are none', async () => {
    void runCommand('app:open');
    expect(await screen.findByRole('dialog', { name: 'Applications' })).toHaveTextContent(
      'no applications yet',
    );
  });
});

describe('app:open-in-browser', () => {
  it('opens the address of the file in the system browser', async () => {
    const opened = vi.fn();
    (
      window as unknown as { runtime: { BrowserOpenURL: (u: string) => void } }
    ).runtime.BrowserOpenURL = opened;
    files().set(
      'GitHub.webapp',
      `${JSON.stringify({ version: 1, url: 'https://github.com/x' })}\n`,
    );
    open('GitHub.webapp');
    await runCommand('app:open-in-browser');
    await waitFor(() => expect(opened).toHaveBeenCalledWith('https://github.com/x'));
  });

  it('opens a tab of the browser on the web', async () => {
    configurePlatform({ kind: 'web' });
    const win = vi.spyOn(window, 'open').mockImplementation(() => null);
    files().set(
      'GitHub.webapp',
      `${JSON.stringify({ version: 1, url: 'https://github.com/x' })}\n`,
    );
    open('GitHub.webapp');
    await runCommand('app:open-in-browser');
    await waitFor(() =>
      expect(win).toHaveBeenCalledWith('https://github.com/x', '_blank', 'noopener,noreferrer'),
    );
  });

  it('opens nothing for a file that is not an application', async () => {
    const opened = vi.fn();
    (
      window as unknown as { runtime: { BrowserOpenURL: (u: string) => void } }
    ).runtime.BrowserOpenURL = opened;
    files().set('Bad.webapp', JSON.stringify({ version: 1, url: 'javascript:alert(1)' }));
    open('Bad.webapp');
    void runCommand('app:open-in-browser');
    expect(await screen.findByRole('dialog')).toHaveTextContent('Only http and https');
    expect(opened).not.toHaveBeenCalled();
  });
});

describe('app:clear-data', () => {
  it('asks, deletes the data on this device and forgets the confirmed origins', async () => {
    confirmOrigin(vault.id, 'https://github.com');
    confirmOrigin('other-vault', 'https://github.com');
    void runCommand('app:clear-data');
    const dlg = await screen.findByRole('dialog', { name: 'Clear the data of the applications' });
    expect(dlg).toHaveTextContent('stored on this device');
    fireEvent.click(screen.getByRole('button', { name: 'Clear data' }));
    await waitFor(() => expect(mock.webview.cleared).toEqual([vault.id]));
    await waitFor(() => expect(confirmedOrigins(vault.id)).toEqual([]));
    // the data of another vault are not touched
    expect(confirmedOrigins('other-vault')).toEqual(['https://github.com']);
  });

  it('does nothing when the user says no', async () => {
    confirmOrigin(vault.id, 'https://github.com');
    void runCommand('app:clear-data');
    await screen.findByRole('dialog', { name: 'Clear the data of the applications' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mock.webview.cleared).toEqual([]);
    expect(confirmedOrigins(vault.id)).toEqual(['https://github.com']);
  });

  it('keeps the confirmed origins when the core could not clear the data', async () => {
    confirmOrigin(vault.id, 'https://github.com');
    mock.webview.available = false;
    void runCommand('app:clear-data');
    await screen.findByRole('dialog', { name: 'Clear the data of the applications' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear data' }));
    // the failure is said in a dialog, translated from its code
    expect(await screen.findByText(/not available on this device/)).toBeInTheDocument();
    expect(confirmedOrigins(vault.id)).toEqual(['https://github.com']);
  });
});

describe('removing a mount', () => {
  const mount = (open: string) =>
    ({
      share_id: 's1',
      display_name: 'Shared',
      local: { mounted: true, revoked: false, open_vault_id: open },
    }) as never;

  it('forgets the origins confirmed for it, and only for it', async () => {
    confirmOrigin('mount-vault', 'https://github.com');
    confirmOrigin(vault.id, 'https://github.com');
    const remove = vi.spyOn(api.sharing, 'removeMount').mockResolvedValue({} as never);
    void actionById('mount:remove').run(mount('mount-vault'), { queryClient: new QueryClient() });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('s1', false));
    await waitFor(() => expect(confirmedOrigins('mount-vault')).toEqual([]));
    expect(confirmedOrigins(vault.id)).toEqual(['https://github.com']);
  });

  it('keeps them when the mount is not removed', async () => {
    confirmOrigin('mount-vault', 'https://github.com');
    void actionById('mount:remove').run(mount('mount-vault'), { queryClient: new QueryClient() });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(confirmedOrigins('mount-vault')).toEqual(['https://github.com']);
  });
});
