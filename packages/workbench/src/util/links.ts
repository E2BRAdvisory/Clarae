// One link policy for every place that renders Markdown (reading view, hover preview, canvas text
// nodes, slides, embedded notes). A click on a rendered link never navigates the page: on the
// desktop that would replace the app in the Wails window, in the browser it would leave the
// workbench and drop pending edits. Wikilinks and relative links open in the vault, tags start a
// search, external URLs go to the system browser (or a new tab), in-page anchors stay put.
import type { LinkSpec } from '../editor/context';
import { openExternal } from './external';
import { safeDecodeURI } from './uri';

export interface LinkHandlers {
  /** Opens a note or file of the vault; without it vault links are inert. */
  openLink?: (spec: LinkSpec, newTab: boolean) => void;
  /** Starts a tag search; without it tags are inert. */
  searchTag?: (tag: string) => void;
  /** Opens an external URL (default: openExternal, which ignores unsafe schemes). */
  openExternal?: (url: string) => void;
}

/** A URL with a scheme (https:, mailto:, wails:…), as opposed to a path in the vault. */
export const hasScheme = (href: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]+:/.test(href);

interface ClickLike {
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  preventDefault(): void;
}

/**
 * Handles a click inside rendered Markdown. Returns true when the click was on a link: the default
 * navigation is then always prevented, whether or not a handler acted on it. In-page anchors
 * (footnotes, `#heading`) are left to the browser and return false.
 */
export function handleLinkClick(e: ClickLike, handlers: LinkHandlers): boolean {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return false;
  const newTab = e.metaKey || e.ctrlKey;
  const wiki = target.closest<HTMLElement>('a.wikilink');
  if (wiki) {
    e.preventDefault();
    handlers.openLink?.(
      {
        target: wiki.dataset['target'] ?? '',
        heading: wiki.dataset['heading'] ?? '',
        block: wiki.dataset['block'] ?? '',
        alias: '',
        embed: false,
      },
      newTab,
    );
    return true;
  }
  const tag = target.closest<HTMLElement>('a.tag');
  if (tag) {
    e.preventDefault();
    handlers.searchTag?.(tag.dataset['tag'] ?? '');
    return true;
  }
  const a = target.closest<HTMLAnchorElement>('a[href]');
  if (!a) return false;
  const href = a.getAttribute('href') ?? '';
  if (href.startsWith('#')) return false;
  e.preventDefault();
  if (hasScheme(href)) (handlers.openExternal ?? openExternal)(href);
  else
    handlers.openLink?.(
      {
        target: safeDecodeURI(href.split('#')[0] ?? ''),
        heading: '',
        block: '',
        alias: '',
        embed: false,
      },
      newTab,
    );
  return true;
}

/** Applies handleLinkClick to every click inside root; returns the function that removes it. */
export function interceptLinks(root: HTMLElement, handlers: LinkHandlers): () => void {
  const onClick = (e: MouseEvent): void => void handleLinkClick(e, handlers);
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

let guardInstalled = false;

/**
 * Safety net for the whole page: a click on an `a[href]` that no handler took care of (its default
 * is not prevented once the event reaches the document) never navigates the page away. External
 * URLs still open outside the app; anything else is dropped. Anchors that download a file
 * (`download`, `blob:`), in-page anchors and the host's own navigation (`data-allow-navigation`,
 * e.g. "back to the console" on an error page) are left alone. Installed once by mountWorkbench.
 */
export function installLinkGuard(doc: Document = document): void {
  if (guardInstalled) return;
  guardInstalled = true;
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented || !(e.target instanceof Element)) return;
    const a = e.target.closest<HTMLAnchorElement>('a[href]');
    if (!a || a.hasAttribute('download') || a.hasAttribute('data-allow-navigation')) return;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#') || href.startsWith('blob:')) return;
    e.preventDefault();
    if (hasScheme(href)) openExternal(href);
  });
}
