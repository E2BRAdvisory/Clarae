// Editable PowerPoint export of a presentation (ADR-0048). Marp renders slides as SVG with a
// <foreignObject>, which no web view can draw onto a canvas (WebKit taints it), so the slides are not
// exported as pictures: the sanitized HTML of each slide is read and rebuilt as PowerPoint objects
// (titles, text runs, bullets, tables, code, pictures, backgrounds, notes) with pptxgenjs, which runs
// offline in the browser and only builds a ZIP. The look of the Marp theme is approximated (colours,
// fonts, `lead` and `invert`); the layout is a simple top-to-bottom flow with estimated heights.
// Loaded on demand (this module and pptxgenjs): neither is in the startup bundle.
import type PptxGenJS from 'pptxgenjs';
import { displayNote } from './slides';

type Slide = ReturnType<PptxGenJS['addSlide']>;
type TextProps = PptxGenJS.TextProps;
type Run = { text: string; options: NonNullable<TextProps['options']> };

const PX = 96; // pixels per inch: the 1280 x 720 slide of Marp is the 13.333 x 7.5 in of LAYOUT_WIDE
const W = 1280;
const H = 720;
const inch = (px: number): number => px / PX;
const pt = (px: number): number => Math.round(px * 0.75 * 10) / 10;

interface Theme {
  bg: string;
  fg: string;
  accent: string;
  dim: string;
  code: string;
  font: string;
  base: number;
  /** Heading size in em. */
  heading: number[];
  margin: number;
}

const THEMES: Record<string, Theme> = {
  default: {
    bg: 'FFFFFF',
    fg: '24292E',
    accent: '0288D1',
    dim: '6A737D',
    code: 'F0F0F0',
    font: 'Arial',
    base: 28,
    heading: [1.8, 1.5, 1.3, 1.15, 1, 0.9],
    margin: 56,
  },
  gaia: {
    bg: 'FFFFFF',
    fg: '455A64',
    accent: '0288D1',
    dim: '607D8B',
    code: 'ECEFF1',
    font: 'Arial',
    base: 30,
    heading: [1.9, 1.5, 1.3, 1.15, 1, 0.9],
    margin: 70,
  },
  uncover: {
    bg: 'FDFCFF',
    fg: '202228',
    accent: '009DD5',
    dim: 'A0A3A8',
    code: 'EEEDF2',
    font: 'Arial',
    base: 28,
    heading: [2, 1.5, 1.3, 1.15, 1, 0.9],
    margin: 70,
  },
};
const INVERT: Record<string, Partial<Theme>> = {
  default: { bg: '1B1F23', fg: 'FFFFFF', accent: '4FC3F7', dim: 'B0B8C0', code: '2D333B' },
  gaia: { bg: '123456', fg: 'FFFFFF', accent: '81D4FA', dim: 'B0BEC5', code: '1E4A70' },
  uncover: { bg: '1B1D1E', fg: 'FDFCFF', accent: '52B8E8', dim: 'A0A3A8', code: '2B2E31' },
};
const MONO = 'Courier New';

function themeOf(section: Element): { theme: Theme; lead: boolean } {
  const name = section.getAttribute('data-theme') ?? 'default';
  const key = name in THEMES ? name : 'default';
  const classes = (section.getAttribute('class') ?? '').split(/\s+/);
  let theme = THEMES[key] as Theme;
  if (classes.includes('invert')) theme = { ...theme, ...INVERT[key] };
  const lead = classes.includes('lead');
  // Gaia's lead slides have an accent background with light text.
  if (lead && key === 'gaia' && !classes.includes('invert'))
    theme = {
      ...theme,
      bg: '0288D1',
      fg: 'FFFFFF',
      accent: 'FFFFFF',
      dim: 'E1F5FE',
      code: '1E90D8',
    };
  return { theme, lead };
}

// ---- pictures --------------------------------------------------------------------------------

interface Img {
  data: string;
  w: number;
  h: number;
}

