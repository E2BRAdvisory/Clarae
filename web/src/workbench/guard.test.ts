import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreHandle } from './bridge';
import { createVaultGuard, needsGate, type GuardOptions } from './guard';
import { readMarkers, updateMarker } from './markers';
import { closeOverlay } from './overlay';

type Handler = (...args: unknown[]) => unknown;

/** A core scripted by the test: bindings answer from `handlers`, events are emitted by hand. */
function fakeCore(handlers: Record<string, Handler> = {}) {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: string[] = [];
  const emit = (name: string, payload: unknown): void =>
    listeners.get(name)?.forEach((cb) => cb(payload));
  const call = (service: string, method: string, ...args: unknown[]): Promise<unknown> => {
    calls.push(`${service}.${method}`);
    const h = handlers[`${service}.${method}`];
    return h ? Promise.resolve().then(() => h(...args)) : Promise.resolve(null);
  };
  const core = {
    methods: {},
    dead: false,
    call,
    callWithin: (_ms: number, service: string, method: string, ...args: unknown[]) =>
      call(service, method, ...args),
    start: () => Promise.resolve(),
    domReady: () => undefined,
    shutdown: () => Promise.resolve(),
    wipe: vi.fn((_prefix: string) => Promise.resolve()),
    on: (name: string, cb: (p: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)?.add(cb);
      return () => listeners.get(name)?.delete(cb);
    },
    off: (name: string) => void listeners.delete(name),
    terminate: () => undefined,
  };
  return { core: core as unknown as CoreHandle, wipe: core.wipe, calls, emit };
}

const info = { id: 'local-1', name: 'Diary', path: '/vaults/cloud-1' };

function guardWith(handlers: Record<string, Handler> = {}, extra: Partial<GuardOptions> = {}) {
  const fake = fakeCore(handlers);
  let t = 0;
  const opts = {
    core: fake.core,
    markerId: 'cloud-1',
    info,
    kind: 'private',
    flush: vi.fn(() => Promise.resolve()),
    goToConsole: vi.fn(),
    reload: vi.fn(),
    now: () => ++t,
    pollMs: 0,
    ...extra,
  };
  const guard = createVaultGuard(opts);
  return { ...fake, guard, opts };
}

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => localStorage.clear());
afterEach(() => closeOverlay());

describe('vault guard: marker', () => {
  it('records the copy when it starts and follows the sync status', () => {
    const { emit } = guardWith();
    expect(readMarkers()['cloud-1']).toMatchObject({
      name: 'Diary',
      kind: 'private',
      localPath: '/vaults/cloud-1',
      pending: 0,
      dirty: false,
    });
    emit('sync:status', { vaultId: 'local-1', phase: 'offline', pending: 3, conflicts: 1 });
    expect(readMarkers()['cloud-1']).toMatchObject({ pending: 3, conflicts: 1 });
    emit('sync:status', { vaultId: 'other', phase: 'idle', pending: 0, conflicts: 0 });
    expect(readMarkers()['cloud-1']).toMatchObject({ pending: 3 });
  });

  it('flags a changed file until a sync that started afterwards ends clean', () => {
    const { emit } = guardWith();
    emit('sync:status', { vaultId: 'local-1', phase: 'syncing', pending: 0, conflicts: 0 });
    emit('vault:file-changed', { vaultId: 'local-1', paths: ['a.md'] });
    expect(readMarkers()['cloud-1']?.dirty).toBe(true);
    // The run in progress started before the change: it may not have scanned it.
    emit('sync:status', { vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 });
    expect(readMarkers()['cloud-1']?.dirty).toBe(true);
    emit('sync:status', { vaultId: 'local-1', phase: 'syncing', pending: 0, conflicts: 0 });
    emit('sync:status', { vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 });
    expect(readMarkers()['cloud-1']?.dirty).toBe(false);
  });
});

