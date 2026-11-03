import { describe, expect, it, vi } from 'vitest';
import {
  acceptOf,
  CoreDeadError,
  CoreTimeoutError,
  installWailsGlobals,
  startCore,
  VerifiedWorker,
  type CoreHandle,
  type VerifiedWorkerDeps,
} from './bridge';
import type { BindingHooks } from './core.gen';
import type { CoreAssets, FromWorker, HostRequest, ToWorker } from './protocol';

const assets: CoreAssets = {
  core: { url: '/core/c.wasm', integrity: 'sha384-x' },
  sqlite: { url: '/core/s.wasm', integrity: 'sha384-y' },
};
const config = {
  dataDir: '/data',
  version: 't',
  logLevel: 'warn' as const,
  storage: { fs: 'accounts/a1/fs', sqlite: '/accounts/a1/sqlite' },
  account: 'sub-1',
};

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

  it('terminates a worker that does not get ready in time and rejects', async () => {
    vi.useFakeTimers();
    try {
      const onFatal = vi.fn();
      // A storage that never answers: the worker never reports `ready`.
      const { worker, core } = start(() => undefined, { onFatal, readyTimeoutMs: 120_000 });
      const settled = core.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(worker.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await settled).toMatchObject({
        message: 'the vault engine did not start within 120 s',
      });
      expect(worker.terminated).toBe(true);
      // A late `ready` changes nothing.
      worker.emit({ type: 'ready', methods });
      expect(await settled).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds start and wipe when given a limit', async () => {
    vi.useFakeTimers();
    try {
      // A core that answers nothing after `ready`.
      const { core } = start((m, w) => void ready(m, w), { readyTimeoutMs: 1_000 });
      const handle = await core;
      const starting = handle.start(5_000).catch((e: unknown) => e);
      const wiping = handle.wipe('/vaults/v', 2_000).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await wiping).toBeInstanceOf(CoreTimeoutError);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await starting).toBeInstanceOf(CoreTimeoutError);
      // The ready limit no longer applies once the core started.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(handle.dead).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a later fatal error through onFatal', async () => {
    const onFatal = vi.fn();
    const { worker, core } = start((m, w) => void ready(m, w), { onFatal });
    await core;
    worker.emit({ type: 'fatal', error: 'the Go core stopped' });
    expect(onFatal).toHaveBeenCalledWith('the Go core stopped');
  });

  it('fails the waiting calls and every later one once the core stops after start-up', async () => {
    const onFatal = vi.fn();
    // A core that never answers a call: only its death can end the wait.
    const { worker, core } = start((m, w) => void ready(m, w), { onFatal });
    const handle = await core;
    const waiting = handle.call('VaultAPI', 'ReadNote', 'v', 'a.md');
    const wiping = handle.wipe('/vaults/v');
    worker.emit({ type: 'fatal', error: 'the Go core exited' });
    await expect(waiting).rejects.toBeInstanceOf(CoreDeadError);
    await expect(wiping).rejects.toThrow('the vault engine stopped: the Go core exited');
    expect(handle.dead).toBe(true);
    const sent = worker.sent.length;
    await expect(handle.call('VaultAPI', 'ListOpen')).rejects.toBeInstanceOf(CoreDeadError);
    expect(worker.sent).toHaveLength(sent); // nothing more is posted to a dead worker
    // A second report (the worker's own error event) does not notify twice.
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it('treats an error event of the worker after start-up as the core stopping', async () => {
    const onFatal = vi.fn();
    const { worker, core } = start((m, w) => void ready(m, w), { onFatal });
    const handle = await core;
    const waiting = handle.call('S', 'M');
    worker.onerror?.({ message: 'out of memory' } as ErrorEvent);
    await expect(waiting).rejects.toThrow(/out of memory/);
    expect(onFatal).toHaveBeenCalledWith('the core worker failed: out of memory');
    expect(handle.dead).toBe(true);
  });

  it('gives up on a call that does not answer in time, and drops its late answer', async () => {
    let late: ToWorker | undefined;
    const { worker, core } = start((m, w) => {
      if (ready(m, w)) return;
      if (m.type === 'call') late = m;
    });
    const handle = await core;
    vi.useFakeTimers();
    try {
      const slow = handle.callWithin(5_000, 'AuthAPI', 'Status');
      const check = expect(slow).rejects.toBeInstanceOf(CoreTimeoutError);
      await vi.advanceTimersByTimeAsync(5_001);
      await check;
      await expect(slow).rejects.toThrow('AuthAPI.Status did not answer within 5 s');
    } finally {
      vi.useRealTimers();
    }
    // The answer arriving afterwards is ignored; the core is still usable.
    if (late?.type === 'call') worker.emit({ type: 'result', id: late.id, result: '"x"' });
    expect(handle.dead).toBe(false);
  });

  it('answers a timed call that is quick enough like any other call', async () => {
    const { core } = start((m, w) => {
      if (ready(m, w)) return;
      if (m.type === 'call') w.emit({ type: 'result', id: m.id, result: '{"status":"ready"}' });
    });
    const handle = await core;
    expect(await handle.callWithin(1_000, 'AuthAPI', 'Status')).toEqual({ status: 'ready' });
  });
});

