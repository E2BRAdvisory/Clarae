import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { Events } from '../app/events';
import { useAppStore } from '../state/store';
import { emptyLayout, openPath, type Layout } from '../workspace/layout';
import {
  isCovered,
  NativeViews,
  normalizeBounds,
  useViewStates,
  type ViewCalls,
} from './nativeViews';

// A window of 1000 x 800 CSS pixels; a stage of 500 x 400 at (100, 200) is the fractions below.
const WIN = { w: 1000, h: 800 };
const RECT = { left: 100, top: 200, width: 500, height: 400 };
const BOUNDS = { x: 0.1, y: 0.25, width: 0.5, height: 0.5 };

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await tick();
};

/** The part of WebViewAPI the manager uses, recording its calls. `viewId`s are v1, v2, … */
function fakeCalls() {
  let n = 0;
  const calls = {
    open: vi.fn((_vault: string, _url: string, _b: unknown) =>
      Promise.resolve({ viewId: `v${++n}`, persistentData: true }),
    ),
    setBounds: vi.fn(() => Promise.resolve()),
    setVisible: vi.fn(() => Promise.resolve()),
    navigate: vi.fn(() => Promise.resolve()),
    back: vi.fn(() => Promise.resolve()),
    forward: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    focus: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    closeVault: vi.fn(() => Promise.resolve()),
    reserveKeys: vi.fn((_list: string[]) => Promise.resolve()),
    clearData: vi.fn(() => Promise.resolve()),
    status: vi.fn(() =>
      Promise.resolve({
        available: true,
        enabled: true,
        persistentData: true,
        maxViewsPerVault: 32,
      }),
    ),
  };
  return calls as typeof calls & ViewCalls;
}

interface Stage {
  el: HTMLDivElement;
  rect: typeof RECT;
}

let mock: WailsMock;
let calls: ReturnType<typeof fakeCalls>;
let views: NativeViews;
let stop: () => void;
let stages: Stage[];
/** What is drawn above the stages, when something is (a palette, a dialog). */
let cover: Element | null;
let keys: string[];

/** A stage in the page, with the rectangle a browser would give it. */
function stage(rect = RECT): Stage {
  const el = document.createElement('div');
  document.body.append(el);
  const s = { el, rect };
  el.getBoundingClientRect = () =>
    ({
      ...s.rect,
      right: s.rect.left + s.rect.width,
      bottom: s.rect.top + s.rect.height,
    }) as DOMRect;
  stages.push(s);
  return s;
}

const place = (
  tabId: string,
  s: Stage,
  o: { url?: string; focused?: boolean; vaultId?: string } = {},
) =>
  views.attach({
    tabId,
    vaultId: o.vaultId ?? 'v1',
    url: o.url ?? 'https://example.com/',
    stage: s.el,
    paneFocused: o.focused ?? false,
  });

/** A layout holding tabs on these paths (the first one active), as the app would restore it. */
function layoutOf(...paths: string[]): { layout: Layout; ids: string[] } {
  let layout = emptyLayout();
  for (const p of paths) layout = openPath(layout, p, { mode: 'live', newTab: true });
  const pane = layout.root.kind === 'pane' ? layout.root : null;
  return { layout, ids: pane?.tabs.map((t) => t.id) ?? [] };
}

beforeEach(() => {
  mock = installWailsMock();
  calls = fakeCalls();
  stages = [];
  cover = null;
  keys = [];
  Object.defineProperty(window, 'innerWidth', { value: WIN.w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: WIN.h, configurable: true });
  document.elementsFromPoint = (x: number, y: number): Element[] => {
    const inside = stages.find(
      (s) =>
        x >= s.rect.left &&
        x <= s.rect.left + s.rect.width &&
        y >= s.rect.top &&
        y <= s.rect.top + s.rect.height,
    );
    return [cover, inside?.el, document.body].filter((e): e is Element => !!e);
  };
  useViewStates.setState({ views: {} });
  useAppStore.setState({
    vault: { id: 'v1', path: '/v1', name: 'V' } as never,
    layout: emptyLayout(),
  });
  views = new NativeViews({
    api: calls,
    embedded: () => true,
    frame: (cb) => {
      cb();
      return 1;
    },
    cancelFrame: () => undefined,
  });
  stop = views.start((a) => keys.push(a));
});

