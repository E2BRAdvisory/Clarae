import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DecryptError,
  RecoveryKeyError,
  WeakKdfError,
  b64,
  deriveKekPassphrase,
  deriveKekRecovery,
  deriveSubkeys,
  encodeRecoveryKey,
  encryptBlob,
  encryptPath,
  encryptPathV2,
  generateKey,
  hex,
  newPassphraseKdf,
  newRecoveryKdf,
  wrap,
  wrapV2,
  type Subkeys,
} from './index';
import {
  BlobNotFoundError,
  ExportInterruptedError,
  KeysWipedError,
  MissingEnvelopeError,
  expireWhenIdle,
  exportPrivateVault,
  holdKeys,
  unlockVault,
  type Envelope,
  type TreeItem,
  type VaultSource,
} from './export';
import { uuidBytes } from './bytes';
import { collect, readZip } from './zipreader.testutil';

const VAULT = '0190a3b4-1111-7222-8333-444455556666';
const PASS = 'correct horse battery staple';
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);

async function sha256Hex(b: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))));
}

interface Fixture {
  envelopes: Envelope[];
  recoveryText: string;
  keys: Subkeys;
  tree: TreeItem[];
  blobs: Map<string, Uint8Array>;
  plain: Record<string, string>;
}

let fx: Fixture;

async function addFile(
  f: Pick<Fixture, 'tree' | 'blobs' | 'keys'>,
  logical: string,
  content: string,
  fileId: string,
  opts: { rawPath?: string } = {},
) {
  const data = enc(content);
  const cipher = await encryptBlob(f.keys, uuidBytes(VAULT), uuidBytes(fileId), data, {
    chunkSize: 16, // several chunks per file
  });
  const hash = await sha256Hex(cipher);
  f.blobs.set(hash, cipher);
  f.tree.push({
    path: opts.rawPath ?? (await encryptPath(f.keys, uuidBytes(VAULT), logical)),
    file_id: fileId,
    hash,
    size: cipher.length,
  });
}

beforeAll(async () => {
  const vmk = generateKey();
  const keys = await deriveSubkeys(vmk);
  const pk = newPassphraseKdf();
  const kekP = await deriveKekPassphrase(PASS, pk);
  const recovery = generateKey();
  const rk = newRecoveryKdf();
  const kekR = await deriveKekRecovery(recovery, rk);
  const envelopes: Envelope[] = [
    { kind: 'passphrase', kdf: pk, wrapped_vmk: b64(await wrap(kekP, vmk)) },
    // The recovery envelope is in format v2 (ADR-0034): the export reads both.
    {
      kind: 'recovery',
      kdf: rk,
      wrapped_vmk: b64(await wrapV2(kekR, vmk, uuidBytes(VAULT), 'recovery')),
    },
  ];
  const f = { tree: [] as TreeItem[], blobs: new Map<string, Uint8Array>(), keys };
  const plain = {
    'notes/a.md': '# Alpha\nsome text that spans several 16-byte chunks',
    'notes/日本/b.md': 'bravo',
    'empty.txt': '',
  };
  let n = 0;
  for (const [p, c] of Object.entries(plain))
    await addFile(f, p, c, `0190a3b4-aaaa-7222-8333-00000000000${n++}`);
  fx = { envelopes, recoveryText: await encodeRecoveryKey(recovery), plain, ...f };
}, 60_000);

function source(f: Pick<Fixture, 'tree' | 'blobs'>, tweak?: Partial<VaultSource>): VaultSource {
  return {
    tree: () => Promise.resolve(f.tree),
    blob: (h) => {
      const b = f.blobs.get(h);
      return b ? Promise.resolve(b) : Promise.reject(new BlobNotFoundError(h));
    },
    ...tweak,
  };
}

