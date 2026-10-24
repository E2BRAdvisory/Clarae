import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/utils';

const ADMIN = { roles: ['nodus-admin'] };
const MB = 1024 ** 2;

const overview = {
  default_quota_bytes: 100 * MB,
  total_used_bytes: 300 * MB,
  user_count: 3,
  users_over_warn: 1,
  users_over_critical: 2,
  top_consumers: [
    { user_id: 'u1', username: 'alice', used_bytes: 96 * MB, quota_bytes: 100 * MB },
    { user_id: 'u2', username: 'bob', used_bytes: 50 * MB, quota_bytes: 100 * MB },
    { user_id: 'u3', username: 'carol', used_bytes: 10 * MB, quota_bytes: -1 },
  ],
  trend: [
    { day: '2026-03-01', total_bytes: 100 * MB },
    { day: '2026-03-02', total_bytes: 200 * MB },
    { day: '2026-03-03', total_bytes: 300 * MB },
  ],
};

describe('admin shell and storage dashboard', () => {
  it('redirects /admin to the dashboard and shows totals, thresholds and top consumers', async () => {
    renderApp({
      path: '/admin',
      user: ADMIN,
      routes: { 'GET /admin/storage/overview': overview },
    });
    expect(await screen.findByRole('heading', { name: 'Storage', level: 2 })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Administration sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Storage', 'Limits', 'Users', 'Groups', 'Configuration', 'Audit log']);
    expect((await screen.findByText('Total used')).closest('div')).toHaveTextContent('300 MB');
    expect(screen.getByText('Users over the critical level').closest('div')).toHaveAttribute(
      'data-level',
      'critical',
    );
    expect(screen.getByText('Users over the warning level').closest('div')).toHaveAttribute(
      'data-level',
      'warn',
    );
    const bars = screen.getAllByTestId('quota-bar');
    expect(bars.map((b) => b.getAttribute('data-level'))).toEqual(['critical', 'ok', 'ok']);
    expect(screen.getByRole('link', { name: 'alice' })).toHaveAttribute('href', '/admin/users/u1');
    expect(screen.getByText('10 MB used, no limit')).toBeInTheDocument();
  });

  it('draws the 30-day trend with a text alternative and a data table', async () => {
    renderApp({
      path: '/admin/storage',
      user: ADMIN,
      routes: { 'GET /admin/storage/overview': overview },
    });
    const chart = await screen.findByTestId('trend-chart');
    expect(chart).toHaveAttribute('role', 'img');
    expect(chart.getAttribute('aria-label')).toMatch(/100 MB.*300 MB/);
    expect(chart.querySelectorAll('circle')).toHaveLength(3);
    expect(screen.getByText('Show the data as a table')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Total storage, last 30 days' })).toBeInTheDocument();
  });

  it('is not reachable for non-administrators', async () => {
    renderApp({ path: '/admin/storage', routes: {} });
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});
