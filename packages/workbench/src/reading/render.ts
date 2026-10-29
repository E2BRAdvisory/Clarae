// Reading view: Markdown -> sanitized HTML (remark/rehype + Obsidian syntax).
//
// Pipeline: strip frontmatter -> blank %%comments%% -> remark (GFM, math) ->
// OFM plugin (wikilinks, embeds, ==highlight==, #tags, callouts, tasks) ->
// rehype (raw HTML allowed, then DOMPurify strips scripts, styles, frames) ->
// heading ids. KaTeX, Mermaid and embeds are hydrated AFTER sanitizing (see
// hydrate.ts): KaTeX needs inline styles that the sanitizer forbids (D-01).
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified, type Plugin } from 'unified';
import type { Element, Root as HastRoot, RootContent as HastContent } from 'hast';
import type { Parent, PhrasingContent, Root, Text } from 'mdast';
import {
  parseWikilinkInner,
  scanSpans,
  stripInlineCode,
  type BlockState,
} from '@memobrain/markdown';
import { sanitizeHtml } from '../util/sanitize';
import { stripFrontmatter } from './sections';

const ESC = ''; // stands for an escaped "[" until text nodes are processed
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Blanks %%comments%% (also across lines) outside code fences and protects \[[ escapes. */
export function prepareSource(src: string): string {
  const lines = stripFrontmatter(src).split('\n');
  const st: BlockState = { inMath: false, inComment: false };
  let fence = '';
  return lines
    .map((line) => {
      const f = FENCE.exec(line);
      if (fence) {
        if (f && (f[1] ?? '').startsWith(fence.charAt(0)) && (f[1] ?? '').length >= fence.length)
          fence = '';
        return line;
      }
      if (f) {
        fence = f[1] ?? '';
        return line;
      }
      let out = line;
      for (const sp of scanSpans(stripInlineCode(line), st)) {
        if (sp.kind === 'comment')
          out = out.slice(0, sp.from) + ' '.repeat(sp.to - sp.from) + out.slice(sp.to);
      }
      return out.replace(/\\\[\[/g, ESC + '[');
    })
    .join('\n');
}

const INLINE_OFM = new RegExp(
  [
    '(!?)\\[\\[([^\\[\\]]+?)\\]\\]', // 1: bang, 2: wikilink inner
    '==(?=\\S)([^\\n]+?)(?<=\\S)==', // 3: highlight
    '(^|[\\s(\\[{,;])#([\\p{L}\\p{N}_\\-/]+)', // 4: boundary, 5: tag
    '[ \\t]\\^([A-Za-z0-9-]+)[ \\t]*$', // 6: block id at end of text
  ].join('|'),
  'gu',
);

const isValidTag = (name: string): boolean => /[^\d/_-]/u.test(name);

function node(
  hName: string,
  props: Record<string, unknown>,
  children: PhrasingContent[],
): PhrasingContent {
  return { type: 'emphasis', children, data: { hName, hProperties: props } } as PhrasingContent;
}

/** Splits a text node into text + Obsidian inline nodes. */
function transformText(value: string): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let last = 0;
  const push = (s: string): void => {
    if (s) out.push({ type: 'text', value: s.replaceAll(ESC, '[') });
  };
  for (const m of value.matchAll(INLINE_OFM)) {
    const at = m.index ?? 0;
    if (m[2] !== undefined) {
      push(value.slice(last, at));
      const p = parseWikilinkInner(m[2]);
      if (m[1]) {
        out.push(
          node(
            'span',
            {
              className: ['embed'],
              'data-target': p.target,
              'data-heading': p.heading,
              'data-block': p.block,
              'data-size': p.alias,
            },
            [],
          ),
        );
      } else {
        const label =
          p.alias ||
          p.target + (p.heading ? ` > ${p.heading}` : p.block ? ` > ^${p.block}` : '') ||
          p.heading;
        out.push(
          node(
            'a',
            {
              className: ['wikilink'],
              href: '#',
              'data-target': p.target,
              'data-heading': p.heading,
              'data-block': p.block,
            },
            [{ type: 'text', value: label }],
          ),
        );
      }
      last = at + m[0].length;
    } else if (m[3] !== undefined) {
      push(value.slice(last, at));
      out.push(node('mark', {}, [{ type: 'text', value: m[3] }]));
      last = at + m[0].length;
    } else if (m[5] !== undefined && isValidTag(m[5])) {
      push(value.slice(last, at) + (m[4] ?? ''));
      out.push(
        node('a', { className: ['tag'], href: '#', 'data-tag': m[5] }, [
          { type: 'text', value: '#' + m[5] },
        ]),
      );
      last = at + m[0].length;
    } else if (m[6] !== undefined) {
      push(value.slice(last, at));
      // The ^id marker is not shown, but its position stays addressable (#blk-id).
      out.push(node('span', { className: ['block-anchor'], id: `blk-${m[6]}` }, []));
      last = at + m[0].length;
    }
  }
  push(value.slice(last));
  return out;
}

const CALLOUT = /^\[!([A-Za-z0-9_-]+)\]([+-]?)[ \t]*/;

const remarkOfm: Plugin<[], Root> = () => (tree) => {
  const visit = (n: Parent, inLink: boolean): void => {
    const next: typeof n.children = [];
    for (const child of n.children) {
      if (child.type === 'text' && !inLink) {
        next.push(...transformText(child.value));
        continue;
      }
      if ('children' in child) {
        const isLink = inLink || child.type === 'link' || child.type === 'linkReference';
        visit(child, isLink);
        if (child.type === 'blockquote') convertCallout(child);
        if (child.type === 'listItem') markTask(child as Parent & { checked?: boolean | null });
      }
      next.push(child);
    }
    n.children = next;
  };
  visit(tree, false);
};

function convertCallout(bq: Parent): void {
  const first = bq.children[0];
  if (!first || first.type !== 'paragraph') return;
  const t = first.children[0];
  if (!t || t.type !== 'text') return;
  const m = CALLOUT.exec(t.value);
  if (!m) return;
  const type = (m[1] ?? 'note').toLowerCase();
  const marker = m[2] ?? '';
  // Title = rest of the first line; body = the remaining lines/paragraphs.
  const rest = t.value.slice(m[0].length);
  const nl = rest.indexOf('\n');
  const title = (nl >= 0 ? rest.slice(0, nl) : rest).trim();
  const remainder = nl >= 0 ? rest.slice(nl + 1) : '';
  const bodyInline: PhrasingContent[] = [
    ...(remainder ? [{ type: 'text', value: remainder } as Text] : []),
    ...first.children.slice(1),
  ];
  const bodyBlocks = [
    ...(bodyInline.length
      ? [{ type: 'paragraph', children: bodyInline } as Parent['children'][number]]
      : []),
    ...bq.children.slice(1),
  ];
  const label = title || type.charAt(0).toUpperCase() + type.slice(1);
  const summary = {
    type: 'paragraph',
    children: [{ type: 'text', value: label }],
    data: { hName: marker ? 'summary' : 'div', hProperties: { className: ['callout-title'] } },
  } as Parent['children'][number];
  const content = {
    type: 'blockquote',
    children: bodyBlocks,
    data: { hName: 'div', hProperties: { className: ['callout-content'] } },
  } as Parent['children'][number];
  bq.children = [summary, content];
  bq.data = {
    hName: marker ? 'details' : 'div',
    hProperties: {
      className: ['callout', `callout-${type}`],
      'data-callout': type,
      ...(marker === '+' ? { open: true } : {}),
    },
  };
}

function markTask(li: Parent & { checked?: boolean | null }): void {
  let state: string | null = null;
  if (li.checked === true) state = 'x';
  else if (li.checked === false)
    state = 'open'; // " " would be trimmed by the sanitizer
  else {
    const p = li.children[0];
    const t = p && p.type === 'paragraph' ? p.children[0] : undefined;
    const m = t && t.type === 'text' ? /^\[(.)\][ \t]+/.exec(t.value) : null;
    if (m && t && t.type === 'text') {
      state = m[1] === ' ' || m[1] === undefined ? 'open' : m[1];
      t.value = t.value.slice(m[0].length);
    }
  }
  if (state !== null) {
    li.data = {
      ...(li.data ?? {}),
      hProperties: { className: ['task-list-item'], 'data-task': state },
    };
  }
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

const text = (n: HastContent | HastRoot): string => {
  if (n.type === 'text') return n.value;
  return 'children' in n ? (n.children as HastContent[]).map(text).join('') : '';
};

/** Adds id="slug" to headings (for #heading navigation); duplicates get -1, -2… */
const rehypeHeadingIds: Plugin<[], HastRoot> = () => (tree) => {
  const seen = new Map<string, number>();
  const walk = (n: HastRoot | Element): void => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      if (/^h[1-6]$/.test(c.tagName)) {
        const base = slug(text(c)) || 'section';
        const k = seen.get(base) ?? 0;
        seen.set(base, k + 1);
        c.properties = { ...c.properties, id: k ? `${base}-${k}` : base };
      }
      walk(c);
    }
  };
  walk(tree);
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkOfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeHeadingIds)
  .use(rehypeStringify);

/** Renders a note (or fragment) to sanitized HTML. */
export function renderMarkdown(src: string): string {
  const html = String(processor.processSync(prepareSource(src)));
  return sanitizeHtml(html);
}
