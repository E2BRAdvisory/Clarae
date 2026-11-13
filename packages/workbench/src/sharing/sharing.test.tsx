import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, linkInfo, type MountState, type Share } from '../app/api';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { unmanaged, useManaged } from '../state/managed';
import { useAppStore } from '../state/store';
import { useSharing } from '../state/sharing';
import { useSync } from '../state/sync';
import { DialogHost } from '../ui/dialogs';
import { FileExplorer } from '../sidebar/FileExplorer';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ShareDialog } from './ShareDialog';
import { SharingDialogs } from './SharingDialogs';
import { SharingPanel } from './SharingPanel';
import { InvitesIndicator, PermissionBadge } from './StatusItems';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
    <DialogHost />
  </QueryClientProvider>
);

let mock: WailsMock;
let vaultId: string;

const invitation = (over: Partial<Share> = {}): Share => ({
  id: 'sh-1',
  vault_id: 'cloud-1',
  vault_name: 'Company',
  resource_type: 'folder',
  display_name: 'Team docs',
  owner_id: 'u-ada',
  owner_name: 'ada',
  created_at: new Date().toISOString(),
  my_permission: 'editor',
  my_status: 'pending',
  ...over,
});

beforeEach(async () => {
  initI18n('en');
  configurePlatform();
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Docs');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
  useAppStore.getState().closeSettings();
  useManaged.setState({ ...unmanaged });
  useSharing.setState({ shareTarget: null, revoked: null });
  useSync.setState({ info: {}, status: {}, conflicts: {} });
  mock.sharing.users.push({ id: 'u-bob', username: 'bob', display_name: 'Bob Smith' });
  mock.sharing.groups.push({
    id: 'g-team',
    name: 'engineers',
    description: 'The engineering team',
  });
});