describe('unlockVault', () => {
  it('unlocks with the passphrase', async () => {
    const u = await unlockVault(fx.envelopes, { kind: 'passphrase', passphrase: PASS }, VAULT);
    expect(hex(u.keys.vmk)).toBe(hex(fx.keys.vmk));
    const { vmk, pathEnc, pathKey } = u.keys;
    u.wipe();
    // Every key is zeroed and dropped: a later use fails instead of working on zeros.
    for (const k of [vmk, pathEnc, pathKey]) expect(k.every((x) => x === 0)).toBe(true);
    expect(u.wiped).toBe(true);
    expect(() => u.keys).toThrow(KeysWipedError);
    u.wipe(); // idempotent
  }, 60_000);

  it('stops on an aborted signal and keeps no key', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      unlockVault(fx.envelopes, { kind: 'passphrase', passphrase: PASS }, VAULT, ac.signal),
    ).rejects.toThrow();
    // Aborted during the derivation: the unlock does not finish.
    const late = new AbortController();
    const pending = unlockVault(
      fx.envelopes,
      { kind: 'passphrase', passphrase: PASS },
      VAULT,
      late.signal,
    );
    late.abort();
    await expect(pending).rejects.toThrow();
  }, 60_000);

  it('rejects a wrong passphrase with DecryptError', async () => {
    await expect(
      unlockVault(fx.envelopes, { kind: 'passphrase', passphrase: 'nope' }, VAULT),
    ).rejects.toBeInstanceOf(DecryptError);
  }, 60_000);

  it('unlocks with the recovery key and reports malformed or wrong ones', async () => {
    const u = await unlockVault(
      fx.envelopes,
      { kind: 'recovery', recoveryKey: fx.recoveryText },
      VAULT,
    );
    expect(hex(u.keys.vmk)).toBe(hex(fx.keys.vmk));
    await expect(
      unlockVault(fx.envelopes, { kind: 'recovery', recoveryKey: 'AAAAA-BBBBB' }, VAULT),
    ).rejects.toBeInstanceOf(RecoveryKeyError);
    const other = await encodeRecoveryKey(generateKey());
    await expect(
      unlockVault(fx.envelopes, { kind: 'recovery', recoveryKey: other }, VAULT),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it('refuses a v2 envelope served for another vault', async () => {
    await expect(
      unlockVault(
        fx.envelopes,
        { kind: 'recovery', recoveryKey: fx.recoveryText },
        '0190a3b4-1111-7222-8333-444455550000',
      ),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it('refuses weak KDF parameters and reports a missing envelope', async () => {
    const weak: Envelope[] = [
      {
        kind: 'passphrase',
        kdf: { alg: 'argon2id', t: 1, m_kib: 8, p: 1, salt: b64(new Uint8Array(16)) },
        wrapped_vmk: b64(new Uint8Array(60)),
      },
    ];
    await expect(
      unlockVault(weak, { kind: 'passphrase', passphrase: 'x' }, VAULT),
    ).rejects.toBeInstanceOf(WeakKdfError);
    await expect(
      unlockVault(weak, { kind: 'recovery', recoveryKey: fx.recoveryText }, VAULT),
    ).rejects.toBeInstanceOf(MissingEnvelopeError);
  });
});

describe('exportPrivateVault', () => {
  it('produces a ZIP equal to the original plaintext tree', async () => {
    const { stream, report } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      source: source(fx),
    });
    const z = readZip(await collect(stream));
    const got = Object.fromEntries(z.entries.map((e) => [e.name, dec(e.data)]));
    expect(got).toEqual(fx.plain);
    expect(report).toMatchObject({ exported: 3, skipped: [], total: 3 });
    expect(report.bytes).toBe(Object.values(fx.plain).reduce((n, s) => n + enc(s).length, 0));
  });

  it('skips and reports unsafe paths, corrupt and missing blobs, keeping the rest', async () => {
    const f = { tree: [...fx.tree], blobs: new Map(fx.blobs), keys: fx.keys };
    await addFile(f, 'x', 'evil', '0190a3b4-bbbb-7222-8333-000000000001', {
      rawPath: await encryptPathRaw('../../etc/passwd'),
    });
    await addFile(f, 'bad.md', 'corrupt me', '0190a3b4-bbbb-7222-8333-000000000002');
    const corruptItem = f.tree[f.tree.length - 1] as TreeItem;
    const orig = f.blobs.get(corruptItem.hash) as Uint8Array;
    const flipped = orig.slice();
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
    // served bytes do not match the manifest hash
    f.blobs.set(corruptItem.hash, flipped);
    await addFile(f, 'gone.md', 'missing', '0190a3b4-bbbb-7222-8333-000000000003');
    f.blobs.delete((f.tree[f.tree.length - 1] as TreeItem).hash);
    f.tree.push({ ...fx.tree[0]!, path: 'enc1:not-valid' });

    const { stream, report } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      source: source(f),
    });
    const z = readZip(await collect(stream));
    expect(z.entries.map((e) => e.name).sort()).toEqual(Object.keys(fx.plain).sort());
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.path, s.reason]));
    expect(reasons).toMatchObject({
      '../../etc/passwd': 'unsafe_path',
      'bad.md': 'blob_corrupt',
      'gone.md': 'blob_missing',
      'enc1:not-valid': 'path_undecryptable',
    });
  });

  it('names a blob that fails authenticated decryption as skipped (wrong file id)', async () => {
    const f = { tree: [...fx.tree], blobs: new Map(fx.blobs), keys: fx.keys };
    const first = f.tree[0] as TreeItem;
    f.tree[0] = { ...first, file_id: '0190a3b4-cccc-7222-8333-000000000009' };
    const { stream, report } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      source: source(f),
    });
    await collect(stream);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ path: 'notes/a.md', reason: 'decrypt_failed' });
  });

  it('reads enc2 path tokens and skips one bound to another file (ADR-0042)', async () => {
    const f = { tree: [...fx.tree], blobs: new Map(fx.blobs), keys: fx.keys };
    const idA = '0190a3b4-dddd-7222-8333-000000000001';
    const idB = '0190a3b4-dddd-7222-8333-000000000002';
    await addFile(f, 'v2/a.md', 'enc2 file', idA, {
      rawPath: await encryptPathV2(fx.keys, uuidBytes(VAULT), uuidBytes(idA), 'v2/a.md'),
    });
    // A hostile server pairs file B with the token of file A.
    await addFile(f, 'v2/b.md', 'other file', idB, {
      rawPath: await encryptPathV2(fx.keys, uuidBytes(VAULT), uuidBytes(idA), 'v2/b.md'),
    });
    const swapped = (f.tree[f.tree.length - 1] as TreeItem).path;
    const { stream, report } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      source: source(f),
    });
    const z = readZip(await collect(stream));
    expect(z.entries.map((e) => e.name)).toContain('v2/a.md');
    expect(z.entries.map((e) => e.name)).not.toContain('v2/b.md');
    expect(report.skipped).toEqual([{ path: swapped, reason: 'path_undecryptable' }]);
  });

  it('fetches several blobs at once, bounded, and keeps the manifest order', async () => {
    const f = { tree: [...fx.tree], blobs: new Map(fx.blobs), keys: fx.keys };
    for (let i = 0; i < 9; i++)
      await addFile(f, `many/${i}.md`, `file ${i}`, `0190a3b4-cccc-7222-8333-00000000000${i}`);
    let inFlight = 0;
    let peak = 0;
    let n = 0;
    const { stream, report } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      concurrency: 4,
      source: source(f, {
        // Later requests answer first: the archive must not follow the network.
        blob: async (h) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 20 - (n++ % 4) * 5));
          inFlight--;
          return f.blobs.get(h) as Uint8Array;
        },
      }),
    });
    const z = readZip(await collect(stream));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    const names = [
      ...Object.keys(fx.plain),
      ...Array.from({ length: 9 }, (_, i) => `many/${i}.md`),
    ];
    expect(z.entries.map((e) => e.name)).toEqual(names);
    expect(report).toMatchObject({ exported: f.tree.length, skipped: [], total: f.tree.length });
  });

  it('tries a blob again after a transient failure, and the archive is complete', async () => {
    const failures = new Map<string, number>();
    const { stream, report } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      retryMs: [0, 0],
      source: source(fx, {
        blob: (h) => {
          const n = failures.get(h) ?? 0;
          failures.set(h, n + 1);
          // Every blob fails twice (a network blip, a 503) before it is served.
          if (n < 2) return Promise.reject(new TypeError('Failed to fetch'));
          return Promise.resolve(fx.blobs.get(h) as Uint8Array);
        },
      }),
    });
    const z = readZip(await collect(stream));
    expect(z.entries).toHaveLength(3);
    expect(report).toMatchObject({ exported: 3, skipped: [] });
    expect([...failures.values()]).toEqual([3, 3, 3]);
  });

  it('stops with ExportInterruptedError, not "missing", when a blob keeps failing', async () => {
    const { stream, report } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      retryMs: [0, 0],
      source: source(fx, { blob: () => Promise.reject(new Error('503 Service Unavailable')) }),
    });
    const err = await collect(stream).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportInterruptedError);
    expect((err as ExportInterruptedError).path).toBe('notes/a.md');
    expect((err as Error).message).toContain('503');
    expect(report.skipped).toEqual([]); // nothing is reported as missing
  });

  it('stops at once on an error that is not worth retrying (a 401 or 403)', async () => {
    let calls = 0;
    const denied = Object.assign(new Error('403 Forbidden'), { status: 403 });
    const { stream } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      concurrency: 1,
      retryMs: [0, 0, 0],
      isRetryable: (e) => (e as { status?: number }).status !== 403,
      source: source(fx, {
        blob: () => {
          calls++;
          return Promise.reject(denied);
        },
      }),
    });
    const err = await collect(stream).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportInterruptedError);
    expect((err as Error).cause).toBe(denied);
    expect(calls).toBe(1);
  });

  it('cancels the downloads still in flight once the export failed', async () => {
    const signals: AbortSignal[] = [];
    const { stream } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      retryMs: [],
      source: source(fx, {
        blob: (h, signal) => {
          signals.push(signal as AbortSignal);
          // The first file fails for good; the others never answer.
          if (h === fx.tree[0]?.hash)
            return new Promise<Uint8Array>((_, reject) =>
              setTimeout(() => reject(new Error('500')), 10),
            );
          return new Promise<Uint8Array>(() => undefined);
        },
      }),
    });
    await expect(collect(stream)).rejects.toBeInstanceOf(ExportInterruptedError);
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('bounds the bytes fetched ahead, a file larger than the budget going alone', async () => {
    const f = { tree: [...fx.tree], blobs: new Map(fx.blobs), keys: fx.keys };
    for (let i = 0; i < 6; i++)
      await addFile(f, `big/${i}.bin`, 'x'.repeat(200), `0190a3b4-eeee-7222-8333-00000000000${i}`);
    let inFlight = 0;
    let peakBytes = 0;
    const sizes = new Map(f.tree.map((t) => [t.hash, t.size]));
    const { stream } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      concurrency: 6,
      maxBytesAhead: 300, // each big file is ~350 bytes of ciphertext: one at a time
      source: source(f, {
        blob: async (h) => {
          inFlight += sizes.get(h) as number;
          peakBytes = Math.max(peakBytes, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight -= sizes.get(h) as number;
          return f.blobs.get(h) as Uint8Array;
        },
      }),
    });
    const z = readZip(await collect(stream));
    expect(z.entries).toHaveLength(f.tree.length);
    const big = Math.max(...f.tree.map((t) => t.size));
    expect(big).toBeGreaterThan(300);
    expect(peakBytes).toBe(big);
    expect(new TextDecoder().decode(z.entries.at(-1)?.data)).toBe('x'.repeat(200));
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    const { stream } = exportPrivateVault({
      vaultId: VAULT,
      keys: fx.keys,
      source: source(fx, {
        blob: (h) => {
          ac.abort();
          return Promise.resolve(fx.blobs.get(h) as Uint8Array);
        },
      }),
      signal: ac.signal,
    });
    await expect(collect(stream)).rejects.toBeTruthy();
  });
});

