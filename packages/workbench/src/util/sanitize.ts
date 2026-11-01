// Every piece of HTML that reaches the DOM goes through here (§3.7): DOMPurify
// with no scripts, styles, forms, frames or style attributes (D-01: no custom
// CSS, not even inline) and no remote resource loading. Mermaid's SVG, which is
// renderer output and not user HTML, has its own rules below (sanitizeSvg).
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

// ---- Mermaid output ---------------------------------------------------------------------------
// Mermaid's SVG is renderer-owned output, like KaTeX's: it carries its own theme as a <style> scoped
// to the diagram's id, inline styles on markers and shapes, and (for some diagrams) HTML labels in
// <foreignObject>. Removing them leaves black shapes and missing labels, so the SVG sanitizer keeps
// them under strict rules: one <style> directly in the root <svg> whose every rule is scoped to that
// svg's id (or is a @keyframes), declarations without remote url(), no `position`, `overflow` or
// `z-index` (nothing may escape the diagram's box) and no escapes or markup. Scripts, event handlers, forms and frames are
// removed as everywhere else. A separate DOMPurify instance keeps these hooks off sanitizeHtml.

const SVG_FORBID_TAGS = FORBID_TAGS.filter((t) => t !== 'style');
const SVG_FORBID_ATTR = FORBID_ATTR.filter((a) => a !== 'style');
const UNSAFE_CSS = /\\|<|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i;
const REMOTE_URL = /url\(\s*(?!['"]?#)/i;
const ID = /^[A-Za-z][\w-]*$/;
/** Properties that could take content out of the diagram's box (over the app's own UI). */
const ESCAPING = /^(position|overflow(-[xy])?|z-index)$/;

/** A declaration list without anything that could load a resource or leave the diagram. */
function safeDeclarations(body: string): string {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter((d) => {
      const colon = d.indexOf(':');
      if (colon <= 0) return false;
      const prop = d.slice(0, colon).trim().toLowerCase();
      return !ESCAPING.test(prop) && !REMOTE_URL.test(d) && !UNSAFE_CSS.test(d);
    })
    .join(';');
}

/** Top-level `prelude { body }` blocks of a style sheet (bodies may nest, as in @keyframes). */
function cssBlocks(css: string): { prelude: string; body: string }[] {
  const out: { prelude: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let open = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth < 0) return []; // unbalanced: keep nothing
      if (depth === 0) {
        out.push({ prelude: css.slice(start, open).trim(), body: css.slice(open + 1, i) });
        start = i + 1;
      }
    }
  }
  return depth === 0 ? out : [];
}

/**
 * Mermaid's style sheet reduced to rules that only reach the diagram `#id`: each selector must start
 * with it, @keyframes are kept (their names are harmless), any other rule is dropped.
 */
export function scopeMermaidCss(css: string, id: string): string {
  if (!ID.test(id)) return '';
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (UNSAFE_CSS.test(text)) return '';
  const scope = `#${id}`;
  const scoped = (sel: string): boolean =>
    sel.startsWith(scope) &&
    (sel.length === scope.length || /[\s.:[>+~,]/.test(sel.charAt(scope.length)));
  const rules: string[] = [];
  for (const { prelude, body } of cssBlocks(text)) {
    if (/^@(-webkit-)?keyframes\s+[\w-]+$/i.test(prelude)) {
      if (!REMOTE_URL.test(body) && !/(position|overflow|z-index)\s*:/i.test(body))
        rules.push(`${prelude}{${body}}`);
      continue;
    }
    if (prelude.startsWith('@') || body.includes('{')) continue;
    const selectors = prelude.split(',').map((s) => s.trim());
    if (selectors.length === 0 || !selectors.every(scoped)) continue;
    const decls = safeDeclarations(body);
    if (decls) rules.push(`${selectors.join(',')}{${decls}}`);
  }
  return rules.join('');
}

let svgPurifier: ReturnType<typeof DOMPurify> | null = null;

function mermaidPurifier(): ReturnType<typeof DOMPurify> {
  if (svgPurifier) return svgPurifier;
  const p = DOMPurify(window);
  p.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'style') return;
    const parent = node.parentElement;
    const isRoot =
      parent !== null &&
      parent.namespaceURI === 'http://www.w3.org/2000/svg' &&
      parent.localName === 'svg' &&
      !parent.parentElement?.closest('svg');
    const css = isRoot ? scopeMermaidCss(node.textContent ?? '', parent.id) : '';
    node.textContent = css; // an empty <style> is harmless; removing it here would confuse the walk
  });
  p.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'style') return;
    const value = safeDeclarations(data.attrValue);
    if (value) data.attrValue = value;
    else data.keepAttr = false;
  });
  svgPurifier = p;
  return p;
}

/** Sanitized SVG (Mermaid output), keeping the diagram's own scoped styles and HTML labels. */
export function sanitizeSvg(svg: string): string {
  return mermaidPurifier().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject', 'style'],
    // HTML labels live in <foreignObject>, the SVG element where HTML is allowed (HTML integration point).
    HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true },
    FORBID_TAGS: SVG_FORBID_TAGS,
    FORBID_ATTR: SVG_FORBID_ATTR,
    ALLOW_DATA_ATTR: true,
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
