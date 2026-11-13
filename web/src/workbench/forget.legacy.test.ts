import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKBENCH_CHANNEL,
  WORKBENCH_LOCK,
  WORKBENCH_LOCKS,
  askWorkbenchToLeave,
  forgetAfterLeave,
  onLeaveRequest,
  tryTakeWorkbenchLocks,
  workbenchPageOpen,
} from './forget';
import { LEGACY_WORKBENCH_CHANNEL, LEGACY_WORKBENCH_LOCK } from './legacyNames';

// During a deploy a tab of 1.4 can still be open: it knows the lock and the channel by their old
// names, and the account by its old key.

/** A Web Locks manager with `ifAvailable` requests, enough for what the workbench asks of it. */
function fakeLocks(initiallyHeld: string[] = []) {
  const held = new Set(initiallyHeld);
  const order: string[] = [];
  const releasers = new Map<string, () => void>();
  const manager = {
    request(name: string, _o: unknown, cb: (lock: { name: string } | null) => unknown) {
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      order.push(name);
      const done = cb({ name }) as Promise<void>;
      void done.finally(() => held.delete(name));
      releasers.set(name, () => undefined);
      return done;
    },
    query: () => Promise.resolve({ held: [...held].map((name) => ({ name })) }),
  };
  return { manager: manager as unknown as LockManager, held, order };
}

describe('the workbench locks', () => {
  it('are the lock of 1.4 and the current one, taken in that order', () => {
    expect(WORKBENCH_LOCKS).toEqual([LEGACY_WORKBENCH_LOCK, WORKBENCH_LOCK]);
    expect(WORKBENCH_LOCK).toBe('clarae-workbench');
  });

  it('are both held by a page, for as long as it lives', async () => {
    const l = fakeLocks();
    expect(await tryTakeWorkbenchLocks(l.manager)).toBe(true);
    expect(l.order).toEqual([LEGACY_WORKBENCH_LOCK, WORKBENCH_LOCK]);
    expect([...l.held].sort()).toEqual([WORKBENCH_LOCK, LEGACY_WORKBENCH_LOCK].sort());
    // A second page finds them taken.
    expect(await tryTakeWorkbenchLocks(l.manager)).toBe(false);
  });

  it('keep this page out while a tab of 1.4 holds its lock', async () => {
    const l = fakeLocks([LEGACY_WORKBENCH_LOCK]);
    expect(await tryTakeWorkbenchLocks(l.manager)).toBe(false);
    expect(l.held.has(WORKBENCH_LOCK)).toBe(false);
  });

  it('let go of the first when the second is taken, so nothing stays held half-way', async () => {
    const l = fakeLocks([WORKBENCH_LOCK]);
    expect(await tryTakeWorkbenchLocks(l.manager)).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(l.held.has(LEGACY_WORKBENCH_LOCK)).toBe(false);
  });

  describe('as the console sees them', () => {
    const withLocks = (l: ReturnType<typeof fakeLocks>) =>
      Object.defineProperty(navigator, 'locks', { configurable: true, value: l.manager });
    afterEach(() => Reflect.deleteProperty(navigator, 'locks'));

    it('count a page of either version as open', async () => {
      withLocks(fakeLocks([LEGACY_WORKBENCH_LOCK]));
      expect(await workbenchPageOpen()).toBe(true);
      withLocks(fakeLocks([WORKBENCH_LOCK]));
      expect(await workbenchPageOpen()).toBe(true);
      withLocks(fakeLocks(['something-else']));
      expect(await workbenchPageOpen()).toBe(false);
    });
  });
});

/** BroadcastChannels of one fake browser: a message reaches every other channel of the name. */
class Bus {
  static open = new Set<Bus>();
  static posted: { name: string; data: unknown }[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    Bus.open.add(this);
  }
  postMessage(data: unknown): void {
    Bus.posted.push({ name: this.name, data });
    for (const c of Bus.open) if (c !== this && c.name === this.name) c.onmessage?.({ data });
  }
  close(): void {
    Bus.open.delete(this);
  }
}

