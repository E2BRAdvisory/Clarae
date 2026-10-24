// The page-preview popover: one floating, scrollable box (position: fixed, so it
// never shifts the layout) showing a note rendered by the reading renderer.
//
// Safety: the HTML comes from renderMarkdown (DOMPurify: no scripts, styles or
// frames, no style attributes); remote resources are stripped on top of that
// and only embeds are hydrated, with one level of embedding. The popover has no
// hover behavior of its own, so links inside it are never previewed again;
// clicking one navigates (and closes the preview).
import i18next from 'i18next';
import { followLink } from '../app/actions';
import { hydrate, MAX_EMBED_DEPTH } from '../embeds/hydrate';
import type { LinkSpec } from '../editor/context';
import { openExternal } from '../util/external';
import { linkKey } from './target';
import { loadPreview, previewBackend, stripRemoteResources } from './service';
import './preview.css';

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ShowRequest {
  vaultId: string;
  fromPath: string;
  spec: Pick<LinkSpec, 'target' | 'heading' | 'block'>;
  anchor: AnchorRect;
  /** Move keyboard focus into the popover (keyboard command); Escape then restores it. */
  focus?: boolean;
  returnFocus?: HTMLElement | null;
}

export const PREVIEW_DELAY_MS = 350;
const HIDE_DELAY_MS = 250;
const GAP = 6;
const MARGIN = 8;

/** Where the popover goes: below the anchor, or above when it does not fit, kept on screen. */
export function placePopover(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - size.width - MARGIN));
  let top = anchor.bottom + GAP;
  if (top + size.height > viewport.height - MARGIN) {
    const above = anchor.top - GAP - size.height;
    top = above >= MARGIN ? above : Math.max(MARGIN, viewport.height - size.height - MARGIN);
  }
  return { left, top };
}

let el: HTMLElement | null = null;
let openKey = '';
let seq = 0;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let pendingKey = '';
let returnFocus: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

const t = (key: string): string => i18next.t(key);

function clearTimers(): void {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  showTimer = undefined;
  hideTimer = undefined;
}

/** Closes the popover and cancels anything scheduled. */
export function hidePreview(restoreFocus = false): void {
  clearTimers();
  seq++; // an in-flight load must not open it afterwards
  pendingKey = '';
  cleanup?.();
  cleanup = null;
  const hadFocus = !!el && el.contains(document.activeElement);
  el?.remove();
  el = null;
  openKey = '';
  if (restoreFocus || hadFocus) returnFocus?.focus();
  returnFocus = null;
}

export const isPreviewOpen = (): boolean => el !== null;
export const previewElement = (): HTMLElement | null => el;

/** Hides after a short grace period (the pointer may be moving onto the popover). */
export function scheduleHidePreview(): void {
  clearTimeout(showTimer);
  pendingKey = '';
  if (!el) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hidePreview(), HIDE_DELAY_MS);
}

/** Shows the popover after `delay` unless the same link is already open or pending. */
export function schedulePreview(req: ShowRequest, delay = PREVIEW_DELAY_MS): void {
  const key = linkKey(req.fromPath, req.spec);
  clearTimeout(hideTimer);
  if (key === openKey || key === pendingKey) return;
  clearTimeout(showTimer);
  pendingKey = key;
  showTimer = setTimeout(() => void showPreview(req), delay);
}

function build(
  req: ShowRequest,
  path: string,
  title: string,
  html: string,
  onOpen: (e: MouseEvent) => void,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'page-preview';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', title);
  root.tabIndex = -1;

  const head = document.createElement('div');
  head.className = 'page-preview-title';
  head.textContent = title;
  head.title = t('preview.open');
  head.addEventListener('click', onOpen);

  const body = document.createElement('div');
  body.className = 'page-preview-body reading';
  body.innerHTML = html; // sanitized by renderMarkdown
  stripRemoteResources(body);
  root.append(head, body);

  body.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const wiki = target.closest<HTMLElement>('a.wikilink');
    if (wiki) {
      e.preventDefault();
      const spec = {
        target: wiki.dataset['target'] ?? '',
        heading: wiki.dataset['heading'] ?? '',
        block: wiki.dataset['block'] ?? '',
      };
      hidePreview();
      void followLink(path, spec, e.metaKey || e.ctrlKey);
      return;
    }
    const a = target.closest<HTMLAnchorElement>('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(href)) openExternal(href);
  });

  hydrate(body, {
    backend: previewBackend(req.vaultId),
    fromPath: path,
    depth: MAX_EMBED_DEPTH - 1, // embeds render one level deep, no further
    visited: [path],
  });
  return root;
}

/** Shows the popover now. */
export async function showPreview(req: ShowRequest): Promise<void> {
  clearTimers();
  const key = linkKey(req.fromPath, req.spec);
  pendingKey = '';
  if (key === openKey && el) return;
  hidePreview();
  const mine = ++seq;
  const res = await loadPreview(req.vaultId, req.fromPath, req.spec);
  if (mine !== seq) return;
  const message = res.ok
    ? ''
    : t(
        res.reason === 'missing'
          ? 'preview.missing'
          : res.reason === 'section'
            ? 'preview.section'
            : res.reason === 'unsupported'
              ? 'preview.unsupported'
              : 'preview.error',
      );
  const path = res.ok ? res.path : '';
  const root = build(
    req,
    path,
    res.ok ? res.title : req.spec.target || req.fromPath,
    res.ok ? res.html : `<p class="muted"></p>`,
    (e) => {
      if (!path) return;
      hidePreview();
      void followLink(
        req.fromPath,
        { target: path, heading: req.spec.heading, block: req.spec.block },
        e.metaKey || e.ctrlKey,
      );
    },
  );
  if (!res.ok) {
    const note = root.querySelector('.muted');
    if (note) note.textContent = message;
  }
  document.body.append(root);
  el = root;
  openKey = key;
  returnFocus = req.returnFocus ?? null;

  const size = root.getBoundingClientRect();
  const pos = placePopover(
    req.anchor,
    { width: size.width, height: size.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  root.style.left = `${pos.left}px`;
  root.style.top = `${pos.top}px`;

  const onEnter = (): void => clearTimeout(hideTimer);
  const onLeave = (): void => scheduleHidePreview();
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hidePreview(true);
    }
  };
  const onDown = (e: MouseEvent): void => {
    if (!root.contains(e.target as Node)) hidePreview();
  };
  const onScroll = (e: Event): void => {
    if (!root.contains(e.target as Node)) hidePreview();
  };
  root.addEventListener('mouseenter', onEnter);
  root.addEventListener('mouseleave', onLeave);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('scroll', onScroll, true);
  cleanup = () => {
    root.removeEventListener('mouseenter', onEnter);
    root.removeEventListener('mouseleave', onLeave);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('scroll', onScroll, true);
  };
  if (req.focus) root.focus();
}
