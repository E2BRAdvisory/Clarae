// The chrome around the document of the Live editor (ADR-0049): what the playground of Milkdown draws
// beside the text, made for the application: the handle of the blocks, the toolbar over a selection, the
// tooltip of a link and the placeholder of an empty block. Crepe draws the last three (its features are
// added in crepe.ts with the configuration made here: names, icons and shortcuts of the application), and
// the handle is the plugin of the blocks of Milkdown (handle.ts).
//
// None of it is in the document: the editor stays what it is for the file, and a read-only editor shows none
// of the controls that change it (theme.css hides them: `editable` stays true there, so the features of
// Crepe would not know).
import type { LinkTooltipFeatureConfig } from '@milkdown/crepe/feature/link-tooltip';
import {
  placeholderConfig,
  type PlaceholderFeatureConfig,
} from '@milkdown/crepe/feature/placeholder';
import type { ToolbarFeatureConfig } from '@milkdown/crepe/feature/toolbar';
import type { Editor } from '@milkdown/kit/core';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import type { EditorCommand } from '../../handle';
import { installHandle } from './handle';
import { namedIcon } from './icons';
import type { ShortcutOf } from './shortcuts';
import { toolbarConfig, type ToolbarLabels } from './toolbar';

export type { Shortcut, ShortcutOf } from './shortcuts';

/** The strings of the chrome. */
export interface ChromeLabels {
  addBlock: string;
  dragBlock: string;
  /** The empty block's hint when the slash menu is on, and when it is not. */
  placeholder: string;
  placeholderNoSlash: string;
  toolbar: ToolbarLabels & { label: string };
  link: {
    copy: string;
    edit: string;
    remove: string;
    confirm: string;
    input: string;
    copied: string;
  };
}

export interface ChromeOptions {
  labels: ChromeLabels;
  readOnly: () => boolean;
  /** The setting `slashCommands`. */
  slashEnabled: () => boolean;
  exec: (command: EditorCommand) => boolean;
  /** The shortcut of a command of the registry; none: no shortcut is shown. */
  shortcut?: ShortcutOf;
}

/** How long the notice of a copied link stays. */
const NOTICE_MS = 2000;
/** The icons of the tooltip of a link that are pressed (copy, edit, remove, confirm). */
const TOOLTIP_BUTTON = '.link-preview .button, .link-edit .button';
/** The widths of the host below which the margin of the text, and the handle, shrink (px). */
const COMPACT = 640;
const NARROW = 420;

export interface Chrome {
  toolbar: ToolbarFeatureConfig;
  linkTooltip: LinkTooltipFeatureConfig;
  placeholder: PlaceholderFeatureConfig;
  /** Installs the handle and the plugin that names and sizes the rest (before the editor is created). */
  install(editor: Editor): void;
}

/** The size class of a width of the host: what the margins and the handle of the stylesheet follow. */
export const sizeOf = (width: number): 'wide' | 'compact' | 'narrow' =>
  width < NARROW ? 'narrow' : width < COMPACT ? 'compact' : 'wide';

const key = new PluginKey('memobrain-chrome');

export function createChrome(o: ChromeOptions): Chrome {
  const { labels } = o;
  let notify: (text: string) => void = () => undefined;
  return {
    toolbar: toolbarConfig({
      labels: labels.toolbar,
      shortcut: o.shortcut ?? (() => undefined),
      exec: o.exec,
    }),
    linkTooltip: {
      // the buttons of the tooltip are icons only: each one carries its name for a screen reader
      linkIcon: namedIcon('copy', labels.link.copy),
      editButton: namedIcon('edit', labels.link.edit),
      removeButton: namedIcon('linkOff', labels.link.remove),
      confirmButton: namedIcon('check', labels.link.confirm),
      inputPlaceholder: labels.link.input,
      onCopyLink: () => notify(labels.link.copied),
    },
    placeholder: { mode: 'block' },
    install(editor) {
      // The hint follows the setting `slashCommands` as it changes: Crepe reads the text of its configuration
      // every time it draws the placeholder, so the text is a getter of the setting.
      editor.config((ctx) => {
        ctx.update(placeholderConfig.key, (prev) =>
          Object.defineProperty({ ...prev }, 'text', {
            enumerable: true,
            get: () => (o.slashEnabled() ? labels.placeholder : labels.placeholderNoSlash),
          }),
        );
      });
      installHandle(editor, {
        readOnly: o.readOnly,
        slashEnabled: o.slashEnabled,
        labels: { addBlock: labels.addBlock, dragBlock: labels.dragBlock },
      });
      editor.use(
        $prose(
          () =>
            new Plugin({
              key,
              view: (view) => {
                const dom = attachDom(view, labels);
                notify = dom.notify;
                return {
                  destroy: () => {
                    notify = () => undefined;
                    dom.destroy();
                  },
                };
              },
            }),
        ),
      );
    },
  };
}