describe('asking a workbench tab to leave', () => {
  const real = globalThis.BroadcastChannel;
  beforeEach(() => {
    Bus.open.clear();
    Bus.posted = [];
    globalThis.BroadcastChannel = Bus as unknown as typeof BroadcastChannel;
  });
  afterEach(() => {
    globalThis.BroadcastChannel = real;
  });

  it('speaks on both channels, each in the key its listener compares', () => {
    askWorkbenchToLeave('new-key', true, 'old-key');
    expect(Bus.posted).toEqual([
      { name: WORKBENCH_CHANNEL, data: { type: 'leave', account: 'new-key', discard: true } },
      {
        name: LEGACY_WORKBENCH_CHANNEL,
        // The message a tab of 1.4 understands: type, account (its key) and discard.
        data: { type: 'leave', account: 'old-key', copy: true, discard: true },
      },
    ]);
  });

  it('keeps to the current channel when the account has no key of 1.4', () => {
    askWorkbenchToLeave('new-key');
    expect(Bus.posted.map((p) => p.name)).toEqual([WORKBENCH_CHANNEL]);
  });

  it('reaches a tab of 1.4, which listens on the old channel for its own key', () => {
    const old14 = vi.fn();
    const tab = new Bus(LEGACY_WORKBENCH_CHANNEL);
    tab.onmessage = (ev) => {
      const d = ev.data as { type: string; account: string; discard?: boolean };
      if (d.type === 'leave' && d.account === 'old-key') old14(d.discard === true);
    };
    askWorkbenchToLeave('new-key', false, 'old-key');
    expect(old14).toHaveBeenCalledWith(false);
  });

  it('is heard once by a page of this version, which listens on both channels', () => {
    const cb = vi.fn();
    const stop = onLeaveRequest('new-key', cb, 'old-key');
    askWorkbenchToLeave('new-key', true, 'old-key');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);
    stop();
    expect(Bus.open.size).toBe(0);
  });

  it('is obeyed when it comes from a console of 1.4 (old channel, old key)', () => {
    const cb = vi.fn();
    onLeaveRequest('new-key', cb, 'old-key');
    new Bus(LEGACY_WORKBENCH_CHANNEL).postMessage({ type: 'leave', account: 'old-key' });
    expect(cb).toHaveBeenCalledWith(false);
  });

  it("ignores the requests about another account's copies", () => {
    const cb = vi.fn();
    onLeaveRequest('new-key', cb, 'old-key');
    askWorkbenchToLeave('bob-new', false, 'bob-old');
    new Bus(LEGACY_WORKBENCH_CHANNEL).postMessage({ type: 'leave', account: 'new-key' }); // not its old key
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('forgetting an account that 1.4 also knew', () => {
  it('asks, counts and removes under both keys', async () => {
    Bus.open.clear();
    Bus.posted = [];
    const real = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = Bus as unknown as typeof BroadcastChannel;
    try {
      const forget = vi.fn(() => Promise.resolve({ removed: true, busy: false }));
      const unsynced = vi.fn(() => []);
      const r = await forgetAfterLeave('new-key', {
        legacyAccount: 'old-key',
        intervalMs: 0,
        forget,
        unsynced,
        pageOpen: () => Promise.resolve(false),
      });
      expect(r).toEqual({ removed: true, busy: false });
      expect(unsynced).toHaveBeenCalledWith('new-key', 'old-key');
      expect(forget).toHaveBeenCalledWith('new-key', 'old-key');
      expect(Bus.posted.map((p) => p.name)).toEqual([WORKBENCH_CHANNEL, LEGACY_WORKBENCH_CHANNEL]);
    } finally {
      globalThis.BroadcastChannel = real;
    }
  });
});
