import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountButton, initials } from './AccountButton';
import type { AuthState } from '../app/api';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';

const profile = (over: Partial<AuthState['profile']> = {}): AuthState['profile'] => ({
  userId: 'u1',
  username: 'ada',
  email: 'ada@example.org',
  displayName: 'Ada Lovelace',
  role: 'user',
  ...over,
});
const auth = (over: Partial<AuthState> = {}): AuthState => ({
  status: 'ready',
  serverUrl: 'https://memobrain.test',
  profile: profile(),
  deviceId: 'd1',
  error: '',
  ...over,
});

let mock: WailsMock;
beforeEach(() => {
  initI18n('en');
  mock = installWailsMock();
  useAppStore.setState({ auth: null, settingsOpen: false });
});

describe('initials', () => {
  it('takes the first and last word, or the first two letters of a single one', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Ada Augusta King Lovelace')).toBe('AL');
    expect(initials('ada')).toBe('AD');
    expect(initials('  ')).toBe('?');
    expect(initials('édith piaf')).toBe('ÉP');
  });
});

describe('account button', () => {
  it('offers to log in when signed out, using the known server', async () => {
    useAppStore.setState({
      auth: auth({ status: 'signed_out', profile: profile({ displayName: '', username: '' }) }),
    });
    render(<AccountButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(useAppStore.getState().auth?.status).toBe('ready'));
    expect(mock.auth.serverUrl).toBe('https://memobrain.test');
    expect(await screen.findByRole('button', { name: 'Uno' })).toBeInTheDocument();
  });

  it('asks for the server address in the settings when there is none', () => {
    useAppStore.setState({ auth: auth({ status: 'signed_out', serverUrl: '' }) });
    render(<AccountButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    return waitFor(() => {
      expect(useAppStore.getState().settingsOpen).toBe(true);
      expect(useAppStore.getState().settingsSection).toBe('cloud');
    });
  });

  it('shows the avatar of the signed-in user with a menu: account and sign out', async () => {
    useAppStore.setState({ auth: auth() });
    render(<AccountButton />);
    const avatar = screen.getByRole('button', { name: 'Ada Lovelace' });
    expect(avatar).toHaveTextContent('AL');

    fireEvent.click(avatar);
    expect(await screen.findByRole('menuitem', { name: 'ada@example.org' })).toBeDisabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account and devices…' }));
    expect(useAppStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'cloud' });

    fireEvent.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(mock.auth.status).toBe('signed_out'));
  });

  it('marks a lost connection and offers to reconnect', async () => {
    useAppStore.setState({ auth: auth({ status: 'disconnected' }) });
    render(<AccountButton />);
    const avatar = screen.getByRole('button', { name: /Ada Lovelace/ });
    expect(avatar).toHaveClass('disconnected');
    fireEvent.click(avatar);
    expect(await screen.findByRole('menuitem', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('is disabled while signing in', () => {
    useAppStore.setState({ auth: auth({ status: 'signing_in' }) });
    render(<AccountButton />);
    expect(screen.getByRole('button', { name: 'Waiting for the browser…' })).toBeDisabled();
  });

  describe('where the host does not own the session (the browser)', () => {
    afterEach(() => configurePlatform());

    it('offers neither signing in nor out: the console does', async () => {
      configurePlatform({ kind: 'web' });
      useAppStore.setState({ auth: auth({ status: 'signed_out' }) });
      const { unmount } = render(<AccountButton />);
      expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
      unmount();

      useAppStore.setState({ auth: auth({ status: 'disconnected' }) });
      render(<AccountButton />);
      fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }));
      expect(await screen.findByRole('menuitem', { name: 'Account and devices…' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Reconnect' })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Sign out' })).not.toBeInTheDocument();
    });
  });
});
