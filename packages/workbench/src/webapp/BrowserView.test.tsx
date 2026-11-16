import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type VaultInfo } from '../app/api';
import { Events } from '../app/events';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useManaged } from '../state/managed';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { dialog, DialogHost } from '../ui/dialogs';
import { emptyLayout, openPath, type Pane, type Tab } from '../workspace/layout';
import { BrowserView } from './BrowserView';
import { nativeViews, useViewStates } from './nativeViews';
import { confirmOrigin, forgetOrigins } from './origins';
import { startWebapps } from './start';

const PATH = 'Tools/GitHub.webapp';
const URL = 'https://github.com/';
const ORIGIN = 'https://github.com';
const FILE = `${JSON.stringify({ version: 1, url: URL })}\n`;
const RECT = { left: 120, top: 80, width: 640, height: 480 };

let mock: WailsMock;
let vault: VaultInfo;
let stopWebapps: () => void;
let pane: Pane;
let tab: Tab;

/** The stage is the only element with area in jsdom, and the dialogs are over everything. */
function stubLayout(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const r = this.classList.contains('browser-stage')
      ? RECT
      : { left: 0, top: 0, width: 0, height: 0 };
    return {
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
    } as DOMRect;
  });
  document.elementsFromPoint = (): Element[] => {
    const cover = document.querySelector('.modal-backdrop');
    const stage = document.querySelector('.browser-stage');
    return [cover, stage, document.body].filter((e): e is Element => !!e);
  };
}

async function setup(opts: { file?: string; flag?: boolean } = {}): Promise<void> {
  mock = installWailsMock();
  initI18n('en');
  configurePlatform();
  useSettings.getState().reset();
  useSync.setState({ info: {} });
  useManaged.setState({ features: { web_viewer: opts.flag !== false } });
  mock.config = { ...mock.config, features: { web_viewer: opts.flag !== false } };
  vault = await api.vault.open('/vaults/Apps');
  mock.vaults.get(vault.id)?.files.set(PATH, opts.file ?? FILE);
  useAppStore.getState().setVault(vault);
  const layout = openPath(emptyLayout(), PATH, { mode: 'live', newTab: true });
  useAppStore.setState({ layout });
  pane = layout.root as Pane;
  tab = pane.tabs[0] as Tab;
  localStorage.clear();
  forgetOrigins(vault.id);
  stubLayout();
  stopWebapps = startWebapps();
}

const view = () => render(<BrowserView vaultId={vault.id} pane={pane} tab={tab} />);
const live = () => [...mock.webview.views.values()];
/** What the UI asked of the core, without the keys it reserves at start. */
const asked = (): string[] => mock.webview.log.filter((l) => !l.startsWith('ReserveKeys'));
const stage = () => document.querySelector('.browser-stage') as HTMLElement;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  stopWebapps?.();
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({ vault: null, layout: emptyLayout() });
  useViewStates.setState({ views: {} });
  configurePlatform();
});

