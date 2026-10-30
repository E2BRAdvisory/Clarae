import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { unmanaged, useManaged } from '../state/managed';
import { useSync } from '../state/sync';
import { DialogHost } from '../ui/dialogs';
import { SyncSection } from '../settings/SyncSection';
import { ConflictsView } from './ConflictsView';
import { ConnectWizard } from './ConnectWizard';
import { HistoryView } from './HistoryView';
import { SyncIndicator } from './SyncIndicator';
import { UnlockDialog } from './UnlockDialog';

const GOOD = 'correct horse battery staple orbit';
const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
    <DialogHost />
  </QueryClientProvider>
);

let mock: WailsMock;
let vaultId: string;

async function signIn() {
  await api.auth.login('https://memobrain.test');
  useAppStore.getState().setAuth(await api.auth.status());
}

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
  useAppStore.getState().setAuth({ status: 'signed_out' } as never);
  useSync.setState({
    info: {},
    status: {},
    conflicts: {},
    wizardOpen: false,
    unlockOpen: false,
    conflictsOpen: false,
    historyPath: null,
    diskWarning: false,
  });
});

describe('SyncIndicator', () => {
  it('offers to connect an unlinked vault', async () => {
    render(wrap(<SyncIndicator />));
    fireEvent.click(await screen.findByRole('button', { name: /Not connected/ }));
    expect(useSync.getState().wizardOpen).toBe(true);
  });

  it('shows the phase of a linked vault and its conflicts', async () => {
    await signIn();
    await api.sync.linkNew(vaultId, 'Notes', 'shared', '');
    mock.sync.conflicts.set(vaultId, [
      {
        id: 1,
        fileId: 'f',
        path: 'a.md',
        copyPath: 'a (conflitto).md',
        strategy: 'markdown-3way',
        localHash: 'h',
        remoteRev: 2,
        detail: '[]',
        createdAt: new Date().toISOString(),
        status: 'open',
      },
    ]);
    await useSync.getState().refresh(vaultId);
    render(wrap(<SyncIndicator />));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Sync: / })).toBeInTheDocument(),
    );
    fireEvent.click(await screen.findByRole('button', { name: /1 conflict\(s\)/ }));
    expect(useSync.getState().conflictsOpen).toBe(true);
  });

  it('turns into an unlock prompt when the vault is locked', async () => {
    await signIn();
    await api.sync.linkNew(vaultId, 'Diary', 'private', GOOD);
    await api.crypto.lock(vaultId);
    await useSync.getState().refresh(vaultId);
    render(wrap(<SyncIndicator />));
    fireEvent.click(await screen.findByRole('button', { name: /Locked/ }));
    expect(useSync.getState().unlockOpen).toBe(true);
  });
});

