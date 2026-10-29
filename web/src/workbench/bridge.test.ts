import { describe, expect, it, vi } from 'vitest';
import { acceptOf, installWailsGlobals, startCore, type CoreHandle } from './bridge';
import type { CoreAssets, FromWorker, HostRequest, ToWorker } from './protocol';

const assets: CoreAssets = {
  core: { url: '/core/c.wasm', integrity: 'sha384-x' },
  sqlite: { url: '/core/s.wasm', integrity: 'sha384-y' },
};
const config = { dataDir: '/data', version: 't', logLevel: 'warn' as const };

/** A worker that behaves like the real one, scripted by the test. */
class FakeWorker {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  sent: ToWorker[] = [];
  terminated = false;
  constructor(private readonly handler: (m: ToWorker, w: FakeWorker) => void) {}
  postMessage(m: ToWorker): void {
    this.sent.push(m);
    queueMicrotask(() => this.handler(m, this));
  }
  emit(m: FromWorker): void {
    this.onmessage?.({ data: m } as MessageEvent<FromWorker>);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function start(handler: (m: ToWorker, w: FakeWorker) => void, extra: object = {}) {
  const worker = new FakeWorker(handler);
  const core = startCore({
    assets,
    config,
    getToken: () => Promise.resolve('tok-1'),
    createWorker: () => worker as unknown as Worker,
    ...extra,
  });
  return { worker, core };
}

const methods = { VaultAPI: ['ReadNote', 'OpenVault'], SettingsAPI: ['Info'] };
const ready = (m: ToWorker, w: FakeWorker): boolean => {
  if (m.type !== 'init') return false;
  w.emit({ type: 'ready', methods });
  return true;
};

describe('startCore', () => {
  it('sends the assets and config, and resolves when the core is ready', async () => {
    const { worker, core } = start((m, w) => void ready(m, w));
    const handle = await core;
    expect(worker.sent[0]).toEqual({ type: 'init', assets, config });
    expect(handle.methods).toEqual(methods);
  });

  it('calls a binding with JSON arguments and parses the answer', async () => {
    const { worker, core } = start((m, w) => {
      if (ready(m, w)) return;
      if (m.type === 'call')
        w.emit({
          type: 'result',
          id: m.id,
          result: JSON.stringify({ echo: JSON.parse(m.args) as unknown }),
        });
    });
    const handle = await core;
    const res = await handle.call('VaultAPI', 'ReadNote', 'vault-1', 'a.md');
    expect(res).toEqual({ echo: ['vault-1', 'a.md'] });
    expect(worker.sent.find((m) => m.type === 'call')).toMatchObject({
      service: 'VaultAPI',
      method: 'ReadNote',
    });
  });

  it('rejects with the message text, like Wails (not with an Error)', async () => {
    const { core } = start((m, w) => {
      if (ready(m, w)) return;
      if (m.type === 'call')
        w.emit({ type: 'result', id: m.id, error: 'conflict: file changed on disk' });
    });
    const handle = await core;
    await expect(handle.call('VaultAPI', 'WriteNote')).rejects.toBe(
      'conflict: file changed on disk',
    );
  });

  it('answers concurrent calls to the right caller', async () => {
    const { core } = start((m, w) => {
      if (ready(m, w)) return;
      // Answer in reverse order of arrival.
      if (m.type === 'call')
        setTimeout(
          () => w.emit({ type: 'result', id: m.id, result: JSON.stringify(m.method) }),
          m.method === 'A' ? 10 : 0,
        );
    });
    const handle = await core;
    const [a, b] = await Promise.all([handle.call('S', 'A'), handle.call('S', 'B')]);
    expect([a, b]).toEqual(['A', 'B']);
  });

  it('delivers Go events to subscribers until they unsubscribe or the event is switched off', async () => {
    const { worker, core } = start((m, w) => void ready(m, w));
    const handle = await core;
    const seen: unknown[] = [];
    const off = handle.on('vault:file-changed', (p) => seen.push(p));
    worker.emit({
      type: 'event',
      name: 'vault:file-changed',
      payload: '{"vaultId":"v","paths":["a.md"]}',
    });
    off();
    worker.emit({ type: 'event', name: 'vault:file-changed', payload: '{"paths":["b.md"]}' });
    expect(seen).toEqual([{ vaultId: 'v', paths: ['a.md'] }]);

    const again: unknown[] = [];
    handle.on('sync:status', (p) => again.push(p));
    handle.off('sync:status');
    worker.emit({ type: 'event', name: 'sync:status', payload: '{}' });
    expect(again).toEqual([]);
  });

  it('answers what the core asks of the browser: a token, a URL, quitting', async () => {
    const onQuit = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const replies: ToWorker[] = [];
    const { worker, core } = start(
      (m, w) => {
        if (ready(m, w)) return;
        if (m.type === 'host-result') replies.push(m);
      },
      { onQuit },
    );
    await core;
    const ask = (id: number, request: HostRequest) => worker.emit({ type: 'host', id, request });
    ask(1, { op: 'token' });
    ask(2, { op: 'openURL', url: 'https://example.com/' });
    ask(3, { op: 'quit' });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies.find((r) => r.type === 'host-result' && r.id === 1)).toMatchObject({
      value: 'tok-1',
    });
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    expect(onQuit).toHaveBeenCalledOnce();
    open.mockRestore();
  });

  it('turns a failing token source into an error reply, not a hang', async () => {
    const replies: ToWorker[] = [];
    const { worker, core } = start(
      (m, w) => {
        if (ready(m, w)) return;
        if (m.type === 'host-result') replies.push(m);
      },
      { getToken: () => Promise.reject(new Error('signed out')) },
    );
    await core;
    worker.emit({ type: 'host', id: 9, request: { op: 'token' } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ type: 'host-result', id: 9, error: 'signed out' });
  });

  it('starts a download when the core delivers a file', async () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const { worker, core } = start((m, w) => void ready(m, w));
    await core;
    worker.emit({
      type: 'download',
      name: 'vault-20261029.zip',
      bytes: new Uint8Array([80, 75]).buffer,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it('rejects when the worker reports a fatal error before it is ready', async () => {
    const { core } = start((m, w) => {
      if (m.type === 'init') w.emit({ type: 'fatal', error: 'cannot load /core/c.wasm: HTTP 404' });
    });
    await expect(core).rejects.toThrow('cannot load /core/c.wasm: HTTP 404');
  });

  it('reports a later fatal error through onFatal', async () => {
    const onFatal = vi.fn();
    const { worker, core } = start((m, w) => void ready(m, w), { onFatal });
    await core;
    worker.emit({ type: 'fatal', error: 'the Go core stopped' });
    expect(onFatal).toHaveBeenCalledWith('the Go core stopped');
  });
});

describe('installWailsGlobals', () => {
  const fake = (): CoreHandle => {
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    return {
      methods,
      call: vi.fn((s: string, m: string, ...a: unknown[]) =>
        Promise.resolve({ s, m, a }),
      ) as unknown as CoreHandle['call'],
      start: () => Promise.resolve(),
      domReady: () => undefined,
      shutdown: () => Promise.resolve(),
      wipe: () => Promise.resolve(),
      on: (n, cb) => {
        if (!listeners.has(n)) listeners.set(n, new Set());
        listeners.get(n)?.add(cb);
        return () => listeners.get(n)?.delete(cb);
      },
      off: (n) => void listeners.delete(n),
      terminate: () => undefined,
    };
  };

  it('exposes one function per method the core reports, as window.go.app', async () => {
    const target = {} as Window;
    const core = fake();
    installWailsGlobals(core, target);
    const app = (
      target as unknown as {
        go: { app: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
      }
    ).go.app;
    expect(Object.keys(app)).toEqual(['VaultAPI', 'SettingsAPI']);
    expect(Object.keys(app['VaultAPI']!)).toEqual(['ReadNote', 'OpenVault']);
    expect(await app['VaultAPI']!['ReadNote']!('v', 'a.md')).toEqual({
      s: 'VaultAPI',
      m: 'ReadNote',
      a: ['v', 'a.md'],
    });
  });

  it('provides the runtime events the generated Wails modules call', () => {
    const target = {} as Window;
    installWailsGlobals(fake(), target);
    const rt = (
      target as unknown as {
        runtime: {
          EventsOnMultiple(n: string, cb: (...d: unknown[]) => void, max: number): () => void;
        };
      }
    ).runtime;
    expect(typeof rt.EventsOnMultiple('x', () => undefined, -1)).toBe('function');
  });
});

describe('acceptOf', () => {
  it('turns Wails dialog patterns into a file input accept list', () => {
    expect(acceptOf(['*.md;*.txt', '*.zip'])).toBe('.md,.txt,.zip');
    expect(acceptOf(['*'])).toBe('');
    expect(acceptOf([])).toBe('');
  });
});
