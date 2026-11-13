// An open graph and the vault changing under it: the app's own autosaves and settings writes must
// not rebuild it, an edit that leaves the links alone must not lay it out again, and a real change
// continues from the positions on screen instead of starting over.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { GraphView } from './GraphView';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useGraphSettings } from './settings';
import * as layoutHost from './layoutHost';

type LayoutHostModule = typeof layoutHost;

vi.mock('./layoutHost', async (importOriginal) => {
  const orig = await importOriginal<LayoutHostModule>();
  return { ...orig, startLayout: vi.fn(orig.startLayout) };
});
const startLayout = vi.mocked(layoutHost.startLayout);

/** A 2D context whose every method does nothing: enough for the renderer to run in jsdom. */
function fakeContext(): CanvasRenderingContext2D {
  const noop = (): void => {};
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : noop),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

let mock: WailsMock;
let vaultId: string;
let builds: number;

function changed(changes: { type: 'create' | 'modify' | 'delete'; path: string }[]): void {
  act(() =>
    mock.emit('vault:file-changed', {
      vaultId,
      paths: changes.map((c) => c.path),
      changes: changes.map((c) => ({
        ...c,
        ...(c.type === 'delete'
          ? {}
          : {
              entry: {
                path: c.path,
                name: c.path,
                isDir: false,
                kind: 'md',
                size: 1,
                mtime: new Date().toISOString(),
              },
            }),
      })),
    }),
  );
}

/** Past the coalescing, the refresh debounce and the build debounce (React commits in between). */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(() => vi.advanceTimersByTimeAsync(250));
}

describe('GraphView refresh', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    initI18n('en');
    useGraphSettings.setState({ vaultId: null, loaded: false });
    mock = installWailsMock();
    vaultId = (await api.vault.open('/v/Refresh')).id;
    const files = mock.vaults.get(vaultId)?.files;
    files?.set('A.md', '[[B]]');
    files?.set('B.md', 'end');
    builds = 0;
    const build = api.graph.build.bind(api.graph);
    vi.spyOn(api.graph, 'build').mockImplementation((...a) => {
      builds++;
      return build(...a);
    });
    startLayout.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ignores settings writes and content-only edits, and continues the layout after a real change', async () => {
    render(<GraphView vaultId={vaultId} path="graph://global" />);
    await settle();
    expect(screen.getByText('2 nodes, 1 links')).toBeInTheDocument();
    expect(startLayout).toHaveBeenCalledTimes(1);
    expect(startLayout.mock.calls[0]?.[4]).toBeUndefined(); // the first layout starts from scratch
    const buildsAtStart = builds;

    // The workspace layout and the graph settings are saved by the app itself.
    changed([{ type: 'modify', path: '.clarae/workspace.json' }]);
    await settle();
    expect(builds).toBe(buildsAtStart);

    // An autosave of a note whose links did not change: built again, but not laid out again.
    mock.vaults.get(vaultId)?.files.set('A.md', '[[B]] more text');
    changed([{ type: 'modify', path: 'A.md' }]);
    await settle();
    expect(builds).toBe(buildsAtStart + 1);
    expect(startLayout).toHaveBeenCalledTimes(1);

    // A new linked note: the layout continues from where the nodes are.
    const files = mock.vaults.get(vaultId)?.files;
    files?.set('C.md', 'new');
    files?.set('A.md', '[[B]] [[C]]');
    changed([
      { type: 'create', path: 'C.md' },
      { type: 'modify', path: 'A.md' },
    ]);
    await settle();
    expect(screen.getByText('3 nodes, 2 links')).toBeInTheDocument();
    expect(startLayout).toHaveBeenCalledTimes(2);
    const warm = startLayout.mock.calls[1]?.[4];
    expect(warm).toBeDefined();
    // A and B keep a position; the new note C starts next to its neighbour A.
    const seed = Array.from(warm?.positions ?? []);
    expect(seed.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('lays the graph out from scratch when the options change', async () => {
    mock.vaults.get(vaultId)?.files.set('Lonely.md', 'alone');
    render(<GraphView vaultId={vaultId} path="graph://global" />);
    await settle();
    expect(screen.getByText('3 nodes, 1 links')).toBeInTheDocument();
    act(() => useGraphSettings.getState().update({ showOrphans: false }));
    await settle();
    expect(screen.getByText('2 nodes, 1 links')).toBeInTheDocument();
    expect(startLayout).toHaveBeenCalledTimes(2);
    expect(startLayout.mock.calls[1]?.[4]).toBeUndefined();
  });
});
