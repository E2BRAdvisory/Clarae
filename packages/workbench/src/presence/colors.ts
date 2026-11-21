// The colour of a person in a shared file (ADR-0065): derived from the user id alone, so the same user has the
// same colour on every screen, in every file and in every session; never random. The avatar, the pointer and its
// label all take it from here. The palette is fixed and its tokens (styles/tokens.css, --presence-N and
// --presence-N-fg) follow the theme and are checked for contrast (tokens.contrast.test.ts).

/** How many colours the palette has (--presence-1 … --presence-8). */
export const PALETTE_SIZE = 8;

export interface UserColor {
  /** 1 … PALETTE_SIZE. */
  index: number;
  /** A CSS colour: the token of the background. */
  background: string;
  /** The token of the text drawn on `background`. */
  foreground: string;
}

/** FNV-1a (32 bits) over the UTF-16 units of the id: stable across runs and platforms. */
export function hashOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function getUserColor(userId: string): UserColor {
  const index = (hashOf(userId) % PALETTE_SIZE) + 1;
  return {
    index,
    background: `var(--presence-${index})`,
    foreground: `var(--presence-${index}-fg)`,
  };
}
