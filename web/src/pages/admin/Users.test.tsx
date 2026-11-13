import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { problem, renderApp, type RecordedCall } from '../../test/utils';

const ADMIN = { roles: ['clarae-admin'] };
const U1 = '11111111-aaaa-4111-8111-111111111111';
const U2 = '22222222-aaaa-4222-8222-222222222222';
const G1 = '33333333-aaaa-4333-8333-333333333333';

function user(over: Record<string, unknown> = {}) {
  return {
    id: U1,
    username: 'alice',
    email: 'alice@example.com',
    display_name: 'Alice Doe',
    role: 'user',
    status: 'active',
    quota_bytes: 5 * 1024 ** 3,
    quota_bytes_override: null,
    used_bytes: 1024 ** 2,
    created_at: '2026-01-15T10:00:00Z',
    ...over,
  };
}

const list = (items: unknown[], total = items.length) => ({ items, total });

describe('admin users list', () => {
  it('sends search, filters, sort and server pagination', async () => {
    const user_ = userEvent.setup();
    const { api } = renderApp({
      path: '/admin/users',
      user: ADMIN,
      routes: {
        'GET /admin/groups': {
          items: [{ id: G1, name: 'Team', member_count: 2, created_at: '2026-01-01T00:00:00Z' }],
        },
        'GET /admin/users': (c: RecordedCall) =>
          list(
            [
              user({
                id: c.query.get('offset') === '25' ? U2 : U1,
                username: c.query.get('offset') === '25' ? 'bob' : 'alice',
              }),
            ],
            60,
          ),
      },
    });
    expect(await screen.findByRole('link', { name: 'Alice Doe' })).toBeInTheDocument();
    expect(screen.getByText('1–1 of 60')).toBeInTheDocument();
    const first = api.called('GET', '/admin/users').at(-1) as RecordedCall;
    expect(first.query.get('limit')).toBe('25');
    expect(first.query.get('offset')).toBe('0');
    expect(first.query.get('sort')).toBe('name');
    expect(first.query.has('q')).toBe(false);

    await user_.type(screen.getByRole('searchbox', { name: 'Search' }), 'ali');
    await user_.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'suspended');
    await user_.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'admin');
    await user_.selectOptions(screen.getByRole('combobox', { name: 'Group' }), G1);
    await user_.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'used');
    await user_.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const q = (api.called('GET', '/admin/users').at(-1) as RecordedCall).query;
      expect(q.get('q')).toBe('ali');
    });
    const q = (api.called('GET', '/admin/users').at(-1) as RecordedCall).query;
    expect(Object.fromEntries(q)).toMatchObject({
      q: 'ali',
      status: 'suspended',
      role: 'admin',
      group: G1,
      sort: 'used',
      offset: '0',
    });

    await user_.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('link', { name: 'Alice Doe' })).toBeInTheDocument();
    await waitFor(() =>
      expect((api.called('GET', '/admin/users').at(-1) as RecordedCall).query.get('offset')).toBe(
        '25',
      ),
    );
    expect(await screen.findByText('26–26 of 60')).toBeInTheDocument();
  });

  it('creates a user and explains the optional temporary password', async () => {
    const user_ = userEvent.setup();
    const { api } = renderApp({
      path: '/admin/users',
      user: ADMIN,
      routes: {
        'GET /admin/groups': { items: [] },
        'GET /admin/users': list([user()]),
        'POST /admin/users': (c: RecordedCall) =>
          new Response(
            JSON.stringify(user({ id: U2, username: (c.body as { username: string }).username })),
            {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      },
    });
    await user_.click(await screen.findByRole('button', { name: 'Create user' }));
    const dialog = screen.getByRole('dialog', { name: 'Create a user' });
    expect(
      within(dialog).getByText(/Without a password the user receives an e-mail/),
    ).toBeInTheDocument();
    // invalid first
    await user_.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('A username and a valid e-mail');
    await user_.type(within(dialog).getByLabelText('Username'), 'bob');
    await user_.type(within(dialog).getByLabelText('E-mail'), 'bob@example.com');
    await user_.selectOptions(within(dialog).getByLabelText('Role'), 'admin');
    await user_.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await screen.findByText('User bob created.')).toBeInTheDocument();
    expect(api.called('POST', '/admin/users')[0]?.body).toEqual({
      username: 'bob',
      email: 'bob@example.com',
      role: 'admin',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows NAME_IN_USE from the API in the create dialog', async () => {
    const user_ = userEvent.setup();
    renderApp({
      path: '/admin/users',
      user: ADMIN,
      routes: {
        'GET /admin/groups': { items: [] },
        'GET /admin/users': list([]),
        'POST /admin/users': problem(409, 'NAME_IN_USE'),
      },
    });
    await user_.click(await screen.findByRole('button', { name: 'Create user' }));
    const dialog = screen.getByRole('dialog');
    await user_.type(within(dialog).getByLabelText('Username'), 'bob');
    await user_.type(within(dialog).getByLabelText('E-mail'), 'bob@example.com');
    await user_.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That name is already in use.',
    );
  });

  it('sets the quota of the selected users in bulk (default, unlimited, amount)', async () => {
    const user_ = userEvent.setup();
    const { api } = renderApp({
      path: '/admin/users',
      user: ADMIN,
      routes: {
        'GET /admin/groups': { items: [] },
        'GET /admin/users': list([user(), user({ id: U2, username: 'bob', display_name: 'Bob' })]),
        'POST /admin/storage/bulk-quota': (c: RecordedCall) => ({
          updated: (c.body as { user_ids: string[] }).user_ids.length,
        }),
      },
    });
    await user_.click(await screen.findByRole('checkbox', { name: 'Select alice' }));
    await user_.click(screen.getByRole('checkbox', { name: 'Select bob' }));
    expect(screen.getByText('2 users selected')).toBeInTheDocument();

    const run = async (choose: () => Promise<void>) => {
      await user_.click(screen.getByRole('button', { name: 'Set quota…' }));
      const dlg = screen.getByRole('dialog', { name: 'Set the quota of the selection' });
      await choose();
      await user_.click(within(dlg).getByRole('button', { name: 'Apply' }));
    };
    // 1) the default -> null
    await run(() => Promise.resolve());
    await waitFor(() => expect(api.called('POST', '/admin/storage/bulk-quota')).toHaveLength(1));
    expect(api.called('POST', '/admin/storage/bulk-quota')[0]?.body).toEqual({
      user_ids: [U1, U2],
      quota_bytes: null,
    });
    expect(await screen.findByText('Quota updated for 2 users.')).toBeInTheDocument();
    expect(screen.queryByText(/users selected/)).not.toBeInTheDocument();

    await user_.click(screen.getByRole('checkbox', { name: 'Select alice' }));
    await run(async () => {
      await user_.click(screen.getByRole('radio', { name: 'Unlimited' }));
    });
    await waitFor(() => expect(api.called('POST', '/admin/storage/bulk-quota')).toHaveLength(2));
    expect(api.called('POST', '/admin/storage/bulk-quota')[1]?.body).toEqual({
      user_ids: [U1],
      quota_bytes: -1,
    });

    await user_.click(await screen.findByRole('checkbox', { name: 'Select alice' }));
    await run(async () => {
      await user_.click(screen.getByRole('radio', { name: 'A specific amount' }));
      const dlg = screen.getByRole('dialog');
      await user_.type(within(dlg).getByLabelText('Quota'), '2');
      await user_.selectOptions(within(dlg).getByLabelText('Unit of Quota'), 'GB');
    });
    await waitFor(() => expect(api.called('POST', '/admin/storage/bulk-quota')).toHaveLength(3));
    expect(api.called('POST', '/admin/storage/bulk-quota')[2]?.body).toEqual({
      user_ids: [U1],
      quota_bytes: 2 * 1024 ** 3,
    });
  });
});

