import { describe, expect, it } from 'vitest';
import { fitSlide, slideSize } from './document';

const NS = 'http://www.w3.org/2000/svg';
const svg = (viewBox?: string): SVGSVGElement => {
  const s = document.createElementNS(NS, 'svg');
  if (viewBox) s.setAttribute('viewBox', viewBox);
  return s;
};

describe('slideSize', () => {
  it('reads the natural size of a slide from its viewBox', () => {
    expect(slideSize(svg('0 0 1280 720'))).toEqual({ width: 1280, height: 720 });
    expect(slideSize(svg('0,0,960,720'))).toEqual({ width: 960, height: 720 });
  });

  it("falls back to Marp's 1280x720 without a usable viewBox", () => {
    expect(slideSize(svg())).toEqual({ width: 1280, height: 720 });
    expect(slideSize(svg('0 0 0 720'))).toEqual({ width: 1280, height: 720 });
  });
});

describe('fitSlide', () => {
  const fit = (viewBox: string, width: number, height: number): HTMLElement => {
    const marpit = document.createElement('div');
    fitSlide(marpit, svg(viewBox), width, height);
    return marpit;
  };

  it('scales a 16:9 slide up to a full HD screen, with no bars', () => {
    const m = fit('0 0 1280 720', 1920, 1080);
    expect(m.style.width).toBe('1280px');
    expect(m.style.height).toBe('720px');
    expect(m.style.transform).toBe('translate(0px, 0px) scale(1.5)');
  });

  it('centers the slide with bars on the longer side', () => {
    expect(fit('0 0 1280 720', 1000, 800).style.transform).toBe(
      'translate(0px, 118.75px) scale(0.78125)',
    );
    const [x, y, scale] = (
      fit('0 0 1280 720', 1600, 600).style.transform.match(/-?[\d.]+/g) ?? []
    ).map(Number);
    expect(x).toBeCloseTo(266.667, 2);
    expect(y).toBe(0);
    expect(scale).toBeCloseTo(0.8333, 4);
  });

  it('scales a 4:3 slide down to a thumbnail of the same proportions', () => {
    expect(fit('0 0 960 720', 120, 90).style.transform).toBe('translate(0px, 0px) scale(0.125)');
  });

  it('does not invert the slide when the area is not laid out yet', () => {
    expect(fit('0 0 1280 720', 0, 0).style.transform).toBe('translate(0px, 0px) scale(0)');
  });
});
