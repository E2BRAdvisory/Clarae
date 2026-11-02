import { argon2id } from 'hash-wasm';
import { b64, buf, concat, enc, equal, randomBytes, unb64, wipeBytes, withCopy } from './bytes';

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

const INFO_PATH_ENC = 'memobrain/v1/path-enc';
const INFO_PATH_KEY = 'memobrain/v1/path-key';
const INFO_FILE = 'memobrain/v1/file';
const INFO_RECOVERY_KEK = 'memobrain/v1/recovery-kek';

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
  const key = await withCopy(secret, (raw) =>
    subtle().importKey('raw', raw, 'HKDF', false, ['deriveBits']),
  );
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

/**
 * Derives the KEK from the passphrase normalized to Unicode NFC, so the same passphrase typed
 * as composed or decomposed characters derives the same key. Every new envelope uses it.
 */
export async function deriveKekPassphrase(passphrase: string, p: KdfParams): Promise<Uint8Array> {
  return deriveKekPassphraseRaw(passphrase.normalize('NFC'), p);
}

/**
 * Derives the KEK from the exact UTF-8 bytes of the passphrase, without normalization: the rule
 * of the envelopes written before NFC normalization, kept to open them (see openWithPassphrase).
 */
export async function deriveKekPassphraseRaw(
  passphrase: string,
  p: KdfParams,
): Promise<Uint8Array> {
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
  const password = enc.encode(passphrase);
  try {
    return await argon2id({
      password,
      salt,
      parallelism: par,
      iterations: t,
      memorySize: m,
      hashLength: KEY_SIZE,
      outputType: 'binary',
    });
  } finally {
    password.fill(0);
  }
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
  const input = concat(enc.encode('memobrain/v1/recovery-checksum'), key);
  try {
    const h = await withCopy(input, (data) => subtle().digest('SHA-256', data));
    return new Uint8Array(h).slice(0, 2);
  } finally {
    input.fill(0);
  }
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
  const bytes = concat(key, await recoveryChecksum(key));
  const raw = base32(bytes);
  bytes.fill(0);
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 5) groups.push(raw.slice(i, i + 5));
  return groups.join('-');
}

export async function parseRecoveryKey(s: string): Promise<Uint8Array> {
  const clean = s.replace(/[-\s]/g, '').toUpperCase();
  const raw = unbase32(clean);
  if (!raw || raw.length !== KEY_SIZE + 2) {
    wipeBytes(raw);
    throw new RecoveryKeyError();
  }
  const key = raw.slice(0, KEY_SIZE);
  const sum = raw.slice(KEY_SIZE);
  raw.fill(0);
  if (!equal(sum, await recoveryChecksum(key))) {
    key.fill(0);
    throw new RecoveryKeyError();
  }
  return key;
}

// ---- wrap / subkeys ----------------------------------------------------------

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return withCopy(raw, (copy) => subtle().importKey('raw', copy, 'AES-GCM', false, usage));
}

// Envelope formats (ADR-0034). v1 is nonce ‖ AES-256-GCM(KEK, VMK) ‖ tag without AAD,
// recognized by its length alone; v2 prefixes a version byte and binds the envelope to its
// vault and kind through the AAD "memobrain/v2/envelope" ‖ vault_id (16 bytes) ‖ kind.
export const WRAPPED_SIZE_V1 = NONCE_SIZE + KEY_SIZE + TAG_SIZE; // 60
export const WRAPPED_SIZE_V2 = 1 + WRAPPED_SIZE_V1; // 61
export const ENVELOPE_V2 = 0x02;
const AAD_ENVELOPE_V2 = 'memobrain/v2/envelope';

export type EnvelopeKind = 'passphrase' | 'recovery';

/** Additional data of a v2 envelope. */
export function envelopeAad(vaultId: Uint8Array, kind: string): Uint8Array {
  if (kind !== 'passphrase' && kind !== 'recovery')
    throw new Error(`unknown envelope kind ${kind}`);
  if (vaultId.length !== 16) throw new Error('vault id must be 16 bytes');
  return concat(enc.encode(AAD_ENVELOPE_V2), vaultId, enc.encode(kind));
}

/** Format of a wrapped VMK from its length and version byte: 1, 2, or 0 when neither. */
export function envelopeVersion(wrapped: Uint8Array): 0 | 1 | 2 {
  if (wrapped.length === WRAPPED_SIZE_V1) return 1;
  if (wrapped.length === WRAPPED_SIZE_V2 && wrapped[0] === ENVELOPE_V2) return 2;
  return 0;
}

/** Wraps the VMK in format v1 (the default writer until every client reads v2, ADR-0034). */
export async function wrap(
  kek: Uint8Array,
  vmk: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_SIZE),
): Promise<Uint8Array> {
  const key = await aesKey(kek, ['encrypt']);
  const ct = await withCopy(vmk, (plain) =>
    subtle().encrypt({ name: 'AES-GCM', iv: buf(nonce), tagLength: 128 }, key, plain),
  );
  return concat(nonce, new Uint8Array(ct));
}