afterEach(() => {
  stop();
  for (const s of stages) s.el.remove();
  cover?.remove();
  useAppStore.setState({ vault: null, layout: emptyLayout() });
});

describe('normalizeBounds', () => {
  it('is a fraction of the viewport, whatever the pixel ratio or the zoom', () => {
    expect(normalizeBounds(RECT, WIN.w, WIN.h)).toEqual(BOUNDS);
    // a display with twice the pixels, or a zoomed application: the viewport is in CSS pixels, so is the rect
    const ratio = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    expect(normalizeBounds(RECT, WIN.w, WIN.h)).toEqual(BOUNDS);
    Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true });
    // the same layout at half the window size is the same fractions
    expect(
      normalizeBounds({ left: 50, top: 100, width: 250, height: 200 }, WIN.w / 2, WIN.h / 2),
    ).toEqual(BOUNDS);
  });

  it('stays inside the window and has an area, or is nothing', () => {
    expect(normalizeBounds({ left: -50, top: -10, width: 2000, height: 2000 }, 1000, 800)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(normalizeBounds({ left: 900, top: 700, width: 400, height: 400 }, 1000, 800)).toEqual({
      x: 0.9,
      y: 0.875,
      width: 0.1,
      height: 0.125,
    });
    expect(normalizeBounds({ left: 0, top: 0, width: 0, height: 10 }, 1000, 800)).toBeNull();
    expect(normalizeBounds({ left: 2000, top: 0, width: 10, height: 10 }, 1000, 800)).toBeNull();
    expect(normalizeBounds(RECT, 0, 800)).toBeNull();
  });
});

describe('isCovered', () => {
  it('sees what is drawn above the stage, and nothing else', () => {
    const s = stage();
    const child = document.createElement('p');
    s.el.append(child);
    const at = (top: Element) => () => [top];
    expect(isCovered(s.el, RECT, at(s.el))).toBe(false);
    expect(isCovered(s.el, RECT, at(child))).toBe(false); // a card of the stage itself
    expect(isCovered(s.el, RECT, at(document.body))).toBe(true);
    expect(isCovered(s.el, RECT, () => [])).toBe(false); // nothing there (outside the viewport)
  });

  it('finds a menu that covers only a corner of the stage', () => {
    const s = stage();
    const menu = document.createElement('div');
    const at = (x: number, y: number): Element[] =>
      x > RECT.left + 380 && y < RECT.top + 120 ? [menu, s.el] : [s.el];
    expect(isCovered(s.el, RECT, at)).toBe(true);
  });
});

