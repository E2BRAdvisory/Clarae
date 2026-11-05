// The application's own CSS around Marp's slides (the slides themselves are styled by the theme):
// the thumbnails and the full-screen presentation, the print layer of "Export to PDF" and the standalone HTML document.

/** Layout of a slide thumbnail (inside its shadow root): the slide fills the width of the card. */
export const THUMB_CSS = `
:host { display: block; }
div.marpit { margin: 0; padding: 0; }
div.marpit > svg { display: block; width: 100%; height: auto; }
`;

/** Layout of the full-screen presentation (inside its shadow root): only the current slide shows. */
export const SHOW_CSS = `
:host { display: block; width: 100%; height: 100%; }
div.marpit { width: 100%; height: 100%; }
div.marpit > svg { display: none; width: 100%; height: 100%; }
div.marpit > svg.current { display: block; }
`;

/** Print layer of "Export to PDF": one slide per page of the slide's size (Marp sets @page). */
export const PRINT_CSS = `
@media screen { #memobrain-print { display: none; } }
@media print {
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; zoom: 1 !important; }
  body.printing > *:not(#memobrain-print) { display: none !important; }
  #memobrain-print { display: block; }
  #memobrain-print div.marpit > svg { display: block; width: 1280px; height: 720px; break-after: page; page-break-after: always; }
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
