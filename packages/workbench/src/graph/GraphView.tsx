import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18next } from '../i18n';
import { api } from '../app/api';
import { openOrCreate } from '../app/actions';
import { onVaultChanges } from '../app/fileChanges';
import { infoOf, useSync } from '../state/sync';
import { useAppStore } from '../state/store';
import { errorMessage } from '../util/errors';
import { GraphPanel } from './GraphPanel';
import { startLayout, type LayoutHost } from './layoutHost';
import { edgePairs, WARM_ALPHA } from './layoutEngine';
import { graphNeedsReload, sameGraph, seedPositions, type PreviousLayout } from './incremental';
import { buildModel, timelapseTime, visibleAt, type GraphModel } from './model';
import { graphCenter } from './paths';
import { GraphRenderer, readPalette } from './renderer';
import { useGraphSettings, type GraphSettings } from './settings';
import type { GraphData, GraphOptions } from './types';
import { fitView, panBy, zoomAt } from './view';
import { Icon } from '../shell/icons';

/** Options sent to GraphAPI.Build for the current settings. */
export function optionsFor(s: GraphSettings, center: string | null): GraphOptions {
  return {
    query: s.query,
    tags: s.tags,
    folders: s.folders,
    excludeFolders: [],
    showOrphans: s.showOrphans,
    showGhosts: s.showGhosts,
    showAttachments: s.showAttachments,
    showTags: s.showTags,
    center: center ?? '',
    depth: center ? s.localDepth : 0,
    direction: center ? s.localDirection : 'both',
    groups: s.groups.map((g) => g.query),
    maxNodes: 0,
  };
}

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

