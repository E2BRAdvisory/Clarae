// The Devices page mounts the DevicesPanel of @memobrain/cloud-features (its behaviour is tested by
// the package's suite on both adapters): here, the wiring to the REST API and the page.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { problem, renderApp } from '../test/utils';

// The browser workbench remembers which device this browser is (IndexedDB, ADR-0029).
vi.mock('../workbench/device', () => ({
  thisBrowserDevice: vi.fn((userId: string) => Promise.resolve(userId === 'u1' ? 'd-web' : null)),
}));

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
  it('marks this browser and keeps it from being revoked here', async () => {
    const browser = {
      id: 'd-web',
      name: 'Firefox',
      platform: 'web',
      created_at: '2026-01-01T00:00:00Z',
    };
    renderApp({ path: '/devices', routes: { 'GET /me/devices': { items: [laptop, browser] } } });
    const table = await screen.findByRole('table', { name: 'Devices' });
    const row = await within(table).findByRole('rowheader', { name: /Firefox/ });
    await waitFor(() => expect(row).toHaveTextContent('This device'));
    expect(screen.queryByRole('button', { name: 'Revoke Firefox' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke Laptop' })).toBeInTheDocument();
  });

  it('lists devices; revoked ones have no revoke button', async () => {
    renderApp({ path: '/devices', routes: { 'GET /me/devices': { items: [laptop, old] } } });
    expect(await screen.findByRole('heading', { name: 'Devices' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Devices' });
    expect(within(table).getByRole('rowheader', { name: 'Laptop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke Laptop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke Old PC' })).not.toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText('macOS')).toBeInTheDocument();
  });

  it('revokes after confirmation with DELETE /me/devices/{id}', async () => {
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
    expect(await screen.findByText('“Laptop” revoked.')).toBeInTheDocument();
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
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
      'The device no longer exists.',
    );
  });
});
