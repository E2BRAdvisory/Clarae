// What the app adds next to Excalidraw's zoom control: zoom to the selection and the mini-map
// switch. Excalidraw has no slot there — its footer slot exists in the full layout only, not in
// the tray layout an editable drawing uses — so the group floats over the canvas, placed right of
// the island that holds the zoom control and following it. Nothing is added to Excalidraw's DOM.
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../shell/icons';
import { useDrawingUi } from './uiPrefs';

interface Place {
  left: number;
  top: number;
  height: number;
}

/** The gap between Excalidraw's islands in the tray layout. */
const GAP = 4;

/**
 * Where the group goes, in the pixels of `host`: right of what holds the zoom control (the island
 * of the tray layout, the left part of the footer in the full one); null while it is not shown.
 */
function useZoomAnchor(host: RefObject<HTMLElement | null>): Place | null {
  const [place, setPlace] = useState<Place | null>(null);
  useLayoutEffect(() => {
    const root = host.current;
    if (!root) return;
    let raf = 0;
    let watched: Element | null = null;
    const sizes = new ResizeObserver(() => schedule());
    const measure = (): void => {
      raf = 0;
      const zoom = root.querySelector<HTMLElement>('.excalidraw .zoom-actions');
      const anchor =
        zoom?.closest<HTMLElement>('.Island') ??
        zoom?.closest<HTMLElement>('.layer-ui__wrapper__footer-left') ??
        zoom ??
        null;
      if (anchor !== watched) {
        if (watched) sizes.unobserve(watched);
        if (anchor) sizes.observe(anchor); // the zoom percentage changes its width
        watched = anchor;
      }
      const a = anchor?.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      if (!a || a.width === 0 || r.width === 0) {
        setPlace(null);
        return;
      }
      // the app can be zoomed as a whole: rectangles are in screen pixels, positions are not
      const k = root.offsetWidth / r.width;
      const next = {
        left: Math.round((a.right - r.left) * k) + GAP,
        top: Math.round((a.top - r.top) * k),
        height: Math.round(a.height * k),
      };
      setPlace((cur) =>
        cur && cur.left === next.left && cur.top === next.top && cur.height === next.height
          ? cur
          : next,
      );
    };
    function schedule(): void {
      if (!raf) raf = requestAnimationFrame(measure);
    }
    sizes.observe(root);
    // Excalidraw swaps layouts (tray, full, view) by replacing parts of its DOM.
    const layout = new MutationObserver(schedule);
    layout.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    schedule();
    return () => {
      sizes.disconnect();
      layout.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [host]);
  return place;
}

interface Props {
  api: ExcalidrawImperativeAPI;
  /** The element the canvas fills: the group is positioned in it. */
  host: RefObject<HTMLElement | null>;
  /** Fits the selection, or the whole drawing when nothing is selected. */
  onZoom: () => void;
}

/** A click on these buttons is not a change of focus: the canvas keeps the keyboard. */
const keepFocus = (e: React.MouseEvent): void => e.preventDefault();

export function NavigationTools({ api, host, onZoom }: Props) {
  const { t } = useTranslation();
  const place = useZoomAnchor(host);
  const [selected, setSelected] = useState(
    () => Object.keys(api.getAppState().selectedElementIds).length > 0,
  );
  useEffect(
    () =>
      api.onChange((_elements, appState) =>
        // the same value leaves the state alone: no render per pointer move
        setSelected(Object.keys(appState.selectedElementIds).length > 0),
      ),
    [api],
  );
  const minimap = useDrawingUi((s) => s.minimap);
  const toggleMinimap = useDrawingUi((s) => s.toggleMinimap);
  if (!place) return null;
  const zoomLabel = t(selected ? 'drawing.footer.zoomSelection' : 'drawing.footer.zoomAll');
  return (
    <div
      className="drawing-nav-tools"
      role="group"
      aria-label={t('drawing.footer.label')}
      style={{ left: place.left, top: place.top, height: place.height }}
    >
      <button
        type="button"
        className="icon"
        title={zoomLabel}
        aria-label={zoomLabel}
        aria-keyshortcuts="Shift+3"
        onMouseDown={keepFocus}
        onClick={onZoom}
      >
        <Icon name="fit" size={18} />
      </button>
      <button
        type="button"
        className={`icon${minimap ? ' active' : ''}`}
        title={t(minimap ? 'drawing.footer.minimapHide' : 'drawing.footer.minimapShow')}
        aria-label={t('drawing.footer.minimap')}
        aria-pressed={minimap}
        onMouseDown={keepFocus}
        onClick={toggleMinimap}
      >
        <Icon name="minimap" size={18} />
      </button>
    </div>
  );
}
