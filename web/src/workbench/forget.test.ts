import { describe, expect, it, vi } from 'vitest';
import { forgetAfterLeave, type ForgetResult, type UnsyncedCopy } from './forget';

const copy = (id: string, over: Partial<UnsyncedCopy> = {}): UnsyncedCopy => ({
  id,
  name: id,
  kind: 'shared',
  localPath: `/vaults/${id}`,
  pending: 0,
  conflicts: 0,
  dirty: true,
  updatedAt: 0,
  ...over,
});

/** A scripted browser: what forget answers and what the markers say, call after call. */
function script(o: { forget?: ForgetResult[]; unsynced?: UnsyncedCopy[][]; open?: boolean[] }) {
  const forget = vi.fn(() => Promise.resolve(o.forget?.shift() ?? { removed: true, busy: false }));
  const unsynced = vi.fn(
    () => (o.unsynced && o.unsynced.length > 1 ? o.unsynced.shift() : o.unsynced?.[0]) ?? [],
  );
  const pageOpen = vi.fn(() =>
    Promise.resolve(
      o.open && o.open.length > 1 ? (o.open.shift() as boolean) : (o.open?.[0] ?? false),
    ),
  );
  return { forget, unsynced, pageOpen, intervalMs: 0 };
}

describe('forgetting the browser after the workbench tab left', () => {
  it('removes the copies once the tab released the files and nothing is pending', async () => {
    const s = script({
      forget: [
        { removed: false, busy: true },
        { removed: true, busy: false },
      ],
    });
    const r = await forgetAfterLeave('a1', s);
    expect(r).toEqual({ removed: true, busy: false });
    expect(s.forget).toHaveBeenCalledTimes(2);
  });

  it('waits while the tab is still uploading what its markers list', async () => {
    const s = script({
      unsynced: [[copy('v1')], [copy('v1')], []],
      open: [true, true, false],
    });
    const r = await forgetAfterLeave('a1', s);
    expect(r.removed).toBe(true);
    expect(s.forget).toHaveBeenCalledOnce(); // never while a copy held changes
  });

  it('removes nothing and lists the copies when the tab left with changes it could not upload', async () => {
    const s = script({ unsynced: [[copy('v1', { pending: 2 })]], open: [false] });
    const r = await forgetAfterLeave('a1', s);
    expect(r).toMatchObject({ removed: false, busy: false, unsynced: [{ id: 'v1', pending: 2 }] });
    expect(s.forget).not.toHaveBeenCalled();
  });

  it('says busy, with what is left, when the tab keeps them past the time limit', async () => {
    const s = script({ unsynced: [[copy('v1')]], open: [true] });
    const r = await forgetAfterLeave('a1', { ...s, timeoutMs: 0 });
    expect(r).toMatchObject({ removed: false, busy: true, unsynced: [{ id: 'v1' }] });
    expect(s.forget).not.toHaveBeenCalled();
  });

  it('removes the copies the user already agreed to lose', async () => {
    const s = script({ unsynced: [[copy('v1')]], open: [false] });
    const r = await forgetAfterLeave('a1', { ...s, accepted: ['v1'] });
    expect(r.removed).toBe(true);
    expect(s.forget).toHaveBeenCalledOnce();
  });

  it('checks nothing when the copies must go (the account was deleted)', async () => {
    const s = script({ unsynced: [[copy('v1')]], open: [true] });
    const r = await forgetAfterLeave('a1', { ...s, discard: true });
    expect(r.removed).toBe(true);
    expect(s.unsynced).not.toHaveBeenCalled();
  });
});
