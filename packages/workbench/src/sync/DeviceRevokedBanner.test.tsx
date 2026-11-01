import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AuthState } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';
import { AccountButton } from '../shell/AccountButton';
import { DeviceRevokedBanner } from './DeviceRevokedBanner';

const revoked = (serverUrl = 'https://memobrain.test'): AuthState => ({
  status: 'device_revoked',
  serverUrl,
  profile: { userId: 'u1', username: 'ada', email: '', displayName: 'Ada', role: 'user' },
  deviceId: 'dev-1',
  error: 'this device was revoked from your account: register it again to resume synchronization',
});

let mock: WailsMock;
beforeEach(() => {
  initI18n('en');
  mock = installWailsMock();
  useAppStore.setState({ auth: null });
});

describe('device revoked banner', () => {
  it('is hidden unless the device is revoked', () => {
    useAppStore.setState({ auth: { ...revoked(), status: 'ready', error: '' } });
    render(<DeviceRevokedBanner />);
    expect(screen.queryByTestId('device-revoked')).toBeNull();
  });

  it('explains that local data is kept and registers the device again', async () => {
    mock.auth = revoked();
    useAppStore.setState({ auth: revoked() });
    render(<DeviceRevokedBanner />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/revoked/);
    expect(banner).toHaveTextContent(/stay on this device/);
    fireEvent.click(screen.getByRole('button', { name: 'Register this device again' }));
    await waitFor(() => expect(useAppStore.getState().auth?.status).toBe('ready'));
    expect(useAppStore.getState().auth?.deviceId).toBe('dev-1-new');
    expect(screen.queryByTestId('device-revoked')).toBeNull();
  });

  it('stays, with the reason, when the registration fails', async () => {
    mock.auth = revoked('https://fail.test');
    useAppStore.setState({ auth: revoked('https://fail.test') });
    render(<DeviceRevokedBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Register this device again' }));
    expect(
      await screen.findByText(/could not be registered again: .*network down/),
    ).toBeInTheDocument();
    expect(useAppStore.getState().auth?.status).toBe('device_revoked');
    expect(screen.getByRole('button', { name: 'Register this device again' })).toBeEnabled();
  });

  it('is offered from the account menu too', async () => {
    mock.auth = revoked();
    useAppStore.setState({ auth: revoked() });
    render(<AccountButton />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Signed in as Ada — this device was revoked' }),
    );
    fireEvent.click(await screen.findByText('Register this device again'));
    await waitFor(() => expect(useAppStore.getState().auth?.status).toBe('ready'));
  });
});
