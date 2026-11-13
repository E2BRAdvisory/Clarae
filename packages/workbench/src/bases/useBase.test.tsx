// A base (opened or embedded in a note) and the vault changing under it: settings writes are
// ignored, bursts run the query once, and a change during a slow run waits for it instead of
// starting another one on the core (BasesAPI.Run may take seconds on a large vault).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { baseNeedsRefresh, REFRESH_MS, useBase } from './useBase';

const BASE = `views:
  - type: table
    name: All
`;

let mock: WailsMock;
let vaultId: string;

function changed(paths: string[]): void {
  act(() =>
    mock.emit('vault:file-changed', {
      vaultId,
      paths,
      changes: paths.map((path) => ({ type: 'modify', path })),
    }),
  );
}

/** Lets timers fire and React commit in between. */
async function wait(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 50) await act(() => vi.advanceTimersByTimeAsync(50));
}

describe('useBase refresh', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    initI18n('en');
    mock = installWailsMock();
    vaultId = (await api.vault.open('/v/Bases')).id;
    const files = mock.vaults.get(vaultId)?.files;
    files?.set('Tasks.base', BASE);
    files?.set('A.md', '---\nstatus: open\n---\n');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('tells the changes that can alter a result', () => {
    const batch = (path: string) => ({
      vaultId,
      unknown: false,
      paths: [path],
      changes: [{ type: 'modify' as const, path }],
    });
    expect(baseNeedsRefresh(batch('.clarae/workspace.json'))).toBe(false);
    expect(baseNeedsRefresh(batch('A.md'))).toBe(true);
    expect(baseNeedsRefresh(batch('img/a.png'))).toBe(true);
    expect(baseNeedsRefresh({ vaultId, unknown: true, paths: [], changes: [] })).toBe(true);
  });

  it('runs once per burst and never for the app settings', async () => {
    const run = vi.spyOn(api.bases, 'run');
    const { result } = renderHook(() =>
      useBase({ vaultId, path: 'Tasks.base', thisPath: 'Tasks.base' }),
    );
    await wait(200);
    expect(result.current.result).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    const first = result.current.result;

    changed(['.clarae/workspace.json']);
    await wait(REFRESH_MS + 300);
    expect(run).toHaveBeenCalledTimes(1);

    // Five autosaves in a row: one run, and an unchanged result keeps the same object.
    for (let i = 0; i < 5; i++) {
      changed(['B.md']);
      await wait(100);
    }
    await wait(REFRESH_MS + 300);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.current.result).toBe(first);
  });

  it('queues the changes that arrive during a slow run', async () => {
    const real = api.bases.run.bind(api.bases);
    let release: (() => void) | null = null;
    let inFlight = 0;
    let maxInFlight = 0;
    const run = vi.spyOn(api.bases, 'run').mockImplementation(async (...a) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // The first refresh is slow: it waits until released.
      if (run.mock.calls.length === 2) await new Promise<void>((r) => (release = r));
      try {
        return await real(...a);
      } finally {
        inFlight--;
      }
    });
    renderHook(() => useBase({ vaultId, path: 'Tasks.base', thisPath: 'Tasks.base' }));
    await wait(200);
    expect(run).toHaveBeenCalledTimes(1);

    changed(['A.md']);
    await wait(REFRESH_MS + 100);
    expect(run).toHaveBeenCalledTimes(2); // the slow one
    for (let i = 0; i < 3; i++) {
      changed(['A.md']);
      await wait(REFRESH_MS + 100);
    }
    expect(run).toHaveBeenCalledTimes(2); // the others wait for it
    act(() => (release as unknown as () => void)());
    await wait(200);
    expect(run).toHaveBeenCalledTimes(3); // one run for all of them
    expect(maxInFlight).toBe(1);
  });
});