/**
 * What the chrome needs of the DOM around the document: the names of what Crepe draws without one, the
 * live region of the notices, and the size class of the host (the margins follow it). Everything is
 * released with the editor.
 */
function attachDom(
  view: EditorView,
  labels: ChromeLabels,
): { notify: (text: string) => void; destroy: () => void } {
  const root = view.dom.parentElement; // `.milkdown`: Crepe's tooltips are its children
  const host = view.dom.closest<HTMLElement>('.live-host');
  const off: (() => void)[] = [];

  // the names: the toolbar is a toolbar, the field of a link has a name
  const label = (el: Element): void => {
    if (el.classList.contains('milkdown-toolbar')) {
      el.setAttribute('role', 'toolbar');
      el.setAttribute('aria-label', labels.toolbar.label);
    }
    el.querySelector('.input-area')?.setAttribute('aria-label', labels.link.input);
    // the icons of the tooltip of a link are what is clicked, and carry their names: they are buttons
    for (const icon of el.querySelectorAll(TOOLTIP_BUTTON)) icon.setAttribute('role', 'button');
  };
  // the button that confirms comes and goes with the text of the field: the field is watched, once
  // (naming makes no record of its own, so the watch does not feed itself)
  const watched = new WeakSet<Element>();
  const name = (el: Element): void => {
    label(el);
    if (
      el.classList.contains('milkdown-link-edit') &&
      !watched.has(el) &&
      typeof MutationObserver !== 'undefined'
    ) {
      watched.add(el);
      const own = new MutationObserver(() => label(el));
      own.observe(el, { childList: true, subtree: true });
      off.push(() => own.disconnect());
    }
  };
  // Those icons act on `pointerdown` only: a click that no pointer made (a screen reader's) is passed on
  // to them as one. The click that follows a pointer's press is that press's, and is let go.
  if (root) {
    let pressedAt = -Infinity;
    const press = (e: Event): void => {
      if ((e.target as Element | null)?.closest?.(TOOLTIP_BUTTON)) pressedAt = performance.now();
    };
    const click = (e: Event): void => {
      const icon = (e.target as Element | null)?.closest?.(TOOLTIP_BUTTON);
      if (!icon || performance.now() - pressedAt <= 500 || typeof PointerEvent === 'undefined')
        return;
      icon.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    };
    root.addEventListener('pointerdown', press, true);
    root.addEventListener('click', click, true);
    off.push(() => {
      root.removeEventListener('pointerdown', press, true);
      root.removeEventListener('click', click, true);
    });
  }
  if (root) {
    for (const el of root.children) name(el);
    if (typeof MutationObserver !== 'undefined') {
      // direct children only: the document's own mutations are not of interest here
      const observer = new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) name(n);
      });
      observer.observe(root, { childList: true });
      off.push(() => observer.disconnect());
    }
  }

  // the size of the host
  if (host && typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? host.clientWidth;
      host.dataset['size'] = sizeOf(width);
    });
    observer.observe(host);
    off.push(() => {
      observer.disconnect();
      delete host.dataset['size'];
    });
  }

  // the notice: a line the screen reader announces and the eye sees for a moment
  const status = document.createElement('div');
  status.className = 'live-chrome-status';
  // always in the accessibility tree (a live region that appears with its text is not announced): out of
  // sight until there is something to say
  // (`aria-live` and no `role=status`: the application's own notices are the statuses the page looks for)
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const line = document.createElement('span');
  status.append(line);
  (host ?? root)?.append(status);
  let timer: ReturnType<typeof setTimeout> | undefined;
  off.push(() => {
    clearTimeout(timer);
    status.remove();
  });
  return {
    notify: (message) => {
      line.textContent = message;
      status.classList.add('on');
      clearTimeout(timer);
      timer = setTimeout(() => {
        status.classList.remove('on');
        line.textContent = '';
      }, NOTICE_MS);
    },
    destroy: () => off.forEach((f) => f()),
  };
}
