import type { BinaryContent } from '../app/api';

export type EmbedKind =
  | 'note'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'drawing'
  | 'canvas'
  | 'base'
  | 'presentation'
  | 'other';

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
  marp: 'presentation',
};

export function classify(path: string): EmbedKind {
  const i = path.lastIndexOf('.');
  if (i < 0) return 'note'; // a bare name resolves to a note
  return EXT[path.slice(i + 1).toLowerCase()] ?? 'other';
}

/** The kinds of file the application shows in a tab of its own (ADR-0047). */
const IN_APP: ReadonlySet<EmbedKind> = new Set<EmbedKind>([
  'note',
  'image',
  'audio',
  'video',
  'pdf',
  'drawing',
  'canvas',
  'base',
  'presentation',
]);

/**
 * Where a file of the vault opens (ADR-0047): in a tab of the application, or outside it (the
 * system's application on the desktop, a download in the browser). The path is a real file, so a
 * name without extension (LICENSE, Makefile, .gitignore) is not a note, unlike in classify.
 */
export function openTarget(path: string): 'in-app' | 'external' {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name.lastIndexOf('.') <= 0) return 'external';
  return IN_APP.has(classify(name)) ? 'in-app' : 'external';
}

/** Size hint of an embed alias: "300" or "300x200". */
export function parseSize(alias: string): { width?: number; height?: number } {
  const m = /^(\d+)(?:x(\d+))?$/.exec(alias.trim());
  if (!m) return {};
  return { width: Number(m[1]), ...(m[2] ? { height: Number(m[2]) } : {}) };
}

export type EmbedAlign = 'left' | 'right' | 'center' | 'left-wrap' | 'right-wrap';

const ALIGNS: readonly string[] = ['left', 'right', 'center', 'left-wrap', 'right-wrap'];

/**
 * Size and alignment of an embed alias: "300", "300x200", "300|left", "right-wrap". The
 * alignment keywords are the ones of the Obsidian Excalidraw plugin (`left`, `right`, `center`,
 * and the `-wrap` forms that let the text flow around the picture).
 */
export function embedOptions(alias: string): {
  size: { width?: number; height?: number };
  align?: EmbedAlign;
} {
  let size: { width?: number; height?: number } = {};
  let align: EmbedAlign | undefined;
  for (const token of alias.split('|').map((t) => t.trim().toLowerCase())) {
    const s = parseSize(token);
    if (s.width) size = s;
    else if (ALIGNS.includes(token)) align = token as EmbedAlign;
  }
  return { size, ...(align ? { align } : {}) };
}

export function pdfPage(heading: string): number {
  const m = /^page=(\d+)$/.exec(heading.trim());
  return m ? Number(m[1]) : 1;
}

/** What the file tree knows of a file: enough to tell whether a cached copy is still current. */
export interface FileStamp {
  size: number;
  mtime: unknown;
}

/** A cached attachment in use: call release once the element showing it is gone. */
export interface MediaHandle {
  url: string;
  blob: Blob;
  /** Idempotent. */
  release: () => void;
}

interface MediaEntry {
  /** size + mtime from the tree, or size + content fingerprint when the tree did not know it. */
  stamp: string;
  fingerprint: string;
  blob: Blob;
  url: string | null;
  refs: number;
}

/**
 * Attachments decoded into Blobs, one per (vault, path), least recently used first. Unused entries
 * keep their object URL (so the browser keeps its decoded image) until evicted beyond these limits,
 * forgotten after a change of the file, or released with the vault; entries in use are revoked
 * when their last user lets go.
 */
export const mediaLimits = { entries: 128, bytes: 96 * 1024 * 1024 };
const cache = new Map<string, MediaEntry>();
const inflight = new Map<string, Promise<MediaEntry>>();
const retired = new Set<MediaEntry>();
let cachedBytes = 0;
let liveUrls = 0;

const keyOf = (vaultId: string, path: string): string => `${vaultId}\u0000${path}`;
const stampOf = (s: FileStamp): string => `${s.size}:${String(s.mtime)}`;

