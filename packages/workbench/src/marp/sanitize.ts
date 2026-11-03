// Marp output within D-01/V-02 (ADR-0047). Marp renders slides as inline SVG whose
// <foreignObject> holds the HTML of each slide, styles them with the stylesheet of a built-in theme
// and puts the values of its directives (backgroundColor, ![bg], image sizes and filters) and KaTeX's
// layout in style attributes. All of it is renderer output: the author's own CSS (<style>,
// <style scoped>, the `style` directive) never reaches it (see engine.ts). What remains is
// sanitized here, with a DOMPurify instance of its own: no scripts, forms or frames, style attributes
// that cannot leave the slide (no position, z-index or overflow) and load nothing but the vault's
// pictures (blob: and data:image URLs), and a theme stylesheet without @import, @font-face or any
// other url().
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
const FORBID_ATTR = ['srcset', 'formaction', 'action', 'autofocus', 'data-style'];

/** A URL that loads nothing from outside the page: a picture of the vault (blob) or inline data. */
const LOCAL_URL = /^(blob:|data:image\/)/i;
const UNSAFE_CSS = /\\|<|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i;
/** Properties that could take content out of the slide (over the app's own UI). */
const ESCAPING = /^(position|overflow(-[xy])?|z-index|inset.*)$/;

/** The declarations of a style attribute; `;` inside url(…) or quotes does not split. */
export function splitDeclarations(style: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(style.slice(start, i));
      start = i + 1;
    }
  }
  out.push(style.slice(start));
  return out.map((d) => d.trim()).filter(Boolean);
}

/** Every url(…) of a CSS text, unquoted. */
function urlsOf(css: string): string[] {
  return [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((m) => m[2] ?? '');
}

/** A style attribute without the declarations that could escape the slide or load a resource. */
export function safeStyle(style: string): string {
  return splitDeclarations(style)
    .filter((d) => {
      const colon = d.indexOf(':');
      if (colon <= 0) return false;
      const prop = d.slice(0, colon).trim().toLowerCase();
      if (ESCAPING.test(prop) || prop === '--style') return false;
      if (UNSAFE_CSS.test(d.replace(/url\(\s*(['"]?)data:[^)]*\)/gi, 'url()'))) return false;
      return urlsOf(d).every((u) => LOCAL_URL.test(u));
    })
    .join(';');
}

/**
 * The theme's stylesheet without anything that would load a resource: @import (Google/Bunny fonts
 * of gaia and uncover: the theme falls back to the system fonts), @font-face (KaTeX's fonts come
 * from the application's own stylesheet) and any url() that is not inline data.
 */
export function sanitizeMarpCss(css: string): string {
  let text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<\/?style/gi, '');
  text = text.replace(/@import\s+[^;]*;/gi, '');
  // @font-face blocks have no nested braces.
  text = text.replace(/@font-face\s*\{[^}]*\}/gi, '');
  return text.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q: string, u: string) =>
    /^data:image\//i.test(u) ? m : 'none',
  );
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

function marpPurifier(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style') {
      const value = safeStyle(data.attrValue);
      if (value) data.attrValue = value;
      else data.keepAttr = false;
    } else if (
      (data.attrName === 'src' || data.attrName === 'href' || data.attrName === 'xlink:href') &&
      _node.localName !== 'a'
    ) {
      // Only pictures of the vault: anything else would be a network request. DOMPurify does not
      // know blob: URLs, so a local one is kept explicitly.
      if (LOCAL_URL.test(data.attrValue.trim())) data.forceKeepAttr = true;
      else data.keepAttr = false;
    }
  });
  purifier = p;
  return p;
}

/** Sanitized slides (Marp's HTML after the vault's pictures were resolved to blob/data URLs). */
export function sanitizeMarpHtml(html: string): string {
  return marpPurifier().sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: ['foreignObject', 'section'],
    // The HTML of each slide lives in <foreignObject>, the SVG element where HTML is allowed.
    HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: true,
  });
}
