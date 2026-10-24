import {
  aesKey,
  DecryptError,
  fileKey,
  NONCE_SIZE,
  SALT_SIZE,
  TAG_SIZE,
  type Subkeys,
} from './keys';
import { buf, concat, enc, randomBytes } from './bytes';

export const MAGIC = 'NDS1';
export const FORMAT_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
const HEADER_SIZE = 4 + 1 + SALT_SIZE + 4;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

export class FormatError extends Error {
  constructor() {
    super('not an NDS1 blob');
    this.name = 'FormatError';
  }
}

function aad(vaultId: Uint8Array, fileId: Uint8Array, index: number, last: boolean): Uint8Array {
  const tail = new Uint8Array(9);
  const dv = new DataView(tail.buffer);
  dv.setBigUint64(0, BigInt(index));
  tail[8] = last ? 1 : 0;
  return concat(vaultId, fileId, tail);
}

function nonce(index: number): Uint8Array {
  const n = new Uint8Array(NONCE_SIZE);
  new DataView(n.buffer).setBigUint64(4, BigInt(index));
  return n;
}

export async function encryptBlob(
  s: Subkeys,
  vaultId: Uint8Array,
  fileId: Uint8Array,
  plaintext: Uint8Array,
  opts: { salt?: Uint8Array; chunkSize?: number } = {},
): Promise<Uint8Array> {
  const salt = opts.salt ?? randomBytes(SALT_SIZE);
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE) throw new Error('invalid chunk size');
  const key = await aesKey(await fileKey(s, fileId, salt), ['encrypt']);
  const header = new Uint8Array(HEADER_SIZE);
  header.set(enc.encode(MAGIC), 0);
  header[4] = FORMAT_VERSION;
  header.set(salt, 5);
  new DataView(header.buffer).setUint32(5 + SALT_SIZE, chunkSize);

  const parts: Uint8Array[] = [header];
  const chunks = Math.max(1, Math.ceil(plaintext.length / chunkSize));
  for (let i = 0; i < chunks; i++) {
    const part = plaintext.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, plaintext.length));
    const sealed = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: buf(nonce(i)),
        additionalData: buf(aad(vaultId, fileId, i, i === chunks - 1)),
        tagLength: 128,
      },
      key,
      buf(part),
    );
    parts.push(new Uint8Array(sealed));
  }
  return concat(...parts);
}

export async function decryptBlob(
  s: Subkeys,
  vaultId: Uint8Array,
  fileId: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (
    blob.length < HEADER_SIZE ||
    new TextDecoder().decode(blob.subarray(0, 4)) !== MAGIC ||
    blob[4] !== FORMAT_VERSION
  )
    throw new FormatError();
  const salt = blob.slice(5, 5 + SALT_SIZE);
  const chunkSize = new DataView(blob.buffer, blob.byteOffset).getUint32(5 + SALT_SIZE);
  if (chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE) throw new FormatError();
  const body = blob.subarray(HEADER_SIZE);
  const sealedSize = chunkSize + TAG_SIZE;
  if (body.length < TAG_SIZE) throw new FormatError();
  const chunks = Math.ceil(body.length / sealedSize);
  const lastLen = body.length - (chunks - 1) * sealedSize;
  if (lastLen < TAG_SIZE) throw new FormatError(); // trailing bytes too short to be a chunk
  const key = await aesKey(await fileKey(s, fileId, salt), ['decrypt']);
  const out: Uint8Array[] = [];
  for (let i = 0; i < chunks; i++) {
    const sealed = body.subarray(i * sealedSize, Math.min((i + 1) * sealedSize, body.length));
    try {
      const pt = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buf(nonce(i)),
          additionalData: buf(aad(vaultId, fileId, i, i === chunks - 1)),
          tagLength: 128,
        },
        key,
        buf(sealed),
      );
      out.push(new Uint8Array(pt));
    } catch {
      throw new DecryptError();
    }
  }
  return concat(...out);
}
