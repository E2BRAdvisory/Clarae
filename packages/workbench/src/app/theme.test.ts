import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { applyTheme, currentTheme, watchTheme } from './theme';
import { useEffectiveTheme } from './useTheme';

/** The colour scheme of the "operating system", which the test flips while the app is open. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  };
  vi.stubGlobal('matchMedia', () => media);
  return {
    set(next: boolean) {
      dark = next;
      listeners.forEach((l) => l());
    },
    listeners: () => listeners.size,
  };
}

beforeEach(() => applyTheme('system'));
afterEach(() => {
  applyTheme('system');
  vi.unstubAllGlobals();
});

describe('the theme in force', () => {
  it('is the one set, or the system one for "system"', () => {
    fakeSystem(true);
    expect(currentTheme()).toBe('dark');
    applyTheme('light');
    expect(currentTheme()).toBe('light');
    applyTheme('dark');
    expect(currentTheme()).toBe('dark');
  });

  it('is watched for a change of the setting', async () => {
    fakeSystem(false);
    const seen = vi.fn();
    const stop = watchTheme(seen);
    applyTheme('dark');
    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
    stop();
    seen.mockClear();
    applyTheme('light');
    await Promise.resolve();
    expect(seen).not.toHaveBeenCalled();
  });

  it('is watched for a change of the system while the app is open, and no longer after', () => {
    const system = fakeSystem(false);
    const seen = vi.fn();
    const stop = watchTheme(seen);
    system.set(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(currentTheme()).toBe('dark');
    stop();
    expect(system.listeners()).toBe(0);
  });

  it('reaches a component live: "system" follows the OS, a fixed theme does not', async () => {
    const system = fakeSystem(false);
    const { result, unmount } = renderHook(() => useEffectiveTheme());
    expect(result.current).toBe('light');
    act(() => system.set(true));
    expect(result.current).toBe('dark');

    act(() => applyTheme('light'));
    await vi.waitFor(() => expect(result.current).toBe('light'));
    act(() => system.set(false));
    act(() => system.set(true)); // the OS goes dark again: the setting says light
    expect(result.current).toBe('light');
    unmount();
    expect(system.listeners()).toBe(0);
  });
});
