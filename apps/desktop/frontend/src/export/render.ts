// Renders a note to a self-contained, sanitized HTML fragment for the exports (standalone HTML file
// and print). It starts from the reading-view renderer and then makes the result independent of the
// running application:
//   - images, embedded drawings and canvases become data: URIs (size capped per file and in total;
//     what exceeds the cap is left out and reported);
//   - embedded notes are inlined, audio/video/PDF embeds and remote images are left out and reported;
//   - math is typeset as MathML (no fonts or stylesheet needed), Mermaid as inline SVG (light theme);
//   - wikilinks become plain text, except links to a heading of the same note, which are in-page
//     anchors; links to other notes cannot work outside the vault and are plain text too; http(s)
//     and mailto links stay links;
//   - the final markup goes through the application sanitizer again: no scripts, no styles.
import { parseDrawingRef } from '../drawing/embed/ref';
import type { BinaryContent } from '../app/api';
import type { EmbedBackend } from '../embeds/hydrate';
import { classify, embedOptions } from '../embeds/media';
import { renderMarkdown } from '../reading/render';
import { extractBlock, extractSection, stripFrontmatter } from '../reading/sections';
import { sanitizeHtml } from '../util/sanitize';
import { renderMermaidLight } from './mermaid';

export interface ExportOptions {
  backend: EmbedBackend;
  /** Vault path of the note. */
  path: string;
  content: string;
  /** Largest attachment that is inlined (bytes). */
  maxFileBytes?: number;
  /** Largest total of inlined attachments (bytes). */
  maxTotalBytes?: number;
}

export interface ExportBody {
  html: string;
  /** Files not inlined because of the size caps. */
  skipped: string[];
  /** Embeds and images left out because they cannot be part of a standalone document. */
  omitted: string[];
}

export const MAX_INLINE_FILE = 8 << 20;
export const MAX_INLINE_TOTAL = 48 << 20;
const MAX_EMBED_DEPTH = 3;

interface Ctx {
  backend: EmbedBackend;
  maxFile: number;
  maxTotal: number;
  used: number;
  skipped: Set<string>;
  omitted: Set<string>;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

const baseName = (p: string): string => p.split('/').pop() ?? p;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function omit(ctx: Ctx, what: string, label: string): HTMLElement {
  ctx.omitted.add(what);
  return el('span', 'embed-omitted', label);
}

/** data: URI of an attachment, or null (and a note in ctx) when it is over the caps. */
async function dataUri(ctx: Ctx, path: string): Promise<string | null> {
  let bin: BinaryContent;
  try {
    bin = await ctx.backend.readBinary(path);
  } catch {
    ctx.omitted.add(path);
    return null;
  }
  if (bin.size > ctx.maxFile || ctx.used + bin.size > ctx.maxTotal) {
    ctx.skipped.add(path);
    return null;
  }
  ctx.used += bin.size;
  return `data:${bin.mime || 'application/octet-stream'};base64,${bin.data}`;
}

/** data: URI of a blob: URL (drawing and canvas previews). */
async function blobToDataUri(ctx: Ctx, url: string, label: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url)).blob();
    if (blob.size > ctx.maxFile || ctx.used + blob.size > ctx.maxTotal) {
      ctx.skipped.add(label);
      return null;
    }
    const uri = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
      r.onerror = () => reject(r.error ?? new Error('read failed'));
      r.readAsDataURL(blob);
    });
    ctx.used += blob.size;
    return uri;
  } catch {
    ctx.omitted.add(label);
    return null;
  }
}

function pictureOf(src: string, alt: string, alias: string): HTMLImageElement {
  const img = el('img');
  img.src = src;
  img.alt = alt;
  const { width, height } = embedOptions(alias).size;
  if (width) img.width = width;
  if (height) img.height = height;
  return img;
}

async function inlineEmbed(
  ctx: Ctx,
  node: HTMLElement,
  fromPath: string,
  depth: number,
  visited: readonly string[],
): Promise<void> {
  const target = node.dataset['target'] ?? '';
  const heading = node.dataset['heading'] ?? '';
  const block = node.dataset['block'] ?? '';
  const alias = node.dataset['size'] ?? '';
  const label = `![[${target}${heading ? '#' + heading : ''}]]`;
  let path = fromPath;
  if (target) {
    try {
      path = await ctx.backend.resolve(fromPath, target);
    } catch {
      path = '';
    }
  }
  if (!path) return void node.replaceWith(omit(ctx, label, label));
  const name = baseName(path);
  switch (classify(path)) {
    case 'image': {
      const uri = await dataUri(ctx, path);
      node.replaceWith(uri ? pictureOf(uri, name, alias) : omit(ctx, path, name));
      return;
    }
    case 'drawing':
    case 'canvas': {
      const kind = classify(path);
      // A part of a drawing (#frame=…) is exported as that part; a part that does not exist
      // leaves the usual placeholder.
      let url: string | undefined;
      try {
        url = await (kind === 'drawing'
          ? ctx.backend.drawingPreview?.(path, parseDrawingRef(heading, block))
          : ctx.backend.canvasPreview?.(path));
      } catch {
        url = undefined;
      }
      const uri = url ? await blobToDataUri(ctx, url, path) : null;
      node.replaceWith(uri ? pictureOf(uri, name, alias) : omit(ctx, path, name));
      return;
    }
    case 'note': {
      if (depth >= MAX_EMBED_DEPTH || visited.includes(path))
        return void node.replaceWith(omit(ctx, label, label));
      let src: string;
      try {
        src = await ctx.backend.readNote(path);
      } catch {
        return void node.replaceWith(omit(ctx, label, label));
      }
      let md = stripFrontmatter(src);
      if (heading) {
        const sec = extractSection(src, heading);
        if (sec === null) return void node.replaceWith(omit(ctx, label, label));
        md = sec;
      } else if (block) {
        const blk = extractBlock(src, block);
        if (blk === null) return void node.replaceWith(omit(ctx, label, label));
        md = blk;
      }
      const box = el('div', 'embed-note');
      box.append(el('div', 'embed-note-title', name.replace(/\.md$/, '')));
      const body = el('div', 'embed-note-body');
      body.innerHTML = renderMarkdown(md); // sanitized by renderMarkdown
      box.append(body);
      node.replaceWith(box);
      await process(ctx, body, path, depth + 1, [...visited, path]);
      return;
    }
    default:
      // audio, video, PDF, bases, other files: nothing to show on paper or in a single file
      node.replaceWith(omit(ctx, path, name));
  }
}