/** FNV-1a of the base64 text: tells two reads of the same bytes apart from an edited file. */
function fingerprintOf(bin: BinaryContent): string {
  let h = 2166136261;
  const d = bin.data;
  for (let i = 0; i < d.length; i++) {
    h ^= d.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${bin.size}:${(h >>> 0).toString(16)}`;
}

function revoke(e: MediaEntry): void {
  if (!e.url) return;
  URL.revokeObjectURL(e.url);
  e.url = null;
  liveUrls--;
}

function drop(key: string, e: MediaEntry): void {
  cache.delete(key);
  cachedBytes -= e.blob.size;
  if (e.refs > 0) retired.add(e);
  else revoke(e);
}

function trim(): void {
  for (const [key, e] of cache) {
    if (cache.size <= mediaLimits.entries && cachedBytes <= mediaLimits.bytes) return;
    if (e.refs === 0) drop(key, e);
  }
}

function touch(key: string, e: MediaEntry): MediaEntry {
  cache.delete(key);
  cache.set(key, e);
  return e;
}

function acquire(e: MediaEntry): MediaHandle {
  e.refs++;
  let released = false;
  return {
    /** Created on first use: a PDF only needs the bytes. */
    get url(): string {
      if (!e.url) {
        e.url = URL.createObjectURL(e.blob);
        liveUrls++;
      }
      return e.url;
    },
    blob: e.blob,
    release: () => {
      if (released) return;
      released = true;
      e.refs--;
      if (e.refs === 0 && retired.delete(e)) revoke(e);
    },
  };
}

async function fetchEntry(
  key: string,
  read: () => Promise<BinaryContent>,
  stamp: string | undefined,
): Promise<MediaEntry> {
  const bin = await read();
  const fingerprint = fingerprintOf(bin);
  const cur = cache.get(key);
  if (cur && cur.fingerprint === fingerprint) {
    cur.stamp = stamp ?? fingerprint; // same bytes (a touched file): keep the decoded copy
    return touch(key, cur);
  }
  if (cur) drop(key, cur);
  const e: MediaEntry = {
    stamp: stamp ?? fingerprint,
    fingerprint,
    blob: new Blob([bytesOf(bin)], { type: bin.mime }),
    url: null,
    refs: 0,
  };
  cache.set(key, e);
  cachedBytes += e.blob.size;
  return e;
}

/**
 * The attachment at path, from the cache when its stamp (from the file tree) still matches, so
 * nothing is read; otherwise read once (concurrent requests share the read) and cached.
 */
export async function loadMedia(
  vaultId: string,
  path: string,
  read: () => Promise<BinaryContent>,
  stat?: FileStamp,
): Promise<MediaHandle> {
  const key = keyOf(vaultId, path);
  const stamp = stat ? stampOf(stat) : undefined;
  const hit = cache.get(key);
  if (hit && stamp !== undefined && hit.stamp === stamp) return acquire(touch(key, hit));
  const flight = `${key}\u0000${stamp ?? ''}`;
  let p = inflight.get(flight);
  if (!p) {
    p = fetchEntry(key, read, stamp).finally(() => inflight.delete(flight));
    inflight.set(flight, p);
  }
  const e = await p;
  const handle = acquire(e);
  // Replaced or forgotten meanwhile: the handle keeps its copy, revoked once released.
  if (cache.get(key) !== e) retired.add(e);
  trim();
  return handle;
}

/** Forgets the cached copies of changed paths (and of everything below changed folders). */
export function forgetMedia(vaultId: string, paths: readonly string[]): void {
  if (cache.size === 0 || paths.length === 0) return;
  const changed = new Set(paths.map((p) => keyOf(vaultId, p)));
  for (const [key, e] of [...cache]) {
    for (let k = key; ;) {
      if (changed.has(k)) {
        drop(key, e);
        break;
      }
      const i = k.lastIndexOf('/');
      if (i < 0) break;
      k = k.slice(0, i);
    }
  }
}

/** Drops every cached attachment of a vault (it was closed). */
export function releaseVaultMedia(vaultId: string): void {
  const prefix = keyOf(vaultId, '');
  for (const [key, e] of [...cache]) if (key.startsWith(prefix)) drop(key, e);
}

/** Cache figures, for tests and diagnostics. */
export function mediaStats(): { entries: number; bytes: number; liveUrls: number } {
  return { entries: cache.size, bytes: cachedBytes, liveUrls };
}

export function bytesOf(bin: BinaryContent) {
  const raw = atob(bin.data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
