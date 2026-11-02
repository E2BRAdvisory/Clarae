// Browser-side ZIP export of a private (end-to-end encrypted) vault: unlock the VMK with the
// passphrase or the recovery key, decrypt the manifest paths and every blob, and stream the
// plaintext into a ZIP. The server only ever serves ciphertext; keys stay in memory.
import { unb64, uuidBytes } from './bytes';
import { decryptBlobChunks } from './blob';
import { decryptPathFor } from './path';
import {
  DecryptError,
  deriveKekRecovery,
  deriveSubkeys,
  openWithPassphrase,
  parseRecoveryKey,
  unwrap,
  wipeSubkeys,
  type KdfParams,
  type Subkeys,
} from './keys';
import { checkZipName, zipStream, type ZipEntry, type ZipLimits } from './zip';

export interface Envelope {
  kind: 'passphrase' | 'recovery';
  kdf: KdfParams;
  /** standard base64 */
  wrapped_vmk: string;
}

export type Secret =
  { kind: 'passphrase'; passphrase: string } | { kind: 'recovery'; recoveryKey: string };

/** No envelope of the kind the user chose exists on the server. */
export class MissingEnvelopeError extends Error {
  constructor(kind: string) {
    super(`no ${kind} key envelope`);
    this.name = 'MissingEnvelopeError';
  }
}

/**
 * Key material of an unlocked vault. Call {@link wipe} when done: it zeroes every key and drops
 * them, so reading `keys` afterwards throws {@link KeysWipedError} instead of handing out zeros.
 */
export interface Unlocked {
  readonly keys: Subkeys;
  /** True once {@link wipe} ran. */
  readonly wiped: boolean;
  wipe(): void;
}

/** The keys of an Unlocked were wiped (explicitly or because they expired). */
export class KeysWipedError extends Error {
  constructor() {
    super('the vault keys were wiped');
    this.name = 'KeysWipedError';
  }
}

/** Wraps subkeys in an {@link Unlocked} whose wipe() zeroes and forgets them. */
export function holdKeys(subkeys: Subkeys): Unlocked {
  let held: Subkeys | null = subkeys;
  return {
    get keys(): Subkeys {
      if (!held) throw new KeysWipedError();
      return held;
    },
    get wiped(): boolean {
      return held === null;
    },
    wipe() {
      if (!held) return;
      wipeSubkeys(held);
      held = null;
    },
  };
}

/**
 * Wipes `unlocked` after `ms` of idleness, as the core locks an unlocked private vault after
 * `security.vault_lock_minutes` (ADR-0029 §6). `touch()` restarts the wait, `pause()` stops it
 * while the keys are in use (an export running), `stop()` ends the watch without wiping. A
 * non-positive or non-finite `ms` never expires.
 */
