import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, type UnsentItem } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, unsentCount, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { DialogHost } from '../ui/dialogs';
import { SyncSection } from './SyncSection';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
    <DialogHost />
  </QueryClientProvider>
);

let mock: WailsMock;
let vaultId: string;

const item = (over: Partial<UnsentItem> & Pick<UnsentItem, 'path' | 'reason'>): UnsentItem => ({
  isDir: false,
  code: '',
  detail: '',
  retryable: false,
  info: false,
  ...over,
});

/** Seeds what the device does not send, with the count the status carries (as the core does). */
async function seed(items: UnsentItem[]) {
  mock.sync.unsent.set(vaultId, items);
  const s = mock.sync.status.get(vaultId);
  if (s) mock.sync.status.set(vaultId, { ...s, unsent: unsentCount(items) });
  await useSync.getState().refresh(vaultId);
}

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
  await api.auth.login('https://clarae.test');
  useAppStore.getState().setAuth(await api.auth.status());
  useSync.setState({ info: {}, status: {}, conflicts: {}, cloudDeleted: {} });
  await api.sync.linkNew(vaultId, 'Team', 'shared', '');
  await useSync.getState().refresh(vaultId);
});

describe('SyncUnsent (Settings › Sync, ADR-0066)', () => {
  it('says that every file was sent when nothing is left out', async () => {
    render(wrap(<SyncSection />));
    expect(await screen.findByText('All files have been sent.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try all again' })).toBeNull();
    expect(screen.getByText(/version control systems \(\.git/)).toBeInTheDocument();
  });

  it('lists the files by reason, with the full path and the detail, and the excluded folders apart', async () => {
    await seed([
      item({
        path: 'video/talk.mp4',
        reason: 'too-large',
        code: 'FILE_TOO_LARGE',
        detail: '2 GB',
        retryable: true,
      }),
      item({ path: 'Meeting 10:30.md', reason: 'invalid-name', detail: 'reserved character' }),
      item({ path: 'Plans.md', reason: 'too-many-conflicts', code: 'TOO_MANY_CONFLICTS' }),
      item({ path: '.git', reason: 'vcs', isDir: true, info: true }),
    ]);
    render(wrap(<SyncSection />));
    const large = await screen.findByRole('heading', { name: 'Too large (1)' });
    const group = large.parentElement as HTMLElement;
    expect(within(group).getByText('video/talk.mp4')).toBeInTheDocument();
    expect(within(group).getByText(/FILE_TOO_LARGE: 2 GB/)).toBeInTheDocument();
    expect(
      within(group).getByRole('button', { name: 'Try again video/talk.mp4' }),
    ).toBeInTheDocument();
    // Fixed on the disk or in the conflict view: no «Try again».
    const invalid = screen.getByRole('heading', { name: 'Invalid name: rename the file (1)' });
    expect(within(invalid.parentElement as HTMLElement).queryByRole('button')).toBeNull();
    const conflicts = screen.getByRole('heading', { name: /Too many concurrent edits/ });
    expect(within(conflicts.parentElement as HTMLElement).queryByRole('button')).toBeNull();
    // The folder of a version control system, informative, in a closed <details>.
    const summary = screen.getByText('Excluded folders (1)');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('.git/')).toBeInTheDocument();
    expect(screen.queryByText('All files have been sent.')).toBeNull();
  });

  it('puts one file back in the queue, then all of them, and reads the list again', async () => {
    await seed([
      item({ path: 'a.pdf', reason: 'too-large', code: 'FILE_TOO_LARGE', retryable: true }),
      item({ path: 'b.md', reason: 'rejected', code: 'FORBIDDEN', retryable: true }),
      item({ path: 'c.md', reason: 'rejected', code: 'PATH_INVALID', retryable: true }),
    ]);
    render(wrap(<SyncSection />));
    const large = await screen.findByRole('heading', { name: 'Too large (1)' });
    fireEvent.click(
      within(large.parentElement as HTMLElement).getByRole('button', { name: 'Try again a.pdf' }),
    );
    await waitFor(() => expect(screen.queryByText('a.pdf')).toBeNull());
    expect(mock.sync.retried).toEqual([{ vaultId, paths: ['a.pdf'] }]);
    expect(screen.getByText('b.md')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try all again' }));
    expect(await screen.findByText('All files have been sent.')).toBeInTheDocument();
    expect(mock.sync.retried[1]).toEqual({ vaultId, paths: [] });
  });

  it('reads the list again when the sync status brings another count of unsent files', async () => {
    render(wrap(<SyncSection />));
    expect(await screen.findByText('All files have been sent.')).toBeInTheDocument();
    mock.sync.unsent.set(vaultId, [
      item({ path: 'late.md', reason: 'rejected', code: 'FORBIDDEN', retryable: true }),
    ]);
    const status = useSync.getState().status[vaultId];
    if (!status) throw new Error('no status');
    act(() => useSync.getState().setStatus({ ...status, unsent: 1 }));
    expect(await screen.findByText('late.md')).toBeInTheDocument();
    expect(screen.queryByText('All files have been sent.')).toBeNull();
  });

  it('shows why the list could not be read', async () => {
    const spy = vi.spyOn(api.sync, 'unsent').mockRejectedValue(new Error('database is locked'));
    render(wrap(<SyncSection />));
    expect(await screen.findByRole('alert')).toHaveTextContent('database is locked');
    spy.mockRestore();
  });

  it('speaks Italian', async () => {
    initI18n('it');
    await seed([
      item({ path: 'a.pdf', reason: 'too-large', retryable: true }),
      item({ path: '.git', reason: 'vcs', isDir: true, info: true }),
    ]);
    render(wrap(<SyncSection />));
    expect(await screen.findByRole('heading', { name: 'File non inviati' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Troppo grandi (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Riprova a.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Riprova tutti' })).toBeInTheDocument();
    expect(screen.getByText('Cartelle escluse (1)')).toBeInTheDocument();
  });
});
