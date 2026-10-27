import { beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { loadWorkspace } from './actions';
import { registerNoteFlusher } from './flush';
import { captureWorkspace, parseWorkspaces, upsertWorkspace } from './model';
import { useWorkspaces } from './store';
import { api, linkInfo } from '../app/api';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { allPanes, emptyLayout, openPath, splitPane } from '../workspace/layout';

let mock: WailsMock;
let vaultId = '';
let seq = 0;

async function openVault(files: Record<string, string>): Promise<void> {
  mock = installWailsMock();
  const v = await api.vault.open(`/v/Ws${++seq}`);
  vaultId = v.id;
  for (const [p, c] of Object.entries(files)) mock.vaults.get(v.id)?.files.set(p, c);
  useAppStore.setState({ vault: v, layout: emptyLayout() });
  await waitFor(() => expect(useWorkspaces.getState().loaded).toBe(true));
}

describe('workspaces', () => {
  beforeEach(() => {
    initI18n('en');
    useAppStore.setState({ vault: null, layout: emptyLayout() });
    useSync.setState({ info: {} });
  });

  it('saves to .memobrain/workspaces.json and loads the layout back, dropping missing files', async () => {
    await openVault({ 'A.md': '', 'B.md': '', 'C.md': '' });
    let layout = openPath(emptyLayout(), 'A.md', { mode: 'live' });
    layout = openPath(layout, 'B.md', { mode: 'source', newTab: true });
    layout = splitPane(layout, layout.activePane, 'row', 'live', 'C.md');
    useAppStore.setState({
      layout,
      left: { open: true, tab: 'tags', width: 300 },
      right: { open: true, tab: 'backlinks', width: 250 },
    });
    const s = useAppStore.getState();
    await useWorkspaces
      .getState()
      .update((l) => upsertWorkspace(l, captureWorkspace('Work', s.layout, s.left, s.right)));

    const stored = parseWorkspaces(
      mock.vaults.get(vaultId)?.files.get('.memobrain/workspaces.json') ?? '',
    );
    expect(stored.workspaces.map((w) => w.name)).toEqual(['Work']);

    // Start from a different state, and let C.md disappear before loading.
    useAppStore.setState({
      layout: emptyLayout(),
      left: { open: false, tab: 'files', width: 280 },
      right: { open: false, tab: 'outline', width: 280 },
    });
    mock.vaults.get(vaultId)?.files.delete('C.md');
    await loadWorkspace(stored.workspaces[0]!);

    const after = useAppStore.getState();
    expect(allPanes(after.layout.root).flatMap((p) => p.tabs.map((t) => t.path))).toEqual([
      'A.md',
      'B.md',
    ]);
    expect(after.left).toEqual({ open: true, tab: 'tags', width: 300 });
    expect(after.right).toEqual({ open: true, tab: 'backlinks', width: 250 });
  });

  it('writes pending edits before replacing the layout', async () => {
    await openVault({ 'A.md': '' });
    const order: string[] = [];
    const off = registerNoteFlusher(async () => {
      await Promise.resolve();
      order.push('flushed');
    });
    const orig = useAppStore.getState().setLayout;
    useAppStore.setState({
      setLayout: (l) => {
        order.push('layout');
        orig(l);
      },
    });
    try {
      await loadWorkspace(
        captureWorkspace(
          'X',
          emptyLayout(),
          useAppStore.getState().left,
          useAppStore.getState().right,
        ),
      );
    } finally {
      off();
      useAppStore.setState({ setLayout: orig });
    }
    expect(order).toEqual(['flushed', 'layout']);
  });

  it('refuses to change workspaces of a read-only vault', async () => {
    await openVault({});
    useSync.setState({ info: { [vaultId]: linkInfo({ linked: true, readOnly: true }) } });
    const ok = await useWorkspaces
      .getState()
      .update((l) =>
        upsertWorkspace(
          l,
          captureWorkspace(
            'N',
            emptyLayout(),
            useAppStore.getState().left,
            useAppStore.getState().right,
          ),
        ),
      );
    expect(ok).toBe(false);
    expect(mock.vaults.get(vaultId)?.files.has('.memobrain/workspaces.json')).toBe(false);
  });
});
