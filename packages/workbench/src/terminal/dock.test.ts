import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampSize, DOCK_DEFAULT, DOCK_KEY, DOCK_MAX, DOCK_MIN, readDock, writeDock } from './dock';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('dock preferences', () => {
  it('start at the bottom with the default size', () => {
    expect(readDock()).toEqual(DOCK_DEFAULT);
  });

  it('are read back as stored', () => {
    writeDock({ position: 'right', size: 410 });
    expect(readDock()).toEqual({ position: 'right', size: 410 });
  });

  it('fall back on damaged or out-of-range data', () => {
    localStorage.setItem(DOCK_KEY, '{not json');
    expect(readDock()).toEqual(DOCK_DEFAULT);
    localStorage.setItem(DOCK_KEY, JSON.stringify({ position: 'top', size: 'big' }));
    expect(readDock()).toEqual(DOCK_DEFAULT);
    localStorage.setItem(DOCK_KEY, JSON.stringify({ position: 'left', size: 99999 }));
    expect(readDock()).toEqual({ position: 'left', size: DOCK_MAX });
    localStorage.setItem(DOCK_KEY, 'null');
    expect(readDock()).toEqual(DOCK_DEFAULT);
  });

  it('survive a storage that throws on read and on write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(readDock()).toEqual(DOCK_DEFAULT);
    expect(() => writeDock({ position: 'left', size: 300 })).not.toThrow();
  });

  it('keep the size in range', () => {
    expect(clampSize(10)).toBe(DOCK_MIN);
    expect(clampSize(1e9)).toBe(DOCK_MAX);
    expect(clampSize(Number.NaN)).toBe(DOCK_DEFAULT.size);
    expect(clampSize('200')).toBe(DOCK_DEFAULT.size);
    expect(clampSize(250.6)).toBe(251);
  });
});
