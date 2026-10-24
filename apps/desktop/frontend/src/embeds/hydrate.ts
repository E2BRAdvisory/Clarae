// Turns the inert placeholders of rendered Markdown into live content:
// embeds (notes, images, audio, video, PDF), math and Mermaid diagrams.
import type { BinaryContent } from '../app/api';
import { renderMarkdown } from '../reading/render';
import { extractBlock, extractSection, stripFrontmatter } from '../reading/sections';
import { blobUrl, classify, parseSize, pdfPage } from './media';
import { renderPdf } from './pdf';
import { renderMath, renderMermaid } from './typeset';
import type { LinkSpec } from '../editor/context';

/** What embeds need from the backend (a subset of `api`, so tests can fake it). */
export interface EmbedBackend {
  resolve(from: string, target: string): Promise<string>;
  readNote(path: string): Promise<string>;
  readBinary(path: string): Promise<BinaryContent>;
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
}

export const MAX_EMBED_DEPTH = 5;

function notice(el: HTMLElement, cls: string, text: string): void {
  el.className = `embed-notice ${cls}`;
  el.textContent = text;
}

/** Fills el with the embed described by spec. */
export async function renderEmbedInto(
  el: HTMLElement,
  spec: LinkSpec,
  deps: EmbedDeps,
): Promise<void> {
  const label = `![[${spec.target}${spec.heading ? '#' + spec.heading : ''}]]`;
  let path = '';
  try {
    path = spec.target ? await deps.backend.resolve(deps.fromPath, spec.target) : deps.fromPath;
  } catch {
    path = '';
  }
  if (!path) return notice(el, 'embed-missing', label);
  const kind = classify(path);
  try {
    switch (kind) {
      case 'image': {
        const bin = await deps.backend.readBinary(path);
        const img = document.createElement('img');
        img.src = blobUrl(bin);
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
        const bin = await deps.backend.readBinary(path);
        const media = document.createElement(kind);
        media.controls = true;
        media.src = blobUrl(bin);
        const { width } = parseSize(spec.alias);
        if (width && media instanceof HTMLVideoElement) media.width = width;
        el.replaceChildren(media);
        return;
      }
      case 'pdf': {
        const bin = await deps.backend.readBinary(path);
        renderPdf(el, bin, pdfPage(spec.heading));
        return;
      }
      case 'note': {
        if (deps.depth >= MAX_EMBED_DEPTH)
          return notice(el, 'embed-limit', `${label} (embed depth limit)`);
        if (deps.visited.includes(path))
          return notice(el, 'embed-cycle', `${label} (circular embed)`);
        const src = await deps.backend.readNote(path);
        let md = stripFrontmatter(src);
        if (spec.heading) {
          const sec = extractSection(src, spec.heading);
          if (sec === null) return notice(el, 'embed-missing', `${label} (heading not found)`);
          md = sec;
        } else if (spec.block) {
          const blk = extractBlock(src, spec.block);
          if (blk === null) return notice(el, 'embed-missing', `${label} (block not found)`);
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
        hydrate(body, {
          ...deps,
          fromPath: path,
          depth: deps.depth + 1,
          visited: [...deps.visited, path],
        });
        return;
      }
      case 'drawing':
      case 'canvas':
      case 'base':
        return notice(el, 'embed-pending', `${path} (${kind} embeds arrive in a later milestone)`);
      default:
        return notice(el, 'embed-other', path);
    }
  } catch {
    notice(el, 'embed-missing', `${label} (could not be loaded)`);
  }
}

/** Hydrates math, Mermaid and embeds inside rendered (sanitized) Markdown. */
export function hydrate(root: HTMLElement, deps: EmbedDeps): void {
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
  for (const el of root.querySelectorAll<HTMLElement>('span.embed')) {
    const spec: LinkSpec = {
      target: el.dataset['target'] ?? '',
      heading: el.dataset['heading'] ?? '',
      block: el.dataset['block'] ?? '',
      alias: el.dataset['size'] ?? '',
      embed: true,
    };
    void renderEmbedInto(el, spec, deps);
  }
}
