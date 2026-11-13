import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Events } from '@clarae/workbench/events';
import {
  UPLOAD_CHUNK,
  UPLOAD_PATH,
  UPLOAD_THRESHOLD,
  installDropGuard,
  installWailsHost,
  type WailsRuntime,
} from './wailsHost';

interface Rig {
  rt: WailsRuntime;
  /** Every Call.ByName(name, ...args). */
  calls: { name: string; args: unknown[] }[];
  /** What a binding call answers (set per test). */
  answer: (service: string, method: string, args: unknown[]) => Promise<unknown>;
  /** Delivers an event the way the runtime does. */
  emit(name: string, data?: unknown): void;
  listeners(name: string): number;
  fn: Record<string, ReturnType<typeof vi.fn>>;
}

const METHODS = { VaultAPI: ['OpenVault', 'WriteNote'], SettingsAPI: ['Capabilities'] };

function rig(methods: unknown = METHODS): Rig {
  const calls: Rig['calls'] = [];
  const subs = new Map<string, Set<(e: { data: unknown }) => void>>();
  const fn = {
    open: vi.fn(() => Promise.resolve()),
    quit: vi.fn(() => Promise.resolve()),
    show: vi.fn(() => Promise.resolve()),
    full: vi.fn(() => Promise.resolve()),
    unfull: vi.fn(() => Promise.resolve()),
    isFull: vi.fn(() => Promise.resolve(true)),
    emit: vi.fn(() => Promise.resolve()),
  };
  const r: Rig = {
    calls,
    answer: () => Promise.resolve(null),
    emit: (name, data) => subs.get(name)?.forEach((cb) => cb({ data: data ?? null })),
    listeners: (name) => subs.get(name)?.size ?? 0,
    fn,
    rt: {
      Call: {
        ByName: (name, ...args) => {
          calls.push({ name, args });
          if (name === 'main.CoreBridge.Methods') return Promise.resolve(methods);
          if (name === 'main.CoreBridge.DomReady') return Promise.resolve();
          const [service, method, a] = args as [string, string, unknown[]];
          return r.answer(service, method, a);
        },
      },
      Events: {
        On: (name, cb) => {
          const set = subs.get(name) ?? new Set();
          subs.set(name, set);
          set.add(cb);
          return () => set.delete(cb);
        },
        Off: (...names) => names.forEach((n) => subs.delete(n)),
        Emit: fn.emit,
      },
      Browser: { OpenURL: fn.open },
      Application: { Quit: fn.quit },
      Window: {
        Show: fn.show,
        Fullscreen: fn.full,
        UnFullscreen: fn.unfull,
        IsFullscreen: fn.isFull,
      },
    },
  };
  return r;
}

type Binding = (...args: unknown[]) => Promise<unknown>;
const globals = () =>
  window as unknown as {
    go?: { app: Record<string, Record<string, Binding>> };
    runtime?: Record<string, (...args: never[]) => unknown>;
  };
const runtime = () => globals().runtime as Record<string, (...args: unknown[]) => unknown>;

let off: (() => void) | undefined;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  off?.();
  off = undefined;
  delete globals().go;
  delete globals().runtime;
  vi.restoreAllMocks();
});

async function install(r: Rig): Promise<void> {
  off = await installWailsHost({ runtime: r.rt });
}

