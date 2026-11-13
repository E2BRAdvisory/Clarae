import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, type RecordedCall } from '../../test/utils';

const ADMIN = { roles: ['clarae-admin'] };
const G = '33333333-aaaa-4333-8333-333333333333';
const U1 = '11111111-aaaa-4111-8111-111111111111';
const U2 = '22222222-aaaa-4222-8222-222222222222';
const P1 = '44444444-aaaa-4444-8444-444444444444';
const P2 = '55555555-aaaa-4555-8555-555555555555';

const group = {
  id: G,
  name: 'Team',
  description: 'The team',
  member_count: 1,
  created_at: '2026-01-01T00:00:00Z',
};
const member = (id: string, username: string, role = 'member') => ({
  user_id: id,
  username,
  email: `${username}@example.com`,
  display_name: username[0]?.toUpperCase() + username.slice(1),
  member_role: role,
});
const adminUser = (id: string, username: string) => ({
  id,
  username,
  email: `${username}@example.com`,
  display_name: username,
  role: 'user',
  status: 'active',
  quota_bytes: 1,
  used_bytes: 0,
  created_at: '2026-01-01T00:00:00Z',
});
const profile = (id: string, name: string, is_global = false) => ({
  id,
  name,
  is_global,
  version: 1,
  config: {},
  locked_keys: [],
  updated_at: '2026-01-01T00:00:00Z',
});

