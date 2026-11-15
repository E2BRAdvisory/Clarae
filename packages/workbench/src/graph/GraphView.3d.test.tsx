import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../app/api';
import { runCommand } from '../commands/registry';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { installWailsMock } from '../test/wails-mock';
import { activeTab, emptyLayout } from '../workspace/layout';
import { GraphView } from './GraphView';
import { SPRITE_NODES } from './lod';
import { useGraphMode } from './mode';
import { GRAPH3D_MAX_NODES, useGraphSettings } from './settings';
import type { GraphSurfaceProps } from './surface';
import type { GraphData } from './types';
import { acquire3D, MAX_3D_SURFACES, webgl2Available } from './webgl';
import type * as Webgl from './webgl';

// The scene needs WebGL, which jsdom does not have: the shell is tested with a stand-in surface
// (the real one is covered by apps/desktop/frontend/e2e/graph-3d.spec.ts).
const surface = vi.hoisted(() => ({
  props: null as GraphSurfaceProps | null,
  /** Every answer the surface was given to draw. */
  drawn: [] as unknown[],
  fit: vi.fn(),
  releaseNodes: vi.fn(),
}));
vi.mock('./three/Graph3D', async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import('react');
  return {
    default: forwardRef<unknown, GraphSurfaceProps>(function Graph3DStandIn(props, ref) {
      useImperativeHandle(ref, () => ({ fit: surface.fit, releaseNodes: surface.releaseNodes }));
      useEffect(() => {
        surface.props = props;
        if (props.model) surface.drawn.push(props.model.data);
      });
      return <div data-testid="graph-3d" data-nodes={props.model?.n ?? -1} />;
    }),
  };
});
vi.mock('./webgl', async (original) => ({
  ...(await original<typeof Webgl>()),
  webgl2Available: vi.fn(() => true),
}));

let spy: MockInstance | null = null;

async function openGraphOf(name: string) {
  const mock = installWailsMock();
  const v = await api.vault.open(`/v/${name}`);
  const files = mock.vaults.get(v.id)?.files;
  files?.set('A.md', '[[B]] [[Sketch.excalidraw]]');
  files?.set('B.md', '[[A]]');
  files?.set('Sketch.excalidraw', '{"type":"excalidraw","elements":[]}');
  // What each answer was asked for: its ceiling of nodes (0: the 2D graph, which has none).
  const ceilings = new Map<GraphData, number>();
  const answer = api.graph.build.bind(api.graph);
  const build = vi.spyOn(api.graph, 'build').mockImplementation(async (id, options) => {
    const data = await answer(id, options);
    ceilings.set(data, options.maxNodes);
    return data;
  });
  spy = build;
  render(<GraphView vaultId={v.id} path="graph://global" />);
  return { build, ceilings };
}

