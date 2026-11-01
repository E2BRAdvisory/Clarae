import { beforeAll, describe, expect, it } from 'vitest';
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
  MissingEnvelopeError,
  exportPrivateVault,
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
      return b ? Promise.resolve(b) : Promise.reject(new Error('404'));
    },
    ...tweak,
  };
}

describe('unlockVault', () => {
  it('unlocks with the passphrase', async () => {
    const u = await unlockVault(fx.envelopes, { kind: 'passphrase', passphrase: PASS }, VAULT);
    expect(hex(u.keys.vmk)).toBe(hex(fx.keys.vmk));
    u.wipe();
    expect(u.keys.vmk.every((x) => x === 0)).toBe(true);
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
