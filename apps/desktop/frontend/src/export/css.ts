// Stylesheet of the exports. It is written by the application (not by the user: D-01) and
// used in two places: embedded in the standalone HTML file, and injected while the page is in
// print mode. Every rule is scoped to `.export-doc` so it cannot touch the application UI.

const LIGHT = `
  --bg: #ffffff; --text: #1d1d1f; --muted: #5f6368; --border: #d0d4d9; --code-bg: #f3f4f6;
  --link: #4a3fc4; --mark: #fff3a3; --quote: #b8bcc4;
  --note: #2f6fdb; --warn: #c77700; --danger: #c62828; --ok: #2e7d32;`;
const DARK = `
  --bg: #1b1c1f; --text: #e6e6e8; --muted: #a0a4ab; --border: #3a3d44; --code-bg: #26282d;
  --link: #a79cff; --mark: #6b5e00; --quote: #555a63;
  --note: #6ea2ff; --warn: #f0a63c; --danger: #ff7b72; --ok: #6fd07a;`;

const RULES: [string, string][] = [
  [
    '',
    'color: var(--text); font: 16px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem; overflow-wrap: anywhere;',
  ],
  ['h1, h2, h3, h4, h5, h6', 'line-height: 1.25; margin: 1.6em 0 0.5em; break-after: avoid;'],
  ['h1', 'font-size: 2em;'],
  ['h2', 'font-size: 1.6em;'],
  ['h3', 'font-size: 1.3em;'],
  ['p, ul, ol, table, pre, blockquote', 'margin: 0.8em 0;'],
  ['a', 'color: var(--link);'],
  ['a.wikilink, span.wikilink, span.tag', 'color: var(--link);'],
  [
    'span.tag',
    'background: var(--code-bg); border-radius: 0.8em; padding: 0 0.5em; font-size: 0.9em;',
  ],
  ['mark', 'background: var(--mark); color: inherit; padding: 0 0.15em;'],
  [
    'code, pre',
    'font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em;',
  ],
  ['code', 'background: var(--code-bg); border-radius: 4px; padding: 0.1em 0.3em;'],
  [
    'pre',
    'background: var(--code-bg); border-radius: 6px; padding: 0.8em 1em; overflow-x: auto; white-space: pre-wrap; break-inside: avoid;',
  ],
  ['pre code', 'background: none; padding: 0;'],
  ['blockquote', 'border-left: 3px solid var(--quote); padding: 0 1em; color: var(--muted);'],
  ['table', 'border-collapse: collapse; max-width: 100%;'],
  ['th, td', 'border: 1px solid var(--border); padding: 0.3em 0.7em; text-align: left;'],
  ['tr, img, svg, figure', 'break-inside: avoid;'],
  ['img, svg', 'max-width: 100%; height: auto;'],
  ['hr', 'border: 0; border-top: 1px solid var(--border); margin: 1.5em 0;'],
  ['li.task-list-item, li[data-task]', 'list-style: none; margin-left: -1.3em;'],
  ['.task-mark', 'display: inline-block; width: 1.3em;'],
  ['li[data-task="x"], li[data-task="X"]', 'color: var(--muted); text-decoration: line-through;'],
  [
    '.callout',
    '--c: var(--note); border: 1px solid var(--border); border-left: 4px solid var(--c); border-radius: 6px; padding: 0.5em 1em; margin: 1em 0; break-inside: avoid;',
  ],
  ['.callout-warning, .callout-caution, .callout-attention', '--c: var(--warn);'],
  [
    '.callout-danger, .callout-error, .callout-bug, .callout-failure, .callout-fail, .callout-missing',
    '--c: var(--danger);',
  ],
  [
    '.callout-tip, .callout-success, .callout-check, .callout-done, .callout-hint, .callout-important',
    '--c: var(--ok);',
  ],
  ['.callout-title', 'font-weight: 600; color: var(--c); cursor: default;'],
  ['.callout-content > :first-child', 'margin-top: 0.3em;'],
  ['.callout-content > :last-child', 'margin-bottom: 0.3em;'],
  ['.embed-note', 'border-left: 3px solid var(--border); margin: 1em 0; padding: 0 1em;'],
  ['.embed-note-title', 'font-weight: 600; color: var(--muted);'],
  ['.embed-omitted', 'color: var(--muted); font-style: italic;'],
  ['.mermaid-diagram', 'text-align: center; margin: 1em 0;'],
  ['.math-display, .katex-display', 'text-align: center; margin: 1em 0; overflow-x: auto;'],
  ['.footnotes', 'font-size: 0.9em; color: var(--muted);'],
];

function scoped(): string {
  return RULES.map(([sel, body]) => {
    const full = sel
      ? sel
          .split(',')
          .map((s) => `.export-doc ${s.trim()}`)
          .join(', ')
      : '.export-doc';
    return `${full} { ${body} }`;
  }).join('\n');
}

/**
 * CSS of the slides (ADR-0027): the typography of the exports on a 1280×720 surface, in the
 * built-in light or dark palette. "auto" follows the application theme (data-theme on the root,
 * else the system setting). Written by the application: no user CSS (D-01).
 */
export function slidesCss(): string {
  const dark = `${DARK} color-scheme: dark;`;
  return `.slide-surface { ${LIGHT} color-scheme: light; }
.slide-surface[data-theme='dark'] { ${dark} }
:root[data-theme='dark'] .slide-surface[data-theme='auto'] { ${dark} }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .slide-surface[data-theme='auto'] { ${dark} } }
${scoped()}
.slide-surface .export-doc { max-width: none; margin: 0; padding: 56px 80px; font-size: 30px; line-height: 1.4; overflow: hidden; }
.slide-surface .export-doc h1 { font-size: 1.9em; margin-top: 0; }
.slide-surface .export-doc h2 { font-size: 1.5em; margin-top: 0; }
.slide-surface .export-doc > :first-child { margin-top: 0; }`;
}

/** CSS of the standalone HTML file: light, switching to dark with the reader's system setting. */
export function standaloneCss(): string {
  return `:root { color-scheme: light dark; ${LIGHT} }
@media (prefers-color-scheme: dark) { :root { ${DARK} } }
html { background: var(--bg); }
body { margin: 0; background: var(--bg); }
${scoped()}
@media print { :root { color-scheme: light; ${LIGHT} } .export-doc { max-width: none; padding: 0; } .export-doc details:not([open]) > :not(summary) { display: block; } }`;
}

/**
 * CSS injected while the application page is in print mode: always light (whatever the app theme),
 * with the application chrome hidden and the document laid out for paper.
 */
export function printCss(): string {
  return `${scoped()}
@media screen { #memobrain-print { display: none; } }
@media print {
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; zoom: 1 !important; }
  body.printing > *:not(#memobrain-print) { display: none !important; }
  #memobrain-print { display: block; ${LIGHT} color-scheme: light; background: var(--bg); }
  @page { margin: 16mm 14mm; }
  .export-doc { max-width: none; padding: 0 6mm; font-size: 11pt; }
  .export-doc a { text-decoration: none; }
}`;
}