/** Wraps the VMK in format v2, bound to the vault and the envelope kind. */
export async function wrapV2(
  kek: Uint8Array,
  vmk: Uint8Array,
  vaultId: Uint8Array,
  kind: EnvelopeKind,
  nonce: Uint8Array = randomBytes(NONCE_SIZE),
): Promise<Uint8Array> {
  const key = await aesKey(kek, ['encrypt']);
  const ct = await withCopy(vmk, (plain) =>
    subtle().encrypt(
      {
        name: 'AES-GCM',
        iv: buf(nonce),
        additionalData: buf(envelopeAad(vaultId, kind)),
        tagLength: 128,
      },
      key,
      plain,
    ),
  );
  return concat(Uint8Array.of(ENVELOPE_V2), nonce, new Uint8Array(ct));
}

/**
 * Recovers the VMK from a v1 or v2 envelope; a v2 envelope opens only for the vault and kind it
 * was written for. DecryptError means a wrong KEK, another vault or kind, or tampering.
 */
export async function unwrap(
  kek: Uint8Array,
  wrapped: Uint8Array,
  vaultId: Uint8Array,
  kind: string,
): Promise<Uint8Array> {
  const version = envelopeVersion(wrapped);
  if (version === 0) throw new DecryptError();
  let aad: Uint8Array | undefined;
  if (version === 2) {
    try {
      aad = envelopeAad(vaultId, kind);
    } catch {
      throw new DecryptError();
    }
  }
  const body = version === 2 ? wrapped.slice(1) : wrapped;
  try {
    const pt = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: buf(body.slice(0, NONCE_SIZE)),
        ...(aad ? { additionalData: buf(aad) } : {}),
        tagLength: 128,
      },
      await aesKey(kek, ['decrypt']),
      buf(body.slice(NONCE_SIZE)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError();
  }
}

/**
 * Encodings of a typed passphrase to try, in order, on an existing envelope: NFC (the rule of
 * every envelope written since normalization), then the exact input and its NFD form, which
 * open envelopes written earlier from the raw bytes of a non-NFC input. No duplicates.
 */
export function passphraseForms(passphrase: string): string[] {
  const forms = [passphrase.normalize('NFC')];
  for (const f of [passphrase, passphrase.normalize('NFD')]) if (!forms.includes(f)) forms.push(f);
  return forms;
}

export interface PassphraseUnlock {
  vmk: Uint8Array;
  /** KEK of the NFC form under the envelope's KDF parameters (to re-wrap under). */
  kek: Uint8Array;
  version: 1 | 2;
  /** Only a non-NFC form opened the envelope. */
  legacy: boolean;
}

/**
 * Derives the KEK from each form of the passphrase and unwraps with the first that works.
 * WeakKdfError comes before any derivation; DecryptError means no form opened it. An aborted
 * `signal` stops between two derivations (one Argon2id run cannot be interrupted) and leaves no
 * key behind.
 */
export async function openWithPassphrase(
  passphrase: string,
  p: KdfParams,
  wrapped: Uint8Array,
  vaultId: Uint8Array,
  signal?: AbortSignal,
): Promise<PassphraseUnlock> {
  const version = envelopeVersion(wrapped);
  if (version === 0) throw new DecryptError();
  const forms = passphraseForms(passphrase);
  let nfcKek: Uint8Array | undefined;
  for (const [i, form] of forms.entries()) {
    let kek: Uint8Array | undefined;
    try {
      signal?.throwIfAborted();
      kek = await deriveKekPassphraseRaw(form, p);
      if (i === 0) nfcKek = kek;
      signal?.throwIfAborted();
      const vmk = await unwrap(kek, wrapped, vaultId, 'passphrase');
      if (signal?.aborted) {
        vmk.fill(0);
        signal.throwIfAborted();
      }
      if (i > 0) kek.fill(0);
      return { vmk, kek: nfcKek ?? kek, version, legacy: i > 0 };
    } catch (err) {
      if (i > 0) wipeBytes(kek);
      if (!(err instanceof DecryptError)) {
        wipeBytes(nfcKek);
        throw err;
      }
    }
  }
  wipeBytes(nfcKek);
  throw new DecryptError();
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

/** The AES-GCM key of a file, imported for WebCrypto; the raw file key is zeroed at once. */
export async function fileCryptoKey(
  s: Subkeys,
  fileId: Uint8Array,
  salt: Uint8Array,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  const raw = await fileKey(s, fileId, salt);
  try {
    return await aesKey(raw, usage);
  } finally {
    raw.fill(0);
  }
}

/** Zeroes the subkeys of a vault (best effort, see wipeBytes). */
export function wipeSubkeys(s: Subkeys): void {
  wipeBytes(s.vmk, s.pathEnc, s.pathKey);
}

export { aesKey };
