import { aesKey, DecryptError, NONCE_SIZE, TAG_SIZE, type Subkeys } from './keys';
import { b64url, buf, concat, dec, enc, hex, randomBytes, unb64url } from './bytes';
import { FormatError } from './blob';

export const PATH_ENC_PREFIX = 'enc1:';
export const PATH_KEY_PREFIX = 'hmac1:';

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

export async function encryptPath(
  s: Subkeys,
  vaultId: Uint8Array,
  path: string,
  nonce: Uint8Array = randomBytes(NONCE_SIZE),
): Promise<string> {
  const norm = normalizePath(path);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(vaultId), tagLength: 128 },
    await aesKey(s.pathEnc, ['encrypt']),
    buf(enc.encode(norm)),
  );
  return PATH_ENC_PREFIX + b64url(concat(nonce, new Uint8Array(sealed)));
}

export async function decryptPath(s: Subkeys, vaultId: Uint8Array, token: string): Promise<string> {
  if (!token.startsWith(PATH_ENC_PREFIX)) throw new FormatError();
  let raw: Uint8Array;
  try {
    raw = unb64url(token.slice(PATH_ENC_PREFIX.length));
  } catch {
    throw new FormatError();
  }
  if (raw.length < NONCE_SIZE + TAG_SIZE) throw new FormatError();
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buf(raw.slice(0, NONCE_SIZE)),
        additionalData: buf(vaultId),
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
