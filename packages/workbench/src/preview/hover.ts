// What triggers a page preview: hovering a [[wikilink]] in the editor (Live
// Preview and Source: editor/source/pagePreview.ts) or in the reading view while holding Cmd/Ctrl
// (or always, per setting), and the keyboard command "Preview link under cursor".
import type { LinkSpec } from '../editor/types';
import { getActiveEditor } from '../editor/registry';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { activeTab, findPane } from '../workspace/layout';
import { schedulePreview, scheduleHidePreview, showPreview, type AnchorRect } from './popover';

/** Whether this pointer/key state should show previews, given the settings. */
export function previewWanted(modifier: boolean): boolean {
  const s = useSettings.getState().editor;
  return s.pagePreview && (s.pagePreviewAlways || modifier);
}

/** The note shown in the pane that contains `el` (panes carry data-pane). */
export function pathOfElement(el: Element): string | null {
  const id = el.closest('[data-pane]')?.getAttribute('data-pane');
  if (!id) return null;
  const { layout } = useAppStore.getState();
  const pane = findPane(layout, id);
  return pane?.tabs.find((t) => t.id === pane.active)?.path ?? null;
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
  const editor = getActiveEditor();
  const link = editor?.linkAt('cursor');
  if (editor && link)
    return { fromPath, spec: link.spec, anchor: link.rect, returnFocus: editor.focusElement };
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
