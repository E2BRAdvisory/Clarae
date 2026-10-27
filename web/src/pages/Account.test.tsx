import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { problem, renderApp, type FakeAuth } from '../test/utils';

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
});
