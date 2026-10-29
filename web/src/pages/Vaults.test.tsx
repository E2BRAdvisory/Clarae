import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/utils';

const base = { owner_id: 'u1', created_at: '2026-01-15T10:00:00Z' };

describe('vaults page', () => {
  it('lists vaults with kind, size, files and last seq', async () => {
    renderApp({
      path: '/vaults',
      routes: {
        'GET /vaults': {
          items: [
            {
              ...base,
              id: 'v1',
              name: 'Notes',
              kind: 'shared',
              last_seq: 1234,
              total_bytes: 5 * 1024 * 1024,
              file_count: 42,
            },
            {
              ...base,
              id: 'v2',
              name: 'Diary',
              kind: 'private',
              last_seq: 7,
              total_bytes: 2048,
              file_count: 3,
            },
          ],
          mounts: [
            {
              ...base,
              id: 'v3',
              owner_id: 'u2',
              name: 'Team',
              kind: 'shared',
              last_seq: 1,
              total_bytes: 0,
              file_count: 0,
            },
          ],
        },
      },
    });
    const notes = (await screen.findByRole('rowheader', { name: 'Notes' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(notes).getByText('Shared')).toBeInTheDocument();
    expect(within(notes).getByText('5 MB')).toBeInTheDocument();
    expect(within(notes).getByText('42')).toBeInTheDocument();
    expect(within(notes).getByText('1,234')).toBeInTheDocument();
    const diary = screen.getByRole('rowheader', { name: 'Diary' }).closest('tr') as HTMLElement;
    expect(within(diary).getByText('Private (encrypted)')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Shared with me' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Team' })).toBeInTheDocument();
  });

  it('shows an empty state without vaults', async () => {
    renderApp({ path: '/vaults', routes: { 'GET /vaults': { items: [], mounts: [] } } });
    expect(await screen.findByText('You have no vaults yet')).toBeInTheDocument();
  });

  const oneVault = {
    items: [
      {
        ...base,
        id: 'v1',
        name: 'Notes',
        kind: 'shared',
        last_seq: 1,
        total_bytes: 0,
        file_count: 0,
      },
    ],
    mounts: [],
  };

  it('offers to open a vault in the browser (the workbench is on by default)', async () => {
    renderApp({
      path: '/vaults',
      routes: {
        'GET /vaults': oneVault,
        'GET /config/effective': { version: 1, config: {}, locked_keys: [] },
      },
    });
    const link = await screen.findByRole('link', { name: 'Open Notes in the browser' });
    expect(link).toHaveAttribute('href', '/vaults/v1/open');
  });

  it('hides it when the administrator turned the workbench off', async () => {
    renderApp({
      path: '/vaults',
      routes: {
        'GET /vaults': oneVault,
        'GET /config/effective': {
          version: 2,
          config: { features: { web_workbench: false } },
          locked_keys: [],
        },
      },
    });
    await screen.findByRole('rowheader', { name: 'Notes' });
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /in the browser/ })).not.toBeInTheDocument(),
    );
  });
});
