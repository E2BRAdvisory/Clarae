// Turns the inert placeholders of rendered Markdown into live content:
// embeds (notes, images, audio, video, PDF), math and Mermaid diagrams.
import type { BinaryContent } from '../app/api';
import { i18next } from '../i18n';
import { renderMarkdown } from '../reading/render';
import { extractBlock, extractSection, stripFrontmatter } from '../reading/sections';
import { classify, embedOptions, loadMedia, parseSize, pdfPage, type FileStamp } from './media';
import { renderPdf } from './pdf';
import { renderMath, renderMermaid } from './typeset';
import type { LinkSpec } from '../editor/context';
import { parseDrawingRef, type DrawingRef } from '../drawing/embed/ref';

/** What embeds need from the backend (a subset of `api`, so tests can fake it). */
export interface EmbedBackend {
  /** Scope of the attachment cache (the vault id); '' when absent. */
  vaultId?: string;
  /**
   * Size and modification time of a file as the file tree knows them, if it does: a cached
   * attachment with the same stamp is shown without reading the file again.
   */
  stat?(path: string): FileStamp | undefined;
  resolve(from: string, target: string): Promise<string>;
  readNote(path: string): Promise<string>;
  readBinary(path: string): Promise<BinaryContent>;
  /** Blob URL of the SVG preview of a drawing (cached by content hash). */
  drawingPreview?(path: string, ref?: DrawingRef | null): Promise<string>;
  /** Blob URL of the static picture of a canvas. */
  canvasPreview?(path: string): Promise<string>;
  /** Mounts the live view of a `.base` file (optionally a named view) into el; returns its unmount. */
  baseEmbed?(el: HTMLElement, path: string, view: string, fromPath: string): (() => void) | void;
}

export interface EmbedDeps {
  backend: EmbedBackend;
  /** The note containing the embed (relative links resolve from it). */
  fromPath: string;
  /** Embedding depth (0 = top level); the limit is MAX_EMBED_DEPTH. */
  depth: number;
  /** Notes already being rendered up the chain, to break cycles. */
  visited: readonly string[];
  openLink?: (spec: LinkSpec, newTab: boolean) => void;
  /**
   * Renders a ```query block of `fromPath` (embedded search); without it the block stays code. The
   * returned function stops the block following the index (called with the hydrate disposer).
   */
  renderQuery?: (el: HTMLElement, source: string, fromPath: string) => (() => void) | void;
}

export const MAX_EMBED_DEPTH = 5;

function notice(el: HTMLElement, cls: string, text: string): void {
  el.className = `embed-notice ${cls}`;
  el.textContent = text;
}

/** A render in progress or done: await it, and dispose it when its element goes away. */
export type EmbedHandle = Promise<void> & { dispose(): void };

/** The render that currently owns an element, so a new render (or its widget) can stop it. */
const owners = new WeakMap<HTMLElement, () => void>();

/** Stops what renderEmbedInto put into el (pdf.js document, attachment, nested embeds, React root). */
export function disposeEmbed(el: HTMLElement): void {
  owners.get(el)?.();
}

/**
 * Fills el with the embed described by spec. The returned handle resolves once it is filled;
 * its dispose() frees what the embed holds (call it when el is discarded) and is idempotent.
 */
export function renderEmbedInto(el: HTMLElement, spec: LinkSpec, deps: EmbedDeps): EmbedHandle {
  disposeEmbed(el);
  const cleanups: (() => void)[] = [];
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (owners.get(el) === dispose) owners.delete(el);
    for (const f of cleanups.splice(0).reverse()) f();
  };
  /** Registers a cleanup; runs it at once when the render was disposed meanwhile. */
  const own = (f: () => void): boolean => {
    if (disposed) {
      f();
      return false;
    }
    cleanups.push(f);
    return true;
  };
  owners.set(el, dispose);
  const done = fill(el, spec, deps, own, () => disposed) as EmbedHandle;
  done.dispose = dispose;
  return done;
}

