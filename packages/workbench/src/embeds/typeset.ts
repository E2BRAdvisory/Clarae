// Lazy rendering of math (KaTeX) and diagrams (Mermaid) into elements. Their
// output is created by the libraries from escaped input and inserted after the
// surrounding HTML was sanitized; KaTeX relies on inline styles, which the
// sanitizer would remove (D-01 forbids user CSS, not the renderer's own).
import type Mermaid from 'mermaid';
import { sanitizeSvg } from '../util/sanitize';

let mermaidReady: Promise<typeof Mermaid> | null = null;
let counter = 0;

function loadMermaid(): Promise<typeof Mermaid> {
  mermaidReady ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
    });
    return m.default;
  });
  return mermaidReady;
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
  void loadMermaid()
    .then(async (mermaid) => {
      const { svg } = await mermaid.render(`mmd-${++counter}`, code);
      el.innerHTML = sanitizeSvg(svg);
    })
    .catch((e: unknown) => {
      el.textContent = '';
      const pre = document.createElement('pre');
      pre.className = 'diagram-error';
      pre.textContent = `${e instanceof Error ? e.message : String(e)}\n\n${code}`;
      el.append(pre);
    });
}
