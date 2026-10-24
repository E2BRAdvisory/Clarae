import type { BinaryContent } from '../app/api';

export type EmbedKind =
  'note' | 'image' | 'audio' | 'video' | 'pdf' | 'drawing' | 'canvas' | 'base' | 'other';

const EXT: Record<string, EmbedKind> = {
  md: 'note',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  avif: 'image',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  flac: 'audio',
  oga: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  ogv: 'video',
  pdf: 'pdf',
  excalidraw: 'drawing',
  canvas: 'canvas',
  base: 'base',
};

export function classify(path: string): EmbedKind {
  const i = path.lastIndexOf('.');
  if (i < 0) return 'note'; // a bare name resolves to a note
  return EXT[path.slice(i + 1).toLowerCase()] ?? 'other';
}

/** Size hint of an embed alias: "300" or "300x200". */
export function parseSize(alias: string): { width?: number; height?: number } {
  const m = /^(\d+)(?:x(\d+))?$/.exec(alias.trim());
  if (!m) return {};
  return { width: Number(m[1]), ...(m[2] ? { height: Number(m[2]) } : {}) };
}

export function pdfPage(heading: string): number {
  const m = /^page=(\d+)$/.exec(heading.trim());
  return m ? Number(m[1]) : 1;
}

const urls = new Map<string, string>();

/** Blob URL for an attachment (cached per path and size). */
export function blobUrl(bin: BinaryContent): string {
  const key = `${bin.path}:${bin.size}:${bin.mime}`;
  const hit = urls.get(key);
  if (hit) return hit;
  const raw = atob(bin.data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: bin.mime }));
  urls.set(key, url);
  return url;
}

export function bytesOf(bin: BinaryContent): Uint8Array {
  const raw = atob(bin.data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
