// The application's own CSS around Marp's slides (the slides themselves are styled by the theme):
// the preview pane, the print layer of "Export to PDF" and the standalone HTML document.

/** Layout of the live preview (inside its shadow root) and of presenting. */
export const PREVIEW_CSS = `
:host { display: block; overflow: auto; background: var(--bg-secondary, #f1f1f1); }
div.marpit { display: flex; flex-direction: column; gap: 16px; padding: 16px; }
div.marpit > svg { display: block; width: 100%; height: auto; cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); }
div.marpit > svg.current { outline: 3px solid var(--accent, #7c3aed); outline-offset: 2px; }
:host(.presenting) { position: fixed; inset: 0; z-index: 1000; overflow: hidden; background: #000; }
:host(.presenting) div.marpit { height: 100%; padding: 0; gap: 0; align-items: center; justify-content: center; }
:host(.presenting) div.marpit > svg { display: none; outline: none; box-shadow: none; cursor: default; }
:host(.presenting) div.marpit > svg.current { display: block; width: 100%; height: 100%; }
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
