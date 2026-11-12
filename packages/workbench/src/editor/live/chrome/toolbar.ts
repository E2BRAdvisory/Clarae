// The toolbar that floats over a selection (Crepe's `toolbar` feature): its buttons are named in the
// language of the application, drawn with its icons, and show its shortcuts (the registry's and the
// user's own, not the ones Milkdown binds to the same marks). The highlight (`==`) is added to the ones
// Crepe has, and runs the editor's own command for it. It is hidden when the editor is read-only (see theme.css).
import type { ToolbarFeatureConfig } from '@milkdown/crepe/feature/toolbar';
import { commandsCtx, schemaCtx } from '@milkdown/kit/core';
import { isMarkSelectedCommand } from '@milkdown/kit/preset/commonmark';
import type { EditorCommand } from '../../handle';
import { chromeIconSvg } from './icons';
import type { ShortcutOf } from './shortcuts';

export interface ToolbarLabels {
  bold: string;
  italic: string;
  strike: string;
  highlight: string;
  code: string;
  math: string;
  link: string;
}

/** The commands of the registry the buttons stand for, by the key Crepe gives the button. */
const COMMAND_OF: Record<string, string> = {
  bold: 'editor:bold',
  italic: 'editor:italic',
  strikethrough: 'editor:strike',
  highlight: 'editor:highlight',
  code: 'editor:code',
  link: 'editor:link',
};

export function toolbarConfig(o: {
  labels: ToolbarLabels;
  shortcut: ShortcutOf;
  exec: (command: EditorCommand) => boolean;
}): ToolbarFeatureConfig {
  const { labels } = o;
  const icon = (name: Parameters<typeof chromeIconSvg>[0]): string => chromeIconSvg(name, 24);
  return {
    boldIcon: icon('bold'),
    italicIcon: icon('italic'),
    strikethroughIcon: icon('strike'),
    codeIcon: icon('code'),
    latexIcon: icon('math'),
    linkIcon: icon('link'),
    boldLabel: labels.bold,
    italicLabel: labels.italic,
    strikethroughLabel: labels.strike,
    codeLabel: labels.code,
    latexLabel: labels.math,
    linkLabel: labels.link,
    buildToolbar: (builder) => {
      builder.getGroup('formatting').addItem('highlight', {
        icon: icon('highlight'),
        label: labels.highlight,
        active: (ctx) =>
          ctx
            .get(commandsCtx)
            .call(isMarkSelectedCommand.key, ctx.get(schemaCtx).marks['ofm_highlight']),
        onRun: () => void o.exec('highlight'),
      });
      for (const group of builder.build()) {
        for (const item of group.items) {
          const id = COMMAND_OF[item.key];
          if (!id) continue;
          const shortcut = o.shortcut(id);
          // what the keymap of Milkdown binds to the mark is not what the application does with the key
          delete item.keymap;
          if (shortcut) {
            item.shortcut = shortcut.display;
            item.ariaKeyshortcuts = shortcut.aria;
          } else {
            delete item.shortcut;
            delete item.ariaKeyshortcuts;
          }
        }
      }
    },
  };
}
