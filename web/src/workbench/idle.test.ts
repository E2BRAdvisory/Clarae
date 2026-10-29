import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchIdle } from './idle';

describe('watchIdle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the idle time', () => {
    const onIdle = vi.fn();
    watchIdle(1000, onIdle);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onIdle).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('is pushed back by any input', () => {
    const onIdle = vi.fn();
    watchIdle(1000, onIdle);
    for (const type of ['pointerdown', 'keydown', 'wheel']) {
      vi.advanceTimersByTime(800);
      document.dispatchEvent(new Event(type));
    }
    vi.advanceTimersByTime(800);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('stops watching when told to', () => {
    const onIdle = vi.fn();
    const stop = watchIdle(1000, onIdle);
    stop();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
