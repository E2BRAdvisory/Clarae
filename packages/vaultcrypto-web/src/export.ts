// Browser-side ZIP export of a private (end-to-end encrypted) vault: unlock the VMK with the
// passphrase or the recovery key, decrypt the manifest paths and every blob, and stream the
// plaintext into a ZIP. The server only ever serves ciphertext; keys stay in memory.
import { unb64, uuidBytes } from './bytes';
import { decryptBlob } from './blob';
import { decryptPath } from './path';
import {
  DecryptError,
  deriveKekPassphrase,
  deriveKekRecovery,
  deriveSubkeys,
  parseRecoveryKey,
  unwrap,
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

/** Key material of an unlocked vault. Call {@link wipe} when done. */
export interface Unlocked {
  keys: Subkeys;
  wipe(): void;
}

/**
 * Derives the KEK from the secret and unwraps the VMK. Throws DecryptError for a wrong
 * passphrase or recovery key (the AEAD tag does not verify), WeakKdfError for unacceptable
 * KDF parameters and RecoveryKeyError for a malformed recovery key.
 */
export async function unlockVault(envelopes: Envelope[], secret: Secret): Promise<Unlocked> {
  const env = envelopes.find((e) => e.kind === secret.kind);
  if (!env) throw new MissingEnvelopeError(secret.kind);
  let kek: Uint8Array;
  let recovery: Uint8Array | undefined;
  if (secret.kind === 'passphrase') {
    kek = await deriveKekPassphrase(secret.passphrase, env.kdf);
  } else {
    recovery = await parseRecoveryKey(secret.recoveryKey);
    kek = await deriveKekRecovery(recovery, env.kdf);
  }
  let vmk: Uint8Array;
  try {
    vmk = await unwrap(kek, unb64(env.wrapped_vmk));
  } catch (err) {
    if (err instanceof DecryptError) throw err;
    throw new DecryptError();
  } finally {
    kek.fill(0);
    recovery?.fill(0);
  }
  const keys = await deriveSubkeys(vmk);
  return {
    keys,
    wipe() {
      keys.vmk.fill(0);
      keys.pathEnc.fill(0);
      keys.pathKey.fill(0);
    },
  };
}

export interface TreeItem {
  path: string;
  file_id: string;
  hash: string;
  size: number;
}

/** What the export needs from the server: the manifest and the (encrypted) blobs. */
export interface VaultSource {
  tree(signal?: AbortSignal): Promise<TreeItem[]>;
  blob(hash: string, signal?: AbortSignal): Promise<Uint8Array>;
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
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Streams the decrypted vault as a ZIP. A file that cannot be exported (unsafe path, corrupt or
 * missing blob) is skipped and listed in the report; the rest of the archive is still produced.
 * Aborting the signal errors the stream.
 */
export function exportPrivateVault(opts: ExportOptions): {
  stream: ReadableStream<Uint8Array>;
  report: ExportReport;
} {
  const report: ExportReport = { exported: 0, bytes: 0, skipped: [], total: 0 };
  const vaultId = uuidBytes(opts.vaultId);
  const { signal } = opts;
  const skip = (s: Skipped) => {
    report.skipped.push(s);
    opts.onProgress?.(report);
  };

  async function* entries(): AsyncGenerator<ZipEntry> {
    const items = await opts.source.tree(signal);
    report.total = items.length;
    opts.onProgress?.(report);
    const seen = new Set<string>();
    for (const item of items) {
      signal?.throwIfAborted();
      let path: string;
      try {
        path = (await decryptPath(opts.keys, vaultId, item.path)).normalize('NFC');
      } catch {
        skip({ path: item.path, reason: 'path_undecryptable' });
        continue;
      }
      const unsafe = checkZipName(path);
      if (unsafe) {
        skip({ path, reason: 'unsafe_path', detail: unsafe });
        continue;
      }
      if (seen.has(path)) {
        skip({ path, reason: 'duplicate_path' });
        continue;
      }
      let cipher: Uint8Array;
      try {
        cipher = await opts.source.blob(item.hash, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        skip({ path, reason: 'blob_missing', detail: err instanceof Error ? err.message : '' });
        continue;
      }
      if ((await sha256Hex(cipher)) !== item.hash) {
        skip({ path, reason: 'blob_corrupt' });
        continue;
      }
      let plain: Uint8Array;
      try {
        plain = await decryptBlob(opts.keys, vaultId, uuidBytes(item.file_id), cipher);
      } catch {
        skip({ path, reason: 'decrypt_failed' });
        continue;
      }
      seen.add(path);
      report.exported++;
      report.bytes += plain.length;
      opts.onProgress?.(report);
      yield { name: path, data: plain, mtime: (opts.now ?? (() => new Date()))() };
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
