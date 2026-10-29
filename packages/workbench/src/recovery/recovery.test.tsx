import { beforeEach, describe, expect, it } from 'vitest';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, linkInfo, type RevisionInfo } from '../app/api';
import { useNoteDocument } from '../editor/useNoteDocument';
import { initI18n } from '../i18n';
import { installWailsMock, hashOf, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { DialogHost } from '../ui/dialogs';
import { HistorySettings } from '../settings/HistorySettings';
import { RecoveryDialogs } from './RecoveryDialog';
import { useRecovery } from './store';
import { mergeVersions } from './versions';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
    <DialogHost />
  </QueryClientProvider>
);

let mock: WailsMock;
let vaultId: string;

const snap = (id: string, path: string, time: string, reason = 'periodic', content = '') => ({
  snapshot: { id, path, time, size: content.length, hash: hashOf(content), reason },
  content,
});

const rev = (n: number, time: string, hasContent = true): RevisionInfo => ({
  rev: n,
  op: 'modify',
  path: 'Note.md',
  size: 1,
  authorId: 'u',
  deviceId: 'd',
  time,
  hasContent,
  mine: true,
});

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
  useSync.setState({ info: {}, status: {}, conflicts: {} });
  useRecovery.getState().close();
});

describe('mergeVersions', () => {
  it('orders local and cloud versions by time and drops contentless revisions', () => {
    const local = [snap('a', 'N.md', '2026-01-01T10:00:00Z').snapshot];
    const out = mergeVersions(local, [
      rev(2, '2026-01-01T11:00:00Z'),
      rev(1, '2026-01-01T09:00:00Z'),
      rev(3, '2026-01-01T12:00:00Z', false),
    ]);
    expect(out.map((v) => v.key)).toEqual(['c:2', 'l:a', 'c:1']);
  });
});

describe('File recovery dialog', () => {
  it('shows local snapshots and cloud revisions together, diffs and restores a local one', async () => {
    mock.vaults.get(vaultId)?.files.set('Note.md', 'line 1\nnow\n');
    mock.history.snapshots.set(`${vaultId}|Note.md`, [
      snap('s2', 'Note.md', '2026-01-01T10:00:00Z', 'periodic', 'line 1\nlocal older\n'),
    ]);
    useSync.setState({ info: { [vaultId]: linkInfo({ linked: true }) } });
    mock.sync.history.set(`${vaultId}|Note.md`, [rev(5, '2026-01-01T11:00:00Z')]);
    mock.sync.revisionTexts.set(`${vaultId}|Note.md|5`, 'line 1\ncloud\n');

    render(wrap(<RecoveryDialogs />));
    act(() => useRecovery.getState().openNote('Note.md'));
    const list = await screen.findByRole('listbox', { name: 'File recovery' });
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Cloud');
    expect(options[1]).toHaveTextContent('This device');

    // The newest (cloud) is selected first; pick the local snapshot.
    fireEvent.click(within(list).getByText(/Automatic snapshot/));
    const diff = await screen.findByLabelText('Comparison with the current text');
    await within(diff).findByText('local older');

    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mock.history.restored).toEqual([{ vaultId, id: 's2' }]));
    expect(mock.vaults.get(vaultId)?.files.get('Note.md')).toBe('line 1\nlocal older\n');
    // The version that was replaced is kept.
    expect(mock.history.snapshots.get(`${vaultId}|Note.md`)?.[0]?.snapshot.reason).toBe(
      'pre-restore',
    );
    await waitFor(() => expect(useRecovery.getState().target).toBeNull());
  });

  it('restores a cloud revision through the sync API', async () => {
    mock.vaults.get(vaultId)?.files.set('Note.md', 'x');
    useSync.setState({ info: { [vaultId]: linkInfo({ linked: true }) } });
    mock.sync.history.set(`${vaultId}|Note.md`, [rev(7, '2026-01-01T11:00:00Z')]);
    mock.sync.revisionTexts.set(`${vaultId}|Note.md|7`, 'cloud text');
    render(wrap(<RecoveryDialogs />));
    act(() => useRecovery.getState().openNote('Note.md'));
    await screen.findByRole('listbox', { name: 'File recovery' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mock.sync.restored).toEqual([{ vaultId, path: 'Note.md', rev: 7 }]));
  });

  it('uses local snapshots only for an unlinked vault and says so when there are none', async () => {
    mock.vaults.get(vaultId)?.files.set('Note.md', 'x');
    mock.sync.history.set(`${vaultId}|Note.md`, [rev(1, '2026-01-01T11:00:00Z')]); // ignored: not linked
    render(wrap(<RecoveryDialogs />));
    act(() => useRecovery.getState().openNote('Note.md'));
    expect(await screen.findByText(/No saved versions of this note yet/)).toBeInTheDocument();
  });

  it('does not allow restoring in a read-only vault', async () => {
    mock.vaults.get(vaultId)?.files.set('Note.md', 'x');
    mock.history.snapshots.set(`${vaultId}|Note.md`, [
      snap('s1', 'Note.md', '2026-01-01T10:00:00Z', 'periodic', 'y'),
    ]);
    useSync.setState({ info: { [vaultId]: linkInfo({ linked: true, readOnly: true }) } });
    render(wrap(<RecoveryDialogs />));
    act(() => useRecovery.getState().openNote('Note.md'));
    await screen.findByRole('listbox', { name: 'File recovery' });
    expect(screen.getByRole('button', { name: 'Restore this version' })).toBeDisabled();
  });

  it('lists deleted files and recovers one', async () => {
    mock.history.snapshots.set(`${vaultId}|gone/Old.md`, [
      snap('d1', 'gone/Old.md', '2026-01-01T10:00:00Z', 'periodic', 'precious'),
    ]);
    render(wrap(<RecoveryDialogs />));
    act(() => useRecovery.getState().openDeleted());
    await screen.findByText('gone/Old.md');
    fireEvent.click(screen.getByRole('button', { name: 'Restore file' }));
    await waitFor(() =>
      expect(mock.vaults.get(vaultId)?.files.get('gone/Old.md')).toBe('precious'),
    );
    expect(await screen.findByText('No deleted files with a saved version.')).toBeInTheDocument();
  });
});

