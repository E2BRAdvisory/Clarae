// What triggers a page preview: hovering a [[wikilink]] in the editor (Live
// Preview and Source) or in the reading view while holding Cmd/Ctrl (or always,
// per setting), and the keyboard command "Preview link under cursor".
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { LinkSpec } from '../editor/context';
import { getActiveEditor } from '../editor/registry';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { activeTab, findPane } from '../workspace/layout';
import {
  hidePreview,
  isPreviewOpen,
  previewElement,
  schedulePreview,
  scheduleHidePreview,
  showPreview,
  type AnchorRect,
} from './popover';
import { wikilinkAt } from './target';

/** Whether this pointer/key state should show previews, given the settings. */
export function previewWanted(modifier: boolean): boolean {
  const s = useSettings.getState().editor;
  return s.pagePreview && (s.pagePreviewAlways || modifier);
}

/** The note shown in the pane that contains `el` (panes carry data-pane). */
function pathOfElement(el: Element): string | null {
  const id = el.closest('[data-pane]')?.getAttribute('data-pane');
  if (!id) return null;
  const { layout } = useAppStore.getState();
  const pane = findPane(layout, id);
  return pane?.tabs.find((t) => t.id === pane.active)?.path ?? null;
}

function spanRect(view: EditorView, from: number, to: number): AnchorRect | null {
  const a = view.coordsAtPos(from);
  const b = view.coordsAtPos(to);
  if (!a || !b) return null;
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** CodeMirror extension: preview on hover over a wikilink. */
export function pagePreviewHover(): Extension {
  return EditorView.domEventHandlers({
    mousemove(event, view) {
      const vault = useAppStore.getState().vault;
      if (!vault || !previewWanted(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const fromPath = pathOfElement(view.dom);
      if (pos === null || !fromPath) {
        scheduleHidePreview();
        return false;
      }
      const line = view.state.doc.lineAt(pos);
      const link = wikilinkAt(line.text, pos - line.from);
      if (!link) {
        scheduleHidePreview();
        return false;
      }
      const anchor = spanRect(view, line.from + link.from, line.from + link.to);
      if (anchor) schedulePreview({ vaultId: vault.id, fromPath, spec: link.spec, anchor });
      return false;
    },
    mouseleave() {
      scheduleHidePreview();
      return false;
    },
    keydown(event) {
      if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return false;
      if (isPreviewOpen() && !previewElement()?.contains(document.activeElement)) hidePreview();
      return false;
    },
  });
}

/** Mouse handlers for the reading view container. */
export function readingPreviewHandlers(
  vaultId: string,
  fromPath: string,
): {
  onMouseMove: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
} {
  return {
    onMouseMove(e) {
      if (!previewWanted(e.metaKey || e.ctrlKey)) return;
      const a = (e.target as HTMLElement).closest<HTMLElement>('a.wikilink');
      if (!a) {
        scheduleHidePreview();
        return;
      }
      const r = a.getBoundingClientRect();
      const spec = {
        target: a.dataset['target'] ?? '',
        heading: a.dataset['heading'] ?? '',
        block: a.dataset['block'] ?? '',
      };
      schedulePreview({
        vaultId,
        fromPath,
        spec,
        anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      });
    },
    onMouseLeave: () => scheduleHidePreview(),
  };
}

interface KeyboardTarget {
  fromPath: string;
  spec: Pick<LinkSpec, 'target' | 'heading' | 'block'>;
  anchor: AnchorRect;
  returnFocus: HTMLElement;
}

/** The link the keyboard would preview: under the editor cursor, or the focused reading-view link. */
export function linkUnderKeyboard(): KeyboardTarget | null {
  const fromPath = activeTab(useAppStore.getState().layout)?.path ?? null;
  if (!fromPath) return null;
  const view = getActiveEditor();
  if (view) {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const link = wikilinkAt(line.text, head - line.from);
    const anchor = link ? spanRect(view, line.from + link.from, line.from + link.to) : null;
    if (link && anchor) return { fromPath, spec: link.spec, anchor, returnFocus: view.contentDOM };
  }
  const a = document.activeElement?.closest<HTMLElement>('a.wikilink');
  if (a) {
    const r = a.getBoundingClientRect();
    return {
      fromPath,
      spec: {
        target: a.dataset['target'] ?? '',
        heading: a.dataset['heading'] ?? '',
        block: a.dataset['block'] ?? '',
      },
      anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      returnFocus: a,
    };
  }
  return null;
}

/** "Preview link under cursor": shows the popover and moves focus into it. */
export async function previewLinkUnderKeyboard(): Promise<void> {
  const vault = useAppStore.getState().vault;
  const target = linkUnderKeyboard();
  if (!vault || !target) return;
  await showPreview({
    vaultId: vault.id,
    fromPath: target.fromPath,
    spec: target.spec,
    anchor: target.anchor,
    focus: true,
    returnFocus: target.returnFocus,
  });
}
