import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeOpfs } from '../test/fakeOpfs';
import { problem, renderApp, type FakeAuth } from '../test/utils';
import { readMarkers, updateMarker } from '../workbench/markers';
import { accountKey } from '../workbench/storage';

/** The storage key of the signed-in test user (fakeAuth: subject u1), and of another account. */
const alice = () => accountKey({ server: location.origin, subject: 'u1' });
const bob = () => accountKey({ server: location.origin, subject: 'someone-else' });

const me = { id: 'u1', username: 'alice' };
const vault = (kind: 'shared' | 'private', name: string) => ({
  id: name,
  owner_id: 'u1',
  name,
  kind,
  last_seq: 0,
  total_bytes: 0,
  file_count: 0,
  created_at: '2026-01-01T00:00:00Z',
});

afterEach(() => vi.restoreAllMocks());

describe('account page', () => {
  it('lists the groups of the user (GET /me/groups)', async () => {
    renderApp({
      path: '/account',
      routes: {
        'GET /me': me,
        'GET /vaults': { items: [], mounts: [] },
        'GET /me/groups': [
          { id: 'g1', name: 'engineers', description: 'The engineers', member_role: 'member' },
        ],
      },
    });
    expect(await screen.findByRole('heading', { name: 'My groups' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'My groups' });
    const row = within(table).getByRole('rowheader', { name: 'engineers' }).closest('tr');
    expect(row).toHaveTextContent('The engineers');
    expect(row).toHaveTextContent('Member');
  });

  it('downloads the account data as a file', async () => {
    const create = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const { api } = renderApp({
      path: '/account',
      routes: {
        'GET /me': me,
        'GET /vaults': { items: [], mounts: [] },
        'GET /me/export': { profile: { id: 'u1' } },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Download my data' }));
    await waitFor(() => expect(api.called('GET', '/me/export')).toHaveLength(1));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Your data was downloaded.')).toBeInTheDocument();
  });

  it('requires the username before deleting and signs out afterwards', async () => {
    localStorage.clear();
    // Copies of this account (one with changes that can never be uploaded now) and of another one.
    updateMarker(await alice(), 'v1', { name: 'Diary', kind: 'private', pending: 2 });
    updateMarker(await bob(), 'b1', { name: 'Bob', kind: 'private', pending: 1 });
    const { api, auth } = renderApp({
      path: '/account',
      routes: {
        'GET /me': me,
        'GET /vaults': { items: [vault('shared', 'Docs')], mounts: [] },
        'DELETE /me': () => undefined,
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete your account?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(confirm).toBeDisabled();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Type your username/), 'alic');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type your username/), 'e');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(api.called('DELETE', '/me')).toHaveLength(1));
    expect(api.called('DELETE', '/me')[0]?.body).toEqual({ confirm: 'alice' });
    await waitFor(() => expect((auth as FakeAuth).signOut).toHaveBeenCalled());
    // The account's copies left the browser without a question; the other account's stayed.
    expect(screen.queryByRole('dialog', { name: 'Changes not uploaded' })).not.toBeInTheDocument();
    expect(readMarkers(await alice())).toEqual({});
    expect(Object.keys(readMarkers(await bob()))).toEqual(['b1']);
  });

  it('warns about private vaults and needs an explicit acknowledgement', async () => {
    const { api } = renderApp({
      path: '/account',
      routes: {
        'GET /me': me,
        'GET /vaults': { items: [vault('private', 'Diary')], mounts: [] },
        'DELETE /me': () => undefined,
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('irrecoverable');
    expect(within(dialog).getByText('Diary')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Type your username/), 'alice');
    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox'));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(api.called('DELETE', '/me')).toHaveLength(1));
    expect(api.called('DELETE', '/me')[0]?.body).toEqual({
      confirm: 'alice',
      acknowledge_data_loss: true,
    });
  });

  it('shows the server error and does not sign out', async () => {
    const { auth } = renderApp({
      path: '/account',
      routes: {
        'GET /me': me,
        'GET /vaults': { items: [], mounts: [] },
        'DELETE /me': () => problem(409, 'INVALID_STATE', 'this is the last active administrator'),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Type your username/), 'alice');
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This is not possible in the current state.',
    );
    expect((auth as FakeAuth).signOut).not.toHaveBeenCalled();
  });

  it('asks before forgetting a browser that keeps changes not uploaded, then forgets it', async () => {
    localStorage.clear();
    updateMarker(await alice(), 'v1', {
      name: 'Diary',
      kind: 'private',
      localPath: '/vaults/v1',
      pending: 1,
    });
    renderApp({
      path: '/account',
      routes: { 'GET /me': me, 'GET /vaults': { items: [], mounts: [] } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Forget this browser' }));
    const dialog = screen.getByRole('dialog', { name: 'Changes not uploaded' });
    expect(dialog).toHaveTextContent('Diary — 1 change not uploaded');
    await user.click(within(dialog).getByRole('button', { name: 'Delete them' }));
    expect(
      await screen.findByText('This browser no longer holds any of your vaults.'),
    ).toBeInTheDocument();
    expect(readMarkers(await alice())).toEqual({});
  });

  it('signs out at once when the browser keeps nothing that was not uploaded', async () => {
    localStorage.clear();
    const { auth } = renderApp({
      path: '/account',
      routes: { 'GET /me': me, 'GET /vaults': { items: [], mounts: [] } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect((auth as FakeAuth).signOut).toHaveBeenCalled());
  });

  it('offers to delete the copies of an earlier version that nobody adopted, after a warning', async () => {
    const { root, restore } = installFakeOpfs();
    try {
      await root.write('fs/vaults/v1/Note.md', 'clear text of someone');
      await root.mkdir('memobrain-sqlite');
      await root.write(`accounts/${await alice()}/fs/x`, 'mine');
      renderApp({
        path: '/account',
        routes: { 'GET /me': me, 'GET /vaults': { items: [], mounts: [] } },
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Delete these copies' }));
      const dialog = screen.getByRole('dialog', {
        name: 'Delete the copies of the earlier version?',
      });
      expect(dialog).toHaveTextContent('may belong to another account');
      await user.click(within(dialog).getByRole('button', { name: 'Delete these copies' }));
      expect(
        await screen.findByText('The copies of the earlier version were deleted.'),
      ).toBeInTheDocument();
      expect(root.names()).toEqual(['accounts']);
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Delete these copies' }),
        ).not.toBeInTheDocument(),
      );
    } finally {
      restore();
    }
  });
});
