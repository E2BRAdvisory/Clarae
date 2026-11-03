import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@memobrain/ui';
import type { LeaveResult as ForgetResult } from '../workbench/forget';
import { updateMarker } from '../workbench/markers';
import { accountKey } from '../workbench/storage';
import { useForgetBrowser } from './ForgetBrowser';

const forget = vi.hoisted(() => ({
  results: [] as ForgetResult[],
  afterLeave: [] as ForgetResult[],
  calls: 0,
  leaveCalls: 0,
  accounts: [] as string[],
}));

vi.mock('../workbench/forget', () => ({
  forgetThisBrowser: (account: string) => {
    forget.calls++;
    forget.accounts.push(account);
    return Promise.resolve(forget.results.shift() ?? { removed: true, busy: false });
  },
  forgetAfterLeave: (account: string) => {
    forget.leaveCalls++;
    forget.accounts.push(account);
    return Promise.resolve(forget.afterLeave.shift() ?? { removed: true, busy: false });
  },
}));

/** The signed-in account's storage key, and another account's of the same browser. */
let account = '';
let other = '';

function Harness({ onDone, onError }: { onDone: () => void; onError: (e: unknown) => void }) {
  const f = useForgetBrowser({
    subject: 'alice',
    confirmLabel: 'Delete and sign out',
    onDone,
    onError,
  });
  return (
    <>
      <Button onClick={f.start} disabled={f.working}>
        Sign out
      </Button>
      {f.dialogs}
    </>
  );
}

const setup = () => {
  const onDone = vi.fn();
  const onError = vi.fn();
  render(<Harness onDone={onDone} onError={onError} />);
  return { onDone, onError, user: userEvent.setup() };
};

beforeEach(async () => {
  account = await accountKey({ server: location.origin, subject: 'alice' });
  other = await accountKey({ server: location.origin, subject: 'bob' });
  localStorage.clear();
  forget.accounts = [];
  forget.results = [];
  forget.afterLeave = [];
  forget.calls = 0;
  forget.leaveCalls = 0;
});

describe('forgetting this browser from the console', () => {
  it('removes the copies at once when none holds changes', async () => {
    updateMarker(account, 'v1', { name: 'Clean', kind: 'private' });
    const { onDone, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists the copies with changes not uploaded and deletes them only after a confirmation', async () => {
    updateMarker(account, 'v1', { name: 'Diary', kind: 'private', pending: 2 });
    updateMarker(account, 'v2', { name: 'Team', kind: 'shared', conflicts: 1 });
    updateMarker(account, 'share:s1', { name: 'From Bob', kind: 'shared', dirty: true });
    updateMarker(account, 'v3', { name: 'Clean', kind: 'shared' });
    const { onDone, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('dialog', { name: 'Changes not uploaded' });
    expect(within(dialog).getByRole('link', { name: 'Diary' })).toHaveAttribute(
      'href',
      '/vaults/v1/open',
    );
    expect(dialog).toHaveTextContent('2 changes not uploaded');
    expect(dialog).toHaveTextContent('1 conflict to resolve');
    expect(dialog).toHaveTextContent('From Bob — changes may not be uploaded yet');
    expect(dialog).not.toHaveTextContent('Clean');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(forget.calls).toBe(0);
    expect(onDone).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(screen.getByRole('button', { name: 'Delete and sign out' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(forget.calls).toBe(1);
    expect(forget.accounts).toEqual([account]);
  });

  it("acts on the signed-in account only: another account's changes are not listed", async () => {
    updateMarker(other, 'b1', { name: 'Bob diary', kind: 'private', pending: 4 });
    const { onDone, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Bob diary/)).not.toBeInTheDocument();
    expect(forget.accounts).toEqual([account]);
  });

  it('says when a workbench tab holds the files, and can ask it to leave', async () => {
    forget.results = [{ removed: false, busy: true }];
    forget.afterLeave = [{ removed: false, busy: true }];
    const { onDone, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog', { name: 'A vault is open in another tab' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Close that tab');
    expect(onDone).not.toHaveBeenCalled();

    // The tab did not leave (it keeps changes it could not upload).
    await user.click(within(dialog).getByRole('button', { name: 'Close that tab and retry' }));
    expect(await within(dialog).findByText(/still open/)).toBeInTheDocument();
    expect(forget.leaveCalls).toBe(1);

    // Closed by hand: retrying succeeds.
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  it('asks again when the tab left with changes it could not upload', async () => {
    forget.results = [{ removed: false, busy: true }];
    const { onDone, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const busy = await screen.findByRole('dialog', { name: 'A vault is open in another tab' });
    // The tab wrote its last edits, could not upload them and went away: its marker says so.
    const marker = updateMarker(account, 'v1', { name: 'Team', kind: 'shared', pending: 1 });
    forget.afterLeave = [{ removed: false, busy: false, unsynced: [{ id: 'v1', ...marker }] }];
    await user.click(within(busy).getByRole('button', { name: 'Close that tab and retry' }));
    const dialog = await screen.findByRole('dialog', { name: 'Changes not uploaded' });
    expect(dialog).toHaveTextContent('Team — 1 change not uploaded');
    expect(forget.calls).toBe(1); // the first attempt only, which removed nothing (busy)
    expect(onDone).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete and sign out' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(forget.calls).toBe(2);
  });

  it('asks before retrying when a copy got changes after the first answer', async () => {
    forget.results = [{ removed: false, busy: true }];
    const { onDone, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const busy = await screen.findByRole('dialog', { name: 'A vault is open in another tab' });
    // The tab was closed by hand right after an edit.
    updateMarker(account, 'v2', { name: 'Notes', kind: 'shared', dirty: true });
    await user.click(within(busy).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('dialog', { name: 'Changes not uploaded' })).toHaveTextContent(
      'Notes',
    );
    expect(forget.calls).toBe(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('names a copy whose cloud vault was deleted without a link to it', async () => {
    updateMarker(account, 'v9', { name: 'Gone', kind: 'shared', pending: 1, cloudDeleted: true });
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('dialog', { name: 'Changes not uploaded' });
    expect(within(dialog).queryByRole('link', { name: 'Gone' })).toBeNull();
    expect(dialog).toHaveTextContent('Gone — 1 change not uploaded, its cloud vault was deleted');
  });
});
