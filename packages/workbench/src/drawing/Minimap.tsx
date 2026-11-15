// The mini-map of a drawing: the whole scene in a small picture, with the part on screen framed.
// A click or a drag on it moves the view. Mounted only while it is shown: hidden, it costs nothing.
import { applyDarkModeFilter, CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fitTransform,
  miniBox,
  panBy,
  sameTransform,
  scrollForCenter,
  toScene,
  visibleBox,
  worldBounds,
  type Box,
  type Transform,
  type View,
} from './minimap/geometry';
import { boundsOf, shapesOf, type Shape } from './minimap/model';
import { sceneSignature } from './scene';

/** The picture, in CSS pixels. */
export const MINIMAP_SIZE = { w: 220, h: 150 };
/** The shapes are rebuilt at most this often while the drawing changes (a drag reports every frame). */
const REBUILD_MS = 200;

const viewOf = (api: ExcalidrawImperativeAPI): View => {
  const s = api.getAppState();
  return {
    scrollX: s.scrollX,
    scrollY: s.scrollY,
    zoom: s.zoom.value,
    width: s.width,
    height: s.height,
  };
};

function paint(
  canvas: HTMLCanvasElement,
  shapes: readonly Shape[],
  t: Transform,
  background: string,
  tint: (color: string) => string,
): void {
  const ratio = window.devicePixelRatio || 1;
  const w = Math.round(MINIMAP_SIZE.w * ratio);
  const h = Math.round(MINIMAP_SIZE.h * ratio);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, MINIMAP_SIZE.w, MINIMAP_SIZE.h);
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  for (const s of shapes) {
    ctx.strokeStyle = tint(s.stroke);
    if (s.kind === 'path') {
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i += 2) {
        const x = s.points[i]! * t.scale + t.dx;
        const y = s.points[i + 1]! * t.scale + t.dy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      continue;
    }
    const b = miniBox(t, s);
    // at this size a small element would vanish: every one leaves at least a dot
    const bw = Math.max(b.w, 1);
    const bh = Math.max(b.h, 1);
    ctx.save();
    ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
    if (s.angle) ctx.rotate(s.angle);
    ctx.beginPath();
    if (s.kind === 'ellipse') ctx.ellipse(0, 0, bw / 2, bh / 2, 0, 0, Math.PI * 2);
    else if (s.kind === 'diamond') {
      ctx.moveTo(0, -bh / 2);
      ctx.lineTo(bw / 2, 0);
      ctx.lineTo(0, bh / 2);
      ctx.lineTo(-bw / 2, 0);
      ctx.closePath();
    } else ctx.rect(-bw / 2, -bh / 2, bw, bh);
    if (s.kind === 'text' || s.kind === 'image') {
      // no outline to follow: a block in the colour of the ink, lighter
      ctx.globalAlpha = s.kind === 'text' ? 0.45 : 0.25;
      ctx.fillStyle = tint(s.stroke);
      ctx.fill();
    } else {
      if (s.fill) {
        ctx.fillStyle = tint(s.fill);
        ctx.fill();
      }
      if (s.kind === 'frame') ctx.setLineDash([3, 2]);
      ctx.stroke();
    }
    ctx.restore();
  }
}

interface Props {
  api: ExcalidrawImperativeAPI;
  theme: 'light' | 'dark';
  /** Fits the whole drawing in the view (the Home key). */
  onShowAll: () => void;
}

