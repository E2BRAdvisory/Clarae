import { useEffect, useMemo, useRef } from 'react';
import { canvasPreviewUrl } from '../canvas/preview';
import { mountBaseEmbed } from '../bases/embed';
import { drawingPreviewUrl } from '../drawing/preview';
import { api } from '../app/api';
import { hydrate, type EmbedBackend } from '../embeds/hydrate';
import type { LinkSpec } from '../editor/types';
import { handleLinkClick } from '../util/links';
import { readingPreviewHandlers } from '../preview/hover';
import { renderQueryInto } from '../query/env';
import { renderMarkdown } from './render';
import { queryClient } from '../state/queryClient';
import { treeEntry } from '../state/queries';

export interface Reveal {
  heading?: string;
  block?: string;
  line?: number;
  nonce: number;
}

interface Props {
  vaultId: string;
  path: string;
  content: string;
  reveal?: Reveal | undefined;
  onOpenLink: (spec: LinkSpec, newTab: boolean) => void;
  onSearchTag: (tag: string) => void;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

export function backendFor(vaultId: string): EmbedBackend {
  return {
    vaultId,
    stat: (p) => treeEntry(queryClient, vaultId, p),
    resolve: (from, target) => api.links.resolve(vaultId, from, target),
    readNote: async (p) => (await api.vault.readNote(vaultId, p)).content,
    readBinary: (p) => api.vault.readBinary(vaultId, p),
    drawingPreview: (p, ref) => drawingPreviewUrl(vaultId, p, ref),
    canvasPreview: (p) => canvasPreviewUrl(vaultId, p),
    baseEmbed: (el, p, view, from) => mountBaseEmbed(el, vaultId, p, view, from),
  };
}

/** Reading view: rendered, non-editable note with live embeds, math and diagrams. */
export function ReadingView({ vaultId, path, content, reveal, onOpenLink, onSearchTag }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html; // already sanitized by renderMarkdown
    // The disposer runs before the next render replaces the content, and on unmount.
    return hydrate(el, {
      backend: backendFor(vaultId),
      fromPath: path,
      depth: 0,
      visited: [path],
      openLink: onOpenLink,
      renderQuery: (holder, source, from) => renderQueryInto(holder, source, vaultId, from),
    });
  }, [html, vaultId, path, onOpenLink]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !reveal) return;
    const target = reveal.block
      ? el.querySelector(`#blk-${CSS.escape(reveal.block)}`)
      : reveal.heading
        ? el.querySelector(`#${CSS.escape(slug(reveal.heading))}`)
        : null;
    target?.scrollIntoView({ block: 'start' });
  }, [reveal, html]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    handleLinkClick(e, { openLink: onOpenLink, searchTag: onSearchTag });
  };

  return (
    <div
      className="reading"
      ref={ref}
      onClick={onClick}
      {...readingPreviewHandlers(vaultId, path)}
    />
  );
}