describe('window.go.app', () => {
  it('has one function per method the core reports', async () => {
    const r = rig();
    await install(r);
    const app = globals().go?.app;
    expect(Object.keys(app ?? {}).sort()).toEqual(['SettingsAPI', 'VaultAPI']);
    expect(Object.keys(app?.['VaultAPI'] ?? {}).sort()).toEqual(['OpenVault', 'WriteNote']);
    expect(r.calls.map((c) => c.name)).toEqual(['main.CoreBridge.Methods']);
  });

  it('calls the bridge by name with the service, the method and the arguments as an array', async () => {
    const r = rig();
    r.answer = () => Promise.resolve({ id: 'v1' });
    await install(r);
    const res = await globals().go?.app['VaultAPI']?.['OpenVault']?.('/tmp/v', 3, null);
    expect(res).toEqual({ id: 'v1' });
    expect(r.calls.at(-1)).toEqual({
      name: 'main.CoreBridge.Call',
      args: ['VaultAPI', 'OpenVault', ['/tmp/v', 3, null]],
    });
    await globals().go?.app['SettingsAPI']?.['Capabilities']?.();
    expect(r.calls.at(-1)?.args).toEqual(['SettingsAPI', 'Capabilities', []]);
  });

  it('rejects with the message string, so errorCode() finds the code', async () => {
    const r = rig();
    r.answer = () => Promise.reject(new Error('conflict: file changed on disk'));
    await install(r);
    const err: unknown = await globals()
      .go?.app['VaultAPI']?.['WriteNote']?.('id', 'a.md', 'x', 'h')
      .catch((e: unknown) => e);
    expect(err).toBe('conflict: file changed on disk');
    expect(typeof err).toBe('string');
  });

  it('rejects with the text of whatever else the runtime throws', async () => {
    const r = rig();
    r.answer = () => Promise.reject('plain text'); // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
    await install(r);
    await expect(globals().go?.app['VaultAPI']?.['OpenVault']?.()).rejects.toBe('plain text');
    r.answer = () => Promise.reject(42); // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
    await expect(globals().go?.app['VaultAPI']?.['OpenVault']?.()).rejects.toBe('42');
  });

  it('fails to install when the core reports no services', async () => {
    await expect(installWailsHost({ runtime: rig(null).rt })).rejects.toThrow(/no services/);
    expect(globals().go).toBeUndefined();
  });

  it('fails to install when the bridge cannot be reached', async () => {
    const r = rig();
    r.rt.Call.ByName = () => Promise.reject(new Error('down'));
    await expect(installWailsHost({ runtime: r.rt })).rejects.toThrow('down');
  });
});

