import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { i18next } from '../i18n';
import { api } from '../app/api';
import { openOrCreate } from '../app/actions';
import { onVaultChanges } from '../app/fileChanges';
import { infoOf, useSync } from '../state/sync';
import { useAppStore } from '../state/store';
import { errorMessage } from '../util/errors';
import { GraphPanel } from './GraphPanel';
import { Graph2D } from './Graph2D';
import { graphNeedsReload, sameGraph } from './incremental';
import { kindCounts, kindIcon } from './kinds';
import { useGraphMode } from './mode';
import { buildModel, timelapseTime, visibleAt, type GraphModel } from './model';
import { graphCenter } from './paths';
import { useGraphSettings, type GraphSettings } from './settings';
import type { GraphData, GraphOptions } from './types';
import type { GraphSurfaceHandle, Unavailable3D } from './surface';
import { MAX_3D_SURFACES, webgl2Available } from './webgl';
import { Icon } from '../shell/icons';
import { lazyView, resetFailedViews } from '../ui/lazyView';

/** three.js and 3d-force-graph: a chunk of its own, downloaded when the 3D view first opens. */
const Graph3D = lazyView(() => import('./three/Graph3D'));

/** A 3D surface that throws (its chunk did not load, the scene failed) leaves the graph in 2D. */
class SurfaceBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    // A chunk that did not download is asked for again the next time 3D is chosen.
    resetFailedViews();
    this.props.onError();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Options sent to GraphAPI.Build for the current settings. `maxNodes` is the ceiling of the
 * surface that draws the answer (0: the core's own); beyond it the core keeps the most connected.
 */
export function optionsFor(s: GraphSettings, center: string | null, maxNodes = 0): GraphOptions {
  return {
    query: s.query,
    tags: s.tags,
    folders: s.folders,
    excludeFolders: [],
    showOrphans: s.showOrphans,
    showGhosts: s.showGhosts,
    showAttachments: s.showAttachments,
    showTags: s.showTags,
    showDocuments: s.showDocuments,
    center: center ?? '',
    depth: center ? s.localDepth : 0,
    direction: center ? s.localDirection : 'both',
    groups: s.groups.map((g) => g.query),
    maxNodes,
  };
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

  // ---- 2D or 3D: the user's choice for this device, unless the 3D surface cannot draw
  const mode = useGraphMode((s) => s.mode);
  const setMode = useGraphMode((s) => s.setMode);
  /** Why the 3D surface gave up; forgotten when the mode is chosen again (another try). */
  const [gaveUp, setGaveUp] = useState<Unavailable3D | null>(null);
  const [seenMode, setSeenMode] = useState(mode);
  if (seenMode !== mode) {
    setSeenMode(mode);
    setGaveUp(null);
  }
  const no3d = mode !== '3d' ? null : !webgl2Available() ? 'webgl' : gaveUp;
  const threeD = mode === '3d' && no3d === null;
  /** Nodes the user dragged in 3D and left held in place. */
  const [held, setHeld] = useState(0);

  const surface = useRef<GraphSurfaceHandle>(null);
  /**
   * The answer on screen, whether its layout continues from the one before (a refresh), and the
   * surface it was asked for: the 3D one has a ceiling of its own, so it never draws a 2D answer.
   */
  const [graph, setGraph] = useState<{ data: GraphData; warm: boolean; threeD: boolean } | null>(
    null,
  );
  const data = graph && graph.threeD === threeD ? graph.data : null;
  const [error, setError] = useState('');
  const [panel, setPanel] = useState(true);
  const [progress, setProgress] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [reload, setReload] = useState(0);
  /** The node walked to with [ and ], by id: indexes change when the graph does. */
  const [focusId, setFocusId] = useState<string | null>(null);
  /** The answer on screen and the vault and options it was built for. */
  const onScreen = useRef<{ key: string; data: GraphData } | null>(null);

  useEffect(() => {
    void useGraphSettings.getState().load(vaultId);
  }, [vaultId]);

  // ---- data (debounced while the user types a query)
  const options = useMemo(
    () => optionsFor(settings, center, threeD ? settings.maxNodes3d : 0),
    [settings, center, threeD],
  );
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
          onScreen.current = { key, data: d };
          setGraph({ data: d, warm: refresh, threeD });
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(errorMessage(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vaultId, optionsKey, loaded, reload, threeD]);

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

  // The node walked to with the keyboard, found again in a changed graph (-1 once it is gone).
  const focusNode = useMemo(
    () => (model && focusId !== null ? model.data.nodes.findIndex((nd) => nd.id === focusId) : -1),
    [model, focusId],
  );

  // ---- timelapse
  const visible = useMemo(() => (model ? visibleAt(model, progress) : null), [model, progress]);
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

  // ---- what a node opens
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

  const focusNodeAt = useCallback((i: number) => {
    setFocusId(modelRef.current?.data.nodes[i]?.id ?? null);
  }, []);

  const legend = useMemo(
    () => (threeD && settings.showLegend && data ? kindCounts(data.nodes) : []),
    [threeD, settings.showLegend, data],
  );
  const surfaceProps = {
    ref: surface,
    model,
    warm: graph?.warm ?? false,
    settings,
    visible,
    focusNode,
    onFocusNode: focusNodeAt,
    onOpenNode: openNodeAt,
  };

  const shown = model?.n ?? 0;
  const lapseTime = model && progress < 1 ? timelapseTime(model, progress) : null;

  return (
    <div className="graph-view">
      <div className="graph-canvas">
        {threeD ? (
          <SurfaceBoundary onError={() => setGaveUp('failed')}>
            <Suspense fallback={null}>
              <Graph3D
                {...surfaceProps}
                label={t('graph.sceneLabel')}
                onHeldNodes={setHeld}
                onUnavailable={setGaveUp}
              />
            </Suspense>
          </SurfaceBoundary>
        ) : (
          <Graph2D {...surfaceProps} label={t('graph.canvasLabel')} />
        )}
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
            onClick={() => surface.current?.fit()}
          >
            <Icon name="fit" />
          </button>
          <button
            type="button"
            className={mode === '3d' ? 'active' : undefined}
            title={t('graph.mode3d')}
            aria-label={t('graph.mode3d')}
            aria-pressed={mode === '3d'}
            data-testid="graph-mode"
            onClick={() => setMode(mode === '3d' ? '2d' : '3d')}
          >
            <Icon name="cube" />
          </button>
          {threeD && held > 0 && (
            <button
              type="button"
              title={t('graph.releaseNodes', { n: held })}
              aria-label={t('graph.releaseNodes', { n: held })}
              onClick={() => surface.current?.releaseNodes()}
            >
              <Icon name="unlock" />
            </button>
          )}
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
        {no3d && (
          <div className="graph-notice" role="status">
            {t(`graph.no3d.${no3d}`, { max: MAX_3D_SURFACES })}
          </div>
        )}
        {legend.length > 0 && (
          <ul className="graph-legend" aria-label={t('graph.legend')}>
            {legend.map(({ kind, count }) => (
              <li key={kind}>
                <Icon name={kindIcon(kind)} size={14} />
                <span>{t(`graph.kind.${kind}`)}</span>
                <span className="count">{count}</span>
              </li>
            ))}
          </ul>
        )}
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
      {panel && (
        <GraphPanel settings={settings} local={center !== null} threeD={threeD} update={update} />
      )}
    </div>
  );
}
