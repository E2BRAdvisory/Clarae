import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { api, type Entry } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { flushSettings, useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { allPanes, emptyLayout, openPath } from '../workspace/layout';
import { flushAllNotes } from '../workspaces/flush';
import { useVaultSession } from './useVaultSession';

interface VaultBindings {
  ListTree: (id: string) => Promise<Entry[]>;
  ReadConfig: (id: string, name: string) => Promise<string>;
  WriteConfig: (id: string, name: string, content: string) => Promise<void>;
}
const bindings = (): VaultBindings =>
  (window as unknown as { go: { app: { VaultAPI: VaultBindings } } }).go.app.VaultAPI;

let mock: WailsMock;
let a = '';
let b = '';

/** Makes the binding `name` wait for the vault `vault` until the returned function is called. */
function hold(name: 'ListTree' | 'ReadConfig', vault: string): () => void {
  const api = bindings();
  const original = api[name] as (...args: string[]) => Promise<unknown>;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  (api as unknown as Record<string, unknown>)[name] = async (...args: string[]) => {
    if (args[0] === vault) await gate;
    return original(...args);
  };
  return () => release();
}

const tabPaths = (): string[] =>
  allPanes(useAppStore.getState().layout.root).flatMap((p) => p.tabs.map((t) => t.path));

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  a = (await api.vault.open('/vaults/A')).id;
  b = (await api.vault.open('/vaults/B')).id;
  useAppStore.setState({ layout: emptyLayout() });
  useSettings.getState().reset();
  await flushSettings();
});

afterEach(async () => {
  useSettings.getState().reset();
  await flushSettings();
});

describe('useVaultSession', () => {
  it('does not apply the workspace of a vault that was left while it loaded', async () => {
    const files = mock.vaults.get(a)?.files;
    files?.set('Only in A.md', '# A');
    files?.set(
      '.memobrain/workspace.json',
      JSON.stringify({ layout: openPath(emptyLayout(), 'Only in A.md', { mode: 'live' }) }),
    );
    const release = hold('ListTree', a);
    const listTree = vi.spyOn(api.vault, 'listTree');
    const hook = renderHook(({ id }) => useVaultSession(id), { initialProps: { id: a } });
    await waitFor(() => expect(listTree).toHaveBeenCalledWith(a));

    hook.rerender({ id: b }); // switched while A's file tree was still loading
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(tabPaths()).not.toContain('Only in A.md');
    hook.unmount();
  });

  it('keeps the settings of the vault opened last when an earlier load ends later', async () => {
    mock.vaults.get(a)?.files.set('.memobrain/editor.json', JSON.stringify({ lineNumbers: true }));
    mock.vaults.get(b)?.files.set('.memobrain/editor.json', JSON.stringify({ lineNumbers: false }));
    const release = hold('ReadConfig', a);
    const slow = useSettings.getState().load(a);
    await useSettings.getState().load(b);
    release();
    await slow;
    expect(useSettings.getState().vaultId).toBe(b);
    expect(useSettings.getState().editor.lineNumbers).toBe(false);
  });

  it('saves the workspace even when the settings cannot be read', async () => {
    const original = bindings().ReadConfig;
    bindings().ReadConfig = (id, name) =>
      name === 'editor.json' ? Promise.reject(new Error('io: broken')) : original(id, name);
    const write = vi.spyOn(api.vault, 'writeConfig');
    const hook = renderHook(() => useVaultSession(a));
    await new Promise((r) => setTimeout(r, 20));
    useAppStore.getState().setLayout(openPath(emptyLayout(), 'New.md', { mode: 'live' }));
    await waitFor(() =>
      expect(write.mock.calls.some(([id, name]) => id === a && name === 'workspace.json')).toBe(
        true,
      ),
    );
    hook.unmount();
  });
});

describe('settings writes', () => {
  it('are written at once by a flush, for the vault they belong to', async () => {
    await useSettings.getState().load(a);
    const write = vi.spyOn(api.vault, 'writeConfig');
    useSettings.getState().setEditor({ lineNumbers: true });
    // The vault is switched before the delay: the change still goes to A.
    useSettings.getState().reset();
    await useSettings.getState().load(b);
    useSettings.getState().setEditor({ lineNumbers: false });
    await flushAllNotes();
    const editorWrites = write.mock.calls.filter(([, name]) => name === 'editor.json');
    expect(editorWrites.map(([id]) => id).sort()).toEqual([a, b].sort());
    expect(
      JSON.parse(mock.vaults.get(a)?.files.get('.memobrain/editor.json') ?? '{}'),
    ).toMatchObject({ lineNumbers: true });
    expect(
      JSON.parse(mock.vaults.get(b)?.files.get('.memobrain/editor.json') ?? '{}'),
    ).toMatchObject({ lineNumbers: false });
  });
});
