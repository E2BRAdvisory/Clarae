import { aesKey, DecryptError, NONCE_SIZE, TAG_SIZE, type Subkeys } from './keys';
import { b64url, buf, concat, dec, enc, hex, randomBytes, unb64url } from './bytes';
import { FormatError } from './blob';

export const PATH_ENC_PREFIX = 'enc1:';
/** enc2 tokens (ADR-0042) are bound to the vault and to the file id. */
export const PATH_ENC_PREFIX_V2 = 'enc2:';
export const PATH_KEY_PREFIX = 'hmac1:';

const AAD_PATH_V2 = 'memobrain/v2/path';

/** NFC-normalizes and rejects the structural errors the server would (empty/relative segments). */
export function normalizePath(p: string): string {
  const n = p.normalize('NFC');
  if (n === '' || n.startsWith('/')) throw new Error(`invalid path ${JSON.stringify(p)}`);
  for (const seg of n.split('/')) {
    if (seg === '' || seg === '.' || seg === '..')
      throw new Error(`invalid path ${JSON.stringify(p)}`);
  }
  return n;
}

/** Case-insensitive identity: NFC + case folding (upper then lower approximates Unicode full folding, e.g. ß → ss). */
export function foldPath(normalized: string): string {
  return normalized.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

/** AAD of an enc2 token: "memobrain/v2/path" ‖ vault_id (16 B) ‖ file_id (16 B). */
export function pathAadV2(vaultId: Uint8Array, fileId: Uint8Array): Uint8Array {
  return concat(enc.encode(AAD_PATH_V2), vaultId, fileId);
}

/** Format of a path token from its prefix: 1, 2, or 0 when it is neither. */
export function pathTokenVersion(token: string): 0 | 1 | 2 {
  if (token.startsWith(PATH_ENC_PREFIX)) return 1;
  if (token.startsWith(PATH_ENC_PREFIX_V2)) return 2;
  return 0;
}

async function sealPath(
  s: Subkeys,
  prefix: string,
  aad: Uint8Array,
  path: string,
  nonce: Uint8Array,
): Promise<string> {
  const norm = normalizePath(path);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad), tagLength: 128 },
    await aesKey(s.pathEnc, ['encrypt']),
    buf(enc.encode(norm)),
  );
  return prefix + b64url(concat(nonce, new Uint8Array(sealed)));
}

async function openPath(s: Subkeys, aad: Uint8Array, body: string): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = unb64url(body);
  } catch {
    throw new FormatError();
  }
  if (raw.length < NONCE_SIZE + TAG_SIZE) throw new FormatError();
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buf(raw.slice(0, NONCE_SIZE)),
        additionalData: buf(aad),
        tagLength: 128,
      },
      await aesKey(s.pathEnc, ['decrypt']),
      buf(raw.slice(NONCE_SIZE)),
    );
    return dec.decode(pt);
  } catch {
    throw new DecryptError();
  }
}

/** enc1 token: bound to the vault only (AAD = vault_id). */
export async function encryptPath(
  s: Subkeys,
  vaultId: Uint8Array,
  path: string,
  nonce: Uint8Array = randomBytes(NONCE_SIZE),
): Promise<string> {
  return sealPath(s, PATH_ENC_PREFIX, vaultId, path, nonce);
}

/** enc2 token of the path of one file (ADR-0042). */
export async function encryptPathV2(
  s: Subkeys,
  vaultId: Uint8Array,
  fileId: Uint8Array,
  path: string,
  nonce: Uint8Array = randomBytes(NONCE_SIZE),
): Promise<string> {
  return sealPath(s, PATH_ENC_PREFIX_V2, pathAadV2(vaultId, fileId), path, nonce);
}

/** Opens an enc1 token; an enc2 token needs its file id ({@link decryptPathFor}) and is a FormatError here. */
export async function decryptPath(s: Subkeys, vaultId: Uint8Array, token: string): Promise<string> {
  if (!token.startsWith(PATH_ENC_PREFIX)) throw new FormatError();
  return openPath(s, vaultId, token.slice(PATH_ENC_PREFIX.length));
}

/**
 * Opens the path token of one file in either format: enc1 is checked against the vault, enc2
 * against the vault and the file. DecryptError: altered, or bound to another vault/file;
 * FormatError: not a path token.
 */
export async function decryptPathFor(
  s: Subkeys,
  vaultId: Uint8Array,
  fileId: Uint8Array,
  token: string,
): Promise<string> {
  switch (pathTokenVersion(token)) {
    case 1:
      return openPath(s, vaultId, token.slice(PATH_ENC_PREFIX.length));
    case 2:
      return openPath(s, pathAadV2(vaultId, fileId), token.slice(PATH_ENC_PREFIX_V2.length));
    default:
      throw new FormatError();
  }
}

export async function pathKey(s: Subkeys, path: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    buf(s.pathKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, buf(enc.encode(foldPath(normalizePath(path)))));
  return PATH_KEY_PREFIX + hex(new Uint8Array(mac));
}
