import { describe, expect, it } from 'vitest';
import { contentId, sanitizeSvg, svgDataUrl, texToSvg } from './tex2svg';

describe('texToSvg', () => {
  it('renders a formula to a standalone SVG with the size in px', async () => {
    const r = await texToSvg('\\frac{a}{b} + x^2', { fontSize: 20, color: '#336699' });
    expect(r.svg.startsWith('<svg ')).toBe(true);
    expect(r.svg).toContain('viewBox=');
    expect(r.svg).toContain('#336699');
    expect(r.svg).not.toContain('currentColor');
    expect(r.width).toBeGreaterThan(10);
    expect(r.height).toBeGreaterThan(10);
    expect(r.svg).toContain(`width="${r.width}"`);
  });

  it('is deterministic and scales with the font size', async () => {
    const a = await texToSvg('E = mc^2', { fontSize: 20 });
    const b = await texToSvg('E = mc^2', { fontSize: 20 });
    const c = await texToSvg('E = mc^2', { fontSize: 40 });
    expect(a.svg).toBe(b.svg);
    expect(c.width / a.width).toBeCloseTo(2, 1);
  });

  it('keeps no style attributes, scripts or links', async () => {
    const r = await texToSvg('\\sqrt{x} \\cdot \\alpha', {});
    expect(r.svg).not.toMatch(/\sstyle=/);
    expect(r.svg).not.toMatch(/<script|<a\b|href=|onload/i);
  });

  it('supports amsmath and rejects unsafe or unknown commands', async () => {
    const ok = await texToSvg('\\begin{align} a &= b \\\\ c &= d \\end{align}');
    expect(ok.svg).toContain('<svg');
    await expect(texToSvg('\\frac{a}')).rejects.toThrow();
  });

  it('rejects an empty formula and ignores a bad color', async () => {
    await expect(texToSvg('   ')).rejects.toThrow('empty');
    const r = await texToSvg('x', { color: 'red; fill: url(x)' });
    expect(r.svg).toContain('#000000');
  });
});

describe('helpers', () => {
  it('builds a base64 data URL', () => {
    expect(svgDataUrl('<svg/>')).toBe(`data:image/svg+xml;base64,${btoa('<svg/>')}`);
    expect(svgDataUrl('<svg>é</svg>')).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('makes stable 40-hex content ids', () => {
    expect(contentId('a')).toMatch(/^[0-9a-f]{40}$/);
    expect(contentId('a')).toBe(contentId('a'));
    expect(contentId('a')).not.toBe(contentId('b'));
  });
});

describe('TeX packages', () => {
  it('registers the allowed packages', async () => {
    for (const tex of [
      '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}',
      '\\begin{cases} a \\\\ b \\end{cases}',
      '\\begin{pmatrix} 1 & 2 \\end{pmatrix}',
      '\\cancel{x} + \\boldsymbol{y} + \\bra{a}\\ket{b}',
      '\\text{hello } x',
    ])
      expect((await texToSvg(tex)).svg, tex).toContain('<svg');
  });

  it('neutralises links, classes, styles and ids whatever the macro', async () => {
    for (const tex of [
      '\\href{javascript:alert(1)}{x}',
      '\\href{https://evil.example}{y}',
      '\\style{color:red; background:url(https://evil)}{x}',
      '\\class{evil}{x}',
      '\\cssId{a}{x}',
      '\\require{html}\\class{z}{x}',
      '\\mathcolor{red}{x}',
      '\\unicode{x41}',
    ]) {
      const { svg } = await texToSvg(tex);
      expect(svg, tex).not.toMatch(
        /<a[\s>]|href=|\sclass=|\sstyle=|data-|\son\w+=|<script|javascript:|evil/i,
      );
    }
  });
});

describe('sanitizeSvg', () => {
  it('drops risky attributes and elements but keeps internal <use> references', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()" style="a:b">' +
      '<title>t</title><a href="javascript:x"><g class="c" data-mml-node="x" fill="red"><use xlink:href="#glyph"/>' +
      '<use href="https://evil/x#y"/><path d="M0 0"/></g></a><script>alert(1)</script></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(
      /onload|style=|<title|<a[\s>]|<\/a>|class=|data-|<script|evil|javascript/,
    );
    expect(clean).toContain('xlink:href="#glyph"');
    expect(clean).toContain('fill="red"');
    expect(clean).toContain('<path d="M0 0"/>');
  });
});
