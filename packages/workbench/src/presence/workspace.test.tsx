// The panes of the workspace hold the watches (ADR-0065): the tab in front of each pane is watched, and the
// watch follows the tab, the file, the split and the vault. The note of each is the real editor.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useManaged } from '../state/managed';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { emptyLayout } from '../workspace/layout';
import { WorkspaceView } from '../workspace/WorkspaceView';

beforeAll(() => {
  const none = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] };
  Range.prototype.getClientRects = () => none;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

let mock: WailsMock;
let vaultId = '';
const watches = (path: string): number => mock.presence.watching(vaultId, path);

beforeEach(async () => {
  initI18n('en');
  useSettings.getState().reset();
  mock = installWailsMock();
  configurePlatform();
  useManaged.setState({ features: {} });
  const info = await api.vault.open('/vaults/Shared');
  vaultId = info.id;
  const files = mock.vaults.get(vaultId)!.files;
  files.set('A.md', '# A');
  files.set('B.md', '# B');
  files.set('Map.canvas', '{"nodes":[],"edges":[]}');
  mock.sync.links.set(vaultId, { linked: true, kind: 'shared' } as never);
  useSync.setState({ info: { [vaultId]: { linked: true, kind: 'shared' } as never } });
  useAppStore.setState({ layout: emptyLayout(), searchQuery: '' });
  useAppStore.getState().setVault(info);
});
afterEach(cleanup);

const mount = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceView vaultId={vaultId} />
    </QueryClientProvider>,
  );

describe('the watches of the workspace', () => {
  it('watches the tab in front and follows it to another file, then ends with the view', async () => {
    useAppStore.getState().openNote('A.md');
    const { unmount } = mount();
    await waitFor(() => expect(watches('A.md')).toBe(1));
    act(() => useAppStore.getState().openNote('B.md')); // the tab in front shows another file
    await waitFor(() => expect(watches('B.md')).toBe(1));
    expect(watches('A.md')).toBe(0);
    unmount();
    expect(watches('B.md')).toBe(0);
  });

  it('counts the same file in two panes, and a tab that goes to the background is not watched', async () => {
    useAppStore.getState().openNote('A.md');
    mount();
    await waitFor(() => expect(watches('A.md')).toBe(1));
    act(() => useAppStore.getState().openNote('A.md', { split: 'row' }));
    await waitFor(() => expect(watches('A.md')).toBe(2));
    act(() => useAppStore.getState().openNote('B.md', { newTab: true })); // the focused pane has B in front now
    await waitFor(() => expect(watches('B.md')).toBe(1));
    expect(watches('A.md')).toBe(1); // the other pane still shows it
  });

  it('watches any kind of file, not only notes (a canvas has avatars too)', async () => {
    useAppStore.getState().openNote('Map.canvas');
    mount();
    await waitFor(() => expect(watches('Map.canvas')).toBe(1));
  });

  it('watches nothing in a vault that is not a shared one, or when the profile turns it off', async () => {
    useSync.setState({ info: { [vaultId]: { linked: true, kind: 'private' } as never } });
    useAppStore.getState().openNote('A.md');
    const { unmount } = mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(mock.presence.log).toEqual([]);
    unmount();
    useSync.setState({ info: { [vaultId]: { linked: true, kind: 'shared' } as never } });
    useManaged.setState({ features: { presence: false } });
    mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(mock.presence.log).toEqual([]);
  });

  it('stops watching at once when the profile turns presence off while it is on screen', async () => {
    useAppStore.getState().openNote('A.md');
    mount();
    await waitFor(() => expect(watches('A.md')).toBe(1));
    act(() => useManaged.setState({ features: { presence: false } }));
    await waitFor(() => expect(watches('A.md')).toBe(0));
  });
});
