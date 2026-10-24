import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { problem, renderApp, type RecordedCall } from '../test/utils';

const ME = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';
const CAROL = '44444444-4444-4444-8444-444444444444';

const common = {
  vault_id: 'v1',
  vault_name: 'Docs',
  resource_type: 'folder',
  created_at: '2026-01-01T00:00:00Z',
};

function ownedShare(grants: unknown[]) {
  return {
    ...common,
    id: 's-own',
    display_name: 'Project X',
    owner_id: ME,
    owner_name: 'Alice',
    grants,
  };
}
const invitation = {
  ...common,
  id: 's-inv',
  display_name: 'Budget',
  owner_id: BOB,
  owner_name: 'Bob',
  my_permission: 'editor',
  my_status: 'pending',
};
const mount = {
  ...common,
  id: 's-mnt',
  display_name: 'Wiki',
  owner_id: BOB,
  owner_name: 'Bob',
  my_permission: 'viewer',
  my_status: 'accepted',
};

function sharesRoute(owned: () => unknown, received: () => unknown) {
  return (call: RecordedCall) => (call.query.get('scope') === 'owned' ? owned() : received());
}

describe('shares page: received', () => {
  it('shows invitations and accepted shares', async () => {
    renderApp({
      path: '/shares',
      routes: {
        'GET /me': { id: ME },
        'GET /shares': sharesRoute(
          () => [],
          () => [invitation, mount],
        ),
      },
    });
    const inv = await screen.findByRole('region', { name: 'Budget' });
    expect(within(inv).getByText(/From Bob/)).toBeInTheDocument();
    expect(within(inv).getByText('Editor')).toBeInTheDocument();
    expect(within(inv).getByRole('button', { name: 'Accept: Budget' })).toBeInTheDocument();
    const acc = screen.getByRole('region', { name: 'Wiki' });
    expect(within(acc).queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument();
    expect(within(acc).getByText('Accepted')).toBeInTheDocument();
  });

  it('accepts an invitation and refreshes', async () => {
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
    await user.click(await screen.findByRole('button', { name: 'Accept: Budget' }));
    await waitFor(() => expect(api.called('POST', '/shares/s-inv:accept')).toHaveLength(1));
    expect(await screen.findByText('Invitation accepted.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Accepted shares' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept: Budget' })).not.toBeInTheDocument();
  });

  it('declines an invitation', async () => {
    let received: unknown[] = [invitation];
    const { api } = renderApp({
      path: '/shares',
      routes: {
        'GET /shares': sharesRoute(
          () => [],
          () => received,
        ),
        'POST /shares/s-inv:decline': () => {
          received = [{ ...invitation, my_status: 'declined' }];
          return received[0];
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Decline: Budget' }));
    await waitFor(() => expect(api.called('POST', '/shares/s-inv:decline')).toHaveLength(1));
    expect(await screen.findByRole('heading', { name: 'Declined' })).toBeInTheDocument();
  });

  it('shows the API error when declining is not possible', async () => {
    renderApp({
      path: '/shares',
      routes: {
        'GET /shares': sharesRoute(
          () => [],
          () => [invitation],
        ),
        'POST /shares/s-inv:decline': () => problem(409, 'INVALID_STATE'),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Decline: Budget' }));
    expect(
      await screen.findByText('This is not possible in the current state.'),
    ).toBeInTheDocument();
  });
});

describe('shares page: owned', () => {
  const grantBob = {
    principal_type: 'user',
    principal_id: BOB,
    principal_name: 'Bob',
    permission: 'viewer',
    status: 'accepted',
    created_at: '2026-01-02T00:00:00Z',
  };
  const grantTeam = {
    principal_type: 'group',
    principal_id: TEAM,
    principal_name: 'Team',
    permission: 'editor',
    status: 'pending',
    created_at: '2026-01-02T00:00:00Z',
  };

  it('revokes a share after confirmation', async () => {
    let owned: unknown[] = [ownedShare([grantBob])];
    const { api } = renderApp({
      path: '/shares',
      routes: {
        'GET /me': { id: ME },
        'GET /shares': sharesRoute(
          () => owned,
          () => [],
        ),
        'DELETE /shares/s-own': () => {
          owned = [];
          return undefined;
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revoke share: Project X' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke this share?' });
    expect(api.called('DELETE', '/shares/s-own')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke share' }));
    await waitFor(() => expect(api.called('DELETE', '/shares/s-own')).toHaveLength(1));
    expect(await screen.findByText('Share revoked.')).toBeInTheDocument();
    expect(await screen.findByText('You have not shared anything yet')).toBeInTheDocument();
  });

  it('only the owner can revoke; a manager just manages', async () => {
    const managed = {
      ...ownedShare([grantBob]),
      owner_id: BOB,
      owner_name: 'Bob',
      my_permission: 'manager',
    };
    renderApp({
      path: '/shares',
      routes: {
        'GET /me': { id: ME },
        'GET /shares': sharesRoute(
          () => [managed],
          () => [],
        ),
      },
    });
    expect(await screen.findByRole('button', { name: 'Manage access' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke share/ })).not.toBeInTheDocument();
  });

  it('lists grants, changes a permission and removes a grant', async () => {
    let grants: unknown[] = [grantBob, grantTeam];
    const { api } = renderApp({
      path: '/shares',
      routes: {
        'GET /me': { id: ME },
        'GET /shares': sharesRoute(
          () => [ownedShare(grants)],
          () => [],
        ),
        [`PUT /shares/s-own/grants/user/${BOB}`]: (call: RecordedCall) => {
          grants = [{ ...grantBob, ...(call.body as object) }, grantTeam];
          return grants[0];
        },
        [`DELETE /shares/s-own/grants/group/${TEAM}`]: () => {
          grants = [grantBob];
          return undefined;
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Manage access' }));
    const table = screen.getByRole('table', { name: 'Access' });
    expect(within(table).getByRole('rowheader', { name: /Bob/ })).toBeInTheDocument();
    expect(within(table).getByText('Pending')).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Permission for Bob' }),
      'editor',
    );
    await waitFor(() =>
      expect(api.called('PUT', `/shares/s-own/grants/user/${BOB}`)).toHaveLength(1),
    );
    expect(api.called('PUT', `/shares/s-own/grants/user/${BOB}`)[0]?.body).toEqual({
      permission: 'editor',
    });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Permission for Bob' })).toHaveValue('editor'),
    );

    await user.click(screen.getByRole('button', { name: 'Remove access of Team' }));
    await waitFor(() =>
      expect(api.called('DELETE', `/shares/s-own/grants/group/${TEAM}`)).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.queryByRole('rowheader', { name: /Team/ })).not.toBeInTheDocument(),
    );
  });

  it('adds a grant found through the directory search', async () => {
    let grants: unknown[] = [grantBob];
    const { api } = renderApp({
      path: '/shares',
      routes: {
        'GET /me': { id: ME },
        'GET /shares': sharesRoute(
          () => [ownedShare(grants)],
          () => [],
        ),
        'GET /directory/users': () => [
          { id: CAROL, username: 'carol', display_name: 'Carol Smith' },
          { id: BOB, username: 'bob', display_name: 'Bob' },
        ],
        [`PUT /shares/s-own/grants/user/${CAROL}`]: (call: RecordedCall) => {
          const g = {
            principal_type: 'user',
            principal_id: CAROL,
            principal_name: 'Carol Smith',
            status: 'pending',
            created_at: '2026-01-03T00:00:00Z',
            ...(call.body as object),
          };
          grants = [grantBob, g];
          return g;
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Manage access' }));
    await user.type(screen.getByLabelText('Name or username'), 'car');
    await user.selectOptions(screen.getByLabelText('Permission'), 'editor');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(api.called('GET', '/directory/users')[0]?.query.get('q')).toBe('car');
    // Bob already has access: his Add button is disabled.
    expect(await screen.findByRole('button', { name: 'Add Bob' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Add Carol Smith' }));
    await waitFor(() =>
      expect(api.called('PUT', `/shares/s-own/grants/user/${CAROL}`)).toHaveLength(1),
    );
    expect(api.called('PUT', `/shares/s-own/grants/user/${CAROL}`)[0]?.body).toEqual({
      permission: 'editor',
    });
    expect(
      await screen.findByRole('combobox', { name: 'Permission for Carol Smith' }),
    ).toBeInTheDocument();
  });

  it('searches groups when the principal type is group', async () => {
    const { api } = renderApp({
      path: '/shares',
      routes: {
        'GET /me': { id: ME },
        'GET /shares': sharesRoute(
          () => [ownedShare([])],
          () => [],
        ),
        'GET /directory/groups': () => [{ id: TEAM, name: 'Team', description: 'Everyone' }],
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Manage access' }));
    expect(screen.getByText('Nobody has access yet.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Add a'), 'group');
    await user.type(screen.getByLabelText('Name or username'), 'te');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('button', { name: 'Add Team' })).toBeEnabled();
    expect(api.called('GET', '/directory/groups')).toHaveLength(1);
  });
});
