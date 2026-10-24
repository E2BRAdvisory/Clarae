import { useEffect, useMemo, useRef } from 'react';
import { api } from '../app/api';
import { hydrate, type EmbedBackend } from '../embeds/hydrate';
import type { LinkSpec } from '../editor/context';
import { openExternal } from '../util/external';
import { renderMarkdown } from './render';

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
    resolve: (from, target) => api.links.resolve(vaultId, from, target),
    readNote: async (p) => (await api.vault.readNote(vaultId, p)).content,
    readBinary: (p) => api.vault.readBinary(vaultId, p),
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
    hydrate(el, {
      backend: backendFor(vaultId),
      fromPath: path,
      depth: 0,
      visited: [path],
      openLink: onOpenLink,
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
    const target = e.target as HTMLElement;
    const wiki = target.closest<HTMLElement>('a.wikilink');
    if (wiki) {
      e.preventDefault();
      onOpenLink(
        {
          target: wiki.dataset['target'] ?? '',
          heading: wiki.dataset['heading'] ?? '',
          block: wiki.dataset['block'] ?? '',
          alias: '',
          embed: false,
        },
        e.metaKey || e.ctrlKey,
      );
      return;
    }
    const tag = target.closest<HTMLElement>('a.tag');
    if (tag) {
      e.preventDefault();
      onSearchTag(tag.dataset['tag'] ?? '');
      return;
    }
    const a = target.closest<HTMLAnchorElement>('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) return; // footnotes and in-page anchors
    e.preventDefault();
    if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(href)) {
      openExternal(href);
    } else {
      onOpenLink(
        {
          target: decodeURI(href.split('#')[0] ?? ''),
          heading: '',
          block: '',
          alias: '',
          embed: false,
        },
        e.metaKey || e.ctrlKey,
      );
    }
  };

  return <div className="reading" ref={ref} onClick={onClick} />;
}
