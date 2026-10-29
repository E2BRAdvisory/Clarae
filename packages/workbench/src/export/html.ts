// The standalone HTML document: one file, no scripts, no remote resources. The meta CSP is a
// second barrier (the Go side refuses scripts and remote references before writing anything).
import { standaloneCss } from './css';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildHtmlDocument(opts: { title: string; lang: string; body: string }): string {
  const csp =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<style>
${standaloneCss()}
</style>
</head>
<body>
<article class="export-doc">
${opts.body}
</article>
</body>
</html>
`;
}
