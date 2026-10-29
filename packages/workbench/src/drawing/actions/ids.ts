const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A random element id, in the shape Excalidraw uses (21 alphanumeric characters). */
export function newId(): string {
  const bytes = new Uint8Array(21);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

export const newNonce = (): number => Math.floor(Math.random() * 2 ** 31);
