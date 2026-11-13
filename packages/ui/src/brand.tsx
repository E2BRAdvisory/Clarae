/* The mark of Clarae notanda, drawn inline: no request, no external file. The three shapes are the
   ones of assets/brand/mark.svg (brand.test.ts keeps them the same) and take their colours from the
   --nd-mark-* tokens (tokens.css), so the mark follows the theme and a header band can give it the
   colours for Deep Navy. */

/** The path data of the three shapes: the upper band, the lower band and the side. */
export const BRAND_MARK_PATHS = [
  'M49.89 285.78 L49.89 193.37 A89.54 89.54 0 0 1 98.79 113.58 L237.02 43.15 A65.61 65.61 0 0 1 296.60 160.08 Z',
  'M152.85 278.68 L296.60 351.92 A65.61 65.61 0 0 1 237.02 468.85 L93.27 395.60 A65.61 65.61 0 0 1 152.85 278.68 Z',
  'M351.33 101.12 A6.18 6.18 0 0 1 360.60 95.77 L432.00 136.99 A60.21 60.21 0 0 1 462.11 189.14 L462.11 322.09 A60.21 60.21 0 0 1 432.00 374.23 L360.60 415.46 A6.18 6.18 0 0 1 351.33 410.11 Z',
] as const;

export interface BrandMarkProps {
  /** Side of the square the mark is drawn in, in CSS pixels. */
  size?: number;
  /** Accessible name; without it the mark is decorative (the product name is next to it). */
  title?: string;
  className?: string;
}

export function BrandMark({ size = 24, title, className }: BrandMarkProps) {
  return (
    <svg
      className={className ? `brand-mark ${className}` : 'brand-mark'}
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path fill="var(--nd-mark-1)" d={BRAND_MARK_PATHS[0]} />
      <path fill="var(--nd-mark-2)" d={BRAND_MARK_PATHS[1]} />
      <path fill="var(--nd-mark-3)" d={BRAND_MARK_PATHS[2]} />
    </svg>
  );
}