describe('ConnectWizard', () => {
  it('asks the user to sign in first', async () => {
    render(wrap(<ConnectWizard vaultId={vaultId} vaultName="Notes" />));
    expect(
      await screen.findByText(/Sign in to your MemoBrain Notes server first/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open cloud settings'));
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsSection).toBe('cloud');
  });

  it('connects a shared vault and shows progress', async () => {
    await signIn();
    render(wrap(<ConnectWizard vaultId={vaultId} vaultName="Notes" />));
    expect(screen.getByText(/The type of a cloud vault cannot be changed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText(/Connected\.|Uploading/);
    expect((await api.sync.info(vaultId)).kind).toBe('shared');
  });

  it('explains the consequences of a private vault and walks through passphrase and recovery key', async () => {
    await signIn();
    render(wrap(<ConnectWizard vaultId={vaultId} vaultName="Diary" />));
    fireEvent.click(screen.getByRole('radio', { name: /Private encrypted vault/ }));
    expect(screen.getByText(/cannot be recovered by anyone/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // The passphrase must be long, strong and confirmed.
    const create = screen.getByRole('button', { name: 'Create encrypted vault' });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'password1234' } });
    fireEvent.change(screen.getByLabelText('Repeat the passphrase'), {
      target: { value: 'password1234' },
    });
    await screen.findByText(/Too easy to guess/);
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText('Repeat the passphrase'), {
      target: { value: GOOD + 'x' },
    });
    await screen.findByText(/passphrases do not match/);
    fireEvent.change(screen.getByLabelText('Repeat the passphrase'), { target: { value: GOOD } });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);

    // The recovery key is shown once and must be retyped.
    const key = (await screen.findByLabelText('Recovery key')).textContent ?? '';
    expect(key).toMatch(/^[A-Z2-7-]+$/);
    const saved = screen.getByRole('button', { name: 'I saved it' });
    expect(saved).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type the recovery key/), {
      target: { value: key.toLowerCase().replace(/-/g, ' ') },
    });
    expect(saved).toBeEnabled();
    fireEvent.click(saved);
    await screen.findByText(/Connected\.|Uploading/);
    expect((await api.sync.info(vaultId)).kind).toBe('private');
  });

  it('connects to an existing private vault and hands over to the unlock dialog', async () => {
    await signIn();
    mock.sync.cloudVaults.push({
      id: 'cv1',
      name: 'Old diary',
      kind: 'private',
      totalBytes: 10,
      fileCount: 2,
      createdAt: new Date().toISOString(),
    });
    render(wrap(<ConnectWizard vaultId={vaultId} vaultName="Notes" />));
    fireEvent.click(screen.getByRole('radio', { name: /existing cloud vault/ }));
    await screen.findByRole('combobox', { name: 'Cloud vault' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(useSync.getState().unlockOpen).toBe(true));
    expect(useSync.getState().wizardOpen).toBe(false);
  });

  it('reports a name that is already in use', async () => {
    await signIn();
    mock.sync.cloudVaults.push({
      id: 'cv1',
      name: 'Notes',
      kind: 'shared',
      totalBytes: 0,
      fileCount: 0,
      createdAt: new Date().toISOString(),
    });
    render(wrap(<ConnectWizard vaultId={vaultId} vaultName="Notes" />));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already have a vault/);
  });
});