describe('HistorySettings', () => {
  it('loads and saves the snapshot settings', async () => {
    render(wrap(<HistorySettings />));
    const retention = await screen.findByLabelText('Keep snapshots for (days)');
    expect(retention).toHaveValue(7);
    fireEvent.change(retention, { target: { value: '30' } });
    fireEvent.blur(retention);
    await waitFor(() => expect(mock.history.settings.retentionDays).toBe(30));
  });
});

describe('a restore performed under an open note', () => {
  it('is picked up by useNoteDocument as an external change', async () => {
    mock.vaults.get(vaultId)?.files.set('Note.md', 'current');
    mock.history.snapshots.set(`${vaultId}|Note.md`, [
      snap('s1', 'Note.md', '2026-01-01T10:00:00Z', 'periodic', 'restored text'),
    ]);
    const { result } = renderHook(() => useNoteDocument(vaultId, 'Note.md', 10));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.content).toBe('current');

    await act(async () => {
      await api.history.restore(vaultId, 's1');
    });
    await waitFor(() => expect(result.current.content).toBe('restored text'));
    expect(result.current.save).toBe('saved');
    expect(result.current.hash).toBe(hashOf('restored text'));
  });

  it('flags a conflict instead of losing unsaved edits', async () => {
    mock.vaults.get(vaultId)?.files.set('Note.md', 'current');
    mock.history.snapshots.set(`${vaultId}|Note.md`, [
      snap('s1', 'Note.md', '2026-01-01T10:00:00Z', 'periodic', 'restored text'),
    ]);
    const { result } = renderHook(() => useNoteDocument(vaultId, 'Note.md', 60_000));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.edit('typing…'));
    await act(async () => {
      await api.history.restore(vaultId, 's1');
    });
    await waitFor(() => expect(result.current.save).toBe('conflict'));
    expect(result.current.current()).toBe('typing…');
  });
});
