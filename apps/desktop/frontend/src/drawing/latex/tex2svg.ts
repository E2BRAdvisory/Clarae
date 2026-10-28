// LaTeX → SVG for drawings (the Excalidraw Extras "MathjaxToSVG"), offline: MathJax's TeX input
// and SVG output run headless on a lite DOM, with glyphs as paths (no font files, no network).
// Loaded lazily: the MathJax chunk is only fetched the first time a formula is rendered.
//
// Safety (V-02/D-01, ADR-0005): `html`, `autoload` and `require` are not registered, and the
// base package's \href, \class, \style and \cssId are neutralised by sanitizeSvg: the result
// has no links, classes, styles or data attributes, and is only ever used as an inert image.

export interface LatexSvg {
  /** A standalone SVG document. */
  svg: string;
  /** Size in px at the requested font size. */
  width: number;
  height: number;
}

export interface LatexOptions {
  /** Font size in px (1em). */
  fontSize?: number;
  /** Fill color of the glyphs (`#rrggbb`). */
  color?: string;
  /** Display style (\displaystyle) rather than inline. */
  display?: boolean;
}

const PACKAGES = [
  'base',
  'ams',
  'newcommand',
  'noundefined',
  'boldsymbol',
  'braket',
  'cancel',
  'color',
  'mathtools',
  'physics',
  'textmacros',
];

type Convert = (tex: string, display: boolean) => string;
let converter: Promise<Convert> | null = null;

async function load(): Promise<Convert> {
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }] =
    await Promise.all([
      import('mathjax-full/js/mathjax.js'),
      import('mathjax-full/js/input/tex.js'),
      import('mathjax-full/js/output/svg.js'),
      import('mathjax-full/js/adaptors/liteAdaptor.js'),
      import('mathjax-full/js/handlers/html.js'),
    ]);
  // Importing a package's configuration is what registers it; AllPackages is avoided on purpose
  // (it would add `html`, `autoload` and `require`).
  await Promise.all([
    import('mathjax-full/js/input/tex/base/BaseConfiguration.js'),
    import('mathjax-full/js/input/tex/ams/AmsConfiguration.js'),
    import('mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js'),
    import('mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js'),
    import('mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js'),
    import('mathjax-full/js/input/tex/braket/BraketConfiguration.js'),
    import('mathjax-full/js/input/tex/cancel/CancelConfiguration.js'),
    import('mathjax-full/js/input/tex/color/ColorConfiguration.js'),
    import('mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js'),
    import('mathjax-full/js/input/tex/physics/PhysicsConfiguration.js'),
    import('mathjax-full/js/input/tex/textmacros/TextMacrosConfiguration.js'),
  ]);
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const doc = mathjax.document('', {
    InputJax: new TeX({
      packages: PACKAGES,
      // A syntax error is reported to the user instead of drawing MathJax's red error box.
      formatError: (_jax: unknown, err: { message: string }) => {
        throw new Error(err.message);
      },
    }),
    OutputJax: new SVG({ fontCache: 'none' }),
  });
  return (tex, display) => adaptor.innerHTML(doc.convert(tex, { display }) as never);
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Renders a formula, or throws with MathJax's message when the TeX is invalid. */
export async function texToSvg(tex: string, o: LatexOptions = {}): Promise<LatexSvg> {
  const source = tex.trim();
  if (!source) throw new Error('empty formula');
  converter ??= load();
  const html = (await converter)(source, o.display ?? true);
  const m = /<svg\b[^>]*>[\s\S]*<\/svg>/.exec(html);
  if (!m) throw new Error('MathJax produced no SVG');
  const fontSize = o.fontSize ?? 24;
  const color = o.color && HEX.test(o.color) ? o.color : '#000000';
  const vb = /viewBox="([-\d.\s]+)"/.exec(m[0])?.[1]?.trim().split(/\s+/).map(Number);
  if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n)))
    throw new Error('MathJax produced an SVG without a viewBox');
  // MathJax's viewBox is in 1/1000 em.
  const width = Math.max(1, ((vb[2] ?? 1000) / 1000) * fontSize);
  const height = Math.max(1, ((vb[3] ?? 1000) / 1000) * fontSize);
  const svg = sanitizeSvg(m[0])
    .replace(/<svg\b[^>]*>/, (open) =>
      open
        .replace(/\swidth="[^"]*"/, '')
        .replace(/\sheight="[^"]*"/, '')
        .replace('<svg', `<svg width="${round(width)}" height="${round(height)}"`),
    )
    .replace(/currentColor/g, color);
  return { svg, width: round(width), height: round(height) };
}

const DROPPED_ATTR = /^(class|style|data-[\w-]+|on\w+|href|xlink:href|xmlns:xlink)$/i;

/**
 * Removes everything from a MathJax SVG that is not drawing: anchors (\href), classes, styles,
 * data attributes, event handlers, titles and links. `<use href="#…">` references inside the
 * document are kept (glyph reuse).
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<\/?a\b[^>]*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(
      /<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g,
      (_m, tag: string, attrs: string, close: string) => {
        const kept = [...attrs.matchAll(/\s+([^\s=>/]+)(?:="([^"]*)")?/g)]
          .filter(([, name, value]) => {
            if (!DROPPED_ATTR.test(name ?? '')) return true;
            const isRef = /^(href|xlink:href)$/i.test(name ?? '');
            return tag === 'use' && isRef && (value ?? '').startsWith('#');
          })
          .map(([all]) => all);
        return `<${tag}${kept.join('')}${close ? '/' : ''}>`;
      },
    );
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** A data URL for the SVG, as stored in a drawing's `files`. */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(s)}`;
}

/** A deterministic 40-hex id for a piece of content (FNV-1a, several rounds). */
export function contentId(text: string): string {
  let out = '';
  for (let round = 0; round < 5; round++) {
    let h = (0x811c9dc5 ^ (round * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}
