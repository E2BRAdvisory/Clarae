// Loads what a page preview shows: the target note (or the section under a
// heading, or a block) rendered by the reading renderer.
import { api } from '../app/api';
import { canvasPreviewUrl } from '../canvas/preview';
import { drawingPreviewUrl } from '../drawing/preview';
import type { LinkSpec } from '../editor/context';
import type { EmbedBackend } from '../embeds/hydrate';
import { classify } from '../embeds/media';
import { renderMarkdown } from '../reading/render';
import { extractBlock, extractSection, stripFrontmatter } from '../reading/sections';
import { queryClient } from '../state/queryClient';
import { treeEntry } from '../state/queries';

export type PreviewResult =
  | { ok: true; path: string; title: string; html: string }
  | { ok: false; reason: 'missing' | 'unsupported' | 'section' | 'error' };

/** Preview of the note a link points to. `html` is sanitized by renderMarkdown. */
export async function loadPreview(
  vaultId: string,
  fromPath: string,
  spec: Pick<LinkSpec, 'target' | 'heading' | 'block'>,
): Promise<PreviewResult> {
  try {
    const path = spec.target ? await api.links.resolve(vaultId, fromPath, spec.target) : fromPath;
    if (!path) return { ok: false, reason: 'missing' };
    if (classify(path) !== 'note') return { ok: false, reason: 'unsupported' };
    const src = (await api.vault.readNote(vaultId, path)).content;
    let md = stripFrontmatter(src);
    if (spec.heading) {
      const sec = extractSection(src, spec.heading);
      if (sec === null) return { ok: false, reason: 'section' };
      md = sec;
    } else if (spec.block) {
      const blk = extractBlock(src, spec.block);
      if (blk === null) return { ok: false, reason: 'section' };
      md = blk;
    }
    const title = (path.split('/').pop() ?? path).replace(/\.md$/, '');
    return { ok: true, path, title, html: renderMarkdown(md) };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Removes everything in the rendered HTML that would load a remote resource
 * (images, audio, video…): a preview shows local content only. Embeds are
 * hydrated afterwards and use blob: URLs.
 */
export function stripRemoteResources(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('[src]')) {
    const src = el.getAttribute('src') ?? '';
    if (/^(blob:|data:image\/)/i.test(src)) continue;
    const alt = el.getAttribute('alt');
    if (alt) el.replaceWith(document.createTextNode(alt));
    else el.remove();
  }
}

/** What embeds inside a preview read from the vault (same as the reading view). */
export function previewBackend(vaultId: string): EmbedBackend {
  return {
    vaultId,
    stat: (p) => treeEntry(queryClient, vaultId, p),
    resolve: (from, target) => api.links.resolve(vaultId, from, target),
    readNote: async (p) => (await api.vault.readNote(vaultId, p)).content,
    readBinary: (p) => api.vault.readBinary(vaultId, p),
    drawingPreview: (p, ref) => drawingPreviewUrl(vaultId, p, ref),
    canvasPreview: (p) => canvasPreviewUrl(vaultId, p),
  };
}
