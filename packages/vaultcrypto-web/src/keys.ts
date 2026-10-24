import { argon2id } from 'hash-wasm';
import { b64, buf, concat, enc, equal, randomBytes, unb64 } from './bytes';

export const KEY_SIZE = 32;
export const NONCE_SIZE = 12;
export const TAG_SIZE = 16;
export const SALT_SIZE = 16;

export const MIN_T = 3;
export const MIN_M_KIB = 64 * 1024;
export const MIN_P = 4;
const MAX_T = 12;
const MAX_M_KIB = 1024 * 1024;
const MAX_P = 16;

const INFO_PATH_ENC = 'nodus/v1/path-enc';
const INFO_PATH_KEY = 'nodus/v1/path-key';
const INFO_FILE = 'nodus/v1/file';
const INFO_RECOVERY_KEK = 'nodus/v1/recovery-kek';

export interface KdfParams {
  alg: string; // 'argon2id' | 'hkdf-sha256'
  t?: number;
  m_kib?: number;
  p?: number;
  /** standard base64 */
  salt: string;
}

export class DecryptError extends Error {
  constructor() {
    super('decryption failed');
    this.name = 'DecryptError';
  }
}
export class WeakKdfError extends Error {
  constructor(msg = 'unacceptable KDF parameters') {
    super(msg);
    this.name = 'WeakKdfError';
  }
}
export class RecoveryKeyError extends Error {
  constructor() {
    super('invalid recovery key');
    this.name = 'RecoveryKeyError';
  }
}

const subtle = (): SubtleCrypto => crypto.subtle;

export async function hkdf(
  secret: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', buf(secret), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
    key,
    KEY_SIZE * 8,
  );
  return new Uint8Array(bits);
}

export function generateKey(): Uint8Array {
  return randomBytes(KEY_SIZE);
}

export async function deriveKekPassphrase(passphrase: string, p: KdfParams): Promise<Uint8Array> {
  const { t = 0, m_kib: m = 0, p: par = 0 } = p;
  if (
    p.alg !== 'argon2id' ||
    t < MIN_T ||
    t > MAX_T ||
    m < MIN_M_KIB ||
    m > MAX_M_KIB ||
    par < MIN_P ||
    par > MAX_P
  )
    throw new WeakKdfError();
  let salt: Uint8Array;
  try {
    salt = unb64(p.salt);
  } catch {
    throw new WeakKdfError('bad salt');
  }
  if (salt.length < 8) throw new WeakKdfError('bad salt');
  return argon2id({
    password: passphrase,
    salt,
    parallelism: par,
    iterations: t,
    memorySize: m,
    hashLength: KEY_SIZE,
    outputType: 'binary',
  });
}

export function newPassphraseKdf(t = MIN_T, mKiB = MIN_M_KIB, p = MIN_P): KdfParams {
  return {
    alg: 'argon2id',
    t: Math.max(t, MIN_T),
    m_kib: Math.max(mKiB, MIN_M_KIB),
    p: Math.max(p, MIN_P),
    salt: b64(randomBytes(SALT_SIZE)),
  };
}

export function newRecoveryKdf(): KdfParams {
  return { alg: 'hkdf-sha256', salt: b64(randomBytes(SALT_SIZE)) };
}

export async function deriveKekRecovery(
  recoveryKey: Uint8Array,
  p: KdfParams,
): Promise<Uint8Array> {
  if (p.alg !== 'hkdf-sha256') throw new Error(`unsupported recovery kdf ${p.alg}`);
  return hkdf(recoveryKey, unb64(p.salt), enc.encode(INFO_RECOVERY_KEK));
}

// ---- recovery key text form ------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

async function recoveryChecksum(key: Uint8Array): Promise<Uint8Array> {
  const h = await subtle().digest(
    'SHA-256',
    buf(concat(enc.encode('nodus/v1/recovery-checksum'), key)),
  );
  return new Uint8Array(h).slice(0, 2);
}

function base32(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const x of b) {
    value = (value << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export async function encodeRecoveryKey(key: Uint8Array): Promise<string> {
  const raw = base32(concat(key, await recoveryChecksum(key)));
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 5) groups.push(raw.slice(i, i + 5));
  return groups.join('-');
}

export async function parseRecoveryKey(s: string): Promise<Uint8Array> {
  const clean = s.replace(/[-\s]/g, '').toUpperCase();
  const raw = unbase32(clean);
  if (!raw || raw.length !== KEY_SIZE + 2) throw new RecoveryKeyError();
  const key = raw.slice(0, KEY_SIZE);
  if (!equal(raw.slice(KEY_SIZE), await recoveryChecksum(key))) throw new RecoveryKeyError();
  return key;
}

// ---- wrap / subkeys ----------------------------------------------------------

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(raw), 'AES-GCM', false, usage);
}

export async function wrap(
  kek: Uint8Array,
  vmk: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_SIZE),
): Promise<Uint8Array> {
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: buf(nonce), tagLength: 128 },
    await aesKey(kek, ['encrypt']),
    buf(vmk),
  );
  return concat(nonce, new Uint8Array(ct));
}

export async function unwrap(kek: Uint8Array, wrapped: Uint8Array): Promise<Uint8Array> {
  if (wrapped.length !== NONCE_SIZE + KEY_SIZE + TAG_SIZE) throw new DecryptError();
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: buf(wrapped.slice(0, NONCE_SIZE)), tagLength: 128 },
      await aesKey(kek, ['decrypt']),
      buf(wrapped.slice(NONCE_SIZE)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError();
  }
}

export interface Subkeys {
  pathEnc: Uint8Array;
  pathKey: Uint8Array;
  vmk: Uint8Array;
}

export async function deriveSubkeys(vmk: Uint8Array): Promise<Subkeys> {
  const none = new Uint8Array(0);
  return {
    vmk,
    pathEnc: await hkdf(vmk, none, enc.encode(INFO_PATH_ENC)),
    pathKey: await hkdf(vmk, none, enc.encode(INFO_PATH_KEY)),
  };
}

export async function fileKey(
  s: Subkeys,
  fileId: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  return hkdf(s.vmk, new Uint8Array(0), concat(enc.encode(INFO_FILE), fileId, salt));
}

export { aesKey };