describe('admin groups', () => {
  it('lists groups with member counts and creates one', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: '/admin/groups',
      user: ADMIN,
      routes: {
        'GET /admin/groups': { items: [group] },
        'POST /admin/groups': { ...group, id: 'new', name: 'Ops' },
      },
    });
    const row = (await screen.findByRole('link', { name: 'Team' })).closest('tr') as HTMLElement;
    expect(within(row).getByText('1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    const dialog = screen.getByRole('dialog', { name: 'Create a group' });
    await user.click(within(dialog).getByRole('button', { name: 'Create group' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('A name is required.');
    await user.type(within(dialog).getByLabelText('Name'), 'Ops');
    await user.type(within(dialog).getByLabelText('Description'), 'Operators');
    await user.click(within(dialog).getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(api.called('POST', '/admin/groups')).toHaveLength(1));
    expect(api.called('POST', '/admin/groups')[0]?.body).toEqual({
      name: 'Ops',
      description: 'Operators',
    });
  });

  it('reads the groups and the members a page at a time', async () => {
    const user = userEvent.setup();
    const second = { ...group, id: 'g2', name: 'Zeta' };
    const { api } = renderApp({
      path: '/admin/groups',
      user: ADMIN,
      routes: {
        'GET /admin/groups': (c: RecordedCall) =>
          c.query.get('cursor') === 'c1'
            ? { items: [second] }
            : { items: [group], next_cursor: 'c1' },
      },
    });
    expect(await screen.findByRole('link', { name: 'Team' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Zeta' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Zeta' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const calls = api.called('GET', '/admin/groups');
    expect(calls.map((c) => [c.query.get('limit'), c.query.get('cursor')])).toEqual([
      ['100', null],
      ['100', 'c1'],
    ]);
  });

  it('reads the members of a group a page at a time', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/admin/groups/${G}`,
      user: ADMIN,
      routes: {
        [`GET /admin/groups/${G}`]: group,
        [`GET /admin/groups/${G}/members`]: (c: RecordedCall) =>
          c.query.get('cursor') === 'm1'
            ? { items: [member(U2, 'bob')] }
            : { items: [member(U1, 'alice')], next_cursor: 'm1' },
        [`GET /admin/groups/${G}/config-profiles`]: [],
        'GET /admin/config-profiles': [],
      },
    });
    const members = await screen.findByRole('table', { name: 'Members' });
    expect(within(members).getByText('Alice')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(members).findByText('Bob')).toBeInTheDocument();
  });

  it('adds a member found by search and removes another after confirmation', async () => {
    const user = userEvent.setup();
    let members = [member(U1, 'alice')];
    const { api } = renderApp({
      path: `/admin/groups/${G}`,
      user: ADMIN,
      routes: {
        [`GET /admin/groups/${G}`]: group,
        [`GET /admin/groups/${G}/members`]: () => ({ items: members }),
        [`GET /admin/groups/${G}/config-profiles`]: [],
        'GET /admin/config-profiles': [],
        'GET /admin/users': (c: RecordedCall) => ({
          items: c.query.get('q') === 'bo' ? [adminUser(U2, 'bob'), adminUser(U1, 'alice')] : [],
          total: 2,
        }),
        [`PUT /admin/groups/${G}/members/${U2}`]: () => {
          members = [...members, member(U2, 'bob', 'manager')];
          return undefined;
        },
        [`DELETE /admin/groups/${G}/members/${U1}`]: () => {
          members = members.filter((m) => m.user_id !== U1);
          return undefined;
        },
      },
    });
    expect(await screen.findByRole('rowheader', { name: /Alice/ })).toBeInTheDocument();
    // no user search is sent before the admin searches
    expect(api.called('GET', '/admin/users')).toHaveLength(0);

    await user.type(screen.getByRole('searchbox', { name: 'Name, username or e-mail' }), 'bo');
    await user.selectOptions(screen.getByLabelText('Role in the group'), 'manager');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    // already a member: disabled
    expect(await screen.findByRole('button', { name: 'Add alice' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Add bob' }));
    await waitFor(() =>
      expect(api.called('PUT', `/admin/groups/${G}/members/${U2}`)).toHaveLength(1),
    );
    expect(api.called('PUT', `/admin/groups/${G}/members/${U2}`)[0]?.body).toEqual({
      member_role: 'manager',
    });
    expect(await screen.findByRole('rowheader', { name: /Bob/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Alice from the group' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this member?' });
    expect(api.called('DELETE', `/admin/groups/${G}/members/${U1}`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(screen.queryByRole('rowheader', { name: /Alice/ })).not.toBeInTheDocument(),
    );
    expect(api.called('DELETE', `/admin/groups/${G}/members/${U1}`)).toHaveLength(1);
  });

  it('changes a member role', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: `/admin/groups/${G}`,
      user: ADMIN,
      routes: {
        [`GET /admin/groups/${G}`]: group,
        [`GET /admin/groups/${G}/members`]: { items: [member(U1, 'alice')] },
        [`GET /admin/groups/${G}/config-profiles`]: [],
        'GET /admin/config-profiles': [],
        [`PUT /admin/groups/${G}/members/${U1}`]: () => undefined,
      },
    });
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Role of Alice' }),
      'manager',
    );
    await waitFor(() =>
      expect(api.called('PUT', `/admin/groups/${G}/members/${U1}`)).toHaveLength(1),
    );
    expect(api.called('PUT', `/admin/groups/${G}/members/${U1}`)[0]?.body).toEqual({
      member_role: 'manager',
    });
  });

  it('replaces the assigned profiles with priorities', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: `/admin/groups/${G}`,
      user: ADMIN,
      routes: {
        [`GET /admin/groups/${G}`]: group,
        [`GET /admin/groups/${G}/members`]: { items: [] },
        [`GET /admin/groups/${G}/config-profiles`]: [{ profile_id: P1, priority: 5 }],
        'GET /admin/config-profiles': [
          profile(P1, 'Base'),
          profile(P2, 'Strict'),
          profile('g', 'Global', true),
        ],
        [`PUT /admin/groups/${G}/config-profiles`]: () => undefined,
      },
    });
    const first = await screen.findByRole('combobox', { name: 'Profile 1' });
    await waitFor(() => expect(first).toHaveValue(P1));
    expect(screen.getByRole('spinbutton', { name: 'Priority of row 1' })).toHaveValue(5);
    // the global profile cannot be assigned to a group
    expect(within(first).queryByRole('option', { name: 'Global' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add a profile' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Profile 2' }), P2);
    const prio = screen.getByRole('spinbutton', { name: 'Priority of row 2' });
    await user.clear(prio);
    await user.type(prio, '10');
    await user.click(screen.getByRole('button', { name: 'Save assignments' }));
    await waitFor(() =>
      expect(api.called('PUT', `/admin/groups/${G}/config-profiles`)).toHaveLength(1),
    );
    expect(api.called('PUT', `/admin/groups/${G}/config-profiles`)[0]?.body).toEqual({
      items: [
        { profile_id: P1, priority: 5 },
        { profile_id: P2, priority: 10 },
      ],
    });

    // removing every row sends an empty list (replace-all semantics)
    await user.click(screen.getByRole('button', { name: 'Remove row 2' }));
    await user.click(screen.getByRole('button', { name: 'Remove row 1' }));
    await user.click(screen.getByRole('button', { name: 'Save assignments' }));
    await waitFor(() =>
      expect(api.called('PUT', `/admin/groups/${G}/config-profiles`)).toHaveLength(2),
    );
    expect(api.called('PUT', `/admin/groups/${G}/config-profiles`)[1]?.body).toEqual({ items: [] });
  });

  it('refuses a duplicated profile before calling the API', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: `/admin/groups/${G}`,
      user: ADMIN,
      routes: {
        [`GET /admin/groups/${G}`]: group,
        [`GET /admin/groups/${G}/members`]: { items: [] },
        [`GET /admin/groups/${G}/config-profiles`]: [{ profile_id: P1, priority: 1 }],
        'GET /admin/config-profiles': [profile(P1, 'Base')],
      },
    });
    await screen.findByRole('combobox', { name: 'Profile 1' });
    await user.click(screen.getByRole('button', { name: 'Add a profile' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Profile 2' }), P1);
    await user.click(screen.getByRole('button', { name: 'Save assignments' }));
    expect(await screen.findByText('A profile can be assigned only once.')).toBeInTheDocument();
    expect(api.called('PUT', `/admin/groups/${G}/config-profiles`)).toHaveLength(0);
  });

  it('deletes a group after confirmation', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: `/admin/groups/${G}`,
      user: ADMIN,
      routes: {
        [`GET /admin/groups/${G}`]: group,
        [`GET /admin/groups/${G}/members`]: { items: [] },
        [`GET /admin/groups/${G}/config-profiles`]: [],
        'GET /admin/config-profiles': [],
        'GET /admin/groups': { items: [] },
        [`DELETE /admin/groups/${G}`]: () => undefined,
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Delete group' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this group?' });
    expect(api.called('DELETE', `/admin/groups/${G}`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete group' }));
    expect(await screen.findByText('Group deleted.')).toBeInTheDocument();
    expect(api.called('DELETE', `/admin/groups/${G}`)).toHaveLength(1);
  });
});
