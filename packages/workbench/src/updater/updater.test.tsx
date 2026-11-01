import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { commands } from '../commands/registry';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { UpdateDialog, UpdateIndicator } from './UpdateDialog';
import { UpdateSettings } from './UpdateSettings';
import { idleStatus, updaterMock } from './mock';
import { useUpdater } from './store';

beforeEach(() => {
  initI18n('en');
  installWailsMock();
  useUpdater.setState({ status: null, dialogOpen: false, message: '', error: '', busy: false });
});

const available = () =>
  idleStatus({
    state: 'available',
    latest: '1.1.0',
    notes: 'Faster sync',
    kind: 'deb',
    size: 1024,
  });

function mount() {
  return render(
    <>
      <UpdateIndicator />
      <UpdateDialog />
    </>,
  );
}

describe('update:check command', () => {
  it('is registered and reports an up-to-date build', async () => {
    mount();
    const cmd = commands.find((c) => c.id === 'update:check');
    expect(cmd).toBeDefined();
    await act(async () => {
      await cmd?.run();
    });
    expect(updaterMock.checks).toBe(1);
    expect(await screen.findByText(/MemoBrain Notes 1\.0\.0 is up to date/)).toBeInTheDocument();
  });

  it('shows the error of a failed check', async () => {
    updaterMock.checkError = 'signature verification failed';
    mount();
    await act(async () => {
      await useUpdater.getState().check();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('signature verification failed');
  });
});

describe('update channel warning', () => {
  const warning = 'the update channel has not been refreshed; updates may be withheld';

  it('shows the warning of a check in the dialog', async () => {
    updaterMock.next = idleStatus({ state: 'up-to-date', latest: '1.0.0', warning });
    mount();
    await act(async () => {
      await useUpdater.getState().check();
    });
    expect(await screen.findByRole('note')).toHaveTextContent(`Warning: ${warning}`);
  });

  it('shows it in the update settings too', async () => {
    useUpdater.setState({ status: idleStatus({ warning }) });
    render(<UpdateSettings />);
    expect(await screen.findByRole('note')).toHaveTextContent(warning);
  });

  it('says nothing when there is no warning', async () => {
    useUpdater.setState({ status: idleStatus({ state: 'up-to-date' }), dialogOpen: true });
    mount();
    await screen.findByRole('dialog');
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('update available', () => {
  it('announces in the status bar and opens the dialog with the release notes', async () => {
    updaterMock.status = available();
    mount();
    const item = await screen.findByRole('button', { name: /Update 1\.1\.0/ });
    fireEvent.click(item);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Faster sync')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install and restart' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip this version' })).toBeInTheDocument();
  });

  it('installs and shows what happened', async () => {
    updaterMock.status = available();
    useUpdater.setState({ status: available(), dialogOpen: true });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Verified: /mock/update.deb');
    expect(updaterMock.installs).toBe(1);
  });

  it('skip hides the indicator and remembers the version', async () => {
    updaterMock.status = available();
    useUpdater.setState({ status: available(), dialogOpen: true });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Skip this version' }));
    await waitFor(() => expect(updaterMock.skipped).toEqual(['1.1.0']));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Update 1\.1\.0/ })).toBeNull(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a required update cannot be skipped', () => {
    useUpdater.setState({ status: { ...available(), required: true }, dialogOpen: true });
    mount();
    expect(screen.queryByRole('button', { name: 'Skip this version' })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(/no longer supported/);
  });

  it('Later closes the dialog', () => {
    useUpdater.setState({ status: available(), dialogOpen: true });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('UpdateSettings', () => {
  it('saves the opt-out and the channel', async () => {
    render(<UpdateSettings />);
    const auto = await screen.findByLabelText('Check for updates automatically');
    fireEvent.click(auto);
    await waitFor(() => expect(updaterMock.settings.enabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Update channel'), { target: { value: 'beta' } });
    await waitFor(() => expect(updaterMock.settings.channel).toBe('beta'));
  });

  it('is read-only when updates are disabled by the administrator', async () => {
    useUpdater.setState({ status: idleStatus({ disabled: 'managed' }) });
    render(<UpdateSettings />);
    expect(await screen.findByLabelText('Check for updates automatically')).toBeDisabled();
    expect(screen.getByText(/Updates are turned off: managed/)).toBeInTheDocument();
  });
});
