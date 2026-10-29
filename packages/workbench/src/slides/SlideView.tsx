import { useEffect, useRef, useState } from 'react';
import type { SlideTheme } from '@memobrain/markdown';
import { slidesCss } from '../export/css';

/** Logical size of a slide: the content is laid out at this size and scaled to fit. */
export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;
const STYLE_ID = 'memobrain-slides-style';

/** Injects the application-written stylesheet of the slides, once. */
function ensureSlidesStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = slidesCss();
  document.head.append(style);
}

/**
 * One slide scaled to the box it is in (which sets the size: a thumbnail, or the whole stage).
 * `html` is already sanitized by the export renderer.
 */
export function SlideView({
  html,
  theme,
  className = '',
}: {
  html: string | undefined;
  theme: SlideTheme;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    ensureSlidesStyle();
    const el = ref.current;
    if (!el) return;
    const fit = (): void => {
      if (el.clientWidth > 0 && el.clientHeight > 0)
        setScale(Math.min(el.clientWidth / SLIDE_WIDTH, el.clientHeight / SLIDE_HEIGHT));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className={`slide-viewport ${className}`}>
      <div
        className="slide-surface"
        data-theme={theme}
        style={{
          width: SLIDE_WIDTH,
          height: SLIDE_HEIGHT,
          transform: `translate(-50%, -50%) scale(${scale || 1})`,
          visibility: scale ? 'visible' : 'hidden',
        }}
      >
        <article className="export-doc" dangerouslySetInnerHTML={{ __html: html ?? '' }} />
      </div>
    </div>
  );
}
