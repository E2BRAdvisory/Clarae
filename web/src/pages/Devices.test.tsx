import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { problem, renderApp } from '../test/utils';

const laptop = {
  id: 'd1',
  name: 'Laptop',
  platform: 'macos',
  app_version: '1.0.0',
  created_at: '2026-01-01T00:00:00Z',
  last_seen_at: '2026-02-01T10:00:00Z',
};
const old = {
  id: 'd2',
  name: 'Old PC',
  platform: 'windows',
  created_at: '2025-01-01T00:00:00Z',
  revoked_at: '2025-06-01T00:00:00Z',
};

describe('devices page', () => {
  it('lists devices; revoked ones have no revoke button', async () => {
    renderApp({ path: '/devices', routes: { 'GET /me/devices': { items: [laptop, old] } } });
    expect(await screen.findByRole('rowheader', { name: 'Laptop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke Laptop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke Old PC' })).not.toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });

  it('revokes after confirmation and reloads the list', async () => {
    let items = [laptop];
    const { api } = renderApp({
      path: '/devices',
      routes: {
        'GET /me/devices': () => ({ items }),
        'DELETE /me/devices/d1': () => {
          items = [{ ...laptop, revoked_at: '2026-03-01T00:00:00Z' } as typeof laptop];
          return undefined;
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revoke Laptop' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke this device?' });
    expect(api.called('DELETE', '/me/devices/d1')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.called('DELETE', '/me/devices/d1')).toHaveLength(1));
    expect(await screen.findByText('Device revoked.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
  });

  it('cancelling does not call the API', async () => {
    const { api } = renderApp({
      path: '/devices',
      routes: { 'GET /me/devices': { items: [laptop] } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revoke Laptop' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.called('DELETE', '/me/devices/d1')).toHaveLength(0);
  });

  it('shows the error in the dialog when the revoke fails', async () => {
    renderApp({
      path: '/devices',
      routes: {
        'GET /me/devices': { items: [laptop] },
        'DELETE /me/devices/d1': () => problem(404, 'NOT_FOUND'),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revoke Laptop' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'Not found',
    );
  });
});