describe('vault guard: lock of a private vault', () => {
  it('ignores the event of a vault that was not unlocked in this page (it waits for its passphrase)', async () => {
    const { emit, wipe, opts } = guardWith();
    emit('vault:locked', { vaultId: 'local-1' });
    await flushAsync();
    expect(wipe).not.toHaveBeenCalled();
    expect(opts.goToConsole).not.toHaveBeenCalled();
  });

  it('removes the copy and goes to the console when nothing is left to upload', async () => {
    const { guard, emit, wipe, calls, opts } = guardWith();
    guard.noteUnlocked();
    emit('vault:locked', { vaultId: 'local-1', reason: 'idle', pending: 0, conflicts: 0 });
    await vi.waitFor(() => expect(opts.goToConsole).toHaveBeenCalledOnce());
    expect(calls).toContain('VaultAPI.CloseVault');
    expect(wipe).toHaveBeenCalledWith('/vaults/cloud-1');
    expect(readMarkers()['cloud-1']).toBeUndefined();
  });

  it('keeps a copy with changes not uploaded and says so, with the ways out', async () => {
    const { guard, emit, wipe, opts } = guardWith();
    guard.noteUnlocked();
    emit('vault:locked', { vaultId: 'local-1', reason: 'manual', pending: 2, conflicts: 1 });
    expect(
      await screen.findByText('2 changes not uploaded yet are kept in this browser as clear text.'),
    ).toBeInTheDocument();
    expect(screen.getByText('1 conflict is not resolved yet.')).toBeInTheDocument();
    expect(wipe).not.toHaveBeenCalled();
    expect(readMarkers()['cloud-1']).toMatchObject({ pending: 2, conflicts: 1 });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(opts.reload).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Back to the console' }));
    expect(opts.goToConsole).toHaveBeenCalledOnce();
    expect(wipe).not.toHaveBeenCalled();

    // Deleting asks first; Cancel goes back to the explanation.
    await user.click(screen.getByRole('button', { name: 'Delete anyway' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete anyway' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(wipe).toHaveBeenCalledWith('/vaults/cloud-1'));
    expect(readMarkers()['cloud-1']).toBeUndefined();
  });

  it('asks the core for the counts when the event carries only the vault id', async () => {
    const { guard, emit, calls } = guardWith({
      'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'locked', pending: 4, conflicts: 0 }),
    });
    guard.noteUnlocked();
    emit('vault:locked', { vaultId: 'local-1' });
    expect(await screen.findByText(/4 changes not uploaded yet/)).toBeInTheDocument();
    expect(calls).toContain('SyncAPI.Status');
  });

  it('keeps the copy when the counts cannot be known', async () => {
    const { guard, emit, wipe } = guardWith({
      'SyncAPI.Status': () => Promise.reject(new Error('the vault engine stopped')),
    });
    guard.noteUnlocked();
    emit('vault:locked', { vaultId: 'local-1' });
    expect(await screen.findByText(/may not have been uploaded yet/)).toBeInTheDocument();
    expect(wipe).not.toHaveBeenCalled();
  });

  it('ignores the sync loop telling that the vault waits for its key (reason "sync")', async () => {
    const { guard, emit, wipe, opts } = guardWith();
    guard.noteUnlocked();
    emit('vault:locked', { vaultId: 'local-1', reason: 'sync', pending: 0, conflicts: 0 });
    await flushAsync();
    expect(wipe).not.toHaveBeenCalled();
    expect(opts.goToConsole).not.toHaveBeenCalled();
    expect(document.querySelector('.page-overlay')).toBeNull();
  });

  it('acts on a manual or idle lock even when the unlock was not seen by the page', async () => {
    const { emit, wipe, opts } = guardWith();
    emit('vault:locked', { vaultId: 'local-1', reason: 'idle', pending: 0, conflicts: 0 });
    await vi.waitFor(() => expect(opts.goToConsole).toHaveBeenCalledOnce());
    expect(wipe).toHaveBeenCalledWith('/vaults/cloud-1');
  });

  it('keeps the copy when the core could not count the changes (pending -1)', async () => {
    const { emit, wipe } = guardWith();
    emit('vault:locked', { vaultId: 'local-1', reason: 'manual', pending: -1, conflicts: 0 });
    expect(await screen.findByText(/may not have been uploaded yet/)).toBeInTheDocument();
    expect(wipe).not.toHaveBeenCalled();
    expect(readMarkers()['cloud-1']?.dirty).toBe(true);
  });
});

describe('vault guard: lock and forget', () => {
  it('flushes, uploads, waits for the outbox, locks and removes the copy', async () => {
    let status = 2;
    let emitRef: (n: string, p: unknown) => void = () => undefined;
    const g = guardWith({
      'SyncAPI.Status': () => ({
        vaultId: 'local-1',
        phase: 'idle',
        pending: status-- > 0 ? 1 : 0,
        conflicts: 0,
      }),
      // Like the core: the event goes out before the call returns.
      'VaultCryptoAPI.Lock': () =>
        emitRef('vault:locked', { vaultId: 'local-1', reason: 'manual', pending: 0, conflicts: 0 }),
    });
    emitRef = g.emit;
    g.guard.noteUnlocked();
    await g.guard.lockAndForget();
    expect(g.opts.flush).toHaveBeenCalledOnce();
    const order = g.calls.filter((c) => c !== 'SyncAPI.Status');
    expect(order).toEqual([
      'SyncAPI.Info',
      'SyncAPI.SyncNow',
      'VaultCryptoAPI.Lock',
      'VaultAPI.CloseVault',
    ]);
    expect(g.calls.filter((c) => c === 'SyncAPI.Status').length).toBeGreaterThanOrEqual(3);
    expect(g.wipe).toHaveBeenCalledWith('/vaults/cloud-1');
    expect(g.opts.goToConsole).toHaveBeenCalledOnce();
  });

  it('keeps the copy when changes could not be uploaded before the lock', async () => {
    const g = guardWith(
      {
        'SyncAPI.Status': () => ({
          vaultId: 'local-1',
          phase: 'offline',
          pending: 5,
          conflicts: 0,
        }),
      },
      { drainMs: 20 },
    );
    g.guard.noteUnlocked();
    await g.guard.lockAndForget();
    expect(screen.getByText(/5 changes not uploaded yet/)).toBeInTheDocument();
    expect(g.calls).toContain('VaultCryptoAPI.Lock');
    expect(g.wipe).not.toHaveBeenCalled();
    expect(g.opts.goToConsole).not.toHaveBeenCalled();
  });

  it('keeps a copy changed while it was never unlocked here', async () => {
    const g = guardWith({
      'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'locked', pending: 0, conflicts: 0 }),
    });
    g.emit('vault:file-changed', { vaultId: 'local-1', paths: ['new.md'] });
    await g.guard.lockAndForget();
    expect(screen.getByText(/may not have been uploaded yet/)).toBeInTheDocument();
    expect(g.calls).not.toContain('VaultCryptoAPI.Lock');
    expect(g.wipe).not.toHaveBeenCalled();
  });

  it('leaves a shared vault after writing the edits, without locking or removing it', async () => {
    const g = guardWith({}, { kind: 'shared' });
    await g.guard.leave();
    expect(g.opts.flush).toHaveBeenCalledOnce();
    expect(g.opts.goToConsole).toHaveBeenCalledOnce();
    expect(g.calls).toEqual([]);
    expect(g.wipe).not.toHaveBeenCalled();
  });
});

describe('needsGate', () => {
  it('asks for the passphrase first only for a locked private copy holding changes', () => {
    updateMarker('p', { kind: 'private', pending: 1 });
    updateMarker('clean', { kind: 'private' });
    expect(needsGate('p', 'private', true)).toMatchObject({ pending: 1 });
    expect(needsGate('p', 'private', false)).toBeNull();
    expect(needsGate('p', 'shared', true)).toBeNull();
    expect(needsGate('clean', 'private', true)).toBeNull();
    expect(needsGate('missing', 'private', true)).toBeNull();
  });
});

describe('vault guard: remove from this browser', () => {
  it('uploads, then removes the copy of a shared vault and goes to the console', async () => {
    const { guard, opts, wipe, calls } = guardWith(
      { 'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 }) },
      { kind: 'shared' },
    );
    await guard.removeCopy();
    expect(opts.flush).toHaveBeenCalled();
    expect(calls).toContain('SyncAPI.SyncNow');
    expect(calls).not.toContain('SyncAPI.Unlink'); // the launcher would only link it again
    expect(wipe).toHaveBeenCalledWith('/vaults/cloud-1');
    expect(readMarkers()['cloud-1']).toBeUndefined();
    expect(opts.goToConsole).toHaveBeenCalled();
  });

  it('keeps a copy with changes the cloud does not have, and deletes it only when asked', async () => {
    const { guard, opts, wipe } = guardWith(
      {
        'SyncAPI.Status': () => ({
          vaultId: 'local-1',
          phase: 'offline',
          pending: 2,
          conflicts: 0,
        }),
      },
      { kind: 'shared', drainMs: 0 },
    );
    await guard.removeCopy();
    expect(wipe).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('2 changes not uploaded yet');
    await userEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await flushAsync();
    expect(wipe).toHaveBeenCalledWith('/vaults/cloud-1');
    expect(opts.goToConsole).toHaveBeenCalled();
  });

  it('stays in the vault when asked', async () => {
    const { guard, opts, wipe } = guardWith(
      { 'SyncAPI.Status': () => null },
      { kind: 'shared', drainMs: 0 },
    );
    await guard.removeCopy();
    await userEvent.click(screen.getByRole('button', { name: 'Stay in the vault' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(wipe).not.toHaveBeenCalled();
    expect(opts.goToConsole).not.toHaveBeenCalled();
  });

  it('locks a private vault first (the same path as leaving)', async () => {
    const { guard, calls } = guardWith({
      'SyncAPI.Info': () => ({ locked: false }),
      'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 }),
    });
    guard.noteUnlocked();
    await guard.removeCopy();
    expect(calls).toContain('VaultCryptoAPI.Lock');
  });
});