describe('opening', () => {
  it('loads nothing until a stage is shown: a restored tab costs no call', async () => {
    const { layout } = layoutOf('A.webapp', 'B.webapp');
    useAppStore.setState({ layout });
    await settle();
    expect(calls.open).not.toHaveBeenCalled();
    expect(calls.status).not.toHaveBeenCalled();
    expect(Object.keys(useViewStates.getState().views)).toEqual([]);
  });

  it('opens the view of the stage that is shown, once, at the fractions of its rectangle', async () => {
    const { layout, ids } = layoutOf('A.webapp', 'B.webapp');
    useAppStore.setState({ layout });
    place(ids[1] as string, stage());
    await settle();
    expect(calls.open).toHaveBeenCalledTimes(1);
    expect(calls.open).toHaveBeenCalledWith('v1', 'https://example.com/', BOUNDS);
    expect(useViewStates.getState().views[ids[1] as string]?.phase).toBe('open');
    // the other tab, never shown, has nothing
    expect(useViewStates.getState().views[ids[0] as string]).toBeUndefined();
  });

  it('waits for a stage that has no area yet', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    const s = stage({ left: 0, top: 0, width: 0, height: 0 });
    place(ids[0] as string, s);
    await settle();
    expect(calls.open).not.toHaveBeenCalled();
    s.rect = RECT;
    views.update();
    await settle();
    expect(calls.open).toHaveBeenCalledWith('v1', 'https://example.com/', BOUNDS);
  });

  it('waits while something covers the stage, and opens when it is gone', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    cover = document.body.appendChild(document.createElement('div'));
    place(ids[0] as string, stage());
    await settle();
    expect(calls.open).not.toHaveBeenCalled();
    cover.remove();
    cover = null;
    views.update();
    await settle();
    expect(calls.open).toHaveBeenCalledTimes(1);
  });

  it('opens one view per tab: two panels on the same application are two views', async () => {
    // the same file in two panes is two tabs, each with its own stage
    place('tab-left', stage());
    place('tab-right', stage({ left: 700, top: 200, width: 250, height: 400 }));
    await settle();
    expect(calls.open).toHaveBeenCalledTimes(2);
    expect(calls.open).toHaveBeenNthCalledWith(1, 'v1', 'https://example.com/', BOUNDS);
    expect(calls.open).toHaveBeenNthCalledWith(2, 'v1', 'https://example.com/', {
      x: 0.7,
      y: 0.25,
      width: 0.25,
      height: 0.5,
    });
    const open = useViewStates.getState().views;
    expect(open['tab-left']?.phase).toBe('open');
    expect(open['tab-right']?.phase).toBe('open');
  });

  it('does not open a second view when asked to reload one that is still opening', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    let release: (v: { viewId: string; persistentData: boolean }) => void = () => undefined;
    calls.open.mockImplementationOnce(() => new Promise((r) => (release = r)));
    place(ids[0] as string, stage());
    await settle();
    views.reload(ids[0] as string);
    views.reopen(ids[0] as string);
    release({ viewId: 'first', persistentData: true });
    await settle();
    expect(calls.open).toHaveBeenCalledTimes(1);
    expect(calls.close).not.toHaveBeenCalled();
    expect(useViewStates.getState().views[ids[0] as string]?.phase).toBe('open');
  });

  it('says why it failed, and tries again on request', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    calls.open.mockRejectedValueOnce(new Error('webview-limit: too many applications are open'));
    place(ids[0] as string, stage());
    await settle();
    const st = useViewStates.getState().views[ids[0] as string];
    expect(st?.phase).toBe('failed');
    expect(st?.error).toMatch(/^webview-limit:/);
    views.reopen(ids[0] as string);
    await settle();
    expect(useViewStates.getState().views[ids[0] as string]?.phase).toBe('open');
    expect(calls.open).toHaveBeenCalledTimes(2);
  });
});