const b64bytes = (dataUrl: string): Uint8Array | null => {
  const m = /^data:[^,]*?;base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob((m[1] ?? '').slice(0, 400_000));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

/** Natural size of a picture from its header (PNG, GIF, JPEG, SVG, WebP); 640 x 360 when unknown. */
export function imageSize(dataUrl: string): { w: number; h: number } {
  const fallback = { w: 640, h: 360 };
  if (/^data:image\/svg\+xml/i.test(dataUrl)) {
    try {
      const body = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const text = /;base64,/i.test(dataUrl.slice(0, dataUrl.indexOf(',') + 1))
        ? atob(body)
        : decodeURIComponent(body);
      const vb = /viewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(text);
      if (vb) return { w: Number(vb[1]), h: Number(vb[2]) };
      const w = /\bwidth\s*=\s*["']([\d.]+)/i.exec(text)?.[1];
      const h = /\bheight\s*=\s*["']([\d.]+)/i.exec(text)?.[1];
      if (w && h) return { w: Number(w), h: Number(h) };
    } catch {
      /* unknown size */
    }
    return fallback;
  }
  const b = b64bytes(dataUrl);
  if (!b || b.length < 24) return fallback;
  const be32 = (o: number): number =>
    (b[o] ?? 0) * 2 ** 24 + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0);
  const le16 = (o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: be32(16) || 640, h: be32(20) || 360 }; // PNG
  if (b[0] === 0x47 && b[1] === 0x49) return { w: le16(6) || 640, h: le16(8) || 360 }; // GIF
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: the first start-of-frame marker holds the size.
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return {
          w: ((b[o + 7] ?? 0) << 8) | (b[o + 8] ?? 0),
          h: ((b[o + 5] ?? 0) << 8) | (b[o + 6] ?? 0),
        };
      o += 2 + (((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0));
    }
    return fallback;
  }
  if (b[0] === 0x52 && b[8] === 0x57) {
    // WebP: lossy (VP8 ), lossless (VP8L) or extended (VP8X).
    const kind = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0);
    if (kind === 'VP8X')
      return {
        w: 1 + ((b[24] ?? 0) | ((b[25] ?? 0) << 8) | ((b[26] ?? 0) << 16)),
        h: 1 + ((b[27] ?? 0) | ((b[28] ?? 0) << 8) | ((b[29] ?? 0) << 16)),
      };
    if (kind === 'VP8 ') return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === 'VP8L') {
      const v = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  return fallback;
}

/** The same data URL with a base64 payload (what pptxgenjs reads). */
function base64Url(src: string): string {
  const comma = src.indexOf(',');
  if (/;base64$/i.test(src.slice(0, comma))) return src;
  const bytes = new TextEncoder().encode(decodeURIComponent(src.slice(comma + 1)));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${src.slice(0, comma).replace(/;utf8$/i, '')};base64,${btoa(bin)}`;
}

/** SVG pictures of the deck being written, as the PNG they were drawn into (null: it could not be). */
let rasters = new Map<string, string | null>();

/** A pptxgenjs data URL: the base64 payload of a `data:image` URL, with its type. */
const pictureOf = (src: string | null): Img | null => {
  if (!src || !/^data:image\/(png|jpe?g|gif|webp|svg\+xml)/i.test(src)) return null;
  const { w, h } = imageSize(src);
  if (/^data:image\/svg\+xml/i.test(src)) {
    // pptxgenjs would draw the SVG itself, and fail to write the whole file when it cannot: the
    // picture goes in as the PNG we made of it, or not at all.
    const png = rasters.get(src);
    return png ? { data: png, w, h } : null;
  }
  return { data: base64Url(src), w, h };
};

/** Draws an SVG picture into a PNG (data URL); fails when the web view cannot draw it. */
export async function rasterizeSvg(url: string, w: number, h: number): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
    img.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('svg'));
    };
    img.src = url;
  });
  const k = Math.min(2, 2000 / Math.max(1, w, h)); // neither side goes past 2000 pixels
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png'); // throws on a tainted canvas
}

// ---- text ------------------------------------------------------------------------------------

interface Style {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
  sup?: boolean;
  sub?: boolean;
}

interface Collected {
  runs: Run[];
  images: { img: Img; w?: number; h?: number; alt: string }[];
}

const LINK_OK = /^(https?:|mailto:)/i;

function collect(node: Node, st: Style, th: Theme, size: number, out: Collected): void {
  if (node.nodeType === 3) {
    const text = (node.textContent ?? '').replace(/[ \t\r\n]+/g, ' ');
    if (text) out.runs.push({ text, options: runOptions(st, th, size) });
    return;
  }
  if (!(node instanceof Element)) return;
  const tag = node.tagName.toLowerCase();
  if (tag === 'img') {
    const img = pictureOf(node.getAttribute('src'));
    const style = node.getAttribute('style') ?? '';
    const w = /(?:^|;)\s*width:\s*([\d.]+)px/.exec(style)?.[1];
    const h = /(?:^|;)\s*height:\s*([\d.]+)px/.exec(style)?.[1];
    if (img)
      out.images.push({
        img,
        ...(w ? { w: Number(w) } : {}),
        ...(h ? { h: Number(h) } : {}),
        alt: node.getAttribute('alt') ?? '',
      });
    return;
  }
  if (tag === 'br') {
    out.runs.push({ text: '\n', options: runOptions(st, th, size) });
    return;
  }
  if (node.classList.contains('katex')) {
    // Math: the TeX source (kept by KaTeX in an annotation) as monospaced text.
    const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '';
    if (tex) out.runs.push({ text: tex, options: runOptions({ ...st, code: true }, th, size) });
    return;
  }
  if (tag === 'script' || tag === 'style') return;
  const next: Style = { ...st };
  if (tag === 'strong' || tag === 'b') next.bold = true;
  else if (tag === 'em' || tag === 'i') next.italic = true;
  else if (tag === 'del' || tag === 's') next.strike = true;
  else if (tag === 'code') next.code = true;
  else if (tag === 'sup') next.sup = true;
  else if (tag === 'sub') next.sub = true;
  else if (tag === 'a') {
    const href = node.getAttribute('href') ?? '';
    if (LINK_OK.test(href)) next.link = href;
  }
  for (const c of node.childNodes) collect(c, next, th, size, out);
}

function runOptions(st: Style, th: Theme, size: number): Run['options'] {
  const o: Run['options'] = {
    fontSize: pt(size),
    fontFace: st.code ? MONO : th.font,
    color: th.fg,
  };
  if (st.bold) o.bold = true;
  if (st.italic) o.italic = true;
  if (st.strike) o.strike = 'sngStrike';
  if (st.sup) o.superscript = true;
  if (st.sub) o.subscript = true;
  if (st.code) o.highlight = th.code;
  if (st.link) {
    o.hyperlink = { url: st.link };
    o.color = th.accent;
    o.underline = { style: 'sng' };
  }
  return o;
}

/** Inline content of a node as text runs (leading and trailing blanks trimmed) and its pictures. */
function inline(node: Node, th: Theme, size: number, st: Style = {}): Collected {
  const out: Collected = { runs: [], images: [] };
  collect(node, st, th, size, out);
  const first = out.runs[0];
  if (first) first.text = first.text.replace(/^ +/, '');
  const last = out.runs[out.runs.length - 1];
  if (last) last.text = last.text.replace(/ +$/, '');
  out.runs = out.runs.filter((r) => r.text !== '');
  return out;
}

const plain = (runs: Run[]): string => runs.map((r) => r.text).join('');

/** Estimated lines of a text in a box of `width` px at `size` px (Arial averages ~0.52 em a letter). */
function lines(text: string, width: number, size: number, factor = 0.52): number {
  const per = Math.max(1, Math.floor(width / (size * factor)));
  return text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / per)), 0);
}

// ---- layout ----------------------------------------------------------------------------------

interface Item {
  y: number;
  h: number;
  draw(slide: Slide, y: number): void;
}

interface Ctx {
  th: Theme;
  /** Left edge and width of the column, in px. */
  x: number;
  w: number;
  /** Font scale (the flow shrinks to fit the slide). */
  k: number;
  lead: boolean;
  items: Item[];
  y: number;
  pptx: PptxGenJS;
}

const LH = 1.3;

function flow(nodes: Iterable<Node>, c: Ctx): void {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) heading(node, Number(tag[1]), c);
    else if (tag === 'p') paragraph(node, c);
    else if (tag === 'ul' || tag === 'ol') list(node, c);
    else if (tag === 'table') table(node, c);
    else if (tag === 'pre') code(node, c);
    else if (tag === 'blockquote') quote(node, c);
    else if (tag === 'hr') c.y += 10 * c.k;
    else if (tag === 'header' || tag === 'footer')
      continue; // drawn by the slide
    else if (node.classList.contains('katex-display')) paragraph(node, c);
    else if (tag === 'div' || tag === 'section' || tag === 'figure') flow(node.children, c);
  }
}

const gap = (c: Ctx): number => c.th.base * 0.45 * c.k;

function push(c: Ctx, h: number, draw: Item['draw']): void {
  c.items.push({ y: c.y, h, draw });
  c.y += h + gap(c);
}

function textBox(c: Ctx, runs: Run[], h: number, opts: Record<string, unknown> = {}): void {
  if (runs.length === 0) return;
  const x = c.x;
  const w = c.w;
  push(c, h, (slide, y) => {
    slide.addText(runs, {
      x: inch(x),
      y: inch(y),
      w: inch(w),
      h: inch(h),
      margin: 0,
      valign: 'top',
      align: c.lead ? 'center' : 'left',
      fit: 'none',
      ...opts,
    } as never);
  });
}

function heading(el: Element, level: number, c: Ctx): void {
  const size = c.th.base * (c.th.heading[level - 1] ?? 1) * c.k;
  const col = inline(el, c.th, size, { bold: true });
  for (const r of col.runs)
    if (!r.options.hyperlink && !r.options.highlight)
      r.options.color = level <= 2 ? c.th.accent : c.th.fg;
  const n = lines(plain(col.runs), c.w, size, 0.56);
  textBox(c, col.runs, n * size * LH, {});
}

function paragraph(el: Element, c: Ctx): void {
  const size = c.th.base * c.k;
  const col = inline(el, c.th, size);
  const n = lines(plain(col.runs), c.w, size);
  textBox(c, col.runs, n * size * LH);
  for (const im of col.images) picture(im.img, c, im.w, im.h);
}

function picture(img: Img, c: Ctx, wantW?: number, wantH?: number): void {
  const maxH = (H - 2 * c.th.margin) * 0.62;
  let w = wantW ?? (wantH ? (wantH * img.w) / img.h : img.w);
  let h = wantH ?? (wantW ? (wantW * img.h) / img.w : img.h);
  const s = Math.min(1, c.w / w, maxH / h);
  w *= s;
  h *= s;
  const x = c.lead ? c.x + (c.w - w) / 2 : c.x;
  push(c, h, (slide, y) => {
    slide.addImage({ data: img.data, x: inch(x), y: inch(y), w: inch(w), h: inch(h) });
  });
}

function list(el: Element, c: Ctx): void {
  const size = c.th.base * c.k;
  const paras: Run[] = [];
  let count = 0;
  let height = 0;
  const imgs: Img[] = [];
  const walk = (ul: Element, level: number): void => {
    const ordered = ul.tagName.toLowerCase() === 'ol';
    for (const li of ul.children) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      const own: Collected = { runs: [], images: [] };
      const nested: Element[] = [];
      for (const ch of li.childNodes) {
        if (ch instanceof Element && /^(ul|ol)$/i.test(ch.tagName)) nested.push(ch);
        else if (ch instanceof Element && ch.tagName.toLowerCase() === 'p') {
          if (own.runs.length) own.runs.push({ text: ' ', options: runOptions({}, c.th, size) });
          const sub = inline(ch, c.th, size);
          own.runs.push(...sub.runs);
          own.images.push(...sub.images);
        } else collect(ch, {}, c.th, size, own);
      }
      if (own.runs.length) {
        const first = own.runs[0];
        if (first) first.text = first.text.replace(/^ +/, '');
        const last = own.runs[own.runs.length - 1];
        if (last) last.text = last.text.replace(/ +$/, '');
        const runs = own.runs.filter((r) => r.text !== '');
        const head = runs[0];
        if (head) {
          head.options = {
            ...head.options,
            bullet: ordered ? { type: 'number' } : true,
            indentLevel: level,
          };
          const tail = runs[runs.length - 1];
          if (tail) tail.options = { ...tail.options, breakLine: true };
          paras.push(...runs);
          const indent = 36 * (level + 1);
          const n = lines(plain(runs), c.w - indent, size);
          height += n * size * LH + size * 0.2;
          count++;
        }
      }
      imgs.push(...own.images.map((i) => i.img));
      for (const sub of nested) walk(sub, level + 1);
    }
  };
  walk(el, 0);
  if (count === 0) return;
  // The last paragraph needs no trailing break.
  const lastRun = paras[paras.length - 1];
  if (lastRun) lastRun.options = { ...lastRun.options, breakLine: false };
  textBox(c, paras, height, { align: 'left' });
  for (const im of imgs) picture(im, c);
}

function code(el: Element, c: Ctx): void {
  const text = (el.textContent ?? '').replace(/\n$/, '');
  const size = c.th.base * 0.72 * c.k;
  const pad = 12;
  const n = lines(text, c.w - 2 * pad, size, 0.6);
  const h = n * size * 1.25 + 2 * pad;
  const { x, w, th } = c;
  push(c, h, (slide, y) => {
    slide.addText(text, {
      x: inch(x),
      y: inch(y),
      w: inch(w),
      h: inch(h),
      fontFace: MONO,
      fontSize: pt(size),
      color: th.fg,
      fill: { color: th.code },
      margin: pad * 0.75,
      valign: 'top',
      align: 'left',
      fit: 'none',
    } as never);
  });
}

function quote(el: Element, c: Ctx): void {
  const indent = 36;
  const start = c.y;
  const inner: Ctx = { ...c, x: c.x + indent, w: c.w - indent, th: { ...c.th, fg: c.th.dim } };
  flow(el.children, inner);
  c.y = inner.y;
  const h = Math.max(0, inner.y - start - gap(c));
  if (h > 0)
    c.items.push({
      y: start,
      h,
      draw: (slide, y) => {
        slide.addShape(c.pptx.ShapeType.rect, {
          x: inch(c.x + 6),
          y: inch(y),
          w: inch(5),
          h: inch(h),
          fill: { color: c.th.accent },
          line: { color: c.th.accent, width: 0 },
        });
      },
    });
}

function table(el: Element, c: Ctx): void {
  const size = c.th.base * 0.8 * c.k;
  const rowsEl = [...el.querySelectorAll('tr')];
  const cols = Math.max(1, ...rowsEl.map((r) => r.children.length));
  const colW = c.w / cols;
  const heights: number[] = [];
  const rows = rowsEl.map((tr) => {
    let maxLines = 1;
    const cells = [...tr.children].map((cell) => {
      const head = cell.tagName.toLowerCase() === 'th';
      const col = inline(cell, c.th, size, head ? { bold: true } : {});
      maxLines = Math.max(maxLines, lines(plain(col.runs), colW - 24, size));
      return {
        text: col.runs.length ? col.runs : [{ text: '', options: {} }],
        options: {
          ...(head ? { fill: { color: c.th.code }, bold: true } : {}),
          align: (cell.getAttribute('align') ?? 'left') as 'left',
          valign: 'middle',
        },
      };
    });
    heights.push(maxLines * size * LH + 18);
    return cells;
  });
  const total = heights.reduce((a, b) => a + b, 0);
  const { x, w, th } = c;
  push(c, total, (slide, y) => {
    slide.addTable(
      rows as never,
      {
        x: inch(x),
        y: inch(y),
        w: inch(w),
        colW: Array.from({ length: cols }, () => inch(colW)),
        rowH: heights.map(inch),
        fontFace: th.font,
        fontSize: pt(size),
        color: th.fg,
        border: { type: 'solid', pt: 1, color: th.dim },
      } as never,
    );
  });
}

// ---- slides ----------------------------------------------------------------------------------

/** The slide's content section and the backgrounds (`![bg]` figures) of an `svg` of Marp. */
function parts(svg: Element): {
  content: Element | null;
  figures: Element[];
  split: { side: 'left' | 'right'; pct: number } | null;
  vertical: boolean;
} {
  let content: Element | null = null;
  const figures: Element[] = [];
  let split: { side: 'left' | 'right'; pct: number } | null = null;
  let vertical = false;
  for (const section of svg.querySelectorAll('foreignObject > section')) {
    const kind = section.getAttribute('data-marpit-advanced-background');
    if (kind === 'background') {
      figures.push(...section.querySelectorAll('figure'));
      const box = section.querySelector('[data-marpit-advanced-background-container]');
      vertical = box?.getAttribute('data-marpit-advanced-background-direction') === 'vertical';
      const side = box?.getAttribute('data-marpit-advanced-background-split');
      if (side === 'left' || side === 'right') {
        const pct = /--marpit-advanced-background-split:\s*([\d.]+)%/.exec(
          box?.getAttribute('style') ?? '',
        )?.[1];
        split = { side, pct: pct ? Number(pct) : 50 };
      }
    } else if (kind !== 'pseudo' && !content) content = section;
  }
  return { content, figures, split, vertical };
}

const urlOf = (el: Element): string | null =>
  /url\(\s*["']?(data:image\/[^"')]+)/i.exec(
    (el.getAttribute('style') ?? '').replace(/&quot;/g, '"'),
  )?.[1] ?? null;

function addBackgrounds(
  slide: Slide,
  figures: Element[],
  region: { x: number; w: number },
  vertical: boolean,
): void {
  const pics = figures.map((f) => pictureOf(urlOf(f))).filter((p): p is Img => p !== null);
  pics.forEach((img, i) => {
    const n = pics.length;
    const bw = vertical ? region.w : region.w / n;
    const bh = vertical ? H / n : H;
    const bx = vertical ? region.x : region.x + bw * i;
    const by = vertical ? bh * i : 0;
    // "cover": the picture fills its box, the surplus is cropped.
    const k = Math.max(bw / img.w, bh / img.h);
    slide.addImage({
      data: img.data,
      x: inch(bx),
      y: inch(by),
      w: inch(img.w * k),
      h: inch(img.h * k),
      sizing: {
        type: 'crop',
        x: inch((img.w * k - bw) / 2),
        y: inch((img.h * k - bh) / 2),
        w: inch(bw),
        h: inch(bh),
      },
    } as never);
  });
}

function layout(
  content: Element,
  th: Theme,
  lead: boolean,
  region: { x: number; w: number },
  pptx: PptxGenJS,
): Item[] {
  const x = region.x + th.margin;
  const w = region.w - 2 * th.margin;
  const avail = H - 2 * th.margin;
  let k = 1;
  let items: Item[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const c: Ctx = { th, x, w, k, lead, items: [], y: th.margin, pptx };
    flow(content.children, c);
    items = c.items;
    const total = c.y - gap(c) - th.margin;
    if (total <= avail || k <= 0.5) break;
    k = Math.max(0.5, k * (avail / total) * 0.97);
  }
  const used = items.reduce((m, i) => Math.max(m, i.y + i.h), th.margin) - th.margin;
  const dy = lead ? Math.max(0, (avail - used) / 2) : 0;
  return items.map((i) => ({ ...i, y: i.y + dy }));
}

export interface PptxDeck {
  /** Sanitized slides (`div.marpit > svg`), the hidden ones already dropped. */
  html: string;
  /** Presenter notes of each slide. */
  notes: readonly string[];
  title: string;
  lang: string;
  /** Draws an SVG picture into a PNG; the web view's canvas unless a test gives another. */
  rasterize?: (url: string, w: number, h: number) => Promise<string>;
}

/** The PowerPoint file (base64) and the pictures that could not go into it (their alt text). */
export interface PptxResult {
  data: string;
  skipped: string[];
}

/** The deck as an editable PowerPoint file, base64 encoded. */
export async function deckToPptx(deck: PptxDeck): Promise<PptxResult> {
  const mod = (await import('pptxgenjs')) as unknown as { default: new () => PptxGenJS };
  const pptx = new mod.default();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = deck.title;
  pptx.subject = deck.title;
  pptx.company = 'Clarae notanda';
  const doc = new DOMParser().parseFromString(`<body>${deck.html}</body>`, 'text/html');
  const svgs = [...doc.querySelectorAll('div.marpit > svg')];
  // SVG pictures first: each one is drawn into a PNG, and one that cannot be is left out and reported.
  const skipped: string[] = [];
  // The pictures of this export only: another export may run while this one waits for the canvas.
  const mine = new Map<string, string | null>();
  const draw = deck.rasterize ?? rasterizeSvg;
  const found: { url: string; alt: string }[] = [];
  for (const el of doc.querySelectorAll('img[src^="data:image/svg"], [style*="url("]')) {
    const url = el.tagName.toLowerCase() === 'img' ? el.getAttribute('src') : urlOf(el);
    if (url && /^data:image\/svg\+xml/i.test(url))
      found.push({ url, alt: (el.getAttribute('alt') ?? '').trim() });
  }
  for (const { url, alt } of found) {
    if (mine.has(url)) continue;
    const { w, h } = imageSize(url);
    try {
      mine.set(url, await draw(url, w, h));
    } catch {
      mine.set(url, null);
      skipped.push(alt || 'SVG');
    }
  }
  rasters = mine; // from here to the file everything is synchronous: no other export can step in
  svgs.forEach((svg, i) => {
    const slide = pptx.addSlide();
    const { content, figures, split, vertical } = parts(svg);
    const { theme, lead } = themeOf(content ?? svg);
    slide.background = { color: theme.bg };
    // The backgrounds, and where the text goes when a picture takes one side (![bg left]).
    const side = split ? (W * split.pct) / 100 : 0;
    const textRegion = !split
      ? { x: 0, w: W }
      : split.side === 'left'
        ? { x: side, w: W - side }
        : { x: 0, w: W - side };
    const bgRegion = !split
      ? { x: 0, w: W }
      : split.side === 'left'
        ? { x: 0, w: side }
        : { x: W - side, w: side };
    if (figures.length) addBackgrounds(slide, figures, bgRegion, vertical);
    if (content) {
      for (const item of layout(content, theme, lead, textRegion, pptx)) item.draw(slide, item.y);
      const head = content.querySelector(':scope > header')?.textContent?.trim();
      const foot = content.querySelector(':scope > footer')?.textContent?.trim();
      const small = {
        fontSize: pt(theme.base * 0.55),
        fontFace: theme.font,
        color: theme.dim,
        margin: 0,
      };
      if (head)
        slide.addText(head, {
          ...small,
          x: inch(theme.margin),
          y: inch(20),
          w: inch(W / 2),
          h: inch(30),
        });
      if (foot)
        slide.addText(foot, {
          ...small,
          x: inch(theme.margin),
          y: inch(H - 50),
          w: inch(W / 2),
          h: inch(30),
        });
      const page = content.getAttribute('data-marpit-pagination');
      if (page)
        slide.addText(page, {
          ...small,
          x: inch(W - 160),
          y: inch(H - 50),
          w: inch(100),
          h: inch(30),
          align: 'right',
        });
    }
    const note = deck.notes[i];
    if (note) slide.addNotes(displayNote(note));
  });
  rasters = new Map();
  const bytes = (await pptx.write({ outputType: 'uint8array' })) as Uint8Array;
  return { data: await mendRuns(bytes), skipped };
}

/**
 * pptxgenjs writes a paragraph-properties element before every text run, not only the first one of a
 * paragraph; PowerPoint rejects a `pPr` after a run ("repair" dialog). The ones that follow a run
 * are dropped from every slide.
 */
async function mendRuns(bytes: Uint8Array): Promise<string> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const xml = await zip.file(name)?.async('string');
    if (xml === undefined) continue;
    zip.file(name, xml.replace(/(<\/a:r>)<a:pPr\b[^>]*?(?:\/>|>.*?<\/a:pPr>)/gs, '$1'));
  }
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}
