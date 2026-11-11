// What the pointer does on the links of the Live editor (A-W5a), the same as in the CodeMirror one:
//
//   Mod+click    on a wikilink, a Markdown link or a #tag follows it (Alt as well: in a new tab); a tag
//                runs the search for it. A plain click only puts the caret there, and the source shows.
//   hover        over a wikilink, with the settings' modifier (or always), shows the page preview; the
//                keyboard has the same through `NoteEditorHandle.linkAt('cursor')`.
//
// Listeners are on the editor's host element, in the capture phase for the click (ProseMirror would
// move the caret first) and released with the editor.
import { pathOfElement, previewWanted } from '../../../preview/hover';
import {
  hidePreview,
  isPreviewOpen,
  previewElement,
  schedulePreview,
  scheduleHidePreview,
} from '../../../preview/popover';
import { useAppStore } from '../../../state/store';
import { safeDecodeURI } from '../../../util/uri';
import type { LinkSpec } from '../../types';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { INTERACTIVE, specOf } from './wikilink';
import type { LiveViewsHost } from './host';

const WIKILINK = '[data-ofm="wikilink"][data-embed="false"]';
const TAG = '[data-ofm="tag"]';
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

const none = (alias = ''): LinkSpec => ({
  target: '',
  heading: '',
  block: '',
  alias,
  embed: false,
});

/** The link a click on `el` follows: what to open, or null when `el` is nothing that opens. */
function followed(el: Element, host: LiveViewsHost, newTab: boolean): (() => void) | null {
  const ctx = host.context();
  const wikilink = el.closest<HTMLElement>(WIKILINK);
  if (wikilink) {
    const { target = '', heading = '', block = '' } = wikilink.dataset;
    return () => ctx.openLink({ target, heading, block, alias: '', embed: false }, newTab);
  }
  const tag = el.closest<HTMLElement>(TAG);
  if (tag) {
    const name = (tag.textContent ?? '').replace(/^#/, '');
    return () => ctx.openLink(none(`#${name}`), false);
  }
  const anchor = el.closest<HTMLAnchorElement>('a[href]');
  if (anchor) {
    const url = anchor.getAttribute('href') ?? '';
    return () => {
      if (SCHEME.test(url)) ctx.openExternal(url);
      else ctx.openLink({ ...none(), target: safeDecodeURI(url.split('#')[0] ?? '') }, newTab);
    };
  }
  return null;
}

/** The wikilink (not an embed) under an element, as a spec and where it is on screen. */
export function wikilinkUnder(el: Element): { spec: LinkSpec; rect: DOMRect } | null {
  const node = el.closest<HTMLElement>(WIKILINK);
  if (!node) return null;
  const spec = specOf(node.textContent ?? '', false);
  if (!spec.target && !spec.heading && !spec.block) return null;
  return { spec, rect: node.getBoundingClientRect() };
}

/** Takes the caret to the end of the source of the embed that holds `el` (its drawing gives way to it). */
function intoSource(view: EditorView, el: Element): boolean {
  const text = el.closest('[data-ofm="wikilink"]')?.querySelector('.ofm-wl-text');
  if (!text) return false;
  const pos = view.posAtDOM(text, text.childNodes.length);
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
  view.focus();
  return true;
}

export function attachInteractions(
  root: HTMLElement,
  host: LiveViewsHost,
  view: () => EditorView,
): () => void {
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    // a click on the drawing of an embed (not on what it lets you click) is a click on its source
    if (
      !(e.metaKey || e.ctrlKey) &&
      e.target.closest('.ofm-embed-render') &&
      !e.target.closest(INTERACTIVE)
    ) {
      if (intoSource(view(), e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const hit = followed(e.target, host, e.altKey);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    hit();
  };

  const onMouseMove = (e: MouseEvent): void => {
    const vault = useAppStore.getState().vault;
    if (!vault || !previewWanted(e.metaKey || e.ctrlKey) || !(e.target instanceof Element)) return;
    const fromPath = pathOfElement(root);
    const link = fromPath ? wikilinkUnder(e.target) : null;
    if (!fromPath || !link) {
      scheduleHidePreview();
      return;
    }
    const { left, right, top, bottom } = link.rect;
    schedulePreview({
      vaultId: vault.id,
      fromPath,
      spec: link.spec,
      anchor: { left, right, top, bottom },
    });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
    if (isPreviewOpen() && !previewElement()?.contains(document.activeElement)) hidePreview();
  };

  root.addEventListener('mousedown', onMouseDown, true);
  root.addEventListener('mousemove', onMouseMove);
  root.addEventListener('mouseleave', scheduleHidePreview);
  root.addEventListener('keydown', onKeyDown);
  return () => {
    root.removeEventListener('mousedown', onMouseDown, true);
    root.removeEventListener('mousemove', onMouseMove);
    root.removeEventListener('mouseleave', scheduleHidePreview);
    root.removeEventListener('keydown', onKeyDown);
  };
}