describe('window.runtime events', () => {
  it('delivers the payload of the event, not the runtime event object', async () => {
    const r = rig();
    await install(r);
    const cb = vi.fn();
    runtime()['EventsOnMultiple']?.(Events.syncStatus, cb, -1);
    r.emit(Events.syncStatus, { phase: 'idle' });
    r.emit(Events.syncStatus, { phase: 'busy' });
    expect(cb.mock.calls).toEqual([[{ phase: 'idle' }], [{ phase: 'busy' }]]);
  });

  it('returns the unsubscribe function', async () => {
    const r = rig();
    await install(r);
    const cb = vi.fn();
    const unsubscribe = runtime()['EventsOnMultiple']?.(Events.syncStatus, cb, -1) as () => void;
    unsubscribe();
    unsubscribe(); // twice: harmless
    r.emit(Events.syncStatus, 1);
    expect(cb).not.toHaveBeenCalled();
    expect(r.listeners(Events.syncStatus)).toBe(0);
  });

  it('stops after max deliveries', async () => {
    const r = rig();
    await install(r);
    const cb = vi.fn();
    runtime()['EventsOnMultiple']?.(Events.syncStatus, cb, 2);
    for (let i = 0; i < 4; i++) r.emit(Events.syncStatus, i);
    expect(cb.mock.calls).toEqual([[0], [1]]);
    expect(r.listeners(Events.syncStatus)).toBe(0);
  });

  it('delivers an event without data as null', async () => {
    const r = rig();
    await install(r);
    const cb = vi.fn();
    runtime()['EventsOnMultiple']?.(Events.appBeforeClose, cb, -1);
    r.emit(Events.appBeforeClose);
    expect(cb).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('EventsOff drops every listener of the names', async () => {
    const r = rig();
    await install(r);
    const cb = vi.fn();
    runtime()['EventsOnMultiple']?.(Events.syncStatus, cb, -1);
    runtime()['EventsOnMultiple']?.(Events.syncStatus, cb, -1);
    runtime()['EventsOnMultiple']?.(Events.indexProgress, cb, -1);
    runtime()['EventsOnMultiple']?.(Events.authState, cb, -1);
    runtime()['EventsOff']?.(Events.syncStatus, Events.indexProgress);
    r.emit(Events.syncStatus, 1);
    r.emit(Events.indexProgress, 1);
    expect(cb).not.toHaveBeenCalled();
    expect(r.listeners(Events.authState)).toBe(1);
  });

  it('EventsEmit sends the first payload and survives a failure', async () => {
    const r = rig();
    await install(r);
    runtime()['EventsEmit']?.('custom:event', { a: 1 }, 'ignored');
    expect(r.fn['emit']).toHaveBeenCalledWith('custom:event', { a: 1 });
    r.fn['emit']?.mockRejectedValueOnce(new Error('boom'));
    runtime()['EventsEmit']?.('custom:event');
    await Promise.resolve();
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('EventsEmit failed: boom'));
  });
});

describe('window.runtime window and browser', () => {
  it('maps each function to the runtime', async () => {
    const r = rig();
    await install(r);
    runtime()['BrowserOpenURL']?.('https://example.com/');
    runtime()['WindowShow']?.();
    runtime()['Quit']?.();
    runtime()['WindowFullscreen']?.();
    runtime()['WindowUnfullscreen']?.();
    expect(r.fn['open']).toHaveBeenCalledWith('https://example.com/');
    expect(r.fn['show']).toHaveBeenCalledOnce();
    expect(r.fn['quit']).toHaveBeenCalledOnce();
    expect(r.fn['full']).toHaveBeenCalledOnce();
    expect(r.fn['unfull']).toHaveBeenCalledOnce();
    await expect(runtime()['WindowIsFullscreen']?.()).resolves.toBe(true);
  });

  it('exposes exactly the functions the UI uses', async () => {
    await install(rig());
    expect(Object.keys(runtime()).sort()).toEqual([
      'BrowserOpenURL',
      'EventsEmit',
      'EventsOff',
      'EventsOnMultiple',
      'Quit',
      'WindowFullscreen',
      'WindowIsFullscreen',
      'WindowShow',
      'WindowUnfullscreen',
    ]);
  });

  it('logs a failed call instead of leaving the rejection unhandled', async () => {
    const r = rig();
    r.fn['quit']?.mockRejectedValueOnce(new Error('no window'));
    await install(r);
    runtime()['Quit']?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Quit failed: no window'));
  });

  it('WindowIsFullscreen rejects when the runtime does (the UI catches it)', async () => {
    const r = rig();
    r.fn['isFull']?.mockRejectedValueOnce(new Error('x'));
    await install(r);
    await expect(runtime()['WindowIsFullscreen']?.()).rejects.toThrow('x');
  });
});

describe('ready signal', () => {
  const domReady = (r: Rig) => r.calls.filter((c) => c.name === 'main.CoreBridge.DomReady').length;

  it('is not sent before the workbench listens for open requests', async () => {
    const r = rig();
    await install(r);
    runtime()['EventsOnMultiple']?.(Events.syncStatus, vi.fn(), -1);
    expect(domReady(r)).toBe(0);
  });

  it('goes once, at the first subscription to app:open-request, with the listener already in place', async () => {
    const r = rig();
    await install(r);
    runtime()['EventsOnMultiple']?.(Events.appOpenRequest, vi.fn(), -1);
    expect(r.listeners(Events.appOpenRequest)).toBe(1);
    expect(domReady(r)).toBe(1);
    // React StrictMode: unsubscribe and subscribe again; a second consumer too.
    const again = runtime()['EventsOnMultiple']?.(Events.appOpenRequest, vi.fn(), -1) as () => void;
    again();
    runtime()['EventsOnMultiple']?.(Events.appOpenRequest, vi.fn(), -1);
    expect(domReady(r)).toBe(1);
  });

  it('is sent again by the new shim after a reload, and once only per page', async () => {
    const first = rig();
    await install(first);
    runtime()['EventsOnMultiple']?.(Events.appOpenRequest, vi.fn(), -1);
    off?.();
    // location.reload(): a new page runs the shim again.
    const second = rig();
    await install(second);
    const cb = vi.fn();
    runtime()['EventsOnMultiple']?.(Events.appOpenRequest, cb, -1);
    runtime()['EventsOnMultiple']?.(Events.appOpenRequest, vi.fn(), -1);
    expect(domReady(first)).toBe(1);
    expect(domReady(second)).toBe(1);
    // A link delivered after the signal reaches the new page's listener exactly once.
    second.emit(Events.appOpenRequest, { vault: 'v' });
    expect(cb).toHaveBeenCalledOnce();
  });

  it('is retried at the next subscription when it failed', async () => {
    const r = rig();
    const base = r.rt.Call.ByName.bind(r.rt.Call);
    let fail = true;
    r.rt.Call.ByName = (name, ...args) => {
      if (name === 'main.CoreBridge.DomReady' && fail) {
        r.calls.push({ name, args });
        return Promise.reject(new Error('not yet'));
      }
      return base(name, ...args);
    };
    await install(r);
    runtime()['EventsOnMultiple']?.(Events.appOpenRequest, vi.fn(), -1);
    await Promise.resolve();
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ready signal failed'));
    fail = false;
    runtime()['EventsOnMultiple']?.(Events.appOpenRequest, vi.fn(), -1);
    expect(domReady(r)).toBe(2);
    runtime()['EventsOnMultiple']?.(Events.appOpenRequest, vi.fn(), -1);
    expect(domReady(r)).toBe(2);
  });
});

describe('drop guard', () => {
  /** An event with a recording DataTransfer: WebKit ignores dropEffect on a constructed one. */
  function drag(type: string, types: string[]) {
    const writes: string[] = [];
    let value = 'none';
    const dt = {
      types,
      get dropEffect() {
        return value;
      },
      set dropEffect(v: string) {
        value = v;
        writes.push(v);
      },
    };
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    return { ev, dt, writes };
  }

  let stop: () => void;
  let page: HTMLElement;
  beforeEach(() => {
    page = document.createElement('div');
    document.body.appendChild(page);
  });
  afterEach(() => {
    stop?.();
    page.remove();
  });

  it('copies and prevents file drags in the bubble phase of window, after the page and the runtime', () => {
    stop = installDropGuard();
    // What the v3 runtime does on documentElement, after the page's own handlers.
    const runtimeHandler = (e: Event): void => {
      (e as DragEvent).dataTransfer!.dropEffect = 'none';
    };
    for (const type of ['dragenter', 'dragover']) {
      document.documentElement.addEventListener(type, runtimeHandler);
      const { ev, dt } = drag(type, ['Files']);
      page.dispatchEvent(ev);
      document.documentElement.removeEventListener(type, runtimeHandler);
      expect(dt.dropEffect).toBe('copy');
      expect(ev.defaultPrevented).toBe(true);
    }
  });

  it('lets the page see a drop, then prevents navigation, without stopping propagation', () => {
    stop = installDropGuard();
    const seen = vi.fn();
    page.addEventListener('drop', seen);
    const { ev } = drag('drop', ['Files']);
    page.dispatchEvent(ev);
    expect(seen).toHaveBeenCalledOnce();
    expect(ev.defaultPrevented).toBe(true);
  });

  it('does not stop propagation of the guarded events', () => {
    stop = installDropGuard();
    const late = vi.fn();
    document.documentElement.addEventListener('dragover', late);
    page.dispatchEvent(drag('dragover', ['Files']).ev);
    expect(late).toHaveBeenCalledOnce();
    document.documentElement.removeEventListener('dragover', late);
  });

  it('ignores drags that carry no files (text, internal drags of the file tree)', () => {
    stop = installDropGuard();
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const { ev, writes } = drag(type, ['text/plain']);
      page.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(writes).toEqual([]);
    }
  });

  it('is installed by installWailsHost and removed by the returned function', async () => {
    const r = rig();
    off = await installWailsHost({ runtime: r.rt });
    let a = drag('dragover', ['Files']);
    page.dispatchEvent(a.ev);
    expect(a.ev.defaultPrevented).toBe(true);
    off();
    off = undefined;
    a = drag('dragover', ['Files']);
    page.dispatchEvent(a.ev);
    expect(a.ev.defaultPrevented).toBe(false);
  });

  it('installs on the given target, not on the global window', async () => {
    const other = new EventTarget() as unknown as Window;
    const r = rig();
    off = await installWailsHost({ runtime: r.rt, target: other });
    expect((other as unknown as { go?: unknown }).go).toBeDefined();
    expect(globals().go).toBeUndefined();
    const a = drag('dragover', ['Files']);
    page.dispatchEvent(a.ev);
    expect(a.ev.defaultPrevented).toBe(false);
  });
});

