import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecordedCall } from '../test/utils';
import { renderApp } from '../test/utils';
import { navigation } from './Vaults';

const base = { owner_id: 'u1', created_at: '2026-01-15T10:00:00Z', last_seq: 1 };
const MB = 1024 * 1024;

const notes = {
  ...base,
  id: 'v1',
  name: 'Notes',
  kind: 'shared',
  total_bytes: 5 * MB,
  file_count: 42,
};
const diary = {
  ...base,
  id: 'v2',
  name: 'Diary',
  kind: 'private',
  total_bytes: 2048,
  file_count: 3,
};
const received = {
  vault_id: 'v9',
  vault_name: 'Company',
  resource_type: 'folder',
  owner_id: 'u2',
  owner_name: 'Bob',
  created_at: '2026-01-01T00:00:00Z',
};
/** A mount as GET /shared-with-me returns it. */
const mountOf = (id: string, name: string) => ({
  share_id: id,
  vault_id: received.vault_id,
  display_name: name,
  resource_type: received.resource_type,
  permission: 'editor',
  scope: `share:${id}`,
  owner_name: received.owner_name,
});
const workbenchOn = { version: 1, config: {}, locked_keys: [] };
const workbenchOff = {
  version: 2,
  config: { features: { web_workbench: false } },
  locked_keys: [],
};