describe('admin user detail', () => {
  const detailRoutes = (u: () => unknown, extra: Record<string, unknown> = {}) => ({
    [`GET /admin/users/${U1}`]: u,
    [`GET /admin/users/${U1}/vaults`]: [
      {
        id: 'v1',
        name: 'Notes',
        kind: 'private',
        total_bytes: 2048,
        file_count: 3,
        created_at: '2026-01-15T10:00:00Z',
        deleted_at: '2026-02-01T10:00:00Z',
      },
    ],
    [`GET /admin/users/${U1}/devices`]: [
      { id: 'd1', name: 'Laptop', platform: 'linux', created_at: '2026-01-15T10:00:00Z' },
    ],
    [`GET /admin/users/${U1}/sessions`]: [
      {
        id: 's1',
        ip_address: '10.0.0.1',
        started: '2026-01-15T10:00:00Z',
        last_access: '2026-01-15T11:00:00Z',
        clients: ['clarae-desktop'],
      },
    ],
    [`GET /admin/users/${U1}/config/effective`]: {
      version: 4,
      config: { editor: { fontSize: 14 } },
      locked_keys: ['editor.fontSize'],
    },
    ...extra,
  });

  it('shows profile, vault metadata, devices, sessions and the effective configuration', async () => {
    renderApp({ path: `/admin/users/${U1}`, user: ADMIN, routes: detailRoutes(() => user()) });
    expect(await screen.findByRole('heading', { name: 'Alice Doe' })).toBeInTheDocument();
    const vaults = (await screen.findByRole('heading', { name: 'Vaults' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(vaults).findByRole('rowheader', { name: 'Notes' })).toBeInTheDocument();
    expect(within(vaults).getByText(/Deleted/)).toBeInTheDocument();
    expect(within(vaults).getByText(/cannot read vault content/)).toBeInTheDocument();
    expect(await screen.findByRole('rowheader', { name: 'Laptop' })).toBeInTheDocument();
    expect(await screen.findByRole('rowheader', { name: '10.0.0.1' })).toBeInTheDocument();
    expect(await screen.findByText(/"fontSize": 14/)).toBeInTheDocument();
    expect(screen.getByText('editor.fontSize')).toBeInTheDocument();
  });

  it('asks for confirmation before suspending and shows the new status', async () => {
    const user_ = userEvent.setup();
    let status = 'active';
    const { api } = renderApp({
      path: `/admin/users/${U1}`,
      user: ADMIN,
      routes: detailRoutes(() => user({ status }), {
        [`POST /admin/users/${U1}:suspend`]: () => {
          status = 'suspended';
          return user({ status });
        },
      }),
    });
    await user_.click(await screen.findByRole('button', { name: 'Suspend' }));
    const dialog = screen.getByRole('dialog', { name: 'Suspend this user?' });
    expect(api.called('POST', `/admin/users/${U1}:suspend`)).toHaveLength(0);
    await user_.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText('User suspended.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(api.called('POST', `/admin/users/${U1}:suspend`)).toHaveLength(1);
  });

  it('offers no suspension or deletion of oneself (the server always refuses them)', async () => {
    renderApp({
      path: `/admin/users/${U1}`,
      user: ADMIN,
      routes: detailRoutes(() => user(), {
        'GET /me': { id: U1, username: 'alice', role: 'admin' },
      }),
    });
    expect(await screen.findByRole('button', { name: 'Reset password' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete user' })).not.toBeInTheDocument();
  });

  it('explains INVALID_STATE (last administrator / yourself) in the dialog', async () => {
    const user_ = userEvent.setup();
    renderApp({
      path: `/admin/users/${U1}`,
      user: ADMIN,
      routes: detailRoutes(() => user(), {
        [`POST /admin/users/${U1}:suspend`]: problem(409, 'INVALID_STATE', 'last admin'),
      }),
    });
    await user_.click(await screen.findByRole('button', { name: 'Suspend' }));
    const dialog = screen.getByRole('dialog');
    await user_.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/last administrator/);
  });

  it('reports whether the reset e-mail was sent', async () => {
    const user_ = userEvent.setup();
    renderApp({
      path: `/admin/users/${U1}`,
      user: ADMIN,
      routes: detailRoutes(() => user(), {
        [`POST /admin/users/${U1}:reset-password`]: { email_sent: false },
      }),
    });
    await user_.click(await screen.findByRole('button', { name: 'Reset password' }));
    await user_.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset password' }),
    );
    expect(await screen.findByText(/could not be sent.*still required/)).toBeInTheDocument();
  });

  it('changes the role and edits the profile with PATCH of the changed fields only', async () => {
    const user_ = userEvent.setup();
    const { api } = renderApp({
      path: `/admin/users/${U1}`,
      user: ADMIN,
      routes: detailRoutes(() => user(), {
        [`PUT /admin/users/${U1}/role`]: user({ role: 'admin' }),
        [`PATCH /admin/users/${U1}`]: user({ display_name: 'Alice D.' }),
      }),
    });
    const role = await screen.findByLabelText('Role');
    await user_.selectOptions(role, 'admin');
    await user_.click(screen.getByRole('button', { name: 'Set role' }));
    await waitFor(() => expect(api.called('PUT', `/admin/users/${U1}/role`)).toHaveLength(1));
    expect(api.called('PUT', `/admin/users/${U1}/role`)[0]?.body).toEqual({ role: 'admin' });

    const name = screen.getByLabelText('Display name');
    await user_.clear(name);
    await user_.type(name, 'Alice D.');
    await user_.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.called('PATCH', `/admin/users/${U1}`)).toHaveLength(1));
    expect(api.called('PATCH', `/admin/users/${U1}`)[0]?.body).toEqual({
      display_name: 'Alice D.',
    });
  });

  it('sends an empty body for the default quota, -1 for unlimited', async () => {
    const user_ = userEvent.setup();
    const { api } = renderApp({
      path: `/admin/users/${U1}`,
      user: ADMIN,
      routes: detailRoutes(() => user({ quota_bytes_override: 3 * 1024 ** 3 }), {
        [`PUT /admin/users/${U1}/quota`]: user(),
      }),
    });
    await user_.click(await screen.findByRole('button', { name: 'Change quota…' }));
    let dialog = screen.getByRole('dialog', { name: 'Quota of alice' });
    // pre-filled with the current override
    expect(within(dialog).getByLabelText('Quota')).toHaveValue(3);
    expect(within(dialog).getByLabelText('Unit of Quota')).toHaveValue('GB');
    await user_.click(within(dialog).getByRole('radio', { name: 'Use the default quota' }));
    await user_.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.called('PUT', `/admin/users/${U1}/quota`)).toHaveLength(1));
    expect(api.called('PUT', `/admin/users/${U1}/quota`)[0]?.body).toEqual({});

    await user_.click(await screen.findByRole('button', { name: 'Change quota…' }));
    dialog = screen.getByRole('dialog');
    await user_.click(within(dialog).getByRole('radio', { name: 'Unlimited' }));
    await user_.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.called('PUT', `/admin/users/${U1}/quota`)).toHaveLength(2));
    expect(api.called('PUT', `/admin/users/${U1}/quota`)[1]?.body).toEqual({ quota_bytes: -1 });
  });

  it('requires typing the username to delete, then returns to the list', async () => {
    const user_ = userEvent.setup();
    const { api } = renderApp({
      path: `/admin/users/${U1}`,
      user: ADMIN,
      routes: {
        ...detailRoutes(() => user()),
        [`DELETE /admin/users/${U1}`]: () => undefined,
        'GET /admin/groups': { items: [] },
        'GET /admin/users': list([]),
      },
    });
    await user_.click(await screen.findByRole('button', { name: 'Delete user' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this user?' });
    expect(within(dialog).getByText(/retention period/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Delete user' });
    expect(confirm).toBeDisabled();
    await user_.type(within(dialog).getByLabelText('Type alice to confirm'), 'alice');
    expect(confirm).toBeEnabled();
    await user_.click(confirm);
    expect(await screen.findByText('User alice deleted.')).toBeInTheDocument();
    expect(api.called('DELETE', `/admin/users/${U1}`)).toHaveLength(1);
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
  });
});