export function expireWhenIdle(
  unlocked: Unlocked,
  ms: number,
  onExpire: () => void,
): { touch(): void; pause(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const touch = () => {
    clear();
    if (!(ms > 0) || !Number.isFinite(ms) || unlocked.wiped) return;
    timer = setTimeout(() => {
      timer = undefined;
      unlocked.wipe();
      onExpire();
    }, ms);
  };
  touch();
  return { touch, pause: clear, stop: clear };
}

/**
 * Derives the KEK from the secret and unwraps the VMK of the vault `vaultId` (a v2 envelope is
 * bound to it, ADR-0034; v1 envelopes are accepted too). A passphrase is tried in NFC form first,
 * then in the legacy forms (openWithPassphrase). Throws DecryptError for a wrong passphrase or
 * recovery key (the AEAD tag does not verify) or an envelope of another vault, WeakKdfError for
 * unacceptable KDF parameters and RecoveryKeyError for a malformed recovery key. The export never
 * rewrites envelopes: it only reads. An aborted `signal` rejects between two derivation steps and
 * leaves no key in memory.
 */
export async function unlockVault(
  envelopes: Envelope[],
  secret: Secret,
  vaultId: string,
  signal?: AbortSignal,
): Promise<Unlocked> {
  signal?.throwIfAborted();
  const env = envelopes.find((e) => e.kind === secret.kind);
  if (!env) throw new MissingEnvelopeError(secret.kind);
  const vid = uuidBytes(vaultId);
  let wrapped: Uint8Array;
  try {
    wrapped = unb64(env.wrapped_vmk);
  } catch {
    throw new DecryptError();
  }
  let vmk: Uint8Array;
  if (secret.kind === 'passphrase') {
    const res = await openWithPassphrase(secret.passphrase, env.kdf, wrapped, vid, signal);
    res.kek.fill(0);
    vmk = res.vmk;
  } else {
    const recovery = await parseRecoveryKey(secret.recoveryKey);
    let kek: Uint8Array;
    try {
      kek = await deriveKekRecovery(recovery, env.kdf);
    } catch (err) {
      recovery.fill(0);
      throw err;
    }
    try {
      vmk = await unwrap(kek, wrapped, vid, 'recovery');
    } catch (err) {
      if (err instanceof DecryptError) throw err;
      throw new DecryptError();
    } finally {
      kek.fill(0);
      recovery.fill(0);
    }
  }
  let keys: Subkeys | undefined;
  try {
    signal?.throwIfAborted();
    keys = await deriveSubkeys(vmk);
    signal?.throwIfAborted();
  } catch (err) {
    if (keys) wipeSubkeys(keys);
    else vmk.fill(0);
    throw err;
  }
  return holdKeys(keys);
}

export interface TreeItem {
  path: string;
  file_id: string;
  hash: string;
  size: number;
}

/**
 * What the export needs from the server: the manifest and the (encrypted) blobs. `blob` rejects with a
 * {@link BlobNotFoundError} when the server does not have the blob (a 404): only then is the file
 * skipped as missing. Any other failure (network, session, server) is retried or stops the export
 * (see {@link ExportOptions.isRetryable}).
 */
export interface VaultSource {
  tree(signal?: AbortSignal): Promise<TreeItem[]>;
  blob(hash: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/** The server has no blob with this hash: the file is skipped as `blob_missing`. */
export class BlobNotFoundError extends Error {
  constructor(hash: string) {
    super(`blob ${hash} not found`);
    this.name = 'BlobNotFoundError';
  }
}

/**
 * The export stopped because a blob could not be downloaded (the network, the session or the server
 * failed, and trying again did not help): the archive is not complete and must not be kept.
 */
export class ExportInterruptedError extends Error {
  /** The file whose blob could not be downloaded (decrypted path). */
  readonly path: string;
  constructor(path: string, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`the download of ${JSON.stringify(path)} failed: ${why}`, { cause });
    this.name = 'ExportInterruptedError';
    this.path = path;
  }
}

export type SkipReason =
  | 'unsafe_path'
  | 'path_undecryptable'
  | 'duplicate_path'
  | 'blob_missing'
  | 'blob_corrupt'
  | 'decrypt_failed';

export interface Skipped {
  /** Decrypted path when known, otherwise the opaque server path. */
  path: string;
  reason: SkipReason;
  detail?: string;
}

/** Live counters: complete once the stream has closed. */
export interface ExportReport {
  exported: number;
  bytes: number;
  skipped: Skipped[];
  /** Total number of manifest entries (known once the stream has started). */
  total: number;
}

export interface ExportOptions {
  vaultId: string;
  keys: Subkeys;
  source: VaultSource;
  signal?: AbortSignal;
  onProgress?: (r: ExportReport) => void;
  limits?: Partial<ZipLimits>;
  now?: () => Date;
  /**
   * How many files are fetched, checked and decrypted ahead of the ZIP writer (default
   * {@link DEFAULT_CONCURRENCY}). The archive keeps the manifest order whatever it is.
   */
  concurrency?: number;
  /**
   * How many bytes (manifest sizes) the files fetched ahead and the one being written may hold
   * (default {@link DEFAULT_MAX_BYTES_AHEAD}). A file larger than that is fetched alone.
   */
  maxBytesAhead?: number;
  /**
   * Whether a failed blob download is worth trying again (default: always). An error it rejects (a
   * 403, say) stops the export at once with an {@link ExportInterruptedError}.
   */
  isRetryable?: (err: unknown) => boolean;
  /** Pauses before each new attempt at a blob (default {@link DEFAULT_RETRY_MS}); then the export stops. */
  retryMs?: readonly number[];
}

/** Files in flight by default: the connections a browser opens to one HTTP/1.1 origin. */
export const DEFAULT_CONCURRENCY = 6;

/** Bytes held ahead of the ZIP writer by default (manifest sizes, the file being written included). */
export const DEFAULT_MAX_BYTES_AHEAD = 64 * 1024 * 1024;

/** Pauses between the attempts at a blob that failed for the network or the server. */
export const DEFAULT_RETRY_MS: readonly number[] = [1000, 3000, 10_000];

/** One manifest entry, made ready for the ZIP ahead of time (see exportPrivateVault). */
type Prepared =
  | { skip: Skipped }
  | { path: string; skip: Skipped }
  | { path: string; plain: Uint8Array[]; size: number };

async function sha256Hex(b: Uint8Array): Promise<string> {
  // Hashed in place when the bytes are a plain ArrayBuffer view (what fetch returns): no copy.
  const view = b.buffer instanceof ArrayBuffer ? (b as Uint8Array<ArrayBuffer>) : new Uint8Array(b);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', view));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Resolves after `ms`; rejects with the signal's reason when it aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const EMPTY = new Uint8Array(0);

/**
 * Hands the decrypted chunks to the ZIP writer one at a time and drops each reference as it goes, so a
 * large file is released while it is written rather than after.
 */
function* drain(chunks: Uint8Array[]): Generator<Uint8Array> {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] as Uint8Array;
    chunks[i] = EMPTY;
    yield c;
  }
  chunks.length = 0;
}

/**
 * Streams the decrypted vault as a ZIP. A file that cannot be exported (unsafe path, corrupt or
 * missing blob) is skipped and listed in the report; the rest of the archive is still produced.
 * A blob that cannot be downloaded for any other reason (network, session, server) is retried, then
 * errors the stream with an {@link ExportInterruptedError}: an archive with holes is never presented
 * as complete. Aborting the signal errors the stream.
 */
export function exportPrivateVault(opts: ExportOptions): {
  stream: ReadableStream<Uint8Array>;
  report: ExportReport;
} {
  const report: ExportReport = { exported: 0, bytes: 0, skipped: [], total: 0 };
  const vaultId = uuidBytes(opts.vaultId);
  const { signal } = opts;
  // Also stops the downloads still in flight once the archive failed or was cancelled.
  const inner = new AbortController();
  if (signal?.aborted) inner.abort(signal.reason);
  else signal?.addEventListener('abort', () => inner.abort(signal.reason), { once: true });
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const isRetryable = opts.isRetryable ?? (() => true);
  const skip = (s: Skipped) => {
    report.skipped.push(s);
    opts.onProgress?.(report);
  };

  /** The blob of one file, tried again on a transient failure; null when the server does not have it. */
  async function fetchBlob(item: TreeItem, path: string): Promise<Uint8Array | null> {
    for (let attempt = 0; ; attempt++) {
      inner.signal.throwIfAborted(); // the export ended while this file waited its turn
      try {
        return await opts.source.blob(item.hash, inner.signal);
      } catch (err) {
        if (inner.signal.aborted) throw err;
        if (err instanceof BlobNotFoundError) return null;
        const wait = retryMs[attempt];
        if (wait === undefined || !isRetryable(err)) throw new ExportInterruptedError(path, err);
        await pause(wait, inner.signal);
      }
    }
  }

  /**
   * Decrypts the path, fetches the blob, checks its hash and decrypts it: everything about one file
   * that does not depend on the others. Several run at once; only an abort or a download that failed
   * for good (ExportInterruptedError) rejects. The ciphertext is released when it returns: what waits
   * for the writer is the plaintext alone, as chunks (never copied into one buffer).
   */
  async function prepare(item: TreeItem): Promise<Prepared> {
    let path: string;
    try {
      path = (
        await decryptPathFor(opts.keys, vaultId, uuidBytes(item.file_id), item.path)
      ).normalize('NFC');
    } catch {
      return { skip: { path: item.path, reason: 'path_undecryptable' } };
    }
    const unsafe = checkZipName(path);
    if (unsafe) return { skip: { path, reason: 'unsafe_path', detail: unsafe } };
    const cipher = await fetchBlob(item, path);
    if (!cipher) return { path, skip: { path, reason: 'blob_missing' } };
    if ((await sha256Hex(cipher)) !== item.hash)
      return { path, skip: { path, reason: 'blob_corrupt' } };
    try {
      // Every chunk is authenticated before the file goes into the archive: one that fails leaves no
      // partial entry behind, only a line in the report.
      const plain = await decryptBlobChunks(opts.keys, vaultId, uuidBytes(item.file_id), cipher);
      return { path, plain, size: plain.reduce((n, c) => n + c.length, 0) };
    } catch {
      return { path, skip: { path, reason: 'decrypt_failed' } };
    }
  }

  /**
   * The ZIP entries in manifest order. Up to `concurrency` files are prepared ahead, within
   * `maxBytesAhead` bytes counting the file being written (bounded memory whatever the file sizes), so
   * a large vault costs about one round trip per `concurrency` files instead of one per file. What
   * depends on the files before (a duplicate path) is decided here, in order, so the archive and the
   * report are the same as with one file at a time.
   */
  async function* entries(): AsyncGenerator<ZipEntry> {
    try {
      const items = await opts.source.tree(inner.signal);
      report.total = items.length;
      opts.onProgress?.(report);
      const width = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
      const budget = Math.max(1, opts.maxBytesAhead ?? DEFAULT_MAX_BYTES_AHEAD);
      const ahead: { job: Promise<Prepared>; bytes: number }[] = [];
      let held = 0; // manifest bytes of the files in `ahead` and of the one being written
      let next = 0;
      const fill = () => {
        while (next < items.length && ahead.length < width) {
          const item = items[next] as TreeItem;
          const bytes = Number.isFinite(item.size) && item.size > 0 ? item.size : 0;
          // With nothing held a file goes even when it is larger than the budget (it is then alone).
          if (held > 0 && held + bytes > budget) return;
          next++;
          held += bytes;
          const job = prepare(item);
          job.catch(() => undefined); // awaited in order below; an abort must not be reported twice
          ahead.push({ job, bytes });
        }
      };
      const seen = new Set<string>();
      for (;;) {
        fill();
        const head = ahead.shift();
        if (!head) break;
        try {
          signal?.throwIfAborted();
          const r = await head.job;
          if (!('path' in r)) {
            skip(r.skip);
            continue;
          }
          if (seen.has(r.path)) {
            skip({ path: r.path, reason: 'duplicate_path' });
            continue;
          }
          if ('skip' in r) {
            skip(r.skip);
            continue;
          }
          seen.add(r.path);
          report.exported++;
          report.bytes += r.size;
          opts.onProgress?.(report);
          // Resumed once the writer took the whole entry: its bytes are released just below.
          yield { name: r.path, data: drain(r.plain), mtime: (opts.now ?? (() => new Date()))() };
        } finally {
          held -= head.bytes;
        }
      }
    } finally {
      // Complete, failed or cancelled: whatever is still being fetched is not needed any more.
      inner.abort(new DOMException('The export ended.', 'AbortError'));
    }
  }

  const zip = zipStream(entries(), opts.limits);
  if (!signal) return { stream: zip, report };
  // Abort errors the output stream even while a pull is idle.
  const reader = zip.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) c.close();
        else c.enqueue(value);
      } catch (err) {
        c.error(err);
        await reader.cancel().catch(() => undefined);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return { stream, report };
}
