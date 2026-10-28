// Color helpers for the style actions. Excalidraw stores colors as "#rgb", "#rrggbb",
// "#rrggbbaa" or "transparent"; anything else (named colors, rgb()) is left untouched.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== 'string') return null;
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input.trim());
  const hex = m?.[1];
  if (!hex) return null;
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  const byte = (i: number): number => parseInt(full.slice(i, i + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 };
}

const hex2 = (n: number): string =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');

/** "#rrggbb", or "#rrggbbaa" when not fully opaque. */
export function formatColor(c: Rgba): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return c.a >= 1 ? base : base + hex2(c.a * 255);
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl({ r, g, b }: Rgba): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255] as const;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function fromHsl({ h, s, l }: Hsl, a: number): Rgba {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return { r: ((r ?? 0) + m) * 255, g: ((g ?? 0) + m) * 255, b: ((b ?? 0) + m) * 255, a };
}

/** Shifts the HSL lightness by `delta` (-1..1), keeping hue, saturation and alpha. */
export function shiftLightness(color: unknown, delta: number): string | null {
  const c = parseColor(color);
  if (!c) return null;
  const hsl = toHsl(c);
  return formatColor(fromHsl({ ...hsl, l: Math.min(1, Math.max(0, hsl.l + delta)) }, c.a));
}

/** Replaces the alpha channel (0..1). */
export function withAlpha(color: unknown, alpha: number): string | null {
  const c = parseColor(color);
  return c ? formatColor({ ...c, a: Math.min(1, Math.max(0, alpha)) }) : null;
}

/** Inverts the RGB channels, keeping alpha. */
export function invertColor(color: unknown): string | null {
  const c = parseColor(color);
  return c ? formatColor({ r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a }) : null;
}