describe('GraphView in 3D', () => {
  beforeEach(() => {
    initI18n('en');
    localStorage.clear();
    useGraphSettings.setState({ vaultId: null, loaded: false });
    useGraphMode.setState({ mode: '2d' });
    vi.mocked(webgl2Available).mockReturnValue(true);
    surface.props = null;
    surface.drawn = [];
    surface.releaseNodes.mockClear();
  });
  afterEach(() => {
    spy?.mockRestore(); // the next test wraps the real binding, not this wrapper
    spy = null;
  });

  it('switches surface, asks the core for the 3D ceiling and shows the legend and the 3D options', async () => {
    const { build, ceilings } = await openGraphOf('Switch');
    expect(await screen.findByText('3 nodes, 3 links')).toBeInTheDocument();
    expect(build.mock.lastCall?.[1].maxNodes).toBe(0);
    expect(screen.getByTestId('graph-mode')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Curved two-way links')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('graph-mode'));
    expect(await screen.findByTestId('graph-3d')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-canvas')).not.toBeInTheDocument();
    expect(screen.getByTestId('graph-mode')).toHaveAttribute('aria-pressed', 'true');
    // The 2D answer is not handed to the 3D surface: it waits for one built within its ceiling.
    await waitFor(() => expect(build.mock.lastCall?.[1].maxNodes).toBe(GRAPH3D_MAX_NODES));
    await waitFor(() => expect(screen.getByTestId('graph-3d')).toHaveAttribute('data-nodes', '3'));
    expect(surface.props?.warm).toBe(false);
    expect(surface.drawn.length).toBeGreaterThan(0);
    expect(surface.drawn.map((d) => ceilings.get(d as GraphData))).not.toContain(0);
    const legend = screen.getByRole('list', { name: 'Kinds of document' });
    expect(legend).toHaveTextContent('Notes2');
    expect(legend).toHaveTextContent('Drawings1');
    // The choice is this device's.
    expect(localStorage.getItem('clarae.graph.mode')).toBe('3d');

    // 3D options: the legend can be turned off, the ceiling lowered.
    fireEvent.click(screen.getByLabelText('Legend'));
    expect(screen.queryByRole('list', { name: 'Kinds of document' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Nodes shown (max)'), { target: { value: '1000' } });
    await waitFor(() => expect(build.mock.lastCall?.[1].maxNodes).toBe(1000));

    fireEvent.click(screen.getByTestId('graph-mode'));
    expect(await screen.findByTestId('graph-canvas')).toBeInTheDocument();
    await waitFor(() => expect(build.mock.lastCall?.[1].maxNodes).toBe(0));
    expect(await screen.findByText('3 nodes, 3 links')).toBeInTheDocument();

    // 3D again, its chunk now loaded: the surface is there at once, before the core has answered,
    // and the 2D answer on screen (which knows no ceiling) is not handed to it meanwhile.
    surface.drawn = [];
    fireEvent.click(screen.getByTestId('graph-mode'));
    expect(screen.getByTestId('graph-3d')).toHaveAttribute('data-nodes', '-1');
    await waitFor(() => expect(screen.getByTestId('graph-3d')).toHaveAttribute('data-nodes', '3'));
    expect(surface.drawn.map((d) => ceilings.get(d as GraphData))).not.toContain(0);
  });

  it('shows in the legend the solid of each kind from the size that draws solids, and the icon below it', async () => {
    useGraphMode.setState({ mode: '3d' });
    // More nodes than the level of sprites draws, of several kinds of document.
    const w = window as unknown as Record<string, unknown>;
    w['__CLARAE_GRAPH_FIXTURE__'] = SPRITE_NODES + 1;
    w['__CLARAE_GRAPH_KINDS__'] = true;
    try {
      await openGraphOf('Solids');
      const legend = await screen.findByRole('list', { name: 'Kinds of document' });
      await waitFor(() => expect(surface.props?.model?.n).toBe(SPRITE_NODES + 1));
      expect(legend.querySelector('[data-shape="sphere"]')).not.toBeNull(); // the notes
      expect(legend.querySelector('[data-shape="cube"]')).not.toBeNull(); // the drawings
      expect(legend.querySelector('[data-shape="torus"]')).not.toBeNull(); // the tags
      // Every row has a solid and no icon.
      const rows = legend.querySelectorAll('li');
      expect(rows.length).toBeGreaterThan(3);
      for (const row of rows) expect(row.querySelectorAll('svg[data-shape]')).toHaveLength(1);
      expect(legend.querySelectorAll('svg:not([data-shape])')).toHaveLength(0);
    } finally {
      delete w['__CLARAE_GRAPH_FIXTURE__'];
      delete w['__CLARAE_GRAPH_KINDS__'];
    }
  });

  it('keeps the icons in the legend for a graph of sprites', async () => {
    useGraphMode.setState({ mode: '3d' });
    await openGraphOf('Icons');
    const legend = await screen.findByRole('list', { name: 'Kinds of document' });
    expect(legend.querySelectorAll('svg')).toHaveLength(legend.querySelectorAll('li').length);
    expect(legend.querySelector('[data-shape]')).toBeNull();
  });

  it('offers to release the nodes held in place, and asks the surface to', async () => {
    useGraphMode.setState({ mode: '3d' });
    await openGraphOf('Held');
    await waitFor(() => expect(surface.props?.model?.n).toBe(3));
    expect(screen.queryByLabelText(/Release the nodes/)).not.toBeInTheDocument();
    act(() => surface.props?.onHeldNodes?.(2));
    fireEvent.click(screen.getByLabelText('Release the nodes held in place (2)'));
    expect(surface.releaseNodes).toHaveBeenCalledTimes(1);
    act(() => surface.props?.onHeldNodes?.(0));
    expect(screen.queryByLabelText(/Release the nodes/)).not.toBeInTheDocument();
  });

  it('falls back to 2D with the reason when the surface gives up, and tries again when asked', async () => {
    useGraphMode.setState({ mode: '3d' });
    await openGraphOf('Lost');
    await waitFor(() => expect(surface.props?.model?.n).toBe(3));
    act(() => surface.props?.onUnavailable?.('lost'));
    expect(await screen.findByTestId('graph-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-3d')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('The graphics context was lost');
    expect(await screen.findByText('3 nodes, 3 links')).toBeInTheDocument();
    // Off and on again: another attempt, without the notice.
    fireEvent.click(screen.getByTestId('graph-mode'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('graph-mode'));
    expect(await screen.findByTestId('graph-3d')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays in 2D on a device without WebGL2, and says why', async () => {
    vi.mocked(webgl2Available).mockReturnValue(false);
    useGraphMode.setState({ mode: '3d' });
    const { build } = await openGraphOf('NoGl');
    expect(await screen.findByText('3 nodes, 3 links')).toBeInTheDocument();
    expect(screen.getByTestId('graph-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-3d')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('WebGL2');
    expect(build.mock.lastCall?.[1].maxNodes).toBe(0);
  });
});

describe('3D graph commands and slots', () => {
  beforeEach(() => {
    initI18n('en');
    localStorage.clear();
    useGraphMode.setState({ mode: '2d' });
  });

  it('open the graph in 3D and switch between the two modes', async () => {
    installWailsMock();
    const v = await api.vault.open('/v/Cmd3d');
    useAppStore.setState({ vault: v, layout: emptyLayout() });
    await runCommand('graph:open-3d');
    expect(activeTab(useAppStore.getState().layout)?.path).toBe('graph://global');
    expect(useGraphMode.getState().mode).toBe('3d');
    await runCommand('graph:toggle-3d');
    expect(useGraphMode.getState().mode).toBe('2d');
    expect(localStorage.getItem('clarae.graph.mode')).toBe('2d');
    await runCommand('graph:toggle-3d');
    expect(useGraphMode.getState().mode).toBe('3d');
  });

  it('gives out a limited number of 3D slots, each returned once', () => {
    const held = Array.from({ length: MAX_3D_SURFACES }, () => acquire3D());
    expect(held.every((release) => release !== null)).toBe(true);
    expect(acquire3D()).toBeNull();
    held[0]?.();
    held[0]?.(); // a second call gives nothing back
    const again = acquire3D();
    expect(again).not.toBeNull();
    expect(acquire3D()).toBeNull();
    again?.();
    for (const release of held.slice(1)) release?.();
  });
});
