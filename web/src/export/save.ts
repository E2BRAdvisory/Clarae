import { downloadBlob } from './download';

interface FilePickerHandle {
  createWritable(): Promise<WritableStream<Uint8Array> & { abort(): Promise<void> }>;
}
type SaveFilePicker = (opts: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FilePickerHandle>;

function picker(): SaveFilePicker | undefined {
  const w = window as unknown as { showSaveFilePicker?: SaveFilePicker };
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker.bind(window) : undefined;
}

/** True when the ZIP can be written straight to disk (File System Access API). */
export function canSaveToDisk(): boolean {
  return picker() !== undefined;
}

/** Above this size the Blob fallback holds the whole archive in memory: warn the user. */
export const BLOB_WARN_BYTES = 500 * 1024 * 1024;

export type SaveMethod = 'disk' | 'blob';

async function collect(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<Blob> {
  const parts: BlobPart[] = [];
  const reader = stream.getReader();
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(new Uint8Array(value));
    }
    // cancelling the reader ends a pending read as "done": that is not a complete archive
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return new Blob(parts, { type: 'application/zip' });
}

/**
 * Saves the ZIP stream. With the File System Access API the stream is piped to the chosen file
 * (an aborted or failed write is discarded, nothing half-written is committed); otherwise the
 * chunks are collected into a Blob and downloaded through an anchor. Must be called from a
 * click handler: the file picker needs a fresh user activation. Throws an AbortError when the
 * picker is dismissed or the signal aborts.
 */
export async function saveZipStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  signal?: AbortSignal,
): Promise<SaveMethod> {
  const show = picker();
  if (!show) {
    downloadBlob(await collect(stream, signal), filename);
    return 'blob';
  }
  const handle = await show({
    suggestedName: filename,
    types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
  });
  const writable = await handle.createWritable();
  try {
    await stream.pipeTo(writable, signal ? { signal } : {});
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
  return 'disk';
}