async function fill(
  el: HTMLElement,
  spec: LinkSpec,
  deps: EmbedDeps,
  own: (cleanup: () => void) => boolean,
  disposed: () => boolean,
): Promise<void> {
  const label = `![[${spec.target}${spec.heading ? '#' + spec.heading : ''}]]`;
  let path = '';
  try {
    path = spec.target ? await deps.backend.resolve(deps.fromPath, spec.target) : deps.fromPath;
  } catch {
    path = '';
  }
  if (disposed()) return;
  if (!path) return notice(el, 'embed-missing', label);
  const kind = classify(path);
  const backend = deps.backend;
  const media = async () => {
    const h = await loadMedia(
      backend.vaultId ?? '',
      path,
      () => backend.readBinary(path),
      backend.stat?.(path),
    );
    return own(h.release) ? h : null;
  };
  try {
    switch (kind) {
      case 'image': {
        const h = await media();
        if (!h) return;
        const img = document.createElement('img');
        img.src = h.url;
        img.alt =
          spec.alias && !parseSize(spec.alias).width ? spec.alias : (path.split('/').pop() ?? path);
        const { width, height } = parseSize(spec.alias);
        if (width) img.width = width;
        if (height) img.height = height;
        el.replaceChildren(img);
        return;
      }
      case 'audio':
      case 'video': {
        const h = await media();
        if (!h) return;
        const player = document.createElement(kind);
        player.controls = true;
        player.src = h.url;
        const { width } = parseSize(spec.alias);
        if (width && player instanceof HTMLVideoElement) player.width = width;
        el.replaceChildren(player);
        return;
      }
      case 'pdf': {
        const h = await media();
        if (!h) return;
        // pdf.js takes the bytes over: give it a copy, the cache keeps the Blob.
        const blob = h.blob;
        h.release(); // pdf.js needs the bytes only, no object URL
        own(
          renderPdf(
            el,
            path,
            async () => new Uint8Array(await blob.arrayBuffer()),
            pdfPage(spec.heading),
          ),
        );
        return;
      }
      case 'note': {
        if (deps.depth >= MAX_EMBED_DEPTH)
          return notice(el, 'embed-limit', i18next.t('embeds.depthLimit', { label }));
        if (deps.visited.includes(path))
          return notice(el, 'embed-cycle', i18next.t('embeds.cycle', { label }));
        const src = await deps.backend.readNote(path);
        if (disposed()) return;
        let md = stripFrontmatter(src);
        if (spec.heading) {
          const sec = extractSection(src, spec.heading);
          if (sec === null)
            return notice(el, 'embed-missing', i18next.t('embeds.headingMissing', { label }));
          md = sec;
        } else if (spec.block) {
          const blk = extractBlock(src, spec.block);
          if (blk === null)
            return notice(el, 'embed-missing', i18next.t('embeds.blockMissing', { label }));
          md = blk;
        }
        el.className = 'embed-note';
        const title = document.createElement('div');
        title.className = 'embed-note-title';
        title.textContent = path.replace(/\.md$/, '').split('/').pop() ?? path;
        title.addEventListener('click', () =>
          deps.openLink?.(
            { target: path, heading: spec.heading, block: spec.block, alias: '', embed: false },
            false,
          ),
        );
        const body = document.createElement('div');
        body.className = 'embed-note-body reading';
        body.innerHTML = renderMarkdown(md); // sanitized by renderMarkdown
        el.replaceChildren(title, body);
        own(
          hydrate(body, {
            ...deps,
            fromPath: path,
            depth: deps.depth + 1,
            visited: [...deps.visited, path],
          }),
        );
        return;
      }
      case 'drawing': {
        const ref = parseDrawingRef(spec.heading, spec.block);
        let url: string | undefined;
        try {
          url = await deps.backend.drawingPreview?.(path, ref);
        } catch (e) {
          if (ref && e instanceof Error && e.name === 'MissingPartError')
            return notice(
              el,
              'embed-missing',
              i18next.t('embeds.partMissing', { label, part: `${ref.kind}=${ref.value}` }),
            );
          throw e;
        }
        if (disposed()) return;
        if (!url) return notice(el, 'embed-other', path);
        const img = document.createElement('img');
        img.src = url;
        img.alt = path.split('/').pop() ?? path;
        img.className = 'embed-drawing';
        const { size, align } = embedOptions(spec.alias);
        const { width, height } = size;
        if (width) img.width = width;
        if (height) img.height = height;
        // Double click opens the drawing in the editor.
        img.addEventListener('dblclick', () =>
          deps.openLink?.({ target: path, heading: '', block: '', alias: '', embed: false }, false),
        );
        el.className = `embed-drawing-wrap${align ? ` align-${align}` : ''}`;
        el.replaceChildren(img);
        return;
      }
      case 'canvas': {
        const url = await deps.backend.canvasPreview?.(path);
        if (disposed()) return;
        if (!url) return notice(el, 'embed-other', path);
        const img = document.createElement('img');
        img.src = url;
        img.alt = path.split('/').pop() ?? path;
        img.className = 'embed-canvas';
        const { size, align } = embedOptions(spec.alias);
        const { width, height } = size;
        if (width) img.width = width;
        if (height) img.height = height;
        img.addEventListener('dblclick', () =>
          deps.openLink?.({ target: path, heading: '', block: '', alias: '', embed: false }, false),
        );
        el.className = `embed-drawing-wrap${align ? ` align-${align}` : ''}`;
        el.replaceChildren(img);
        return;
      }
      case 'base':
        if (!deps.backend.baseEmbed) return notice(el, 'embed-other', path);
        // `![[x.base#View]]`: the fragment names the view.
        el.className = 'embed-base-wrap';
        {
          const unmount = deps.backend.baseEmbed(el, path, spec.heading, deps.fromPath);
          if (unmount) own(unmount);
        }
        return;
      default:
        return notice(el, 'embed-other', path);
    }
  } catch {
    if (!disposed()) notice(el, 'embed-missing', i18next.t('embeds.loadFailed', { label }));
  }
}

