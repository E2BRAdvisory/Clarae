// The 2D surface of the graph view: a canvas drawn by GraphRenderer, laid out by d3-force in a
// Web Worker (layoutHost). Pan, zoom, hover and the keyboard live here; the data, the filters and
// the toolbar are GraphView's.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { startLayout, type LayoutHost } from './layoutHost';
import { edgePairs, WARM_ALPHA } from './layoutEngine';
import { seedPositions, type PreviousLayout } from './incremental';
import type { GraphModel } from './model';
import { GraphRenderer, readPalette } from './renderer';
import type { GraphSurfaceHandle, GraphSurfaceProps } from './surface';
import { fitView, panBy, zoomAt } from './view';

declare global {
  interface Window {
    /** Frame statistics, exposed to the benchmark harness in E2E builds only. */
    __graphStats?: {
      frames: number[];
      layoutMs: number;
      nodes: number;
      edges: number;
      ticks: number;
    };
  }
}

export const Graph2D = forwardRef<GraphSurfaceHandle, GraphSurfaceProps>(function Graph2D(
  { model, warm, settings, visible, focusNode, onFocusNode, onOpenNode, label },
  ref,
) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<GraphRenderer | null>(null);
  const dirty = useRef(true);
  const host = useRef<LayoutHost | null>(null);
  const userMoved = useRef(false);
  const gestureTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The nodes the renderer's positions belong to, and the heat of their layout (0 = settled). */
  const laidOut = useRef<readonly string[]>([]);
  const layoutAlpha = useRef(0);
  /** A layout from scratch fits the view once it settles, unless the user moved it first. */
  const fitWhenDone = useRef(false);
  const data = model?.data ?? null;
  const modelRef = useRef<GraphModel | null>(null);
  const warmRef = useRef(warm);
  useEffect(() => {
    modelRef.current = model;
    warmRef.current = warm;
  });

  useImperativeHandle(ref, () => ({
    fit: () => {
      const r = renderer.current;
      const m = modelRef.current;
      if (!r || !m) return;
      userMoved.current = false;
      r.view = fitView(r.positions, m.n, r.size.w, r.size.h);
      dirty.current = true;
    },
    releaseNodes: () => undefined, // nothing is held: a 2D node cannot be dragged
  }));

  // ---- renderer lifecycle
  useEffect(() => {
    const el = canvas.current;
    const box = wrap.current;
    if (!el || !box) return;
    let r: GraphRenderer;
    try {
      r = new GraphRenderer(el);
    } catch {
      return; // no 2D canvas (unit tests): the view still renders its controls and status
    }
    renderer.current = r;
    const size = (): void => {
      r.resize(box.clientWidth, box.clientHeight, window.devicePixelRatio || 1);
      dirty.current = true;
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(box);
    let raf = 0;
    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      if (!dirty.current) return;
      dirty.current = false;
      const t0 = performance.now();
      const f = r.gesturing ? r.quickDraw() : r.draw();
      const st = window.__graphStats;
      if (st) {
        r.flush(); // benchmark mode: include raster time
        st.frames.push(performance.now() - t0);
        st.nodes = f.nodes;
        st.edges = f.edges;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.current = null;
    };
  }, []);

  // Theme-aware colours: read from CSS tokens, again whenever the theme changes.
  const groupColors = settings.groups.map((g) => g.color).join(',');
  useEffect(() => {
    const apply = (): void => {
      const r = renderer.current;
      const el = wrap.current;
      if (!r || !el) return;
      r.palette = readPalette(el, groupColors ? groupColors.split(',') : []);
      dirty.current = true;
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
    const r = renderer.current;
    if (!r) return;
    r.labelZoom = settings.labelZoom;
    dirty.current = true;
  }, [settings.labelZoom]);

  // ---- layout (restarts when the nodes or links change, not when only the node size does)
  const forcesRef = useRef(settings.forces);
  useEffect(() => {
    forcesRef.current = settings.forces;
  });
  useEffect(() => {
    const r = renderer.current;
    const m = modelRef.current;
    if (!r || !m) return;
    // A refresh keeps the nodes where they are and the view where the user left it; new options
    // (filters, depth, another centre) lay the graph out from scratch and fit it.
    const prev: PreviousLayout = { ids: laidOut.current, positions: r.positions };
    const seed = warmRef.current ? seedPositions(prev, m) : null;
    laidOut.current = m.data.nodes.map((nd) => nd.id);
    r.setModel(m);
    // Never draw the new model with the old indexes: until the layout posts, the kept nodes stay
    // where they were (the others appear with the first post).
    r.positions = seed ?? new Float32Array(0);
    if (!seed) {
      userMoved.current = false;
      fitWhenDone.current = true;
    }
    if (m.n === 0) {
      r.positions = new Float32Array(0);
      dirty.current = true;
      return;
    }
    const t0 = performance.now();
    let first = !seed;
    const onPositions = (pos: Float32Array, alpha: number, done: boolean): void => {
      r.positions = pos;
      layoutAlpha.current = done ? 0 : alpha;
      if ((first || (done && fitWhenDone.current)) && !userMoved.current) {
        const { w, h: hh } = r.size;
        r.view = fitView(pos, m.n, w, hh);
      }
      first = false;
      if (done) fitWhenDone.current = false;
      const st = window.__graphStats;
      if (st) {
        st.ticks++;
        if (done) st.layoutMs = performance.now() - t0;
      }
      dirty.current = true;
    };
    // A layout interrupted while still spreading out continues at its own heat.
    const warm = seed
      ? { positions: seed, alpha: Math.max(WARM_ALPHA, layoutAlpha.current) }
      : undefined;
    const h = startLayout(m.n, edgePairs(m.data.edges), forcesRef.current, onPositions, warm);
    host.current = h;
    return () => {
      h.dispose();
      host.current = null;
    };
  }, [data]);

  // The radius depends on nodeSize: same layout, new model.
  useEffect(() => {
    if (model) renderer.current?.setModel(model);
    dirty.current = true;
  }, [model]);

  useEffect(() => {
    renderer.current?.setSelected(focusNode);
    dirty.current = true;
  }, [model, focusNode]);

  useEffect(() => {
    host.current?.setForces(settings.forces);
  }, [settings.forces]);

  // ---- timelapse
  useEffect(() => {
    renderer.current?.setVisible(visible);
    dirty.current = true;
  }, [model, visible]);

  // ---- interaction
  const point = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const b = wrap.current?.getBoundingClientRect();
    return { x: e.clientX - (b?.left ?? 0), y: e.clientY - (b?.top ?? 0) };
  };
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const setHover = (i: number): void => {
    const r = renderer.current;
    if (!r || r.hovered === i) return;
    r.setHover(i);
    dirty.current = true;
  };
  const move = (v: ReturnType<typeof panBy>): void => {
    const r = renderer.current;
    if (!r) return;
    r.startGesture();
    r.view = v;
    userMoved.current = true;
    dirty.current = true;
    clearTimeout(gestureTimer.current);
    gestureTimer.current = setTimeout(() => {
      renderer.current?.endGesture();
      dirty.current = true;
    }, 150);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const r = renderer.current;
    const m = modelRef.current;
    if (!r || !m) return;
    const { w, h } = r.size;
    const step = 60;
    const key = e.key;
    if (key === 'ArrowLeft') move(panBy(r.view, step, 0));
    else if (key === 'ArrowRight') move(panBy(r.view, -step, 0));
    else if (key === 'ArrowUp') move(panBy(r.view, 0, step));
    else if (key === 'ArrowDown') move(panBy(r.view, 0, -step));
    else if (key === '+' || key === '=') move(zoomAt(r.view, w / 2, h / 2, 1.25));
    else if (key === '-') move(zoomAt(r.view, w / 2, h / 2, 0.8));
    else if (key === '0') {
      userMoved.current = false;
      r.view = fitView(r.positions, m.n, w, h);
      dirty.current = true;
    } else if (key === '[' || key === ']') {
      // Walk the nodes from the most to the least connected one.
      const order = Array.from({ length: m.n }, (_, i) => i).sort(
        (a, b) => (m.degree[b] as number) - (m.degree[a] as number),
      );
      const at = order.indexOf(focusNode);
      const next = order[(at + (key === ']' ? 1 : -1) + order.length) % order.length] ?? -1;
      onFocusNode(next);
      r.setSelected(next);
      setHover(next);
      const x = r.positions[2 * next] as number;
      const y = r.positions[2 * next + 1] as number;
      move({
        k: Math.max(r.view.k, settings.labelZoom),
        x: w / 2 - x * Math.max(r.view.k, settings.labelZoom),
        y: h / 2 - y * Math.max(r.view.k, settings.labelZoom),
      });
    } else if (key === 'Enter' && focusNode >= 0) onOpenNode(focusNode, e.metaKey || e.ctrlKey);
    else return;
    e.preventDefault();
  };

  return (
    <div className="graph-surface" ref={wrap} data-graph-mode="2d">
      <canvas
        ref={canvas}
        tabIndex={0}
        role="application"
        aria-label={label}
        data-testid="graph-canvas"
        onKeyDown={onKeyDown}
        onWheel={(e) => {
          const r = renderer.current;
          if (!r) return;
          const p = point(e);
          move(zoomAt(r.view, p.x, p.y, Math.exp(-e.deltaY * 0.0015)));
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          const r = renderer.current;
          if (!r) return;
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
            if (d.moved) {
              move(panBy(r.view, dx, dy));
              d.x = e.clientX;
              d.y = e.clientY;
            }
            return;
          }
          const p = point(e);
          setHover(r.hit(p.x, p.y));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          const r = renderer.current;
          if (!d || d.moved || !r) return;
          const p = point(e);
          const i = r.hit(p.x, p.y);
          if (i >= 0) onOpenNode(i, e.metaKey || e.ctrlKey);
        }}
        onPointerLeave={() => setHover(-1)}
      />
    </div>
  );
});
