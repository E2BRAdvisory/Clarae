// Lazy rendering of math (KaTeX) and diagrams (Mermaid) into elements. Their
// output is created by the libraries from escaped input and inserted after the
// surrounding HTML was sanitized; KaTeX relies on inline styles, which the
// sanitizer would remove (D-01 forbids user CSS, not the renderer's own).
import type Mermaid from 'mermaid';
import { effectiveTheme, type Theme } from '../app/theme';
import { sanitizeSvg } from '../util/sanitize';

let mermaidReady: Promise<typeof Mermaid> | null = null;
let counter = 0;

/** Mermaid's theme for the application's effective theme (data-theme, or the OS for "system"). */
export const mermaidTheme = (): 'dark' | 'default' =>
  effectiveTheme((document.documentElement.getAttribute('data-theme') ?? 'system') as Theme) ===
  'dark'
    ? 'dark'
    : 'default';

/**
 * The configuration of every render. Labels are SVG text where the diagram supports it, so most
 * diagrams need no HTML in <foreignObject>; the sanitizer keeps the few that still use it.
 */
export const mermaidConfig = (theme: 'dark' | 'default') =>
  ({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  }) as const;

function loadMermaid(): Promise<typeof Mermaid> {
  mermaidReady ??= import('mermaid').then((m) => m.default);
  return mermaidReady;
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Renders one diagram to (unsanitized) SVG with the given theme. Mermaid has a single global
 * configuration read when a queued render starts, so renders run one at a time here, each with its
 * own configuration: an export in the light theme and an on-screen diagram never mix themes.
 */
export function mermaidRender(
  id: string,
  code: string,
  theme: 'dark' | 'default',
): Promise<string> {
  const run = chain.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize(mermaidConfig(theme));
    return (await mermaid.render(id, code)).svg;
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Diagrams on screen with their source, rendered again when the theme changes. */
const live = new Map<HTMLElement, string>();
let watching = false;

function rerenderAll(): void {
  for (const [el, code] of live) {
    if (el.isConnected) draw(el, code);
    else live.delete(el);
  }
}

function watchTheme(): void {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  new MutationObserver(rerenderAll).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', rerenderAll);
}

export function renderMath(el: HTMLElement, tex: string, display: boolean): void {
  el.textContent = tex; // visible immediately, replaced when KaTeX has loaded
  void import('katex')
    .then((k) => {
      k.default.render(tex, el, {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
      });
    })
    .catch(() => undefined);
}

export function renderMermaid(el: HTMLElement, code: string): void {
  el.textContent = '…';
  for (const known of live.keys()) if (!known.isConnected) live.delete(known);
  live.set(el, code);
  watchTheme();
  draw(el, code);
}

function draw(el: HTMLElement, code: string): void {
  void mermaidRender(`mmd-${++counter}`, code, mermaidTheme())
    .then((svg) => {
      if (live.get(el) !== code) return; // replaced by a newer render meanwhile
      el.innerHTML = sanitizeSvg(svg);
    })
    .catch((e: unknown) => {
      if (live.get(el) !== code) return;
      el.textContent = '';
      const pre = document.createElement('pre');
      pre.className = 'diagram-error';
      pre.textContent = `${e instanceof Error ? e.message : String(e)}\n\n${code}`;
      el.append(pre);
    });
}
