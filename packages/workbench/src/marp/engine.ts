// Marp rendering (ADR-0047): a .marp file to slides (inline SVG, one per slide) and the stylesheet of
// its built-in theme. Loaded on demand (marp-core is not in the startup bundle). Everything runs
// offline: emoji stay Unicode characters (no twemoji images), math is typeset by KaTeX with the
// application's own fonts, pictures come from the vault through the caller's resolver.
import { Marp } from '@marp-team/marp-core';
import katexPlugin from '@marp-team/marp-core/plugins/katex';
import { safeDecodeURI } from '../util/uri';
import { sanitizeMarpCss, sanitizeMarpHtml, splitDeclarations } from './sanitize';

/**
 * Marp without the author's CSS (V-02): Marpit collects <style>, <style scoped> and the `style`
 * directive into the text it appends after the theme; leaving it out keeps only the built-in theme.
 * Raw HTML is off (html: false), so no other markup reaches the slides either.
 */
class VaultMarp extends Marp {
  protected override themeSetPackOptions(): ReturnType<Marp['themeSetPackOptions']> {
    const opts = { ...super.themeSetPackOptions() };
    delete opts.after;
    return opts;
  }

  /** The 0-based line where each slide starts (the first one at the top of the file). */
  slideLines(): number[] {
    const slides = (this.lastSlideTokens ?? []) as { type: string; map?: [number, number] }[][];
    return slides.map(
      (tokens) => tokens.find((t) => t.type === 'marpit_slide_open')?.map?.[0] ?? 0,
    );
  }

  /**
   * Whether each slide moved Marp's page counter on: every slide but those with `paginate: skip` or
   * `hold` (`false` still counts). Read from the directives Marpit resolved, so inheritance and
   * `_paginate` are as the engine has them.
   */
  pageAdvances(): boolean[] {
    const slides = (this.lastSlideTokens ?? []) as {
      type: string;
      meta?: { marpitDirectives?: { paginate?: unknown } };
    }[][];
    return slides.map((tokens) => {
      const p = tokens.find((t) => t.type === 'marpit_slide_open')?.meta?.marpitDirectives
        ?.paginate;
      return p !== 'skip' && p !== 'hold';
    });
  }
}

let marp: VaultMarp | null = null;

function engine(): VaultMarp {
  marp ??= new VaultMarp({
    html: false,
    inlineSVG: true,
    script: false,
    emoji: { shortcode: true, unicode: false },
    minifyCSS: true,
  }).use(katexPlugin({ fontPath: false }));
  return marp;
}

/** A picture used by the slides, as the page may load it; release frees it (a cached blob). */
export interface ResolvedAsset {
  url: string;
  release?: () => void;
}

/** Turns the address of a picture (vault path, as written) into a loadable URL, or null to drop it. */
export type AssetResolver = (ref: string) => Promise<ResolvedAsset | null>;

export interface Deck {
  /** Sanitized slides: `<div class="marpit">` with one `<svg>` per slide. */
  html: string;
  /** Sanitized stylesheet of the theme (scoped to `div.marpit`). */
  css: string;
  /** 0-based first line of each slide in the source. */
  slideLines: number[];
  /** Presenter notes of each slide (its non-directive HTML comments, without clarae markers). */
  notes: string[];
  /** True for each slide left out of the presentation (`<!-- clarae: hidden -->`). */
  hidden: boolean[];
  /** For each slide, whether it advanced the page counter (not `paginate: skip` or `hold`). */
  advances: boolean[];
  /** Frees the pictures the slides hold. */
  release(): void;
}

/** Obsidian embeds of pictures (`![[a.png]]`, `![[a.png|200]]`) as Marp images. */
export function embedsToImages(source: string): string {
  return source.replace(
    /!\[\[([^\]|#\n]+)(?:\|(\d+)(?:x(\d+))?)?\]\]/g,
    (_m, target: string, w?: string, h?: string) =>
      `![${[w ? `w:${w}` : '', h ? `h:${h}` : ''].filter(Boolean).join(' ')}](<${target.trim()}>)`,
  );
}

/** The marker comment that leaves a slide out of the presentation and its exports. */
export const HIDDEN_COMMENT = /^clarae:\s*hidden$/i;

const URL_IN_CSS = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

/** Renders a presentation: slides, theme and the pictures they show, all sanitized. */
export async function renderDeck(source: string, resolve: AssetResolver): Promise<Deck> {
  const m = engine();
  const out = m.render(embedsToImages(source));
  const slideLines = m.slideLines();
  const advances = m.pageAdvances();
  const doc = new DOMParser().parseFromString(`<body>${out.html}</body>`, 'text/html');

  // Every picture the slides reference: <img> and the url() of the inline styles of ![bg].
  const imgs = [...doc.querySelectorAll('img[src]')];
  const styled = [...doc.querySelectorAll('[style*="url("]')];
  const refs = new Set<string>(imgs.map((i) => i.getAttribute('src') ?? ''));
  for (const el of styled)
    for (const mm of (el.getAttribute('style') ?? '').matchAll(URL_IN_CSS)) refs.add(mm[2] ?? '');
  refs.delete('');
  const held: (() => void)[] = [];
  const urls = new Map<string, string>();
  await Promise.all(
    [...refs].map(async (ref) => {
      const asset = await resolve(safeDecodeURI(ref)).catch(() => null);
      if (!asset) return;
      urls.set(ref, asset.url);
      if (asset.release) held.push(asset.release);
    }),
  );
  for (const img of imgs) {
    const url = urls.get(img.getAttribute('src') ?? '');
    if (url) img.setAttribute('src', url);
    else img.removeAttribute('src'); // missing or remote: the alt text stays
  }
  for (const el of styled) {
    const style = splitDeclarations(el.getAttribute('style') ?? '')
      .map((d) =>
        d.replace(URL_IN_CSS, (_x, _q: string, ref: string) => {
          const url = urls.get(ref);
          return url ? `url("${url}")` : 'none';
        }),
      )
      .join(';');
    el.setAttribute('style', style);
  }
  const comments = out.comments ?? [];
  const notes = slideLines.map((_l, i) =>
    (comments[i] ?? [])
      .map((c) => c.trim())
      .filter((c) => c && !HIDDEN_COMMENT.test(c))
      .join('\n\n'),
  );
  const hidden = slideLines.map((_l, i) =>
    (comments[i] ?? []).some((c) => HIDDEN_COMMENT.test(c.trim())),
  );
  return {
    html: sanitizeMarpHtml(doc.body.innerHTML),
    css: sanitizeMarpCss(out.css),
    slideLines,
    notes,
    hidden,
    advances,
    release: () => held.splice(0).forEach((r) => r()),
  };
}

export { slideAt } from './slides';
