// Mermaid for exports: always the light theme, whatever the application theme is. Renders go
// through the same queue as the on-screen diagrams, each with its own theme (mermaidRender).
import { mermaidRender } from '../embeds/typeset';
import { sanitizeSvg } from '../util/sanitize';

let counter = 0;

/** Renders diagrams to sanitized SVG strings; a diagram that fails yields null. */
export async function renderMermaidLight(codes: string[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (const code of codes) {
    try {
      out.push(sanitizeSvg(await mermaidRender(`exp-mmd-${++counter}`, code, 'default')));
    } catch {
      out.push(null);
    }
  }
  return out;
}