describe('UnlockDialog', () => {
  async function lockedVault() {
    await signIn();
    await api.sync.linkNew(vaultId, 'Diary', 'private', GOOD);
    await api.crypto.lock(vaultId);
  }

  it('unlocks with the passphrase', async () => {
    await lockedVault();
    render(wrap(<UnlockDialog vaultId={vaultId} />));
    fireEvent.change(document.getElementById('unlock-secret') as HTMLElement, {
      target: { value: 'wrong wrong wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/wrong passphrase/);
    fireEvent.change(document.getElementById('unlock-secret') as HTMLElement, {
      target: { value: GOOD },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(useSync.getState().unlockOpen).toBe(false));
    expect((await api.sync.info(vaultId)).locked).toBe(false);
  });

  it('forces a new passphrase after unlocking with the recovery key and offers a new key', async () => {
    await lockedVault();
    const recovery = mock.sync.secrets.get('cloud-1')?.recoveryKey ?? '';
    useSync.setState({ unlockOpen: true });
    render(wrap(<UnlockDialog vaultId={vaultId} />));
    fireEvent.click(screen.getByRole('radio', { name: 'Recovery key' }));
    fireEvent.change(document.getElementById('unlock-secret') as HTMLElement, {
      target: { value: recovery },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await screen.findByText(/Choose a new passphrase now/);
    const fresh = 'another long unrelated passphrase 42';
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: fresh } });
    fireEvent.change(screen.getByLabelText('Repeat the passphrase'), { target: { value: fresh } });
    const save = screen.getByRole('button', { name: 'Save passphrase' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await screen.findByText(/new recovery key/);
    fireEvent.click(screen.getByRole('button', { name: 'Generate a new key' }));
    const key = (await screen.findByLabelText('Recovery key')).textContent ?? '';
    expect(key).not.toBe(recovery);
    expect(mock.sync.secrets.get('cloud-1')?.passphrase).toBe(fresh);
  });
});

describe('ConflictsView', () => {
  const conflict = {
    id: 7,
    fileId: 'f',
    path: 'plan.md',
    copyPath: 'plan (conflitto laptop 2026-10-24 10-00).md',
    strategy: 'markdown-3way',
    localHash: 'h',
    remoteRev: 3,
    detail: '[]',
    createdAt: new Date().toISOString(),
    status: 'open',
  };

  beforeEach(async () => {
    await signIn();
    await api.sync.linkNew(vaultId, 'Notes', 'shared', '');
    mock.sync.conflicts.set(vaultId, [conflict]);
    mock.sync.conflictTexts.set(7, { current: 'row 1\nrow 3 by A\n', ours: 'row 1\nrow 3 by B\n' });
    await useSync.getState().refreshConflicts(vaultId);
  });

  it('shows both versions side by side with the differing lines', async () => {
    render(wrap(<ConflictsView vaultId={vaultId} />));
    const diff = await screen.findByLabelText('Side by side comparison');
    await within(diff).findByText('row 3 by A');
    expect(within(diff).getByText('row 3 by B')).toBeInTheDocument();
    expect(screen.getByText(/saved as “plan \(conflitto/)).toBeInTheDocument();
  });

  it.each([
    ['Keep current', 'keep-remote'],
    ['Keep mine', 'keep-local'],
    ['Keep both', 'keep-both'],
  ])('%s resolves the conflict with %s', async (label, action) => {
    render(wrap(<ConflictsView vaultId={vaultId} />));
    await screen.findByLabelText('Side by side comparison');
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() =>
      expect(mock.sync.resolved).toEqual([{ vaultId, id: 7, action, merged: '' }]),
    );
    expect(await screen.findByText('No conflicts.')).toBeInTheDocument();
  });

  it('lets the user merge by hand', async () => {
    render(wrap(<ConflictsView vaultId={vaultId} />));
    await screen.findByLabelText('Side by side comparison');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Merge by hand' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Merge by hand' }));
    const box = screen.getByLabelText('Merged text');
    expect(box).toHaveValue('row 1\nrow 3 by A\n');
    fireEvent.change(box, { target: { value: 'row 1\nrow 3 by A and B\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save merged text' }));
    await waitFor(() =>
      expect(mock.sync.resolved[0]).toMatchObject({
        action: 'merged',
        merged: 'row 1\nrow 3 by A and B\n',
      }),
    );
  });
});

describe('HistoryView', () => {
  it('lists revisions, diffs against the current text and restores', async () => {
    await signIn();
    await api.sync.linkNew(vaultId, 'Notes', 'shared', '');
    const mockVault = mock.vaults.get(vaultId);
    mockVault?.files.set('Note.md', 'line 1\nnow\n');
    const t = new Date().toISOString();
    mock.sync.history.set(`${vaultId}|Note.md`, [
      {
        rev: 3,
        op: 'modify',
        path: 'Note.md',
        size: 10,
        authorId: 'u',
        deviceId: 'd',
        time: t,
        hasContent: true,
        mine: true,
      },
      {
        rev: 2,
        op: 'delete',
        path: 'Note.md',
        size: 0,
        authorId: 'u',
        deviceId: 'd',
        time: t,
        hasContent: false,
        mine: false,
      },
      {
        rev: 1,
        op: 'create',
        path: 'Note.md',
        size: 5,
        authorId: 'u',
        deviceId: 'd',
        time: t,
        hasContent: true,
        mine: true,
      },
    ]);
    mock.sync.revisionTexts.set(`${vaultId}|Note.md|3`, 'line 1\nnow\n');
    mock.sync.revisionTexts.set(`${vaultId}|Note.md|1`, 'line 1\nolder\n');

    render(wrap(<HistoryView vaultId={vaultId} path="Note.md" />));
    const list = await screen.findByRole('listbox', { name: 'Version history' });
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    expect(
      within(list)
        .getByText(/#2 · deleted/)
        .closest('li'),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByText('The two versions are identical.')).toBeInTheDocument();

    fireEvent.click(within(list).getByText(/#1 · created/));
    const diff = await screen.findByLabelText('Comparison with the current text');
    await within(diff).findByText('older');
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mock.sync.restored).toEqual([{ vaultId, path: 'Note.md', rev: 1 }]));
  });

  it('says so when a note has no history', async () => {
    await signIn();
    await api.sync.linkNew(vaultId, 'Notes', 'shared', '');
    mock.vaults.get(vaultId)?.files.set('New.md', 'x');
    render(wrap(<HistoryView vaultId={vaultId} path="New.md" />));
    expect(await screen.findByText('No saved versions yet.')).toBeInTheDocument();
  });
});

describe('SyncSection (settings)', () => {
  it('offers to connect when the vault is not linked', async () => {
    render(wrap(<SyncSection />));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect to the cloud' }));
    expect(useSync.getState().wizardOpen).toBe(true);
  });

  it('pauses, changes the interval and disconnects after confirmation', async () => {
    await signIn();
    await api.sync.linkNew(vaultId, 'Notes', 'shared', '');
    await useSync.getState().refresh(vaultId);
    render(wrap(<SyncSection />));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause sync' }));
    await screen.findByRole('button', { name: 'Resume sync' });
    expect(mock.sync.links.get(vaultId)?.paused).toBe(true);

    fireEvent.change(screen.getByLabelText('Check the server'), { target: { value: '300' } });
    await waitFor(() => expect(mock.sync.links.get(vaultId)?.pollSeconds).toBe(300));

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mock.sync.links.has(vaultId)).toBe(false));
  });

  it('shows the encryption controls of a private vault with the disk warning', async () => {
    await signIn();
    mock.sync.disk = 'unencrypted';
    await api.sync.linkNew(vaultId, 'Diary', 'private', GOOD);
    await useSync.getState().refresh(vaultId);
    await useSync.getState().checkDisk();
    render(wrap(<SyncSection />));
    expect(await screen.findByText(/does not look encrypted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Lock now' }));
    await screen.findByRole('button', { name: 'Unlock' });
    expect(mock.sync.links.get(vaultId)?.locked).toBe(true);
  });

  it('sets the idle lock of private vaults as a device setting', async () => {
    useManaged.setState({ ...unmanaged });
    await signIn();
    await api.sync.linkNew(vaultId, 'Diary', 'private', GOOD);
    await useSync.getState().refresh(vaultId);
    render(wrap(<SyncSection />));
    const select = await screen.findByLabelText('Lock automatically when idle');
    expect(select).toHaveValue('0');
    fireEvent.change(select, { target: { value: '15' } });
    await waitFor(() => expect(mock.settings.vaultLockMinutes).toBe(15));
    expect(useAppStore.getState().settings.vaultLockMinutes).toBe(15);
  });

  it('shows the administrator idle lock: a default until the user chooses, fixed when locked', async () => {
    await signIn();
    await api.sync.linkNew(vaultId, 'Diary', 'private', GOOD);
    await useSync.getState().refresh(vaultId);
    const withoutChoice = { ...useAppStore.getState().settings };
    delete withoutChoice.vaultLockMinutes;
    useAppStore.getState().setSettings(withoutChoice);
    useManaged.setState({
      ...unmanaged,
      managed: true,
      config: { security: { vault_lock_minutes: 30 } },
    });
    const { unmount } = render(wrap(<SyncSection />));
    expect(await screen.findByLabelText('Lock automatically when idle')).toHaveValue('30');
    unmount();

    useAppStore.getState().setSettings({ ...useAppStore.getState().settings, vaultLockMinutes: 5 });
    useManaged.setState({ locked: ['security.vault_lock_minutes'] });
    render(wrap(<SyncSection />));
    const select = await screen.findByLabelText('Lock automatically when idle');
    expect(select).toHaveValue('30');
    expect(select).toBeDisabled();
    expect(screen.getByText(/Managed by your administrator/)).toBeInTheDocument();
    useManaged.setState({ ...unmanaged });
  });

  it('changes the passphrase only with the right old one', async () => {
    await signIn();
    await api.sync.linkNew(vaultId, 'Diary', 'private', GOOD);
    await useSync.getState().refresh(vaultId);
    render(wrap(<SyncSection />));
    fireEvent.click(await screen.findByRole('button', { name: 'Change passphrase' }));
    fireEvent.change(screen.getByLabelText('Current passphrase'), {
      target: { value: 'not the passphrase' },
    });
    const fresh = 'a completely different long passphrase 99';
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: fresh } });
    fireEvent.change(screen.getByLabelText('Repeat the passphrase'), { target: { value: fresh } });
    const save = screen.getByRole('button', { name: 'Save passphrase' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText(/wrong passphrase/)).toBeInTheDocument();
    expect(mock.sync.secrets.get('cloud-1')?.passphrase).toBe(GOOD);
  });
});
