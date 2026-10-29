// Every piece of HTML that reaches the DOM goes through here (§3.7): DOMPurify
// with no scripts, styles, forms, frames or style attributes (D-01: no custom
// CSS, not even inline) and no remote resource loading.
import DOMPurify from 'dompurify';

const FORBID_TAGS = [
  'style',
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'link',
  'meta',
  'base',
  'input',
  'button',
  'textarea',
  'select',
];
const FORBID_ATTR = ['style', 'srcset', 'formaction', 'action', 'autofocus'];

/** Returns sanitized HTML for innerHTML-style insertion. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS, FORBID_ATTR, ALLOW_DATA_ATTR: true });
}

/** Sanitized SVG (Mermaid output). */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'style'],
    FORBID_ATTR,
  });
}

/** Replaces the content of el with sanitized HTML. */
export function setSanitizedHtml(el: HTMLElement, html: string): void {
  el.innerHTML = sanitizeHtml(html);
}

/** Only these URL schemes may be opened from a rendered link. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol);
  } catch {
    return false;
  }
}