export function GraphView({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const center = graphCenter(path);
  const settings = useGraphSettings((s) => s.settings);
  const loaded = useGraphSettings((s) => s.loaded);
  const update = useGraphSettings((s) => s.update);
  const openNote = useAppStore((s) => s.openNote);
  const search = useAppStore((s) => s.search);
  const readOnly = useSync((s) => infoOf(s, vaultId).readOnly);

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<GraphRenderer | null>(null);
  const dirty = useRef(true);
  const host = useRef<LayoutHost | null>(null);
  const userMoved = useRef(false);
  const gestureTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState(true);
  const [progress, setProgress] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [reload, setReload] = useState(0);
  /** The node walked to with [ and ], by id: indexes change when the graph does. */
  const [focusId, setFocusId] = useState<string | null>(null);
  /** The next layout continues from the current one (a refresh, not new options). */
  const warmNext = useRef(false);
  /** The answer on screen and the vault and options it was built for. */
  const onScreen = useRef<{ key: string; data: GraphData } | null>(null);
  /** The nodes the renderer's positions belong to, and the heat of their layout (0 = settled). */
  const laidOut = useRef<readonly string[]>([]);
  const layoutAlpha = useRef(0);
  /** A layout from scratch fits the view once it settles, unless the user moved it first. */
  const fitWhenDone = useRef(false);

  useEffect(() => {
    void useGraphSettings.getState().load(vaultId);
  }, [vaultId]);

  // ---- data (debounced while the user types a query)
  const options = useMemo(() => optionsFor(settings, center), [settings, center]);
  const optionsKey = JSON.stringify(options);
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const key = `${vaultId}\n${optionsKey}`;
    const timer = setTimeout(() => {
      api.graph
        .build(vaultId, JSON.parse(optionsKey) as GraphOptions)
        .then((d) => {
          if (cancelled) return;
          setError('');
          // Same options as the graph on screen: a refresh after file changes. Same nodes and
          // links: nothing to redraw; otherwise the layout continues from the current positions.
          const prev = onScreen.current;
          const refresh = prev?.key === key;
          if (refresh && sameGraph(prev.data, d)) return;
          warmNext.current = refresh;
          onScreen.current = { key, data: d };
          setData(d);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(errorMessage(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vaultId, optionsKey, loaded, reload]);

  // The index changed (note created, renamed, edited): rebuild, coalescing bursts. Changes that
  // cannot alter nodes or links (settings under .clarae/, an edited attachment) are ignored.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onVaultChanges((batch) => {
      if (batch.vaultId !== vaultId || !graphNeedsReload(batch)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setReload((n) => n + 1), 1500);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [vaultId]);

  const nodeSize = settings.nodeSize;
  const model: GraphModel | null = useMemo(
    () => (data ? buildModel(data, nodeSize) : null),
    [data, nodeSize],
  );
  const modelRef = useRef<GraphModel | null>(null);
  useEffect(() => {
    modelRef.current = model;
  });

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
    const seed = warmNext.current ? seedPositions(prev, m) : null;
    warmNext.current = false;
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

  // The node walked to with the keyboard, found again in a changed graph (-1 once it is gone).
  const focusNode = useMemo(
    () => (model && focusId !== null ? model.data.nodes.findIndex((nd) => nd.id === focusId) : -1),
    [model, focusId],
  );
  useEffect(() => {
    renderer.current?.setSelected(focusNode);
    dirty.current = true;
  }, [model, focusNode]);

  useEffect(() => {
    host.current?.setForces(settings.forces);
  }, [settings.forces]);

  // ---- timelapse
  useEffect(() => {
    if (!model) return;
    renderer.current?.setVisible(visibleAt(model, progress));
    dirty.current = true;
  }, [model, progress]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let p = progress >= 1 ? 0 : progress;
    const step = (now: number): void => {
      p = Math.min(1, p + (now - last) / 1000 / settings.timelapseSeconds);
      last = now;
      setProgress(p);
      if (p >= 1) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- progress is the clock, not an input
  }, [playing, settings.timelapseSeconds]);

  // ---- interaction
  const openNodeAt = useCallback(
    (i: number, newTab: boolean) => {
      const nd = modelRef.current?.data.nodes[i];
      if (!nd) return;
      if (nd.kind === 'tag') search(`tag:#${nd.id.slice(4)}`);
      else if (nd.kind === 'ghost') {
        if (!readOnly)
          void openOrCreate(center ?? '', { target: nd.label, heading: '', block: '' }, newTab);
      } else openNote(nd.path, { newTab });
    },
    [center, openNote, search, readOnly],
  );

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
      setFocusId(m.data.nodes[next]?.id ?? null);
      r.setSelected(next);
      setHover(next);
      const x = r.positions[2 * next] as number;
      const y = r.positions[2 * next + 1] as number;
      move({
        k: Math.max(r.view.k, settings.labelZoom),
        x: w / 2 - x * Math.max(r.view.k, settings.labelZoom),
        y: h / 2 - y * Math.max(r.view.k, settings.labelZoom),
      });
    } else if (key === 'Enter' && focusNode >= 0) openNodeAt(focusNode, e.metaKey || e.ctrlKey);
    else return;
    e.preventDefault();
  };

  const shown = model?.n ?? 0;
  const lapseTime = model && progress < 1 ? timelapseTime(model, progress) : null;

  return (
    <div className="graph-view">
      <div className="graph-canvas" ref={wrap}>
        <canvas
          ref={canvas}
          tabIndex={0}
          role="application"
          aria-label={t('graph.canvasLabel')}
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
            if (i >= 0) openNodeAt(i, e.metaKey || e.ctrlKey);
          }}
          onPointerLeave={() => setHover(-1)}
        />
        <div className="graph-toolbar">
          <button
            type="button"
            title={playing ? t('graph.pause') : t('graph.play')}
            aria-label={playing ? t('graph.pause') : t('graph.play')}
            onClick={() => setPlaying((p) => !p)}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            aria-label={t('graph.timelapseProgress')}
            onChange={(e) => {
              setPlaying(false);
              setProgress(Number(e.target.value) / 1000);
            }}
          />
          {lapseTime !== null && (
            <span className="graph-date">
              {new Date(lapseTime).toLocaleDateString(i18next.language)}
            </span>
          )}
          <button
            type="button"
            title={t('graph.fit')}
            aria-label={t('graph.fit')}
            onClick={() => {
              const r = renderer.current;
              if (!r || !model) return;
              userMoved.current = false;
              r.view = fitView(r.positions, model.n, r.size.w, r.size.h);
              dirty.current = true;
            }}
          >
            <Icon name="fit" />
          </button>
          <button
            type="button"
            title={t('graph.settings')}
            aria-label={t('graph.settings')}
            aria-expanded={panel}
            onClick={() => setPanel((p) => !p)}
          >
            <Icon name="settings" />
          </button>
        </div>
        <div className="graph-status" aria-live="polite">
          {error
            ? t('graph.error', { message: error })
            : !data
              ? t('graph.loading')
              : shown === 0
                ? t('graph.empty')
                : data.truncated
                  ? t('graph.truncated', { shown, total: data.total })
                  : t('graph.stats', { nodes: shown, edges: data.edges.length })}
        </div>
      </div>
      {panel && <GraphPanel settings={settings} local={center !== null} update={update} />}
    </div>
  );
}