describe('installWailsGlobals', () => {
  const fake = (): CoreHandle => {
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    const call = vi.fn((s: string, m: string, ...a: unknown[]) =>
      Promise.resolve({ s, m, a }),
    ) as unknown as CoreHandle['call'];
    return {
      methods,
      dead: false,
      call,
      callWithin: (_ms: number, s: string, m: string, ...a: unknown[]) => call(s, m, ...a),
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

  it('tells the hooks about the calls that answered, read at each call', async () => {
    const target = {} as Window;
    const hooks: BindingHooks = {};
    installWailsGlobals(fake(), target, hooks);
    const app = (
      target as unknown as {
        go: { app: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
      }
    ).go.app;
    const seen: unknown[] = [];
    // Added after the globals were installed, as launch.ts does once the guard exists.
    hooks.VaultAPI = { OpenVault: (args, result) => seen.push(args, result) };
    await app['VaultAPI']!['ReadNote']!('v', 'a.md');
    expect(seen).toEqual([]);
    await app['VaultAPI']!['OpenVault']!('/vaults/x');
    expect(seen).toEqual([['/vaults/x'], { s: 'VaultAPI', m: 'OpenVault', a: ['/vaults/x'] }]);
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

describe('VerifiedWorker', () => {
  /** A real worker stand-in: records what it receives, emits what the test says. */
  class StubWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    received: unknown[] = [];
    terminated = false;
    constructor(
      readonly url: string,
      readonly options: WorkerOptions,
    ) {}
    postMessage(m: unknown): void {
      this.received.push(m);
    }
    terminate(): void {
      this.terminated = true;
    }
  }

  function deps(fetchImpl: VerifiedWorkerDeps['fetch']) {
    const workers: StubWorker[] = [];
    const revoked: string[] = [];
    const fetches: [string, RequestInit][] = [];
    const d: VerifiedWorkerDeps = {
      fetch: (url, init) => (fetches.push([url, init]), fetchImpl(url, init)),
      createObjectURL: () => 'blob:http://localhost/1',
      revokeObjectURL: (u) => void revoked.push(u),
      createWorker: (url, options) => {
        const w = new StubWorker(url, options);
        workers.push(w);
        return w as unknown as Worker;
      },
    };
    return { d, workers, revoked, fetches };
  }
  const ok = () => Promise.resolve(new Response('self.onmessage = () => {};', { status: 200 }));
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('fetches the script with its integrity and starts the worker from the checked bytes', async () => {
    const { d, workers, revoked, fetches } = deps(ok);
    const vw = new VerifiedWorker('/assets/core-worker-X.js', 'sha384-abc', { type: 'module' }, d);
    const got: unknown[] = [];
    vw.onmessage = (e) => got.push(e.data);
    vw.postMessage({ type: 'init' }); // before the worker exists: queued
    await settle();

    expect(fetches).toEqual([
      ['/assets/core-worker-X.js', { integrity: 'sha384-abc', credentials: 'same-origin' }],
    ]);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.url).toBe('blob:http://localhost/1');
    expect(workers[0]!.options).toEqual({ type: 'module' });
    expect(workers[0]!.received).toEqual([{ type: 'init' }]);

    workers[0]!.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    expect(got).toEqual([{ type: 'ready' }]);
    expect(revoked).toEqual(['blob:http://localhost/1']);
    // dispatchEvent works as on a Worker (the E2E tests simulate a crash with it).
    vw.dispatchEvent(new MessageEvent('message', { data: { type: 'fatal' } }));
    expect(got).toEqual([{ type: 'ready' }, { type: 'fatal' }]);
  });

  it('never starts a script that fails the integrity check', async () => {
    const { d, workers } = deps(() => Promise.reject(new TypeError('Failed to fetch')));
    const vw = new VerifiedWorker('/assets/w.js', 'sha384-abc', { type: 'module' }, d);
    const errors: string[] = [];
    vw.onerror = (e) => errors.push(e.message);
    await settle();
    expect(workers).toHaveLength(0);
    expect(errors).toEqual(['cannot load /assets/w.js: Failed to fetch']);
  });

  it('refuses a script without integrity outside E2E builds', async () => {
    const { d, workers, fetches } = deps(ok);
    const vw = new VerifiedWorker('/assets/w.js', '', { type: 'module' }, d);
    const errors: string[] = [];
    vw.onerror = (e) => errors.push(e.message);
    await settle();
    expect(fetches).toHaveLength(0);
    expect(workers).toHaveLength(0);
    expect(errors).toEqual(['cannot load /assets/w.js: no integrity to check']);
  });

  it('turns a failure of the started worker into an error event', async () => {
    const { d, workers } = deps(ok);
    const vw = new VerifiedWorker('/assets/w.js', 'sha384-abc', { type: 'module' }, d);
    const errors: string[] = [];
    vw.onerror = (e) => errors.push(e.message);
    await settle();
    workers[0]!.onerror?.(new ErrorEvent('error', { message: 'boom', cancelable: true }));
    expect(errors).toEqual(['boom']);
  });

  it('does not start once terminated', async () => {
    const { d, workers } = deps(ok);
    const vw = new VerifiedWorker('/assets/w.js', 'sha384-abc', { type: 'module' }, d);
    vw.terminate();
    await settle();
    expect(workers).toHaveLength(0);
  });

  it('feeds startCore like a plain worker', async () => {
    const { d, workers } = deps(ok);
    const core = startCore({
      assets,
      config,
      getToken: () => Promise.resolve('t'),
      createWorker: () =>
        new VerifiedWorker(
          '/assets/w.js',
          'sha384-abc',
          { type: 'module' },
          d,
        ) as unknown as Worker,
    });
    await settle();
    expect(workers[0]!.received).toEqual([{ type: 'init', assets, config }]);
    workers[0]!.onmessage?.({ data: { type: 'ready', methods } } as MessageEvent);
    expect((await core).methods).toEqual(methods);
  });

  it('fails startCore when the check fails', async () => {
    const { d } = deps(() => Promise.reject(new TypeError('integrity mismatch')));
    const onFatal = vi.fn();
    const core = startCore({
      assets,
      config,
      getToken: () => Promise.resolve('t'),
      onFatal,
      createWorker: () =>
        new VerifiedWorker(
          '/assets/w.js',
          'sha384-abc',
          { type: 'module' },
          d,
        ) as unknown as Worker,
    });
    await expect(core).rejects.toThrow('integrity mismatch');
    expect(onFatal).toHaveBeenCalledOnce();
  });
});
