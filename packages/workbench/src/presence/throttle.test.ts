import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttleLatest } from './throttle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('throttleLatest', () => {
  it('sends the first call at once and the last of a burst when the window ends', () => {
    const calls: number[] = [];
    const f = throttleLatest(
      (n: number) => calls.push(n),
      40,
      () => Date.now(),
    );
    f(1);
    f(2);
    f(3);
    expect(calls).toEqual([1]);
    vi.advanceTimersByTime(39);
    expect(calls).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([1, 3]);
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([1, 3]); // nothing more was asked
  });

  it('sends at most one call per window, whatever the rate', () => {
    const calls: number[] = [];
    const f = throttleLatest(
      (n: number) => calls.push(n),
      40,
      () => Date.now(),
    );
    for (let t = 0; t < 400; t += 5) {
      f(t);
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(100);
    expect(calls.length).toBeLessThanOrEqual(11);
    expect(calls.at(-1)).toBe(395); // the latest position is never lost
  });

  it('goes again at once after a quiet window', () => {
    const calls: number[] = [];
    const f = throttleLatest(
      (n: number) => calls.push(n),
      40,
      () => Date.now(),
    );
    f(1);
    vi.advanceTimersByTime(100);
    f(2);
    expect(calls).toEqual([1, 2]);
  });

  it('cancel drops what is waiting', () => {
    const calls: number[] = [];
    const f = throttleLatest(
      (n: number) => calls.push(n),
      40,
      () => Date.now(),
    );
    f(1);
    f(2);
    f.cancel();
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([1]);
  });
});
