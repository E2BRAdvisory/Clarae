// The 3D surface of the graph view: a GraphScene (three.js, in this lazy chunk) laid out in three
// dimensions by the layout worker. Same props and gestures as Graph2D; what differs is the camera
// (orbit instead of pan) and that a node can be dragged and stays where it is dropped.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { seedPositions, type PreviousLayout } from '../incremental';
import { edgePairs, WARM_ALPHA } from '../layoutEngine';
import { startLayout, type LayoutHost } from '../layoutHost';
import type { GraphModel } from '../model';
import { readPalette } from '../renderer';
import type { GraphSurfaceHandle, GraphSurfaceProps } from '../surface';
import { acquire3D } from '../webgl';
import { GraphScene } from './scene';

/** Radians the arrow keys turn the camera by. */
const TURN = 0.2;
/** A second click this soon after the one that selected a node is the end of a double click. */
const DOUBLE_CLICK_MS = 500;

const Graph3D = forwardRef<GraphSurfaceHandle, GraphSurfaceProps>(function Graph3D(
  {
    model,
    warm,
    settings,
    visible,
    focusNode,
    onFocusNode,
    onOpenNode,
    label,
    onHeldNodes,
    onUnavailable,
  },
  ref,
) {
  const box = useRef<HTMLDivElement>(null);
  const scene = useRef<GraphScene | null>(null);
  const host = useRef<LayoutHost | null>(null);
  const userMoved = useRef(false);
  /** The nodes the scene's positions belong to, and the heat of their layout (0 = settled). */
  const laidOut = useRef<readonly string[]>([]);
  const layoutAlpha = useRef(0);
  const fitWhenDone = useRef(false);
  /** Nodes the user dragged, by id: they stay where they were dropped, across refreshes too. */
  const held = useRef(new Set<string>());
  /** When a click selected a node, and when one opened a node (a double click does both once). */
  const selectedAt = useRef(0);
  const openedAt = useRef(0);
  const data = model?.data ?? null;
  const latest = useRef({
    model,
    warm,
    focusNode,
    onFocusNode,
    onOpenNode,
    onHeldNodes,
    onUnavailable,
  });
  useEffect(() => {
    latest.current = {
      model,
      warm,
      focusNode,
      onFocusNode,
      onOpenNode,
      onHeldNodes,
      onUnavailable,
    };
  });

  useImperativeHandle(ref, () => ({
    fit: () => {
      userMoved.current = false;
      scene.current?.fit();
    },
    releaseNodes: () => {
      host.current?.release();
      held.current.clear();
      latest.current.onHeldNodes?.(0);
    },
  }));

  // ---- scene lifecycle: one WebGL context for the life of the surface, released with it
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const release = acquire3D();
    if (!release) {
      latest.current.onUnavailable?.('limit');
      return;
    }
    const open = (i: number, newTab: boolean): void => {
      openedAt.current = performance.now();
      latest.current.onOpenNode(i, newTab);
    };
    let s: GraphScene;
    try {
      s = new GraphScene(el, {
        // The first click selects a node and flies to it; a click on the selected node opens it.
        onClick: (i, newTab) => {
          const now = performance.now();
          if (i < 0) {
            // The second click of a double click lands where the node was before the camera moved.
            if (now - selectedAt.current > DOUBLE_CLICK_MS) latest.current.onFocusNode(-1);
          } else if (newTab || i === latest.current.focusNode) open(i, newTab);
          else {
            selectedAt.current = now;
            latest.current.onFocusNode(i);
            s.focus(i);
          }
        },
        onDrag: (i, x, y, z) => host.current?.fix(i, x, y, z),
        onDragEnd: (i, x, y, z) => {
          host.current?.fix(i, x, y, z);
          const id = latest.current.model?.data.nodes[i]?.id;
          if (id === undefined) return;
          held.current.add(id);
          latest.current.onHeldNodes?.(held.current.size);
        },
        onUserMove: () => {
          userMoved.current = true;
        },
        onContextLost: () => latest.current.onUnavailable?.('lost'),
      });
    } catch {
      release();
      latest.current.onUnavailable?.('failed');
      return;
    }
    scene.current = s;
    const onDoubleClick = (): void => {
      const now = performance.now();
      const i = latest.current.focusNode;
      if (i < 0 || now - selectedAt.current > 2 * DOUBLE_CLICK_MS) return;
      if (now - openedAt.current > DOUBLE_CLICK_MS) open(i, false);
    };
    el.addEventListener('dblclick', onDoubleClick);
    return () => {
      el.removeEventListener('dblclick', onDoubleClick);
      s.dispose();
      scene.current = null;
      release();
    };
  }, []);

  // Theme-aware colours: read from CSS tokens, again whenever the theme changes.
  const groupColors = settings.groups.map((g) => g.color).join(',');
  useEffect(() => {
    const apply = (): void => {
      const el = box.current;
      if (el) scene.current?.setPalette(readPalette(el, groupColors ? groupColors.split(',') : []));
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener('change', apply);
    return () => {
      mo.disconnect();
      mq?.removeEventListener('change', apply);
    };
  }, [groupColors]);

  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    s.labelZoom = settings.labelZoom;
    s.wake();
  }, [settings.labelZoom]);

  useEffect(() => {
    scene.current?.setCurved(settings.curvedLinks);
  }, [settings.curvedLinks]);

  // ---- layout (restarts when the nodes or links change, not when only the node size does)
  const forcesRef = useRef(settings.forces);
  useEffect(() => {
    forcesRef.current = settings.forces;
  });
  useEffect(() => {
    const s = scene.current;
    const el = box.current;
    const m = latest.current.model;
    if (!s || !el || !m) return;
    // A refresh keeps the nodes where they are and the camera where the user left it; new options
    // lay the graph out from scratch and fit it.
    const prev: PreviousLayout = { ids: laidOut.current, positions: s.positions };
    const seed = latest.current.warm ? seedPositions(prev, m, 3) : null;
    laidOut.current = m.data.nodes.map((nd) => nd.id);
    s.setModel(m, seed);
    el.dataset['graphSettled'] = '0';
    if (!seed) {
      userMoved.current = false;
      fitWhenDone.current = true;
      held.current.clear();
      latest.current.onHeldNodes?.(0);
    }
    if (m.n === 0) {
      el.dataset['graphSettled'] = '1';
      return;
    }
    const t0 = performance.now();
    let first = !seed;
    const onPositions = (pos: Float32Array, alpha: number, done: boolean): void => {
      s.setPositions(pos);
      layoutAlpha.current = done ? 0 : alpha;
      if ((first || (done && fitWhenDone.current)) && !userMoved.current) s.fit(!first);
      first = false;
      if (done) fitWhenDone.current = false;
      el.dataset['graphSettled'] = done ? '1' : '0';
      const st = window.__graphStats;
      if (st) {
        st.ticks++;
        st.nodes = m.n;
        st.edges = m.data.edges.length;
        if (done) st.layoutMs = performance.now() - t0;
      }
    };
    // A layout interrupted while still spreading out continues at its own heat.
    const from = seed
      ? { positions: seed, alpha: Math.max(WARM_ALPHA, layoutAlpha.current) }
      : undefined;
    const h = startLayout(m.n, edgePairs(m.data.edges), forcesRef.current, onPositions, from, 3);
    // What the user put somewhere stays there in the refreshed graph (a node that is gone is forgotten).
    if (seed) {
      const index = new Map(m.data.nodes.map((nd, i) => [nd.id, i]));
      for (const id of [...held.current]) {
        const i = index.get(id);
        if (i === undefined || !Number.isFinite(seed[3 * i])) held.current.delete(id);
        else h.fix(i, seed[3 * i] as number, seed[3 * i + 1] as number, seed[3 * i + 2] as number);
      }
      latest.current.onHeldNodes?.(held.current.size);
    }
    host.current = h;
    return () => {
      h.dispose();
      host.current = null;
    };
  }, [data]);

  // The radius depends on nodeSize: same layout, new model.
  useEffect(() => {
    if (model) scene.current?.resize(model);
  }, [model]);

  useEffect(() => {
    scene.current?.setSelected(focusNode);
  }, [model, focusNode]);

  useEffect(() => {
    host.current?.setForces(settings.forces);
  }, [settings.forces]);

  // ---- timelapse
  useEffect(() => {
    scene.current?.setVisible(visible);
  }, [model, visible]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const s = scene.current;
    const m: GraphModel | null = latest.current.model;
    if (!s || !m) return;
    const key = e.key;
    const turn = (azimuth: number, polar: number, zoom = 1): void => {
      userMoved.current = true;
      s.orbit(azimuth, polar, zoom);
    };
    if (key === 'ArrowLeft') turn(-TURN, 0);
    else if (key === 'ArrowRight') turn(TURN, 0);
    else if (key === 'ArrowUp') turn(0, -TURN);
    else if (key === 'ArrowDown') turn(0, TURN);
    else if (key === '+' || key === '=') turn(0, 0, 0.8);
    else if (key === '-') turn(0, 0, 1.25);
    else if (key === '0') {
      userMoved.current = false;
      s.fit();
    } else if ((key === '[' || key === ']') && m.n > 0) {
      // Walk the nodes from the most to the least connected one.
      const order = Array.from({ length: m.n }, (_, i) => i).sort(
        (a, b) => (m.degree[b] as number) - (m.degree[a] as number),
      );
      const at = order.indexOf(focusNode);
      const next = order[(at + (key === ']' ? 1 : -1) + order.length) % order.length] ?? -1;
      onFocusNode(next);
      userMoved.current = true;
      s.focus(next);
    } else if (key === 'Enter' && focusNode >= 0) onOpenNode(focusNode, e.metaKey || e.ctrlKey);
    else if (key === 'Escape' && focusNode >= 0) onFocusNode(-1);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="graph-surface graph3d"
      ref={box}
      tabIndex={0}
      role="application"
      aria-label={label}
      data-testid="graph-3d"
      data-graph-mode="3d"
      onKeyDown={onKeyDown}
    />
  );
});

export default Graph3D;
