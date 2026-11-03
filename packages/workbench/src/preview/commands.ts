// Page preview commands; spread into the registry (commands/registry.ts).
import type { Command } from '../commands/registry';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { linkUnderKeyboard, previewLinkUnderKeyboard } from './hover';

export const previewCommands: Command[] = [
  {
    id: 'preview:link',
    group: 'editor',
    feature: 'preview',
    defaults: [],
    // Works even when hover previews are switched off: it is an explicit request.
    enabled: () => useAppStore.getState().vault !== null && linkUnderKeyboard() !== null,
    run: async () => {
      try {
        await previewLinkUnderKeyboard();
      } catch (e) {
        await dialog.error(e);
      }
    },
  },
  {
    id: 'preview:toggle',
    group: 'view',
    feature: 'preview',
    defaults: [],
    run: () => {
      const s = useSettings.getState();
      s.setEditor({ pagePreview: !s.editor.pagePreview });
    },
  },
];