export function Minimap({ api, theme, onShowAll }: Props) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(false);
  // Excalidraw's style menu opens over the same corner (tray layout): the mini-map gives way.
  const [covered, setCovered] = useState(false);
  /** The transform the picture was last painted with; a drag keeps using the one it started on. */
  const shown = useRef<Transform | null>(null);
  const dragging = useRef<Transform | null>(null);
  /** Asks for a repaint from outside the effect (the end of a drag). */
  const scheduleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const tint = (c: string): string => applyDarkModeFilter(c, theme === 'dark');
    let shapes: Shape[] = [];
    let content: Box | null = null;
    let signature = '';
    let background = '';
    let built = 0;
    let dirty = true;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const render = (): void => {
      raf = 0;
      const el = canvas.current;
      const box = frame.current;
      if (!el || !box) return;
      const elements = api.getSceneElements();
      const sig = sceneSignature(elements, 0);
      if (sig !== signature) {
        const wait = REBUILD_MS - (performance.now() - built);
        if (wait > 0 && signature !== '') {
          // too soon after the last rebuild: the picture catches up when the changes pause
          clearTimeout(timer);
          timer = setTimeout(schedule, wait);
        } else {
          signature = sig;
          built = performance.now();
          // the ink for what has no colour of its own is the drawing's default stroke
          shapes = shapesOf(elements, '#1e1e1e');
          content = boundsOf(shapes);
          dirty = true;
          setEmpty(shapes.length === 0);
        }
      }
      const state = api.getAppState();
      setCovered(state.openMenu === 'shape');
      const bg = tint(state.viewBackgroundColor);
      if (bg !== background) {
        background = bg;
        dirty = true;
      }
      const view = visibleBox(viewOf(api));
      const next = dragging.current ?? fitTransform(worldBounds(content, view), MINIMAP_SIZE);
      if (dirty || !sameTransform(next, shown.current)) {
        paint(el, shapes, next, background, tint);
        shown.current = next;
        dirty = false;
      }
      const b = miniBox(next, view);
      box.style.transform = `translate(${b.x}px, ${b.y}px)`;
      box.style.width = `${Math.max(b.w, 2)}px`;
      box.style.height = `${Math.max(b.h, 2)}px`;
    };
    function schedule(): void {
      if (!raf) raf = requestAnimationFrame(render);
    }

    // Excalidraw reports a change for edits, selection, scroll, zoom and the size of the canvas.
    const offChange = api.onChange(schedule);
    const offScroll = api.onScrollChange(schedule);
    scheduleRef.current = schedule;
    schedule();
    return () => {
      offChange();
      offScroll();
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      scheduleRef.current = null;
    };
  }, [api, theme]);

  const scrollTo = (scroll: { scrollX: number; scrollY: number }): void =>
    api.updateScene({ appState: scroll, captureUpdate: CaptureUpdateAction.NEVER });

  /** Centres the view on the point of the scene under the pointer. */
  const follow = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = canvas.current;
    const at = dragging.current ?? shown.current;
    if (!el || !at) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // the app can be zoomed as a whole: pointer and rectangle are in the same pixels, the picture is not
    const p = toScene(at, {
      x: ((e.clientX - rect.left) * MINIMAP_SIZE.w) / rect.width,
      y: ((e.clientY - rect.top) * MINIMAP_SIZE.h) / rect.height,
    });
    scrollTo(scrollForCenter(p, viewOf(api)));
  };

  return (
    <div
      className="drawing-minimap"
      hidden={covered}
      role="group"
      aria-label={t('drawing.minimap.label')}
      tabIndex={0}
      style={{ width: MINIMAP_SIZE.w, height: MINIMAP_SIZE.h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // the canvas keeps the keyboard: a click here is navigation, not a change of focus
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = shown.current;
        follow(e);
      }}
      onPointerMove={(e) => {
        if (dragging.current) follow(e);
      }}
      onPointerUp={(e) => {
        dragging.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        scheduleRef.current?.();
      }}
      onPointerCancel={() => {
        dragging.current = null;
        scheduleRef.current?.();
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.5 : 0.1;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const move = moves[e.key];
        if (move) {
          e.preventDefault();
          scrollTo(panBy(viewOf(api), move[0], move[1]));
        } else if (e.key === 'Home') {
          e.preventDefault();
          onShowAll();
        }
      }}
    >
      <canvas ref={canvas} aria-hidden="true" />
      <div ref={frame} className="drawing-minimap-view" aria-hidden="true" />
      {empty && <span className="drawing-minimap-empty">{t('drawing.minimap.empty')}</span>}
    </div>
  );
}