describe('placement', () => {
  async function opened() {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    const s = stage();
    const detach = place(ids[0] as string, s, { focused: false });
    await settle();
    calls.setBounds.mockClear();
    calls.setVisible.mockClear();
    return { s, id: ids[0] as string, detach };
  }

  it('follows the stage, and only when it moved', async () => {
    const { s } = await opened();
    views.update();
    await settle();
    expect(calls.setBounds).not.toHaveBeenCalled();
    s.rect = { left: 100, top: 200, width: 300, height: 400 };
    views.update();
    await settle();
    expect(calls.setBounds).toHaveBeenCalledTimes(1);
    expect(calls.setBounds).toHaveBeenCalledWith('v1', 'v1', {
      x: 0.1,
      y: 0.25,
      width: 0.3,
      height: 0.5,
    });
  });

  it('coalesces the changes of a frame into one update', async () => {
    const { s } = await opened();
    const frames: (() => void)[] = [];
    const lazy = new NativeViews({
      api: calls,
      embedded: () => true,
      frame: (cb) => frames.push(cb),
      cancelFrame: () => undefined,
    });
    expect(frames).toHaveLength(0);
    lazy.schedule();
    lazy.schedule();
    lazy.schedule();
    expect(frames).toHaveLength(1);
    s.rect = RECT;
  });

  it('hides when the tab goes away and keeps the page: it comes back without opening again', async () => {
    const { s, id, detach } = await opened();
    detach();
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    expect(calls.close).not.toHaveBeenCalled();
    place(id, s);
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);
    expect(calls.open).toHaveBeenCalledTimes(1);
  });

  it('hides under a drag, and shows again after it', async () => {
    await opened();
    document.dispatchEvent(new Event('dragstart'));
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    document.dispatchEvent(new Event('dragend'));
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);
  });

  it('hides while a splitter is dragged over it', async () => {
    await opened();
    const bar = document.body.appendChild(document.createElement('div'));
    bar.setAttribute('role', 'separator');
    bar.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    window.dispatchEvent(new Event('pointerup'));
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);
    bar.remove();
  });

  it('hides under what the application draws above it, and shows again when it is gone', async () => {
    await opened();
    const dialog = document.body.appendChild(document.createElement('div'));
    cover = dialog;
    views.update();
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    dialog.remove();
    cover = null;
    views.update();
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);
  });

  it('suppresses on request, at once, and releases', async () => {
    await opened();
    const release = views.suppress('test');
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    release();
    release(); // idempotent
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);
  });

  it('gives the page the keyboard when the pane has the focus of the application', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage(), { focused: true });
    await settle();
    expect(calls.focus).toHaveBeenCalledTimes(1);
    expect(calls.focus).toHaveBeenCalledWith('v1', 'v1');
  });

  it('does not take the keyboard of another pane', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage(), { focused: false });
    await settle();
    expect(calls.focus).not.toHaveBeenCalled();
    views.setPaneFocused(ids[0] as string, true);
    await settle();
    expect(calls.focus).toHaveBeenCalledTimes(1);
  });

  it('gives the page the keyboard back after something that covered it goes away', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage(), { focused: true });
    await settle();
    expect(calls.focus).toHaveBeenCalledTimes(1);
    calls.focus.mockClear();
    // a palette or a dialog: the pane keeps the focus of the application (nobody calls setPaneFocused),
    // the driver took the keyboard from the view it hid
    const dialog = document.body.appendChild(document.createElement('div'));
    cover = dialog;
    views.update();
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    dialog.remove();
    cover = null;
    views.update();
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);
    expect(calls.focus).toHaveBeenCalledTimes(1);
  });

  it('does not give the keyboard back to a page whose pane lost the focus meanwhile', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    const detach = place(ids[0] as string, stage(), { focused: false });
    await settle();
    detach();
    await settle();
    cover = document.body.appendChild(document.createElement('div'));
    const again = place(ids[0] as string, stages[0] as Stage, { focused: true }); // shown again, under a dialog
    void again;
    await settle();
    views.setPaneFocused(ids[0] as string, false); // the user clicks into another pane
    cover.remove();
    cover = null;
    views.update();
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);
    expect(calls.focus).not.toHaveBeenCalled();
  });

  it('does not take the keyboard from another pane when the view finishes opening', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    let release: (v: { viewId: string; persistentData: boolean }) => void = () => undefined;
    calls.open.mockImplementationOnce(() => new Promise((r) => (release = r)));
    place(ids[0] as string, stage(), { focused: true });
    await settle();
    views.setPaneFocused(ids[0] as string, false); // the user clicks into the editor of another pane
    release({ viewId: 'v1', persistentData: true });
    await settle();
    expect(calls.focus).not.toHaveBeenCalled();
  });

  it('focuses the pane of a view the user clicked', async () => {
    const left = layoutOf('A.webapp');
    useAppStore.setState({ layout: left.layout });
    place(left.ids[0] as string, stage(), { focused: false });
    await settle();
    const spy = vi.spyOn(useAppStore.getState(), 'focusPane');
    useAppStore.setState({ focusPane: spy });
    mock.emit(Events.webviewFocus, { viewId: 'v1', vaultId: 'v1' });
    expect(spy).toHaveBeenCalledWith(left.layout.activePane);
  });

  it('follows the address of the file', async () => {
    const { id, s } = await opened();
    place(id, s, { url: 'https://example.org/next' });
    await settle();
    expect(calls.navigate).toHaveBeenCalledWith('v1', 'v1', 'https://example.org/next');
    expect(calls.open).toHaveBeenCalledTimes(1);
  });
});

