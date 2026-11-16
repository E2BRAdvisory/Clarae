// WebKit (WKWebView on macOS, Safari) has long kept the `<section>` of a Marp slide, which sits in a
// `<foreignObject>` of an inline `<svg>`, at its natural 1280x720 whatever the size of the `<svg>`
// (WebKit bug 23113): a slide shown larger or smaller than that ends up in a corner. Marp's own
// script fixes it with the polyfill used here, but the engine renders with `script: false` (no script
// in the output: ADR-0048), so the application applies it where it shows slides, in their shadow
// roots. The polyfill sets styles through the CSSOM, which the CSP of the page allows.
//
// The polyfill is applied only where the layout shows the fault (the section and its
// `<foreignObject>` disagree on size or position): a WebKit that has fixed the bug would scale the
// slide twice, and the engines that never had it need nothing.
import { observe, webkit } from '@marp-team/marpit-svg-polyfill';

/** How far (in px) the section may be from its `<foreignObject>` before it counts as misplaced. */
const TOLERANCE = 2;
/** Frames waited for a slide to be laid out before giving up the first probe. */
const PROBE_FRAMES = 120;

/** `misplaced` when the layout shows the WebKit fault, `fine` when it does not, `unknown` when no slide is shown yet. */
export function probeSlides(target: ParentNode): 'misplaced' | 'fine' | 'unknown' {
  for (const svg of target.querySelectorAll('svg[data-marpit-svg]')) {
    if (svg.getBoundingClientRect().width === 0) continue; // not shown
    const fo = svg.querySelector('foreignObject');
    const section = fo?.querySelector('section');
    if (!fo || !section) continue;
    const f = fo.getBoundingClientRect();
    const s = section.getBoundingClientRect();
    if (f.width === 0) continue;
    const off = (a: number, b: number): boolean => Math.abs(a - b) > TOLERANCE;
    return off(s.width, f.width) || off(s.left, f.left) || off(s.top, f.top) ? 'misplaced' : 'fine';
  }
  return 'unknown';
}

/**
 * Keeps the slides under `target` (a shadow root) fitted for as long as it is shown, when the engine
 * misplaces them: the polyfill then follows the size of the slide on every frame. `host` is the
 * element whose size drives the layout. Returns the function that stops it.
 */
export function observeSlides(host: Element, target: ParentNode): () => void {
  let stopObserving: (() => void) | null = null;
  let stopped = false;
  let frame = 0;
  const probe = (): void => {
    if (stopped || stopObserving) return;
    if (probeSlides(target) === 'misplaced') stopObserving = observe(target);
  };
  // The slides are laid out a frame or more after they are inserted.
  let waited = 0;
  const wait = (): void => {
    if (stopped || stopObserving) return;
    probe();
    if (!stopObserving && waited++ < PROBE_FRAMES) frame = requestAnimationFrame(wait);
  };
  wait();
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(probe) : null;
  resize?.observe(host);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    resize?.disconnect();
    stopObserving?.();
  };
}

/**
 * Fits the slides under `target` once they are laid out and whenever `host` changes size, without a
 * frame loop: for the thumbnails, of which there are many and whose size changes only with their card.
 */
export function fitSlides(host: Element, target: ParentNode): () => void {
  let misplaced = false;
  let stopped = false;
  let frame = 0;
  const run = (): void => {
    if (stopped) return;
    // Once the fault is seen it stays: after the polyfill the slide looks fine, but would be misplaced again.
    if (!misplaced && probeSlides(target) === 'misplaced') misplaced = true;
    if (misplaced) webkit({ target });
  };
  let waited = 0;
  const wait = (): void => {
    if (stopped) return;
    run();
    if (!misplaced && probeSlides(target) === 'unknown' && waited++ < PROBE_FRAMES)
      frame = requestAnimationFrame(wait);
  };
  wait();
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(run) : null;
  resize?.observe(host);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    resize?.disconnect();
  };
}