/** An opaque path token whose plaintext is not a valid logical path (as a hostile server could serve). */
async function encryptPathRaw(plain: string): Promise<string> {
  const { aesKey, NONCE_SIZE } = await import('./keys');
  const { b64url, concat, randomBytes } = await import('./bytes');
  const nonce = randomBytes(NONCE_SIZE);
  const sealed = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(nonce),
      additionalData: new Uint8Array(uuidBytes(VAULT)),
      tagLength: 128,
    },
    await aesKey(fx.keys.pathEnc, ['encrypt']),
    new Uint8Array(enc(plain)),
  );
  return 'enc1:' + b64url(concat(nonce, new Uint8Array(sealed)));
}

describe('key expiry', () => {
  const keys = (): Subkeys => ({
    vmk: new Uint8Array(32).fill(1),
    pathEnc: new Uint8Array(32).fill(2),
    pathKey: new Uint8Array(32).fill(3),
  });

  it('wipes the keys after the idle time, unless touched or paused', () => {
    vi.useFakeTimers();
    try {
      const k = keys();
      const u = holdKeys(k);
      const onExpire = vi.fn();
      const watch = expireWhenIdle(u, 1_000, onExpire);
      vi.advanceTimersByTime(900);
      watch.touch();
      vi.advanceTimersByTime(900);
      expect(u.wiped).toBe(false);
      watch.pause(); // an export is running
      vi.advanceTimersByTime(5_000);
      expect(u.wiped).toBe(false);
      watch.touch();
      vi.advanceTimersByTime(1_000);
      expect(u.wiped).toBe(true);
      expect(onExpire).toHaveBeenCalledOnce();
      expect(k.vmk.every((x) => x === 0) && k.pathKey.every((x) => x === 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never expires without a positive time, and stop() ends the watch', () => {
    vi.useFakeTimers();
    try {
      const u = holdKeys(keys());
      expireWhenIdle(u, 0, () => undefined);
      const v = holdKeys(keys());
      expireWhenIdle(v, 1_000, () => undefined).stop();
      vi.advanceTimersByTime(60_000);
      expect(u.wiped || v.wiped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
