import { useEffect, useMemo, useState } from 'react';
import { parseSlides, type Slide, type SlideDeck } from '@clarae/markdown';
import { renderExportBody } from '../export/render';
import { backendFor } from '../reading/ReadingView';
import { useActiveNote } from '../state/activeNote';
import { useNote } from '../state/queries';

/** The slides of a note: its text as the user sees it (unsaved edits included). */
export function useDeck(
  vaultId: string,
  path: string | null,
): { deck: SlideDeck; isNote: boolean; text: string } {
  const isNote = !!path && /\.md$/i.test(path);
  const live = useActiveNote((s) =>
    s.note && s.note.path === path && s.note.vaultId === vaultId ? s.note.text : null,
  );
  const { data: saved } = useNote(vaultId, isNote ? path : null);
  const text = live ?? saved?.content ?? '';
  const deck = useMemo(() => parseSlides(text), [text]);
  return { deck, isNote, text };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MAX_CACHED = 300;
const cache = new Map<string, Promise<string>>();

/** Sanitized, self-contained HTML of one slide; the result is cached by content. */
export function renderSlide(vaultId: string, path: string, content: string): Promise<string> {
  const key = `${vaultId}\u0000${path}\u0000${content}`;
  let html = cache.get(key);
  if (!html) {
    html = renderExportBody({ backend: backendFor(vaultId), path, content })
      .then((b) => b.html)
      .catch(() => `<pre>${escapeHtml(content)}</pre>`);
    cache.set(key, html);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  }
  return html;
}

/**
 * The HTML of every slide, rendered with the pipeline of the exports (images and diagrams
 * included, nothing fetched from the network). `delay` waits for typing to pause.
 */
export function useSlideHtml(
  vaultId: string,
  path: string,
  slides: Slide[],
  delay = 0,
): (string | undefined)[] {
  const [html, setHtml] = useState<(string | undefined)[]>([]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void Promise.all(slides.map((s) => renderSlide(vaultId, path, s.content))).then((h) => {
        if (alive) setHtml(h);
      });
    }, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [vaultId, path, slides, delay]);
  return html;
}