/** GET/POST/DELETE /vaults over a list the test can watch, like the server. */
function vaultRoutes(initial: Record<string, unknown>[]) {
  const vaults: Record<string, unknown>[] = initial.map((v) => ({ ...v }));
  return {
    vaults,
    routes: {
      'GET /vaults': (c: RecordedCall) => ({
        items: vaults.filter((v) => c.query.get('include_deleted') === 'true' || !v['deleted_at']),
        mounts: [],
      }),
      'POST /vaults': (c: RecordedCall) => {
        const body = c.body as { name: string; kind: string };
        const v = { ...base, id: `v${vaults.length + 1}`, total_bytes: 0, file_count: 0, ...body };
        vaults.push(v);
        return v;
      },
      'DELETE /vaults/v1': () => {
        vaults[0]!['deleted_at'] = '2026-11-01T09:00:00Z';
        return undefined;
      },
      'POST /vaults/v1:restore': () => {
        delete vaults[0]!['deleted_at'];
        return vaults[0];
      },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('vaults page', () => {
  it('lists the vaults with type, size, files and the ZIP download', async () => {
    renderApp({
      path: '/vaults',
      routes: { ...vaultRoutes([notes, diary]).routes, 'GET /shares': { items: [] } },
    });
    const row = (await screen.findByRole('rowheader', { name: 'Notes' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('Shared')).toBeInTheDocument();
    expect(within(row).getByText('5 MB')).toBeInTheDocument();
    expect(within(row).getByText('42')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Download ZIP: Notes' })).toBeInTheDocument();
    const d = screen.getByRole('rowheader', { name: 'Diary' }).closest('tr') as HTMLElement;
    expect(within(d).getByText('Private (encrypted)')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Shared with me' })).not.toBeInTheDocument();
  });

  it('opens an accepted share as a mount, with its share id (MountsList)', async () => {
    const { api } = renderApp({
      path: '/vaults',
      routes: {
        ...vaultRoutes([]).routes,
        'GET /config/effective': workbenchOn,
        'GET /shared-with-me': { items: [mountOf('sh1', 'Team')] },
      },
    });
    const list = await screen.findByRole('region', { name: 'Shared with me' });
    const team = within(list).getByRole('region', { name: 'Team' });
    expect(team).toHaveTextContent('From Bob');
    expect(within(team).getByRole('link', { name: 'Open Team in the browser' })).toHaveAttribute(
      'href',
      '/vaults/v9/open?share=sh1',
    );
    // The mounts are GET /shared-with-me, through the port: no list of received shares here.
    expect(api.called('GET', '/shares')).toHaveLength(0);
  });

  it('lists the mounts without a link when the workbench is off', async () => {
    renderApp({
      path: '/vaults',
      routes: {
        ...vaultRoutes([]).routes,
        'GET /config/effective': workbenchOff,
        'GET /shared-with-me': { items: [mountOf('sh1', 'Team')] },
      },
    });
    const team = await screen.findByRole('region', { name: 'Team' });
    expect(within(team).queryByRole('link')).toBeNull();
  });

  it('shows an empty state without vaults', async () => {
    renderApp({
      path: '/vaults',
      routes: { ...vaultRoutes([]).routes, 'GET /shares': { items: [] } },
    });
    expect(await screen.findByText('You have no cloud vaults yet')).toBeInTheDocument();
  });

  it('offers to open a vault in the browser (the workbench is on by default)', async () => {
    renderApp({
      path: '/vaults',
      routes: { ...vaultRoutes([notes]).routes, 'GET /config/effective': workbenchOn },
    });
    const link = await screen.findByRole('link', { name: 'Open Notes in the browser' });
    expect(link).toHaveAttribute('href', '/vaults/v1/open');
  });

  it('hides it when the administrator turned the workbench off', async () => {
    renderApp({
      path: '/vaults',
      routes: { ...vaultRoutes([notes]).routes, 'GET /config/effective': workbenchOff },
    });
    await screen.findByRole('rowheader', { name: 'Notes' });
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /in the browser/ })).not.toBeInTheDocument(),
    );
  });

  it('creates a shared vault and lists it', async () => {
    const { api } = renderApp({
      path: '/vaults',
      routes: { ...vaultRoutes([notes]).routes, 'GET /config/effective': workbenchOn },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'New vault' }));
    const dialog = screen.getByRole('dialog', { name: 'New cloud vault' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Team' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('rowheader', { name: 'Team' })).toBeInTheDocument();
    const [post] = api.called('POST', '/vaults');
    expect(post?.body).toEqual({ name: 'Team', kind: 'shared' });
  });

  it('sends a private vault to the browser workbench, which makes its keys', async () => {
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => undefined);
    const { api } = renderApp({
      path: '/vaults',
      routes: { ...vaultRoutes([]).routes, 'GET /config/effective': workbenchOn },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'New vault' }));
    const dialog = screen.getByRole('dialog', { name: 'New cloud vault' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'My diary' } });
    await waitFor(() =>
      expect(within(dialog).getByRole('radio', { name: /Private/ })).toBeEnabled(),
    );
    fireEvent.click(within(dialog).getByRole('radio', { name: /Private/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(assign).toHaveBeenCalledWith('/vaults/new/open?kind=private&name=My%20diary');
    expect(api.called('POST', '/vaults')).toEqual([]);
  });

  it('without the workbench a private vault cannot be created here, and says why', async () => {
    renderApp({
      path: '/vaults',
      routes: { ...vaultRoutes([]).routes, 'GET /config/effective': workbenchOff },
    });
    await screen.findByText('You have no cloud vaults yet');
    fireEvent.click(screen.getByRole('button', { name: 'New vault' }));
    const dialog = screen.getByRole('dialog', { name: 'New cloud vault' });
    await waitFor(() =>
      expect(within(dialog).getByRole('radio', { name: /Private/ })).toBeDisabled(),
    );
    expect(dialog).toHaveTextContent('create it from the desktop app');
  });

  it('deletes, lists as deleted and restores, refreshing what the console shows', async () => {
    const { api } = renderApp({
      path: '/vaults',
      routes: { ...vaultRoutes([notes]).routes, 'GET /config/effective': workbenchOn },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Notes' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete “Notes”?' });
    expect(dialog).toHaveTextContent('retention period set by the administrator');
    expect(dialog).not.toHaveTextContent('copy on this device');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const gone = await screen.findByRole('table', { name: 'Deleted vaults' });
    expect(api.called('DELETE', '/vaults/v1')).toHaveLength(1);
    fireEvent.click(within(gone).getByRole('button', { name: 'Restore Notes' }));
    await waitFor(() =>
      expect(screen.queryByRole('table', { name: 'Deleted vaults' })).not.toBeInTheDocument(),
    );
    expect(api.called('POST', '/vaults/v1:restore')).toHaveLength(1);
    expect(screen.getByRole('rowheader', { name: 'Notes' })).toBeInTheDocument();
  });
});