describe('invitations and mounts', () => {
  beforeEach(async () => {
    await api.auth.login('https://clarae.test');
    useAppStore.getState().setAuth(await api.auth.status());
  });

  it('asks to sign in first', async () => {
    useAppStore.getState().setAuth(await api.auth.logout());
    mock.sharing.invitations.push(invitation());
    render(wrap(<SharingPanel />));
    expect(await screen.findByText(/Sign in to the cloud/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Team docs' })).toBeNull();
  });

  it('accepts an invitation and shows the new mount', async () => {
    mock.sharing.invitations.push(invitation());
    render(wrap(<SharingPanel />));
    const item = await screen.findByRole('region', { name: 'Team docs' });
    expect(item).toHaveTextContent('From ada · in Company');
    expect(item).toHaveTextContent('Editor');
    expect(item).toHaveTextContent('Folder');
    fireEvent.click(within(item).getByRole('button', { name: 'Accept Team docs' }));
    await waitFor(() => expect(screen.getByText('No invitations.')).toBeInTheDocument());
    // The mount is listed by MountsList, the console's list, with the workbench's actions.
    const mounts = await screen.findByRole('region', { name: 'Shared with me' });
    const mount = await within(mounts).findByRole('region', { name: 'Team docs' });
    expect(mount).toHaveTextContent('From ada');
    expect(mount).toHaveTextContent('Editor');
    expect(within(mount).getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(within(mount).getByRole('button', { name: 'Remove from this device' })).toBeEnabled();
    expect(within(mount).queryByRole('link')).toBeNull(); // the console's link, not here
    expect(mock.sharing.mounts).toHaveLength(1);
  });

  it('says so when nothing is shared with the user', async () => {
    render(wrap(<SharingPanel />));
    expect(await screen.findByText('Nothing is shared with you yet.')).toBeInTheDocument();
  });

  it('marks a mount whose share ended and offers only to remove its copy', async () => {
    mock.sharing.mounts.push({ ...revokedMount(''), vaultId: '' });
    render(wrap(<SharingPanel />));
    const mounts = await screen.findByRole('region', { name: 'Shared with me' });
    const mount = await within(mounts).findByRole('region', { name: 'Team docs' });
    expect(mount).toHaveTextContent('Share ended');
    expect(mount).toHaveTextContent('the copy on this device stays until you remove it');
    expect(within(mount).queryByRole('button', { name: 'Open' })).toBeNull();
    expect(within(mount).getByRole('button', { name: 'Remove from this device' })).toBeEnabled();
  });

  it('declines an invitation', async () => {
    mock.sharing.invitations.push(invitation());
    render(wrap(<SharingPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'Decline Team docs' }));
    await waitFor(() => expect(mock.sharing.declined).toEqual(['sh-1']));
    expect(await screen.findByText('No invitations.')).toBeInTheDocument();
  });

  it('opens a mount as a vault named after the share, read-only for a viewer', async () => {
    mock.sharing.invitations.push(invitation({ my_permission: 'viewer' }));
    mock.sharing.mountFiles.set('sh-1', { 'Plan.md': '# plan' });
    render(wrap(<SharingPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Team docs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(useAppStore.getState().vault?.name).toBe('Team docs'));
    const id = useAppStore.getState().vault?.id ?? '';
    const info = await api.sync.info(id);
    expect(info).toMatchObject({
      mount: true,
      permission: 'viewer',
      readOnly: true,
      ownerName: 'ada',
    });
  });

  it('lists the shares of the account and creates one for a shared vault only', async () => {
    mock.sync.cloudVaults.push(
      {
        id: 'cloud-team',
        owner_id: 'u-me',
        name: 'Team',
        kind: 'shared',
        total_bytes: 0,
        file_count: 0,
        last_seq: 1,
        created_at: '2026-10-01T10:00:00Z',
      },
      {
        id: 'cloud-diary',
        owner_id: 'u-me',
        name: 'Diary',
        kind: 'private',
        total_bytes: 0,
        file_count: 0,
        last_seq: 1,
        created_at: '2026-10-01T10:00:00Z',
      },
    );
    render(wrap(<SharingPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'New share' }));
    const dialog = screen.getByRole('dialog', { name: 'New share' });
    const vault = await within(dialog).findByLabelText('Vault');
    await waitFor(() =>
      expect(
        within(vault)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Team']),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('region', { name: 'Team' })).toBeInTheDocument();
    expect(mock.sharing.owned).toMatchObject([
      { vault_id: 'cloud-team', resource_type: 'vault', display_name: 'Team' },
    ]);
    expect(mock.sharing.owned[0]).not.toHaveProperty('my_permission'); // the owner's share
  });

  it('honours the sharing flag of the configuration', async () => {
    mock.config = { ...mock.config, features: { sharing: false } };
    mock.sharing.invitations.push(invitation());
    render(wrap(<SharingPanel />));
    expect(
      await screen.findByText('Sharing is turned off by your administrator.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Team docs' })).toBeNull();
  });

  it('removes a mount after confirmation', async () => {
    mock.sharing.mounts.push({
      shareId: 'sh-2',
      cloudVaultId: 'c',
      name: 'Old share',
      ownerName: 'ada',
      resourceType: 'folder',
      permission: 'editor',
      path: '/m/sh-2',
      mounted: true,
      revoked: false,
      vaultId: '',
    });
    render(wrap(<SharingPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from this device' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mock.sharing.mounts).toHaveLength(0));
  });

  it('shows pending invitations in the status bar', async () => {
    mock.sharing.invitations.push(invitation(), invitation({ id: 'sh-9' }));
    render(wrap(<InvitesIndicator />));
    fireEvent.click(await screen.findByRole('button', { name: /2 invitations/ }));
    expect(useAppStore.getState().settingsSection).toBe('sharing');
  });
});

describe('permission badge and read-only', () => {
  it('names the level on a mount and says read-only for a viewer', () => {
    useSync.setState({
      info: {
        [vaultId]: linkInfo({
          linked: true,
          mount: true,
          permission: 'viewer',
          readOnly: true,
          ownerName: 'ada',
        }),
      },
    });
    render(wrap(<PermissionBadge />));
    expect(screen.getByText('Viewer · read-only')).toBeInTheDocument();
  });

  it('shows nothing on a vault of one’s own', () => {
    useSync.setState({ info: { [vaultId]: linkInfo({ linked: true, permission: 'owner' }) } });
    const { container } = render(wrap(<PermissionBadge />));
    expect(container.querySelector('.badge')).toBeNull();
  });

  it('a read-only vault offers no way to create, rename or delete in the explorer', async () => {
    mock.vaults.get(vaultId)?.files.set('Plan.md', 'x');
    useSync.setState({
      info: {
        [vaultId]: linkInfo({ linked: true, mount: true, permission: 'viewer', readOnly: true }),
      },
    });
    render(wrap(<FileExplorer vaultId={vaultId} />));
    expect(screen.queryByRole('button', { name: 'New note' })).toBeNull();
    fireEvent.contextMenu(await screen.findByText('Plan'));
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Move to trash' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument();
  });
});

describe('Share dialog', () => {
  async function connectedVault() {
    await api.auth.login('https://clarae.test');
    useSync.setState({
      info: {
        [vaultId]: linkInfo({
          linked: true,
          kind: 'shared',
          cloudVaultId: 'cloud-1',
          name: 'Docs',
          permission: 'owner',
        }),
      },
    });
    await api.sync.linkNew(vaultId, 'Docs', 'shared', '');
    await useSync.getState().refresh(vaultId);
  }

  it('creates a share for a folder with the people found in the directory', async () => {
    await connectedVault();
    render(wrap(<ShareDialog vaultId={vaultId} target={{ path: 'Projects/Alfa', isDir: true }} />));
    expect(screen.getByRole('dialog', { name: 'Share “Projects/Alfa”' })).toBeInTheDocument();
    const newShare = screen.getByRole('region', { name: 'New share' });
    const search = within(newShare).getByRole('form', { name: 'Add people or groups' });
    fireEvent.change(within(search).getByLabelText('Name or username'), {
      target: { value: 'bo' },
    });
    fireEvent.click(within(search).getByRole('button', { name: 'Search' }));
    fireEvent.click(await within(search).findByRole('button', { name: 'Add Bob Smith' }));
    fireEvent.change(within(search).getByLabelText('Add a'), { target: { value: 'group' } });
    fireEvent.change(within(search).getByLabelText('Name or username'), {
      target: { value: 'eng' },
    });
    fireEvent.click(within(search).getByRole('button', { name: 'Search' }));
    fireEvent.click(await within(search).findByRole('button', { name: 'Add engineers' }));
    const list = screen.getByRole('list', { name: 'Recipients' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.change(within(list).getByLabelText('Level of engineers'), {
      target: { value: 'viewer' },
    });
    fireEvent.click(within(newShare).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(mock.sharing.owned).toHaveLength(1));
    const created = mock.sharing.owned[0];
    expect(created).toMatchObject({
      resource_type: 'folder',
      path_prefix: 'Projects/Alfa',
      display_name: 'Alfa',
    });
    expect(created?.grants?.map((g) => [g.principal_type, g.permission])).toEqual([
      ['user', 'editor'],
      ['group', 'viewer'],
    ]);
    // It now shows among the existing shares.
    expect(await screen.findByRole('region', { name: 'Alfa' })).toBeInTheDocument();
  });

  it('changes a level, removes a recipient, renames and revokes a share', async () => {
    await connectedVault();
    await api.sharing.create(vaultId, 'Docs', true, 'Docs share', [
      { principal_type: 'user', principal_id: 'u-bob', permission: 'viewer' },
      { principal_type: 'group', principal_id: 'g-team', permission: 'editor' },
    ]);
    render(wrap(<ShareDialog vaultId={vaultId} target={{ path: 'Docs', isDir: true }} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Access to Docs share' }));
    const region = await screen.findByRole('region', { name: 'Docs share' });
    fireEvent.change(within(region).getByLabelText('Permission of bob'), {
      target: { value: 'manager' },
    });
    await waitFor(() => expect(mock.sharing.owned[0]?.grants?.[0]?.permission).toBe('manager'));
    fireEvent.click(within(region).getByRole('button', { name: 'Remove engineers' }));
    await waitFor(() => expect(mock.sharing.owned[0]?.grants).toHaveLength(1));

    fireEvent.click(within(region).getByRole('button', { name: 'Edit Docs share' }));
    const edit = screen.getByRole('dialog', { name: 'Edit “Docs share”' });
    fireEvent.change(within(edit).getByLabelText('Name'), { target: { value: 'Handbook' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.sharing.owned[0]?.display_name).toBe('Handbook'));

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Handbook' }));
    const confirm = screen.getByRole('dialog', { name: 'Revoke “Handbook”?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(mock.sharing.revoked).toEqual(['share-1']));
  });

  it('is offered by the explorer only for folders and documents of an owned, shared vault', async () => {
    mock.vaults.get(vaultId)?.files.set('Projects/Alfa/a.md', 'x');
    render(wrap(<FileExplorer vaultId={vaultId} />));
    fireEvent.contextMenu(await screen.findByText('Projects'));
    expect(screen.queryByRole('menuitem', { name: 'Share…' })).toBeNull(); // not connected to the cloud
    fireEvent.keyDown(document.body, { key: 'Escape' });
  });

  it('is offered once the vault is connected', async () => {
    mock.vaults.get(vaultId)?.files.set('Projects/Alfa/a.md', 'x');
    await connectedVault();
    render(wrap(<FileExplorer vaultId={vaultId} />));
    fireEvent.contextMenu(await screen.findByText('Projects'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share…' }));
    expect(useSharing.getState().shareTarget).toEqual({ path: 'Projects', isDir: true });
  });
});

describe('a share that ends', () => {
  it('asks what to do with the copy and keeps it on request', async () => {
    mock.sharing.mounts.push({
      shareId: 'sh-3',
      cloudVaultId: 'c',
      name: 'Team docs',
      ownerName: 'ada',
      resourceType: 'folder',
      permission: 'editor',
      path: '/m/sh-3',
      mounted: true,
      revoked: false,
      vaultId: vaultId,
    });
    render(wrap(<SharingDialogs />));
    await act(async () => {
      mock.emit('mount:revoked', { vaultId, shareId: 'sh-3', name: 'Team docs' });
      await Promise.resolve();
    });
    const dlg = await screen.findByRole('alertdialog', { name: 'Sharing ended' });
    expect(within(dlg).getByText(/stopped sharing “Team docs”/)).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Keep a copy' }));
    await waitFor(() => expect(mock.sharing.mounts).toHaveLength(0));
    expect(await screen.findByText('Copy kept')).toBeInTheDocument();
    expect(useAppStore.getState().vault).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'OK' })); // the dialogs' queue is shared
    await waitFor(() => expect(screen.queryByText('Copy kept')).toBeNull());
  });

  it('in the browser, offers a download instead of a kept folder and removes the copy through the host', async () => {
    const remove = vi.fn();
    configurePlatform({ kind: 'web', onRemoveFromBrowser: remove });
    mock.sharing.mounts.push(revokedMount(vaultId));
    render(wrap(<SharingDialogs />));
    await act(async () => {
      mock.emit('mount:revoked', { vaultId, shareId: 'sh-3', name: 'Team docs' });
      await Promise.resolve();
    });
    const dlg = await screen.findByRole('alertdialog', { name: 'Sharing ended' });
    expect(within(dlg).queryByRole('button', { name: 'Keep a copy' })).toBeNull();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Download a copy' }));
    const done = await screen.findByRole('dialog', { name: 'Export finished' });
    expect(mock.exports).toEqual([vaultId]);
    fireEvent.click(within(done).getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Export finished' })).toBeNull(),
    );
    // The prompt stays until the copy is dealt with; deleting it goes through the host's guard.
    fireEvent.click(within(dlg).getByRole('button', { name: 'Delete the copy' }));
    expect(remove).toHaveBeenCalledOnce();
    expect(mock.sharing.mounts).toHaveLength(1); // not removed behind the guard's back
    expect(useSharing.getState().revoked).toBeNull();
  });
});

const revokedMount = (localId: string): MountState => ({
  shareId: 'sh-3',
  cloudVaultId: 'c',
  name: 'Team docs',
  ownerName: 'ada',
  resourceType: 'folder',
  permission: 'editor',
  path: '/m/sh-3',
  mounted: true,
  revoked: true,
  vaultId: localId,
});

describe('mounts in the browser', () => {
  beforeEach(async () => {
    await api.auth.login('https://clarae.test');
    useAppStore.getState().setAuth(await api.auth.status());
  });
  afterEach(() => configurePlatform());

  it('opens a mount in its own page through the host, not inside this one', async () => {
    const openMount = vi.fn();
    configurePlatform({ kind: 'web', onOpenMount: openMount });
    mock.sharing.invitations.push(invitation());
    render(wrap(<SharingPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Team docs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(openMount).toHaveBeenCalledWith({ shareId: 'sh-1', cloudVaultId: 'cloud-1' }),
    );
    expect(useAppStore.getState().vault?.id).toBe(vaultId); // the page keeps its own vault
    expect(mock.sharing.mounts[0]?.vaultId).toBeFalsy(); // OpenMount was not called here
  });

  it('removes a closed mount without offering to keep a folder, and tells the host', async () => {
    const removed = vi.fn();
    configurePlatform({ kind: 'web', onMountRemoved: removed });
    mock.sharing.mounts.push({ ...revokedMount(''), vaultId: '' });
    render(wrap(<SharingPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from this device' }));
    expect(await screen.findByText(/Remove “Team docs” from this device\?/)).toBeInTheDocument();
    expect(screen.queryByText(/Keep a copy of the files/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(removed).toHaveBeenCalledWith('sh-3'));
    expect(mock.sharing.mounts).toHaveLength(0);
  });

  it('removes the open mount through the host (upload first, its marker, the console)', async () => {
    const remove = vi.fn();
    configurePlatform({ kind: 'web', onRemoveFromBrowser: remove });
    mock.sharing.mounts.push({ ...revokedMount(vaultId), revoked: false });
    render(wrap(<SharingPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from this device' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(mock.sharing.mounts).toHaveLength(1);
  });
});

describe('managed settings', () => {
  it('a locked key is disabled and says who manages it; the others stay editable', async () => {
    useManaged.setState({
      ...unmanaged,
      managed: true,
      version: 2,
      config: { editor: { fontSize: 20 } },
      locked: ['editor.fontSize'],
    });
    useAppStore.getState().openSettings('editor');
    render(wrap(<SettingsPanel />));
    expect(await screen.findByLabelText('Editor font size')).toBeDisabled();
    expect(screen.getByText(/Managed by your administrator/)).toBeInTheDocument();
    expect(screen.getByLabelText('Wrap long lines')).toBeEnabled();
  });

  it('a configuration pushed by the server applies at once', async () => {
    render(wrap(<SharingDialogs />));
    await act(async () => {
      mock.emit('config:updated', {
        version: 4,
        config: { features: { drawings: false } },
        lockedKeys: [],
        managed: true,
        fetchedAt: '',
        features: { drawings: false },
      });
      await Promise.resolve();
    });
    expect(useManaged.getState().features['drawings']).toBe(false);
    expect(useManaged.getState().version).toBe(4);
  });
});