describe('what the page reports', () => {
  async function opened() {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage());
    await settle();
    calls.setVisible.mockClear();
    return ids[0] as string;
  }
  const view = (id: string) => useViewStates.getState().views[id];

  it('shows the state of the page as text the core sent', async () => {
    const id = await opened();
    mock.emit(Events.webviewState, {
      viewId: 'v1',
      vaultId: 'v1',
      url: 'https://example.com/a',
      title: '<b>x</b>',
      loading: false,
      canGoBack: true,
      canGoForward: false,
    });
    expect(view(id)?.page).toMatchObject({
      url: 'https://example.com/a',
      title: '<b>x</b>',
      canGoBack: true,
      loading: false,
    });
  });

  it('ignores the events of other views and of other vaults', async () => {
    const id = await opened();
    mock.emit(Events.webviewState, {
      viewId: 'v9',
      vaultId: 'v1',
      url: 'https://evil.test/',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
    mock.emit(Events.webviewState, {
      viewId: 'v1',
      vaultId: 'other',
      url: 'https://evil.test/',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
    expect(view(id)?.page.url).toBe('https://example.com/');
  });

  it('keeps what the core refused, a few at a time', async () => {
    const id = await opened();
    mock.emit(Events.webviewBlocked, {
      viewId: 'v1',
      vaultId: 'v1',
      url: 'file:///etc/passwd',
      reason: 'scheme',
      mainFrame: true,
    });
    mock.emit(Events.webviewDownload, {
      viewId: 'v1',
      vaultId: 'v1',
      url: 'https://example.com/a.zip',
    });
    mock.emit(Events.webviewPermission, {
      viewId: 'v1',
      vaultId: 'v1',
      permission: 'camera',
      origin: 'https://example.com',
    });
    mock.emit(Events.webviewNewWindow, {
      viewId: 'v1',
      vaultId: 'v1',
      url: 'https://example.org/',
      opened: true,
      reason: 'other',
    });
    const kinds = view(id)?.notices.map((n) => n.kind);
    expect(kinds).toEqual(['download', 'permission', 'new-window']); // the oldest went
    views.dismissNotice(id, view(id)?.notices[0]?.id as number);
    expect(view(id)?.notices).toHaveLength(2);
  });

  it('steps aside for a load error and a crash, and comes back on reload', async () => {
    const id = await opened();
    mock.emit(Events.webviewLoadError, {
      viewId: 'v1',
      vaultId: 'v1',
      url: 'https://self-signed.test/',
      message: 'bad certificate',
      code: -1202,
      certificate: true,
    });
    await settle();
    expect(view(id)?.loadError).toMatchObject({ certificate: true });
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    views.reload(id);
    await settle();
    expect(view(id)?.loadError).toBeNull();
    expect(calls.reload).toHaveBeenCalledWith('v1', 'v1');
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);

    mock.emit(Events.webviewCrashed, { viewId: 'v1', vaultId: 'v1' });
    await settle();
    expect(view(id)?.crashed).toBe(true);
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
  });

  it('forgets a view the core closed, and opens another when asked', async () => {
    const id = await opened();
    mock.emit(Events.webviewClosed, { viewId: 'v1', vaultId: 'v1', reason: 'vault-locked' });
    expect(view(id)).toMatchObject({ phase: 'closed', reason: 'vault-locked' });
    expect(views.hasView(id)).toBe(false);
    calls.setBounds.mockClear();
    views.update();
    await settle();
    expect(calls.setBounds).not.toHaveBeenCalled(); // nothing is sent to a view that is gone
    views.reopen(id);
    await settle();
    expect(calls.open).toHaveBeenCalledTimes(2);
    expect(view(id)?.phase).toBe('open');
  });

  it('opens again by itself after the data were cleared, once the stage is shown again', async () => {
    const id = await opened();
    mock.emit(Events.webviewClosed, { viewId: 'v1', vaultId: 'v1', reason: 'data-cleared' });
    // the tab shows its stage again (the origin was asked for again, and confirmed)
    place(id, stages[0] as Stage);
    await settle();
    expect(calls.open).toHaveBeenCalledTimes(2);
  });

  it('turns a view the core no longer knows into a closed one', async () => {
    const id = await opened();
    calls.reload.mockRejectedValueOnce(new Error('webview-not-found: no such view'));
    views.back(id);
    views.reload(id);
    await settle();
    expect(view(id)).toMatchObject({ phase: 'closed', reason: 'gone' });
  });

  it('hands the reserved keys back to the application', async () => {
    await opened();
    mock.emit(Events.webviewKey, { viewId: 'v1', vaultId: 'v1', accelerator: 'cmd+w' });
    expect(keys).toEqual(['cmd+w']);
  });
});

describe('closing', () => {
  it('closes the view when its tab is closed', async () => {
    const { layout, ids } = layoutOf('A.webapp', 'B.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage());
    await settle();
    useAppStore.getState().closeTabById(ids[0] as string);
    await settle();
    expect(calls.close).toHaveBeenCalledWith('v1', 'v1');
    expect(useViewStates.getState().views[ids[0] as string]).toBeUndefined();
  });

  it('keeps the view of a tab that only moved to another pane', async () => {
    const { layout, ids } = layoutOf('A.webapp', 'B.webapp');
    useAppStore.setState({ layout });
    const s = stage();
    const detach = place(ids[0] as string, s);
    await settle();
    // the pane re-mounts the stage: detach, then attach to a new element
    detach();
    useAppStore.getState().split('row');
    await settle();
    place(ids[0] as string, stage());
    await settle();
    expect(calls.close).not.toHaveBeenCalled();
    expect(calls.open).toHaveBeenCalledTimes(1);
  });

  it('closes a view that was still opening when its tab was closed', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    let release: (v: { viewId: string; persistentData: boolean }) => void = () => undefined;
    calls.open.mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    place(ids[0] as string, stage());
    await settle();
    useAppStore.getState().closeTabById(ids[0] as string);
    release({ viewId: 'late', persistentData: true });
    await settle();
    expect(calls.close).toHaveBeenCalledWith('v1', 'late');
  });

  it('closes the views of a vault that is left', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage());
    await settle();
    useAppStore.getState().setVault({ id: 'v2', path: '/v2', name: 'W' } as never);
    await settle();
    expect(calls.closeVault).toHaveBeenCalledWith('v1');
    expect(useViewStates.getState().views[ids[0] as string]).toBeUndefined();
    // nothing is sent to a view of the old vault any more
    calls.setBounds.mockClear();
    views.update();
    await settle();
    expect(calls.setBounds).not.toHaveBeenCalled();
  });

  it('closes everything when it stops', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage());
    await settle();
    stop();
    expect(calls.close).toHaveBeenCalledWith('v1', 'v1');
    stop = views.start();
  });
});

