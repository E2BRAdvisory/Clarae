import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Welcome } from '../shell/Welcome';
import { initI18n } from '../i18n';
import { enterFullscreen } from '../util/fullscreen';
import { openExternal } from '../util/external';
import { can, capabilitiesFor, configurePlatform, usePlatform } from './index';

initI18n();

afterEach(() => {
  configurePlatform(); // back to the desktop
  vi.restoreAllMocks();
});

function renderWelcome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Welcome onOpen={() => Promise.resolve()} />
    </QueryClientProvider>,
  );
}

describe('platform capabilities', () => {
  it('the desktop has everything, the browser only cloud vaults', () => {
    expect(capabilitiesFor('desktop')).toEqual({
      localFolders: true,
      updater: true,
      diskEncryptionCheck: true,
      nativeWindow: true,
      osTrash: true,
      multiVault: true,
      unlinkVault: true,
      ownsSession: true,
      detachedCopies: true,
    });
    expect(capabilitiesFor('web')).toEqual({
      localFolders: false,
      updater: false,
      diskEncryptionCheck: false,
      nativeWindow: false,
      osTrash: false,
      multiVault: false,
      unlinkVault: false,
      ownsSession: false,
      detachedCopies: false,
    });
  });

  it('takes the host overrides', () => {
    configurePlatform({ kind: 'web', capabilities: { osTrash: true } });
    expect(can('osTrash')).toBe(true);
    expect(can('multiVault')).toBe(false);
  });

  it('keeps the way to remove the copy from the browser that the host gives', () => {
    const remove = vi.fn();
    configurePlatform({ kind: 'web', onRemoveFromBrowser: remove });
    usePlatform.getState().removeFromBrowser?.();
    expect(remove).toHaveBeenCalledOnce();
    configurePlatform();
    expect(usePlatform.getState().removeFromBrowser).toBeNull();
  });

  it('keeps the ways to open and forget a mount that the host gives', () => {
    const open = vi.fn();
    const removed = vi.fn();
    configurePlatform({ kind: 'web', onOpenMount: open, onMountRemoved: removed });
    usePlatform.getState().openMount?.({ shareId: 's1', cloudVaultId: 'c1' });
    usePlatform.getState().mountRemoved?.('s1');
    expect(open).toHaveBeenCalledWith({ shareId: 's1', cloudVaultId: 'c1' });
    expect(removed).toHaveBeenCalledWith('s1');
    configurePlatform();
    expect(usePlatform.getState().openMount).toBeNull();
    expect(usePlatform.getState().mountRemoved).toBeNull();
  });

  it('defaults to the desktop and follows what the host configures', () => {
    expect(usePlatform.getState().kind).toBe('desktop');
    expect(can('updater')).toBe(true);
    configurePlatform({ kind: 'web' });
    expect(usePlatform.getState().kind).toBe('web');
    expect(can('updater')).toBe(false);
    expect(usePlatform.getState().backToConsole).toBeNull();
  });

  it('hands out copies, so one caller cannot change another host', () => {
    const caps = capabilitiesFor('web');
    caps.updater = true;
    expect(capabilitiesFor('web').updater).toBe(false);
  });
});

describe('the welcome screen', () => {
  it('offers a local folder on the desktop', () => {
    renderWelcome();
    expect(screen.getByRole('button', { name: /open folder as vault/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /back to the console/i })).not.toBeInTheDocument();
  });

  it('lists the recent vaults on the desktop only', async () => {
    const { installWailsMock } = await import('../test/wails-mock');
    const { api } = await import('../app/api');
    installWailsMock();
    await api.vault.open('/vaults/Recent One');
    const first = renderWelcome();
    expect(await screen.findByText('Recent One')).toBeInTheDocument();
    first.unmount();
    configurePlatform({ kind: 'web' });
    renderWelcome();
    expect(screen.queryByText(/recent/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Recent One')).not.toBeInTheDocument();
  });

  it('offers the way back to the console, not a local folder, in the browser', () => {
    const back = vi.fn();
    configurePlatform({ kind: 'web', onBackToConsole: back });
    renderWelcome();
    expect(screen.queryByRole('button', { name: /open folder as vault/i })).not.toBeInTheDocument();
    expect(screen.getByText(/cloud vaults from the console/i)).toBeInTheDocument();
    screen.getByRole('button', { name: /back to the console/i }).click();
    expect(back).toHaveBeenCalledOnce();
  });
});

describe('leaving the page', () => {
  it('opens external links in a new tab that cannot reach back, in the browser', () => {
    configurePlatform({ kind: 'web' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openExternal('https://example.com/x');
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
  });

  it('ignores unsafe URLs on every platform', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    for (const kind of ['web', 'desktop'] as const) {
      configurePlatform({ kind });
      openExternal('javascript:alert(1)');
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('does not touch a window that is not there when presenting in the browser', async () => {
    configurePlatform({ kind: 'web' });
    const el = document.createElement('div');
    Object.defineProperty(el, 'requestFullscreen', { value: undefined });
    await expect(enterFullscreen(el)).resolves.toBeUndefined();
  });
});
