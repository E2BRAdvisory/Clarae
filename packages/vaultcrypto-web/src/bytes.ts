export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function unhex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function b64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function b64url(b: Uint8Array): string {
  return b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return unb64(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

export function uuidBytes(id: string): Uint8Array {
  const h = id.replace(/-/g, '');
  if (h.length !== 32) throw new Error(`bad uuid ${id}`);
  return unhex(h);
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto rejects some shared/offset views). */
export function buf(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b);
}
