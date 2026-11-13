// Putting vault content into a drawing: images (kept in the drawing's `files`, Spec §2.7.1) and
// notes (as a card: a rectangle with the title and an excerpt, linked to the note). The card is
// plain Excalidraw JSON: its `link` makes it clickable, previewable on hover, and a backlink of the
// note in the index, and the rename of the note keeps the link up to date.
import { baseElement } from '../actions/factory';
import { newId } from '../actions/ids';
import type { SceneElement, ScenePatch } from '../actions/types';
import { contentId } from '../latex/tex2svg';
import { stripFrontmatter } from '../../reading/sections';

/** The image types Excalidraw can hold in `files`. */
export const IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/avif',
] as const;

/** Images above this size are refused: they would bloat the drawing (Spec §2.7.1: 10 MB). */
export const MAX_IMAGE_BYTES = 10 << 20;
const DEFAULT_WIDTH = 400;

export const isImagePath = (path: string): boolean =>
  /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path);

export interface ImageContent {
  path: string;
  mime: string;
  /** base64 */
  data: string;
  size: number;
}

/** The patch that inserts an image centered on `center`, at most `maxWidth` wide. */
export function imagePatch(
  img: ImageContent,
  natural: { width: number; height: number },
  center: { x: number; y: number },
  maxWidth = DEFAULT_WIDTH,
  kind: 'image' | 'drawing' = 'image',
): ScenePatch {
  if (!(IMAGE_MIMES as readonly string[]).includes(img.mime))
    throw new Error(`unsupported image type: ${img.mime || 'unknown'}`);
  if (img.size > MAX_IMAGE_BYTES)
    throw new Error(`the image is larger than ${MAX_IMAGE_BYTES >> 20} MB`);
  if (!(natural.width > 0 && natural.height > 0)) throw new Error('the image has no size');
  const width = Math.min(natural.width, maxWidth);
  const height = (natural.height * width) / natural.width;
  const dataURL = `data:${img.mime};base64,${img.data}`;
  const fileId = contentId(dataURL);
  const el = baseElement(
    'image',
    { x: center.x - width / 2, y: center.y - height / 2, width, height },
    {
      strokeColor: 'transparent',
      roughness: 0,
      status: 'saved',
      fileId,
      scale: [1, 1],
      customData: { clarae: { kind, path: img.path } },
    },
  );
  return {
    add: [el],
    files: { [fileId]: { id: fileId, mimeType: img.mime, dataURL, created: Date.now() } },
  };
}

/** Markdown as short plain text: no frontmatter, code, images, markup or link syntax. */
export function noteExcerpt(md: string, max = 280): string {
  const text = stripFrontmatter(md)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/(^|\s)[*_]+|[*_]+(?=\s|$)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** Greedy word wrap to `width` characters (long words are kept whole). */
export function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

const withoutExt = (p: string): string => p.replace(/\.md$/i, '');
const baseName = (p: string): string => withoutExt(p.split('/').pop() ?? p);

/** The wikilink a card carries: the full path, always resolvable and unambiguous. */
export const noteLink = (path: string): string => `[[${withoutExt(path)}]]`;

/** A card for a note, centered on `center`: container + bound text, linked to the note. */
export function noteCardPatch(
  path: string,
  markdown: string,
  center: { x: number; y: number },
  opts: { fontSize?: number; columns?: number; maxChars?: number } = {},
): ScenePatch {
  const fontSize = opts.fontSize ?? 16;
  const columns = opts.columns ?? 36;
  // The card's first line is already the note's name: a leading H1 would repeat it.
  const body = stripFrontmatter(markdown).replace(/^\s*#\s+.*(?:\n|$)/, '');
  const excerpt = noteExcerpt(body, opts.maxChars ?? 280);
  const lines = wrapLines(`${baseName(path)}\n\n${excerpt}`.trimEnd(), columns);
  const textW = Math.max(...lines.map((l) => l.length)) * fontSize * 0.62;
  const textH = lines.length * fontSize * 1.25;
  const width = Math.ceil(textW + 30);
  const height = Math.ceil(textH + 30);
  const textId = newId();
  const card = baseElement(
    'rectangle',
    { x: center.x - width / 2, y: center.y - height / 2, width, height },
    {
      backgroundColor: '#fff9db',
      roundness: { type: 3 },
      link: noteLink(path),
      boundElements: [{ id: textId, type: 'text' }],
      customData: { clarae: { kind: 'note', path } },
    },
  );
  const text = baseElement(
    'text',
    { x: (card.x as number) + 15, y: (card.y as number) + 15, width: textW, height: textH },
    {
      id: textId,
      text: lines.join('\n'),
      originalText: lines.join('\n'),
      fontSize,
      fontFamily: 5,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: card.id,
      autoResize: true,
      lineHeight: 1.25,
    },
  );
  return { add: [card, text] as SceneElement[] };
}
