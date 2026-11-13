// One suite for CloudVaultsTable, run against every adapter (ADR-0037 §2): RestCloudPort over the
// fake REST endpoints here, CoreCloudPort over the Wails mock in @clarae/workbench. What a host
// adds (the console's export column, the workbench's connect flow) is tested by the host.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloudVaultsTable, type CloudVaultsTableProps } from '../CloudVaultsTable';
import { formatDay, purgeDate } from '../format';
import type { CloudPort } from '../port';
import type { SeedVault } from './fakeRest';

export interface SuiteHarness {
  /** Shown by the test runner ("RestCloudPort", "CoreCloudPort"). */
  name: string;
  /** A port over a backend that holds exactly these vaults. */
  setup(seed: SeedVault[]): Promise<CloudPort> | CloudPort;
}

const MB = 1024 * 1024;

export function cloudVaultsTableSuite(h: SuiteHarness): void {
  async function mount(seed: SeedVault[], props: Partial<CloudVaultsTableProps> = {}) {
    const port = await h.setup(seed);
    const callbacks = {
      onChanged: vi.fn(),
      onCreatePrivate: vi.fn(),
      // A host that cannot create a shared vault by itself brings its own flow.
      onNew: port.capabilities.createShared ? undefined : vi.fn(),
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CloudVaultsTable port={port} lang="en" {...callbacks} {...props} />
      </QueryClientProvider>,
    );
    return { port, ...callbacks };
  }

  const liveTable = () => screen.getByRole('table', { name: 'Cloud vaults' });
  const deletedTable = () => screen.findByRole('table', { name: 'Deleted vaults' });
  const row = (table: HTMLElement, name: string) =>
    within(table).getByRole('rowheader', { name }).closest('tr') as HTMLElement;

  describe(`CloudVaultsTable on ${h.name}`, () => {
    it('lists the vaults with type, size and files', async () => {
      await mount([
        { name: 'Notes', kind: 'shared', total_bytes: 5 * MB, file_count: 42 },
        { name: 'Diary', kind: 'private', total_bytes: 2048, file_count: 3 },
      ]);
      await screen.findByRole('rowheader', { name: 'Notes' });
      const notes = row(liveTable(), 'Notes');
      expect(within(notes).getByText('Shared')).toBeInTheDocument();
      expect(within(notes).getByText('5 MB')).toBeInTheDocument();
      expect(within(notes).getByText('42')).toBeInTheDocument();
      expect(
        within(row(liveTable(), 'Diary')).getByText('Private (encrypted)'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Deleted vaults' })).not.toBeInTheDocument();
    });

    it('shows an empty state without vaults', async () => {
      await mount([]);
      expect(await screen.findByText('You have no cloud vaults yet')).toBeInTheDocument();
    });

    it('renames a vault', async () => {
      const { onChanged } = await mount([{ name: 'Notes', kind: 'shared' }]);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Notes' }));
      const dialog = screen.getByRole('dialog', { name: 'Rename vault' });
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Journal' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await screen.findByRole('rowheader', { name: 'Journal' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('“Journal” renamed.');
      expect(onChanged).toHaveBeenCalled();
    });

    it('says when the new name is taken', async () => {
      await mount([
        { name: 'Notes', kind: 'shared' },
        { name: 'Work', kind: 'shared' },
      ]);
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Notes' }));
      const dialog = screen.getByRole('dialog', { name: 'Rename vault' });
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Work' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'You already have a vault with this name.',
      );
      expect(row(liveTable(), 'Notes')).toBeInTheDocument();
    });

    it('deletes after a confirmation that explains the retention, then restores', async () => {
      const { port } = await mount([
        { name: 'Notes', kind: 'shared' },
        { name: 'Work', kind: 'shared' },
      ]);
      fireEvent.click(await screen.findByRole('button', { name: 'Delete Notes' }));
      const dialog = screen.getByRole('dialog', { name: 'Delete “Notes”?' });
      expect(dialog).toHaveTextContent('you can restore it from “Deleted vaults”');
      if (port.capabilities.keepsLocalCopy)
        expect(dialog).toHaveTextContent('The copy on this device stays where it is');
      else expect(dialog).not.toHaveTextContent('The copy on this device');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

      const gone = await deletedTable();
      expect(within(gone).getByRole('rowheader', { name: 'Notes' })).toBeInTheDocument();
      await waitFor(() =>
        expect(within(liveTable()).queryByRole('rowheader', { name: 'Notes' })).toBeNull(),
      );
      expect(screen.getByRole('status')).toHaveTextContent('“Notes” deleted.');

      fireEvent.click(within(gone).getByRole('button', { name: 'Restore Notes' }));
      await waitFor(() => expect(row(liveTable(), 'Notes')).toBeInTheDocument());
      await waitFor(() =>
        expect(screen.queryByRole('table', { name: 'Deleted vaults' })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole('status')).toHaveTextContent('“Notes” restored.');
    });

    it('deletes nothing when the confirmation is cancelled', async () => {
      const { port } = await mount([{ name: 'Notes', kind: 'shared' }]);
      fireEvent.click(await screen.findByRole('button', { name: 'Delete Notes' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(await port.listDeletedVaults()).toEqual([]);
      expect(row(liveTable(), 'Notes')).toBeInTheDocument();
    });

    it('says when a restored name is taken meanwhile', async () => {
      await mount([
        { name: 'Notes', kind: 'shared', deleted: '2026-10-20T08:00:00Z' },
        { name: 'Notes', kind: 'shared' },
      ]);
      const gone = await deletedTable();
      fireEvent.click(within(gone).getByRole('button', { name: 'Restore Notes' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'You already have a vault with this name.',
      );
    });

    it('dates the final removal when the retention is known', async () => {
      const deletedAt = '2026-10-20T08:00:00Z';
      const { port } = await mount([{ name: 'Old', kind: 'private', deleted: deletedAt }]);
      const gone = await deletedTable();
      const days = port.capabilities.deletedRetentionDays;
      const expected =
        days === undefined
          ? 'after the retention period'
          : formatDay(purgeDate(deletedAt, days), 'en');
      expect(within(row(gone, 'Old')).getByText(expected)).toBeInTheDocument();
      expect(within(row(gone, 'Old')).getByText(formatDay(deletedAt, 'en'))).toBeInTheDocument();
    });

    it('creates a vault, or hands creation to the host', async () => {
      const { port, onNew, onCreatePrivate } = await mount([]);
      await screen.findByText('You have no cloud vaults yet');
      fireEvent.click(screen.getByRole('button', { name: 'New vault' }));
      if (!port.capabilities.createShared) {
        expect(onNew).toHaveBeenCalledOnce();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        return;
      }
      const dialog = screen.getByRole('dialog', { name: 'New cloud vault' });
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Team' } });
      if (port.capabilities.createPrivate) {
        // A private vault: the consequences are spelled out, and the host creates it (its keys).
        fireEvent.click(within(dialog).getByRole('radio', { name: /Private/ }));
        expect(dialog).toHaveTextContent('it can never be shared');
        expect(dialog).toHaveTextContent('at least 12 characters');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
        expect(onCreatePrivate).toHaveBeenCalledWith('Team');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'New vault' }));
        fireEvent.change(
          within(screen.getByRole('dialog', { name: 'New cloud vault' })).getByLabelText('Name'),
          { target: { value: 'Team' } },
        );
      }
      const again = screen.getByRole('dialog', { name: 'New cloud vault' });
      fireEvent.click(within(again).getByRole('radio', { name: /Shared/ }));
      fireEvent.click(within(again).getByRole('button', { name: 'Create' }));
      expect(await screen.findByRole('rowheader', { name: 'Team' })).toBeInTheDocument();
      expect(within(row(liveTable(), 'Team')).getByText('Shared')).toBeInTheDocument();
    });

    it('keeps the vault open in the page from being deleted', async () => {
      await mount([{ name: 'Notes', kind: 'shared' }], { isCurrent: (v) => v.name === 'Notes' });
      expect(await screen.findByRole('button', { name: 'Delete Notes' })).toBeDisabled();
      expect(screen.getAllByText(/go back to the console to delete it/).length).toBeGreaterThan(0);
    });
  });
}