async function inlineImage(ctx: Ctx, img: HTMLImageElement, fromPath: string): Promise<void> {
  const src = img.getAttribute('src') ?? '';
  if (src.startsWith('data:image/')) return;
  const alt = img.getAttribute('alt') ?? '';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//.test(src)) {
    img.replaceWith(omit(ctx, src, alt || src)); // remote (or blob:) image
    return;
  }
  let target = src;
  try {
    target = decodeURI(src);
  } catch {
    /* keep as written */
  }
  let path: string;
  try {
    path = await ctx.backend.resolve(fromPath, target.split(/[?#]/)[0] ?? target);
  } catch {
    path = '';
  }
  if (!path) return void img.replaceWith(omit(ctx, src, alt || src));
  const uri = await dataUri(ctx, path);
  img.replaceWith(uri ? pictureOf(uri, alt || baseName(path), '') : omit(ctx, path, alt || src));
}

function plain(node: Element, cls: string): void {
  const span = el('span', cls, node.textContent ?? '');
  node.replaceWith(span);
}

function fixLinks(root: HTMLElement): void {
  for (const a of root.querySelectorAll<HTMLElement>('a.wikilink')) {
    const heading = a.dataset['heading'] ?? '';
    const block = a.dataset['block'] ?? '';
    if (!(a.dataset['target'] ?? '') && (heading || block)) {
      a.setAttribute('href', block ? `#blk-${block}` : `#${slug(heading)}`);
      a.removeAttribute('data-target');
      if ((a.textContent ?? '').trimStart().startsWith('>')) a.textContent = heading || `^${block}`;
    } else plain(a, 'wikilink');
  }
  for (const a of root.querySelectorAll('a.tag')) plain(a, 'tag');
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) continue;
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute('rel', 'noopener noreferrer');
      continue;
    }
    plain(a, 'wikilink'); // another note or file: there is no vault to open it in
  }
}

function markTasks(root: HTMLElement): void {
  for (const li of root.querySelectorAll<HTMLElement>('li[data-task]')) {
    if (li.querySelector(':scope > .task-mark')) continue;
    const s = li.dataset['task'] ?? 'open';
    const glyph = s === 'open' ? '☐' : s === 'x' || s === 'X' ? '☑' : `[${s}]`;
    li.prepend(el('span', 'task-mark', glyph));
  }
}

/** Everything that depends on the note the markup belongs to (embeds, images, links, tasks). */
async function process(
  ctx: Ctx,
  root: HTMLElement,
  fromPath: string,
  depth: number,
  visited: readonly string[],
): Promise<void> {
  for (const node of root.querySelectorAll<HTMLElement>('span.embed'))
    await inlineEmbed(ctx, node, fromPath, depth, visited);
  for (const img of root.querySelectorAll('img')) await inlineImage(ctx, img, fromPath);
  fixLinks(root);
  markTasks(root);
}

async function typeset(root: HTMLElement): Promise<void> {
  const maths = [...root.querySelectorAll<HTMLElement>('.math-inline, .math-display')];
  if (maths.length) {
    const katex = (await import('katex')).default;
    for (const m of maths) {
      const display = m.classList.contains('math-display');
      try {
        m.innerHTML = katex.renderToString(m.textContent ?? '', {
          displayMode: display,
          output: 'mathml',
          throwOnError: false,
          strict: 'ignore',
        });
      } catch {
        /* keeps the TeX source as text */
      }
    }
  }
  const diagrams = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')];
  const svgs = await renderMermaidLight(diagrams.map((d) => d.textContent ?? ''));
  diagrams.forEach((code, i) => {
    const svg = svgs[i];
    if (!svg) return; // a diagram that does not render stays as its source
    const holder = el('div', 'mermaid-diagram');
    holder.innerHTML = svg; // sanitized SVG
    code.closest('pre')?.replaceWith(holder);
  });
}

/** Renders the note into sanitized, self-contained markup. */
export async function renderExportBody(opts: ExportOptions): Promise<ExportBody> {
  const ctx: Ctx = {
    backend: opts.backend,
    maxFile: opts.maxFileBytes ?? MAX_INLINE_FILE,
    maxTotal: opts.maxTotalBytes ?? MAX_INLINE_TOTAL,
    used: 0,
    skipped: new Set(),
    omitted: new Set(),
  };
  const root = el('div');
  root.innerHTML = renderMarkdown(opts.content); // sanitized by renderMarkdown
  await process(ctx, root, opts.path, 0, [opts.path]);
  await typeset(root);
  for (const d of root.querySelectorAll('details')) d.setAttribute('open', '');
  return {
    html: sanitizeHtml(root.innerHTML),
    skipped: [...ctx.skipped],
    omitted: [...ctx.omitted],
  };
}
