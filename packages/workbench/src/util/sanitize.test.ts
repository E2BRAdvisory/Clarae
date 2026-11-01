import { beforeAll, describe, expect, it } from 'vitest';
import { mermaidRender } from '../embeds/typeset';
import { sanitizeHtml, sanitizeSvg, scopeMermaidCss } from './sanitize';

beforeAll(() => {
  // jsdom has no SVG layout: Mermaid only needs plausible text boxes.
  const proto = window.SVGElement.prototype as unknown as Record<string, unknown>;
  proto['getBBox'] = () => ({ x: 0, y: 0, width: 60, height: 20 });
  proto['getComputedTextLength'] = () => 60;
});

const parse = (svg: string): SVGSVGElement => {
  const host = document.createElement('div');
  host.innerHTML = svg;
  return host.querySelector('svg') as SVGSVGElement;
};

describe('sanitizeSvg on real Mermaid output', () => {
  it('keeps the scoped theme, the inline styles and the labels of a flowchart', async () => {
    const raw = await mermaidRender('mmd-t1', 'flowchart TD\n  A[Hello] --> B[World]', 'default');
    const svg = parse(sanitizeSvg(raw));
    const style = svg.querySelector(':scope > style');
    expect(style?.textContent).toContain('#mmd-t1 .node rect');
    expect(style?.textContent).toContain('fill:#ECECFF');
    expect(svg.textContent).toContain('Hello');
    expect(svg.textContent).toContain('World');
    expect(svg.querySelector('[style*="stroke-width"]')).not.toBeNull();
  }, 30000);

  it('follows the theme it is rendered with', async () => {
    const dark = await mermaidRender('mmd-t2', 'flowchart LR\n  A --> B', 'dark');
    const light = await mermaidRender('mmd-t3', 'flowchart LR\n  A --> B', 'default');
    expect(parse(sanitizeSvg(dark)).querySelector('style')?.textContent).not.toContain('#ECECFF');
    expect(parse(sanitizeSvg(light)).querySelector('style')?.textContent).toContain('#ECECFF');
  }, 30000);

  it('keeps HTML labels in a foreignObject, without anything active', () => {
    const svg = parse(
      sanitizeSvg(
        '<svg id="m" xmlns="http://www.w3.org/2000/svg"><g class="node"><rect/>' +
          '<foreignObject width="50" height="20"><div xmlns="http://www.w3.org/1999/xhtml" ' +
          'style="display: table-cell; position: fixed; background: url(https://evil.example/x)">' +
          '<span class="nodeLabel" onclick="alert(1)">Hello</span><script>alert(1)</script>' +
          '<iframe src="https://evil.example"></iframe></div></foreignObject></g></svg>',
      ),
    );
    const label = svg.querySelector('foreignObject span.nodeLabel');
    expect(label?.textContent).toBe('Hello');
    expect(label?.getAttribute('onclick')).toBeNull();
    expect(svg.querySelector('script, iframe')).toBeNull();
    const div = svg.querySelector('foreignObject div') as HTMLElement;
    expect(div.getAttribute('style')).toBe('display: table-cell');
  });

  it('drops styles that are not scoped to the diagram or that load resources', () => {
    const svg = parse(
      sanitizeSvg(
        '<svg id="m" xmlns="http://www.w3.org/2000/svg"><style>' +
          'body{display:none}#m .a{fill:red}#mx .b{fill:blue}#m .c{background:url(https://x/y)}' +
          '#m .d{position:fixed;fill:green}@media print{#m .e{fill:red}}@keyframes k{to{opacity:0}}' +
          '</style><g><style>#m .f{fill:red}</style></g></svg>',
      ),
    );
    const sheets = [...svg.querySelectorAll('style')].map((s) => s.textContent);
    expect(sheets[0]).toBe('#m .a{fill:red}#m .d{fill:green}@keyframes k{to{opacity:0}}');
    expect(sheets[1] ?? '').toBe(''); // a nested <style> is emptied
  });

  it('rejects a whole sheet with escapes or imports', () => {
    expect(scopeMermaidCss('#m .a{fill:red}@import "x.css";', 'm')).toBe('');
    expect(scopeMermaidCss('#m .a{fill:\\72 ed}', 'm')).toBe('');
    expect(scopeMermaidCss('#m .a{fill:red}', 'bad id')).toBe('');
  });

  it('does not change the rules for user HTML', () => {
    expect(sanitizeHtml('<p style="color:red">x</p><style>p{}</style>')).toBe('<p>x</p>');
  });
});
