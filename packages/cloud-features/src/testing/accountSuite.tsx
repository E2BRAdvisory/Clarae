// One suite for the account components (DevicesPanel, UsagePanel, SharesManager, InvitationsList,
// MyGroups), run against every adapter (ADR-0037 §2): RestCloudPort over fakeCloudApi here,
// CoreCloudPort over the Wails mock in @memobrain/workbench. The seed is in the API's shapes; each
// harness puts it behind its own backend.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DevicesPanel } from '../DevicesPanel';
import { formatDay } from '../format';
import { MyGroups } from '../MyGroups';
import { errorCode, type CloudPort, type Share } from '../port';
import { InvitationsList } from '../sharing/InvitationsList';
import { MountsList } from '../sharing/MountsList';
import { SharesManager } from '../sharing/SharesManager';
import { dayOf } from '../sharing/ShareDialogs';
import { UsagePanel } from '../UsagePanel';
import { vaultId, type CloudSeed } from './fakeCloud';
import { OWNER } from './fakeRest';

export interface AccountHarness {
  /** Shown by the test runner ("RestCloudPort", "CoreCloudPort"). */
  name: string;
  /** The port marks the device it runs on by itself (the core); the console's page is told. */
  knowsCurrentDevice: boolean;
  /** A port over a backend that holds exactly this seed. */
  setup(seed: CloudSeed): Promise<CloudPort> | CloudPort;
}

const MB = 1024 * 1024;
const BOB = '0198f1c2-cccc-7bbb-8ccc-000000000001';
const CAROL = '0198f1c2-cccc-7bbb-8ccc-000000000002';
const TEAM = '0198f1c2-dddd-7bbb-8ccc-000000000001';
const ADA = '0198f1c2-cccc-7bbb-8ccc-0000000000ad';
// UUIDs, as the contract says: the suite also runs on the Go core, which decodes them.
const LAPTOP = '0198f1c2-eeee-7bbb-8ccc-0000000000d1';
const OFFICE_PC = '0198f1c2-eeee-7bbb-8ccc-0000000000d2';
const FIREFOX = '0198f1c2-eeee-7bbb-8ccc-0000000000d3';
const S1 = '0198f1c2-ffff-7bbb-8ccc-000000000001';
const S2 = '0198f1c2-ffff-7bbb-8ccc-000000000002';
const S_MANAGED = '0198f1c2-ffff-7bbb-8ccc-00000000000a';
const I1 = '0198f1c2-ffff-7bbb-8ccc-000000000101';
/** A share id (UUID, like the server's) for the paged lists: `tag` keeps the lists apart. */
const pagedId = (tag: string, i: number) =>
  `0198f1c2-${tag}-7bbb-8ccc-${String(i).padStart(12, '0')}`;
const I2 = '0198f1c2-ffff-7bbb-8ccc-000000000102';
const I3 = '0198f1c2-ffff-7bbb-8ccc-000000000103';

/** A share of the n-th seed vault, owned by the user unless `my_permission` says otherwise. */
export function seedShare(over: Partial<Share> & { id: string; display_name: string }): Share {
  return {
    vault_id: vaultId(0),
    vault_name: 'Team',
    resource_type: 'vault',
    owner_id: OWNER,
    owner_name: 'me',
    created_at: '2026-10-01T10:00:00Z',
    grants: [],
    ...over,
  };
}

const devices: NonNullable<CloudSeed['devices']> = [
  {
    id: LAPTOP,
    name: 'Laptop',
    platform: 'macos',
    app_version: '1.2.0',
    created_at: '2026-01-01T00:00:00Z',
    last_seen_at: '2026-10-30T10:00:00Z',
    current: true,
  },
  {
    id: OFFICE_PC,
    name: 'Office PC',
    platform: 'windows',
    app_version: '1.1.0',
    created_at: '2026-02-01T00:00:00Z',
    last_seen_at: '2026-10-29T10:00:00Z',
  },
  { id: FIREFOX, name: 'Firefox', platform: 'web', created_at: '2026-03-01T00:00:00Z' },
];

