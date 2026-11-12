// CodeMirror extension: a page preview on hover over a [[wikilink]] in the Source editor.
// The triggers of the reading view and of the keyboard are in preview/hover.ts.
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { pathOfElement, previewWanted } from '../../preview/hover';
import {
  hidePreview,
  isPreviewOpen,
  previewElement,
  schedulePreview,
  scheduleHidePreview,
} from '../../preview/popover';
import { useAppStore } from '../../state/store';
import { wikilinkAtPos } from './links';

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
      const link = wikilinkAtPos(view, pos);
      if (!link) {
        scheduleHidePreview();
        return false;
      }
      if (link.rect)
        schedulePreview({ vaultId: vault.id, fromPath, spec: link.spec, anchor: link.rect });
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
