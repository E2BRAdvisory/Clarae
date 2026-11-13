// The Usage page mounts the UsagePanel of @clarae/cloud-features: here, the wiring to the REST API.
// The level shown is the server's (ADR-0037 §2), whatever the default thresholds would say.
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/utils';

const GB = 1024 ** 3;
const vault = (id: string, name: string, bytes: number) => ({
  id,
  owner_id: 'u1',
  name,
  kind: 'shared',
  last_seq: 1,
  total_bytes: bytes,
  file_count: 3,
  created_at: '2026-01-01T00:00:00Z',
});

describe('usage page', () => {
  it('shows the bar with the level of the server and the space of each vault', async () => {
    renderApp({
      path: '/usage',
      routes: {
        // 70 %: below the default 80 %, but the administrator set the warning lower.
        'GET /me/usage': { used_bytes: 0.7 * GB * 4, quota_bytes: 4 * GB, level: 'warning' },
        'GET /vaults': {
          items: [vault('v1', 'Notes', GB), vault('v2', 'Work', 2 * GB)],
          mounts: [],
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Storage used' })).toBeInTheDocument();
    expect(await screen.findByText('2.8 GB of 4 GB')).toBeInTheDocument();
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-level', 'warn');
    expect(screen.getByRole('status')).toHaveTextContent('Your space is running low.');
    const table = await screen.findByRole('table', { name: 'Space by vault' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((r) => r.textContent),
    ).toEqual(['Work', 'Notes']);
  });

  it('handles an unlimited quota', async () => {
    renderApp({
      path: '/usage',
      routes: {
        'GET /me/usage': { used_bytes: 2 * GB, quota_bytes: -1, level: 'ok' },
        'GET /vaults': { items: [], mounts: [] },
      },
    });
    expect(await screen.findByText('2 GB used, no limit')).toBeInTheDocument();
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-level', 'ok');
  });
});
