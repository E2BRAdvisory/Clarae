import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observeMock = vi.fn(() => vi.fn());
const webkitMock = vi.fn();
vi.mock('@marp-team/marpit-svg-polyfill', () => ({ observe: observeMock, webkit: webkitMock }));

const { fitSlides, observeSlides, probeSlides } = await import('./polyfill');

type Box = { left: number; top: number; width: number };
const rect = (b: Box): DOMRect =>
  ({ ...b, right: b.left + b.width, x: b.left, y: b.top, height: 0, bottom: 0 }) as DOMRect;

/** A shadow-root stand-in: one slide whose boxes the test decides. */
function slide(boxes: { svg: Box; fo: Box; section: Box }): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML =
    '<svg data-marpit-svg=""><foreignObject><section>x</section></foreignObject></svg>';
  const at = (el: Element | null, b: Box) =>
    vi.spyOn(el as Element, 'getBoundingClientRect').mockReturnValue(rect(b));
  at(root.querySelector('svg'), boxes.svg);
  at(root.querySelector('foreignObject'), boxes.fo);
  at(root.querySelector('section'), boxes.section);
  return root;
}

const fine = { left: 0, top: 100, width: 1000 };
const FINE = { svg: { left: 0, top: 0, width: 1000 }, fo: fine, section: fine };
// WebKit bug 23113: the section stays at its natural size in the corner.
const MISPLACED = { ...FINE, section: { left: 0, top: 0, width: 1280 } };

describe('Marp slides in WebKit', () => {
  beforeEach(() => {
    observeMock.mockClear();
    webkitMock.mockClear();
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('tells a misplaced section from a fine one, and a hidden slide from both', () => {
    expect(probeSlides(slide(FINE))).toBe('fine');
    expect(probeSlides(slide(MISPLACED))).toBe('misplaced');
    expect(probeSlides(slide({ ...FINE, svg: { left: 0, top: 0, width: 0 } }))).toBe('unknown');
    expect(probeSlides(document.createElement('div'))).toBe('unknown');
  });

  it('applies the polyfill to the presentation only where the section is misplaced, and stops it', () => {
    const host = document.createElement('div');
    const stop = observeSlides(host, slide(FINE));
    expect(observeMock).not.toHaveBeenCalled();
    stop();

    const bad = slide(MISPLACED);
    const stopBad = observeSlides(host, bad);
    expect(observeMock).toHaveBeenCalledTimes(1);
    expect(observeMock).toHaveBeenCalledWith(bad);
    const stopObserving = observeMock.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    expect(stopObserving).not.toHaveBeenCalled();
    stopBad();
    expect(stopObserving).toHaveBeenCalledTimes(1);
  });

  it('fits the thumbnails once, only where the section is misplaced', () => {
    const host = document.createElement('div');
    fitSlides(host, slide(FINE))();
    expect(webkitMock).not.toHaveBeenCalled();
    const bad = slide(MISPLACED);
    const stop = fitSlides(host, bad);
    expect(webkitMock).toHaveBeenCalledWith({ target: bad });
    stop();
  });
});
