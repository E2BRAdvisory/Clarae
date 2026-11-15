// In-memory WebViewAPI for Vitest and Playwright runs on the Wails mock (M18, track E): a stand-in
// for the native views of the desktop, with the rules of the core (apps/desktop/internal/webview)
// that the UI depends on, written independently of the UI's own code so that a divergence shows.
//
// Nothing is rendered: a "view" is a record. A test (or an e2e spec, through `window.__mock.webview`)
// reads what the UI asked for (`views`, `log`, `reserved`) and makes the core speak with `emit`.
import { Events } from '../../app/events';
import type { ViewBounds, WebViewOpened, WebViewStatus } from '../../app/api';
import { checkWebappUrl } from '../../webapp/model';

export interface MockView {
  id: string;
  vaultId: string;
  /** The address of the page now. */
  url: string;
  bounds: ViewBounds;
  visible: boolean;
  /** Took the keyboard focus (Focus), until another does. */
  focused: boolean;
  /** Addresses visited, and where in them the view is. */
  history: string[];
  index: number;
}

export interface MockWebView {
  /** The device has a driver (what the capability `embeddedBrowser` says): false is a Windows or Linux desktop. */
  available: boolean;
  persistentData: boolean;
  maxViews: number;
  /** The open views by id. */
  views: Map<string, MockView>;
  /** Every call in order: "Open vault-id https://…", "SetVisible view-1 false", … */
  log: string[];
  /** The list of the last ReserveKeys. */
  reserved: string[];
  /** Vault ids whose data were cleared. */
  cleared: string[];
  /** The next Open fails with this error message (once). */
  failNextOpen: string;
  /**
   * Events the core sends about the next view before it answers Open (it knows the view before the
   * call returns): `[event name, payload without viewId and vaultId]`. Used once.
   */
  eventsBeforeOpenReply: [string, Record<string, unknown>][];
  /** Closes the views of a vault as the core does when it is closed or locked (or the flag goes off): with the event. */
  endViews: (vaultId: string | null, reason: 'vault-closed' | 'vault-locked' | 'disabled') => void;
  /** Emits an event of the core (set by installWailsMock). */
  emit: (name: string, payload: unknown) => void;
}

export const MAX_MOCK_ACCELERATORS = 128;

const MODIFIERS = ['ctrl', 'alt', 'shift', 'cmd'];
const NAMED = new Set([
  'enter',
  'escape',
  'tab',
  'space',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'plus',
  ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
]);
const EDITING = new Set(['cmd+c', 'cmd+v', 'cmd+x', 'cmd+a', 'cmd+z', 'shift+cmd+z']);

/** The grammar of webview.ParseAccelerator: the reason it is refused, or '' when it is fine. */
export function acceleratorProblem(a: string): string {
  if (a === '' || a.length > 32) return 'empty or too long';
  if (a !== a.toLowerCase()) return 'not lower case';
  const parts = a.split('+');
  const key = parts[parts.length - 1] as string;
  const mods = parts.slice(0, -1);
  let last = -1;
  for (const m of mods) {
    const i = MODIFIERS.indexOf(m);
    if (i < 0) return `unknown modifier ${m}`;
    if (i <= last) return 'modifiers out of order or repeated';
    last = i;
  }
  if (!(NAMED.has(key) || (key.length === 1 && key > ' ' && key < '\u007f' && key !== '+')))
    return `unknown key ${key}`;
  const fkey = /^f\d/.test(key);
  if (!mods.includes('ctrl') && !mods.includes('cmd') && !fkey) return 'ctrl or cmd is required';
  if (EDITING.has(a)) return `${a} is text editing`;
  return '';
}

const fail = (code: string, text: string): Promise<never> =>
  Promise.reject(new Error(`${code}: ${text}`));

