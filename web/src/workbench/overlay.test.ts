import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeOverlay, showFatal, showUnlockGate, unsyncedLines } from './overlay';

afterEach(() => closeOverlay());

describe('page overlays', () => {
  it('offers a reload when the core stopped', async () => {
    const reload = vi.fn();
    showFatal(reload);
    expect(
      screen.getByText('The vault engine stopped. Reload the page to continue.'),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('replaces the previous overlay instead of stacking them', () => {
    showFatal();
    showFatal();
    expect(document.querySelectorAll('.page-overlay')).toHaveLength(1);
  });

  it('describes what a copy holds', () => {
    expect(unsyncedLines(1, 0)).toEqual([
      '1 change not uploaded yet is kept in this browser as clear text.',
    ]);
    expect(unsyncedLines(0, 2)).toEqual(['2 conflicts are not resolved yet.']);
    expect(unsyncedLines(0, 0, true)).toEqual([
      'Changes made in this browser may not have been uploaded yet.',
    ]);
  });
});

describe('unlock gate', () => {
  const base = {
    counts: { pending: 3, conflicts: 0 },
    setPassphrase: vi.fn(() => Promise.resolve()),
    deleteCopy: vi.fn(),
    backToConsole: vi.fn(),
  };

  it('unlocks with the passphrase before anything is shown, and reports a wrong one', async () => {
    const unlock = vi
      .fn<(s: string, r: boolean) => Promise<boolean>>()
      .mockRejectedValueOnce('wrong passphrase')
      .mockResolvedValueOnce(false);
    const done = vi.fn();
    void showUnlockGate({ ...base, unlock }).then(done);
    expect(screen.getByText(/3 changes not uploaded yet/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Passphrase'), 'not it{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong passphrase');
    expect(done).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Passphrase'));
    await user.type(screen.getByLabelText('Passphrase'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(unlock).toHaveBeenLastCalledWith('correct horse battery', false);
    expect(document.querySelector('.page-overlay')).toBeNull();
  });

  it('asks for a new passphrase after the recovery key', async () => {
    const unlock = vi.fn(() => Promise.resolve(true));
    const setPassphrase = vi.fn(() => Promise.resolve());
    const done = vi.fn();
    void showUnlockGate({ ...base, unlock, setPassphrase }).then(done);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Use the recovery key'));
    await user.type(screen.getByLabelText('Recovery key'), 'AAAA-BBBB{Enter}');
    expect(unlock).toHaveBeenCalledWith('AAAA-BBBB', true);
    await user.type(await screen.findByLabelText('New passphrase'), 'short');
    await user.type(screen.getByLabelText('Repeat the new passphrase'), 'short{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('at least 12 characters');
    await user.clear(screen.getByLabelText('New passphrase'));
    await user.clear(screen.getByLabelText('Repeat the new passphrase'));
    await user.type(screen.getByLabelText('New passphrase'), 'a long new passphrase');
    await user.type(screen.getByLabelText('Repeat the new passphrase'), 'a long new passphrasf');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('differ');
    await user.clear(screen.getByLabelText('Repeat the new passphrase'));
    await user.type(screen.getByLabelText('Repeat the new passphrase'), 'a long new passphrase');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(setPassphrase).toHaveBeenCalledWith('a long new passphrase');
  });

  it('deletes the copy only after a confirmation', async () => {
    const deleteCopy = vi.fn();
    void showUnlockGate({ ...base, deleteCopy, unlock: () => Promise.resolve(false) });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect(deleteCopy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete anyway' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteCopy).toHaveBeenCalledOnce();
  });
});
