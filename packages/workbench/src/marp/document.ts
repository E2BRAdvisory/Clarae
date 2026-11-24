// The application's own CSS around Marp's slides (the slides themselves are styled by the theme):
// the thumbnails and the full-screen presentation, the print layer of "Export to PDF" and the standalone HTML document.

/**
 * Layout of a slide thumbnail (inside its shadow root): `div.frame` takes the proportions of the
 * slide (set by the panel from its viewBox) and the slide, at its natural size, is scaled to it by
 * `fitSlide`, as in the presentation (see SHOW_CSS for why not by stretching the `<svg>`).
 */
export const THUMB_CSS = `
:host { display: block; }
div.frame { position: relative; overflow: hidden; aspect-ratio: 16 / 9; }
div.marpit { position: absolute; left: 0; top: 0; margin: 0; padding: 0; transform-origin: 0 0; }
div.marpit > svg { display: block; width: 100%; height: 100%; }
`;

/**
 * Layout of the full-screen presentation (inside its shadow root): only the current slide shows.
 * The slide is laid out at its natural size (the viewBox of its `<svg>`, 1280x720 by default) and
 * `fitSlide` scales and centers `div.marpit` with a CSS transform: WebKit (WKWebView, Safari)
 * does not scale the HTML of a `<foreignObject>` with the viewBox of its `<svg>` (bug 23113), so
 * an `<svg>` stretched to the screen leaves the slide in a corner at its natural size, while a
 * transform on an HTML ancestor scales everything in every engine, without Marp's polyfill.
 */
export const SHOW_CSS = `
:host { display: block; position: relative; width: 100%; height: 100%; overflow: hidden; }
div.marp-body { width: 100%; height: 100%; }
div.marpit { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
div.marpit > svg { display: none; width: 100%; height: 100%; }
div.marpit > svg.current { display: block; }
`;

/** The natural size of a slide: the viewBox of its `<svg>` (Marp's default 1280x720 without one). */
export function slideSize(svg: SVGSVGElement): { width: number; height: number } {
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  const [, , w, h] = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  return w && h && w > 0 && h > 0 ? { width: w, height: h } : { width: 1280, height: 720 };
}

/**
 * Fits a slide laid out at its natural size to `width` x `height` (the screen of the presentation,
 * the card of a thumbnail): `marpit`, the parent of its `<svg>`, takes the natural size and a
 * transform makes it as large as it can be with its proportions, centered, bars on the longer side.
 */
export function fitSlide(
  marpit: HTMLElement,
  svg: SVGSVGElement,
  width: number,
  height: number,
): void {
  const size = slideSize(svg);
  const scale = Math.max(0, Math.min(width / size.width, height / size.height));
  const x = (width - size.width * scale) / 2;
  const y = (height - size.height * scale) / 2;
  marpit.style.width = `${size.width}px`;
  marpit.style.height = `${size.height}px`;
  marpit.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

/** Print layer of "Export to PDF": one slide per page of the slide's size (Marp sets @page). */
export const PRINT_CSS = `
@media screen { #clarae-print { display: none; } }
@media print {
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; zoom: 1 !important; }
  body.printing > *:not(#clarae-print) { display: none !important; }
  #clarae-print { display: block; }
  #clarae-print div.marpit > svg { display: block; width: 1280px; height: 720px; break-after: page; page-break-after: always; }
}
`;

/** Standalone document: the slides one under the other, each as wide as the window allows. */
const STANDALONE_CSS = `
html, body { margin: 0; background: #2b2b2b; }
div.marpit { display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 24px; }
div.marpit > svg { display: block; width: min(100%, 1280px); height: auto; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4); }
@media print {
  body { background: #fff; }
  div.marpit { padding: 0; gap: 0; }
  div.marpit > svg { width: 1280px; height: 720px; box-shadow: none; break-after: page; page-break-after: always; }
}
`;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One self-contained HTML file: no scripts, no remote resources (as export/html.ts). */
export function deckHtmlDocument(opts: {
  title: string;
  lang: string;
  css: string;
  html: string;
}): string {
  const csp =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(opts.title)}</title>
<style>
${opts.css}
${STANDALONE_CSS}
</style>
</head>
<body>
${opts.html}
</body>
</html>
`;
}
