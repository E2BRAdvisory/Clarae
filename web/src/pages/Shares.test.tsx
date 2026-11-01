// The Sharing page mounts InvitationsList and SharesManager of @memobrain/cloud-features (their
// behaviour is tested by the package's suite on both adapters): here, the REST calls the page makes,
// the link to open a mount and the `sharing` flag.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, type RecordedCall } from '../test/utils';

const ME = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const V1 = '0198f1c2-aaaa-7bbb-8ccc-000000000001';

const common = {
  vault_id: V1,
  vault_name: 'Docs',
  resource_type: 'folder',
  created_at: '2026-01-01T00:00:00Z',
};
const invitation = {
  ...common,
  id: 's-inv',
  display_name: 'Budget',
  owner_id: BOB,
  owner_name: 'Bob',
  my_permission: 'editor',
  my_status: 'pending',
};
const mount = { ...invitation, id: 's-mnt', display_name: 'Wiki', my_status: 'accepted' };
const owned = {
  ...common,
  id: 's-own',
  display_name: 'Project X',
  owner_id: ME,
  owner_name: 'Alice',
  grants: [],
};
const vaults = {
  items: [
    {
      id: V1,
      owner_id: ME,
      name: 'Docs',
      kind: 'shared',
      last_seq: 1,
      total_bytes: 0,
      file_count: 0,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'p1',
      owner_id: ME,
      name: 'Diary',
      kind: 'private',
      last_seq: 1,
      total_bytes: 0,
      file_count: 0,
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
  mounts: [],
};

function sharesRoute(own: () => unknown, received: () => unknown) {
  return (call: RecordedCall) => (call.query.get('scope') === 'owned' ? own() : received());
}

describe('shares page', () => {
  it('shows the shares received, with Open on an accepted one, and the shares created', async () => {
    renderApp({
      path: '/shares',
      routes: {
        'GET /me': { id: ME },
        'GET /shares': sharesRoute(
          () => [owned],
          () => [invitation, mount],
        ),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Shared with me' })).toBeInTheDocument();
    const inv = await screen.findByRole('region', { name: 'Budget' });
    expect(within(inv).getByRole('button', { name: 'Accept Budget' })).toBeInTheDocument();
    const wiki = screen.getByRole('region', { name: 'Wiki' });
    expect(within(wiki).getByRole('link', { name: 'Open Wiki in the browser' })).toHaveAttribute(
      'href',
      `/vaults/${V1}/open?share=s-mnt`,
    );
    expect(await screen.findByRole('region', { name: 'Project X' })).toBeInTheDocument();
  });

  it('accepts an invitation with POST /shares/{id}:accept', async () => {
    let received: unknown[] = [invitation];
    const { api } = renderApp({
      path: '/shares',
      routes: {
        'GET /shares': sharesRoute(
          () => [],
          () => received,
        ),
        'POST /shares/s-inv:accept': () => {
          received = [{ ...invitation, my_status: 'accepted' }];
          return received[0];
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept Budget' }));
    await waitFor(() => expect(api.called('POST', '/shares/s-inv:accept')).toHaveLength(1));
    expect(await screen.findByText('Invitation to “Budget” accepted.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Accepted shares' })).toBeInTheDocument();
  });

  it('creates a share of a folder with POST /shares; private vaults are not offered', async () => {
    let list: unknown[] = [];
    const { api } = renderApp({
      path: '/shares',
      routes: {
        'GET /shares': sharesRoute(
          () => list,
          () => [],
        ),
        'GET /vaults': vaults,
        'POST /shares': (call: RecordedCall) => {
          const s = { ...owned, ...(call.body as object), id: 's-new', grants: [] };
          list = [s];
          return new Response(JSON.stringify(s), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New share' }));
    const dialog = screen.getByRole('dialog', { name: 'New share' });
    await waitFor(() =>
      expect(
        within(within(dialog).getByLabelText('Vault'))
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Docs']),
    );
    await user.click(within(dialog).getByRole('radio', { name: 'A folder' }));
    await user.type(within(dialog).getByLabelText('Folder'), 'Plans/2027');
    await user.click(within(dialog).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(api.called('POST', '/shares')).toHaveLength(1));
    expect(api.called('POST', '/shares')[0]?.body).toEqual({
      vault_id: V1,
      display_name: '2027',
      resource_type: 'folder',
      path_prefix: 'Plans/2027',
    });
    expect(await screen.findByRole('region', { name: '2027' })).toBeInTheDocument();
  });

  it('renames a share with PATCH /shares/{id}', async () => {
    let share = { ...owned };
    const { api } = renderApp({
      path: '/shares',
      routes: {
        'GET /shares': sharesRoute(
          () => [share],
          () => [],
        ),
        'PATCH /shares/s-own': (call: RecordedCall) => {
          share = { ...share, ...(call.body as object) };
          return share;
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Project X' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit “Project X”' });
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Project Y');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.called('PATCH', '/shares/s-own')).toHaveLength(1));
    expect(api.called('PATCH', '/shares/s-own')[0]?.body).toEqual({ display_name: 'Project Y' });
    expect(await screen.findByRole('region', { name: 'Project Y' })).toBeInTheDocument();
  });

  it('is turned off, with its menu entry, when the administrator disables sharing', async () => {
    const { api } = renderApp({
      path: '/shares',
      routes: {
        'GET /config/effective': {
          version: 1,
          config: { features: { sharing: false } },
          locked_keys: [],
        },
        'GET /shares': [invitation],
      },
    });
    expect(
      await screen.findByText('Sharing is turned off by your administrator.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Sharing' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('region', { name: 'Budget' })).not.toBeInTheDocument();
    expect(api.called('GET', '/shares')).toHaveLength(0);
  });
});
