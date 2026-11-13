import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp, type RecordedCall } from '../../test/utils';

const ADMIN = { roles: ['clarae-admin'] };
const U1 = '11111111-aaaa-4111-8111-111111111111';

const entry = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  at: '2026-03-01T10:00:00Z',
  actor_id: U1,
  actor_name: 'alice',
  action: 'user.suspend',
  target_type: 'user',
  target_id: 'u-9',
  ip: '10.0.0.1',
  details: { reason: 'test' },
  ...over,
});

describe('audit log', () => {
  it('filters, paginates with the cursor and expands the details', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: '/admin/audit',
      user: ADMIN,
      routes: {
        'GET /admin/users': {
          items: [
            {
              id: U1,
              username: 'alice',
              display_name: 'Alice',
              email: 'a@x',
              role: 'user',
              status: 'active',
              quota_bytes: 1,
              used_bytes: 0,
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          total: 1,
        },
        'GET /admin/audit-log': (c: RecordedCall) =>
          c.query.get('cursor') === 'c1'
            ? { items: [entry(1, { action: 'vault.delete', details: {} })] }
            : { items: [entry(2)], next_cursor: 'c1' },
      },
    });
    expect(await screen.findByText('user.suspend')).toBeInTheDocument();
    expect((api.called('GET', '/admin/audit-log')[0] as RecordedCall).query.get('limit')).toBe(
      '100',
    );

    await user.click(screen.getByRole('button', { name: 'Show details of user.suspend' }));
    expect(screen.getByText(/"reason": "test"/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('vault.delete')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(api.called('GET', '/admin/audit-log').at(-1)?.query.get('cursor')).toBe('c1');

    // filters
    await user.type(screen.getByRole('searchbox', { name: 'Find a user' }), 'ali');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: 'Filter by alice' }));
    await user.type(screen.getByLabelText('Action'), 'user.');
    await user.type(screen.getByLabelText('Target'), 'u-9');
    await user.type(screen.getByLabelText('From'), '2026-03-01T08:00');
    await user.type(screen.getByLabelText('To'), '2026-03-02T08:00');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => {
      const q = api.called('GET', '/admin/audit-log').at(-1)?.query;
      expect(q?.get('actor')).toBe(U1);
    });
    const q = api.called('GET', '/admin/audit-log').at(-1)?.query as URLSearchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      actor: U1,
      action: 'user.',
      target: 'u-9',
      from: new Date('2026-03-01T08:00').toISOString(),
      to: new Date('2026-03-02T08:00').toISOString(),
    });
    expect(q.has('cursor')).toBe(false);
  });
});

describe('audit CSV export', () => {
  let created: Blob[] = [];
  const revoke = vi.fn();
  beforeEach(() => {
    created = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return 'blob:test';
    });
    URL.revokeObjectURL = revoke;
  });
  afterEach(() => vi.restoreAllMocks());

  it('requests the CSV with the same filters and downloads it as a file', async () => {
    const user = userEvent.setup();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(`${this.download}|${this.href}`);
    });
    const { api } = renderApp({
      path: '/admin/audit',
      user: ADMIN,
      routes: {
        'GET /admin/audit-log': { items: [] },
        'GET /admin/audit-log.csv': () =>
          new Response('id,at\n1,2026\n', { status: 200, headers: { 'Content-Type': 'text/csv' } }),
      },
    });
    await user.type(await screen.findByLabelText('Action'), 'user.');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(api.called('GET', '/admin/audit-log.csv')).toHaveLength(1));
    const call = api.called('GET', '/admin/audit-log.csv')[0] as RecordedCall;
    expect(call.query.get('action')).toBe('user.');
    expect(call.query.has('limit')).toBe(false);
    await waitFor(() => expect(clicked).toEqual(['audit-log.csv|blob:test']));
    expect(await created[0]?.text()).toBe('id,at\n1,2026\n');
    // The object URL is revoked a minute later (shared/download.ts, covered by its own test).
    expect(revoke).not.toHaveBeenCalled();
    expect(await screen.findByText('Audit log exported.')).toBeInTheDocument();
  });

  it('shows an error when the export is refused', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/admin/audit',
      user: ADMIN,
      routes: {
        'GET /admin/audit-log': { items: [] },
        'GET /admin/audit-log.csv': () =>
          new Response(
            JSON.stringify({ type: 'about:blank', title: 'x', status: 403, code: 'FORBIDDEN' }),
            {
              status: 403,
              headers: { 'Content-Type': 'application/problem+json' },
            },
          ),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('You are not allowed to do this.')).toBeInTheDocument();
  });
});