describe('the reserved keys', () => {
  it('are sent once, and again only when they change', async () => {
    await views.reserveKeys(['cmd+w', 'cmd+p']);
    await views.reserveKeys(['cmd+w', 'cmd+p']);
    expect(calls.reserveKeys).toHaveBeenCalledTimes(1);
    expect(calls.reserveKeys).toHaveBeenCalledWith(['cmd+w', 'cmd+p']);
    await views.reserveKeys(['cmd+w']);
    expect(calls.reserveKeys).toHaveBeenCalledTimes(2);
  });

  it('survive one combination the core refuses', async () => {
    calls.reserveKeys.mockImplementation((list: string[]) =>
      list.includes('cmd+bad')
        ? Promise.reject(new Error('webview-invalid-accelerator: unknown key'))
        : Promise.resolve(),
    );
    await views.reserveKeys(['cmd+w', 'cmd+bad', 'cmd+p']);
    expect(calls.reserveKeys).toHaveBeenLastCalledWith(['cmd+w', 'cmd+p']);
  });
});

describe('where there is no embedded browser', () => {
  it('starts nothing and reserves nothing', async () => {
    const off = new NativeViews({ api: calls, embedded: () => false });
    const stopOff = off.start();
    await off.reserveKeys(['cmd+w']);
    expect(calls.reserveKeys).not.toHaveBeenCalled();
    stopOff();
  });
});

describe('a view that finishes opening after its stage went away', () => {
  it('is hidden: the core made it visible, and nothing else would say otherwise', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    let release: (v: { viewId: string; persistentData: boolean }) => void = () => undefined;
    calls.open.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const detach = place(ids[0] as string, stage());
    await settle();
    detach(); // the user went to another tab while the view was being made
    await settle();
    release({ viewId: 'late', persistentData: true });
    await settle();
    expect(calls.setVisible).toHaveBeenCalledWith('v1', 'late', false);
    expect(calls.close).not.toHaveBeenCalled();
    // and it comes back when the tab does
    place(ids[0] as string, stages[0] as Stage);
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'late', true);
    expect(calls.open).toHaveBeenCalledTimes(1);
  });
});

