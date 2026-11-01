import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@memobrain/ui';
import type { ForgetResult } from '../workbench/forget';
import { updateMarker } from '../workbench/markers';
import { useForgetBrowser } from './ForgetBrowser';

const forget = vi.hoisted(() => ({
  results: [] as ForgetResult[],
  afterLeave: [] as ForgetResult[],
  calls: 0,
  leaveCalls: 0,
}));

vi.mock('../workbench/forget', () => ({
  forgetThisBrowser: () => {
    forget.calls++;
    return Promise.resolve(forget.results.shift() ?? { removed: true, busy: false });
  },
  forgetAfterLeave: () => {
    forget.leaveCalls++;
    return Promise.resolve(forget.afterLeave.shift() ?? { removed: true, busy: false });
  },
}));

function Harness({ onDone, onError }: { onDone: () => void; onError: (e: unknown) => void }) {
  const f = useForgetBrowser({ confirmLabel: 'Delete and sign out', onDone, onError });
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

beforeEach(() => {
  localStorage.clear();
  forget.results = [];
  forget.afterLeave = [];
  forget.calls = 0;
  forget.leaveCalls = 0;
});

describe('forgetting this browser from the console', () => {
  it('removes the copies at once when none holds changes', async () => {
    updateMarker('v1', { name: 'Clean', kind: 'private' });
    const { onDone, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists the copies with changes not uploaded and deletes them only after a confirmation', async () => {
    updateMarker('v1', { name: 'Diary', kind: 'private', pending: 2 });
    updateMarker('v2', { name: 'Team', kind: 'shared', conflicts: 1 });
    updateMarker('share:s1', { name: 'From Bob', kind: 'shared', dirty: true });
    updateMarker('v3', { name: 'Clean', kind: 'shared' });
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
});