/**
 * Hydrates math, Mermaid and embeds inside rendered (sanitized) Markdown. Returns a disposer for
 * the embeds, to call before root's content is replaced or root is discarded.
 */
export function hydrate(root: HTMLElement, deps: EmbedDeps): () => void {
  const embeds: EmbedHandle[] = [];
  const queries: (() => void)[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('.math-inline'))
    renderMath(el, el.textContent ?? '', false);
  for (const el of root.querySelectorAll<HTMLElement>('.math-display'))
    renderMath(el, el.textContent ?? '', true);
  for (const code of root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
    const holder = document.createElement('div');
    holder.className = 'mermaid-diagram';
    code.closest('pre')?.replaceWith(holder);
    renderMermaid(holder, code.textContent ?? '');
  }
  if (deps.renderQuery) {
    for (const code of root.querySelectorAll<HTMLElement>('pre > code.language-query')) {
      const holder = document.createElement('div');
      code.closest('pre')?.replaceWith(holder);
      const stop = deps.renderQuery(holder, code.textContent ?? '', deps.fromPath);
      if (stop) queries.push(stop);
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>('span.embed')) {
    const spec: LinkSpec = {
      target: el.dataset['target'] ?? '',
      heading: el.dataset['heading'] ?? '',
      block: el.dataset['block'] ?? '',
      alias: el.dataset['size'] ?? '',
      embed: true,
    };
    embeds.push(renderEmbedInto(el, spec, deps));
  }
  return () => {
    embeds.splice(0).forEach((e) => e.dispose());
    queries.splice(0).forEach((stop) => stop());
  };
}
