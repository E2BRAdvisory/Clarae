// Call counts of the vault:file-changed handling (tree refetches, link resolutions, backlinks
// queries) for the scenarios that used to cause an invalidation storm. The numbers are printed
// and asserted against budgets, so a regression shows up as a failing test. Before the
// coalesced, typed handling (fileChanges.ts) they were:
//   (a) 20 autosaves:            listTree 20,  resolve 1000, backlinks 20
//   (b) 200 sync modify events:  listTree 200, resolve 50,   backlinks 200
//   (c) create + rename + delete: listTree 3,  resolve 150,  backlinks 3
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { api } from './api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { emptyLayout } from '../workspace/layout';
import { useSettings } from '../state/settings';

type Counts = { listTree: number; resolve: number; backlinks: number; readNote: number };
type ChangeType = 'create' | 'modify' | 'delete';

const LINKS = 50;
declare const process: { stderr: { write(s: string): boolean } };
// Vitest swallows console output of passing tests here: write the figures straight to stderr.
const report = (...parts: unknown[]): void => void process.stderr.write(parts.join(' ') + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(() => sleep(15));
}

let mock: WailsMock;
let vaultId: string;
let counts: Counts;
let qc: QueryClient;

function count(api: Record<string, (...a: unknown[]) => unknown>, name: string, key: keyof Counts) {
  const orig = api[name] as (...a: unknown[]) => unknown;
  api[name] = (...a: unknown[]) => {
    counts[key]++;
    return orig(...a);
  };
}

/** The payload the Go core emits after a watcher batch (paths, plus the typed changes). */
function emit(changes: { type: ChangeType; path: string }[]): void {
  const files = mock.vaults.get(vaultId)?.files;
  act(() =>
    mock.emit('vault:file-changed', {
      vaultId,
      paths: changes.map((c) => c.path),
      changes: changes.map((c) => ({
        type: c.type,
        path: c.path,
        ...(c.type === 'delete'
          ? {}
          : {
              entry: {
                path: c.path,
                name: c.path.split('/').pop(),
                isDir: false,
                kind: 'md',
                size: files?.get(c.path)?.length ?? 0,
                mtime: new Date().toISOString(),
              },
            }),
      })),
    }),
  );
}

beforeEach(async () => {
  initI18n('en');
  useSettings.getState().reset();
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Perf');
  vaultId = info.id;
  const files = mock.vaults.get(vaultId)?.files;
  // Five links per line, so all of them are inside the (jsdom) viewport.
  const body = Array.from({ length: LINKS / 5 }, (_, l) =>
    Array.from({ length: 5 }, (_, i) => `[[L${l * 5 + i}]]`).join(' '),
  ).join('\n');
  files?.set('Host.md', `# Host\n${body}\n`);
  for (let i = 0; i < LINKS; i++) files?.set(`L${i}.md`, `# L${i}\n`);
  for (let i = 0; i < 200; i++) files?.set(`Sync/N${i}.md`, `# N${i}\n`);
  counts = { listTree: 0, resolve: 0, backlinks: 0, readNote: 0 };
  const go = (window as unknown as { go: { app: Record<string, Record<string, never>> } }).go.app;
  count(go['VaultAPI'] as never, 'ListTree', 'listTree');
  count(go['LinksAPI'] as never, 'Resolve', 'resolve');
  count(go['LinksAPI'] as never, 'Backlinks', 'backlinks');
  count(go['VaultAPI'] as never, 'ReadNote', 'readNote');
  useAppStore.setState({
    layout: emptyLayout(),
    searchQuery: '',
    paletteOpen: false,
    switcherOpen: false,
    settingsOpen: false,
  });
  useAppStore.getState().setVault(info);
  useAppStore.getState().openNote('Host.md');
  useAppStore.getState().setRight({ open: true, tab: 'links' });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  await screen.findByLabelText('Note editor');
  await waitFor(() => expect(counts.resolve).toBe(LINKS));
  await settle();
  await settle();
});

afterEach(() => {
  useAppStore.getState().setVault(null);
});

function snapshot(): Counts {
  const c = { ...counts };
  counts = { listTree: 0, resolve: 0, backlinks: 0, readNote: 0 };
  return c;
}

describe('vault:file-changed call counts', () => {
  it('(a) 20 autosaves of the open note with 50 visible links', async () => {
    snapshot();
    const files = mock.vaults.get(vaultId)?.files;
    for (let i = 0; i < 20; i++) {
      files?.set('Host.md', (files.get('Host.md') ?? '') + `x${i}\n`);
      emit([{ type: 'modify', path: 'Host.md' }]);
      await settle(4);
    }
    const c = snapshot();
    report('[perf a] 20 autosaves:', JSON.stringify(c));
    expect(c.listTree).toBe(0);
    expect(c.resolve).toBe(0);
    // The note's own outgoing links changed: its Links panel reloads, once per save.
    expect(c.backlinks).toBeLessThanOrEqual(20);
    // The editor still hears about every change of its file (external-change check).
    expect(c.readNote).toBeGreaterThanOrEqual(20);
  });

  it('(b) a burst of 200 sync modify events', async () => {
    snapshot();
    for (let i = 0; i < 200; i++) emit([{ type: 'modify', path: `Sync/N${i}.md` }]);
    await settle(10);
    const c = snapshot();
    report('[perf b] 200 modify events:', JSON.stringify(c));
    expect(c.listTree).toBe(0);
    expect(c.resolve).toBe(0);
    expect(c.backlinks).toBeLessThanOrEqual(2);
  });

  it('(c) create + rename + delete', async () => {
    snapshot();
    const files = mock.vaults.get(vaultId)?.files;
    files?.set('New.md', '# New\n');
    emit([{ type: 'create', path: 'New.md' }]);
    await settle();
    files?.set('L1b.md', files.get('L1.md') ?? '');
    files?.delete('L1.md');
    emit([
      { type: 'delete', path: 'L1.md' },
      { type: 'create', path: 'L1b.md' },
    ]);
    await settle();
    files?.delete('L2.md');
    emit([{ type: 'delete', path: 'L2.md' }]);
    await settle();
    const c = snapshot();
    report('[perf c] create+rename+delete:', JSON.stringify(c));
    expect(c.listTree).toBe(0);
    // Only the links that pointed at the renamed and the deleted note are resolved again.
    expect(c.resolve).toBe(2);
    expect(c.backlinks).toBeLessThanOrEqual(3);
    const tree = (qc.getQueryData<{ path: string }[]>(['tree', vaultId]) ?? []).map((e) => e.path);
    expect(tree).toEqual(expect.arrayContaining(['New.md', 'L1b.md', 'L0.md']));
    expect(tree).not.toContain('L1.md');
    expect(tree).not.toContain('L2.md');
  });
});
