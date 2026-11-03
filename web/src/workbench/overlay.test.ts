import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeOverlay, gateErrorText, showFatal, showUnlockGate, unsyncedLines } from './overlay';

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
    const strong = 'violet tram juggles 41 quiet anchors';
    const alert = () => screen.getByRole('alert');
    await user.type(await screen.findByLabelText('New passphrase'), 'short');
    await user.type(screen.getByLabelText('Repeat the new passphrase'), 'short{Enter}');
    await vi.waitFor(() => expect(alert()).toHaveTextContent('at least 12 characters'));
    // Long enough but guessable: the same policy as the workbench's dialogs (zxcvbn, §3.8.2).
    await user.clear(screen.getByLabelText('New passphrase'));
    await user.clear(screen.getByLabelText('Repeat the new passphrase'));
    await user.type(screen.getByLabelText('New passphrase'), 'aaaaaaaaaaaa');
    await user.type(screen.getByLabelText('Repeat the new passphrase'), 'aaaaaaaaaaaa');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(alert()).toHaveTextContent('too easy to guess'), {
      timeout: 10_000,
    });
    expect(setPassphrase).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('New passphrase'));
    await user.clear(screen.getByLabelText('Repeat the new passphrase'));
    await user.type(screen.getByLabelText('New passphrase'), strong);
    await user.type(screen.getByLabelText('Repeat the new passphrase'), `${strong}x`);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(alert()).toHaveTextContent('differ'));
    await user.clear(screen.getByLabelText('Repeat the new passphrase'));
    await user.type(screen.getByLabelText('Repeat the new passphrase'), strong);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(setPassphrase).toHaveBeenCalledWith(strong);
  }, 20_000);

  it("shows the core's refusal of a weak passphrase, translated (the live check is not the guard)", async () => {
    const setPassphrase = vi
      .fn<(p: string) => Promise<void>>()
      .mockRejectedValueOnce(
        new Error('weak-passphrase: guessable: the passphrase is too easy to guess'),
      )
      .mockRejectedValueOnce(
        new Error('weak-passphrase: too-short: the passphrase must have at least 12 characters'),
      )
      .mockResolvedValueOnce(undefined);
    const done = vi.fn();
    // A live check that lets everything through: only the core decides.
    const check = () => Promise.resolve({ longEnough: true, ok: true });
    void showUnlockGate({
      ...base,
      unlock: () => Promise.resolve(true),
      setPassphrase,
      check,
    }).then(done);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Passphrase'), 'AAAA-BBBB{Enter}');
    const pass = 'a passphrase the core judges';
    await user.type(await screen.findByLabelText('New passphrase'), pass);
    await user.type(screen.getByLabelText('Repeat the new passphrase'), pass);
    const save = screen.getByRole('button', { name: 'Save' });
    await user.click(save);
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This passphrase is too easy to guess: add more words or characters.',
      ),
    );
    await user.click(save);
    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The passphrase needs at least 12 characters.',
      ),
    );
    expect(done).not.toHaveBeenCalled();
    await user.click(save);
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(setPassphrase).toHaveBeenCalledTimes(3);
  });

  it('translates the typed errors of the core and keeps the rest as written', () => {
    expect(gateErrorText(new Error('weak-passphrase: too-short: at least 12'))).toBe(
      'The passphrase needs at least 12 characters.',
    );
    expect(gateErrorText('weak-passphrase: guessable: too easy')).toMatch(/too easy to guess/);
    expect(gateErrorText(new Error('wrong-secret: wrong passphrase or recovery key'))).toBe(
      'Wrong passphrase or recovery key.',
    );
    expect(gateErrorText(new Error('the vault engine stopped'))).toBe('the vault engine stopped');
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