const validBounds = (b: ViewBounds): boolean =>
  [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
  b.width > 0 &&
  b.height > 0 &&
  b.x + b.width <= 1.000001 &&
  b.y + b.height <= 1.000001;

export function createWebViewMock(deps: {
  emit: (name: string, payload: unknown) => void;
  /** Throws when the vault is not open. */
  vaultOpen: (vaultId: string) => boolean;
  /** features.web_viewer of the profile in force. */
  enabled: () => boolean;
  seed?: Partial<Pick<MockWebView, 'available' | 'persistentData' | 'maxViews'>>;
}) {
  const state: MockWebView = {
    available: deps.seed?.available ?? true,
    persistentData: deps.seed?.persistentData ?? true,
    maxViews: deps.seed?.maxViews ?? 32,
    views: new Map(),
    log: [],
    reserved: [],
    cleared: [],
    failNextOpen: '',
    eventsBeforeOpenReply: [],
    endViews: (vaultId, reason) => {
      for (const [id, v] of [...state.views])
        if (vaultId === null || v.vaultId === vaultId) {
          state.views.delete(id);
          state.emit(Events.webviewClosed, { viewId: id, vaultId: v.vaultId, reason });
        }
    },
    emit: deps.emit,
  };
  let n = 0;

  const guard = (vaultId: string): Promise<void> | null => {
    if (!state.available)
      return fail('webview-unavailable', 'the embedded browser is not available on this device');
    if (!deps.vaultOpen(vaultId)) return fail('vault-not-open', 'the vault is not open');
    return null;
  };
  const view = (vaultId: string, id: string): MockView | null => {
    const v = state.views.get(id);
    return v && v.vaultId === vaultId ? v : null;
  };
  const stateEvent = (v: MockView, loading: boolean): void =>
    state.emit(Events.webviewState, {
      viewId: v.id,
      vaultId: v.vaultId,
      url: v.url,
      title: 'Mock page',
      loading,
      canGoBack: v.index > 0,
      canGoForward: v.index < v.history.length - 1,
    });
  /** What a page does after a request: loading, then loaded (the UI hears both). */
  const load = (v: MockView): void => {
    stateEvent(v, true);
    setTimeout(() => state.views.has(v.id) && stateEvent(v, false), 0);
  };
  const urlProblem = (url: string): Promise<never> | null => {
    const c = checkWebappUrl(url);
    return c.ok ? null : fail('webview-invalid-url', `${c.reason}: the address cannot be opened`);
  };
  const call = <T>(text: string, f: () => Promise<T> | T): Promise<T> => {
    state.log.push(text);
    return Promise.resolve().then(f);
  };

  const api = {
    Status: (): Promise<WebViewStatus> =>
      Promise.resolve({
        available: state.available,
        enabled: deps.enabled(),
        persistentData: state.persistentData,
        maxViewsPerVault: state.maxViews,
      }),
    Open: (vaultId: string, url: string, bounds: ViewBounds): Promise<WebViewOpened> =>
      call(`Open ${vaultId} ${url}`, async () => {
        await guard(vaultId);
        if (!deps.enabled())
          return fail('webview-disabled', 'applications are turned off by the configuration');
        if (state.failNextOpen) {
          const message = state.failNextOpen;
          state.failNextOpen = '';
          throw new Error(message);
        }
        await urlProblem(url);
        if (!validBounds(bounds))
          return fail(
            'webview-invalid-bounds',
            'the bounds must be fractions of the window between 0 and 1',
          );
        if ([...state.views.values()].filter((v) => v.vaultId === vaultId).length >= state.maxViews)
          return fail('webview-limit', 'too many applications are open');
        const v: MockView = {
          id: `view-${++n}`,
          vaultId,
          url,
          bounds: { ...bounds },
          visible: true,
          focused: false,
          history: [url],
          index: 0,
        };
        state.views.set(v.id, v);
        load(v);
        for (const [name, payload] of state.eventsBeforeOpenReply.splice(0))
          state.emit(name, { viewId: v.id, vaultId, ...payload });
        return { viewId: v.id, persistentData: state.persistentData };
      }),
    SetBounds: (vaultId: string, id: string, bounds: ViewBounds): Promise<void> =>
      call(`SetBounds ${id} ${JSON.stringify(bounds)}`, async () => {
        await guard(vaultId);
        const v = view(vaultId, id);
        if (!v) return fail('webview-not-found', 'no such view');
        if (!validBounds(bounds))
          return fail(
            'webview-invalid-bounds',
            'the bounds must be fractions of the window between 0 and 1',
          );
        v.bounds = { ...bounds };
      }),
    SetVisible: (vaultId: string, id: string, visible: boolean): Promise<void> =>
      call(`SetVisible ${id} ${visible}`, async () => {
        await guard(vaultId);
        const v = view(vaultId, id);
        if (!v) return fail('webview-not-found', 'no such view');
        v.visible = visible;
        if (!visible) v.focused = false;
      }),
    Navigate: (vaultId: string, id: string, url: string): Promise<void> =>
      call(`Navigate ${id} ${url}`, async () => {
        await guard(vaultId);
        const v = view(vaultId, id);
        if (!v) return fail('webview-not-found', 'no such view');
        await urlProblem(url);
        v.history = [...v.history.slice(0, v.index + 1), url];
        v.index++;
        v.url = url;
        load(v);
      }),
    Back: (vaultId: string, id: string): Promise<void> =>
      call(`Back ${id}`, async () => {
        await guard(vaultId);
        const v = view(vaultId, id);
        if (!v) return fail('webview-not-found', 'no such view');
        if (v.index > 0) {
          v.url = v.history[--v.index] as string;
          load(v);
        }
      }),
    Forward: (vaultId: string, id: string): Promise<void> =>
      call(`Forward ${id}`, async () => {
        await guard(vaultId);
        const v = view(vaultId, id);
        if (!v) return fail('webview-not-found', 'no such view');
        if (v.index < v.history.length - 1) {
          v.url = v.history[++v.index] as string;
          load(v);
        }
      }),
    Reload: (vaultId: string, id: string): Promise<void> =>
      call(`Reload ${id}`, async () => {
        await guard(vaultId);
        const v = view(vaultId, id);
        if (!v) return fail('webview-not-found', 'no such view');
        load(v);
      }),
    Focus: (vaultId: string, id: string): Promise<void> =>
      call(`Focus ${id}`, async () => {
        await guard(vaultId);
        const v = view(vaultId, id);
        if (!v) return fail('webview-not-found', 'no such view');
        for (const o of state.views.values()) o.focused = o === v;
      }),
    Close: (vaultId: string, id: string): Promise<void> =>
      call(`Close ${id}`, async () => {
        await guard(vaultId);
        if (!view(vaultId, id)) return fail('webview-not-found', 'no such view');
        state.views.delete(id);
      }),
    CloseVault: (vaultId: string): Promise<void> =>
      call(`CloseVault ${vaultId}`, async () => {
        // like every call that names a vault: a vault that is not open is refused
        await guard(vaultId);
        for (const [id, v] of state.views) if (v.vaultId === vaultId) state.views.delete(id);
      }),
    ReserveKeys: (accelerators: string[]): Promise<void> =>
      call(`ReserveKeys ${accelerators.length}`, () => {
        if (!state.available)
          return fail(
            'webview-unavailable',
            'the embedded browser is not available on this device',
          );
        if (accelerators.length > MAX_MOCK_ACCELERATORS)
          return fail('webview-invalid-accelerator', 'too many accelerators');
        for (const a of accelerators) {
          const why = acceleratorProblem(a);
          if (why) return fail('webview-invalid-accelerator', why);
        }
        state.reserved = [...accelerators];
      }),
    ClearData: (vaultId: string): Promise<void> =>
      call(`ClearData ${vaultId}`, async () => {
        await guard(vaultId);
        for (const [id, v] of [...state.views])
          if (v.vaultId === vaultId) {
            state.views.delete(id);
            state.emit(Events.webviewClosed, { viewId: id, vaultId, reason: 'data-cleared' });
          }
        state.cleared.push(vaultId);
      }),
  };
  return { state, api };
}