describe('calls larger than the transport of Wails (B-W4b)', () => {
  interface Sent {
    url: string;
    offset: number;
    bytes: Uint8Array;
  }

  /** A core that takes an upload: BeginUpload hands out an id, the chunks come through `fetch`. */
  function uploadRig(opts: { beginError?: string; chunkStatus?: (n: number) => number } = {}) {
    const r = rig();
    const base = r.rt.Call.ByName.bind(r.rt.Call);
    const sent: Sent[] = [];
    let n = 0;
    r.rt.Call.ByName = (name, ...args) => {
      if (name === 'main.CoreBridge.BeginUpload') {
        r.calls.push({ name, args });
        return opts.beginError
          ? Promise.reject(new Error(opts.beginError))
          : Promise.resolve('up1');
      }
      if (name === 'main.CoreBridge.AbortUpload') {
        r.calls.push({ name, args });
        return Promise.resolve();
      }
      if (name === 'main.CoreBridge.CallUploaded') {
        r.calls.push({ name, args });
        const [service, method] = args as [string, string];
        return r.answer(service, method, []);
      }
      return base(name, ...args);
    };
    const send = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const status = opts.chunkStatus?.(n++) ?? 204;
      sent.push({
        url,
        offset: Number(new URL(url, 'http://x').searchParams.get('offset')),
        bytes: init?.body as Uint8Array,
      });
      return Promise.resolve(
        new Response(status === 204 ? null : 'chunk out of order', { status }),
      );
    });
    return { r, sent, send: send as unknown as typeof fetch };
  }

  const names = (r: Rig) => r.calls.map((c) => c.name.replace('main.CoreBridge.', ''));

  async function installWith(u: ReturnType<typeof uploadRig>): Promise<Binding> {
    off = await installWailsHost({ runtime: u.r.rt, fetch: u.send });
    return globals().go?.app['VaultAPI']?.['WriteNote'] as Binding;
  }

  it('sends the arguments in ordered chunks and runs the call on the upload', async () => {
    const u = uploadRig();
    u.r.answer = () => Promise.resolve({ path: '/tmp/out.html' });
    const write = await installWith(u);
    const html = 'x'.repeat(UPLOAD_THRESHOLD + 1000);

    const res = await write('vault', 'name', html);

    expect(res).toEqual({ path: '/tmp/out.html' });
    expect(names(u.r)).toEqual(['Methods', 'BeginUpload', 'CallUploaded']);
    const total = u.r.calls[1]?.args[0] as number;
    expect(u.r.calls[2]?.args).toEqual(['VaultAPI', 'WriteNote', 'up1']);

    // The chunks are the JSON of the arguments, whole and in order, none larger than UPLOAD_CHUNK.
    expect(u.sent.map((c) => c.offset)).toEqual(
      Array.from({ length: Math.ceil(total / UPLOAD_CHUNK) }, (_, i) => i * UPLOAD_CHUNK),
    );
    expect(u.sent.every((c) => c.url.startsWith(`${UPLOAD_PATH}up1?offset=`))).toBe(true);
    expect(u.sent.every((c) => c.bytes.length <= UPLOAD_CHUNK)).toBe(true);
    const whole = new Uint8Array(total);
    for (const c of u.sent) whole.set(c.bytes, c.offset);
    const args = JSON.parse(new TextDecoder().decode(whole)) as unknown[];
    expect(args).toEqual(['vault', 'name', html]);
  });

  it('counts bytes, not characters: a document of 3-byte characters', async () => {
    const u = uploadRig();
    const write = await installWith(u);
    // 11 Mi characters is below the threshold in characters and above it in bytes.
    const text = '€'.repeat(11 * 1024 * 1024);
    expect(text.length).toBeLessThan(UPLOAD_THRESHOLD);
    await write(text);
    expect(names(u.r)).toEqual(['Methods', 'BeginUpload', 'CallUploaded']);
    const total = u.r.calls[1]?.args[0] as number;
    expect(total).toBe(new TextEncoder().encode(JSON.stringify([text])).length);
    expect(total).toBeGreaterThan(UPLOAD_THRESHOLD);
  });

  it('finds the large string inside an object argument', async () => {
    const u = uploadRig();
    const write = await installWith(u);
    await write({ images: { a: ['y'.repeat(UPLOAD_THRESHOLD + 1)] } });
    expect(names(u.r)).toContain('CallUploaded');
  });

  it('keeps every call that fits on the usual path', async () => {
    const u = uploadRig();
    const write = await installWith(u);
    await write('small', 1, null);
    // Past the measuring point but within what Wails takes: measured, then sent as before.
    await write('z'.repeat(5 * 1024 * 1024));
    expect(names(u.r)).toEqual(['Methods', 'Call', 'Call']);
    expect(u.send).not.toHaveBeenCalled();
  });

  it('aborts the upload and rejects with the text when a chunk is refused', async () => {
    const u = uploadRig({ chunkStatus: (n) => (n === 2 ? 409 : 204) });
    const write = await installWith(u);
    const err: unknown = await write('x'.repeat(UPLOAD_THRESHOLD + 1)).catch((e: unknown) => e);
    expect(err).toBe('upload: chunk out of order (HTTP 409)');
    expect(names(u.r)).toEqual(['Methods', 'BeginUpload', 'AbortUpload']);
    expect(u.r.calls.at(-1)?.args).toEqual(['up1']);
    expect(u.sent).toHaveLength(3); // it stops at the refused chunk
  });

  it("rejects with the core's text when it refuses the upload, without sending anything", async () => {
    const u = uploadRig({ beginError: 'upload of 400000000 bytes: the limit is 320 MiB' });
    const write = await installWith(u);
    await expect(write('x'.repeat(UPLOAD_THRESHOLD + 1))).rejects.toBe(
      'upload of 400000000 bytes: the limit is 320 MiB',
    );
    expect(u.send).not.toHaveBeenCalled();
    expect(names(u.r)).toEqual(['Methods', 'BeginUpload']);
  });

  it('rejects with the message string of a failed call, as the usual path does', async () => {
    const u = uploadRig();
    u.r.answer = () => Promise.reject(new Error('conflict: file changed on disk'));
    const write = await installWith(u);
    await expect(write('x'.repeat(UPLOAD_THRESHOLD + 1))).rejects.toBe(
      'conflict: file changed on disk',
    );
  });
});