const directory = {
  users: [
    { id: BOB, username: 'bob', display_name: 'Bob Smith' },
    { id: CAROL, username: 'carol' },
  ],
  groups: [{ id: TEAM, name: 'engineers', description: 'The engineers' }],
};

export function cloudAccountSuite(h: AccountHarness): void {
  async function mount(seed: CloudSeed, ui: (port: CloudPort) => ReactNode) {
    const port = await h.setup(seed);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}>{ui(port)}</QueryClientProvider>);
    return port;
  }
  const row = (table: HTMLElement, name: string | RegExp) =>
    within(table).getByRole('rowheader', { name }).closest('tr') as HTMLElement;
  const card = (name: string) => screen.findByRole('region', { name });

  describe(`DevicesPanel on ${h.name}`, () => {
    const show = (seed: CloudSeed) =>
      mount(seed, (port) => (
        <DevicesPanel
          port={port}
          lang="en"
          currentDeviceId={h.knowsCurrentDevice ? undefined : LAPTOP}
        />
      ));

    it('marks the device in use and keeps it from being revoked', async () => {
      await show({ devices });
      const table = await screen.findByRole('table', { name: 'Devices' });
      const laptop = row(table, /Laptop/);
      expect(within(laptop).getByText('This device')).toBeInTheDocument();
      expect(within(laptop).queryByRole('button')).toBeNull();
      expect(within(laptop).getByText(/sign out to disconnect it/)).toBeInTheDocument();
      expect(within(row(table, 'Office PC')).getByText('Windows')).toBeInTheDocument();
      expect(within(row(table, 'Firefox')).getByText('Browser')).toBeInTheDocument();
      expect(within(row(table, 'Firefox')).getByText('Never')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Revoke Office PC' })).toBeEnabled();
    });

    it('revokes another device after a confirmation', async () => {
      await show({ devices });
      fireEvent.click(await screen.findByRole('button', { name: 'Revoke Office PC' }));
      const dialog = screen.getByRole('dialog', { name: 'Revoke this device?' });
      expect(dialog).toHaveTextContent('“Office PC” stops synchronizing');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('status')).toHaveTextContent('“Office PC” revoked.');
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Revoke Office PC' })).toBeNull(),
      );
    });

    it('revokes nothing when the confirmation is cancelled', async () => {
      const port = await show({ devices });
      fireEvent.click(await screen.findByRole('button', { name: 'Revoke Firefox' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const after = await port.listDevices();
      expect(after.find((d) => d.id === FIREFOX)?.revoked_at).toBeUndefined();
    });

    it('shows an empty state without devices', async () => {
      await show({ devices: [] });
      expect(await screen.findByText('No registered devices')).toBeInTheDocument();
    });
  });

  describe(`UsagePanel on ${h.name}`, () => {
    it('follows the level of the server, not a threshold of its own', async () => {
      // 70 % with an administrator's warning threshold at 60 %: the default thresholds would say ok.
      await mount(
        {
          usage: { used_bytes: 70 * MB, quota_bytes: 100 * MB, level: 'warning' },
          vaults: [
            { name: 'Small', kind: 'shared', total_bytes: 10 * MB, file_count: 4 },
            { name: 'Big', kind: 'private', total_bytes: 60 * MB, file_count: 40 },
          ],
        },
        (port) => <UsagePanel port={port} lang="en" />,
      );
      expect(await screen.findByText('70 MB of 100 MB')).toBeInTheDocument();
      expect(screen.getByText('70%')).toBeInTheDocument();
      expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-level', 'warn');
      expect(screen.getByRole('status')).toHaveTextContent('Your space is running low.');
      const table = await screen.findByRole('table', { name: 'Space by vault' });
      const rows = within(table)
        .getAllByRole('rowheader')
        .map((r) => r.textContent);
      expect(rows).toEqual(['Big', 'Small']);
      expect(within(row(table, 'Big')).getByText('86%')).toBeInTheDocument();
      expect(within(row(table, 'Big')).getByText('Private (encrypted)')).toBeInTheDocument();
    });

    it('handles an unlimited quota', async () => {
      await mount({ usage: { used_bytes: 2 * MB, quota_bytes: -1, level: 'ok' } }, (port) => (
        <UsagePanel port={port} lang="en" />
      ));
      expect(await screen.findByText('2 MB used, no limit')).toBeInTheDocument();
      expect(screen.getByText('Plenty of space left.')).toBeInTheDocument();
      expect(await screen.findByText('You have no cloud vaults yet.')).toBeInTheDocument();
    });
  });

  describe(`SharesManager on ${h.name}`, () => {
    const vaults: NonNullable<CloudSeed['vaults']> = [
      { name: 'Team', kind: 'shared' },
      { name: 'Diary', kind: 'private' },
    ];
    const show = (seed: CloudSeed) =>
      mount(seed, (port) => <SharesManager port={port} lang="en" />);

    it('lists the shares with their type, vault and expiry; a manager cannot revoke', async () => {
      const expires = new Date(Date.now() + 10 * 86_400_000).toISOString();
      await show({
        vaults,
        owned: [
          seedShare({
            id: S1,
            display_name: 'Handbook',
            resource_type: 'folder',
            path_prefix: 'Docs/Handbook',
            expires_at: expires,
          }),
          seedShare({ id: S2, display_name: 'Ada’s notes', my_permission: 'manager' }),
        ],
      });
      const handbook = await card('Handbook');
      expect(handbook).toHaveTextContent('Folder');
      expect(handbook).toHaveTextContent('in Team · Docs/Handbook');
      expect(handbook).toHaveTextContent(`Expires ${formatDay(expires, 'en')}`);
      expect(within(handbook).getByRole('button', { name: 'Revoke Handbook' })).toBeEnabled();
      const managed = await card('Ada’s notes');
      expect(managed).toHaveTextContent('No expiry');
      expect(within(managed).queryByRole('button', { name: /Revoke/ })).toBeNull();
      expect(managed).toHaveTextContent('only its owner can revoke it');
    });

    it('creates a share of a folder of a shared vault; private vaults are not offered', async () => {
      await show({ vaults, owned: [] });
      expect(await screen.findByText('You have not shared anything yet')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'New share' }));
      const dialog = screen.getByRole('dialog', { name: 'New share' });
      const vault = await within(dialog).findByLabelText('Vault');
      await waitFor(() =>
        expect(
          within(vault)
            .getAllByRole('option')
            .map((o) => o.textContent),
        ).toEqual(['Team']),
      );
      expect(dialog).toHaveTextContent('Private vaults are end-to-end encrypted');
      fireEvent.click(within(dialog).getByRole('radio', { name: 'A folder' }));
      fireEvent.change(within(dialog).getByLabelText('Folder'), {
        target: { value: '/Projects/Alfa/' },
      });
      expect(within(dialog).getByLabelText('Name')).toHaveValue('Alfa');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
      const created = await card('Alfa');
      expect(created).toHaveTextContent('in Team · Projects/Alfa');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('“Alfa” shared.');
      // Opened at once, to add the people.
      expect(within(created).getByText('Nobody has access yet.')).toBeInTheDocument();
    });

    it('never shares a private vault (D-02)', async () => {
      const port = await h.setup({ vaults });
      const err = await port
        .createShare({ vault_id: vaultId(1), display_name: 'Diary' })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(errorCode(err)).toBe('VAULT_ENCRYPTED');
      expect(await port.listShares('owned')).toEqual({ items: [] });
    });

    it('renames a share, sets its expiry, then removes it', async () => {
      await show({ vaults, owned: [seedShare({ id: S1, display_name: 'Handbook' })] });
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Handbook' }));
      let dialog = screen.getByRole('dialog', { name: 'Edit “Handbook”' });
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Guide' } });
      fireEvent.click(within(dialog).getByRole('checkbox', { name: 'No expiry' }));
      const day = dayOf(new Date(Date.now() + 30 * 86_400_000).toISOString());
      fireEvent.change(within(dialog).getByLabelText('Expires on'), { target: { value: day } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      const guide = await card('Guide');
      expect(screen.getByRole('status')).toHaveTextContent('“Guide” updated.');
      await waitFor(() => expect(guide).toHaveTextContent('Expires'));

      fireEvent.click(within(guide).getByRole('button', { name: 'Edit Guide' }));
      dialog = screen.getByRole('dialog', { name: 'Edit “Guide”' });
      expect(within(dialog).getByLabelText('Expires on')).toHaveValue(day);
      fireEvent.click(within(dialog).getByRole('checkbox', { name: 'No expiry' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(async () => expect(await card('Guide')).toHaveTextContent('No expiry'));
    });

    it('says when the expiry is in the past', async () => {
      await show({ vaults, owned: [seedShare({ id: S1, display_name: 'Handbook' })] });
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Handbook' }));
      const dialog = screen.getByRole('dialog', { name: 'Edit “Handbook”' });
      fireEvent.click(within(dialog).getByRole('checkbox', { name: 'No expiry' }));
      fireEvent.change(within(dialog).getByLabelText('Expires on'), {
        target: { value: '2020-01-01' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'the expiry, which must be in the future',
      );
    });

    it('gives access to people and groups, changes a level and removes one', async () => {
      await show({
        vaults,
        ...directory,
        owned: [
          seedShare({
            id: S1,
            display_name: 'Handbook',
            grants: [
              {
                principal_type: 'user',
                principal_id: CAROL,
                principal_name: 'carol',
                permission: 'viewer',
                status: 'accepted',
                created_at: '2026-10-01T10:00:00Z',
              },
            ],
          }),
        ],
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Access to Handbook' }));
      const handbook = await card('Handbook');
      const search = within(handbook).getByRole('form', { name: 'Add people or groups' });
      fireEvent.change(within(search).getByLabelText('Name or username'), {
        target: { value: 'bob' },
      });
      fireEvent.change(within(search).getByLabelText('With permission'), {
        target: { value: 'editor' },
      });
      fireEvent.click(within(search).getByRole('button', { name: 'Search' }));
      fireEvent.click(await within(search).findByRole('button', { name: 'Add Bob Smith' }));
      const access = await within(handbook).findByRole('table', { name: 'Access' });
      await waitFor(() => expect(row(access, /bob/)).toBeInTheDocument());
      expect(within(row(access, /bob/)).getByLabelText('Permission of bob')).toHaveValue('editor');
      expect(within(row(access, /bob/)).getByText('Pending')).toBeInTheDocument();

      fireEvent.change(within(search).getByLabelText('Add a'), { target: { value: 'group' } });
      fireEvent.change(within(search).getByLabelText('Name or username'), {
        target: { value: 'eng' },
      });
      fireEvent.click(within(search).getByRole('button', { name: 'Search' }));
      // A group is told apart by its description, on every adapter.
      expect(await within(search).findByRole('list', { name: 'Search results' })).toHaveTextContent(
        'engineers (The engineers)',
      );
      fireEvent.click(await within(search).findByRole('button', { name: 'Add engineers' }));
      await waitFor(() => expect(row(access, /engineers/)).toBeInTheDocument());
      expect(within(row(access, /engineers/)).getByText('Group')).toBeInTheDocument();
      expect(await within(search).findByRole('button', { name: 'Add engineers' })).toBeDisabled();

      fireEvent.change(within(row(access, /carol/)).getByLabelText('Permission of carol'), {
        target: { value: 'manager' },
      });
      await waitFor(() =>
        expect(within(row(access, /carol/)).getByLabelText('Permission of carol')).toHaveValue(
          'manager',
        ),
      );
      expect(screen.getByRole('status')).toHaveTextContent('Access of carol updated.');
      fireEvent.click(within(access).getByRole('button', { name: 'Remove carol' }));
      await waitFor(() =>
        expect(within(access).queryByRole('rowheader', { name: /carol/ })).toBeNull(),
      );
      expect(screen.getByRole('status')).toHaveTextContent('carol no longer has access.');
    });

    it('revokes a share after a confirmation', async () => {
      await show({ vaults, owned: [seedShare({ id: S1, display_name: 'Handbook' })] });
      fireEvent.click(await screen.findByRole('button', { name: 'Revoke Handbook' }));
      const dialog = screen.getByRole('dialog', { name: 'Revoke “Handbook”?' });
      expect(dialog).toHaveTextContent('lose access at once');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
      expect(await screen.findByText('You have not shared anything yet')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('“Handbook” revoked.');
    });

    it('lets a manager share inside the share they manage, never outside (ADR-0041 §8)', async () => {
      const company = vaultId(7); // somebody else's vault: not among the user's
      const alfa = seedShare({
        id: S_MANAGED,
        display_name: 'Alfa',
        vault_id: company,
        vault_name: 'Company',
        resource_type: 'folder',
        path_prefix: 'Projects/Alfa',
        owner_id: ADA,
        owner_name: 'ada',
        my_permission: 'manager',
        my_status: 'accepted',
      });
      const port = await show({
        vaults,
        owned: [alfa, seedShare({ id: S1, display_name: 'Handbook' })],
      });
      // The owner of a share uses "New share"; only a managed share offers to share inside it.
      expect(
        within(await card('Handbook')).queryByRole('button', { name: /Share inside/ }),
      ).toBeNull();
      fireEvent.click(
        within(await card('Alfa')).getByRole('button', { name: 'Share inside Alfa' }),
      );
      const dialog = screen.getByRole('dialog', { name: 'Share inside “Alfa”' });
      expect(dialog).toHaveTextContent('Inside “Alfa” · in Company · Projects/Alfa');
      expect(dialog).toHaveTextContent('with access up to Manager');
      expect(within(dialog).queryByLabelText('Vault')).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Share' })).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Subfolder'), {
        target: { value: '/Drafts/' },
      });
      expect(within(dialog).getByLabelText('Name')).toHaveValue('Drafts');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
      const drafts = await card('Drafts');
      expect(drafts).toHaveTextContent('in Company · Projects/Alfa/Drafts');
      expect(screen.getByRole('status')).toHaveTextContent('“Drafts” shared.');
      // The manager who made it manages it, but only the owner of the vault revokes it.
      expect(within(drafts).queryByRole('button', { name: /Revoke/ })).toBeNull();
      expect(drafts).toHaveTextContent('only its owner can revoke it');
      const made = (await port.listShares('owned')).items.find((x) => x.display_name === 'Drafts');
      expect(made).toMatchObject({ owner_name: 'ada', my_permission: 'manager' });

      // The whole managed folder is fine too; outside it the server says no.
      fireEvent.click(
        within(await card('Alfa')).getByRole('button', { name: 'Share inside Alfa' }),
      );
      const again = screen.getByRole('dialog', { name: 'Share inside “Alfa”' });
      fireEvent.click(within(again).getByRole('radio', { name: 'The whole folder' }));
      expect(within(again).queryByLabelText('Subfolder')).toBeNull();
      expect(within(again).getByLabelText('Name')).toHaveValue('Alfa');
      fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
      const err = await port
        .createShare({ vault_id: company, display_name: 'Beta', path_prefix: 'Projects/Beta' })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(errorCode(err)).toBe('FORBIDDEN');
    });

    it('shows only the shares of one vault when asked', async () => {
      await mount(
        {
          vaults: [
            { name: 'Team', kind: 'shared' },
            { name: 'Work', kind: 'shared' },
          ],
          owned: [
            seedShare({ id: S1, display_name: 'Handbook' }),
            seedShare({
              id: S2,
              display_name: 'Plans',
              vault_id: vaultId(1),
              vault_name: 'Work',
            }),
          ],
        },
        (port) => <SharesManager port={port} lang="en" vaultId={vaultId(1)} canCreate={false} />,
      );
      expect(await card('Plans')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Handbook' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'New share' })).toBeNull();
    });

    // GET /shares is paginated (100 a page by default): the list grows a page at a time.
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        seedShare({ id: pagedId('eeee', i), display_name: `Share ${i}` }),
      );

    it('reads the shares a page at a time', async () => {
      await show({ vaults, owned: many(101) });
      expect(await card('Share 99')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Share 100' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await card('Share 100')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
    });

    it('reads every page for the shares of one vault', async () => {
      const last = seedShare({
        id: pagedId('eeee', 999_999),
        display_name: 'Plans',
        vault_id: vaultId(1),
        vault_name: 'Work',
      });
      await mount(
        {
          vaults: [
            { name: 'Team', kind: 'shared' },
            { name: 'Work', kind: 'shared' },
          ],
          owned: [...many(100), last],
        },
        (port) => <SharesManager port={port} lang="en" vaultId={vaultId(1)} canCreate={false} />,
      );
      expect(await card('Plans')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Share 0' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    });
  });

  describe(`InvitationsList on ${h.name}`, () => {
    const invitation = (id: string, name: string, over: Partial<Share> = {}): Share => {
      // A recipient does not see the grants of a share.
      const share: Share = seedShare({
        id,
        display_name: name,
        resource_type: 'folder',
        owner_id: ADA,
        owner_name: 'ada',
        vault_name: 'Company',
        my_permission: 'editor',
        my_status: 'pending',
        ...over,
      });
      delete share.grants;
      return share;
    };

    it('accepts an invitation: it moves to the accepted shares', async () => {
      await mount({ received: [invitation(I1, 'Budget')] }, (port) => (
        <InvitationsList port={port} lang="en" />
      ));
      const budget = await card('Budget');
      expect(budget).toHaveTextContent('From ada · in Company');
      expect(budget).toHaveTextContent('Editor');
      fireEvent.click(within(budget).getByRole('button', { name: 'Accept Budget' }));
      const accepted = await screen.findByRole('region', { name: 'Accepted shares' });
      expect(await within(accepted).findByRole('region', { name: 'Budget' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Invitation to “Budget” accepted.');
      expect(screen.getByText('No invitations.')).toBeInTheDocument();
    });

    it('declines an invitation', async () => {
      await mount({ received: [invitation(I1, 'Budget')] }, (port) => (
        <InvitationsList port={port} lang="en" />
      ));
      fireEvent.click(await screen.findByRole('button', { name: 'Decline Budget' }));
      expect(await screen.findByText('No invitations.')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Invitation to “Budget” declined.');
    });

    it('shows only the sections asked for', async () => {
      await mount(
        {
          received: [
            invitation(I1, 'Budget'),
            invitation(I2, 'Roadmap', { my_status: 'accepted' }),
          ],
        },
        (port) => <InvitationsList port={port} lang="en" sections={['pending']} />,
      );
      expect(await card('Budget')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Roadmap' })).toBeNull();
    });

    it('reads the received shares a page at a time', async () => {
      // The pending invitations come from GET /shares?scope=received, a page at a time; the
      // accepted ones are the mounts (MountsList), which reads every page of /shared-with-me.
      const pending = Array.from({ length: 101 }, (_, i) =>
        invitation(pagedId('dddd', i), `Invite ${i}`),
      );
      await mount({ received: pending }, (port) => <InvitationsList port={port} lang="en" />);
      expect(await card('Invite 99')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Invite 100' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await card('Invite 100')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    });
  });

  describe(`MountsList on ${h.name}`, () => {
    // A share the user received, in the shape of GET /shares?scope=received.
    const received = (id: string, name: string, over: Partial<Share> = {}): Share => {
      const share: Share = seedShare({
        id,
        display_name: name,
        resource_type: 'folder',
        owner_id: ADA,
        owner_name: 'ada',
        vault_name: 'Company',
        my_permission: 'editor',
        my_status: 'accepted',
        ...over,
      });
      delete share.grants;
      return share;
    };

    it('lists the accepted shares only, with type, level and owner', async () => {
      await mount(
        {
          received: [
            received(I1, 'Budget', { my_status: 'pending' }),
            received(I2, 'Roadmap'),
            received(I3, 'Archive', { my_status: 'declined', resource_type: 'vault' }),
          ],
        },
        (port) => <MountsList port={port} lang="en" />,
      );
      const list = await screen.findByRole('region', { name: 'Shared with me' });
      const roadmap = await within(list).findByRole('region', { name: 'Roadmap' });
      expect(roadmap).toHaveTextContent('Folder');
      expect(roadmap).toHaveTextContent('Editor');
      expect(roadmap).toHaveTextContent('From ada');
      expect(within(list).queryByRole('region', { name: 'Budget' })).toBeNull();
      expect(within(list).queryByRole('region', { name: 'Archive' })).toBeNull();
      // Nothing to open without a host that says where.
      expect(within(roadmap).queryByRole('link')).toBeNull();
    });

    it('says when nothing is shared with the user', async () => {
      await mount({ received: [received(I1, 'Budget', { my_status: 'pending' })] }, (port) => (
        <MountsList port={port} lang="en" />
      ));
      expect(await screen.findByText('Nothing is shared with you yet.')).toBeInTheDocument();
    });

    it('opens a mount where the host says (the console: a link to the workbench)', async () => {
      await mount({ received: [received(I2, 'Roadmap')] }, (port) => (
        <MountsList
          port={port}
          lang="en"
          openHref={(m) => `/vaults/${m.vault_id}/open?share=${m.share_id}`}
        />
      ));
      expect(
        await screen.findByRole('link', { name: 'Open Roadmap in the browser' }),
      ).toHaveAttribute('href', `/vaults/${vaultId(0)}/open?share=${I2}`);
    });

    it('gives each mount a slot for the actions of the host', async () => {
      await mount({ received: [received(I2, 'Roadmap')] }, (port) => (
        <MountsList
          port={port}
          lang="en"
          actions={(m) => <button type="button">{`Act on ${m.display_name}`}</button>}
        />
      ));
      const roadmap = await screen.findByRole('region', { name: 'Roadmap' });
      expect(within(roadmap).getByRole('button', { name: 'Act on Roadmap' })).toBeInTheDocument();
    });

    it('shows nothing at all when asked to hide an empty list', async () => {
      await mount({ received: [received(I1, 'Budget', { my_status: 'pending' })] }, (port) => (
        <>
          <MountsList port={port} lang="en" hideWhenEmpty />
          <InvitationsList port={port} lang="en" sections={['pending']} />
        </>
      ));
      expect(await screen.findByRole('region', { name: 'Budget' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Shared with me' })).toBeNull();
      expect(screen.queryByText('Nothing is shared with you yet.')).toBeNull();
    });

    it('lists the port-level mounts as the components show them', async () => {
      const port = await mount({ received: [received(I2, 'Roadmap')] }, () => null);
      const mounts = await port.listMounts();
      expect(mounts).toHaveLength(1);
      expect(mounts[0]).toMatchObject({
        share_id: I2,
        vault_id: vaultId(0),
        display_name: 'Roadmap',
        resource_type: 'folder',
        permission: 'editor',
        owner_name: 'ada',
      });
      // A port that keeps a copy of the mount on this device tells its state (the folder may not
      // exist yet: it is made when the share is accepted or the mount opened here).
      if (port.capabilities.keepsLocalCopy) {
        expect(mounts[0]?.local).toMatchObject({ revoked: false, open_vault_id: '' });
        expect(typeof mounts[0]?.local?.mounted).toBe('boolean');
      } else expect(mounts[0]?.local).toBeUndefined();
    });
  });

  describe(`sharing turned off on ${h.name}`, () => {
    it('says so instead of listing shares or invitations', async () => {
      await mount(
        {
          features: { sharing: false },
          owned: [seedShare({ id: S1, display_name: 'Handbook' })],
        },
        (port) => (
          <>
            <SharesManager port={port} lang="en" />
            <InvitationsList port={port} lang="en" />
            <MountsList port={port} lang="en" />
          </>
        ),
      );
      await waitFor(() =>
        expect(screen.getAllByText('Sharing is turned off by your administrator.')).toHaveLength(2),
      );
      expect(screen.queryByRole('region', { name: 'Handbook' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'New share' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Shared with me' })).toBeNull();
    });
  });

  describe(`MyGroups on ${h.name}`, () => {
    it('lists the groups of the user where the port knows them', async () => {
      const port = await mount(
        {
          myGroups: [
            { id: TEAM, name: 'engineers', description: 'The engineers', member_role: 'manager' },
          ],
        },
        (p) => <MyGroups port={p} lang="en" />,
      );
      if (!port.capabilities.myGroups) {
        expect(screen.queryByRole('table')).toBeNull();
        return;
      }
      const table = await screen.findByRole('table', { name: 'My groups' });
      expect(within(row(table, 'engineers')).getByText('Manager')).toBeInTheDocument();
      // ADR-0041 §9: shown, but it gives nothing.
      expect(screen.getByText(/manager role gives no extra permission/)).toBeInTheDocument();
    });
  });
}
