// Mermaid for exports: always the light theme, whatever the application theme is. Mermaid has one
// global configuration, so it is switched to "default" for the duration of the export and put back
// to the application's theme afterwards.
import { sanitizeSvg } from '../util/sanitize';

let counter = 0;

const appTheme = (): 'dark' | 'default' =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';

/** Renders diagrams to sanitized SVG strings; a diagram that fails yields null. */
export async function renderMermaidLight(codes: string[]): Promise<(string | null)[]> {
  if (codes.length === 0) return [];
  const { default: mermaid } = await import('mermaid');
  const config = { startOnLoad: false, securityLevel: 'strict' as const };
  mermaid.initialize({ ...config, theme: 'default' });
  try {
    const out: (string | null)[] = [];
    for (const code of codes) {
      try {
        const { svg } = await mermaid.render(`exp-mmd-${++counter}`, code);
        out.push(sanitizeSvg(svg));
      } catch {
        out.push(null);
      }
    }
    return out;
  } finally {
    mermaid.initialize({ ...config, theme: appTheme() });
  }
}
