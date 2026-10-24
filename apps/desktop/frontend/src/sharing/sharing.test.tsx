import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, linkInfo, type ShareInfo } from '../app/api';
import { initI18n } from '../i18n';
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

const invitation = (over: Partial<ShareInfo> = {}): ShareInfo => ({
  id: 'sh-1',
  vaultId: 'cloud-1',
  vaultName: 'Company',
  resourceType: 'folder',
  pathPrefix: '',
  displayName: 'Team docs',
  ownerName: 'ada',
  createdAt: new Date().toISOString(),
  expiresAt: '',
  myPermission: 'editor',
  myStatus: 'pending',
  grants: [],
  ...over,
});

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Docs');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
  useAppStore.getState().closeSettings();
  useManaged.setState({ ...unmanaged });
  useSharing.setState({ shareTarget: null, revoked: null });
  useSync.setState({ info: {}, status: {}, conflicts: {} });
  mock.sharing.directory.push(
    { type: 'user', id: 'u-bob', name: 'bob', label: 'Bob Smith (bob)' },
    { type: 'group', id: 'g-team', name: 'engineers', label: 'engineers' },
  );
});

describe('invitations and mounts', () => {
  it('accepts an invitation and shows the new mount', async () => {
    mock.sharing.invitations.push(invitation());
    render(wrap(<SharingPanel />));
    const item = (await screen.findByText('Team docs')).closest('li') as HTMLElement;
    expect(within(item).getByText(/Shared by ada · Editor · Folder/)).toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.getByText('No invitations.')).toBeInTheDocument());
    expect(await screen.findByText(/From ada · Editor/)).toBeInTheDocument();
    expect(mock.sharing.mounts).toHaveLength(1);
  });

  it('declines an invitation', async () => {
    mock.sharing.invitations.push(invitation());
    render(wrap(<SharingPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(mock.sharing.declined).toEqual(['sh-1']));
    expect(await screen.findByText('No invitations.')).toBeInTheDocument();
  });

  it('opens a mount as a vault named after the share, read-only for a viewer', async () => {
    mock.sharing.invitations.push(invitation({ myPermission: 'viewer' }));
    mock.sharing.mountFiles.set('sh-1', { 'Plan.md': '# plan' });
    render(wrap(<SharingPanel />));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
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
    expect(screen.getByRole('button', { name: 'New note' })).toBeDisabled();
    fireEvent.contextMenu(await screen.findByText('Plan'));
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Move to trash' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument();
  });
});

describe('Share dialog', () => {
  async function connectedVault() {
    await api.auth.login('https://nodus.test');
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
  }

  it('creates a share for a folder with the people found in the directory', async () => {
    await connectedVault();
    render(wrap(<ShareDialog vaultId={vaultId} target={{ path: 'Projects/Alfa', isDir: true }} />));
    expect(screen.getByRole('dialog', { name: 'Share “Projects/Alfa”' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search people and groups…', { selector: 'input' }), {
      target: { value: 'bo' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Bob Smith/ }));
    fireEvent.change(screen.getAllByLabelText('Search people and groups…')[0] as HTMLElement, {
      target: { value: 'eng' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /engineers/ }));
    const list = screen.getByRole('list', { name: 'Recipients' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(mock.sharing.owned).toHaveLength(1));
    const created = mock.sharing.owned[0];
    expect(created).toMatchObject({
      resourceType: 'folder',
      pathPrefix: 'Projects/Alfa',
      displayName: 'Alfa',
    });
    expect(created?.grants.map((g) => [g.principalType, g.permission])).toEqual([
      ['user', 'editor'],
      ['group', 'editor'],
    ]);
    // It now shows among the existing shares.
    expect(await screen.findByRole('region', { name: 'Alfa' })).toBeInTheDocument();
  });

  it('changes a level, removes a recipient and revokes a share', async () => {
    await connectedVault();
    await api.sharing.create(vaultId, 'Docs', true, 'Docs share', [
      { principalType: 'user', principalId: 'u-bob', permission: 'viewer' },
      { principalType: 'group', principalId: 'g-team', permission: 'editor' },
    ]);
    render(wrap(<ShareDialog vaultId={vaultId} target={{ path: 'Docs', isDir: true }} />));
    const region = await screen.findByRole('region', { name: 'Docs share' });
    fireEvent.change(within(region).getByLabelText('Level of bob'), {
      target: { value: 'manager' },
    });
    await waitFor(() => expect(mock.sharing.owned[0]?.grants[0]?.permission).toBe('manager'));
    fireEvent.click(within(region).getByRole('button', { name: 'Remove engineers' }));
    await waitFor(() => expect(mock.sharing.owned[0]?.grants).toHaveLength(1));
    fireEvent.click(within(region).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
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