describe('what a view says before Open answers', () => {
  it('is kept for the view that was being opened, in order', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    calls.open.mockImplementationOnce(() => {
      // the core registered the view before the call returned
      mock.emit(Events.webviewLoadError, {
        viewId: 'early',
        vaultId: 'v1',
        url: 'https://example.com/',
        message: 'certificate refused',
        code: -1202,
        certificate: true,
      });
      return Promise.resolve({ viewId: 'early', persistentData: true });
    });
    place(ids[0] as string, stage());
    await settle();
    const st = useViewStates.getState().views[ids[0] as string];
    expect(st?.phase).toBe('open');
    expect(st?.loadError).toMatchObject({ certificate: true });
    // the card is over the stage, so the view steps aside
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'early', false);
  });

  it('is not kept for a view that is not being opened, nor for another vault', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    mock.emit(Events.webviewLoadError, {
      viewId: 'stray',
      vaultId: 'v1',
      url: 'x',
      message: '',
      code: 1,
      certificate: false,
    });
    calls.open.mockImplementationOnce(() => {
      mock.emit(Events.webviewCrashed, { viewId: 'other', vaultId: 'v2' });
      mock.emit(Events.webviewCrashed, { viewId: 'unrelated', vaultId: 'v1' });
      return Promise.resolve({ viewId: 'mine', persistentData: true });
    });
    place(ids[0] as string, stage());
    await settle();
    const st = useViewStates.getState().views[ids[0] as string];
    expect(st?.loadError).toBeNull();
    expect(st?.crashed).toBe(false);
  });
});

describe('a drag that is not told to end', () => {
  const over = (): void => {
    document.dispatchEvent(new Event('dragover'));
  };

  it('stops hiding the views once no dragover comes', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage());
    await settle();
    document.dispatchEvent(new Event('dragenter'));
    await settle();
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    // a file dropped where nothing takes it: only a dragleave inside the window, if that
    await tick(450);
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);
  });

  it('keeps hiding them while dragover comes', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage());
    await settle();
    document.dispatchEvent(new Event('dragenter'));
    for (let i = 0; i < 8; i++) {
      over();
      await tick(60);
    }
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    expect(calls.setVisible).toHaveBeenCalledTimes(1);
  });

  it('ends at a dragleave that names no destination, unless a dragover follows at once', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage());
    await settle();
    const leave = (): void => {
      const e = new Event('dragleave');
      Object.assign(e, { clientX: 300, clientY: 300, relatedTarget: null });
      document.dispatchEvent(e);
    };
    document.dispatchEvent(new Event('dragenter'));
    leave();
    over(); // between elements: the drag goes on
    await tick(200);
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', false);
    leave(); // out of everything
    await tick(220);
    expect(calls.setVisible).toHaveBeenLastCalledWith('v1', 'v1', true);
  });
});

describe('a view that ended with the lock of its vault', () => {
  it('opens again when the vault is unlocked, and not for another reason', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    place(ids[0] as string, stage());
    await settle();
    mock.emit(Events.webviewClosed, { viewId: 'v1', vaultId: 'v1', reason: 'vault-locked' });
    views.resumeAfterUnlock(ids[0] as string);
    await settle();
    expect(calls.open).toHaveBeenCalledTimes(2);
    mock.emit(Events.webviewClosed, { viewId: 'v2', vaultId: 'v1', reason: 'quit' });
    views.resumeAfterUnlock(ids[0] as string);
    await settle();
    expect(calls.open).toHaveBeenCalledTimes(2);
  });

  it('opens again after the profile turned the browser off and on: the stage is shown again', async () => {
    const { layout, ids } = layoutOf('A.webapp');
    useAppStore.setState({ layout });
    const detach = place(ids[0] as string, stage());
    await settle();
    mock.emit(Events.webviewClosed, { viewId: 'v1', vaultId: 'v1', reason: 'disabled' });
    detach(); // the card of the card-only tab replaced the stage
    await settle();
    place(ids[0] as string, stages[0] as Stage);
    await settle();
    expect(calls.open).toHaveBeenCalledTimes(2);
  });
});

describe('the only caller of the core', () => {
  it('clears the data through the manager', async () => {
    await views.clearData('v1');
    expect(calls.clearData).toHaveBeenCalledWith('v1');
  });
});
