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

/** The account's storage key (storage.ts). */
const A = 'a-alice';
const info = { id: 'local-1', name: 'Diary', path: '/vaults/cloud-1' };

function guardWith(handlers: Record<string, Handler> = {}, extra: Partial<GuardOptions> = {}) {
  const fake = fakeCore(handlers);
  let t = 0;
  const opts = {
    core: fake.core,
    account: A,
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

/** The core's verdict on removing the copy (SyncAPI.CopyVerdict), as the core answers it. */
const verdict =
  (pending: number, conflicts = 0) =>
  () => ({
    removable: pending === 0 && conflicts === 0,
    reason: pending > 0 ? 'pending' : conflicts > 0 ? 'conflicts' : 'clean',
    pending,
    conflicts,
  });

beforeEach(() => localStorage.clear());
afterEach(() => closeOverlay());

describe('vault guard: marker', () => {
  it('records the copy when it starts and follows the sync status', () => {
    const { emit } = guardWith();
    expect(readMarkers(A)['cloud-1']).toMatchObject({
      name: 'Diary',
      kind: 'private',
      localPath: '/vaults/cloud-1',
      pending: 0,
      dirty: false,
    });
    emit('sync:status', { vaultId: 'local-1', phase: 'offline', pending: 3, conflicts: 1 });
    expect(readMarkers(A)['cloud-1']).toMatchObject({ pending: 3, conflicts: 1 });
    emit('sync:status', { vaultId: 'other', phase: 'idle', pending: 0, conflicts: 0 });
    expect(readMarkers(A)['cloud-1']).toMatchObject({ pending: 3 });
  });

  it('flags a changed file until a sync that started afterwards ends clean', () => {
    const { emit } = guardWith();
    emit('sync:status', { vaultId: 'local-1', phase: 'syncing', pending: 0, conflicts: 0 });
    emit('vault:file-changed', { vaultId: 'local-1', paths: ['a.md'] });
    expect(readMarkers(A)['cloud-1']?.dirty).toBe(true);
    // The run in progress started before the change: it may not have scanned it.
    emit('sync:status', { vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 });
    expect(readMarkers(A)['cloud-1']?.dirty).toBe(true);
    emit('sync:status', { vaultId: 'local-1', phase: 'syncing', pending: 0, conflicts: 0 });
    emit('sync:status', { vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 });
    expect(readMarkers(A)['cloud-1']?.dirty).toBe(false);
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
    expect(readMarkers(A)['cloud-1']).toBeUndefined();
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
    expect(readMarkers(A)['cloud-1']).toMatchObject({ pending: 2, conflicts: 1 });

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
    expect(readMarkers(A)['cloud-1']).toBeUndefined();
  });

  it("asks the core's verdict when the event carries only the vault id", async () => {
    const { guard, emit, calls } = guardWith({ 'SyncAPI.CopyVerdict': verdict(4) });
    guard.noteUnlocked();
    emit('vault:locked', { vaultId: 'local-1' });
    expect(await screen.findByText(/4 changes not uploaded yet/)).toBeInTheDocument();
    expect(calls).toContain('SyncAPI.CopyVerdict');
  });

  it('keeps the copy when the counts cannot be known', async () => {
    const { guard, emit, wipe } = guardWith({
      'SyncAPI.CopyVerdict': () => Promise.reject(new Error('the vault engine stopped')),
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
    expect(readMarkers(A)['cloud-1']?.dirty).toBe(true);
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
        'SyncAPI.CopyVerdict': verdict(5),
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

  it("decides a copy never unlocked here by the core's verdict, which scans it", async () => {
    const g = guardWith({
      'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'locked', pending: 0, conflicts: 0 }),
      // The sync never ran (no key): the verdict's scan finds the change made while locked.
      'SyncAPI.CopyVerdict': verdict(1),
    });
    g.emit('vault:file-changed', { vaultId: 'local-1', paths: ['new.md'] });
    await g.guard.lockAndForget();
    expect(screen.getByText(/1 change not uploaded yet/)).toBeInTheDocument();
    expect(g.calls).not.toContain('VaultCryptoAPI.Lock');
    expect(g.wipe).not.toHaveBeenCalled();

    closeOverlay();
    localStorage.clear();
    const clean = guardWith({ 'SyncAPI.CopyVerdict': verdict(0) });
    await clean.guard.lockAndForget();
    expect(clean.calls).not.toContain('VaultCryptoAPI.Lock');
    expect(clean.wipe).toHaveBeenCalledWith('/vaults/cloud-1');
  });

  it('leaves a shared vault after writing and uploading the edits, without locking or removing it', async () => {
    const g = guardWith(
      {
        'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 }),
        'SyncAPI.CopyVerdict': verdict(0),
      },
      { kind: 'shared' },
    );
    g.emit('vault:file-changed', { vaultId: 'local-1', paths: ['new.md'] });
    await g.guard.leave();
    expect(g.opts.flush).toHaveBeenCalledOnce();
    expect(g.calls).toContain('SyncAPI.SyncNow');
    expect(g.calls).not.toContain('VaultCryptoAPI.Lock');
    expect(g.opts.goToConsole).toHaveBeenCalledOnce();
    expect(g.wipe).not.toHaveBeenCalled();
    // The verdict scanned the copy: the change was uploaded, the marker is clean.
    expect(readMarkers(A)['cloud-1']).toMatchObject({ pending: 0, conflicts: 0, dirty: false });
  });

  it('leaving a shared vault records what could not be uploaded, for the console to ask', async () => {
    const g = guardWith(
      {
        'SyncAPI.Status': () => ({
          vaultId: 'local-1',
          phase: 'offline',
          pending: 1,
          conflicts: 0,
        }),
        // Written by the flush, not scanned by a sync yet: the verdict's scan counts it.
        'SyncAPI.CopyVerdict': verdict(2),
      },
      { kind: 'shared' },
    );
    g.emit('vault:file-changed', { vaultId: 'local-1', paths: ['new.md'] });
    await g.guard.leave();
    expect(readMarkers(A)['cloud-1']).toMatchObject({ pending: 2, dirty: false });
    expect(g.wipe).not.toHaveBeenCalled();
    expect(g.opts.goToConsole).toHaveBeenCalledOnce();
  });

  it('leaving with an unknown verdict keeps the copy flagged', async () => {
    const g = guardWith(
      {
        'SyncAPI.Status': () => Promise.reject(new Error('engine stopped')),
        'SyncAPI.CopyVerdict': () => ({
          removable: false,
          reason: 'unknown',
          pending: -1,
          conflicts: 0,
        }),
      },
      { kind: 'shared' },
    );
    await g.guard.leave();
    expect(readMarkers(A)['cloud-1']?.dirty).toBe(true);
    expect(g.opts.goToConsole).toHaveBeenCalledOnce();
  });

  it('leaves for another page of the workbench (a mount) instead of the console', async () => {
    const to = vi.fn();
    const g = guardWith(
      { 'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 }) },
      { kind: 'shared' },
    );
    await g.guard.leave(to);
    expect(to).toHaveBeenCalledOnce();
    expect(g.opts.goToConsole).not.toHaveBeenCalled();
  });

  it('a private vault left for another page is locked and removed first', async () => {
    const to = vi.fn();
    const g = guardWith({
      'SyncAPI.Info': () => ({ locked: false }),
      'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 }),
      'SyncAPI.CopyVerdict': verdict(0),
    });
    g.guard.noteUnlocked();
    await g.guard.leave(to);
    expect(g.calls).toContain('VaultCryptoAPI.Lock');
    expect(g.wipe).toHaveBeenCalledWith('/vaults/cloud-1');
    expect(to).toHaveBeenCalledOnce();
    expect(g.opts.goToConsole).not.toHaveBeenCalled();
  });

  it('stops waiting for the outbox once the sync is offline', async () => {
    let polls = 0;
    const g = guardWith(
      {
        'SyncAPI.Status': () => {
          polls++;
          return { vaultId: 'local-1', phase: 'offline', pending: 1, conflicts: 0 };
        },
        'SyncAPI.CopyVerdict': verdict(1),
      },
      { kind: 'shared', drainMs: 60_000, pollMs: 0 },
    );
    await g.guard.leave();
    expect(polls).toBe(1); // the drain's poll; the final count is the verdict
    expect(readMarkers(A)['cloud-1']?.pending).toBe(1);
  });
});

describe('vault guard: cloud vault deleted elsewhere', () => {
  const deleted = (g: ReturnType<typeof guardWith>) => {
    // As the core does: the unlinked folder's status (kind "", zero counts) comes first.
    g.emit('sync:status', {
      vaultId: 'local-1',
      phase: 'idle',
      pending: 0,
      conflicts: 0,
      kind: '',
    });
    g.emit('vault:cloud-deleted', { vaultId: 'local-1', cloudVaultId: 'cloud-1', name: 'Diary' });
    g.emit('sync:status', {
      vaultId: 'local-1',
      phase: 'idle',
      pending: 0,
      conflicts: 0,
      kind: '',
    });
  };

  it('flags the marker and keeps what it records (the zero counts of an unlinked folder mean nothing)', () => {
    const g = guardWith({}, { kind: 'shared' });
    g.emit('sync:status', { vaultId: 'local-1', phase: 'offline', pending: 3, conflicts: 0 });
    deleted(g);
    expect(readMarkers(A)['cloud-1']).toMatchObject({ pending: 3, cloudDeleted: true });
  });

  it('removes a copy that holds nothing without trying to upload', async () => {
    const g = guardWith({}, { kind: 'shared' });
    deleted(g);
    await g.guard.removeCopy();
    expect(g.calls).not.toContain('SyncAPI.SyncNow');
    expect(g.wipe).toHaveBeenCalledWith('/vaults/cloud-1');
    expect(readMarkers(A)['cloud-1']).toBeUndefined();
    expect(g.opts.goToConsole).toHaveBeenCalledOnce();
  });

  it('asks before removing a copy that holds changes the cloud never got', async () => {
    const g = guardWith({}, { kind: 'shared' });
    g.emit('sync:status', { vaultId: 'local-1', phase: 'offline', pending: 2, conflicts: 0 });
    deleted(g);
    await g.guard.removeCopy();
    expect(g.wipe).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('2 changes not uploaded yet');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('cloud vault was deleted');
    await userEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(g.wipe).toHaveBeenCalledWith('/vaults/cloud-1'));
  });

  it('starts detached when the launcher found the cloud vault gone, and offers the removal', async () => {
    // A copy with an edit the cloud never got, its vault deleted while no tab was open.
    updateMarker(A, 'cloud-1', { name: 'Diary', kind: 'shared', localPath: info.path, pending: 2 });
    const g = guardWith({}, { kind: 'shared', cloudDeleted: true });
    expect(readMarkers(A)['cloud-1']).toMatchObject({ pending: 2, cloudDeleted: true });
    // The zero counts of the unlinked folder say nothing about what it holds.
    g.emit('sync:status', {
      vaultId: 'local-1',
      phase: 'idle',
      pending: 0,
      conflicts: 0,
      kind: '',
    });
    expect(readMarkers(A)['cloud-1']?.pending).toBe(2);

    g.guard.offerRemoval();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('deleted from the console');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('2 changes not uploaded yet');
    await userEvent.click(screen.getByRole('button', { name: 'Stay in the vault' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(g.wipe).not.toHaveBeenCalled();

    // Removing asks again for what would be lost, without trying to upload.
    g.guard.offerRemoval();
    await userEvent.click(screen.getByRole('button', { name: 'Remove from this browser' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('alertdialog')).toHaveTextContent('cloud vault was deleted'),
    );
    expect(g.calls).not.toContain('SyncAPI.SyncNow');
    expect(g.wipe).not.toHaveBeenCalled();
  });

  it('removes a clean copy whose cloud vault the launcher found gone', async () => {
    const g = guardWith({}, { kind: 'shared', cloudDeleted: true });
    g.guard.offerRemoval();
    await userEvent.click(screen.getByRole('button', { name: 'Remove from this browser' }));
    await vi.waitFor(() => expect(g.wipe).toHaveBeenCalledWith('/vaults/cloud-1'));
    expect(readMarkers(A)['cloud-1']).toBeUndefined();
    expect(g.opts.goToConsole).toHaveBeenCalledOnce();
  });

  it('a restored vault opened again clears the flag', () => {
    updateMarker(A, 'cloud-1', {
      name: 'Diary',
      kind: 'shared',
      localPath: info.path,
      cloudDeleted: true,
    });
    guardWith({}, { kind: 'shared' });
    expect(readMarkers(A)['cloud-1']?.cloudDeleted).toBe(false);
  });

  it('a removal under way after the deletion decides by the marker, not by the zero counts', async () => {
    const g = guardWith(
      {
        'SyncAPI.Status': () => ({
          vaultId: 'local-1',
          phase: 'idle',
          pending: 0,
          conflicts: 0,
          kind: '',
        }),
        'SyncAPI.CopyVerdict': () => ({
          removable: false,
          reason: 'unlinked',
          pending: -1,
          conflicts: -1,
        }),
      },
      { kind: 'shared', drainMs: 0 },
    );
    updateMarker(A, 'cloud-1', { pending: 1 });
    await g.guard.removeCopy();
    expect(g.wipe).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('1 change not uploaded yet');
  });

  it('leaving removes the clear text of a clean private copy, and keeps one with changes', async () => {
    const clean = guardWith();
    deleted(clean);
    await clean.guard.leave();
    expect(clean.wipe).toHaveBeenCalledWith('/vaults/cloud-1');
    expect(clean.calls).not.toContain('VaultCryptoAPI.Lock');

    localStorage.clear();
    const kept = guardWith();
    kept.emit('vault:file-changed', { vaultId: 'local-1', paths: ['a.md'] });
    deleted(kept);
    await kept.guard.leave();
    expect(kept.wipe).not.toHaveBeenCalled();
    expect(kept.opts.goToConsole).toHaveBeenCalledOnce();
    expect(readMarkers(A)['cloud-1']).toMatchObject({ dirty: true, cloudDeleted: true });
  });

  it('a vault opened again after its restoration is followed as before', () => {
    updateMarker(A, 'cloud-1', { cloudDeleted: true });
    guardWith({}, { kind: 'shared' });
    expect(readMarkers(A)['cloud-1']?.cloudDeleted).toBe(false);
  });
});

describe('needsGate', () => {
  it('asks for the passphrase first only for a locked private copy holding changes', () => {
    updateMarker(A, 'p', { kind: 'private', pending: 1 });
    updateMarker(A, 'clean', { kind: 'private' });
    expect(needsGate(A, 'p', 'private', true)).toMatchObject({ pending: 1 });
    expect(needsGate(A, 'p', 'private', false)).toBeNull();
    expect(needsGate(A, 'p', 'shared', true)).toBeNull();
    expect(needsGate(A, 'clean', 'private', true)).toBeNull();
    expect(needsGate(A, 'missing', 'private', true)).toBeNull();
  });
});

describe('vault guard: remove from this browser', () => {
  it('uploads, then removes the copy of a shared vault and goes to the console', async () => {
    const { guard, opts, wipe, calls } = guardWith(
      {
        'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'idle', pending: 0, conflicts: 0 }),
        'SyncAPI.CopyVerdict': verdict(0),
      },
      { kind: 'shared' },
    );
    await guard.removeCopy();
    expect(opts.flush).toHaveBeenCalled();
    expect(calls).toContain('SyncAPI.SyncNow');
    expect(calls).not.toContain('SyncAPI.Unlink'); // the launcher would only link it again
    expect(wipe).toHaveBeenCalledWith('/vaults/cloud-1');
    expect(readMarkers(A)['cloud-1']).toBeUndefined();
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
        'SyncAPI.CopyVerdict': verdict(2),
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

  it("keeps a copy whose change the core's scan finds, even when the sync counts are zero", async () => {
    const { guard, emit, wipe, calls } = guardWith(
      {
        'SyncAPI.Status': () => ({ vaultId: 'local-1', phase: 'error', pending: 0, conflicts: 0 }),
        'SyncAPI.CopyVerdict': verdict(1),
      },
      { kind: 'shared', drainMs: 0 },
    );
    emit('vault:file-changed', { vaultId: 'local-1', paths: ['late.md'] });
    await guard.removeCopy();
    expect(calls).toContain('SyncAPI.CopyVerdict');
    expect(wipe).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('1 change not uploaded yet');
  });

  it('keeps a copy in conflict, and one whose verdict is unknown', async () => {
    const conflict = guardWith(
      { 'SyncAPI.CopyVerdict': verdict(0, 1) },
      { kind: 'shared', drainMs: 0 },
    );
    await conflict.guard.removeCopy();
    expect(conflict.wipe).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('1 conflict is not resolved yet');

    closeOverlay();
    localStorage.clear();
    const unknown = guardWith(
      {
        'SyncAPI.CopyVerdict': () => ({
          removable: false,
          reason: 'unknown',
          pending: -1,
          conflicts: 0,
        }),
      },
      { kind: 'shared', drainMs: 0 },
    );
    await unknown.guard.removeCopy();
    expect(unknown.wipe).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('may not have been uploaded yet');
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