describe('an application where the browser is not embedded', () => {
  it('is a card that opens the page in the system browser', async () => {
    await setup();
    configurePlatform({ capabilities: { embeddedBrowser: false } });
    const open = vi.fn();
    (
      window as unknown as { runtime: { BrowserOpenURL: (u: string) => void } }
    ).runtime.BrowserOpenURL = open;
    view();
    expect(await screen.findByRole('heading', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByText(URL)).toBeInTheDocument();
    expect(screen.getByText(/opens in your browser/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open in the browser' }));
    expect(open).toHaveBeenCalledWith(URL);
    // nothing was asked of the core
    expect(asked()).toEqual([]);
    expect(document.querySelector('iframe, webview, .browser-stage')).toBeNull();
  });

  it('opens a tab of the browser on the web', async () => {
    await setup();
    configurePlatform({ kind: 'web' });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Open in the browser' }));
    expect(open).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer');
    expect(asked()).toEqual([]);
  });

  it('says so when the profile turns the browser off, and never asks the core', async () => {
    await setup({ flag: false });
    view();
    expect(await screen.findByText(/turned off by the configuration profile/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in the browser' })).toBeInTheDocument();
    expect(asked()).toEqual([]);
    expect(document.querySelector('.browser-stage')).toBeNull();
  });

  it('is the same card when the core says it cannot after all', async () => {
    await setup();
    confirmOrigin(vault.id, ORIGIN);
    mock.webview.available = false; // the capability said yes, the core refuses
    view();
    expect(await screen.findByText(/browser inside the tab is not available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in the browser' })).toBeEnabled();
  });
});

describe('a file that is not an application', () => {
  it.each([
    ['{', /not valid JSON/],
    ['[]', /does not have the form/],
    [JSON.stringify({ version: 3, url: URL }), /newer version/],
    [JSON.stringify({ version: 1, url: 'javascript:alert(1)' }), /Only http and https/],
    [JSON.stringify({ version: 1, url: 'file:///etc/passwd' }), /Only http and https/],
    [JSON.stringify({ version: 1, url: 'https://user:pw@github.com/' }), /user name or password/],
  ])('shows why, and loads nothing (%s)', async (file, message) => {
    await setup({ file });
    confirmOrigin(vault.id, ORIGIN);
    view();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This application cannot be opened');
    expect(alert).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Change address' })).toBeInTheDocument();
    expect(asked()).toEqual([]);
    expect(document.querySelector('.browser-stage')).toBeNull();
  });

  it('offers no editing in a vault that may not be changed', async () => {
    await setup({ file: '{' });
    useSync.setState({
      info: {
        [vault.id]: { readOnly: true },
      } as never,
    });
    view();
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Change address' })).toBeNull();
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
  });

  it('offers no editing where the profile turns applications off: the command would not run', async () => {
    await setup({ file: '{', flag: false });
    view();
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Change address' })).toBeNull();
    expect(screen.queryByText(/read-only/)).toBeNull();
  });

  it('gives each card its own heading id, so two panes with a card do not share one', async () => {
    await setup({ file: '{' });
    const two = render(
      <>
        <BrowserView vaultId={vault.id} pane={pane} tab={tab} />
        <BrowserView vaultId={vault.id} pane={pane} tab={{ ...tab, id: 'other-tab' }} />
      </>,
    );
    const cards = await waitFor(() => {
      const found = two.container.querySelectorAll('.app-card');
      expect(found).toHaveLength(2);
      return [...found];
    });
    const ids = cards.map((c) => c.getAttribute('aria-labelledby') as string);
    expect(new Set(ids).size).toBe(2);
    for (const [i, card] of cards.entries()) expect(card.querySelector('h2')?.id).toBe(ids[i]);
  });
});

describe('the first opening of an origin', () => {
  it('asks, and loads nothing until the user agrees', async () => {
    await setup();
    view();
    expect(
      await screen.findByRole('heading', { name: `Open ${ORIGIN} here?` }),
    ).toBeInTheDocument();
    expect(screen.getByText(/loads inside Clarae notanda/)).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(asked()).toEqual([]);
    expect(document.querySelector('.browser-stage')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open here' }));
    await waitFor(() => expect(live()).toHaveLength(1));
    expect(live()[0]).toMatchObject({ url: URL, vaultId: vault.id, visible: true });
    expect(localStorage.getItem(`clarae.webapp.origins.${vault.id}`)).toBe(`["${ORIGIN}"]`);
  });

  it('can send the page to the system browser instead', async () => {
    await setup();
    const open = vi.fn();
    (
      window as unknown as { runtime: { BrowserOpenURL: (u: string) => void } }
    ).runtime.BrowserOpenURL = open;
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Open in the browser' }));
    expect(open).toHaveBeenCalledWith(URL);
    expect(asked()).toEqual([]);
  });

  it('is not asked again for an origin confirmed on this device', async () => {
    await setup();
    confirmOrigin(vault.id, ORIGIN);
    view();
    await waitFor(() => expect(live()).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Open here' })).toBeNull();
  });

  it('is asked again once the data of the applications were cleared', async () => {
    await setup();
    confirmOrigin(vault.id, ORIGIN);
    view();
    await waitFor(() => expect(live()).toHaveLength(1));
    await act(async () => {
      await api.webview.clearData(vault.id);
      forgetOrigins(vault.id);
    });
    expect(await screen.findByRole('button', { name: 'Open here' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open here' }));
    await waitFor(() => expect(live()).toHaveLength(1));
    expect(mock.webview.log.filter((l) => l.startsWith('Open '))).toHaveLength(2);
  });
});

describe('the browser of the tab', () => {
  async function shown() {
    await setup();
    confirmOrigin(vault.id, ORIGIN);
    view();
    await waitFor(() => expect(live()).toHaveLength(1));
    await waitFor(() => expect(stage()).toHaveAttribute('data-phase', 'open'));
  }
  const viewId = () => live()[0]?.id as string;
  const send = (name: string, payload: Record<string, unknown>) =>
    act(() => mock.emit(name, { viewId: viewId(), vaultId: vault.id, ...payload }));

  it('opens at the rectangle of its stage, as fractions of the window', async () => {
    await shown();
    const v = live()[0];
    expect(v?.bounds.x).toBeCloseTo(RECT.left / window.innerWidth, 5);
    expect(v?.bounds.y).toBeCloseTo(RECT.top / window.innerHeight, 5);
    expect(v?.bounds.width).toBeCloseTo(RECT.width / window.innerWidth, 5);
    expect(v?.bounds.height).toBeCloseTo(RECT.height / window.innerHeight, 5);
  });

  it('has a bar with the address as text and the navigation of the page', async () => {
    await shown();
    expect(screen.getByRole('toolbar', { name: 'Application' })).toBeInTheDocument();
    expect(screen.getByText(URL)).toHaveClass('browser-url');
    // an address is not typed into the bar
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();

    send(Events.webviewState, {
      url: 'https://github.com/features',
      title: 'Features',
      loading: false,
      canGoBack: true,
      canGoForward: false,
    });
    expect(screen.getByText('https://github.com/features')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(mock.webview.log).toContain(`Back ${viewId()}`));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(mock.webview.log).toContain(`Reload ${viewId()}`));
  });

  it('shows the loading state while the page loads', async () => {
    await shown();
    send(Events.webviewState, {
      url: URL,
      title: '',
      loading: true,
      canGoBack: false,
      canGoForward: false,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(stage()).toHaveAttribute('aria-busy', 'true');
  });

  it('shows everything the page says as text, never as markup', async () => {
    await shown();
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    send(Events.webviewState, {
      url: `https://github.com/?q=${hostile}`,
      title: hostile,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
    send(Events.webviewBlocked, {
      url: `javascript:${hostile}`,
      reason: 'scheme',
      mainFrame: true,
    });
    send(Events.webviewPermission, { permission: hostile, origin: hostile });
    send(Events.webviewNewWindow, {
      url: `https://example.org/${hostile}`,
      opened: false,
      reason: 'other',
    });
    send(Events.webviewDownload, { url: hostile });
    expect(document.querySelectorAll('.browser-view img, .browser-view script')).toHaveLength(0);
    expect(document.querySelector('.browser-view [onerror]')).toBeNull();
    expect(screen.getByRole('list', { name: 'Messages of the page' })).toHaveTextContent(
      '<img src=x',
    );
    expect(document.body.textContent).toContain('<img src=x');
    // the address bar and the notices are text nodes
    expect(document.querySelector('.browser-url')?.textContent).toContain('<img src=x');
  });

  it('tells what the core refused, and lets the user dismiss it', async () => {
    await shown();
    send(Events.webviewBlocked, { url: 'file:///etc/passwd', reason: 'scheme', mainFrame: true });
    send(Events.webviewDownload, { url: 'https://github.com/a.zip' });
    send(Events.webviewPermission, { permission: 'camera', origin: 'https://github.com' });
    send(Events.webviewNewWindow, { url: 'https://example.org/', opened: true, reason: 'other' });
    const list = screen.getByRole('list', { name: 'Messages of the page' });
    expect(list).toHaveTextContent('A download was refused');
    expect(list).toHaveTextContent('asked for the permission “camera”: denied');
    expect(list).toHaveTextContent('its address opened in your browser');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0] as HTMLElement);
    expect(list.querySelectorAll('li')).toHaveLength(2);
  });

  it('refuses a certificate with no way around it', async () => {
    await shown();
    send(Events.webviewLoadError, {
      url: 'https://self-signed.test/',
      message: 'The certificate is not trusted',
      code: -1202,
      certificate: true,
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The certificate of the site is not valid');
    expect(alert).toHaveTextContent('There is no way to continue anyway');
    const buttons = [...alert.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Open in the browser', 'Try again']);
    // the view steps aside for the card
    await waitFor(() => expect(live()[0]?.visible).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(live()[0]?.visible).toBe(true));
    expect(mock.webview.log).toContain(`Reload ${viewId()}`);
  });

  it('offers to reload a page that crashed', async () => {
    await shown();
    send(Events.webviewCrashed, {});
    expect(await screen.findByRole('alert')).toHaveTextContent('The page stopped working');
    await waitFor(() => expect(live()[0]?.visible).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mock.webview.log).toContain(`Reload ${viewId()}`));
  });

  it('explains a view the core ended, and opens it again', async () => {
    await shown();
    const id = viewId();
    mock.webview.views.delete(id);
    send(Events.webviewClosed, { viewId: id, reason: 'data-cleared' });
    // the origin is still confirmed here, so the card for the closed view shows
    expect(
      await screen.findByText('The data of the applications were cleared.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open again' }));
    await waitFor(() => expect(live()).toHaveLength(1));
    expect(viewId()).not.toBe(id);
  });

  it('waits for the unlock of a locked vault, and opens by itself when it comes', async () => {
    await shown();
    // the vault locks: the core ends its views and says so
    act(() => useSync.setState({ info: { [vault.id]: { locked: true } } as never }));
    act(() => mock.webview.endViews(vault.id, 'vault-locked'));
    expect(await screen.findByText(/The vault is locked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open again' })).toBeNull();
    expect(live()).toHaveLength(0);
    // the passphrase is given: the application that ended with the lock is there again
    act(() => useSync.setState({ info: { [vault.id]: { locked: false } } as never }));
    await waitFor(() => expect(live()).toHaveLength(1));
    await waitFor(() => expect(stage()).toHaveAttribute('data-phase', 'open'));
    expect(screen.queryByText(/The vault is locked/)).toBeNull();
  });

  it('opens again after the profile turned the browser off and on', async () => {
    await shown();
    act(() => useManaged.setState({ features: { web_viewer: false } }));
    act(() => mock.webview.endViews(vault.id, 'disabled'));
    expect(await screen.findByText(/turned off by the configuration profile/)).toBeInTheDocument();
    act(() => useManaged.setState({ features: { web_viewer: true } }));
    await waitFor(() => expect(live()).toHaveLength(1));
    expect(mock.webview.log.filter((l) => l.startsWith('Open '))).toHaveLength(2);
  });

  it('says when there are too many applications open', async () => {
    await setup();
    confirmOrigin(vault.id, ORIGIN);
    mock.webview.failNextOpen = 'webview-limit: too many applications are open';
    view();
    expect(
      await screen.findByRole('heading', { name: 'Too many applications are open' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/close one and try again/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(live()).toHaveLength(1));
  });

  it('hides the page under a dialog, and shows it again when the dialog closes', async () => {
    await shown();
    render(<DialogHost />);
    expect(live()[0]?.visible).toBe(true);
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => {
      answer = dialog.confirm('Sure?', 'The page is below');
    });
    await screen.findByRole('dialog');
    act(() => nativeViews.update());
    await waitFor(() => expect(live()[0]?.visible).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await answer;
    act(() => nativeViews.update());
    await waitFor(() => expect(live()[0]?.visible).toBe(true));
  });

  it('hides the page when the tab is not shown and keeps it for when it is', async () => {
    await shown();
    cleanup();
    await waitFor(() => expect(live()[0]?.visible).toBe(false));
    expect(mock.webview.log.some((l) => l.startsWith('Close '))).toBe(false);
    const id = viewId();
    view();
    await waitFor(() => expect(live()[0]?.visible).toBe(true));
    expect(viewId()).toBe(id);
    expect(mock.webview.log.filter((l) => l.startsWith('Open '))).toHaveLength(1);
  });

  it('opens the page in the browser from the bar, where the user is', async () => {
    await shown();
    const open = vi.fn();
    (
      window as unknown as { runtime: { BrowserOpenURL: (u: string) => void } }
    ).runtime.BrowserOpenURL = open;
    send(Events.webviewState, {
      url: 'https://github.com/features',
      title: '',
      loading: false,
      canGoBack: true,
      canGoForward: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open in the browser' }));
    expect(open).toHaveBeenCalledWith('https://github.com/features');
  });

  it('follows the file when its address changes', async () => {
    await shown();
    mock.vaults
      .get(vault.id)
      ?.files.set(PATH, `${JSON.stringify({ version: 1, url: 'https://github.com/new' })}\n`);
    act(() => mock.emit(Events.vaultFileChanged, { vaultId: vault.id, paths: [PATH] }));
    await waitFor(() =>
      expect(mock.webview.log).toContain(`Navigate ${viewId()} https://github.com/new`),
    );
  });
});
